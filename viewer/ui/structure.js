// A user-owned hierarchy of part IDs, independent of the read-only PVS tree.
import { $, el, fmt, store, saveBytes } from "./util.js";
import { exportOBJ } from "../lib/obj.js";
import { writePVS } from "../lib/pvswrite.js";
import { buildSpec, writeConverted, REST_NAME } from "../lib/restructure.js";

export function initStructure(app) {
  let groups = [];
  let signature = "";
  const key = () => `pvs-viewer:structure:${signature}`;
  const save = () => {
    if (!store.set(key(), { version: 1, model: app.title, parts: app.nParts, signature, groups }))
      alert("Não foi possível salvar a estrutura no armazenamento local. Exporte uma cópia em JSON.");
  };
  const selectedParts = () => {
    const out = new Set();
    for (const n of app.selNodes) for (let p = app.tree.p0[n]; p < app.tree.p1[n]; p++) out.add(p);
    return out;
  };
  const members = (g) => {
    const out = [...g.parts];
    for (const child of groups.filter((x) => x.parent === g.id)) for (const p of members(child)) out.push(p);
    return out;
  };
  const changed = () => { save(); render(); };
  const valid = (data) => {
    if (data?.version !== 1 || data.model !== app.title || data.parts !== app.nParts || data.signature !== signature || !Array.isArray(data.groups))
      throw new Error("A estrutura pertence a outro modelo ou tem formato inválido.");
    const ids = new Set(), assigned = new Set();
    for (const g of data.groups) {
      if (!Number.isSafeInteger(g.id) || ids.has(g.id) || typeof g.name !== "string" || !Array.isArray(g.parts))
        throw new Error("Grupo inválido ou duplicado.");
      ids.add(g.id);
      for (const p of g.parts) {
        if (!Number.isInteger(p) || p < 0 || p >= app.nParts || assigned.has(p)) throw new Error("Peça inválida ou repetida.");
        assigned.add(p);
      }
    }
    for (const g of data.groups) {
      if (g.parent !== null && !ids.has(g.parent)) throw new Error("Grupo pai inexistente.");
      const seen = new Set([g.id]);
      let parent = g.parent;
      while (parent !== null) {
        if (seen.has(parent)) throw new Error("A estrutura contém um ciclo.");
        seen.add(parent);
        parent = data.groups.find((x) => x.id === parent).parent;
      }
    }
    return data.groups.map((g) => ({ id: g.id, name: g.name, parent: g.parent, parts: [...g.parts] }));
  };
  const render = () => {
    const box = $("#groupList");
    box.replaceChildren();
    if (!app.tree) return;
    if (!groups.length) box.append(el("p.muted", { text: "Crie um grupo para organizar as peças." }));
    const visit = (g, depth) => {
      const all = members(g);
      const row = el("div.row", null, el("span.nm", { text: g.name, title: g.name }),
        el("span.cnt", { text: fmt(all.length) }));
      row.style.paddingLeft = 4 + depth * 14 + "px";
      row.title = "Clique para selecionar as peças do grupo";
      row.onclick = () => app.select(all.map((p) => app.partNode[p]), "replace", { reveal: false });
      const tools = el("div.row2", null,
        el("button", { text: "+ seleção", onclick: () => {
          const parts = selectedParts();
          for (const other of groups) other.parts = other.parts.filter((p) => !parts.has(p));
          g.parts.push(...parts);
          changed();
        } }),
        el("button", { text: "− seleção", onclick: () => {
          const parts = selectedParts(); g.parts = g.parts.filter((p) => !parts.has(p)); changed();
        } }),
        el("button", { text: "Renomear", onclick: () => {
          const name = prompt("Nome do grupo", g.name)?.trim(); if (name) { g.name = name; changed(); }
        } }),
        el("button", { text: "Excluir", onclick: () => {
          if (!confirm(`Excluir o grupo “${g.name}” e seus subgrupos? As peças continuam no modelo.`)) return;
          const remove = new Set([g.id]);
          for (let changedIds = true; changedIds;) {
            changedIds = false;
            for (const child of groups) if (remove.has(child.parent) && !remove.has(child.id)) { remove.add(child.id); changedIds = true; }
          }
          groups = groups.filter((x) => !remove.has(x.id)); changed();
        } }));
      const parent = el("select", { title: "Mover grupo para dentro de outro grupo" }, el("option", { value: "", text: "Raiz" }));
      const descendants = new Set([g.id]);
      for (let again = true; again;) {
        again = false;
        for (const child of groups) if (descendants.has(child.parent) && !descendants.has(child.id)) { descendants.add(child.id); again = true; }
      }
      for (const target of groups) if (!descendants.has(target.id)) parent.append(el("option", { value: String(target.id), text: target.name }));
      parent.value = g.parent === null ? "" : String(g.parent);
      parent.onchange = () => { g.parent = parent.value === "" ? null : Number(parent.value); changed(); };
      box.append(el("div", null, row, tools, el("div.row2", null, el("span", { text: "Dentro de" }), parent)));
      for (const child of groups.filter((x) => x.parent === g.id)) visit(child, depth + 1);
    };
    for (const g of groups.filter((x) => x.parent === null)) visit(g, 0);
  };
  app.on("model", () => {
    // Distinguish revisions with the same filename and part count.
    let hash = 2166136261;
    for (const name of app.tree.shapes) for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
    signature = `${app.title}:${app.nParts}:${(hash >>> 0).toString(16)}`;
    const saved = store.get(key(), null);
    try { groups = saved ? valid(saved) : []; } catch { groups = []; }
    render();
  });
  $("#groupNew").onclick = () => {
    const name = $("#groupName").value.trim();
    if (!name || !app.tree) return;
    // the selected parts go into the new group (and leave the group they were in)
    const parts = selectedParts();
    for (const other of groups) other.parts = other.parts.filter((p) => !parts.has(p));
    groups.push({ id: Math.max(0, ...groups.map((g) => g.id)) + 1, name, parent: null, parts: [...parts] });
    $("#groupName").value = "";
    changed();
  };
  $("#groupName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#groupNew").click(); });

  // ---- export of the reorganized structure (PVS or converted folder)
  const expStatus = (t) => { $("#expStatus").textContent = t; };
  const baseName = () => (app.title || "modelo").replace(/\.pvs$/i, "");
  const spec = (rest) => buildSpec(app.tree, app.nParts, groups, { rest });
  const needGroups = () => {
    if (groups.length) return true;
    expStatus("Crie ao menos um grupo antes de exportar.");
    return false;
  };

  // the original .pvs: kept in memory for a .pvs folder; a converted folder does not have it
  function originalPVS() {
    const s = app.sourceInfo();
    if (s?.kind === "raw") return Promise.resolve(s.pvs);
    expStatus("A pasta convertida não guarda o .pvs: escolha o arquivo original (" + (s?.meta?.source || "o .pvs do modelo") + ").");
    return new Promise((resolve) => {
      const input = $("#pvsOrigFile");
      input.value = "";
      input.onchange = async () => { const f = input.files[0]; resolve(f ? await f.arrayBuffer() : null); };
      input.click();
    });
  }

  $("#pvsExport").onclick = async () => {
    if (!app.tree || !needGroups()) return;
    const btn = $("#pvsExport");
    btn.disabled = true;
    try {
      const buf = await originalPVS();
      if (!buf) { expStatus(""); return; }
      expStatus("Gerando o PVS…");
      await new Promise((r) => setTimeout(r, 30)); // let the message show
      const { spec: s, restParts } = spec($("#restMode").value);
      const { bytes, components, added } = writePVS(buf, s, app.tree.names);
      const name = baseName() + "-reorganizado.pvs";
      const where = await saveBytes(name, bytes, { description: "Estrutura Creo View", mime: "application/octet-stream", ext: "pvs", startIn: app.access?.dir });
      if (!where) { expStatus(""); return; }
      expStatus(`PVS salvo (${where}): ${fmt(components)} componentes, ${fmt(added)} grupo(s) novo(s)` +
        ($("#restMode").value === "drop" ? `, ${fmt(restParts.length)} peça(s) fora dos grupos deixadas de fora` : "") +
        ". Coloque-o na mesma pasta dos arquivos .ol para abrir.");
    } catch (e) {
      expStatus("Não foi possível exportar o PVS: " + e.message);
    } finally { btn.disabled = false; }
  };

  $("#convExport").onclick = async () => {
    if (!app.tree || !needGroups()) return;
    const s = app.sourceInfo();
    if (s?.kind !== "converted" || !(s.meta.format >= 2)) {
      expStatus("Para gerar uma pasta convertida, abra o modelo convertido (a pasta com chunks.json). Com a pasta do .pvs aberta, use Exportar PVS.");
      return;
    }
    const folderName = baseName() + "-reorganizado";
    const btn = $("#convExport");
    btn.disabled = true;
    let write, finish, cancel;
    try {
      if (window.desktop?.exportFolderBegin) {
        const target = await window.desktop.exportFolderBegin(folderName);
        if (!target) return;
        write = (n, b) => window.desktop.conversionWrite(n, b);
        finish = async () => { await window.desktop.conversionFinish(); return target; };
        cancel = () => window.desktop.conversionCancel();
      } else if (window.showDirectoryPicker) {
        const parent = await window.showDirectoryPicker({ id: "pvs-export", mode: "readwrite" });
        let exists = true;
        try { await parent.getDirectoryHandle(folderName); } catch { exists = false; }
        if (exists) throw new Error(`a pasta “${folderName}” já existe ali. Escolha outro local ou renomeie a pasta existente.`);
        const dir = await parent.getDirectoryHandle(folderName, { create: true });
        const cdir = await dir.getDirectoryHandle("c", { create: true });
        write = async (n, b) => {
          const d = n.startsWith("c/") ? cdir : dir;
          const w = await (await d.getFileHandle(n.replace(/^c\//, ""), { create: true })).createWritable();
          await w.write(b); await w.close();
        };
        finish = async () => folderName;
        cancel = async () => { try { await parent.removeEntry(folderName, { recursive: true }); } catch { /* leave it */ } };
      } else {
        throw new Error("este navegador não grava pastas. Use o Chrome, o Edge ou o aplicativo desktop.");
      }
      const mode = $("#restMode").value;
      const { spec: sp, restParts } = spec(mode === "drop" ? "box" : mode);
      try {
        const r = await writeConverted(app.tree, sp, s.src, s.meta, write, {
          title: folderName + ".pvs", hidden: mode === "drop" ? restParts : [],
          progress: (k, n) => expStatus(`Copiando a geometria: ${fmt(k)} de ${fmt(n)} blocos…`),
        });
        const where = await finish();
        expStatus(`Pasta salva: ${where} (${fmt(r.nodes)} nós, ${fmt(r.parts)} peças). Abra-a com o botão de abrir modelo.` +
          (mode === "drop" ? " As peças fora dos grupos ficam ocultas, em “" + REST_NAME + "”." : ""));
      } catch (e) { await cancel(); throw e; }
    } catch (e) {
      if (e.name !== "AbortError") expStatus("Não foi possível exportar a pasta: " + e.message);
    } finally { btn.disabled = false; }
  };
  $("#groupExport").onclick = () => {
    if (!app.tree) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, model: app.title, parts: app.nParts, signature, groups })], { type: "application/json" }));
    const a = el("a", { href: url, download: `${app.title.replace(/\.pvs$/i, "")}-estrutura.json` });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  };
  $("#groupImport").onclick = () => $("#groupFile").click();
  $("#objExport").onclick = async () => {
    const button = $("#objExport");
    button.disabled = true;
    try {
      const count = await exportOBJ(app, (done, total) => { $("#load").textContent = `Exportando OBJ: ${done}/${total} peças`; });
      if (count) $("#load").textContent = `OBJ salvo com ${count} peças.`;
    } catch (e) { if (e.name !== "AbortError") alert("Erro ao exportar OBJ: " + e.message); }
    finally { button.disabled = false; }
  };
  $("#groupFile").onchange = async () => {
    const f = $("#groupFile").files[0];
    if (!f) return;
    try { groups = valid(JSON.parse(await f.text())); changed(); }
    catch (e) { alert("Estrutura inválida: " + e.message); }
    $("#groupFile").value = "";
  };
}
