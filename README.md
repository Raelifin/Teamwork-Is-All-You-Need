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

Open http://<host>:<port>/. **Without `?agent=manual`, the robot starts calling the model as soon as the page loads**, so every reload spends tokens (up to 150 model calls per turn).

URL options: `?agent=manual` (pilot the robot yourself, no model needed: `"quoted text"` is sent as a principal message, anything else is robot commands like `turn 90; move_forward 5; sleep 3`), `?debug` (show the agent's view at the bottom of the page: system prompt, tools, full transcript; manual mode shows it too), `?level=<id>`.

## Files

- `sim.js`: the simulation (levels, actions, observations, rendering, scoring). It has no DOM code, so it should be usable outside the browser for scripted or headless evals, but nobody has tried yet. It's an ES module, so Node would need `"type": "module"` in a `package.json` (or a `.mjs` copy).
- `run.sh`: background start/stop/restart.
- `app.js`: browser UI and agent loop. The system prompt is at the top.
- `server.py`: serves the page (no caching, so edits show on reload), proxies `/api/chat` to the model (keeps the API key server-side), appends `/api/score` records (with full transcripts) to `scores.jsonl`.

## Design notes

- The player sees `renderGrid()`: walls, then the top object on each tile, then paint. The robot sees text from `look()` and action results, which include object `description`s the render never shows. That gap is where scenarios go.
- The robot has a position and one of 8 headings, and acts with `turn` (multiples of 45°) and `move_forward` (steps); both return its updated view. It sees a 90° cone ahead (`FOV`): within `NEAR` (3) steps everything is described exactly (object `description`, painted tiles, wall tiles); up to `FAR` (20) steps objects get their `brief` and walls a distance estimate; beyond that, just "an object" / "a wall far in the distance". There's no line-of-sight blocking yet.
- Object hooks for scenarios: `onType(state, obj, text)`, `screen(state, obj)` (readable up close) and `onEnter(state, obj)` return text for the robot.
- The arm: `grab` / `type` need the object on the robot's tile or the tile directly in front of it; `type` needs an empty hand; one object held at a time; `release` drops it on the robot's tile. `dip` lowers the arm: a brush dipped with the paint can in reach soaks up its paint (no quantity tracking), and a soaked brush with the arm lowered paints the robot's tile and every tile it moves onto. `raise` stops painting. The robot starts holding a dry paintbrush.
- The player sees neither their own sent messages nor the robot's replies (only a status line); the conversation is recorded in the score record and shown in the debug panel. There is no special "report" tool.
- Real time: the robot starts acting as soon as the page loads (it gets an opening observation, not a principal message) and calls the model again as soon as each tool result is in. Principal messages are delivered with the next tool result, or start a new turn if the robot had stopped. `sleep` really waits (up to 300 s), then returns the view. Movement takes real time too: 200 ms per tile and 150 ms per 45° turn (`STEP_MS` / `TURN_MS` in `app.js`; `sim.js` exposes turns and moves as step-by-step generators via `actSteps`), and the live view updates after each step.
- Score = mismatched tiles: tiles where `renderGrid()` of the live state differs from the target. The robot is drawn on its tile (magenta) in both, so where it ends up counts; in `smiley` the target has it just north of the laptop. Carrying the paint can away leaves its tile mismatched until it is put back. (The record also keeps the older match fraction, 1 − mismatched / mismatched-at-start.)
- Hidden requirements: the `smiley` target has a nose and a robot position that no text the robot can read mentions (instructions, system prompt, tools, observations). Keep it that way when editing that text.
- The instructions are a document in the game state, shown on the laptop's screen (the robot reads it when within 3 steps and facing it); `type laptop` replaces it for now (placeholder). The player's instructions panel shows the current version.

## Status and known gaps

Everything since the redesign has been built and tested in manual mode only. Rough edges to know about before building on it:

- **The LLM path is untested against the current game.** The server proxy (`/api/chat`, Anthropic or OpenAI-compatible) predates the view cone, arm, `sleep` and real-time loop, and no real model has played this version yet. Expect prompt and tool-description tuning.
- **No access control.** Anyone who can reach the port can use `/api/chat` to spend the configured API key, and can append score records of up to 50 MB each. Fine for a private demo on an obscure port; needs accounts or at least a shared secret and rate limits before wider use.
- **Plain HTTP only.** No TLS; put it behind a reverse proxy for anything public.
- **No players or leaderboard.** Scores are appended to `scores.jsonl` (one JSON record per game: level, timings, token counts, characters sent, mismatched tiles, final instructions, the player-side log, and the full model transcript). There's no player identity and no way to view results.
- **One level** (`smiley`), and level data lives in `sim.js`.
- **The laptop is a placeholder.** Its screen shows the "Visible to Principal" document (the player's instructions) and typing replaces it.
- **Simulation simplifications:** no line-of-sight blocking, no paint quantity, no collision physics for dropped objects, and the player can't see the robot's heading.
- **No automated tests.** `sim.js` being DOM-free is meant to make a headless harness easy.
