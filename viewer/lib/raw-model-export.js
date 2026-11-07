// Convert selected pieces of an open original PVS model into a portable viewer ZIP.
import { createModelZip } from "./browser-mobile-export.js";

const encoder = new TextEncoder();

export async function exportRawModelZip(source, selectedParts, progress = () => {}, write = null) {
  const { m, t, small } = source;
  const selected = [...new Set(selectedParts)].sort((a, b) => a - b);
  if (!selected.length || selected.some((p) => !Number.isInteger(p) || p < 0 || p >= t.shapes.length))
    throw new Error("Selecione peças válidas para exportar.");
  const zip = createModelZip(write);
  const count = t.shapes.length;
  const pvsBoxes = new Float32Array(count * 6), partsBoxes = new Float32Array(count * 6);
  for (let p = 0; p < count; p++) if (t.boxes[p]) {
    pvsBoxes.set(t.boxes[p], p * 6);
    partsBoxes.set(t.boxes[p], p * 6);
  }
  const tree = { ...t };
  delete tree.boxes;
  const chunks = [], items = [], itemLayers = [], layers = [], layerIds = new Map();
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  let tris = 0;
  const worker = new Worker(new URL("./olworker.js", import.meta.url), { type: "module" });
  try {
    worker.postMessage({ type: "init", dir: m.access.dir, base: m.access.base, small });
    for (let start = 0; start < selected.length; start += 20) {
      const batch = selected.slice(start, start + 20).map((part) => ({
        part, name: t.shapes[part], file: m.access.files?.get(t.shapes[part]) || undefined,
      }));
      await new Promise((resolve, reject) => {
        worker.onmessage = ({ data: d }) => {
          try {
            if (d.type === "error") { reject(new Error(d.message)); return; }
            if (d.type === "chunk") {
              const file = `${String(chunks.length).padStart(5, "0")}.bin`;
              const bytes = new Uint8Array(d.verts.byteLength + d.nrm.byteLength + d.idx.byteLength + d.edges.byteLength);
              let at = 0;
              for (const a of [d.verts, d.nrm, d.idx, d.edges]) {
                bytes.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), at);
                at += a.byteLength;
              }
              zip.add("c/" + file, bytes);
              chunks.push({ f: file, min: d.min, max: d.max, io: items.length, ic: d.items.length,
                nv: d.nv, ni: d.ni, ne: d.ne, ps: d.ps, small: d.small });
              tris += d.ni / 3;
              for (let a = 0; a < 3; a++) { low[a] = Math.min(low[a], d.min[a]); high[a] = Math.max(high[a], d.max[a]); }
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
          } catch (error) { reject(error); }
        };
        worker.onerror = (event) => reject(new Error(event.message || "Falha na conversão."));
        worker.postMessage({ type: "task", id: start, parts: batch });
      });
      await zip.flush();
      progress(`Convertendo ${Math.min(start + 20, selected.length)} de ${selected.length} peças…`);
    }
  } finally { worker.terminate(); }
  if (!chunks.length) throw new Error("A seleção não contém geometria legível.");
  const itemBytes = new Uint8Array(items.length * 8), itemView = new DataView(itemBytes.buffer);
  items.forEach((item, i) => { itemView.setUint32(i * 8, item[0], true); itemBytes.set(item.slice(1), i * 8 + 4); });
  const layerBytes = new Uint8Array(itemLayers.length * 2), layerView = new DataView(layerBytes.buffer);
  itemLayers.forEach((id, i) => layerView.setUint16(i * 2, id, true));
  const meta = { format: 2, source: m.name, parts: count, items: items.length, tris,
    min: low, max: high, layers, chunks, includedParts: selected };
  zip.add("tree.json", encoder.encode(JSON.stringify(tree)));
  zip.add("items.bin", itemBytes);
  zip.add("parts.bin", new Uint8Array(partsBoxes.buffer));
  zip.add("layers.bin", layerBytes);
  zip.add("pvsbox.bin", new Uint8Array(pvsBoxes.buffer));
  zip.add("chunks.json", encoder.encode(JSON.stringify(meta)));
  return zip.finish();
}
