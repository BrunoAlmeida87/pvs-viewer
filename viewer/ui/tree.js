// Assembly tree (left panel): lazy rows, visibility check boxes, selection.
import { $, el, fmt } from "./util.js";

export function initTree(app) {
  const treeEl = $("#tree");
  let kids = null;
  const rowOf = new Map();
  const expanded = new Set();

  // side tabs
  document.querySelectorAll("#side .tabs button").forEach((b) => {
    b.onclick = () => app.showTab(b.dataset.tab);
  });
  app.showTab = (id) => {
    document.querySelectorAll("#side .tabs button").forEach((x) => x.classList.toggle("on", x.dataset.tab === id));
    document.querySelectorAll("#side .tab").forEach((x) => x.classList.toggle("on", x.id === id));
  };

  app.on("model", () => {
    const t = app.tree, n = app.nNodes;
    kids = new Array(n).fill(null);
    for (let i = 1; i < n; i++) (kids[t.parent[i]] || (kids[t.parent[i]] = [])).push(i);
    app.kids = (k) => kids[k] || [];
    rowOf.clear();
    expanded.clear();
    treeEl.innerHTML = "";
    treeEl.append(makeRow(0, 0));
    toggle(0, true);
  });

  function makeRow(node, depth) {
    const t = app.tree;
    const cb = el("input", { type: "checkbox" });
    const tw = el("span.tw", { text: kids[node] ? "▸" : "" });
    const row = el("div.row", null, tw, cb, el("span.nm", { text: t.names[node], title: t.names[node] }),
      kids[node] ? el("span.cnt", { text: fmt(app.partCount(node)) }) : null);
    row.style.paddingLeft = 4 + depth * 14 + "px";
    const wrap = el("div.node", null, row);
    wrap.dataset.depth = depth;
    row._node = node;
    row._cb = cb;
    rowOf.set(node, row);
    setCheck(row);
    if (app.selNodes.has(node)) row.classList.add("sel");
    tw.addEventListener("click", (e) => { e.stopPropagation(); toggle(node); });
    cb.addEventListener("click", (e) => { e.stopPropagation(); app.setVisible([node], cb.checked); });
    row.addEventListener("click", (e) => app.select([node], e.ctrlKey || e.metaKey ? "toggle" : "replace", { reveal: false }));
    row.addEventListener("dblclick", () => { if (kids[node]) toggle(node); app.frameNodes([node]); });
    return wrap;
  }

  function setCheck(row) {
    const n = row._node, total = app.partCount(n);
    const v = app.visPrefix ? app.visibleCount(n) : total;
    row._cb.checked = v > 0;
    row._cb.indeterminate = v > 0 && v < total;
  }

  function toggle(node, force) {
    const row = rowOf.get(node);
    if (!row || !kids[node]) return;
    const wrap = row.parentElement;
    const open = force !== undefined ? force : !expanded.has(node);
    if (open === expanded.has(node)) return;
    if (open) {
      expanded.add(node);
      row.firstChild.textContent = "▾";
      const box = el("div.kids");
      const depth = +wrap.dataset.depth + 1;
      for (const k of kids[node]) box.append(makeRow(k, depth));
      wrap.append(box);
    } else {
      expanded.delete(node);
      row.firstChild.textContent = "▸";
      const box = wrap.querySelector(":scope > .kids");
      if (box) {
        box.querySelectorAll(".row").forEach((r) => { rowOf.delete(r._node); expanded.delete(r._node); });
        box.remove();
      }
    }
  }

  app.revealNode = (node) => {
    app.showTab("treeTab");
    for (const a of app.ancestors(node)) toggle(a, true);
    const r = rowOf.get(node);
    if (r) r.scrollIntoView({ block: "nearest" });
  };

  app.on("state", () => { for (const r of rowOf.values()) setCheck(r); });
  app.on("selection", ({ reveal }) => {
    for (const [n, r] of rowOf) r.classList.toggle("sel", app.selNodes.has(n));
    if (reveal && app.focus >= 0 && app.selNodes.size === 1) app.revealNode(app.focus);
  });
}
