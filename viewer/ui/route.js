// Removal route: take an equipment out along a path and see where it hits. The path is a list of
// offsets of the equipment (points picked on the model — it goes there keeping its height, or with
// it — and "Subir" / "Descer"). The equipment is shown moving along it (the same per-part offsets
// as the assembly animation), and "Verificar a rota" checks it in small steps against the real
// geometry of the parts around (the geometry worker, with the equipment's mesh moved): the stretches
// where it hits and what it hits. What touches it where it stands (its base, the floor) is support,
// not an obstacle.
import * as THREE from "three";
import { $, el } from "./util.js";
import { geomClient } from "../lib/geomclient.js";

const TOUCH = 0.005; // metres: closer than this is a hit
const MAX_NEAR = 300; // parts checked per step, nearest first

export function initRoute(app) {
  const panel = $("#routePanel"), btn = $("#routeBtn"), hint = $("#rtHint"), result = $("#rtResult"), slider = $("#rtPos");
  const group = new THREE.Group();
  group.name = "route";
  app.helpers.add(group);
  const lineMat = new THREE.LineBasicMaterial({ color: 0x1c7ed6, depthTest: false, transparent: true });
  const hitMat = new THREE.LineBasicMaterial({ color: 0xe03131, depthTest: false, transparent: true });
  const dotMat = new THREE.MeshBasicMaterial({ color: 0x1c7ed6, depthTest: false, transparent: true });
  let item = null;   // {nodes, parts, name, box (Box3), ref (Vector3: base centre), key}
  let pts = [];      // offsets [x, y, z] of the equipment, the first one [0, 0, 0]
  let hits = [];     // [{from, to (metres along the path), parts: Set}]
  let t = 0, playing = 0, offsets = null;

  // ------------------------------------------------------------ the path
  const len = () => { let L = 0; for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]); return L; };
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  function at(s) { // offset at s metres along the path
    if (pts.length < 2) return pts[0] || [0, 0, 0];
    for (let i = 1; i < pts.length; i++) {
      const d = dist(pts[i - 1], pts[i]);
      if (s <= d || i === pts.length - 1) { const k = d ? Math.min(1, s / d) : 1; return pts[i - 1].map((v, j) => v + (pts[i][j] - v) * k); }
      s -= d;
    }
    return pts[pts.length - 1];
  }
  const fmtM = (m) => m.toFixed(2).replace(".", ",") + " m";

  // ------------------------------------------------------------ drawing
  function redraw() {
    for (const o of [...group.children]) { group.remove(o); o.geometry?.dispose(); }
    if (!item) { app.requestRender(); return; }
    const r = item.ref, P = pts.map((o) => new THREE.Vector3(r.x + o[0], r.y + o[1], r.z + o[2]));
    if (P.length > 1) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(P), lineMat); l.renderOrder = 12; group.add(l); }
    const size = item.box.getSize(new THREE.Vector3()).length();
    for (const p of P) { const m = new THREE.Mesh(new THREE.SphereGeometry(Math.max(0.02, size * 0.015), 12, 8), dotMat); m.position.copy(p); m.renderOrder = 12; group.add(m); }
    // where it hits: the equipment's box there, in red
    for (const h of hits) {
      const o = at(h.from), b = item.box.clone().translate(new THREE.Vector3(...o));
      const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(...b.getSize(new THREE.Vector3()).toArray())), hitMat);
      box.position.copy(b.getCenter(new THREE.Vector3()));
      box.renderOrder = 12;
      group.add(box);
    }
    app.requestRender();
  }
  // the equipment shown at s metres along the path
  function show(s) {
    if (!item) return;
    t = Math.max(0, Math.min(len(), s));
    if (!offsets) offsets = new Float32Array(app.nParts * 3);
    offsets.fill(0);
    const o = at(t);
    for (const p of item.parts) { offsets[p * 3] = o[0]; offsets[p * 3 + 1] = o[1]; offsets[p * 3 + 2] = o[2]; }
    app.setPartOffsets(offsets);
    const L = len();
    slider.value = L ? Math.round(t / L * 1000) : 0;
    $("#rtPosLbl").textContent = fmtM(t);
  }
  function sync() {
    const has = !!item, path = pts.length > 1;
    for (const id of ["#rtAdd", "#rtUp", "#rtDown"]) $(id).disabled = !has;
    for (const id of ["#rtUndo", "#rtClear", "#rtPlay", "#rtCheck"]) $(id).disabled = !path;
    slider.disabled = !path;
    $("#rtItemName").textContent = has ? `${item.name} · caminho de ${fmtM(len())}` : "";
  }
  function changed() { hits = []; result.innerHTML = ""; sync(); redraw(); show(len()); }

  // ------------------------------------------------------------ choosing the equipment and the points
  $("#rtItem").onclick = () => {
    if (!app.selNodes.size) { hint.textContent = "Selecione antes o equipamento a retirar (no modelo, na árvore ou na busca)."; return; }
    reset();
    const nodes = [...app.selNodes], parts = [];
    app.forParts(nodes, (p) => parts.push(p));
    const box = app.nodesBox(nodes);
    if (box.isEmpty()) return;
    item = { nodes, parts, box, name: nodes.length === 1 ? app.tree.names[nodes[0]] : `${nodes.length} itens`,
      ref: new THREE.Vector3((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, box.min.z), key: null };
    pts = [[0, 0, 0]];
    hint.textContent = "Agora marque o caminho: “Ponto no modelo…” e clique onde ele deve passar; Subir / Descer para içar.";
    changed();
  };
  $("#rtAdd").onclick = () => {
    const prev = app.tool;
    $("#rtAdd").classList.add("on");
    hint.textContent = "Clique no ponto do modelo para onde o equipamento vai.";
    app.tool = (info) => {
      app.tool = prev;
      $("#rtAdd").classList.remove("on");
      if (!info.point || !item) return;
      const last = pts[pts.length - 1], r = item.ref;
      pts.push([info.point[0] - r.x, info.point[1] - r.y, $("#rtZ").checked ? info.point[2] - r.z : last[2]]);
      hint.textContent = "Ponto acrescentado. Continue o caminho ou verifique a rota.";
      changed();
    };
  };
  const lift = (k) => { const last = pts[pts.length - 1]; pts.push([last[0], last[1], last[2] + k * +$("#rtStep").value]); changed(); };
  $("#rtUp").onclick = () => lift(1);
  $("#rtDown").onclick = () => lift(-1);
  $("#rtUndo").onclick = () => { if (pts.length > 1) pts.pop(); changed(); };
  $("#rtClear").onclick = () => { pts = [[0, 0, 0]]; changed(); };
  slider.oninput = () => { stop(); show(+slider.value / 1000 * len()); };
  $("#rtPlay").onclick = () => {
    if (playing) { stop(); return; }
    if (t >= len() - 1e-6) t = 0;
    let last = performance.now();
    const speed = Math.max(0.3, len() / 8); // the whole path in about 8 s
    $("#rtPlay").textContent = "❚❚";
    const step = (now) => {
      if (!playing) return;
      show(t + (now - last) / 1000 * speed);
      last = now;
      if (t >= len()) { stop(); return; }
      playing = requestAnimationFrame(step);
    };
    playing = requestAnimationFrame(step);
  };
  function stop() { if (playing) cancelAnimationFrame(playing); playing = 0; $("#rtPlay").textContent = "▶"; }

  // ------------------------------------------------------------ the check
  $("#rtCheck").onclick = async () => {
    if (!item || pts.length < 2) return;
    if (!app.canReadGeometry()) { hint.textContent = "A verificação precisa da geometria das peças (abra a pasta do modelo ou uma pasta convertida)."; return; }
    stop();
    app.geom = app.geom || geomClient(app);
    const g = app.geom;
    $("#rtCheck").disabled = true;
    try {
      hint.textContent = "Preparando…";
      item.key = await g.merged("route:" + item.parts.join(","), item.parts);
      if (!item.key) { hint.textContent = "Não foi possível ler a geometria do equipamento."; return; }
      const own = new Set(item.parts), B = app.partBoxes(), L = len();
      // steps: a quarter of its smallest side, between 2 cm and 25 cm
      const sz = item.box.getSize(new THREE.Vector3());
      const ds = Math.max(0.02, Math.min(0.25, Math.min(sz.x, sz.y, sz.z) / 4));
      const n = Math.max(1, Math.ceil(L / ds));
      // the parts its box sweeps over
      const swept = item.box.clone();
      for (let i = 0; i <= n; i++) swept.union(item.box.clone().translate(new THREE.Vector3(...at(i / n * L))));
      swept.expandByScalar(0.05);
      const cand = [];
      for (let p = 0; p < app.nParts; p++) {
        if (own.has(p) || !app.partVisible[p] || !app.isLoaded(p)) continue;
        const o = p * 6;
        if (B[o] > swept.max.x || B[o + 3] < swept.min.x || B[o + 1] > swept.max.y || B[o + 4] < swept.min.y || B[o + 2] > swept.max.z || B[o + 5] < swept.min.z) continue;
        cand.push(p);
      }
      // support: what touches it where it stands
      const support = new Set();
      for (const p of nearAt([0, 0, 0], cand, B)) {
        const k = await g.part(p);
        if (!k) continue;
        const r = await g.pair(item.key, k, TOUCH);
        if (r.crossings > 0 || r.d < TOUCH) support.add(p);
      }
      hits = [];
      let open = null, minD = Infinity, minP = -1;
      for (let i = 1; i <= n; i++) {
        const s = i / n * L, o = at(s);
        if (i % 4 === 0) { hint.textContent = `Verificando… ${Math.round(i / n * 100)}%`; show(s); await new Promise((r) => setTimeout(r)); }
        const here = new Set();
        for (const p of nearAt(o, cand, B)) {
          if (support.has(p)) continue;
          const k = await g.part(p);
          if (!k) continue;
          const r = await g.pairAt(item.key, k, o, 0.1);
          if (r.crossings > 0 || r.d < TOUCH) here.add(p);
          else if (r.d < minD) { minD = r.d; minP = p; }
        }
        if (here.size) {
          if (open) { open.to = s; for (const p of here) open.parts.add(p); }
          else hits.push(open = { from: s, to: s, parts: here });
        } else open = null;
      }
      report(support, minD, minP);
      redraw();
      show(hits.length ? hits[0].from : 0);
    } finally { $("#rtCheck").disabled = false; }
  };
  // candidate parts whose box meets the equipment's box moved by o (plus a margin), nearest first
  function nearAt(o, cand, B) {
    const b = item.box.clone().translate(new THREE.Vector3(...o)).expandByScalar(0.1), c = b.getCenter(new THREE.Vector3()), out = [];
    for (const p of cand) {
      const q = p * 6;
      if (B[q] > b.max.x || B[q + 3] < b.min.x || B[q + 1] > b.max.y || B[q + 4] < b.min.y || B[q + 2] > b.max.z || B[q + 5] < b.min.z) continue;
      out.push([p, ((B[q] + B[q + 3]) / 2 - c.x) ** 2 + ((B[q + 1] + B[q + 4]) / 2 - c.y) ** 2 + ((B[q + 2] + B[q + 5]) / 2 - c.z) ** 2]);
    }
    return out.sort((u, v) => u[1] - v[1]).slice(0, MAX_NEAR).map((x) => x[0]);
  }
  const name = (p) => app.tree.names[app.partNode[p]];
  function report(support, minD, minP) {
    result.innerHTML = "";
    if (!hits.length) {
      result.append(el("p.rtOk", { text: "Passa sem bater." + (minP >= 0 ? ` Folga mínima ${(minD * 1000).toFixed(0)} mm (${name(minP)}).` : "") }));
    } else {
      result.append(el("p.rtBad", { text: `Bate em ${hits.length} trecho${hits.length === 1 ? "" : "s"} do caminho:` }));
      hits.forEach((h, i) => {
        const parts = [...h.parts];
        result.append(el("button.rtHit", {
          title: "Mostrar o equipamento nesse ponto e selecionar as peças",
          onclick: () => { stop(); show(h.from); app.select(parts.map((p) => app.partNode[p]), "replace"); },
        }, el("b", { text: `${i + 1}. de ${fmtM(h.from)} a ${fmtM(h.to)}` }), el("span", { text: parts.slice(0, 3).map(name).join(", ") + (parts.length > 3 ? ` e mais ${parts.length - 3}` : "") })));
      });
    }
    if (support.size) result.append(el("p.hint", { text: `Apoios ignorados (encostam nele onde está): ${[...support].slice(0, 4).map(name).join(", ")}${support.size > 4 ? "…" : ""}` }));
    hint.textContent = hits.length ? "Toque num trecho para ver o equipamento ali." : "Rota livre.";
  }

  // ------------------------------------------------------------ panel
  function reset() {
    stop();
    item = null; pts = []; hits = []; result.innerHTML = "";
    if (offsets) { offsets = null; app.setPartOffsets(null); }
    sync(); redraw();
  }
  btn.onclick = () => { panel.hidden = !panel.hidden; };
  new MutationObserver(() => {
    btn.classList.toggle("on", !panel.hidden);
    group.visible = !panel.hidden;
    if (panel.hidden) { stop(); if (offsets) { offsets = null; app.setPartOffsets(null); } } // the equipment goes back to its place
    else if (item) show(t);
    app.requestRender();
  }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  app.on("model", reset);
  sync();
}
