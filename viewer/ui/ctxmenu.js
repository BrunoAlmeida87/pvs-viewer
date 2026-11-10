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
    app.showMenu(e, nodes.length > 1 ? `${nodes.length} itens selecionados` : app.tree.names[node], items);
  };
  // any small menu at the mouse (same look), e.g. the right-click menu of a view tab
  app.showMenu = (e, title, items) => {
    e.preventDefault();
    if (!items.length) return;
    menu.replaceChildren(el("div.cmTitle", { text: title }));
    for (const it of items) {
      if (it === "-") { if (menu.lastChild && !menu.lastChild.classList.contains("cmSep")) menu.append(el("div.cmSep")); continue; }
      if (it.header) { menu.append(el("div.cmHead", { text: it.header })); continue; }
      menu.append(el("button", { text: it.label, title: it.title || "", disabled: !!it.disabled,
        onclick: () => { close(); it.onClick(); } }));
    }
    menu.hidden = false;
    menu.scrollTop = 0;
    // opened by a finger that is still down: lifting it must not press the item that appeared under it
    if (e.touchHold) {
      menu.style.pointerEvents = "none";
      const arm = () => setTimeout(() => { menu.style.pointerEvents = ""; }, 350);
      window.addEventListener("pointerup", arm, { once: true, capture: true });
      window.addEventListener("pointercancel", arm, { once: true, capture: true });
    } else menu.style.pointerEvents = "";
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - r.width - 8)) + "px";
    menu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - r.height - 8)) + "px";
  };
  document.addEventListener("pointerdown", (e) => { if (!menu.contains(e.target)) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  window.addEventListener("blur", close);

  // touch screens have no right button: a finger held on a row of the tree or of the search
  // results opens the same menu
  for (const id of ["#tree", "#results"]) {
    let timer = 0, start = null, fired = false;
    const box = $(id);
    box.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      const row = e.target.closest(".row");
      if (!row || !(row._node >= 0)) return;
      fired = false;
      start = { x: e.clientX, y: e.clientY };
      clearTimeout(timer);
      timer = setTimeout(() => { fired = true; app.openContextMenu({ clientX: start.x, clientY: start.y, touchHold: true, preventDefault() {} }, row._node); }, 520);
    });
    box.addEventListener("pointermove", (e) => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 9) clearTimeout(timer); });
    for (const ev of ["pointerup", "pointercancel", "scroll"]) box.addEventListener(ev, () => clearTimeout(timer), true);
    box.addEventListener("click", (e) => { if (fired) { fired = false; e.stopPropagation(); e.preventDefault(); } }, true);
    box.addEventListener("contextmenu", (e) => { if (fired) e.preventDefault(); });
  }

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
