// Colour tools: manual colour/opacity, ghost mode and "colour by rule" with a legend.
import { $, el, fmt, num, palette, ramp, hex, parseHex } from "./util.js";

const MAX_CATS = 40;
const NONE = 0xd4d4d4, OTHER = 0xa8a8a8;

export function initColors(app) {
  const ruleSel = $("#rule"), legend = $("#legend");
  app.ruleSpec = "";

  app.on("model", () => {
    ruleSel.innerHTML = "";
    ruleSel.append(el("option", { value: "", text: "cor original" }),
      el("option", { value: "lvl:1", text: "seção (nível 1)" }),
      el("option", { value: "lvl:2", text: "subsistema (nível 2)" }));
    for (const k of app.tree.props.keys) if (k !== "libelle" && k !== "part_objectid") ruleSel.append(el("option", { value: "key:" + k, text: k }));
    ruleSel.append(el("option", { value: "rand", text: "cor por peça" }));
    ruleSel.value = "";
    legend.hidden = true;
  });

  const sel = () => [...app.selNodes];
  $("#colorApply").onclick = () => { if (app.selNodes.size) app.setColor(sel(), parseHex($("#colorPick").value)); };
  $("#opacityApply").onclick = () => {
    if (app.selNodes.size) app.setOpacity(sel(), Math.round(($("#opacity").value / 100) * 255));
  };
  $("#ghost").onclick = () => { app.setGhost(!app.ghost); $("#ghost").classList.toggle("on", app.ghost); };
  $("#resetColors").onclick = () => app.resetColors();
  ruleSel.onchange = () => app.applyRule(ruleSel.value);
  app.on("rule", (spec) => {
    ruleSel.value = spec || "";
    if (!spec) { legend.hidden = true; app.ruleSpec = ""; }
  });

  // value of a part for a rule spec
  function valueFn(spec) {
    const t = app.tree;
    if (spec.startsWith("lvl:")) {
      const lv = +spec.slice(4);
      return (p) => { const a = app.levelNode(app.partNode[p], lv); return a < 0 ? "" : t.names[a]; };
    }
    if (spec.startsWith("key:")) {
      const ki = app.keyIndex(spec.slice(4));
      return (p) => app.prop(app.partNode[p], ki) ?? "";
    }
    return null;
  }

  app.applyRule = function (spec) {
    app.ruleSpec = spec;
    if (!spec) { app.setRule(null); legend.hidden = true; app.emit("rule", ""); return; }
    const n = app.nParts, rule = new Int32Array(n);
    if (spec === "rand") {
      for (let p = 0; p < n; p++) rule[p] = palette(p % 997);
      app.setRule(rule);
      showLegend("Cor por peça", []);
      return;
    }
    const f = valueFn(spec);
    const vals = new Array(n);
    const count = new Map();
    for (let p = 0; p < n; p++) { const v = f(p); vals[p] = v; count.set(v, (count.get(v) || 0) + 1); }
    const distinct = [...count.keys()].filter((v) => v !== "");
    const numeric = distinct.length > 12 && distinct.every((v) => !isNaN(num(v)));
    const entries = [];
    if (numeric) {
      let lo = Infinity, hi = -Infinity;
      for (const v of distinct) { const x = num(v); if (x < lo) lo = x; if (x > hi) hi = x; }
      const B = 8, span = hi - lo || 1;
      const bucket = (x) => Math.min(B - 1, Math.floor(((x - lo) / span) * B));
      const bc = new Array(B).fill(0);
      for (let p = 0; p < n; p++) {
        if (vals[p] === "") { rule[p] = NONE; continue; }
        const b = bucket(num(vals[p]));
        rule[p] = ramp(b / (B - 1));
        bc[b]++;
      }
      for (let b = 0; b < B; b++) {
        const a = lo + (span * b) / B, z = lo + (span * (b + 1)) / B;
        entries.push({ label: `${trim(a)} – ${trim(z)}`, color: ramp(b / (B - 1)), count: bc[b],
          match: (p) => vals[p] !== "" && bucket(num(vals[p])) === b });
      }
    } else {
      const sorted = distinct.sort((a, b) => count.get(b) - count.get(a));
      const colorOf = new Map();
      sorted.slice(0, MAX_CATS).forEach((v, i) => colorOf.set(v, palette(i)));
      for (let p = 0; p < n; p++) rule[p] = vals[p] === "" ? NONE : colorOf.get(vals[p]) ?? OTHER;
      for (const v of sorted.slice(0, MAX_CATS)) entries.push({ label: v, color: colorOf.get(v), count: count.get(v), match: (p) => vals[p] === v });
      if (sorted.length > MAX_CATS) {
        const rest = sorted.slice(MAX_CATS);
        const restSet = new Set(rest);
        entries.push({ label: `outros (${fmt(rest.length)} valores)`, color: OTHER, count: rest.reduce((s, v) => s + count.get(v), 0), match: (p) => restSet.has(vals[p]) });
      }
    }
    if (count.get("")) entries.push({ label: "(sem valor)", color: NONE, count: count.get(""), match: (p) => vals[p] === "" });
    app.setRule(rule);
    showLegend(ruleSel.selectedOptions[0]?.textContent || spec, entries);
    app.emit("rule", spec);
  };

  app.showLegend = (title, entries) => showLegend(title, entries);

  function trim(x) { return Math.abs(x) >= 100 ? x.toFixed(0) : +x.toPrecision(3) + ""; }

  function showLegend(title, entries) {
    legend.innerHTML = "";
    legend.append(el("div.lh", null, el("span", { text: title }),
      el("button", { text: "✕", title: "Voltar às cores originais", onclick: () => { ruleSel.value = ""; app.applyRule(""); } })));
    for (const e of entries) {
      const sw = el("span.sw");
      sw.style.background = hex(e.color);
      const item = el("div.li", { title: "Clique para selecionar · Ctrl+clique soma" }, sw, el("span.lv", { text: e.label, title: e.label }), el("span.lc", { text: fmt(e.count) }));
      item.onclick = (ev) => {
        const out = [];
        for (let p = 0; p < app.nParts; p++) if (e.match(p)) out.push(app.partNode[p]);
        app.select(out, ev.ctrlKey || ev.metaKey ? "add" : "replace", { reveal: false });
      };
      legend.append(item);
    }
    if (!entries.length) legend.append(el("div.muted", { text: "Cores aleatórias por peça." }));
    legend.hidden = false;
  }
}
