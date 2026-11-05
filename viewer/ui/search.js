// Search tab: text / regex / property conditions combined with AND / OR, and actions on the results.
import { $, el, fmt, num, parseHex } from "./util.js";

const NEGATIVE = new Set(["notcontains", "empty", "ne"]);
const NO_VALUE = new Set(["exists", "empty"]);
const MAX_ROWS = 1000;

export function initSearch(app) {
  let lowerNames = null, lowerVals = null;

  function fieldOptions(sel, withAny = true) {
    sel.innerHTML = "";
    sel.append(el("option", { value: "name", text: "Nome" }));
    if (withAny) sel.append(el("option", { value: "*", text: "Qualquer campo" }));
    for (const k of app.tree.props.keys) if (k !== "libelle") sel.append(el("option", { value: k, text: k }));
  }

  app.on("model", () => {
    lowerNames = lowerVals = null;
    fieldOptions($("#qField"));
    $("#conds").innerHTML = "";
    $("#results").innerHTML = "";
    $("#qActions").hidden = true;
    app.lastResults = [];
  });

  $("#addCond").onclick = () => addCond();
  function addCond() {
    const f = el("select"), o = $("#qOp").cloneNode(true), v = el("input", { placeholder: "valor" });
    fieldOptions(f);
    const row = el("div.cond", null, f, o, v, el("button", { text: "✕", title: "Remover", onclick: () => row.remove() }));
    row._get = () => ({ field: f.value, op: o.value, value: v.value });
    v.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
    $("#conds").append(row);
    v.focus();
  }

  $("#qRun").onclick = run;
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });

  function conditions() {
    let value = $("#q").value, op = $("#qOp").value;
    const m = /^\/(.+)\/$/.exec(value.trim());
    if (m) { value = m[1]; op = "regex"; }
    const list = [{ field: $("#qField").value, op, value }];
    for (const r of $("#conds").children) list.push(r._get());
    return list.filter((c) => NO_VALUE.has(c.op) || c.value.trim() !== "");
  }

  function makeTest(op, value, cs) {
    const raw = value.trim();
    const v = cs ? raw : raw.toLowerCase();
    const n = num(raw);
    switch (op) {
      case "contains": return (s) => s.includes(v);
      case "notcontains": return (s) => !s.includes(v);
      case "starts": return (s) => s.startsWith(v);
      case "equals": {
        if (!v.includes("*")) return (s) => s === v;
        const re = new RegExp("^" + v.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "s");
        return (s) => re.test(s);
      }
      case "regex": {
        const re = new RegExp(raw, cs ? "" : "i");
        return (s, orig) => re.test(orig);
      }
      case "gt": return (s) => num(s) > n;
      case "lt": return (s) => num(s) < n;
      case "ge": return (s) => num(s) >= n;
      case "le": return (s) => num(s) <= n;
      case "ne": return (s) => (isNaN(n) ? s !== v : num(s) !== n);
      case "exists": return (s) => s !== "";
      case "empty": return (s) => s === "";
    }
    return () => false;
  }

  function run() {
    const conds = conditions();
    if (!conds.length) return;
    const cs = $("#qCase").checked;
    const scope = $("#qScope").value;
    const join = $("#qJoin").value;
    const t = app.tree, P = t.props;
    if (!cs && !lowerNames) { lowerNames = t.names.map((s) => s.toLowerCase()); lowerVals = P.vals.map((s) => s.toLowerCase()); }
    let compiled;
    try {
      compiled = conds.map((c) => ({ ...c, ki: c.field === "name" || c.field === "*" ? -1 : P.keys.indexOf(c.field), test: makeTest(c.op, c.value, cs) }));
    } catch (e) {
      $("#qCount").textContent = "Expressão inválida: " + e.message;
      $("#qActions").hidden = false;
      return;
    }
    const names = cs ? t.names : lowerNames, vals = cs ? P.vals : lowerVals;
    const value = (n, ki) => {
      for (let i = P.start[n]; i < P.start[n + 1]; i++) if (P.kv[2 * i] === ki) return P.kv[2 * i + 1];
      return -1;
    };
    const check = (n, c) => {
      if (c.field === "name") return c.test(names[n], t.names[n]);
      if (c.field === "*") {
        const neg = NEGATIVE.has(c.op);
        let r = c.test(names[n], t.names[n]);
        if (neg ? !r : r) return r;
        for (let i = P.start[n]; i < P.start[n + 1]; i++) {
          const vi = P.kv[2 * i + 1];
          r = c.test(vals[vi], P.vals[vi]);
          if (neg ? !r : r) return r;
        }
        return r;
      }
      const vi = c.ki < 0 ? -1 : value(n, c.ki);
      return vi < 0 ? c.test("", "") : c.test(vals[vi], P.vals[vi]);
    };
    const hits = [];
    for (let n = 0; n < app.nNodes; n++) {
      const part = t.part[n] >= 0;
      if ((scope === "parts" && !part) || (scope === "asm" && part)) continue;
      let ok = join === "and";
      for (const c of compiled) {
        const r = check(n, c);
        if (join === "and" && !r) { ok = false; break; }
        if (join === "or" && r) { ok = true; break; }
      }
      if (ok) hits.push(n);
    }
    showResults(hits);
  }

  function showResults(hits) {
    app.lastResults = hits;
    const parts = app.leafNodes(hits).length;
    $("#qActions").hidden = false;
    $("#qCount").textContent = `${fmt(hits.length)} resultado(s) · ${fmt(parts)} peça(s)` + (hits.length > MAX_ROWS ? ` · mostrando ${fmt(MAX_ROWS)}` : "");
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
