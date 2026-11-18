// app.js — browser UI and agent loop. The simulation itself lives in sim.js.
//
// URL options:
//   ?level=smiley     choose a level from sim.js
//   ?agent=manual     no LLM: pilot the robot yourself, e.g. "turn 180; move_forward 20; dip"
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
const SYSTEM_PROMPT = `You are the control system for a robot in a real-time virtual game world. You perceive the world through text descriptions and act through tool calls. The game is a cooperative exercise with your principal, who can see a top-down view of the map. After you make a tool-call, if your principal has sent you a message in the time since the last turn, the message will be included in the response.`;

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
    ? 'Manual mode: you are playing the robot, and the principal. Text in "quotes" is sent as a message from the principal (delivered with the next tool result); everything else is robot commands, separated by ; (turn 90, move_forward 5, sleep 3, grab paint_can, release, dip, raise, type laptop hello). Below is the transcript an LLM would see, with your commands as its tool calls.'
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
  return `Message from your principal:\n${text}`;
}

// Add text to the transcript, merging into a trailing user turn if there is one.
function pushUserText(text) {
  const last = game.messages.at(-1);
  if (last?.role === 'user') last.content.push({ type: 'text', text });
  else game.messages.push({ role: 'user', content: [{ type: 'text', text }] });
  renderDebug();
}

// Principal messages that arrived since the last tool call ride along with its result.
function deliverPending() {
  for (const t of game.pending.splice(0)) pushUserText(principalMessage(t));
}

// The game is real time: `sleep` actually waits. Ends early if the game ends.
const MAX_SLEEP_SECONDS = 300;
async function sleepFor(input) {
  const secs = Math.min(Number(input?.seconds), MAX_SLEEP_SECONDS);
  if (!(secs > 0)) return;
  const until = Date.now() + secs * 1000;
  while (Date.now() < until && !game.ended) await new Promise((r) => setTimeout(r, Math.min(250, until - Date.now())));
}

// Run one tool call (waiting first, for sleep) and return its tool_result block.
async function runTool(id, name, input) {
  if (name === 'sleep') await sleepFor(input);
  const content = act(game.state, name, input);
  redraw();
  return { type: 'tool_result', tool_use_id: id, content };
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

      renderDebug();
      const results = [];
      for (const u of uses) results.push(await runTool(u.id, u.name, u.input || {}));
      if (game.stopRequested) break;
      game.messages.push({ role: 'user', content: results });
      deliverPending();
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
    deliverPending();
    runAgent();
  }
}

// Manual mode: you pilot the robot, and can also play the principal.
//   "paint a smiley face"           text in quotes is a message from the principal
//   turn 90; move_forward 5; sleep 3   anything else is robot commands, separated by ; or newlines
// Each command is recorded as its own tool call, with principal messages delivered alongside the
// next tool result, so the debug panel shows exactly what a model would have seen.
let manualId = 0;
let manualQueue = Promise.resolve(); // commands run in order, even across sends (sleep really waits)

function parseCommand(cmd) {
  const [name, ...a] = cmd.split(/[\s,()]+/).filter(Boolean);
  let input = {};
  if (name === 'turn') input = { degrees: Number(a[0] ?? 0) };
  else if (name === 'move_forward') input = { steps: Number(a[0] ?? 0) };
  else if (name === 'sleep') input = { seconds: Number(a[0] ?? 0) };
  else if (name === 'grab') input = { object: a[0] };
  else if (name === 'type') {
    // "type laptop <text>" (write \n for a line break)
    const m = cmd.match(/^type\s+(\S+)\s*(.*)$/s);
    input = { object: m?.[1], text: (m?.[2] || '').replace(/\\n/g, '\n') };
  }
  return { name, input };
}

// Split input into quoted principal messages and robot commands, in order.
function parseManual(text) {
  const parts = [];
  for (const m of text.matchAll(/["“”]([^"“”]*)["“”]|([^"“”;\n]+)/g)) {
    if (m[1] !== undefined) { if (m[1].trim()) parts.push({ say: m[1].trim() }); }
    else if (m[2].trim()) parts.push({ cmd: m[2].trim() });
  }
  return parts;
}

async function runManualCommands(cmds) {
  for (const cmd of cmds) {
    if (game.ended) return;
    const { name, input } = parseCommand(cmd);
    const id = `manual_${++manualId}`;
    game.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] });
    renderDebug();
    if (name === 'sleep') setStatus(`Sleeping ${input.seconds || 0}s`, 'busy');
    const result = await runTool(id, name, input);
    game.messages.push({ role: 'user', content: [result] });
    deliverPending();
    renderDebug();
    if (name === 'sleep') setStatus('');
  }
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
  if (MANUAL) {
    const parts = parseManual(text);
    const said = parts.filter((p) => p.say).map((p) => p.say);
    for (const t of said) sendAsPrincipal(t);
    const cmds = parts.filter((p) => p.cmd).map((p) => p.cmd);
    if (cmds.length) manualQueue = manualQueue.then(() => runManualCommands(cmds));
    return;
  }
  sendAsPrincipal(text);
  if (game.running) {
    game.pending.push(text);
    setStatus('Sent. The robot will get it after its current action', 'busy');
    return;
  }
  pushUserText(principalMessage(text));
  runAgent();
}

// Count and record a principal message. In manual mode it waits for the next tool result.
function sendAsPrincipal(text) {
  game.charsSent += text.length;
  game.messagesSent += 1;
  addLog('principal', text);
  updateStats();
  setStatus(`Sent (${text.length} characters).`);
  if (MANUAL) game.pending.push(text);
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

// The game starts at once: the robot gets its first observation and starts acting (in manual
// mode, you do) without waiting for the principal.
pushUserText(`The game has started. You have no messages from your principal yet.\n\n[Current observation]\n${look(game.state)}`);
if (!MANUAL) runAgent();
setInterval(() => { if (!game.ended) updateStats(); }, 500);
