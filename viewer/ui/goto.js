// "Ir até…": say where you are (an equipment, the walk mode's spot, or a point tapped on the model)
// and where you want to go; the route is drawn on the floors of the model, with the distance, the
// steps told in words, the route on the walk mode's map and "Seguir" (the walk mode walks it).
// The augmented reality uses the same route at real size (ui/ar.js, app.navRoute).
//
// The routes run on the walking map (lib/navgrid.js), computed the first time from the model
// itself and kept on the device. The "Mapa de caminhada" part of the panel shows it on the model
// (green where one can walk), tells what was found (decks, ladders) and has the settings: name
// patterns of ladders and of parts to leave out (doors, hatches), links drawn by hand, forbidden
// areas, and the sizes (free height, step, body).
import * as THREE from "three";
import { $, el } from "./util.js";
import { itemPicker } from "./picker.js";
import { navClient, NAV_DEFAULTS } from "../lib/navclient.js";
import { along } from "../lib/navpath.js";

const WALK_SPEED = 1.3; // m/s when following the route
const EYE = 1.6;
const fmtM = (m) => (m < 10 ? m.toFixed(1).replace(".", ",") : Math.round(m).toLocaleString("pt-BR")) + " m";
const fmtA = (a) => Math.round(a).toLocaleString("pt-BR") + " m²";
// the thin bar at the top (and on the phone) shows the progress
function progress(f) { const b = $("#bar > div"); if (b) b.style.width = (f >= 1 ? 0 : Math.max(1, f * 100)) + "%"; }
const fmtT = (s) => (s < 60 ? Math.max(5, Math.round(s / 5) * 5) + " s" : Math.round(s / 60) + " min");

export function initGoto(app) {
  const panel = $("#gotoPanel"), btn = $("#gotoBtn"), hint = $("#goHint"), result = $("#goResult");
  const nav = navClient(app);
  app.nav = nav;
  const group = new THREE.Group();
  group.name = "goto";
  app.helpers.add(group);
  const mapGroup = new THREE.Group();
  mapGroup.name = "navmap";
  app.helpers.add(mapGroup);

  let from = null, to = null; // {kind: "item", nodes, name, box} | {kind: "point", p, name, eye}
  let current = null;         // {route, steps, from, to}
  let following = 0;          // requestAnimationFrame id while "Seguir" runs
  let computing = null;       // AbortController while the map is computed
  let inAR = false;           // the augmented reality is walking the route: keep it drawn
  const say = (t) => { hint.textContent = t; };

  // ------------------------------------------------------------ choosing the two ends
  const pickBox = $("#goPick"), q = $("#goQ"), list = $("#goList");
  let picking = null; // "from" | "to"
  const picker = itemPicker(app, {
    list, input: q,
    onPick: (nodes, name) => set(picking, { kind: "item", nodes, name, box: boxOf(nodes) }),
    extra: () => {
      const rows = [];
      const w = app.whereWalk && app.whereWalk();
      if (picking === "from" && w) rows.push({ label: "Onde estou na caminhada", sub: "o ponto em que a caminhada está (ou parou)", onClick: () => set("from", { kind: "point", p: w.point.toArray(), name: "onde estou na caminhada", yaw: w.yaw }) });
      rows.push({ label: "Tocar no modelo…", sub: "escolher um ponto ou uma peça tocando nela", onClick: () => tapOnModel(picking) });
      return rows;
    },
  });
  function boxOf(nodes) {
    const b = app.nodesBox(nodes);
    return b.isEmpty() ? null : [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
  }
  function openPick(which) {
    picking = which;
    pickBox.hidden = false;
    $("#goPickTitle").textContent = which === "from" ? "Estou em…" : "Quero ir para…";
    picker.reset();
    picker.show();
  }
  function closePick() { pickBox.hidden = true; picking = null; q.blur(); }
  $("#goQClose").onclick = closePick;
  $("#goFrom").onclick = () => openPick("from");
  $("#goTo").onclick = () => openPick("to");
  function tapOnModel(which) {
    closePick();
    const prev = app.tool;
    say("Toque no modelo: numa peça (ela vira o " + (which === "from" ? "ponto de partida" : "destino") + ") ou num piso.");
    app.tool = (info) => {
      app.tool = prev;
      if (!info.point) { say("Nada foi tocado. Tente de novo."); return; }
      // a floor (a surface facing up, under the eyes) is a point; anything else is the part
      const n = info.node;
      const big = n >= 0 ? app.nodesBox([n]) : null;
      const flat = big && big.max.z - big.min.z < 0.3 && (big.max.x - big.min.x > 2 || big.max.y - big.min.y > 2);
      if (n >= 0 && !flat) set(which, { kind: "item", nodes: [n], name: app.tree.names[n], box: boxOf([n]) });
      else set(which, { kind: "point", p: info.point, name: "ponto tocado" });
    };
  }
  function set(which, end) {
    closePick();
    if (which === "from") from = end; else to = end;
    clearRoute();
    sync();
    if (from && to) run();
  }
  function sync() {
    const label = (e) => (e ? e.name : "Escolher…");
    $("#goFrom").textContent = label(from);
    $("#goTo").textContent = label(to);
    $("#goFrom").classList.toggle("set", !!from);
    $("#goTo").classList.toggle("set", !!to);
    $("#goSwap").disabled = !(from || to);
    $("#goRun").disabled = !(from && to);
    $("#goActions").hidden = !current;
  }
  $("#goSwap").onclick = () => { [from, to] = [to, from]; clearRoute(); sync(); if (from && to) run(); };
  $("#goRun").onclick = () => run();

  // ------------------------------------------------------------ the walking map
  async function ensureMap(force = false) {
    if (nav.ready && !force) return true;
    if (computing) return false;
    computing = new AbortController();
    $("#goCompute").textContent = "Cancelar";
    try {
      const r = await nav.compute({ force, signal: computing.signal, onProgress: (f, t) => { say(t); progress(f); } });
      showMap(r);
      return true;
    } catch (e) {
      if (e.name === "AbortError") say("Cálculo do mapa cancelado.");
      else { say("Não foi possível calcular o mapa de caminhada: " + (e.message || e)); console.error(e); }
      return false;
    } finally {
      computing = null;
      progress(1);
      $("#goCompute").textContent = "Calcular de novo";
    }
  }
  $("#goCompute").onclick = () => { if (computing) computing.abort(); else ensureMap(true); };
  function showMap(r) {
    const s = r.summary;
    const lines = [];
    lines.push(`Piso livre: ${fmtA(s.area)}` + (s.decks.length ? ` em ${s.decks.length} ${s.decks.length === 1 ? "nível" : "níveis"} (${s.decks.map((d) => fmtM(d.z)).join(", ")})` : ""));
    const lad = s.ladders.filter((l) => l.links > 0);
    lines.push(`Escadas pelo nome: ${s.ladders.length} encontrada${s.ladders.length === 1 ? "" : "s"}, ${lad.length} ligando níveis` + (s.manual.length ? ` · ${s.manual.filter(Boolean).length} de ${s.manual.length} ligações à mão` : ""));
    if (s.areas > 1) lines.push(`Áreas separadas: ${s.areas} (a principal com ${fmtA(s.mainArea)}; em roxo no mapa as outras)`);
    if (s.flipped) lines.push("As faces do modelo parecem invertidas: o mapa foi feito considerando isso.");
    $("#goMapInfo").textContent = lines.join("\n");
    drawMap(r.drawing);
    say(current ? hint.textContent : "Mapa de caminhada pronto.");
  }
  // the map on the model: a dot per floor cell (green free, yellow next to an edge, red forbidden,
  // purple cut off from the main area) and the links between decks in orange
  function drawMap(d) {
    for (const o of [...mapGroup.children]) { mapGroup.remove(o); o.geometry?.dispose(); o.material?.dispose(); }
    if (!d) return;
    const n = d.state.length, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const C = [[0.2, 0.75, 0.35], [0.95, 0.75, 0.15], [0.9, 0.2, 0.2], [0.6, 0.3, 0.85]];
    for (let i = 0; i < n; i++) {
      pos[i * 3] = d.pos[i * 3]; pos[i * 3 + 1] = d.pos[i * 3 + 1]; pos[i * 3 + 2] = d.pos[i * 3 + 2] + 0.03;
      const c = C[d.state[i]] || C[0];
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: nav.last.summary.grid.cell * 0.8, vertexColors: true, sizeAttenuation: true, transparent: true, opacity: 0.85 }));
    pts.renderOrder = 10;
    mapGroup.add(pts);
    if (d.conns.length) {
      const lp = [];
      for (const c of d.conns) lp.push(c.a[0], c.a[1], c.a[2] + 0.05, c.b[0], c.b[1], c.b[2] + 0.05);
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(lp), 3));
      const l = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xff7a00, depthTest: false }));
      l.renderOrder = 11;
      mapGroup.add(l);
    }
    mapGroup.visible = $("#goShowMap").checked && !panel.hidden;
    app.requestRender();
  }
  $("#goShowMap").onchange = async () => {
    if ($("#goShowMap").checked && !nav.ready) await ensureMap();
    mapGroup.visible = $("#goShowMap").checked;
    app.requestRender();
  };
  $("#goCopyDiag").onclick = async () => {
    if (!nav.ready) { say("Calcule o mapa antes."); return; }
    const s = nav.last.summary, st = nav.settings();
    const text = [
      `Mapa de caminhada — ${app.title}`,
      `grade ${s.grid.W} × ${s.grid.H} células de ${st.cell} m; fatias a cada ${st.dz} m; folga ${st.head} m; degrau ${st.step} m; raio ${st.radius} m`,
      `piso livre ${fmtA(s.area)} · junto de bordas ${fmtA(s.edgeArea)} · proibido ${fmtA(s.forbiddenArea)} · faces invertidas: ${s.flipped ? "sim" : "não"}`,
      `níveis: ${s.decks.map((d) => `${fmtM(d.z)} (${fmtA(d.area)})`).join(", ") || "nenhum"}`,
      `áreas: ${s.areas} (principal ${fmtA(s.mainArea)}, ${s.smallAreas} pequenas)`,
      `escadas pelo nome (${st.ladders}): ${s.ladders.map((l) => `${l.label} [${l.links}]`).join("; ") || "nenhuma"}`,
      `ignorados (${st.ignore}): ${nav.matching(nav.pattern(st.ignore)).map((n) => app.tree.names[n]).slice(0, 30).join("; ") || "nenhum"}`,
      `ligações à mão: ${s.manual.length}, ligadas: ${s.manual.filter(Boolean).length}`,
    ].join("\n");
    try { await navigator.clipboard.writeText(text); say("Diagnóstico copiado (só números e nomes, sem a geometria)."); }
    catch { $("#goMapInfo").textContent = text; say("Não foi possível copiar: o diagnóstico está no quadro acima."); }
  };

  // settings
  const S = [["goCell", "cell"], ["goHead", "head"], ["goStep", "step"], ["goRadius", "radius"]];
  function loadSettings() {
    const s = nav.settings();
    for (const [id, k] of S) $("#" + id).value = String(s[k]).replace(".", ",");
    $("#goLadders").value = s.ladders;
    $("#goIgnore").value = s.ignore;
    $("#goInside").checked = s.useInside;
  }
  const num = (v) => parseFloat(String(v).replace(",", "."));
  async function settingsChanged(redo) {
    const patch = {};
    for (const [id, k] of S) { const v = num($("#" + id).value); if (v > 0) patch[k] = v; }
    patch.ladders = $("#goLadders").value.trim();
    patch.ignore = $("#goIgnore").value.trim();
    patch.useInside = $("#goInside").checked;
    if (patch.ladders && !nav.pattern(patch.ladders)) { say("O padrão das escadas não é válido."); return; }
    if (patch.ignore && !nav.pattern(patch.ignore)) { say("O padrão das peças ignoradas não é válido."); return; }
    nav.setSettings(patch);
    if (!nav.ready) return;
    clearRoute();
    if (redo === "slices") { await ensureMap(false); }
    else if (redo === "build") { say("Refazendo o mapa…"); showMap(await nav.build()); }
    else { showMap(await nav.refreshExtras()); }
  }
  for (const [id, k] of S) $("#" + id).onchange = () => settingsChanged(k === "cell" ? "slices" : "build");
  $("#goLadders").onchange = () => settingsChanged("extras");
  $("#goIgnore").onchange = () => settingsChanged("slices");
  $("#goInside").onchange = () => settingsChanged("slices");
  $("#goDefaults").onclick = () => { nav.setSettings({ ...NAV_DEFAULTS }); loadSettings(); settingsChanged("slices"); };

  // links drawn by hand and forbidden areas (kept per model)
  function pickPoints(n, text, done) {
    const prev = app.tool, pts = [];
    say(text[0]);
    app.tool = (info) => {
      if (!info.point) { say("Toque numa superfície do modelo."); return; }
      pts.push(info.point);
      if (pts.length < n) { say(text[pts.length]); return; }
      app.tool = prev;
      done(pts);
    };
  }
  $("#goLink").onclick = async () => {
    if (!(await ensureMap())) return;
    pickPoints(2, ["Ligar dois pontos: toque no piso de um lado (por exemplo, ao pé de uma escada sem nome).", "Agora toque no piso do outro lado."], async (p) => {
      const e = nav.extrasOf();
      e.manual.push({ a: p[0], b: p[1], label: "ligação " + (e.manual.length + 1) });
      nav.setExtrasOf(e);
      const r = await nav.refreshExtras();
      showMap(r);
      say(r.summary.manual[r.summary.manual.length - 1] ? "Ligação feita." : "Não há piso livre perto de um dos pontos: a ligação não vale.");
      syncExtras();
    });
  };
  $("#goBlock").onclick = async () => {
    if (!(await ensureMap())) return;
    pickPoints(2, ["Bloquear área: toque num canto da área (no piso).", "Agora toque no canto oposto."], async (p) => {
      const e = nav.extrasOf(), [a, b] = p;
      e.blocks.push([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]) - 0.3, Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]) + 0.3]);
      nav.setExtrasOf(e);
      showMap(await nav.refreshExtras());
      say("Área bloqueada: as rotas não passam por ela.");
      syncExtras();
    });
  };
  $("#goUndoExtra").onclick = async () => {
    const e = nav.extrasOf();
    const last = [...e.manual.map((m) => ["manual", m]), ...e.blocks.map((b) => ["blocks", b])].pop();
    if (!last) return;
    if (last[0] === "blocks") e.blocks.pop(); else e.manual.pop();
    nav.setExtrasOf(e);
    if (nav.ready) showMap(await nav.refreshExtras());
    syncExtras();
  };
  function syncExtras() {
    const e = nav.extrasOf(), k = e.manual.length + e.blocks.length;
    $("#goUndoExtra").disabled = !k;
    $("#goExtrasInfo").textContent = k ? `${e.manual.length} ligação(ões) à mão · ${e.blocks.length} área(s) bloqueada(s)` : "";
  }

  // ------------------------------------------------------------ the route
  const endOf = (e) => (e.kind === "item" ? { box: e.box } : { point: e.p, eye: false });
  async function run() {
    if (!from || !to) return;
    if (from.kind === "item" && !from.box) { say("A partida não tem geometria carregada."); return; }
    if (to.kind === "item" && !to.box) { say("O destino não tem geometria carregada."); return; }
    if (!(await ensureMap())) return;
    say("Procurando o caminho…");
    const goal = to.kind === "item"
      ? { name: to.name, center: [(to.box[0] + to.box[3]) / 2, (to.box[1] + to.box[4]) / 2, (to.box[2] + to.box[5]) / 2], base: to.box[2], top: to.box[5] }
      : { name: to.name };
    const r = await nav.route(endOf(from), endOf(to), goal);
    if (r.error) { clearRoute(); say(r.message + (r.error === "apart" ? " Veja o mapa (Mapa de caminhada › Mostrar no modelo)." : "")); return; }
    current = { route: r.route, steps: r.steps, from, to };
    drawRoute();
    report();
    sync();
    if (to.kind === "item") app.flashNodes(to.nodes);
    frameRoute();
    app.emit("navRoute", current);
  }
  app.navRoute = () => current;
  app.navShowRoute = (on) => { inAR = on; group.visible = !panel.hidden || following > 0 || inAR; mapGroup.visible = !inAR && !panel.hidden && $("#goShowMap").checked; app.requestRender(); };
  function clearRoute() {
    stopFollow();
    current = null;
    for (const o of [...group.children]) { group.remove(o); o.geometry?.dispose(); }
    result.innerHTML = "";
    app.mapExtra = null;
    sync();
    app.requestRender();
    app.emit("navRoute", null);
  }
  $("#goClear").onclick = () => { clearRoute(); say(""); };

  const routeMat = new THREE.MeshBasicMaterial({ color: 0x1c7ed6, depthTest: true });
  const routeMatBehind = new THREE.MeshBasicMaterial({ color: 0x1c7ed6, depthTest: false, transparent: true, opacity: 0.35 });
  const arrowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: true });
  const startMat = new THREE.MeshBasicMaterial({ color: 0x2f9e44 }), endMat = new THREE.MeshBasicMaterial({ color: 0xe8590c });
  // the route as a flat band on the floor (vertical bits as a tube), arrows every 2 m
  function drawRoute() {
    for (const o of [...group.children]) { group.remove(o); o.geometry?.dispose(); }
    const P = simplify(current.route.points.map((p) => new THREE.Vector3(p[0], p[1], p[2] + 0.06)), 0.04);
    if (P.length < 2) return;
    const path = new THREE.CurvePath();
    for (let i = 1; i < P.length; i++) path.add(new THREE.LineCurve3(P[i - 1], P[i]));
    const tube = new THREE.TubeGeometry(path, Math.min(4000, P.length * 4), 0.07, 6, false);
    for (const [mat, order] of [[routeMatBehind, 12], [routeMat, 13]]) { const m = new THREE.Mesh(tube, mat); m.renderOrder = order; group.add(m); }
    // arrows (flat triangles pointing the way)
    const L = current.route.length, n = Math.max(1, Math.floor(L / 2));
    const tri = new THREE.ConeGeometry(0.16, 0.34, 3).rotateZ(-Math.PI / 2); // points to +x
    const arrows = new THREE.InstancedMesh(tri, arrowMat, n);
    const m = new THREE.Matrix4(), qn = new THREE.Quaternion(), e = new THREE.Euler();
    for (let k = 0; k < n; k++) {
      const a = along(current.route, (k + 0.5) * L / n);
      e.set(0, 0, Math.atan2(a.dir[1], a.dir[0]));
      m.compose(new THREE.Vector3(a.p[0], a.p[1], a.p[2] + 0.12), qn.setFromEuler(e), new THREE.Vector3(1, 1, 1));
      arrows.setMatrixAt(k, m);
    }
    arrows.renderOrder = 14;
    group.add(arrows);
    const pin = (p, mat) => { const s = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.05, 24).rotateX(Math.PI / 2), mat); s.position.set(p[0], p[1], p[2] + 0.05); s.renderOrder = 14; group.add(s); };
    pin(current.route.points[0], startMat);
    pin(current.route.points[current.route.points.length - 1], endMat);
    group.visible = !panel.hidden || following > 0 || inAR;
    // on the walk mode's map: the route of the deck one is on, darker elsewhere
    app.mapExtra = (g, px, W, H, z) => {
      const pts = current.route.points;
      g.lineWidth = Math.max(2, W / 70);
      g.lineJoin = "round";
      for (let i = 1; i < pts.length; i++) {
        const same = z == null || Math.abs(pts[i][2] + EYE - z) < 1.5;
        g.strokeStyle = same ? "rgba(28, 126, 214, .95)" : "rgba(28, 126, 214, .35)";
        const [x0, y0] = px(pts[i - 1][0], pts[i - 1][1]), [x1, y1] = px(pts[i][0], pts[i][1]);
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      }
      const [ex, ey] = px(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      g.fillStyle = "#e8590c"; g.beginPath(); g.arc(ex, ey, Math.max(3, W / 45), 0, Math.PI * 2); g.fill();
    };
    app.redrawMap?.();
    app.requestRender();
  }
  // fewer points: drop those in line with their neighbours (within tol)
  function simplify(P, tol) {
    if (P.length < 3) return P;
    const out = [P[0]];
    const ab = new THREE.Vector3(), ap = new THREE.Vector3();
    let a = 0;
    for (let i = 2; i < P.length; i++) {
      ab.subVectors(P[i], P[a]);
      const l2 = ab.lengthSq();
      let worst = 0;
      for (let k = a + 1; k < i; k++) {
        ap.subVectors(P[k], P[a]);
        const t = l2 ? Math.max(0, Math.min(1, ap.dot(ab) / l2)) : 0;
        worst = Math.max(worst, ap.addScaledVector(ab, -t).length());
        if (worst > tol) break;
      }
      if (worst > tol) { out.push(P[i - 1]); a = i - 1; }
    }
    out.push(P[P.length - 1]);
    return out;
  }
  function report() {
    result.innerHTML = "";
    const r = current.route;
    let climb = 0;
    for (let i = 1; i < r.points.length; i++) climb += Math.max(0, r.points[i][2] - r.points[i - 1][2]);
    const secs = r.length / WALK_SPEED + climb * 2;
    result.append(el("p.goSum", { text: `${fmtM(r.length)} · cerca de ${fmtT(secs)} a pé` + (climb > 1 ? ` · sobe ${fmtM(climb)}` : "") }));
    const ol = el("ol.goSteps");
    for (const s of current.steps) {
      ol.append(el("li", {}, el("button", {
        text: s.text, title: "Ver este trecho",
        onclick: () => frameRoute(s.at),
      })));
    }
    result.append(ol);
    say("Toque num passo para ver o trecho. “Seguir” percorre o caminho na caminhada.");
  }
  // look at the whole route (or around point i of it)
  function frameRoute(i = -1) {
    const P = current.route.points, b = new THREE.Box3();
    if (i < 0) for (const p of P) b.expandByPoint(new THREE.Vector3(...p));
    else {
      const c = new THREE.Vector3(...P[Math.min(P.length - 1, i)]);
      b.setFromCenterAndSize(c, new THREE.Vector3(6, 6, 3));
    }
    if (current.to.kind === "item" && i < 0) b.union(new THREE.Box3(new THREE.Vector3(...current.to.box.slice(0, 3)), new THREE.Vector3(...current.to.box.slice(3))));
    const cam = app.cameraFor ? app.cameraFor(b, [0.45, -0.6, 0.65]) : null;
    if (cam) app.setCamera(cam); else app.frameNodes([]);
  }

  // ------------------------------------------------------------ following the route in the walk mode
  function stopFollow() {
    if (following) cancelAnimationFrame(following);
    following = 0;
    $("#goFollow").textContent = "▶ Seguir";
  }
  $("#goFollow").onclick = () => {
    if (following) { stopFollow(); return; }
    if (!current) return;
    let s = 0, last = performance.now(), yaw = null;
    $("#goFollow").textContent = "❚❚ Parar";
    const L = current.route.length;
    const tick = (now) => {
      if (!following) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!app.walking() && s > 0) { stopFollow(); return; } // the walk mode was left
      s = Math.min(L, s + dt * WALK_SPEED * 2.5); // a little faster than walking
      const a = along(current.route, s), want = Math.atan2(a.dir[1], a.dir[0]);
      if (yaw === null) yaw = want;
      let d = want - yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      yaw += d * Math.min(1, dt * 4); // turn smoothly
      app.walkPose([a.p[0], a.p[1], a.p[2] + EYE], yaw);
      if (s >= L) {
        stopFollow();
        const end = current.steps[current.steps.length - 1];
        say(end ? end.text : "Chegou.");
        if (current.to.kind === "item") app.flashNodes(current.to.nodes);
        return;
      }
      following = requestAnimationFrame(tick);
    };
    following = requestAnimationFrame(tick);
  };

  // ------------------------------------------------------------ panel
  btn.onclick = () => { panel.hidden = !panel.hidden; };
  new MutationObserver(() => {
    btn.classList.toggle("on", !panel.hidden);
    group.visible = !panel.hidden || following > 0 || inAR;
    mapGroup.visible = !panel.hidden && $("#goShowMap").checked && !inAR;
    if (!panel.hidden) { loadSettings(); syncExtras(); if (!from && app.selNodes.size) { const nodes = [...app.selNodes]; from = { kind: "item", nodes, name: nodes.length === 1 ? app.tree.names[nodes[0]] : `${nodes.length} itens`, box: boxOf(nodes) }; sync(); } }
    else closePick();
    app.requestRender();
  }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  app.on("model", () => { from = to = null; clearRoute(); nav.reset(); drawMap(null); $("#goMapInfo").textContent = ""; sync(); });
  // after "Carregar mais" the map is no longer that of what is loaded
  app.on("loaded", () => { if (nav.ready) { nav.reset(); drawMap(null); $("#goMapInfo").textContent = "O que está carregado mudou: o mapa será calculado de novo."; } });
  // open "Ir até" with an end chosen (from the context menu of a part)
  app.gotoFrom = (nodes) => { panel.hidden = false; set("from", { kind: "item", nodes, name: nodes.length === 1 ? app.tree.names[nodes[0]] : `${nodes.length} itens`, box: boxOf(nodes) }); };
  app.gotoTo = (nodes) => { panel.hidden = false; set("to", { kind: "item", nodes, name: nodes.length === 1 ? app.tree.names[nodes[0]] : `${nodes.length} itens`, box: boxOf(nodes) }); };
  app.addContextItems?.((nodes) => [
    { label: "Ir até aqui…", title: "O caminho até esta peça (Ir até…)", onClick: () => app.gotoTo(nodes) },
    { label: "Estou aqui (Ir até…)", title: "O caminho a partir desta peça", onClick: () => app.gotoFrom(nodes) },
  ]);
  loadSettings();
  syncExtras();
  sync();
}
