// Choosing an item from a list: typed name or code ("DT20003" finds "LPR-DT20003"), or — without
// typing, since the keyboard may cover everything on a phone — a system (bigrama), then one of its
// equipments. What is selected in the viewer is offered at the top. Used by the search of the
// augmented reality and by "Ir até…".
//
// itemPicker(app, {list, input, onPick, allSystem, extra}) → {show(), reset()}
//   list: element that gets the rows; input: the text box; onPick(nodes, title)
//   allSystem: offer "Todo o sistema XX" (every equipment of a bigrama at once)
//   extra(): rows added at the top when nothing is typed ([{label, sub, nodes, title, onClick}])
import { BIGRAMA_KEY } from "../lib/bigrama.js";

const MAX_RESULTS = 50;
// as in the Search tab: lower case, no accents, no separators ("LPREX" finds "LPR-EX20003")
export const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s\-_./]+/g, "");

export function itemPicker(app, { list, input, onPick, allSystem = false, extra = null }) {
  let index = null; // normalized "name|code" of every node, built at the first search
  let browse = null; // the bigrama whose equipment is listed (nothing typed), or null for the list of systems
  app.on("model", () => { index = null; browse = null; });
  function buildIndex() {
    const t = app.tree, ki = app.keyIndex("part_objectid");
    index = new Array(app.nNodes);
    for (let n = 0; n < app.nNodes; n++) index[n] = norm(t.names[n]) + "|" + (ki >= 0 ? norm(app.prop(n, ki) ?? "") : "");
  }
  // every word must appear; an assembly and its own parts: the assembly only
  function find(text) {
    const words = text.split(/\s+/).map(norm).filter(Boolean);
    if (!words.length) return [];
    if (!index) buildIndex();
    const hits = [];
    for (let n = 1; n < app.nNodes && hits.length < 2000; n++) if (words.every((w) => index[n].includes(w))) hits.push(n);
    const set = new Set(hits), parent = app.tree.parent;
    return hits.filter((n) => { for (let p = parent[n]; p >= 0; p = parent[p]) if (set.has(p)) return false; return true; });
  }
  function row(label, sub, onClick, cls = "") {
    const b = document.createElement("button");
    b.className = "arHit" + (cls ? " " + cls : "");
    const name = document.createElement("b"), small = document.createElement("small");
    name.textContent = label;
    small.textContent = sub;
    b.append(name, small);
    b.onclick = onClick;
    return b;
  }
  const partsText = (n) => { const k = app.partCount(n); return k === 1 ? "1 peça" : k.toLocaleString("pt-BR") + " peças"; };
  const note = (text) => { const p = document.createElement("p"); p.textContent = text; list.append(p); };
  const pick = (nodes, title) => onPick(nodes, title || (nodes.length === 1 ? app.tree.names[nodes[0]] : `${nodes.length} itens`));
  // equipment of a bigrama: the nodes with that code of their own that are not inside another one
  function equipmentOf(code) {
    const ki = app.keyIndex(BIGRAMA_KEY), eff = app.bigramaEff, parent = app.tree.parent, out = [];
    if (ki < 0 || !eff) return out;
    for (let n = 1; n < app.nNodes; n++) if (app.prop(n, ki) === code && eff[parent[n]] !== code) out.push(n);
    return out.sort((a, b) => app.tree.names[a].localeCompare(app.tree.names[b], "pt-BR", { numeric: true }));
  }
  function showBrowse() {
    if (!browse) {
      for (const r of (extra && extra()) || []) list.append(row(r.label, r.sub, r.onClick || (() => pick(r.nodes, r.title)), r.cls || ""));
      // what is selected in the viewer is one tap away
      if (app.selNodes.size) {
        const nodes = [...app.selNodes];
        list.append(row(nodes.length === 1 ? app.tree.names[nodes[0]] : `Seleção atual (${nodes.length} itens)`, "selecionado no visualizador", () => pick(nodes)));
      }
    }
    const systems = (app.bigramaList || []).filter((g) => g.code !== "");
    if (!browse) {
      note(systems.length ? "Digite o nome ou o código, ou escolha um sistema:" : "Digite o nome ou o código (por exemplo DT20003).");
      for (const g of systems) {
        list.append(row(g.code, `${g.equip.toLocaleString("pt-BR")} equipamento${g.equip === 1 ? "" : "s"} · ${g.parts.toLocaleString("pt-BR")} peças`, () => {
          browse = g.code;
          show();
          list.scrollTop = 0;
        }));
      }
      return;
    }
    list.append(row("◂ Sistemas", "voltar à lista de bigramas", () => { browse = null; show(); list.scrollTop = 0; }, "arBack"));
    const eq = equipmentOf(browse);
    if (allSystem && eq.length > 1) list.append(row(`Todo o sistema ${browse}`, `${eq.length.toLocaleString("pt-BR")} equipamentos em destaque`, () => pick(eq, `Sistema ${browse}`), "arAll"));
    const parent = app.tree.parent;
    for (const n of eq) list.append(row(app.tree.names[n], (parent[n] > 0 ? app.tree.names[parent[n]] + " · " : "") + partsText(n), () => pick([n])));
    if (!eq.length) note("Nenhum equipamento com este bigrama.");
  }
  function show() {
    list.innerHTML = "";
    if (!app.tree) return;
    const text = input.value.trim();
    if (!text) { showBrowse(); return; }
    const hits = find(text);
    if (!hits.length) { note("Nada encontrado."); return; }
    const parent = app.tree.parent;
    for (const n of hits.slice(0, MAX_RESULTS)) {
      const up = parent[n] > 0 ? app.tree.names[parent[n]] + " · " : "";
      list.append(row(app.tree.names[n], up + partsText(n), () => pick([n])));
    }
    if (hits.length > MAX_RESULTS) note(`Mais ${(hits.length - MAX_RESULTS).toLocaleString("pt-BR")} resultados: escreva mais do nome.`);
  }
  let searchT = 0;
  input.addEventListener("input", () => { clearTimeout(searchT); searchT = setTimeout(show, 200); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(searchT); show(); input.blur(); } });
  return { show, reset() { browse = null; input.value = ""; }, find, equipmentOf };
}
