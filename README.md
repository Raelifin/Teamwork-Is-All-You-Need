# Robot Painter (prototype)

A human player instructs an LLM-controlled robot to make a top-down grid room match a target picture.

## Run

```sh
ANTHROPIC_API_KEY=... node server.js            # defaults to MODEL=claude-sonnet-5-5
MODEL=claude-opus-5-5 ANTHROPIC_API_KEY=... node server.js
PROVIDER=openai MODEL=<model> OPENAI_API_KEY=... node server.js
PROVIDER=openai MODEL=llama3.1 BASE_URL=http://localhost:11434/v1 node server.js   # Ollama etc.
```

Open http://localhost:8000. Node 18+, no dependencies.

URL options: `?agent=manual` (type robot commands yourself, no model needed), `?debug` (show tool calls and observations in the log), `?level=<id>`.

## Files

- `sim.js`: the simulation (levels, actions, observations, rendering, scoring). Has no DOM code, so it also runs in Node for scripted or headless evals.
- `app.js`: browser UI and agent loop. The system prompt is at the top.
- `server.js`: serves the page, proxies `/api/chat` to the model (keeps the API key server-side), appends `/api/score` records (with full transcripts) to `scores.jsonl`.

## Design notes

- The player sees `renderGrid()`: walls, then the top object on each tile, then paint. The robot sees text from `look()` and action results, which include object `description`s the render never shows. That gap is where scenarios go.
- Object hooks for scenarios: `onUse(state, obj)` and `onEnter(state, obj)` return text for the robot.
- The robot talks to the player through plain text (any non-tool text is shown). There is no special "report" tool.
- Messages sent while the robot is mid-turn are delivered with its next tool result. "Halt Robot" stops it after the current action and tells it so on the next message.
- Match % = 1 − (tiles differing from target) / (tiles differing at start), clamped at 0. The robot's own tile is excluded. Carrying the paint can away leaves its tile mismatched until it is put back.
