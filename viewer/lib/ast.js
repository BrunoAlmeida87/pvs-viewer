// Reader for Creo View annotation sets / figures (ann*.ast, "EMK V7.0"), recovered from the SBR
// files:
//   u32 14, "!/EMK V7.0  !/", u32 0, u32 n + name, ..., u32 size + "\n"-separated component paths,
//   u32 1, "1", BA BA BA BA, then one gzip member up to the end of the file.
// The gzip data has a camera header and one record per component:
//   0x96 u32 len path, u32 index, then flag bytes up to 0xCA:
//   0x9A shown, 0x9D/0x9C appearance override, 0x97 colour (3 x f32), 0xAF opacity (f32).
// A path is "/@@PV-AUTO-ID@@006/@@PV-AUTO-ID@@001/..." = child numbers from the root assembly.
// Components that are not listed are hidden in the figure.
import { gunzipMember } from "./gz.js";

export function parseAST(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  const magic = new TextDecoder("latin1").decode(u8.subarray(4, 18));
  if (!magic.startsWith("!/EMK")) throw new Error("não é um arquivo de figura do Creo View");
  const nl = dv.getUint32(22, true);
  const name = new TextDecoder().decode(u8.subarray(26, 26 + Math.min(nl, 200)));
  let g = -1;
  for (let i = 26; i < u8.length - 6; i++) {
    if (u8[i] === 0xba && u8[i + 1] === 0xba && u8[i + 2] === 0xba && u8[i + 3] === 0xba && u8[i + 4] === 0x1f && u8[i + 5] === 0x8b) { g = i + 4; break; }
  }
  if (g < 0) throw new Error("dados da figura não encontrados");
  const out = gunzipMember(u8, g, u8.length);
  const od = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let p = 0;
  while (p < out.length - 6 && !(out[p] === 0x96 && out[p + 5] === 0x2f)) p++;
  const records = [];
  const td = new TextDecoder("latin1");
  while (p < out.length - 5 && out[p] === 0x96) {
    const L = od.getUint32(p + 1, true);
    if (L <= 0 || L > 4096 || p + 5 + L + 4 > out.length) break;
    const text = td.decode(out.subarray(p + 5, p + 5 + L));
    let q = p + 5 + L + 4;
    let color = null, opacity = null, shown = false, ok = true;
    while (q < out.length && out[q] !== 0xca) {
      const t = out[q++];
      if (t === 0x97) { color = [od.getFloat32(q, true), od.getFloat32(q + 4, true), od.getFloat32(q + 8, true)]; q += 12; }
      else if (t === 0xaf) { opacity = od.getFloat32(q, true); q += 4; }
      else if (t === 0x9a) shown = true;
      else if (t >= 0x98 && t <= 0x9e) { /* other flags */ }
      else { ok = false; break; }
    }
    if (!ok) break;
    q++;
    const path = text.split("/").filter(Boolean).map((s) => parseInt(s.replace(/^.*@@/, ""), 10));
    if (path.every((x) => Number.isFinite(x))) records.push({ path, color, opacity, shown });
    p = q;
  }
  return { name, records };
}
