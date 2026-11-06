// Geometry helpers for measuring and analysis: triangle BVH, point-triangle distance, minimum
// distance and intersection between two meshes, circle fit, volume. Pure functions (no DOM),
// used by the page and by geomworker.js. Meshes are {pos: Float32Array xyz, idx: Uint32Array}.

// ------------------------------------------------------------------ BVH
// Flat bounding volume hierarchy over triangles. node i: box[6i..6i+5], left[i] (-1 for leaves),
// right[i], start[i] / count[i] into `tri` (triangle numbers).
export function buildBVH(mesh) {
  const { pos, idx } = mesh;
  const nt = idx.length / 3;
  const cx = new Float32Array(nt * 3), tb = new Float32Array(nt * 6);
  for (let t = 0; t < nt; t++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k] * 3, x = pos[v], y = pos[v + 1], z = pos[v + 2];
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
      if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
    }
    tb.set([x0, y0, z0, x1, y1, z1], t * 6);
    cx[t * 3] = (x0 + x1) / 2; cx[t * 3 + 1] = (y0 + y1) / 2; cx[t * 3 + 2] = (z0 + z1) / 2;
  }
  const tri = new Uint32Array(nt);
  for (let t = 0; t < nt; t++) tri[t] = t;
  const maxNodes = 2 * nt + 1;
  const box = new Float32Array(maxNodes * 6), left = new Int32Array(maxNodes), right = new Int32Array(maxNodes);
  const start = new Int32Array(maxNodes), count = new Int32Array(maxNodes);
  let nn = 0;
  const stack = [[0, nt, nn++]];
  while (stack.length) {
    const [s, e, n] = stack.pop();
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let c0 = [Infinity, Infinity, Infinity], c1 = [-Infinity, -Infinity, -Infinity];
    for (let i = s; i < e; i++) {
      const t = tri[i] * 6;
      if (tb[t] < x0) x0 = tb[t]; if (tb[t + 1] < y0) y0 = tb[t + 1]; if (tb[t + 2] < z0) z0 = tb[t + 2];
      if (tb[t + 3] > x1) x1 = tb[t + 3]; if (tb[t + 4] > y1) y1 = tb[t + 4]; if (tb[t + 5] > z1) z1 = tb[t + 5];
      for (let a = 0; a < 3; a++) { const c = cx[tri[i] * 3 + a]; if (c < c0[a]) c0[a] = c; if (c > c1[a]) c1[a] = c; }
    }
    box.set([x0, y0, z0, x1, y1, z1], n * 6);
    if (e - s <= 4) { left[n] = -1; start[n] = s; count[n] = e - s; continue; }
    let ax = 0;
    for (let a = 1; a < 3; a++) if (c1[a] - c0[a] > c1[ax] - c0[ax]) ax = a;
    const mid = (c0[ax] + c1[ax]) / 2;
    let i = s, j = e - 1;
    while (i <= j) {
      if (cx[tri[i] * 3 + ax] < mid) i++;
      else { const t = tri[i]; tri[i] = tri[j]; tri[j] = t; j--; }
    }
    if (i === s || i === e) i = (s + e) >> 1;
    const l = nn++, r = nn++;
    left[n] = l; right[n] = r;
    stack.push([s, i, l], [i, e, r]);
  }
  return { box, left, right, start, count, tri, mesh };
}

function boxDist2(b, o, x, y, z) {
  const dx = Math.max(b[o] - x, 0, x - b[o + 3]);
  const dy = Math.max(b[o + 1] - y, 0, y - b[o + 4]);
  const dz = Math.max(b[o + 2] - z, 0, z - b[o + 5]);
  return dx * dx + dy * dy + dz * dz;
}

// ------------------------------------------------------------------ point - triangle
// Closest point on triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5).
export function closestOnTriangle(p, a, b, c, out) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const set = (q, s = 0, u = null, t = 0, w = null) => {
    out[0] = q[0] + (u ? u[0] * s : 0) + (w ? w[0] * t : 0);
    out[1] = q[1] + (u ? u[1] * s : 0) + (w ? w[1] * t : 0);
    out[2] = q[2] + (u ? u[2] * s : 0) + (w ? w[2] * t : 0);
    return out;
  };
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return set(a);
  const bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return set(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return set(a, d1 / (d1 - d3), ab);
  const cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return set(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return set(a, d2 / (d2 - d6), ac);
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return set(b, w, [c[0] - b[0], c[1] - b[1], c[2] - b[2]]);
  }
  const den = 1 / (va + vb + vc);
  return set(a, vb * den, ab, vc * den, ac);
}

const V = (pos, i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];

// Nearest point of the BVH mesh to p, searching only closer than sqrt(best.d2).
function nearest(bvh, p, best) {
  const { box, left, right, start, count, tri, mesh } = bvh;
  const { pos, idx } = mesh;
  const q = [0, 0, 0];
  const stack = [0];
  while (stack.length) {
    const n = stack.pop();
    if (boxDist2(box, n * 6, p[0], p[1], p[2]) >= best.d2) continue;
    if (left[n] < 0) {
      for (let i = start[n]; i < start[n] + count[n]; i++) {
        const t = tri[i] * 3;
        closestOnTriangle(p, V(pos, idx[t]), V(pos, idx[t + 1]), V(pos, idx[t + 2]), q);
        const d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
        if (d2 < best.d2) { best.d2 = d2; best.q = q.slice(); best.p = p.slice(); }
      }
    } else {
      const l = left[n], r = right[n];
      const dl = boxDist2(box, l * 6, p[0], p[1], p[2]), dr = boxDist2(box, r * 6, p[0], p[1], p[2]);
      if (dl < dr) stack.push(r, l); else stack.push(l, r);
    }
  }
  return best;
}

// Sample points of a mesh: vertices, triangle centroids and edge midpoints.
function samples(mesh) {
  const { pos, idx } = mesh;
  const nv = pos.length / 3, nt = idx.length / 3;
  const out = new Float32Array((nv + nt * 4) * 3);
  out.set(pos);
  let o = pos.length;
  for (let t = 0; t < nt; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    for (let k = 0; k < 3; k++) {
      out[o + k] = (pos[a + k] + pos[b + k] + pos[c + k]) / 3;
      out[o + 3 + k] = (pos[a + k] + pos[b + k]) / 2;
      out[o + 6 + k] = (pos[b + k] + pos[c + k]) / 2;
      out[o + 9 + k] = (pos[c + k] + pos[a + k]) / 2;
    }
    o += 12;
  }
  return out;
}

// Minimum distance between two meshes (sampled both ways; exact for vertex-face contacts,
// within a fraction of the facet size otherwise). Returns {d, pa, pb}.
export function minDistance(A, B, bvhA, bvhB, limit = Infinity) {
  bvhA = bvhA || buildBVH(A);
  bvhB = bvhB || buildBVH(B);
  const best = { d2: limit * limit, p: null, q: null };
  let swap = false;
  for (const [src, dst, flip] of [[A, bvhB, false], [B, bvhA, true]]) {
    const S = samples(src);
    for (let i = 0; i < S.length; i += 3) {
      const before = best.d2;
      nearest(dst, [S[i], S[i + 1], S[i + 2]], best);
      if (best.d2 < before) swap = flip;
      if (best.d2 === 0) break;
    }
  }
  if (!best.p) return { d: Infinity, pa: null, pb: null };
  return { d: Math.sqrt(best.d2), pa: swap ? best.q : best.p, pb: swap ? best.p : best.q };
}

// ------------------------------------------------------------------ intersection
// Segment pq crosses triangle abc (Möller–Trumbore, 0 < t < 1).
function segTri(p, q, a, b, c) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
  if (Math.abs(det) < 1e-14) return false;
  const f = 1 / det;
  const s = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
  if (u < -1e-9 || u > 1 + 1e-9) return false;
  const qq = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = f * (d[0] * qq[0] + d[1] * qq[1] + d[2] * qq[2]);
  if (v < -1e-9 || u + v > 1 + 1e-9) return false;
  const t = f * (e2[0] * qq[0] + e2[1] * qq[1] + e2[2] * qq[2]);
  return t > 1e-7 && t < 1 - 1e-7;
}

function triTri(A, ta, B, tb) {
  const a = [V(A.pos, A.idx[ta]), V(A.pos, A.idx[ta + 1]), V(A.pos, A.idx[ta + 2])];
  const b = [V(B.pos, B.idx[tb]), V(B.pos, B.idx[tb + 1]), V(B.pos, B.idx[tb + 2])];
  for (let k = 0; k < 3; k++) {
    if (segTri(a[k], a[(k + 1) % 3], b[0], b[1], b[2])) return true;
    if (segTri(b[k], b[(k + 1) % 3], a[0], a[1], a[2])) return true;
  }
  return false;
}

function overlap(b1, o1, b2, o2, tol) {
  return b1[o1] <= b2[o2 + 3] + tol && b2[o2] <= b1[o1 + 3] + tol &&
    b1[o1 + 1] <= b2[o2 + 4] + tol && b2[o2 + 1] <= b1[o1 + 4] + tol &&
    b1[o1 + 2] <= b2[o2 + 5] + tol && b2[o2 + 2] <= b1[o1 + 5] + tol;
}

// Do the surfaces of two meshes cross? Returns the number of crossing triangle pairs (capped).
export function intersections(bvhA, bvhB, cap = 50) {
  const A = bvhA.mesh, B = bvhB.mesh;
  let found = 0;
  const stack = [[0, 0]];
  while (stack.length && found < cap) {
    const [m, n] = stack.pop();
    if (!overlap(bvhA.box, m * 6, bvhB.box, n * 6, 0)) continue;
    const la = bvhA.left[m] < 0, lb = bvhB.left[n] < 0;
    if (la && lb) {
      for (let i = bvhA.start[m]; i < bvhA.start[m] + bvhA.count[m]; i++)
        for (let j = bvhB.start[n]; j < bvhB.start[n] + bvhB.count[n]; j++)
          if (triTri(A, bvhA.tri[i] * 3, B, bvhB.tri[j] * 3)) found++;
    } else if (lb || (!la && boxVol(bvhA.box, m) > boxVol(bvhB.box, n))) {
      stack.push([bvhA.left[m], n], [bvhA.right[m], n]); // split the larger node
    } else {
      stack.push([m, bvhB.left[n]], [m, bvhB.right[n]]);
    }
  }
  return found;
}
function boxVol(b, n) { const o = n * 6; return (b[o + 3] - b[o]) * (b[o + 4] - b[o + 1]) * (b[o + 5] - b[o + 2]); }

// ------------------------------------------------------------------ volume
// Volume enclosed by a closed, outward-oriented mesh (m³ when positions are in metres).
export function volume(mesh) {
  const { pos, idx } = mesh;
  let v = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
      - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
      + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return v / 6;
}

// ------------------------------------------------------------------ edges and circles
// Chains of edge segments (vertex lists) split where a vertex does not have exactly two segments.
export function edgeChains(edges) {
  const adj = new Map();
  const add = (a, b, s) => { let l = adj.get(a); if (!l) adj.set(a, (l = [])); l.push([b, s]); };
  const ns = edges.length / 2;
  for (let s = 0; s < ns; s++) { add(edges[2 * s], edges[2 * s + 1], s); add(edges[2 * s + 1], edges[2 * s], s); }
  const used = new Uint8Array(ns), chains = [];
  const walk = (v, s0) => {
    const chain = [v];
    let s = s0, cur = v;
    for (;;) {
      used[s] = 1;
      const nxt = edges[2 * s] === cur ? edges[2 * s + 1] : edges[2 * s];
      chain.push(nxt);
      cur = nxt;
      const l = adj.get(cur);
      if (l.length !== 2) break;
      const next = l[0][1] === s ? l[1] : l[0];
      if (used[next[1]]) break;
      s = next[1];
    }
    return chain;
  };
  for (const [v, l] of adj) if (l.length !== 2) for (const [, s] of l) if (!used[s]) chains.push(walk(v, s));
  for (let s = 0; s < ns; s++) if (!used[s]) chains.push(walk(edges[2 * s], s));
  return chains;
}

// Least-squares circle through 3D points: plane from the polygon normal, then an algebraic
// (Kåsa) fit in that plane. Returns {center, radius, normal, rms} or null.
export function fitCircle(pts) {
  const n = pts.length;
  if (n < 3) return null;
  const c = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] += p[k] / n;
  const N = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const u = [a[0] - c[0], a[1] - c[1], a[2] - c[2]], v = [b[0] - c[0], b[1] - c[1], b[2] - c[2]];
    N[0] += u[1] * v[2] - u[2] * v[1]; N[1] += u[2] * v[0] - u[0] * v[2]; N[2] += u[0] * v[1] - u[1] * v[0];
  }
  let ln = Math.hypot(...N);
  if (ln < 1e-12) return null;
  for (let k = 0; k < 3; k++) N[k] /= ln;
  const t = Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const U = [N[1] * t[2] - N[2] * t[1], N[2] * t[0] - N[0] * t[2], N[0] * t[1] - N[1] * t[0]];
  ln = Math.hypot(...U);
  for (let k = 0; k < 3; k++) U[k] /= ln;
  const W = [N[1] * U[2] - N[2] * U[1], N[2] * U[0] - N[0] * U[2], N[0] * U[1] - N[1] * U[0]];
  // normal equations for x² + y² + D x + E y + F = 0
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
  const xy = pts.map((p) => {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return [d[0] * U[0] + d[1] * U[1] + d[2] * U[2], d[0] * W[0] + d[1] * W[1] + d[2] * W[2]];
  });
  for (const [x, y] of xy) {
    const row = [x, y, 1], z = -(x * x + y * y);
    for (let i = 0; i < 3; i++) { r[i] += row[i] * z; for (let j = 0; j < 3; j++) M[i][j] += row[i] * row[j]; }
  }
  const sol = solve3(M, r);
  if (!sol) return null;
  const [D, E, F] = sol;
  const cx = -D / 2, cy = -E / 2, rad2 = cx * cx + cy * cy - F;
  if (!(rad2 > 0)) return null;
  const radius = Math.sqrt(rad2);
  let err = 0;
  for (const [x, y] of xy) err += (Math.hypot(x - cx, y - cy) - radius) ** 2;
  const center = [c[0] + U[0] * cx + W[0] * cy, c[1] + U[1] * cx + W[1] * cy, c[2] + U[2] * cx + W[2] * cy];
  return { center, radius, normal: N, u: U, w: W, rms: Math.sqrt(err / n) };
}

function solve3(M, r) {
  const A = M.map((row, i) => [...row, r[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
    if (Math.abs(A[p][i]) < 1e-18) return null;
    [A[i], A[p]] = [A[p], A[i]];
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const f = A[k][i] / A[i][i];
      for (let j = i; j < 4; j++) A[k][j] -= f * A[i][j];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

// Closest point to p on segment ab, and its squared distance.
export function closestOnSegment(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  let t = l2 > 0 ? ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const q = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  return { q, d2: (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2 };
}
