// Hand markups: pen, arrow, box and text drawn over the view (as the Creo View markups). They belong
// to the view they were drawn on: when the camera moves they are hidden ("Voltar à vista" brings the
// camera back), and saved views, links and the PNG keep them. Coordinates are kept relative to the
// view centre and divided by the view height, so they stay on the model when the window is resized.
import { $, el } from "./util.js";

const SVGNS = "http://www.w3.org/2000/svg";
const COLORS = ["#e03131", "#f59f00", "#1c7ed6", "#2f9e44", "#212529", "#ffffff"];

export function initMarkup(app) {
  const panel = $("#markPanel"), btn = $("#markBtn"), pad = $("#markPad"), hintEl = $("#markHint");
  const svg = $("#overlay");
  const layer = document.createElementNS(SVGNS, "g");
  layer.setAttribute("class", "markLayer");
  svg.append(layer);
  let items = [];     // {t: "pen"|"arrow"|"box"|"text", c: colour, w: width, pts: [[x, y]…], text}
  let cam = null;     // the camera they were drawn on
  let tool = "pen", color = COLORS[0];
  let drawing = null; // the item being drawn

  // ------------------------------------------------------------ coordinates
  const size = () => [svg.clientWidth || svg.parentNode.clientWidth, svg.clientHeight || svg.parentNode.clientHeight];
  const toN = (x, y) => { const [W, H] = size(); return [(x - W / 2) / H, (y - H / 2) / H]; };
  const toS = ([x, y]) => { const [W, H] = size(); return [x * H + W / 2, y * H + H / 2]; };
  const local = (e) => { const r = svg.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  // the same view: camera within a hair (relative to its distance to the target)
  function sameView() {
    if (!cam) return true;
    const c = app.getCamera();
    if (!!c.ortho !== !!cam.ortho) return false;
    const d = Math.hypot(...cam.pos.map((v, i) => v - cam.target[i])) || 1, tol = d * 1e-4;
    const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
    return near(c.pos, cam.pos) && near(c.target, cam.target) && (!cam.ortho || Math.abs((c.zoom || 1) - (cam.zoom || 1)) < 1e-4);
  }

  // ------------------------------------------------------------ drawing on the SVG overlay
  const mk = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  function shape(it) {
    const [, H] = size(), w = Math.max(1, it.w * H);
    const P = it.pts.map(toS);
    const line = { stroke: it.c, "stroke-width": w, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" };
    if (it.t === "pen") return mk("polyline", { ...line, points: P.map((p) => p.join(",")).join(" ") });
    if (it.t === "box") {
      const [a, b] = [P[0], P[P.length - 1]];
      return mk("rect", { ...line, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]), rx: w });
    }
    if (it.t === "arrow") {
      const [a, b] = [P[0], P[P.length - 1]], g = mk("g", {});
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), k = Math.max(10, w * 4);
      g.append(mk("line", { ...line, x1: a[0], y1: a[1], x2: b[0], y2: b[1] }));
      const h1 = [b[0] - k * Math.cos(ang - 0.45), b[1] - k * Math.sin(ang - 0.45)], h2 = [b[0] - k * Math.cos(ang + 0.45), b[1] - k * Math.sin(ang + 0.45)];
      g.append(mk("polygon", { points: [h1, b, h2].map((p) => p.join(",")).join(" "), fill: it.c, stroke: it.c, "stroke-width": w / 2, "stroke-linejoin": "round" }));
      return g;
    }
    if (it.t === "text") {
      const fs = Math.max(12, it.w * H * 4.5), t = mk("text", { x: P[0][0], y: P[0][1], fill: it.c, "font-size": fs, "font-weight": 650,
        "font-family": "Segoe UI, system-ui, sans-serif", "paint-order": "stroke", stroke: it.c === "#ffffff" ? "#212529" : "#ffffff", "stroke-width": fs / 7, "stroke-linejoin": "round" });
      t.textContent = it.text;
      return t;
    }
    return null;
  }
  function draw() {
    layer.innerHTML = "";
    const ok = sameView();
    if (ok || drawing) for (const it of drawing ? [...items, drawing] : items) { const s = shape(it); if (s) layer.append(s); }
    $("#markBack").hidden = ok || !items.length;
    if (!panel.hidden) hintEl.textContent = !items.length ? HINT[tool] : ok ? `${items.length} marcação${items.length === 1 ? "" : "ões"} nesta vista. ` + HINT[tool]
      : "A vista mudou: as marcações ficam guardadas com a vista em que foram feitas.";
  }
  const HINT = {
    pen: "Desenhe com o dedo ou o mouse sobre o modelo.",
    arrow: "Arraste do começo até a ponta da seta.",
    box: "Arraste de um canto ao outro.",
    text: "Toque onde vai o texto.",
    nav: "Gire e aproxime o modelo; para desenhar, escolha outra ferramenta (as marcações valem para uma vista).",
  };
  app.on("frame", draw);
  window.addEventListener("resize", draw);

  // ------------------------------------------------------------ input
  function setTool(t) {
    tool = t;
    for (const b of panel.querySelectorAll("[data-mt]")) b.classList.toggle("on", b.dataset.mt === t);
    syncPad();
    draw();
  }
  function syncPad() { pad.hidden = panel.hidden || tool === "nav"; }
  const width = () => +$("#markWidth").value / 900; // fraction of the view height
  pad.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    if (!sameView()) { items = []; } // a new view: the old markups stay with the view they belong to
    if (!items.length) cam = app.getCamera();
    const p = toN(...local(e));
    if (tool === "text") { askText(e, p); return; }
    pad.setPointerCapture(e.pointerId);
    drawing = { t: tool, c: color, w: width(), pts: [p, p] };
    draw();
  });
  pad.addEventListener("pointermove", (e) => {
    if (!drawing) return;
    const p = toN(...local(e));
    if (drawing.t === "pen") {
      const q = drawing.pts[drawing.pts.length - 1], [, H] = size();
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) * H >= 2) drawing.pts.push(p);
    } else drawing.pts[1] = p;
    draw();
  });
  const finish = () => {
    if (!drawing) return;
    const d = drawing, [, H] = size(), a = d.pts[0], b = d.pts[d.pts.length - 1];
    drawing = null;
    if (d.t === "pen" ? d.pts.length > 2 : Math.hypot(b[0] - a[0], b[1] - a[1]) * H > 6) items.push(d);
    draw();
  };
  pad.addEventListener("pointerup", finish);
  pad.addEventListener("pointercancel", finish);
  // text: a small box where it was tapped; Enter (or leaving it) keeps it, Esc cancels
  function askText(e, p) {
    const [x, y] = local(e);
    const box = el("input", { className: "markText", placeholder: "Texto", value: "" });
    box.style.left = x + "px"; box.style.top = y + "px"; box.style.color = color;
    pad.parentNode.append(box);
    let done = false;
    const end = (keep) => {
      if (done) return;
      done = true;
      const text = box.value.trim();
      box.remove();
      if (keep && text) items.push({ t: "text", c: color, w: width(), pts: [p], text });
      draw();
    };
    box.addEventListener("keydown", (k) => { k.stopPropagation(); if (k.key === "Enter") end(true); if (k.key === "Escape") end(false); });
    box.addEventListener("blur", () => end(true));
    setTimeout(() => box.focus(), 0);
  }

  // ------------------------------------------------------------ panel
  for (const b of panel.querySelectorAll("[data-mt]")) b.onclick = () => setTool(b.dataset.mt);
  const swatches = $("#markColors");
  for (const c of COLORS) {
    const b = el("button", { className: "sw", title: c, onclick: () => { color = c; for (const x of swatches.children) x.classList.toggle("on", x === b); } });
    b.style.background = c;
    if (c === color) b.classList.add("on");
    swatches.append(b);
  }
  $("#markUndo").onclick = () => { if (sameView()) items.pop(); draw(); };
  $("#markClear").onclick = () => { items = []; cam = null; draw(); };
  $("#markBack").onclick = () => { if (cam) app.setCamera(cam); };
  $("#markSave").onclick = () => {
    if (!items.length || !sameView()) { hintEl.textContent = "Desenhe algo nesta vista antes de salvar."; return; }
    const name = $("#viewName");
    if (!name.value.trim()) name.value = "Marcação " + new Date().toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    $("#viewSave").click();
    hintEl.textContent = "Vista salva com as marcações (Vistas, na barra lateral).";
  };
  $("#markPng").onclick = () => $("#shotBtn").click();
  btn.onclick = () => { panel.hidden = !panel.hidden; };
  new MutationObserver(() => {
    btn.classList.toggle("on", !panel.hidden);
    if (panel.hidden) { drawing = null; for (const t of document.querySelectorAll(".markText")) t.blur(); }
    syncPad();
    draw();
  }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  app.on("model", () => { items = []; cam = null; draw(); });

  // ------------------------------------------------------------ saved views
  // Only markups that belong to the current view go into it.
  app.getMarkup = () => (items.length && sameView() ? { cam, items } : null);
  app.setMarkup = (m) => { items = m && Array.isArray(m.items) ? m.items : []; cam = m ? m.cam : null; draw(); };
}
