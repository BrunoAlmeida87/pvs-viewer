// Parts list (BOM) with sorting, filtering and CSV export, plus grouped statistics.
import { $, el, fmt, num, csv, download } from "./util.js";

const ROW_H = 22;

export function initTable(app) {
  const panel = $("#bom"), head = $("#bomHead"), body = $("#bomBody"), rowsEl = $("#bomRows"), spacer = $("#bomSpacer");
  let tab = "list", cols = [], rows = [], sortCol = -1, sortDir = 1, numericCol = new Map();
  let statRows = [], weightKey = -1, dirty = true;

  app.on("model", () => {
    const keys = app.tree.props.keys;
    cols = [{ id: "name", label: "Nome", w: 320 }, { id: "lvl1", label: "Seção", w: 110 }, { id: "lvl2", label: "Subsistema", w: 200 }];
    for (const k of keys) if (k !== "libelle" && k !== "part_objectid") cols.push({ id: "k:" + k, label: k, w: 110, ki: keys.indexOf(k) });
    if (keys.includes("part_objectid")) cols.push({ id: "k:part_objectid", label: "part_objectid", w: 200, ki: keys.indexOf("part_objectid") });
    weightKey = keys.indexOf("Unit weight");
    const sk = $("#statsKey");
    sk.innerHTML = "";
    sk.append(el("option", { value: "lvl1", text: "Seção (nível 1)" }), el("option", { value: "lvl2", text: "Subsistema (nível 2)" }));
    for (const k of keys) if (k !== "libelle" && k !== "part_objectid") sk.append(el("option", { value: "k:" + k, text: k }));
    if (keys.includes("Material")) sk.value = "k:Material";
    numericCol.clear();
    sortCol = -1;
    dirty = true;
  });

  function cell(c, n) {
    if (c.id === "name") return app.tree.names[n];
    if (c.id === "lvl1" || c.id === "lvl2") { const a = app.levelNode(n, c.id === "lvl1" ? 1 : 2); return a < 0 ? "" : app.tree.names[a]; }
    return app.prop(n, c.ki) ?? "";
  }

  function isNumeric(c) {
    if (numericCol.has(c.id)) return numericCol.get(c.id);
    let seen = 0, numbers = 0;
    for (let p = 0; p < app.nParts && seen < 2000; p += Math.max(1, Math.floor(app.nParts / 2000))) {
      const v = cell(c, app.partNode[p]);
      if (v === "") continue;
      seen++;
      if (!isNaN(num(v))) numbers++;
    }
    const r = seen > 0 && numbers / seen > 0.9;
    numericCol.set(c.id, r);
    return r;
  }

  function scopeNodes() {
    const s = $("#bomScope").value;
    if (s === "sel") return app.leafNodes([...app.selNodes]);
    if (s === "res") return app.leafNodes(app.lastResults);
    const out = [];
    for (let p = 0; p < app.nParts; p++) if (s === "all" || app.partVisible[p]) out.push(app.partNode[p]);
    return out;
  }

  function filtered() {
    let nodes = scopeNodes();
    const f = $("#bomFilter").value.trim().toLowerCase();
    if (f) nodes = nodes.filter((n) => cols.some((c) => cell(c, n).toLowerCase().includes(f)));
    return nodes;
  }

  function rebuild() {
    dirty = false;
    if (tab === "list") buildList(); else buildStats();
  }

  // ------------------------------------------------------------ list
  function buildList() {
    rows = filtered();
    if (sortCol >= 0) {
      const c = cols[sortCol], numeric = isNumeric(c);
      const key = rows.map((n) => cell(c, n));
      const idx = rows.map((_, i) => i);
      const coll = new Intl.Collator("pt-BR", { numeric: true, sensitivity: "base" });
      idx.sort((a, b) => {
        let r;
        if (numeric) { const x = num(key[a]), y = num(key[b]); r = (isNaN(x) ? Infinity : x) - (isNaN(y) ? Infinity : y); }
        else r = coll.compare(key[a], key[b]);
        return r * sortDir;
      });
      rows = idx.map((i) => rows[i]);
    }
    head.innerHTML = "";
    cols.forEach((c, i) => {
      const h = el("div.bc", { text: c.label + (i === sortCol ? (sortDir > 0 ? " ▲" : " ▼") : ""), title: "Ordenar por " + c.label });
      h.style.width = c.w + "px";
      h.onclick = () => { if (sortCol === i) sortDir = -sortDir; else { sortCol = i; sortDir = 1; } buildList(); };
      head.append(h);
    });
    const width = cols.reduce((s, c) => s + c.w, 0);
    spacer.style.height = rows.length * ROW_H + "px";
    spacer.style.width = width + "px";
    rowsEl.style.width = width + "px";
    $("#bomCount").textContent = `${fmt(rows.length)} peça(s)`;
    draw();
  }

  function draw() {
    if (tab !== "list") return;
    const first = Math.floor(body.scrollTop / ROW_H);
    const count = Math.ceil(body.clientHeight / ROW_H) + 4;
    rowsEl.style.transform = `translateY(${first * ROW_H}px)`;
    rowsEl.innerHTML = "";
    for (let i = first; i < Math.min(rows.length, first + count); i++) {
      const n = rows[i];
      const r = el("div.br");
      if (app.selNodes.has(n)) r.classList.add("sel");
      for (const c of cols) {
        const v = cell(c, n);
        const d = el("div.bc", { text: v, title: v });
        d.style.width = c.w + "px";
        if (c.id !== "name" && isNumeric(c)) d.classList.add("num");
        r.append(d);
      }
      r.onclick = (e) => app.select([n], e.ctrlKey || e.metaKey ? "toggle" : "replace", { reveal: false });
      r.ondblclick = () => app.frameNodes([n]);
      rowsEl.append(r);
    }
  }

  // ------------------------------------------------------------ statistics
  function groupValue(spec) {
    if (spec === "lvl1" || spec === "lvl2") {
      const lv = spec === "lvl1" ? 1 : 2;
      return (n) => { const a = app.levelNode(n, lv); return a < 0 ? "" : app.tree.names[a]; };
    }
    const ki = app.keyIndex(spec.slice(2));
    return (n) => app.prop(n, ki) ?? "";
  }

  function buildStats() {
    const nodes = filtered();
    const g = groupValue($("#statsKey").value);
    const groups = new Map();
    for (const n of nodes) {
      const v = g(n);
      let s = groups.get(v);
      if (!s) groups.set(v, (s = { value: v, count: 0, weight: 0, nodes: [] }));
      s.count++;
      s.nodes.push(n);
      if (weightKey >= 0) { const w = num(app.prop(n, weightKey)); if (!isNaN(w)) s.weight += w; }
    }
    statRows = [...groups.values()].sort((a, b) => b.count - a.count);
    const total = nodes.length || 1;
    const sc = [{ label: "Valor", w: 320 }, { label: "Peças", w: 90 }, { label: "%", w: 70 }];
    if (weightKey >= 0) sc.push({ label: "Soma Unit weight", w: 180 });
    head.innerHTML = "";
    for (const c of sc) { const h = el("div.bc", { text: c.label }); h.style.width = c.w + "px"; head.append(h); }
    spacer.style.height = "0px";
    rowsEl.style.transform = "none";
    rowsEl.innerHTML = "";
    rowsEl.style.width = sc.reduce((s, c) => s + c.w, 0) + "px";
    for (const s of statRows) {
      const vals = [s.value || "(sem valor)", fmt(s.count), ((100 * s.count) / total).toFixed(1)];
      if (weightKey >= 0) vals.push(s.weight ? s.weight.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) : "");
      const r = el("div.br", { title: "Clique para selecionar · Ctrl+clique soma" });
      vals.forEach((v, i) => { const d = el("div.bc", { text: v }); d.style.width = sc[i].w + "px"; if (i) d.classList.add("num"); r.append(d); });
      r.onclick = (e) => app.select(s.nodes, e.ctrlKey || e.metaKey ? "add" : "replace", { reveal: false });
      r.ondblclick = () => app.frameNodes(s.nodes);
      rowsEl.append(r);
    }
    $("#bomCount").textContent = `${fmt(nodes.length)} peça(s) · ${fmt(statRows.length)} grupo(s)`;
  }

  // ------------------------------------------------------------ export
  $("#bomCsv").onclick = () => {
    const base = (app.title || "modelo").replace(/\.pvs$/i, "");
    if (tab === "list") {
      const out = [cols.map((c) => c.label), ...rows.map((n) => cols.map((c) => cell(c, n)))];
      download(base + "-pecas.csv", csv(out));
    } else {
      const out = [["Valor", "Peças", ...(weightKey >= 0 ? ["Soma Unit weight"] : [])],
        ...statRows.map((s) => [s.value, s.count, ...(weightKey >= 0 ? [String(s.weight).replace(".", ",")] : [])])];
      download(base + "-estatisticas.csv", csv(out));
    }
  };

  // ------------------------------------------------------------ wiring
  app.openTable = (scope) => {
    if (scope) $("#bomScope").value = scope;
    panel.hidden = false;
    $("#view").classList.add("bomOpen");
    $("#listBtn").classList.add("on");
    rebuild();
  };
  $("#listBtn").onclick = () => {
    if (panel.hidden) app.openTable();
    else close();
  };
  const close = () => { panel.hidden = true; $("#view").classList.remove("bomOpen"); $("#listBtn").classList.remove("on"); };
  $("#bomClose").onclick = close;
  document.querySelectorAll("#bom [data-btab]").forEach((b) => {
    b.onclick = () => {
      tab = b.dataset.btab;
      document.querySelectorAll("#bom [data-btab]").forEach((x) => x.classList.toggle("on", x === b));
      $("#groupBy").hidden = tab !== "stats";
      body.scrollTop = 0;
      rebuild();
    };
  });
  $("#bomScope").onchange = rebuild;
  $("#statsKey").onchange = rebuild;
  let ft = 0;
  $("#bomFilter").oninput = () => { clearTimeout(ft); ft = setTimeout(rebuild, 250); };
  body.addEventListener("scroll", () => { head.scrollLeft = body.scrollLeft; draw(); });
  window.addEventListener("resize", () => { if (!panel.hidden) draw(); });

  let st = 0;
  const later = () => { clearTimeout(st); st = setTimeout(() => { if (!panel.hidden) rebuild(); else dirty = true; }, 150); };
  app.on("selection", () => {
    const s = $("#bomScope").value;
    if (s === "sel") later();
    else if (!panel.hidden && tab === "list") draw();
  });
  app.on("state", () => { if ($("#bomScope").value === "vis") later(); });
  app.on("results", () => { if ($("#bomScope").value === "res") later(); });
  app.on("loaded", () => { if (!panel.hidden && dirty) rebuild(); });
}
