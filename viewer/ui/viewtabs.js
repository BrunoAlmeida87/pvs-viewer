// View tabs over the 3D view: several views of the same model, side by side as tabs. "Modelo" is the
// model as usual; every other tab shows only the items included in it, with its own camera, and
// remembers what was hidden or shown in it while you worked there. Items are included from the
// right-click menu (tree, search results or a part in the 3D view), or with "+" from the selection.
// The tabs are kept in this browser, per model.
import { $, el, fmt, store } from "./util.js";

export function initViewTabs(app) {
  const bar = $("#viewTabs");
  let tabs = [], cur = 0, seq = 1;
  const key = () => `pvs-viewer:viewtabs:${app.title}:${app.nParts}`;

  // ------------------------------------------------------------ parts of a tab (mask <-> runs)
  const runsOf = (mask) => {
    const out = [];
    for (let p = 0; p < mask.length; p++) if (mask[p]) { let q = p; while (q + 1 < mask.length && mask[q + 1]) q++; out.push([p, q - p + 1]); p = q; }
    return out;
  };
  const maskOf = (runs) => {
    const m = new Uint8Array(app.nParts);
    for (const [s, n] of runs || []) if (s >= 0 && s + n <= app.nParts) m.fill(1, s, s + n);
    return m;
  };
  const partsOfNodes = (nodes) => {
    const out = [];
    app.forParts(nodes, (p) => out.push(p));
    return out;
  };
  const count = (mask) => { let n = 0; for (let p = 0; p < mask.length; p++) n += mask[p]; return n; };

  let saveT = 0;
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      const list = tabs.slice(1).map((t) => ({ name: t.name, runs: runsOf(t.mask), cam: cur === tabs.indexOf(t) ? app.getCamera() : t.cam }));
      store.set(key(), { version: 1, tabs: list, cur });
    }, 300);
  };

  // ------------------------------------------------------------ switching
  function leave() {
    app.emit("viewtab-leave"); // tools that took over the view (animation) give it back first
    const a = tabs[cur];
    a.vis = app.partVisible.slice();
    a.cam = app.getCamera();
  }
  function enter(i, frameIt) {
    cur = i;
    const b = tabs[i];
    if (b.vis) app.partVisible.set(b.vis);
    else if (b.mask) app.partVisible.set(b.mask);
    else app.partVisible.fill(1);
    app.refresh();
    if (b.cam && !frameIt) app.setCamera(b.cam);
    else if (b.mask && count(b.mask)) {
      const list = [];
      for (let p = 0; p < b.mask.length; p++) if (b.mask[p]) list.push(p);
      app.frameBox(app.partsBox(list));
    }
    if (bar.querySelectorAll(".vt").length === tabs.length) mark(); else render();
    app.emit("viewtab", i);
    save();
  }
  function switchTo(i) {
    if (i === cur || !tabs[i]) return;
    leave();
    enter(i, false);
  }
  app.viewTab = () => (cur > 0 ? tabs[cur].name : "");

  // ------------------------------------------------------------ editing
  function newTab(parts, name) {
    const mask = new Uint8Array(app.nParts);
    for (const p of parts) mask[p] = 1;
    tabs.push({ name: name || `Vista ${seq++}`, mask, vis: null, cam: null });
    leave();
    enter(tabs.length - 1, true);
  }
  function include(i, parts, on) {
    const t = tabs[i];
    for (const p of parts) t.mask[p] = on ? 1 : 0;
    if (i === cur) { for (const p of parts) app.partVisible[p] = on ? 1 : 0; app.refresh(); }
    else if (t.vis) for (const p of parts) t.vis[p] = on ? 1 : 0;
    render();
    save();
  }
  function close(i) {
    if (i === 0) return;
    if (i === cur) { leave(); tabs.splice(i, 1); enter(i - 1, false); }
    else { tabs.splice(i, 1); if (cur > i) cur--; render(); save(); }
  }
  // rename in place: the name becomes a text box (Enter or clicking away saves, Esc cancels)
  function rename(i) {
    if (i === 0) return;
    const tab = bar.children[i], span = tab?.querySelector(".vtName");
    if (!span || tab.querySelector("input")) return;
    const input = el("input.vtEdit", { value: tabs[i].name, size: String(Math.max(6, tabs[i].name.length)) });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const n = input.value.trim();
      if (ok && n) { tabs[i].name = n; save(); }
      render();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keyboard shortcuts of the viewer stay off while typing
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    for (const ev of ["click", "dblclick", "pointerdown"]) input.addEventListener(ev, (e) => e.stopPropagation());
    span.replaceWith(input);
    input.focus();
    input.select();
  }
  function duplicate(i) {
    const t = tabs[i];
    if (i === cur) { t.vis = app.partVisible.slice(); t.cam = app.getCamera(); }
    const mask = t.mask ? t.mask.slice() : new Uint8Array(app.nParts).fill(1);
    tabs.push({ name: t.name + " (cópia)", mask, vis: t.vis ? t.vis.slice() : null, cam: t.cam });
    leave();
    enter(tabs.length - 1, false);
  }
  function tabMenu(e, i) {
    const items = i === 0
      ? [{ label: "Duplicar como nova vista", onClick: () => duplicate(0) }]
      : [{ label: "Renomear", onClick: () => { switchTo(i); rename(i); } },
        { label: "Duplicar", onClick: () => duplicate(i) },
        { label: "Fechar", onClick: () => close(i) }];
    app.showMenu(e, tabs[i].name, items);
  }

  // in a tab, "Mostrar tudo" shows everything of that tab, not the whole model
  const showAll = app.showAll;
  app.showAll = () => {
    if (cur > 0) { app.partVisible.set(tabs[cur].mask); app.refresh(); }
    else showAll();
  };

  // ------------------------------------------------------------ tab bar
  // switching tabs only moves the highlight: rebuilding the bar would swallow a double click
  function mark() { [...bar.querySelectorAll(".vt")].forEach((b, i) => b.classList.toggle("on", i === cur)); }
  function render() {
    bar.replaceChildren();
    if (!app.tree) return;
    tabs.forEach((t, i) => {
      const b = el("div.vt" + (i === cur ? ".on" : ""), {
        title: i === 0 ? "O modelo inteiro, como sempre" : `${fmt(count(t.mask))} peça(s) · duplo clique ou ✎ renomeia · botão direito: mais opções`,
        onclick: () => switchTo(i),
        ondblclick: () => rename(i),
        onauxclick: (e) => { if (e.button === 1) close(i); },
        oncontextmenu: (e) => tabMenu(e, i),
      }, el("span.vtName", { text: t.name }), i > 0 ? el("span.vtN", { text: fmt(count(t.mask)) }) : null,
      i > 0 ? el("button.vtEd", { text: "✎", title: "Renomear a vista", onclick: (e) => { e.stopPropagation(); switchTo(i); rename(i); } }) : null,
      i > 0 ? el("button.vtX", { text: "×", title: "Fechar a vista", onclick: (e) => { e.stopPropagation(); close(i); } }) : null);
      bar.append(b);
    });
    bar.append(el("button.vtAdd", { text: "+", title: "Nova vista (com as peças selecionadas, se houver; depois inclua mais itens com o botão direito na árvore)",
      onclick: () => newTab(app.selectedParts()) }));
  }

  // ------------------------------------------------------------ right-click menu
  app.addContextItems((nodes) => {
    const parts = partsOfNodes(nodes);
    if (!parts.length) return [];
    const out = [{ header: "Vistas" }];
    tabs.forEach((t, i) => {
      if (i === 0) return;
      let inside = 0;
      for (const p of parts) inside += t.mask[p];
      if (inside < parts.length) out.push({ label: `Incluir em “${t.name}”`, onClick: () => include(i, parts, true) });
      if (inside > 0) out.push({ label: `Tirar de “${t.name}”`, onClick: () => include(i, parts, false) });
    });
    out.push({ label: "Nova vista com isto", onClick: () => newTab(parts, nodes.length === 1 ? app.tree.names[nodes[0]] : null) });
    return out;
  });

  app.on("model", () => {
    tabs = [{ name: "Modelo", mask: null, vis: null, cam: null }];
    cur = 0; seq = 1;
    const saved = store.get(key(), null);
    if (saved?.version === 1 && Array.isArray(saved.tabs)) {
      for (const s of saved.tabs) tabs.push({ name: String(s.name || `Vista ${seq}`), mask: maskOf(s.runs), vis: null, cam: s.cam || null });
      seq = tabs.length;
    }
    render();
  });
}
