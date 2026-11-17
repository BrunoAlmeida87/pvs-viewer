const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");

const OL = pathToFileURL(path.join(__dirname, "..", "..", "viewer", "lib", "ol.js")).href;

// ------------------------------------------------------------ a small .ol file, written by hand
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
const i32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, true); return b; };
const f32 = (...v) => new Uint8Array(Float32Array.from(v).buffer);
const u32s = (...v) => new Uint8Array(Uint32Array.from(v).buffer);
// record: u32 word (tag, bit 24 = has children), i32 payload length, payload, children, end mark
const rec = (tag, payload, kids = null) => cat(u32(tag | (kids ? 0x1000000 : 0)), i32(payload.length), payload,
  ...(kids ? [...kids, u32(0), i32(0)] : []));

// "DIV-OL07BL", 8 bytes, u32 section count, {u32 id, u32 offset} per section, then the sections
function olFile(sections) {
  const head = 22 + sections.length * 8;
  let off = head;
  const table = [];
  for (const [id, data] of sections) { table.push(u32(id), u32(off)); off += data.length; }
  return cat(new TextEncoder().encode("DIV-OL07BL"), new Uint8Array(8), u32(sections.length), ...table, ...sections.map((s) => s[1]));
}

// one red material; one face: a 1 × 1 m square on z = 0 (two triangles, normals +z); one edge
const material = rec(5, cat(f32(0, 0, 0), f32(1, 0, 0), new Uint8Array(28), f32(1)));
const pool = rec(0x16, cat(new Uint8Array([1]), u32(4),
  f32(0, 0, 0, 0, 0, 1), f32(1, 0, 0, 0, 0, 1), f32(1, 1, 0, 0, 0, 1), f32(0, 1, 0, 0, 0, 1)), [
  rec(0x17, new Uint8Array(0), [rec(0x18, cat(i32(0), i32(-1)), [rec(0x1b, u32s(0, 1, 2, 0, 2, 3))])]),
]);
const face = rec(0x0d, i32(0), [pool]);
const edgePool = rec(0x16, cat(new Uint8Array([0]), u32(2), f32(0, 0, 0), f32(1, 0, 0)), [
  rec(0x17, new Uint8Array(0), [rec(0x18, cat(i32(0), i32(-1)), [rec(0x1d, u32s(0, 1))])]),
]);
const SEC0 = material, SEC1 = face, SEC2 = edgePool;
const valid = () => olFile([[0, SEC0], [1, SEC1], [2, SEC2]]);

// The same file with the face record's length made negative (it points back at its own header).
function negativeAt(sectionId) {
  const secs = [[0, SEC0], [1, SEC1.slice()], [2, SEC2.slice()]];
  new DataView(secs[sectionId][1].buffer).setInt32(4, -8, true);
  return olFile(secs);
}

// ------------------------------------------------------------ running loadOL with a time limit
// In a worker: a parser stuck in a loop must fail the test, not hang the test runner.
function inWorker(inputs, ms) {
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.url).then(({ loadOL }) => {
      const out = workerData.inputs.map((u8) => {
        try {
          const r = loadOL(u8);
          return { ok: true, groups: r.groups.map((g) => ({ rgba: g.rgba, layer: g.layer, tris: g.tris.flat().length, curved: g.nrm.some(Boolean) })),
            edges: Object.fromEntries(Object.entries(r.edges).map(([k, e]) => [k, { pts: e.pos.length / 3, segs: [...e.segs] }])) };
        } catch (e) { return { ok: false, error: String(e.message || e) }; }
      });
      parentPort.postMessage(out);
    });`;
  return new Promise((resolve) => {
    const w = new Worker(code, { eval: true, workerData: { url: OL, inputs } });
    const timer = setTimeout(() => { w.terminate(); resolve(null); }, ms);
    w.once("message", (m) => { clearTimeout(timer); w.terminate(); resolve(m); });
    w.once("error", (e) => { clearTimeout(timer); resolve([{ ok: false, error: "worker: " + e.message }]); });
  });
}

test("a valid .ol file: colour, triangles, flat face, CAD edge", async () => {
  const [r] = await inWorker([valid()], 5000);
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.groups, [{ rgba: [255, 0, 0, 255], layer: "", tris: 6, curved: false }]);
  assert.deepEqual(r.edges, { "": { pts: 2, segs: [0, 1] } });
});

test("a record with a negative length is a corrupt file, not an endless loop", async () => {
  const r = await inWorker([negativeAt(1)], 5000);
  assert.ok(r, "loadOL did not finish in 5 s (endless loop)");
  assert.equal(r[0].ok, false);
  assert.match(r[0].error, /corrompido/);
});

test("corrupt edges (section 2) leave the faces, without edges", async () => {
  const r = await inWorker([negativeAt(2)], 5000);
  assert.ok(r, "loadOL did not finish in 5 s (endless loop)");
  assert.ok(r[0].ok, r[0].error);
  assert.equal(r[0].groups[0].tris, 6);
  assert.deepEqual(r[0].edges, {});
});

test("random damage to the records never hangs the reader", async () => {
  // deterministic pseudo-random bytes (the same cases on every run)
  let seed = 12345;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const base = valid(), start = 22 + 3 * 8; // only the records: the section table stays valid
  const inputs = [];
  for (let k = 0; k < 400; k++) {
    const u8 = base.slice();
    const n = 1 + Math.floor(rnd() * 8);
    for (let j = 0; j < n; j++) u8[start + Math.floor(rnd() * (u8.length - start))] = Math.floor(rnd() * 256);
    inputs.push(u8);
  }
  const r = await inWorker(inputs, 20000);
  assert.ok(r, "some damaged file made loadOL loop for more than 20 s");
  assert.equal(r.length, inputs.length);
});
