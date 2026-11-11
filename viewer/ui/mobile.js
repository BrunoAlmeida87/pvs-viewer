// Phone layout. The 3D view takes the whole screen; everything else floats over it and stays
// small: a slim button bar, a one-line card for the selected part, and tools that open as low
// sheets which can be folded down to their title. Nothing here runs on a PC or a tablet (they keep
// the PC layout), except the small helpers other modules call.
import { $, fmt, VERSION } from "./util.js";

export function initMobile(app) {
  const root = document.documentElement, view = $("#view"), appEl = $("#app");
  const mobile = root.classList.contains("mobile");

  // ------------------------------------------------------------ side drawer (tree, search, saved views)
  function setSide(open, tab) {
    appEl.classList.toggle("mobileSide", open);
    $("#mobileSideBackdrop").hidden = !open;
    if (open && tab) app.showTab(tab);
    if (open) closeSheets();
  }
  app.closeMobileSide = () => setSide(false);
  if (!mobile) return;

  $("#mobileSideClose").onclick = () => setSide(false);
  $("#mobileSideBackdrop").onclick = () => setSide(false);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !appEl.classList.contains("mobileSide")) return;
    e.stopPropagation();
    setSide(false);
  }, true);
  // tools started from the drawer that continue on the model: get out of the way
  for (const id of ["#noteNew", "#viewLink", "#shotBtn"]) $(id)?.addEventListener("click", () => setSide(false));
  $("#viewList").addEventListener("click", (e) => { if (e.target.closest("button")?.textContent === "Aplicar") setSide(false); });
  // after the point of a new note is picked on the model, its text box is in the drawer: bring it back
  // (only once the tap is over: its own click would land on the drawer's backdrop and close it, and
  // would take the focus away from the text box)
  new MutationObserver(() => {
    if ($("#noteEditor").hidden) return;
    setTimeout(() => {
      if ($("#noteEditor").hidden) return;
      setSide(true, "setsTab");
      $("#noteEditor").scrollIntoView({ block: "center" });
      setTimeout(() => $("#noteText").focus(), 250); // once the drawer has slid in (it cannot take focus while hidden)
    }, 400);
  }).observe($("#noteEditor"), { attributes: true, attributeFilter: ["hidden"] });
  for (const id of ["#noteOk", "#noteCancel"]) $(id).addEventListener("click", () => setSide(false));

  // ------------------------------------------------------------ the PC menus become sheets
  // The same controls (same ids, same handlers) move from the top bar menus into panels.
  const adopt = (panel, from) => { const body = $(panel + " .pb"); if (from) body.append(...from.childNodes); };
  adopt("#displayPanel", $("#dStyle").closest(".menuBody"));
  adopt("#colorPanel", $("#colorPick").closest(".menuBody"));
  adopt("#selPanel", $("#selInvert").closest(".menuBody"));
  $("#infoPanel .pb").append($("#info"));
  $("#infoBox").hidden = true;
  $("#selPanel .pb").addEventListener("click", (e) => { if (e.target.closest("button") && e.target.closest("button").id !== "selSame") $("#selPanel").hidden = true; });

  // ------------------------------------------------------------ sheets (the floating panels)
  const panels = [...document.querySelectorAll("#floaters .panel")];
  const anyPanel = () => panels.some((p) => !p.hidden);
  for (const p of panels) {
    const head = p.querySelector(".ph");
    head.title = "Toque para recolher ou abrir";
    head.addEventListener("click", (e) => { if (!e.target.closest("button")) p.classList.toggle("min"); });
    new MutationObserver(() => {
      if (!p.hidden) p.classList.remove("min");
      view.classList.toggle("sheetOpen", anyPanel());
    }).observe(p, { attributes: true, attributeFilter: ["hidden"] });
  }
  const openPanel = (id) => { $(id).hidden = false; };

  // ------------------------------------------------------------ menus over the bar
  const sheets = [$("#mViewSheet"), $("#mToolSheet")];
  function closeSheets() {
    for (const s of sheets) s.hidden = true;
    $("#mSheetBack").hidden = true;
    for (const b of ["#mViews", "#mTools"]) $(b).classList.remove("on");
  }
  function toggleSheet(sheet, btn) {
    const open = sheet.hidden;
    closeSheets();
    if (!open) return;
    sheet.hidden = false;
    $("#mSheetBack").hidden = false;
    btn.classList.add("on");
  }
  $("#mSheetBack").onclick = closeSheets;

  const press = (id) => $(id).click();
  const DO = {
    close() {},
    ortho: () => app.toggleOrtho(),
    prev: () => app.viewPrev(),
    next: () => app.viewNext(),
    saved: () => setSide(true, "setsTab"),
    showAll: () => press("#showAll"),
    isolate: () => press("#isolate"),
    hide: () => press("#hideSel"),
    ghost: () => press("#ghost"),
    undo: () => app.undo(),
    display: () => openPanel("#displayPanel"),
    colors: () => openPanel("#colorPanel"),
    select: () => openPanel("#selPanel"),
    cut: () => press("#cutBtn"),
    measure: () => press("#measureBtn"),
    ar: () => app.startAR?.(),
    labels: () => app.toggleLabels(),
    mark: () => press("#markBtn"),
    man: () => press("#manBtn"),
    walk: () => { for (const p of panels) if (!p.hidden) p.querySelector("[data-close]")?.click(); app.setWalk(true, true); },
    layers: () => press("#layerBtn"),
    bigramas: () => press("#bgBtn"),
    nb: () => press("#nbBtn"),
    explode: () => press("#explodeBtn"),
    list: () => press("#listBtn"),
    analysis: () => press("#analysisBtn"),
    anim: () => press("#animBtn"),
    open: () => press("#openModelBtn"),
    more: () => press("#loadMoreBtn"),
    export: () => press("#exportMobileBtn"),
    theme: () => press("#themeBtn"),
    perf: () => app.togglePerf(),
    full: () => { if (document.fullscreenElement) document.exitFullscreen(); else root.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {}); },
  };
  for (const s of sheets) s.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    closeSheets();
    if (b.dataset.do) DO[b.dataset.do]?.();
  });
  function syncTools() {
    const has = !!app.tree, sel = app.selNodes.size > 0;
    for (const b of $("#mToolSheet").querySelectorAll("[data-do]")) {
      const k = b.dataset.do;
      b.disabled = !has && !["open", "theme", "full", "close", "perf"].includes(k) ? true
        : (k === "isolate" || k === "hide") ? !sel : k === "undo" ? !app.canUndo() : false;
    }
    $("#mMore").hidden = $("#loadMoreBtn").hidden;
    $("#mExport").hidden = $("#exportMobileBtn").hidden;
    $("#mExport").disabled = $("#exportMobileBtn").disabled;
    $("#mExport span").textContent = sel ? "Exportar seleção" : "Exportar";
    $("#mFull").hidden = !root.requestFullscreen;
    $("#mToolSheet [data-do=ghost]").classList.toggle("on", !!app.ghost);
    $("#mLabels").classList.toggle("on", app.labelsOn());
    $("#mOrtho").classList.toggle("on", app.isOrtho());
    $("#mToolTitle").textContent = app.title || "Ferramentas";
    $("#mVersion").textContent = "v" + VERSION;
  }

  // ------------------------------------------------------------ bottom bar
  $("#mTree").onclick = () => setSide(!appEl.classList.contains("mobileSide"), "treeTab");
  $("#mSearch").onclick = () => { setSide(true, "searchTab"); $("#mobileFilterText").focus(); };
  $("#mFit").onclick = () => { closeSheets(); if (app.selNodes.size) app.frameNodes([...app.selNodes]); else app.fitAll(); };
  $("#mViews").onclick = () => { syncTools(); toggleSheet($("#mViewSheet"), $("#mViews")); };
  $("#mTools").onclick = () => { syncTools(); toggleSheet($("#mToolSheet"), $("#mTools")); };
  // while a finger moves the model, the bar and the card fade so that nothing covers it
  let navT = 0;
  app.canvas.addEventListener("pointerdown", () => { clearTimeout(navT); view.classList.add("nav"); closeSheets(); });
  const rest = () => { clearTimeout(navT); navT = setTimeout(() => view.classList.remove("nav"), 450); };
  window.addEventListener("pointerup", rest);
  window.addEventListener("pointercancel", rest);

  // ------------------------------------------------------------ selected part: one line
  const card = $("#selCard");
  app.on("selection", () => {
    const n = app.selNodes.size;
    card.hidden = n === 0;
    if (!n) { if (!$("#infoPanel").hidden) $("#infoPanel").hidden = true; return; }
    card.querySelector("b").textContent = n === 1 ? app.tree.names[app.focus] : `${fmt(n)} itens`;
    const parts = app.selectedParts().length;
    card.querySelector("span").textContent = n === 1 && parts === 1 ? "" : `${fmt(parts)} peça${parts === 1 ? "" : "s"}`;
  });
  app.on("model", () => { card.hidden = true; });
  $("#selCardName").onclick = () => { const p = $("#infoPanel"); p.hidden = !p.hidden; };
  card.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act || !app.selNodes.size) return;
    const nodes = [...app.selNodes];
    if (act === "zoom") app.frameNodes(nodes);
    else if (act === "isolate") app.isolate(nodes);
    else if (act === "hide") { app.setVisible(nodes, false); app.clearSelection(); }
    else if (act === "more") { const r = card.getBoundingClientRect(); app.openContextMenu({ clientX: r.right - 8, clientY: r.top - 8, preventDefault() {} }, app.focus); }
  });

  // ------------------------------------------------------------ status: a short message, a thin bar
  const toast = $("#toast"), load = $("#load"), prog = $("#mProgress"), fill = $("#bar > div");
  let toastT = 0;
  const say = () => {
    const t = load.textContent.trim();
    if (!t || t === "Carregando…") return;
    toast.textContent = t;
    toast.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { toast.hidden = true; }, 3200);
  };
  new MutationObserver(say).observe(load, { childList: true, characterData: true, subtree: true });
  new MutationObserver(() => {
    const w = parseFloat(fill.style.width) || 0;
    prog.hidden = !(w > 0 && w < 100);
    prog.firstElementChild.style.width = w + "%";
  }).observe(fill, { attributes: true, attributeFilter: ["style"] });

  // ------------------------------------------------------------ small things
  app.setCubeSize(58, 6);
  app.on("walk", (on) => { if (on) { closeSheets(); setSide(false); } });
  app.on("loaded", syncTools);
}
