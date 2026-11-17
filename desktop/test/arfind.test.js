const test = require("node:test");
const assert = require("node:assert/strict");

// A pump 1 × 1 m standing on the floor (z 0), its middle at (10.5, 0.5); you stand at the origin.
const PUMP = [10, 0, 0, 11, 1, 1.2];
const me = { x: 0, y: 0.5, feet: 0 };

test("the arrow points at the item: ahead, to the right, behind", async () => {
  const { findInfo } = await import("../../viewer/lib/arfind.js");
  let f = findInfo(me, [1, 0], [PUMP]); // looking along +x: it is straight ahead, 10 m away
  assert.equal(f.side, "à frente");
  assert.ok(Math.abs(f.dist - 10) < 1e-9 && Math.abs(f.rel) < 1e-9);
  f = findInfo(me, [0, 1], [PUMP]); // looking along +y: +x is to the right
  assert.equal(f.side, "à direita");
  assert.ok(Math.abs(f.rel - Math.PI / 2) < 1e-9);
  f = findInfo(me, [0, -1], [PUMP]);
  assert.equal(f.side, "à esquerda");
  f = findInfo(me, [-1, 0], [PUMP]);
  assert.equal(f.side, "atrás de você");
  f = findInfo(me, [1, 1], [PUMP]); // 45° to the left of it
  assert.equal(f.side, "à frente, à direita");
});

test("above, below and on the same level", async () => {
  const { findInfo, findLine } = await import("../../viewer/lib/arfind.js");
  const valve = [5, 0, 4.5, 5.4, 0.4, 5]; // on the deck above
  let f = findInfo(me, [1, 0], [valve]);
  assert.equal(f.level.kind, "above");
  assert.equal(findLine(f), "5 m · à frente · 4,5 m acima");
  f = findInfo({ x: 0, y: 0, feet: 4.5 }, [1, 0], [PUMP]); // from the deck above
  assert.equal(f.level.kind, "below");
  assert.match(findLine(f), /3,3 m abaixo/);
  const high = [5, 0, 1.8, 5.4, 0.4, 2.1]; // a valve within reach over the floor
  assert.equal(findInfo(me, [1, 0], [high]).level.kind, "same");
});

test("arriving: close to it and within reach", async () => {
  const { findInfo, findLine } = await import("../../viewer/lib/arfind.js");
  const f = findInfo({ x: 9.4, y: 0.5, feet: 0 }, [1, 0], [PUMP]);
  assert.ok(f.arrived);
  assert.equal(findLine(f), "à frente");
  // over it in plan but a deck below: not arrived
  assert.ok(!findInfo({ x: 10.5, y: 0.5, feet: -4 }, [1, 0], [PUMP]).arrived);
});

test("several items (a whole system): the nearest one, the same deck first", async () => {
  const { findInfo } = await import("../../viewer/lib/arfind.js");
  const far = [30, 0, 0, 31, 1, 1], upstairs = [3, 0, 4.5, 4, 1, 5.5];
  const f = findInfo(me, [1, 0], [far, upstairs, PUMP]);
  assert.equal(f.index, 2); // the pump: 10 m on this deck beats 3 m but a deck up
});

test("a buzz each time it gets closer than 20, 10, 5 and 2 m", async () => {
  const { closerStep } = await import("../../viewer/lib/arfind.js");
  assert.equal(closerStep(21, 19), 20);
  assert.equal(closerStep(10.2, 9.9), 10);
  assert.equal(closerStep(6, 1.5), 2);
  assert.equal(closerStep(9, 8), 0);
  assert.equal(closerStep(4, 6), 0); // going away: nothing
});
