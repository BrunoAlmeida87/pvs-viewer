const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { exportMobile } = require("../mobile-export");

test("exports only selected converted geometry while preserving item ids", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pvs-mobile-export-"));
  const source = path.join(root, "source"), target = path.join(root, "target");
  try {
    await fs.mkdir(path.join(source, "c"), { recursive: true });
    const items = Buffer.alloc(16);
    items.writeUInt32LE(0, 0); items.writeUInt32LE(1, 8);
    await fs.writeFile(path.join(source, "items.bin"), items);
    for (const name of ["tree.json", "parts.bin"]) await fs.writeFile(path.join(source, name), "{}");
    const verts = Buffer.alloc(6 * 8), normals = Buffer.alloc(6 * 4);
    for (let v = 0; v < 6; v++) verts.writeUInt16LE(v < 3 ? 0 : 1, v * 8 + 6);
    const indices = Buffer.alloc(12), edges = Buffer.alloc(8);
    [0, 1, 2, 3, 4, 5].forEach((v, i) => indices.writeUInt16LE(v, i * 2));
    [0, 1, 3, 4].forEach((v, i) => edges.writeUInt16LE(v, i * 2));
    await fs.writeFile(path.join(source, "c", "00000.bin"), Buffer.concat([verts, normals, indices, edges]));
    await fs.writeFile(path.join(source, "chunks.json"), JSON.stringify({
      format: 2, source: "test.pvs", parts: 2, items: 2, tris: 2,
      min: [0, 0, 0], max: [1, 1, 1], chunks: [{ f: "00000.bin", nv: 6, ni: 6, ne: 4, io: 0, ic: 2, min: [0, 0, 0], max: [1, 1, 1] }],
    }));
    const result = await exportMobile(source, target, [1]);
    const meta = JSON.parse(await fs.readFile(path.join(target, "chunks.json"), "utf8"));
    const out = await fs.readFile(path.join(target, "c", "00000.bin"));
    assert.deepEqual(result, { chunks: 1, tris: 1 });
    assert.deepEqual(meta.includedParts, [1]);
    assert.equal(meta.chunks[0].nv, 3);
    assert.equal(meta.chunks[0].ni, 3);
    assert.equal(meta.chunks[0].ne, 2);
    assert.equal(out.length, 3 * 12 + (3 + 2) * 2);
    assert.equal(out.readUInt16LE(6), 1); // original local item id remains valid
    assert.deepEqual([0, 1, 2], [out.readUInt16LE(36), out.readUInt16LE(38), out.readUInt16LE(40)]);
  } finally {
    if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir())) await fs.rm(root, { recursive: true, force: true });
  }
});
