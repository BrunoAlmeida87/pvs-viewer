// Leaving the page with work that exists only on screen: measurements, hand markups and mannequins are
// kept only inside a saved view (or its link / file) — 3D notes, groups and animations save themselves.
// If any of them changed since the last time they were saved, closing the tab, reloading or opening
// another model asks first (the browser's own "leave the site?" question).
//
// What counts as saved: what went into a view that was stored (saving or updating it — not when the
// browser's storage refused it), into its link or its file, and what an applied view brings. Hand
// markups drawn for another camera position do not go into a view, so they stay unsaved. A new model
// starts with nothing to save.
//
// Not in the desktop app: there, a page that asks to stay keeps the window from closing without any
// question (Electron shows no dialog by itself).
export function initUnsaved(app) {
  if (window.desktop) { app.markSaved = () => {}; return; }
  const print = (m, k, q) => (m.length + k.length + q.length ? JSON.stringify([m, k, q]) : "");
  // everything on screen now (all the markups, also those of another camera position)
  const work = () => print(app.measurements ? app.measurements() : [], app.markupItems ? app.markupItems() : [],
    app.getMannequins ? app.getMannequins() : []);
  let saved = "";
  // state: a captured view (ui/views.js) — what it holds is saved; none: everything on screen is
  app.markSaved = (state) => {
    saved = state ? print(state.measurements || [], (state.markup && state.markup.items) || [], state.mannequins || []) : work();
  };
  app.unsavedWork = () => { const w = work(); return !!w && w !== saved; };
  app.on("model", () => { saved = ""; });
  window.addEventListener("beforeunload", (e) => {
    if (!app.tree || !app.unsavedWork()) return;
    e.preventDefault();
    e.returnValue = ""; // older browsers need it to ask
  });
}
