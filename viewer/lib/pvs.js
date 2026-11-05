// Reader for Creo View binary structure files (PV-PVS03xx). Port of tools/pvs.py.
import { gunzipAll } from "./gz.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const latin = new TextDecoder("windows-1252");
function text(b) { try { return utf8.decode(b); } catch { return latin.decode(b); } }

export function parsePVS(buffer) {
  const data = new Uint8Array(buffer);
  if (String.fromCharCode(...data.subarray(0, 6)) !== "PV-PVS") throw new Error("não é um arquivo PVS");
  const version = String.fromCharCode(...data.subarray(6, 10));
  let first = -1;
  for (let i = 10; i < data.length - 2; i++) if (data[i] === 0x1f && data[i + 1] === 0x8b && data[i + 2] === 8) { first = i; break; }
  const b = gunzipAll(data, first);
  const doubleMatrix = parseInt(version.slice(0, 2), 10) >= 3;
  let p = 0;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const uint = (n) => { let v = 0; for (let k = 0; k < n; k++) v += b[p + k] * 2 ** (8 * k); p += n; return v; };
  const varint = () => { let v = 0, s = 0, c; do { c = b[p++]; v += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80); return v; };
  const tag = () => {
    const h = b[p] | (b[p + 1] << 8); p += 2;
    if (h === 0) return [0, 0, 0, false];
    return [h & 0x1ff, uint((h >> 9) & 7), uint((h >> 12) & 7), (h >> 15) === 1];
  };
  const skipChildren = () => {
    let depth = 1;
    while (depth > 0) {
      const [id, ln, , ch] = tag();
      if (id === 0) { depth--; continue; }
      p += ln;
      if (ch) depth++;
    }
  };
  const symbols = [];
  const symbol = () => {
    const v = varint();
    if (v === 0) return "";
    if (v & 1) return symbols[Math.floor(v / 2)] ?? "";
    const n = Math.floor(v / 2);
    const s = text(b.subarray(p, p + n)); p += n; return s;
  };
  const comps = [];

  const instance = (fl) => {
    const inst = { comp: varint() };
    if (fl & 1) varint();
    if (fl & 2) { inst.pos = [dv.getFloat64(p, true), dv.getFloat64(p + 8, true), dv.getFloat64(p + 16, true)]; p += 24; }
    if (fl & 4) {
      const m = [];
      for (let k = 0; k < 9; k++) {
        m.push(doubleMatrix ? dv.getFloat64(p, true) : dv.getFloat32(p, true));
        p += doubleMatrix ? 8 : 4;
      }
      inst.mat = m;
    }
    if (fl & 8) symbol();
    if (fl & 0x10) inst.name = symbol();
    return inst;
  };

  const component = (ln, body, ch) => {
    const c = { name: symbol(), shape: null, bbox: null, children: [] };
    p = body + ln;
    comps.push(c);
    if (!ch) return;
    for (;;) {
      const [id, cln, cfl, cch] = tag();
      if (id === 0) return;
      const cbody = p;
      if (id === 0x21) c.children.push(instance(cfl));
      else if (id === 0x23) {
        c.shape = symbol();
        if (cfl & 1) { c.bbox = [0, 1, 2, 3, 4, 5].map((k) => dv.getFloat32(p + 4 * k, true)); p += 24; }
      }
      p = cbody + cln;
      if (cch) skipChildren();
    }
  };

  while (p < b.length) {
    const [id, ln, , ch] = tag();
    const body = p;
    if (id === 1) {
      const n = varint();
      for (let i = 0; i < n; i++) { const k = varint(); symbols.push(text(b.subarray(p, p + k))); p += k; }
      p = body + ln;
      if (ch) skipChildren();
    } else if (id === 2) {
      p = body + ln;
      if (ch) {
        for (;;) {
          const [cid, cln, , cch] = tag();
          if (cid === 0) break;
          const cbody = p;
          if (cid === 0x20) component(cln, cbody, cch);
          else { p = cbody + cln; if (cch) skipChildren(); }
        }
      }
      break;
    } else if (id !== 0) {
      p = body + ln;
      if (ch) skipChildren();
    }
  }
  const transformed = comps.some((c) => c.children.some((i) => (i.pos && i.pos.some((v) => v !== 0)) ||
    (i.mat && i.mat.some((v, k) => Math.abs(v - (k % 4 === 0 ? 1 : 0)) > 1e-9))));
  return { version, components: comps, transformed };
}

// Flatten the component tree into the viewer's DFS-ordered tree (same layout as tree.json).
export function buildTree(comps) {
  const used = new Uint8Array(comps.length);
  for (const c of comps) for (const i of c.children) used[i.comp] = 1;
  let root = comps.length - 1;
  for (let i = comps.length - 1; i >= 0; i--) if (!used[i]) { root = i; break; }
  const names = [], parent = [], part = [], p0 = [], p1 = [], shapes = [], boxes = [];
  const stack = [[root, -1, false]];
  while (stack.length) {
    const [ci, par, done] = stack.pop();
    if (done) { p1[par] = shapes.length; continue; }
    const node = names.length;
    const c = comps[ci];
    names.push(c.name);
    parent.push(par);
    p0.push(shapes.length);
    p1.push(0);
    if (c.shape) { part.push(shapes.length); shapes.push(c.shape); boxes.push(c.bbox); }
    else part.push(-1);
    stack.push([ci, node, true]);
    for (let k = c.children.length - 1; k >= 0; k--) stack.push([c.children[k].comp, node, false]);
  }
  return { names, parent, part, p0, p1, shapes, boxes };
}
