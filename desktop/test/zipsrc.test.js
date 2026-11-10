const test = require("node:test");
const assert = require("node:assert/strict");

// A converted model read straight from a ZIP: stored or compressed entries, at the top or in a folder.
test("reads a converted model from a ZIP without extracting it", async () => {
  const { zipConverted, zipEntries } = await import("../../viewer/lib/zipsrc.js");
  const { zipSync } = await import("../../viewer/vendor/fflate.js");
  const text = (s) => new TextEncoder().encode(s);
  const chunk = new Uint8Array(5000).map((_, i) => (i * 7) & 255);
  const files = { "chunks.json": text(JSON.stringify({ format: 2, chunks: [{ f: "00000.bin" }] })), "tree.json": text('{"names":["raiz"]}'), "c/00000.bin": chunk };

  for (const [label, level, prefix] of [["stored", 0, ""], ["compressed, inside a folder", 6, "SBR-modelo/"]]) {
    const tree = {};
    for (const [name, data] of Object.entries(files)) tree[prefix + name] = [data, { level }];
    const zip = new Blob([zipSync(tree)]);
    const src = await zipConverted(zip);
    assert.equal((await src.json("chunks.json")).format, 2, label);
    assert.deepEqual(await src.json("tree.json"), { names: ["raiz"] }, label);
    assert.deepEqual(new Uint8Array(await src.buf("c/00000.bin")), chunk, label);
    await assert.rejects(() => src.buf("c/00001.bin"), /ausente/, label);
    assert.equal((await zipEntries(zip)).size, 3, label);
  }
});

test("explains a ZIP that holds no converted model", async () => {
  const { zipConverted } = await import("../../viewer/lib/zipsrc.js");
  const { zipSync } = await import("../../viewer/vendor/fflate.js");
  const raw = new Blob([zipSync({ "SBR.pvs": new Uint8Array(4), "a.ol": new Uint8Array(4) })]);
  await assert.rejects(() => zipConverted(raw), /modelo original/);
  await assert.rejects(() => zipConverted(new Blob([zipSync({ "leia.txt": new Uint8Array(1) })])), /chunks\.json/);
  await assert.rejects(() => zipConverted(new Blob([new Uint8Array(100)])), /ZIP válido/);
});
