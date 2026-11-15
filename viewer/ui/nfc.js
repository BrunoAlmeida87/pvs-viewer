// NFC tags (Chrome on Android, Web NFC). "Gravar na tag…" writes on a sticker a link to the
// selected part with the camera of now (lib/nfctag.js); touching that tag later opens the viewer
// at that part, seen from there, with the part pulsing. With the viewer closed Android opens the
// link itself; with the viewer open (and "Ler tags" on) the page reads the tag and goes there
// without reloading — or, when the tag is of another model kept on this device, reopens with it.
import { $, status, store } from "./util.js";
import { tagURL, tagFits, parseTag, sameModel, modelKey } from "../lib/nfctag.js";
import { listRecent } from "../lib/recent.js";

const READ_KEY = "pvs-viewer:nfcRead";

export function initNFC(app) {
  const supported = "NDEFReader" in window && window.isSecureContext;
  const panel = $("#nfcPanel"), btn = $("#nfcBtn"), msg = $("#nfcMsg"), wait = $("#nfcWait"), readBox = $("#nfcRead");
  if (!supported) { btn.hidden = true; $("#mNfc").hidden = true; return; }
  btn.hidden = false;
  $("#mNfc").hidden = false;
  const say = (t) => { msg.textContent = t; status(t); };

  // ------------------------------------------------------------ the part to write
  const codeOf = (n) => { const ki = app.keyIndex("part_objectid"); return (ki >= 0 && app.prop(n, ki)) || app.tree.names[n]; };
  function syncItem() {
    const n = app.tree ? app.focus : -1;
    $("#nfcItem").textContent = n >= 0 ? codeOf(n) + (codeOf(n) !== app.tree.names[n] ? " · " + app.tree.names[n] : "") : "Selecione uma peça";
    $("#nfcWrite").disabled = n < 0 || !!writing;
  }
  app.on("selection", syncItem);
  app.on("model", syncItem);

  // ------------------------------------------------------------ write
  let writing = null; // AbortController while waiting for a tag
  let quietUntil = 0; // the tag just written is not read back as a tag to go to
  async function write() {
    const n = app.focus;
    if (!app.tree || n < 0 || writing) return;
    const code = codeOf(n);
    const url = tagURL(location.href, { code, model: app.title, cam: app.getCamera() });
    const fit = tagFits(url);
    if (!fit.chip) { say(`O link ficou grande demais para uma tag (${fit.bytes} bytes).`); return; }
    writing = new AbortController();
    wait.hidden = false;
    $("#nfcWaitText").textContent = `Encoste a tag atrás do celular… (${fit.bytes} bytes${fit.chip === "NTAG213" ? "" : ", precisa de " + fit.chip + " ou maior"})`;
    msg.textContent = "";
    syncItem();
    try {
      await new NDEFReader().write({ records: [{ recordType: "url", data: url }] }, { signal: writing.signal });
      navigator.vibrate?.(80);
      say(`Tag gravada: ${code} (${fit.bytes} bytes).`);
    } catch (e) {
      say(e.name === "AbortError" ? "Gravação cancelada."
        : e.name === "NotAllowedError" ? "O Chrome não tem permissão para usar o NFC (Configurações do site › NFC)."
        : e.name === "NotSupportedError" ? "O NFC está desligado neste celular (Configurações › Conexões › NFC) ou a tag não é compatível."
        : e.name === "NetworkError" ? `A tag se afastou antes de terminar, está bloqueada ou não tem espaço (precisa de ${fit.bytes} bytes). Tente de novo segurando a tag parada.`
        : "Não foi possível gravar: " + (e.message || e.name));
    } finally {
      writing = null;
      quietUntil = performance.now() + 2000;
      wait.hidden = true;
      syncItem();
    }
  }
  const cancel = () => writing?.abort();
  $("#nfcWrite").onclick = write;
  $("#nfcCancel").onclick = cancel;

  // ------------------------------------------------------------ read
  let scanning = null, pending = null;
  async function startReading() {
    if (scanning) return true;
    const ctl = new AbortController();
    try {
      const reader = new NDEFReader();
      await reader.scan({ signal: ctl.signal });
      reader.onreading = (e) => onTag(e.message);
      reader.onreadingerror = () => status("Não foi possível ler a tag: encoste de novo, parada.");
      scanning = ctl;
      return true;
    } catch (e) {
      say(e.name === "NotAllowedError" ? "Sem permissão para ler tags NFC (Configurações do site › NFC)."
        : e.name === "NotSupportedError" ? "O NFC está desligado neste celular (Configurações › Conexões › NFC)."
        : "Não foi possível ler tags: " + (e.message || e.name));
      return false;
    }
  }
  function stopReading() { scanning?.abort(); scanning = null; }
  function onTag(message) {
    if (writing || performance.now() < quietUntil) return;
    let href = "";
    for (const r of message.records) {
      if (r.recordType === "url" || r.recordType === "absolute-url") { href = new TextDecoder().decode(r.data); break; }
    }
    const tag = href && parseTag(href);
    if (!tag) { status("Esta tag não tem um link de peça do visualizador."); return; }
    navigator.vibrate?.(60);
    if (!app.tree) { pending = { tag, href }; status("Tag lida: " + tag.code + " — abre quando o modelo carregar."); return; }
    go(tag, href);
  }
  async function go(tag, href) {
    if (document.documentElement.classList.contains("mobile")) { panel.hidden = true; app.closeMobileSide?.(); }
    if (tag.model && !sameModel(tag.model, app.title)) {
      // another model: reopen the viewer with it when it is kept on this device
      const r = (await listRecent()).find((x) => x.model && sameModel(x.model, tag.model));
      if (r) { status(`Abrindo ${modelKey(tag.model)} para a tag…`); location.href = location.origin + location.pathname + new URL(href).search; return; }
      status(`Esta tag é do modelo “${modelKey(tag.model)}”, que não está neste aparelho. Procurando ${tag.code} em ${modelKey(app.title)}…`);
      await app.goToPart(tag.code, null, `Tag do modelo “${modelKey(tag.model)}”`);
      return;
    }
    await app.goToPart(tag.code, tag.cam, "Tag NFC");
  }
  app.on("loaded", () => { if (pending) { const p = pending; pending = null; go(p.tag, p.href); } });

  readBox.checked = store.get(READ_KEY, true);
  readBox.onchange = async () => {
    store.set(READ_KEY, readBox.checked);
    if (!readBox.checked) { stopReading(); say("Leitura de tags desligada."); return; }
    if (await startReading()) say("Pronto: encoste uma tag para ir até a peça dela.");
    else { readBox.checked = false; store.set(READ_KEY, false); }
  };
  // reading starts by itself once the site may use NFC (the first time needs a tap: opening this panel)
  if (readBox.checked && navigator.permissions) {
    navigator.permissions.query({ name: "nfc" }).then((p) => { if (p.state === "granted" && readBox.checked) startReading(); }).catch(() => {});
  }

  // ------------------------------------------------------------ panel
  const open = (on) => {
    panel.hidden = !on;
    if (on) { syncItem(); if (readBox.checked) startReading(); }
  };
  btn.onclick = () => open(panel.hidden);
  app.openNFC = () => open(true);
  new MutationObserver(() => {
    btn.classList.toggle("on", !panel.hidden);
    if (panel.hidden) cancel();
  }).observe(panel, { attributes: true, attributeFilter: ["hidden"] });

  app.addContextItems((nodes, node) => [{
    label: "Gravar na tag NFC…", title: "Grava esta peça, com a vista de agora, numa tag NFC adesiva",
    onClick: () => { app.select([node], "replace", { reveal: false }); open(true); write(); },
  }]);
}
