// Undo / redo (Ctrl+Z, Ctrl+Y) of what is easy to do by mistake: hiding, isolating, colouring and
// changing the opacity of parts. The viewer calls app.checkpoint() right before each of those.
import { $, status } from "./util.js";

const MAX = 30;

export function initUndo(app) {
  let undo = [], redo = [], pending = false;
  const snap = () => ({ vis: app.partVisible.slice(), col: app.partColor.slice(), op: app.partOpacity.slice() });
  const same = (a, b) => {
    for (const k of ["vis", "col", "op"]) { const x = a[k], y = b[k]; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; }
    return true;
  };
  const put = (s) => { app.partVisible.set(s.vis); app.partColor.set(s.col); app.partOpacity.set(s.op); app.refresh(); };
  const sync = () => {
    $("#undoBtn").disabled = !undo.length;
    $("#redoBtn").disabled = !redo.length;
    app.emit("undo");
  };
  const clear = () => { undo = []; redo = []; sync(); };

  // one snapshot for everything changed in the same go (a panel may change many items at once)
  app.checkpoint = () => {
    if (!app.tree || pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; });
    undo.push(snap());
    if (undo.length > MAX) undo.shift();
    redo = [];
    sync();
  };
  const step = (from, to, done, none) => {
    if (!app.tree) return;
    const now = snap();
    let s = from.pop();
    while (s && same(s, now)) s = from.pop(); // a checkpoint of something that changed nothing
    if (!s) { sync(); status(none); return; }
    to.push(now);
    put(s);
    sync();
    status(done);
  };
  app.undo = () => step(undo, redo, "Desfeito. Ctrl+Y refaz.", "Nada para desfazer.");
  app.redo = () => step(redo, undo, "Refeito.", "Nada para refazer.");
  app.canUndo = () => undo.length > 0;

  $("#undoBtn").onclick = () => app.undo();
  $("#redoBtn").onclick = () => app.redo();
  app.on("model", clear);
  app.on("viewtab", clear); // each view tab has its own visibility
}
