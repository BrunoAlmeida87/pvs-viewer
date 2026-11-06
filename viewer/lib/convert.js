// Desktop-only streaming conversion to the same format produced by tools/build.py.
// The geometry worker writes chunks to disk without uploading them to WebGL.
import { parsePVS, buildTree } from "./pvs.js";

const encoder = new TextEncoder();

export async function convertModel(desktop, progress = () => {}) {
  const input = await desktop.conversionBegin();
  if (!input) return null;
  let worker;
  try {
    const response = await fetch(input.base + encodeURIComponent(input.pvs));
    if (!response.ok) throw new Error(`Não foi possível ler ${input.pvs}.`);
    const model = parsePVS(await response.arrayBuffer());
    const tree = buildTree(model.components);
    const n = tree.shapes.length;
    const pvsBoxes = new Float32Array(n * 6);
    const partsBoxes = new Float32Array(n * 6);
    const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
    for (let p = 0; p < n; p++) {
      const b = tree.boxes[p];
      if (b) {
        pvsBoxes.set(b, p * 6);
        for (let k = 0; k < 3; k++) { low[k] = Math.min(low[k], b[k]); high[k] = Math.max(high[k], b[k + 3]); }
      }
    }
    delete tree.boxes;
    const small = Number.isFinite(low[0]) ? Math.hypot(...low.map((v, i) => high[i] - v)) * 0.004 : 0;
    const chunks = [], items = [], itemLayers = [], layers = [], layerIds = new Map();
    let tris = 0;
    worker = new Worker(new URL("./olworker.js", import.meta.url), { type: "module" });
    worker.postMessage({ type: "init", base: input.base, small });
    const tasks = [];
    for (let p = 0; p < n; p += 20) tasks.push(tree.shapes.slice(p, p + 20).map((name, k) => ({ name, part: p + k })));
    for (let task = 0; task < tasks.length; task++) {
      const batch = tasks[task];
      const writes = [];
      await new Promise((resolve, reject) => {
        worker.onmessage = (event) => {
          const d = event.data;
          if (d.type === "error") { reject(new Error(d.message)); return; }
          if (d.type === "chunk") {
            const file = `${String(chunks.length).padStart(5, "0")}.bin`;
            const bytes = new Uint8Array(d.verts.byteLength + d.nrm.byteLength + d.idx.byteLength + d.edges.byteLength);
            let at = 0;
            for (const a of [d.verts, d.nrm, d.idx, d.edges]) { bytes.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), at); at += a.byteLength; }
            writes.push(desktop.conversionWrite("c/" + file, bytes));
            chunks.push({ f: file, min: d.min, max: d.max, io: items.length, ic: d.items.length,
              nv: d.nv, ni: d.ni, ne: d.ne, ps: d.ps, small: d.small });
            tris += d.ni / 3;
            for (let i = 0; i < d.items.length; i++) {
              items.push([d.items[i], ...d.colors.subarray(i * 4, i * 4 + 4)]);
              const name = d.layers[i] || "";
              if (!layerIds.has(name)) { layerIds.set(name, layers.length); layers.push(name); }
              itemLayers.push(layerIds.get(name));
            }
          } else if (d.type === "done") {
            for (let i = 0; i < d.boxParts.length; i++) partsBoxes.set(d.boxes.subarray(i * 6, i * 6 + 6), d.boxParts[i] * 6);
            resolve();
          }
        };
        worker.onerror = (event) => reject(new Error(event.message || "Falha na conversão."));
        worker.postMessage({ type: "task", id: task, parts: batch });
      });
      await Promise.all(writes);
      progress(`Convertendo: ${Math.min((task + 1) * 20, n).toLocaleString("pt-BR")} de ${n.toLocaleString("pt-BR")} peças`);
    }
    worker.terminate(); worker = null;
    if (!chunks.length) throw new Error("Nenhuma geometria pôde ser convertida.");
    const itemBytes = new Uint8Array(items.length * 8), itemView = new DataView(itemBytes.buffer);
    items.forEach((item, i) => { itemView.setUint32(i * 8, item[0], true); itemBytes.set(item.slice(1), i * 8 + 4); });
    const layerBytes = new Uint8Array(itemLayers.length * 2), layerView = new DataView(layerBytes.buffer);
    itemLayers.forEach((id, i) => layerView.setUint16(i * 2, id, true));
    const min = [0, 1, 2].map((k) => Math.min(...chunks.map((c) => c.min[k])));
    const max = [0, 1, 2].map((k) => Math.max(...chunks.map((c) => c.max[k])));
    const meta = { format: 2, source: input.pvs, parts: n, items: items.length, tris, min, max, layers, chunks };
    await desktop.conversionWrite("tree.json", encoder.encode(JSON.stringify(tree)));
    await desktop.conversionWrite("items.bin", itemBytes);
    await desktop.conversionWrite("parts.bin", new Uint8Array(partsBoxes.buffer));
    await desktop.conversionWrite("layers.bin", layerBytes);
    await desktop.conversionWrite("pvsbox.bin", new Uint8Array(pvsBoxes.buffer));
    // This manifest is written last so an incomplete directory is never recognized as a model.
    await desktop.conversionWrite("chunks.json", encoder.encode(JSON.stringify(meta)));
    await desktop.conversionFinish();
    return input.folder;
  } catch (error) {
    await desktop.conversionCancel();
    throw error;
  } finally {
    if (worker) worker.terminate();
  }
}
