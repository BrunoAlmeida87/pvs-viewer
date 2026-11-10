// Read a converted model straight from a ZIP file (the one "Exportar modelo" writes), without
// extracting it: only the list of files at the end of the ZIP is read up front, and each file is
// then read from its own byte range. A phone opens one file much more easily than a folder.
import { inflateSync } from "../vendor/fflate.js";

const utf8 = new TextDecoder();

// Entries of a ZIP: Map of name -> { method, size, csize, offset, nameLen, extraLen }.
export async function zipEntries(file) {
  const size = file.size;
  const tailLen = Math.min(size, 65557 + 20); // end record + longest comment + ZIP64 locator
  const tail = new DataView(await file.slice(size - tailLen).arrayBuffer());
  let e = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error("O arquivo não é um ZIP válido.");
  let count = tail.getUint16(e + 10, true), cdSize = tail.getUint32(e + 12, true), cdOffset = tail.getUint32(e + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) { // ZIP64: sizes over 4 GB
    const l = e - 20;
    if (l < 0 || tail.getUint32(l, true) !== 0x07064b50) throw new Error("ZIP incompleto (índice ZIP64 ausente).");
    const at = Number(tail.getBigUint64(l + 8, true));
    const r = new DataView(await file.slice(at, at + 56).arrayBuffer());
    if (r.getUint32(0, true) !== 0x06064b50) throw new Error("ZIP incompleto (índice ZIP64 inválido).");
    count = Number(r.getBigUint64(32, true)); cdSize = Number(r.getBigUint64(40, true)); cdOffset = Number(r.getBigUint64(48, true));
  }
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const bytes = new Uint8Array(cd.buffer);
  const out = new Map();
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error("ZIP corrompido (lista de arquivos).");
    const method = cd.getUint16(p + 10, true);
    let csize = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true), offset = cd.getUint32(p + 42, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, "/");
    // ZIP64 extra field: the 64-bit values of the fields that overflowed, in this order
    for (let x = p + 46 + nameLen, end = x + extraLen; x + 4 <= end;) {
      const id = cd.getUint16(x, true), len = cd.getUint16(x + 2, true);
      if (id === 1) {
        let y = x + 4;
        if (usize === 0xffffffff) { usize = Number(cd.getBigUint64(y, true)); y += 8; }
        if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(y, true)); y += 8; }
        if (offset === 0xffffffff) offset = Number(cd.getBigUint64(y, true));
      }
      x += 4 + len;
    }
    if (!name.endsWith("/")) out.set(name, { method, size: usize, csize, offset, nameLen, extraLen });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Bytes of one entry (ArrayBuffer). One read covers the local header and the data.
export async function zipRead(file, en) {
  const guess = 30 + en.nameLen + en.extraLen + 64;
  let buf = await file.slice(en.offset, en.offset + guess + en.csize).arrayBuffer();
  const dv = new DataView(buf);
  if (buf.byteLength < 30 || dv.getUint32(0, true) !== 0x04034b50) throw new Error("ZIP corrompido (cabeçalho de arquivo).");
  const start = 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
  if (start + en.csize > buf.byteLength) { // unusually long local header: read the data on its own
    buf = await file.slice(en.offset + start, en.offset + start + en.csize).arrayBuffer();
    return unpack(new Uint8Array(buf), en);
  }
  return unpack(new Uint8Array(buf, start, en.csize), en);
}

function unpack(data, en) {
  if (en.method === 0) return data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer;
  if (en.method === 8) { const out = inflateSync(data, { out: new Uint8Array(en.size) }); return out.buffer; }
  throw new Error("ZIP com um método de compressão não suportado.");
}

// A model source ({json, buf}, like the folder ones) over a ZIP that holds a converted model.
// The model may be at the top of the ZIP or inside one folder.
export async function zipConverted(file) {
  const entries = await zipEntries(file);
  const meta = [...entries.keys()].filter((k) => k === "chunks.json" || k.endsWith("/chunks.json")).sort((a, b) => a.length - b.length)[0];
  if (meta === undefined) {
    const raw = [...entries.keys()].some((k) => k.toLowerCase().endsWith(".pvs"));
    throw new Error(raw
      ? "Este ZIP tem o modelo original (.pvs + .ol). Extraia-o e abra a pasta, ou exporte o modelo pelo visualizador para ter um ZIP que abre direto."
      : "O ZIP não tem um modelo convertido (chunks.json).");
  }
  const prefix = meta.slice(0, -"chunks.json".length);
  const read = async (n) => {
    const en = entries.get(prefix + n);
    if (!en) throw new Error("arquivo ausente no ZIP: " + n);
    return zipRead(file, en);
  };
  return { json: async (n) => JSON.parse(utf8.decode(await read(n))), buf: read };
}
