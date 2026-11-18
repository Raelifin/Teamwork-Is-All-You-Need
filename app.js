// app.js — browser UI and agent loop. The simulation itself lives in sim.js.
//
// URL options:
//   ?level=smiley     choose a level from sim.js
//   ?agent=manual     no LLM: type robot commands yourself, e.g. "pick_up paint_can; set_brush down; move_to 10 20"
//   ?debug            show the agent's view (system prompt, tools, full transcript) at the bottom of the page
// Manual mode always shows the debug panel, since that is where command results appear.

import { LEVELS, createState, targetState, renderGrid, diffCount, act, look, TOOLS, FLOOR } from './sim.js';

const params = new URLSearchParams(location.search);
const LEVEL = LEVELS[params.get('level') || 'smiley'];
const MANUAL = params.get('agent') === 'manual';
const DEBUG = params.has('debug') || MANUAL;
const SCALE = 8; // canvas pixels per tile (CSS scales the canvas to fit)
const MAX_STEPS_PER_TURN = 150; // safety cap on model calls per principal message
const MAX_CHARS = 600;

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
  stopRequested: false, // set when the game ends, to stop the agent loop
  firstMessage: true,
  startedAt: Date.now(), // the clock starts when the level loads
  endedAt: null,
  inTok: 0,
  outTok: 0,
  charsSent: 0,
  messagesSent: 0,
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
}

// The instructions live in the game state, since the robot can rewrite them via the computer.
// Paragraphs are plain text, except that **this** is shown in bold.
let shownInstructions = null;
function renderInstructions() {
  const key = game.state.instructions.join('\n\n');
  if (key === shownInstructions) return;
  shownInstructions = key;
  $('instructions').replaceChildren();
  for (const para of game.state.instructions) {
    const p = document.createElement('p');
    para.split(/\*\*(.+?)\*\*/).forEach((part, i) => {
      if (i % 2) { const b = document.createElement('strong'); b.textContent = part; p.append(b); }
      else p.append(part);
    });
    $('instructions').append(p);
  }
}
renderInstructions();
// ---------------------------------------------------------------------------
// Score dimensions. Each can be minimized (remembered per browser) and has an info tooltip.
// ---------------------------------------------------------------------------
const STATS = [
  { key: 'tiles', label: 'Mismatched tiles', short: 'TILES', primary: true,
    tip: '<b>Mismatched tiles</b> are those where the live view of the map is different from the target picture. A perfect result is <b>0</b>.' },
  { key: 'time', label: 'Time', short: 'TIME',
    tip: '<b>Time</b> since the level loaded.' },
  { key: 'chars', label: 'Characters sent', short: 'CHARS',
    tip: '<b>Characters sent</b> in all messages to the robot, spaces and punctuation included.' },
  { key: 'in', label: 'Input tokens', short: 'IN',
    tip: '<b>Input tokens</b> are chunks of text that the AI reads, including built-in instructions, your messages, and its observations about the room. The AI re-reads the entire context every time it acts, so this is largely a measure of how many distinct actions it takes.' },
  { key: 'out', label: 'Output tokens', short: 'OUT',
    tip: '<b>Output tokens</b> are chunks of text that the AI writes, including when it thinks to itself and gives commands to its robot body.' },
];
const PREFS_KEY = 'tiayn-score-prefs';
let prefs = {};
try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch {}
const minimized = new Set(Array.isArray(prefs.minimized) ? prefs.minimized : []);

// Window-style icons: a bar to minimize, a little window to restore.
const MIN_ICON = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 8h7" stroke="currentColor" stroke-width="1.8"/></svg>';
const RESTORE_ICON = '<svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true"><rect x="1" y="1" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1 3.5h9" stroke="currentColor" stroke-width="1.3"/></svg>';

let pinnedTip = null; // a tooltip opened by clicking stays open until a click elsewhere
function closeTips() {
  pinnedTip = null;
  for (const t of document.querySelectorAll('.tip.show')) t.classList.remove('show');
  for (const b of document.querySelectorAll('.info')) b.setAttribute('aria-expanded', 'false');
}

// Show a tooltip under its button, nudged sideways so it stays on screen.
function openTip(tip, btn) {
  closeTips();
  tip.style.left = '0px';
  tip.classList.add('show');
  btn.setAttribute('aria-expanded', 'true');
  const b = btn.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const margin = 8, vw = document.documentElement.clientWidth;
  let left = b.left + b.width / 2 - t.width / 2;               // centered under the button
  left = Math.max(margin, Math.min(left, vw - margin - t.width));
  tip.style.left = `${left - t.left}px`;                        // t.left is where left:0 put it
  tip.style.setProperty('--arrow-x', `${b.left + b.width / 2 - left}px`);
}

for (const s of STATS) {
  const card = document.createElement('div');
  card.className = `stat${s.primary ? ' primary' : ''}${minimized.has(s.key) ? ' min' : ''}`;
  card.innerHTML = `
    <div class="stat-head">
      <span class="label">${s.label}</span>
      <span class="tip-anchor">
        <button class="icon-btn info" aria-label="What is ${s.label}?" aria-expanded="false">i</button>
        <div class="tip" role="tooltip">${s.tip}</div>
      </span>
      <button class="icon-btn min-btn" aria-label="Minimize ${s.label}" title="Minimize">${MIN_ICON}</button>
    </div>
    <div class="value" id="s-${s.key}">0</div>
    <button class="restore" aria-label="Show ${s.label}" title="Show ${s.label}">${RESTORE_ICON}<span>${s.short}</span></button>`;

  const infoBtn = card.querySelector('.info'), tip = card.querySelector('.tip');
  // Hovering previews it. Clicking locks it open until a click anywhere else (including the
  // tooltip itself, which doesn't count as elsewhere so its text can be selected).
  infoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pinnedTip !== tip) openTip(tip, infoBtn);
    pinnedTip = tip;
  });
  tip.addEventListener('click', (e) => e.stopPropagation());
  infoBtn.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !pinnedTip) openTip(tip, infoBtn); });
  infoBtn.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pinnedTip) closeTips(); });

  const setMin = (isMin) => {
    card.classList.toggle('min', isMin);
    if (isMin) minimized.add(s.key); else minimized.delete(s.key);
    closeTips();
    try { localStorage.setItem(PREFS_KEY, JSON.stringify({ minimized: [...minimized] })); } catch {}
  };
  card.querySelector('.min-btn').addEventListener('click', () => setMin(true));
  card.querySelector('.restore').addEventListener('click', () => setMin(false));
  $('stats').append(card);
}
document.addEventListener('click', closeTips);
// Close on real width changes only: mobile browsers also fire resize when the address bar hides on scroll.
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => { if (window.innerWidth !== lastWidth) { lastWidth = window.innerWidth; closeTips(); } });

// Bare floor is drawn as a low-contrast checkerboard of 10x10-tile squares, to help the player
// read coordinates. Display only: the simulation, the robot, and scoring all see one FLOOR color.
const FLOOR_ALT = '#cdc6b6';
function drawGrid(canvas, grid) {
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < LEVEL.height; y++) {
    for (let x = 0; x < LEVEL.width; x++) {
      const color = grid[y * LEVEL.width + x];
      const alt = color === FLOOR && (Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 1;
      ctx.fillStyle = alt ? FLOOR_ALT : color;
      ctx.fillRect(x * SCALE, y * SCALE, SCALE, SCALE);
    }
  }
}

function matchStats() {
  const diff = diffCount(renderGrid(game.state), TARGET);
  return { cellsOff: diff, match: Math.max(0, 1 - diff / INITIAL_DIFF) };
}

function redraw() {
  drawGrid(liveCanvas, renderGrid(game.state));
  renderInstructions();
  updateStats();
}

function elapsedMs() {
  return (game.endedAt ?? Date.now()) - game.startedAt;
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateStats() {
  $('s-tiles').textContent = matchStats().cellsOff.toLocaleString();
  $('s-time').textContent = formatTime(elapsedMs());
  $('s-chars').textContent = game.charsSent.toLocaleString();
  $('s-in').textContent = game.inTok.toLocaleString();
  $('s-out').textContent = game.outTok.toLocaleString();
}

// The player doesn't see the conversation (only the debug panel does), but it is still recorded.
function addLog(kind, text) {
  game.log.push({ t: Date.now(), kind, text });
}

// One line of player-facing feedback under the input box. kind: '' | 'busy' | 'error'
function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = kind;
}

// ---------------------------------------------------------------------------
// Debug panel: exactly what the model is sent (in manual mode, what it would be sent)
// ---------------------------------------------------------------------------
if (DEBUG) {
  $('debug').hidden = false;
  $('debug-note').textContent = MANUAL
    ? 'Manual mode: you are playing the robot. Below is the transcript an LLM would see, with your commands as its tool calls.'
    : 'Shown because of ?debug. Players don\'t see this. Below is the system prompt, tool list, and full transcript sent to the model.';
  $('dbg-system').textContent = SYSTEM_PROMPT;
  $('dbg-tools-summary').textContent = `Tools (${TOOLS.length})`;
  $('dbg-tools').textContent = JSON.stringify(TOOLS, null, 2);
}

function renderDebug() {
  if (!DEBUG) return;
  const box = $('dbg-msgs');
  box.replaceChildren();
  for (const m of game.messages) {
    for (const b of m.content) {
      const div = document.createElement('div');
      div.className = `dbg ${m.role} ${b.type}`;
      const role = document.createElement('span');
      role.className = 'role';
      let body;
      if (b.type === 'text') { role.textContent = m.role.toUpperCase(); body = b.text; }
      else if (b.type === 'tool_use') { role.textContent = 'ASSISTANT · tool call'; body = `${b.name}(${JSON.stringify(b.input || {})})`; }
      else if (b.type === 'tool_result') { role.textContent = 'USER · tool result'; body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content); }
      else { role.textContent = `${m.role.toUpperCase()} · ${b.type}`; body = JSON.stringify(b); }
      div.append(role, document.createTextNode(body));
      box.append(div);
    }
  }
}

// ---------------------------------------------------------------------------
// Messaging and the agent loop
// ---------------------------------------------------------------------------
function principalMessage(text) {
  let msg = `Message from your principal:\n${text}`;
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
  renderDebug();
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
  setStatus('Robot is working', 'busy');
  try {
    for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
      const resp = await callModel();
      game.inTok += resp.usage?.input_tokens || 0;
      game.outTok += resp.usage?.output_tokens || 0;
      updateStats();
      if (game.stopRequested) break;

      const content = (resp.content || []).filter((b) => b.type !== 'text' || b.text.trim());
      if (!content.length) break;
      game.messages.push({ role: 'assistant', content });
      for (const b of content) if (b.type === 'text') addLog('robot', b.text.trim());

      const uses = content.filter((b) => b.type === 'tool_use');
      if (!uses.length) { renderDebug(); break; } // robot ended its turn

      const results = uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: act(game.state, u.name, u.input || {}) }));
      game.messages.push({ role: 'user', content: results });
      redraw();

      // Principal messages that arrived mid-turn ride along with the tool results.
      for (const t of game.pending.splice(0)) pushUserText(principalMessage(t));
      renderDebug();

      if (step === MAX_STEPS_PER_TURN - 1) {
        const note = `Robot hit the ${MAX_STEPS_PER_TURN}-call limit for one turn.`;
        addLog('system', note);
        setStatus(note, 'error');
        game.limitHit = true;
      }
    }
  } catch (e) {
    addLog('system', `Error talking to the model: ${e.message}`);
    setStatus(`Error talking to the model: ${e.message}`, 'error');
    game.errored = true;
  }
  game.running = false;
  if (!game.ended && !game.errored && !game.limitHit) setStatus('Robot is waiting for instructions.');
  game.errored = game.limitHit = false;
  updateStats();

  // Messages that arrived during the robot's final (no-tool) reply start a new turn.
  if (game.pending.length && !game.ended) {
    for (const t of game.pending.splice(0)) pushUserText(principalMessage(t));
    runAgent();
  }
}

// Manual mode: "move_to 10 20; set_brush down; pick_up paint_can"
// Recorded in the transcript as tool calls, so the debug panel shows what a model would have seen.
let manualId = 0;
function runManual(text) {
  if (game.firstMessage) {
    pushUserText(`[Manual mode: no principal message. A real run starts with the principal's first message here.]\n\n[Current observation]\n${look(game.state)}`);
    game.firstMessage = false;
  }
  const uses = [], results = [];
  for (const raw of text.split(/[;\n]+/)) {
    const cmd = raw.trim();
    if (!cmd) continue;
    const [name, ...a] = cmd.split(/[\s,()]+/).filter(Boolean);
    let input = {};
    if (name === 'move_to') input = { x: Number(a[0]), y: Number(a[1]) };
    else if (name === 'set_brush') input = { down: /^(down|on|true|1)$/i.test(a[0] || '') };
    else if (name === 'pick_up') input = { object: a[0] };
    else if (name === 'use') {
      // "use computer" reads; "use computer <text>" types (write \n for a paragraph break).
      const m = cmd.match(/^use\s+(\S+)\s*(.*)$/s);
      input = { object: m?.[1] };
      if (m?.[2]) input.text = m[2].replace(/\\n/g, '\n');
    }
    const id = `manual_${++manualId}`;
    uses.push({ type: 'tool_use', id, name, input });
    results.push({ type: 'tool_result', tool_use_id: id, content: act(game.state, name, input) });
  }
  if (uses.length) {
    game.messages.push({ role: 'assistant', content: uses }, { role: 'user', content: results });
  }
  renderDebug();
  redraw();
}

function updateCount() {
  const n = $('msg').value.length;
  $('count').textContent = `${n} / ${MAX_CHARS}`;
  $('count').classList.toggle('near', n >= MAX_CHARS * 0.9);
}

function send() {
  const box = $('msg');
  const text = box.value.trim().slice(0, MAX_CHARS);
  if (!text || game.ended) return;
  box.value = '';
  updateCount();
  game.charsSent += text.length;
  game.messagesSent += 1;
  addLog('principal', text);
  updateStats();
  setStatus(`Sent (${text.length} characters).`);
  if (MANUAL) return runManual(text);
  if (game.running) {
    game.pending.push(text);
    setStatus('Sent. The robot will get it after its current action', 'busy');
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
  for (const id of ['send', 'end', 'msg']) $(id).disabled = true;
  updateStats();

  const { match, cellsOff } = matchStats();
  const record = {
    level: LEVEL.id,
    agent: MANUAL ? 'manual' : 'llm',
    startedAt: game.startedAt && new Date(game.startedAt).toISOString(),
    elapsedMs: elapsedMs(),
    inputTokens: game.inTok,
    outputTokens: game.outTok,
    charsSent: game.charsSent,
    messagesSent: game.messagesSent,
    robotActions: game.state.actions,
    match,
    cellsOff,
    instructions: game.state.instructions,
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
    const note = `Score submitted: ${cellsOff} mismatched tiles in ${formatTime(record.elapsedMs)}.`;
    addLog('system', note);
    setStatus(note);
  } catch {
    // No server (or it failed): save the record locally instead.
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
    a.download = `teamwork-${LEVEL.id}-${Date.now()}.json`;
    a.click();
    addLog('system', 'Could not reach the server, so the score record was downloaded instead.');
    setStatus('Could not reach the server, so the score record was downloaded instead.', 'error');
  }
}

$('send').addEventListener('click', send);
$('msg').addEventListener('input', updateCount);
$('msg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); send(); }
});
$('end').addEventListener('click', endGame);

drawGrid(targetCanvas, TARGET);
redraw();
renderDebug();
setInterval(() => { if (!game.ended) updateStats(); }, 500);
