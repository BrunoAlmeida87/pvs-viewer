// Assembly animation: a list of steps; in each step a set of parts arrives at its place (slides
// in, fades in or just appears), with the camera framing it. "Fixed" parts stay in place the whole
// time (the hull, the structure around a circuit). Several animations per model, saved in this
// browser and exported as JSON; playback can be recorded to a .webm video.
//
// It drives the viewer through partVisible / partOpacity / partColor and per-part offsets (the
// same mechanism as the exploded view); everything is given back when the animation stops.
import { $, el, fmt, store, saveBytes } from "./util.js";

const EFFECTS = [["slide", "deslizar até o lugar"], ["fade", "surgir (transparência)"], ["pop", "aparecer"]];
const DIRS = [["up", "de cima"], ["down", "de baixo"], ["px", "de +X"], ["nx", "de −X"], ["py", "de +Y"], ["ny", "de −Y"],
  ["cam", "da câmera"], ["out", "de fora, espalhadas"]];
const AXIS = { up: [0, 0, 1], down: [0, 0, -1], px: [1, 0, 0], nx: [-1, 0, 0], py: [0, 1, 0], ny: [0, -1, 0] };
const CAMS = [["frame", "enquadrar a etapa"], ["orbit", "enquadrar e girar"], ["keep", "manter"], ["saved", "vista gravada"], ["all", "mostrar tudo"]];
const LEAD = 0.6; // seconds with only the fixed parts, before the first step
const GHOST = 50, GRAY = 0xd5d9df;

const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hexToRgb = (h) => parseInt(String(h).slice(1), 16) || 0xff8c1a;
const clock = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const secs = (v) => num(v, 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " s";

export const newStep = (name, parts) => ({ name, parts, effect: "slide", dir: "up", dist: 0, dur: 1.5, hold: 0.6, seq: false,
  hl: true, color: "#ff8c1a", cam: "frame", camT: 1, view: null, orbit: 40 });
const newAnim = (name) => ({ name, fixed: [], look: "ghost", startCam: null, steps: [] });

export function initAnim(app) {
  const panel = $("#animPanel"), btn = $("#animBtn");
  let doc = { list: [newAnim("Animação 1")], cur: 0 };
  let signature = "", sel = -1;
  const A = () => doc.list[doc.cur];

  // ------------------------------------------------------------ storage
  const key = () => `pvs-viewer:anim:${signature}`;
  let saveT = 0;
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      if (!store.set(key(), { version: 1, model: app.title, parts: app.nParts, signature, ...doc }))
        info("Não deu para salvar no navegador (pouco espaço): exporte a animação em JSON.");
    }, 300);
  };
  const valid = (d) => {
    if (d?.version !== 1 || d.parts !== app.nParts || !Array.isArray(d.list) || !d.list.length) throw new Error("arquivo de outro modelo ou formato inválido");
    const ok = (p) => Number.isInteger(p) && p >= 0 && p < app.nParts;
    for (const a of d.list) {
      if (typeof a.name !== "string" || !Array.isArray(a.steps) || !Array.isArray(a.fixed)) throw new Error("animação inválida");
      a.fixed = a.fixed.filter(ok);
      a.steps = a.steps.map((s) => ({ ...newStep(String(s.name || "Etapa"), []), ...s, parts: (s.parts || []).filter(ok) }));
    }
    return { list: d.list, cur: Math.min(d.cur | 0, d.list.length - 1) };
  };

  // ------------------------------------------------------------ playback state
  let active = false, playing = false, t = 0, last = 0, snap = null, offsets = null;
  let prep = null; // prepared data for the current animation (see prepare())
  let rec = null;

  function activate() {
    if (active) return;
    snap = { vis: app.partVisible.slice(), op: app.partOpacity.slice(), col: app.partColor.slice(), cam: app.getCamera() };
    offsets = new Float32Array(app.nParts * 3);
    app.setPartOffsets(offsets);
    active = true;
    prepare();
  }
  function deactivate(restoreCam) {
    if (!active) return;
    pause();
    app.partVisible.set(snap.vis); app.partOpacity.set(snap.op); app.partColor.set(snap.col);
    app.setPartOffsets(null);
    active = false;
    app.refresh();
    if (restoreCam) app.setCamera(snap.cam);
    markNow(-1);
  }

  // Everything the frames need, computed once per change of the animation.
  function prepare() {
    const a = A(), n = app.nParts, boxes = app.partBoxes();
    offsets.fill(0); // so that the boxes below are the parts' real places
    const stepOf = new Int32Array(n).fill(-1), rank = new Int32Array(n);
    const fixed = new Uint8Array(n);
    for (const p of a.fixed) fixed[p] = 1;
    let dup = 0;
    const steps = a.steps.map((s, i) => {
      const parts = [];
      for (const p of s.parts) { if (stepOf[p] >= 0) { dup++; continue; } stepOf[p] = i; rank[p] = parts.length; parts.push(p); }
      return { s, parts, box: app.partsBox(parts) };
    });
    for (let i = 0; i < n; i++) if (stepOf[i] >= 0) fixed[i] = 0;
    const all = app.partsBox([...a.fixed, ...steps.flatMap((x) => x.parts)]);
    const modelDiag = all.isEmpty() ? 10 : all.getSize(all.min.clone()).length();
    // timeline
    let time = LEAD;
    for (const x of steps) {
      x.camT = x.s.cam === "keep" ? 0 : Math.max(0, num(x.s.camT, 1));
      x.dur = Math.max(0.05, num(x.s.dur, 1.5));
      x.hold = Math.max(0, num(x.s.hold, 0.5));
      x.t0 = time;
      time += x.camT + x.dur + x.hold;
    }
    // cameras: where each step's transition ends (c0) and where the step ends (c1)
    let cam = a.startCam || snap.cam;
    const start = cam;
    const dirOf = (c) => [c.pos[0] - c.target[0], c.pos[1] - c.target[1], c.pos[2] - c.target[2]];
    for (const x of steps) {
      const m = x.s.cam;
      let c0 = cam;
      if ((m === "frame" || m === "orbit") && !x.box.isEmpty()) c0 = app.cameraFor(x.box, dirOf(cam)) || cam;
      else if (m === "saved" && x.s.view) c0 = x.s.view;
      else if (m === "all" && !all.isEmpty()) c0 = app.cameraFor(all, dirOf(cam)) || cam;
      x.c0 = c0;
      x.c1 = m === "orbit" ? orbit(c0, num(x.s.orbit, 40)) : c0;
      cam = x.c1;
      // slide direction and distance
      const diag = x.box.isEmpty() ? 1 : x.box.getSize(x.box.min.clone()).length();
      x.dist = num(x.s.dist, 0) > 0 ? +x.s.dist : Math.max(diag * 1.2, modelDiag * 0.03, 0.2);
      if (x.s.dir === "cam") { const d = dirOf(c0), l = Math.hypot(...d) || 1; x.dir = d.map((v) => v / l); }
      else x.dir = AXIS[x.s.dir] || AXIS.up;
      x.center = x.box.isEmpty() ? [0, 0, 0] : x.box.getCenter(x.box.min.clone()).toArray();
      x.color = hexToRgb(x.s.color);
      x.w = x.parts.length > 1 ? Math.min(1, 4 / x.parts.length) : 1;
    }
    prep = { a, steps, stepOf, rank, fixed, boxes, total: time + 0.4, start, end: cam, dup };
    $("#animTime").max = String(Math.round(prep.total * 1000));
    infoSummary();
  }

  // camera turned `deg` degrees around the vertical axis through its target
  function orbit(c, deg) {
    const r = (deg * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
    const dx = c.pos[0] - c.target[0], dy = c.pos[1] - c.target[1];
    return { ...c, pos: [c.target[0] + dx * cs - dy * sn, c.target[1] + dx * sn + dy * cs, c.pos[2]] };
  }
  function lerpCam(a, b, u) {
    if (u <= 0) return a;
    if (u >= 1) return b;
    const L = (x, y) => x + (y - x) * u;
    const ta = a.target, tb = b.target;
    const target = [L(ta[0], tb[0]), L(ta[1], tb[1]), L(ta[2], tb[2])];
    const da = a.pos.map((v, i) => v - ta[i]), db = b.pos.map((v, i) => v - tb[i]);
    const la = Math.hypot(...da) || 1e-6, lb = Math.hypot(...db) || 1e-6;
    let d = da.map((v, i) => L(v / la, db[i] / lb));
    const ld = Math.hypot(...d) || 1;
    const dist = Math.exp(L(Math.log(la), Math.log(lb)));
    d = d.map((v) => (v / ld) * dist);
    return { ortho: b.ortho, pos: target.map((v, i) => v + d[i]), target, half: L(a.half || 10, b.half || 10), zoom: L(a.zoom || 1, b.zoom || 1) };
  }

  // State of every part and of the camera at time `time` (seconds).
  let lastStep = -2;
  function applyAt(time) {
    if (!prep) return;
    const { steps, stepOf, rank, fixed, a, boxes } = prep;
    let i = steps.findIndex((x) => time < x.t0 + x.camT + x.dur + x.hold);
    if (i < 0) i = steps.length;
    if (i !== lastStep) { // offsets only live on the step that is moving
      for (const x of steps) for (const p of x.parts) { offsets[p * 3] = 0; offsets[p * 3 + 1] = 0; offsets[p * 3 + 2] = 0; }
      lastStep = i;
      markNow(i < steps.length ? i : -1);
    }
    const vis = app.partVisible, op = app.partOpacity, col = app.partColor;
    const look = a.look, n = app.nParts;
    for (let p = 0; p < n; p++) {
      const s = stepOf[p];
      if (s >= 0 && s < i) { vis[p] = 1; op[p] = snap.op[p]; col[p] = snap.col[p]; }
      else if (s >= 0) { vis[p] = 0; }
      else if (fixed[p]) { vis[p] = 1; op[p] = look === "ghost" ? GHOST : snap.op[p]; col[p] = look === "gray" ? GRAY : snap.col[p]; }
      else vis[p] = 0;
    }
    let camNow = null;
    if (i < steps.length) {
      const x = steps[i], local = time - x.t0;
      const u0 = clamp01((local - x.camT) / x.dur);
      const m = x.parts.length, w = x.w, gap = m > 1 ? (1 - w) / (m - 1) : 0;
      const eff = x.s.effect;
      for (const p of x.parts) {
        const u = x.s.seq ? clamp01((u0 - rank[p] * gap) / w) : u0;
        if (u <= 0) { vis[p] = 0; continue; }
        vis[p] = 1;
        const e = ease(u);
        op[p] = eff === "fade" ? Math.max(1, Math.round(snap.op[p] * e)) : eff === "slide" ? Math.max(1, Math.round(snap.op[p] * Math.min(1, u / 0.12))) : snap.op[p];
        col[p] = x.s.hl ? x.color : snap.col[p];
        if (eff === "slide") {
          let d = x.dir;
          if (x.s.dir === "out") {
            const o = p * 6, c = [(boxes[o] + boxes[o + 3]) / 2 - x.center[0], (boxes[o + 1] + boxes[o + 4]) / 2 - x.center[1], (boxes[o + 2] + boxes[o + 5]) / 2 - x.center[2]];
            const l = Math.hypot(...c);
            d = l > 1e-6 ? c.map((v) => v / l) : AXIS.up;
          }
          const k = x.dist * (1 - e);
          offsets[p * 3] = d[0] * k; offsets[p * 3 + 1] = d[1] * k; offsets[p * 3 + 2] = d[2] * k;
        }
      }
      const prev = i === 0 ? prep.start : steps[i - 1].c1;
      if (local < x.camT) camNow = lerpCam(prev, x.c0, ease(clamp01(local / Math.max(1e-6, x.camT))));
      else if (x.s.cam === "orbit") camNow = orbit(x.c0, num(x.s.orbit, 40) * ease(clamp01((local - x.camT) / (x.dur + x.hold))));
      else camNow = x.c0;
    } else camNow = prep.end;
    app.setPartOffsets(offsets);
    app.refreshQuiet();
    if ($("#animCam").checked && camNow) app.setCamera(camNow);
  }

  function markNow(i) {
    [...$("#animSteps").children].forEach((r, k) => r.classList.toggle("now", k === i));
  }

  // ------------------------------------------------------------ transport
  const speed = () => +$("#animSpeed").value || 1;
  function frame(now) {
    if (!playing) return;
    t += ((now - last) / 1000) * speed();
    last = now;
    if (t >= prep.total) {
      if ($("#animLoop").checked && !rec) t = 0;
      else { t = prep.total; applyAt(t); showTime(); pause(); if (rec) finishRecording(); return; }
    }
    app.markMoving(); // fluid playback: same level of detail as when orbiting
    applyAt(t);
    showTime();
    requestAnimationFrame(frame);
  }
  function play() {
    if (!A().steps.length) { info("Crie ao menos uma etapa: selecione peças e clique em “+ Etapa com a seleção”."); return; }
    activate();
    if (t >= prep.total - 1e-3) t = 0;
    playing = true;
    last = performance.now();
    $("#animPlay").textContent = "⏸";
    requestAnimationFrame(frame);
  }
  function pause() { playing = false; $("#animPlay").textContent = "▶"; }
  function seek(time) {
    if (!A().steps.length) return;
    activate();
    t = Math.max(0, Math.min(prep.total, time));
    applyAt(t);
    showTime();
  }
  function showTime() {
    $("#animTime").value = String(Math.round(t * 1000));
    $("#animClock").textContent = `${clock(t)} / ${clock(prep ? prep.total : 0)}`;
  }
  $("#animPlay").onclick = () => (playing ? pause() : play());
  $("#animStop").onclick = () => { if (rec) stopRecording(true); deactivate(true); t = 0; showTime(); };
  $("#animTime").oninput = () => { pause(); seek(+$("#animTime").value / 1000); };
  $("#animCam").onchange = () => { if (active) applyAt(t); };

  // ------------------------------------------------------------ video
  function stopRecording(discard) {
    if (!rec) return;
    rec.discard = discard;
    try { rec.r.stop(); } catch { /* already stopped */ }
  }
  function finishRecording() { setTimeout(() => stopRecording(false), 400); } // keep the last frame a moment
  $("#animRec").onclick = () => {
    if (rec) { stopRecording(true); return; }
    if (!A().steps.length) { info("Crie ao menos uma etapa antes de gravar."); return; }
    if (!app.canvas.captureStream || !window.MediaRecorder) { info("Este navegador não grava vídeo da tela do modelo."); return; }
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    const r = new MediaRecorder(app.canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 10e6 });
    const parts = [];
    rec = { r, discard: false };
    r.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    r.onstop = async () => {
      const discard = rec.discard;
      rec = null;
      app.setCubeVisible(true);
      $("#animRec").textContent = "● Gravar vídeo";
      if (discard) { info("Gravação cancelada."); return; }
      const blob = new Blob(parts, { type: "video/webm" });
      const name = `${(app.title || "modelo").replace(/\.pvs$/i, "")} - ${A().name}.webm`.replace(/[\\/:*?"<>|]/g, "_");
      const where = await saveBytes(name, new Uint8Array(await blob.arrayBuffer()), { description: "Vídeo WebM", mime: "video/webm", ext: "webm" });
      info(where ? `Vídeo salvo: ${where} (${(blob.size / 1e6).toFixed(1)} MB).` : "Vídeo não salvo.");
    };
    app.setCubeVisible(false);
    $("#animRec").textContent = "■ Parar gravação";
    $("#animLoop").checked = false;
    activate();
    t = 0;
    applyAt(0);
    r.start(250);
    setTimeout(play, 150);
  };

  // ------------------------------------------------------------ editing
  const changed = (reprep = true) => {
    save();
    renderSteps();
    if (active && reprep) { prepare(); applyAt(Math.min(t, prep.total)); showTime(); }
    else infoSummary();
  };
  const selParts = () => app.selectedParts();
  const leaves = (n) => { const out = []; for (let p = app.tree.p0[n]; p < app.tree.p1[n]; p++) out.push(p); return out; };

  function info(text) { $("#animInfo").textContent = text; }
  function infoSummary() {
    const a = A();
    const inSteps = new Set(a.steps.flatMap((s) => s.parts));
    const parts = inSteps.size;
    const fixedN = a.fixed.reduce((k, p) => k + (inSteps.has(p) ? 0 : 1), 0);
    let total = LEAD;
    for (const s of a.steps) total += (s.cam === "keep" ? 0 : num(s.camT, 1)) + num(s.dur, 1.5) + num(s.hold, 0.5);
    info(a.steps.length
      ? `${fmt(a.steps.length)} etapa(s) · ${fmt(parts)} peça(s) · ${fmt(fixedN)} fixa(s) · ${clock(total + 0.4)}` +
        (prep && prep.dup && active ? ` · ${fmt(prep.dup)} peça(s) repetida(s) em mais de uma etapa: vale a primeira` : "")
      : "Selecione peças (na árvore, na Busca ou em Bigramas) e crie as etapas. Use “Visíveis agora” para deixar o resto do modelo como contexto fixo.");
    $("#animFixedN").textContent = `${fmt(fixedN)} peça(s) fixa(s)`;
  }

  function renderSel() {
    const s = $("#animSel");
    s.replaceChildren(...doc.list.map((a, i) => el("option", { value: String(i), text: a.name })));
    s.value = String(doc.cur);
    $("#animFixedLook").value = A().look;
  }
  const effShort = { slide: "desliza", fade: "surge", pop: "aparece" };
  function renderSteps() {
    const box = $("#animSteps");
    box.replaceChildren(...A().steps.map((s, i) => el("div.aStep" + (i === sel ? ".on" : ""), { onclick: () => pick(i) },
      el("span.n", { text: String(i + 1) }),
      el("span.nm", { text: s.name, title: s.name }),
      el("span.sum", { text: `${fmt(s.parts.length)} pç · ${effShort[s.effect] || ""} · ${secs(s.dur)}` }),
      el("button", { text: "▲", title: "Antes", onclick: (e) => { e.stopPropagation(); move(i, -1); } }),
      el("button", { text: "▼", title: "Depois", onclick: (e) => { e.stopPropagation(); move(i, 1); } }),
      el("button", { text: "✕", title: "Excluir a etapa", onclick: (e) => { e.stopPropagation(); remove(i); } }))));
    if (active && prep) markNow(lastStep < prep.steps.length ? lastStep : -1);
    renderEdit();
    infoSummary();
  }
  function move(i, d) {
    const st = A().steps, j = i + d;
    if (j < 0 || j >= st.length) return;
    [st[i], st[j]] = [st[j], st[i]];
    if (sel === i) sel = j; else if (sel === j) sel = i;
    changed();
  }
  function remove(i) {
    A().steps.splice(i, 1);
    if (sel === i) sel = -1; else if (sel > i) sel--;
    changed();
  }
  // choosing a step shows the model as it is when that step has just arrived
  function pick(i) {
    sel = sel === i ? -1 : i;
    renderSteps();
    if (sel >= 0) {
      pause();
      activate();
      const x = prep.steps[sel];
      seek(x.t0 + x.camT + x.dur);
    }
  }

  function renderEdit() {
    const box = $("#animEdit");
    box.replaceChildren();
    const s = A().steps[sel];
    if (!s) return;
    const set = (k, v, reprep = true) => { s[k] = v; changed(reprep); };
    const select = (k, opts) => { const e = el("select", { onchange: () => set(k, e.value) }, ...opts.map(([v, l]) => el("option", { value: v, text: l }))); e.value = s[k]; return e; };
    const number = (k, step, title) => el("input", { type: "number", min: "0", step: String(step), value: String(s[k]), title, onchange: (e) => set(k, Math.max(0, +e.target.value || 0)) });
    const name = el("input", { value: s.name, onchange: () => set("name", name.value.trim() || s.name, false) });
    const sp = () => selParts();
    box.append(
      el("div.row2", null, el("span", { text: "Nome" }), name),
      el("div.row2", null, el("span", { text: `${fmt(s.parts.length)} peças` }),
        el("button", { text: "= seleção", title: "As peças da etapa passam a ser as selecionadas", onclick: () => { const p = sp(); if (p.length) set("parts", p); } }),
        el("button", { text: "+ seleção", onclick: () => { const have = new Set(s.parts); set("parts", [...s.parts, ...sp().filter((p) => !have.has(p))]); } }),
        el("button", { text: "− seleção", onclick: () => { const rm = new Set(sp()); set("parts", s.parts.filter((p) => !rm.has(p))); } }),
        el("button", { text: "Selecionar", onclick: () => app.select(s.parts.map((p) => app.partNode[p]), "replace", { reveal: false }) })),
      el("div.row2", null, el("span", { text: "Entrada" }), select("effect", EFFECTS)),
      s.effect === "slide" ? el("div.row2", null, el("span", { text: "Vem" }), select("dir", DIRS),
        number("dist", 0.1, "Distância do deslize, em metros (0 = automática, pelo tamanho da etapa)"), el("span.muted", { text: "m" })) : null,
      el("div.row2", null, el("span", { text: "Duração" }), number("dur", 0.1, "Segundos do movimento"), el("span.muted", { text: "s · pausa" }),
        number("hold", 0.1, "Segundos parados depois de chegar")),
      el("label.chk", null, el("input", { type: "checkbox", checked: s.seq, onchange: (e) => set("seq", e.target.checked) }),
        "uma peça após a outra, na ordem da etapa (bom para tubulação e cabos)"),
      el("div.row2", null, el("label.chk.inl", null, el("input", { type: "checkbox", checked: s.hl, onchange: (e) => set("hl", e.target.checked) }), "destacar com a cor"),
        el("input", { type: "color", value: s.color, onchange: (e) => set("color", e.target.value) })),
      el("div.row2", null, el("span", { text: "Câmera" }), select("cam", CAMS),
        s.cam !== "keep" ? number("camT", 0.1, "Segundos da transição da câmera, antes das peças se moverem") : null,
        s.cam !== "keep" ? el("span.muted", { text: "s" }) : null),
      s.cam === "orbit" ? el("div.row2", null, el("span", { text: "Girar" }), number("orbit", 5, "Graus em volta do eixo vertical, durante o movimento e a pausa"), el("span.muted", { text: "graus" })) : null,
      s.cam === "saved" ? el("div.row2", null, el("span", { text: s.view ? "vista gravada" : "sem vista" }),
        el("button", { text: "Gravar a vista atual", onclick: () => set("view", app.getCamera()) }),
        s.view ? el("button", { text: "Ir para ela", onclick: () => app.setCamera(s.view) }) : null) : null,
    );
  }

  // ------------------------------------------------------------ steps from the selection
  $("#animAddSel").onclick = () => {
    const parts = selParts();
    if (!parts.length) { info("Selecione as peças da etapa primeiro."); return; }
    const n = app.focus >= 0 ? app.focus : app.partNode[parts[0]];
    const name = app.selNodes.size === 1 ? app.tree.names[n] : `Etapa ${A().steps.length + 1}`;
    A().steps.push(newStep(name, parts));
    sel = A().steps.length - 1;
    changed();
  };
  // one step per child of each selected node (or per selected part)
  $("#animGenKids").onclick = () => {
    const nodes = [...app.selNodes].sort((a, b) => a - b);
    if (!nodes.length) { info("Selecione uma montagem: cada item dentro dela vira uma etapa."); return; }
    const out = [];
    for (const n of nodes) {
      const kids = app.kids ? app.kids(n) : [];
      if (!kids.length) { if (app.partCount(n)) out.push(newStep(app.tree.names[n], leaves(n))); continue; }
      for (const c of kids) if (app.partCount(c)) out.push(newStep(app.tree.names[c], leaves(c)));
    }
    if (!out.length) { info("A seleção não tem itens com geometria."); return; }
    if (out.length > 150 && !confirm(`Isso cria ${fmt(out.length)} etapas. Continuar?`)) return;
    A().steps.push(...out);
    changed();
    info(`${fmt(out.length)} etapa(s) criada(s).`);
  };
  // order the selection along the circuit and cut it in stretches
  $("#animGenPath").onclick = () => {
    const parts = selParts();
    if (parts.length < 2) { info("Selecione as peças do circuito (por exemplo, um bigrama em Bigramas → Selec.)."); return; }
    const t = app.tree, boxes = app.partBoxes(), ki = app.keyIndex("Bigrama");
    // unit = the equipment (node with its own code) the part belongs to, or the part itself
    const unitOf = (p) => {
      if (ki >= 0) for (let n = app.partNode[p]; n >= 0; n = t.parent[n]) if (app.prop(n, ki)) return n;
      return app.partNode[p];
    };
    const units = new Map();
    for (const p of parts) {
      const u = unitOf(p);
      let g = units.get(u);
      if (!g) units.set(u, (g = { node: u, parts: [], c: [0, 0, 0] }));
      g.parts.push(p);
    }
    const list = [...units.values()];
    for (const g of list) {
      let k = 0;
      for (const p of g.parts) {
        const o = p * 6;
        if (!boxes[o] && !boxes[o + 3] && !boxes[o + 1] && !boxes[o + 4]) continue;
        for (let a = 0; a < 3; a++) g.c[a] += (boxes[o + a] + boxes[o + 3 + a]) / 2;
        k++;
      }
      if (k) g.c = g.c.map((v) => v / k);
    }
    const isEquip = list.some((g) => g.parts.length > 1 || g.node !== app.partNode[g.parts[0]]);
    const what = isEquip ? "equipamentos" : "peças";
    const suggest = Math.max(1, Math.ceil(list.length / 12));
    const per = Math.round(+prompt(`${fmt(list.length)} ${what} no circuito. Quantos ${what} por etapa?`, String(suggest)));
    if (!(per >= 1)) return;
    // start at the extreme of the longest axis, then always go to the nearest one not yet used
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const g of list) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], g.c[a]); hi[a] = Math.max(hi[a], g.c[a]); }
    const ax = [0, 1, 2].reduce((b, a) => (hi[a] - lo[a] > hi[b] - lo[b] ? a : b), 0);
    let cur = list.reduce((b, g) => (g.c[ax] < b.c[ax] ? g : b), list[0]);
    const used = new Set([cur]), chain = [cur];
    while (chain.length < list.length) {
      let best = null, bd = Infinity;
      for (const g of list) {
        if (used.has(g)) continue;
        const d = (g.c[0] - cur.c[0]) ** 2 + (g.c[1] - cur.c[1]) ** 2 + (g.c[2] - cur.c[2]) ** 2;
        if (d < bd) { bd = d; best = g; }
      }
      used.add(best); chain.push(best); cur = best;
    }
    const out = [];
    for (let i = 0; i < chain.length; i += per) {
      const slice = chain.slice(i, i + per);
      const st = newStep(per === 1 ? t.names[slice[0].node] : `Trecho ${out.length + 1} · ${fmt(slice.length)} ${what}`, slice.flatMap((g) => g.parts));
      st.seq = true;
      st.dur = Math.round(Math.min(6, Math.max(1.2, 0.35 * st.parts.length)) * 10) / 10;
      st.hold = 0.3;
      out.push(st);
    }
    A().steps.push(...out);
    changed();
    info(`${fmt(out.length)} etapa(s) seguindo o circuito (${fmt(list.length)} ${what}).`);
  };

  // ------------------------------------------------------------ fixed parts
  const setFixed = (parts) => { A().fixed = parts; changed(); };
  $("#animFixedVis").onclick = () => {
    const vis = active ? snap.vis : app.partVisible;
    const inSteps = new Uint8Array(app.nParts);
    for (const s of A().steps) for (const p of s.parts) inSteps[p] = 1;
    const out = [];
    for (let p = 0; p < app.nParts; p++) if (vis[p] && !inSteps[p]) out.push(p);
    setFixed(out);
  };
  // context that matters: visible parts around the steps (lighter to draw, easier to read)
  $("#animFixedNear").onclick = () => {
    const a = A();
    if (!a.steps.length) { info("Crie as etapas primeiro: as fixas serão as peças em volta delas."); return; }
    const m = +String(prompt("Distância em volta das etapas (metros):", "1") || "").replace(",", ".");
    if (!(m >= 0)) return;
    const vis = active ? snap.vis : app.partVisible, b = app.partBoxes(), n = app.nParts;
    const inSteps = new Uint8Array(n);
    const boxes = a.steps.map((s) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const p of s.parts) { inSteps[p] = 1; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b[p * 6 + k]); hi[k] = Math.max(hi[k], b[p * 6 + 3 + k]); } }
      return [lo[0] - m, lo[1] - m, lo[2] - m, hi[0] + m, hi[1] + m, hi[2] + m];
    }).filter((x) => x[0] <= x[3]);
    const out = [];
    for (let p = 0; p < n; p++) {
      if (!vis[p] || inSteps[p]) continue;
      const o = p * 6;
      if (!b[o] && !b[o + 3] && !b[o + 1] && !b[o + 4]) continue;
      for (const x of boxes) if (b[o] <= x[3] && b[o + 3] >= x[0] && b[o + 1] <= x[4] && b[o + 4] >= x[1] && b[o + 2] <= x[5] && b[o + 5] >= x[2]) { out.push(p); break; }
    }
    setFixed(out);
  };
  $("#animFixedAdd").onclick = () => { const have = new Set(A().fixed); setFixed([...A().fixed, ...selParts().filter((p) => !have.has(p))]); };
  $("#animFixedSub").onclick = () => { const rm = new Set(selParts()); setFixed(A().fixed.filter((p) => !rm.has(p))); };
  $("#animFixedClr").onclick = () => setFixed([]);
  $("#animFixedLook").onchange = () => { A().look = $("#animFixedLook").value; changed(); };
  $("#animStartCam").onclick = () => { A().startCam = app.getCamera(); changed(); info("Vista inicial gravada: a animação começa daqui."); };

  // ------------------------------------------------------------ animations of the model
  const switchTo = (i) => { deactivate(false); doc.cur = i; sel = -1; t = 0; renderSel(); renderSteps(); showTime(); save(); };
  $("#animSel").onchange = () => switchTo(+$("#animSel").value);
  $("#animNew").onclick = () => {
    const name = prompt("Nome da nova animação", `Animação ${doc.list.length + 1}`)?.trim();
    if (!name) return;
    doc.list.push(newAnim(name));
    switchTo(doc.list.length - 1);
  };
  $("#animMore").onclick = () => { $("#animMoreMenu").hidden = !$("#animMoreMenu").hidden; };
  $("#animMoreMenu").onclick = async (e) => {
    const act = e.target.dataset?.act;
    if (!act) return;
    $("#animMoreMenu").hidden = true;
    const a = A();
    if (act === "rename") { const n = prompt("Nome da animação", a.name)?.trim(); if (n) { a.name = n; renderSel(); save(); } }
    else if (act === "dup") { doc.list.push({ ...JSON.parse(JSON.stringify(a)), name: a.name + " (cópia)" }); switchTo(doc.list.length - 1); }
    else if (act === "del") {
      if (!confirm(`Excluir a animação “${a.name}”?`)) return;
      doc.list.splice(doc.cur, 1);
      if (!doc.list.length) doc.list.push(newAnim("Animação 1"));
      switchTo(Math.min(doc.cur, doc.list.length - 1));
    } else if (act === "export") {
      const data = JSON.stringify({ version: 1, model: app.title, parts: app.nParts, signature, list: [a], cur: 0 });
      await saveBytes(`${a.name}.animacao.json`.replace(/[\\/:*?"<>|]/g, "_"), new TextEncoder().encode(data), { description: "Animação", mime: "application/json", ext: "json" });
    } else if (act === "import") $("#animFile").click();
  };
  $("#animFile").onchange = async () => {
    const f = $("#animFile").files[0];
    $("#animFile").value = "";
    if (!f) return;
    try {
      const d = valid(JSON.parse(await f.text()));
      doc.list.push(...d.list);
      switchTo(doc.list.length - 1);
      info(`Importada: ${d.list.map((a) => a.name).join(", ")}.`);
    } catch (e) { info("Não foi possível importar: " + e.message); }
  };

  // ------------------------------------------------------------ panel
  btn.onclick = () => {
    panel.hidden = !panel.hidden;
    btn.classList.toggle("on", !panel.hidden);
    if (!panel.hidden) { renderSel(); renderSteps(); showTime(); }
  };
  // closed by its ✕ or because another panel opened: give the view back
  new MutationObserver(() => {
    if (!panel.hidden) return;
    btn.classList.remove("on");
    if (rec) stopRecording(true);
    deactivate(true);
  }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  document.addEventListener("keydown", (e) => {
    if (panel.hidden || e.key !== " " || e.target.closest("input, select, textarea, button")) return;
    e.preventDefault();
    e.stopPropagation();
    if (playing) pause(); else play();
  }, true);

  app.on("viewtab-leave", () => { if (rec) stopRecording(true); deactivate(false); });
  app.on("model", () => {
    deactivate(false);
    prep = null;
    let hash = 2166136261;
    for (const name of app.tree.shapes) for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
    signature = `${app.title}:${app.nParts}:${(hash >>> 0).toString(16)}`;
    try { doc = valid(store.get(key(), null)); } catch { doc = { list: [newAnim("Animação 1")], cur: 0 }; }
    sel = -1; t = 0;
    renderSel(); renderSteps(); showTime();
  });
}
