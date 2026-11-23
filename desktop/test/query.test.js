const test = require("node:test");
const assert = require("node:assert/strict");

// Conditions on properties in the search box (viewer/lib/query.js).
const KEYS = ["Material", "Thickness", "Unit weight", "Description", "part_objectid", "Bigrama", "Descrição"];
// a few nodes, as {key: value}
const NODES = [
  { Material: "S355JR", Thickness: "10", "Unit weight": "52,5", Description: "TUBE 8 POL", Bigrama: "DT" },
  { Material: "S275", Thickness: "8.0", "Unit weight": "12", Description: "Chapa xadrez" },
  { Material: "s355j2", Thickness: "12 mm", Description: "TUBE 4 POL" },
  { Material: "AISI 316", Description: "Válvula gaveta", Descrição: "Válvula" },
  {}, // an assembly: no properties
];

async function run(query) {
  const { parseQuery, passes } = await import("../../viewer/lib/query.js");
  const q = parseQuery(query, KEYS);
  const hits = NODES.map((props, i) => [props, i]).filter(([props]) =>
    q.conds.every((c) => passes(c, (ki) => props[KEYS[ki]]))).map(([, i]) => i);
  return { ...q, hits };
}

test("a word with a property name and an operator is a condition; any other word stays text", async () => {
  const q = await run("bomba Material=S355* lpr-dt20003 Cor=azul");
  assert.deepEqual(q.conds.map((c) => [c.key, c.op, c.values]), [["Material", "=", ["S355*"]]]);
  assert.deepEqual(q.words, ["bomba", "lpr-dt20003", "Cor=azul"]); // "Cor" is not a property here
  assert.equal(q.error, "");
  // capitals, accents, spaces and separators in the property name do not count
  for (const w of ["material=x", "MATERIAL=x", "unit_weight>1", "UnitWeight>1", "\"Unit weight\">1", "descricao~v"]) {
    assert.equal((await run(w)).conds.length, 1, w);
  }
  // "Descrição" is its own property: "descricao" names it (not "Description")
  assert.equal((await run("descricao~v")).conds[0].key, "Descrição");
});

test("= with wildcards and alternatives, ~ contains, != another value", async () => {
  assert.deepEqual((await run("Material=S355*")).hits, [0, 2]); // capitals do not count
  assert.deepEqual((await run("Material=S355")).hits, []); // whole value
  assert.deepEqual((await run("Material=s27?")).hits, [1]);
  assert.deepEqual((await run("Material=S275|AISI*")).hits, [1, 3]);
  assert.deepEqual((await run("Description~tube")).hits, [0, 2]);
  assert.deepEqual((await run("Description~\"8 POL\"")).hits, [0]);
  assert.deepEqual((await run("Description~valvula")).hits, [3]); // accents do not count
  // != : has the property and it is something else (the assembly without properties is not listed)
  assert.deepEqual((await run("Material!=S275")).hits, [0, 2, 3]);
  assert.deepEqual((await run("Material!=S355*")).hits, [1, 3]);
  // two conditions: both
  assert.deepEqual((await run("Material=S355* Description~4")).hits, [2]);
});

test("number comparisons read commas, points and units", async () => {
  const { number } = await import("../../viewer/lib/query.js");
  assert.equal(number("10"), 10);
  assert.equal(number("0,5"), 0.5);
  assert.equal(number(".24335"), 0.24335);
  assert.equal(number("12 mm"), 12);
  assert.equal(number("-3e2"), -300);
  for (const v of ["S355", "1/2", "", "abc 10", undefined, null]) assert.ok(Number.isNaN(number(v)), String(v));

  assert.deepEqual((await run("Thickness>9")).hits, [0, 2]);
  assert.deepEqual((await run("Thickness>=10")).hits, [0, 2]);
  assert.deepEqual((await run("Thickness<10")).hits, [1]);
  assert.deepEqual((await run("Thickness<=8")).hits, [1]);
  assert.deepEqual((await run("Thickness=8")).hits, [1]); // "8.0" is the number 8
  assert.deepEqual((await run("Thickness=8|12")).hits, [1, 2]);
  assert.deepEqual((await run("\"Unit weight\">50")).hits, [0]); // "52,5"
  const spaced = await run("Thickness > 9"); // spaced out: three plain words, as before
  assert.equal(spaced.conds.length, 0);
  assert.deepEqual(spaced.words, ["Thickness", ">", "9"]);
});

test("a comparison with a value that is not a number is reported, not searched", async () => {
  const q = await run("Thickness>grosso");
  assert.match(q.error, /não é um número/);
  assert.equal((await run("Thickness>10")).error, "");
});

test("quoted words keep their spaces; an empty pair of quotes is a word", async () => {
  const { words } = await import("../../viewer/lib/query.js");
  assert.deepEqual(words('  bomba  "de agua"  Description="TUBE 8 POL" '), ["bomba", "de agua", "Description=TUBE 8 POL"]);
  assert.deepEqual(words('Material=""'), ["Material="]);
  assert.deepEqual(words(""), []);
});

test("a search over 60 000 nodes with conditions stays fast", async () => {
  const { parseQuery, passes } = await import("../../viewer/lib/query.js");
  const mats = ["S355JR", "S275", "AISI 316", "A36", "S235"];
  const nodes = Array.from({ length: 60000 }, (_, i) => ({ Material: mats[i % 5], Thickness: String(4 + (i % 30)) }));
  const count = (query) => {
    const q = parseQuery(query, KEYS);
    let n = 0;
    for (const props of nodes) if (q.conds.every((c) => passes(c, (ki) => props[KEYS[ki]]))) n++;
    return n;
  };
  const t0 = performance.now();
  // S355JR, S275 and S235 with 20 mm or more: 8 of every 30 nodes
  assert.equal(count("Material=S355*|S2* Thickness>=20"), 16000);
  assert.equal(count("Material=S355*|S2* Thickness>=20 Description!=x"), 0); // no node has Description: "!=" needs it
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
});
