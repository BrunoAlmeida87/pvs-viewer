const test = require("node:test");
const assert = require("node:assert/strict");

// Where a model is read from (viewer/lib/sources.js), with stand-ins for the browser's File and
// directory handles.
const file = (path, text) => ({
  name: path.split(/[\\/]/).pop(), webkitRelativePath: path, // a File's name has no folder
  text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer,
});
function dir(name, entries) { // entries: {name: text | dir(...)}
  return {
    kind: "directory", name,
    async getFileHandle(n) { const e = entries[n]; if (typeof e !== "string") throw Object.assign(new Error(n), { name: "NotFoundError" }); return { kind: "file", getFile: async () => file(n, e) }; },
    async getDirectoryHandle(n) { const e = entries[n]; if (!e || typeof e === "string") throw new Error(n); return e; },
    async *entries() { for (const [n, e] of Object.entries(entries)) yield [n, typeof e === "string" ? { kind: "file", getFile: async () => file(n, e) } : e]; },
  };
}

test("a list of files: the converted model nearest the top, or the .pvs and its .ol beside it", async () => {
  const { fromFileList, NO_MODEL } = await import("../../viewer/lib/sources.js");
  const conv = await fromFileList([file("Modelo/sub/chunks.json", "{}"), file("Modelo/chunks.json", '{"a":1}'), file("Modelo/c/00000.bin", "xyz")]);
  assert.equal(conv.kind, "converted");
  assert.deepEqual(await conv.src.json("chunks.json"), { a: 1 });
  assert.equal(new TextDecoder().decode(await conv.src.buf("c/00000.bin")), "xyz");
  await assert.rejects(conv.src.buf("c/00001.bin"), /arquivo ausente: c\/00001.bin/);

  const raw = await fromFileList([file("SBR\\SBR.pvs", "PVS"), file("SBR\\p1.ol", "OL"), file("SBR\\outra\\p2.ol", "x")]);
  assert.equal(raw.kind, "raw");
  assert.equal(raw.name, "SBR.pvs");
  assert.equal(new TextDecoder().decode(raw.pvs), "PVS");
  assert.deepEqual([...raw.access.files.keys()], ["SBR.pvs", "p1.ol"]); // only the .pvs folder, not its subfolders

  await assert.rejects(fromFileList([file("x/leia.txt", "")]), (e) => e.message === NO_MODEL);
});

test("a folder picked in the browser: converted (also in subfolders of c/) or original", async () => {
  const { fromDirectory, NO_MODEL } = await import("../../viewer/lib/sources.js");
  const conv = await fromDirectory(dir("M", { "chunks.json": '{"format":2}', c: dir("c", { "00000.bin": "abc" }) }));
  assert.equal(conv.kind, "converted");
  assert.deepEqual(await conv.src.json("chunks.json"), { format: 2 });
  assert.equal(new TextDecoder().decode(await conv.src.buf("c/00000.bin")), "abc");

  const d = dir("SBR", { "notas.txt": "", "Maquete.PVS": "P", "p1.ol": "O" });
  const raw = await fromDirectory(d);
  assert.equal(raw.kind, "raw");
  assert.equal(raw.name, "Maquete.PVS");
  assert.equal(raw.access.dir, d);

  await assert.rejects(fromDirectory(dir("vazia", { "a.txt": "" })), (e) => e.message === NO_MODEL);
});

test("the desktop app's folder: converted, original, or neither", async () => {
  const { fromDesktop, NO_MODEL } = await import("../../viewer/lib/sources.js");
  const conv = await fromDesktop({ converted: true, base: "model://local/" });
  assert.equal(conv.kind, "converted");
  assert.equal(typeof conv.src.json, "function");
  await assert.rejects(fromDesktop({ converted: false, pvs: null, base: "model://local/" }), (e) => e.message === NO_MODEL);
});

test("the shaders module only exports GLSL text (no JavaScript inside the shaders)", async () => {
  const sh = await import("../../viewer/lib/shaders.js");
  for (const k of ["COMMON", "VERT_HEAD", "VERT", "FRAG", "EDGE_VERT", "EDGE_FRAG", "NAV_FRAG"]) {
    assert.equal(typeof sh[k], "string", k);
    assert.ok(!/\bexport\b|\bfunction\b/.test(sh[k]), k);
    if (k !== "VERT_HEAD") assert.ok(sh[k].startsWith(sh.COMMON), k); // the shared part comes first
  }
  assert.ok(sh.VERT.includes("const int XRAY_OP = 20;"));
});
