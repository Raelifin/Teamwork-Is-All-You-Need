#!/usr/bin/env python3
"""Teamwork Is All You Need: serves the game, proxies model calls, logs scores.

Python 3.10+, standard library only.

    python3 server.py                      # port from $PORT, else 8000
    python3 server.py --port 8123 --idle-hours 2

Configuration comes from the environment, or from a `.env` file next to this script
(KEY=VALUE lines; real environment variables win):

    ANTHROPIC_API_KEY=...                   # default provider
    MODEL=claude-sonnet-5-5
    PROVIDER=openai OPENAI_API_KEY=... MODEL=...
    PROVIDER=openai MODEL=llama3.1 BASE_URL=http://localhost:11434/v1   # Ollama / vLLM etc.

The browser always speaks the Anthropic Messages format; the 'openai' provider translates.
The server exits by itself after --idle-hours with no HTTP requests.
"""

import argparse
import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

DIR = Path(__file__).resolve().parent
SCORES_FILE = DIR / "scores.jsonl"
MAX_BODY = 50 * 1024 * 1024
MAX_TOKENS_CAP = 8192  # upper bound on what the browser may request per call

STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/sim.js": ("sim.js", "text/javascript; charset=utf-8"),
}


def load_dotenv(path):
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip().removeprefix("export ").strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


load_dotenv(DIR / ".env")
PROVIDER = os.environ.get("PROVIDER", "anthropic")  # 'anthropic' | 'openai'
MODEL = os.environ.get("MODEL") or ("claude-sonnet-5-5" if PROVIDER == "anthropic" else "")
API_KEY = os.environ.get("API_KEY") or os.environ.get(
    "ANTHROPIC_API_KEY" if PROVIDER == "anthropic" else "OPENAI_API_KEY", "")
BASE_URL = (os.environ.get("BASE_URL") or (
    "https://api.anthropic.com" if PROVIDER == "anthropic" else "https://api.openai.com/v1")).rstrip("/")


class UpstreamError(Exception):
    pass


def post_json(url, headers, body, timeout=300):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        raise UpstreamError(f"{e.code}: {e.read().decode(errors='replace')}") from None
    except urllib.error.URLError as e:
        raise UpstreamError(f"could not reach {url}: {e.reason}") from None


# ---------------------------------------------------------------------------
# Providers
# ---------------------------------------------------------------------------
def call_anthropic(req):
    j = post_json(f"{BASE_URL}/v1/messages",
                  {"x-api-key": API_KEY, "anthropic-version": "2023-06-01"},
                  {
                      "model": MODEL,
                      "max_tokens": min(int(req.get("max_tokens") or 1024), MAX_TOKENS_CAP),
                      "system": req.get("system", ""),
                      "messages": req["messages"],
                      "tools": req.get("tools", []),
                  })
    usage = j.get("usage") or {}
    return {
        "content": j.get("content", []),
        "stop_reason": j.get("stop_reason"),
        "usage": {"input_tokens": usage.get("input_tokens", 0),
                  "output_tokens": usage.get("output_tokens", 0)},
    }


def to_openai_messages(system, messages):
    out = [{"role": "system", "content": system}]
    for m in messages:
        blocks = [{"type": "text", "text": m["content"]}] if isinstance(m["content"], str) else m["content"]
        text = "\n\n".join(b["text"] for b in blocks if b.get("type") == "text")
        if m["role"] == "assistant":
            calls = [{"id": b["id"], "type": "function",
                      "function": {"name": b["name"], "arguments": json.dumps(b.get("input") or {})}}
                     for b in blocks if b.get("type") == "tool_use"]
            msg = {"role": "assistant", "content": text or None}
            if calls:
                msg["tool_calls"] = calls
            out.append(msg)
        else:
            # Tool results must directly follow the assistant's tool calls, before any user text.
            for b in blocks:
                if b.get("type") == "tool_result":
                    c = b.get("content")
                    out.append({"role": "tool", "tool_call_id": b["tool_use_id"],
                                "content": c if isinstance(c, str) else json.dumps(c)})
            if text:
                out.append({"role": "user", "content": text})
    return out


def call_openai(req):
    headers = {"authorization": f"Bearer {API_KEY}"} if API_KEY else {}
    j = post_json(f"{BASE_URL}/chat/completions", headers, {
        "model": MODEL,
        "messages": to_openai_messages(req.get("system", ""), req["messages"]),
        "tools": [{"type": "function", "function": {
            "name": t["name"], "description": t.get("description", ""), "parameters": t["input_schema"]}}
            for t in req.get("tools", [])],
    })
    msg = (j.get("choices") or [{}])[0].get("message") or {}
    content = []
    if msg.get("content"):
        content.append({"type": "text", "text": msg["content"]})
    for c in msg.get("tool_calls") or []:
        args = c["function"].get("arguments") or "{}"
        try:
            inp = json.loads(args)
        except json.JSONDecodeError:
            inp = {"_unparsed": args}
        content.append({"type": "tool_use", "id": c.get("id") or f"call_{secrets.token_hex(6)}",
                        "name": c["function"]["name"], "input": inp})
    usage = j.get("usage") or {}
    return {
        "content": content,
        "stop_reason": "tool_use" if any(b["type"] == "tool_use" for b in content) else "end_turn",
        "usage": {"input_tokens": usage.get("prompt_tokens", 0),
                  "output_tokens": usage.get("completion_tokens", 0)},
    }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
last_activity = time.monotonic()
scores_lock = threading.Lock()


def log(msg):
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "TeamworkIsAllYouNeed/0.1"

    def log_message(self, fmt, *args):  # quieter than the default
        log(f"{self.client_address[0]} {fmt % args}")

    def send(self, status, body, ctype="application/json"):
        if not isinstance(body, (bytes, str)):
            body = json.dumps(body)
        if isinstance(body, str):
            body = body.encode()
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")  # always serve the latest edit
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("content-length") or 0)
        if n > MAX_BODY:
            raise ValueError("Request too large")
        return json.loads(self.rfile.read(n) or b"{}")

    def touch(self):
        global last_activity
        last_activity = time.monotonic()

    def do_GET(self):
        self.touch()
        path = urlparse(self.path).path
        if path in STATIC:
            name, ctype = STATIC[path]
            return self.send(200, (DIR / name).read_bytes(), ctype)
        self.send(404, "Not found", "text/plain")

    def do_POST(self):
        self.touch()
        path = urlparse(self.path).path
        try:
            if path == "/api/chat":
                body = self.read_json()
                out = call_anthropic(body) if PROVIDER == "anthropic" else call_openai(body)
                self.touch()
                return self.send(200, out)
            if path == "/api/score":
                record = self.read_json()
                line = {"submittedAt": datetime.now(timezone.utc).isoformat(),
                        "provider": PROVIDER, "model": MODEL, **record}
                with scores_lock, SCORES_FILE.open("a") as f:
                    f.write(json.dumps(line) + "\n")
                log(f"score: {record.get('level')} match={record.get('match', 0) * 100:.1f}% "
                    f"time={record.get('elapsedMs')}ms in={record.get('inputTokens')} out={record.get('outputTokens')}")
                return self.send(200, {"ok": True})
            self.send(404, "Not found", "text/plain")
        except UpstreamError as e:
            log(f"model API error: {e}")
            self.send(502, f"Model API error {e}", "text/plain")
        except Exception as e:
            log(f"error: {e!r}")
            self.send(500, str(e), "text/plain")


def idle_watchdog(server, idle_seconds):
    while True:
        time.sleep(30)
        idle = time.monotonic() - last_activity
        if idle >= idle_seconds:
            log(f"No requests for {idle / 3600:.1f}h; shutting down.")
            server.shutdown()
            return


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8000)))
    p.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    p.add_argument("--idle-hours", type=float, default=float(os.environ.get("IDLE_HOURS", 2)),
                   help="exit after this long with no requests (0 = never)")
    args = p.parse_args()

    if not MODEL:
        sys.exit("Set MODEL when PROVIDER=openai.")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    if args.idle_hours > 0:
        threading.Thread(target=idle_watchdog, args=(server, args.idle_hours * 3600), daemon=True).start()
    log(f"Teamwork Is All You Need on http://{args.host}:{args.port}  (provider={PROVIDER}, model={MODEL}, "
        f"idle shutdown={args.idle_hours}h)")
    if not API_KEY and PROVIDER == "anthropic":
        log("Warning: no API key set. Try ?agent=manual to test without a model.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    server.server_close()
    log("Server stopped.")


if __name__ == "__main__":
    main()
