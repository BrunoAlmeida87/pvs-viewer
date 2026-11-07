const test = require("node:test");
const assert = require("node:assert/strict");

test("web export downloads a readable ZIP containing only selected geometry", async () => {
  const { exportMobileZip } = await import("../../viewer/lib/browser-mobile-export.js");
  const { unzipSync } = await import("../../viewer/vendor/fflate.js");
  const meta = { format: 2, source: "test.pvs", parts: 2, items: 2, tris: 2,
    min: [0, 0, 0], max: [1, 1, 1], chunks: [{ f: "00000.bin", nv: 6, ni: 6, ne: 4, io: 0, ic: 2, min: [0, 0, 0], max: [1, 1, 1] }] };
  const items = new ArrayBuffer(16), itemView = new DataView(items);
  itemView.setUint32(0, 0, true); itemView.setUint32(8, 1, true);
  const chunk = new ArrayBuffer(6 * 12 + 6 * 2 + 4 * 2), dv = new DataView(chunk);
  for (let v = 0; v < 6; v++) dv.setUint16(v * 8 + 6, v < 3 ? 0 : 1, true);
  [0, 1, 2, 3, 4, 5].forEach((v, i) => dv.setUint16(6 * 12 + i * 2, v, true));
  [0, 1, 3, 4].forEach((v, i) => dv.setUint16(6 * 12 + 12 + i * 2, v, true));
  const files = new Map([["items.bin", items], ["c/00000.bin", chunk],
    ["tree.json", new TextEncoder().encode("{}").buffer], ["parts.bin", new ArrayBuffer(48)]]);
  const src = { buf: async (name) => { if (!files.has(name)) throw new Error("missing " + name); return files.get(name); } };
  const blob = await exportMobileZip(src, meta, [1]);
  const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(zip["chunks.json"]));
  assert.deepEqual(manifest.includedParts, [1]);
  assert.equal(manifest.tris, 1);
  assert.equal(manifest.chunks[0].nv, 3);
  assert.equal(zip["c/00000.bin"].length, 3 * 12 + (3 + 2) * 2);
  assert.equal(new DataView(zip["c/00000.bin"].buffer).getUint16(6, true), 1);
  const fullZip = unzipSync(new Uint8Array(await (await exportMobileZip(src, meta, [0, 1])).arrayBuffer()));
  const fullMeta = JSON.parse(new TextDecoder().decode(fullZip["chunks.json"]));
  assert.deepEqual(fullMeta.includedParts, [0, 1]);
  assert.equal(fullMeta.tris, 2);
  assert.equal(fullMeta.chunks[0].nv, 6);
  const streamed = [];
  const noBlob = await exportMobileZip(src, meta, [0, 1], () => {}, async (bytes) => { streamed.push(bytes); });
  assert.equal(noBlob, null);
  const streamedZip = unzipSync(new Uint8Array(await new Blob(streamed).arrayBuffer()));
  assert.equal(JSON.parse(new TextDecoder().decode(streamedZip["chunks.json"])).tris, 2);
});
