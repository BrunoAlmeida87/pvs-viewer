// Web worker: reads Creo View .ol files and packs their triangles into GPU chunks.
// Port of tools/ol.py + the chunk writer in tools/build.py.
//
// Messages in:  {type:"init", dir?: FileSystemDirectoryHandle, base?: string}
//               {type:"task", id, parts:[{part, name, file?: File}]}
// Messages out: {type:"chunk", min, max, nv, ni, ne, verts: Uint16Array, nrm: Int8Array, idx: Uint16Array,
//                edges: Uint16Array, items: Uint32Array, colors: Uint8Array}
//               {type:"done", id, tris, missing, boxParts, boxes}
// Vertices are welded by position + normal (smooth shading keeps creases). The CAD edges of
// section 2 are stored as index pairs into the same vertices.
import { gunzipMember } from "./gz.js";

const MAX_VERTS = 65535;
const WELD = 1e-4; // metres
let dir = null, base = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "init") { dir = m.dir || null; base = m.base || null; return; }
  if (m.type === "task") {
    try { await runTask(m); } catch (err) {
      self.postMessage({ type: "error", id: m.id, message: String(err && err.stack || err) });
    }
  }
};

async function runTask(m) {
  const writer = new ChunkWriter();
  let tris = 0, missing = 0;
  const boxParts = [], boxes = [];
  for (const { part, name, file } of m.parts) {
    let buf;
    try { buf = await readFile(name, file); } catch { missing++; continue; }
    if (!buf) { missing++; continue; }
    let ol;
    try { ol = loadOL(new Uint8Array(buf)); } catch { missing++; continue; }
    const groups = ol.groups;
    // the part's edges go with its largest colour group
    let big = null, bigN = -1;
    for (const g of groups) { let n = 0; for (const t of g.tris) n += t.length; if (n > bigN) { bigN = n; big = g; } }
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const g of groups) {
      const w = weld(g.pos, g.nrm, g.tris, g === big ? ol.edges : null);
      if (!w) continue;
      writer.add(part, g.rgba, w.pos, w.nrm, w.idx, w.edges);
      tris += w.idx.length / 3;
      const P = w.pos;
      for (let i = 0; i < P.length; i += 3) for (let a = 0; a < 3; a++) {
        if (P[i + a] < b[a]) b[a] = P[i + a];
        if (P[i + a] > b[a + 3]) b[a + 3] = P[i + a];
      }
    }
    if (b[0] <= b[3]) { boxParts.push(part); boxes.push(...b); }
  }
  writer.flush();
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

// ------------------------------------------------------------------ OL format
function sections(u8) {
  if (u8[0] !== 0x44 || u8[1] !== 0x49 || u8[2] !== 0x56) throw new Error("not OL");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const count = dv.getUint32(18, true);
  const ent = [];
  for (let i = 0; i < count; i++) {
    const w = dv.getUint32(22 + i * 8, true), off = dv.getUint32(26 + i * 8, true);
    ent.push({ id: (w & 0xffffff) === 0xffffff ? -1 : w & 0xffffff, comp: w >>> 24, off });
  }
  const out = {};
  for (const s of ent) {
    if (s.id < 0 || s.id > 2) continue; // materials, facets, edges
    let end = u8.length;
    for (const t of ent) if (t.off > s.off && t.off < end) end = t.off;
    try { out[s.id] = s.comp ? gunzipMember(u8, s.off, end) : u8.subarray(s.off, end); } catch (e) { if (s.id !== 2) throw e; }
  }
  return out;
}

// Parse a flat record stream into a tree: {tag, o (payload offset), n (length), kids}
function records(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const root = { tag: -1, o: 0, n: 0, kids: [] };
  const stack = [root];
  let p = 0;
  while (p + 8 <= b.length) {
    const word = dv.getUint32(p, true), ln = dv.getInt32(p + 4, true);
    p += 8;
    const tag = word & 0xffffff;
    if (tag === 0) { if (stack.length > 1) stack.pop(); p += Math.max(ln, 0); continue; }
    const r = { tag, o: p, n: ln, kids: [] };
    p += ln;
    stack[stack.length - 1].kids.push(r);
    if (word & 0x1000000) stack.push(r);
  }
  return { root, dv };
}

function walk(r, fn) { for (const k of r.kids) { fn(k); walk(k, fn); } }

// Vertex pool (0x16): u8 flags (1 normals, 2 rgba, 4 uv), u32 count, interleaved floats.
function readPool(dv, vp, withNormals) {
  const flags = dv.getUint8(vp.o);
  const cnt = dv.getUint32(vp.o + 1, true);
  const stride = 3 + (flags & 1 ? 3 : 0) + (flags & 2 ? 4 : 0) + (flags & 4 ? 2 : 0);
  if (5 + cnt * stride * 4 > vp.n) return null;
  const pos = new Float32Array(cnt * 3);
  const nrm = withNormals && flags & 1 ? new Float32Array(cnt * 3) : null;
  for (let i = 0; i < cnt; i++) {
    const o = vp.o + 5 + i * stride * 4;
    pos[i * 3] = dv.getFloat32(o, true);
    pos[i * 3 + 1] = dv.getFloat32(o + 4, true);
    pos[i * 3 + 2] = dv.getFloat32(o + 8, true);
    if (nrm) {
      nrm[i * 3] = dv.getFloat32(o + 12, true);
      nrm[i * 3 + 1] = dv.getFloat32(o + 16, true);
      nrm[i * 3 + 2] = dv.getFloat32(o + 20, true);
    }
  }
  return { pos, nrm };
}

function indices(dv, prim) {
  const n = prim.n >> 2, ix = new Uint32Array(n);
  for (let k = 0; k < n; k++) ix[k] = dv.getUint32(prim.o + 4 * k, true);
  return ix;
}

// Make triangle winding agree with the CAD normals (counter-clockwise = outward).
function orient(tris, pos, nrm) {
  if (!nrm) return;
  for (let k = 0; k < tris.length; k += 3) {
    const a = tris[k] * 3, b = tris[k + 1] * 3, c = tris[k + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const s = gx * (nrm[a] + nrm[b] + nrm[c]) + gy * (nrm[a + 1] + nrm[b + 1] + nrm[c + 1]) + gz * (nrm[a + 2] + nrm[b + 2] + nrm[c + 2]);
    if (s < 0) { const t = tris[k + 1]; tris[k + 1] = tris[k + 2]; tris[k + 2] = t; }
  }
}

// True when all normals of a pool are (nearly) equal: a planar face. Its vertices are stored
// without a normal, so they weld with the neighbouring planar faces.
function planar(n) {
  const x = n[0], y = n[1], z = n[2];
  for (let i = 3; i < n.length; i += 3) if (n[i] * x + n[i + 1] * y + n[i + 2] * z < 0.9998) return false;
  return true;
}

function loadOL(u8) {
  const secs = sections(u8);
  const mats = [];
  if (secs[0]) {
    const { root, dv } = records(secs[0]);
    walk(root, (r) => {
      if (r.tag === 5 && r.n >= 52) {
        let a = r.n >= 56 ? dv.getFloat32(r.o + 52, true) : 1;
        if (!(a >= 0 && a <= 1)) a = 1;
        mats.push([dv.getFloat32(r.o + 12, true), dv.getFloat32(r.o + 16, true), dv.getFloat32(r.o + 20, true), a]);
      }
    });
  }
  const groups = new Map();
  if (!secs[1]) return { groups: [], edges: null };
  {
    const { root, dv } = records(secs[1]);
    const col = (mi) => {
      const m = mi >= 0 && mi < mats.length ? mats[mi] : [0.7, 0.7, 0.7, 1];
      return m.map((v) => Math.max(0, Math.min(255, Math.round(Math.round(v * 1000) / 1000 * 255))));
    };
    walk(root, (face) => {
      if (face.tag !== 0x0d) return;
      const faceMat = dv.getInt32(face.o, true);
      for (const vp of face.kids) {
        if (vp.tag !== 0x16) continue;
        const pool = readPool(dv, vp, true);
        if (!pool) continue;
        for (const pf of vp.kids) {
          if (pf.tag !== 0x17) continue;
          for (const mesh of pf.kids) {
            if (mesh.tag !== 0x18) continue;
            let mi = dv.getInt32(mesh.o + 4, true);
            if (mi < 0) mi = faceMat;
            const tris = [];
            for (const prim of mesh.kids) {
              const ix = indices(dv, prim), n = ix.length;
              if (prim.tag === 0x1b) { for (let k = 0; k + 2 < n; k += 3) tris.push(ix[k], ix[k + 1], ix[k + 2]); }
              else if (prim.tag === 0x1a) {
                for (let k = 0; k + 2 < n; k++) {
                  const a = ix[k], b = ix[k + 1], c = ix[k + 2];
                  if (a === b || b === c || a === c) continue;
                  if (k % 2 === 0) tris.push(a, b, c); else tris.push(b, a, c);
                }
              } else if (prim.tag === 0x19) { for (let k = 1; k + 1 < n; k++) tris.push(ix[0], ix[k], ix[k + 1]); }
            }
            if (!tris.length) continue;
            orient(tris, pool.pos, pool.nrm);
            if (pool.nrm && planar(pool.nrm)) pool.nrm = null; // flat shading is exact here
            const rgba = col(mi);
            const key = rgba.join(",");
            let g = groups.get(key);
            if (!g) { g = { rgba, pos: [], nrm: [], tris: [] }; groups.set(key, g); }
            g.pos.push(pool.pos);
            g.nrm.push(pool.nrm);
            g.tris.push(tris);
          }
        }
      }
    });
  }
  // Section 2: edges. 0x12 edge > 0x16 points > 0x17 > 0x18 > 0x1C polyline | 0x1D line pairs
  let edges = null;
  if (secs[2]) {
    const { root, dv } = records(secs[2]);
    const pts = [], segs = [];
    let np = 0;
    walk(root, (vp) => {
      if (vp.tag !== 0x16) return;
      const pool = readPool(dv, vp, false);
      if (!pool) return;
      const cnt = pool.pos.length / 3;
      let used = false;
      walk(vp, (prim) => {
        if (prim.tag !== 0x1c && prim.tag !== 0x1d) return;
        const ix = indices(dv, prim);
        if (prim.tag === 0x1c) { for (let k = 0; k + 1 < ix.length; k++) if (ix[k] < cnt && ix[k + 1] < cnt) segs.push(np + ix[k], np + ix[k + 1]); }
        else for (let k = 0; k + 1 < ix.length; k += 2) if (ix[k] < cnt && ix[k + 1] < cnt) segs.push(np + ix[k], np + ix[k + 1]);
        used = true;
      });
      if (used) { pts.push(pool.pos); np += cnt; }
    });
    if (segs.length) {
      const P = new Float32Array(np * 3);
      let o = 0;
      for (const p of pts) { P.set(p, o); o += p.length; }
      edges = { pos: P, segs: Uint32Array.from(segs) };
    }
  }
  return { groups: [...groups.values()], edges };
}

// ------------------------------------------------------------------ welding
function hash3(x, y, z) { return Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791); }

// Merge the vertex pools of one colour group: vertices with the same position and normal become
// one. Edge points are matched to a vertex at the same position (or added without a normal).
function weld(posList, nrmList, triList, edges) {
  let nv = 0, nt = 0;
  for (const p of posList) nv += p.length / 3;
  for (const t of triList) nt += t.length;
  if (!nt) return null;
  const ne = edges ? edges.pos.length / 3 : 0;
  let size = 1;
  while (size < (nv + ne) * 2) size <<= 1;
  const mask = size - 1;
  const keys = new Int32Array(size * 6), slot = new Int32Array(size).fill(-1);   // position + normal
  const pkeys = new Int32Array(size * 3), pslot = new Int32Array(size).fill(-1); // position only
  const remap = new Int32Array(nv);
  const out = new Float32Array((nv + ne) * 3), on = new Int8Array((nv + ne) * 4);
  let nu = 0;
  const posFind = (x, y, z) => {
    let h = hash3(x, y, z) & mask;
    for (;;) {
      const s = pslot[h];
      if (s < 0) return ~h;
      if (pkeys[h * 3] === x && pkeys[h * 3 + 1] === y && pkeys[h * 3 + 2] === z) return s;
      h = (h + 1) & mask;
    }
  };
  const posAdd = (h, x, y, z, v) => { pslot[h] = v; pkeys[h * 3] = x; pkeys[h * 3 + 1] = y; pkeys[h * 3 + 2] = z; };
  const poolBase = [];
  for (let j = 0, s = 0; j < posList.length; j++) { poolBase.push(s); s += posList[j].length / 3; }
  // curved faces (with normals): weld by position + normal
  for (let j = 0; j < posList.length; j++) {
    const p = posList[j], n = nrmList[j];
    if (!n) continue;
    for (let i = 0, g = poolBase[j]; i < p.length; i += 3, g++) {
      const x = Math.round(p[i] / WELD), y = Math.round(p[i + 1] / WELD), z = Math.round(p[i + 2] / WELD);
      const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
      const nx = Math.round(n[i] / l * 127), ny = Math.round(n[i + 1] / l * 127), nz = Math.round(n[i + 2] / l * 127);
      let h = (hash3(x, y, z) ^ Math.imul(nx * 65536 + ny * 256 + nz, 2654435761)) & mask;
      for (;;) {
        const s = slot[h];
        if (s < 0) {
          slot[h] = nu;
          const k = h * 6;
          keys[k] = x; keys[k + 1] = y; keys[k + 2] = z; keys[k + 3] = nx; keys[k + 4] = ny; keys[k + 5] = nz;
          out[nu * 3] = p[i]; out[nu * 3 + 1] = p[i + 1]; out[nu * 3 + 2] = p[i + 2];
          on[nu * 4] = nx; on[nu * 4 + 1] = ny; on[nu * 4 + 2] = nz;
          const f = posFind(x, y, z);
          if (f < 0) posAdd(~f, x, y, z, nu);
          remap[g] = nu++;
          break;
        }
        const k = h * 6;
        if (keys[k] === x && keys[k + 1] === y && keys[k + 2] === z && keys[k + 3] === nx && keys[k + 4] === ny && keys[k + 5] === nz) { remap[g] = s; break; }
        h = (h + 1) & mask;
      }
    }
  }
  // planar faces: weld by position with any vertex already there (the shader falls back to
  // flat shading where the borrowed normal disagrees with the face)
  for (let j = 0; j < posList.length; j++) {
    const p = posList[j];
    if (nrmList[j]) continue;
    for (let i = 0, g = poolBase[j]; i < p.length; i += 3, g++) {
      const x = Math.round(p[i] / WELD), y = Math.round(p[i + 1] / WELD), z = Math.round(p[i + 2] / WELD);
      const f = posFind(x, y, z);
      if (f >= 0) { remap[g] = f; continue; }
      posAdd(~f, x, y, z, nu);
      out[nu * 3] = p[i]; out[nu * 3 + 1] = p[i + 1]; out[nu * 3 + 2] = p[i + 2];
      remap[g] = nu++;
    }
  }
  const idx = new Uint32Array(nt);
  let k = 0, baseV = 0;
  for (let j = 0; j < posList.length; j++) {
    const t = triList[j];
    for (let i = 0; i < t.length; i += 3) {
      const a = remap[baseV + t[i]], b = remap[baseV + t[i + 1]], c = remap[baseV + t[i + 2]];
      if (a === b || b === c || a === c) continue;
      idx[k++] = a; idx[k++] = b; idx[k++] = c;
    }
    baseV += posList[j].length / 3;
  }
  if (!k) return null;
  let E = null;
  if (edges) {
    const P = edges.pos, emap = new Int32Array(ne);
    for (let i = 0; i < ne; i++) {
      const x = Math.round(P[i * 3] / WELD), y = Math.round(P[i * 3 + 1] / WELD), z = Math.round(P[i * 3 + 2] / WELD);
      const f = posFind(x, y, z);
      if (f >= 0) { emap[i] = f; continue; }
      posAdd(~f, x, y, z, nu);
      out[nu * 3] = P[i * 3]; out[nu * 3 + 1] = P[i * 3 + 1]; out[nu * 3 + 2] = P[i * 3 + 2];
      emap[i] = nu++;
    }
    const S = edges.segs, e = new Uint32Array(S.length);
    let m = 0;
    for (let i = 0; i < S.length; i += 2) {
      const a = emap[S[i]], b = emap[S[i + 1]];
      if (a !== b) { e[m++] = a; e[m++] = b; }
    }
    E = e.subarray(0, m);
  }
  return { pos: out.subarray(0, nu * 3), nrm: on.subarray(0, nu * 4), idx: idx.subarray(0, k), edges: E };
}

// ------------------------------------------------------------------ chunk packing
class ChunkWriter {
  constructor() { this.reset(); }
  reset() { this.parts = []; this.items = []; this.colors = []; this.nv = 0; this.ni = 0; this.ne = 0; }

  add(part, rgba, P, N, I, E) {
    for (const [p, n, i, e] of split(P, N, I, E)) {
      const nv = p.length / 3;
      if (this.nv + nv > MAX_VERTS) this.flush();
      const local = this.items.length;
      this.items.push(part);
      this.colors.push(...rgba);
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
    self.postMessage({ type: "chunk", min: lo, max: hi, nv: this.nv, ni: this.ni, ne: this.ne, verts, nrm, idx, edges, items, colors },
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
