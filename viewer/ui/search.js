// Search tab: free text (or /regex/) over the structure, optionally restricted to one bigrama,
// and actions on the results.
import { $, el, fmt, parseHex } from "./util.js";

const MAX_ROWS = 1000;

// Lower case, no accents, and no separators: "LPREX" finds "LPR-EX20003", "tubulacao" finds "TUBULAÇÃO".
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s\-_.]+|\//g, "");

export function initSearch(app) {
  let normNames = null, normVals = null;

  app.on("model", () => {
    normNames = normVals = null;
    $("#results").innerHTML = "";
    $("#qActions").hidden = true;
    app.lastResults = [];
    $("#mobileFilterText").value = "";
    $("#mobileFilterHint").textContent = "Busque pelo nome para filtrar a visualização.";
    $("#mobileFilterOnly").disabled = true;
    $("#mobileFilterHide").disabled = true;
  });

  // bigrama drop-down, ready to pick from (the list comes from the Bigramas panel module)
  app.on("bigrama", () => {
    const sel = $("#qBg");
    sel.innerHTML = "";
    sel.append(el("option", { value: "", text: "Todos os bigramas" }));
    for (const g of app.bigramaList || []) {
      if (g.code === "") continue;
      sel.append(el("option", { value: g.code, text: `${g.code}  ·  ${fmt(g.parts)} peças` }));
    }
    sel.disabled = sel.options.length < 2;
  });
  function clearQuickResults() {
    app.lastResults = [];
    $("#results").innerHTML = "";
    $("#qActions").hidden = true;
    $("#mobileFilterOnly").disabled = true;
    $("#mobileFilterHide").disabled = true;
    $("#mobileFilterHint").textContent = "Toque em Buscar para atualizar os resultados.";
  }
  $("#mobileFilterText").addEventListener("input", clearQuickResults);
  $("#mobileFilterScope").addEventListener("change", clearQuickResults);
  $("#mobileFilterText").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); quickSearch(); $("#mobileFilterText").blur(); }
  });
  $("#mobileFilterRun").onclick = quickSearch;
  function quickSearch() {
    const term = $("#mobileFilterText").value.trim();
    if (!app.tree || !term) {
      clearQuickResults();
      $("#mobileFilterHint").textContent = app.tree ? "Digite um nome para buscar." : "Abra um modelo para buscar.";
      return;
    }
    $("#q").value = term;
    $("#qScope").value = $("#mobileFilterScope").value;
    $("#qBg").value = "";
    $("#qProps").checked = false;
    run();
  }
  $("#mobileFilterOnly").onclick = () => {
    if (!app.lastResults.length) return;
    app.isolate(app.lastResults);
    app.closeMobileSide();
  };
  $("#mobileFilterHide").onclick = () => {
    if (!app.lastResults.length) return;
    app.setVisible(app.lastResults, false);
    app.closeMobileSide();
  };
  $("#mobileFilterAll").onclick = () => { if (app.tree) app.showAll(); app.closeMobileSide(); };
  $("#mobileAdvancedSearch").onclick = () => {
    const open = $("#searchTab").classList.toggle("advancedSearch");
    $("#mobileAdvancedSearch").setAttribute("aria-expanded", String(open));
    $("#mobileAdvancedSearch").textContent = open ? "Busca avançada ▴" : "Busca avançada ▾";
  };

  $("#qRun").onclick = run;
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
  $("#qBg").onchange = run;
  $("#qScope").onchange = () => { if ($("#q").value.trim() || $("#qBg").value) run(); };
  $("#qProps").onchange = () => { if ($("#q").value.trim()) run(); };

  function run() {
    const t = app.tree, P = t.props;
    const query = $("#q").value.trim();
    const bg = $("#qBg").value;
    const scope = $("#qScope").value;
    const inProps = $("#qProps").checked;
    if (!query && !bg) return;
    if (!normNames) normNames = t.names.map(norm);
    if (inProps && !normVals) normVals = P.vals.map(norm);

    // what a node offers to the text test: its name and, optionally, every property value
    let test;
    const re = /^\/(.+)\/$/.exec(query);
    if (query && re) {
      let rx;
      try { rx = new RegExp(re[1], "i"); } catch (e) { $("#qCount").textContent = "Expressão inválida: " + e.message; $("#qActions").hidden = false; return; }
      test = (n) => {
        if (rx.test(t.names[n])) return true;
        if (inProps) for (let i = P.start[n]; i < P.start[n + 1]; i++) if (rx.test(P.vals[P.kv[2 * i + 1]])) return true;
        return false;
      };
    } else if (query) {
      const terms = query.split(/\s+/).map(norm).filter(Boolean);
      if (!terms.length) return;
      test = (n) => {
        const parts = [normNames[n]];
        if (inProps) for (let i = P.start[n]; i < P.start[n + 1]; i++) parts.push(normVals[P.kv[2 * i + 1]]);
        return terms.every((w) => parts.some((s) => s.includes(w)));
      };
    }

    const eff = app.bigramaEff;
    const hits = [];
    for (let n = 0; n < app.nNodes; n++) {
      const part = t.part[n] >= 0;
      if ((scope === "parts" && !part) || (scope === "asm" && part)) continue;
      if (bg && (!eff || eff[n] !== bg)) continue;
      if (test && !test(n)) continue;
      hits.push(n);
    }
    showResults(hits);
  }

  function showResults(hits) {
    app.lastResults = hits;
    const parts = app.leafNodes(hits).length;
    $("#qActions").hidden = false;
    $("#qCount").textContent = `${fmt(hits.length)} resultado(s) · ${fmt(parts)} peça(s)` + (hits.length > MAX_ROWS ? ` · mostrando ${fmt(MAX_ROWS)}` : "");
    $("#mobileFilterHint").textContent = hits.length ? `${fmt(hits.length)} resultado(s) encontrado(s). Escolha o que mostrar.` : "Nenhum resultado. Tente outro nome ou tipo.";
    $("#mobileFilterOnly").disabled = hits.length === 0;
    $("#mobileFilterHide").disabled = hits.length === 0;
    const res = $("#results");
    res.innerHTML = "";
    for (const n of hits.slice(0, MAX_ROWS)) {
      const row = el("div.row", { title: app.path(n) }, el("span.nm", { text: app.tree.names[n] }));
      row._node = n;
      if (app.selNodes.has(n)) row.classList.add("sel");
      row.addEventListener("click", (e) => app.select([n], e.ctrlKey || e.metaKey ? "toggle" : "replace", { reveal: false }));
      row.addEventListener("dblclick", () => { app.select([n], "replace", { reveal: false }); app.frameNodes([n]); });
      res.append(row);
    }
    app.emit("results", hits);
  }
  app.showResults = (hits) => { app.showTab("searchTab"); showResults(hits); };

  app.on("selection", () => {
    for (const r of $("#results").children) r.classList.toggle("sel", app.selNodes.has(r._node));
  });

  document.querySelectorAll("#qActions [data-act]").forEach((b) => {
    b.onclick = () => {
      const hits = app.lastResults;
      if (!hits.length) return;
      switch (b.dataset.act) {
        case "select": app.select(hits, "replace", { reveal: false }); break;
        case "add": app.select(hits, "add", { reveal: false }); break;
        case "isolate": app.isolate(hits); break;
        case "hide": app.setVisible(hits, false); break;
        case "show": app.setVisible(hits, true); break;
        case "color": app.setColor(hits, parseHex($("#colorPick").value)); break;
        case "zoom": app.frameNodes(hits); break;
        case "list": app.openTable("res"); break;
      }
    };
  });
}
