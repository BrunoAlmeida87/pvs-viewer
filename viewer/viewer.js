// Core of the viewer: rendering, model loading, picking, navigation and the shared state that
// the UI modules (ui/*.js) read and change through the `app` object.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { parsePVS, buildTree as buildPVSTree } from "./lib/pvs.js";
import { SSAO } from "./lib/post.js";
import { ViewCube } from "./lib/viewcube.js";
import { loadOL, weld, edgeOwners } from "./lib/ol.js";
import { chooseRegions, initRegions } from "./ui/regions.js";
import { initMeasure } from "./ui/measure.js";
import { initViews } from "./ui/views.js";
import { initAnalysis } from "./ui/analysis.js";
import { initLayout } from "./ui/layout.js";
import { initNeighbor } from "./ui/neighbor.js";
import { initLayers } from "./ui/layers.js";
import { initBigrama } from "./ui/bigrama.js";
import { initAnim } from "./ui/anim.js";
import { initContextMenu } from "./ui/ctxmenu.js";
import { initViewTabs } from "./ui/viewtabs.js";
import { addBigrama } from "./lib/bigrama.js";
import { initTree } from "./ui/tree.js";
import { initStructure } from "./ui/structure.js";
import { initSearch } from "./ui/search.js";
import { initInfo } from "./ui/info.js";
import { initSets } from "./ui/sets.js";
import { initColors } from "./ui/colors.js";
import { initTable } from "./ui/table.js";
import { initDisplay } from "./ui/display.js";
import { $, status, store } from "./ui/util.js";
import { convertModel } from "./lib/convert.js";
import { exportMobileZip } from "./lib/browser-mobile-export.js";
import { exportRawModelZip } from "./lib/raw-model-export.js";
import { previewChunks, completedParts, MOBILE_PREVIEW_TRIANGLES } from "./lib/mobile-preview.js";
import { zipConverted } from "./lib/zipsrc.js";
import { addRecent, listRecent, removeRecent, allow, canKeep, keepZip, keptFile, dropKept, sizeText } from "./lib/recent.js";
import { initMobile } from "./ui/mobile.js";
import { initUndo } from "./ui/undo.js";
import { initAR } from "./ui/ar.js";
import { initLabels } from "./ui/labels.js";

const DATA = "data/";
const TEX_W = 4096;
// "touch": finger as the main pointer (phones and tablets): lighter defaults. "mobile": a phone,
// which also gets the compact full-screen layout (ui/mobile.js).
const touch = document.documentElement.classList.contains("touch");
const mobile = document.documentElement.classList.contains("mobile");

// ---------------------------------------------------------------- app / events
const listeners = {};
export const app = {
  on(ev, fn) { (listeners[ev] || (listeners[ev] = [])).push(fn); },
  emit(ev, ...a) { (listeners[ev] || []).forEach((f) => f(...a)); },
  title: "", tree: null, nNodes: 0, nParts: 0,
  selNodes: new Set(), focus: -1, ghost: false, lastResults: [],
  access: null, // how to read model files (thumbnails): {dir} | {files} | {base}
  // display: style 0 shaded, 1 shaded + edges, 2 hidden line, 3 edges only, 4 x-ray
  // quality: "high" draws everything, "auto" skips sub-pixel parts (more while moving),
  // "fast" also drops edges/SSAO and resolution while moving
  display: { style: 0, smooth: true, ssao: false, bg: "grad", light: "cam", bright: 100, cube: true, quality: "auto", perf: false, hover: true },
  tool: null, // when set, clicks in the 3D view go to tool(pickInfo, event) instead of selecting
  // plane: free section plane {p: point, n: normal (towards the side removed), depth: m along -n, flip} or null
  clip: { axes: [0, 1, 2].map(() => ({ on: false, lo: 0, hi: 1 })), invert: false, cap: true, show: true, plane: null },
  explode: { amount: 0, level: 1, selOnly: false },
};

// ---------------------------------------------------------------- renderer
const view = $("#view");
const renderer = new THREE.WebGLRenderer({ antialias: !touch, alpha: true, powerPreference: "high-performance" });
// At rest the view is drawn at up to 2 device pixels per CSS pixel (sharp on phone screens too);
// while the camera moves the resolution may drop (see the quality presets in the render loop).
const baseRatio = () => Math.min(window.devicePixelRatio || 1, 2);
let curRatio = baseRatio();
renderer.setPixelRatio(curRatio);
renderer.setClearColor(0x000000, 0); // the background is the CSS of #view
// Every chunk has its own material, and three.js sorts opaque objects by material before depth:
// without this the chunks would be drawn in loading order. Front to back lets the depth test
// discard hidden pixels before they are shaded.
renderer.setOpaqueSort((a, b) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || a.z - b.z || a.id - b.id);
view.prepend(renderer.domElement);

const scene = new THREE.Scene();
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const persp = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
persp.up.set(0, 0, 1);
ortho.up.set(0, 0, 1);
let camera = persp;
let controls = makeControls(camera);
const cube = new ViewCube();
let ssao = null;

function makeControls(cam) {
  const c = new OrbitControls(cam, renderer.domElement);
  c.enableDamping = true;
  c.dampingFactor = 0.15;
  c.zoomToCursor = true;
  c.screenSpacePanning = true;
  c.enableRotate = false; // rotation is done here, around the point under the cursor
  c.addEventListener("change", () => { lastMove = performance.now(); requestRender(); });
  c.addEventListener("start", () => { userMoved = true; tween = null; fly = null; });
  return c;
}
let userMoved = false;
let lastMove = 0; // last camera movement (level of detail is lower while moving)

let needRender = true;
function requestRender() { needRender = true; }
app.requestRender = requestRender;

function resize() {
  if (renderer.xr.isPresenting) return; // the AR session sets the size; app.xr.end() calls this again
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false);
  const svg = document.querySelector("#overlay");
  if (svg) { svg.setAttribute("width", w); svg.setAttribute("height", h); svg.setAttribute("viewBox", `0 0 ${w} ${h}`); }
  persp.aspect = w / Math.max(1, h);
  persp.updateProjectionMatrix();
  updateOrtho();
  requestRender();
}
new ResizeObserver(resize).observe(view);

// ---------------------------------------------------------------- shaders
// itemTex: one texel per draw item.  rgb = colour, a = state:
//   0 = hidden, otherwise bit 7 = selected and bits 0..6 = opacity (127 = opaque).
// offTex: per item xyz offset (exploded view).
// Every chunk is drawn twice: pass 0 draws opaque items, pass 1 the translucent ones.
// pickMode 1 writes item ids, 2 writes the view depth (float bits).
const COMMON = /* glsl */ `
precision highp float;
precision highp int;
uniform int pickMode;
uniform int style;
uniform int clipOn;
uniform int clipInvert;
uniform vec3 clipMin;
uniform vec3 clipMax;
uniform int planeOn;  // free section plane: removes where dot(w, plane.xyz) > plane.w
uniform vec4 plane;
uniform int nbClip;   // neighbourhood cut: 0 off, 1 sphere, 2 box
uniform vec3 nbC;
uniform float nbR;
uniform vec3 nbMin;
uniform vec3 nbMax;
bool clipped(vec3 w) {
  if (planeOn == 1 && dot(w, plane.xyz) > plane.w) return true;
  if (nbClip == 1 && distance(w, nbC) > nbR) return true;
  if (nbClip == 2 && (any(lessThan(w, nbMin)) || any(greaterThan(w, nbMax)))) return true;
  if (clipOn == 0) return false;
  bool inside = all(greaterThanEqual(w, clipMin)) && all(lessThanEqual(w, clipMax));
  return clipInvert == 1 ? inside : !inside;
}
vec4 packId(uint id) {
  return vec4(float(id & 255u), float((id >> 8) & 255u), float((id >> 16) & 255u), float(id >> 24)) / 255.0;
}`;

const VERT_HEAD = /* glsl */ `
in uvec4 qpos;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec3 bmin;
uniform vec3 bext;
uniform int itemOffset;
uniform int exploded;
uniform sampler2D itemTex;
uniform sampler2D offTex;
out vec3 vView;
out vec3 vWorld;
flat out vec4 vCol;
flat out float vSel;
flat out uint vId;
int op;
bool sel;
vec4 itemState(out ivec2 tc) {
  int idx = itemOffset + int(qpos.w);
  tc = ivec2(idx & 4095, idx >> 12);
  vec4 t = texelFetch(itemTex, tc, 0);
  int av = int(t.a * 255.0 + 0.5);
  op = av & 127;
  sel = av >= 128;
  vId = uint(idx + 1);
  vSel = sel ? 1.0 : 0.0;
  return t;
}
vec4 place(ivec2 tc) {
  vec3 p = bmin + vec3(qpos.xyz) * (bext / 65535.0);
  if (exploded == 1) p += texelFetch(offTex, tc, 0).xyz;
  vWorld = p;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vView = mv.xyz;
  return projectionMatrix * mv;
}`;

const VERT = COMMON + VERT_HEAD + /* glsl */ `
in vec4 nrm;
uniform mat3 normalMatrix;
uniform int pass;
out vec3 vNormal;
const int XRAY_OP = 20;
void main() {
  ivec2 tc;
  vec4 t = itemState(tc);
  if (style == 4 && pickMode == 0 && !sel && op > XRAY_OP) op = XRAY_OP;
  bool draw = op > 0 && (pass == 0 ? op == 127 : op < 127);
  if (pickMode != 0 && pass == 1) draw = false;
  vCol = vec4(t.rgb, float(op) / 127.0);
  vNormal = normalMatrix * nrm.xyz;
  vec4 p = place(tc);
  gl_Position = draw ? p : vec4(0.0, 0.0, 2.0, 1.0);
}`;

const FRAG = COMMON + /* glsl */ `
in vec3 vView;
in vec3 vWorld;
in vec3 vNormal;
flat in vec4 vCol;
flat in float vSel;
flat in uint vId;
uniform int pass;
uniform int ortho;
uniform int smoothOn;
uniform int capOn;
uniform vec3 light;   // ambient, diffuse, specular
uniform vec3 skyDir;  // view space
uniform float skyMix;
uniform float bright;
out vec4 outColor;
void main() {
  if ((clipOn == 1 || nbClip > 0 || planeOn == 1) && clipped(vWorld)) discard;
  if (pickMode == 1) { outColor = packId(vId); return; }
  if (pickMode == 2) { outColor = packId(floatBitsToUint(-vView.z)); return; }
  vec3 base = vCol.rgb;
  if (style == 2) base = vec3(1.0);
  if (vSel > 0.5) base = mix(base, vec3(1.0, 0.42, 0.05), style == 2 ? 0.35 : 0.7);
  if (capOn == 1 && (clipOn == 1 || nbClip > 0 || planeOn == 1) && !gl_FrontFacing) {
    // inside of a cut solid: flat hatched cap
    vec3 c = base * 0.62 * bright;
    if (mod(gl_FragCoord.x - gl_FragCoord.y, 7.0) < 1.3) c *= 0.55;
    outColor = vec4(c, 1.0);
    return;
  }
  if (style == 2) { outColor = vec4(base, 1.0); return; }
  vec3 fn = normalize(cross(dFdx(vView), dFdy(vView))); // faces the camera
  vec3 n = fn;
  if (smoothOn == 1) {
    float l = length(vNormal);
    if (l > 0.05) {
      vec3 s = vNormal / l;
      if (!gl_FrontFacing) s = -s;
      if (dot(s, fn) > 0.82) n = s; // a normal far from the facet comes from a crease: stay flat
    }
  }
  vec3 V = ortho == 1 ? vec3(0.0, 0.0, 1.0) : normalize(-vView);
  float d = max(dot(n, V), 0.0);
  float dif = mix(d, 0.55 * d + 0.45 * (0.5 + 0.5 * dot(n, skyDir)), skyMix);
  vec3 c = (base * (light.x + light.y * dif) + vec3(light.z) * pow(d, 30.0)) * bright;
  float a = 1.0;
  if (pass == 1) {
    a = vCol.a;
    if (style == 4 && vSel < 0.5) { float f = 1.0 - d; a = clamp(a * (0.6 + 2.4 * f * f), 0.04, 0.6); }
  }
  outColor = vec4(c, a);
}`;

const EDGE_VERT = COMMON + VERT_HEAD + /* glsl */ `
void main() {
  ivec2 tc;
  vec4 t = itemState(tc);
  bool draw = op > 0 && (style == 3 || op == 127);
  vCol = vec4(t.rgb, float(op) / 127.0);
  vec4 p = place(tc);
  gl_Position = draw ? p : vec4(0.0, 0.0, 2.0, 1.0);
}`;

const EDGE_FRAG = COMMON + /* glsl */ `
in vec3 vView;
in vec3 vWorld;
flat in vec4 vCol;
flat in float vSel;
flat in uint vId;
out vec4 outColor;
void main() {
  if ((clipOn == 1 || nbClip > 0 || planeOn == 1) && clipped(vWorld)) discard;
  if (pickMode == 1) { outColor = packId(vId); return; }
  if (pickMode == 2) { outColor = packId(floatBitsToUint(-vView.z)); return; }
  vec3 c = style == 3 ? vCol.rgb * 0.9 : style == 2 ? vec3(0.08) : vCol.rgb * 0.22;
  if (vSel > 0.5) c = style == 3 ? vec3(1.0, 0.42, 0.05) : vec3(0.7, 0.22, 0.0);
  outColor = vec4(c, 1.0);
}`;

const shared = {
  itemTex: { value: null }, offTex: { value: null }, pickMode: { value: 0 }, ortho: { value: 0 },
  style: { value: 0 }, smoothOn: { value: 1 }, exploded: { value: 0 },
  clipOn: { value: 0 }, clipInvert: { value: 0 }, capOn: { value: 1 },
  clipMin: { value: new THREE.Vector3() }, clipMax: { value: new THREE.Vector3() },
  planeOn: { value: 0 }, plane: { value: new THREE.Vector4() },
  nbClip: { value: 0 }, nbC: { value: new THREE.Vector3() }, nbR: { value: 1 },
  nbMin: { value: new THREE.Vector3() }, nbMax: { value: new THREE.Vector3() },
  light: { value: new THREE.Vector3(0.32, 0.68, 0.1) }, skyDir: { value: new THREE.Vector3(0, 0, 1) },
  skyMix: { value: 0 }, bright: { value: 1 },
};

// ---------------------------------------------------------------- item state
let nItems = 0, itemPart = null, itemColor = null, itemTexData, itemTex, offTexData, offTex;
let partFirstItem;
const chunks = []; // {io, ic, mesh, meshT, edgeIdx, edges, geo, q, min, max}

// ---------------------------------------------------------------- layers
// Creo layers of each draw item (from the .ol faces). Hidden layers are not drawn.
let itemLayer = null;
app.layers = [];            // layer names, by id ("" = no layer)
const layerId = new Map();  // name -> id
let layerHidden = new Uint8Array(16);
app.hiddenLayers = new Set(["99"]); // layer 99: the space an equipment may take (door swing…)
function layerOf(name) {
  let id = layerId.get(name);
  if (id === undefined) {
    id = app.layers.length;
    app.layers.push(name);
    layerId.set(name, id);
    if (id >= layerHidden.length) { const h = new Uint8Array(layerHidden.length * 2); h.set(layerHidden); layerHidden = h; }
    layerHidden[id] = app.hiddenLayers.has(name) ? 1 : 0;
    layersChanged = true;
  }
  return id;
}
let layersChanged = false;
app.layerIdOfItem = (i) => itemLayer[i];
app.itemCount = () => nItems;
app.itemPart = (i) => itemPart[i];
app.setLayersHidden = function (names) {
  app.hiddenLayers = new Set(names);
  app.layers.forEach((n, id) => { layerHidden[id] = app.hiddenLayers.has(n) ? 1 : 0; });
  geomCache.clear();
  if (app.geom) app.geom.forget();
  app.refresh();
  app.emit("layers");
};
app.isLayerHidden = (name) => app.hiddenLayers.has(name);

function allocItems(cap) {
  const rows = Math.max(1, Math.ceil(cap / TEX_W));
  const n = rows * TEX_W;
  const np = new Uint32Array(n), nc = new Uint8Array(n * 4), nl = new Uint16Array(n);
  if (itemPart) { np.set(itemPart.subarray(0, nItems)); nc.set(itemColor.subarray(0, nItems * 4)); nl.set(itemLayer.subarray(0, nItems)); }
  itemPart = np; itemColor = nc; itemLayer = nl;
  itemTexData = new Uint8Array(n * 4);
  if (itemTex) itemTex.dispose();
  itemTex = new THREE.DataTexture(itemTexData, TEX_W, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  itemTex.minFilter = itemTex.magFilter = THREE.NearestFilter;
  itemTex.generateMipmaps = false;
  shared.itemTex.value = itemTex;
  offTexData = new Float32Array(n * 4);
  if (offTex) offTex.dispose();
  offTex = new THREE.DataTexture(offTexData, TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
  offTex.minFilter = offTex.magFilter = THREE.NearestFilter;
  offTex.generateMipmaps = false;
  shared.offTex.value = offTex;
  if (partOffset) writeOffsets();
}

// layers: per item, layer names (array) or ids into `names` (Uint16Array, converted folders)
function addItems(parts, colors, layers, names) {
  const off = nItems, n = parts.length;
  const grow = off + n > itemPart.length;
  if (grow) allocItems(Math.ceil((off + n) * 1.25));
  itemPart.set(parts, off);
  itemColor.set(colors, off * 4);
  for (let i = 0; i < n; i++) {
    const l = layers ? layers[i] : "";
    itemLayer[off + i] = layerOf(names ? (l === 65535 ? "" : names[l] ?? "") : l ?? "");
  }
  if (layersChanged) { layersChanged = false; queueMicrotask(() => app.emit("layers")); }
  for (let i = 0; i < n; i++) if (partFirstItem[parts[i]] < 0) partFirstItem[parts[i]] = off + i;
  nItems += n;
  if (grow) app.refresh();
  else { writeItems(off, off + n); itemTex.needsUpdate = true; }
  if (partOffset) writeOffsets();
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
    let op = partVisible[p] && !layerHidden[itemLayer[i]] ? partOpacity[p] : 0;
    const sel = partSel[p];
    if (ghost && !sel && op > GHOST_OP) op = GHOST_OP;
    let op7 = Math.round(op / 255 * 127);
    if (op > 0 && op7 === 0) op7 = 1;
    itemTexData[o + 3] = op7 === 0 ? 0 : (sel ? 128 : 0) | op7;
  }
}

// Part under the mouse (desktop): its items are drawn a little lighter. The items of a part are
// found through an index built on demand (items arrive chunk by chunk while loading).
let hoverPart = -1, partItems = null;
function itemsIndex() {
  if (partItems && partItems.n === nItems) return partItems;
  const start = new Uint32Array(app.nParts + 2);
  for (let i = 0; i < nItems; i++) start[itemPart[i] + 2]++;
  for (let p = 0; p < app.nParts; p++) start[p + 2] += start[p + 1];
  const list = new Uint32Array(nItems);
  for (let i = 0; i < nItems; i++) list[start[itemPart[i] + 1]++] = i;
  partItems = { n: nItems, start, list };
  return partItems;
}
function paintHover() {
  if (hoverPart < 0 || hoverPart >= app.nParts) return;
  const { start, list } = itemsIndex();
  for (let k = start[hoverPart]; k < start[hoverPart + 1]; k++) {
    const o = list[k] * 4;
    for (let c = 0; c < 3; c++) itemTexData[o + c] += (255 - itemTexData[o + c]) * 0.4;
  }
}
function setHoverPart(p) {
  if (p === hoverPart) return;
  if (hoverPart >= 0 && hoverPart < app.nParts) {
    const { start, list } = itemsIndex();
    for (let k = start[hoverPart]; k < start[hoverPart + 1]; k++) writeItems(list[k], list[k] + 1);
  }
  hoverPart = p;
  paintHover();
  if (itemTex) itemTex.needsUpdate = true;
  requestRender();
}

// Which meshes take part in the frame, from the item states and the display style. The result
// is stored in c.want; applyLod() then drops chunks whose parts are too small on screen.
function updateVisibility() {
  const st = app.display.style;
  for (const c of chunks) {
    let any = false, shown = false;
    for (let i = c.io; i < c.io + c.ic && !(any && shown); i++) {
      const a = itemTexData[i * 4 + 3] & 127;
      if (a > 0) shown = true;
      if (a > 0 && a < 127) any = true;
    }
    c.want = { m: shown && st !== 3, t: shown && st !== 3 && (any || st === 4), e: shown && st >= 1 && st <= 3 };
  }
  applyLod(0);
}

// Level of detail: hide chunks whose largest part would cover fewer than `minPx` pixels.
const _box = new THREE.Box3();
let drawnTris = 0, drawnChunks = 0;
// `eye` and `fpx` (focal length in pixels) replace the camera's (augmented reality).
function applyLod(minPx, noEdges = false, eye = null, fpx = 0) {
  const H = view.clientHeight;
  const f = fpx || H / (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)));
  const orthoH = (ortho.top - ortho.bottom) / ortho.zoom;
  const cull = minPx > 0 && !partOffset && !walk.on;
  drawnTris = 0; drawnChunks = 0;
  for (const c of chunks) {
    const w = c.want || { m: true, t: false, e: false };
    let hide = false;
    if (cull && c.ps) {
      const px = eye ? c.ps * f / Math.max(1e-6, _box.set(c.min, c.max).distanceToPoint(eye))
        : camera === persp ? c.ps * f / Math.max(1e-6, _box.set(c.min, c.max).distanceToPoint(camera.position)) : c.ps * H / orthoH;
      hide = px < minPx;
    }
    c.mesh.visible = w.m && !hide;
    c.meshT.visible = w.t && !hide;
    if (c.edges) c.edges.visible = w.e && !hide && !noEdges;
    if (c.mesh.visible || c.meshT.visible) { drawnTris += c.ni / 3; drawnChunks++; }
  }
}

// Re-derive the GPU state after any change of visibility, selection or colour.
app.refresh = function () {
  writeItems(0, nItems);
  paintHover();
  itemTex.needsUpdate = true;
  updateVisibility();
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
// app.checkpoint() (ui/undo.js) remembers visibility, colours and opacity for Ctrl+Z.
app.checkpoint = () => {};
app.setVisible = (nodes, on) => { app.checkpoint(); fillParts(app.partVisible, nodes, on ? 1 : 0); app.refresh(); };
app.isolate = (nodes) => { app.checkpoint(); app.partVisible.fill(0); fillParts(app.partVisible, nodes, 1); app.refresh(); };
app.showAll = () => { app.checkpoint(); app.partVisible.fill(1); app.refresh(); };
app.setColor = (nodes, rgb) => { app.checkpoint(); fillParts(app.partColor, nodes, rgb == null ? -1 : rgb); app.refresh(); };
app.setOpacity = (nodes, op) => { app.checkpoint(); fillParts(app.partOpacity, nodes, op); app.refresh(); };
app.setRule = (arr) => { app.partRule = arr; app.refresh(); };
app.resetColors = () => {
  app.checkpoint();
  app.partColor.fill(-1); app.partOpacity.fill(255); app.partRule = null;
  app.emit("rule", null);
  app.refresh();
};
app.setGhost = (on) => { app.ghost = on; app.refresh(); };

// ---------------------------------------------------------------- display
const LIGHTS = {
  cam: { light: [0.32, 0.68, 0.10], sky: 0 },
  sky: { light: [0.26, 0.74, 0.08], sky: 1 },
  flat: { light: [1.0, 0.0, 0.0], sky: 0 },
};

app.setDisplay = function (patch) {
  Object.assign(app.display, patch);
  const d = app.display;
  shared.style.value = d.style;
  shared.smoothOn.value = d.smooth ? 1 : 0;
  shared.bright.value = d.bright / 100;
  const L = LIGHTS[d.light] || LIGHTS.cam;
  shared.light.value.set(...L.light);
  shared.skyMix.value = L.sky;
  view.dataset.bg = d.bg;
  cube.visible = d.cube;
  if (d.style >= 1 && d.style <= 3) ensureEdges();
  const offset = d.style === 1 || d.style === 2;
  for (const c of chunks) {
    c.mesh.material.polygonOffset = offset;
    if (c.edges) c.edges.material.depthTest = d.style !== 3;
  }
  if (!d.ssao && ssao) { ssao.dispose(); ssao = null; }
  if (itemTexData) updateVisibility();
  app.emit("display");
  requestRender();
};
app.toggleStyle = (s) => app.setDisplay({ style: app.display.style === s ? 0 : s });

// ---------------------------------------------------------------- exploded view
let partOffset = null;
function writeOffsets() {
  const off = partOffset;
  for (let i = 0; i < nItems; i++) {
    const p = itemPart[i] * 3, o = i * 4;
    offTexData[o] = off[p]; offTexData[o + 1] = off[p + 1]; offTexData[o + 2] = off[p + 2];
  }
  offTex.needsUpdate = true;
}

// Per-part offsets set by another tool (the assembly animation): a Float32Array of 3 × nParts, or
// null to give the parts back to the exploded view.
app.setPartOffsets = function (off) {
  if (!off) { partOffset = null; app.setExplode({}); return; }
  partOffset = off;
  writeOffsets();
  shared.exploded.value = 1;
  for (const c of chunks) { c.mesh.frustumCulled = c.meshT.frustumCulled = false; if (c.edges) c.edges.frustumCulled = false; }
  requestRender();
};
// Cheap redraw after changing partVisible / partOpacity / partColor many times a second: no
// "state" event (the tree and panels would re-render on every frame).
app.refreshQuiet = function () {
  writeItems(0, nItems);
  paintHover();
  itemTex.needsUpdate = true;
  updateVisibility();
  requestRender();
};

// Move groups of parts (level-N assemblies or single parts) away from the centre.
app.setExplode = function (patch) {
  Object.assign(app.explode, patch);
  const { amount, level, selOnly } = app.explode;
  if (!app.tree) return;
  const k = amount / 100;
  if (k <= 0) {
    partOffset = null;
    shared.exploded.value = 0;
    for (const c of chunks) { c.mesh.frustumCulled = c.meshT.frustumCulled = true; if (c.edges) c.edges.frustumCulled = true; }
    requestRender();
    return;
  }
  const n = app.nParts;
  const use = new Uint8Array(n);
  if (selOnly && app.selNodes.size) for (let p = 0; p < n; p++) use[p] = app.partSel[p];
  else use.fill(1);
  const group = new Int32Array(n);
  for (let p = 0; p < n; p++) {
    const g = level > 0 ? app.levelNode(app.partNode[p], level) : -1;
    group[p] = g >= 0 ? g : app.nNodes + p;
  }
  const lo = new Map(), hi = new Map();
  const all = new THREE.Box3(), v = new THREE.Vector3();
  for (let p = 0; p < n; p++) {
    if (!use[p]) continue;
    const o = p * 6;
    if (partBox[o] === 0 && partBox[o + 3] === 0 && partBox[o + 1] === 0 && partBox[o + 4] === 0) continue;
    const g = group[p];
    let a = lo.get(g), b = hi.get(g);
    if (!a) { a = [Infinity, Infinity, Infinity]; b = [-Infinity, -Infinity, -Infinity]; lo.set(g, a); hi.set(g, b); }
    for (let i = 0; i < 3; i++) { a[i] = Math.min(a[i], partBox[o + i]); b[i] = Math.max(b[i], partBox[o + 3 + i]); }
    all.expandByPoint(v.set(partBox[o], partBox[o + 1], partBox[o + 2]));
    all.expandByPoint(v.set(partBox[o + 3], partBox[o + 4], partBox[o + 5]));
  }
  if (all.isEmpty()) return;
  const C = all.getCenter(new THREE.Vector3());
  partOffset = new Float32Array(n * 3);
  for (let p = 0; p < n; p++) {
    if (!use[p]) continue;
    const a = lo.get(group[p]), b = hi.get(group[p]);
    if (!a) continue;
    for (let i = 0; i < 3; i++) partOffset[p * 3 + i] = ((a[i] + b[i]) / 2 - C.getComponent(i)) * k;
  }
  writeOffsets();
  shared.exploded.value = 1;
  for (const c of chunks) { c.mesh.frustumCulled = c.meshT.frustumCulled = false; if (c.edges) c.edges.frustumCulled = false; }
  requestRender();
};

// ---------------------------------------------------------------- section planes / box
const clipBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
  new THREE.LineBasicMaterial({ color: 0xe8590c, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false }));
clipBox.visible = false;
clipBox.renderOrder = 10;
scene.add(clipBox);

// Helpers drawn with the model but never picked (plane outline, mannequin, removal route…).
const helpers = new THREE.Group();
helpers.renderOrder = 10;
scene.add(helpers);
app.helpers = helpers;
// outline of the free section plane: a square on the plane, as big as the model
const planeHelper = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0)]),
new THREE.LineBasicMaterial({ color: 0x0ca678, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }));
planeHelper.visible = false;
planeHelper.renderOrder = 10;
helpers.add(planeHelper);

function clipRange() {
  const b = modelBox(), size = b.getSize(new THREE.Vector3());
  return { lo: b.min.clone().addScaledVector(size, -0.01), ext: size.multiplyScalar(1.02) };
}
app.setClip = function (patch) {
  Object.assign(app.clip, patch);
  const c = app.clip;
  if (!modelMin) return;
  const { lo, ext } = clipRange();
  const min = shared.clipMin.value, max = shared.clipMax.value;
  let any = false;
  for (let a = 0; a < 3; a++) {
    const ax = c.axes[a];
    if (ax.on) any = true;
    const l = Math.min(ax.lo, ax.hi), h = Math.max(ax.lo, ax.hi);
    min.setComponent(a, ax.on ? lo.getComponent(a) + ext.getComponent(a) * l : -1e30);
    max.setComponent(a, ax.on ? lo.getComponent(a) + ext.getComponent(a) * h : 1e30);
  }
  shared.clipOn.value = any ? 1 : 0;
  const pl = c.plane;
  if (pl && pl.n && pl.p) {
    const n = new THREE.Vector3(...pl.n).normalize();
    const at = new THREE.Vector3(...pl.p).addScaledVector(n, -(pl.depth || 0)); // deeper: into the part, away from the viewer
    if (pl.flip) n.negate();
    shared.plane.value.set(n.x, n.y, n.z, n.dot(at));
    shared.planeOn.value = 1;
    const size = modelBox().getSize(new THREE.Vector3()).length() * 0.6;
    planeHelper.position.copy(at);
    planeHelper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    planeHelper.scale.set(size, size, 1);
    planeHelper.visible = c.show;
  } else {
    shared.planeOn.value = 0;
    planeHelper.visible = false;
  }
  shared.clipInvert.value = c.invert ? 1 : 0;
  shared.capOn.value = c.cap ? 1 : 0;
  const b0 = lo, b1 = lo.clone().add(ext);
  const bmin = min.clone().max(b0), bmax = max.clone().min(b1);
  clipBox.position.copy(bmin).add(bmax).multiplyScalar(0.5);
  clipBox.scale.copy(bmax).sub(bmin).max(new THREE.Vector3(1e-6, 1e-6, 1e-6));
  clipBox.visible = any && c.show;
  app.emit("clip");
  requestRender();
};
// ---------------------------------------------------------------- neighbourhood region
// Outline of the region (sphere: 3 great circles + equator band, box: 12 edges) and the cut.
const nbHelper = new THREE.Group();
{
  const mat = new THREE.LineBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
  const circle = (axis) => {
    const pts = [];
    for (let i = 0; i <= 96; i++) {
      const t = (i / 96) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      pts.push(axis === 0 ? new THREE.Vector3(0, c, s) : axis === 1 ? new THREE.Vector3(c, 0, s) : new THREE.Vector3(c, s, 0));
    }
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
  };
  const sphere = new THREE.Group();
  sphere.add(circle(0), circle(1), circle(2));
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), mat);
  nbHelper.add(sphere, box);
  nbHelper.userData = { sphere, box };
  nbHelper.visible = false;
  nbHelper.renderOrder = 11;
  sphere.children.forEach((c) => { c.renderOrder = 11; });
  box.renderOrder = 11;
  scene.add(nbHelper);
}
// r: {shape: "sphere"|"box", center, radius, half: [hx,hy,hz], clip, outline} or null to clear.
app.setRegion = function (r) {
  if (!r) { shared.nbClip.value = 0; nbHelper.visible = false; requestRender(); return; }
  const c = new THREE.Vector3(...r.center);
  shared.nbC.value.copy(c);
  shared.nbR.value = r.radius;
  shared.nbMin.value.set(c.x - r.half[0], c.y - r.half[1], c.z - r.half[2]);
  shared.nbMax.value.set(c.x + r.half[0], c.y + r.half[1], c.z + r.half[2]);
  shared.nbClip.value = r.clip ? (r.shape === "sphere" ? 1 : 2) : 0;
  const { sphere, box } = nbHelper.userData;
  sphere.visible = r.shape === "sphere";
  box.visible = r.shape === "box";
  nbHelper.position.copy(c);
  if (r.shape === "sphere") sphere.scale.setScalar(r.radius); else box.scale.set(...r.half);
  nbHelper.visible = !!r.outline;
  requestRender();
};

// Normalised [lo, hi] of a world box on each axis, for the section box around the selection.
app.clipFromBox = function (box) {
  const { lo, ext } = clipRange();
  const size = box.getSize(new THREE.Vector3());
  const axes = [0, 1, 2].map((a) => {
    const pad = Math.max(size.getComponent(a) * 0.03, ext.getComponent(a) * 0.002);
    return {
      on: true,
      lo: Math.max(0, (box.min.getComponent(a) - pad - lo.getComponent(a)) / ext.getComponent(a)),
      hi: Math.min(1, (box.max.getComponent(a) + pad - lo.getComponent(a)) / ext.getComponent(a)),
    };
  });
  app.setClip({ axes });
};

// ---------------------------------------------------------------- model sources
// A model is either a folder converted by tools/build.py (chunks.json, tree.json, ...)
// or an original Creo View folder (.pvs + .ol files) that is parsed here in the browser.
// Local folders are read by the browser and are never uploaded.
function ok(r, name) { if (!r.ok) throw new Error(name + ": HTTP " + r.status); return r; }

const httpSrc = (base) => ({
  json: (n) => fetch(base + n).then((r) => ok(r, n).json()),
  buf: (n) => fetch(base + n).then((r) => ok(r, n).arrayBuffer()),
});
const httpConverted = httpSrc(DATA);

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
  if (window.desktop) {
    const r = params.has("abrir") ? null : await window.desktop.initialFolder();
    if (r) { rememberPath(r); return fromDesktop(r); }
  } else if (!params.has("abrir")) {
    try { await httpConverted.json("chunks.json"); return { kind: "converted", src: httpConverted }; } catch { /* none on server */ }
  }
  // Coming back to the viewer (the browser closed the tab, or the app was reopened): the last model
  // opens by itself when it can be read without asking anything — a copy kept on this device, a
  // folder or ZIP the browser still lets the site read, or a folder of the desktop app.
  if (!params.has("abrir")) {
    const last = (await listRecent())[0];
    if (last) {
      try {
        const m = await reopen(last, false);
        if (m) { reopened = last; status("Reabrindo " + last.name + "… (Abrir para trocar de modelo)"); addRecent(last); return m; }
      } catch (e) { console.warn("reabrir:", e); }
    }
  }
  status("Nenhum modelo carregado");
  const card = $("#open");
  card.hidden = false;
  return new Promise((resolve) => {
    const fail = (e) => { if (e && e.name !== "AbortError") $("#openErr").textContent = e.message || String(e); };
    if (window.desktop) {
      $("#convertBtn").hidden = false;
      $("#convertBtn").onclick = async () => {
        const button = $("#convertBtn");
        button.disabled = true;
        $("#openErr").textContent = "";
        try {
          const result = await convertModel(window.desktop, status);
          if (result) status(`Modelo convertido em ${result}. Abra essa pasta para visualizar.`);
        } catch (e) { fail(e); }
        finally { button.disabled = false; }
      };
    }
    $("#openBtn").onclick = async () => {
      $("#openErr").textContent = "";
      if (window.desktop) { // desktop app (Electron): the folder is served as model://local/
        try {
          const r = await window.desktop.pickFolder();
          if (!r) return;
          const m = await fromDesktop(r);
          rememberPath(r);
          card.hidden = true;
          resolve(m);
        } catch (e) { fail(e); }
        return;
      }
      if (window.showDirectoryPicker) {
        try {
          const dir = await window.showDirectoryPicker({ id: "pvs-model", mode: "read" });
          status("Procurando o modelo na pasta…");
          const m = await fromDirectory(dir);
          addRecent({ kind: "dir", name: dir.name, handle: dir });
          card.hidden = true;
          resolve(m);
        } catch (e) { fail(e); }
      } else {
        $("#folder").click();
      }
    };
    // drag a folder onto the card (Chrome / Edge give a directory handle)
    const zone = $("#dropZone");
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add("over"); };
    zone.ondragleave = () => zone.classList.remove("over");
    zone.ondrop = async (e) => {
      e.preventDefault();
      zone.classList.remove("over");
      $("#openErr").textContent = "";
      const item = e.dataTransfer.items && e.dataTransfer.items[0];
      try {
        const dropped = e.dataTransfer.files && e.dataTransfer.files[0];
        if (dropped && /\.zip$/i.test(dropped.name)) { // a ZIP written by "Exportar modelo"
          const zh = !window.desktop && item && item.getAsFileSystemHandle ? await item.getAsFileSystemHandle().catch(() => null) : null;
          await openZip(dropped, zh && zh.kind === "file" ? zh : null);
          return;
        }
        if (window.desktop) throw new Error("Use o botão “Escolher a pasta…”.");
        const h = item && item.getAsFileSystemHandle ? await item.getAsFileSystemHandle() : null;
        if (!h || h.kind !== "directory") throw new Error("Solte uma pasta (a que contém o .pvs e os .ol) ou um arquivo ZIP exportado. Neste navegador, use os botões.");
        status("Procurando o modelo na pasta…");
        const m = await fromDirectory(h);
        addRecent({ kind: "dir", name: h.name, handle: h });
        card.hidden = true;
        resolve(m);
      } catch (err) { fail(err); }
    };
    $("#folder").onchange = async () => {
      try {
        const m = await fromFileList($("#folder").files);
        card.hidden = true;
        resolve(m);
      } catch (e) { fail(e); }
    };
    // a ZIP written by "Exportar modelo" opens directly, without extracting it
    async function openZip(file, handle) {
      status("Lendo o ZIP…");
      const src = await zipConverted(file);
      if (handle) addRecent({ kind: "zip", name: file.name, handle });
      else keepAfterLoad(file); // no lasting access to the file: keep a copy on the device
      card.hidden = true;
      resolve({ kind: "converted", src });
    }
    $("#openZipBtn").onclick = async () => {
      $("#openErr").textContent = "";
      if (window.showOpenFilePicker && !window.desktop) {
        try {
          const [h] = await window.showOpenFilePicker({ id: "pvs-zip", types: [{ description: "Modelo 3D (ZIP)", accept: { "application/zip": [".zip"] } }] });
          await openZip(await h.getFile(), h);
        } catch (e) { fail(e); }
      } else $("#zipFile").click();
    };
    $("#zipFile").onchange = async () => {
      const f = $("#zipFile").files[0];
      if (!f) return;
      try { await openZip(f, null); } catch (e) { fail(e); }
    };
    // models opened before: one click (the browser may ask again for permission to read)
    const showRecent = async () => {
      const list = (await listRecent()).filter((r) => (window.desktop ? r.kind === "path" && window.desktop.openFolder : r.kind !== "path"));
      $("#recentBox").hidden = !list.length;
      $("#recentList").replaceChildren(...list.map((r) => {
        const go = document.createElement("button");
        go.className = "recentGo";
        go.title = r.path || r.name;
        go.append(Object.assign(document.createElement("b"), { textContent: r.name }),
          Object.assign(document.createElement("span"), { className: "muted", textContent:
            (r.kind === "kept" ? "neste aparelho · " + sizeText(r.size || 0) : r.kind === "zip" ? "ZIP" : "pasta") + " · " + new Date(r.when).toLocaleDateString("pt-BR") }));
        go.onclick = async () => {
          $("#openErr").textContent = "";
          try {
            status("Abrindo " + r.name + "…");
            const m = await reopen(r, true);
            addRecent(r);
            reopened = r;
            card.hidden = true;
            resolve(m);
          } catch (e) { fail(e && e.name === "NotFoundError" ? new Error("“" + r.name + "” não está mais no mesmo lugar.") : e); }
        };
        const del = document.createElement("button");
        del.className = "recentDel";
        del.textContent = "✕";
        del.title = r.kind === "kept" ? "Apagar a cópia guardada neste aparelho" : "Tirar da lista";
        del.onclick = async () => {
          if (r.kind === "kept" && !confirm(`Apagar a cópia de “${r.name}” guardada neste aparelho? O arquivo original não é afetado.`)) return;
          if (r.kind === "kept") await dropKept(r.path);
          await removeRecent(r.id);
          showRecent();
        };
        const row = document.createElement("div");
        row.className = "recentRow";
        row.append(go, del);
        return row;
      }));
    };
    showRecent();
  });
}
// Open a model from the recent list. ask: may ask the browser for permission (inside a click).
// Returns null when it cannot be opened without asking.
let reopened = null;
async function reopen(r, ask) {
  if (r.kind === "path") {
    if (!window.desktop || !window.desktop.openFolder) return null;
    const d = await window.desktop.openFolder(r.path);
    if (!d) { if (ask) throw new Error("A pasta não existe mais: " + r.path); return null; }
    return fromDesktop(d);
  }
  if (window.desktop) return null;
  if (r.kind === "kept") {
    let f;
    try { f = await keptFile(r.path); } catch {
      removeRecent(r.id); // the browser erased it (site data cleared, or short of space)
      throw new Error(`A cópia de “${r.name}” guardada neste aparelho não existe mais. Abra o ZIP de novo.`);
    }
    return { kind: "converted", src: await zipConverted(f) };
  }
  if (!r.handle) return null;
  if (ask) { if (!(await allow(r.handle))) throw new Error("Sem permissão para ler “" + r.name + "”."); }
  else if (!r.handle.queryPermission || await r.handle.queryPermission({ mode: "read" }) !== "granted") return null;
  return r.kind === "dir" ? fromDirectory(r.handle) : { kind: "converted", src: await zipConverted(await r.handle.getFile()) };
}
// After the model shows up, copy the ZIP to the device (reading it twice at the same time would
// slow the first view down).
function keepAfterLoad(file) {
  if (!canKeep()) { app.on("loaded", () => status("Modelo aberto. Este navegador não deixa guardá-lo: ao fechar, abra o ZIP de novo.")); return; }
  let started = false;
  app.on("loaded", async () => {
    if (started) return;
    started = true;
    let shown = -1;
    try {
      await keepZip(file, (f) => { const p = Math.floor(f * 10) * 10; if (p !== shown) { shown = p; status(`Guardando o modelo neste aparelho… ${p}%`); } });
      status("Modelo guardado neste aparelho: ele reabre sozinho quando você voltar.");
    } catch (e) {
      console.warn("guardar:", e);
      status("Não foi possível guardar o modelo neste aparelho: " + (e.message || e) + " Ao fechar, abra o ZIP de novo.");
    }
  });
}
// The camera is remembered when the page is left, and put back when the same model is reopened.
const camKey = () => "pvs-viewer:lastcam:" + app.title + ":" + app.nParts;
function saveLastCamera() { if (app.tree && userMoved) try { localStorage.setItem(camKey(), JSON.stringify(app.getCamera())); } catch { /* storage blocked */ } }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveLastCamera(); });
window.addEventListener("pagehide", saveLastCamera);
app.on("loaded", () => {
  if (!reopened || wantedCode() || location.hash) return; // a link decides where to look
  try { const c = JSON.parse(localStorage.getItem(camKey()) || "null"); if (c && c.pos) app.setCamera(c); } catch { /* none */ }
});

function rememberPath(r) {
  if (r && r.folder && window.desktop.openFolder) addRecent({ kind: "path", name: String(r.folder).split(/[\\/]/).filter(Boolean).pop() || r.folder, path: r.folder });
}

const NO_MODEL = "A pasta não tem arquivo .pvs nem um modelo convertido (chunks.json). Escolha a pasta que contém o .pvs e os arquivos .ol.";

async function fromDesktop(r) {
  if (r.converted) return { kind: "converted", src: httpSrc(r.base) };
  if (!r.pvs) throw new Error(NO_MODEL);
  const buf = await fetch(r.base + encodeURIComponent(r.pvs)).then((x) => ok(x, r.pvs).arrayBuffer());
  return { kind: "raw", name: r.pvs, pvs: buf, access: { base: r.base, list: r.files } };
}

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
  addBigrama(t);
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
  app.partLoaded = new Uint8Array(nParts);
  app.availableParts = new Uint8Array(nParts).fill(1);
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
  // true: always ask which sections to load; "auto" (phones and tablets): ask only when the model
  // is too big to load at once; a link to one part never asks.
  const ask = $("#openRegions")?.checked || new URLSearchParams(location.search).has("regioes") ? true : touch && !wantedCode() ? "auto" : false;
  if (m.kind === "converted") await loadConverted(m.src, ask);
  else { app.access = m.access; await loadRaw(m, ask); }
}

// Where the geometry comes from, kept for loading more regions and for reading part geometry.
let source = null;
const isLoaded = (p) => app.partLoaded && app.partLoaded[p] === 1;

// Parts to load first: all, or the regions chosen in a dialog.
async function firstParts(ask) {
  if (!ask) return null;
  const selected = await chooseRegions(app);
  // On a phone, closing the section dialog must not load the entire model.
  return touch && selected === undefined ? new Uint8Array(app.nParts) : selected;
}

async function loadConverted(src, ask) {
  const [meta, t, itemsBuf, partsBuf] = await Promise.all([
    src.json("chunks.json"), src.json("tree.json"), src.buf("items.bin"), src.buf("parts.bin"),
  ]);
  setModel(meta.source, t, new Float32Array(partsBuf), meta.min, meta.max);
  if (Array.isArray(meta.includedParts)) {
    app.availableParts.fill(0);
    app.partVisible.fill(0);
    for (const p of meta.includedParts) if (Number.isInteger(p) && p >= 0 && p < app.nParts) {
      app.availableParts[p] = 1;
      app.partVisible[p] = 1;
    }
    app.refresh();
  }
  const n = itemsBuf.byteLength / 8, dv = new DataView(itemsBuf);
  const parts = new Uint32Array(n), colors = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    parts[i] = dv.getUint32(i * 8, true);
    for (let k = 0; k < 4; k++) colors[i * 4 + k] = dv.getUint8(i * 8 + 4 + k);
  }
  let layers = null; // u16 per item into meta.layers (folders converted before layers had none)
  if (meta.layers) { try { layers = new Uint16Array(await src.buf("layers.bin")); } catch { layers = null; } }
  addItems(parts, colors, layers, layers ? meta.layers : null);
  source = { kind: "converted", src, meta, v2: (meta.format || 1) >= 2, loaded: new Uint8Array(meta.chunks.length) };
  try { app.pvsBoxes = new Float32Array(await src.buf("pvsbox.bin")); } catch { app.pvsBoxes = null; } // older folders lack it
  await loadParts(await firstParts(ask === "auto" ? (meta.tris || Infinity) > MOBILE_PREVIEW_TRIANGLES : ask), touch);
  app.emit("loaded");
}

async function loadConvertedParts(want, preview = false) {
  const { src, meta, v2 } = source;
  const list = [];
  meta.chunks.forEach((c, k) => {
    if (source.loaded[k]) return;
    if (want) { let any = false; for (let i = c.io; i < c.io + c.ic && !any; i++) any = want[itemPart[i]] === 1; if (!any) return; }
    list.push(k);
  });
  const selected = preview ? previewChunks(meta.chunks, list) : list;
  source.previewed = selected.length < list.length;
  let next = 0, done = 0;
  const bar = $("#bar > div");
  async function fetcher() {
    while (next < selected.length) {
      const k = selected[next++], c = meta.chunks[k];
      const buf = await src.buf("c/" + c.f);
      if (v2) {
        const o1 = c.nv * 8, o2 = o1 + c.nv * 4, o3 = o2 + c.ni * 2;
        addChunk(c, new Uint16Array(buf, 0, c.nv * 4), new Int8Array(buf, o1, c.nv * 4), new Uint16Array(buf, o2, c.ni),
          c.ne ? new Uint16Array(buf, o3, c.ne).slice() : null, c.io, c.ic);
      } else {
        addChunk(c, new Uint16Array(buf, 0, c.nv * 4), null, new Uint16Array(buf, c.nv * 8, c.ni), null, c.io, c.ic);
      }
      source.loaded[k] = 1;
      done++;
      bar.style.width = (100 * done / selected.length).toFixed(1) + "%";
      status(done < selected.length ? `Carregando geometria ${done}/${selected.length}` : "Modelo carregado" + (v2 ? "" : " · formato antigo: rode tools/build.py de novo para ter arestas e sombreado suave"));
    }
  }
  await Promise.all(Array.from({ length: touch ? 3 : 6 }, fetcher));
  // A part can span several chunks: count it as complete only after all its chunks load.
  app.partLoaded.set(completedParts(meta.chunks, itemPart, source.loaded, app.nParts));
}

async function loadRaw(m, ask) {
  const pvs = parsePVS(m.pvs);
  const t = buildPVSTree(pvs.components);
  const boxes = new Float32Array(t.shapes.length * 6);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  t.boxes.forEach((b, i) => {
    if (!b) return;
    boxes.set(b, i * 6);
    for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], b[a]); hi[a] = Math.max(hi[a], b[a + 3]); }
  });
  app.pvsBoxes = boxes.slice(); // as stored in the PVS (the comparison tool uses them)
  setModel(m.name, t, boxes, lo, hi);
  if (pvs.transformed) { // not applied yet: say it where the user sees it, once the model is open
    console.warn("O modelo tem instâncias com transformação; esta versão ainda não as aplica.");
    app.on("loaded", () => status("Atenção: este modelo posiciona peças por transformação, o que esta versão ainda não aplica — algumas podem aparecer fora do lugar."));
  }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  source = { kind: "raw", m, t, small: isFinite(diag) ? diag * 0.004 : 0 }; // same rule as tools/build.py
  await loadParts(await firstParts(ask === "auto" ? t.shapes.length > 1500 : ask));
  app.emit("loaded");
}

async function loadRawParts(want) {
  const { m, t } = source;
  const t0 = performance.now();
  const todo = [];
  for (let p = 0; p < t.shapes.length; p++) if (!isLoaded(p) && (!want || want[p] === 1)) todo.push(p);
  const TASK = 150, total = todo.length;
  const tasks = [];
  for (let s = 0; s < total; s += TASK) tasks.push(todo.slice(s, s + TASK));
  const nWorkers = Math.max(1, Math.min(touch ? 2 : 8, (navigator.hardwareConcurrency || 4) - 1));
  const bar = $("#bar > div");
  let missing = 0, next = 0, doneParts = 0;
  const files = m.access.files;
  const runWorker = () => new Promise((resolve, reject) => {
    const w = new Worker(new URL("./lib/olworker.js", import.meta.url), { type: "module" });
    w.postMessage({ type: "init", dir: m.access.dir, base: m.access.base, small: source.small });
    let cur = null;
    const send = () => {
      if (next >= tasks.length) { w.terminate(); resolve(); return; }
      cur = tasks[next++];
      const parts = cur.map((p) => ({ part: p, name: t.shapes[p], file: files ? files.get(t.shapes[p]) || null : undefined }));
      w.postMessage({ type: "task", id: next, parts });
    };
    const progress = () => {
      for (const p of cur) app.partLoaded[p] = 1;
      doneParts = Math.min(total, doneParts + cur.length);
      bar.style.width = (100 * doneParts / total).toFixed(1) + "%";
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      status(`Lendo peças ${doneParts.toLocaleString("pt-BR")}/${total.toLocaleString("pt-BR")} · ${secs}s`);
    };
    w.onmessage = (e) => {
      const d = e.data;
      if (d.type === "chunk") {
        const io = addItems(d.items, d.colors, d.layers);
        addChunk(d, d.verts, d.nrm, d.idx, d.ne ? d.edges : null, io, d.items.length);
      } else if (d.type === "error") {
        console.error("worker:", d.message);
        missing += cur.length;
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
  await Promise.all(Array.from({ length: Math.min(nWorkers, Math.max(1, tasks.length)) }, runWorker));
  const secs = ((performance.now() - t0) / 1000).toFixed(0);
  status(`${total.toLocaleString("pt-BR")} peças carregadas em ${secs}s` + (missing ? ` · ${missing} arquivo(s) .ol ausente(s) ou ilegível(is)` : ""));
  const all = partsBox(todo);
  if (!all.isEmpty()) {
    const b = new THREE.Box3(new THREE.Vector3(...modelMin), new THREE.Vector3(...modelMax));
    if (!want) b.copy(all); else b.union(all);
    modelMin = b.min.toArray(); modelMax = b.max.toArray();
  }
}

// Load geometry for parts (Uint8Array flags, or null = everything not loaded yet).
let loading = false;
async function loadParts(want, preview = false) {
  if (loading) return;
  loading = true;
  try {
    if (source.kind === "converted") await loadConvertedParts(want, preview);
    else await loadRawParts(want);
  } finally { loading = false; }
  const total = app.availableParts.reduce((s, v) => s + v, 0);
  const n = app.partLoaded.reduce((s, v, p) => s + (app.availableParts[p] ? v : 0), 0);
  $("#loadMoreBtn").hidden = n >= total;
  if (n < total) status(`${source.previewed ? "Prévia pronta · " : ""}${n.toLocaleString("pt-BR")} de ${total.toLocaleString("pt-BR")} peças carregadas · use Carregar… para o resto`);
  if (!userMoved) {
    if (source.kind === "converted" && source.previewed && chunks.length) {
      const box = new THREE.Box3();
      for (const c of chunks) { box.expandByPoint(c.min); box.expandByPoint(c.max); }
      frame(box, new THREE.Vector3(1, -1, 0.8).normalize());
    } else fitAll(false);
  }
  app.setClip({});
  app.emit("geometry");
  requestRender();
}
// parts: Uint8Array flags, an array of part numbers, or null for everything
app.loadParts = (parts) => {
  if (parts && !(parts instanceof Uint8Array)) { const f = new Uint8Array(app.nParts); for (const p of parts) f[p] = 1; parts = f; }
  return loadParts(parts);
};
app.isLoaded = isLoaded;

function disposeArray() { this.array = null; }
let loadedTris = 0, loadedEdges = 0;

function showStats() {
  $("#stats").textContent = `${(loadedTris / 1e6).toFixed(1)} M triângulos · ${(loadedEdges / 1e6).toFixed(1)} M arestas · ${app.nParts.toLocaleString("pt-BR")} peças`;
}

function chunkMaterial(vs, fs, c, extra) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: vs,
    fragmentShader: fs,
    uniforms: { ...shared, bmin: { value: c.min }, bext: { value: c.max.clone().sub(c.min) }, itemOffset: { value: c.io }, ...extra },
    side: THREE.DoubleSide,
  });
}

function addChunk(c, verts, nrm, idx, edges, io, ic) {
  loadedTris += c.ni / 3;
  loadedEdges += edges ? edges.length / 2 : 0;
  showStats();
  requestRender();
  const g = new THREE.BufferGeometry();
  const q = new THREE.BufferAttribute(verts, 4);
  q.gpuType = THREE.IntType;
  q.onUpload(disposeArray);
  g.setAttribute("qpos", q);
  if (nrm) {
    const na = new THREE.BufferAttribute(nrm, 4, true);
    na.onUpload(disposeArray);
    g.setAttribute("nrm", na);
  }
  const ia = new THREE.BufferAttribute(idx, 1);
  ia.onUpload(disposeArray);
  g.setIndex(ia);
  const min = new THREE.Vector3(...c.min), max = new THREE.Vector3(...c.max);
  g.boundingBox = new THREE.Box3(min, max);
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  const chunk = { io, ic, q, geo: g, min, max, edgeIdx: edges, edges: null, ps: c.ps || 0, ni: c.ni, ne: edges ? edges.length : 0, nv: c.nv };
  const make = (pass) => {
    const mat = chunkMaterial(VERT, FRAG, chunk, { pass: { value: pass } });
    mat.transparent = pass === 1;
    mat.depthWrite = pass === 0;
    if (pass === 0) { mat.polygonOffsetFactor = 1; mat.polygonOffsetUnits = 1; mat.polygonOffset = app.display.style === 1 || app.display.style === 2; }
    const mesh = new THREE.Mesh(g, mat);
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = pass;
    mesh.frustumCulled = !partOffset;
    scene.add(mesh);
    return mesh;
  };
  chunk.mesh = make(0);
  chunk.meshT = make(1);
  chunks.push(chunk);
  const st = app.display.style;
  if (st >= 1 && st <= 3) makeEdges(chunk);
  let any = false;
  for (let i = io; i < io + ic && !any; i++) { const a = itemTexData[i * 4 + 3] & 127; any = a > 0 && a < 127; }
  chunk.want = { m: st !== 3, t: st !== 3 && (any || st === 4), e: st >= 1 && st <= 3 };
  chunk.mesh.visible = chunk.want.m;
  chunk.meshT.visible = chunk.want.t;
  if (chunk.edges) chunk.edges.visible = chunk.want.e;
  gpuBytes += c.nv * (nrm ? 12 : 8) + c.ni * 2;
}
let gpuBytes = 0;

// CAD edges are sent to the GPU only when an edge style is used for the first time.
function makeEdges(c) {
  if (c.edges || !c.edgeIdx) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute("qpos", c.q);
  const ia = new THREE.BufferAttribute(c.edgeIdx, 1);
  ia.onUpload(disposeArray);
  g.setIndex(ia);
  g.boundingBox = c.geo.boundingBox;
  g.boundingSphere = c.geo.boundingSphere;
  const mat = chunkMaterial(EDGE_VERT, EDGE_FRAG, c, {});
  mat.depthTest = app.display.style !== 3;
  const lines = new THREE.LineSegments(g, mat);
  lines.matrixAutoUpdate = false;
  lines.renderOrder = 0.5;
  lines.frustumCulled = !partOffset;
  lines.visible = app.display.style >= 1 && app.display.style <= 3;
  scene.add(lines);
  gpuBytes += c.edgeIdx.length * 2;
  c.edges = lines;
  c.edgeIdx = null;
}
function ensureEdges() { for (const c of chunks) makeEdges(c); }
app.hasEdges = () => loadedEdges > 0;

// ---------------------------------------------------------------- camera helpers
function modelBox() { return new THREE.Box3(new THREE.Vector3(...modelMin), new THREE.Vector3(...modelMax)); }

function partsBox(parts) {
  const b = new THREE.Box3(), v = new THREE.Vector3();
  for (const p of parts) {
    const o = p * 6;
    if (partBox[o] === 0 && partBox[o + 3] === 0 && partBox[o + 1] === 0 && partBox[o + 4] === 0) continue;
    const dx = partOffset ? partOffset[p * 3] : 0, dy = partOffset ? partOffset[p * 3 + 1] : 0, dz = partOffset ? partOffset[p * 3 + 2] : 0;
    b.expandByPoint(v.set(partBox[o] + dx, partBox[o + 1] + dy, partBox[o + 2] + dz));
    b.expandByPoint(v.set(partBox[o + 3] + dx, partBox[o + 4] + dy, partBox[o + 5] + dz));
  }
  return b;
}
app.nodesBox = function (nodes) {
  const parts = [];
  app.forParts(nodes, (p) => parts.push(p));
  return partsBox(parts);
};

// Look at a box from `dir` (default: the current direction). smooth: glide there instead of jumping.
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
function frame(box, dir, smooth = false) {
  if (box.isEmpty()) return;
  if (walk.on) setWalk(false);
  tween = null; fly = null;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
  if (!dir) dir = camera.position.clone().sub(controls.target).normalize();
  if (!(dir.lengthSq() > 0)) dir.set(1, -1, 0.8).normalize(); // also recovers from an invalid (NaN) camera
  const vh = THREE.MathUtils.degToRad(persp.fov / 2);
  const hh = Math.atan(Math.tan(vh) * (persp.aspect > 0 ? persp.aspect : 1)); // narrow views: the horizontal angle is the smaller one
  const dist = radius / Math.sin(Math.min(vh, hh));
  const to = { pos: center.clone().addScaledVector(dir, dist), target: center, half: radius * 1.1 / Math.min(1, persp.aspect > 0 ? persp.aspect : 1), zoom: 1 };
  if (smooth && !calm && camera.position.distanceToSquared(controls.target) > 0) flyTo(to);
  else placeCamera(to);
}
function placeCamera(c) {
  controls.target.copy(c.target);
  persp.position.copy(c.pos);
  ortho.position.copy(c.pos);
  ortho.zoom = c.zoom;
  orthoHalf = c.half;
  persp.lookAt(c.target); ortho.lookAt(c.target);
  updateOrtho();
  controls.update();
  requestRender();
}
// Glide the camera to {pos, target, half, zoom}: the target moves in a straight line while the
// viewing direction turns and the distance changes around it.
let fly = null;
function flyTo(to, dur = 380) {
  tween = null;
  fly = { t0: performance.now(), dur, pos: camera.position.clone(), target: controls.target.clone(), half: orthoHalf, zoom: ortho.zoom, to };
  requestRender();
}
function stepFly(now) {
  if (!fly) return;
  const f = fly, t = Math.min(1, (now - f.t0) / f.dur), e = t * t * (3 - 2 * t);
  const target = f.target.clone().lerp(f.to.target, e);
  const a = f.pos.clone().sub(f.target), b = f.to.pos.clone().sub(f.to.target);
  const la = Math.max(a.length(), 1e-9), lb = Math.max(b.length(), 1e-9);
  a.divideScalar(la); b.divideScalar(lb);
  const q = new THREE.Quaternion().setFromUnitVectors(a, b);
  const d = a.applyQuaternion(new THREE.Quaternion().slerp(q, e));
  camera.position.copy(target).addScaledVector(d, la * Math.pow(lb / la, e));
  controls.target.copy(target);
  orthoHalf = f.half + (f.to.half - f.half) * e;
  ortho.zoom = f.zoom + (f.to.zoom - f.zoom) * e;
  if (camera === ortho) updateOrtho();
  camera.lookAt(target);
  needRender = true;
  lastMove = now;
  if (t >= 1) { fly = null; placeCamera({ pos: camera.position.clone(), target, half: orthoHalf, zoom: ortho.zoom }); }
}
// Where the camera is, or where it is gliding to (so that repeated keys add up).
function cameraGoal() {
  return fly ? { pos: fly.to.pos.clone(), target: fly.to.target.clone(), half: fly.to.half, zoom: fly.to.zoom }
    : { pos: camera.position.clone(), target: controls.target.clone(), half: orthoHalf, zoom: ortho.zoom };
}
// Keyboard navigation: turn around the target, slide the view, zoom.
function orbitBy(dAz, dEl) {
  const g = cameraGoal(), off = g.pos.clone().sub(g.target), dist = off.length();
  if (!(dist > 0)) return;
  const az = Math.atan2(off.y, off.x) + dAz;
  const el = Math.max(-1.55, Math.min(1.55, Math.asin(Math.max(-1, Math.min(1, off.z / dist))) + dEl));
  g.pos.copy(g.target).addScaledVector(new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)), dist);
  flyTo(g, 170);
}
function panBy(dx, dy) { // fractions of the view height
  const g = cameraGoal();
  const h = camera === ortho ? (2 * g.half) / g.zoom : 2 * g.pos.distanceTo(g.target) * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const move = right.multiplyScalar(dx * h).addScaledVector(up, dy * h);
  g.pos.add(move); g.target.add(move);
  flyTo(g, 170);
}
function zoomBy(k) { // k < 1 gets closer
  const g = cameraGoal();
  if (camera === ortho) g.zoom /= k;
  else g.pos.sub(g.target).multiplyScalar(k).add(g.target);
  flyTo(g, 170);
}
// Camera history: every time the camera comes to rest its position is remembered, so that
// Backspace goes back to where you were looking before (Shift+Backspace: forward again).
const camHist = [];
let camIdx = -1, histJump = false;
function histPush() {
  const c = app.getCamera(), last = camHist[camIdx];
  if (!c.pos.every(Number.isFinite)) return;
  if (last && last.ortho === c.ortho && last.zoom === c.zoom && last.pos.every((v, i) => Math.abs(v - c.pos[i]) < 1e-6) && last.target.every((v, i) => Math.abs(v - c.target[i]) < 1e-6)) return;
  camHist.length = camIdx + 1;
  camHist.push(c);
  if (camHist.length > 60) camHist.shift();
  camIdx = camHist.length - 1;
}
function histGo(step) {
  const i = camIdx + step;
  if (i < 0 || i >= camHist.length) { status(step < 0 ? "Não há vista anterior." : "Não há vista seguinte."); return; }
  if (walk.on) setWalk(false);
  camIdx = i;
  histJump = true;
  const c = camHist[i];
  if ((camera === ortho) !== !!c.ortho) setOrtho(!!c.ortho);
  const to = { pos: new THREE.Vector3(...c.pos), target: new THREE.Vector3(...c.target), half: c.half || orthoHalf, zoom: c.zoom || 1 };
  if (calm) placeCamera(to); else flyTo(to);
}
app.viewPrev = () => histGo(-1);
app.viewNext = () => histGo(1);
app.frameNodes = (nodes) => frame(app.nodesBox(nodes), null, true);
// The camera that frame() would set for a box, without moving to it ({pos, target, ortho, half, zoom}).
app.cameraFor = function (box, dir) {
  if (!box || box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.01);
  const d = dir ? new THREE.Vector3(...dir).normalize() : camera.position.clone().sub(controls.target).normalize();
  if (!(d.lengthSq() > 0)) d.set(1, -1, 0.8).normalize();
  const asp = persp.aspect > 0 ? persp.aspect : 1; // a hidden view has no width
  const vh = THREE.MathUtils.degToRad(persp.fov / 2);
  const hh = Math.atan(Math.tan(vh) * asp);
  const dist = radius / Math.sin(Math.min(vh, hh));
  return { ortho: camera === ortho, pos: center.clone().addScaledVector(d, dist).toArray(), target: center.toArray(),
    half: radius * 1.1 / Math.min(1, asp), zoom: 1 };
};
app.partsBox = (parts) => partsBox(parts);

let orthoHalf = 10;
function updateOrtho() {
  const a = view.clientWidth / Math.max(1, view.clientHeight);
  ortho.left = -orthoHalf * a; ortho.right = orthoHalf * a;
  ortho.top = orthoHalf; ortho.bottom = -orthoHalf;
  ortho.updateProjectionMatrix();
}

function fitAll(keepDir = true, smooth = false) {
  const box = partOffset ? partsBox(Array.from({ length: app.nParts }, (_, p) => p)) : modelBox();
  frame(box, keepDir ? null : new THREE.Vector3(1, -1, 0.8).normalize(), smooth);
}
app.fitAll = () => fitAll(true, true);

const VIEWS = {
  iso: new THREE.Vector3(1, -1, 0.8), front: new THREE.Vector3(1, 0, 0),
  side: new THREE.Vector3(0, -1, 0), top: new THREE.Vector3(0, -0.0001, 1),
};

// Smoothly turn the camera around the target to look from `dir`.
let tween = null;
function turnTo(dir) {
  if (walk.on) setWalk(false);
  fly = null;
  const d = dir.clone().normalize();
  if (Math.abs(d.z) > 0.9999) d.set(0, -1e-4 * Math.sign(d.z || 1), Math.sign(d.z)).normalize();
  const from = camera.position.clone().sub(controls.target);
  tween = { t0: performance.now(), dur: 350, from: from.clone().normalize(), to: d, dist: from.length() };
  requestRender();
}
function stepTween(now) {
  if (!tween) return;
  const t = Math.min(1, (now - tween.t0) / tween.dur), e = t * t * (3 - 2 * t);
  const q = new THREE.Quaternion().setFromUnitVectors(tween.from, tween.to);
  const d = tween.from.clone().applyQuaternion(new THREE.Quaternion().slerp(q, e));
  camera.position.copy(controls.target).addScaledVector(d, tween.dist);
  camera.lookAt(controls.target);
  needRender = true;
  lastMove = now;
  if (t >= 1) tween = null;
}

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
// Draw the scene for picking into `rt` with `cam`: ids (mode 1) or view depth (mode 2).
function renderPick(cam, mode, rt) {
  shared.pickMode.value = mode;
  const boxVis = clipBox.visible, nbVis = nbHelper.visible, hVis = helpers.visible;
  clipBox.visible = false;
  nbHelper.visible = false;
  helpers.visible = false;
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, cam);
  renderer.setRenderTarget(null);
  clipBox.visible = boxVis;
  nbHelper.visible = nbVis;
  helpers.visible = hVis;
  shared.pickMode.value = 0;
}
// Render ids (mode 1) or view depth (mode 2) of a screen rectangle; returns the raw RGBA bytes.
// The camera is narrowed to that rectangle (view offset), so only the chunks that cross it are
// drawn: a click costs a tiny fraction of a frame, however big the model is.
function pickRender(mode, x0, y0, x1, y1) {
  const r = renderer.domElement.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  const rx = Math.max(0, Math.min(w - 1, Math.floor(Math.min(x0, x1) - r.left)));
  const ry = Math.max(0, Math.min(h - 1, Math.floor(Math.min(y0, y1) - r.top)));
  const rw = Math.max(1, Math.min(w - rx, Math.ceil(Math.abs(x1 - x0)) || 1));
  const rh = Math.max(1, Math.min(h - ry, Math.ceil(Math.abs(y1 - y0)) || 1));
  if (!pickRT) pickRT = new THREE.WebGLRenderTarget(rw, rh);
  else if (pickRT.width !== rw || pickRT.height !== rh) pickRT.setSize(rw, rh);
  camera.setViewOffset(w, h, rx, ry, rw, rh);
  renderPick(camera, mode, pickRT);
  camera.clearViewOffset();
  const buf = new Uint8Array(rw * rh * 4);
  renderer.readRenderTargetPixels(pickRT, 0, 0, rw, rh, buf);
  return { buf, rw, rh };
}
// Distance from `origin` to the nearest drawn surface along `dir` (unit vector), up to `max`
// metres; Infinity when there is nothing. Used by the walk mode (floor and walls).
const probeCam = new THREE.PerspectiveCamera(5, 1, 0.02, 100);
const PROBE = 5;
let probeRT = null;
const _probeBuf = new Uint8Array(PROBE * PROBE * 4), _probeF = new Float32Array(_probeBuf.buffer);
function probe(origin, dir, max, fov = 5) {
  if (!probeRT) probeRT = new THREE.WebGLRenderTarget(PROBE, PROBE);
  probeCam.position.copy(origin);
  probeCam.up.set(0, 0, 1);
  if (Math.abs(dir.z) > 0.99) probeCam.up.set(1, 0, 0);
  probeCam.lookAt(_pv2.copy(origin).add(dir));
  probeCam.fov = fov;
  probeCam.far = max;
  probeCam.updateProjectionMatrix();
  probeCam.updateMatrixWorld();
  renderPick(probeCam, 2, probeRT);
  renderer.readRenderTargetPixels(probeRT, 0, 0, PROBE, PROBE, _probeBuf);
  let best = Infinity;
  for (let i = 0; i < _probeF.length; i++) { const z = _probeF[i]; if (z > 0 && z < best) best = z; }
  return best;
}
const _pv2 = new THREE.Vector3();
function pickRect(x0, y0, x1, y1) {
  const { buf } = pickRender(1, x0, y0, x1, y1);
  requestRender();
  const ids = new Set();
  for (let i = 0; i < buf.length; i += 4) {
    const id = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24);
    if (id > 0) ids.add(id - 1);
  }
  return ids;
}
// Item under the cursor, or the nearest one within a few pixels (edges are thin).
function pickNode(x, y, redraw = true) {
  const R = 4;
  const { buf, rw } = pickRender(1, x - R, y - R, x + R + 1, y + R + 1);
  if (redraw) requestRender();
  let best = -1, bd = Infinity;
  for (let i = 0; i < buf.length; i += 4) {
    const id = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24);
    if (id <= 0) continue;
    const px = (i / 4) % rw - R, py = Math.floor(i / 4 / rw) - R, d = px * px + py * py;
    if (d < bd) { bd = d; best = id - 1; }
  }
  return best < 0 ? -1 : app.partNode[itemPart[best]];
}
// Which part is drawn at each pixel of the view, sampled every `step` CSS pixels (labels, 2D views):
// {w, h, step, part: Int32Array, row by row from the top; -1 where nothing is drawn}.
app.partsOnScreen = function (step = 4) {
  const r = renderer.domElement.getBoundingClientRect();
  const { buf, rw, rh } = pickRender(1, r.left, r.top, r.right, r.bottom);
  const w = Math.ceil(rw / step), h = Math.ceil(rh / step), part = new Int32Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) {
    const row = rh - 1 - y * step; // the render target is bottom-up
    for (let x = 0; x < w; x++) {
      const i = (row * rw + x * step) * 4;
      const id = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24);
      if (id > 0) part[y * w + x] = itemPart[id - 1];
    }
  }
  requestRender();
  return { w, h, step, part };
};
// World point under the cursor, or null.
function pickPoint(x, y) {
  const { buf } = pickRender(2, x, y, x + 1, y + 1);
  requestRender();
  const z = new Float32Array(buf.buffer, 0, 1)[0];
  if (!(z > 0) || !isFinite(z)) return null;
  const r = renderer.domElement.getBoundingClientRect();
  const nx = ((x - r.left) / r.width) * 2 - 1, ny = -((y - r.top) / r.height) * 2 + 1;
  const fwd = camera.getWorldDirection(new THREE.Vector3());
  if (camera === persp) {
    const d = new THREE.Vector3(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize();
    return camera.position.clone().addScaledVector(d, z / d.dot(fwd));
  }
  const p0 = new THREE.Vector3(nx, ny, -1).unproject(camera);
  return p0.addScaledVector(fwd, z - camera.near);
}

// ---------------------------------------------------------------- services for the UI tools
// What is under the cursor: {node, part, point: [x,y,z] | null}.
app.pick = function (x, y) {
  const node = pickNode(x, y);
  const pt = node >= 0 ? pickPoint(x, y) : null;
  let point = pt ? pt.toArray() : null;
  if (point && partOffset && node >= 0) { // exploded: back to the part's own position
    const p = app.tree.part[node];
    if (p >= 0) for (let a = 0; a < 3; a++) point[a] -= partOffset[p * 3 + a];
  }
  return { node, part: node >= 0 ? app.tree.part[node] : -1, point, x, y };
};
// Screen position (CSS pixels in the view) of a world point; null when behind the camera.
const _pv = new THREE.Vector3();
app.project = function (p, part = -1) {
  _pv.set(p[0], p[1], p[2]);
  if (partOffset && part >= 0) _pv.x += partOffset[part * 3], _pv.y += partOffset[part * 3 + 1], _pv.z += partOffset[part * 3 + 2];
  _pv.project(camera);
  if (_pv.z > 1 || _pv.z < -1) return null;
  return [(_pv.x + 1) / 2 * view.clientWidth, (1 - _pv.y) / 2 * view.clientHeight];
};
// World size of one screen pixel at a point.
app.worldPerPixel = function (p) {
  if (camera === ortho) return (ortho.top - ortho.bottom) / ortho.zoom / view.clientHeight;
  const d = camera.position.distanceTo(_pv.set(p[0], p[1], p[2]));
  return 2 * d * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2)) / view.clientHeight;
};
// While walking the orbit target is not updated: the view looks where the camera faces, so the
// target is put a few metres ahead (saved views and links then open looking the same way).
// During a smooth transition the camera is reported where it is going (a view saved at that moment
// must not keep a point half way).
app.getCamera = () => fly ? { ortho: camera === ortho, pos: fly.to.pos.toArray(), target: fly.to.target.toArray(), half: fly.to.half, zoom: fly.to.zoom } : ({ ortho: camera === ortho, pos: camera.position.toArray(),
  target: walk.on ? camera.position.clone().addScaledVector(camera.getWorldDirection(new THREE.Vector3()), Math.max(1, walk.speed * 3)).toArray() : controls.target.toArray(),
  half: orthoHalf, zoom: ortho.zoom });
app.setCamera = function (c) {
  if (!c || !c.pos?.every(Number.isFinite) || !c.target?.every(Number.isFinite)) return; // never take an invalid camera
  if (walk.on) setWalk(false);
  tween = null; fly = null;
  if ((camera === ortho) !== !!c.ortho) setOrtho(!!c.ortho);
  camera.position.fromArray(c.pos);
  controls.target.fromArray(c.target);
  if (c.ortho) { orthoHalf = c.half || orthoHalf; ortho.zoom = c.zoom || 1; updateOrtho(); }
  camera.lookAt(controls.target);
  controls.update();
  userMoved = true;
  requestRender();
};
app.frameBox = (b) => frame(b);
app.frameMinMax = (a, b) => frame(new THREE.Box3(new THREE.Vector3(...a), new THREE.Vector3(...b)), null, true);
app.partBoxes = () => partBox;
app.modelBox = () => modelBox();
app.scene = scene;
app.canvas = renderer.domElement;
app.setCubeVisible = (on) => { cube.visible = on && app.display.cube; requestRender(); };
app.setCubeSize = (size, margin) => { cube.size = size; cube.margin = margin; requestRender(); };
// Treat the next frames as camera movement (lower level of detail, as when orbiting): used by the
// animation so that playback stays fluid on slower graphics cards.
app.markMoving = () => { lastMove = performance.now(); };
// What the model was read from: the original .pvs bytes (raw folder) or the converted folder.
app.sourceInfo = () => !source ? null : source.kind === "raw"
  ? { kind: "raw", pvs: source.m.pvs, name: source.m.name }
  : { kind: "converted", src: source.src, meta: source.meta };

// Geometry of one part in world coordinates {pos, idx, edges}, read again from the source
// (chunk files of a converted folder, or the part's .ol file). Cached.
const geomCache = new Map(), chunkBufCache = new Map();
app.partGeometry = async function (p) {
  if (geomCache.has(p)) { const g = geomCache.get(p); geomCache.delete(p); geomCache.set(p, g); return g; }
  let g = null;
  try {
    if (source && source.kind === "converted" && source.v2) g = await geomFromChunks(p);
    else if (app.access) g = await geomFromOL(p);
  } catch (e) { console.warn("geometria da peça", p, e); }
  geomCache.set(p, g);
  while (geomCache.size > 400) geomCache.delete(geomCache.keys().next().value);
  return g;
};
async function geomFromOL(p) {
  const f = await app.readModelFile(app.tree.shapes[p]);
  if (!f) return null;
  const ol = loadOL(new Uint8Array(await f.arrayBuffer()));
  const owner = edgeOwners(ol.groups);
  const P = [], I = [], E = [];
  let nv = 0;
  for (const g of ol.groups) {
    if (app.hiddenLayers.has(g.layer)) continue; // measuring ignores hidden layers
    const w = weld(g.pos, g.nrm, g.tris, owner.get(g.layer) === g ? ol.edges[g.layer] || null : null);
    if (!w) continue;
    P.push(w.pos);
    for (const i of w.idx) I.push(i + nv);
    if (w.edges) for (const i of w.edges) E.push(i + nv);
    nv += w.pos.length / 3;
  }
  const pos = new Float32Array(nv * 3);
  let o = 0;
  for (const a of P) { pos.set(a, o); o += a.length; }
  return { pos, idx: Uint32Array.from(I), edges: Uint32Array.from(E) };
}
async function chunkBuffer(c) {
  if (chunkBufCache.has(c.f)) return chunkBufCache.get(c.f);
  const buf = await source.src.buf("c/" + c.f);
  chunkBufCache.set(c.f, buf);
  while (chunkBufCache.size > 6) chunkBufCache.delete(chunkBufCache.keys().next().value);
  return buf;
}
async function geomFromChunks(p) {
  const list = source.meta.chunks;
  const P = [], I = [], E = [];
  let nv = 0;
  for (let i = 0; i < nItems; i++) {
    if (itemPart[i] !== p || layerHidden[itemLayer[i]]) continue;
    let lo = 0, hi = list.length - 1; // chunk with io <= i < io + ic
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (list[mid].io <= i) lo = mid; else hi = mid - 1; }
    const c = list[lo];
    const buf = await chunkBuffer(c);
    const verts = new Uint16Array(buf, 0, c.nv * 4), local = i - c.io;
    const o2 = c.nv * 12, idx = new Uint16Array(buf, o2, c.ni), edg = c.ne ? new Uint16Array(buf, o2 + c.ni * 2, c.ne) : null;
    const map = new Int32Array(c.nv).fill(-1);
    const ext = [0, 1, 2].map((a) => Math.max(c.max[a] - c.min[a], 1e-6));
    for (let v = 0; v < c.nv; v++) {
      if (verts[v * 4 + 3] !== local) continue;
      map[v] = nv++;
      P.push(c.min[0] + verts[v * 4] / 65535 * ext[0], c.min[1] + verts[v * 4 + 1] / 65535 * ext[1], c.min[2] + verts[v * 4 + 2] / 65535 * ext[2]);
    }
    for (let k = 0; k < c.ni; k += 3) {
      const a = map[idx[k]], b = map[idx[k + 1]], d = map[idx[k + 2]];
      if (a >= 0 && b >= 0 && d >= 0) I.push(a, b, d);
    }
    if (edg) for (let k = 0; k < c.ne; k += 2) {
      const a = map[edg[k]], b = map[edg[k + 1]];
      if (a >= 0 && b >= 0) E.push(a, b);
    }
  }
  if (!I.length) return null;
  return { pos: Float32Array.from(P), idx: Uint32Array.from(I), edges: Uint32Array.from(E) };
}
app.canReadGeometry = () => !!(source && ((source.kind === "converted" && source.v2) || app.access));

// Names of files in the original model folder that match a pattern (for ann*.ast).
app.listModelFiles = async function (re) {
  const a = app.access, out = [];
  if (!a) return out;
  if (a.files) { for (const k of a.files.keys()) if (re.test(k)) out.push(k); }
  else if (a.dir) { for await (const [k, h] of a.dir.entries()) if (h.kind === "file" && re.test(k)) out.push(k); }
  else if (a.list) { for (const k of a.list) if (re.test(k)) out.push(k); }
  else if (a.base) { // plain web server: probe ann0000.ast, ann0001.ast, ...
    for (let i = 0; i < 50; i++) {
      const k = "ann" + String(i).padStart(4, "0") + ".ast";
      const r = await fetch(a.base + k, { method: "HEAD" }).catch(() => null);
      if (!r || !r.ok) break;
      out.push(k);
    }
  }
  return out.sort();
};

// PNG of the current view at `scale` times the screen size, with the background and the
// measurement / note overlay. Returns a Blob.
app.screenshot = async function (scale = 2) {
  const gl = renderer.getContext();
  const maxSize = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
  const W = view.clientWidth, H = view.clientHeight;
  const s = Math.min(scale, maxSize / W, maxSize / H);
  const w = Math.round(W * s), h = Math.round(H * s);
  const rt = new THREE.WebGLRenderTarget(w, h, { samples: s <= 2 ? 4 : 0 });
  const boxVis = clipBox.visible;
  clipBox.visible = false;
  applyLod(0);
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, camera);
  const px = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
  renderer.setRenderTarget(null);
  rt.dispose();
  clipBox.visible = boxVis;
  requestRender();
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4, dst = y * w * 4;
    for (let x = 0; x < w * 4; x += 4) {
      const a = px[src + x + 3];
      const k = a ? 255 / a : 0; // the target holds premultiplied colour
      img.data[dst + x] = Math.min(255, px[src + x] * k);
      img.data[dst + x + 1] = Math.min(255, px[src + x + 1] * k);
      img.data[dst + x + 2] = Math.min(255, px[src + x + 2] * k);
      img.data[dst + x + 3] = a;
    }
  }
  const layer = new OffscreenCanvas(w, h);
  layer.getContext("2d").putImageData(img, 0, 0);
  const out = new OffscreenCanvas(w, h), g = out.getContext("2d");
  const bg = { grad: ["#f1f3f6", "#c7ced8"], white: ["#ffffff", "#ffffff"], dark: ["#434b59", "#1a1e25"], black: ["#000000", "#000000"] }[app.display.bg] || ["#fff", "#fff"];
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, bg[0]); grad.addColorStop(1, bg[1]);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.drawImage(layer, 0, 0);
  const svg = document.querySelector("#overlay");
  if (svg && svg.childElementCount) {
    const xml = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
    try {
      const im = new Image();
      im.src = url;
      await im.decode();
      g.drawImage(im, 0, 0, w, h);
    } finally { URL.revokeObjectURL(url); }
  }
  return out.convertToBlob({ type: "image/png" });
};

// ---------------------------------------------------------------- mouse
let down = null, box = null, rot = null;
const touches = new Set();
const boxEl = $("#boxSel"), pivotEl = $("#pivot");
// Capture phase, before OrbitControls: view cube clicks and Shift+drag rectangle selection.
view.addEventListener("pointerdown", (e) => {
  if (e.target !== renderer.domElement) return;
  const r = renderer.domElement.getBoundingClientRect();
  if (e.button === 0 && cube.visible && cube.inside(e.clientX - r.left, e.clientY - r.top)) {
    e.stopPropagation();
    e.preventDefault();
    down = null;
    const d = cube.pick(e.clientX - r.left, e.clientY - r.top);
    if (d) turnTo(d);
    return;
  }
  if (e.button === 0 && e.shiftKey) {
    e.stopPropagation();
    e.preventDefault();
    box = { x0: e.clientX, y0: e.clientY, add: e.ctrlKey || e.metaKey };
    boxEl.hidden = false;
    updateBox(e);
  }
}, true);
window.addEventListener("pointermove", (e) => {
  if (box) updateBox(e);
  if (aim && aim.id === e.pointerId) { aim.x = e.clientX; aim.y = e.clientY; placeLoupe(); requestRender(); return; }
  if (hold && hold.id === e.pointerId && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > 9) endHold();
  if (rot && rot.id === e.pointerId && touches.size < 2) dragRotate(e);
});
window.addEventListener("pointerup", (e) => {
  if (rot?.id === e.pointerId) { rot = null; pivotEl.hidden = true; }
  if (e.pointerType === "touch") touches.delete(e.pointerId);
  if (hold?.id === e.pointerId) endHold();
  if (aim && aim.id === e.pointerId) { // release: the tool gets the point under the crosshair
    const a = aim;
    endAim();
    if (app.tool) app.tool(app.pick(a.x, a.y - AIM_UP), e);
  }
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

renderer.domElement.addEventListener("pointerdown", (e) => {
  clearHover();
  if (e.pointerType === "touch") touches.add(e.pointerId);
  if (touches.size > 1) { down = null; rot = null; pivotEl.hidden = true; endHold(); endAim(); return; }
  down = { id: e.pointerId, x: e.clientX, y: e.clientY };
  if (e.button === 0) rot = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, pivot: null, started: false };
  // a finger held still: with a tool on (measuring, placing a note) it aims with a magnifier;
  // otherwise it opens the menu of the part under it (what the right button does on a PC)
  if (e.pointerType === "touch" && !walk.on && app.tree) {
    const x = e.clientX, y = e.clientY, id = e.pointerId;
    hold = { id, x, y, timer: setTimeout(() => {
      hold = null;
      if (!down || down.id !== id) return;
      if (app.tool) { down = null; rot = null; pivotEl.hidden = true; startAim(id, x, y); return; }
      const node = pickNode(x, y);
      if (node < 0) return;
      down = null; rot = null; pivotEl.hidden = true;
      if (navigator.vibrate) navigator.vibrate(12);
      app.openContextMenu({ clientX: x, clientY: y, touchHold: true, preventDefault() {} }, node);
    }, app.tool ? 230 : 520) };
  }
});
renderer.domElement.addEventListener("pointerup", (e) => {
  const isTouch = e.pointerType === "touch";
  if (isTouch) lastTouchUp = performance.now();
  if (!down || down.id !== e.pointerId || touches.size > 1 || e.shiftKey || Math.hypot(e.clientX - down.x, e.clientY - down.y) > (isTouch ? 9 : 4) || e.button !== 0) return;
  if (walk.on && walk.placing) {
    const point = pickPoint(e.clientX, e.clientY);
    if (point) placeWalkAt(point);
    else status("Escolha um ponto numa superfície visível do modelo.");
    return;
  }
  if (app.tool) { app.tool(app.pick(e.clientX, e.clientY), e); return; }
  const node = pickNode(e.clientX, e.clientY);
  if (isTouch && !walk.on) { // second tap in the same place: frame the part (or everything)
    const now = performance.now(), t = lastTap;
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    if (t && now - t.t < 330 && Math.hypot(e.clientX - t.x, e.clientY - t.y) < 28) {
      lastTap = null;
      if (node >= 0) { app.select([node], "replace"); app.frameNodes([node]); } else fitAll(true, true);
      return;
    }
  }
  if (e.altKey && app.focus >= 0) { app.select([app.tree.parent[app.focus]], "replace"); return; }
  if (node < 0) { if (!(e.ctrlKey || e.metaKey)) app.clearSelection(); return; }
  app.select([node], e.ctrlKey || e.metaKey ? "toggle" : "replace");
});
renderer.domElement.addEventListener("dblclick", (e) => {
  if (walk.on || app.tool || performance.now() - lastTouchUp < 700) return; // touch: handled as a double tap
  const node = pickNode(e.clientX, e.clientY);
  if (node >= 0) app.frameNodes([node]); else fitAll(true, true);
});
window.addEventListener("pointercancel", (e) => {
  touches.delete(e.pointerId);
  if (down?.id === e.pointerId) down = null;
  if (rot?.id === e.pointerId) { rot = null; pivotEl.hidden = true; }
  if (hold?.id === e.pointerId) endHold();
  if (aim?.id === e.pointerId) endAim();
});
let hold = null, lastTap = null, lastTouchUp = 0;
function endHold() { if (hold) { clearTimeout(hold.timer); hold = null; } }

// Aiming on a touch screen: the finger hides the point, so a crosshair sits a little above it
// and a magnifier shows what is under the crosshair. Lifting the finger gives that point to the tool.
const AIM_UP = 56, LOUPE = 132, LOUPE_ZOOM = 2.6;
let aim = null;
const loupeEl = $("#loupe"), aimDot = $("#aimDot");
function startAim(id, x, y) {
  aim = { id, x, y };
  view.classList.add("aiming");
  loupeEl.hidden = false; aimDot.hidden = false;
  placeLoupe();
  requestRender();
}
function endAim() {
  if (!aim) return;
  aim = null;
  view.classList.remove("aiming");
  loupeEl.hidden = true; aimDot.hidden = true;
}
function placeLoupe() {
  const r = view.getBoundingClientRect();
  const tx = aim.x - r.left, ty = aim.y - AIM_UP - r.top;
  aimDot.style.left = tx + "px"; aimDot.style.top = ty + "px";
  let lx = tx - LOUPE / 2, ly = ty - LOUPE - 44;
  if (ly < 6) { ly = Math.max(6, ty - LOUPE / 2); lx = tx < r.width / 2 ? tx + 60 : tx - LOUPE - 60; } // near the top: beside the finger
  loupeEl.style.left = Math.max(4, Math.min(r.width - LOUPE - 4, lx)) + "px";
  loupeEl.style.top = Math.max(4, ly) + "px";
}
// Copy the pixels around the crosshair into the magnifier (right after the frame is drawn).
app.on("frame", () => {
  if (!aim) return;
  const c = renderer.domElement, r = c.getBoundingClientRect(), k = c.width / r.width;
  if (loupeEl.width !== LOUPE * 2) loupeEl.width = loupeEl.height = LOUPE * 2;
  const g = loupeEl.getContext("2d"), D = loupeEl.width, src = (LOUPE / LOUPE_ZOOM) * k;
  g.fillStyle = getComputedStyle(view).backgroundColor || "#ccd";
  g.fillRect(0, 0, D, D);
  g.imageSmoothingEnabled = false;
  g.drawImage(c, (aim.x - r.left) * k - src / 2, (aim.y - AIM_UP - r.top) * k - src / 2, src, src, 0, 0, D, D);
  g.strokeStyle = "rgba(232,89,12,.95)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(D / 2 - 18, D / 2); g.lineTo(D / 2 - 5, D / 2); g.moveTo(D / 2 + 5, D / 2); g.lineTo(D / 2 + 18, D / 2);
  g.moveTo(D / 2, D / 2 - 18); g.lineTo(D / 2, D / 2 - 5); g.moveTo(D / 2, D / 2 + 5); g.lineTo(D / 2, D / 2 + 18); g.stroke();
});

// Name and highlight of the part under the mouse (not on touch screens).
const tip = $("#hoverTip");
let hoverTimer = 0, hoverNode = -1;
function clearHover() {
  clearTimeout(hoverTimer);
  hoverNode = -1;
  setHoverPart(-1);
  tip.hidden = true;
}
function placeTip(x, y) {
  const r = view.getBoundingClientRect();
  let lx = x - r.left + 16;
  if (lx + tip.offsetWidth > r.width - 6) lx = x - r.left - tip.offsetWidth - 12;
  tip.style.left = Math.max(4, lx) + "px";
  tip.style.top = Math.min(r.height - tip.offsetHeight - 4, y - r.top + 18) + "px";
}
renderer.domElement.addEventListener("pointermove", (e) => {
  if (e.pointerType !== "mouse") return;
  clearTimeout(hoverTimer);
  if (e.buttons || walk.on || box || !app.display.hover || !app.tree) { if (hoverNode >= 0 || !tip.hidden) clearHover(); return; }
  const x = e.clientX, y = e.clientY;
  if (!tip.hidden) placeTip(x, y);
  hoverTimer = setTimeout(() => {
    if (performance.now() - lastMove < 140 || fly || tween) return;
    const r = renderer.domElement.getBoundingClientRect();
    const node = cube.visible && cube.inside(x - r.left, y - r.top) ? -1 : pickNode(x, y, false);
    if (node < 0) { clearHover(); return; }
    if (node !== hoverNode) {
      hoverNode = node;
      setHoverPart(app.tree.part[node]);
      const par = app.tree.parent[node];
      tip.replaceChildren(Object.assign(document.createElement("b"), { textContent: app.tree.names[node] }),
        ...(par > 0 ? [Object.assign(document.createElement("span"), { textContent: app.tree.names[par] })] : []));
    }
    tip.hidden = false;
    placeTip(x, y);
  }, 40);
});
renderer.domElement.addEventListener("pointerleave", clearHover);
app.on("model", clearHover);
app.on("display", () => { if (!app.display.hover) clearHover(); });

// Left drag: orbit around the point under the cursor (or look around while walking).// Left drag: orbit around the point under the cursor (or look around while walking).
const Z = new THREE.Vector3(0, 0, 1);
function dragRotate(e) {
  if (!rot.started) {
    if (Math.hypot(e.clientX - rot.sx, e.clientY - rot.sy) < 3) return;
    rot.started = true;
    userMoved = true;
    tween = null; fly = null;
    endHold();
    if (!walk.on) {
      rot.pivot = pickPoint(rot.sx, rot.sy) || controls.target.clone();
      const r = view.getBoundingClientRect();
      Object.assign(pivotEl.style, { left: rot.sx - r.left + "px", top: rot.sy - r.top + "px" });
      pivotEl.hidden = false;
    }
  }
  const dx = e.clientX - rot.x, dy = e.clientY - rot.y;
  rot.x = e.clientX; rot.y = e.clientY;
  lastMove = performance.now();
  const k = (2 * Math.PI) / Math.max(200, view.clientHeight);
  if (walk.on) {
    walk.yaw -= dx * k * 0.5;
    walk.pitch = Math.max(-1.55, Math.min(1.55, walk.pitch - dy * k * 0.5));
    walkLook();
    requestRender();
    return;
  }
  const P = rot.pivot;
  const qa = new THREE.Quaternion().setFromAxisAngle(Z, -dx * k);
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).applyQuaternion(qa);
  const qe = new THREE.Quaternion().setFromAxisAngle(right, -dy * k);
  let q = qe.clone().multiply(qa);
  const off = camera.position.clone().sub(controls.target).applyQuaternion(q).normalize();
  if (Math.abs(off.z) > 0.9995) q = qa; // do not go over the pole
  camera.position.sub(P).applyQuaternion(q).add(P);
  controls.target.sub(P).applyQuaternion(q).add(P);
  camera.lookAt(controls.target);
  const s = P.clone().project(camera), r = view.getBoundingClientRect();
  Object.assign(pivotEl.style, { left: (s.x + 1) / 2 * r.width + "px", top: (1 - s.y) / 2 * r.height + "px" });
  requestRender();
}

// ---------------------------------------------------------------- walk mode
// First person. It starts as free flight from the current view; "Posicionar" (or a tap on the
// model, on a phone) stands the camera on a surface, 1.6 m above it, and turns on the two helpers:
// "Chão" keeps that height over whatever is below, "Colisão" stops at walls and equipment. Both
// measure the model with tiny depth renders (probe), so they work on any model without extra data.
const EYE = 1.6, BODY = 0.4, DOWN = new THREE.Vector3(0, 0, -1), VIEW_FOV = 40, WALK_FOV = 62;
const walk = { on: false, placing: false, keys: new Set(), touch: new Set(), speed: 0, yaw: 0, pitch: 0, last: 0,
  ground: false, collide: false, mx: 0, my: 0, lx: 0, ly: 0,
  free: Infinity, freeDir: new THREE.Vector3(), freeT: 0, floorT: 0, floorZ: null };
function syncWalkUI() {
  $("#walkPlace").classList.toggle("on", walk.placing);
  $("#walkGround").classList.toggle("on", walk.ground);
  $("#walkCollide").classList.toggle("on", walk.collide);
  $("#walkAim").hidden = !walk.on;
  view.classList.toggle("walkGround", walk.on && walk.ground);
  const t = walk.speed.toFixed(1).replace(".", ",") + " m/s";
  $("#walkSpeed").textContent = t;
  $("#walkSpeedLbl").textContent = t;
}
function setWalkPlacing(on, message) {
  walk.placing = on;
  syncWalkUI();
  status(message || (on
    ? (touch ? "Toque num piso para ficar em pé nele, ou já ande com os controles." : "Clique num piso para ficar em pé nele, ou já ande com W A S D.")
    : "Caminhada: arraste para olhar ao redor."));
}
function placeWalkAt(point) {
  const forward = new THREE.Vector3(Math.cos(walk.yaw), Math.sin(walk.yaw), 0);
  camera.position.copy(point).addScaledVector(forward, -0.35).addScaledVector(Z, EYE);
  // a point on a wall or a column: step back from it (as far as there is room behind), so that
  // the view does not start with the nose against the surface
  const ahead = probe(camera.position, forward, 4, 20);
  if (ahead < 1.6) {
    const back = forward.clone().negate();
    camera.position.addScaledVector(back, Math.max(0, Math.min(1.6 - ahead, probe(camera.position, back, 4, 20) - BODY)));
  }
  walk.pitch = 0;
  walk.speed = 1.5;
  walk.ground = walk.collide = true;
  walk.floorT = walk.freeT = 0; walk.floorZ = null;
  walkLook();
  setWalkPlacing(false, "Pés no chão. Arraste para olhar; ande com " + (touch ? "o controle da esquerda." : "W A S D."));
  userMoved = true;
  lastMove = performance.now();
  requestRender();
}
const WALK_KEYS = new Set(["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright", "pageup", "pagedown", "shift"]);
function walkLook() {
  const f = new THREE.Vector3(Math.cos(walk.pitch) * Math.cos(walk.yaw), Math.cos(walk.pitch) * Math.sin(walk.yaw), Math.sin(walk.pitch));
  camera.lookAt(camera.position.clone().add(f));
}
function setWalk(on, place = false) {
  if (on === walk.on) return;
  walk.on = on;
  walk.keys.clear();
  walk.touch.clear();
  walk.mx = walk.my = walk.lx = walk.ly = 0;
  walk.placing = false;
  walk.ground = walk.collide = false;
  walk.floorZ = null; walk.free = Infinity;
  tween = null; fly = null;
  clearHover();
  // first person uses a wider lens: inside a building the normal one feels like a tunnel
  persp.fov = on ? WALK_FOV : VIEW_FOV;
  persp.updateProjectionMatrix();
  if (on) {
    if (camera === ortho) setOrtho(false);
    const f = camera.getWorldDirection(new THREE.Vector3());
    walk.yaw = Math.atan2(f.y, f.x);
    walk.pitch = Math.asin(Math.max(-1, Math.min(1, f.z)));
    // initial speed: cross the current camera distance in about 8 seconds
    walk.speed = Math.max(0.3, Math.min(50, camera.position.distanceTo(controls.target) / 8));
    controls.enabled = false;
    walkLook();
  } else {
    lastWalk = walkSpot();
    const f = camera.getWorldDirection(new THREE.Vector3());
    controls.target.copy(camera.position).addScaledVector(f, Math.max(1, walk.speed * 3));
    controls.enabled = true;
    controls.update();
  }
  $("#walkBtn").classList.toggle("on", on);
  $("#walkHint").hidden = !on;
  $("#walkBar").hidden = !on;
  $("#walkPads").hidden = !on;
  view.classList.toggle("walking", on);
  cube.visible = on ? false : app.display.cube;
  if (on && place) setWalkPlacing(true); else syncWalkUI();
  app.emit("walk", on);
  requestRender();
}
app.setWalk = setWalk;
// ---------------------------------------------------------------- walk mode: mini map
// A plan of the model seen from above, cut a little above the eyes (inside a ship or a building it
// shows the deck you are on, not the roof), with "you are here" and the view cone on it. The plan
// is drawn again when you change deck or the visibility changes; a tap on it takes you there.
const MAP_CUT = 0.6; // metres above the eyes
const map = { base: null, z: null, box: null, scale: 1, w: 0, h: 0, timer: 0, show: store.get("pvs-viewer:walkMap", true) };
const mapCanvas = $("#miniMap"), mapCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
let mapRT = null;
function mapSize() {
  const max = touch ? 132 : 176, b = modelBox(), sx = b.max.x - b.min.x, sy = b.max.y - b.min.y;
  const k = max / Math.max(sx, sy, 1e-6);
  return [Math.max(40, Math.round(sx * k)), Math.max(40, Math.round(sy * k))];
}
function renderMapBase() {
  if (!modelMin) return;
  const b = modelBox(), [cw, ch] = mapSize(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
  map.w = cw; map.h = ch; map.box = b; map.z = camera.position.z;
  mapCanvas.style.width = cw + "px"; mapCanvas.style.height = ch + "px";
  mapCanvas.width = W; mapCanvas.height = H;
  const c = b.getCenter(new THREE.Vector3()), hx = (b.max.x - b.min.x) / 2, hy = (b.max.y - b.min.y) / 2;
  mapCam.left = -hx; mapCam.right = hx; mapCam.top = hy; mapCam.bottom = -hy;
  mapCam.near = 0.01; mapCam.far = b.max.z - b.min.z + 2;
  mapCam.position.set(c.x, c.y, b.max.z + 1);
  mapCam.up.set(0, 1, 0);
  mapCam.lookAt(c.x, c.y, b.min.z);
  mapCam.updateProjectionMatrix();
  mapCam.updateMatrixWorld();
  if (!mapRT) mapRT = new THREE.WebGLRenderTarget(W, H);
  else if (mapRT.width !== W || mapRT.height !== H) mapRT.setSize(W, H);
  // cut above the eyes (the user's own plane is put back after)
  const saved = { on: shared.planeOn.value, p: shared.plane.value.clone(), ortho: shared.ortho.value, sky: shared.skyDir.value.clone() };
  shared.planeOn.value = 1;
  shared.plane.value.set(0, 0, 1, camera.position.z + MAP_CUT);
  shared.ortho.value = 1;
  shared.skyDir.value.set(0.35, 0.45, 1).normalize();
  const hv = helpers.visible, cb = clipBox.visible;
  helpers.visible = false; clipBox.visible = false;
  renderer.setRenderTarget(mapRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, mapCam);
  renderer.setRenderTarget(null);
  helpers.visible = hv; clipBox.visible = cb;
  shared.planeOn.value = saved.on; shared.plane.value.copy(saved.p); shared.ortho.value = saved.ortho; shared.skyDir.value.copy(saved.sky);
  const px = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(mapRT, 0, 0, W, H, px);
  const img = new ImageData(W, H);
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4); // bottom-up → top-down
  if (!map.base) map.base = document.createElement("canvas");
  map.base.width = W; map.base.height = H;
  map.base.getContext("2d").putImageData(img, 0, 0);
  requestRender();
}
function drawMap() {
  if (!walk.on || !map.show || !map.base) return;
  const g = mapCanvas.getContext("2d"), W = mapCanvas.width, H = mapCanvas.height, b = map.box;
  g.clearRect(0, 0, W, H);
  g.drawImage(map.base, 0, 0);
  const x = (camera.position.x - b.min.x) / (b.max.x - b.min.x) * W, y = (b.max.y - camera.position.y) / (b.max.y - b.min.y) * H;
  const r = Math.max(W, H) * 0.16, a = -walk.yaw, half = THREE.MathUtils.degToRad(WALK_FOV / 2) * 1.2;
  g.fillStyle = "rgba(37, 99, 235, .28)";
  g.beginPath(); g.moveTo(x, y); g.arc(x, y, r, a - half, a + half); g.closePath(); g.fill();
  g.fillStyle = "#e8590c"; g.strokeStyle = "#fff"; g.lineWidth = Math.max(1.5, W / 120);
  g.beginPath(); g.arc(x, y, Math.max(4, W / 40), 0, Math.PI * 2); g.fill(); g.stroke();
}
// a new plan when the eyes change deck (more than 1.2 m up or down)
function mapFollow() {
  if (!walk.on || !map.show) return;
  if (map.z === null || Math.abs(camera.position.z - map.z) > 1.2) renderMapBase();
  drawMap();
}
function mapLater() { clearTimeout(map.timer); if (walk.on && map.show) map.timer = setTimeout(() => { map.z = null; mapFollow(); }, 300); }
function showMap(on) {
  map.show = on;
  store.set("pvs-viewer:walkMap", on);
  $("#walkMap").classList.toggle("on", on);
  mapCanvas.hidden = !(walk.on && on);
  if (walk.on && on) { map.z = null; mapFollow(); }
}
$("#walkMap").onclick = () => showMap(!map.show);
app.on("frame", mapFollow);
for (const ev of ["state", "clip", "layers", "geometry"]) app.on(ev, mapLater);
app.on("walk", (on) => { mapCanvas.hidden = !(on && map.show); $("#walkMap").classList.toggle("on", map.show); if (on) { map.z = null; mapFollow(); } });
// a tap on the map: go there (same height; with "Chão" on, the feet find the floor)
mapCanvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (!walk.on || !map.box) return;
  const r = mapCanvas.getBoundingClientRect(), b = map.box;
  camera.position.x = b.min.x + (e.clientX - r.left) / r.width * (b.max.x - b.min.x);
  camera.position.y = b.max.y - (e.clientY - r.top) / r.height * (b.max.y - b.min.y);
  walk.floorT = 0; walk.floorZ = null;
  walkLook();
  lastMove = performance.now();
  requestRender();
});

// where the walk mode stands: the floor under the camera and the way it looks (for AR at real size)
let lastWalk = null;
function walkSpot() {
  const g = probe(camera.position, DOWN, 60, 5);
  return { point: camera.position.clone().addScaledVector(Z, -(isFinite(g) ? g : EYE)), yaw: walk.yaw, cam: camera.position.clone() };
}
app.walking = () => walk.on;
$("#walkPlace").onclick = () => setWalkPlacing(!walk.placing);
$("#walkGround").onclick = () => { walk.ground = !walk.ground; walk.floorT = 0; walk.floorZ = null; syncWalkUI(); status(walk.ground ? "Pés no chão: a câmera fica a 1,6 m do piso." : "Voo livre: suba e desça à vontade."); };
$("#walkCollide").onclick = () => { walk.collide = !walk.collide; walk.freeT = 0; syncWalkUI(); status(walk.collide ? "Colisão ligada: você para em paredes e equipamentos." : "Colisão desligada: você atravessa as peças."); };
$("#walkExit").onclick = () => setWalk(false);
$("#walkSlower").onclick = () => { walk.speed = Math.max(0.05, walk.speed / 1.5); syncWalkUI(); };
$("#walkFaster").onclick = () => { walk.speed = Math.min(100, walk.speed * 1.5); syncWalkUI(); };
// up / down buttons (touch): held like keys
document.querySelectorAll("#walkPads [data-walk]").forEach((button) => {
  const key = button.dataset.walk;
  button.addEventListener("pointerdown", (e) => { if (!walk.on) return; e.preventDefault(); button.setPointerCapture(e.pointerId); walk.touch.add(key); button.classList.add("on"); });
  const release = () => { walk.touch.delete(key); button.classList.remove("on"); };
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(ev, release);
  button.addEventListener("contextmenu", (e) => e.preventDefault());
});
// Two thumb sticks (touch): the left one walks, the right one turns the view. x, y in -1..1.
function joystick(el, set) {
  const knob = el.firstElementChild;
  let id = null;
  const move = (e) => {
    const r = el.getBoundingClientRect(), R = r.width / 2;
    let x = (e.clientX - r.left - R) / R, y = (e.clientY - r.top - R) / R;
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    knob.style.transform = `translate(${(x * R * 0.55).toFixed(1)}px, ${(y * R * 0.55).toFixed(1)}px)`;
    set(Math.abs(x) < 0.12 ? 0 : x, Math.abs(y) < 0.12 ? 0 : y);
    requestRender();
  };
  el.addEventListener("pointerdown", (e) => { if (!walk.on) return; e.preventDefault(); id = e.pointerId; el.setPointerCapture(id); el.classList.add("on"); move(e); });
  el.addEventListener("pointermove", (e) => { if (e.pointerId === id) move(e); });
  const end = (e) => { if (e.pointerId !== id) return; id = null; el.classList.remove("on"); knob.style.transform = ""; set(0, 0); };
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(ev, end);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}
joystick($("#joyMove"), (x, y) => { walk.mx = x; walk.my = y; });
joystick($("#joyLook"), (x, y) => { walk.lx = x; walk.ly = y; });

// How far the camera may go along `dir` before touching something (collision).
const _wd = new THREE.Vector3(), _wo = new THREE.Vector3();
function freeStep(dir, step, now) {
  _wd.copy(dir);
  if (walk.ground) _wd.z = 0;
  if (_wd.lengthSq() < 1e-8) return step;
  _wd.normalize();
  if (now - walk.freeT > 90 || _wd.dot(walk.freeDir) < 0.97) {
    _wo.copy(camera.position);
    if (walk.ground) _wo.z -= 0.45; // chest height: steps and low sills do not stop the walk
    walk.free = probe(_wo, _wd, 8, 16);
    walk.freeDir.copy(_wd);
    walk.freeT = now;
  }
  const ok = Math.max(0, Math.min(step, walk.free - BODY));
  walk.free -= ok;
  return ok;
}
// Keep the eyes 1.6 m above the floor (the nearest surface below): climbs steps, falls off edges.
function floorStep(now, dt) {
  if (now - walk.floorT > 110) {
    walk.floorT = now;
    const g = probe(camera.position, DOWN, 60, 5);
    walk.floorZ = isFinite(g) ? camera.position.z - g + EYE : null;
  }
  if (walk.floorZ == null) return false;
  const dz = walk.floorZ - camera.position.z;
  if (Math.abs(dz) < 1e-3) return false;
  const max = (dz > 0 ? 3.5 : 9) * dt;
  camera.position.z += Math.max(-max, Math.min(max, dz));
  return true;
}
function stepWalk(now) {
  const dt = Math.min(0.1, (now - walk.last) / 1000);
  walk.last = now;
  if (!walk.on) return; // "Posicionar" only waits for a tap: walking and looking keep working meanwhile
  let moved = false;
  if (walk.lx || walk.ly) {
    walk.yaw -= walk.lx * 1.9 * dt;
    walk.pitch = Math.max(-1.55, Math.min(1.55, walk.pitch - walk.ly * 1.3 * dt));
    moved = true;
  }
  const K = walk.keys, T = walk.touch;
  let fwd = -walk.my, side = walk.mx, up = 0;
  if (K.has("w") || K.has("arrowup")) fwd += 1;
  if (K.has("s") || K.has("arrowdown")) fwd -= 1;
  if (K.has("d") || K.has("arrowright")) side += 1;
  if (K.has("a") || K.has("arrowleft")) side -= 1;
  if (K.has("e") || K.has("pageup") || T.has("e")) up += 1;
  if (K.has("q") || K.has("pagedown") || T.has("q")) up -= 1;
  const cy = Math.cos(walk.yaw), sy = Math.sin(walk.yaw), cp = Math.cos(walk.pitch);
  const v = walk.ground ? new THREE.Vector3(cy, sy, 0) : new THREE.Vector3(cp * cy, cp * sy, Math.sin(walk.pitch));
  v.multiplyScalar(fwd).add(new THREE.Vector3(sy * side, -cy * side, walk.ground ? 0 : up));
  const mag = Math.min(1, v.length());
  if (mag > 0.01) {
    v.normalize();
    let step = walk.speed * (K.has("shift") ? 4 : 1) * mag * dt;
    if (walk.collide) step = freeStep(v, step, now);
    if (step > 0) { camera.position.addScaledVector(v, step); moved = true; }
  }
  // the floor is measured while moving and for a moment after (settling), not while standing still
  if (walk.ground && (moved || walk.floorT === 0 || now - lastMove < 600) && floorStep(now, dt)) moved = true;
  if (!moved) return;
  walkLook();
  needRender = true;
  lastMove = now;
}
renderer.domElement.addEventListener("wheel", (e) => {
  if (!walk.on) return;
  e.preventDefault();
  walk.speed = Math.max(0.05, Math.min(100, walk.speed * (e.deltaY < 0 ? 1.25 : 0.8)));
  syncWalkUI();
}, { passive: false });
window.addEventListener("blur", () => { walk.keys.clear(); walk.touch.clear(); walk.mx = walk.my = walk.lx = walk.ly = 0; });
window.addEventListener("keyup", (e) => walk.keys.delete(e.key.toLowerCase()));

// ---------------------------------------------------------------- toolbar & keys
$("#fit").onclick = () => fitAll(true, true);
$("#zoomSel").onclick = () => { if (app.selNodes.size) app.frameNodes([...app.selNodes]); };
$("#viewPrev").onclick = () => histGo(-1);
$("#viewNext").onclick = () => histGo(1);
const exportButton = $("#exportMobileBtn");
let exportingMobile = false;
function updateExportButton() {
  exportButton.hidden = !source;
  exportButton.disabled = exportButton.hidden || exportingMobile;
  const selected = app.selNodes.size > 0;
  exportButton.title = selected ? "Exportar as peças selecionadas em um modelo 3D" : "Exportar o modelo 3D completo";
}
app.on("loaded", updateExportButton);
app.on("selection", updateExportButton);
app.canExportModel = () => !!source;
app.exportModelNode = (node) => {
  const parts = [];
  for (let p = app.tree.p0[node]; p < app.tree.p1[node]; p++) if (app.availableParts[p]) parts.push(p);
  return exportModelParts(parts);
};
async function exportModelParts(parts) {
  if (exportingMobile) return;
  exportingMobile = true;
  updateExportButton();
  let writable = null;
  try {
    status(`Exportando modelo 3D (${parts.length.toLocaleString("pt-BR")} peças)…`);
    if (window.desktop && source.kind === "converted") {
      const result = await window.desktop.mobileExport(parts);
      status(result ? `Modelo 3D salvo em ${result}` : "Exportação cancelada");
    } else {
      const filename = (app.title.replace(/\.pvs$/i, "").replace(/[\\/:*?"<>|]/g, "_") || "modelo") + "-modelo.zip";
      if (!window.desktop && window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({ suggestedName: filename,
          types: [{ description: "Modelo 3D (ZIP)", accept: { "application/zip": [".zip"] } }] });
        writable = await handle.createWritable();
      }
      const write = writable ? (bytes) => writable.write(bytes) : null;
      const blob = source.kind === "converted"
        ? await exportMobileZip(source.src, source.meta, parts, status, write)
        : await exportRawModelZip(source, parts, status, write);
      if (writable) { await writable.close(); writable = null; }
      else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        setTimeout(() => { URL.revokeObjectURL(url); link.remove(); }, 60000);
      }
      status("Modelo 3D exportado. O ZIP abre direto em “Abrir arquivo ZIP…”, no PC ou no celular.");
    }
  } catch (error) {
    if (writable) { try { await writable.abort(); } catch { /* already closed */ } }
    if (error.name === "AbortError") status("Exportação cancelada");
    else { status("Erro na exportação: " + error.message); console.error(error); }
  }
  finally { exportingMobile = false; updateExportButton(); }
}
exportButton.onclick = () => {
  const parts = app.selNodes.size ? app.selectedParts().filter((p) => app.availableParts[p])
    : [...app.availableParts.keys()].filter((p) => app.availableParts[p]);
  return exportModelParts(parts);
};
document.querySelectorAll("[data-view]").forEach((b) => {
  b.onclick = () => {
    frame(app.selNodes.size ? app.nodesBox([...app.selNodes]) : modelBox(), VIEWS[b.dataset.view].clone().normalize(), true);
  };
});
$("#isolate").onclick = () => { if (app.selNodes.size) app.isolate([...app.selNodes]); };
$("#hideSel").onclick = () => { if (app.selNodes.size) app.setVisible([...app.selNodes], false); };
$("#showAll").onclick = () => app.showAll();
$("#ortho").onclick = () => { if (walk.on) setWalk(false); setOrtho(camera !== ortho); };
$("#walkBtn").onclick = () => setWalk(!walk.on);
app.toggleOrtho = () => $("#ortho").click();
app.isOrtho = () => camera === ortho;

// drop-down menus
document.querySelectorAll(".menu").forEach((m) => {
  m.querySelector(".menuBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    const open = m.classList.contains("open");
    document.querySelectorAll(".menu.open").forEach((o) => o.classList.remove("open"));
    if (!open) m.classList.add("open");
  });
  m.querySelector(".menuBody").addEventListener("click", (e) => {
    if (e.target.closest("button")) m.classList.remove("open");
    e.stopPropagation();
  });
});
document.addEventListener("click", () => document.querySelectorAll(".menu.open").forEach((o) => o.classList.remove("open")));

window.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  const k = e.key.toLowerCase();
  if (walk.on) {
    if (k === "escape") { if (walk.placing) setWalkPlacing(false); else setWalk(false); return; }
    if (k === "g") { $("#walkGround").click(); return; }
    if (k === "c") { $("#walkCollide").click(); return; }
    if (k === "p") { $("#walkPlace").click(); return; }
    if (WALK_KEYS.has(k)) { walk.keys.add(k); walk.last = performance.now(); requestRender(); e.preventDefault(); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && app.tree) { // undo / redo of visibility and colours
    if (k === "z" && !e.shiftKey) { app.undo(); e.preventDefault(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { app.redo(); e.preventDefault(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // navigation: arrows turn the view (Shift: slide it), + / - zoom, Home fits, 1-4 standard views
  const A = THREE.MathUtils.degToRad(15);
  if (k.startsWith("arrow") && app.tree) {
    const dx = k === "arrowleft" ? -1 : k === "arrowright" ? 1 : 0, dy = k === "arrowup" ? 1 : k === "arrowdown" ? -1 : 0;
    if (e.shiftKey) panBy(dx * 0.12, dy * 0.12); else orbitBy(dx * A, dy * A * 0.66);
    e.preventDefault();
    return;
  }
  if (k === "+" || k === "=") { zoomBy(0.8); return; }
  if (k === "-" || k === "_") { zoomBy(1.25); return; }
  if (k === "home") { fitAll(true, true); e.preventDefault(); return; }
  if (k === "backspace") { histGo(e.shiftKey ? 1 : -1); e.preventDefault(); return; }
  const std = { 1: "front", 2: "side", 3: "top", 4: "iso" }[k];
  if (std && app.tree) { frame(app.selNodes.size ? app.nodesBox([...app.selNodes]) : modelBox(), VIEWS[std].clone().normalize(), true); return; }
  if (k === "5") { $("#ortho").click(); return; }
  if (k === "f") $("#fit").click();
  else if (k === "z") $("#zoomSel").click();
  else if (k === "i") $("#isolate").click();
  else if (k === "h") $("#hideSel").click();
  else if (k === "a") $("#showAll").click();
  else if (k === "g") $("#ghost").click();
  else if (k === "l") $("#listBtn").click();
  else if (k === "e") app.toggleStyle(1);
  else if (k === "x") app.toggleStyle(4);
  else if (k === "c") $("#cutBtn").click();
  else if (k === "r") app.toggleLabels();
  else if (k === "m") $("#measureBtn").click();
  else if (k === "n") $("#nbBtn").click();
  else if (k === "k") $("#layerBtn").click();
  else if (k === "b") $("#bgBtn").click();
  else if (k === "v") $("#animBtn").click();
  else if (k === "p") app.togglePerf();
  else if (k === "escape") app.clearSelection();
});

// ---------------------------------------------------------------- loop
const SKY = new THREE.Vector3(0.35, -0.45, 1).normalize();
// Quality presets: minimum on-screen size (pixels) of the largest part of a chunk, at rest and
// while moving, and what is dropped while moving.
const QUALITY = {
  high: { idle: 0, move: 0, edges: true, ssao: true, ratio: 1 },
  auto: { idle: 0.75, move: 5, edges: true, ssao: false, ratio: 1, adaptive: true },
  fast: { idle: 1, move: 8, edges: false, ssao: false, ratio: 0.6 },
};
// "Automática" adapts to the machine: while the camera moves, the time between frames decides
// how small a part may be before it is skipped (px) and, as a last resort, the resolution. A fast
// graphics card keeps nearly everything; a slow one drops detail until the movement is fluid.
const adapt = { px: 5, ratio: touch ? 0.75 : 1, ema: 0, n: 0, last: 0 };
function adaptQuality(now, moving) {
  if (!moving) { adapt.last = 0; return; }
  const dt = adapt.last ? now - adapt.last : 0;
  adapt.last = now;
  if (!dt || dt > 500) return;
  adapt.ema = adapt.ema ? adapt.ema * 0.75 + dt * 0.25 : dt;
  if (++adapt.n < 5) return;
  adapt.n = 0;
  if (adapt.ema > 42) { // under about 24 frames/s: draw less
    if (adapt.px < 24) adapt.px = Math.min(24, adapt.px * 1.4);
    else if (adapt.ratio > 0.5) adapt.ratio -= 0.25;
  } else if (adapt.ema < 24) { // over about 40 frames/s: there is room for more
    if (adapt.ratio < (touch ? 0.75 : 1)) adapt.ratio += 0.25;
    else if (adapt.px > 1.5) adapt.px = Math.max(1.5, adapt.px / 1.25);
  }
}
let wasMoving = false;
const frameTimes = [];
function animate(now = performance.now()) {
  requestAnimationFrame(animate);
  if (xrOn) return; // the AR session draws its own frames (app.xr.render)
  stepTween(now);
  stepFly(now);
  stepWalk(now);
  if (!walk.on && !tween && !fly && controls.update()) needRender = true;
  const moving = now - lastMove < 150;
  if (wasMoving && !moving) { // the camera came to rest: refine, and remember where it stopped
    needRender = true;
    if (histJump) histJump = false; else if (!walk.on && app.tree) histPush();
    saveLastCamera(); // a phone may close the browser without telling the page
  }
  wasMoving = moving;
  if (!needRender) { adapt.last = 0; return; }
  needRender = false;
  const Q = QUALITY[app.display.quality] || QUALITY.auto;
  if (Q.adaptive) adaptQuality(now, moving);
  const minPx = moving ? (Q.adaptive ? adapt.px : Q.move) : Q.idle;
  const ratio = baseRatio() * (moving ? (Q.adaptive ? adapt.ratio : touch ? Math.min(Q.ratio, 0.75) : Q.ratio) : 1);
  if (Math.abs(ratio - curRatio) > 0.01) { curRatio = ratio; renderer.setPixelRatio(ratio); resize(); }
  applyLod(minPx, moving && (!Q.edges || (Q.adaptive && adapt.px >= 14)));
  const size = modelMin ? modelBox().getSize(new THREE.Vector3()).length() : 100;
  if (camera === persp) {
    if (walk.on) { persp.near = 0.02; persp.far = size * 3; }
    else {
      const d = camera.position.distanceTo(controls.target);
      persp.near = Math.max(d / 2000, 0.0005);
      persp.far = d + size * 2;
    }
    persp.updateProjectionMatrix();
  } else {
    ortho.near = -1e4; ortho.far = 1e4; ortho.updateProjectionMatrix();
  }
  camera.updateMatrixWorld();
  shared.skyDir.value.copy(SKY).transformDirection(camera.matrixWorldInverse);
  const t0 = performance.now();
  if (app.display.ssao && app.display.style !== 3 && (!moving || Q.ssao)) {
    if (!ssao) ssao = new SSAO(renderer);
    const d = walk.on ? 3 : camera === persp ? camera.position.distanceTo(controls.target) : orthoHalf / ortho.zoom * 2;
    ssao.render(scene, camera, Math.max(0.03, Math.min(size * 0.02, d * 0.03)));
  } else {
    renderer.render(scene, camera);
  }
  cube.render(renderer, camera, view.clientWidth, view.clientHeight);
  app.emit("frame");
  frameTimes.push(now);
  while (frameTimes.length && now - frameTimes[0] > 1000) frameTimes.shift();
  if (app.display.perf) showPerf(now, performance.now() - t0, moving);
}

// ---------------------------------------------------------------- augmented reality (ui/ar.js)
// While an AR session runs, the window loop above stops and the session's frames draw the model.
// Its place in the room is the transform of the whole scene: every mesh is a child of it and the
// shaders keep model coordinates for the cuts, so nothing else needs to know about AR.
let xrOn = false, xrOrtho = 0, xrNb = null;
const xrCam = new THREE.PerspectiveCamera(60, 1, 0.01, 2000); // takes the phone's pose and lens each frame
const _eye = new THREE.Vector3(), _xrInv = new THREE.Matrix4(), _xrMv = new THREE.Matrix4();
app.renderer = renderer;
app.xr = {
  // What is shown now, in model coordinates: the visible loaded parts, inside the cut and the neighbourhood.
  bounds() {
    const parts = [];
    for (let p = 0; p < app.nParts; p++) if (app.partVisible[p] && isLoaded(p)) parts.push(p);
    const b = partsBox(parts);
    if (b.isEmpty()) return modelBox();
    if (shared.clipOn.value && !shared.clipInvert.value) b.intersect(new THREE.Box3(shared.clipMin.value.clone(), shared.clipMax.value.clone()));
    if (shared.nbClip.value === 2) b.intersect(new THREE.Box3(shared.nbMin.value.clone(), shared.nbMax.value.clone()));
    if (shared.nbClip.value === 1) {
      const c = shared.nbC.value, r = shared.nbR.value;
      b.intersect(new THREE.Box3(c.clone().subScalar(r), c.clone().addScalar(r)));
    }
    return b.isEmpty() ? modelBox() : b;
  },
  // Returns where to start at real size, in model coordinates: the floor under the walk camera
  // (and the way it looked, `yaw` in the model's xy plane) or the base of the selection; or null.
  // (Also just after leaving the walk mode, while the view has not moved: on a phone its bar is
  // hidden while walking, so the tools are reached by leaving it.)
  begin() {
    let start = null;
    if (walk.on) start = walkSpot();
    else if (lastWalk && lastWalk.cam.distanceToSquared(camera.position) < 1e-8) start = lastWalk;
    else if (app.selNodes.size) {
      const b = app.nodesBox([...app.selNodes]);
      if (!b.isEmpty()) start = { point: new THREE.Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.min.z), yaw: null };
    }
    if (walk.on) setWalk(false);
    xrOn = true;
    setHoverPart(-1);
    xrOrtho = shared.ortho.value;
    shared.ortho.value = 0;
    scene.matrixAutoUpdate = false;
    renderer.xr.enabled = true;
    return start;
  },
  // A sphere (model coordinates) outside which nothing is drawn — the found item on the table —
  // or null; the neighbourhood tool's own cut comes back after.
  clipSphere(c, r) {
    if (c) {
      if (!xrNb) xrNb = { clip: shared.nbClip.value, c: shared.nbC.value.clone(), r: shared.nbR.value };
      shared.nbClip.value = 1;
      shared.nbC.value.copy(c);
      shared.nbR.value = r;
    } else if (xrNb) {
      shared.nbClip.value = xrNb.clip;
      shared.nbC.value.copy(xrNb.c);
      shared.nbR.value = xrNb.r;
      xrNb = null;
    }
  },
  // m: Matrix4 from model coordinates to the room (metres, y up), or null to hide the model
  place(m) {
    scene.visible = !!m;
    if (m) { scene.matrix.copy(m); scene.matrixWorldNeedsUpdate = true; }
  },
  // One AR frame: level of detail from where the phone is, light, then draw (and `extra`, a scene
  // in room coordinates such as the aiming ring, over it). Returns the triangles drawn.
  render(minPx, extra) {
    drawnTris = 0;
    if (scene.visible) {
      scene.updateMatrixWorld();
      const cam = renderer.xr.getCamera(), sub = cam.cameras[0] || cam; // the pose of this frame is in .matrix
      _eye.setFromMatrixPosition(cam.matrix).applyMatrix4(_xrInv.copy(scene.matrixWorld).invert());
      const h = sub.viewport && sub.viewport.w > 0 ? sub.viewport.w : renderer.domElement.height;
      applyLod(minPx, false, _eye, h * sub.projectionMatrix.elements[5] / 2);
      shared.skyDir.value.copy(SKY).transformDirection(_xrMv.multiplyMatrices(_xrInv.copy(cam.matrix).invert(), scene.matrixWorld));
    }
    renderer.render(scene, xrCam);
    if (extra) { renderer.autoClear = false; renderer.render(extra, xrCam); renderer.autoClear = true; }
    return drawnTris;
  },
  end() {
    app.xr.clipSphere(null);
    xrOn = false;
    renderer.xr.enabled = false;
    scene.matrix.identity();
    scene.matrixAutoUpdate = true;
    scene.visible = true;
    scene.updateMatrixWorld(true);
    shared.ortho.value = xrOrtho;
    resize();
    requestRender();
  },
};

// ---------------------------------------------------------------- performance panel
const gpuName = (() => {
  const gl = renderer.getContext();
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "desconhecida";
})();
app.gpu = gpuName;
app.gpuIntegrated = /intel|uhd|iris|microsoft basic|swiftshader|llvmpipe|software/i.test(gpuName) && !/nvidia|radeon|amd|geforce|rtx|gtx|quadro|arc/i.test(gpuName);
let perfShown = 0;
function showPerf(now, cpuMs, moving) {
  if (now - perfShown < 250) return;
  perfShown = now;
  const fps = frameTimes.length > 1 ? (frameTimes.length - 1) * 1000 / (frameTimes[frameTimes.length - 1] - frameTimes[0]) : 0;
  const el = $("#perf");
  el.hidden = false;
  const total = chunks.reduce((s, c) => s + c.ni / 3, 0);
  el.innerHTML = "";
  const line = (k, v, cls) => { const d = document.createElement("div"); if (cls) d.className = cls; d.innerHTML = `<span>${k}</span><b>${v}</b>`; el.append(d); };
  line("Placa de vídeo", gpuName.replace(/^ANGLE \(|\)$/g, "").replace(/ Direct3D.*$/, ""), app.gpuIntegrated ? "warn" : "");
  line("Quadros/s", moving || fps > 0 ? fps.toFixed(0) : "parado");
  line("Envio do quadro (CPU)", cpuMs.toFixed(1) + " ms");
  line("Triângulos desenhados", `${(drawnTris / 1e6).toFixed(1)} de ${(total / 1e6).toFixed(1)} M`);
  line("Blocos desenhados", `${drawnChunks} de ${chunks.length}`);
  line("Memória de vídeo (aprox.)", (gpuBytes / 1048576).toFixed(0) + " MB");
  if (performance.memory) line("Memória JS", (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + " MB");
  line("Qualidade", { high: "alta", auto: "automática", fast: "rápida" }[app.display.quality] + (moving ? " · em movimento" : "")
    + (app.display.quality === "auto" ? ` · peças ≥ ${adapt.px.toFixed(1)} px${adapt.ratio < 1 ? ` · resolução ${Math.round(adapt.ratio * 100)}%` : ""}` : ""));
  if (app.gpuIntegrated) {
    const w = document.createElement("p");
    w.className = "warn";
    w.textContent = "O navegador está usando a placa integrada. No Windows: Configurações › Sistema › Tela › Elementos gráficos › escolha o navegador › Alto desempenho, e reabra o navegador.";
    el.append(w);
  }
}
app.hidePerf = () => { $("#perf").hidden = true; };

// ---------------------------------------------------------------- start
initContextMenu(app);
initUndo(app);
initTree(app);
initViewTabs(app);
initStructure(app);
initSearch(app);
initInfo(app);
initSets(app);
initColors(app);
initTable(app);
initDisplay(app);
initNeighbor(app);
initLayers(app);
initBigrama(app);
initAnim(app);
initLayout(app);
initRegions(app);
initMeasure(app);
initViews(app);
initAnalysis(app);
initMobile(app);
initAR(app);
initLabels(app);

// ---------------------------------------------------------------- link to one part
// ...?peca=LPR-DT20003 opens the model, selects the equipment with that code (or name) and frames it.
function wantedCode() {
  const q = new URLSearchParams(location.search).get("peca");
  if (q) return q;
  const m = /[#&]peca=([^&]+)/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : "";
}
const normCode = (t) => String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s\-_.\/]+/g, "");
app.findByCode = function (code) {
  const want = normCode(code), t = app.tree, ki = app.keyIndex("part_objectid");
  if (!want) return [];
  const exact = [], partial = [];
  for (let n = 1; n < app.nNodes; n++) {
    const name = normCode(t.names[n]), id = ki >= 0 ? normCode(app.prop(n, ki) ?? "") : "";
    if (name === want || id === want) exact.push(n);
    else if (partial.length < 200 && (name.includes(want) || (id && id.includes(want)))) partial.push(n);
  }
  const hits = exact.length ? exact : partial;
  const set = new Set(hits); // an assembly and its own parts: keep the assembly only
  return hits.filter((n) => !set.has(t.parent[n]));
};
app.on("loaded", async () => {
  const code = wantedCode();
  if (!code) return;
  const nodes = app.findByCode(code);
  if (!nodes.length) { status(`Nenhuma peça com o código “${code}” neste modelo.`); return; }
  const need = [];
  app.forParts(nodes, (p) => { if (!isLoaded(p) && app.availableParts[p]) need.push(p); });
  if (need.length) await app.loadParts(need);
  app.select(nodes, "replace");
  app.frameNodes(nodes);
  status(`${code}: ${nodes.length === 1 ? app.tree.names[nodes[0]] : nodes.length + " itens"}`);
});
app.partLink = function (node) {
  const ki = app.keyIndex("part_objectid");
  const code = (ki >= 0 && app.prop(node, ki)) || app.tree.names[node];
  const u = new URL(location.href);
  u.hash = "";
  u.searchParams.delete("abrir");
  u.searchParams.set("peca", code);
  return u.href;
};
if (!window.desktop) app.addContextItems((nodes, node) => [{
  label: "Copiar link desta peça", title: "Um endereço que abre o visualizador, seleciona e enquadra esta peça (quem abrir precisa ter o mesmo modelo)",
  onClick: async () => {
    const url = app.partLink(node);
    try { await navigator.clipboard.writeText(url); status("Link copiado: " + url); } catch { prompt("Copie o link:", url); }
  },
}]);

app.on("selection", () => {
  const s = app.selNodes.size;
  $("#selInfo").textContent = s ? `${s.toLocaleString("pt-BR")} selecionado(s) · ${app.selectedParts().length.toLocaleString("pt-BR")} peça(s)` : "";
});
app.on("model", () => app.setClip({}));
main().catch((e) => { status("Erro: " + e.message); console.error(e); });
