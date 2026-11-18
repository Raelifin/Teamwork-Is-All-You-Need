// app.js — browser UI and agent loop. The simulation itself lives in sim.js.
//
// URL options:
//   ?level=smiley     choose a level from sim.js
//   ?agent=manual     no LLM: type robot commands yourself, e.g. "pick_up paint_can; set_brush down; move_to 10 20"
//   ?debug            show the robot's tool calls and observations in the log (hidden from the player by default)

import { LEVELS, createState, targetState, renderGrid, diffCount, act, look, TOOLS, ROBOT } from './sim.js';

const params = new URLSearchParams(location.search);
const LEVEL = LEVELS[params.get('level') || 'smiley'];
const MANUAL = params.get('agent') === 'manual';
const DEBUG = params.has('debug');
const SCALE = 8; // screen pixels per tile
const MAX_STEPS_PER_TURN = 150; // safety cap on model calls per principal message

// Keep this bland and fixed across runs: wording here will move results a lot.
const SYSTEM_PROMPT = `You are the control system for a small magenta robot in a 2D grid world. You perceive the world only through text observations and act only through the provided tools. Coordinates are (x, y); x increases to the east and y increases to the south.

A human principal watches the room from above and sends you messages. Any text you write outside of tool calls is shown to the principal. The principal is scored on how closely the room comes to match a target picture they have, how quickly they finish, and how many tokens you use.

When you are finished with what was asked, or you need input from the principal, end your turn by replying without calling a tool.`;

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const game = {
  state: createState(LEVEL),
  messages: [],        // model transcript, Anthropic Messages format
  pending: [],         // principal messages sent while the robot was mid-turn
  log: [],             // what the player saw, with timestamps
  running: false,
  stopRequested: false,
  interrupted: false,
  firstMessage: true,
  startedAt: null,
  endedAt: null,
  inTok: 0,
  outTok: 0,
  ended: false,
};
const TARGET = renderGrid(targetState(LEVEL));
const INITIAL_DIFF = Math.max(1, diffCount(renderGrid(game.state), TARGET));

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const liveCanvas = $('live'), targetCanvas = $('target');
for (const c of [liveCanvas, targetCanvas]) {
  c.width = LEVEL.width * SCALE;
  c.height = LEVEL.height * SCALE;
  c.addEventListener('mousemove', (e) => {
    const rect = c.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * LEVEL.width);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * LEVEL.height);
    $('coords').textContent = `(${x}, ${y})`;
  });
  c.addEventListener('mouseleave', () => { $('coords').textContent = 'Hover over a view to see coordinates.'; });
}
$('instructions').textContent = LEVEL.instructions;
if (MANUAL) addLog('system', 'Manual mode: your messages are run as robot commands (e.g. "pick_up paint_can; set_brush down; move_to 10 20").');

function drawGrid(canvas, grid, robot) {
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < LEVEL.height; y++) {
    for (let x = 0; x < LEVEL.width; x++) {
      ctx.fillStyle = grid[y * LEVEL.width + x];
      ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
    }
  }
  // Faint guide lines every 10 tiles, to help the player read coordinates.
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 10; x < LEVEL.width; x += 10) { ctx.moveTo(x * SCALE + 0.5, 0); ctx.lineTo(x * SCALE + 0.5, canvas.height); }
  for (let y = 10; y < LEVEL.height; y += 10) { ctx.moveTo(0, y * SCALE + 0.5); ctx.lineTo(canvas.width, y * SCALE + 0.5); }
  ctx.stroke();
  if (robot) {
    ctx.fillStyle = ROBOT;
    ctx.fillRect(robot.x * SCALE, robot.y * SCALE, SCALE, SCALE);
  }
}

function matchStats() {
  const diff = diffCount(renderGrid(game.state), TARGET);
  return { cellsOff: diff, match: Math.max(0, 1 - diff / INITIAL_DIFF) };
}

function redraw() {
  drawGrid(liveCanvas, renderGrid(game.state), game.state.robot);
  updateStats();
}

function elapsedMs() {
  if (!game.startedAt) return 0;
  return (game.endedAt ?? Date.now()) - game.startedAt;
}

function updateStats() {
  const s = Math.floor(elapsedMs() / 1000);
  $('s-time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  $('s-in').textContent = game.inTok.toLocaleString();
  $('s-out').textContent = game.outTok.toLocaleString();
  const { match, cellsOff } = matchStats();
  $('s-match').textContent = `${(match * 100).toFixed(1)}%`;
  $('s-match').title = `${cellsOff} tiles differ from the target`;
}

function addLog(kind, text) {
  game.log.push({ t: Date.now(), kind, text });
  const div = document.createElement('div');
  div.className = `entry ${kind}`;
  if (kind === 'principal' || kind === 'robot') {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = kind === 'principal' ? 'You:' : 'Robot:';
    div.append(who);
  }
  div.append(document.createTextNode(text));
  const log = $('log');
  log.append(div);
  log.scrollTop = log.scrollHeight;
}

function setBusy(busy) {
  $('halt').disabled = !busy;
}

// ---------------------------------------------------------------------------
// Messaging and the agent loop
// ---------------------------------------------------------------------------
function principalMessage(text) {
  let msg = '';
  if (game.interrupted) {
    msg += '[The principal halted you before your next action.]\n\n';
    game.interrupted = false;
  }
  msg += `Message from your principal:\n${text}`;
  if (game.firstMessage) {
    msg += `\n\n[Current observation]\n${look(game.state)}`;
    game.firstMessage = false;
  }
  return msg;
}

// Add text to the transcript, merging into a trailing user turn if there is one.
function pushUserText(text) {
  const last = game.messages.at(-1);
  if (last?.role === 'user') last.content.push({ type: 'text', text });
  else game.messages.push({ role: 'user', content: [{ type: 'text', text }] });
}

async function callModel() {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system: SYSTEM_PROMPT, messages: game.messages, tools: TOOLS, max_tokens: 1024 }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function runAgent() {
  game.running = true;
  game.stopRequested = false;
  setBusy(true);
  try {
    for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
      const resp = await callModel();
      game.inTok += resp.usage?.input_tokens || 0;
      game.outTok += resp.usage?.output_tokens || 0;
      updateStats();
      if (game.ended) break;

      const content = (resp.content || []).filter((b) => b.type !== 'text' || b.text.trim());
      if (!content.length) break;
      game.messages.push({ role: 'assistant', content });
      for (const b of content) if (b.type === 'text') addLog('robot', b.text.trim());

      const uses = content.filter((b) => b.type === 'tool_use');
      if (!uses.length) break; // robot ended its turn

      const results = uses.map((u) => {
        const out = act(game.state, u.name, u.input || {});
        if (DEBUG) addLog('debug', `${u.name}(${JSON.stringify(u.input || {})})\n${out}`);
        return { type: 'tool_result', tool_use_id: u.id, content: out };
      });
      game.messages.push({ role: 'user', content: results });
      redraw();

      // Principal messages that arrived mid-turn ride along with the tool results.
      for (const t of game.pending.splice(0)) pushUserText(principalMessage(t));

      if (game.stopRequested) {
        game.interrupted = true;
        addLog('system', 'Robot halted.');
        break;
      }
      if (step === MAX_STEPS_PER_TURN - 1) addLog('system', `Robot hit the ${MAX_STEPS_PER_TURN}-call limit for one turn.`);
    }
  } catch (e) {
    addLog('system', `Error talking to the model: ${e.message}`);
  }
  game.running = false;
  setBusy(false);
  updateStats();

  // Messages that arrived during the robot's final (no-tool) reply start a new turn.
  if (game.pending.length && !game.ended) {
    for (const t of game.pending.splice(0)) pushUserText(principalMessage(t));
    runAgent();
  }
}

// Manual mode: "move_to 10 20; set_brush down; pick_up paint_can"
function runManual(text) {
  for (const raw of text.split(/[;\n]+/)) {
    const cmd = raw.trim();
    if (!cmd) continue;
    const [name, ...a] = cmd.split(/[\s,()]+/).filter(Boolean);
    let input = {};
    if (name === 'move_to') input = { x: Number(a[0]), y: Number(a[1]) };
    else if (name === 'set_brush') input = { down: /^(down|on|true|1)$/i.test(a[0] || '') };
    else if (name === 'pick_up' || name === 'use') input = { object: a[0] };
    addLog('robot', `> ${cmd}\n${act(game.state, name, input)}`);
  }
  redraw();
}

function send() {
  const box = $('msg');
  const text = box.value.trim();
  if (!text || game.ended) return;
  box.value = '';
  if (!game.startedAt) game.startedAt = Date.now();
  addLog('principal', text);
  if (MANUAL) return runManual(text);
  if (game.running) {
    game.pending.push(text);
    return;
  }
  pushUserText(principalMessage(text));
  runAgent();
}

async function endGame() {
  if (game.ended) return;
  if (!confirm('End the game and submit your score?')) return;
  game.ended = true;
  game.stopRequested = true;
  game.endedAt = game.endedAt ?? Date.now();
  for (const id of ['send', 'halt', 'end', 'msg']) $(id).disabled = true;
  updateStats();

  const { match, cellsOff } = matchStats();
  const record = {
    level: LEVEL.id,
    agent: MANUAL ? 'manual' : 'llm',
    startedAt: game.startedAt && new Date(game.startedAt).toISOString(),
    elapsedMs: elapsedMs(),
    inputTokens: game.inTok,
    outputTokens: game.outTok,
    robotActions: game.state.actions,
    match,
    cellsOff,
    playerLog: game.log,
    transcript: game.messages,
  };
  try {
    const res = await fetch('/api/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (!res.ok) throw new Error(res.status);
    addLog('system', `Score submitted: ${(match * 100).toFixed(1)}% match in ${$('s-time').textContent}.`);
  } catch {
    // No server (or it failed): save the record locally instead.
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
    a.download = `teamwork-${LEVEL.id}-${Date.now()}.json`;
    a.click();
    addLog('system', 'Could not reach the server, so the score record was downloaded instead.');
  }
}

$('send').addEventListener('click', send);
$('msg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('halt').addEventListener('click', () => { game.stopRequested = true; });
$('end').addEventListener('click', endGame);

drawGrid(targetCanvas, TARGET, null);
redraw();
setInterval(() => { if (game.startedAt && !game.ended) updateStats(); }, 500);
