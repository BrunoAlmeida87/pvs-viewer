// Saved views (camera, visibility, colours, display, section, exploded view, selection, notes,
// measurements), sharing by link or file, PNG capture, 3D notes and Creo View figures (ann*.ast).
import { $, el, fmt, store } from "./util.js";
import { parseAST } from "../lib/ast.js";

const SVGNS = "http://www.w3.org/2000/svg";

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

async function pack(obj) {
  const data = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(data).arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function unpack(text) {
  const b = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(b, (c) => c.charCodeAt(0));
  const data = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return JSON.parse(await new Response(data).text());
}

function saveBlob(name, blob) {
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function initViews(app) {
  const key = () => "pvs-viewer:views:" + app.title;
  const load = () => store.get(key(), { views: [], notes: [] });
  const save = (d) => { if (!store.set(key(), d)) alert("Não foi possível salvar: o armazenamento do navegador está cheio ou bloqueado."); };
  const say = (t) => { $("#load").textContent = t; };
  let notes = [];

  // ------------------------------------------------------------ view state
  function capture() {
    // with the neighbourhood on, keep the visibility from before it plus its settings
    const base = app.nbSaved ? app.nbSaved() : null;
    return {
      nb: app.nbState ? app.nbState() : null,
      layers: [...app.hiddenLayers],
      v: 1, model: app.title, camera: app.getCamera(),
      display: { ...app.display, perf: undefined },
      clip: JSON.parse(JSON.stringify(app.clip)), explode: { ...app.explode },
      visible: runs(base ? base.visible : app.partVisible, 1), color: runs(app.partColor, -1), opacity: runs(base ? base.opacity : app.partOpacity, 255),
      rule: app.ruleSpec || "", ghost: app.ghost, sel: [...app.selNodes].slice(0, 20000),
      notes, measurements: app.measurements ? app.measurements() : [],
      markup: app.getMarkup ? app.getMarkup() : null,
      mannequins: app.getMannequins ? app.getMannequins() : [],
    };
  }
  function apply(s) {
    if (!s || !app.tree) return;
    if (app.nbApply) app.nbApply(null);
    if (Array.isArray(s.layers)) app.setLayersHidden(s.layers);
    app.partColor.fill(-1); app.partOpacity.fill(255); app.partVisible.fill(1);
    for (const [a, n, v] of s.color || []) app.partColor.fill(v, a, a + n);
    for (const [a, n, v] of s.opacity || []) app.partOpacity.fill(v, a, a + n);
    for (const [a, n, v] of s.visible || []) app.partVisible.fill(v, a, a + n);
    app.ghost = !!s.ghost;
    $("#ghost").classList.toggle("on", app.ghost);
    if (s.display) { const d = { ...s.display }; delete d.perf; app.setDisplay(d); }
    if (s.clip) app.setClip({ plane: null, ...s.clip }); // views saved before the free plane have none
    if (s.explode) {
      $("#exAmount").value = s.explode.amount || 0; $("#exLevel").value = s.explode.level ?? 1; $("#exSel").checked = !!s.explode.selOnly;
      app.setExplode(s.explode);
    }
    app.select((s.sel || []).filter((n) => n < app.nNodes), "replace", { reveal: false });
    if (s.rule) app.applyRule(s.rule); else { app.partRule = null; app.emit("rule", ""); app.refresh(); }
    if (s.notes) { notes = s.notes; renderNotes(); }
    if (s.measurements && app.setMeasurements) app.setMeasurements(s.measurements);
    if (s.nb && app.nbApply) app.nbApply(s.nb);
    if (app.setMannequins) app.setMannequins(s.mannequins || []);
    app.setCamera(s.camera);
    // hand markups belong to this camera (views saved before them have none)
    if (app.setMarkup) app.setMarkup(s.markup ? { cam: s.camera, items: s.markup.items } : null);
  }
  app.captureView = capture;
  app.applyView = apply;

  // ------------------------------------------------------------ saved views
  $("#viewSave").onclick = () => {
    const d = load();
    const name = $("#viewName").value.trim() || `Vista ${d.views.length + 1}`;
    d.views = d.views.filter((v) => v.name !== name);
    d.views.push({ name, state: capture() });
    save(d);
    $("#viewName").value = "";
    renderViews();
  };
  function renderViews() {
    const box = $("#viewList");
    box.innerHTML = "";
    const d = load();
    if (!d.views.length) box.append(el("div.muted", { text: "Nenhuma vista salva." }));
    for (const v of d.views) {
      box.append(el("div.item", null,
        el("span.nm", { text: v.name, title: v.name }),
        el("button", { text: "Aplicar", onclick: () => apply(v.state) }),
        el("button", { text: "Atualizar", title: "Substitui pela vista atual", onclick: () => { const x = load(); const y = x.views.find((z) => z.name === v.name); if (y) y.state = capture(); save(x); } }),
        el("button", { text: "✕", title: "Excluir", onclick: () => { const x = load(); x.views = x.views.filter((y) => y.name !== v.name); save(x); renderViews(); } })));
    }
  }

  // ------------------------------------------------------------ sharing
  $("#viewLink").onclick = async () => {
    const s = capture();
    const url = location.origin + location.pathname + location.search + "#vista=" + await pack(s);
    try { await navigator.clipboard.writeText(url); say(`Link copiado (${fmt(url.length)} caracteres). Quem abrir precisa abrir o mesmo modelo.`); }
    catch { prompt("Copie o link:", url); }
  };
  $("#viewExport").onclick = () => {
    const name = (app.title || "modelo").replace(/\.pvs$/i, "") + "-vista.json";
    saveBlob(name, new Blob([JSON.stringify(capture())], { type: "application/json" }));
  };
  $("#viewImport").onclick = () => $("#viewFile").click();
  $("#viewFile").onchange = async () => {
    const f = $("#viewFile").files[0];
    if (!f) return;
    try { apply(JSON.parse(await f.text())); say("Vista importada: " + f.name); } catch (e) { alert("Arquivo de vista inválido: " + e.message); }
    $("#viewFile").value = "";
  };
  app.on("loaded", async () => {
    const m = location.hash.match(/vista=([\w-]+)/);
    if (!m) return;
    try { apply(await unpack(m[1])); say("Vista do link aplicada."); } catch (e) { console.warn("link de vista inválido", e); }
  });

  // ------------------------------------------------------------ PNG
  $("#shotBtn").onclick = async () => {
    say("Gerando imagem…");
    try {
      const blob = await app.screenshot(+$("#shotScale").value);
      const name = (app.title || "modelo").replace(/\.pvs$/i, "") + "-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png";
      saveBlob(name, blob);
      say("Imagem salva: " + name);
    } catch (e) { say("Erro ao gerar imagem: " + e.message); }
  };

  // ------------------------------------------------------------ 3D notes
  const svg = $("#overlay");
  const layer = document.createElementNS(SVGNS, "g");
  svg.append(layer);
  let pending = null, prevTool = null;
  const saveNotes = () => { const d = load(); d.notes = notes; save(d); };
  $("#noteNew").onclick = () => {
    prevTool = app.tool;
    say("Clique no ponto do modelo onde vai a nota.");
    $("#noteNew").classList.add("on");
    app.tool = (info) => {
      app.tool = prevTool;
      $("#noteNew").classList.remove("on");
      if (!info.point) { say("Nenhuma peça nesse ponto."); return; }
      pending = { p: info.point, node: info.node };
      $("#noteEditor").hidden = false;
      $("#noteText").value = "";
      $("#noteText").focus();
      draw();
    };
  };
  $("#noteOk").onclick = () => {
    const text = $("#noteText").value.trim();
    if (pending && text) { notes.push({ id: Date.now(), p: pending.p, node: pending.node, text }); saveNotes(); say("Nota salva."); }
    pending = null;
    $("#noteEditor").hidden = true;
    renderNotes();
  };
  $("#noteCancel").onclick = () => { pending = null; $("#noteEditor").hidden = true; draw(); };
  $("#noteShow").onchange = draw;
  function renderNotes() {
    const box = $("#noteList");
    box.innerHTML = "";
    if (!notes.length) box.append(el("div.muted", { text: "Nenhuma nota." }));
    notes.forEach((n, i) => {
      box.append(el("div.item", null,
        el("span.nm", { text: `${i + 1}. ${n.text}`, title: n.text }),
        el("button", { text: "Ver", onclick: () => { if (n.node >= 0 && n.node < app.nNodes) app.frameNodes([n.node]); } }),
        el("button", { text: "✕", title: "Excluir", onclick: () => { notes.splice(i, 1); saveNotes(); renderNotes(); } })));
    });
    draw();
  }
  const mk = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  function draw() {
    layer.innerHTML = "";
    if (!$("#noteShow").checked) return;
    const all = pending ? [...notes, { p: pending.p, text: "…" }] : notes;
    all.forEach((n, i) => {
      const A = app.project(n.p);
      if (!A) return;
      const text = (i + 1) + ". " + (n.text.length > 48 ? n.text.slice(0, 47) + "…" : n.text);
      const bx = A[0] + 34, by = A[1] - 44, w = text.length * 6.6 + 14;
      layer.append(mk("line", { x1: A[0], y1: A[1], x2: bx, y2: by + 10, stroke: "#1d2330", "stroke-width": 1.2 }));
      layer.append(mk("circle", { cx: A[0], cy: A[1], r: 3.5, fill: "#ffd43b", stroke: "#1d2330", "stroke-width": 1.2 }));
      layer.append(mk("rect", { x: bx, y: by, width: w, height: 21, rx: 4, fill: "#fff9db", stroke: "#e0b000" }));
      const t = mk("text", { x: bx + 7, y: by + 15, fill: "#1d2330", "font-size": 12, "font-family": "Segoe UI, sans-serif" });
      t.textContent = text;
      layer.append(t);
    });
  }
  app.on("frame", draw);

  // ------------------------------------------------------------ Creo View figures (ann*.ast)
  async function loadFigures() {
    const box = $("#figList");
    box.innerHTML = "";
    let names = [];
    try { names = await app.listModelFiles(/^ann\d+\.ast$/i); } catch { /* none */ }
    if (!names.length) { box.append(el("div.muted", { text: app.access ? "Nenhuma figura (ann*.ast) na pasta do modelo." : "Disponível ao abrir a pasta original do modelo." })); return; }
    for (const n of names) {
      const row = el("div.item", null, el("span.nm", { text: n }));
      box.append(row);
      try {
        const f = await app.readModelFile(n);
        const fig = parseAST(await f.arrayBuffer());
        row.firstChild.textContent = `${fig.name || n} (${fmt(fig.records.length)})`;
        row.firstChild.title = n;
        row.append(el("button", { text: "Aplicar", onclick: () => applyFigure(fig) }));
      } catch (e) { row.append(el("span.muted", { text: " ilegível" })); console.warn(n, e); }
    }
  }
  function applyFigure(fig) {
    const t = app.tree;
    const vis = new Uint8Array(app.nParts);
    app.partColor.fill(-1);
    app.partOpacity.fill(255);
    let found = 0, missing = 0;
    for (const r of fig.records) {
      let n = 0;
      for (const k of r.path) { const kids = app.kids(n); n = k < kids.length ? kids[k] : -1; if (n < 0) break; }
      if (n < 0) { missing++; continue; }
      found++;
      vis.fill(1, t.p0[n], t.p1[n]);
      if (r.color) app.partColor.fill((Math.round(r.color[0] * 255) << 16) | (Math.round(r.color[1] * 255) << 8) | Math.round(r.color[2] * 255), t.p0[n], t.p1[n]);
      if (r.opacity != null && r.opacity < 1) app.partOpacity.fill(Math.max(8, Math.round(r.opacity * 255)), t.p0[n], t.p1[n]);
    }
    app.partVisible.set(vis);
    app.partRule = null;
    app.emit("rule", "");
    app.refresh();
    const shown = [];
    for (let p = 0; p < app.nParts; p++) if (vis[p]) shown.push(app.partNode[p]);
    if (shown.length) app.frameNodes(shown);
    say(`Figura “${fig.name}”: ${fmt(found)} componentes aplicados` + (missing ? ` · ${fmt(missing)} não existem nesta versão do modelo` : ""));
  }

  app.on("model", () => {
    notes = load().notes || [];
    renderViews();
    renderNotes();
  });
  app.on("loaded", loadFigures);
}
