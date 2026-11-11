// Mannequin: a 1.75 m person (1.60 / 1.90) standing, crouching or reaching up, put on a floor of the
// model with a click, to see whether there is room to get to an equipment and work on it.
// "Verificar contato" compares its shape with the parts around it (the geometry worker): the parts
// it touches, or the smallest clearance. Several can be placed; the panel acts on the last one.
// They are kept with the saved views.
import * as THREE from "three";
import { $ } from "./util.js";
import { geomClient } from "../lib/geomclient.js";

const LIMIT = 0.3; // metres: clearances above this are not worth reporting

// Joints in metres for a 1.75 m person: x forward, y left, z up. Each limb: [from, to, radius].
const POSES = {
  stand: {
    head: [0, 0, 1.63], headR: 0.105, torso: [[0, 0, 0.98], [0, 0, 1.38], 0.165],
    limbs: () => [-1, 1].flatMap((k) => [
      [[0, 0.19 * k, 1.42], [0, 0.22 * k, 1.14], 0.05], [[0, 0.22 * k, 1.14], [0.06, 0.22 * k, 0.88], 0.043],
      [[0, 0.1 * k, 0.92], [0.02, 0.11 * k, 0.5], 0.075], [[0.02, 0.11 * k, 0.5], [0, 0.11 * k, 0.08], 0.055],
      [[-0.03, 0.11 * k, 0.045], [0.16, 0.11 * k, 0.045], 0.045],
    ]),
  },
  crouch: {
    head: [0.16, 0, 1.13], headR: 0.105, torso: [[-0.1, 0, 0.6], [0.06, 0, 0.95], 0.165],
    limbs: () => [-1, 1].flatMap((k) => [
      [[0.05, 0.19 * k, 0.98], [0.25, 0.22 * k, 0.78], 0.05], [[0.25, 0.22 * k, 0.78], [0.5, 0.2 * k, 0.72], 0.043],
      [[-0.12, 0.11 * k, 0.55], [0.3, 0.13 * k, 0.55], 0.075], [[0.3, 0.13 * k, 0.55], [0.12, 0.13 * k, 0.08], 0.055],
      [[0.06, 0.13 * k, 0.045], [0.25, 0.13 * k, 0.045], 0.045],
    ]),
  },
  reach: {
    head: [0, 0, 1.63], headR: 0.105, torso: [[0, 0, 0.98], [0, 0, 1.38], 0.165],
    limbs: () => [-1, 1].flatMap((k) => [
      [[0, 0.19 * k, 1.44], [0.02, 0.21 * k, 1.74], 0.05], [[0.02, 0.21 * k, 1.74], [0.05, 0.19 * k, 2.02], 0.043],
      [[0, 0.1 * k, 0.92], [0.02, 0.11 * k, 0.5], 0.075], [[0.02, 0.11 * k, 0.5], [0, 0.11 * k, 0.08], 0.055],
      [[-0.03, 0.11 * k, 0.045], [0.16, 0.11 * k, 0.045], 0.045],
    ]),
  },
};
const POSE_NAMES = { stand: "em pé", crouch: "agachado", reach: "alcance" };

export function initMannequin(app) {
  const panel = $("#manPanel"), btn = $("#manBtn"), hint = $("#manHint");
  const root = new THREE.Group();
  root.name = "mannequins";
  app.helpers.add(root);
  // the model's own shader needs no light; the mannequin's material does
  app.helpers.add(new THREE.HemisphereLight(0xffffff, 0x666655, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(0.4, -0.6, 1);
  app.helpers.add(sun);
  const material = new THREE.MeshLambertMaterial({ color: 0xf59f00 });
  const touchMat = new THREE.MeshLambertMaterial({ color: 0xe03131 });
  let list = []; // {p: [x, y, z] (feet), yaw (radians, 0 = facing +x), h (m), pose, obj, touching}
  let touched = [];

  // ------------------------------------------------------------ the body
  const UP = new THREE.Vector3(0, 1, 0);
  function capsule(a, b, r) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), len = A.distanceTo(B);
    const g = new THREE.CapsuleGeometry(r, Math.max(1e-3, len), 4, 10);
    const m = new THREE.Mesh(g, material);
    m.position.copy(A).add(B).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(UP, B.clone().sub(A).normalize());
    return m;
  }
  function build(it) {
    const P = POSES[it.pose] || POSES.stand, s = it.h / 1.75, body = new THREE.Group();
    const head = new THREE.Mesh(new THREE.SphereGeometry(P.headR, 16, 12), material);
    head.position.set(...P.head);
    body.add(head, capsule(...P.torso));
    for (const l of P.limbs()) body.add(capsule(...l));
    body.scale.setScalar(s);
    const g = new THREE.Group();
    g.add(body);
    g.position.set(...it.p);
    g.rotation.z = it.yaw;
    g.renderOrder = 0;
    return g;
  }
  function refresh() {
    for (const it of list) if (it.obj) { root.remove(it.obj); it.obj.traverse((o) => o.geometry && o.geometry.dispose()); }
    for (const it of list) { it.obj = build(it); paint(it); root.add(it.obj); }
    const cur = list[list.length - 1];
    $("#manRemove").disabled = !cur;
    for (const id of ["#manLeft", "#manRight", "#manCheck"]) $(id).disabled = !cur;
    if (cur) { $("#manHeight").value = cur.h.toFixed(2); $("#manPose").value = cur.pose; }
    app.requestRender();
  }
  const paint = (it) => it.obj && it.obj.traverse((o) => { if (o.isMesh) o.material = it.touching ? touchMat : material; });
  // The body as one triangle mesh in model coordinates (for the contact check).
  function worldMesh(it) {
    it.obj.updateMatrixWorld(true);
    const pos = [], idx = [];
    it.obj.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.index ? o.geometry : null, P = o.geometry.attributes.position, v = new THREE.Vector3(), base = pos.length / 3;
      for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i).applyMatrix4(o.matrixWorld); pos.push(v.x, v.y, v.z); }
      if (g) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
      else for (let i = 0; i < P.count; i++) idx.push(base + i);
    });
    return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
  }

  // ------------------------------------------------------------ placing
  $("#manPlace").onclick = () => {
    const prev = app.tool;
    hint.textContent = "Clique no piso onde o manequim fica em pé.";
    $("#manPlace").classList.add("on");
    app.tool = (info) => {
      app.tool = prev;
      $("#manPlace").classList.remove("on");
      if (!info.point) { hint.textContent = "Nenhuma peça nesse ponto: clique num piso."; return; }
      const c = app.getCamera();
      const yaw = Math.atan2(c.pos[1] - info.point[1], c.pos[0] - info.point[0]); // facing the camera
      list.push({ p: info.point, yaw, h: +$("#manHeight").value, pose: $("#manPose").value, touching: false });
      refresh();
      hint.textContent = "Manequim posto. Gire, mude a postura ou verifique o contato com as peças em volta.";
    };
  };
  const cur = () => list[list.length - 1];
  $("#manRemove").onclick = () => { const it = list.pop(); if (it && it.obj) root.remove(it.obj); touched = []; $("#manSelect").disabled = true; refresh(); hint.textContent = ""; };
  $("#manLeft").onclick = () => { const it = cur(); if (it) { it.yaw += Math.PI / 12; it.touching = false; refresh(); } };
  $("#manRight").onclick = () => { const it = cur(); if (it) { it.yaw -= Math.PI / 12; it.touching = false; refresh(); } };
  $("#manHeight").onchange = () => { const it = cur(); if (it) { it.h = +$("#manHeight").value; it.touching = false; refresh(); } };
  $("#manPose").onchange = () => { const it = cur(); if (it) { it.pose = $("#manPose").value; it.touching = false; refresh(); } };

  // ------------------------------------------------------------ contact with the parts around it
  $("#manCheck").onclick = async () => {
    const it = cur();
    if (!it) return;
    if (!app.canReadGeometry()) { hint.textContent = "A verificação precisa da geometria das peças (abra a pasta do modelo ou uma pasta convertida)."; return; }
    app.geom = app.geom || geomClient(app);
    hint.textContent = "Verificando…";
    // the floor it stands on is no obstacle: the body is checked 1 cm up, and what does not rise
    // above the soles is left out
    const mesh = worldMesh(it);
    for (let i = 2; i < mesh.pos.length; i += 3) mesh.pos[i] += 0.01;
    const key = app.geom.custom("mannequin", mesh), sole = it.p[2] + 0.03;
    const box = new THREE.Box3().setFromBufferAttribute(new THREE.BufferAttribute(mesh.pos, 3)).expandByScalar(LIMIT);
    const B = app.partBoxes(), near = [];
    for (let p = 0; p < app.nParts; p++) {
      if (!app.partVisible[p] || !app.isLoaded(p)) continue;
      const o = p * 6;
      if (B[o + 5] <= sole) continue;
      if (B[o] > box.max.x || B[o + 3] < box.min.x || B[o + 1] > box.max.y || B[o + 4] < box.min.y || B[o + 2] > box.max.z || B[o + 5] < box.min.z) continue;
      near.push(p);
    }
    touched = [];
    let best = { d: Infinity, p: -1 };
    for (const p of near.slice(0, 400)) {
      const k = await app.geom.part(p);
      if (!k) continue;
      const r = await app.geom.pair(key, k, LIMIT);
      if (r.crossings > 0 || r.d < 0.003) touched.push(p);
      else if (r.d < best.d) best = { d: r.d, p };
    }
    it.touching = touched.length > 0;
    paint(it);
    app.requestRender();
    const name = (p) => app.tree.names[app.partNode[p]];
    $("#manSelect").disabled = !touched.length;
    hint.textContent = touched.length
      ? `Encosta em ${touched.length} peça${touched.length === 1 ? "" : "s"}: ${touched.slice(0, 4).map(name).join(", ")}${touched.length > 4 ? "…" : ""}`
      : best.p >= 0 ? `Sem contato. Folga mínima ${(best.d * 1000).toFixed(0)} mm até ${name(best.p)}.`
        : `Sem contato: nada a menos de ${LIMIT * 1000} mm.`;
    if (near.length > 400) hint.textContent += " (verificadas as 400 peças mais próximas)";
  };
  $("#manSelect").onclick = () => { if (touched.length) app.select(touched.map((p) => app.partNode[p]), "replace"); };

  // ------------------------------------------------------------ panel, views
  btn.onclick = () => { panel.hidden = !panel.hidden; };
  new MutationObserver(() => btn.classList.toggle("on", !panel.hidden)).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  app.on("model", () => { for (const it of list) if (it.obj) root.remove(it.obj); list = []; refresh(); });
  app.getMannequins = () => list.map(({ p, yaw, h, pose }) => ({ p, yaw, h, pose }));
  app.setMannequins = (m) => {
    for (const it of list) if (it.obj) root.remove(it.obj);
    list = Array.isArray(m) ? m.map((x) => ({ ...x, touching: false })) : [];
    refresh();
  };
  app.mannequinPoseName = (k) => POSE_NAMES[k] || k;
  refresh();
}
