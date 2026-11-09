// A new assembly tree made from the groups of "Minha estrutura", and its export as a converted
// folder (the format the viewer opens fastest). The PVS export is in pvswrite.js.
//
// The new tree (spec) is described in terms of the nodes of the open model:
//   { orig: n, whole: true }        node n of the model with everything below it
//   { orig: n, children: [...] }    node n with only some of its children (the others moved away)
//   { name, children: [...] }       a group created by the user
// Root: the model's root, with the groups first and then what was not moved (kept where it was,
// gathered under one assembly, or left out).
// Inside a group, each assembly whose parts all went to that group is kept whole (with its own
// sub-assemblies); only assemblies that were split are opened up.

export const REST_NAME = "Peças fora dos grupos";

export function buildSpec(t, nParts, groups, { rest = "keep" } = {}) {
  const N = t.names.length;
  const kids = Array.from({ length: N }, () => []);
  for (let n = 1; n < N; n++) kids[t.parent[n]].push(n);
  const owner = new Int32Array(nParts).fill(-1);
  groups.forEach((g, gi) => { for (const p of g.parts) owner[p] = gi; });
  // runEnd[p]: last part of the run of equal owners that contains p (parts of a node are contiguous)
  const runEnd = new Int32Array(nParts);
  for (let p = nParts - 1; p >= 0; p--) runEnd[p] = p + 1 < nParts && owner[p + 1] === owner[p] ? runEnd[p + 1] : p;
  const sorted = groups.map((g) => Int32Array.from(g.parts).sort());
  const restList = [];
  for (let p = 0; p < nParts; p++) if (owner[p] < 0) restList.push(p);
  const listOf = (o) => (o < 0 ? restList : sorted[o]);
  const count = (n) => t.p1[n] - t.p0[n];
  const uniform = (n, o) => count(n) > 0 && owner[t.p0[n]] === o && runEnd[t.p0[n]] >= t.p1[n] - 1;
  const any = (n, o) => {
    const a = listOf(o);
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < t.p0[n]) lo = m + 1; else hi = m; }
    return lo < a.length && a[lo] < t.p1[n];
  };
  // what of node n belongs to owner o: n whole, or the pieces of its children
  const collect = (n, o, out) => {
    if (count(n) === 0) return;
    if (uniform(n, o)) { out.push({ orig: n, whole: true }); return; }
    if (!any(n, o)) return;
    for (const c of kids[n]) collect(c, o, out);
  };
  // the model without the moved parts, keeping its hierarchy (and empty assemblies)
  const prune = (n) => {
    if (count(n) === 0 || uniform(n, -1)) return { orig: n, whole: true };
    const children = [];
    for (const c of kids[n]) if (count(c) === 0 || any(c, -1)) children.push(prune(c));
    return { orig: n, children };
  };
  const byParent = new Map();
  groups.forEach((g, gi) => { const k = g.parent ?? null; if (!byParent.has(k)) byParent.set(k, []); byParent.get(k).push(gi); });
  const group = (gi) => {
    const children = (byParent.get(groups[gi].id) || []).map(group);
    for (const c of kids[0]) collect(c, gi, children);
    return { name: groups[gi].name, children };
  };
  const top = (byParent.get(null) || []).map(group);
  const restKids = [];
  for (const c of kids[0]) if (count(c) === 0 || any(c, -1)) restKids.push(prune(c));
  // rest: "keep" = where they were · "drop" = left out · "box" = under one assembly (REST_NAME)
  const spec = rest === "drop" ? { orig: 0, children: top }
    : rest === "box" ? { orig: 0, children: [...top, { name: REST_NAME, children: restKids }] }
      : { orig: 0, children: [...top, ...restKids] };
  return { spec, restParts: restList };
}

// The viewer's tree (tree.json layout) for a spec, and the new order of the parts:
// order[newPart] = old part.
export function specTree(t, spec) {
  const N = t.names.length;
  const size = new Int32Array(N).fill(1);
  for (let n = N - 1; n > 0; n--) size[t.parent[n]] += size[n];
  const P = t.props;
  const names = [], parent = [], part = [], p0 = [], p1 = [], thumbs = [], shapes = [], order = [];
  const start = [0], kv = [];
  const node = (name, par, propsOf, thumb) => {
    const i = names.length;
    names.push(name); parent.push(par); p0.push(order.length); p1.push(0); part.push(-1); thumbs.push(thumb || "");
    if (propsOf >= 0) for (let k = P.start[propsOf]; k < P.start[propsOf + 1]; k++) kv.push(P.kv[2 * k], P.kv[2 * k + 1]);
    start.push(kv.length / 2);
    return i;
  };
  const leaf = (i, n) => { if (t.part[n] >= 0) { part[i] = order.length; shapes.push(t.shapes[t.part[n]]); order.push(t.part[n]); } };
  const close = (i) => { p1[i] = order.length; };
  const visit = (s, par) => {
    if (s.orig != null && s.whole) {
      // the original subtree is the contiguous range [n, n + size) of the DFS order
      const base = names.length, n0 = s.orig, stack = [];
      for (let n = n0; n < n0 + size[n0]; n++) {
        while (stack.length && stack[stack.length - 1].end <= n) close(stack.pop().i);
        const i = node(t.names[n], n === n0 ? par : base + (t.parent[n] - n0), n, t.thumbs[n]);
        leaf(i, n);
        stack.push({ i, end: n + size[n] });
      }
      while (stack.length) close(stack.pop().i);
      return;
    }
    const i = s.orig != null ? node(t.names[s.orig], par, s.orig, t.thumbs[s.orig]) : node(s.name, par, -1, "");
    if (s.orig != null) leaf(i, s.orig);
    for (const c of s.children) visit(c, i);
    close(i);
  };
  visit(spec, -1);
  return { tree: { names, parent, p0, p1, part, props: { keys: P.keys, vals: P.vals, start, kv }, thumbs, shapes }, order: Int32Array.from(order) };
}

// Write a converted folder for the new tree. src: the open converted folder ({json, buf}); meta:
// its chunks.json; write(name, Uint8Array) saves one file of the new folder.
export async function writeConverted(t, spec, src, meta, write, { title, hidden = [], progress = () => {} } = {}) {
  const { tree, order } = specTree(t, spec);
  const n = order.length;
  if (n !== meta.parts) throw new Error("a nova estrutura tem " + n + " peças e o modelo " + meta.parts);
  const newOf = new Int32Array(n);
  order.forEach((old, i) => { newOf[old] = i; });
  const enc = new TextEncoder();
  // geometry chunks are copied unchanged: they refer to items, and items to parts
  for (let k = 0; k < meta.chunks.length; k++) {
    const f = meta.chunks[k].f;
    await write("c/" + f, new Uint8Array(await src.buf("c/" + f)));
    progress(k + 1, meta.chunks.length);
  }
  const items = new Uint8Array(await src.buf("items.bin"));
  const dv = new DataView(items.buffer, items.byteOffset, items.byteLength);
  for (let i = 0; i < items.length / 8; i++) dv.setUint32(i * 8, newOf[dv.getUint32(i * 8, true)], true);
  const permute = (buf) => {
    const a = new Float32Array(buf), b = new Float32Array(a.length);
    for (let i = 0; i < n; i++) b.set(a.subarray(order[i] * 6, order[i] * 6 + 6), i * 6);
    return new Uint8Array(b.buffer);
  };
  await write("items.bin", items);
  await write("parts.bin", permute(await src.buf("parts.bin")));
  try { await write("pvsbox.bin", permute(await src.buf("pvsbox.bin"))); } catch { /* older folders lack it */ }
  if (meta.layers) await write("layers.bin", new Uint8Array(await src.buf("layers.bin")));
  // the "Bigrama" property is derived when a model opens: not stored
  const ki = tree.props.keys.indexOf("Bigrama");
  if (ki >= 0) {
    const kv = [], start = [0];
    for (let i = 0; i < tree.names.length; i++) {
      for (let k = tree.props.start[i]; k < tree.props.start[i + 1]; k++) if (tree.props.kv[2 * k] !== ki) kv.push(tree.props.kv[2 * k], tree.props.kv[2 * k + 1]);
      start.push(kv.length / 2);
    }
    tree.props = { keys: tree.props.keys.filter((k) => k !== "Bigrama"), vals: tree.props.vals, start, kv: kv.map((v, i) => (i % 2 === 0 && v > ki ? v - 1 : v)) };
  }
  await write("tree.json", enc.encode(JSON.stringify(tree)));
  const out = { ...meta, source: title || meta.source };
  delete out.includedParts;
  if (hidden.length) {
    const hide = new Uint8Array(n);
    for (const p of hidden) hide[newOf[p]] = 1;
    out.includedParts = [];
    for (let p = 0; p < n; p++) if (!hide[p]) out.includedParts.push(p);
  }
  await write("chunks.json", enc.encode(JSON.stringify(out))); // last: an unfinished folder is never taken for a model
  return { parts: n, nodes: tree.names.length };
}
