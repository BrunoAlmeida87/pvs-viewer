// Measuring: point-to-point distance, angle, coordinates, radius/diameter of circular edges,
// clearance between two parts, dimensions and weight of the selection. Results are drawn in the
// SVG overlay over the 3D view and listed in the "Medir" panel.
import { $, el, fmt, num } from "./util.js";
import { geomClient } from "../lib/geomclient.js";
import { edgeChains, fitCircle, closestOnSegment, volume } from "../lib/geom.js";

const SVGNS = "http://www.w3.org/2000/svg";
const HINTS = {
  dist: "Clique em dois pontos do modelo.",
  angle: "Clique em três pontos: o segundo é o vértice do ângulo.",
  coord: "Clique num ponto para ver as coordenadas.",
  radius: "Clique numa aresta circular (furo, tubo, flange).",
  min: "Clique em duas peças, ou use “Folga entre as 2 selecionadas”.",
};

// Lengths: the model is in metres; shown in millimetres.
export const mm = (m) => (m * 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + " mm";
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v) => Math.hypot(v[0], v[1], v[2]);

export function initMeasure(app) {
  app.geom = app.geom || geomClient(app);
  const panel = $("#measurePanel"), list = $("#mList");
  const svg = $("#overlay");
  const layer = document.createElementNS(SVGNS, "g");
  svg.append(layer);
  let mode = "dist", pts = [], items = [];

  const active = () => !panel.hidden;
  const setTool = () => { app.tool = active() ? onPick : app.tool === onPick ? null : app.tool; };
  $("#measureBtn").onclick = () => {
    panel.hidden = !panel.hidden;
    $("#measureBtn").classList.toggle("on", !panel.hidden);
    if (!panel.hidden) { for (const id of ["#analysisPanel"]) { const p = $(id); if (p && !p.hidden) p.querySelector("[data-close]")?.click(); } }
    pts = [];
    setTool();
    draw();
  };
  panel.querySelector("[data-close]").addEventListener("click", () => { $("#measureBtn").classList.remove("on"); pts = []; setTimeout(setTool); draw(); });
  document.querySelectorAll("#mModes button").forEach((b) => {
    b.onclick = () => {
      mode = b.dataset.m;
      document.querySelectorAll("#mModes button").forEach((x) => x.classList.toggle("on", x === b));
      $("#mHint").textContent = HINTS[mode];
      pts = [];
      draw();
    };
  });
  $("#mHint").textContent = HINTS[mode];
  $("#mClear").onclick = () => { items = []; pts = []; render(); };

  // ------------------------------------------------------------ picking with snapping
  async function snapped(info) {
    if (!info.point) return null;
    const out = { p: info.point, part: info.part, node: info.node, how: "superfície" };
    if (!$("#mSnap").checked || info.part < 0 || !app.canReadGeometry()) return out;
    const g = await app.partGeometry(info.part);
    if (!g) return out;
    const wpp = app.worldPerPixel(info.point);
    let best = (10 * wpp) ** 2, bi = -1;
    const P = g.pos, p = info.point;
    for (let i = 0; i < P.length; i += 3) {
      const d = (P[i] - p[0]) ** 2 + (P[i + 1] - p[1]) ** 2 + (P[i + 2] - p[2]) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    if (bi >= 0) return { ...out, p: [P[bi], P[bi + 1], P[bi + 2]], how: "vértice" };
    let bd = (7 * wpp) ** 2, bq = null;
    const E = g.edges;
    for (let k = 0; k < E.length; k += 2) {
      const a = E[k] * 3, b = E[k + 1] * 3;
      const r = closestOnSegment(p, [P[a], P[a + 1], P[a + 2]], [P[b], P[b + 1], P[b + 2]]);
      if (r.d2 < bd) { bd = r.d2; bq = r.q; }
    }
    if (bq) return { ...out, p: bq, how: "aresta" };
    return out;
  }

  async function onPick(info) {
    if (info.node < 0) { $("#mHint").textContent = "Nenhuma peça nesse ponto. " + HINTS[mode]; return; }
    if (mode === "radius") return radiusAt(info);
    if (mode === "min") {
      pts.push({ p: info.point, part: info.part, node: info.node });
      draw();
      if (pts.length === 2) { const [a, b] = pts; pts = []; await clearance([a.node], [b.node]); }
      else $("#mHint").textContent = "Agora clique na segunda peça.";
      return;
    }
    const s = await snapped(info);
    if (!s) return;
    pts.push(s);
    const need = { dist: 2, angle: 3, coord: 1 }[mode];
    if (pts.length < need) { draw(); $("#mHint").textContent = `Ponto ${pts.length} (${s.how}). ` + HINTS[mode]; return; }
    const P = pts.map((x) => x.p);
    if (mode === "dist") {
      const d = sub(P[1], P[0]);
      items.push({ type: "dist", pts: P, text: `Distância ${mm(len(d))}`, detail: `ΔX ${mm(Math.abs(d[0]))} · ΔY ${mm(Math.abs(d[1]))} · ΔZ ${mm(Math.abs(d[2]))}` });
    } else if (mode === "angle") {
      const u = sub(P[0], P[1]), v = sub(P[2], P[1]);
      const ang = Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (len(u) * len(v) || 1)))) * 180 / Math.PI;
      items.push({ type: "angle", pts: P, text: `Ângulo ${ang.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}°` });
    } else {
      const q = P[0];
      items.push({ type: "coord", pts: P, text: `X ${mm(q[0])} · Y ${mm(q[1])} · Z ${mm(q[2])}`, detail: app.tree.names[s.node] });
    }
    pts = [];
    $("#mHint").textContent = HINTS[mode];
    render();
  }

  // ------------------------------------------------------------ radius / diameter
  async function radiusAt(info) {
    if (!app.canReadGeometry()) { $("#mHint").textContent = "Para medir raios é preciso abrir a pasta original do modelo ou uma pasta convertida no formato novo."; return; }
    const g = await app.partGeometry(info.part);
    if (!g || !g.edges.length) { $("#mHint").textContent = "Essa peça não tem arestas para medir."; return; }
    const P = g.pos, p = info.point;
    const V = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    let best = Infinity, chain = null;
    for (const c of edgeChains(g.edges)) {
      for (let k = 0; k + 1 < c.length; k++) {
        const r = closestOnSegment(p, V(c[k]), V(c[k + 1]));
        if (r.d2 < best) { best = r.d2; chain = c; }
      }
    }
    const wpp = app.worldPerPixel(p);
    if (!chain || best > (15 * wpp) ** 2) { $("#mHint").textContent = "Clique mais perto de uma aresta circular."; return; }
    const ptsC = chain.map(V);
    if (ptsC.length > 2 && chain[0] === chain[chain.length - 1]) ptsC.pop();
    const fit = ptsC.length >= 4 ? fitCircle(ptsC) : null;
    if (!fit || fit.rms > fit.radius * 0.01) { $("#mHint").textContent = "Essa aresta não é circular."; return; }
    const circle = [];
    for (let i = 0; i <= 48; i++) {
      const t = (i / 48) * 2 * Math.PI, c = Math.cos(t) * fit.radius, s = Math.sin(t) * fit.radius;
      circle.push([0, 1, 2].map((a) => fit.center[a] + fit.u[a] * c + fit.w[a] * s));
    }
    const closed = chain[0] === chain[chain.length - 1];
    items.push({ type: "radius", pts: [fit.center], circle,
      text: `Raio ${mm(fit.radius)} · Ø ${mm(fit.radius * 2)}`,
      detail: `Centro X ${mm(fit.center[0])} · Y ${mm(fit.center[1])} · Z ${mm(fit.center[2])}${closed ? "" : " · arco"}` });
    $("#mHint").textContent = HINTS[mode];
    render();
  }

  // ------------------------------------------------------------ clearance between parts
  async function clearance(nodesA, nodesB) {
    if (!app.canReadGeometry()) { $("#mHint").textContent = "Para medir folga é preciso abrir a pasta original do modelo ou uma pasta convertida no formato novo."; return; }
    $("#mHint").textContent = "Calculando a folga…";
    const keyOf = async (nodes) => {
      const parts = [];
      app.forParts(nodes, (p) => parts.push(p));
      return parts.length === 1 ? app.geom.part(parts[0]) : app.geom.merged("n" + nodes.join(","), parts);
    };
    const [ka, kb] = [await keyOf(nodesA), await keyOf(nodesB)];
    if (!ka || !kb) { $("#mHint").textContent = "Não foi possível ler a geometria dessas peças."; return; }
    const r = await app.geom.pair(ka, kb);
    const na = app.tree.names[nodesA[0]], nb = app.tree.names[nodesB[0]];
    if (r.error) { $("#mHint").textContent = "Erro: " + r.error; return; }
    if (r.crossings) items.push({ type: "min", pts: [], text: "Interferência: as peças se cruzam", detail: `${na} × ${nb}`, warn: true });
    else items.push({ type: "min", pts: [r.pa, r.pb], text: `Folga ${mm(r.d)}`, detail: `${na} × ${nb}` });
    $("#mHint").textContent = HINTS[mode];
    render();
  }
  $("#mPair").onclick = () => {
    const s = [...app.selNodes];
    if (s.length !== 2) { $("#mHint").textContent = "Selecione exatamente 2 itens (Ctrl+clique)."; return; }
    clearance([s[0]], [s[1]]);
  };

  // ------------------------------------------------------------ selection dimensions / weight
  $("#mBox").onclick = () => {
    if (!app.selNodes.size) { $("#mHint").textContent = "Selecione algo primeiro."; return; }
    const b = app.nodesBox([...app.selNodes]);
    if (b.isEmpty()) return;
    const s = b.getSize(b.min.clone());
    items.push({ type: "box", box: [b.min.toArray(), b.max.toArray()], text: `Dimensões ${mm(s.x)} × ${mm(s.y)} × ${mm(s.z)}`,
      detail: `Mín ${b.min.toArray().map(mm).join(" · ")} — Máx ${b.max.toArray().map(mm).join(" · ")}` });
    render();
  };
  $("#mWeight").onclick = async () => {
    const parts = app.selectedParts();
    if (!parts.length) { $("#mHint").textContent = "Selecione algo primeiro."; return; }
    const ki = app.keyIndex("Unit weight");
    const dens = num($("#mDensity").value) || 7850;
    let kg = 0, withW = 0, est = 0, nEst = 0, vol = 0, fail = 0;
    const missing = [];
    for (const p of parts) {
      const w = ki >= 0 ? num(app.prop(app.partNode[p], ki)) : NaN;
      if (!isNaN(w)) { kg += w; withW++; } else missing.push(p);
    }
    if (missing.length && app.canReadGeometry()) {
      const cap = Math.min(missing.length, 3000);
      for (let i = 0; i < cap; i++) {
        if (i % 50 === 0) $("#mHint").textContent = `Calculando volume ${i}/${cap}…`;
        const g = await app.partGeometry(missing[i]);
        if (!g) { fail++; continue; }
        const v = Math.abs(volume(g));
        vol += v; est += v * dens; nEst++;
      }
      fail += missing.length - cap;
    } else fail += missing.length;
    const t = (x) => x >= 1000 ? (x / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + " t" : x.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " kg";
    items.push({ type: "weight", pts: [], text: `Peso ${t(kg + est)} (${fmt(parts.length)} peças)`,
      detail: `${fmt(withW)} com Unit weight: ${t(kg)}` + (nEst ? ` · ${fmt(nEst)} pelo volume (${(vol * 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} L × ${fmt(dens)} kg/m³): ${t(est)}` : "") + (fail ? ` · ${fmt(fail)} sem dados` : "") });
    $("#mHint").textContent = HINTS[mode];
    render();
  };

  // ------------------------------------------------------------ list and overlay
  function render() {
    list.innerHTML = "";
    items.forEach((it, i) => {
      list.append(el("div.mItem" + (it.warn ? ".warn" : ""), null,
        el("div", null, el("b", { text: it.text }), it.detail ? el("div.muted", { text: it.detail }) : null),
        el("button", { text: "✕", title: "Apagar", onclick: () => { items.splice(i, 1); render(); } })));
    });
    draw();
  }
  app.measurements = () => items;
  app.setMeasurements = (v) => { items = Array.isArray(v) ? v : []; render(); };

  // inline styles (not CSS classes) so that the PNG export, which serialises this SVG, keeps them
  const STYLE = {
    mline: { stroke: "#e8590c", "stroke-width": 2, fill: "none" },
    mbox: { stroke: "#1c7ed6", "stroke-width": 1.5, "stroke-dasharray": "5 4", fill: "none" },
    mdot: { fill: "#e8590c", stroke: "#fff", "stroke-width": 1.5 },
    "mdot pending": { fill: "#1c7ed6", stroke: "#fff", "stroke-width": 1.5 },
  };
  const mk = (tag, attrs) => {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) {
      if (k === "class") { for (const [s, v] of Object.entries(STYLE[attrs[k]] || {})) e.setAttribute(s, v); }
      else e.setAttribute(k, attrs[k]);
    }
    return e;
  };
  const label = (x, y, text) => {
    const g = mk("g", {});
    const t = mk("text", { x: x + 8, y: y - 9, fill: "#fff", "font-size": 12, "font-family": "Segoe UI, sans-serif" });
    t.textContent = text;
    g.append(mk("rect", { x: x + 4, y: y - 23, width: text.length * 6.6 + 10, height: 19, rx: 3, fill: "rgba(29,35,48,.85)" }), t);
    return g;
  };
  function draw() {
    layer.innerHTML = "";
    if (!items.length && !pts.length) return;
    const pr = (p) => app.project(p);
    const line = (a, b, cls = "mline") => { const A = pr(a), B = pr(b); if (A && B) layer.append(mk("line", { x1: A[0], y1: A[1], x2: B[0], y2: B[1], class: cls })); };
    const dot = (p, cls = "mdot") => { const A = pr(p); if (A) layer.append(mk("circle", { cx: A[0], cy: A[1], r: 4, class: cls })); return A; };
    for (const it of items) {
      if (it.type === "box") {
        const [a, b] = it.box, c = (i) => [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]];
        for (const [i, j] of [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]) line(c(i), c(j), "mbox");
        const A = pr(c(7));
        if (A) layer.append(label(A[0], A[1], it.text.replace("Dimensões ", "")));
        continue;
      }
      if (it.circle) for (let i = 0; i + 1 < it.circle.length; i++) line(it.circle[i], it.circle[i + 1]);
      const P = it.pts || [];
      for (let i = 0; i + 1 < P.length; i++) line(P[i], P[i + 1]);
      let at = null;
      for (const p of P) at = dot(p) || at;
      if (it.type === "dist" || it.type === "min") { const A = pr(P[0]), B = pr(P[1]); if (A && B) at = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]; }
      if (it.type === "angle") at = pr(P[1]);
      if (at && P.length) layer.append(label(at[0], at[1], it.text.replace(/^(Distância|Ângulo|Folga) /, "")));
    }
    for (const s of pts) dot(s.p, "mdot pending");
  }
  app.on("frame", draw);
  app.on("model", () => { items = []; pts = []; render(); });
}
