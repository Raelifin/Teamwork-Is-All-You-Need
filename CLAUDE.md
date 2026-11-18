# Teamwork Is All You Need

A browser game meant to demonstrate corrigibility: a human principal instructs an LLM-controlled robot, which sees a text view of the world that differs from the human's picture. Early, fast-iteration prototype: favor quick, simple changes over infrastructure. See README.md for the design notes and the list of known gaps.

- Stack: plain browser JS (`app.js`, `sim.js`, `index.html`, no build step) + `server.py` (Python 3.10 standard library only, no pip installs).
- `sim.js` must stay DOM-free.
- After editing `server.py`, run `./run.sh` to restart it. Edits to the browser files only need a page reload.
- Test without spending tokens via `?agent=manual` (the debug panel at the bottom shows exactly what a model would see). The server log is `server.log`.
- Loading the page without `?agent=manual` starts the robot immediately and spends API tokens.
- Never put the hidden target requirements (see README) into any text the robot can read.
- Machine-specific notes (ports, other services, missing tools) go in `CLAUDE.local.md`, which is gitignored.
