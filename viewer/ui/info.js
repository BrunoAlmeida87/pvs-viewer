// Properties panel (bottom-left) and the "Seleção" menu actions.
import { $, el, fmt, num } from "./util.js";

export function initInfo(app) {
  const info = $("#info");
  let thumbUrl = null, token = 0;

  app.on("selection", show);
  app.on("model", () => {
    const sel = $("#selSameKey");
    sel.innerHTML = "";
    for (const k of app.tree.props.keys) if (k !== "libelle" && k !== "part_objectid") sel.append(el("option", { value: k, text: k }));
    show();
  });

  function show() {
    const n = app.focus;
    info.innerHTML = "";
    if (thumbUrl) { URL.revokeObjectURL(thumbUrl); thumbUrl = null; }
    if (n < 0) { info.append(el("div.muted", { text: "Clique numa peça no modelo ou na árvore." })); return; }
    const t = app.tree;
    const box = app.nodesBox([n]);
    const size = box.isEmpty() ? null : box.getSize(box.min.clone());
    const head = [];
    if (app.selNodes.size > 1) head.push(el("div.muted", { text: `${fmt(app.selNodes.size)} itens selecionados · detalhes do último:` }));
    const parts = app.partCount(n);
    const rows = [
      ["Tipo", t.part[n] >= 0 ? "Peça" : `Montagem · ${fmt(parts)} peça(s)`],
      ...(size ? [["Dimensões (m)", `${size.x.toFixed(3)} × ${size.y.toFixed(3)} × ${size.z.toFixed(3)}`]] : []),
      ...app.nodeProps(n).filter(([k, v]) => !(k === "libelle" && v === t.names[n])),
    ];
    if (t.part[n] >= 0) rows.push(["Arquivo", t.shapes ? t.shapes[t.part[n]] || "" : ""]);
    const table = el("table", null, ...rows.filter((r) => r[1] !== "").map(([k, v]) =>
      el("tr", null, el("td", { text: k }), el("td", { text: v, title: v }))));
    const img = el("img", { alt: "", hidden: true });
    info.append(...head, el("div.title", { text: t.names[n] }), el("div.path", { text: app.path(n) }), img, table);
    loadThumb(n, img);
  }

  async function loadThumb(n, img) {
    const name = app.tree.thumbs[n];
    if (!name) return;
    const my = ++token;
    const file = await app.readModelFile(name);
    if (!file || my !== token) return;
    thumbUrl = URL.createObjectURL(file);
    img.src = thumbUrl;
    img.hidden = false;
  }

  // ---- selection menu
  const sel = () => [...app.selNodes];
  $("#selClear").onclick = () => app.clearSelection();
  $("#selInvert").onclick = () => {
    const out = [];
    for (let p = 0; p < app.nParts; p++) if (!app.partSel[p] && app.partVisible[p]) out.push(app.partNode[p]);
    app.select(out, "replace", { reveal: false });
  };
  $("#selParent").onclick = () => {
    const s = new Set(sel().map((n) => app.tree.parent[n]).filter((n) => n >= 0));
    app.select([...s], "replace");
  };
  $("#selChildren").onclick = () => {
    const out = [];
    for (const n of sel()) { const k = app.kids(n); if (k.length) out.push(...k); else out.push(n); }
    app.select(out, "replace", { reveal: false });
  };
  $("#selSiblings").onclick = () => {
    const s = new Set();
    for (const n of sel()) { const p = app.tree.parent[n]; for (const k of p >= 0 ? app.kids(p) : [n]) s.add(k); }
    app.select([...s], "replace", { reveal: false });
  };
  $("#selSameColor").onclick = () => {
    if (app.focus < 0) return;
    const p0 = app.tree.p0[app.focus];
    if (p0 >= app.tree.p1[app.focus]) return;
    const c = app.partRGB(p0);
    const out = [];
    for (let p = 0; p < app.nParts; p++) if (app.partRGB(p) === c) out.push(app.partNode[p]);
    app.select(out, "replace", { reveal: false });
  };
  $("#selSame").onclick = () => {
    if (app.focus < 0) return;
    const key = $("#selSameKey").value, ki = app.keyIndex(key);
    let v = app.prop(app.focus, ki);
    if (v === undefined) {
      // assembly without the property: use the value of its first part
      const p0 = app.tree.p0[app.focus];
      if (p0 < app.tree.p1[app.focus]) v = app.prop(app.partNode[p0], ki);
    }
    if (v === undefined) return;
    const nv = num(v);
    const out = [];
    for (let p = 0; p < app.nParts; p++) {
      const n = app.partNode[p], x = app.prop(n, ki);
      if (x === v || (!isNaN(nv) && num(x) === nv)) out.push(n);
    }
    app.select(out, "replace", { reveal: false });
  };
}
