const test = require("node:test");
const assert = require("node:assert/strict");

test("exports a selected node from an original PVS source", async () => {
  const { exportRawModelZip } = await import("../../viewer/lib/raw-model-export.js");
  const { unzipSync } = await import("../../viewer/vendor/fflate.js");
  const previousWorker = global.Worker;
  global.Worker = class {
    postMessage(message) {
      if (message.type !== "task") return;
      queueMicrotask(() => {
        const part = message.parts[0].part;
        this.onmessage({ data: { type: "chunk", min: [0, 0, 0], max: [1, 1, 1], nv: 3, ni: 3, ne: 0,
          ps: 1, small: false, verts: new Uint16Array(12), nrm: new Int8Array(12), idx: new Uint16Array([0, 1, 2]),
          edges: new Uint16Array(0), items: new Uint32Array([part]), colors: new Uint8Array([255, 0, 0, 255]), layers: [""] } });
        this.onmessage({ data: { type: "done", boxParts: new Uint32Array([part]), boxes: new Float32Array([0, 0, 0, 1, 1, 1]) } });
      });
    }
    terminate() {}
  };
  try {
    const source = { kind: "raw", small: 0, m: { name: "test.pvs", access: { files: new Map() } },
      t: { shapes: ["one.ol", "two.ol"], boxes: [[0, 0, 0, 1, 1, 1], [0, 0, 0, 1, 1, 1]] } };
    const blob = await exportRawModelZip(source, [1]);
    const zip = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    const meta = JSON.parse(new TextDecoder().decode(zip["chunks.json"]));
    assert.deepEqual(meta.includedParts, [1]);
    assert.equal(meta.format, 2);
    assert.equal(meta.tris, 1);
    assert.equal(meta.chunks[0].io, 0);
    assert.ok(zip["c/00000.bin"]);
    assert.equal(new DataView(zip["items.bin"].buffer, zip["items.bin"].byteOffset).getUint32(0, true), 1);
  } finally { global.Worker = previousWorker; }
});
