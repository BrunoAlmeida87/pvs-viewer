// Conditions on properties typed in the search box, next to ordinary words:
//
//   Material=S355*        the value is S355 followed by anything (* any text, ? one character)
//   Thickness>10          number comparisons: >  <  >=  <=  (a comma or a point as decimal mark)
//   Thickness=8|10|12     alternatives: any of them
//   Description~TUBE      contains
//   Material!=S355        has the property, with another value
//   "Unit weight">=50     quotes keep spaces together (in the property name or in the value)
//
// A word is a condition only when what comes before the operator is the name of a property of the
// model (capitals, accents, spaces and separators do not count: "unitweight", "Unit_weight" and
// "UNIT WEIGHT" all name "Unit weight"). Anything else stays an ordinary word, searched as before.
// Conditions and words must all be true (E). Pure functions: tested in desktop/test/query.test.js.

// Lower case, no accents, no separators (the same rule as the text search).
export const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s\-_.]+|\//g, "");
// Lower case and no accents only (values compared whole: "S355JR" is not "S 355 JR").
const fold = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

// Number in a value: "12", "0,5", ".24335", "-3e2", also with a unit after it ("10 mm", "6,35mm").
// NaN when the value is not a number ("S355", "1/2", "").
export function number(v) {
  if (v == null) return NaN;
  const m = /^\s*([-+]?(?:\d+[.,]?\d*|[.,]\d+)(?:[eE][-+]?\d+)?)\s*[a-zA-Zµ%°²³]*\s*$/.exec(String(v));
  return m ? parseFloat(m[1].replace(",", ".")) : NaN;
}

// The words of a query, with "quoted parts" kept together (the quotes are removed).
export function words(query) {
  const out = [];
  let cur = "", quoted = false, any = false;
  for (const ch of String(query)) {
    if (ch === '"') { quoted = !quoted; any = true; continue; }
    if (!quoted && /\s/.test(ch)) { if (cur || any) out.push(cur); cur = ""; any = false; continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

const OP = /^(.+?)\s*(>=|<=|!=|=|>|<|~)\s*(.*)$/s;

// Split a query into conditions and ordinary words.
//   keys: the property names of the model (tree.props.keys).
// Returns { conds: [{ key, keys: [indexes], op, values: [...] , text }], words: [...], error }.
// error: a message for the first condition that cannot work (a comparison with a value that is not a
// number); the search shows it instead of results.
export function parseQuery(query, keys) {
  const byName = new Map();
  keys.forEach((k, i) => {
    const n = norm(k);
    if (!n) return;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(i);
  });
  const conds = [], plain = [];
  let error = "";
  for (const w of words(query)) {
    const m = OP.exec(w);
    const ix = m ? byName.get(norm(m[1])) : null;
    if (!ix) { if (w) plain.push(w); continue; }
    const op = m[2], values = m[3].split("|").map((v) => v.trim());
    const cond = { key: keys[ix[0]], keys: ix, op, values, text: w };
    if (op === ">" || op === "<" || op === ">=" || op === "<=") {
      cond.limit = number(m[3]);
      if (!Number.isFinite(cond.limit) && !error) error = `“${w}”: ${op} compara números, e “${m[3]}” não é um número.`;
    } else {
      cond.match = values.map(valueTest(op === "~"));
    }
    conds.push(cond);
  }
  return { conds, words: plain, error };
}

// A test for one alternative of = / != (whole value, with wildcards) or ~ (contains).
function valueTest(contains) {
  return (v) => {
    if (contains) { const want = norm(v); return (s) => norm(s).includes(want); }
    if (/[*?]/.test(v)) {
      const rx = new RegExp("^" + fold(v).replace(/[.+^${}()[\]\\|]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "s");
      return (s) => rx.test(fold(s));
    }
    const want = fold(v), wantN = number(v);
    return (s) => {
      if (Number.isFinite(wantN)) { const n = number(s); if (Number.isFinite(n)) return n === wantN; }
      return fold(s) === want;
    };
  };
}

// Does a node pass a condition? get(keyIndex) gives the node's value for that property, or undefined.
export function passes(cond, get) {
  let has = false;
  for (const ki of cond.keys) {
    const v = get(ki);
    if (v === undefined) continue;
    has = true;
    if (check(cond, v)) return cond.op !== "!=";
  }
  // "!=": the node has the property and none of its values is one of those given
  return cond.op === "!=" && has;
}

// The answer for each distinct value is remembered: a model has tens of thousands of parts but few
// distinct materials or thicknesses.
function check(cond, v) {
  const memo = cond.memo || (cond.memo = new Map());
  let r = memo.get(v);
  if (r === undefined) { r = compare(cond, v); memo.set(v, r); }
  return r;
}
function compare(cond, v) {
  switch (cond.op) {
    case ">": case "<": case ">=": case "<=": {
      const n = number(v);
      if (!Number.isFinite(n) || !Number.isFinite(cond.limit)) return false;
      return cond.op === ">" ? n > cond.limit : cond.op === "<" ? n < cond.limit : cond.op === ">=" ? n >= cond.limit : n <= cond.limit;
    }
    default: return cond.match.some((t) => t(v));
  }
}

// How a condition reads in the results line: Thickness > 10, Material = S355* ou S275*.
export function describe(cond) {
  const op = { "~": "contém", "!=": "≠", ">=": "≥", "<=": "≤" }[cond.op] || cond.op;
  return `${cond.key} ${op} ${cond.values.map((v) => v || "(vazio)").join(" ou ")}`;
}
