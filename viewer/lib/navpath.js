// A route on the walking map (navgrid.js): the shortest way from some floors to others, then
// straightened (straight lines wherever they stay on the floor) and told as instructions.
// Pure: runs in the worker and in the tests.
import { step, spanXYZ, cellXY, DX, DY } from "./navgrid.js";

const SQ2 = Math.SQRT2;
// walking near an edge costs a little more (the route keeps to the middle of passages)
const WALL = [1.5, 1.25, 1.1];

class Heap { // min-heap of (key, value)
  constructor() { this.k = new Float64Array(1024); this.v = new Int32Array(1024); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) { const k = new Float64Array(this.n * 2), v = new Int32Array(this.n * 2); k.set(this.k); v.set(this.v); this.k = k; this.v = v; }
    let i = this.n++;
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0], key = this.k[--this.n], val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
  topKey() { return this.k[0]; }
}

// diagonal neighbour (dx, dy) of a: both ways round the corner must be open
function diag(nav, a, dx, dy) {
  const dX = dx > 0 ? 0 : 2, dY = dy > 0 ? 1 : 3;
  const p = step(nav, a, dX), q = step(nav, a, dY);
  if (p < 0 || q < 0 || nav.blocked[p] || nav.blocked[q]) return -1;
  const r = step(nav, p, dY);
  return r >= 0 && r === step(nav, q, dX) ? r : -1;
}

// Shortest route from `starts` to `goals` ([{span, cost}]: cost added at that end). Returns the list
// of floors (with the links between decks used: {span, conn}) or null.
export function findPath(nav, starts, goals, maxVisit = 6e6) {
  const m = nav.z.length;
  if (!starts.length || !goals.length) return null;
  const g = nav._g && nav._g.length === m ? nav._g : (nav._g = new Float64Array(m));
  const from = nav._from && nav._from.length === m ? nav._from : (nav._from = new Int32Array(m));
  const via = nav._via && nav._via.length === m ? nav._via : (nav._via = new Int32Array(m));
  g.fill(Infinity); from.fill(-1); via.fill(-1);
  const goalCost = new Map();
  let gx = 0, gy = 0, gr = 0;
  for (const t of goals) { const old = goalCost.get(t.span); if (old === undefined || t.cost < old) goalCost.set(t.span, t.cost); }
  // heuristic: straight distance (in plan) to the circle around the goals
  const gp = [...goalCost.keys()].map((s) => cellXY(nav, nav.cellOf[s]));
  for (const [x, y] of gp) { gx += x; gy += y; }
  gx /= gp.length; gy /= gp.length;
  for (const [x, y] of gp) gr = Math.max(gr, Math.hypot(x - gx, y - gy));
  const h = (a) => { const [x, y] = cellXY(nav, nav.cellOf[a]); return Math.max(0, Math.hypot(x - gx, y - gy) - gr); };
  const heap = new Heap();
  for (const s of starts) {
    if (nav.blocked[s.span] || s.cost >= g[s.span]) continue;
    g[s.span] = s.cost;
    heap.push(s.cost + h(s.span), s.span);
  }
  const keep = nav.keep, cell = nav.cell;
  let best = Infinity, end = -1, visits = 0;
  const relax = (a, b, c, conn = -1) => {
    if (b < 0 || nav.blocked[b]) return;
    const k = nav.dist[b] - keep, w = k >= 0 && k < 3 ? WALL[k] : 1;
    const ng = g[a] + c * w + Math.abs(nav.z[b] - nav.z[a]) * (conn >= 0 ? 0 : 1.5);
    if (ng < g[b]) { g[b] = ng; from[b] = a; via[b] = conn; heap.push(ng + h(b), b); }
  };
  while (heap.n) {
    if (heap.topKey() >= best) break;
    const a = heap.pop();
    if (++visits > maxVisit) break;
    const gc = goalCost.get(a);
    if (gc !== undefined && g[a] + gc < best) { best = g[a] + gc; end = a; }
    for (let d = 0; d < 4; d++) relax(a, step(nav, a, d), cell);
    for (const [dx, dy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) relax(a, diag(nav, a, dx, dy), cell * SQ2);
    const cs = nav.connOf.get(a);
    if (cs) for (const i of cs) { const c = nav.conn[i]; relax(a, c.a === a ? c.b : c.a, c.cost, i); }
  }
  if (end < 0) return null;
  const out = [];
  for (let a = end; a >= 0; a = from[a]) out.push({ span: a, conn: via[a] });
  out.reverse();
  return { steps: out, cost: best };
}

// Can one walk straight from floor a to floor b (in plan), cell by cell, on linked floors? Returns
// the floors crossed (a…b) or null.
export function straight(nav, a, b) {
  const W = nav.W, ca = nav.cellOf[a], cb = nav.cellOf[b];
  let x = ca % W, y = (ca / W) | 0;
  const tx = cb % W, ty = (cb / W) | 0, nx = Math.abs(tx - x), ny = Math.abs(ty - y), sx = tx > x ? 1 : -1, sy = ty > y ? 1 : -1;
  const out = [a];
  let s = a;
  // walk the cells the segment crosses (through a corner: both sides must be open)
  for (let ix = 0, iy = 0; ix < nx || iy < ny;) {
    const dec = (0.5 + ix) / nx - (0.5 + iy) / ny;
    if (nx && ny && Math.abs(dec) < 1e-9) {
      const r = diag(nav, s, sx, sy);
      if (r < 0) return null;
      s = r; x += sx; y += sy; ix++; iy++;
    } else if (ny === 0 || (nx && dec < 0)) {
      const r = step(nav, s, sx > 0 ? 0 : 2);
      if (r < 0 || nav.blocked[r]) return null;
      s = r; x += sx; ix++;
    } else {
      const r = step(nav, s, sy > 0 ? 1 : 3);
      if (r < 0 || nav.blocked[r]) return null;
      s = r; y += sy; iy++;
    }
    out.push(s);
  }
  return s === b ? out : null;
}

// The route made straight: {points: [[x, y, z]…] (one per cell crossed, following the floor),
// turns: indices of the corners in points, legs: [{kind: "walk" | "ladder" | "door", from, to, label, node}],
// length (m)}.
export function shapeRoute(nav, path) {
  const steps = path.steps, points = [], turns = [0], legs = [];
  // pieces walked on the floor, split by the links between decks
  const pieces = [];
  let cur = [steps[0].span];
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].conn >= 0) { pieces.push({ spans: cur }); pieces.push({ conn: steps[i].conn, end: steps[i].span }); cur = [steps[i].span]; }
    else cur.push(steps[i].span);
  }
  pieces.push({ spans: cur });
  const add = (s) => { const p = spanXYZ(nav, s); const l = points[points.length - 1]; if (!l || l[0] !== p[0] || l[1] !== p[1] || l[2] !== p[2]) points.push(p); };
  for (const pc of pieces) {
    if (pc.conn !== undefined) {
      const c = nav.conn[pc.conn], from = points.length - 1;
      add(pc.end);
      if (turns[turns.length - 1] !== from) turns.push(from);
      turns.push(points.length - 1);
      legs.push({ kind: c.kind, from, to: points.length - 1, label: c.label, node: c.node });
      continue;
    }
    const sp = pc.spans, legFrom = Math.max(0, points.length - 1);
    if (!points.length) add(sp[0]);
    let i = 0;
    while (i < sp.length - 1) {
      // the farthest floor reachable in a straight line (grows while it works; a few misses allowed)
      let j = i + 1, line = [sp[i], sp[i + 1]], miss = 0;
      for (let k = i + 2; k < sp.length && miss < 12; k++) {
        const l = straight(nav, sp[i], sp[k]);
        if (l) { j = k; line = l; miss = 0; } else miss++;
      }
      for (let k = 1; k < line.length; k++) add(line[k]);
      if (j < sp.length - 1) turns.push(points.length - 1);
      i = j;
    }
    if (points.length - 1 > legFrom) legs.push({ kind: "walk", from: legFrom, to: points.length - 1 });
  }
  if (turns[turns.length - 1] !== points.length - 1) turns.push(points.length - 1);
  // between two corners the cells crossed zigzag around the straight line: put them on it (in
  // plan), keeping the height of their floor
  const T = [...new Set(turns)].sort((a, b) => a - b);
  for (let t = 0; t < T.length - 1; t++) {
    const a = points[T[t]], b = points[T[t + 1]], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    if (l2 < 1e-9) continue;
    for (let k = T[t] + 1; k < T[t + 1]; k++) {
      const p = points[k], u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
      points[k] = [a[0] + dx * u, a[1] + dy * u, p[2]];
    }
  }
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
  return { points, turns: T, legs, length };
}

// ------------------------------------------------------------------ instructions
const m1 = (v) => (v < 10 ? Math.max(0.5, Math.round(v * 2) / 2) : Math.round(v)).toLocaleString("pt-BR") + " m";
const lvl = (z) => z.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " m";
const plan = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function turnWord(a, b) { // from direction a to direction b (in plan)
  const ang = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]) * 180 / Math.PI;
  const s = ang > 0 ? "esquerda" : "direita", t = Math.abs(ang);
  if (t < 25) return null;
  if (t < 60) return "vire levemente à " + s;
  if (t < 140) return "vire à " + s;
  return "volte (meia-volta)";
}
// which side an object is on, walking along dir
export function sideOf(dir, from, at) {
  const v = [at[0] - from[0], at[1] - from[1]], l = Math.hypot(...v);
  if (l < 0.3) return "à sua frente";
  const ang = Math.atan2(dir[0] * v[1] - dir[1] * v[0], dir[0] * v[0] + dir[1] * v[1]) * 180 / Math.PI;
  return Math.abs(ang) < 40 ? "à sua frente" : Math.abs(ang) > 140 ? "atrás de você" : ang > 0 ? "à sua esquerda" : "à sua direita";
}

// Steps of the route told in words: [{text, at (index in points), dist (m from the start)}].
// goal: {name, center: [x, y, z]} (optional), decks: [{z}] (optional, to name the levels).
export function instructions(route, goal = null) {
  const { points, turns, legs } = route, out = [];
  if (points.length < 2) { out.push({ text: goal ? `Você já está junto de ${goal.name}.` : "Você já está no destino.", at: 0, dist: 0 }); return out; }
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]));
  const legAt = (i) => legs.find((l) => l.kind !== "walk" && l.from === i);
  const dirAt = (i, j) => { const a = points[i], b = points[j]; const l = plan(a, b) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  let prevDir = null, pending = 0, pendingAt = 0;
  const flush = (then) => {
    if (pending >= 0.5) out.push({ text: then ? `Siga ${m1(pending)} e ${then}` : `Siga ${m1(pending)}`, at: pendingAt, dist: cum[pendingAt] });
    else if (then) out.push({ text: then[0].toUpperCase() + then.slice(1), at: pendingAt, dist: cum[pendingAt] });
    pending = 0;
  };
  for (let t = 0; t < turns.length - 1; t++) {
    const i = turns[t], j = turns[t + 1], lg = legAt(i);
    if (lg && lg.to === j) { // a ladder or a door
      const dz = points[j][2] - points[i][2];
      flush(null);
      const what = lg.kind === "ladder" ? (lg.label ? `a escada ${lg.label}` : "a escada") : (lg.label ? `por ${lg.label}` : "pela passagem");
      out.push({ text: lg.kind === "ladder" ? `${dz > 0 ? "Suba" : "Desça"} ${what} até o nível ${lvl(points[j][2])} (${m1(Math.abs(dz))} ${dz > 0 ? "acima" : "abaixo"})` : `Passe ${what}`, at: i, dist: cum[i], kind: lg.kind });
      prevDir = null;
      pendingAt = j;
      continue;
    }
    const d = dirAt(i, j), dz = points[j][2] - points[i][2], len = cum[j] - cum[i];
    if (prevDir && pending + len > 0) {
      const w = turnWord(prevDir, d);
      if (w) { flush(w); pendingAt = i; }
    }
    if (Math.abs(dz) > 1.2) { // stairs on the way: where they start and end on this stretch
      let a = i, b = j;
      while (a < j && Math.abs(points[a][2] - points[i][2]) < 0.2) a++;
      while (b > a && Math.abs(points[j][2] - points[b - 1][2]) < 0.2) b--;
      a = Math.max(i, a - 1);
      if (!pending) pendingAt = i;
      pending += cum[a] - cum[i];
      flush(null);
      out.push({ text: `${dz > 0 ? "Suba" : "Desça"} a escada até o nível ${lvl(points[j][2])} (${m1(Math.abs(dz))} ${dz > 0 ? "acima" : "abaixo"})`, at: a, dist: cum[a], kind: "stairs" });
      pendingAt = b;
      pending = cum[j] - cum[b];
    } else {
      if (!pending) pendingAt = i;
      pending += len;
    }
    prevDir = d;
  }
  flush(null);
  const last = points[points.length - 1];
  let where = "";
  if (goal && goal.center) {
    const k = Math.max(0, points.length - 4), dir = dirAt(k, points.length - 1);
    where = " — " + sideOf(dir, last, goal.center);
    if (goal.base != null && goal.base - last[2] > 2) where += `, no alto (a ${m1(goal.base - last[2])} do piso)`;
    else if (goal.top != null && goal.top < last[2] - 0.3) where += ", abaixo do piso";
  }
  out.push({ text: goal ? `Chegou: ${goal.name}${where}.` : "Chegou.", at: points.length - 1, dist: cum[points.length - 1], kind: "arrive" });
  return out;
}

// position and heading at `s` metres along the route: {p: [x, y, z], dir: [dx, dy], i (segment)}
export function along(route, s) {
  const P = route.points;
  if (P.length < 2) return { p: P[0] || [0, 0, 0], dir: [1, 0], i: 0 };
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (s <= l || i === P.length - 1) {
      const k = l ? Math.max(0, Math.min(1, s / l)) : 1;
      return { p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k], i, dir: aheadDir(route, i) };
    }
    s -= l;
  }
  return { p: P[P.length - 1], dir: aheadDir(route, P.length - 1), i: P.length - 1 };
}
// heading in plan near point i, looking a couple of metres ahead (vertical bits are skipped)
function aheadDir(route, i) {
  const P = route.points, a = P[Math.max(0, i - 1)];
  for (let j = i; j < P.length; j++) { const l = plan(a, P[j]); if (l > 1.5 || j === P.length - 1) return l > 1e-6 ? [(P[j][0] - a[0]) / l, (P[j][1] - a[1]) / l] : [1, 0]; }
  return [1, 0];
}
export { DX, DY };
