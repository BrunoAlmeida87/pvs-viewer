// Core of the viewer: rendering, model loading, picking and the shared state that the
// UI modules (ui/*.js) read and change through the `app` object.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { parsePVS, buildTree as buildPVSTree } from "./lib/pvs.js";
import { initTree } from "./ui/tree.js";
import { initSearch } from "./ui/search.js";
import { initInfo } from "./ui/info.js";
import { initSets } from "./ui/sets.js";
import { initColors } from "./ui/colors.js";
import { initTable } from "./ui/table.js";
import { $, status } from "./ui/util.js";

const DATA = "data/";
const TEX_W = 4096;

// ---------------------------------------------------------------- app / events
const listeners = {};
export const app = {
  on(ev, fn) { (listeners[ev] || (listeners[ev] = [])).push(fn); },
  emit(ev, ...a) { (listeners[ev] || []).forEach((f) => f(...a)); },
  title: "", tree: null, nNodes: 0, nParts: 0,
  selNodes: new Set(), focus: -1, ghost: false, lastResults: [],
  access: null, // how to read model files (thumbnails): {dir} | {files} | {base}
};

// ---------------------------------------------------------------- renderer
const view = $("#view");
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0xdfe3ea, 1);
view.prepend(renderer.domElement);

const scene = new THREE.Scene();
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const persp = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
persp.up.set(0, 0, 1);
ortho.up.set(0, 0, 1);
let camera = persp;
let controls = makeControls(camera);

function makeControls(cam) {
  const c = new OrbitControls(cam, renderer.domElement);
  c.enableDamping = true;
  c.dampingFactor = 0.15;
  c.zoomToCursor = true;
  c.screenSpacePanning = true;
  c.addEventListener("change", requestRender);
  c.addEventListener("start", () => { userMoved = true; });
  return c;
}
let userMoved = false;

let needRender = true;
function requestRender() { needRender = true; }
app.requestRender = requestRender;

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  persp.aspect = w / Math.max(1, h);
  persp.updateProjectionMatrix();
  updateOrtho();
  requestRender();
}
new ResizeObserver(resize).observe(view);

// ---------------------------------------------------------------- shaders
// itemTex: one texel per draw item.  rgb = colour, a = state:
//   0 = hidden, otherwise bit 7 = selected and bits 0..6 = opacity (127 = opaque).
// Every chunk is drawn twice: pass 0 draws opaque items, pass 1 the translucent ones.
const VERT = /* glsl */ `
precision highp float;
precision highp int;
in uvec4 qpos;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 bmin;
uniform vec3 bext;
uniform int itemOffset;
uniform int pass;
uniform int pickMode;
uniform sampler2D itemTex;
out vec3 vView;
flat out vec4 vCol;
flat out float vSel;
flat out uint vId;
void main() {
  int idx = itemOffset + int(qpos.w);
  vec4 t = texelFetch(itemTex, ivec2(idx & 4095, idx >> 12), 0);
  int av = int(t.a * 255.0 + 0.5);
  int op = av & 127;
  bool draw = op > 0 && (pass == 0 ? op == 127 : op < 127);
  if (pickMode == 1 && pass == 1) draw = false;
  vCol = vec4(t.rgb, float(op) / 127.0);
  vSel = av >= 128 ? 1.0 : 0.0;
  vId = uint(idx + 1);
  vec3 p = bmin + vec3(qpos.xyz) * (bext / 65535.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vView = mv.xyz;
  gl_Position = draw ? projectionMatrix * mv : vec4(0.0, 0.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
precision highp int;
in vec3 vView;
flat in vec4 vCol;
flat in float vSel;
flat in uint vId;
uniform int pickMode;
uniform int pass;
uniform int ortho;
out vec4 outColor;
void main() {
  if (pickMode == 1) {
    uint id = vId;
    outColor = vec4(float(id & 255u), float((id >> 8) & 255u), float((id >> 16) & 255u), float((id >> 24) & 255u)) / 255.0;
    return;
  }
  vec3 n = normalize(cross(dFdx(vView), dFdy(vView)));
  vec3 l = ortho == 1 ? vec3(0.0, 0.0, 1.0) : normalize(-vView);
  float d = abs(dot(n, l));
  vec3 base = vCol.rgb;
  if (vSel > 0.5) base = mix(base, vec3(1.0, 0.42, 0.05), 0.7);
  vec3 c = base * (0.32 + 0.68 * d) + vec3(0.10) * pow(d, 30.0);
  outColor = vec4(c, pass == 1 ? vCol.a : 1.0);
}`;

const shared = { itemTex: { value: null }, pickMode: { value: 0 }, ortho: { value: 0 } };

// ---------------------------------------------------------------- item state
let nItems = 0, itemPart = null, itemColor = null, itemTexData, itemTex;
let partFirstItem;
const chunks = []; // {io, ic, meshT}

function allocItems(cap) {
  const rows = Math.max(1, Math.ceil(cap / TEX_W));
  const n = rows * TEX_W;
  const np = new Uint32Array(n), nc = new Uint8Array(n * 4);
  if (itemPart) { np.set(itemPart.subarray(0, nItems)); nc.set(itemColor.subarray(0, nItems * 4)); }
  itemPart = np; itemColor = nc;
  itemTexData = new Uint8Array(n * 4);
  if (itemTex) itemTex.dispose();
  itemTex = new THREE.DataTexture(itemTexData, TEX_W, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  itemTex.minFilter = itemTex.magFilter = THREE.NearestFilter;
  itemTex.generateMipmaps = false;
  shared.itemTex.value = itemTex;
}

function addItems(parts, colors) {
  const off = nItems, n = parts.length;
  const grow = off + n > itemPart.length;
  if (grow) allocItems(Math.ceil((off + n) * 1.25));
  itemPart.set(parts, off);
  itemColor.set(colors, off * 4);
  for (let i = 0; i < n; i++) if (partFirstItem[parts[i]] < 0) partFirstItem[parts[i]] = off + i;
  nItems += n;
  if (grow) app.refresh();
  else { writeItems(off, off + n); itemTex.needsUpdate = true; }
  return off;
}

const GHOST_OP = 30;
function writeItems(a, b) {
  const { partVisible, partSel, partColor, partOpacity } = app;
  const rule = app.partRule;
  const ghost = app.ghost && app.selNodes.size > 0;
  for (let i = a; i < b; i++) {
    const p = itemPart[i], o = i * 4;
    const c = partColor[p] >= 0 ? partColor[p] : rule && rule[p] >= 0 ? rule[p] : -1;
    if (c >= 0) { itemTexData[o] = c >> 16; itemTexData[o + 1] = (c >> 8) & 255; itemTexData[o + 2] = c & 255; }
    else { itemTexData[o] = itemColor[o]; itemTexData[o + 1] = itemColor[o + 1]; itemTexData[o + 2] = itemColor[o + 2]; }
    let op = partVisible[p] ? partOpacity[p] : 0;
    const sel = partSel[p];
    if (ghost && !sel && op > GHOST_OP) op = GHOST_OP;
    let op7 = Math.round(op / 255 * 127);
    if (op > 0 && op7 === 0) op7 = 1;
    itemTexData[o + 3] = op7 === 0 ? 0 : (sel ? 128 : 0) | op7;
  }
}

function updateTranslucent() {
  for (const c of chunks) {
    let any = false;
    for (let i = c.io; i < c.io + c.ic && !any; i++) {
      const a = itemTexData[i * 4 + 3] & 127;
      if (a > 0 && a < 127) any = true;
    }
    c.meshT.visible = any;
  }
}

// Re-derive the GPU state after any change of visibility, selection or colour.
app.refresh = function () {
  writeItems(0, nItems);
  itemTex.needsUpdate = true;
  updateTranslucent();
  const vp = new Uint32Array(app.nParts + 1);
  for (let p = 0; p < app.nParts; p++) vp[p + 1] = vp[p] + app.partVisible[p];
  app.visPrefix = vp;
  app.emit("state");
  requestRender();
};

// Effective colour (0xRRGGBB) of a part as drawn now.
app.partRGB = function (p) {
  if (app.partColor[p] >= 0) return app.partColor[p];
  if (app.partRule && app.partRule[p] >= 0) return app.partRule[p];
  const i = partFirstItem[p];
  if (i < 0) return -1;
  return (itemColor[i * 4] << 16) | (itemColor[i * 4 + 1] << 8) | itemColor[i * 4 + 2];
};

// ---------------------------------------------------------------- tree helpers
app.visibleCount = (n) => app.visPrefix[app.tree.p1[n]] - app.visPrefix[app.tree.p0[n]];
app.partCount = (n) => app.tree.p1[n] - app.tree.p0[n];
app.isPart = (n) => app.tree.part[n] >= 0;
app.ancestors = function (n) {
  const a = [];
  for (let p = app.tree.parent[n]; p >= 0; p = app.tree.parent[p]) a.push(p);
  return a.reverse();
};
app.path = (n) => app.ancestors(n).map((a) => app.tree.names[a]).join(" / ");
app.forParts = function (nodes, fn) {
  for (const n of nodes) for (let p = app.tree.p0[n]; p < app.tree.p1[n]; p++) fn(p);
};
// Part nodes (leaves) inside the given nodes, without duplicates.
app.leafNodes = function (nodes) {
  const seen = new Uint8Array(app.nParts), out = [];
  app.forParts(nodes, (p) => { if (!seen[p]) { seen[p] = 1; out.push(app.partNode[p]); } });
  return out;
};

// properties
app.keyIndex = (k) => app.tree.props.keys.indexOf(k);
app.nodeProps = function (n) {
  const P = app.tree.props, out = [];
  for (let i = P.start[n]; i < P.start[n + 1]; i++) out.push([P.keys[P.kv[2 * i]], P.vals[P.kv[2 * i + 1]]]);
  return out;
};
app.prop = function (n, ki) {
  const P = app.tree.props;
  for (let i = P.start[n]; i < P.start[n + 1]; i++) if (P.kv[2 * i] === ki) return P.vals[P.kv[2 * i + 1]];
  return undefined;
};
// Level-1 / level-2 assembly of a node (for grouping and colouring).
app.levelNode = function (n, level) {
  const t = app.tree, d = app.depth;
  if (d[n] < level) return -1;
  while (d[n] > level) n = t.parent[n];
  return n;
};

// ---------------------------------------------------------------- selection
function recomputeSel() {
  app.partSel.fill(0);
  for (const n of app.selNodes) app.partSel.fill(1, app.tree.p0[n], app.tree.p1[n]);
}

// mode: "replace" | "add" | "toggle" | "remove"
app.select = function (nodes, mode = "replace", opts = {}) {
  if (mode === "replace") app.selNodes.clear();
  for (const n of nodes) {
    if (n < 0) continue;
    if (mode === "remove" || (mode === "toggle" && app.selNodes.has(n))) app.selNodes.delete(n);
    else app.selNodes.add(n);
  }
  const last = nodes.length ? nodes[nodes.length - 1] : -1;
  app.focus = app.selNodes.has(last) ? last : app.selNodes.size ? [...app.selNodes][app.selNodes.size - 1] : -1;
  recomputeSel();
  app.refresh();
  app.emit("selection", { reveal: opts.reveal !== false });
};
app.clearSelection = () => app.select([], "replace");
app.selectedParts = function () {
  const out = [];
  for (let p = 0; p < app.nParts; p++) if (app.partSel[p]) out.push(p);
  return out;
};

// ---------------------------------------------------------------- visibility & colour
function fillParts(arr, nodes, v) { for (const n of nodes) arr.fill(v, app.tree.p0[n], app.tree.p1[n]); }
app.setVisible = (nodes, on) => { fillParts(app.partVisible, nodes, on ? 1 : 0); app.refresh(); };
app.isolate = (nodes) => { app.partVisible.fill(0); fillParts(app.partVisible, nodes, 1); app.refresh(); };
app.showAll = () => { app.partVisible.fill(1); app.refresh(); };
app.setColor = (nodes, rgb) => { fillParts(app.partColor, nodes, rgb == null ? -1 : rgb); app.refresh(); };
app.setOpacity = (nodes, op) => { fillParts(app.partOpacity, nodes, op); app.refresh(); };
app.setRule = (arr) => { app.partRule = arr; app.refresh(); };
app.resetColors = () => {
  app.partColor.fill(-1); app.partOpacity.fill(255); app.partRule = null;
  app.emit("rule", null);
  app.refresh();
};
app.setGhost = (on) => { app.ghost = on; app.refresh(); };

// ---------------------------------------------------------------- model sources
// A model is either a folder converted by tools/build.py (chunks.json, tree.json, ...)
// or an original Creo View folder (.pvs + .ol files) that is parsed here in the browser.
// Local folders are read by the browser and are never uploaded.
function ok(r, name) { if (!r.ok) throw new Error(name + ": HTTP " + r.status); return r; }

const httpConverted = {
  json: (n) => fetch(DATA + n).then((r) => ok(r, n).json()),
  buf: (n) => fetch(DATA + n).then((r) => ok(r, n).arrayBuffer()),
};

function filesConverted(all, prefix) {
  const get = (n) => { const f = all.get(prefix + n); if (!f) throw new Error("arquivo ausente: " + n); return f; };
  return { json: async (n) => JSON.parse(await get(n).text()), buf: async (n) => get(n).arrayBuffer() };
}

function dirConverted(dir) {
  const file = async (n) => {
    const parts = n.split("/");
    let d = dir;
    for (const s of parts.slice(0, -1)) d = await d.getDirectoryHandle(s);
    return (await d.getFileHandle(parts[parts.length - 1])).getFile();
  };
  return { json: async (n) => JSON.parse(await (await file(n)).text()), buf: async (n) => (await file(n)).arrayBuffer() };
}

// Read a file of the original model folder (used for thumbnails); null if unavailable.
app.readModelFile = async function (name) {
  const a = app.access;
  if (!a || !name) return null;
  try {
    if (a.files) { const f = a.files.get(name); return f ? f : null; }
    if (a.dir) return await (await a.dir.getFileHandle(name)).getFile();
    if (a.base) { const r = await fetch(a.base + encodeURIComponent(name)); return r.ok ? await r.blob() : null; }
  } catch { /* missing */ }
  return null;
};

async function pickModel() {
  const params = new URLSearchParams(location.search);
  if (params.get("pvs")) {
    const url = params.get("pvs");
    const buf = await fetch(url).then((r) => ok(r, url).arrayBuffer());
    return { kind: "raw", name: decodeURIComponent(url.split("/").pop()), pvs: buf,
      access: { base: new URL(url.slice(0, url.lastIndexOf("/") + 1), location.href).href } };
  }
  if (!params.has("abrir")) {
    try { await httpConverted.json("chunks.json"); return { kind: "converted", src: httpConverted }; } catch { /* none on server */ }
  }
  status("Nenhum modelo carregado");
  const card = $("#open");
  card.hidden = false;
  return new Promise((resolve) => {
    const fail = (e) => { if (e && e.name !== "AbortError") $("#openErr").textContent = e.message || String(e); };
    $("#openBtn").onclick = async () => {
      $("#openErr").textContent = "";
      if (window.showDirectoryPicker) {
        try {
          const dir = await window.showDirectoryPicker({ id: "pvs-model", mode: "read" });
          status("Procurando o modelo na pasta…");
          const m = await fromDirectory(dir);
          card.hidden = true;
          resolve(m);
        } catch (e) { fail(e); }
      } else {
        $("#folder").click();
      }
    };
    $("#folder").onchange = async () => {
      try {
        const m = await fromFileList($("#folder").files);
        card.hidden = true;
        resolve(m);
      } catch (e) { fail(e); }
    };
  });
}

const NO_MODEL = "A pasta não tem arquivo .pvs nem um modelo convertido (chunks.json). Escolha a pasta que contém o .pvs e os arquivos .ol.";

async function fromDirectory(dir) {
  try { await dir.getFileHandle("chunks.json"); return { kind: "converted", src: dirConverted(dir) }; } catch { /* not converted */ }
  let found = null;
  for await (const [name, h] of dir.entries()) {
    if (h.kind === "file" && name.toLowerCase().endsWith(".pvs")) { found = h; break; }
  }
  if (!found) throw new Error(NO_MODEL);
  const f = await found.getFile();
  return { kind: "raw", name: f.name, pvs: await f.arrayBuffer(), access: { dir } };
}

async function fromFileList(files) {
  const all = new Map();
  for (const f of files) all.set((f.webkitRelativePath || f.name).replace(/\\/g, "/"), f);
  const keys = [...all.keys()];
  const meta = keys.filter((k) => k.endsWith("chunks.json")).sort((a, b) => a.length - b.length)[0];
  if (meta) return { kind: "converted", src: filesConverted(all, meta.slice(0, -"chunks.json".length)) };
  const pvs = keys.filter((k) => k.toLowerCase().endsWith(".pvs")).sort((a, b) => a.length - b.length)[0];
  if (!pvs) throw new Error(NO_MODEL);
  const prefix = pvs.slice(0, pvs.lastIndexOf("/") + 1);
  const byName = new Map();
  for (const [k, f] of all) if (k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) byName.set(k.slice(prefix.length), f);
  const f = all.get(pvs);
  return { kind: "raw", name: f.name, pvs: await f.arrayBuffer(), access: { files: byName } };
}

// ---------------------------------------------------------------- model setup
let modelMin, modelMax, partBox;

function setModel(name, t, boxes, lo, hi) {
  if (!t.props) t.props = { keys: [], vals: [], start: new Array(t.names.length + 1).fill(0), kv: [] };
  if (!t.thumbs) t.thumbs = [];
  app.title = name;
  app.tree = t;
  app.nNodes = t.names.length;
  partBox = boxes;
  modelMin = lo; modelMax = hi;
  const nParts = partBox.length / 6;
  app.nParts = nParts;
  app.partVisible = new Uint8Array(nParts).fill(1);
  app.partSel = new Uint8Array(nParts);
  app.partColor = new Int32Array(nParts).fill(-1);
  app.partOpacity = new Uint8Array(nParts).fill(255);
  app.partRule = null;
  app.partNode = new Int32Array(nParts).fill(-1);
  t.part.forEach((p, n) => { if (p >= 0) app.partNode[p] = n; });
  const depth = new Int32Array(app.nNodes);
  for (let n = 1; n < app.nNodes; n++) depth[n] = depth[t.parent[n]] + 1;
  app.depth = depth;
  partFirstItem = new Int32Array(nParts).fill(-1);
  $("#title").textContent = name;
  document.title = name + " · Visualizador PVS";
  allocItems(Math.max(nParts * 1.3, TEX_W));
  app.refresh();
  app.emit("model");
  fitAll(false);
}

async function main() {
  resize();
  animate();
  const m = await pickModel();
  status("Carregando estrutura…");
  if (m.kind === "converted") await loadConverted(m.src);
  else { app.access = m.access; await loadRaw(m); }
}

async function loadConverted(src) {
  const [meta, t, itemsBuf, partsBuf] = await Promise.all([
    src.json("chunks.json"), src.json("tree.json"), src.buf("items.bin"), src.buf("parts.bin"),
  ]);
  setModel(meta.source, t, new Float32Array(partsBuf), meta.min, meta.max);
  const n = itemsBuf.byteLength / 8, dv = new DataView(itemsBuf);
  const parts = new Uint32Array(n), colors = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    parts[i] = dv.getUint32(i * 8, true);
    for (let k = 0; k < 4; k++) colors[i * 4 + k] = dv.getUint8(i * 8 + 4 + k);
  }
  addItems(parts, colors);
  const list = meta.chunks;
  let next = 0, done = 0;
  const bar = $("#bar > div");
  async function fetcher() {
    while (next < list.length) {
      const c = list[next++];
      const buf = await src.buf("c/" + c.f);
      addChunk(c, new Uint16Array(buf, 0, c.nv * 4), new Uint16Array(buf, c.nv * 8, c.ni), c.io, c.ic);
      done++;
      bar.style.width = (100 * done / list.length).toFixed(1) + "%";
      status(done < list.length ? `Carregando geometria ${done}/${list.length}` : "Modelo carregado");
    }
  }
  await Promise.all(Array.from({ length: 6 }, fetcher));
  app.emit("loaded");
}

async function loadRaw(m) {
  const t0 = performance.now();
  const pvs = parsePVS(m.pvs);
  const t = buildPVSTree(pvs.components);
  const boxes = new Float32Array(t.shapes.length * 6);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  t.boxes.forEach((b, i) => {
    if (!b) return;
    boxes.set(b, i * 6);
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b[a]); hi[a] = Math.max(hi[a], b[a + 3]); }
  });
  setModel(m.name, t, boxes, lo, hi);
  if (pvs.transformed) console.warn("O modelo tem instâncias com transformação; esta versão ainda não as aplica.");

  const total = t.shapes.length;
  const TASK = 150;
  const tasks = [];
  for (let s = 0; s < total; s += TASK) tasks.push(s);
  const nWorkers = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const bar = $("#bar > div");
  let missing = 0, next = 0, doneParts = 0;
  const files = m.access.files;
  const runWorker = () => new Promise((resolve, reject) => {
    const w = new Worker(new URL("./lib/olworker.js", import.meta.url), { type: "module" });
    w.postMessage({ type: "init", dir: m.access.dir, base: m.access.base });
    const send = () => {
      if (next >= tasks.length) { w.terminate(); resolve(); return; }
      const s = tasks[next++];
      const parts = [];
      for (let p = s; p < Math.min(total, s + TASK); p++) {
        const name = t.shapes[p];
        parts.push({ part: p, name, file: files ? files.get(name) || null : undefined });
      }
      w.postMessage({ type: "task", id: s, parts });
    };
    const progress = () => {
      doneParts = Math.min(total, doneParts + TASK);
      bar.style.width = (100 * doneParts / total).toFixed(1) + "%";
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      status(`Lendo peças ${doneParts.toLocaleString("pt-BR")}/${total.toLocaleString("pt-BR")} · ${secs}s`);
    };
    w.onmessage = (e) => {
      const d = e.data;
      if (d.type === "chunk") {
        const io = addItems(d.items, d.colors);
        addChunk(d, d.verts, d.idx, io, d.items.length);
      } else if (d.type === "error") {
        console.error("worker:", d.message);
        missing += TASK;
        progress();
        send();
      } else if (d.type === "done") {
        missing += d.missing;
        // geometry bounding boxes replace the ones stored in the PVS (not always accurate)
        for (let i = 0; i < d.boxParts.length; i++) partBox.set(d.boxes.subarray(i * 6, i * 6 + 6), d.boxParts[i] * 6);
        progress();
        send();
      }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || "erro no worker")); };
    send();
  });
  await Promise.all(Array.from({ length: nWorkers }, runWorker));
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  status(`Modelo carregado em ${secs}s` + (missing ? ` · ${missing} arquivo(s) .ol ausente(s) ou ilegível(is)` : ""));
  const all = partsBox(Array.from({ length: app.nParts }, (_, p) => p));
  if (!all.isEmpty()) { modelMin = all.min.toArray(); modelMax = all.max.toArray(); }
  if (!userMoved) fitAll(false);
  app.emit("loaded");
}

function disposeArray() { this.array = null; }
let loadedTris = 0;

function addChunk(c, verts, idx, io, ic) {
  loadedTris += c.ni / 3;
  $("#stats").textContent = `${(loadedTris / 1e6).toFixed(1)} M triângulos · ${app.nParts.toLocaleString("pt-BR")} peças`;
  requestRender();
  const g = new THREE.BufferGeometry();
  const q = new THREE.BufferAttribute(verts, 4);
  q.gpuType = THREE.IntType;
  q.onUpload(disposeArray);
  g.setAttribute("qpos", q);
  const ia = new THREE.BufferAttribute(idx, 1);
  ia.onUpload(disposeArray);
  g.setIndex(ia);
  const min = new THREE.Vector3(...c.min), max = new THREE.Vector3(...c.max);
  g.boundingBox = new THREE.Box3(min, max);
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  const make = (pass) => {
    const mat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        bmin: { value: min }, bext: { value: max.clone().sub(min) }, itemOffset: { value: io }, pass: { value: pass },
        itemTex: shared.itemTex, pickMode: shared.pickMode, ortho: shared.ortho,
      },
      side: THREE.DoubleSide,
      transparent: pass === 1,
      depthWrite: pass === 0,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = pass;
    scene.add(mesh);
    return mesh;
  };
  make(0);
  const meshT = make(1);
  const chunk = { io, ic, meshT };
  chunks.push(chunk);
  let any = false;
  for (let i = io; i < io + ic && !any; i++) { const a = itemTexData[i * 4 + 3] & 127; any = a > 0 && a < 127; }
  meshT.visible = any;
}

// ---------------------------------------------------------------- camera helpers
function modelBox() { return new THREE.Box3(new THREE.Vector3(...modelMin), new THREE.Vector3(...modelMax)); }

function partsBox(parts) {
  const b = new THREE.Box3(), v = new THREE.Vector3();
  for (const p of parts) {
    const o = p * 6;
    if (partBox[o] === 0 && partBox[o + 3] === 0 && partBox[o + 1] === 0 && partBox[o + 4] === 0) continue;
    b.expandByPoint(v.set(partBox[o], partBox[o + 1], partBox[o + 2]));
    b.expandByPoint(v.set(partBox[o + 3], partBox[o + 4], partBox[o + 5]));
  }
  return b;
}
app.nodesBox = function (nodes) {
  const parts = [];
  app.forParts(nodes, (p) => parts.push(p));
  return partsBox(parts);
};

function frame(box, dir) {
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
  if (!dir) dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.lengthSq() === 0) dir.set(1, -1, 0.8).normalize();
  const dist = radius / Math.sin(THREE.MathUtils.degToRad(persp.fov / 2));
  controls.target.copy(center);
  persp.position.copy(center).addScaledVector(dir, dist);
  ortho.position.copy(center).addScaledVector(dir, dist);
  ortho.zoom = 1;
  orthoHalf = radius * 1.1;
  persp.lookAt(center); ortho.lookAt(center);
  updateOrtho();
  controls.update();
  requestRender();
}
app.frameNodes = (nodes) => frame(app.nodesBox(nodes));

let orthoHalf = 10;
function updateOrtho() {
  const a = view.clientWidth / Math.max(1, view.clientHeight);
  ortho.left = -orthoHalf * a; ortho.right = orthoHalf * a;
  ortho.top = orthoHalf; ortho.bottom = -orthoHalf;
  ortho.updateProjectionMatrix();
}

function fitAll(keepDir = true) { frame(modelBox(), keepDir ? null : new THREE.Vector3(1, -1, 0.8).normalize()); }

const VIEWS = {
  iso: new THREE.Vector3(1, -1, 0.8), front: new THREE.Vector3(1, 0, 0),
  side: new THREE.Vector3(0, -1, 0), top: new THREE.Vector3(0, -0.0001, 1),
};

function setOrtho(on) {
  const from = camera;
  camera = on ? ortho : persp;
  camera.position.copy(from.position);
  camera.quaternion.copy(from.quaternion);
  const target = controls.target.clone();
  controls.dispose();
  controls = makeControls(camera);
  controls.target.copy(target);
  if (on) {
    orthoHalf = camera.position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
    ortho.zoom = 1;
    updateOrtho();
  }
  shared.ortho.value = on ? 1 : 0;
  controls.update();
  $("#ortho").classList.toggle("on", on);
  requestRender();
}

// ---------------------------------------------------------------- picking
let pickRT = null;
// Render item ids into an off-screen target and return the ids in a screen rectangle.
function pickRect(x0, y0, x1, y1) {
  const r = renderer.domElement.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (!pickRT || pickRT.width !== w || pickRT.height !== h) {
    if (pickRT) pickRT.dispose();
    pickRT = new THREE.WebGLRenderTarget(w, h);
  }
  const rx = Math.max(0, Math.min(w - 1, Math.floor(Math.min(x0, x1) - r.left)));
  const ry = Math.max(0, Math.min(h - 1, Math.floor(Math.min(y0, y1) - r.top)));
  const rw = Math.max(1, Math.min(w - rx, Math.ceil(Math.abs(x1 - x0)) || 1));
  const rh = Math.max(1, Math.min(h - ry, Math.ceil(Math.abs(y1 - y0)) || 1));
  shared.pickMode.value = 1;
  const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(pickRT);
  renderer.render(scene, camera);
  const buf = new Uint8Array(rw * rh * 4);
  renderer.readRenderTargetPixels(pickRT, rx, h - ry - rh, rw, rh, buf);
  renderer.setRenderTarget(null);
  renderer.setClearColor(cc, ca);
  shared.pickMode.value = 0;
  requestRender();
  const ids = new Set();
  for (let i = 0; i < buf.length; i += 4) {
    const id = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24);
    if (id > 0) ids.add(id - 1);
  }
  return ids;
}
function pickNode(x, y) {
  const ids = pickRect(x, y, x + 1, y + 1);
  for (const id of ids) return app.partNode[itemPart[id]];
  return -1;
}

let down = null, box = null;
const boxEl = $("#boxSel");
// Shift+drag: rectangle selection (capture phase, before OrbitControls sees the event).
view.addEventListener("pointerdown", (e) => {
  if (e.button === 0 && e.shiftKey && e.target === renderer.domElement) {
    e.stopPropagation();
    e.preventDefault();
    box = { x0: e.clientX, y0: e.clientY, add: e.ctrlKey || e.metaKey };
    boxEl.hidden = false;
    updateBox(e);
  }
}, true);
window.addEventListener("pointermove", (e) => { if (box) updateBox(e); });
window.addEventListener("pointerup", (e) => {
  if (!box) return;
  const b = box;
  box = null;
  boxEl.hidden = true;
  if (Math.abs(e.clientX - b.x0) < 3 && Math.abs(e.clientY - b.y0) < 3) return;
  const ids = pickRect(b.x0, b.y0, e.clientX, e.clientY);
  const nodes = new Set();
  for (const id of ids) nodes.add(app.partNode[itemPart[id]]);
  app.select([...nodes], b.add ? "add" : "replace", { reveal: false });
});
function updateBox(e) {
  const r = view.getBoundingClientRect();
  const x = Math.min(box.x0, e.clientX) - r.left, y = Math.min(box.y0, e.clientY) - r.top;
  Object.assign(boxEl.style, { left: x + "px", top: y + "px", width: Math.abs(e.clientX - box.x0) + "px", height: Math.abs(e.clientY - box.y0) + "px" });
}

renderer.domElement.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || e.shiftKey || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
  const node = pickNode(e.clientX, e.clientY);
  if (e.altKey && app.focus >= 0) { app.select([app.tree.parent[app.focus]], "replace"); return; }
  if (node < 0) { if (!(e.ctrlKey || e.metaKey)) app.clearSelection(); return; }
  app.select([node], e.ctrlKey || e.metaKey ? "toggle" : "replace");
});
renderer.domElement.addEventListener("dblclick", (e) => {
  const node = pickNode(e.clientX, e.clientY);
  if (node >= 0) app.frameNodes([node]);
});

// ---------------------------------------------------------------- toolbar & keys
$("#fit").onclick = () => fitAll();
$("#zoomSel").onclick = () => { if (app.selNodes.size) app.frameNodes([...app.selNodes]); };
document.querySelectorAll("[data-view]").forEach((b) => {
  b.onclick = () => frame(app.selNodes.size ? app.nodesBox([...app.selNodes]) : modelBox(), VIEWS[b.dataset.view].clone().normalize());
});
$("#isolate").onclick = () => { if (app.selNodes.size) app.isolate([...app.selNodes]); };
$("#hideSel").onclick = () => { if (app.selNodes.size) app.setVisible([...app.selNodes], false); };
$("#showAll").onclick = () => app.showAll();
$("#ortho").onclick = () => setOrtho(camera !== ortho);

// drop-down menus
document.querySelectorAll(".menu").forEach((m) => {
  m.querySelector(".menuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = m.classList.contains("open");
    document.querySelectorAll(".menu.open").forEach((o) => o.classList.remove("open"));
    if (!open) m.classList.add("open");
  });
  m.querySelector(".menuBody").addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON") m.classList.remove("open");
    e.stopPropagation();
  });
});
document.addEventListener("click", () => document.querySelectorAll(".menu.open").forEach((o) => o.classList.remove("open")));

window.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "f") $("#fit").click();
  else if (k === "z") $("#zoomSel").click();
  else if (k === "i") $("#isolate").click();
  else if (k === "h") $("#hideSel").click();
  else if (k === "a") $("#showAll").click();
  else if (k === "g") $("#ghost").click();
  else if (k === "l") $("#listBtn").click();
  else if (k === "escape") app.clearSelection();
});

// ---------------------------------------------------------------- loop
function animate() {
  requestAnimationFrame(animate);
  if (controls.update()) needRender = true;
  if (!needRender) return;
  needRender = false;
  if (camera === persp) {
    const d = camera.position.distanceTo(controls.target);
    const size = modelMin ? modelBox().getSize(new THREE.Vector3()).length() : 100;
    persp.near = Math.max(d / 2000, 0.0005);
    persp.far = d + size * 2;
    persp.updateProjectionMatrix();
  } else {
    ortho.near = -1e4; ortho.far = 1e4; ortho.updateProjectionMatrix();
  }
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- start
initTree(app);
initSearch(app);
initInfo(app);
initSets(app);
initColors(app);
initTable(app);
app.on("selection", () => {
  const s = app.selNodes.size;
  $("#selInfo").textContent = s ? `${s.toLocaleString("pt-BR")} selecionado(s) · ${app.selectedParts().length.toLocaleString("pt-BR")} peça(s)` : "";
});
main().catch((e) => { status("Erro: " + e.message); console.error(e); });
