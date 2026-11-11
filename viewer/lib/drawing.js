// 2D drawings: a plan, an elevation or the current view, as lines, with dimensions, on a sheet,
// written as SVG, PDF or DXF.
//
// What is drawn: the CAD edges of the visible parts and the outlines of their curved surfaces
// (silhouettes), only where they are seen — each one is sampled along its length against a depth
// image of the same view (hidden-line removal), and the cuts count as on screen. Where a cutting
// plane faces the view, the outline of the cut parts on it is added as thick lines (the section).
// Dimensions: the overall size, the "Medir" distances, and optionally the equipment codes.
//
// Units: the drawing is built in metres on the view plane (x right, y up), laid out on the sheet in
// millimetres (y up), and the DXF is written in model millimetres (1:1).

const VIEWS = {
  top: { name: "Planta (vista de cima)", fwd: [0, 0, -1], up: [0, 1, 0] },
  front: { name: "Frente", fwd: [-1, 0, 0], up: [0, 0, 1] },
  side: { name: "Lateral", fwd: [0, 1, 0], up: [0, 0, 1] },
};
export const SHEETS = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };
const NICE = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
const DEPTH_PX = 2600; // the depth image's longer side

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
export const mmText = (m) => Math.round(m * 1000).toLocaleString("pt-BR");

// The view's axes: fwd (looking direction), right, up.
export function viewBasis(app, kind) {
  if (VIEWS[kind]) {
    const v = VIEWS[kind];
    return { name: v.name, fwd: v.fwd, up: v.up, right: cross(v.fwd, v.up) };
  }
  const c = app.getCamera(), fwd = unit(sub(c.target, c.pos));
  let right = cross(fwd, [0, 0, 1]);
  if (Math.hypot(...right) < 1e-6) right = [1, 0, 0];
  right = unit(right);
  return { name: "Vista atual", fwd, right, up: cross(right, fwd) };
}

// ------------------------------------------------------------------ the drawing (metres, view plane)
export async function buildDrawing(app, opts, progress = () => {}) {
  const B = viewBasis(app, opts.view);
  const box = app.xr.bounds();
  const corners = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push([x, y, z]);
  const C = [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2];
  let hw = 0, hh = 0, hd = 0;
  for (const p of corners) { const d = sub(p, C); hw = Math.max(hw, Math.abs(dot(d, B.right))); hh = Math.max(hh, Math.abs(dot(d, B.up))); hd = Math.max(hd, Math.abs(dot(d, B.fwd))); }
  hw *= 1.02; hh *= 1.02;
  const dist = hd * 1.1 + 1;
  const k = DEPTH_PX / Math.max(hw, hh);
  const W = Math.max(16, Math.round(2 * hw * k)), H = Math.max(16, Math.round(2 * hh * k));
  const depth = app.depthImage({ right: B.right, up: B.up, fwd: B.fwd, center: C, halfW: hw, halfH: hh, dist }, W, H);
  const px = (2 * hw) / W; // metres per depth pixel
  const tol = px * 2 + 0.002;
  const eye = C.map((v, i) => v - B.fwd[i] * dist);
  // view plane coordinates (x, y), depth from the camera, and pixel of a model point
  const proj = (p) => { const d = sub(p, C); return [dot(d, B.right), dot(d, B.up), dot(sub(p, eye), B.fwd)]; };
  const seenAt = (x, y, z) => {
    const i = Math.floor((x + hw) / px), j = Math.floor((hh - y) / px);
    let far = -Infinity;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= W || b >= H) { far = Infinity; continue; }
      const v = depth[b * W + a];
      if (v > far) far = v;
    }
    return z <= far + tol;
  };
  const segs = [];   // [x1, y1, x2, y2, layer]
  // keeps the seen stretches of a 3D segment
  function addSeen(a, b, layer) {
    const A = proj(a), Bp = proj(b), L = Math.hypot(Bp[0] - A[0], Bp[1] - A[1]);
    const n = Math.max(1, Math.ceil(L / (px * 0.9)));
    let start = -1, last = -1;
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = A[0] + (Bp[0] - A[0]) * t, y = A[1] + (Bp[1] - A[1]) * t, z = A[2] + (Bp[2] - A[2]) * t;
      const w = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      const ok = !app.isClipped(w[0], w[1], w[2]) && seenAt(x, y, z);
      if (ok) { if (start < 0) start = i; last = i; }
      if ((!ok || i === n) && start >= 0) {
        if (last > start || n === 0) {
          const t0 = start / n, t1 = last / n;
          segs.push([A[0] + (Bp[0] - A[0]) * t0, A[1] + (Bp[1] - A[1]) * t0, A[0] + (Bp[0] - A[0]) * t1, A[1] + (Bp[1] - A[1]) * t1, layer]);
        }
        start = -1;
      }
    }
  }
  // the parts: visible, loaded, not entirely cut away
  const parts = [];
  const PB = app.partBoxes();
  for (let p = 0; p < app.nParts; p++) {
    if (!app.partVisible[p] || !app.isLoaded(p)) continue;
    const o = p * 6;
    if (PB[o] > box.max.x || PB[o + 3] < box.min.x || PB[o + 1] > box.max.y || PB[o + 4] < box.min.y || PB[o + 2] > box.max.z || PB[o + 5] < box.min.z) continue;
    parts.push(p);
  }
  // section planes facing the view
  const planes = app.cutPlanes().filter((pl) => Math.abs(dot(pl.n, B.fwd)) > 0.999);
  let k2 = 0;
  const drew = new Set(); // parts with something in the drawing
  for (const p of parts) {
    if (++k2 % 20 === 0) { progress(k2, parts.length); await new Promise((r) => setTimeout(r)); }
    const g = await app.partGeometry(p);
    if (!g || !g.idx.length) continue;
    const before = segs.length;
    const P = g.pos, I = g.idx, at = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    // CAD edges
    const E = g.edges || [];
    for (let i = 0; i < E.length; i += 2) addSeen(at(E[i]), at(E[i + 1]), "ARESTAS");
    // silhouettes (the triangles on the two sides of an edge face opposite ways) and open borders;
    // without CAD edges, also the sharp edges (more than 30°)
    const facing = new Float32Array(I.length / 3), normals = E.length ? null : new Float32Array(I.length);
    for (let t = 0; t < I.length; t += 3) {
      const n = cross(sub(at(I[t + 1]), at(I[t])), sub(at(I[t + 2]), at(I[t])));
      facing[t / 3] = dot(n, B.fwd);
      if (normals) { const u = unit(n); normals[t] = u[0]; normals[t + 1] = u[1]; normals[t + 2] = u[2]; }
    }
    const first = new Map();
    for (let t = 0; t < I.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = I[t + e], b = I[t + (e + 1) % 3], key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
        const other = first.get(key);
        if (other === undefined) { first.set(key, t); continue; }
        first.set(key, -1 - other); // seen twice
        const f1 = facing[other / 3], f2 = facing[t / 3];
        let edge = (f1 < 0) !== (f2 < 0);
        if (!edge && normals && dot([normals[other], normals[other + 1], normals[other + 2]], [normals[t], normals[t + 1], normals[t + 2]]) < 0.866) edge = true;
        if (edge) addSeen(at(a), at(b), "ARESTAS");
      }
    }
    for (const [key, t] of first) if (t >= 0) addSeen(at(Math.floor(key / 4294967296)), at(key % 4294967296), "ARESTAS");
    // the section: where the cut planes meet the triangles
    for (const pl of planes) {
      const s = (i) => dot(at(i), pl.n) - pl.d;
      for (let t = 0; t < I.length; t += 3) {
        const v = [I[t], I[t + 1], I[t + 2]], d = v.map(s);
        if ((d[0] > 0 && d[1] > 0 && d[2] > 0) || (d[0] < 0 && d[1] < 0 && d[2] < 0)) continue;
        const q = [];
        for (let e = 0; e < 3; e++) {
          const a = e, b = (e + 1) % 3;
          if ((d[a] <= 0) !== (d[b] <= 0)) { const f = d[a] / (d[a] - d[b]), A = at(v[a]), Bv = at(v[b]); q.push(A.map((x, j) => x + (Bv[j] - x) * f)); }
        }
        if (q.length !== 2) continue;
        const mid = q[0].map((x, j) => (x + q[1][j]) / 2 - pl.n[j] * 1e-6);
        if (app.isClipped(mid[0], mid[1], mid[2])) continue;
        const A = proj(q[0]), Bq = proj(q[1]);
        segs.push([A[0], A[1], Bq[0], Bq[1], "CORTE"]);
      }
    }
    if (segs.length > before) drew.add(p);
  }
  progress(parts.length, parts.length);
  // what goes beside the lines
  const dims = [], texts = [];
  if (opts.measures && app.measurements) {
    for (const m of app.measurements()) {
      if ((m.type !== "dist" && m.type !== "min") || !m.pts || m.pts.length < 2 || !m.pts[0] || !m.pts[1]) continue;
      const a = proj(m.pts[0]), b = proj(m.pts[1]);
      dims.push({ a: [a[0], a[1]], b: [b[0], b[1]], text: mmText(Math.hypot(...sub(m.pts[1], m.pts[0]))) });
    }
  }
  if (opts.codes) {
    const kb = app.keyIndex("Bigrama"), ko = app.keyIndex("part_objectid"), t = app.tree, done = new Set();
    if (kb >= 0) {
      for (const p of drew) {
        let n = app.partNode[p], top = -1;
        for (let x = n; x >= 0; x = t.parent[x]) if (app.prop(x, kb)) top = x;
        if (top < 0 || done.has(top)) continue;
        done.add(top);
        const b = app.nodesBox([top]), c = proj([(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2]);
        let code = ko >= 0 ? app.prop(top, ko) || "" : "";
        if (code.includes("/")) code = code.slice(code.indexOf("/") + 1);
        texts.push({ x: c[0], y: c[1], text: code || t.names[top].split(" - ")[0], layer: "CODIGOS" });
      }
    }
  }
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const s of segs) { minx = Math.min(minx, s[0], s[2]); maxx = Math.max(maxx, s[0], s[2]); miny = Math.min(miny, s[1], s[3]); maxy = Math.max(maxy, s[1], s[3]); }
  if (!segs.length) return null;
  const sectionNote = planes.length ? sectionText(planes[0], B) : "";
  return { segs, dims, texts, bounds: { minx, miny, maxx, maxy }, name: B.name + sectionNote };
}
function sectionText(pl, B) {
  const ax = pl.n.findIndex((v) => Math.abs(v) > 0.999);
  if (ax >= 0) return ` · corte em ${"XYZ"[ax]} = ${(pl.d * Math.sign(pl.n[ax])).toFixed(2).replace(".", ",")} m`;
  return " · em corte";
}

// ------------------------------------------------------------------ the sheet (millimetres, y up)
// Returns {w, h, scale (N of 1:N), lines: [{x1, y1, x2, y2, w, layer}], texts: [{x, y, text, size, angle, anchor, layer}], fits}
export function layout(d, opts) {
  const [W, H] = SHEETS[opts.sheet] || SHEETS.A3;
  const M = 10, TB = 26, PAD = 16; // margin, title block height, room for dimensions
  const areaW = W - 2 * M - 2 * PAD, areaH = H - 2 * M - TB - 2 * PAD;
  const dw = Math.max(1e-6, d.bounds.maxx - d.bounds.minx), dh = Math.max(1e-6, d.bounds.maxy - d.bounds.miny);
  let N = +opts.scale;
  if (!N) N = NICE.find((n) => (dw * 1000) / n <= areaW && (dh * 1000) / n <= areaH) || Math.ceil(Math.max(dw * 1000 / areaW, dh * 1000 / areaH));
  const s = 1000 / N; // mm on paper per metre
  const fits = dw * s <= areaW + 0.5 && dh * s <= areaH + 0.5;
  const ox = M + PAD + (areaW - dw * s) / 2 - d.bounds.minx * s, oy = M + TB + PAD + (areaH - dh * s) / 2 - d.bounds.miny * s;
  const P = (x, y) => [ox + x * s, oy + y * s];
  const lines = [], texts = [];
  const line = (a, b, w, layer) => lines.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], w, layer });
  for (const g of d.segs) { const a = P(g[0], g[1]), b = P(g[2], g[3]); line(a, b, g[4] === "CORTE" ? 0.6 : 0.25, g[4]); }
  // a dimension between a and b (sheet mm), pushed `off` mm to the side `side` (unit vector)
  function dim(a, b, off, text) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1) return;
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const nrm = [-u[1], u[0]];
    const A = [a[0] + nrm[0] * off, a[1] + nrm[1] * off], Bd = [b[0] + nrm[0] * off, b[1] + nrm[1] * off];
    const ext = (p, q) => line([p[0] + nrm[0] * Math.sign(off) * 1, p[1] + nrm[1] * Math.sign(off) * 1], [q[0] + nrm[0] * Math.sign(off) * 1.5, q[1] + nrm[1] * Math.sign(off) * 1.5], 0.13, "COTAS");
    ext(a, A); ext(b, Bd);
    line(A, Bd, 0.18, "COTAS");
    for (const p of [A, Bd]) line([p[0] - (u[0] + nrm[0]) * 1.1, p[1] - (u[1] + nrm[1]) * 1.1], [p[0] + (u[0] + nrm[0]) * 1.1, p[1] + (u[1] + nrm[1]) * 1.1], 0.3, "COTAS");
    let ang = Math.atan2(u[1], u[0]) * 180 / Math.PI;
    let tn = nrm;
    if (ang > 90.01 || ang <= -89.99) { ang += ang > 0 ? -180 : 180; tn = [-nrm[0], -nrm[1]]; }
    const side = Math.sign(off) * (tn[0] * nrm[0] + tn[1] * nrm[1]) >= 0 ? 1 : -1;
    texts.push({ x: (A[0] + Bd[0]) / 2 + tn[0] * 1.2 * side, y: (A[1] + Bd[1]) / 2 + tn[1] * 1.2 * side, text, size: 2.5, angle: ang, anchor: "middle", base: side > 0 ? "bottom" : "top", layer: "COTAS" });
  }
  const b = d.bounds;
  if (opts.overall) {
    dim(P(b.minx, b.miny), P(b.maxx, b.miny), -8, mmText(b.maxx - b.minx));
    dim(P(b.minx, b.maxy), P(b.minx, b.miny), -8, mmText(b.maxy - b.miny));
  }
  for (const m of d.dims) dim(P(...m.a), P(...m.b), 6, m.text);
  // codes, without overlapping
  const taken = [];
  for (const t of d.texts) {
    const [x, y] = P(t.x, t.y), w = t.text.length * 1.25 + 1, h = 3;
    const r = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
    if (taken.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) continue;
    taken.push(r);
    texts.push({ x, y, text: t.text, size: 2.2, angle: 0, anchor: "middle", base: "middle", layer: "CODIGOS" });
  }
  // frame and title block
  const fr = (x1, y1, x2, y2, w) => { line([x1, y1], [x2, y1], w, "FOLHA"); line([x2, y1], [x2, y2], w, "FOLHA"); line([x2, y2], [x1, y2], w, "FOLHA"); line([x1, y2], [x1, y1], w, "FOLHA"); };
  fr(M, M, W - M, H - M, 0.5);
  const tx = W - M - 130, ty = M;
  fr(tx, ty, W - M, ty + TB, 0.35);
  line([tx, ty + 13], [W - M, ty + 13], 0.18, "FOLHA");
  line([tx + 85, ty], [tx + 85, ty + 13], 0.18, "FOLHA");
  const T = (x, y, text, size, anchor = "start") => texts.push({ x, y, text, size, angle: 0, anchor, base: "bottom", layer: "FOLHA" });
  T(tx + 3, ty + 18, opts.title || "", 3.5);
  T(tx + 3, ty + 15.5 - 13 + 6, d.name, 2.5);
  T(tx + 3, ty + 3, "Visualizador PVS · " + new Date().toLocaleDateString("pt-BR"), 2);
  T(tx + 88, ty + 7, `Escala 1:${N}`, 3);
  T(tx + 88, ty + 3, `Folha ${opts.sheet} · medidas em mm`, 2);
  return { w: W, h: H, scale: N, lines, texts, fits };
}

// ------------------------------------------------------------------ writers
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const COLORS = { ARESTAS: "#1d2330", CORTE: "#000000", COTAS: "#1c4ed6", CODIGOS: "#c2410c", FOLHA: "#1d2330" };
export function toSVG(L) {
  const r = (v) => +v.toFixed(3);
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" width="${L.w}mm" height="${L.h}mm" viewBox="0 0 ${L.w} ${L.h}">`, `<rect width="${L.w}" height="${L.h}" fill="#fff"/>`];
  const byLayer = new Map();
  for (const l of L.lines) { const k = l.layer + "|" + l.w; if (!byLayer.has(k)) byLayer.set(k, []); byLayer.get(k).push(`M${r(l.x1)} ${r(L.h - l.y1)}L${r(l.x2)} ${r(L.h - l.y2)}`); }
  for (const [k, d] of byLayer) { const [layer, w] = k.split("|"); out.push(`<path id="${layer.toLowerCase()}-${w}" d="${d.join("")}" stroke="${COLORS[layer] || "#000"}" stroke-width="${w}" stroke-linecap="round" fill="none"/>`); }
  for (const t of L.texts) {
    const base = t.base === "top" ? "hanging" : t.base === "middle" ? "central" : "alphabetic";
    out.push(`<text x="${r(t.x)}" y="${r(L.h - t.y)}" font-family="Arial, Helvetica, sans-serif" font-size="${t.size}" fill="${COLORS[t.layer] || "#000"}" text-anchor="${t.anchor}" dominant-baseline="${base}"${t.angle ? ` transform="rotate(${r(-t.angle)} ${r(t.x)} ${r(L.h - t.y)})"` : ""}>${esc(t.text)}</text>`);
  }
  out.push("</svg>");
  return out.join("\n");
}

// PDF 1.4 written by hand: one page, vector lines, Helvetica (WinAnsi) text.
export function toPDF(L) {
  const k = 72 / 25.4, f = (v) => (+v.toFixed(3)).toString();
  const rgb = (hex) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(" ");
  let c = "1 J 1 j\n";
  const groups = new Map();
  for (const l of L.lines) { const key = l.layer + "|" + l.w; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(l); }
  for (const [key, ls] of groups) {
    const [layer, w] = key.split("|");
    c += `${rgb(COLORS[layer] || "#000000")} RG ${f(w * k)} w\n`;
    for (const l of ls) c += `${f(l.x1 * k)} ${f(l.y1 * k)} m ${f(l.x2 * k)} ${f(l.y2 * k)} l\n`;
    c += "S\n";
  }
  const latin = (t) => [...String(t)].map((ch) => { const n = ch.charCodeAt(0); return n < 256 ? ch : "?"; }).join("").replace(/[\\()]/g, (m) => "\\" + m);
  for (const t of L.texts) {
    const size = t.size * k, w = String(t.text).length * size * 0.52; // Helvetica, roughly
    const a = (t.angle || 0) * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a);
    let dx = t.anchor === "middle" ? -w / 2 : t.anchor === "end" ? -w : 0;
    let dy = t.base === "top" ? -size * 0.75 : t.base === "middle" ? -size * 0.35 : 0;
    const x = t.x * k + dx * cs - dy * sn, y = t.y * k + dx * sn + dy * cs;
    c += `BT ${rgb(COLORS[t.layer] || "#000000")} rg /F1 ${f(size)} Tf ${f(cs)} ${f(sn)} ${f(-sn)} ${f(cs)} ${f(x)} ${f(y)} Tm (${latin(t.text)}) Tj ET\n`;
  }
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(L.w * k)} ${f(L.h * k)}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${c.length} >>\nstream\n${c}endstream`,
  ];
  let pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("");
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, (ch) => ch.charCodeAt(0) & 255); // every char is one byte (Latin-1)
}

// DXF R12 (AC1009), model millimetres 1:1: the sheet is scaled back by the drawing scale.
export function toDXF(L) {
  const N = L.scale, f = (v) => (+(v * N).toFixed(3)).toString();
  const layers = { ARESTAS: 7, CORTE: 7, COTAS: 5, CODIGOS: 30, FOLHA: 8 };
  const o = [];
  const g = (code, value) => o.push(String(code), String(value));
  g(0, "SECTION"); g(2, "HEADER"); g(9, "$ACADVER"); g(1, "AC1009"); g(9, "$DWGCODEPAGE"); g(3, "ANSI_1252"); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LTYPE"); g(70, 1);
  g(0, "LTYPE"); g(2, "CONTINUOUS"); g(70, 0); g(3, "Solid line"); g(72, 65); g(73, 0); g(40, "0.0");
  g(0, "ENDTAB");
  g(0, "TABLE"); g(2, "LAYER"); g(70, Object.keys(layers).length);
  for (const [name, color] of Object.entries(layers)) { g(0, "LAYER"); g(2, name); g(70, 0); g(62, color); g(6, "CONTINUOUS"); }
  g(0, "ENDTAB");
  g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  for (const l of L.lines) { g(0, "LINE"); g(8, l.layer); g(10, f(l.x1)); g(20, f(l.y1)); g(30, "0.0"); g(11, f(l.x2)); g(21, f(l.y2)); g(31, "0.0"); }
  for (const t of L.texts) {
    const h = t.anchor === "middle" ? 1 : t.anchor === "end" ? 2 : 0, v = t.base === "top" ? 3 : t.base === "middle" ? 2 : 0;
    g(0, "TEXT"); g(8, t.layer); g(10, f(t.x)); g(20, f(t.y)); g(30, "0.0"); g(40, f(t.size)); g(1, String(t.text).replace(/[\r\n]/g, " "));
    if (t.angle) g(50, (+t.angle.toFixed(3)).toString());
    if (h || v) { g(72, h); g(11, f(t.x)); g(21, f(t.y)); g(31, "0.0"); g(73, v); }
  }
  g(0, "ENDSEC"); g(0, "EOF");
  const text = o.join("\r\n") + "\r\n";
  return Uint8Array.from(text, (ch) => { const n = ch.charCodeAt(0); return n < 256 ? n : 63; }); // Windows-1252 (Latin-1 part)
}
