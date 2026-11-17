const test = require("node:test");
const assert = require("node:assert/strict");

// A box as the CAD files have it: each face its own 4 vertices (corners repeated), 2 triangles per face,
// counter-clockwise seen from outside. inward: the faces turned to the inside (the cavity of a hollow part).
function box(x0, y0, z0, x1, y1, z1, { inward = false, without = -1 } = {}) {
  const C = [];
  for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) C.push([x, y, z]);
  const F = [[0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6], [0, 1, 3, 2], [4, 6, 7, 5]];
  const pos = [], idx = [];
  F.forEach((f, k) => {
    if (k === without) return;
    const b = pos.length / 3;
    for (const c of f) pos.push(...C[c]);
    if (inward) idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    else idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  });
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx) };
}
const merge = (...meshes) => {
  const pos = [], idx = [];
  for (const m of meshes) { const b = pos.length / 3; pos.push(...m.pos); for (const i of m.idx) idx.push(i + b); }
  return { pos: Float32Array.from(pos), idx: Uint32Array.from(idx) };
};

// geomworker.js in a Node worker thread (self = a small shim), answering the messages the page sends.
function geomWorker() {
  const { Worker } = require("node:worker_threads");
  const url = require("node:url").pathToFileURL(require("node:path").join(__dirname, "..", "..", "viewer", "lib", "geomworker.js")).href;
  const w = new Worker(`
    const { parentPort } = require("node:worker_threads");
    globalThis.self = { postMessage: (m) => parentPort.postMessage(m) };
    import(${JSON.stringify(url)}).then(() => parentPort.on("message", (data) => self.onmessage({ data })));`, { eval: true });
  const waiting = new Map();
  w.on("message", (m) => { const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r(m); } });
  let id = 0;
  return {
    mesh: (key, m) => w.postMessage({ type: "mesh", key, pos: m.pos, idx: m.idx }),
    pair: (a, b) => new Promise((r) => { const i = ++id; waiting.set(i, r); w.postMessage({ type: "pair", id: i, a, b, limit: Infinity }); }),
    close: () => w.terminate(),
  };
}

test("the check worker: contact, one inside the other, and a mesh it does not hold any more", async () => {
  const g = geomWorker();
  try {
    g.mesh("big", box(0, 0, 0, 1, 1, 1)); g.mesh("small", box(0.25, 0.25, 0.25, 0.75, 0.75, 0.75)); g.mesh("far", box(3, 0, 0, 4, 1, 1));
    let r = await g.pair("big", "far");
    assert.equal(r.crossings, 0); assert.ok(Math.abs(r.d - 2) < 1e-6);
    r = await g.pair("big", "small");
    assert.equal(r.contained, true); assert.equal(r.d, 0);
    // a mesh the worker does not have (never sent, or dropped from its memory): an error, never "no collision"
    r = await g.pair("big", "gone");
    assert.ok(r.error, "a missing mesh must be reported, not answered as d = Infinity");
  } finally { g.close(); }
});

test("the check worker keeps the meshes in use: the least recently used is dropped first", async () => {
  const g = geomWorker();
  try {
    const cube = box(0, 0, 0, 1, 1, 1), MAX = 600;
    g.mesh("item", cube);                                   // the moving equipment, sent first
    for (let k = 1; k < MAX; k++) g.mesh("p" + k, box(2, 0, 0, 3, 1, 1)); // the cache is now full
    let r = await g.pair("item", "p1");                      // the item is used…
    assert.ok(!r.error, r.error);
    g.mesh("new", box(2, 0, 0, 3, 1, 1));                    // …so a new mesh drops p2 (unused), not the item
    r = await g.pair("item", "new");
    assert.ok(!r.error, "the mesh in use was dropped: " + r.error);
    r = await g.pair("item", "p2");
    assert.ok(r.error, "p2, the least recently used, should have been dropped");
  } finally { g.close(); }
});

test("closed meshes: a box is; a box without one face is not", async () => {
  const { isClosed } = await import("../../viewer/lib/geom.js");
  assert.equal(isClosed(box(0, 0, 0, 1, 1, 1)), true);
  assert.equal(isClosed(box(0, 0, 0, 1, 1, 1, { without: 5 })), false);
  // a hollow part (outer box + inner cavity) is closed too
  assert.equal(isClosed(merge(box(0, 0, 0, 4, 4, 4), box(1, 1, 1, 3, 3, 3, { inward: true }))), true);
});

test("a point is inside a closed mesh, outside it, or in the cavity of a hollow part", async () => {
  const { buildBVH, pointInside } = await import("../../viewer/lib/geom.js");
  const solid = buildBVH(box(0, 0, 0, 1, 1, 1));
  assert.equal(pointInside(solid, [0.5, 0.5, 0.5]), true);
  assert.equal(pointInside(solid, [0.3, 0.71, 0.2]), true);
  assert.equal(pointInside(solid, [1.5, 0.5, 0.5]), false);
  assert.equal(pointInside(solid, [-0.2, -0.2, 2]), false);
  const hollow = buildBVH(merge(box(0, 0, 0, 4, 4, 4), box(1, 1, 1, 3, 3, 3, { inward: true })));
  assert.equal(pointInside(hollow, [0.5, 2, 2]), true);   // in the wall of the part
  assert.equal(pointInside(hollow, [2, 2, 2]), false);    // in the cavity: not inside the material
});

test("one part entirely inside another is contained; touching, apart, open or in a cavity is not", async () => {
  const { buildBVH, contained, intersections } = await import("../../viewer/lib/geom.js");
  const B = (m) => buildBVH(m);
  const big = B(box(0, 0, 0, 1, 1, 1)), small = B(box(0.25, 0.25, 0.25, 0.75, 0.75, 0.75));
  assert.equal(intersections(big, small), 0); // the surfaces do not cross: only containment finds it
  assert.equal(contained(big, small), true);
  assert.equal(contained(small, big), true); // either order
  assert.equal(contained(big, B(box(2, 0, 0, 3, 1, 1))), false); // apart
  assert.equal(contained(big, B(box(1, 0, 0, 2, 1, 1))), false); // face against face
  assert.equal(contained(B(box(0, 0, 0, 1, 1, 1, { without: 5 })), small), false); // open outer mesh: no "inside"
  const hollow = B(merge(box(0, 0, 0, 4, 4, 4), box(1, 1, 1, 3, 3, 3, { inward: true })));
  assert.equal(contained(hollow, B(box(1.5, 1.5, 1.5, 2.5, 2.5, 2.5))), false); // in the cavity (a pipe in its insulation)
  assert.equal(contained(hollow, B(box(0.2, 0.2, 0.2, 0.8, 0.8, 0.8))), true); // in the material
});
