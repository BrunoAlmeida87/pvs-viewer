// Display menu (style, smooth shading, SSAO, background, light), section planes/box panel and
// exploded view panel. Display settings are remembered in this browser.
import { $, store } from "./util.js";

const KEY = "pvs-viewer:display";
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
  $("#dQuality").onchange = (e) => app.setDisplay({ quality: e.target.value });
  $("#dPerf").onchange = (e) => { app.setDisplay({ perf: e.target.checked }); if (!e.target.checked) app.hidePerf(); };
  app.togglePerf = () => { app.setDisplay({ perf: !app.display.perf }); if (!app.display.perf) app.hidePerf(); };
  app.setDisplay(d0);
  app.styleName = () => STYLES[app.display.style];

  // ------------------------------------------------------------ floating panels
  const panels = { cutPanel: $("#cutBtn"), explodePanel: $("#explodeBtn"), measurePanel: $("#measureBtn"), analysisPanel: $("#analysisBtn") };
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
  for (const id of ["#cutInvert", "#cutCap", "#cutShow"]) $(id).onchange = readCut;
  $("#cutSel").onclick = () => {
    if (!app.selNodes.size) { $("#load").textContent = "Selecione as peças para criar a caixa de corte em volta delas."; return; }
    app.clipFromBox(app.nodesBox([...app.selNodes]));
  };
  $("#cutReset").onclick = () => app.setClip({ axes: [0, 1, 2].map(() => ({ on: false, lo: 0, hi: 1 })), invert: false });

  // ------------------------------------------------------------ exploded view
  const readEx = () => app.setExplode({ amount: +$("#exAmount").value, level: +$("#exLevel").value, selOnly: $("#exSel").checked });
  $("#exAmount").oninput = readEx;
  $("#exLevel").onchange = readEx;
  $("#exSel").onchange = readEx;
  $("#exReset").onclick = () => { $("#exAmount").value = 0; readEx(); };
  app.on("selection", () => { if ($("#exSel").checked && app.explode.amount > 0) readEx(); });
  app.on("model", () => { $("#exAmount").value = 0; app.explode.amount = 0; });
}
