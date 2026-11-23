// Leaving the page with work that exists only on screen: measurements, hand markups and mannequins are
// kept only inside a saved view (or its link / file) — 3D notes, groups and animations save themselves.
// If any of them changed since the last time they were saved, closing the tab, reloading or opening
// another model asks first (the browser's own "leave the site?" question).
//
// What counts as saved: saving or updating a view, copying its link, exporting it to a file, and
// applying a view (what it brings is saved already). A new model starts with nothing to save.
//
// Not in the desktop app: there, a page that asks to stay keeps the window from closing without any
// question (Electron shows no dialog by itself).
export function initUnsaved(app) {
  if (window.desktop) { app.markSaved = () => {}; return; }
  const work = () => {
    const m = app.measurements ? app.measurements() : [];
    const k = app.markupItems ? app.markupItems() : [];
    const q = app.getMannequins ? app.getMannequins() : [];
    return m.length + k.length + q.length ? JSON.stringify([m, k, q]) : "";
  };
  let saved = "";
  app.markSaved = () => { saved = work(); };
  app.unsavedWork = () => { const w = work(); return !!w && w !== saved; };
  app.on("model", () => { saved = ""; });
  window.addEventListener("beforeunload", (e) => {
    if (!app.tree || !app.unsavedWork()) return;
    e.preventDefault();
    e.returnValue = ""; // older browsers need it to ask
  });
}
