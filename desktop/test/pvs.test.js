const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");

const lib = (n) => pathToFileURL(path.join(__dirname, "..", "..", "viewer", "lib", n)).href;

// Components as parsePVS returns them: { name, shape, bbox, children: [{ comp }] }
const comp = (name, kids = [], shape = null) => ({ name, shape, bbox: shape ? [0, 0, 0, 1, 1, 1] : null, thumb: null, props: null,
  children: kids.map((k) => ({ comp: k })) });

// Runs fn(module, input) in a worker with little memory and a time limit: a structure that grows
// without end must fail the test instead of taking the test runner down with it.
function inWorker(url, fnSource, input, ms = 5000) {
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.url).then((m) => {
      try { parentPort.postMessage({ ok: true, value: (${fnSource})(m, workerData.input) }); }
      catch (e) { parentPort.postMessage({ ok: false, error: String(e.message || e) }); }
    });`;
  return new Promise((resolve) => {
    const w = new Worker(code, { eval: true, workerData: { url, input }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    const timer = setTimeout(() => { w.terminate(); resolve({ ok: false, error: "não terminou em " + ms + " ms" }); }, ms);
    w.once("message", (m) => { clearTimeout(timer); w.terminate(); resolve(m); });
    w.once("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: "worker: " + (e.code || e.message) }); });
  });
}
const tree = (comps) => inWorker(lib("pvs.js"), "(m, c) => m.buildTree(c)", comps);
const order = (comps) => inWorker(lib("pvswrite.js"), "(m, c) => m.nodeComponents(c)", comps);

test("a part used twice in one assembly appears twice in the tree", async () => {
  // root R > assembly A > the same part L twice
  const r = await tree([comp("L", [], "l.ol"), comp("A", [0, 0]), comp("R", [1])]);
  assert.ok(r.ok, r.error);
  const t = r.value;
  assert.deepEqual(t.names, ["R", "A", "L", "L"]);
  assert.deepEqual(t.parent, [-1, 0, 1, 1]);
  assert.deepEqual(t.part, [-1, -1, 0, 1]);
  assert.deepEqual([t.p0, t.p1], [[0, 0, 0, 1], [2, 2, 1, 2]]);
  assert.deepEqual(t.shapes, ["l.ol", "l.ol"]);
});

test("a component that holds itself is a corrupt file, not an endless tree", async () => {
  for (const comps of [
    [comp("A", [0])],                               // A contains A
    [comp("A", [1]), comp("B", [0]), comp("R", [0])], // A > B > A
  ]) {
    const r = await tree(comps);
    assert.equal(r.ok, false);
    assert.match(r.error, /contém a si mesmo/);
  }
});

test("a reference to a component that does not exist, and a file with no components", async () => {
  let r = await tree([comp("A", [7]), comp("R", [0])]);
  assert.equal(r.ok, false);
  assert.match(r.error, /inexistente/);
  r = await tree([]);
  assert.equal(r.ok, false);
  assert.match(r.error, /sem componentes/);
});

test("the PVS writer walks the tree in the same order and stops at a cycle too", async () => {
  const kids = (list) => list.map((k) => ({ kids: k }));
  let r = await order(kids([[], [0, 0], [1]]));
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.value, [2, 1, 0, 0]); // same node order as buildTree above
  r = await order(kids([[1], [0], [0]]));
  assert.equal(r.ok, false);
  assert.match(r.error, /contém a si mesmo/);
});
