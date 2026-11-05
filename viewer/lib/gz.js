// gzip helpers shared by the page and the workers.
import { inflateSync } from "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js";

const MAX_MEMBER = 1 << 30;

// Decompress one gzip member occupying exactly u8[s, e).
export function gunzipMember(u8, s, e) {
  if (u8[s] !== 0x1f || u8[s + 1] !== 0x8b) throw new Error("not gzip");
  const flg = u8[s + 3];
  let p = s + 10;
  if (flg & 4) p += 2 + (u8[p] | (u8[p + 1] << 8));
  if (flg & 8) while (u8[p++]);
  if (flg & 16) while (u8[p++]);
  if (flg & 2) p += 2;
  const isize = (u8[e - 4] | (u8[e - 3] << 8) | (u8[e - 2] << 16) | (u8[e - 1] << 24)) >>> 0;
  if (isize > MAX_MEMBER) throw new Error("bad gzip size");
  const out = inflateSync(u8.subarray(p, e - 8), { out: new Uint8Array(isize) });
  if (out.length !== isize) throw new Error("gzip size mismatch");
  return out;
}

// Decompress concatenated gzip members starting at `start`.  Member boundaries are
// found by the header signature (CM=8, FLG=0, MTIME=0) and validated by decoding.
export function gunzipAll(u8, start) {
  const cand = [];
  for (let i = start; i <= u8.length - 8; i++) {
    if (u8[i] === 0x1f && u8[i + 1] === 0x8b && u8[i + 2] === 8 && u8[i + 3] === 0 &&
        u8[i + 4] === 0 && u8[i + 5] === 0 && u8[i + 6] === 0 && u8[i + 7] === 0) cand.push(i);
  }
  cand.push(u8.length);
  const parts = [];
  let s = 0;
  while (s < cand.length - 1) {
    let e = s + 1, out = null;
    for (; e < cand.length; e++) {
      try { out = gunzipMember(u8, cand[s], cand[e]); break; } catch { /* boundary was a false match */ }
    }
    if (!out) throw new Error("corrupt gzip data at " + cand[s]);
    parts.push(out);
    s = e;
  }
  let n = 0;
  for (const p of parts) n += p.length;
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return all;
}
