const test = require("node:test");
const assert = require("node:assert/strict");

// A small installation made of solid boxes [minx, miny, minz, maxx, maxy, maxz]: a lower deck at 0 m,
// an upper deck at 4 m (x 10–20) with a hatch for a ladder, a stair between them (x 5–10), a pump
// on the lower deck and a tank on the upper one. The slices are what the GPU would give: the highest
// surface below the cut — the top of a box under it, or the bottom of a box the cut goes through
// (seen from inside, as the viewer draws both sides).
function scene({ stairs = true, ladder = true, grating = false } = {}) {
  const B = [];
  B.push([0, 0, -0.02, 10, 10, 0]); // lower deck, under the stair end and around
  B.push([10, 0, -0.02, 20, 10, 0]);
  // upper deck at 4 m around a hatch (x 17.5–18.5, y 7.5–8.5)
  B.push([10, 0, 3.98, 20, 7.5, 4]);
  B.push([10, 8.5, 3.98, 20, 10, 4]);
  B.push([10, 7.5, 3.98, 17.5, 8.5, 4]);
  B.push([18.5, 7.5, 3.98, 20, 8.5, 4]);
  // a wall closing the space under the upper deck except a door (y 4–5) at x 10
  B.push([10, 0, 0, 10.1, 4, 3.98]);
  B.push([10, 5, 0, 10.1, 10, 3.98]);
  if (stairs) for (let i = 0; i < 20; i++) { // 20 steps of 0.2 m, 0.25 m deep, from x = 5 up to x = 10
    const top = 0.2 * (i + 1);
    B.push([5 + 0.25 * i, 1, top - 0.05, 5 + 0.25 * (i + 1), 2, top]);
  }
  if (ladder) B.push([17.9, 8.3, 0, 18.1, 8.4, 5]); // ladder through the hatch
  B.push([2, 6, 0, 3, 7, 1]); // pump
  B.push([14, 2, 4, 16, 4, 6]); // tank on the upper deck
  if (grating) { // a grating on legs at 1 m over the lower deck: bars every other cell
    for (let x = 0; x < 4; x += 0.4) B.push([x, 8, 0.97, x + 0.2, 10, 1]);
  }
  return B;
}

function build(boxes, opts = {}) {
  return import("../../viewer/lib/navgrid.js").then((ng) => {
    const cell = 0.2, x0 = -1, y0 = -1, W = Math.ceil(22 / cell), H = Math.ceil(12 / cell);
    const b = ng.createBuilder({ W, H, x0, y0, cell });
    const tops = new Float32Array(W * H), inside = new Uint8Array(W * H);
    for (let cut = -0.5; cut < 8; cut += 0.2) {
      // 3 × 3 samples per cell, the highest kept (as tileTops does with the pixels of a render)
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        let t = NaN, back = 0;
        for (let sj = 0; sj < 3; sj++) for (let si = 0; si < 3; si++) {
          const x = x0 + (i + (si + 0.5) / 3) * cell, y = y0 + (j + (sj + 0.5) / 3) * cell;
          for (const q of boxes) {
            if (x < q[0] || x > q[3] || y < q[1] || y > q[4]) continue;
            const top = q[5] <= cut, h = top ? q[5] : q[2] < cut ? q[2] : NaN;
            if (h !== h) continue;
            if (!(h <= t)) { t = h; back = top ? 0 : 1; } else if (h === t && !top) back = 1;
          }
        }
        tops[j * W + i] = t;
        inside[j * W + i] = back;
      }
      b.slice(0, 0, W, H, tops, inside);
    }
    const nav = ng.buildNav(b.grid, b.surfaces(), opts);
    return { ng, nav };
  });
}

const box = (B) => B; // [minx, miny, minz, maxx, maxy, maxz]
const PUMP = box([2, 6, 0, 3, 7, 1]), TANK = box([14, 2, 4, 16, 4, 6]);

async function route(nav, ng, from, to) {
  const np = await import("../../viewer/lib/navpath.js");
  ng.components(nav);
  const p = np.findPath(nav, ng.standAround(nav, from), ng.standAround(nav, to));
  return p && { ...np.shapeRoute(nav, p), np };
}

test("the walking map finds both decks, the stair and the free height", async () => {
  const { ng, nav } = await build(scene());
  const d = ng.decks(nav).map((x) => x.z);
  assert.ok(d.includes(0) && d.includes(4), "decks at 0 and 4 m: " + d);
  // under the upper deck (4 m) there is head room; on the pump (1 m tall, 3 m under nothing) one could stand,
  // but not under the low end of the stair (0.4 m over the floor)
  const under = ng.nearestFloor(nav, 15, 6, 0, 0.3);
  assert.ok(under >= 0, "floor under the upper deck");
  const underStair = ng.nearestFloor(nav, 5.6, 1.5, 0, 0.1, 0.1, 0.1);
  assert.equal(underStair, -1, "no floor under the low end of the stair");
  // a step of the stair is a floor, linked to the next one
  const s = ng.nearestFloor(nav, 7.6, 1.5, 2.2, 0.15, 0.3, 0.3);
  assert.ok(s >= 0, "a step of the stair");
});

test("a route goes from the pump up the stair to the tank", async () => {
  const { ng, nav } = await build(scene({ ladder: false }));
  const r = await route(nav, ng, PUMP, TANK);
  assert.ok(r, "a route");
  const zs = r.points.map((p) => p[2]);
  assert.ok(Math.min(...zs) < 0.1 && Math.max(...zs) > 3.9, "from the lower deck to the upper one");
  // it climbs on the stair (x 5–10, y 1–2)
  const onStair = r.points.filter((p) => p[2] > 1 && p[2] < 3);
  assert.ok(onStair.length > 3 && onStair.every((p) => p[0] > 5 && p[0] < 10 && p[1] > 1 && p[1] < 2), "on the stair");
  assert.ok(r.length > 12 && r.length < 40, "length " + r.length);
  // the instructions climb the stair and arrive
  const steps = r.np.instructions(r, { name: "TANQUE", center: [15, 3, 5], base: 4, top: 6 });
  assert.ok(steps.some((s) => /Suba a escada/.test(s.text)), steps.map((s) => s.text).join(" | "));
  assert.match(steps[steps.length - 1].text, /^Chegou: TANQUE/);
});

test("without the stair the ladder named in the model joins the decks", async () => {
  const { ng, nav } = await build(scene({ stairs: false }));
  assert.equal(await route(nav, ng, PUMP, TANK), null, "no route before the ladder is known");
  const n = ng.addLadder(nav, { label: "LPR-ES001", node: 7, box: [17.9, 8.3, 0, 18.1, 8.4, 5] });
  assert.equal(n, 1, "one link, lower deck to upper deck");
  const r = await route(nav, ng, PUMP, TANK);
  assert.ok(r, "a route by the ladder");
  assert.ok(r.legs.some((l) => l.kind === "ladder" && l.label === "LPR-ES001"));
  const steps = r.np.instructions(r, { name: "TANQUE", center: [15, 3, 5], base: 4, top: 6 });
  assert.ok(steps.some((s) => /Suba a escada LPR-ES001/.test(s.text)), steps.map((s) => s.text).join(" | "));
});

test("a link drawn by hand works like a ladder; a forbidden area is avoided", async () => {
  const { ng, nav } = await build(scene({ stairs: false, ladder: false }));
  assert.ok(ng.addManualLink(nav, [12, 9, 0], [12, 9, 4]));
  let r = await route(nav, ng, PUMP, TANK);
  assert.ok(r && r.legs.some((l) => l.kind === "ladder"));
  // forbid the door in the wall at x = 10 (y 4–5): no way to the link any more
  ng.blockBoxes(nav, [[9.5, 3.5, -0.5, 10.6, 5.5, 0.5]]);
  r = await route(nav, ng, PUMP, TANK);
  assert.equal(r, null, r && JSON.stringify(r.points.filter((q) => Math.abs(q[0] - 10) < 0.3)));
});

test("the route goes through the door and keeps off the walls", async () => {
  const { ng, nav } = await build(scene({ stairs: false }));
  const np = await import("../../viewer/lib/navpath.js");
  const a = ng.nearestFloor(nav, 5, 4.5, 0), b = ng.nearestFloor(nav, 15, 4.5, 0);
  const p = np.findPath(nav, [{ span: a, cost: 0 }], [{ span: b, cost: 0 }]);
  const r = np.shapeRoute(nav, p);
  const at10 = r.points.filter((q) => Math.abs(q[0] - 10) < 0.15);
  assert.ok(at10.length && at10.every((q) => q[1] > 4 && q[1] < 5), "through the door");
  assert.ok(r.turns.length <= 4, "a straight line through the door, not a staircase of cells: " + r.turns.length);
  assert.ok(Math.abs(r.length - 10) < 0.5, "length " + r.length);
});

test("gratings: holes of one cell between bars are floor", async () => {
  const { ng, nav } = await build(scene({ grating: true }));
  let n = 0;
  for (let x = 0.5; x < 3.5; x += 0.2) if (ng.nearestFloor(nav, x, 9, 1, 0.05, 0.05, 0.05) >= 0) n++;
  assert.ok(n >= 13, "the grating is a continuous floor: " + n);
});

test("straight lines and turns are told in words", async () => {
  const np = await import("../../viewer/lib/navpath.js");
  const route = { points: [[0, 0, 0], [5, 0, 0], [10, 0, 0], [10, 5, 0], [10, 8, 0]], turns: [0, 2, 4], legs: [{ kind: "walk", from: 0, to: 4 }] };
  const s = np.instructions(route, { name: "BOMBA", center: [9, 8.5, 0.5] });
  assert.deepEqual(s.map((x) => x.text), ["Siga 10 m e vire à esquerda", "Siga 8 m", "Chegou: BOMBA — à sua esquerda."]);
});
