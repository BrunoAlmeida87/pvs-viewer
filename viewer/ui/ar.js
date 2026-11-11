// Augmented reality: the model on a table (or on the floor), seen through the phone's camera.
// WebXR "immersive-ar" with hit testing: Chrome on Android, with "Google Play Services for AR".
// The phone looks for flat surfaces; a ring shows where the model would stand and the model follows
// it; a tap puts it there. What is shown is what the viewer shows now: visibility, colours, cuts.
//
// Two ways to look at it:
// - on the table (Mesa, 1:20, 1:50, 1:100): one finger drags the model, two fingers scale and turn it;
// - at real size: you stand inside it. A thumb stick walks (the model moves the other way), ▲ ▼ go
//   up and down a deck, one finger pulls the floor, two fingers turn the model around you. There
//   is nothing to aim at: you are put in at once, the start point on the floor just in front of
//   you. It is where the walk mode stood (looking the same way), else next to the selection, else
//   the middle of the model. "Mover" aims again, to put it on a chosen spot of the floor.
import * as THREE from "three";
import { $, status, VERSION } from "./util.js";

const TABLE = 0.5; // metres: "Mesa" makes the largest side of what is shown this long
const SCALES = { 20: 1 / 20, 50: 1 / 50, 100: 1 / 100, real: 1 };
const MAX_TABLE = 1 / 5; // pinching on the table stops here (bigger is the real-size mode)
const SPEEDS = [0.75, 1.5, 3, 6]; // m/s at full thumb stick
// on the table the side of the model the isometric view looks at faces the phone:
// model (1, -1, 0) is room (1, 0, 1) once z-up becomes y-up
const ISO_ANGLE = Math.atan2(1, 1);
const HINT = {
  search: "Aponte para a mesa ou o piso e mova o celular devagar, até aparecer o anel",
  aim: "Toque na tela para pôr o modelo aqui",
  aimReal: "Aponte para o piso e toque: você começa ali",
  placed: "Arraste para mover · dois dedos aumentam, diminuem e giram",
  placedReal: "Controle da esquerda anda · ▲ ▼ sobem e descem · dois dedos giram em volta de você",
};

export function initAR(app) {
  const ui = $("#arUi"), hint = $("#arHint"), scaleLbl = $("#arScale");
  const buttons = [$("#arBtn"), $("#mAr"), $("#walkAr")].filter(Boolean);
  for (const b of buttons) b.onclick = () => start({ real: b.id === "walkAr" }); // from the walk mode: real size, right there
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
  let session = null, hitSource = null, refSpace = null;
  let phase = "search"; // search: no surface found yet · aim: the model follows the ring · placed
  const size = new THREE.Vector3();
  const tableAnchor = new THREE.Vector3(); // model point on the table: the base centre
  const realAnchor = new THREE.Vector3();  // model point at the ring at real size: where you start
  let realYaw = null; // the way the walk mode looked (model xy angle), or null
  const pos = new THREE.Vector3(), hitPos = new THREE.Vector3(), camPos = new THREE.Vector3();
  let yaw = 0, scale = 1, preset = "table", turned = false, speed = 1;
  const M = new THREE.Matrix4(), T = new THREE.Matrix4(), hitM = new THREE.Matrix4();
  const lod = { px: 2, last: 0, ema: 0, n: 0 };
  const fwd = new THREE.Vector3();
  const joy = { id: null, x: 0, y: 0, vert: 0 };
  let lastT = 0;
  let floorY = null; // the floor seen by the phone (a surface well below it), room y

  const real = () => preset === "real";
  const anchor = () => (real() ? realAnchor : tableAnchor);
  const fitScale = () => Math.min(MAX_TABLE, TABLE / Math.max(1e-6, size.x, size.y, size.z));
  function setPreset(k) {
    const was = real();
    preset = k;
    scale = k === "table" ? fitScale() : SCALES[k];
    // between the table and real size the model goes somewhere else: aim again
    if (was !== real()) {
      turned = false;
      if (real()) enterReal(); // no aiming: in at once (or at the first frame)
      else if (phase !== "search") setPhase("aim");
    }
    ui.classList.toggle("real", real());
    showScale();
    setPhase(phase);
  }
  function showScale() {
    const r = 1 / scale, dec = (x) => (x < 10 ? x.toFixed(1).replace(".", ",").replace(",0", "") : String(Math.round(x)));
    scaleLbl.textContent = Math.abs(r - 1) < 0.05 ? "tamanho real" : r > 1 ? "escala 1:" + dec(r) : "escala " + dec(scale) + ":1";
    for (const b of ui.querySelectorAll("[data-s]")) b.classList.toggle("on", b.dataset.s === preset);
  }
  function setPhase(p) {
    phase = p;
    hint.textContent = HINT[p === "search" ? p : p + (real() ? "Real" : "")];
    ui.dataset.phase = p;
  }
  const showSpeed = () => { $("#arSpeed").textContent = String(SPEEDS[speed]).replace(".", ",") + " m/s"; };

  // model → room: the anchor at `pos`, turned by `yaw` about the vertical, scaled, z-up → y-up
  function modelMatrix() {
    const a = anchor();
    M.makeTranslation(-a.x, -a.y, -a.z);
    M.premultiply(T.makeRotationX(-Math.PI / 2));
    M.premultiply(T.makeScale(scale, scale, scale));
    M.premultiply(T.makeRotationY(yaw));
    M.premultiply(T.makeTranslation(pos.x, pos.y, pos.z));
    return M;
  }
  // real size: the start point on the floor 0.8 m in front of the phone, the model turned
  function enterReal() {
    const cam = app.renderer.xr.getCamera();
    if (!session || !cam.cameras.length) { if (phase !== "search") setPhase("search"); return; } // no pose yet: onFrame does it
    camPos.setFromMatrixPosition(cam.matrix);
    const e = cam.matrix.elements;
    fwd.set(-e[8], 0, -e[10]);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const y = floorY !== null && floorY < camPos.y - 0.9 ? floorY : camPos.y - 1.4;
    pos.set(camPos.x + fwd.x * 0.8, y, camPos.z + fwd.z * 0.8);
    faceCamera();
    setPhase("placed");
  }
  // the angle of a room direction about the vertical (rotating by `yaw` adds to it)
  const angle = (x, z) => Math.atan2(x, z);
  function faceCamera() {
    const dx = camPos.x - pos.x, dz = camPos.z - pos.z;
    if (dx * dx + dz * dz < 1e-6) return;
    if (real() && realYaw !== null) {
      // look the way the walk mode looked: that model direction along the phone's view
      const e = app.renderer.xr.getCamera().matrix.elements;
      yaw = angle(-e[8], -e[10]) - angle(Math.cos(realYaw), -Math.sin(realYaw));
    } else {
      yaw = angle(dx, dz) - ISO_ANGLE;
    }
  }

  // ------------------------------------------------------------ start and end
  async function start(opts = {}) {
    if (session || !app.tree) return;
    if (!navigator.xr) { status("Este navegador não tem realidade aumentada (use o Chrome no Android)."); return; }
    const box = app.xr.bounds();
    box.getSize(size);
    tableAnchor.set((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z);
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
      const from = app.xr.begin();
      realAnchor.copy(from ? from.point : tableAnchor);
      realYaw = from ? from.yaw : null;
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
    if (!session.domOverlayState) session.addEventListener("select", onSelect); // no buttons: a tap places / picks up again
    turned = false;
    pos.set(0, 0, -1);
    floorY = null;
    phase = "search";
    setPreset(opts.real ? "real" : "table");
    showSpeed();
    $("#arVersion").textContent = "v" + VERSION;
    ui.hidden = false;
    lod.px = 2; lod.last = 0; lod.ema = 0; lastT = 0;
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
    stopJoy();
    app.xr.end();
  }
  $("#arExit").onclick = () => session?.end().catch(() => {});

  function onSelect() {
    if (phase === "aim") setPhase("placed");
    else if (phase === "placed") { turned = false; setPhase("aim"); }
  }

  // ------------------------------------------------------------ each frame
  const up = new THREE.Vector3(), side = new THREE.Vector3();
  function onFrame(t, frame) {
    if (!session || !frame) return;
    const r = app.renderer, cam = r.xr.getCamera();
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
    lastT = t;
    camPos.setFromMatrixPosition(cam.matrix);
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
    if (found && hitPos.y < camPos.y - 0.9) floorY = floorY === null ? hitPos.y : Math.min(floorY, hitPos.y);
    if (phase === "search" && real() && cam.cameras.length) enterReal();
    if (found && phase === "search") setPhase("aim");
    if (found && phase === "aim") {
      pos.copy(hitPos);
      if (!turned) faceCamera();
    }
    // walking at real size: the model moves the other way
    if (phase === "placed" && real() && dt && (joy.x || joy.y || joy.vert)) {
      const e = cam.matrix.elements, v = SPEEDS[speed] * dt;
      fwd.set(-e[8], 0, -e[10]).normalize();
      side.set(e[0], 0, e[2]).normalize();
      pos.addScaledVector(fwd, -joy.y * v).addScaledVector(side, -joy.x * v);
      pos.y -= joy.vert * Math.min(v, 1.2 * dt);
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

  // ------------------------------------------------------------ where a finger points, on a level plane
  const ro = new THREE.Vector3(), rd = new THREE.Vector3();
  function onPlane(x, y, h, out) {
    const sub = app.renderer.xr.getCamera().cameras[0];
    if (!sub) return null;
    ro.setFromMatrixPosition(sub.matrix);
    rd.set((x / window.innerWidth) * 2 - 1, 1 - (y / window.innerHeight) * 2, 0.5)
      .applyMatrix4(sub.projectionMatrixInverse).applyMatrix4(sub.matrix).sub(ro).normalize();
    if (Math.abs(rd.y) < 0.02) return null;
    const k = (h - ro.y) / rd.y;
    if (k <= 0 || k > 40) return null; // above the horizon, or too far to drag sensibly
    return out.copy(ro).addScaledVector(rd, k);
  }

  // ------------------------------------------------------------ buttons
  $("#arMove").onclick = () => { turned = false; if (phase !== "search") setPhase("aim"); };
  for (const b of ui.querySelectorAll("[data-s]")) b.onclick = () => setPreset(b.dataset.s);
  $("#arSpeed").onclick = () => { speed = (speed + 1) % SPEEDS.length; showSpeed(); };
  for (const b of ui.querySelectorAll("[data-v]")) {
    const v = Number(b.dataset.v);
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); joy.vert = v; b.classList.add("on"); });
    const off = () => { if (joy.vert === v) joy.vert = 0; b.classList.remove("on"); };
    b.addEventListener("pointerup", off);
    b.addEventListener("pointercancel", off);
  }

  // thumb stick (real size)
  const stick = $("#arJoy"), knob = stick.querySelector("i");
  function moveJoy(e) {
    const r = stick.getBoundingClientRect(), R = r.width / 2 - 10;
    let x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    const l = Math.hypot(x, y);
    if (l > R) { x *= R / l; y *= R / l; }
    knob.style.transform = `translate(${x}px, ${y}px)`;
    // a small dead zone, then a curve that is gentle near the centre
    const f = (u) => { const a = Math.max(0, Math.abs(u) - 0.12) / 0.88; return Math.sign(u) * a * a; };
    joy.x = f(x / R); joy.y = f(-y / R);
  }
  function stopJoy() { joy.id = null; joy.x = joy.y = 0; knob.style.transform = ""; }
  stick.addEventListener("pointerdown", (e) => { e.preventDefault(); stick.setPointerCapture(e.pointerId); joy.id = e.pointerId; moveJoy(e); });
  stick.addEventListener("pointermove", (e) => { if (e.pointerId === joy.id) moveJoy(e); });
  stick.addEventListener("pointerup", (e) => { if (e.pointerId === joy.id) stopJoy(); });
  stick.addEventListener("pointercancel", (e) => { if (e.pointerId === joy.id) stopJoy(); });

  // ------------------------------------------------------------ gestures on the picture
  // one finger: drag the model (on the table) or pull the floor (real size)
  // two fingers: turn (about the model on the table, about you at real size); on the table also scale
  const touches = new Map(); // pointerId -> {x, y}
  let g = null; // the gesture going on
  const pair = () => {
    const [a, b] = [...touches.values()];
    return { d: Math.hypot(b.x - a.x, b.y - a.y), a: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  const grabAt = (x, y) => {
    Object.assign(g, { x0: x, y0: y, pos0: pos.clone(), grab: onPlane(x, y, pos.y, new THREE.Vector3()) });
  };
  ui.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, .joy")) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 1) {
      g = { t0: performance.now(), moved: false, multi: false };
      grabAt(e.clientX, e.clientY);
    } else if (touches.size === 2 && g) {
      const p = pair();
      Object.assign(g, { multi: true, d0: p.d, a0: p.a, yaw0: yaw, scale0: scale, pos0: pos.clone(), pivot: (real() ? camPos : pos).clone() });
    }
  });
  const _p = new THREE.Vector3(), _r = new THREE.Vector3();
  ui.addEventListener("pointermove", (e) => {
    const p0 = touches.get(e.pointerId);
    if (!p0 || !g) return;
    p0.x = e.clientX; p0.y = e.clientY;
    if (!g.moved && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > 12) g.moved = true;
    if (phase !== "placed") return; // while aiming the model follows the ring
    if (touches.size >= 2) {
      const p = pair(), turn = -(p.a - g.a0);
      // turn about the pivot: the pivot stays put
      _r.copy(g.pos0).sub(g.pivot).applyAxisAngle(_p.set(0, 1, 0), turn);
      pos.copy(g.pivot).add(_r);
      yaw = g.yaw0 + turn;
      turned = true;
      if (!real()) {
        scale = Math.max(1e-4, Math.min(MAX_TABLE, g.scale0 * p.d / Math.max(1, g.d0)));
        preset = "";
        showScale();
      }
    } else if (!g.multi) {
      if (g.moved && g.grab && onPlane(e.clientX, e.clientY, g.pos0.y, _p)) {
        pos.set(g.pos0.x + _p.x - g.grab.x, g.pos0.y, g.pos0.z + _p.z - g.grab.z);
      }
    }
  });
  const lift = (e) => {
    if (!touches.delete(e.pointerId) || !g) return;
    if (touches.size === 0) {
      const tap = !g.moved && !g.multi && performance.now() - g.t0 < 500;
      g = null;
      if (tap && phase === "aim") setPhase("placed");
    } else if (touches.size === 1) { // one finger left: the turn / scale is over, nothing until it lifts
      g.moved = true;
    }
  };
  ui.addEventListener("pointerup", lift);
  ui.addEventListener("pointercancel", lift);
}
