// Web worker: reads Creo View .ol files and packs their triangles into GPU chunks.
// Port of tools/ol.py + the chunk writer in tools/build.py.
//
// Messages in:  {type:"init", dir?: FileSystemDirectoryHandle, base?: string}
//               {type:"task", id, parts:[{part, name, file?: File}]}
// Messages out: {type:"chunk", min, max, nv, ni, verts: Uint16Array, idx: Uint16Array, items: Uint32Array, colors: Uint8Array}
//               {type:"done", id, tris, missing}
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
  {
    const writer = new ChunkWriter();
    let tris = 0, missing = 0;
    const boxParts = [], boxes = [];
    for (const { part, name, file } of m.parts) {
      let buf;
      try { buf = await readFile(name, file); } catch { missing++; continue; }
      if (!buf) { missing++; continue; }
      let groups;
      try { groups = loadOL(new Uint8Array(buf)); } catch (err) { missing++; continue; }
      const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const g of groups) {
        const w = weld(g.pos, g.tris);
        if (!w) continue;
        writer.add(part, g.rgba, w.pos, w.idx);
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
    if (s.id !== 0 && s.id !== 1) continue; // materials + facets only
    let end = u8.length;
    for (const t of ent) if (t.off > s.off && t.off < end) end = t.off;
    out[s.id] = s.comp ? gunzipMember(u8, s.off, end) : u8.subarray(s.off, end);
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
  if (!secs[1]) return [];
  const sb = secs[1];
  const { root, dv } = records(sb);
  const col = (mi) => {
    const m = mi >= 0 && mi < mats.length ? mats[mi] : [0.7, 0.7, 0.7, 1];
    return m.map((v) => Math.max(0, Math.min(255, Math.round(Math.round(v * 1000) / 1000 * 255))));
  };
  walk(root, (face) => {
    if (face.tag !== 0x0d) return;
    const faceMat = dv.getInt32(face.o, true);
    for (const vp of face.kids) {
      if (vp.tag !== 0x16) continue;
      const flags = sb[vp.o];
      const cnt = dv.getUint32(vp.o + 1, true);
      const stride = 3 + (flags & 1 ? 3 : 0) + (flags & 2 ? 4 : 0) + (flags & 4 ? 2 : 0);
      const pos = new Float32Array(cnt * 3);
      for (let i = 0; i < cnt; i++) {
        const o = vp.o + 5 + i * stride * 4;
        pos[i * 3] = dv.getFloat32(o, true);
        pos[i * 3 + 1] = dv.getFloat32(o + 4, true);
        pos[i * 3 + 2] = dv.getFloat32(o + 8, true);
      }
      for (const pf of vp.kids) {
        if (pf.tag !== 0x17) continue;
        for (const mesh of pf.kids) {
          if (mesh.tag !== 0x18) continue;
          let mi = dv.getInt32(mesh.o + 4, true);
          if (mi < 0) mi = faceMat;
          const tris = [];
          for (const prim of mesh.kids) {
            const n = prim.n >> 2;
            const ix = new Uint32Array(n);
            for (let k = 0; k < n; k++) ix[k] = dv.getUint32(prim.o + 4 * k, true);
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
          const rgba = col(mi);
          const key = rgba.join(",");
          let g = groups.get(key);
          if (!g) { g = { rgba, pos: [], tris: [] }; groups.set(key, g); }
          g.pos.push(pos);
          g.tris.push(tris);
        }
      }
    }
  });
  return [...groups.values()];
}

// Merge vertex pools of one colour group and weld coincident vertices.
function weld(posList, triList) {
  let nv = 0, nt = 0;
  for (const p of posList) nv += p.length / 3;
  for (const t of triList) nt += t.length;
  if (!nt) return null;
  let size = 1;
  while (size < nv * 2) size <<= 1;
  const keys = new Int32Array(size * 3);
  const slot = new Int32Array(size).fill(-1);
  const remap = new Int32Array(nv);
  const out = new Float32Array(nv * 3);
  let nu = 0, g = 0;
  for (const p of posList) {
    for (let i = 0; i < p.length; i += 3, g++) {
      const x = Math.round(p[i] / WELD), y = Math.round(p[i + 1] / WELD), z = Math.round(p[i + 2] / WELD);
      let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (size - 1);
      for (;;) {
        const s = slot[h];
        if (s < 0) {
          slot[h] = nu; keys[h * 3] = x; keys[h * 3 + 1] = y; keys[h * 3 + 2] = z;
          out[nu * 3] = p[i]; out[nu * 3 + 1] = p[i + 1]; out[nu * 3 + 2] = p[i + 2];
          remap[g] = nu++;
          break;
        }
        if (keys[h * 3] === x && keys[h * 3 + 1] === y && keys[h * 3 + 2] === z) { remap[g] = s; break; }
        h = (h + 1) & (size - 1);
      }
    }
  }
  const idx = new Uint32Array(nt);
  let k = 0, baseV = 0, ti = 0;
  for (let j = 0; j < posList.length; j++) {
    const t = triList[j];
    for (let i = 0; i < t.length; i += 3) {
      const a = remap[baseV + t[i]], b = remap[baseV + t[i + 1]], c = remap[baseV + t[i + 2]];
      if (a === b || b === c || a === c) continue;
      idx[k++] = a; idx[k++] = b; idx[k++] = c;
    }
    baseV += posList[j].length / 3;
    ti++;
  }
  if (!k) return null;
  return { pos: out.subarray(0, nu * 3), idx: idx.subarray(0, k) };
}

// ------------------------------------------------------------------ chunk packing
class ChunkWriter {
  constructor() { this.reset(); }
  reset() { this.pos = []; this.idx = []; this.loc = []; this.items = []; this.colors = []; this.nv = 0; this.ni = 0; }

  add(part, rgba, P, I) {
    for (const [p, i] of split(P, I)) {
      const n = p.length / 3;
      if (this.nv + n > MAX_VERTS) this.flush();
      const local = this.items.length;
      this.items.push(part);
      this.colors.push(...rgba);
      this.pos.push(p);
      this.loc.push([local, n]);
      const shifted = new Uint32Array(i.length);
      for (let k = 0; k < i.length; k++) shifted[k] = i[k] + this.nv;
      this.idx.push(shifted);
      this.nv += n;
      this.ni += i.length;
    }
  }

  flush() {
    if (!this.nv) return;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of this.pos) for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) {
      const v = p[i + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v;
    }
    const ext = [0, 1, 2].map((a) => Math.max(hi[a] - lo[a], 1e-6));
    const verts = new Uint16Array(this.nv * 4);
    let o = 0;
    this.pos.forEach((p, j) => {
      const local = this.loc[j][0];
      for (let i = 0; i < p.length; i += 3) {
        for (let a = 0; a < 3; a++) verts[o++] = Math.min(65535, Math.max(0, Math.round((p[i + a] - lo[a]) / ext[a] * 65535)));
        verts[o++] = local;
      }
    });
    const idx = new Uint16Array(this.ni);
    let q = 0;
    for (const i of this.idx) { idx.set(i, q); q += i.length; }
    const items = Uint32Array.from(this.items), colors = Uint8Array.from(this.colors);
    self.postMessage({ type: "chunk", min: lo, max: hi, nv: this.nv, ni: this.ni, verts, idx, items, colors },
      [verts.buffer, idx.buffer, items.buffer, colors.buffer]);
    this.reset();
  }
}

// Split a mesh with more than MAX_VERTS vertices into pieces that fit in a chunk.
function* split(P, I) {
  const nv = P.length / 3;
  if (nv <= MAX_VERTS) { yield [P, I]; return; }
  let start = 0;
  const map = new Int32Array(nv).fill(-1);
  while (start < I.length) {
    const used = [];
    const tris = [];
    let k = start;
    for (; k < I.length; k += 3) {
      let add = 0;
      for (let a = 0; a < 3; a++) if (map[I[k + a]] < 0) add++;
      if (used.length + add > MAX_VERTS) break;
      for (let a = 0; a < 3; a++) {
        const v = I[k + a];
        if (map[v] < 0) { map[v] = used.length; used.push(v); }
        tris.push(map[v]);
      }
    }
    const p = new Float32Array(used.length * 3);
    used.forEach((v, j) => { p[j * 3] = P[v * 3]; p[j * 3 + 1] = P[v * 3 + 1]; p[j * 3 + 2] = P[v * 3 + 2]; map[v] = -1; });
    yield [p, Uint32Array.from(tris)];
    start = k;
  }
}
