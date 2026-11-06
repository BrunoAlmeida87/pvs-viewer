// Web worker: reads Creo View .ol files and packs their triangles into GPU chunks.
// Port of tools/ol.py + the chunk writer in tools/build.py.
//
// Messages in:  {type:"init", dir?: FileSystemDirectoryHandle, base?: string}
//               {type:"task", id, parts:[{part, name, file?: File}]}
// Messages out: {type:"chunk", min, max, nv, ni, ne, verts: Uint16Array, nrm: Int8Array, idx: Uint16Array,
//                edges: Uint16Array, items: Uint32Array, colors: Uint8Array, layers: string[] (per item)}
//               {type:"done", id, tris, missing, boxParts, boxes}
// Vertices are welded by position + normal (smooth shading keeps creases). The CAD edges of
// section 2 are stored as index pairs into the same vertices.
import { loadOL, weld, edgeOwners } from "./ol.js";

const MAX_VERTS = 65535;
let dir = null, base = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") { dir = m.dir || null; base = m.base || null; small = m.small || 0; return; }
  if (m.type === "task") {
    try { await runTask(m); } catch (err) {
      self.postMessage({ type: "error", id: m.id, message: String(err && err.stack || err) });
    }
  }
};

// Small parts go to their own chunks, so that the viewer can skip them when they are only a
// few pixels big (level of detail). `small` is the size limit in metres (bounding box diagonal).
let small = 0;

async function runTask(m) {
  // three size classes: large, medium (< 5 × small) and small parts
  const big = new ChunkWriter(false), medium = new ChunkWriter(false), little = new ChunkWriter(true);
  let tris = 0, missing = 0;
  const boxParts = [], boxes = [];
  for (const { part, name, file } of m.parts) {
    let buf;
    try { buf = await readFile(name, file); } catch { missing++; continue; }
    if (!buf) { missing++; continue; }
    let ol;
    try { ol = loadOL(new Uint8Array(buf)); } catch { missing++; continue; }
    const groups = ol.groups;
    // each layer's edges go with that layer's largest colour group
    const owner = edgeOwners(groups);
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const welded = [];
    for (const g of groups) {
      const w = weld(g.pos, g.nrm, g.tris, owner.get(g.layer) === g ? ol.edges[g.layer] || null : null);
      if (!w) continue;
      welded.push([g, w]);
      tris += w.idx.length / 3;
      const P = w.pos;
      for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) {
        if (P[i + a] < b[a]) b[a] = P[i + a];
        if (P[i + a] > b[a + 3]) b[a + 3] = P[i + a];
      }
    }
    if (b[0] > b[3]) continue;
    boxParts.push(part); boxes.push(...b);
    const size = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    const writer = size < small ? little : size < small * 5 ? medium : big;
    for (const [g, w] of welded) writer.add(part, g.rgba, g.layer, w.pos, w.nrm, w.idx, w.edges, size);
  }
  big.flush();
  medium.flush();
  little.flush();
  const bp = Uint32Array.from(boxParts), bb = Float32Array.from(boxes);
  self.postMessage({ type: "done", id: m.id, tris, missing, boxParts: bp, boxes: bb }, [bp.buffer, bb.buffer]);
}

async function readFile(name, file) {
  if (file) return file.arrayBuffer();
  if (dir) return (await (await dir.getFileHandle(name)).getFile()).arrayBuffer();
  if (base !== null) {
    const r = await fetch(base + encodeURIComponent(name));
    if (!r.ok) return null;
    return r.arrayBuffer();
  }
  return null;
}

// ------------------------------------------------------------------ chunk packing
class ChunkWriter {
  constructor(isSmall) { this.small = isSmall; this.reset(); }
  reset() { this.parts = []; this.items = []; this.colors = []; this.layers = []; this.nv = 0; this.ni = 0; this.ne = 0; this.ps = 0; }

  add(part, rgba, layer, P, N, I, E, size) {
    this.ps = Math.max(this.ps, size || 0);
    for (const [p, n, i, e] of split(P, N, I, E)) {
      const nv = p.length / 3;
      if (this.nv + nv > MAX_VERTS) this.flush();
      const local = this.items.length;
      this.items.push(part);
      this.colors.push(...rgba);
      this.layers.push(layer);
      this.parts.push({ p, n, i, e, local, base: this.nv });
      this.nv += nv;
      this.ni += i.length;
      this.ne += e ? e.length : 0;
    }
  }

  flush() {
    if (!this.nv) return;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const { p } of this.parts) for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) {
      const v = p[i + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v;
    }
    const ext = [0, 1, 2].map((a) => Math.max(hi[a] - lo[a], 1e-6));
    const verts = new Uint16Array(this.nv * 4), nrm = new Int8Array(this.nv * 4);
    const idx = new Uint16Array(this.ni), edges = new Uint16Array(this.ne);
    let o = 0, q = 0, r = 0;
    for (const { p, n, i, e, local, base } of this.parts) {
      nrm.set(n, o);
      for (let k = 0; k < p.length; k += 3) {
        for (let a = 0; a < 3; a++) verts[o++] = Math.min(65535, Math.max(0, Math.round((p[k + a] - lo[a]) / ext[a] * 65535)));
        verts[o++] = local;
      }
      for (let k = 0; k < i.length; k++) idx[q++] = i[k] + base;
      if (e) for (let k = 0; k < e.length; k++) edges[r++] = e[k] + base;
    }
    const items = Uint32Array.from(this.items), colors = Uint8Array.from(this.colors);
    self.postMessage({ type: "chunk", min: lo, max: hi, nv: this.nv, ni: this.ni, ne: this.ne, ps: this.ps, small: this.small, verts, nrm, idx, edges, items, colors, layers: this.layers },
      [verts.buffer, nrm.buffer, idx.buffer, edges.buffer, items.buffer, colors.buffer]);
    this.reset();
  }
}

// Split a mesh with more than MAX_VERTS vertices into pieces that fit in a chunk.
// Each edge goes to the piece holding one of its ends (the other end is copied there if needed).
function* split(P, N, I, E) {
  const nv = P.length / 3;
  if (nv <= MAX_VERTS) { yield [P, N, I, E]; return; }
  const piece = new Int32Array(nv).fill(-1), local = new Int32Array(nv);
  const pieces = [];
  const open = () => { const pc = { used: [], tris: [], edges: [] }; pieces.push(pc); return pc; };
  const put = (pc, pi, v) => {
    if (piece[v] === pi) return local[v];
    if (pc.used.length >= MAX_VERTS) return -1;
    piece[v] = pi; local[v] = pc.used.length; pc.used.push(v);
    return local[v];
  };
  let cur = open();
  for (let k = 0; k < I.length; k += 3) {
    const pi = pieces.length - 1;
    let add = 0;
    for (let a = 0; a < 3; a++) if (piece[I[k + a]] !== pi) add++;
    if (cur.used.length + add > MAX_VERTS) cur = open();
    const pj = pieces.length - 1;
    for (let a = 0; a < 3; a++) cur.tris.push(put(cur, pj, I[k + a]));
  }
  if (E) {
    let spill = null, spillIdx = -1;
    for (let k = 0; k < E.length; k += 2) {
      const a = E[k], b = E[k + 1];
      let pi = piece[a] >= 0 ? piece[a] : piece[b] >= 0 ? piece[b] : pieces.length - 1;
      let pc = pieces[pi];
      let la = put(pc, pi, a), lb = la < 0 ? -1 : put(pc, pi, b);
      if (la < 0 || lb < 0) {
        if (!spill || spill.used.length + 2 > MAX_VERTS) { spill = open(); spillIdx = pieces.length - 1; }
        pc = spill; pi = spillIdx;
        la = put(pc, pi, a); lb = put(pc, pi, b);
      }
      pc.edges.push(la, lb);
    }
  }
  for (const pc of pieces) {
    const n = pc.used.length;
    const p = new Float32Array(n * 3), nn = new Int8Array(n * 4);
    pc.used.forEach((v, j) => {
      p[j * 3] = P[v * 3]; p[j * 3 + 1] = P[v * 3 + 1]; p[j * 3 + 2] = P[v * 3 + 2];
      nn[j * 4] = N[v * 4]; nn[j * 4 + 1] = N[v * 4 + 1]; nn[j * 4 + 2] = N[v * 4 + 2];
    });
    if (!n) continue;
    yield [p, nn, Uint32Array.from(pc.tris), pc.edges.length ? Uint32Array.from(pc.edges) : null];
  }
}
