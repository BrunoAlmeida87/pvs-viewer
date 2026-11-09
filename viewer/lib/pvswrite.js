// Writes a Creo View structure file (PV-PVS03xx) with a new assembly tree, starting from the
// original file. Format recovered from SBR.pvs (see tools/pvs.py for the tag stream):
//
//   "PV-PVS0301C" + 3 bytes + u32 section count, then per section:
//     u8 type, u8 (1), u8 name length, name, u32 compressed size
//   followed by the sections, each one gzip member of the tag stream:
//     symbols (tag 1) · structure (tag 2) · properties (tag 3, one per name, e.g. "STRUCTURE").
//
// Nothing of the original is lost: the symbol table only grows (names of the new assemblies are
// appended), every component keeps its own bytes (name, shape, bounding box, thumbnail, unknown
// tags) and every property record keeps its bytes. Only the instance lists (which component is
// inside which) change, and the components are renumbered so that only those used by the new tree
// are written, children before parents and the root last (as in the files Creo View writes).
import { gzipSync } from "../vendor/fflate.js";
import { gunzipMember } from "./gz.js";

const utf8 = new TextEncoder();

// ---------------------------------------------------------------- byte helpers
class Out {
  constructor() { this.chunks = []; this.n = 0; }
  bytes(b) { this.chunks.push(b); this.n += b.length; }
  u8(...v) { this.bytes(Uint8Array.from(v)); }
  done() { const all = new Uint8Array(this.n); let o = 0; for (const c of this.chunks) { all.set(c, o); o += c.length; } return all; }
}
function varint(v) {
  const out = [];
  do { let c = v % 128; v = Math.floor(v / 128); if (v > 0) c |= 128; out.push(c); } while (v > 0);
  return Uint8Array.from(out);
}
const width = (v) => (v === 0 ? 0 : v < 0x100 ? 1 : v < 0x10000 ? 2 : v < 0x1000000 ? 3 : 4);
function le(v, n) { const b = new Uint8Array(n); for (let k = 0; k < n; k++) { b[k] = v % 256; v = Math.floor(v / 256); } return b; }
function tagHead(id, len, flags, children) {
  const lw = width(len), fw = width(flags);
  const h = id | (lw << 9) | (fw << 12) | (children ? 0x8000 : 0);
  const b = new Uint8Array(2 + lw + fw);
  b[0] = h & 255; b[1] = h >> 8;
  b.set(le(len, lw), 2); b.set(le(flags, fw), 2 + lw);
  return b;
}
const END = Uint8Array.from([0, 0]);

// Tag reader over one decompressed section.
function reader(b) {
  const r = { p: 0 };
  r.uint = (n) => { let v = 0; for (let k = 0; k < n; k++) v += b[r.p + k] * 2 ** (8 * k); r.p += n; return v; };
  r.varint = () => { let v = 0, s = 0, c; do { c = b[r.p++]; v += (c & 127) * 2 ** s; s += 7; } while (c & 128); return v; };
  r.tag = () => {
    const h = b[r.p] | (b[r.p + 1] << 8); r.p += 2;
    if (h === 0) return { id: 0 };
    return { id: h & 0x1ff, len: r.uint((h >> 9) & 7), flags: r.uint((h >> 12) & 7), children: (h >> 15) === 1 };
  };
  r.skipChildren = () => {
    let depth = 1;
    while (depth > 0) {
      const t = r.tag();
      if (t.id === 0) { depth--; continue; }
      r.p += t.len;
      if (t.children) depth++;
    }
  };
  return r;
}

// ---------------------------------------------------------------- reading
export function readSections(buffer) {
  const u8 = new Uint8Array(buffer);
  if (String.fromCharCode(...u8.subarray(0, 6)) !== "PV-PVS") throw new Error("não é um arquivo PVS");
  const count = u8[14] | (u8[15] << 8) | (u8[16] << 16) | (u8[17] << 24);
  let p = 18;
  const sections = [];
  for (let i = 0; i < count; i++) {
    const type = u8[p], b1 = u8[p + 1], nl = u8[p + 2];
    const name = u8.slice(p + 3, p + 3 + nl);
    p += 3 + nl;
    const size = (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0;
    p += 4;
    sections.push({ type, b1, name, size });
  }
  let at = p;
  for (const s of sections) { s.raw = u8.subarray(at, at + s.size); at += s.size; }
  if (at !== u8.length) throw new Error("cabeçalho do PVS em formato não reconhecido (versão " + String.fromCharCode(...u8.subarray(6, 10)) + ")");
  for (const s of sections) {
    s.data = gunzipMember(s.raw, 0, s.raw.length);
    const r = reader(s.data);
    s.first = s.data.length >= 2 ? r.tag().id : 0;
  }
  return { magic: u8.slice(0, 14), sections };
}

// Components of the structure section, each with its own bytes and its instance list.
function readStructure(data) {
  const r = reader(data);
  const top = r.tag();
  if (top.id !== 2) throw new Error("seção de estrutura inesperada");
  r.p += top.len;
  const comps = [], other = [];
  if (!top.children) return { comps, other, topBody: data.subarray(2, 2) };
  for (;;) {
    const start = r.p;
    const t = r.tag();
    if (t.id === 0) break;
    const body = r.p;
    if (t.id !== 0x20) {
      r.p = body + t.len;
      if (t.children) r.skipChildren();
      other.push(data.subarray(start, r.p));
      continue;
    }
    const c = { len: t.len, flags: t.flags, body: data.subarray(body, body + t.len), extra: [], kids: [], inst: [] };
    r.p = body + t.len;
    if (t.children) {
      for (;;) {
        const cs = r.p;
        const k = r.tag();
        if (k.id === 0) break;
        const kb = r.p;
        if (k.id === 0x21) {
          const comp = r.varint();
          if (k.flags & 6) throw new Error("o modelo tem instâncias com posição ou rotação; a reorganização ainda não as trata");
          c.kids.push(comp);
          c.inst.push({ flags: k.flags, tail: data.subarray(r.p, kb + k.len) }); // id / name / hidden of this instance
          r.p = kb + k.len;
          if (k.children) r.skipChildren();
        } else {
          r.p = kb + k.len;
          if (k.children) r.skipChildren();
          c.extra.push(data.subarray(cs, r.p));
        }
      }
    }
    comps.push(c);
  }
  return { comps, other };
}

// Same traversal as buildTree() in pvs.js and tools/build.py: node i of the viewer's tree is
// component nodeComp[i].
export function nodeComponents(comps) {
  const used = new Uint8Array(comps.length);
  for (const c of comps) for (const k of c.kids) used[k] = 1;
  let root = comps.length - 1;
  for (let i = comps.length - 1; i >= 0; i--) if (!used[i]) { root = i; break; }
  const out = [], stack = [root];
  while (stack.length) {
    const ci = stack.pop();
    out.push(ci);
    const k = comps[ci].kids;
    for (let j = k.length - 1; j >= 0; j--) stack.push(k[j]);
  }
  return out;
}

// Property sections: one 0x2a block per component (flag bit 0: a varint index step), holding the
// 0x2b records. Returns, per section, the block bytes by component index.
function readProps(data, nComps) {
  const r = reader(data);
  const top = r.tag();
  r.p += top.len;
  const byComp = new Map(), other = [];
  if (!top.children) return { byComp, other, empty: true };
  let idx = -1;
  for (;;) {
    const start = r.p;
    const t = r.tag();
    if (t.id === 0) break;
    const body = r.p;
    if (t.id !== 0x2a) {
      r.p = body + t.len;
      if (t.children) r.skipChildren();
      other.push(data.subarray(start, r.p));
      continue;
    }
    idx += t.flags & 1 ? r.varint() : 1;
    r.p = body + t.len;
    if (!t.children) continue;
    const cs = r.p;
    r.skipChildren();
    if (idx >= 0 && idx < nComps) byComp.set(idx, data.subarray(cs, r.p - 2)); // without the end mark
  }
  return { byComp, other, empty: false };
}

// ---------------------------------------------------------------- writing
// spec: the new tree, in terms of the viewer's tree nodes (see restructure.js):
//   { orig: node, whole: true }                 original node with all its descendants
//   { orig: node, children: [spec…] }           original node with a new list of children
//   { name: "text", children: [spec…] }         new assembly
// treeNames: the viewer's node names, to check that the file is the model that is open.
export function writePVS(buffer, spec, treeNames) {
  const { magic, sections } = readSections(buffer);
  const symSec = sections.find((s) => s.first === 1);
  const strSec = sections.find((s) => s.first === 2);
  if (!symSec || !strSec) throw new Error("PVS sem tabela de símbolos ou sem estrutura");
  const { comps, other } = readStructure(strSec.data);
  const nodeComp = nodeComponents(comps);
  if (treeNames && nodeComp.length !== treeNames.length) throw new Error("este PVS não corresponde ao modelo aberto (" + nodeComp.length + " nós no arquivo, " + treeNames.length + " no modelo)");

  // symbol table: count, then (length, bytes) per symbol; new names go at the end
  const sr = reader(symSec.data);
  const st = sr.tag();
  const symBody = sr.p;
  const nSym = sr.varint();
  const symEntries = symSec.data.subarray(sr.p, symBody + st.len);
  const newNames = [];
  const symbolOf = (name) => { newNames.push(name); return varint((nSym + newNames.length - 1) * 2 + 1); };

  // new components, children first, root last
  const out = []; // {comp: original index | -1, body, flags, extra, kids: [new index], inst: [{flags, tail}]}
  const emitWhole = (ci) => {
    const c = comps[ci];
    const kids = c.kids.map(emitWhole);
    out.push({ comp: ci, body: c.body, flags: c.flags, extra: c.extra, kids, inst: c.inst });
    return out.length - 1;
  };
  const instOf = new Map(); // original component -> its own instance bytes (from its original parent)
  for (const c of comps) c.kids.forEach((k, j) => instOf.set(k, c.inst[j]));
  const emit = (s) => {
    if (s.orig != null && s.whole) return emitWhole(nodeComp[s.orig]);
    const kids = s.children.map(emit);
    if (s.orig != null) {
      const ci = nodeComp[s.orig], c = comps[ci];
      out.push({ comp: ci, body: c.body, flags: c.flags, extra: c.extra, kids, inst: null });
    } else {
      out.push({ comp: -1, body: symbolOf(s.name), flags: 0, extra: [], kids, inst: null });
    }
    return out.length - 1;
  };
  emit(spec);

  // structure section
  const S = new Out();
  S.bytes(tagHead(2, 0, 0, true));
  for (const o of other) S.bytes(o);
  for (const c of out) {
    const hasKids = c.kids.length > 0 || c.extra.length > 0;
    S.bytes(tagHead(0x20, c.body.length, c.flags, hasKids));
    S.bytes(c.body);
    if (!hasKids) continue;
    for (const k of c.kids) {
      const src = out[k].comp >= 0 ? instOf.get(out[k].comp) : null;
      const flags = src ? src.flags : 0, tail = src ? src.tail : new Uint8Array(0);
      const v = varint(k);
      S.bytes(tagHead(0x21, v.length + tail.length, flags, false));
      S.bytes(v); S.bytes(tail);
    }
    for (const e of c.extra) S.bytes(e);
    S.bytes(END);
  }
  S.bytes(END);

  // symbol section
  const Y = new Out();
  const extraSyms = newNames.map((n) => { const b = utf8.encode(n); const v = varint(b.length); const e = new Uint8Array(v.length + b.length); e.set(v); e.set(b, v.length); return e; });
  const count = varint(nSym + newNames.length);
  const symLen = count.length + symEntries.length + extraSyms.reduce((a, e) => a + e.length, 0);
  Y.bytes(tagHead(1, symLen, 0, false));
  Y.bytes(count); Y.bytes(symEntries);
  for (const e of extraSyms) Y.bytes(e);
  // anything after the symbol tag in the same section stays
  sr.p = symBody + st.len;
  if (st.children) sr.skipChildren();
  Y.bytes(symSec.data.subarray(sr.p));

  // property sections: the blocks follow the new component numbering
  const newData = new Map([[symSec, Y.done()], [strSec, S.done()]]);
  for (const s of sections) {
    if (s.first !== 3) continue;
    const P = readProps(s.data, comps.length);
    if (P.empty) continue; // copied as is
    const W = new Out();
    W.bytes(tagHead(3, 0, 0, true));
    for (const o of P.other) W.bytes(o);
    let prev = -1;
    out.forEach((c, i) => {
      const block = c.comp >= 0 ? P.byComp.get(c.comp) : null;
      if (!block) return;
      const step = i - prev;
      if (step === 1) W.bytes(tagHead(0x2a, 0, 0, true));
      else { const v = varint(step); W.bytes(tagHead(0x2a, v.length, 1, true)); W.bytes(v); }
      W.bytes(block); W.bytes(END);
      prev = i;
    });
    W.bytes(END);
    newData.set(s, W.done());
  }

  // file: header + sections (gzip, MTIME 0 and OS 0 as in the original)
  const raws = sections.map((s) => {
    const d = newData.get(s);
    if (!d) return s.raw;
    const g = gzipSync(d, { level: 6, mtime: 0 });
    g[9] = 0;
    return g;
  });
  const F = new Out();
  F.bytes(magic.subarray(0, 14));
  F.bytes(le(sections.length, 4));
  sections.forEach((s, i) => { F.u8(s.type, s.b1, s.name.length); F.bytes(s.name); F.bytes(le(raws[i].length, 4)); });
  for (const r of raws) F.bytes(r);
  return { bytes: F.done(), components: out.length, added: newNames.length };
}
