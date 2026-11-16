// Walking map of a model ("mapa de caminhada"): where a person can stand and walk, deck by deck.
//
// It is built from top-down depth renders of the model cut at increasing heights (slices). For
// each cell of a horizontal grid, slice k gives the highest surface below the cut. Going up, the
// value of a cell only grows, and every new value is a new surface in that column: a floor, the
// bottom of a beam (seen from inside once the cut goes through it), a pipe… The distance to the
// next one is the free height above it, and a surface with enough free height is a floor. The
// renders also tell when what is seen is the inside of a solid (a back face): the cut is then
// inside that solid, so the space right over the surface below is taken — a wall or an equipment
// standing on the floor shows only its base, at the floor's height, until the cut passes its top.
// Neighbouring floors within a step height are linked (stairs pass step by step); floors next to
// a wall, a railing or an edge are dropped by the body radius. Ladders (found by name) and links
// drawn by hand join the decks that steps do not join.
//
// Pure (no DOM, no three.js): it runs in a worker (navworker.js) and in the tests.

export const DEFAULTS = {
  cell: 0.2,    // m: grid cell
  sub: 3,       // pixels per cell side in the renders (thin bars and railings are not missed)
  dz: 0.2,      // m between slices
  head: 1.8,    // m: free height needed over a floor
  step: 0.4,    // m: the most a step can rise between two cells
  radius: 0.25, // m: half the width of a person (keeps the path off walls and railings)
};
const MERGE = 0.06; // m: values of a column closer than this are the same surface
const HOLE = 0.04;  // m: the two sides of a grating hole are at the same height
const INF = 1e9;
// the 4 directions of the links: +x, +y, -x, -y
export const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

// ------------------------------------------------------------------ from the renders
// One render (rw × rh pixels, `sub` per cell, rows from the bottom) of view depths (float bits in
// RGBA bytes: 0 = nothing, negative = a back face, the inside of a solid) from a camera at height
// camZ looking down → the highest surface of each cell (tops: cw × ch cells, NaN where nothing
// was drawn) and whether it is the inside of a solid (inside: 1). On a tie the inside wins.
export function tileTops(bytes, rw, rh, sub, camZ, cw, ch, tops, inside) {
  const f = new Float32Array(bytes.buffer, bytes.byteOffset, rw * rh);
  tops.fill(NaN, 0, cw * ch);
  inside.fill(0, 0, cw * ch);
  for (let y = 0; y < rh; y++) {
    const cy = Math.min(ch - 1, (y / sub) | 0), row = y * rw;
    for (let x = 0; x < rw; x++) {
      const d = f[row + x];
      if (!(d !== 0) || d !== d) continue;
      const back = d < 0, z = camZ - Math.abs(d), c = cy * cw + Math.min(cw - 1, (x / sub) | 0), o = tops[c];
      if (o !== o || z > o + 1e-4) { tops[c] = z; inside[c] = back ? 1 : 0; }
      else if (back && z > o - 1e-4) inside[c] = 1;
    }
  }
}

// Collects the surfaces of every column, slice by slice (lowest cut first).
// useInside: false ignores the back faces (for models whose faces are turned the wrong way).
export function createBuilder({ W, H, x0, y0, cell }, useInside = true) {
  const n = W * H;
  const last = new Float32Array(n).fill(NaN), lastIn = new Uint8Array(n);
  let cap = 1 << 16, sc = new Uint32Array(cap), sz = new Float32Array(cap), sf = new Float32Array(cap), si = new Uint8Array(cap), ns = 0;
  function push(c, z, free, inside) {
    if (ns === cap) {
      cap *= 2;
      const a = new Uint32Array(cap), b = new Float32Array(cap), d = new Float32Array(cap), e = new Uint8Array(cap);
      a.set(sc); b.set(sz); d.set(sf); e.set(si); sc = a; sz = b; sf = d; si = e;
    }
    sc[ns] = c; sz[ns] = z; sf[ns] = free; si[ns] = inside; ns++;
  }
  return {
    // tops (and inside, or null) of the cells of the rectangle (rx, ry, rw, rh) of the grid, row by
    // row from ry; NaN = nothing
    slice(rx, ry, rw, rh, tops, inside = null) {
      for (let j = 0; j < rh; j++) {
        const base = (ry + j) * W + rx;
        for (let i = 0; i < rw; i++) {
          const t = tops[j * rw + i];
          if (t !== t) continue;
          const c = base + i, l = last[c], f = useInside && inside ? inside[j * rw + i] : 0;
          if (l !== l) { last[c] = t; lastIn[c] = f; continue; }
          if (t - l < MERGE) { if (t > l) last[c] = t; lastIn[c] = f; continue; }
          push(c, l, t - l, lastIn[c]);
          last[c] = t; lastIn[c] = f;
        }
      }
    },
    // All the surfaces: {start (per cell), z, free}. Inside a solid nothing is free over a surface.
    // Seen from above everything, the top of each column must be the outside of something: when
    // most of them look like insides, the model's faces are turned the other way round (then what
    // looked inside is outside).
    surfaces() {
      let cols = 0, topIn = 0;
      for (let c = 0; c < n; c++) if (last[c] === last[c]) { cols++; topIn += lastIn[c]; push(c, last[c], INF, 0); last[c] = NaN; }
      const flip = topIn > cols / 2 ? 1 : 0;
      for (let i = 0; i < ns; i++) if (sf[i] < INF && (si[i] ^ flip)) sf[i] = 0;
      this.flipped = !!flip;
      return csr(n, sc, sz, sf, ns);
    },
    flipped: false,
    grid: { W, H, x0, y0, cell },
  };
}

// counting sort by cell (stable: each column stays from the bottom up)
function csr(n, sc, sz, sf, ns) {
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < ns; i++) start[sc[i] + 1]++;
  for (let c = 0; c < n; c++) start[c + 1] += start[c];
  const pos = start.slice(0, n), z = new Float32Array(ns), free = new Float32Array(ns);
  for (let i = 0; i < ns; i++) { const k = pos[sc[i]]++; z[k] = sz[i]; free[k] = sf[i]; }
  return { start, z, free };
}

// ------------------------------------------------------------------ the map
// grid {W, H, x0, y0, cell}, surf {start, z, free} → the walking map:
//   start (per cell), z, cellOf: the floors; link: 4 per floor, the index of the linked floor in the
//   neighbour cell (−1 = none); dist: cells to the nearest edge; blocked: 1 = too close to an edge
//   (or in an area marked as forbidden); conn: links between decks.
export function buildNav(grid, surf, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { W, H, cell } = grid;
  surf = fillHoles(W, H, surf, o.head);
  surf = fillHoles(W, H, surf, o.head); // a second pass for holes next to holes
  // the floors: surfaces with the free height of a person over them
  const n = W * H, start = new Uint32Array(n + 1);
  let m = 0;
  for (let c = 0; c < n; c++) {
    for (let k = surf.start[c]; k < surf.start[c + 1]; k++) if (surf.free[k] >= o.head) m++;
    start[c + 1] = m;
  }
  const z = new Float32Array(m), cellOf = new Uint32Array(m);
  for (let c = 0, i = 0; c < n; c++) for (let k = surf.start[c]; k < surf.start[c + 1]; k++) if (surf.free[k] >= o.head) { z[i] = surf.z[k]; cellOf[i++] = c; }
  // links: the nearest floor of the neighbour within a step
  const link = new Int8Array(m * 4).fill(-1);
  for (let a = 0; a < m; a++) {
    const c = cellOf[a], x = c % W, y = (c / W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const nc = ny * W + nx;
      let best = -1, bd = o.step;
      for (let b = start[nc]; b < start[nc + 1] && b - start[nc] < 127; b++) {
        const dd = Math.abs(z[b] - z[a]);
        if (dd <= bd) { bd = dd; best = b - start[nc]; }
      }
      link[a * 4 + d] = best;
    }
  }
  // a link only counts both ways (a step down to a floor that does not step back up is an edge)
  for (let a = 0; a < m; a++) for (let d = 0; d < 4; d++) {
    const b = to(start, cellOf, link, W, a, d);
    if (b >= 0 && to(start, cellOf, link, W, b, (d + 2) & 3) !== a) link[a * 4 + d] = -1;
  }
  // distance to the nearest edge (cells, through the links)
  const dist = new Uint8Array(m).fill(255), queue = new Int32Array(m);
  let qh = 0, qt = 0;
  for (let a = 0; a < m; a++) for (let d = 0; d < 4; d++) if (link[a * 4 + d] < 0) { dist[a] = 0; queue[qt++] = a; break; }
  while (qh < qt) {
    const a = queue[qh++];
    if (dist[a] >= 254) continue;
    for (let d = 0; d < 4; d++) {
      const b = to(start, cellOf, link, W, a, d);
      if (b >= 0 && dist[b] > dist[a] + 1) { dist[b] = dist[a] + 1; queue[qt++] = b; }
    }
  }
  const blocked = new Uint8Array(m);
  const keep = keepDist(o.radius, cell);
  for (let a = 0; a < m; a++) if (dist[a] < keep) blocked[a] = 1;
  return { ...grid, params: o, keep, start, z, cellOf, link, dist, blocked, conn: [], connOf: new Map(), comp: null, compSize: null };
}
// the first distance (in cells) whose centre is at least `radius` from the edge
export const keepDist = (radius, cell) => Math.max(0, Math.ceil(radius / cell - 0.5));

// floor reached from `a` in direction d, or −1
export function to(start, cellOf, link, W, a, d) {
  const k = link[a * 4 + d];
  if (k < 0) return -1;
  return start[cellOf[a] + DX[d] + DY[d] * W] + k;
}
export const step = (nav, a, d) => to(nav.start, nav.cellOf, nav.link, nav.W, a, d);

// Gratings: a cell with nothing at the height of the floor on both sides of it (left and right, or
// front and back) is a hole of the grating, not a gap: it gets that floor. Not if something else is
// there (a post, the side of a box).
function fillHoles(W, H, surf, head) {
  const { start, z, free } = surf, add = [];
  const near = (c, h) => { // a floor of cell c at height h (±HOLE), or −1
    for (let k = start[c]; k < start[c + 1]; k++) if (free[k] >= head && Math.abs(z[k] - h) <= HOLE) return k;
    return -1;
  };
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const c = y * W + x;
    for (const [da, db] of [[-1, 1], [-W, W]]) {
      let done = false;
      for (let k = start[c + da]; k < start[c + da + 1] && !done; k++) {
        if (free[k] < head) continue;
        const h = z[k], kb = near(c + db, h);
        if (kb < 0) continue;
        const f = (h + z[kb]) / 2;
        let clear = true, above = INF;
        for (let j = start[c]; j < start[c + 1]; j++) {
          if (z[j] > f - 0.1 && z[j] < f + head) { clear = false; break; }
          if (z[j] >= f + head) above = Math.min(above, z[j] - f);
        }
        if (clear) { add.push(c, f, above); done = true; }
      }
      if (done) break;
    }
  }
  if (!add.length) return surf;
  // merge the new floors in (columns stay sorted from the bottom up)
  const n = W * H, na = add.length / 3, ns = z.length + na;
  const cnt = new Uint32Array(n + 1);
  for (let c = 0; c < n; c++) cnt[c + 1] = start[c + 1] - start[c];
  for (let i = 0; i < na; i++) cnt[add[i * 3] + 1]++;
  for (let c = 0; c < n; c++) cnt[c + 1] += cnt[c];
  const z2 = new Float32Array(ns), f2 = new Float32Array(ns);
  const extra = new Map();
  for (let i = 0; i < na; i++) extra.set(add[i * 3], [add[i * 3 + 1], add[i * 3 + 2]]);
  for (let c = 0; c < n; c++) {
    let w = cnt[c];
    const e = extra.get(c);
    let put = !e;
    for (let k = start[c]; k < start[c + 1]; k++) {
      if (!put && z[k] > e[0]) { z2[w] = e[0]; f2[w++] = e[1]; put = true; }
      z2[w] = z[k];
      // the surface just below the new floor now has the floor over it
      f2[w] = e && z[k] < e[0] && (k + 1 === start[c + 1] || z[k + 1] > e[0]) ? Math.min(free[k], e[0] - z[k]) : free[k];
      w++;
    }
    if (!put) { z2[w] = e[0]; f2[w++] = e[1]; }
  }
  return { start: cnt, z: z2, free: f2 };
}

// ------------------------------------------------------------------ finding floors
export const cellXY = (nav, c) => [nav.x0 + (c % nav.W + 0.5) * nav.cell, nav.y0 + (((c / nav.W) | 0) + 0.5) * nav.cell];
export function spanXYZ(nav, a) { const [x, y] = cellXY(nav, nav.cellOf[a]); return [x, y, nav.z[a]]; }

// Floors (not blocked) whose cell centre is within the box [x0, y0, x1, y1] and whose height is in [zl, zh].
export function floorsIn(nav, x0, y0, x1, y1, zl, zh, fn) {
  const { W, H, cell } = nav;
  const i0 = Math.max(0, Math.floor((x0 - nav.x0) / cell)), i1 = Math.min(W - 1, Math.floor((x1 - nav.x0) / cell));
  const j0 = Math.max(0, Math.floor((y0 - nav.y0) / cell)), j1 = Math.min(H - 1, Math.floor((y1 - nav.y0) / cell));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const c = j * W + i;
    for (let a = nav.start[c]; a < nav.start[c + 1]; a++) if (!nav.blocked[a] && nav.z[a] >= zl && nav.z[a] <= zh) fn(a);
  }
}

// The floor nearest to a point: within `r` metres around it, at most `below` under it and `above`
// over it (for the eyes of the walk mode: below = 2.2). −1 when there is none.
export function nearestFloor(nav, x, y, z, r = 1.5, below = 0.6, above = 0.6) {
  let best = -1, bd = Infinity;
  floorsIn(nav, x - r, y - r, x + r, y + r, z - below, z + above, (a) => {
    const [px, py] = cellXY(nav, nav.cellOf[a]), d = Math.hypot(px - x, py - y) + Math.abs(nav.z[a] - z) * 0.5;
    if (d < bd) { bd = d; best = a; }
  });
  return best;
}

// Where to stand to reach an equipment with box b ([minx, miny, minz, maxx, maxy, maxz]): floors
// around it (up to `reach` m off its sides) at its base, or under it when it is up high. Each with a
// cost (m): the distance to its side, plus a penalty for standing lower or higher than its base.
export function standAround(nav, b, reach = 1.2) {
  const out = [];
  floorsIn(nav, b[0] - reach, b[1] - reach, b[3] + reach, b[4] + reach, b[2] - 2.6, Math.min(b[5], b[2] + 0.6), (a) => {
    const [x, y] = cellXY(nav, nav.cellOf[a]), h = nav.z[a];
    const dx = Math.max(b[0] - x, 0, x - b[3]), dy = Math.max(b[1] - y, 0, y - b[4]);
    const below = b[2] - h; // how far under the base of the equipment
    out.push({ span: a, cost: Math.hypot(dx, dy) + (below > 0.4 ? (below - 0.4) * 0.8 : 0) + (below < -0.1 ? (-0.1 - below) * 2 : 0) });
  });
  return out;
}

// ------------------------------------------------------------------ links between decks
// Ladder or stair spec: {label, node, box: [minx, miny, minz, maxx, maxy, maxz], low: [x, y], high: [x, y]}
// (low / high: where its foot and its top are, in plan). The decks it meets are the groups of floors
// around it at distinct heights; each is joined to the next one up at the point nearest to the
// ladder at that height.
export function addLadder(nav, spec, maxOff = 1.2) {
  const [x0, y0, z0, x1, y1, z1] = spec.box, low = spec.low || [(x0 + x1) / 2, (y0 + y1) / 2], high = spec.high || low;
  const found = [];
  floorsIn(nav, x0 - maxOff, y0 - maxOff, x1 + maxOff, y1 + maxOff, z0 - 0.6, z1 + 0.3, (a) => found.push(a));
  if (found.length < 2) return 0;
  found.sort((a, b) => nav.z[a] - nav.z[b]);
  // decks: heights more than 0.5 m apart
  const decks = [];
  let cur = [found[0]];
  for (let i = 1; i < found.length; i++) {
    if (nav.z[found[i]] - nav.z[found[i - 1]] > 0.5) { decks.push(cur); cur = []; }
    cur.push(found[i]);
  }
  decks.push(cur);
  if (decks.length < 2) return 0;
  const pick = (deck) => {
    const h = nav.z[deck[0]], t = z1 > z0 ? Math.max(0, Math.min(1, (h - z0) / (z1 - z0))) : 0;
    const tx = low[0] + (high[0] - low[0]) * t, ty = low[1] + (high[1] - low[1]) * t;
    let best = -1, bd = Infinity;
    for (const a of deck) { const [x, y] = cellXY(nav, nav.cellOf[a]), d = Math.hypot(x - tx, y - ty); if (d < bd) { bd = d; best = a; } }
    return bd <= maxOff + Math.hypot(x1 - x0, y1 - y0) / 2 ? best : -1;
  };
  let added = 0, prev = pick(decks[0]);
  for (let i = 1; i < decks.length; i++) {
    const p = pick(decks[i]);
    if (prev >= 0 && p >= 0 && nav.z[p] - nav.z[prev] > nav.params.step) { connect(nav, prev, p, "ladder", spec.label, spec.node); added++; }
    if (p >= 0) prev = p;
  }
  return added;
}

// A link drawn by hand between two points [x, y, z] (a door shown closed, a ladder without a name):
// joins the floors nearest to them. Returns false when there is no floor near one of them.
export function addManualLink(nav, a, b, label = "ligação") {
  const fa = nearestFloor(nav, a[0], a[1], a[2], 1.5, 2.2, 0.8), fb = nearestFloor(nav, b[0], b[1], b[2], 1.5, 2.2, 0.8);
  if (fa < 0 || fb < 0 || fa === fb) return false;
  connect(nav, fa, fb, Math.abs(nav.z[fa] - nav.z[fb]) > nav.params.step ? "ladder" : "door", label, -1);
  return true;
}

function connect(nav, a, b, kind, label, node) {
  const [ax, ay, az] = spanXYZ(nav, a), [bx, by, bz] = spanXYZ(nav, b);
  const len = Math.hypot(bx - ax, by - ay, bz - az);
  // climbing a ladder is slow: about 4 times walking the same length
  const cost = kind === "ladder" ? Math.abs(bz - az) * 4 + Math.hypot(bx - ax, by - ay) + 2 : len;
  const i = nav.conn.length;
  nav.conn.push({ a, b, kind, label, node, cost, len });
  for (const s of [a, b]) { const l = nav.connOf.get(s); if (l) l.push(i); else nav.connOf.set(s, [i]); }
}

// Forbidden areas: boxes [minx, miny, minz, maxx, maxy, maxz]; their floors are blocked.
export function blockBoxes(nav, boxes) {
  for (const b of boxes) {
    const { W, H, cell } = nav;
    const i0 = Math.max(0, Math.floor((b[0] - nav.x0) / cell)), i1 = Math.min(W - 1, Math.floor((b[3] - nav.x0) / cell));
    const j0 = Math.max(0, Math.floor((b[1] - nav.y0) / cell)), j1 = Math.min(H - 1, Math.floor((b[4] - nav.y0) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = j * W + i;
      for (let a = nav.start[c]; a < nav.start[c + 1]; a++) if (nav.z[a] >= b[2] - 0.05 && nav.z[a] <= b[5]) nav.blocked[a] = 2;
    }
  }
}

// ------------------------------------------------------------------ connected areas
// comp: the area of each floor (−1 blocked); compSize: floors per area. Areas joined by the links
// between decks are one area.
export function components(nav) {
  const m = nav.z.length, comp = new Int32Array(m).fill(-1), sizes = [], queue = new Int32Array(m);
  for (let s = 0; s < m; s++) {
    if (comp[s] >= 0 || nav.blocked[s]) continue;
    const id = sizes.length;
    let qh = 0, qt = 0, size = 0;
    comp[s] = id; queue[qt++] = s;
    while (qh < qt) {
      const a = queue[qh++];
      size++;
      for (let d = 0; d < 4; d++) {
        const b = step(nav, a, d);
        if (b >= 0 && comp[b] < 0 && !nav.blocked[b]) { comp[b] = id; queue[qt++] = b; }
      }
      const cs = nav.connOf.get(a);
      if (cs) for (const i of cs) {
        const c = nav.conn[i], b = c.a === a ? c.b : c.a;
        if (comp[b] < 0 && !nav.blocked[b]) { comp[b] = id; queue[qt++] = b; }
      }
    }
    sizes.push(size);
  }
  nav.comp = comp;
  nav.compSize = sizes;
  return sizes;
}

// Decks: heights (m) where many floors are, with their area (m²), from the lowest.
export function decks(nav) {
  const bins = new Map(), m = nav.z.length;
  for (let a = 0; a < m; a++) if (!nav.blocked[a]) { const k = Math.round(nav.z[a] * 2) / 2; bins.set(k, (bins.get(k) || 0) + 1); }
  const minCells = Math.max(25, m * 0.01), cellA = nav.cell * nav.cell;
  return [...bins].filter(([, k]) => k >= minCells).sort((a, b) => a[0] - b[0]).map(([z, k]) => ({ z, area: k * cellA }));
}
