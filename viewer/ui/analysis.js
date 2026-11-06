// Analysis panel: comparison with another version of the model, and interference / contact check.
import { $, el, fmt, num } from "./util.js";
import { parsePVS, buildTree } from "../lib/pvs.js";
import { geomClient } from "../lib/geomclient.js";
import { mm } from "./measure.js";

const SAME = 0xc9ced6, CHANGED = 0xf08c00, REMOVED = 0xe03131;

// Key of each part for matching two versions: part_objectid when present, else the path of
// names; repeated keys (several instances) get #2, #3...
function partKeys(t) {
  const P = t.props, ko = P.keys.indexOf("part_objectid");
  const nParts = t.shapes.length, keys = new Array(nParts), seen = new Map();
  const node = new Int32Array(nParts).fill(-1);
  t.part.forEach((p, n) => { if (p >= 0) node[p] = n; });
  const pathOf = (n) => { const a = []; for (let x = n; x >= 0; x = t.parent[x]) a.push(t.names[x]); return a.reverse().join("/"); };
  for (let p = 0; p < nParts; p++) {
    const n = node[p];
    let k = null;
    if (ko >= 0 && n >= 0) for (let i = P.start[n]; i < P.start[n + 1]; i++) if (P.kv[2 * i] === ko) { k = P.vals[P.kv[2 * i + 1]]; break; }
    if (!k) k = n >= 0 ? pathOf(n) : "#" + p;
    const c = (seen.get(k) || 0) + 1;
    seen.set(k, c);
    keys[p] = c > 1 ? k + "#" + c : k;
  }
  return { keys, node };
}

export function initAnalysis(app) {
  app.geom = app.geom || geomClient(app);
  const panel = $("#analysisPanel");
  $("#analysisBtn").onclick = () => {
    panel.hidden = !panel.hidden;
    $("#analysisBtn").classList.toggle("on", !panel.hidden);
  };
  panel.querySelector("[data-close]").addEventListener("click", () => $("#analysisBtn").classList.remove("on"));

  // ------------------------------------------------------------ comparison
  $("#cmpPick").onclick = () => $("#cmpFile").click();
  $("#cmpFile").onchange = async () => {
    const f = $("#cmpFile").files[0];
    $("#cmpFile").value = "";
    if (!f || !app.tree) return;
    const out = $("#cmpResult");
    out.innerHTML = "";
    out.append(el("div.muted", { text: "Lendo " + f.name + "…" }));
    await new Promise((r) => setTimeout(r, 30));
    let other;
    try { other = buildTree(parsePVS(await f.arrayBuffer()).components); }
    catch (e) { out.innerHTML = ""; out.append(el("div.warn", { text: "Não foi possível ler: " + e.message })); return; }
    compare(other, f.name);
  };

  function compare(other, name) {
    const tol = (num($("#cmpTol").value) || 2) / 1000;
    const cur = partKeys(app.tree), oth = partKeys(other);
    const byKey = new Map();
    oth.keys.forEach((k, p) => byKey.set(k, p));
    const curBox = app.pvsBoxes || app.partBoxes();
    const status = new Uint8Array(app.nParts); // 0 same, 1 changed, 2 removed
    const matched = new Uint8Array(other.shapes.length);
    let nSame = 0, nChanged = 0, nRemoved = 0;
    for (let p = 0; p < app.nParts; p++) {
      const q = byKey.get(cur.keys[p]);
      if (q === undefined) { status[p] = 2; nRemoved++; continue; }
      matched[q] = 1;
      const b = other.boxes[q] && other.boxes[q].some((v) => v !== 0) ? other.boxes[q] : null;
      let curHas = false;
      for (let i = 0; i < 6; i++) if (curBox[p * 6 + i] !== 0) curHas = true;
      let diff = 0;
      if (b && curHas) for (let i = 0; i < 6; i++) diff = Math.max(diff, Math.abs(b[i] - curBox[p * 6 + i]));
      else if (!!b !== curHas) diff = Infinity; // box only on one side
      if (diff > tol) { status[p] = 1; nChanged++; } else nSame++;
    }
    const added = [];
    for (let q = 0; q < other.shapes.length; q++) if (!matched[q]) added.push(q);
    const rule = new Int32Array(app.nParts);
    for (let p = 0; p < app.nParts; p++) rule[p] = status[p] === 0 ? SAME : status[p] === 1 ? CHANGED : REMOVED;
    app.ruleSpec = "cmp";
    app.setRule(rule);
    app.showLegend(`Comparação com ${name}`, [
      { label: "Alteradas (posição ou tamanho)", color: CHANGED, count: nChanged, match: (p) => status[p] === 1 },
      { label: "Só nesta versão (removidas na outra)", color: REMOVED, count: nRemoved, match: (p) => status[p] === 2 },
      { label: "Iguais", color: SAME, count: nSame, match: (p) => status[p] === 0 },
    ]);
    const out = $("#cmpResult");
    out.innerHTML = "";
    out.append(el("div", null, el("b", { text: `${fmt(nChanged)} alteradas · ${fmt(nRemoved)} só nesta versão · ${fmt(added.length)} novas na outra · ${fmt(nSame)} iguais` })));
    const sel = (st) => { const nodes = []; for (let p = 0; p < app.nParts; p++) if (status[p] === st) nodes.push(app.partNode[p]); app.select(nodes, "replace", { reveal: false }); };
    out.append(el("div.row2", null,
      el("button", { text: "Selecionar alteradas", onclick: () => sel(1) }),
      el("button", { text: "Selecionar removidas", onclick: () => sel(2) })));
    if (added.length) {
      const onode = new Int32Array(other.shapes.length).fill(-1);
      other.part.forEach((p, n) => { if (p >= 0) onode[p] = n; });
      const box = el("div.cmpAdded");
      box.append(el("div.muted", { text: `Novas na outra versão (não estão neste modelo)${added.length > 300 ? ", primeiras 300" : ""}:` }));
      for (const q of added.slice(0, 300)) box.append(el("div", { text: other.names[onode[q]] || other.shapes[q], title: other.shapes[q] }));
      out.append(box);
    }
    if (!app.pvsBoxes) out.append(el("p.hint", { text: "Este modelo foi aberto de uma pasta convertida: a comparação usa as caixas da geometria, o que pode marcar como alteradas peças cuja caixa no .pvs era imprecisa. Abrindo a pasta original a comparação é exata." }));
  }

  // ------------------------------------------------------------ interference
  let stop = false, running = false;
  $("#intStop").onclick = () => { stop = true; };
  $("#intRun").onclick = async () => {
    if (running) return;
    if (!app.selNodes.size) { $("#intStatus").textContent = "Selecione as peças a verificar."; return; }
    if (!app.canReadGeometry()) { $("#intStatus").textContent = "É preciso abrir a pasta original do modelo ou uma pasta convertida no formato novo."; return; }
    running = true; stop = false;
    try { await runInterference(); } finally { running = false; }
  };

  async function runInterference() {
    const tol = (num($("#intTol").value) || 0) / 1000;
    const scope = $("#intScope").value;
    const S = app.selectedParts().filter((p) => app.isLoaded(p));
    const B = app.partBoxes();
    const T = [];
    if (scope === "sel") T.push(...S);
    else for (let p = 0; p < app.nParts; p++) if (app.partVisible[p] && app.isLoaded(p)) T.push(p);
    const MAX_PAIRS = 5000, pairs = [];
    const inSel = new Uint8Array(app.nParts);
    for (const p of S) inSel[p] = 1;
    for (const a of S) {
      const o = a * 6;
      for (const b of T) {
        if (b === a || (inSel[b] && b < a)) continue;
        const q = b * 6;
        if (B[o] <= B[q + 3] + tol && B[q] <= B[o + 3] + tol && B[o + 1] <= B[q + 4] + tol && B[q + 1] <= B[o + 4] + tol &&
            B[o + 2] <= B[q + 5] + tol && B[q + 2] <= B[o + 5] + tol) pairs.push([a, b]);
        if (pairs.length >= MAX_PAIRS) break;
      }
      if (pairs.length >= MAX_PAIRS) break;
    }
    const list = $("#intList");
    list.innerHTML = "";
    const hits = [];
    const t0 = performance.now();
    for (let i = 0; i < pairs.length && !stop; i++) {
      if (i % 10 === 0) $("#intStatus").textContent = `Verificando ${fmt(i)}/${fmt(pairs.length)} pares com caixas sobrepostas… ${fmt(hits.length)} encontrado(s)`;
      const [a, b] = pairs[i];
      const ka = await app.geom.part(a), kb = await app.geom.part(b);
      if (!ka || !kb) continue;
      const r = await app.geom.pair(ka, kb, tol);
      if (r.error) continue;
      if (r.crossings || r.d <= tol) {
        const h = { a, b, cross: r.crossings > 0, d: r.d };
        hits.push(h);
        addRow(h);
      }
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(0);
    const nCross = hits.filter((h) => h.cross).length;
    $("#intStatus").textContent = (stop ? "Interrompido. " : "") +
      `${fmt(pairs.length)} pares verificados em ${secs}s: ${fmt(nCross)} interferência(s), ${fmt(hits.length - nCross)} contato(s)` +
      (pairs.length >= MAX_PAIRS ? ` · limite de ${fmt(MAX_PAIRS)} pares: selecione menos peças` : "");
    if (hits.length) {
      list.prepend(el("div.row2", null,
        el("button", { text: "Selecionar interferências", onclick: () => { const s = new Set(); for (const h of hits) if (h.cross) { s.add(app.partNode[h.a]); s.add(app.partNode[h.b]); } app.select([...s], "replace", { reveal: false }); } }),
        el("button", { text: "Selecionar todos", onclick: () => { const s = new Set(); for (const h of hits) { s.add(app.partNode[h.a]); s.add(app.partNode[h.b]); } app.select([...s], "replace", { reveal: false }); } })));
    }
  }
  function addRow(h) {
    const na = app.tree.names[app.partNode[h.a]], nb = app.tree.names[app.partNode[h.b]];
    const row = el("div.intRow" + (h.cross ? ".warn" : ""), { title: "Clique para selecionar e enquadrar o par" },
      el("b", { text: h.cross ? "Interferência" : `Contato ${mm(h.d)}` }), el("div", { text: na }), el("div", { text: nb }));
    row.onclick = () => { const n = [app.partNode[h.a], app.partNode[h.b]]; app.select(n, "replace", { reveal: false }); app.frameNodes(n); };
    $("#intList").append(row);
  }
  app.on("model", () => { $("#cmpResult").innerHTML = ""; $("#intList").innerHTML = ""; $("#intStatus").textContent = ""; app.geom.forget(); });
}
