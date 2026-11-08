// Bigramas panel: filter the model by system. The bigrama (DT in LPR-DT20003) is added to the data as
// the "Bigrama" property when the model loads (lib/bigrama.js). A part belongs to the bigrama of its
// own equipment code, or else of the nearest assembly above it that has one. The check boxes show
// or hide those parts; the other tools (search, colour by property, part list) use the same property.
import { $, el, fmt } from "./util.js";
import { BIGRAMA_KEY } from "../lib/bigrama.js";

const NONE = ""; // parts that sit under no equipment code (hull, structure, piping runs…)

export function initBigrama(app) {
  const panel = $("#bgPanel"), list = $("#bgList"), btn = $("#bgBtn");
  let groups = new Map(); // bigrama -> { code, nodes: Int32Array (part nodes), parts: Int32Array (part ids), equip }

  btn.onclick = () => {
    panel.hidden = !panel.hidden;
    btn.classList.toggle("on", !panel.hidden);
    if (!panel.hidden) render();
  };
  panel.querySelector("[data-close]").addEventListener("click", () => btn.classList.remove("on"));

  function build() {
    groups = new Map();
    app.bigramaEff = null;
    app.bigramaList = [];
    const t = app.tree, ki = app.keyIndex(BIGRAMA_KEY);
    if (ki < 0) return;
    const eff = new Array(app.nNodes).fill(NONE);
    const tmp = new Map();
    const get = (code) => { let g = tmp.get(code); if (!g) tmp.set(code, (g = { code, nodes: [], parts: [], equip: 0 })); return g; };
    // parents come before their children, so one pass is enough
    for (let n = 0; n < app.nNodes; n++) {
      const own = app.prop(n, ki);
      if (own) get(own).equip++;
      eff[n] = own || (t.parent[n] >= 0 ? eff[t.parent[n]] : NONE);
      if (t.part[n] >= 0) { const g = get(eff[n]); g.nodes.push(n); g.parts.push(t.part[n]); }
    }
    for (const [code, g] of tmp) groups.set(code, { code, equip: g.equip, nodes: Int32Array.from(g.nodes), parts: Int32Array.from(g.parts) });
    // shared with the Busca tab: bigrama of every node, and the list of bigramas
    app.bigramaEff = eff;
    app.bigramaList = [...groups.values()].map((g) => ({ code: g.code, parts: g.parts.length, equip: g.equip }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  const label = (code) => (code === NONE ? "(sem bigrama)" : code);
  // 1 = all parts visible, 0 = none, 0.5 = some
  function visState(g) {
    let on = 0;
    for (const p of g.parts) on += app.partVisible[p];
    return on === g.parts.length ? 1 : on === 0 ? 0 : 0.5;
  }
  const filtered = () => {
    const f = $("#bgFilter").value.trim().toLowerCase();
    const sort = $("#bgSort").value;
    const all = [...groups.values()].filter((g) => !f || label(g.code).toLowerCase().includes(f));
    all.sort((a, b) => {
      if (a.code === NONE) return 1;
      if (b.code === NONE) return -1;
      return sort === "count" ? b.parts.length - a.parts.length || a.code.localeCompare(b.code) : a.code.localeCompare(b.code);
    });
    return all;
  };

  function render() {
    if (panel.hidden) return;
    list.innerHTML = "";
    if (!groups.size) {
      list.append(el("div.muted", { text: "Este modelo não tem códigos de equipamento (LPR-XX…) para extrair bigramas." }));
      $("#bgInfo").textContent = "";
      return;
    }
    const rows = filtered();
    if (!rows.length) list.append(el("div.muted", { text: "Nenhum bigrama com esse nome." }));
    for (const g of rows) {
      const s = visState(g);
      const cb = el("input", { type: "checkbox", checked: s === 1 });
      cb.indeterminate = s === 0.5;
      cb.onchange = () => app.setVisible([...g.nodes], cb.checked);
      list.append(el("div.lrow", null,
        el("label", null, cb, el("code", { text: label(g.code) })),
        el("span.muted", { text: fmt(g.parts.length), title: `${fmt(g.parts.length)} peça(s) com geometria` + (g.code === NONE ? "" : ` · ${fmt(g.equip)} código(s) de equipamento`) }),
        el("button", { text: "Só", title: "Mostra só as peças deste bigrama", onclick: () => app.isolate([...g.nodes]) }),
        el("button", { text: "Selec.", title: "Seleciona as peças deste bigrama", onclick: () => app.select([...g.nodes], "replace", { reveal: false }) })));
    }
    const named = [...groups.keys()].filter((c) => c !== NONE).length;
    const shown = [...groups.values()].filter((g) => visState(g) > 0).length;
    $("#bgInfo").textContent = `${fmt(named)} bigrama(s) · ${fmt(shown)} com peças visíveis`;
    btn.classList.toggle("active", shown < groups.size);
  }

  $("#bgFilter").oninput = render;
  $("#bgSort").onchange = render;
  $("#bgAll").onclick = () => app.showAll();
  $("#bgNone").onclick = () => app.setVisible([0], false);
  $("#bgShown").onclick = () => {
    const keep = new Set(filtered().map((g) => g.code));
    app.setVisible([0], false);
    app.setVisible([...groups.values()].filter((g) => keep.has(g.code)).flatMap((g) => [...g.nodes]), true);
  };

  let t = 0;
  app.on("state", () => { if (panel.hidden) return; clearTimeout(t); t = setTimeout(render, 120); });
  app.on("model", () => { build(); $("#bgFilter").value = ""; render(); app.emit("bigrama"); });
}
