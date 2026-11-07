// Build a smaller converted model from the pieces selected in the desktop viewer.
// Chunk vertices carry a local item id; items.bin maps that id to a part number.
const fs = require("node:fs/promises");
const path = require("node:path");

async function exportMobile(source, target, selectedParts) {
  const meta = JSON.parse(await fs.readFile(path.join(source, "chunks.json"), "utf8"));
  if (meta.format !== 2) throw new Error("Converta novamente o modelo para usar a exportação móvel.");
  const items = await fs.readFile(path.join(source, "items.bin"));
  const selected = new Set(selectedParts);
  if (!selected.size || [...selected].some((p) => !Number.isInteger(p) || p < 0 || p >= meta.parts))
    throw new Error("Selecione peças válidas para exportar.");
  await fs.mkdir(path.join(target, "c"), { recursive: true });
  for (const name of ["tree.json", "items.bin", "parts.bin", "layers.bin", "pvsbox.bin"]) {
    try { await fs.copyFile(path.join(source, name), path.join(target, name)); }
    catch (e) { if (e.code !== "ENOENT" || !["layers.bin", "pvsbox.bin"].includes(name)) throw e; }
  }
  const chunks = [];
  let tris = 0;
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const c of meta.chunks) {
    let relevant = false;
    for (let i = c.io; i < c.io + c.ic && !relevant; i++) relevant = selected.has(items.readUInt32LE(i * 8));
    if (!relevant) continue;
    const src = await fs.readFile(path.join(source, "c", c.f));
    const expected = c.nv * 12 + (c.ni + c.ne) * 2;
    if (src.length !== expected) throw new Error(`Bloco inválido: ${c.f}`);
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const map = new Int32Array(c.nv).fill(-1);
    const verts = Buffer.allocUnsafe(c.nv * 8), normals = Buffer.allocUnsafe(c.nv * 4);
    let nv = 0;
    for (let v = 0; v < c.nv; v++) {
      const item = c.io + dv.getUint16(v * 8 + 6, true);
      if (item >= c.io + c.ic || item * 8 + 4 > items.length) throw new Error(`Item inválido: ${c.f}`);
      if (!selected.has(items.readUInt32LE(item * 8))) continue;
      map[v] = nv;
      src.copy(verts, nv * 8, v * 8, v * 8 + 8);
      src.copy(normals, nv * 4, c.nv * 8 + v * 4, c.nv * 8 + v * 4 + 4);
      for (let axis = 0; axis < 3; axis++) {
        const value = c.min[axis] + dv.getUint16(v * 8 + axis * 2, true) / 65535 * (c.max[axis] - c.min[axis]);
        low[axis] = Math.min(low[axis], value);
        high[axis] = Math.max(high[axis], value);
      }
      nv++;
    }
    if (!nv) continue;
    const indices = Buffer.allocUnsafe(c.ni * 2), edges = Buffer.allocUnsafe(c.ne * 2);
    let ni = 0, ne = 0;
    const indexStart = c.nv * 12, edgeStart = indexStart + c.ni * 2;
    for (let k = 0; k < c.ni; k += 3) {
      const a = map[dv.getUint16(indexStart + k * 2, true)] ?? -1;
      const b = map[dv.getUint16(indexStart + (k + 1) * 2, true)] ?? -1;
      const d = map[dv.getUint16(indexStart + (k + 2) * 2, true)] ?? -1;
      if (a < 0 || b < 0 || d < 0) continue;
      for (const v of [a, b, d]) { indices.writeUInt16LE(v, ni * 2); ni++; }
    }
    for (let k = 0; k < c.ne; k += 2) {
      const a = map[dv.getUint16(edgeStart + k * 2, true)] ?? -1;
      const b = map[dv.getUint16(edgeStart + (k + 1) * 2, true)] ?? -1;
      if (a < 0 || b < 0) continue;
      edges.writeUInt16LE(a, ne * 2); edges.writeUInt16LE(b, (ne + 1) * 2); ne += 2;
    }
    if (!ni && !ne) continue;
    const file = `${String(chunks.length).padStart(5, "0")}.bin`;
    await fs.writeFile(path.join(target, "c", file), Buffer.concat([
      verts.subarray(0, nv * 8), normals.subarray(0, nv * 4), indices.subarray(0, ni * 2), edges.subarray(0, ne * 2),
    ]));
    chunks.push({ ...c, f: file, nv, ni, ne });
    tris += ni / 3;
  }
  if (!chunks.length) throw new Error("A seleção não contém geometria convertida.");
  const out = { ...meta, chunks, tris, min: low, max: high, includedParts: [...selected].sort((a, b) => a - b) };
  await fs.writeFile(path.join(target, "chunks.json"), JSON.stringify(out));
  return { chunks: chunks.length, tris };
}

module.exports = { exportMobile };
