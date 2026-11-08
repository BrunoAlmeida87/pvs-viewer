// Export selected tessellated parts as Wavefront OBJ. Coordinates are in metres.
export async function writeOBJ(app, parts, write, progress = () => {}) {
  let offset = 1, exported = 0;
  await write("# Visualizador PVS — coordenadas em metros\n");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const geometry = await app.partGeometry(p);
    if (!geometry?.idx?.length) continue;
    const name = String(app.tree.shapes[p] || `peca_${p}`).replace(/[\r\n]/g, " ");
    await write(`o ${name}\n`);
    let text = "";
    const flush = async () => { if (text) { await write(text); text = ""; } };
    for (let v = 0; v < geometry.pos.length; v += 3) {
      text += `v ${geometry.pos[v]} ${geometry.pos[v + 1]} ${geometry.pos[v + 2]}\n`;
      if (text.length > 500000) await flush();
    }
    for (let t = 0; t < geometry.idx.length; t += 3) {
      text += `f ${offset + geometry.idx[t]} ${offset + geometry.idx[t + 1]} ${offset + geometry.idx[t + 2]}\n`;
      if (text.length > 500000) await flush();
    }
    await flush();
    offset += geometry.pos.length / 3;
    exported++;
    progress(i + 1, parts.length);
  }
  return exported;
}

export async function exportOBJ(app, progress = () => {}) {
  const parts = app.selectedParts();
  if (!parts.length) throw new Error("Selecione uma ou mais peças antes de exportar.");
  const name = (app.title || "modelo").replace(/\.pvs$/i, "") + "-selecao.obj";
  if (window.desktop) {
    if (!await window.desktop.objBegin(name)) return 0;
    try {
      const count = await writeOBJ(app, parts, (text) => window.desktop.objWrite(text), progress);
      if (!count) throw new Error("Nenhuma peça selecionada tem geometria disponível.");
      await window.desktop.objFinish();
      return count;
    } catch (e) { await window.desktop.objCancel(); throw e; }
  }
  if (!window.showSaveFilePicker) throw new Error("Use o Electron ou um navegador com suporte a salvar arquivos diretamente.");
  const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "Wavefront OBJ", accept: { "text/plain": [".obj"] } }] });
  const file = await handle.createWritable();
  try {
    const count = await writeOBJ(app, parts, (text) => file.write(text), progress);
    if (!count) throw new Error("Nenhuma peça selecionada tem geometria disponível.");
    await file.close();
    return count;
  } catch (e) { await file.abort(); throw e; }
}
