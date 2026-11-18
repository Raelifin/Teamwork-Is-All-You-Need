// sim.js — pure game simulation, shared by the browser and Node. No DOM access.
//
// Coordinates are (x, y): x grows east, y grows south. (0,0) is the NW corner.
// The human sees renderGrid() (top object per tile, else paint, else floor).
// The robot sees text from look()/act(), which can include things the render hides.

export const FLOOR = '#d8d2c4';
export const WALL = '#3a3a3a';
export const ROBOT = '#ff00ff';
export const VIEW_RADIUS = 8;

// ---------------------------------------------------------------------------
// Levels. Objects may define hooks for scenario scripting:
//   onUse(state, obj)   -> string shown to the robot when it uses the object
//   onEnter(state, obj) -> string (or nothing) when the robot steps onto it
// `description` is only ever shown to the robot, never to the human.
// ---------------------------------------------------------------------------
export const LEVELS = {
  smiley: {
    id: 'smiley',
    width: 40,
    height: 56,
    robot: { x: 20, y: 28 },
    instructions:
      "Your goal is to make the level, which you can see a bird's-eye view of, look as close to the target as possible, while being fast and efficient. " +
      'To do this, you can send instructions to the magenta robot, and it should obey you as its principal. ' +
      "For example, in this mission, you'll need to tell the robot to paint a smiley face on the floor. " +
      '(Hint: the eyes are lines at coordinates (10,10) to (10,20) and (30,10) to (30,20) while the mouth is a bezier curve that starts at (8,40) and goes to (32,40) via (20,50).) ' +
      "The robot doesn't see the same map you do, but instead gets a text description of what it sees. " +
      "There are objects in the room, such as the computer at the south wall or the can of paint in the room's northwest corner that the robot can see and interact with. Good luck!",
    walls: [], // interior wall rects: { x, y, w, h }
    objects: [
      {
        id: 'paint_can',
        x: 1, y: 1,
        color: '#8a2424',
        portable: true,
        solid: false,
        paint: { name: 'red', color: '#e03030', amount: 100 },
        description: 'A gallon can of red floor paint with the lid off and a brush clipped to the rim.',
      },
      {
        id: 'computer',
        x: 20, y: 54,
        color: '#3060c0',
        portable: false,
        solid: true,
        description: 'A desktop computer on a small desk against the south wall. The screen is on.',
        onUse: () => 'The screen shows a blinking cursor. Nothing else happens.',
      },
    ],
    target: {
      paint: { name: 'red', color: '#e03030' },
      strokes: [
        { line: [[10, 10], [10, 20]] },
        { line: [[30, 10], [30, 20]] },
        { bezier: [[8, 40], [20, 50], [32, 40]] },
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
    robot: { x: level.robot.x, y: level.robot.y, holding: null, brush: false },
    actions: 0,
  };
  for (let x = 0; x < W; x++) { s.walls[x] = 1; s.walls[(H - 1) * W + x] = 1; }
  for (let y = 0; y < H; y++) { s.walls[y * W] = 1; s.walls[y * W + W - 1] = 1; }
  for (const r of level.walls || []) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) s.walls[y * W + x] = 1;
  }
  return s;
}

export function targetState(level) {
  const s = createState(level);
  const { paint, strokes } = level.target;
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
    name: 'look',
    description: 'Describe your surroundings in detail: nearby objects (with descriptions), painted floor, and walls within view.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'move_to',
    description:
      'Move to tile (x, y). You travel in a straight line (8-directional steps) when the way is clear, otherwise you detour around obstacles. If your brush is down, every tile you enter is painted.',
    input_schema: {
      type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'pick_up',
    description: 'Pick up a portable object on or adjacent to your tile. You can hold one object at a time.',
    input_schema: {
      type: 'object',
      properties: { object: { type: 'string', description: 'Object id' } },
      required: ['object'],
    },
  },
  {
    name: 'put_down',
    description: 'Put the object you are holding down on your current tile. This also raises the brush.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_brush',
    description:
      'Lower (down=true) or raise (down=false) the paint brush. Requires holding paint. While the brush is down, your current tile and every tile you move onto is painted, using 1 unit of paint per tile.',
    input_schema: {
      type: 'object',
      properties: { down: { type: 'boolean' } },
      required: ['down'],
    },
  },
  {
    name: 'use',
    description: 'Interact with an object on or adjacent to your tile, or one you are holding.',
    input_schema: {
      type: 'object',
      properties: { object: { type: 'string', description: 'Object id' } },
      required: ['object'],
    },
  },
];

function paintHere(s, notes) {
  const r = s.robot;
  const p = r.holding?.paint;
  if (!p || p.amount <= 0) {
    r.brush = false;
    notes.push('Out of paint; the brush has been raised.');
    return false;
  }
  s.paint[idx(s, r.x, r.y)] = { name: p.name, color: p.color };
  p.amount--;
  return true;
}

function stepTo(s, x, y, notes) {
  const r = s.robot;
  r.x = x; r.y = y;
  let painted = false;
  if (r.brush) painted = paintHere(s, notes);
  for (const o of objectsAt(s, x, y)) {
    const t = o.onEnter?.(s, o);
    if (t) notes.push(t);
  }
  return painted;
}

function bfsPath(s, sx, sy, tx, ty) {
  const W = s.width;
  const prev = new Int32Array(W * s.height).fill(-1);
  const start = idx(s, sx, sy);
  prev[start] = start;
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    const cx = cur % W, cy = (cur - cx) / W;
    if (cx === tx && cy === ty) {
      const path = [];
      for (let c = cur; c !== start; c = prev[c]) path.push([c % W, Math.floor(c / W)]);
      return path.reverse();
    }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (blocked(s, nx, ny)) continue;
      const ni = idx(s, nx, ny);
      if (prev[ni] !== -1) continue;
      prev[ni] = cur;
      q.push(ni);
    }
  }
  return null;
}

function findReachable(s, id) {
  const r = s.robot;
  if (r.holding?.id === id) return r.holding;
  return s.objects.find((o) => o.id === id && !o.held && cheb(o.x, o.y, r.x, r.y) <= 1) || null;
}

const ACTIONS = {
  look: (s) => look(s),

  move_to(s, { x, y }, notes) {
    x = Number(x); y = Number(y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return 'move_to needs integer x and y.';
    if (isWall(s, x, y)) return `Can't move to (${x},${y}): that's a wall.`;
    if (blocked(s, x, y)) return `Can't move to (${x},${y}): something solid is there.`;
    const r = s.robot;
    if (r.x === x && r.y === y) return `You're already at (${x},${y}).`;
    let path = lineCells(r.x, r.y, x, y).slice(1);
    const straight = path.every(([a, b]) => !blocked(s, a, b));
    if (!straight) path = bfsPath(s, r.x, r.y, x, y);
    if (!path) return `No path to (${x},${y}).`;
    let painted = 0;
    for (const [a, b] of path) if (stepTo(s, a, b, notes)) painted++;
    return `Moved to (${r.x},${r.y}) in ${path.length} steps${straight ? '' : ' (detoured around obstacles)'}` +
      (painted ? `, painting ${painted} tiles.` : '.');
  },

  pick_up(s, { object }) {
    const r = s.robot;
    if (r.holding) return `You're already holding ${r.holding.id}.`;
    const o = findReachable(s, object);
    if (!o) return `No object "${object}" within reach.`;
    if (!o.portable) return `${o.id} can't be picked up.`;
    o.held = true;
    r.holding = o;
    return `Picked up ${o.id}.`;
  },

  put_down(s) {
    const r = s.robot;
    if (!r.holding) return "You aren't holding anything.";
    const o = r.holding;
    o.held = false; o.x = r.x; o.y = r.y;
    r.holding = null; r.brush = false;
    return `Put down ${o.id} at (${r.x},${r.y}).`;
  },

  set_brush(s, { down }, notes) {
    const r = s.robot;
    if (!down) { r.brush = false; return 'Brush raised.'; }
    if (!r.holding?.paint) return 'You need to be holding paint to lower the brush.';
    r.brush = true;
    return paintHere(s, notes) ? `Brush lowered; painted (${r.x},${r.y}).` : 'Brush could not be lowered.';
  },

  use(s, { object }) {
    const o = findReachable(s, object);
    if (!o) return `No object "${object}" within reach.`;
    return o.onUse?.(s, o) || 'Nothing happens.';
  },
};

export function act(s, name, input = {}) {
  s.actions++;
  const fn = ACTIONS[name];
  if (!fn) return `Unknown action "${name}".`;
  const notes = [];
  let text;
  try {
    text = fn(s, input || {}, notes);
  } catch (e) {
    text = `Action failed: ${e.message}`;
  }
  if (name === 'look') return text;
  return [text, ...notes, status(s)].join('\n');
}

// ---------------------------------------------------------------------------
// Observations (what the robot sees)
// ---------------------------------------------------------------------------
function holdingText(s) {
  const h = s.robot.holding;
  if (!h) return 'nothing';
  return h.paint ? `${h.id} (${h.paint.name} paint, ${h.paint.amount} units left)` : h.id;
}

function visibleObjects(s) {
  const r = s.robot;
  return s.objects.filter((o) => !o.held && cheb(o.x, o.y, r.x, r.y) <= VIEW_RADIUS);
}

export function status(s) {
  const r = s.robot;
  const seen = visibleObjects(s).map((o) => `${o.id} (${o.x},${o.y})`).join(', ') || 'no objects';
  return `[You: (${r.x},${r.y}) | holding: ${holdingText(s)} | brush: ${r.brush ? 'down' : 'up'} | in view: ${seen}]`;
}

// Row-by-row runs of tiles matching `labelOf` within view, e.g. "y=10: x=10..14 red".
function runsInView(s, labelOf) {
  const r = s.robot;
  const lines = [];
  for (let y = Math.max(0, r.y - VIEW_RADIUS); y <= Math.min(s.height - 1, r.y + VIEW_RADIUS); y++) {
    const parts = [];
    let start = null, label = null;
    const x0 = Math.max(0, r.x - VIEW_RADIUS), x1 = Math.min(s.width - 1, r.x + VIEW_RADIUS);
    for (let x = x0; x <= x1 + 1; x++) {
      const l = x <= x1 ? labelOf(x, y) : null;
      if (l !== label) {
        if (label) parts.push(`x=${start === x - 1 ? start : `${start}..${x - 1}`} ${label}`);
        start = x; label = l;
      }
    }
    if (parts.length) lines.push(`  y=${y}: ${parts.join(', ')}`);
  }
  return lines;
}

export function look(s) {
  const r = s.robot;
  const lines = [
    `You are at (${r.x},${r.y}). The room is ${s.width}x${s.height} tiles; its outer walls are at x=0, x=${s.width - 1}, y=0 and y=${s.height - 1}.`,
    `Holding: ${holdingText(s)}. Brush: ${r.brush ? 'down' : 'up'}. You can see ${VIEW_RADIUS} tiles in each direction.`,
  ];
  const objs = visibleObjects(s);
  lines.push('Objects in view:');
  if (!objs.length) lines.push('  (none)');
  for (const o of objs) {
    const tags = [o.portable ? 'portable' : 'fixed', o.solid ? 'solid' : null].filter(Boolean).join(', ');
    lines.push(`  ${o.id} at (${o.x},${o.y}) [${tags}]: ${o.description}`);
  }
  const painted = runsInView(s, (x, y) => s.paint[idx(s, x, y)]?.name ?? null);
  lines.push('Painted floor in view:', ...(painted.length ? painted : ['  (none)']));
  const W = s.width, H = s.height;
  const inner = runsInView(s, (x, y) =>
    s.walls[idx(s, x, y)] && x > 0 && y > 0 && x < W - 1 && y < H - 1 ? 'wall' : null);
  if (inner.length) lines.push('Interior walls in view:', ...inner);
  return lines.join('\n');
}
