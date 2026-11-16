const test = require("node:test");
const assert = require("node:assert/strict");

// The link written on an NFC tag: a part, its model and the camera, short enough for an NTAG213.
test("an NFC tag link goes back to the same part, model and camera", async () => {
  const { tagURL, parseTag, tagFits } = await import("../../viewer/lib/nfctag.js");
  const cam = { ortho: false, pos: [123.456789, -45.1, 7.25], target: [118.2, -40.004, 3], half: 10, zoom: 1 };
  const url = tagURL("https://brunoalmeida87.github.io/pvs-viewer/viewer/?abrir#vista=x",
    { code: "LPR-DT20003", model: "SBR.pvs", cam, regions: { preview: true, ids: [3, 4, 5, 20, 400] } });
  assert.equal(url, "https://brunoalmeida87.github.io/pvs-viewer/viewer/?p=LPR-DT20003&m=SBR&c=123.46_-45.1_7.25_118.2_-40_3&r=P.3-5.k.b4");
  const t = parseTag(url);
  assert.equal(t.code, "LPR-DT20003");
  assert.equal(t.model, "SBR");
  assert.deepEqual(t.cam, { ortho: false, pos: [123.46, -45.1, 7.25], target: [118.2, -40, 3] });
  assert.deepEqual(t.regions, { all: false, preview: true, ids: [3, 4, 5, 20, 400] });
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
  assert.equal(url, "http://localhost:8080/?p=Bomba+01/A&m=Maquete+SBR+rev+2");
  const t = parseTag(url);
  assert.equal(t.code, "Bomba 01/A");
  assert.ok(sameModel(t.model, "maquete sbr rev 2.PVS"));
  assert.equal(t.cam, null);
  assert.equal(parseTag("https://example.com/"), null);
  assert.equal(parseTag("não é link"), null);
  assert.equal(parseTag("https://x/viewer/#peca=LPR-EX20003").code, "LPR-EX20003"); // the older part links
  assert.equal(parseTag("https://x/viewer/?peca=LPR-EX20003").code, "LPR-EX20003");
  assert.equal(t.regions, null);
  assert.equal(ndefBytes("https://a.b/"), 4 + 1 + 4);
});

test("what was loaded: everything, nothing but the part, the preview, sections", async () => {
  const { encodeRegions, decodeRegions, encodeCam } = await import("../../viewer/lib/nfctag.js");
  assert.equal(encodeRegions({ all: true }), "A");
  assert.equal(encodeRegions({ preview: false, ids: [] }), "N");
  assert.equal(encodeRegions({ preview: true, ids: [] }), "P");
  assert.equal(encodeRegions({ preview: false, ids: [7, 0, 1, 2, 7] }), "0-2.7");
  assert.equal(encodeRegions(null), "");
  assert.deepEqual(decodeRegions("A"), { all: true, preview: false, ids: [] });
  assert.deepEqual(decodeRegions("N"), { all: false, preview: false, ids: [] });
  assert.deepEqual(decodeRegions("P.0-2.7"), { all: false, preview: true, ids: [0, 1, 2, 7] });
  assert.equal(decodeRegions("x-?"), null);
  assert.equal(decodeRegions(null), null);
  // a plant seen from far: decimetres are enough
  assert.equal(encodeCam({ pos: [1000.26, 50, 30], target: [960, 40, 0] }), "1000.3_50_30_960_40_0");
});
