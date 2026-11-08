const test = require("node:test");
const assert = require("node:assert/strict");

test("mobile first load keeps a bounded, recognizable preview", async () => {
  const { previewChunks, completedParts } = await import("../../viewer/lib/mobile-preview.js");
  const chunks = [
    { ni: 3_000_000, ps: 2, small: false },
    { ni: 3_000_000, ps: 20, small: false },
    { ni: 3_000_000, ps: 1, small: true },
  ];
  assert.deepEqual(previewChunks(chunks, [0, 1, 2], 2_000_000), [0, 1]);
  assert.deepEqual(previewChunks(chunks, [0, 1, 2], 500_000), [1]);
  assert.deepEqual(previewChunks(chunks, [2], 1_500_000), [2]);
  const pieces = [{ io: 0, ic: 2 }, { io: 2, ic: 1 }];
  assert.deepEqual([...completedParts(pieces, [0, 1, 0], [1, 0], 3)], [0, 1, 1]);
  assert.deepEqual([...completedParts(pieces, [0, 1, 0], [1, 1], 3)], [1, 1, 1]);
});
