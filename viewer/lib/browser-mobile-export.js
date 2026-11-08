// Export selected geometry from a converted folder already open in the web viewer.
import { Zip, ZipPassThrough } from "../vendor/fflate.js";

export function createModelZip(write = null) {
  const pieces = write ? null : [];
  let zipError = null;
  let queue = Promise.resolve();
  const zip = new Zip((error, bytes) => {
    if (error) zipError = error;
    else if (bytes?.length) {
      if (write) queue = queue.then(() => write(bytes));
      else pieces.push(bytes);
    }
  });
  return {
    add(name, bytes) {
      const file = new ZipPassThrough(name);
      zip.add(file);
      file.push(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), true);
      if (zipError) throw zipError;
    },
    async flush() {
      await queue;
      if (zipError) throw zipError;
    },
    async finish() {
      zip.end();
      await queue;
      if (zipError) throw zipError;
      return write ? null : new Blob(pieces, { type: "application/zip" });
    },
  };
}

export async function exportMobileZip(src, meta, selectedParts, progress = () => {}, write = null) {
  if (meta.format !== 2) throw new Error("Converta novamente o modelo antes de exportar.");
  const selected = new Set(selectedParts);
  if (!selected.size || [...selected].some((p) => !Number.isInteger(p) || p < 0 || p >= meta.parts))
    throw new Error("Selecione peças válidas para exportar.");
  const items = new DataView(await src.buf("items.bin"));
  const packageZip = createModelZip(write);
  const add = packageZip.add;
  for (const name of ["tree.json", "items.bin", "parts.bin", "layers.bin", "pvsbox.bin"]) {
    let data;
    try { data = await src.buf(name); }
    catch (e) { if (!["layers.bin", "pvsbox.bin"].includes(name)) throw e; else continue; }
    add(name, data);
  }
  const chunks = [];
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  let tris = 0;
  for (let ci = 0; ci < meta.chunks.length; ci++) {
    const c = meta.chunks[ci];
    let relevant = false;
    for (let i = c.io; i < c.io + c.ic && !relevant; i++) relevant = selected.has(items.getUint32(i * 8, true));
    if (!relevant) continue;
    const buf = await src.buf("c/" + c.f);
    if (buf.byteLength !== c.nv * 12 + (c.ni + c.ne) * 2) throw new Error(`Bloco inválido: ${c.f}`);
    const dv = new DataView(buf), raw = new Uint8Array(buf);
    const map = new Int32Array(c.nv).fill(-1);
    const verts = new Uint8Array(c.nv * 8), normals = new Uint8Array(c.nv * 4);
    let nv = 0;
    for (let v = 0; v < c.nv; v++) {
      const item = c.io + dv.getUint16(v * 8 + 6, true);
      if (item >= c.io + c.ic || item * 8 + 4 > items.byteLength) throw new Error(`Item inválido: ${c.f}`);
      if (!selected.has(items.getUint32(item * 8, true))) continue;
      map[v] = nv;
      verts.set(raw.subarray(v * 8, v * 8 + 8), nv * 8);
      normals.set(raw.subarray(c.nv * 8 + v * 4, c.nv * 8 + v * 4 + 4), nv * 4);
      for (let a = 0; a < 3; a++) {
        const value = c.min[a] + dv.getUint16(v * 8 + a * 2, true) / 65535 * (c.max[a] - c.min[a]);
        low[a] = Math.min(low[a], value); high[a] = Math.max(high[a], value);
      }
      nv++;
    }
    if (!nv) continue;
    const indices = new Uint16Array(c.ni), edges = new Uint16Array(c.ne);
    let ni = 0, ne = 0;
    const indexStart = c.nv * 12, edgeStart = indexStart + c.ni * 2;
    for (let k = 0; k < c.ni; k += 3) {
      const a = map[dv.getUint16(indexStart + k * 2, true)] ?? -1;
      const b = map[dv.getUint16(indexStart + (k + 1) * 2, true)] ?? -1;
      const d = map[dv.getUint16(indexStart + (k + 2) * 2, true)] ?? -1;
      if (a < 0 || b < 0 || d < 0) continue;
      indices.set([a, b, d], ni); ni += 3;
    }
    for (let k = 0; k < c.ne; k += 2) {
      const a = map[dv.getUint16(edgeStart + k * 2, true)] ?? -1;
      const b = map[dv.getUint16(edgeStart + (k + 1) * 2, true)] ?? -1;
      if (a < 0 || b < 0) continue;
      edges.set([a, b], ne); ne += 2;
    }
    if (!ni && !ne) continue;
    const file = `${String(chunks.length).padStart(5, "0")}.bin`;
    const output = new Uint8Array(nv * 12 + (ni + ne) * 2);
    output.set(verts.subarray(0, nv * 8));
    output.set(normals.subarray(0, nv * 4), nv * 8);
    const outView = new DataView(output.buffer);
    for (let k = 0; k < ni; k++) outView.setUint16(nv * 12 + k * 2, indices[k], true);
    for (let k = 0; k < ne; k++) outView.setUint16(nv * 12 + (ni + k) * 2, edges[k], true);
    add("c/" + file, output);
    await packageZip.flush();
    chunks.push({ ...c, f: file, nv, ni, ne });
    tris += ni / 3;
    progress(`Exportando bloco ${ci + 1} de ${meta.chunks.length}…`);
  }
  if (!chunks.length) throw new Error("A seleção não contém geometria convertida.");
  const manifest = { ...meta, chunks, tris, min: low, max: high, includedParts: [...selected].sort((a, b) => a - b) };
  add("chunks.json", new TextEncoder().encode(JSON.stringify(manifest)));
  return packageZip.finish();
}
