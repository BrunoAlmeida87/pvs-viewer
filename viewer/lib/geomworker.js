// Web worker for the heavier geometry checks (minimum distance, interference), so the page does
// not freeze. Meshes are sent once and kept here with their BVH.
//
// In:  {type:"mesh", key, pos, idx}
//      {type:"pair", id, a, b, limit}   -> {type:"pair", id, crossings, d, pa, pb}
//      {type:"forget"}                  (drop the cache)
import { buildBVH, minDistance, intersections } from "./geom.js";

// First in, first out (geomclient.js mirrors this to know which meshes are still here).
const cache = new Map();
export const MAX = 600;

function get(key) {
  const m = cache.get(key);
  if (!m) return null;
  if (!m.bvh) m.bvh = buildBVH(m);
  return m;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "mesh") {
    cache.set(m.key, { pos: m.pos, idx: m.idx, bvh: null });
    while (cache.size > MAX) cache.delete(cache.keys().next().value);
  } else if (m.type === "forget") {
    cache.clear();
  } else if (m.type === "pair") {
    try {
      const A = get(m.a), B = get(m.b);
      if (!A || !B || !A.idx.length || !B.idx.length) { self.postMessage({ type: "pair", id: m.id, crossings: 0, d: Infinity }); return; }
      const crossings = intersections(A.bvh, B.bvh, 20);
      if (crossings) { self.postMessage({ type: "pair", id: m.id, crossings, d: 0 }); return; }
      const r = minDistance(A, B, A.bvh, B.bvh, m.limit ?? Infinity);
      self.postMessage({ type: "pair", id: m.id, crossings: 0, d: r.d, pa: r.pa, pb: r.pb });
    } catch (err) {
      self.postMessage({ type: "pair", id: m.id, error: String(err && err.message || err) });
    }
  }
};
