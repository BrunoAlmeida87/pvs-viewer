// What an NFC tag holds: a link to the viewer that opens a model at one part, seen from the camera
// of when the tag was written, with the same sections loaded:
//   …/viewer/?p=LPR-DT20003&m=SBR&c=x_y_z_tx_ty_tz[_half_zoom]&r=P.3-5.k
// c: camera position and target in metres; with the two extra numbers, an orthographic view.
// r: what was loaded — A everything, N nothing but the part, P the general preview, and the
// sections fully loaded: their numbers (base 36, a-b for a run) in the list of level-1 assemblies
// each followed by its level-2 ones (the order of the "Escolha o que carregar" dialog).
// A link works both ways: with the viewer closed, Android opens it (the iPhone too, read only);
// with the viewer open and reading tags, the page takes it and goes to the part without reloading.
// The link is kept short so it fits the smallest stickers (NTAG213: 137 bytes for the message).

export const NTAG213 = 137, NTAG215 = 496, NTAG216 = 868;

// "SBR.pvs" → "SBR": how a model is named on a tag
export const modelKey = (name) => String(name || "").replace(/\.pvs$/i, "").trim();
export const sameModel = (a, b) => modelKey(a).toLowerCase() === modelKey(b).toLowerCase();

// Shortest text of a number with `d` decimals ("12.30" → "12.3", "-0.00" → "0").
function num(v, d) {
  const s = (+v).toFixed(d).replace(/\.?0+$/, "");
  return s === "-0" || s === "" ? "0" : s;
}
// encodeURIComponent, but keeping what a query may hold as is (shorter tags)
const enc = (s) => encodeURIComponent(s).replace(/%2C/gi, ",").replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%20/g, "+");

export function encodeCam(c) {
  if (!c || !c.pos || !c.target) return "";
  // close views need finer numbers than the camera of a whole plant
  const d = Math.hypot(c.pos[0] - c.target[0], c.pos[1] - c.target[1], c.pos[2] - c.target[2]);
  const k = d < 3 ? 3 : d < 30 ? 2 : 1;
  const v = [...c.pos, ...c.target].map((x) => num(x, k));
  if (c.ortho) v.push(num(c.half || 1, 3), num(c.zoom || 1, 3));
  return v.join("_");
}
export function decodeCam(s) {
  if (!s) return null;
  const v = String(s).split(/[_,]/).map(Number);
  if ((v.length !== 6 && v.length !== 8) || !v.every(Number.isFinite)) return null;
  const c = { ortho: v.length === 8, pos: v.slice(0, 3), target: v.slice(3, 6) };
  if (c.ortho) { c.half = v[6]; c.zoom = v[7]; }
  return c;
}

// regions: {all, preview, ids: [numbers]} → "A" | "N" | "P.3-5.k" | "3-5.k"
export function encodeRegions(r) {
  if (!r) return "";
  if (r.all) return "A";
  const ids = [...new Set(r.ids || [])].filter((i) => Number.isInteger(i) && i >= 0).sort((a, b) => a - b);
  const out = r.preview ? ["P"] : [];
  for (let i = 0; i < ids.length;) {
    let j = i;
    while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j++;
    out.push(j > i ? ids[i].toString(36) + "-" + ids[j].toString(36) : ids[i].toString(36));
    i = j + 1;
  }
  return out.length ? out.join(".") : "N";
}
export function decodeRegions(s) {
  if (!s) return null;
  if (s === "A") return { all: true, preview: false, ids: [] };
  const r = { all: false, preview: false, ids: [] };
  for (const t of String(s).split(".")) {
    if (t === "P") { r.preview = true; continue; }
    if (t === "N" || !t) continue;
    const [a, b] = t.split("-").map((x) => parseInt(x, 36));
    if (!Number.isInteger(a) || a < 0) return null;
    const end = b === undefined ? a : b;
    if (!Number.isInteger(end) || end < a || end - a > 100000) return null;
    for (let i = a; i <= end; i++) r.ids.push(i);
  }
  return r;
}

// The link written on a tag. base: the address of the viewer (its query and hash are dropped).
export function tagURL(base, { code, model, cam, regions }) {
  const u = new URL(base);
  let q = "p=" + enc(code);
  if (model) q += "&m=" + enc(modelKey(model));
  const c = encodeCam(cam);
  if (c) q += "&c=" + c;
  const r = encodeRegions(regions);
  if (r) q += "&r=" + r;
  return u.origin + u.pathname + "?" + q;
}

// What a link read from a tag (or the address the viewer was opened with) asks for; null when it
// is not a link to a part.
export function parseTag(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  const p = u.searchParams;
  let code = p.get("p") || p.get("peca") || ""; // "peca": the part links of "Copiar link desta peça"
  if (!code) { const m = /[#&]peca=([^&]+)/.exec(u.hash); if (m) code = decodeURIComponent(m[1]); }
  if (!code) return null;
  return { code, model: p.get("m") || "", cam: decodeCam(p.get("c")), regions: decodeRegions(p.get("r")) };
}

// Bytes of the NDEF message holding this link as one URI record (with the usual "https://"
// abbreviation): what must fit on the tag.
const PREFIXES = ["http://www.", "https://www.", "http://", "https://"];
export function ndefBytes(url) {
  let rest = url;
  for (const p of PREFIXES) if (url.startsWith(p)) { rest = url.slice(p.length); break; }
  const payload = 1 + new TextEncoder().encode(rest).length;
  return (payload < 256 ? 4 : 7) + payload; // header, type length, payload length, type "U"
}
// The smallest common sticker that holds it.
export function tagFits(url) {
  const n = ndefBytes(url);
  return { bytes: n, chip: n <= NTAG213 ? "NTAG213" : n <= NTAG215 ? "NTAG215" : n <= NTAG216 ? "NTAG216" : "" };
}
