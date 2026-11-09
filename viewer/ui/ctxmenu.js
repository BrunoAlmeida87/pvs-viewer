// Right-click menu for items of the model: tree rows, search results and parts in the 3D view.
// Modules add their own entries with app.addContextItems(fn): fn(nodes, node) returns a list of
//   { label, onClick, disabled, title }   an action
//   { header: "text" }                     a section title
//   "-"                                    a separator
import { $, el } from "./util.js";

export function initContextMenu(app) {
  const menu = el("div.treeContextMenu");
  menu.hidden = true;
  document.body.append(menu);
  const providers = [];
  const close = () => { menu.hidden = true; };
  app.addContextItems = (fn) => providers.push(fn);

  // the items the menu acts on: the whole selection when the clicked item is part of it
  app.openContextMenu = (e, node) => {
    e.preventDefault();
    if (node < 0) return;
    if (!app.selNodes.has(node)) app.select([node], "replace", { reveal: false });
    const nodes = [...app.selNodes];
    const items = providers.flatMap((fn) => { const r = fn(nodes, node) || []; return r.length ? ["-", ...r] : []; }).slice(1);
    if (!items.length) return;
    menu.replaceChildren(el("div.cmTitle", { text: nodes.length > 1 ? `${nodes.length} itens selecionados` : app.tree.names[node] }));
    for (const it of items) {
      if (it === "-") { if (menu.lastChild && !menu.lastChild.classList.contains("cmSep")) menu.append(el("div.cmSep")); continue; }
      if (it.header) { menu.append(el("div.cmHead", { text: it.header })); continue; }
      menu.append(el("button", { text: it.label, title: it.title || "", disabled: !!it.disabled,
        onclick: () => { close(); it.onClick(); } }));
    }
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - r.width - 8)) + "px";
    menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - r.height - 8)) + "px";
  };
  document.addEventListener("pointerdown", (e) => { if (!menu.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  window.addEventListener("blur", close);

  // search results
  $("#results").addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".row");
    if (row && row._node >= 0) app.openContextMenu(e, row._node);
  });
  // parts in the 3D view: right click without dragging (the right button also pans the camera)
  const view = $("#view");
  let down = null;
  view.addEventListener("pointerdown", (e) => { if (e.button === 2) down = { x: e.clientX, y: e.clientY }; }, true);
  view.addEventListener("contextmenu", (e) => {
    if (e.target.closest("#floaters, #legend, #viewTabs, #open, .modal")) return;
    e.preventDefault();
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || !app.tree) return;
    const r = view.getBoundingClientRect();
    const hit = app.pick(e.clientX - r.left, e.clientY - r.top);
    if (hit.node >= 0) app.openContextMenu(e, hit.node);
  });

  // basic actions, always present
  app.addContextItems((nodes) => [
    { label: "Enquadrar", onClick: () => app.frameNodes(nodes) },
    { label: "Isolar", onClick: () => app.isolate(nodes) },
    { label: "Ocultar", onClick: () => app.setVisible(nodes, false) },
    { label: "Mostrar na árvore", onClick: () => app.revealNode(nodes[nodes.length - 1]) },
  ]);
}
