const test = require("node:test");
const assert = require("node:assert/strict");

// A tiny PVS made by hand, in the layout of the files Creo View writes (see viewer/lib/pvswrite.js):
//   root ─┬─ A ── p1.ol
//         └─ B ─┬─ p2.ol
//               └─ p3.ol
async function tinyPVS() {
  const { gzipSync } = await import("../../viewer/vendor/fflate.js");
  const bytes = (...a) => Uint8Array.from(a.flat());
  const cat = (list) => { const n = list.reduce((s, b) => s + b.length, 0), o = new Uint8Array(n); let k = 0; for (const b of list) { o.set(b, k); k += b.length; } return o; };
  const le = (v, n) => Array.from({ length: n }, (_, k) => (v >> (8 * k)) & 255);
  const width = (v) => (v === 0 ? 0 : v < 256 ? 1 : v < 65536 ? 2 : 3);
  const tag = (id, len, flags, kids) => { const lw = width(len), fw = width(flags); const h = id | (lw << 9) | (fw << 12) | (kids ? 0x8000 : 0); return bytes(h & 255, h >> 8, le(len, lw), le(flags, fw)); };
  const END = bytes(0, 0);
  const names = ["root", "A", "B", "p1.ol", "p2.ol", "p3.ol", "Material", "aço", "part1", "part2", "part3"];
  const enc = new TextEncoder();
  const symBody = cat([bytes(names.length), ...names.map((s) => { const b = enc.encode(s); return cat([bytes(b.length), b]); })]);
  const sym = (i) => bytes(i * 2 + 1);
  const comp = (nameIdx, kids, shapeIdx) => {
    const children = [];
    for (const k of kids) children.push(cat([tag(0x21, 1, 0, false), bytes(k)]));
    if (shapeIdx != null) children.push(cat([tag(0x23, 1, 0, false), sym(shapeIdx)]));
    return cat([tag(0x20, 1, 0, children.length > 0), sym(nameIdx), ...children, children.length ? END : bytes()]);
  };
  // components: 0 p1, 1 p2, 2 p3, 3 A, 4 B, 5 root
  const structure = cat([tag(2, 0, 0, true), comp(8, [], 3), comp(9, [], 4), comp(10, [], 5), comp(1, [0]), comp(2, [1, 2]), comp(0, [3, 4]), END]);
  const rec = (k, v) => cat([tag(0x2b, 2, 0, false), sym(k), sym(v)]);
  const props = cat([tag(3, 0, 0, true), tag(0x2a, 0, 0, true), rec(6, 7), END, tag(0x2a, 1, 1, true), bytes(2), rec(6, 7), END, END]); // comps 0 and 2
  const sections = [[1, enc.encode(""), cat([tag(1, symBody.length, 0, false), symBody])], [2, enc.encode(""), structure], [3, enc.encode("STRUCTURE"), props]];
  const gz = sections.map(([, , d]) => { const g = gzipSync(d, { mtime: 0 }); g[9] = 0; return g; });
  const head = cat([enc.encode("PV-PVS0301C"), bytes(0, 0, 0), bytes(le(sections.length, 4)),
    ...sections.map(([type, name], i) => cat([bytes(type, 1, name.length), name, bytes(le(gz[i].length, 4))]))]);
  return cat([head, ...gz]).buffer;
}

test("moving parts into a group rewrites the PVS and keeps names, shapes and properties", async () => {
  const { parsePVS, buildTree } = await import("../../viewer/lib/pvs.js");
  const { writePVS } = await import("../../viewer/lib/pvswrite.js");
  const { buildSpec, specTree } = await import("../../viewer/lib/restructure.js");
  const original = await tinyPVS();
  const t = buildTree(parsePVS(original).components);
  assert.deepEqual(t.names, ["root", "A", "part1", "B", "part2", "part3"]);
  // p3 (part index 2) goes to a new group; B keeps p2
  const groups = [{ id: 1, name: "Circuito", parent: null, parts: [2] }];
  for (const [rest, names] of [
    ["keep", ["root", "Circuito", "part3", "A", "part1", "B", "part2"]],
    ["box", ["root", "Circuito", "part3", "Peças fora dos grupos", "A", "part1", "B", "part2"]],
    ["drop", ["root", "Circuito", "part3"]],
  ]) {
    const { spec } = buildSpec(t, 3, groups, { rest });
    const { bytes } = writePVS(original, spec, t.names);
    const back = buildTree(parsePVS(bytes.buffer).components);
    assert.deepEqual(back.names, names, rest);
    const want = specTree(t, spec).tree;
    assert.deepEqual(back.parent, want.parent);
    assert.deepEqual(back.shapes, want.shapes);
    // part3 kept its property (it was component 2 of the original)
    const n = back.names.indexOf("part3");
    const props = [];
    for (let k = back.props.start[n]; k < back.props.start[n + 1]; k++) props.push(back.props.keys[back.props.kv[2 * k]] + "=" + back.props.vals[back.props.kv[2 * k + 1]]);
    assert.deepEqual(props, ["Material=aço"]);
  }
});

test("a whole assembly moved to a group keeps its sub-structure", async () => {
  const { parsePVS, buildTree } = await import("../../viewer/lib/pvs.js");
  const { buildSpec, specTree } = await import("../../viewer/lib/restructure.js");
  const t = buildTree(parsePVS(await tinyPVS()).components);
  const { spec } = buildSpec(t, 3, [{ id: 1, name: "G", parent: null, parts: [1, 2] }], { rest: "keep" });
  const { tree, order } = specTree(t, spec);
  assert.deepEqual(tree.names, ["root", "G", "B", "part2", "part3", "A", "part1"]);
  assert.deepEqual([...order], [1, 2, 0]);
  assert.deepEqual(tree.p0.slice(0, 3), [0, 0, 0]);
  assert.deepEqual(tree.p1.slice(0, 3), [3, 2, 2]);
});
