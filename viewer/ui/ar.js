// Augmented reality: the model on a table (or on the floor), seen through the phone's camera.
// WebXR "immersive-ar" with hit testing: Chrome on Android, with "Google Play Services for AR".
// The phone looks for flat surfaces; a ring shows where the model would stand and the model follows
// it; a tap puts it there. What is shown is what the viewer shows now: visibility, colours, cuts.
//
// Two ways to look at it:
// - on the table (Mesa, 1:20, 1:50, 1:100): one finger drags the model, two fingers scale and turn it;
// - at real size: you stand inside it. A thumb stick walks (the model moves the other way), ▲ ▼ go
//   up and down a deck, one finger pulls the floor, two fingers turn the model around you. There
//   is nothing to aim at: you are put in at once. From the walk mode you start under your own feet,
//   looking the way the walk mode looked; else the start point is on the floor just in front of you,
//   next to the selection or in the middle of the model. "Mover" aims again, to put it on a chosen
//   spot of the floor.
//
// "Acertar posição" (real size) puts the model on the real place: choose an equipment near you and
// tap the floor at its foot; a second one, a few metres from the first, also fixes the direction.
//
// "Buscar" finds an item by name or code: it turns orange and everything else transparent. On the
// table the view zooms in on it (only what is around it is drawn). At real size the model stays
// where it is and the item is found like a lost tracker: a card at the top with an arrow pointing to
// it, how far it is, which side and how high; its box and a pin over it are drawn through the walls;
// the phone buzzes as you get closer; "Ver de perto" brings it in front of you, "Voltar ao lugar"
// takes it back. "✕ name" takes the highlight away. Without typing (the keyboard may not open over
// the camera picture), the list offers the systems (bigramas), then the equipment of the one chosen.
//
// "Ir até… › Na RA" walks a route at real size: the model starts where the route starts (you stand
// there, facing the way it goes) and is hidden — the blue band and its arrows lie on the real
// floor, an arrow at the top points where to go, with the next step and the distance.
import * as THREE from "three";
import { $, status, VERSION } from "./util.js";
import { itemPicker } from "./picker.js";
import { along } from "../lib/navpath.js";
import { findInfo, findLine, closerStep } from "../lib/arfind.js";

const TABLE = 0.5; // metres: "Mesa" makes the largest side of what is shown this long
const SCALES = { 20: 1 / 20, 50: 1 / 50, 100: 1 / 100, real: 1 };
const MAX_TABLE = 1 / 5; // pinching on the table stops here (bigger is the real-size mode)
const SPEEDS = [0.75, 1.5, 3, 6]; // m/s at full thumb stick
const FOCUS_TABLE = 0.25; // metres: on the table the found item is zoomed to about this size
const FOCUS_AROUND = 0.3; // metres: radius of what is still drawn around it on the table
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
  // the hint fades out after a few seconds once placed: each new message shows again
  new MutationObserver(() => { hint.style.animation = "none"; void hint.offsetWidth; hint.style.animation = ""; })
    .observe(hint, { childList: true, characterData: true, subtree: true });
  const buttons = [$("#arBtn"), $("#mAr"), $("#walkAr")].filter(Boolean);
  for (const b of buttons) b.onclick = () => start({ real: b.id === "walkAr" }); // from the walk mode: real size, right there
  app.startAR = start;

  // shown only where the browser can do it (an Android phone or tablet with ARCore, over https)
  (async () => {
    let ok = false;
    try { ok = !!navigator.xr && window.isSecureContext && await navigator.xr.isSessionSupported("immersive-ar"); } catch { ok = false; }
    for (const b of buttons) b.hidden = !ok;
    const go = $("#goAr");
    if (go) { go.hidden = !ok; go.onclick = () => start({ real: true, nav: true }); }
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
  let focus = null; // the found item: {nodes, box, name, ghost, sel} (ghost and selection from before)
  let zoom = null;  // the view zoomed on it: {anchor, clip}; the anchor replaces the preset's
  let tween = null; // a smooth move of the model: {t0, dur, p0, p1, s0, s1}
  let nav = null;   // walking a route: {route, steps, cum, s, shownAt, done}
  let navCal = null; // the equipment whose foot is being tapped to fix the position: {nodes, box, name}
  let hitOk = false; // a surface under the ring this frame
  let cal = [];      // the last taps of "Acertar posição": [{M (model), R (room)}]
  let align = "none"; // how the model sits on the real place: none · walk · start (of a route) · pos · full
  let startAtFeet = false; // real size starts under your feet (from the walk mode, on a route)
  let modelHidden = false; // only the helpers drawn over the camera picture (route, found item)
  let near = null;   // "Ver de perto": the found item brought in front of you; {pos} where the model was
  let finder = { shownAt: 0, last: Infinity, arrived: false, index: -1 };

  const real = () => preset === "real";
  const anchor = () => (zoom ? zoom.anchor : real() ? realAnchor : tableAnchor);
  const fitScale = () => Math.min(MAX_TABLE, TABLE / Math.max(1e-6, size.x, size.y, size.z));
  function setPreset(k) {
    const was = real(), zoomed = !!zoom;
    preset = k;
    scale = k === "table" ? fitScale() : SCALES[k];
    tween = null;
    if (zoom) { zoom = null; app.xr.clipSphere(null); } // a scale chip goes back to the whole model
    // between the table and real size the model goes somewhere else: aim again
    near = null;
    if (was !== real() || (zoomed && real())) {
      turned = false;
      if (real()) {
        if (phase !== "search") align = "none"; // from the table: no longer on the real place
        enterReal(); // no aiming: in at once (or at the first frame)
      } else if (phase !== "search") setPhase("aim");
    }
    ui.classList.toggle("real", real());
    showScale();
    setPhase(phase);
    syncGuide();
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
  // real size: the start point on the floor 0.8 m in front of the phone (under it, from the walk
  // mode or on a route), the model turned
  function enterReal() {
    const cam = app.renderer.xr.getCamera();
    if (!session || !cam.cameras.length) { if (phase !== "search") setPhase("search"); return; } // no pose yet: onFrame does it
    camPos.setFromMatrixPosition(cam.matrix);
    const e = cam.matrix.elements;
    fwd.set(-e[8], 0, -e[10]);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const y = floorY !== null && floorY < camPos.y - 0.9 ? floorY : camPos.y - 1.4;
    const ahead = startAtFeet ? 0 : 0.8;
    pos.set(camPos.x + fwd.x * ahead, y, camPos.z + fwd.z * ahead);
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
      const route = opts.nav && app.navRoute ? app.navRoute() : null;
      nav = route ? startNav(route) : null;
      if (nav) app.navShowRoute?.(true);
      const from = app.xr.begin();
      const fromWalk = !nav && !!(from && from.cam);
      if (nav) { realAnchor.set(...route.route.points[0]); realYaw = nav.yaw0; }
      else { realAnchor.copy(from ? from.point : tableAnchor); realYaw = from ? from.yaw : null; }
      startAtFeet = !!nav || fromWalk;
      align = nav ? "start" : fromWalk ? "walk" : "none";
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
    cal = []; near = null; navCal = null;
    modelHidden = !!nav;
    app.xr.hideModel(modelHidden);
    setPreset(opts.real || nav ? "real" : "table");
    if (nav) hint.textContent = "Fique no começo do caminho, virado para onde ele vai. Depois, “Acertar posição” num equipamento perto.";
    else if (fromWalk) hint.textContent = "Você está onde parou na caminhada: fique nesse lugar, olhando para o mesmo lado. “Acertar posição” corrige.";
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
    // the found item stays selected in the viewer; the transparency goes back to what it was
    if (focus) { app.setGhost(focus.ghost); focus = null; }
    zoom = null; tween = null;
    if (nav) { app.navShowRoute?.(false); nav = null; }
    navCal = null; near = null; cal = []; modelHidden = false;
    navArrow.visible = false;
    findMarks.visible = false;
    showFocus();
    syncGuide();
    closeSearch();
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
    hitOk = found;
    if (found && hitPos.y < camPos.y - 0.9) floorY = floorY === null ? hitPos.y : Math.min(floorY, hitPos.y);
    if (phase === "search" && real() && cam.cameras.length) enterReal();
    if (found && phase === "search") setPhase("aim");
    if (found && phase === "aim") {
      pos.copy(hitPos);
      if (!turned) faceCamera();
    }
    if (tween) {
      const k = Math.min(1, (t - (tween.t0 ??= t)) / tween.dur), e = k * k * (3 - 2 * k);
      pos.lerpVectors(tween.p0, tween.p1, e);
      scale = tween.s0 * Math.pow(tween.s1 / tween.s0, e);
      if (k >= 1) { const done = tween.done; tween = null; done?.(); }
    }
    // walking at real size: the model moves the other way
    if (phase === "placed" && real() && dt && (joy.x || joy.y || joy.vert)) {
      const e = cam.matrix.elements, v = SPEEDS[speed] * dt;
      fwd.set(-e[8], 0, -e[10]).normalize();
      side.set(e[0], 0, e[2]).normalize();
      pos.addScaledVector(fwd, -joy.y * v).addScaledVector(side, -joy.x * v);
      pos.y -= joy.vert * Math.min(v, 1.2 * dt);
    }
    ring.visible = found && (phase !== "placed" || !!navCal);
    if (ring.visible) ring.matrix.makeTranslation(hitPos.x, hitPos.y, hitPos.z);
    findMarks.visible = false;
    if (phase === "placed" && focus && real() && !near) findFrame(cam, t);
    else if (nav && phase === "placed") navFrame(cam, t);
    else navArrow.visible = false;
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
  $("#arMove").onclick = () => {
    turned = false;
    tween = null;
    if (zoom && real()) zoom = null; // at real size the start point goes to the floor, not the item
    if (phase !== "search") setPhase("aim");
  };
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
    if (e.target.closest("button, .joy, #arSearch")) return;
    tween = null;
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
      if (tap && navCal) { if (hitOk) applyCalib(); else hint.textContent = "Aponte para o piso até aparecer o anel, e toque."; }
      else if (tap && phase === "aim") { setPhase("placed"); if (focus && !real()) zoomTo(focus.box); }
    } else if (touches.size === 1) { // one finger left: the turn / scale is over, nothing until it lifts
      g.moved = true;
    }
  };
  ui.addEventListener("pointerup", lift);
  ui.addEventListener("pointercancel", lift);

  // ------------------------------------------------------------ find an item, highlight it and zoom on it
  const panel = $("#arSearch"), q = $("#arQ"), list = $("#arResults"), chip = $("#arFocus");
  let pickFor = "find"; // "find": highlight the item · "calib": tap at its foot to fix the position
  const picker = itemPicker(app, {
    list, input: q, allSystem: true,
    onPick: (nodes, title) => (pickFor === "calib" ? startCalib(nodes, title) : pick(nodes, title)),
    extra: () => (pickFor === "calib" ? nearRows() : []),
  });
  // the box gets the focus only when tapped: on the phone that would open the keyboard over the list
  function openSearch() {
    panel.hidden = false;
    picker.show();
  }
  function closeSearch() { panel.hidden = true; q.blur(); }
  $("#arFind").onclick = () => { pickFor = "find"; if (panel.hidden) openSearch(); else closeSearch(); };
  $("#arQClose").onclick = closeSearch;

  async function pick(nodes, title) {
    closeSearch();
    const parts = [];
    app.forParts(nodes, (p) => parts.push(p));
    const need = parts.filter((p) => !app.isLoaded(p) && app.availableParts[p]);
    if (need.length) { hint.textContent = "Carregando o item…"; await app.loadParts(need); }
    if (!session) return;
    if (parts.some((p) => !app.partVisible[p])) app.setVisible(nodes, true);
    if (!focus) focus = { ghost: app.ghost, sel: [...app.selNodes] };
    if (near) backFromNear(false);
    focus.nodes = nodes;
    focus.name = title || (nodes.length === 1 ? app.tree.names[nodes[0]] : `${nodes.length} itens`);
    focus.box = app.nodesBox(nodes);
    // each item on its own (a whole system: the arrow goes to the nearest one)
    focus.items = nodes.map((n) => ({ n, b: app.nodesBox([n]) })).filter((x) => !x.b.isEmpty())
      .map((x) => ({ n: x.n, box: [x.b.min.x, x.b.min.y, x.b.min.z, x.b.max.x, x.b.max.y, x.b.max.z] }));
    focus.boxes = focus.items.map((x) => x.box);
    finder = { shownAt: 0, last: Infinity, arrived: false, index: -1 };
    app.select(nodes, "replace");
    app.setGhost(true);
    showFocus();
    if (phase === "placed" && !focus.box.isEmpty() && !real()) zoomTo(focus.box);
    setPhase(phase);
    syncGuide();
    hint.textContent = real()
      ? (align === "none" ? `Para a seta apontar certo, use “Acertar posição” num equipamento perto de você.` : `Siga a seta até ${focus.name}.`)
      : focus.name + (phase === "placed" ? " em destaque" : " em destaque: ponha o modelo para ver");
  }
  function clearFocus() {
    if (!focus) return;
    if (near) backFromNear(true);
    app.select(focus.sel, "replace");
    app.setGhost(focus.ghost);
    focus = null;
    showFocus();
    if (zoom && !real()) setPreset("table"); // the zoomed-in table view: back to the whole model
    setPhase(phase);
    syncGuide();
  }
  function showFocus() {
    chip.hidden = !focus;
    if (focus) chip.textContent = "✕ " + focus.name;
  }
  chip.onclick = clearFocus;

  // move the model so that the item is easy to see (smoothly, from where it is now)
  const _a = new THREE.Vector3(), _c = new THREE.Vector3(), _sz = new THREE.Vector3();
  function zoomTo(box) {
    box.getCenter(_c);
    const big = Math.max(1e-3, ...box.getSize(_sz).toArray());
    const now = modelMatrix().clone();
    tween = null;
    if (real()) {
      // in front of you, at a distance that fits it; at the same height unless it is out of reach
      const a = _c.clone(), from = a.clone().applyMatrix4(now);
      const e = app.renderer.xr.getCamera().matrix.elements;
      fwd.set(-e[8], 0, -e[10]);
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      const d = Math.max(1.2, big * 0.6 + 0.8);
      const to = camPos.clone().addScaledVector(fwd, d);
      to.y = Math.abs(from.y - camPos.y) < 2 ? from.y : camPos.y - 0.2;
      zoom = { anchor: a, clip: false };
      pos.copy(from);
      tween = { t0: null, dur: 900, p0: from, p1: to, s0: scale, s1: scale };
    } else {
      // on the table: the item's base where the model stands, zoomed in, only its surroundings drawn
      const a = _a.set(_c.x, _c.y, box.min.z).clone(), from = a.clone().applyMatrix4(now);
      const spot = pos.clone(); // the anchor's place on the table
      const s1 = Math.max(scale, Math.min(1, FOCUS_TABLE / big));
      // only a real zoom-in needs the cut (a whole system is about as big as the model)
      const clip = s1 > scale * 1.5;
      zoom = { anchor: a, clip };
      app.xr.clipSphere(clip ? _c : null, Math.max(FOCUS_AROUND / s1, big * 0.75));
      pos.copy(from);
      tween = { t0: null, dur: 900, p0: from, p1: spot, s0: scale, s1 };
      preset = "";
      scale = tween.s0;
      const r = 1 / s1;
      showScale();
      scaleLbl.textContent = Math.abs(r - 1) < 0.05 ? "tamanho real" : "escala 1:" + (r < 10 ? r.toFixed(1).replace(".", ",").replace(",0", "") : Math.round(r));
    }
  }

  // ------------------------------------------------------------ walking a route ("Ir até…")
  const NAV_AHEAD = 2.5; // metres: the arrow points at the route this far ahead
  const navArrow = new THREE.Group();
  {
    // a flat arrow pointing to -z (forward), seen from above and a little from the side
    const sh = new THREE.Shape([[0, -0.22], [0.13, 0.04], [0.045, 0.01], [0.045, 0.16], [-0.045, 0.16], [-0.045, 0.01], [-0.13, 0.04]].map(([x, y]) => new THREE.Vector2(x, y)));
    const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.03, bevelEnabled: false }).rotateX(Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x4dabf7, transparent: true, opacity: 0.92, depthTest: false }));
    m.renderOrder = 20;
    navArrow.add(m);
  }
  navArrow.visible = false;
  marks.add(navArrow);
  function startNav(cur) {
    const P = cur.route.points, cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]));
    const a = along(cur.route, 0);
    return { route: cur.route, steps: cur.steps, to: cur.to, from: cur.from, cum, s: 0, done: false, shownAt: 0,
      yaw0: Math.atan2(a.dir[1], a.dir[0]) };
  }
  $("#arNavModel").onclick = () => { modelHidden = !modelHidden; app.xr.hideModel(modelHidden); syncGuide(); };
  $("#arCal").onclick = () => {
    if (!real() || phase === "search") return;
    if (navCal) { navCal = null; hint.textContent = "Acerto cancelado."; return; }
    pickFor = "calib";
    q.value = "";
    openSearch();
  };
  const _inv = new THREE.Matrix4(), _u = new THREE.Vector3(), _t = new THREE.Vector3();
  // where the phone is, in model coordinates, and the feet under it
  function userInModel() {
    _inv.copy(modelMatrix()).invert();
    _u.copy(camPos).applyMatrix4(_inv);
    const eye = floorY !== null && camPos.y - floorY > 0.9 ? camPos.y - floorY : 1.45;
    return { x: _u.x, y: _u.y, z: _u.z, feet: _u.z - eye };
  }
  // equipment near where you are, to fix the position on (with the route's start first)
  let eqCache = null;
  app.on("model", () => { eqCache = null; });
  function nearRows() {
    if (!session) return [];
    if (!eqCache) {
      eqCache = [];
      for (const g of (app.bigramaList || []).filter((x) => x.code)) for (const n of picker.equipmentOf(g.code)) {
        const b = app.nodesBox([n]);
        if (!b.isEmpty()) eqCache.push({ n, b, c: b.getCenter(new THREE.Vector3()) });
      }
    }
    const u = userInModel(), rows = [];
    if (nav && nav.from && nav.from.kind === "item") rows.push({ label: nav.from.name, sub: "ponto de partida do caminho", nodes: nav.from.nodes, title: nav.from.name });
    const near = eqCache.map((e) => ({ ...e, d: Math.hypot(e.c.x - u.x, e.c.y - u.y) + Math.abs(e.b.min.z - u.feet) * 2 }))
      .filter((e) => e.d < 25).sort((a, b) => a.d - b.d).slice(0, 12);
    for (const e of near) rows.push({ label: app.tree.names[e.n], sub: `a uns ${Math.max(1, Math.round(e.d))} m daqui`, nodes: [e.n], title: app.tree.names[e.n] });
    return rows;
  }
  function startCalib(nodes, name) {
    closeSearch();
    pickFor = "find";
    const box = app.nodesBox(nodes);
    if (box.isEmpty()) { hint.textContent = "Esse item não tem geometria carregada."; return; }
    if (near) backFromNear(false); // the model goes back on the real place first
    navCal = { nodes, box, name };
    hint.textContent = `Aponte para o piso junto ao pé de ${name}, do lado em que você está, e toque quando aparecer o anel.`;
  }
  // the tapped floor point (room) is the foot of the chosen equipment on your side (model)
  function applyCalib() {
    const u = userInModel(), b = navCal.box;
    const mx = Math.max(b.min.x, Math.min(b.max.x, u.x)), my = Math.max(b.min.y, Math.min(b.max.y, u.y));
    // the floor at its foot: its base (on a route: the route's floor near there, unless it stands on it)
    let mz = b.min.z, bd = 4;
    if (nav) for (const p of nav.route.points) { const d = Math.hypot(p[0] - mx, p[1] - my); if (d < bd) { bd = d; if (Math.abs(p[2] - b.min.z) > 0.6) mz = p[2]; else mz = b.min.z; } }
    const M = new THREE.Vector3(mx, my, mz), R = hitPos.clone();
    const prev = cal[cal.length - 1];
    let turnedNow = false;
    if (prev && Math.hypot(M.x - prev.M.x, M.y - prev.M.y) > 2 && Math.hypot(R.x - prev.R.x, R.z - prev.R.z) > 1.5) {
      yaw = angle(R.x - prev.R.x, R.z - prev.R.z) - Math.atan2(M.x - prev.M.x, -(M.y - prev.M.y));
      turnedNow = true;
    }
    cal.push({ M, R });
    if (cal.length > 2) cal.shift();
    zoom = null; tween = null; turned = true;
    realAnchor.copy(M);
    pos.copy(R);
    align = turnedNow || align === "full" ? "full" : "pos";
    finder.last = Infinity;
    hint.textContent = turnedNow ? `Posição e direção acertadas em ${navCal.name}.`
      : `Posição acertada em ${navCal.name}. Para acertar também a direção, faça o mesmo num equipamento a alguns metros dali.`;
    navCal = null;
  }
  // each frame: where you are along the route, where to go, the next step
  function navFrame(cam, t) {
    const P = nav.route.points, cum = nav.cum, L = cum[cum.length - 1];
    const u = userInModel();
    // the nearest point of the route (in plan, on about the same floor)
    let best = Infinity, bs = 0, off = Infinity, q = null;
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      const k = l2 > 1e-9 ? Math.max(0, Math.min(1, ((u.x - a[0]) * dx + (u.y - a[1]) * dy) / l2)) : 0;
      const qx = a[0] + dx * k, qy = a[1] + dy * k, qz = a[2] + (b[2] - a[2]) * k;
      const plan = Math.hypot(u.x - qx, u.y - qy);
      const d = plan + 1.5 * Math.max(0, Math.abs(qz - u.feet) - 0.8) + 0.05 * Math.abs(cum[i - 1] + (cum[i] - cum[i - 1]) * k - nav.s);
      if (d < best) { best = d; bs = cum[i - 1] + (cum[i] - cum[i - 1]) * k; off = plan; q = [qx, qy, qz]; }
    }
    nav.s = bs;
    const lost = off > 3;
    const target = lost ? q : along(nav.route, Math.min(L, bs + NAV_AHEAD)).p;
    _t.set(target[0], target[1], target[2]).applyMatrix4(modelMatrix());
    const e = cam.matrix.elements, fx = -e[8], fz = -e[10], fl = Math.hypot(fx, fz) || 1;
    const dx = _t.x - camPos.x, dz = _t.z - camPos.z;
    const rel = Math.atan2((-fz * dx + fx * dz) / fl, (fx * dx + fz * dz) / fl);
    // the 3D arrow: a little in front of you, under the eyes, pointing there
    navArrow.position.set(camPos.x + fx / fl * 1.1, camPos.y - 0.55, camPos.z + fz / fl * 1.1);
    navArrow.rotation.set(0, Math.atan2(-dx, -dz), 0);
    navArrow.visible = !navCal;
    if (t - nav.shownAt < 150) return; // the text a few times a second
    nav.shownAt = t;
    $("#arNavArrow").style.transform = `rotate(${rel.toFixed(3)}rad)`;
    const left = Math.max(0, L - bs), box = $("#arNav");
    const arrived = left < 1.2 && off < 2;
    box.classList.toggle("off", lost);
    box.classList.toggle("arrived", arrived);
    let text, dist;
    if (arrived) {
      text = nav.steps[nav.steps.length - 1]?.text || "Chegou.";
      dist = "";
      if (!nav.done) { nav.done = true; if (nav.to && nav.to.kind === "item") app.flashNodes(nav.to.nodes, 6000); }
    } else if (lost) {
      text = "Fora do caminho: siga a seta até a faixa azul";
      dist = `a ${Math.round(off)} m · ou “Acertar posição” se a faixa estiver no lugar errado`;
    } else {
      const next = nav.steps.find((st) => st.dist > bs + 0.4) || nav.steps[nav.steps.length - 1];
      text = next.text;
      const up = target[2] - u.feet;
      dist = `em ${Math.max(0, Math.round(next.dist - bs))} m · faltam ${Math.round(left)} m` + (up > 0.8 ? " · suba" : up < -0.8 ? " · desça" : "");
    }
    if ($("#arNavText").textContent !== text) $("#arNavText").textContent = text;
    if ($("#arNavDist").textContent !== dist) $("#arNavDist").textContent = dist;
  }

  // ------------------------------------------------------------ finding the item at real size
  // The card at the top (shared with the route), its buttons, and the layout: with a card the AR's
  // bar goes to the bottom and the thumb stick goes away (you walk for real).
  function syncGuide() {
    const finding = !!session && !!focus && real();
    const show = finding || !!nav;
    $("#arNav").hidden = !show;
    $("#arNav").classList.toggle("find", finding);
    ui.classList.toggle("guide", show && !!session);
    $("#arNavNear").hidden = !finding;
    $("#arNavNear").textContent = near ? "Voltar ao lugar" : "Ver de perto";
    $("#arNavModel").textContent = modelHidden ? "Mostrar modelo" : finding ? "Só o item" : "Ocultar modelo";
    if (!show) $("#arNav").classList.remove("arrived", "off");
    if (finding && near) {
      $("#arNavText").textContent = focus.name;
      $("#arNavDist").textContent = "de perto, na sua frente · “Voltar ao lugar” para a seta";
      $("#arNavArrow").style.transform = "";
    } else if (finding) finder.shownAt = 0; // the next frame writes the card
  }
  $("#arNavNear").onclick = () => {
    if (!focus || !real()) return;
    if (near) { backFromNear(true); return; }
    near = { pos: pos.clone() };
    const it = focus.items[finder.index] || focus.items[0];
    zoomTo(it ? new THREE.Box3(new THREE.Vector3(...it.box.slice(0, 3)), new THREE.Vector3(...it.box.slice(3))) : focus.box);
    syncGuide();
  };
  // the model back on the real place (smoothly, or at once)
  function backFromNear(smooth) {
    if (!near) return;
    const back = near.pos;
    near = null;
    if (smooth && zoom) {
      // where the zoomed point goes when the model is back: the same matrix as before "Ver de perto"
      const z = zoom, p = pos.clone();
      zoom = null; pos.copy(back);
      const p1 = z.anchor.clone().applyMatrix4(modelMatrix());
      zoom = z; pos.copy(p);
      tween = { t0: null, dur: 700, p0: p, p1, s0: scale, s1: scale, done: () => { zoom = null; pos.copy(back); } };
    } else {
      tween = null; zoom = null; pos.copy(back);
    }
    syncGuide();
  }

  // the item's box and a pin over it (room coordinates, drawn over everything: seen through walls)
  const findMarks = new THREE.Group();
  const findBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: 0xff8c00, depthTest: false, transparent: true, opacity: 0.95 }));
  findBox.matrixAutoUpdate = false;
  findBox.renderOrder = 19;
  const pin = new THREE.Group();
  {
    const mat = new THREE.MeshBasicMaterial({ color: 0xff8c00, depthTest: false, transparent: true, opacity: 0.95 });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.32, 20).rotateX(Math.PI), mat); // points down
    cone.position.y = 0.16;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.7, 8), mat);
    stem.position.y = 0.67;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), mat);
    head.position.y = 1.05;
    for (const m of [cone, stem, head]) { m.renderOrder = 19; pin.add(m); }
  }
  findMarks.add(findBox, pin);
  findMarks.visible = false;
  marks.add(findMarks);
  const _h = new THREE.Vector3(), _bc = new THREE.Vector3(), _bs = new THREE.Vector3(), _bm = new THREE.Matrix4();
  const buzz = (p) => { try { navigator.vibrate?.(p); } catch { /* no vibration */ } };
  function findFrame(cam, t) {
    const u = userInModel();
    // the way the phone points, in the model's plan
    const e = cam.matrix.elements;
    _h.set(camPos.x - e[8], camPos.y, camPos.z - e[10]).applyMatrix4(_inv);
    const info = findInfo(u, [_h.x - u.x, _h.y - u.y], focus.boxes);
    if (!info) { navArrow.visible = false; return; }
    const it = focus.items[info.index], b = it.box, mm = modelMatrix();
    // the box and the pin, bigger when far so that it is still seen
    _bc.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    _bs.set(Math.max(0.05, b[3] - b[0]), Math.max(0.05, b[4] - b[1]), Math.max(0.05, b[5] - b[2]));
    findBox.matrix.copy(mm).multiply(_bm.makeTranslation(_bc.x, _bc.y, _bc.z)).multiply(T.makeScale(_bs.x, _bs.y, _bs.z));
    _t.set(_bc.x, _bc.y, b[5]).applyMatrix4(mm);
    const far = _t.distanceTo(camPos);
    pin.position.set(_t.x, _t.y + 0.05 + 0.06 * Math.sin(t / 260), _t.z);
    pin.scale.setScalar(Math.max(0.6, Math.min(5, far / 5)));
    findMarks.visible = !navCal;
    // the 3D arrow in front of you, pointing to it
    _t.set(...info.target).applyMatrix4(mm);
    const fx = -e[8], fz = -e[10], fl = Math.hypot(fx, fz) || 1;
    navArrow.position.set(camPos.x + fx / fl * 1.1, camPos.y - 0.55, camPos.z + fz / fl * 1.1);
    navArrow.rotation.set(0, Math.atan2(-(_t.x - camPos.x), -(_t.z - camPos.z)), 0);
    navArrow.visible = !navCal && !info.arrived;
    // the card, a few times a second; a buzz when getting closer
    if (t - finder.shownAt < 150) return;
    finder.shownAt = t;
    if (info.index !== finder.index) { finder.index = info.index; finder.last = Infinity; finder.arrived = false; }
    const step = closerStep(finder.last, info.dist);
    if (step && finder.last !== Infinity) buzz(step <= 2 ? [60, 40, 60] : 50);
    finder.last = info.dist;
    if (info.arrived && !finder.arrived) { finder.arrived = true; buzz([120, 80, 120]); app.flashNodes([it.n], 6000); }
    else if (!info.arrived && info.dist > 2) finder.arrived = false;
    $("#arNavArrow").style.transform = info.arrived ? "" : `rotate(${info.rel.toFixed(3)}rad)`;
    const box = $("#arNav");
    box.classList.toggle("arrived", info.arrived);
    const name = app.tree.names[it.n];
    const text = info.arrived ? `Está aqui: ${name}` : focus.items.length > 1 ? `${focus.name} · o mais perto: ${name}` : name;
    const line = findLine(info) + (align === "none" && !info.arrived ? " · acerte a posição para a seta apontar certo" : "");
    if ($("#arNavText").textContent !== text) $("#arNavText").textContent = text;
    if ($("#arNavDist").textContent !== line) $("#arNavDist").textContent = line;
  }
}
