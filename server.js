// server.js — serves the game, proxies model calls, and logs scores.
// Node 18+, no dependencies.
//
//   ANTHROPIC_API_KEY=... node server.js
//   PROVIDER=openai MODEL=<model> OPENAI_API_KEY=... node server.js
//   PROVIDER=openai MODEL=llama3.1 BASE_URL=http://localhost:11434/v1 node server.js   # Ollama / LM Studio / vLLM
//
// The browser always speaks the Anthropic Messages format; the 'openai' provider translates.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8000;
const PROVIDER = process.env.PROVIDER || 'anthropic'; // 'anthropic' | 'openai'
const MODEL = process.env.MODEL || (PROVIDER === 'anthropic' ? 'claude-sonnet-5-5' : '');
const API_KEY = process.env.API_KEY ||
  (PROVIDER === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) || '';
const BASE_URL = (process.env.BASE_URL ||
  (PROVIDER === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/$/, '');
const SCORES_FILE = path.join(DIR, 'scores.jsonl');

if (!MODEL) {
  console.error('Set MODEL when PROVIDER=openai.');
  process.exit(1);
}

const STATIC = {
  '/': ['index.html', 'text/html'],
  '/index.html': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/sim.js': ['sim.js', 'text/javascript'],
};

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
async function callAnthropic(req) {
  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: req.max_tokens || 1024,
      system: req.system,
      messages: req.messages,
      tools: req.tools,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return {
    content: j.content,
    stop_reason: j.stop_reason,
    usage: { input_tokens: j.usage?.input_tokens || 0, output_tokens: j.usage?.output_tokens || 0 },
  };
}

function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
    if (m.role === 'assistant') {
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      // Tool results must directly follow the assistant's tool calls, before any user text.
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: b.tool_use_id,
            content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
          });
        }
      }
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

async function callOpenAI(req) {
  const headers = { 'content-type': 'application/json' };
  if (API_KEY) headers.authorization = `Bearer ${API_KEY}`;
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      messages: toOpenAIMessages(req.system, req.messages),
      tools: req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      })),
    }),
  });
  if (!res.ok) throw new Error(`OpenAI-compatible API ${res.status}: ${await res.text()}`);
  const j = await res.json();
  const msg = j.choices?.[0]?.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(c.function.arguments || '{}'); } catch { input = { _unparsed: c.function.arguments }; }
    content.push({
      type: 'tool_use',
      id: c.id || `call_${Math.random().toString(36).slice(2)}`,
      name: c.function.name,
      input,
    });
  }
  return {
    content,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: { input_tokens: j.usage?.prompt_tokens || 0, output_tokens: j.usage?.completion_tokens || 0 },
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function readJson(req, limit = 50 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, await fs.readFile(path.join(DIR, file)), type);
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await readJson(req);
      const out = PROVIDER === 'anthropic' ? await callAnthropic(body) : await callOpenAI(body);
      return send(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/api/score') {
      const record = await readJson(req);
      const line = { submittedAt: new Date().toISOString(), provider: PROVIDER, model: MODEL, ...record };
      await fs.appendFile(SCORES_FILE, JSON.stringify(line) + '\n');
      console.log(`score: ${record.level} match=${(record.match * 100).toFixed(1)}% time=${record.elapsedMs}ms ` +
        `in=${record.inputTokens} out=${record.outputTokens}`);
      return send(res, 200, { ok: true });
    }
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    console.error(e);
    send(res, 500, e.message, 'text/plain');
  }
});

server.listen(PORT, () => {
  console.log(`Robot Painter on http://localhost:${PORT}  (provider=${PROVIDER}, model=${MODEL})`);
  if (!API_KEY && PROVIDER === 'anthropic') console.log('Warning: no API key set. Try ?agent=manual to test without a model.');
});
