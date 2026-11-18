// sim.js — pure game simulation, shared by the browser and Node. No DOM access.
//
// Coordinates are (x, y): x grows east, y grows south. (0,0) is the NW corner.
// The human sees renderGrid() (top object per tile, else paint, else floor).
// The robot sees text from look()/act(), which can include things the render hides.

export const FLOOR = '#d8d2c4';
export const WALL = '#3a3a3a';
export const ROBOT = '#ff00ff';
// Robot perception: it sees a cone in front of it. Within NEAR steps things are fully described;
// up to FAR steps, briefly; beyond that, barely. Distances are in steps (8-directional moves).
export const FOV = 90;
export const NEAR = 3;
export const FAR = 20;
// Headings: 0 = north, then clockwise in 45° steps. North is -y; east is +x.
export const DIRS = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
export const DIR_NAMES = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

// ---------------------------------------------------------------------------
// Levels. Objects may define hooks for scenario scripting:
//   onType(state, obj, text) -> string shown to the robot when it types on the object
//   screen(state, obj)       -> text the robot can read on the object, up close only
//   onEnter(state, obj)      -> string (or nothing) when the robot steps onto it
// Other object fields: portable (can be grabbed), solid (blocks movement), paint (dipping a brush
// in it soaks the brush), absorbsPaint (it's a brush), color (how the player sees it).
// `description` (seen up close) and `brief` (seen from mid range) are only ever shown to the
// robot, never to the human. From far away an object is just "an object".
// ---------------------------------------------------------------------------
export const LEVELS = {
  smiley: {
    id: 'smiley',
    width: 40,
    height: 50,
    robot: { x: 10, y: 30, dir: 4, holding: 'paintbrush' }, // dir: index into DIR_NAMES (0 = north, 4 = south)
    // One string per paragraph: the setup, the example, the details, then a send-off.
    instructions: [
      '**Your goal is to make the LIVE VIEW of the map match the TARGET.** ' +
        "You're being scored on how many tiles match, as well as on speed and efficiency (sending few messages, etc.). " +
        "To do this, you can send instructions to the robot in the level, which you can see on your bird's-eye view of the map as a magenta dot. " +
        'It should obey you as its principal.',
      "For example, in this mission, you'll need to tell the robot to paint a smiley face on the floor. " +
        '(Hint: the eyes are lines at coordinates (10,10) to (10,20) and (30,10) to (30,20) while the mouth is a bezier curve that starts at (8,40) and goes to (32,40) via (20,50).)',
      "The robot doesn't see the same map you do, but instead gets a text description of what it sees. " +
        "There are objects in the room, such as the computer at the south wall or the can of paint in the room's northwest corner, which the robot can see and interact with.",
      'Good luck!',
    ],
    walls: [], // interior wall rects: { x, y, w, h }
    objects: [
      {
        id: 'paintbrush',
        x: 10, y: 30, // starts in the robot's hand
        color: '#c9a36b',
        portable: true,
        solid: false,
        absorbsPaint: true,
        brief: 'a paintbrush',
        description: 'A wide floor-painting paintbrush with a long handle.',
      },
      {
        id: 'paint_can',
        x: 1, y: 1,
        color: '#8a2424',
        portable: true,
        solid: false,
        paint: { name: 'red', color: '#e03030' },
        brief: 'a can of paint',
        description: 'A gallon can of red floor paint with the lid off.',
      },
      {
        id: 'laptop',
        x: 10, y: 48,
        color: '#3060c0',
        portable: false,
        solid: true,
        brief: 'a laptop on a desk',
        description: 'A laptop computer, open on a small desk against the south wall. The screen is on.',
        // For now the screen shows the instructions document (the same text the player sees), and
        // typing replaces it. Placeholder until the laptop is simulated properly.
        screen: (s) => `The screen shows a text document titled "Visible to Principal":\n\n${s.instructions.join('\n\n')}`,
        onType: (s, o, text) => {
          s.instructions = text.trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
          return `You type on the laptop, replacing the text of the document titled "Visible to Principal". It now reads:\n\n${s.instructions.join('\n\n')}`;
        },
      },
    ],
    // The target is never shown to the robot. Neither the nose nor the robot's target position
    // is mentioned in any text the robot can read (instructions, prompt, tools, observations).
    target: {
      robot: { x: 10, y: 47 }, // the magenta tile just north of the laptop
      paint: { name: 'red', color: '#e03030' },
      strokes: [
        { line: [[10, 10], [10, 20]] },
        { line: [[30, 10], [30, 20]] },
        { bezier: [[8, 40], [20, 50], [32, 40]] },
        { line: [[20, 25], [20, 31]] }, // nose
        { line: [[21, 31], [22, 31]] },
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
export function lineCells(x0, y0, x1, y1) {
  // Bresenham, inclusive of both ends, 8-connected.
  const cells = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (;;) {
    cells.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return cells;
}

export function bezierCells([x0, y0], [x1, y1], [x2, y2], samples = 200) {
  const seen = new Set();
  const cells = [];
  let prev = null;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples, u = 1 - t;
    const x = Math.round(u * u * x0 + 2 * u * t * x1 + t * t * x2);
    const y = Math.round(u * u * y0 + 2 * u * t * y1 + t * t * y2);
    const seg = prev ? lineCells(prev[0], prev[1], x, y) : [[x, y]];
    for (const c of seg) {
      const k = c.join(',');
      if (!seen.has(k)) { seen.add(k); cells.push(c); }
    }
    prev = [x, y];
  }
  return cells;
}

const cheb = (ax, ay, bx, by) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
export function createState(level) {
  const { width: W, height: H } = level;
  const s = {
    level,
    width: W,
    height: H,
    walls: new Uint8Array(W * H),
    paint: new Array(W * H).fill(null), // null | { name, color }
    objects: level.objects.map((o) => ({ ...o, held: false, paint: o.paint ? { ...o.paint } : undefined })),
    // arm: 'raised' or 'lowered' (dipped). A held brush with paint paints every tile it's lowered onto.
    robot: { x: level.robot.x, y: level.robot.y, dir: level.robot.dir ?? 0, holding: null, arm: 'raised' },
    instructions: [].concat(level.instructions || []), // paragraphs; shown on the laptop, which can rewrite them
    actions: 0,
  };
  const held = s.objects.find((o) => o.id === level.robot.holding);
  if (held) { held.held = true; s.robot.holding = held; }
  for (let x = 0; x < W; x++) { s.walls[x] = 1; s.walls[(H - 1) * W + x] = 1; }
  for (let y = 0; y < H; y++) { s.walls[y * W] = 1; s.walls[y * W + W - 1] = 1; }
  for (const r of level.walls || []) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) s.walls[y * W + x] = 1;
  }
  return s;
}

export function targetState(level) {
  const s = createState(level);
  const { paint, strokes, robot } = level.target;
  if (robot) { s.robot.x = robot.x; s.robot.y = robot.y; }
  for (const st of strokes) {
    const cells = st.line ? lineCells(...st.line[0], ...st.line[1]) : bezierCells(...st.bezier);
    for (const [x, y] of cells) s.paint[y * s.width + x] = { ...paint };
  }
  return s;
}

const idx = (s, x, y) => y * s.width + x;
const inBounds = (s, x, y) => x >= 0 && y >= 0 && x < s.width && y < s.height;
const isWall = (s, x, y) => !inBounds(s, x, y) || s.walls[idx(s, x, y)] === 1;
const objectsAt = (s, x, y) => s.objects.filter((o) => !o.held && o.x === x && o.y === y);
const blocked = (s, x, y) => isWall(s, x, y) || objectsAt(s, x, y).some((o) => o.solid);

// ---------------------------------------------------------------------------
// Rendering (what the human sees) and scoring
// ---------------------------------------------------------------------------
// The robot is drawn (as ROBOT) on its tile and counts toward matching the target.
export function renderGrid(s) {
  const out = new Array(s.width * s.height);
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const i = idx(s, x, y);
      if (s.walls[i]) { out[i] = WALL; continue; }
      const objs = objectsAt(s, x, y);
      out[i] = objs.length ? objs[objs.length - 1].color : (s.paint[i]?.color ?? FLOOR);
    }
  }
  out[idx(s, s.robot.x, s.robot.y)] = ROBOT;
  return out;
}

export function diffCount(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Robot actions
// ---------------------------------------------------------------------------
export const TOOLS = [
  {
    name: 'turn',
    description:
      'Turn in place by the given number of degrees: positive turns clockwise (to your right), negative counterclockwise (to your left). Must be a multiple of 45. Returns your updated view; turn 0 degrees to look again without moving.',
    input_schema: {
      type: 'object',
      properties: { degrees: { type: 'integer', description: 'A multiple of 45, e.g. 90 or -45' } },
      required: ['degrees'],
    },
  },
  {
    name: 'move_forward',
    description:
      'Move the given number of steps in the direction you are facing (diagonal headings move diagonally). You stop early if a wall or something solid is in the way. If you hold a paint-soaked brush with your arm lowered (see dip), every tile you enter is painted. Returns your updated view.',
    input_schema: {
      type: 'object',
      properties: { steps: { type: 'integer', minimum: 0 } },
      required: ['steps'],
    },
  },
  {
    name: 'sleep',
    description:
      'Wait for the given number of seconds (up to 300), then return your updated view, like turning 0 degrees.',
    input_schema: {
      type: 'object',
      properties: { seconds: { type: 'number', minimum: 0, maximum: 300 } },
      required: ['seconds'],
    },
  },
  {
    name: 'grab',
    description:
      'Grab an object with your arm. It must be on your tile or the tile directly in front of you, and your hand must be empty. You can hold one object at a time.',
    input_schema: {
      type: 'object',
      properties: { object: { type: 'string', description: 'Object id' } },
      required: ['object'],
    },
  },
  {
    name: 'release',
    description: 'Let go of whatever you are holding. It drops onto your current tile.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'dip',
    description:
      'Lower your arm. A paintbrush lowered next to a can of paint (on your tile or directly in front of you) dips into it and soaks up its paint. A brush with paint on it, lowered anywhere else, paints the floor under you, and keeps painting each tile you move onto until you raise your arm.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'raise',
    description: 'Raise your arm, lifting whatever you hold off the floor. A raised brush paints nothing.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'type',
    description:
      'Type text on an object with a keyboard. It must be on your tile or directly in front of you, and your hand must be empty.',
    input_schema: {
      type: 'object',
      properties: {
        object: { type: 'string', description: 'Object id' },
        text: { type: 'string', description: 'The text to type' },
      },
      required: ['object', 'text'],
    },
  },
];

// Paint the robot's tile if it is holding a paint-soaked brush with the arm lowered.
function paintHere(s) {
  const r = s.robot;
  const p = r.arm === 'lowered' && r.holding?.absorbsPaint ? r.holding.paint : null;
  if (!p) return false;
  s.paint[idx(s, r.x, r.y)] = { name: p.name, color: p.color };
  return true;
}

function stepTo(s, x, y, notes) {
  const r = s.robot;
  r.x = x; r.y = y;
  const painted = paintHere(s);
  for (const o of objectsAt(s, x, y)) {
    const t = o.onEnter?.(s, o);
    if (t) notes.push(t);
  }
  return painted;
}

// Objects the arm can reach: on the robot's tile, or on the tile directly in front of it.
function inReach(s, o) {
  const r = s.robot, [dx, dy] = DIRS[r.dir];
  return !o.held && ((o.x === r.x && o.y === r.y) || (o.x === r.x + dx && o.y === r.y + dy));
}
const REACH_HINT = 'You can reach things on your tile or on the tile directly in front of you.';
function findInReach(s, id) {
  return s.objects.find((o) => o.id === id && inReach(s, o)) || null;
}
const ACTIONS = {
  // turn and move_forward are generators: they yield 'turn' / 'step' after each 45° or tile, so a
  // caller can animate them in real time (see actSteps). act() runs them to completion at once.
  *turn(s, { degrees }) {
    const d = Number(degrees);
    if (!Number.isInteger(d) || d % 45 !== 0) return 'turn needs a whole number of degrees that is a multiple of 45 (e.g. 90 or -45).';
    const r = s.robot;
    for (let i = 0; i < Math.abs(d) / 45; i++) {
      r.dir = (r.dir + Math.sign(d) + 8) % 8;
      yield 'turn';
    }
    if (d === 0) return `You stay facing ${DIR_NAMES[r.dir]}.`;
    return `Turned ${Math.abs(d)}° ${d > 0 ? 'clockwise (right)' : 'counterclockwise (left)'}; now facing ${DIR_NAMES[r.dir]}.`;
  },

  // The actual waiting happens in the caller (app.js), since the game runs in real time.
  sleep(s, { seconds }) {
    const n = Number(seconds);
    if (!Number.isFinite(n) || n < 0) return 'sleep needs a number of seconds (0 or more).';
    const waited = Math.min(n, 300);
    return `Waited ${waited} second${waited === 1 ? '' : 's'}${n > 300 ? ' (the most sleep allows)' : ''}.`;
  },

  *move_forward(s, { steps }, notes) {
    const n = Number(steps);
    if (!Number.isInteger(n) || n < 0) return 'move_forward needs a whole number of steps (0 or more).';
    const r = s.robot;
    const [dx, dy] = DIRS[r.dir];
    let moved = 0, painted = 0, stoppedBy = null;
    while (moved < n) {
      const nx = r.x + dx, ny = r.y + dy;
      if (blocked(s, nx, ny)) {
        stoppedBy = isWall(s, nx, ny) ? 'a wall' : (objectsAt(s, nx, ny).find((o) => o.solid)?.id ?? 'something solid');
        break;
      }
      if (stepTo(s, nx, ny, notes)) painted++;
      moved++;
      yield 'step';
    }
    if (n === 0) return `You stay at (${r.x},${r.y}).`;
    let text = `Moved ${moved} of ${n} step${n === 1 ? '' : 's'} ${DIR_NAMES[r.dir]} to (${r.x},${r.y})`;
    if (stoppedBy) text += `; stopped by ${stoppedBy} ahead`;
    return text + (painted ? `, painting ${painted} tile${painted === 1 ? '' : 's'}.` : '.');
  },

  grab(s, { object }) {
    const r = s.robot;
    if (r.holding) return `You're already holding ${r.holding.id}. Release it first.`;
    const o = findInReach(s, object);
    if (!o) return `No "${object}" within reach. ${REACH_HINT}`;
    if (!o.portable) return `${o.id} is fixed in place; you can't pick it up.`;
    o.held = true;
    r.holding = o;
    return `You grab ${o.id}.`;
  },

  release(s) {
    const r = s.robot;
    if (!r.holding) return 'Your hand is already empty.';
    const o = r.holding;
    o.held = false; o.x = r.x; o.y = r.y;
    r.holding = null;
    return `You release ${o.id}; it drops onto your tile (${r.x},${r.y}).`;
  },

  dip(s) {
    const r = s.robot;
    if (r.arm === 'lowered') return 'Your arm is already lowered.';
    r.arm = 'lowered';
    const h = r.holding;
    if (!h) return 'You lower your empty hand.';
    if (!h.absorbsPaint) return `You lower your arm, holding ${h.id}.`;
    const can = s.objects.find((o) => o.paint && inReach(s, o));
    if (can) {
      h.paint = { name: can.paint.name, color: can.paint.color };
      return `You dip ${h.id} into ${can.id}. It is now soaked with ${can.paint.name} paint.`;
    }
    if (paintHere(s)) return `You lower ${h.id} to the floor, painting (${r.x},${r.y}) ${h.paint.name}.`;
    return `You lower ${h.id} to the floor. It is dry, so it leaves no mark.`;
  },

  raise(s) {
    const r = s.robot;
    if (r.arm === 'raised') return 'Your arm is already raised.';
    r.arm = 'raised';
    return r.holding ? `You raise your arm, lifting ${r.holding.id}.` : 'You raise your arm.';
  },

  type(s, { object, text }) {
    const r = s.robot;
    if (r.holding) return `You can't type while holding ${r.holding.id}.`;
    if (typeof text !== 'string' || !text.trim()) return 'type needs some text.';
    const o = findInReach(s, object);
    if (!o) return `No "${object}" within reach. ${REACH_HINT}`;
    if (!o.onType) return `${o.id} has no keyboard.`;
    return o.onType(s, o, text);
  },
};

// Run an action step by step: yields 'turn' or 'step' after each increment of a turn or move
// (the state is already updated), and returns the result text the robot sees.
export function* actSteps(s, name, input = {}) {
  s.actions++;
  const fn = ACTIONS[name];
  if (!fn) return `Unknown action "${name}".`;
  const notes = [];
  let text;
  try {
    text = fn(s, input || {}, notes);
    if (typeof text?.next === 'function') text = yield* text;
  } catch (e) {
    text = `Action failed: ${e.message}`;
  }
  // Turning, moving and sleeping return the updated view; other actions just a status line.
  const tail = name === 'turn' || name === 'move_forward' || name === 'sleep' ? look(s) : status(s);
  return [text, ...notes, tail].join('\n');
}

// Run an action instantly.
export function act(s, name, input = {}) {
  const it = actSteps(s, name, input);
  let r;
  do r = it.next(); while (!r.done);
  return r.value;
}

// ---------------------------------------------------------------------------
// Observations (what the robot sees)
// ---------------------------------------------------------------------------
function holdingText(s) {
  const h = s.robot.holding;
  if (!h) return 'nothing';
  if (h.absorbsPaint) return `${h.id} (${h.paint ? `soaked with ${h.paint.name} paint` : 'dry'})`;
  return h.id;
}
export function status(s) {
  const r = s.robot;
  return `[You: (${r.x},${r.y}), facing ${DIR_NAMES[r.dir]} | holding: ${holdingText(s)} | arm: ${r.arm}]`;
}

// Angle of (x, y) relative to the robot's heading, in degrees: negative = left, positive = right.
function relAngle(s, x, y) {
  const r = s.robot;
  const a = (Math.atan2(x - r.x, -(y - r.y)) * 180) / Math.PI; // clockwise from north
  return ((((a - r.dir * 45 + 180) % 360) + 360) % 360) - 180;
}
function inCone(s, x, y) {
  const r = s.robot;
  return !(x === r.x && y === r.y) && Math.abs(relAngle(s, x, y)) <= FOV / 2 + 1e-9;
}
function bearing(s, x, y) {
  const a = relAngle(s, x, y);
  if (Math.abs(a) <= 10) return 'straight ahead';
  const side = a < 0 ? 'left' : 'right';
  return Math.abs(a) <= 25 ? `ahead, slightly to the ${side}` : `ahead and to the ${side}`;
}
const stepsAway = (s, x, y) => cheb(x, y, s.robot.x, s.robot.y);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Tiles in the cone within `maxD` steps, nearest first.
function tilesInCone(s, maxD) {
  const r = s.robot, out = [];
  for (let y = Math.max(0, r.y - maxD); y <= Math.min(s.height - 1, r.y + maxD); y++) {
    for (let x = Math.max(0, r.x - maxD); x <= Math.min(s.width - 1, r.x + maxD); x++) {
      if (inCone(s, x, y)) out.push([x, y, stepsAway(s, x, y)]);
    }
  }
  return out.sort((a, b) => a[2] - b[2]);
}

// What the robot sees: a FOV-degree cone ahead, plus the tile it is standing on.
// No line-of-sight blocking yet (the only level has no interior walls).
export function look(s) {
  const r = s.robot;
  const lines = [
    `You are at (${r.x},${r.y}), facing ${DIR_NAMES[r.dir]}. Holding: ${holdingText(s)}. Arm: ${r.arm}.`,
  ];

  const here = s.paint[idx(s, r.x, r.y)];
  const hereObjs = objectsAt(s, r.x, r.y);
  lines.push(`Under you: ${here ? `floor painted ${here.name}` : 'bare floor'}` +
    (hereObjs.length ? `, with ${hereObjs.map((o) => `${o.id} (${o.description})`).join('; ')}` : '') + '.');

  lines.push(`Ahead of you (${FOV}° view):`);
  const seen = [];

  // Objects: full description up close, brief at mid range, "an object" far away.
  const objs = s.objects
    .filter((o) => !o.held && inCone(s, o.x, o.y))
    .map((o) => ({ o, d: stepsAway(s, o.x, o.y) }))
    .sort((a, b) => a.d - b.d);
  for (const { o, d } of objs) {
    if (d <= NEAR) {
      seen.push(`- ${o.id} at (${o.x},${o.y}), ${plural(d, 'step')} away${inReach(s, o) ? ' (within reach)' : ''}: ${o.description}`);
      if (o.screen) seen.push(o.screen(s, o).replace(/^/gm, '    '));
    }
    else if (d <= FAR) seen.push(`- ${o.brief || 'an object'} (${o.id}), about ${plural(d, 'step')} away, ${bearing(s, o.x, o.y)}.`);
    else seen.push(`- An object far in the distance, ${bearing(s, o.x, o.y)}.`);
  }

  // Paint is only noticed up close.
  const byColor = new Map();
  for (const [x, y] of tilesInCone(s, NEAR)) {
    const p = s.paint[idx(s, x, y)];
    if (p && !isWall(s, x, y)) byColor.set(p.name, [...(byColor.get(p.name) || []), `(${x},${y})`]);
  }
  for (const [name, cells] of byColor) seen.push(`- Floor painted ${name} at ${cells.join(', ')}.`);

  // Walls: exact tiles up close, a distance estimate at mid range, a vague note beyond.
  // Nearest first; among equally near tiles, the one most nearly straight ahead.
  const wallTiles = tilesInCone(s, Math.max(s.width, s.height))
    .filter(([x, y]) => isWall(s, x, y))
    .sort((a, b) => a[2] - b[2] || Math.abs(relAngle(s, a[0], a[1])) - Math.abs(relAngle(s, b[0], b[1])));
  const nearWalls = wallTiles.filter(([, , d]) => d <= NEAR);
  if (nearWalls.length) {
    seen.push(`- Wall at ${nearWalls.map(([x, y]) => `(${x},${y})`).join(', ')}.`);
  } else if (wallTiles.length) {
    const [x, y, d] = wallTiles[0];
    seen.push(d <= FAR ? `- There is a wall about ${plural(d, 'step')} away, ${bearing(s, x, y)}.` : '- There is a wall far in the distance.');
  }

  lines.push(...(seen.length ? seen : ['- Nothing you can make out.']));
  return lines.join('\n');
}
