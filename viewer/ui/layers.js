// Layers panel: Creo layers read from the .ol files. Layer 99 (the space an equipment may take,
// such as a door swing) starts hidden. The choice is remembered per model in this browser.
import { $, el, fmt, store } from "./util.js";

const DEFAULT_HIDDEN = ["99"];

export function initLayers(app) {
  const panel = $("#layerPanel"), list = $("#layerList");
  const key = () => "pvs-viewer:layers:" + app.title;
  let counts = new Map(); // layer name -> Set of parts

  $("#layerBtn").onclick = () => {
    panel.hidden = !panel.hidden;
    $("#layerBtn").classList.toggle("on", !panel.hidden);
    if (!panel.hidden) render();
  };
  panel.querySelector("[data-close]").addEventListener("click", () => $("#layerBtn").classList.remove("on"));

  function recount() {
    counts = new Map();
    const n = app.itemCount();
    for (let i = 0; i < n; i++) {
      const name = app.layers[app.layerIdOfItem(i)];
      let s = counts.get(name);
      if (!s) counts.set(name, (s = new Set()));
      s.add(app.itemPart(i));
    }
  }
  const label = (name) => (name === "" ? "(sem camada)" : "Camada " + name);
  const sorted = () => [...app.layers].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : (+a - +b) || a.localeCompare(b)));
  const save = () => store.set(key(), [...app.hiddenLayers]);
  const setHidden = (names) => { app.setLayersHidden(names); save(); render(); };

  function render() {
    if (panel.hidden) return;
    list.innerHTML = "";
    const f = $("#layerFilter").value.trim().toLowerCase();
    const names = sorted().filter((n) => !f || label(n).toLowerCase().includes(f));
    if (!names.length) list.append(el("div.muted", { text: app.layers.length ? "Nenhuma camada com esse nome." : "As camadas aparecem quando a geometria é carregada." }));
    for (const name of names) {
      const parts = counts.get(name);
      const cb = el("input", { type: "checkbox", checked: !app.hiddenLayers.has(name) });
      cb.onchange = () => {
        const h = new Set(app.hiddenLayers);
        if (cb.checked) h.delete(name); else h.add(name);
        setHidden([...h]);
      };
      const row = el("div.lrow", null,
        el("label", null, cb, el("span", { text: label(name) }), name === "99" ? el("span.tag", { text: "volumes de movimento" }) : null),
        el("span.muted", { text: fmt(parts ? parts.size : 0) }),
        el("button", { text: "Selecionar", title: "Seleciona as peças que têm geometria nesta camada", onclick: () => {
          const s = counts.get(name);
          if (s) app.select([...s].map((p) => app.partNode[p]), "replace", { reveal: false });
        } }));
      list.append(row);
    }
    const hidden = [...app.hiddenLayers].filter((n) => app.layers.includes(n));
    $("#layerInfo").textContent = `${fmt(app.layers.length)} camada(s)` + (hidden.length ? ` · ${fmt(hidden.length)} oculta(s)` : "");
    $("#layerBtn").classList.toggle("active", hidden.length > 0);
  }

  $("#layerFilter").oninput = render;
  $("#layerAll").onclick = () => setHidden([]);
  $("#layerNone").onclick = () => setHidden([...app.layers]);
  $("#layerDefault").onclick = () => setHidden(DEFAULT_HIDDEN);

  let t = 0;
  const later = () => { clearTimeout(t); t = setTimeout(() => { recount(); render(); }, 300); };
  app.on("layers", later);
  app.on("geometry", later);
  app.on("model", () => {
    const saved = store.get(key(), null);
    app.setLayersHidden(Array.isArray(saved) ? saved : DEFAULT_HIDDEN);
  });
  app.on("loaded", () => {
    recount();
    render();
    const s99 = counts.get("99");
    if (s99 && app.hiddenLayers.has("99")) {
      $("#load").textContent += ` · camada 99 (volumes de movimento) oculta em ${fmt(s99.size)} peça(s) — veja Camadas`;
    }
  });
}
