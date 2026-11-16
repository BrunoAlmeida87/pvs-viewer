// Page side of the walking map: settings, name patterns (ladders, parts to leave out), the slices
// rendered by the viewer (app.navSlices) sent to the worker (navworker.js), and a copy of the
// result kept on the device, so that the map is computed once per model.
import { DEFAULTS } from "./navgrid.js";
import { BIGRAMA_KEY } from "./bigrama.js";

const SETTINGS = "pvs-viewer:nav";
export const NAV_DEFAULTS = {
  ...DEFAULTS,
  useInside: true,
  ladders: "ESCADA|STAIR|LADDER|MARINH",
  ignore: "\\bPORTAS?\\b|\\bDOORS?\\b|ESCOTILHA|HATCH",
};
const DB = "pvs-viewer-nav", STORE = "maps", KEEP = 3;

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "key" });
    r.onerror = () => reject(r.error);
    r.onsuccess = () => {
      const db = r.result, t = db.transaction(STORE, mode), s = t.objectStore(STORE), out = fn(s);
      t.oncomplete = () => { db.close(); resolve(out && "result" in out ? out.result : undefined); };
      t.onerror = t.onabort = () => { db.close(); reject(t.error); };
    };
  });
}
async function keepMap(entry) {
  try {
    await idb("readwrite", (s) => s.put({ ...entry, when: Date.now() }));
    const all = (await idb("readonly", (s) => s.getAll())) || [];
    all.sort((a, b) => b.when - a.when);
    for (const old of all.slice(KEEP)) await idb("readwrite", (s) => s.delete(old.key));
  } catch { /* storage blocked: computed again next time */ }
}
async function keptMap(key) { try { return await idb("readonly", (s) => s.get(key)); } catch { return null; } }

// "ESCADA, LADDER" or "ESCADA|LADDER" → a case-insensitive pattern (null when empty or invalid)
export function pattern(text) {
  const t = String(text || "").trim().replace(/\s*,\s*/g, "|");
  if (!t) return null;
  try { return new RegExp(t, "i"); } catch { return null; }
}
const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

export function navClient(app) {
  let worker = null, seq = 0, ready = false, last = null;
  const pending = new Map();
  const start = () => {
    if (worker) return worker;
    worker = new Worker(new URL("./navworker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => { const r = pending.get(e.data.id); if (r) { pending.delete(e.data.id); r(e.data); } };
    worker.onerror = (e) => { for (const [, r] of pending) r({ error: "exception", message: e.message || "erro no cálculo" }); pending.clear(); };
    return worker;
  };
  const ask = (msg, transfer = []) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); start().postMessage({ ...msg, id }, transfer); });
  const post = (msg, transfer = []) => start().postMessage(msg, transfer);

  const settings = () => ({ ...NAV_DEFAULTS, ...(store(SETTINGS) || {}) });
  const setSettings = (patch) => { const s = { ...settings(), ...patch }; save(SETTINGS, s); return s; };
  const extrasKey = () => "pvs-viewer:navExtras:" + (app.title || "");
  const extrasOf = () => ({ manual: [], blocks: [], ...(store(extrasKey()) || {}) });
  const setExtrasOf = (e) => save(extrasKey(), { manual: e.manual || [], blocks: e.blocks || [] });

  // Nodes whose name or description matches: the top ones (not inside another one that matches).
  // tall: a group ("ESCADAS") whose children are themselves two or more tall matching things (each
  // stair or ladder) gives its children instead (the steps of one ladder are not tall: no).
  function matching(re, tall = false) {
    if (!re || !app.tree) return [];
    const t = app.tree, keys = ["Description", "libelle", "part_objectid", BIGRAMA_KEY].map(app.keyIndex).filter((k) => k >= 0);
    const match = new Uint8Array(app.nNodes);
    for (let n = 1; n < app.nNodes; n++) {
      let text = t.names[n];
      for (const k of keys) { const v = app.prop(n, k); if (v != null) text += " " + v; }
      if (re.test(text) || re.test(strip(text))) match[n] = 1;
    }
    const kids = new Map();
    for (let n = 1; n < app.nNodes; n++) { const p = t.parent[n]; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(n); }
    const height = (n) => { const b = app.nodesBox([n]); return b.isEmpty() ? 0 : b.max.z - b.min.z; };
    const out = [];
    const visit = (n) => {
      if (match[n]) {
        const k = tall ? (kids.get(n) || []).filter((c) => match[c] && height(c) >= 1) : [];
        if (k.length >= 2) { for (const c of k) visit(c); return; }
        out.push(n);
        return;
      }
      for (const c of kids.get(n) || []) visit(c);
    };
    for (const c of kids.get(0) || []) visit(c);
    return out;
  }
  // a ladder or stair: its box and where its foot and its top are in plan (from its parts' boxes)
  function ladderSpec(n) {
    const parts = [];
    app.forParts([n], (p) => { if (app.partLoaded[p]) parts.push(p); });
    if (!parts.length) return null;
    const b = app.partsBox(parts);
    if (b.isEmpty() || b.max.z - b.min.z < 0.5) return null;
    const low = [0, 0, 0], high = [0, 0, 0];
    for (const p of parts) {
      const q = app.partsBox([p]), cx = (q.min.x + q.max.x) / 2, cy = (q.min.y + q.max.y) / 2;
      if (q.min.z < b.min.z + 0.3) { low[0] += cx; low[1] += cy; low[2]++; }
      if (q.max.z > b.max.z - 0.3) { high[0] += cx; high[1] += cy; high[2]++; }
    }
    const mid = [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2];
    const at = (s) => (s[2] && parts.length > 2 ? [s[0] / s[2], s[1] / s[2]] : mid);
    return { label: app.tree.names[n], node: n, box: [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z], low: at(low), high: at(high) };
  }
  function extras() {
    const s = settings(), e = extrasOf();
    const ladders = matching(pattern(s.ladders), true).map(ladderSpec).filter(Boolean);
    return { ladders, manual: e.manual, blocks: e.blocks };
  }
  // parts left out of the map (doors, hatches): they do not block
  function excluded() {
    const re = pattern(settings().ignore);
    const nodes = matching(re);
    if (!nodes.length) return { flags: null, count: 0 };
    const f = new Uint8Array(app.nParts);
    app.forParts(nodes, (p) => { f[p] = 1; });
    return { flags: f, count: nodes.length };
  }
  function cacheKey(s) {
    const L = app.loadedRegions();
    return JSON.stringify({ v: 1, model: app.title, n: app.nParts, items: app.itemCount(), loaded: L, cell: s.cell, sub: s.sub, dz: s.dz, inside: s.useInside, ignore: s.ignore, layers: [...app.hiddenLayers].sort() });
  }
  const params = (s) => ({ cell: s.cell, head: s.head, step: s.step, radius: s.radius });

  // The map, from the device's copy or computed now. onProgress(fraction, text).
  async function compute({ force = false, onProgress = () => {}, signal = null } = {}) {
    const s = settings(), key = cacheKey(s);
    ready = false;
    const kept = force ? null : await keptMap(key);
    if (kept) {
      onProgress(0.9, "Usando o mapa guardado neste aparelho…");
      await ask({ type: "surfaces", set: { grid: kept.grid, flipped: kept.flipped, start: kept.start, z: kept.z, free: kept.free } });
    } else {
      const ex = excluded();
      onProgress(0, "Fatiando o modelo…");
      const grid = await app.navSlices({ cell: s.cell, sub: s.sub, dz: s.dz, exclude: ex.flags, signal }, {
        start: (g) => post({ type: "begin", grid: g, useInside: s.useInside }),
        slice: (rx, ry, rw, rh, tops, inside) => post({ type: "slice", rx, ry, rw, rh, tops, inside }, [tops.buffer, inside.buffer]),
        progress: (f) => onProgress(f * 0.9, `Fatiando o modelo… ${Math.round(f * 100)}%`),
      });
      await ask({ type: "end" });
      // keep a copy on the device
      const c = await ask({ type: "surfaces" });
      if (c.surfaces) keepMap({ key, grid, flipped: c.surfaces.flipped, start: c.surfaces.start, z: c.surfaces.z, free: c.surfaces.free });
    }
    return build(onProgress);
  }
  async function build(onProgress = () => {}) {
    onProgress(0.95, "Montando o mapa de caminhada…");
    const r = await ask({ type: "build", params: params(settings()), extras: extras() });
    if (r.error) throw new Error(r.message);
    ready = true;
    last = r;
    return r;
  }
  async function refreshExtras() {
    if (!ready) return null;
    const r = await ask({ type: "extras", extras: extras() });
    if (r.error) throw new Error(r.message);
    last = r;
    return r;
  }
  return {
    settings, setSettings, extrasOf, setExtrasOf, matching, pattern,
    get ready() { return ready; }, get last() { return last; },
    compute, build, refreshExtras,
    route: (from, to, goal) => ask({ type: "route", from, to, goal }),
    floorAt: (p, opts = {}) => ask({ type: "floorAt", p, ...opts }),
    reset() { ready = false; last = null; if (worker) { worker.terminate(); worker = null; pending.clear(); } },
    _cacheKey: cacheKey, _keep: keepMap,
  };
}

function store(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } }
