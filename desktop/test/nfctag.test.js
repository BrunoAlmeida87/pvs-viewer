const test = require("node:test");
const assert = require("node:assert/strict");

// The link written on an NFC tag: a part, its model and the camera, short enough for an NTAG213.
test("an NFC tag link goes back to the same part, model and camera", async () => {
  const { tagURL, parseTag, tagFits } = await import("../../viewer/lib/nfctag.js");
  const cam = { ortho: false, pos: [123.456789, -45.1, 7.25], target: [118.2, -40.004, 3], half: 10, zoom: 1 };
  const url = tagURL("https://brunoalmeida87.github.io/pvs-viewer/viewer/?abrir#vista=x",
    { code: "LPR-DT20003", model: "SBR.pvs", cam });
  assert.equal(url, "https://brunoalmeida87.github.io/pvs-viewer/viewer/?peca=LPR-DT20003&m=SBR&c=123.46_-45.1_7.25_118.2_-40_3");
  const t = parseTag(url);
  assert.equal(t.code, "LPR-DT20003");
  assert.equal(t.model, "SBR");
  assert.deepEqual(t.cam, { ortho: false, pos: [123.46, -45.1, 7.25], target: [118.2, -40, 3] });
  const fit = tagFits(url);
  assert.equal(fit.chip, "NTAG213");
  assert.ok(fit.bytes <= 137, fit.bytes);
});

test("close and orthographic views, names with spaces, links that are not tags", async () => {
  const { tagURL, parseTag, encodeCam, decodeCam, sameModel, ndefBytes } = await import("../../viewer/lib/nfctag.js");
  // close to the part: millimetres
  assert.equal(encodeCam({ pos: [1.23456, 0, -0.0001], target: [1, 0, 0] }), "1.235_0_0_1_0_0");
  const o = decodeCam(encodeCam({ ortho: true, pos: [10, 20, 30], target: [0, 0, 0], half: 12.5, zoom: 2 }));
  assert.deepEqual(o, { ortho: true, pos: [10, 20, 30], target: [0, 0, 0], half: 12.5, zoom: 2 });
  assert.equal(decodeCam("1_2_3"), null);
  assert.equal(decodeCam("1_2_3_a_5_6"), null);
  const url = tagURL("http://localhost:8080/", { code: "Bomba 01/A", model: "Maquete SBR rev 2.pvs", cam: null });
  assert.equal(url, "http://localhost:8080/?peca=Bomba+01/A&m=Maquete+SBR+rev+2");
  const t = parseTag(url);
  assert.equal(t.code, "Bomba 01/A");
  assert.ok(sameModel(t.model, "maquete sbr rev 2.PVS"));
  assert.equal(t.cam, null);
  assert.equal(parseTag("https://example.com/"), null);
  assert.equal(parseTag("não é link"), null);
  assert.equal(parseTag("https://x/viewer/#peca=LPR-EX20003").code, "LPR-EX20003"); // the older part links
  assert.equal(ndefBytes("https://a.b/"), 4 + 1 + 4);
});
