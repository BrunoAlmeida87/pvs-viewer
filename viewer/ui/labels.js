// Automatic labels: the code of each equipment floats over it while it can be seen. They are worked
// out when the camera comes to rest (they fade while it moves): one id render of the whole view says
// which equipment owns each pixel, so a label sits over the part of it that is visible and nothing
// hidden behind other parts gets one. Bigger (more visible) equipment first; labels never overlap.
// A click on a label selects the equipment.
import { $, store } from "./util.js";
import { BIGRAMA_KEY } from "../lib/bigrama.js";

const STEP = 4;        // CSS pixels between samples of the id render
const MIN_SAMPLES = 3; // an equipment needs this many visible samples to get a label
const MAX_LABELS = 80;
const REST_MS = 220;   // the camera has to be still this long
const KEEP = 96;       // visible sample points kept per equipment (to find a free place for its label)

export function initLabels(app) {
  const layer = $("#labels"), box = $("#dLabels");
  let on = store.get("pvs-viewer:labels", false);
  let owner = null;  // part -> labelled node (or -1)
  let text = null;   // labelled node -> label text
  let lastCam = "", timer = 0, shown = false;

  // which node labels each part: an equipment (its own bigrama code, the outermost one) or, in models
  // without equipment codes, the part itself
  function build() {
    const t = app.tree, kb = app.keyIndex(BIGRAMA_KEY), ko = app.keyIndex("part_objectid");
    owner = new Int32Array(app.nParts).fill(-1);
    text = new Map();
    const top = new Int32Array(app.nNodes).fill(-1);
    let any = false;
    if (kb >= 0) {
      for (let n = 0; n < app.nNodes; n++) {
        const up = t.parent[n] >= 0 ? top[t.parent[n]] : -1;
        top[n] = up >= 0 ? up : app.prop(n, kb) ? n : -1;
        if (top[n] === n) any = true;
      }
    }
    for (let p = 0; p < app.nParts; p++) {
      const n = app.partNode[p];
      owner[p] = any ? top[n] : n;
    }
    const label = (n) => {
      let code = ko >= 0 ? app.prop(n, ko) : "";
      if (code) { const s = code.indexOf("/"); if (s >= 0) code = code.slice(s + 1); }
      return (code || t.names[n].split(" - ")[0]).trim();
    };
    for (let p = 0; p < app.nParts; p++) { const n = owner[p]; if (n >= 0 && !text.has(n)) text.set(n, label(n)); }
  }

  function clear() { layer.innerHTML = ""; shown = false; }
  function update() {
    if (!on || !app.tree || app.tool) { clear(); return; }
    if (!owner) build();
    const shot = app.partsOnScreen(STEP);
    const acc = new Map(); // node -> [samples, sum x, sum y, some sample points (x, y, …)]
    for (let y = 0; y < shot.h; y++) {
      for (let x = 0; x < shot.w; x++) {
        const p = shot.part[y * shot.w + x];
        if (p < 0) continue;
        const n = owner[p];
        if (n < 0) continue;
        let a = acc.get(n);
        if (!a) acc.set(n, (a = [0, 0, 0, []]));
        a[0]++; a[1] += x; a[2] += y;
        // keep a spread of points: every one at first, then every other one, and so on
        if (a[0] % (1 << Math.floor(Math.log2(Math.max(1, a[0] / KEEP)) + 1)) === 0 || a[3].length < KEEP) a[3].push(x, y);
      }
    }
    const order = [...acc].filter(([, a]) => a[0] >= MIN_SAMPLES).sort((u, v) => v[1][0] - u[1][0]);
    const taken = [], W = layer.clientWidth, H = layer.clientHeight;
    layer.innerHTML = "";
    for (const [n, a] of order) {
      if (taken.length >= MAX_LABELS) break;
      const t = text.get(n) || "";
      // on a visible point of the equipment: the one nearest to the middle of what is seen of it,
      // or the next ones if that place is taken
      const mx = a[1] / a[0], my = a[2] / a[0], pts = a[3], cand = [];
      for (let i = 0; i < pts.length; i += 2) cand.push([(pts[i] - mx) ** 2 + (pts[i + 1] - my) ** 2, pts[i] * STEP, pts[i + 1] * STEP]);
      cand.sort((u, v) => u[0] - v[0]);
      const w = t.length * 6.6 + 12, h = 19;
      let r = null, cx = 0, cy = 0;
      for (const [, x, y] of cand.slice(0, 24)) {
        const q = [x - w / 2, y - h / 2, x + w / 2, y + h / 2];
        if (q[0] < 2 || q[1] < 2 || q[2] > W - 2 || q[3] > H - 2) continue;
        if (taken.some((o) => q[0] < o[2] + 3 && q[2] > o[0] - 3 && q[1] < o[3] + 2 && q[3] > o[1] - 2)) continue;
        r = q; cx = x; cy = y;
        break;
      }
      if (!r) continue;
      taken.push(r);
      const el = document.createElement("button");
      el.className = "lbl" + (app.selNodes.has(n) ? " sel" : "");
      el.textContent = t;
      el.style.left = cx + "px";
      el.style.top = cy + "px";
      el.title = app.tree.names[n];
      el.onclick = (e) => { e.stopPropagation(); app.select([n], e.ctrlKey || e.metaKey ? "toggle" : "replace"); };
      layer.append(el);
    }
    shown = true;
    layer.classList.remove("moving");
  }
  const schedule = () => { clearTimeout(timer); if (on) timer = setTimeout(update, REST_MS); };

  // the camera moves: fade, and work them out again when it stops
  app.on("frame", () => {
    if (!on) return;
    const c = app.getCamera(), key = c.pos.concat(c.target, [c.zoom || 0]).map((v) => v.toFixed(4)).join();
    if (key === lastCam) return;
    lastCam = key;
    if (shown) layer.classList.add("moving");
    schedule();
  });
  for (const ev of ["state", "clip", "layers", "geometry", "selection"]) app.on(ev, schedule);
  app.on("model", () => { owner = null; text = null; clear(); schedule(); });
  window.addEventListener("resize", schedule);

  function set(v) {
    on = v;
    store.set("pvs-viewer:labels", on);
    box.checked = on;
    $("#mLabels")?.classList.toggle("on", on);
    if (on) { lastCam = ""; app.requestRender(); schedule(); } else clear();
  }
  box.checked = on;
  box.onchange = () => set(box.checked);
  app.toggleLabels = () => set(!on);
  app.labelsOn = () => on;
}
