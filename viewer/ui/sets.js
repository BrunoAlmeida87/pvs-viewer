// Named selection sets and colour schemes, kept in this browser's localStorage per model.
import { $, el, fmt, store } from "./util.js";

// run-length encode a typed array, skipping the default value: [[start, length, value], ...]
function runs(arr, skip) {
  const out = [];
  for (let i = 0; i < arr.length;) {
    const v = arr[i];
    let j = i + 1;
    while (j < arr.length && arr[j] === v) j++;
    if (v !== skip) out.push([i, j - i, v]);
    i = j;
  }
  return out;
}

export function initSets(app) {
  const key = () => "pvs-viewer:" + app.title;
  const load = () => store.get(key(), { sets: [], schemes: [] });
  const save = (d) => {
    if (!store.set(key(), d)) alert("Não foi possível salvar: o armazenamento do navegador está cheio ou bloqueado.");
  };

  app.on("model", render);

  $("#setSave").onclick = () => {
    if (!app.selNodes.size) { alert("Selecione algo antes de salvar um conjunto."); return; }
    const d = load();
    const name = $("#setName").value.trim() || `Conjunto ${d.sets.length + 1}`;
    d.sets = d.sets.filter((s) => s.name !== name);
    d.sets.push({ name, nodes: [...app.selNodes] });
    save(d);
    $("#setName").value = "";
    render();
  };

  $("#schemeSave").onclick = () => {
    const d = load();
    const name = $("#schemeName").value.trim() || `Esquema ${d.schemes.length + 1}`;
    d.schemes = d.schemes.filter((s) => s.name !== name);
    d.schemes.push({ name, color: runs(app.partColor, -1), opacity: runs(app.partOpacity, 255),
      visible: runs(app.partVisible, 1), rule: app.ruleSpec || "", ghost: app.ghost });
    save(d);
    $("#schemeName").value = "";
    render();
  };

  function applyScheme(s) {
    app.partColor.fill(-1);
    app.partOpacity.fill(255);
    app.partVisible.fill(1);
    for (const [a, n, v] of s.color) app.partColor.fill(v, a, a + n);
    for (const [a, n, v] of s.opacity) app.partOpacity.fill(v, a, a + n);
    for (const [a, n, v] of s.visible || []) app.partVisible.fill(v, a, a + n);
    app.ghost = !!s.ghost;
    $("#ghost").classList.toggle("on", app.ghost);
    if (s.rule) app.applyRule(s.rule);
    else { app.partRule = null; app.emit("rule", ""); app.refresh(); }
  }

  function render() {
    const d = load();
    const sets = $("#setList"), schemes = $("#schemeList");
    sets.innerHTML = "";
    schemes.innerHTML = "";
    if (!d.sets.length) sets.append(el("div.muted", { text: "Nenhum conjunto salvo." }));
    for (const s of d.sets) {
      const nodes = s.nodes.filter((n) => n < app.nNodes);
      sets.append(el("div.item", null,
        el("span.nm", { text: `${s.name} (${fmt(nodes.length)})`, title: s.name }),
        el("button", { text: "Selecionar", onclick: () => app.select(nodes, "replace", { reveal: false }) }),
        el("button", { text: "+", title: "Somar à seleção", onclick: () => app.select(nodes, "add", { reveal: false }) }),
        el("button", { text: "Isolar", onclick: () => app.isolate(nodes) }),
        el("button", { text: "✕", title: "Excluir", onclick: () => { const x = load(); x.sets = x.sets.filter((y) => y.name !== s.name); save(x); render(); } })));
    }
    if (!d.schemes.length) schemes.append(el("div.muted", { text: "Nenhum esquema salvo." }));
    for (const s of d.schemes) {
      schemes.append(el("div.item", null,
        el("span.nm", { text: s.name, title: s.name }),
        el("button", { text: "Aplicar", onclick: () => applyScheme(s) }),
        el("button", { text: "✕", title: "Excluir", onclick: () => { const x = load(); x.schemes = x.schemes.filter((y) => y.name !== s.name); save(x); render(); } })));
    }
  }
}
