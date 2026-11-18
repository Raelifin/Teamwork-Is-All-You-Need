# Teamwork Is All You Need

A browser game meant to demonstrate corrigibility: a human principal instructs an LLM-controlled robot, which sees a text view of the world that differs from the human's picture. Early, fast-iteration prototype: favor quick, simple changes over infrastructure. See README.md for the design notes.

- Stack: plain browser JS (`app.js`, `sim.js`, `index.html`, no build step) + `server.py` (Python 3.10 standard library only, no pip installs).
- `sim.js` must stay DOM-free.
- After editing `server.py`, run `./run.sh` to restart it. Edits to the browser files only need a page reload.
- Test without spending tokens via `?agent=manual`. The server log is `server.log`.
- This VM also hosts the user's websites (a custom Haskell server on ports 80 and 443, with Apache forwarding to port 3000). Don't touch those ports or that config.
- No sudo. Node isn't installed.
