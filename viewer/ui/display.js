// Display menu (style, smooth shading, SSAO, background, light), section planes/box panel and
// exploded view panel. Display settings are remembered in this browser.
import { $, store } from "./util.js";

const KEY = document.documentElement.classList.contains("touch") ? "pvs-viewer:display-touch" : "pvs-viewer:display";
const STYLES = ["Sombreado", "Sombreado + arestas", "Linhas ocultas", "Só arestas", "Raio-X"];

export function initDisplay(app) {
  // ------------------------------------------------------------ display menu
  const saved = store.get(KEY, {});
  const d0 = { ...app.display, ...saved, ssao: !!saved.ssao };
  if (!["auto", "fast", "high"].includes(d0.quality)) d0.quality = "auto";
  const sync = () => {
    const d = app.display;
    $("#dStyle").value = String(d.style);
    $("#dSmooth").checked = d.smooth;
    $("#dSSAO").checked = d.ssao;
    $("#dBg").value = d.bg;
    $("#dLight").value = d.light;
    $("#dBright").value = d.bright;
    $("#dCube").checked = d.cube;
    $("#dQuality").value = d.quality;
    $("#dPerf").checked = d.perf;
    $("#dHover").checked = d.hover !== false;
  };
  app.on("display", () => {
    sync();
    store.set(KEY, app.display);
    if (app.display.style >= 1 && app.display.style <= 3 && app.tree && !app.hasEdges())
      $("#load").textContent = "Este modelo não tem arestas (pasta convertida no formato antigo: rode tools/build.py de novo).";
  });
  $("#dStyle").onchange = (e) => app.setDisplay({ style: +e.target.value });
  $("#dSmooth").onchange = (e) => app.setDisplay({ smooth: e.target.checked });
  $("#dSSAO").onchange = (e) => app.setDisplay({ ssao: e.target.checked });
  $("#dBg").onchange = (e) => app.setDisplay({ bg: e.target.value });
  $("#dLight").onchange = (e) => app.setDisplay({ light: e.target.value });
  $("#dBright").oninput = (e) => app.setDisplay({ bright: +e.target.value });
  $("#dCube").onchange = (e) => app.setDisplay({ cube: e.target.checked });
  $("#dHover").onchange = (e) => app.setDisplay({ hover: e.target.checked });
  $("#dQuality").onchange = (e) => app.setDisplay({ quality: e.target.value });
  $("#dPerf").onchange = (e) => { app.setDisplay({ perf: e.target.checked }); if (!e.target.checked) app.hidePerf(); };
  app.togglePerf = () => { app.setDisplay({ perf: !app.display.perf }); if (!app.display.perf) app.hidePerf(); };
  app.setDisplay(d0);
  app.styleName = () => STYLES[app.display.style];

  // ------------------------------------------------------------ floating panels
  const panels = { cutPanel: $("#cutBtn"), explodePanel: $("#explodeBtn"), measurePanel: $("#measureBtn"), analysisPanel: $("#analysisBtn"), nbPanel: $("#nbBtn"), layerPanel: $("#layerBtn"), bgPanel: $("#bgBtn"), animPanel: $("#animBtn") };
  const toggle = (id, on) => {
    const p = $("#" + id);
    p.hidden = on === undefined ? !p.hidden : !on;
    if (panels[id]) panels[id].classList.toggle("on", !p.hidden);
  };
  $("#cutBtn").onclick = () => toggle("cutPanel");
  $("#explodeBtn").onclick = () => toggle("explodePanel");
  document.querySelectorAll("#floaters [data-close]").forEach((b) => { b.onclick = () => toggle(b.dataset.close, false); });

  // ------------------------------------------------------------ section planes / box
  const rows = [...document.querySelectorAll(".cutRow")];
  const readCut = () => {
    const axes = rows.map((r) => ({
      on: r.querySelector("input[type=checkbox]").checked,
      lo: +r.querySelector(".lo").value / 1000,
      hi: +r.querySelector(".hi").value / 1000,
    }));
    app.setClip({ axes, invert: $("#cutInvert").checked, cap: $("#cutCap").checked, show: $("#cutShow").checked });
  };
  const syncCut = () => {
    const c = app.clip;
    rows.forEach((r, a) => {
      r.querySelector("input[type=checkbox]").checked = c.axes[a].on;
      r.querySelector(".lo").value = Math.round(c.axes[a].lo * 1000);
      r.querySelector(".hi").value = Math.round(c.axes[a].hi * 1000);
      r.classList.toggle("off", !c.axes[a].on);
    });
    $("#cutInvert").checked = c.invert;
    $("#cutCap").checked = c.cap;
    $("#cutShow").checked = c.show;
    $("#cutBtn").classList.toggle("active", c.axes.some((x) => x.on));
  };
  app.on("clip", syncCut);
  rows.forEach((r) => {
    const cb = r.querySelector("input[type=checkbox]");
    // moving a slider of an axis that is off switches that axis on
    for (const s of r.querySelectorAll("input[type=range]")) s.oninput = () => { cb.checked = true; readCut(); };
    cb.onchange = readCut;
  });
  document.querySelectorAll("#mobileCutPresets [data-cut-axis]").forEach((button) => {
    button.onclick = () => {
      const axis = +button.dataset.cutAxis;
      rows.forEach((r, i) => {
        r.querySelector("input[type=checkbox]").checked = i === axis;
        r.querySelector(".lo").value = 0;
        r.querySelector(".hi").value = i === axis ? 500 : 1000;
      });
      readCut();
    };
  });
  for (const id of ["#cutInvert", "#cutCap", "#cutShow"]) $(id).onchange = readCut;
  $("#cutSel").onclick = () => {
    if (!app.selNodes.size) { $("#load").textContent = "Selecione as peças para criar a caixa de corte em volta delas."; return; }
    app.clipFromBox(app.nodesBox([...app.selNodes]));
  };
  $("#cutReset").onclick = () => app.setClip({ axes: [0, 1, 2].map(() => ({ on: false, lo: 0, hi: 1 })), invert: false, plane: null });

  // ------------------------------------------------------------ free plane: through a face, in its direction
  const diag = () => { const b = app.modelBox(); return b.min.distanceTo(b.max) || 1; };
  const syncPlane = () => {
    const pl = app.clip.plane;
    for (const id of ["#cutFaceOff", "#cutDepth", "#cutFlip", "#cutLook"]) $(id).disabled = !pl;
    if (!pl) { $("#cutDepthLbl").textContent = ""; return; }
    $("#cutDepth").value = Math.round((pl.depth || 0) / diag() * 1000);
    $("#cutDepthLbl").textContent = ((pl.depth || 0) * 1000).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + " mm";
    $("#cutFlip").classList.toggle("on", !!pl.flip);
  };
  app.on("clip", () => { syncPlane(); $("#cutBtn").classList.toggle("active", app.clip.axes.some((x) => x.on) || !!app.clip.plane); });
  $("#cutFace").onclick = () => {
    const prev = app.tool === pickFace ? null : app.tool;
    $("#cutFreeHint").textContent = "Agora clique numa face do modelo.";
    $("#cutFace").classList.add("on");
    app.tool = pickFace;
    async function pickFace(info) {
      app.tool = prev;
      $("#cutFace").classList.remove("on");
      if (info.node < 0 || !info.point) { $("#cutFreeHint").textContent = "Nenhuma peça nesse ponto. Toque em “Plano por uma face…” e tente de novo."; return; }
      const n = await faceNormal(info);
      app.setClip({ plane: { p: info.point, n, depth: 0, flip: false } });
      $("#cutFreeHint").textContent = "Plano criado. Arraste a profundidade para levá-lo para dentro; “Olhar de frente” mostra o corte.";
    }
  };
  $("#cutFaceOff").onclick = () => app.setClip({ plane: null });
  $("#cutDepth").oninput = (e) => { const pl = app.clip.plane; if (pl) app.setClip({ plane: { ...pl, depth: (+e.target.value / 1000) * diag() } }); };
  $("#cutFlip").onclick = () => { const pl = app.clip.plane; if (pl) app.setClip({ plane: { ...pl, flip: !pl.flip } }); };
  $("#cutLook").onclick = () => {
    const pl = app.clip.plane;
    if (!pl) return;
    const c = app.getCamera(), n = pl.n, d = pl.depth || 0;
    const at = pl.p.map((v, i) => v - n[i] * d);
    const dist = Math.hypot(...c.pos.map((v, i) => v - c.target[i])) || diag();
    // looking at the kept side: from the removed side
    const s = pl.flip ? -1 : 1;
    const pos = at.map((v, i) => v + s * n[i] * dist);
    if (Math.abs(n[2]) > 0.999) pos[1] -= dist * 1e-3; // straight down / up: z is the camera's up, keep it defined
    app.setCamera({ ...c, pos, target: at });
  };
  // Normal of the face under a picked point (the nearest triangle of the part), turned towards the viewer.
  async function faceNormal(info) {
    const c = app.getCamera(), p = info.point;
    const toEye = c.pos.map((v, i) => v - p[i]);
    let n = null;
    if (info.part >= 0 && app.canReadGeometry()) {
      const g = await app.partGeometry(info.part);
      if (g && g.idx.length) n = nearestTriangleNormal(g.pos, g.idx, p);
    }
    if (!n) { const l = Math.hypot(...toEye) || 1; return toEye.map((v) => v / l); } // no geometry: face the camera
    if (n[0] * toEye[0] + n[1] * toEye[1] + n[2] * toEye[2] < 0) n = n.map((v) => -v);
    return n;
  }

  // ------------------------------------------------------------ exploded view
  const readEx = () => app.setExplode({ amount: +$("#exAmount").value, level: +$("#exLevel").value, selOnly: $("#exSel").checked });
  $("#exAmount").oninput = readEx;
  $("#exLevel").onchange = readEx;
  $("#exSel").onchange = readEx;
  $("#exReset").onclick = () => { $("#exAmount").value = 0; readEx(); };
  app.on("selection", () => { if ($("#exSel").checked && app.explode.amount > 0) readEx(); });
  app.on("model", () => { $("#exAmount").value = 0; app.explode.amount = 0; });
}

// Unit normal of the triangle nearest to point p (positions xyz, indices in triangles).
export function nearestTriangleNormal(P, I, p) {
  let best = Infinity, bn = null;
  const q = [0, 0, 0];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    closestOnTriangle(p, P, a, b, c, q);
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
    if (d >= best) continue;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue; // a degenerate sliver says nothing about the face
    best = d;
    bn = [nx / l, ny / l, nz / l];
  }
  return bn;
}
// Closest point of triangle (a, b, c: offsets into P) to p, written to q (Ericson, Real-Time Collision Detection).
function closestOnTriangle(p, P, a, b, c, q) {
  const abx = P[b] - P[a], aby = P[b + 1] - P[a + 1], abz = P[b + 2] - P[a + 2];
  const acx = P[c] - P[a], acy = P[c + 1] - P[a + 1], acz = P[c + 2] - P[a + 2];
  const apx = p[0] - P[a], apy = p[1] - P[a + 1], apz = p[2] - P[a + 2];
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { q[0] = P[a]; q[1] = P[a + 1]; q[2] = P[a + 2]; return; }
  const bpx = p[0] - P[b], bpy = p[1] - P[b + 1], bpz = p[2] - P[b + 2];
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { q[0] = P[b]; q[1] = P[b + 1]; q[2] = P[b + 2]; return; }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); q[0] = P[a] + v * abx; q[1] = P[a + 1] + v * aby; q[2] = P[a + 2] + v * abz; return; }
  const cpx = p[0] - P[c], cpy = p[1] - P[c + 1], cpz = p[2] - P[c + 2];
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { q[0] = P[c]; q[1] = P[c + 1]; q[2] = P[c + 2]; return; }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); q[0] = P[a] + w * acx; q[1] = P[a + 1] + w * acy; q[2] = P[a + 2] + w * acz; return; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    q[0] = P[b] + w * (P[c] - P[b]); q[1] = P[b + 1] + w * (P[c + 1] - P[b + 1]); q[2] = P[b + 2] + w * (P[c + 2] - P[b + 2]); return;
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  q[0] = P[a] + abx * v + acx * w; q[1] = P[a + 1] + aby * v + acy * w; q[2] = P[a + 2] + abz * v + acz * w;
}
