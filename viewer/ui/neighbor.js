// Neighbourhood: show only the selected parts and what is around them, inside a sphere or a box
// whose size can be changed. Parts are kept whole (filtered by their geometry) or cut exactly at
// the region's surface. Leaving restores the previous visibility and opacity.
import { $, num, fmt } from "./util.js";
import { meshInSphere, meshInBox } from "../lib/geom.js";

const MIN = 0.05; // metres
const GHOST = 77; // neighbours' opacity (0..255) when "semitransparentes"

export function initNeighbor(app) {
  const panel = $("#nbPanel");
  let st = null, token = 0, timer = 0;

  const diag = () => { const b = app.modelBox(); return Math.max(1, b.getSize(b.min.clone()).length()); };
  const toSlider = (v) => Math.round(1000 * Math.log(Math.max(MIN, v) / MIN) / Math.log(diag() / MIN));
  const fromSlider = (s) => MIN * Math.pow(diag() / MIN, s / 1000);
  const m = (v) => v.toLocaleString("pt-BR", { maximumFractionDigits: v < 10 ? 2 : 1 });
  const hint = (t) => { $("#nbCount").textContent = t; };

  // half sizes of the region
  const halfOf = (s) => (s.shape === "sphere" ? [s.size, s.size, s.size] : s.axes ? s.dims.map((d) => d / 2) : [s.size / 2, s.size / 2, s.size / 2]);

  function enter(nodes) {
    if (!nodes.length) { hint("Selecione uma ou mais peças (na árvore ou no modelo) e clique em “Usar a seleção”."); return; }
    const b = app.nodesBox(nodes);
    if (b.isEmpty()) { hint("A seleção não tem geometria carregada."); return; }
    const c = b.getCenter(b.min.clone()), d = b.getSize(b.min.clone());
    const focus = new Uint8Array(app.nParts);
    app.forParts(nodes, (p) => { focus[p] = 1; });
    if (!st) st = { saved: { visible: app.partVisible.slice(), opacity: app.partOpacity.slice() }, shape: "sphere", mode: "whole", ghost: $("#nbGhost").checked, outline: $("#nbShow").checked, axes: false };
    st.focus = focus;
    st.nodes = nodes.slice(0, 5000);
    st.center = c.toArray();
    const r = Math.max(1, d.length() / 2 + 1);
    st.size = st.shape === "sphere" ? r : 2 * r;
    st.dims = [Math.max(1, d.x + 2), Math.max(1, d.y + 2), Math.max(1, d.z + 2)];
    sync();
    apply();
  }

  function exit() {
    if (!st) return;
    token++;
    app.partVisible.set(st.saved.visible);
    app.partOpacity.set(st.saved.opacity);
    st = null;
    app.setRegion(null);
    app.refresh();
    $("#nbBtn").classList.remove("active");
    hint("");
  }

  // Box test for every part, then (keeping whole parts) a geometry test for those on the border.
  function apply() {
    if (!st) return;
    const my = ++token;
    const B = app.partBoxes(), c = st.center, h = halfOf(st), r = st.size, sphere = st.shape === "sphere";
    const vis = app.partVisible, op = app.partOpacity, saved = st.saved;
    const border = [];
    let inside = 0;
    for (let p = 0; p < app.nParts; p++) {
      const o = p * 6;
      let show = 0;
      if (st.focus[p]) show = 1;
      else if (app.isLoaded(p) && !(B[o] === 0 && B[o + 3] === 0 && B[o + 1] === 0 && B[o + 4] === 0)) {
        if (sphere) {
          let d2 = 0, far2 = 0;
          for (let a = 0; a < 3; a++) {
            const lo = B[o + a], hi = B[o + 3 + a];
            const dd = Math.max(lo - c[a], 0, c[a] - hi);
            d2 += dd * dd;
            far2 += Math.max(Math.abs(lo - c[a]), Math.abs(hi - c[a])) ** 2;
          }
          if (d2 <= r * r) { show = 1; if (far2 > r * r) border.push(p); }
        } else {
          let overlap = true, within = true;
          for (let a = 0; a < 3; a++) {
            const lo = B[o + a], hi = B[o + 3 + a];
            if (lo > c[a] + h[a] || hi < c[a] - h[a]) overlap = false;
            if (lo < c[a] - h[a] || hi > c[a] + h[a]) within = false;
          }
          if (overlap) { show = 1; if (!within) border.push(p); }
        }
      }
      vis[p] = show;
      op[p] = show && st.ghost && !st.focus[p] ? Math.min(saved.opacity[p], GHOST) : saved.opacity[p];
      if (show && !st.focus[p]) inside++;
    }
    app.setRegion({ shape: st.shape, center: c, radius: r, half: h, clip: st.mode === "clip", outline: st.outline });
    app.refresh();
    $("#nbBtn").classList.add("active");
    hint(`${fmt(inside)} peça(s) na região` + (border.length && st.mode === "whole" ? " · conferindo a geometria…" : ""));
    clearTimeout(timer);
    if (st.mode === "whole" && border.length && app.canReadGeometry()) timer = setTimeout(() => refine(my, border, inside), 450);
    else if (st.mode === "whole" && border.length) hint(`${fmt(inside)} peça(s) na região (pela caixa das peças; abra a pasta original ou uma convertida no formato novo para conferir a geometria)`);
  }

  async function refine(my, border, count) {
    const c = st.center, h = halfOf(st), r = st.size, sphere = st.shape === "sphere";
    const CAP = 2500;
    // nearest first, so the result is right where it matters if the cap is reached
    const B = app.partBoxes();
    const dist = (p) => { let d = 0; for (let a = 0; a < 3; a++) d += ((B[p * 6 + a] + B[p * 6 + 3 + a]) / 2 - c[a]) ** 2; return d; };
    const list = border.filter((p) => !st.focus[p]).sort((a, b) => dist(a) - dist(b)).slice(0, CAP);
    let removed = 0, last = performance.now();
    for (let i = 0; i < list.length; i++) {
      if (my !== token || !st) return;
      const p = list[i];
      const g = await app.partGeometry(p);
      if (my !== token || !st) return;
      if (g && !(sphere ? meshInSphere(g, c, r) : meshInBox(g, c, h))) { app.partVisible[p] = 0; removed++; }
      if (performance.now() - last > 300) {
        last = performance.now();
        app.refresh();
        hint(`${fmt(count - removed)} peça(s) na região · conferindo a geometria ${fmt(i + 1)}/${fmt(list.length)}…`);
      }
    }
    app.refresh();
    hint(`${fmt(count - removed)} peça(s) na região` + (border.length > CAP ? ` (as ${fmt(CAP)} mais próximas da borda conferidas pela geometria)` : ""));
  }

  // ------------------------------------------------------------ UI
  function sync() {
    if (!st) return;
    document.querySelectorAll("#nbShape button").forEach((b) => b.classList.toggle("on", b.dataset.s === st.shape));
    document.querySelectorAll("#nbMode button").forEach((b) => b.classList.toggle("on", b.dataset.m === st.mode));
    $("#nbSizeLbl").textContent = st.shape === "sphere" ? "Raio" : "Lado";
    $("#nbAxesL").hidden = st.shape === "sphere";
    $("#nbAxesRow").hidden = st.shape === "sphere" || !st.axes;
    $("#nbSizeRow").hidden = st.shape === "box" && st.axes;
    $("#nbAxes").checked = st.axes;
    $("#nbSize").value = toSlider(st.size);
    $("#nbVal").value = m(st.size);
    ["#nbX", "#nbY", "#nbZ"].forEach((id, a) => { $(id).value = m(st.dims[a]); });
    $("#nbGhost").checked = st.ghost;
    $("#nbShow").checked = st.outline;
  }

  $("#nbBtn").onclick = () => {
    panel.hidden = !panel.hidden;
    $("#nbBtn").classList.toggle("on", !panel.hidden);
    if (!panel.hidden && !st) enter([...app.selNodes]);
  };
  panel.querySelector("[data-close]").addEventListener("click", () => $("#nbBtn").classList.remove("on"));
  $("#nbUseSel").onclick = () => enter([...app.selNodes]);
  $("#nbExit").onclick = exit;
  $("#nbFrame").onclick = () => {
    if (!st) return;
    const h = halfOf(st), c = st.center;
    app.frameMinMax([c[0] - h[0], c[1] - h[1], c[2] - h[2]], [c[0] + h[0], c[1] + h[1], c[2] + h[2]]);
  };
  document.querySelectorAll("#nbShape button").forEach((b) => {
    b.onclick = () => {
      if (!st || st.shape === b.dataset.s) return;
      st.size = b.dataset.s === "box" ? st.size * 2 : st.size / 2; // keep the same extent
      st.shape = b.dataset.s;
      sync(); apply();
    };
  });
  document.querySelectorAll("#nbMode button").forEach((b) => { b.onclick = () => { if (!st) return; st.mode = b.dataset.m; sync(); apply(); }; });
  $("#nbSize").oninput = () => { if (!st) return; st.size = fromSlider(+$("#nbSize").value); $("#nbVal").value = m(st.size); apply(); };
  $("#nbVal").onchange = () => { if (!st) return; const v = num($("#nbVal").value); if (v > 0) { st.size = v; sync(); apply(); } };
  $("#nbAxes").onchange = () => { if (!st) return; st.axes = $("#nbAxes").checked; if (st.axes) st.dims = [st.size, st.size, st.size]; sync(); apply(); };
  ["#nbX", "#nbY", "#nbZ"].forEach((id, a) => { $(id).onchange = () => { if (!st) return; const v = num($(id).value); if (v > 0) { st.dims[a] = v; apply(); } }; });
  $("#nbGhost").onchange = () => { if (!st) return; st.ghost = $("#nbGhost").checked; apply(); };
  $("#nbShow").onchange = () => { if (!st) return; st.outline = $("#nbShow").checked; apply(); };
  $("#nbCenterSel").onclick = () => {
    if (!st) return enter([...app.selNodes]);
    const b = app.nodesBox(st.nodes);
    if (!b.isEmpty()) { st.center = b.getCenter(b.min.clone()).toArray(); apply(); }
  };
  $("#nbCenterPick").onclick = () => {
    if (!st) { hint("Primeiro escolha as peças (Usar a seleção)."); return; }
    const prev = app.tool;
    $("#nbCenterPick").classList.add("on");
    hint("Clique no ponto do modelo que será o centro da região.");
    app.tool = (info) => {
      app.tool = prev;
      $("#nbCenterPick").classList.remove("on");
      if (!info.point) { hint("Nenhuma peça nesse ponto."); return; }
      st.center = info.point;
      apply();
    };
  };

  // for saved views
  app.nbState = () => st && { nodes: st.nodes, shape: st.shape, center: st.center, size: st.size, axes: st.axes, dims: st.dims, mode: st.mode, ghost: st.ghost, outline: st.outline };
  app.nbSaved = () => st && st.saved;
  app.nbApply = (s) => {
    if (!s) { if (st) exit(); return; }
    if (st) { st = null; app.setRegion(null); }
    const nodes = (s.nodes || []).filter((n) => n < app.nNodes);
    const focus = new Uint8Array(app.nParts);
    app.forParts(nodes, (p) => { focus[p] = 1; });
    st = { ...s, nodes, focus, saved: { visible: app.partVisible.slice(), opacity: app.partOpacity.slice() } };
    sync();
    apply();
  };
  app.on("model", () => { st = null; token++; app.setRegion(null); hint(""); });
}
