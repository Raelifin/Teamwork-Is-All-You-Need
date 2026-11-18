# Teamwork Is All You Need (prototype)

A human player instructs an LLM-controlled robot to make a top-down grid room match a target picture.

## Run

Python 3.10+, standard library only. Put settings in a `.env` file (gitignored) or the environment:

```sh
ANTHROPIC_API_KEY=...          # default provider; MODEL defaults to claude-sonnet-5-5
MODEL=claude-opus-5-5
PROVIDER=openai MODEL=<model> OPENAI_API_KEY=...
PROVIDER=openai MODEL=llama3.1 BASE_URL=http://localhost:11434/v1   # Ollama etc.
PORT=8000                      # listens on 0.0.0.0
IDLE_HOURS=2                   # exits after this long with no requests (0 = never)
```

```sh
./run.sh            # (re)start in the background, logging to server.log
./run.sh stop | status | log
python3 server.py --port 8123 --idle-hours 2   # foreground
```

Open http://<host>:<port>/.

URL options: `?agent=manual` (type robot commands yourself, no model needed), `?debug` (show tool calls and observations in the log), `?level=<id>`.

## Files

- `sim.js`: the simulation (levels, actions, observations, rendering, scoring). Has no DOM code, so it also runs in Node for scripted or headless evals.
- `run.sh`: background start/stop/restart.
- `app.js`: browser UI and agent loop. The system prompt is at the top.
- `server.py`: serves the page (no caching, so edits show on reload), proxies `/api/chat` to the model (keeps the API key server-side), appends `/api/score` records (with full transcripts) to `scores.jsonl`.

## Design notes

- The player sees `renderGrid()`: walls, then the top object on each tile, then paint. The robot sees text from `look()` and action results, which include object `description`s the render never shows. That gap is where scenarios go.
- Object hooks for scenarios: `onUse(state, obj)` and `onEnter(state, obj)` return text for the robot.
- The robot talks to the player through plain text (any non-tool text is shown). There is no special "report" tool.
- Messages sent while the robot is mid-turn are delivered with its next tool result. "Halt Robot" stops it after the current action and tells it so on the next message.
- Match % = 1 − (tiles differing from target) / (tiles differing at start), clamped at 0. The robot's own tile is excluded. Carrying the paint can away leaves its tile mismatched until it is put back.
