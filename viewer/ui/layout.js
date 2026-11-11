// Page layout: light/dark theme, collapsible side bar and properties, floating panels (one at a
// time, draggable by the header, position remembered), "Abrir" button and the GPU chip.
import { $, store } from "./util.js";

export function initLayout(app) {
  // ------------------------------------------------------------ theme
  const root = document.documentElement;
  const setTheme = (t) => {
    root.dataset.theme = t;
    store.set("pvs-viewer:theme", t);
    // the 3D background follows the theme when it is one of the two gradients
    if (t === "dark" && app.display.bg === "grad") app.setDisplay({ bg: "dark" });
    if (t === "light" && app.display.bg === "dark") app.setDisplay({ bg: "grad" });
  };
  try { const t = localStorage.getItem("pvs-viewer:theme"); if (t) root.dataset.theme = JSON.parse(t); } catch { /* default light */ }
  $("#themeBtn").onclick = () => setTheme(root.dataset.theme === "dark" ? "light" : "dark");

  // ------------------------------------------------------------ side bar and properties
  const appEl = $("#app");
  const phone = root.classList.contains("mobile");
  // a narrow window (a tablet held upright) starts with the side bar closed: the model comes first
  if (store.get("pvs-viewer:noSide", root.clientWidth < 900)) appEl.classList.add("noSide");
  $("#sideToggle").onclick = () => {
    appEl.classList.toggle("noSide");
    store.set("pvs-viewer:noSide", appEl.classList.contains("noSide"));
  };
  // drag the line between the side bar and the 3D view to resize it (double click: back to 340 px)
  const SIDE_DEFAULT = 340, SIDE_MIN = 240;
  const sideMax = () => Math.max(SIDE_MIN, Math.min(900, window.innerWidth - 320));
  const setSide = (w, save = true) => {
    w = Math.round(Math.max(SIDE_MIN, Math.min(sideMax(), w)));
    root.style.setProperty("--side-w", w + "px");
    if (save) store.set("pvs-viewer:sideW", w);
  };
  const savedW = store.get("pvs-viewer:sideW", null);
  if (typeof savedW === "number") setSide(savedW, false);
  const grip = $("#sideGrip");
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    appEl.classList.add("resizing");
    const left = $("#side").getBoundingClientRect().left;
    const move = (ev) => setSide(ev.clientX - left, false);
    const up = (ev) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      appEl.classList.remove("resizing");
      setSide(ev.clientX - left);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });
  grip.addEventListener("dblclick", () => setSide(SIDE_DEFAULT));
  window.addEventListener("resize", () => { const w = parseInt(getComputedStyle(root).getPropertyValue("--side-w"), 10); if (w > sideMax()) setSide(sideMax(), false); });

  if (store.get("pvs-viewer:infoClosed", false)) $("#infoBox").classList.add("closed");
  $("#infoHead").onclick = () => {
    $("#infoBox").classList.toggle("closed");
    store.set("pvs-viewer:infoClosed", $("#infoBox").classList.contains("closed"));
  };

  // ------------------------------------------------------------ floating panels
  const panels = [...document.querySelectorAll("#floaters .panel")];
  const pos = store.get("pvs-viewer:panelPos", {});
  const place = (p) => {
    const v = $("#view").getBoundingClientRect(), r = pos[p.id];
    if (!r) { p.style.left = ""; p.style.top = ""; return; }
    p.style.left = Math.max(0, Math.min(v.width - 120, r[0])) + "px";
    p.style.top = Math.max(0, Math.min(v.height - 60, r[1])) + "px";
  };
  for (const p of panels) {
    place(p);
    // only one panel open at a time: opening one closes the others (through their own close button)
    new MutationObserver(() => {
      if (p.hidden) return;
      place(p);
      for (const q of panels) if (q !== p && !q.hidden) q.querySelector("[data-close]")?.click();
    }).observe(p, { attributes: true, attributeFilter: ["hidden"] });
    const head = p.querySelector(".ph");
    head.addEventListener("pointerdown", (e) => {
      if (phone || e.button !== 0 || e.target.closest("button")) return; // on a phone the panels are fixed sheets
      e.preventDefault();
      const v = $("#view").getBoundingClientRect();
      const r = p.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const x = Math.max(0, Math.min(v.width - 80, ev.clientX - v.left - dx));
        const y = Math.max(0, Math.min(v.height - 40, ev.clientY - v.top - dy));
        p.style.left = x + "px"; p.style.top = y + "px";
        pos[p.id] = [x, y];
      };
      const up = () => {
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", up);
        store.set("pvs-viewer:panelPos", pos);
      };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", up);
    });
    head.addEventListener("dblclick", (e) => { if (e.target.closest("button")) return; delete pos[p.id]; store.set("pvs-viewer:panelPos", pos); place(p); });
    head.title = "Arraste para mover · duplo clique volta à posição inicial";
  }

  // ------------------------------------------------------------ top bar in one row
  // When the buttons do not fit in the window: first the labels go (icons with tooltips), then the
  // least used tools move into a "Mais" menu, one by one, until everything fits in a single row.
  const bar = $("#bar1"), more = $("#moreMenu"), moreBody = more.querySelector(".menuBody");
  const MOVABLE = ["#arBtn", "#manBtn", "#markBtn", "#animBtn", "#analysisBtn", "#explodeBtn", "#nbBtn", "#bgBtn", "#layerBtn", "#walkBtn", "#ghost",
    "#exportMobileBtn", "#measureBtn", "#cutBtn", "#hideSel", "#isolate", "#zoomSel", "#loadMoreBtn"];
  const home = new Map(); // button -> placeholder at its place in the bar
  for (const sel of MOVABLE) { const b = $(sel), ph = document.createComment(sel); b.before(ph); home.set(b, ph); }
  const tooWide = () => bar.scrollWidth > bar.clientWidth + 1;
  let fitting = false;
  function fitBar() {
    if (phone || fitting) return;
    fitting = true;
    for (const [b, ph] of home) if (b.parentNode === moreBody) ph.after(b);
    more.hidden = true;
    bar.classList.remove("compact");
    if (tooWide()) {
      bar.classList.add("compact");
      if (tooWide()) {
        more.hidden = false;
        for (const [b] of home) { if (!tooWide()) break; if (!b.hidden) moreBody.prepend(b); }
        if (!moreBody.children.length) more.hidden = true;
      }
    }
    fitting = false;
  }
  new ResizeObserver(fitBar).observe(bar);
  // buttons that appear later ("Carregar", "Exportar modelo") change the width too
  // (the "Mais" menu itself and the drop-downs are left out: fitBar changes them)
  new MutationObserver((list) => { if (list.some((m) => m.target !== more && m.target.classList.contains("tb"))) fitBar(); })
    .observe(bar, { attributes: true, attributeFilter: ["hidden"], subtree: true });
  app.on("model", fitBar);
  fitBar();

  // ------------------------------------------------------------ open another model
  $("#openModelBtn").onclick = () => {
    const u = new URL(location.href);
    u.searchParams.delete("pvs");
    u.searchParams.set("abrir", "");
    u.hash = "";
    location.href = u.href.replace(/abrir=(&|$)/, "abrir$1");
  };

  // ------------------------------------------------------------ GPU chip
  const chip = $("#gpuChip");
  const short = app.gpu.replace(/^ANGLE \(/, "").replace(/\)$/, "").replace(/ Direct3D.*$/, "").replace(/\s*\(0x[0-9A-F]+\)/i, "").replace(/^[^,]+,\s*/, "");
  chip.querySelector("span").textContent = short.length > 34 ? short.slice(0, 33) + "…" : short;
  chip.classList.add(app.gpuIntegrated ? "bad" : "good");
  if (app.gpuIntegrated) chip.title = "O navegador está usando a placa de vídeo integrada (mais lenta). Clique para ver o desempenho e como trocar.";
  chip.hidden = false;
  chip.onclick = () => app.togglePerf();
}
