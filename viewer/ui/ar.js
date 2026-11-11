// Augmented reality: the model on a table (or on the floor), seen through the phone's camera.
// WebXR "immersive-ar" with hit testing: Chrome on Android, with "Google Play Services for AR".
// The phone looks for flat surfaces; a ring shows where the model would stand and the model follows
// it; a tap puts it there. Then one finger turns it, two fingers scale and turn it, and the chips
// choose a scale (the whole of it on the table, 1:20, 1:50, 1:100 or real size).
// What is shown is what the viewer shows now: visibility, colours, cuts, exploded view.
import * as THREE from "three";
import { $, status } from "./util.js";

const TABLE = 0.5; // metres: "Mesa" makes the largest side of what is shown this long
const SCALES = { 20: 1 / 20, 50: 1 / 50, 100: 1 / 100, 1: 1 };
// the side of the model the viewer's isometric view looks at faces the phone when it is placed:
// model (1, -1, 0) is room (1, 0, 1) once z-up becomes y-up
const ISO_ANGLE = Math.atan2(1, 1);
const HINT = {
  search: "Aponte para a mesa ou o piso e mova o celular devagar, até aparecer o anel",
  aim: "Toque na tela para pôr o modelo aqui",
  placed: "Um dedo gira · dois dedos aumentam, diminuem e giram",
};

export function initAR(app) {
  const ui = $("#arUi"), hint = $("#arHint"), scaleLbl = $("#arScale");
  const buttons = [$("#arBtn"), $("#mAr")].filter(Boolean);
  for (const b of buttons) b.onclick = () => start();
  app.startAR = start;

  // shown only where the browser can do it (an Android phone or tablet with ARCore, over https)
  (async () => {
    let ok = false;
    try { ok = !!navigator.xr && window.isSecureContext && await navigator.xr.isSessionSupported("immersive-ar"); } catch { ok = false; }
    for (const b of buttons) b.hidden = !ok;
  })();

  // ------------------------------------------------------------ the ring that shows where the model goes
  const marks = new THREE.Scene();
  const ring = new THREE.Group();
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false });
  ring.add(new THREE.Mesh(new THREE.RingGeometry(0.07, 0.085, 48).rotateX(-Math.PI / 2), ringMat));
  ring.add(new THREE.Mesh(new THREE.CircleGeometry(0.008, 16).rotateX(-Math.PI / 2), ringMat));
  ring.matrixAutoUpdate = false;
  ring.visible = false;
  marks.add(ring);

  // ------------------------------------------------------------ state
  let session = null, hitSource = null, refSpace = null, overlay = false;
  let phase = "search"; // search: no surface found yet · aim: the model follows the ring · placed
  let anchor = new THREE.Vector3(), size = new THREE.Vector3();
  const pos = new THREE.Vector3(), hitPos = new THREE.Vector3(), camPos = new THREE.Vector3();
  let yaw = 0, scale = 1, preset = "table", turned = false;
  const M = new THREE.Matrix4(), T = new THREE.Matrix4(), hitM = new THREE.Matrix4();
  const lod = { px: 2, last: 0, ema: 0, n: 0 };

  const fitScale = () => Math.min(20, TABLE / Math.max(1e-6, size.x, size.y, size.z));
  function setPreset(k) {
    preset = k;
    scale = k === "table" ? fitScale() : SCALES[k];
    showScale();
  }
  function showScale() {
    const r = 1 / scale, dec = (x) => (x < 10 ? x.toFixed(1).replace(".", ",").replace(",0", "") : String(Math.round(x)));
    scaleLbl.textContent = Math.abs(r - 1) < 0.05 ? "tamanho real" : r > 1 ? "escala 1:" + dec(r) : "escala " + dec(scale) + ":1";
    for (const b of ui.querySelectorAll("[data-s]")) b.classList.toggle("on", b.dataset.s === preset);
  }
  function setPhase(p) {
    phase = p;
    hint.textContent = HINT[p];
    ui.dataset.phase = p;
  }

  // model → room: base centre at `pos`, turned by `yaw` about the vertical, scaled, z-up → y-up
  function modelMatrix() {
    M.makeTranslation(-anchor.x, -anchor.y, -anchor.z);
    M.premultiply(T.makeRotationX(-Math.PI / 2));
    M.premultiply(T.makeScale(scale, scale, scale));
    M.premultiply(T.makeRotationY(yaw));
    M.premultiply(T.makeTranslation(pos.x, pos.y, pos.z));
    return M;
  }
  // turn the model so that its isometric side faces the phone
  function faceCamera() {
    const dx = camPos.x - pos.x, dz = camPos.z - pos.z;
    if (dx * dx + dz * dz > 1e-6) yaw = Math.atan2(dx, dz) - ISO_ANGLE;
  }

  // ------------------------------------------------------------ start and end
  async function start() {
    if (session || !app.tree) return;
    if (!navigator.xr) { status("Este navegador não tem realidade aumentada (use o Chrome no Android)."); return; }
    const box = app.xr.bounds();
    box.getSize(size);
    anchor.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z);
    let s;
    try {
      s = await navigator.xr.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test"], optionalFeatures: ["dom-overlay"], domOverlay: { root: ui },
      });
    } catch (e) {
      status("Não foi possível abrir a realidade aumentada: " + (e.message || e) +
        ". É preciso o Chrome no Android, com o app “Google Play Services para RA”, e permitir a câmera.");
      return;
    }
    session = s;
    session.addEventListener("end", onEnd);
    const r = app.renderer;
    try {
      app.closeMobileSide?.();
      for (const p of document.querySelectorAll("#floaters .panel")) if (!p.hidden) p.querySelector("[data-close]")?.click();
      app.xr.begin();
      r.xr.setReferenceSpaceType("local");
      await r.xr.setSession(session);
      refSpace = r.xr.getReferenceSpace();
      const viewer = await session.requestReferenceSpace("viewer");
      hitSource = await session.requestHitTestSource({ space: viewer });
    } catch (e) {
      status("Erro na realidade aumentada: " + (e.message || e));
      session.end().catch(() => {});
      return;
    }
    overlay = !!session.domOverlayState;
    if (!overlay) session.addEventListener("select", onSelect); // no buttons: a tap places / picks up again
    turned = false;
    pos.set(0, 0, -1);
    setPreset("table");
    setPhase("search");
    ui.hidden = false;
    lod.px = 2; lod.last = 0; lod.ema = 0;
    r.setAnimationLoop(onFrame);
  }

  function onEnd() {
    const r = app.renderer;
    r.setAnimationLoop(null);
    try { hitSource?.cancel(); } catch { /* already gone */ }
    hitSource = null;
    session = null;
    refSpace = null;
    ui.hidden = true;
    ring.visible = false;
    app.xr.end();
  }
  $("#arExit").onclick = () => session?.end().catch(() => {});

  function onSelect() {
    if (phase === "aim") setPhase("placed");
    else if (phase === "placed") { turned = false; setPhase("aim"); }
  }

  // ------------------------------------------------------------ each frame
  const up = new THREE.Vector3();
  function onFrame(t, frame) {
    if (!session || !frame) return;
    const r = app.renderer;
    camPos.setFromMatrixPosition(r.xr.getCamera().matrix);
    let found = false;
    if (hitSource) {
      for (const h of frame.getHitTestResults(hitSource)) {
        const pose = h.getPose(refSpace);
        if (!pose) continue;
        hitM.fromArray(pose.transform.matrix);
        up.setFromMatrixColumn(hitM, 1);
        if (up.y < 0.75) continue; // a wall, not a table or the floor
        hitPos.setFromMatrixPosition(hitM);
        found = true;
        break;
      }
    }
    if (found && phase === "search") setPhase("aim");
    if (found && phase === "aim") {
      pos.copy(hitPos);
      if (!turned) faceCamera();
    }
    ring.visible = found && phase !== "placed";
    if (ring.visible) ring.matrix.makeTranslation(hitPos.x, hitPos.y, hitPos.z);
    app.xr.place(phase === "search" ? null : modelMatrix());
    adaptLod(t);
    app.xr.render(lod.px, marks);
  }
  // fewer small parts when the phone cannot keep up (the camera picture runs at about 30 frames/s)
  function adaptLod(t) {
    const dt = lod.last ? t - lod.last : 0;
    lod.last = t;
    if (!dt || dt > 500) return;
    lod.ema = lod.ema ? lod.ema * 0.85 + dt * 0.15 : dt;
    if (++lod.n < 10) return;
    lod.n = 0;
    if (lod.ema > 45) lod.px = Math.min(30, lod.px * 1.35);
    else if (lod.ema < 36) lod.px = Math.max(1, lod.px / 1.2);
  }

  // ------------------------------------------------------------ buttons and gestures (over the camera picture)
  $("#arMove").onclick = () => { turned = false; setPhase(phase === "search" ? "search" : "aim"); };
  for (const b of ui.querySelectorAll("[data-s]")) b.onclick = () => setPreset(b.dataset.s);

  const touches = new Map(); // pointerId -> {x, y}
  let g = null; // the gesture going on
  const pair = () => {
    const [a, b] = [...touches.values()];
    return { d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  ui.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) g = { x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, multi: false, yaw, scale };
    else if (touches.size === 2 && g) { const p = pair(); Object.assign(g, { multi: true, d0: p.d, a0: p.a, yaw, scale }); }
  });
  ui.addEventListener("pointermove", (e) => {
    const p0 = touches.get(e.pointerId);
    if (!p0 || !g) return;
    p0.x = e.clientX; p0.y = e.clientY;
    if (touches.size >= 2) {
      const p = pair();
      scale = Math.max(1e-4, Math.min(20, g.scale * p.d / Math.max(1, g.d0)));
      yaw = g.yaw - (p.a - g.a0);
      preset = "";
      turned = true;
      showScale();
    } else if (!g.multi) {
      const dx = e.clientX - g.x0;
      if (!g.moved && Math.hypot(dx, e.clientY - g.y0) > 12) g.moved = true;
      if (g.moved) { yaw = g.yaw + dx * 0.012; turned = true; }
    }
  });
  const lift = (e) => {
    if (!touches.delete(e.pointerId) || !g) return;
    if (touches.size === 0) {
      const tap = !g.moved && !g.multi && performance.now() - g.t0 < 500;
      g = null;
      if (tap && phase === "aim") setPhase("placed");
    } else if (touches.size === 1) { // one finger left: go on turning from here
      const [p] = [...touches.values()];
      Object.assign(g, { x0: p.x, y0: p.y, yaw, scale, moved: true });
    }
  };
  ui.addEventListener("pointerup", lift);
  ui.addEventListener("pointercancel", lift);
}
