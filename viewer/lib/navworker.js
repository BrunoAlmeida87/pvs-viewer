// Worker of the walking map: collects the slices rendered by the page (navgrid.js), builds the map
// and answers routes (navpath.js), so the page never stops while it works.
//
// Three stages, so that a change redoes only what it needs:
//   surfaces — the columns of the model (from the slices; kept on the device by navclient.js);
//   base     — the floors and their links (free height, step, body radius);
//   map      — base + ladders, links drawn by hand and forbidden areas.
import { createBuilder, buildNav, addLadder, addManualLink, blockBoxes, components, decks, standAround, nearestFloor, spanXYZ, DEFAULTS } from "./navgrid.js";
import { findPath, shapeRoute, instructions } from "./navpath.js";

let builder = null, surf = null, grid = null, base = null, nav = null, flipped = false, extras = { ladders: [], manual: [], blocks: [] };

function apply() {
  nav = { ...base, blocked: base.blocked.slice(), conn: [], connOf: new Map() };
  const ladders = [];
  for (const l of extras.ladders) { const k = addLadder(nav, l); ladders.push({ label: l.label, node: l.node, links: k }); }
  const manual = extras.manual.map((m) => addManualLink(nav, m.a, m.b, m.label || "ligação"));
  blockBoxes(nav, extras.blocks);
  const sizes = components(nav);
  return { ladders, manual, sizes };
}

function summary(info) {
  const m = nav.z.length;
  let free = 0, edge = 0, forb = 0;
  for (let a = 0; a < m; a++) { const b = nav.blocked[a]; if (!b) free++; else if (b === 1) edge++; else forb++; }
  const cellA = nav.cell * nav.cell, sizes = info.sizes.slice().sort((a, b) => b - a);
  return {
    grid: { W: nav.W, H: nav.H, x0: nav.x0, y0: nav.y0, cell: nav.cell }, params: nav.params,
    floors: m, area: free * cellA, edgeArea: edge * cellA, forbiddenArea: forb * cellA,
    decks: decks(nav), areas: sizes.length, mainArea: (sizes[0] || 0) * cellA, smallAreas: sizes.filter((s) => s * cellA < 2).length,
    ladders: info.ladders, manual: info.manual, links: nav.conn.length, flipped,
  };
}

// what the page draws: every floor (x, y, z) with its state, and the links between decks
function drawing() {
  const m = nav.z.length, pos = new Float32Array(m * 3), state = new Uint8Array(m);
  for (let a = 0; a < m; a++) {
    const p = spanXYZ(nav, a);
    pos[a * 3] = p[0]; pos[a * 3 + 1] = p[1]; pos[a * 3 + 2] = p[2];
    // 0 free (main area), 1 near an edge, 2 forbidden, 3 free but cut off from the main area
    state[a] = nav.blocked[a] ? nav.blocked[a] : nav.comp[a] === mainComp() ? 0 : 3;
  }
  const conns = nav.conn.map((c) => ({ a: spanXYZ(nav, c.a), b: spanXYZ(nav, c.b), kind: c.kind, label: c.label }));
  return { pos, state, conns };
}
let mainId = -1;
function mainComp() {
  if (mainId >= 0) return mainId;
  let best = 0;
  nav.compSize.forEach((s, i) => { if (s > nav.compSize[best]) best = i; });
  return (mainId = best);
}

// where a route starts or ends: {box: [6]} an equipment, or {point: [x, y, z]} where one stands
function ends(e) {
  if (e.point) {
    const [x, y, z] = e.point, a = nearestFloor(nav, x, y, z, 2, e.eye ? 2.4 : 0.8, e.eye ? 0.4 : 0.8);
    return a < 0 ? [] : [{ span: a, cost: 0 }];
  }
  let list = standAround(nav, e.box);
  if (!list.length) list = standAround(nav, e.box, 3);
  // only floors that can lead somewhere: not tiny islands (the top of a box)
  const big = list.filter((s) => nav.compSize[nav.comp[s.span]] * nav.cell * nav.cell >= 2);
  return big.length ? big : list;
}

function route(m) {
  const from = ends(m.from), to = ends(m.to);
  if (!from.length) return { error: "from", message: "Não há piso livre perto do ponto de partida." };
  if (!to.length) return { error: "to", message: "Não há piso livre perto do destino." };
  // only the areas both ends touch (a quick "no way" when they are apart)
  const fa = new Set(from.map((s) => nav.comp[s.span])), ta = new Set(to.map((s) => nav.comp[s.span]));
  if (![...fa].some((c) => ta.has(c))) return { error: "apart", message: "Não há caminho: a partida e o destino estão em áreas que não se ligam (falta uma escada ou uma passagem?)." };
  const p = findPath(nav, from, to);
  if (!p) return { error: "none", message: "Não foi encontrado um caminho." };
  const r = shapeRoute(nav, p);
  const steps = instructions(r, m.goal || null);
  return { route: r, steps };
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === "begin") { grid = m.grid; builder = createBuilder(grid, m.useInside !== false); surf = base = nav = null; return; }
    if (m.type === "slice") { builder.slice(m.rx, m.ry, m.rw, m.rh, m.tops, m.inside); return; }
    if (m.type === "end") { surf = builder.surfaces(); flipped = builder.flipped; builder = null; self.postMessage({ id: m.id, ok: true }); return; }
    if (m.type === "surfaces") { // kept on the device: give them back / take them
      if (m.set) { grid = m.set.grid; flipped = !!m.set.flipped; surf = { start: m.set.start, z: m.set.z, free: m.set.free }; self.postMessage({ id: m.id, ok: true }); return; }
      const c = { grid, flipped, start: surf.start.slice(), z: surf.z.slice(), free: surf.free.slice() };
      self.postMessage({ id: m.id, surfaces: c }, [c.start.buffer, c.z.buffer, c.free.buffer]);
      return;
    }
    if (m.type === "build") {
      base = buildNav(grid, surf, { ...DEFAULTS, ...m.params });
      extras = m.extras || extras;
      mainId = -1;
      const info = apply();
      const d = drawing();
      self.postMessage({ id: m.id, summary: summary(info), drawing: d }, [d.pos.buffer, d.state.buffer]);
      return;
    }
    if (m.type === "extras") { // ladders / links / forbidden areas changed
      extras = m.extras;
      mainId = -1;
      const info = apply();
      const d = drawing();
      self.postMessage({ id: m.id, summary: summary(info), drawing: d }, [d.pos.buffer, d.state.buffer]);
      return;
    }
    if (m.type === "route") { self.postMessage({ id: m.id, ...(nav ? route(m) : { error: "map", message: "O mapa de caminhada não foi calculado." }) }); return; }
    if (m.type === "floorAt") { // the floor under a point (the walk mode, a tap)
      const a = nav ? nearestFloor(nav, m.p[0], m.p[1], m.p[2], m.r || 1.5, m.below ?? 2.4, m.above ?? 0.4) : -1;
      self.postMessage({ id: m.id, floor: a >= 0 ? spanXYZ(nav, a) : null, free: a >= 0 && !nav.blocked[a] });
      return;
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: "exception", message: String(err && err.message || err) });
  }
};
