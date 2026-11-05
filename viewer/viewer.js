import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { parsePVS, buildTree as buildPVSTree } from "./lib/pvs.js";

const DATA = "data/";
const TEX_W = 4096;
const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- renderer
const view = $("#view");
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0xdfe3ea, 1);
view.appendChild(renderer.domElement);

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
  return c;
}

let needRender = true;
function requestRender() { needRender = true; }

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  persp.aspect = w / h;
  persp.updateProjectionMatrix();
  updateOrtho();
  requestRender();
}
window.addEventListener("resize", resize);

// ---------------------------------------------------------------- shaders
const VERT = /* glsl */ `
precision highp float;
precision highp int;
in uvec4 qpos;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 bmin;
uniform vec3 bext;
uniform int itemOffset;
uniform sampler2D itemTex;
out vec3 vView;
flat out vec4 vCol;
flat out uint vId;
void main() {
  int idx = itemOffset + int(qpos.w);
  vec4 t = texelFetch(itemTex, ivec2(idx & 4095, idx >> 12), 0);
  vCol = t;
  vId = uint(idx + 1);
  vec3 p = bmin + vec3(qpos.xyz) * (bext / 65535.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vView = mv.xyz;
  gl_Position = projectionMatrix * mv;
  if (t.a < 0.01) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
precision highp int;
in vec3 vView;
flat in vec4 vCol;
flat in uint vId;
uniform int pickMode;
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
  if (vCol.a > 0.4 && vCol.a < 0.6) base = mix(base, vec3(1.0, 0.42, 0.05), 0.7);
  vec3 c = base * (0.32 + 0.68 * d) + vec3(0.10) * pow(d, 30.0);
  outColor = vec4(c, 1.0);
}`;

const shared = {
  itemTex: { value: null },
  pickMode: { value: 0 },
  ortho: { value: 0 },
};

// ---------------------------------------------------------------- state
let title = "", tree, partBox, modelMin, modelMax;
let nItems = 0, itemPart = null, itemColor = null, itemTexData, itemTex;
let nParts, partVisible, partSelected, partNode, visPrefix;
let selectedNode = -1;
const loaded = { chunks: 0, tris: 0, parts: 0 };

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

// Register draw items (part index + RGBA); returns the global offset of the first one.
function addItems(parts, colors) {
  const off = nItems, n = parts.length;
  const grow = off + n > itemPart.length;
  if (grow) allocItems(Math.ceil((off + n) * 1.25));
  itemPart.set(parts, off);
  itemColor.set(colors, off * 4);
  nItems += n;
  if (grow) refreshItems();
  else { writeItems(off, off + n); itemTex.needsUpdate = true; }
  return off;
}

function writeItems(a, b) {
  for (let i = a; i < b; i++) {
    const p = itemPart[i], o = i * 4;
    itemTexData[o] = itemColor[o];
    itemTexData[o + 1] = itemColor[o + 1];
    itemTexData[o + 2] = itemColor[o + 2];
    itemTexData[o + 3] = !partVisible[p] ? 0 : partSelected[p] ? 128 : 255;
  }
}

function refreshItems() {
  writeItems(0, nItems);
  itemTex.needsUpdate = true;
  visPrefix = new Uint32Array(nParts + 1);
  for (let p = 0; p < nParts; p++) visPrefix[p + 1] = visPrefix[p] + partVisible[p];
  updateTreeChecks();
  requestRender();
}

function visibleCount(node) { return visPrefix[tree.p1[node]] - visPrefix[tree.p0[node]]; }

function setVisible(node, on) {
  partVisible.fill(on ? 1 : 0, tree.p0[node], tree.p1[node]);
  refreshItems();
}

function select(node, reveal = true) {
  partSelected.fill(0);
  selectedNode = node;
  if (node >= 0) partSelected.fill(1, tree.p0[node], tree.p1[node]);
  refreshItems();
  document.querySelectorAll(".row.sel").forEach((r) => r.classList.remove("sel"));
  if (node >= 0) {
    if (reveal) revealNode(node);
    const r = rowOf.get(node);
    if (r) r.classList.add("sel");
  }
  showInfo(node);
}

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

function status(t) { $("#load").textContent = t; }

async function pickModel() {
  const params = new URLSearchParams(location.search);
  if (params.get("pvs")) {
    const url = params.get("pvs");
    const buf = await fetch(url).then((r) => ok(r, url).arrayBuffer());
    return { kind: "raw", name: decodeURIComponent(url.split("/").pop()), pvs: buf, access: { base: new URL(url.slice(0, url.lastIndexOf("/") + 1), location.href).href } };
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

async function fromDirectory(dir) {
  try { await dir.getFileHandle("chunks.json"); return { kind: "converted", src: dirConverted(dir) }; } catch { /* not converted */ }
  const found = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind === "file" && name.toLowerCase().endsWith(".pvs")) { found.push(h); break; }
  }
  if (!found.length) throw new Error("A pasta não tem arquivo .pvs nem um modelo convertido (chunks.json). Escolha a pasta que contém o .pvs e os arquivos .ol.");
  const f = await found[0].getFile();
  return { kind: "raw", name: f.name, pvs: await f.arrayBuffer(), access: { dir } };
}

async function fromFileList(files) {
  const all = new Map();
  for (const f of files) all.set((f.webkitRelativePath || f.name).replace(/\\/g, "/"), f);
  const keys = [...all.keys()];
  const meta = keys.filter((k) => k.endsWith("chunks.json")).sort((a, b) => a.length - b.length)[0];
  if (meta) return { kind: "converted", src: filesConverted(all, meta.slice(0, -"chunks.json".length)) };
  const pvs = keys.filter((k) => k.toLowerCase().endsWith(".pvs")).sort((a, b) => a.length - b.length)[0];
  if (!pvs) throw new Error("A pasta não tem arquivo .pvs nem um modelo convertido (chunks.json). Escolha a pasta que contém o .pvs e os arquivos .ol.");
  const prefix = pvs.slice(0, pvs.lastIndexOf("/") + 1);
  const byName = new Map();
  for (const [k, f] of all) if (k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) byName.set(k.slice(prefix.length), f);
  const f = all.get(pvs);
  return { kind: "raw", name: f.name, pvs: await f.arrayBuffer(), access: { files: byName } };
}

// ---------------------------------------------------------------- model setup
function setModel(name, t, boxes, lo, hi) {
  title = name;
  tree = t;
  partBox = boxes;
  modelMin = lo; modelMax = hi;
  nParts = partBox.length / 6;
  partVisible = new Uint8Array(nParts).fill(1);
  partSelected = new Uint8Array(nParts);
  partNode = new Int32Array(nParts).fill(-1);
  tree.part.forEach((p, n) => { if (p >= 0) partNode[p] = n; });
  $("#title").textContent = name;
  document.title = name + " · Visualizador PVS";
  allocItems(Math.max(nParts * 1.3, TEX_W));
  refreshItems();
  buildTree();
  fitAll(false);
}

async function main() {
  resize();
  animate();
  const m = await pickModel();
  status("Carregando estrutura…");
  if (m.kind === "converted") await loadConverted(m.src);
  else await loadRaw(m);
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
  let next = 0;
  const bar = $("#bar > div");
  async function fetcher() {
    while (next < list.length) {
      const c = list[next++];
      const buf = await src.buf("c/" + c.f);
      addChunk(c, new Uint16Array(buf, 0, c.nv * 4), new Uint16Array(buf, c.nv * 8, c.ni), c.io);
      loaded.chunks++;
      bar.style.width = (100 * loaded.chunks / list.length).toFixed(1) + "%";
      status(loaded.chunks < list.length ? `Carregando geometria ${loaded.chunks}/${list.length}` : "Modelo carregado");
    }
  }
  await Promise.all(Array.from({ length: 6 }, fetcher));
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
  let missing = 0, next = 0;
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
    w.onmessage = (e) => {
      const d = e.data;
      if (d.type === "chunk") {
        const io = addItems(d.items, d.colors);
        addChunk(d, d.verts, d.idx, io);
      } else if (d.type === "error") {
        console.error("worker:", d.message);
        missing += TASK;
        loaded.parts = Math.min(total, loaded.parts + TASK);
        send();
      } else if (d.type === "done") {
        loaded.parts = Math.min(total, loaded.parts + TASK);
        missing += d.missing;
        bar.style.width = (100 * loaded.parts / total).toFixed(1) + "%";
        const secs = ((performance.now() - t0) / 1000).toFixed(0);
        status(`Lendo peças ${loaded.parts.toLocaleString("pt-BR")}/${total.toLocaleString("pt-BR")} · ${secs}s`);
        send();
      }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || "erro no worker")); };
    send();
  });
  await Promise.all(Array.from({ length: nWorkers }, runWorker));
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  status(`Modelo carregado em ${secs}s` + (missing ? ` · ${missing} arquivo(s) .ol ausente(s) ou ilegível(is)` : ""));
}

function disposeArray() { this.array = null; }

function addChunk(c, verts, idx, io) {
  loaded.tris += c.ni / 3;
  $("#stats").textContent = `${(loaded.tris / 1e6).toFixed(1)} M triângulos · ${nParts.toLocaleString("pt-BR")} peças`;
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
  const mat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      bmin: { value: min },
      bext: { value: max.clone().sub(min) },
      itemOffset: { value: io },
      itemTex: shared.itemTex,
      pickMode: shared.pickMode,
      ortho: shared.ortho,
    },
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(g, mat);
  mesh.matrixAutoUpdate = false;
  scene.add(mesh);
}

// ---------------------------------------------------------------- camera helpers
function modelBox() { return new THREE.Box3(new THREE.Vector3(...modelMin), new THREE.Vector3(...modelMax)); }

function nodeBox(node) {
  const b = new THREE.Box3();
  for (let p = tree.p0[node]; p < tree.p1[node]; p++) {
    const o = p * 6;
    if (partBox[o] === 0 && partBox[o + 3] === 0 && partBox[o + 1] === 0 && partBox[o + 4] === 0) continue;
    b.expandByPoint(new THREE.Vector3(partBox[o], partBox[o + 1], partBox[o + 2]));
    b.expandByPoint(new THREE.Vector3(partBox[o + 3], partBox[o + 4], partBox[o + 5]));
  }
  return b;
}

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
const pickRT = new THREE.WebGLRenderTarget(1, 1);
const pickBuf = new Uint8Array(4);
function pick(clientX, clientY) {
  const r = renderer.domElement.getBoundingClientRect();
  const x = (clientX - r.left) * renderer.getPixelRatio();
  const y = (clientY - r.top) * renderer.getPixelRatio();
  const w = r.width * renderer.getPixelRatio(), h = r.height * renderer.getPixelRatio();
  camera.setViewOffset(w, h, x, y, 1, 1);
  shared.pickMode.value = 1;
  const cc = renderer.getClearColor(new THREE.Color()), ca = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(pickRT);
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(pickRT, 0, 0, 1, 1, pickBuf);
  renderer.setRenderTarget(null);
  renderer.setClearColor(cc, ca);
  shared.pickMode.value = 0;
  camera.clearViewOffset();
  requestRender();
  const id = pickBuf[0] | (pickBuf[1] << 8) | (pickBuf[2] << 16) | (pickBuf[3] << 24);
  return id > 0 ? id - 1 : -1;
}

let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => { down = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
  const item = pick(e.clientX, e.clientY);
  if (item < 0) { select(-1); return; }
  const node = partNode[itemPart[item]];
  // second click on the selected part climbs to its parent assembly
  if (e.detail === 1 && selectedNode >= 0 && e.altKey) select(tree.parent[selectedNode]);
  else select(node);
});
renderer.domElement.addEventListener("dblclick", (e) => {
  const item = pick(e.clientX, e.clientY);
  if (item >= 0) frame(nodeBox(partNode[itemPart[item]]));
});

// ---------------------------------------------------------------- tree UI
const treeEl = $("#tree");
let kids;
const rowOf = new Map();
const expanded = new Set();

function buildTree() {
  const n = tree.names.length;
  kids = Array.from({ length: n }, () => null);
  for (let i = 1; i < n; i++) {
    const p = tree.parent[i];
    (kids[p] || (kids[p] = [])).push(i);
  }
  treeEl.innerHTML = "";
  treeEl.appendChild(makeRow(0, 0));
  toggleExpand(0);
}

function makeRow(node, depth) {
  const wrap = document.createElement("div");
  wrap.className = "node";
  const row = document.createElement("div");
  row.className = "row";
  row.style.paddingLeft = (4 + depth * 14) + "px";
  const tw = document.createElement("span");
  tw.className = "tw";
  tw.textContent = kids[node] ? "▸" : "";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = tree.names[node];
  nm.title = tree.names[node];
  row.append(tw, cb);
  row.append(nm);
  if (kids[node]) {
    const cnt = document.createElement("span");
    cnt.className = "cnt";
    cnt.textContent = (tree.p1[node] - tree.p0[node]).toLocaleString("pt-BR");
    row.append(cnt);
  }
  wrap.append(row);
  wrap.dataset.depth = depth;
  row._node = node;
  row._cb = cb;
  rowOf.set(node, row);
  setCheck(row);
  tw.addEventListener("click", (e) => { e.stopPropagation(); toggleExpand(node); });
  cb.addEventListener("click", (e) => { e.stopPropagation(); setVisible(node, cb.checked); });
  row.addEventListener("click", () => select(node, false));
  row.addEventListener("dblclick", () => { if (kids[node]) toggleExpand(node); frame(nodeBox(node)); });
  if (node === selectedNode) row.classList.add("sel");
  return wrap;
}

function setCheck(row) {
  const node = row._node;
  const total = tree.p1[node] - tree.p0[node];
  const v = visPrefix ? visibleCount(node) : total;
  row._cb.checked = v > 0;
  row._cb.indeterminate = v > 0 && v < total;
}

function updateTreeChecks() { for (const row of rowOf.values()) setCheck(row); }

function toggleExpand(node, force) {
  const row = rowOf.get(node);
  if (!row || !kids[node]) return;
  const wrap = row.parentElement;
  const open = force !== undefined ? force : !expanded.has(node);
  if (open === expanded.has(node)) return;
  if (open) {
    expanded.add(node);
    row.firstChild.textContent = "▾";
    const box = document.createElement("div");
    box.className = "kids";
    const depth = +wrap.dataset.depth + 1;
    for (const k of kids[node]) box.appendChild(makeRow(k, depth));
    wrap.appendChild(box);
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

function ancestors(node) {
  const a = [];
  for (let p = tree.parent[node]; p >= 0; p = tree.parent[p]) a.push(p);
  return a.reverse();
}

function revealNode(node) {
  if (searchActive) clearSearch();
  for (const a of ancestors(node)) toggleExpand(a, true);
  const r = rowOf.get(node);
  if (r) r.scrollIntoView({ block: "nearest" });
}

function showInfo(node) {
  const el = $("#info");
  if (node < 0) { el.textContent = "Clique numa peça no modelo ou na árvore."; return; }
  const path = ancestors(node).map((a) => tree.names[a]).join(" / ");
  const b = nodeBox(node);
  const s = b.isEmpty() ? null : b.getSize(new THREE.Vector3());
  const parts = tree.p1[node] - tree.p0[node];
  el.innerHTML = "";
  const h = document.createElement("div");
  h.style.fontWeight = "600";
  h.textContent = tree.names[node];
  const p = document.createElement("div");
  p.className = "path";
  p.textContent = path;
  const d = document.createElement("div");
  d.textContent = `${parts.toLocaleString("pt-BR")} peça(s)` + (s ? ` · ${s.x.toFixed(3)} × ${s.y.toFixed(3)} × ${s.z.toFixed(3)} m` : "");
  el.append(h, p, d);
}

// ---------------------------------------------------------------- search
const searchEl = $("#search");
let searchActive = false, searchTimer = 0;
let lowerNames = null;
searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 200);
});
searchEl.addEventListener("keydown", (e) => { if (e.key === "Escape") { searchEl.value = ""; clearSearch(); } });

function runSearch() {
  const q = searchEl.value.trim().toLowerCase();
  if (!q) { clearSearch(); return; }
  if (!lowerNames) lowerNames = tree.names.map((s) => s.toLowerCase());
  const hits = [];
  for (let i = 0; i < lowerNames.length && hits.length < 500; i++) if (lowerNames[i].includes(q)) hits.push(i);
  searchActive = true;
  treeEl.style.display = "none";
  let res = $("#results");
  if (!res) { res = document.createElement("div"); res.id = "results"; res.style.cssText = "flex:1;overflow:auto"; treeEl.after(res); }
  res.style.display = "";
  res.innerHTML = "";
  const head = document.createElement("div");
  head.className = "row";
  head.style.color = "var(--muted)";
  head.style.paddingLeft = "8px";
  head.textContent = hits.length >= 500 ? "500+ resultados" : `${hits.length} resultado(s)`;
  res.append(head);
  for (const n of hits) {
    const r = document.createElement("div");
    r.className = "row";
    r.textContent = tree.names[n];
    r.title = ancestors(n).map((a) => tree.names[a]).join(" / ");
    r.addEventListener("click", () => { select(n, false); });
    r.addEventListener("dblclick", () => { select(n); frame(nodeBox(n)); });
    res.append(r);
  }
}

function clearSearch() {
  searchActive = false;
  treeEl.style.display = "";
  const res = $("#results");
  if (res) res.style.display = "none";
}

// ---------------------------------------------------------------- toolbar & keys
$("#fit").onclick = () => fitAll();
$("#zoomSel").onclick = () => { if (selectedNode >= 0) frame(nodeBox(selectedNode)); };
document.querySelectorAll("[data-view]").forEach((b) => {
  b.onclick = () => frame(selectedNode >= 0 ? nodeBox(selectedNode) : modelBox(), VIEWS[b.dataset.view].clone().normalize());
});
$("#isolate").onclick = () => {
  if (selectedNode < 0) return;
  partVisible.fill(0);
  partVisible.fill(1, tree.p0[selectedNode], tree.p1[selectedNode]);
  refreshItems();
};
$("#hideSel").onclick = () => { if (selectedNode >= 0) setVisible(selectedNode, false); };
$("#showAll").onclick = () => { partVisible.fill(1); refreshItems(); };
$("#ortho").onclick = () => setOrtho(camera !== ortho);
window.addEventListener("keydown", (e) => {
  if (e.target === searchEl) return;
  const k = e.key.toLowerCase();
  if (k === "f") $("#fit").click();
  else if (k === "z") $("#zoomSel").click();
  else if (k === "i") $("#isolate").click();
  else if (k === "h") $("#hideSel").click();
  else if (k === "a") $("#showAll").click();
  else if (k === "escape") select(-1);
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

main().catch((e) => { $("#load").textContent = "Erro: " + e.message; console.error(e); });
