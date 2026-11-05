import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

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
let meta, tree, nItems, itemPart, itemColor, itemTexData, itemTex, partBox;
let nParts, partVisible, partSelected, partNode, partItemsStart, partItems;
let visPrefix;
let selectedNode = -1;
const loaded = { chunks: 0, tris: 0 };

// ---------------------------------------------------------------- data sources
// Model data comes either from the server (viewer/data/) or from a local folder
// the user picks; a picked folder is read in the browser and never uploaded.
let src = null;

function ok(r, name) { if (!r.ok) throw new Error(name + ": HTTP " + r.status); return r; }
const httpSource = {
  json: (n) => fetch(DATA + n).then((r) => ok(r, n).json()),
  buf: (n) => fetch(DATA + n).then((r) => ok(r, n).arrayBuffer()),
};

function folderSource(files) {
  const all = new Map();
  for (const f of files) all.set((f.webkitRelativePath || f.name).replace(/\\/g, "/"), f);
  const meta = [...all.keys()].filter((k) => k.endsWith("chunks.json")).sort((a, b) => a.length - b.length)[0];
  if (!meta) throw new Error("a pasta não contém chunks.json (gerado por tools/build.py)");
  const prefix = meta.slice(0, -"chunks.json".length);
  const get = (n) => {
    const f = all.get(prefix + n);
    if (!f) throw new Error("arquivo ausente: " + n);
    return f;
  };
  return {
    json: async (n) => JSON.parse(await get(n).text()),
    buf: async (n) => get(n).arrayBuffer(),
  };
}

async function pickSource() {
  if (!new URLSearchParams(location.search).has("abrir")) {
    try {
      await httpSource.json("chunks.json");
      return httpSource;
    } catch {
      // no model on the server: ask for a local folder
    }
  }
  $("#load").textContent = "Nenhum modelo carregado";
  const card = $("#open");
  card.hidden = false;
  return new Promise((resolve) => {
    const input = $("#folder");
    input.onchange = () => {
      try {
        const s = folderSource(input.files);
        card.hidden = true;
        resolve(s);
      } catch (e) {
        $("#openErr").textContent = e.message;
      }
    };
  });
}

async function main() {
  resize();
  src = await pickSource();
  $("#load").textContent = "Carregando estrutura…";
  const [m, t, itemsBuf, partsBuf] = await Promise.all([
    src.json("chunks.json"),
    src.json("tree.json"),
    src.buf("items.bin"),
    src.buf("parts.bin"),
  ]);
  meta = m; tree = t;
  $("#title").textContent = meta.source;
  document.title = meta.source + " · Visualizador PVS";

  nItems = itemsBuf.byteLength / 8;
  const dv = new DataView(itemsBuf);
  itemPart = new Uint32Array(nItems);
  itemColor = new Uint8Array(nItems * 4);
  for (let i = 0; i < nItems; i++) {
    itemPart[i] = dv.getUint32(i * 8, true);
    for (let k = 0; k < 4; k++) itemColor[i * 4 + k] = dv.getUint8(i * 8 + 4 + k);
  }
  partBox = new Float32Array(partsBuf);
  nParts = partBox.length / 6;
  partVisible = new Uint8Array(nParts).fill(1);
  partSelected = new Uint8Array(nParts);
  partNode = new Int32Array(nParts).fill(-1);
  tree.part.forEach((p, n) => { if (p >= 0) partNode[p] = n; });
  // CSR part -> items
  const counts = new Uint32Array(nParts + 1);
  for (let i = 0; i < nItems; i++) counts[itemPart[i] + 1]++;
  for (let p = 0; p < nParts; p++) counts[p + 1] += counts[p];
  partItemsStart = counts;
  partItems = new Uint32Array(nItems);
  const fill = counts.slice();
  for (let i = 0; i < nItems; i++) partItems[fill[itemPart[i]]++] = i;

  const rows = Math.max(1, Math.ceil(nItems / TEX_W));
  itemTexData = new Uint8Array(TEX_W * rows * 4);
  itemTex = new THREE.DataTexture(itemTexData, TEX_W, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  itemTex.minFilter = itemTex.magFilter = THREE.NearestFilter;
  itemTex.generateMipmaps = false;
  shared.itemTex.value = itemTex;
  refreshItems();

  buildTree();
  fitAll(false);
  loadChunks();
  animate();
}

// ---------------------------------------------------------------- items / visibility
function refreshItems() {
  for (let i = 0; i < nItems; i++) {
    const p = itemPart[i];
    const o = i * 4;
    itemTexData[o] = itemColor[o];
    itemTexData[o + 1] = itemColor[o + 1];
    itemTexData[o + 2] = itemColor[o + 2];
    itemTexData[o + 3] = !partVisible[p] ? 0 : partSelected[p] ? 128 : 255;
  }
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

// ---------------------------------------------------------------- chunk loading
async function loadChunks() {
  const list = meta.chunks.map((c, i) => ({ c, i }));
  let next = 0;
  const total = list.length;
  const bar = $("#bar > div");
  async function worker() {
    while (next < list.length) {
      const { c } = list[next++];
      const buf = await src.buf("c/" + c.f);
      addChunk(c, buf);
      loaded.chunks++;
      loaded.tris += c.ni / 3;
      bar.style.width = (100 * loaded.chunks / total).toFixed(1) + "%";
      $("#load").textContent = loaded.chunks < total ? `Carregando geometria ${loaded.chunks}/${total}` : "Modelo carregado";
      $("#stats").textContent = `${(loaded.tris / 1e6).toFixed(1)} M triângulos · ${nParts.toLocaleString("pt-BR")} peças`;
      requestRender();
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
}

function disposeArray() { this.array = null; }

function addChunk(c, buf) {
  const verts = new Uint16Array(buf, 0, c.nv * 4);
  const idx = new Uint16Array(buf, c.nv * 8, c.ni);
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
      itemOffset: { value: c.io },
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
function modelBox() { return new THREE.Box3(new THREE.Vector3(...meta.min), new THREE.Vector3(...meta.max)); }

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
    const size = modelBox().getSize(new THREE.Vector3()).length();
    persp.near = Math.max(d / 2000, 0.0005);
    persp.far = d + size * 2;
    persp.updateProjectionMatrix();
  } else {
    ortho.near = -1e4; ortho.far = 1e4; ortho.updateProjectionMatrix();
  }
  renderer.render(scene, camera);
}

main().catch((e) => { $("#load").textContent = "Erro: " + e.message; console.error(e); });
