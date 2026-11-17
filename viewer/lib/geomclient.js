// Page side of geomworker.js: sends part meshes once and runs distance / interference checks.
const MAX = 600; // same as geomworker.js (the least recently used mesh is dropped first)

export function geomClient(app) {
  let worker = null, seq = 0;
  // `sent` mirrors the worker's cache in the same order (least recently used first): a mesh sent, or
  // used in a check, moves to the end on both sides
  const sent = [], sentSet = new Set(), pending = new Map();
  const start = () => {
    if (worker) return worker;
    worker = new Worker(new URL("./geomworker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => { const r = pending.get(e.data.id); if (r) { pending.delete(e.data.id); r(e.data); } };
    return worker;
  };
  const touch = (key) => { const i = sent.indexOf(key); if (i >= 0) { sent.splice(i, 1); sent.push(key); } };
  const post = (key, g) => {
    const i = sent.indexOf(key);
    if (i >= 0) sent.splice(i, 1); // sent again: one entry, at the end
    start().postMessage({ type: "mesh", key, pos: g.pos.slice(), idx: g.idx.slice() });
    sent.push(key); sentSet.add(key);
    while (sent.length > MAX) sentSet.delete(sent.shift());
  };
  // Mesh key for one part (null if its geometry cannot be read).
  async function part(p) {
    const key = "p" + p;
    if (sentSet.has(key)) return key;
    const g = await app.partGeometry(p);
    if (!g || !g.idx.length) return null;
    post(key, g);
    return key;
  }
  // Mesh key for several parts merged (an assembly).
  async function merged(key, parts, cap = 300) {
    if (sentSet.has(key)) return key;
    const list = [];
    for (const p of parts.slice(0, cap)) { const g = await app.partGeometry(p); if (g && g.idx.length) list.push(g); }
    if (!list.length) return null;
    let nv = 0, ni = 0;
    for (const g of list) { nv += g.pos.length; ni += g.idx.length; }
    const pos = new Float32Array(nv), idx = new Uint32Array(ni);
    let o = 0, q = 0;
    for (const g of list) { pos.set(g.pos, o); for (let i = 0; i < g.idx.length; i++) idx[q++] = g.idx[i] + o / 3; o += g.pos.length; }
    post(key, { pos, idx });
    return key;
  }
  // {crossings, d, pa, pb}: crossings > 0 means the surfaces cross (interference).
  function pair(a, b, limit = Infinity) {
    touch(a); touch(b); // the worker does the same, in the same order
    const id = ++seq;
    return new Promise((resolve) => { pending.set(id, resolve); start().postMessage({ type: "pair", id, a, b, limit }); });
  }
  // The same with mesh a moved by off [dx, dy, dz] (removal route).
  function pairAt(a, b, off, limit = Infinity) {
    touch(a); touch(b);
    const id = ++seq;
    return new Promise((resolve) => { pending.set(id, resolve); start().postMessage({ type: "pairAt", id, a, b, off, limit }); });
  }
  // A mesh that is not a part (the mannequin), sent under its own key (sent again each time).
  function custom(key, g) { sentSet.delete(key); post(key, g); return key; }
  function forget() { sent.length = 0; sentSet.clear(); if (worker) worker.postMessage({ type: "forget" }); }
  return { part, merged, pair, pairAt, custom, forget };
}
