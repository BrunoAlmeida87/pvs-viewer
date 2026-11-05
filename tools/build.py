"""Convert a Creo View PVS + OL model into the web viewer's compact format.

Output (in <out>/):
  tree.json   - assembly tree in DFS order: names, parent, part range,
                properties (keys/vals tables + per-node pairs) and thumbnail names
  items.bin   - per draw item: u32 part index, u8 r,g,b,a  (8 bytes)
  parts.bin   - per part: f32 min xyz, max xyz (24 bytes)
  chunks.json - list of chunks with bbox, item offset/count, sizes
  c/NNNNN.bin - chunk geometry: u16 x4 per vertex (x,y,z quantized over the
                chunk bbox, w = chunk-local item), i8 x4 per vertex (normal * 127, 0),
                u16 triangle indices, u16 edge index pairs (CAD edges).

Usage: python build.py <model.pvs> <out_dir> [workers]
"""
import json
import os
import struct
import sys
import time
from multiprocessing import Pool

import numpy as np

from ol import load_ol
from pvs import PVS

MAX_VERTS = 65535
WELD = 1e-4  # metres: positions closer than this are merged within a part


def _match_positions(P, N, q, pts):
    """Index of a vertex at the same position as each point; points with no match become new
    vertices (welded among themselves, without a normal). Returns P, N, q, indices."""
    qe = np.round(pts / WELD).astype(np.int64)
    nv = len(P)
    _, inv = np.unique(np.vstack([q, qe]), axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    first = np.full(inv.max() + 1, -1, dtype=np.int64)
    first[inv[:nv][::-1]] = np.arange(nv)[::-1]
    ids = inv[nv:]
    m = first[ids]
    miss = m < 0
    if miss.any():
        u, where = np.unique(ids[miss], return_index=True)
        extra = np.full(len(first), -1, dtype=np.int64)
        extra[u] = nv + np.arange(len(u))
        m[miss] = extra[ids[miss]]
        src = np.nonzero(miss)[0][where]
        P = np.vstack([P, pts[src]])
        N = np.vstack([N, np.zeros((len(u), 4), dtype=np.int8)])
        q = np.vstack([q, qe[src]])
    return P, N, q, m


def _weld_group(ps, ns, ixs):
    """Merge the pools of one colour group. Curved faces weld by position + normal; planar faces
    (all normals equal) carry no normal and weld by position with any vertex already there; the
    shader falls back to flat shading where a borrowed normal disagrees with the face."""
    curved = [k for k, n in enumerate(ns) if n is not None and not (n @ n[0] >= 0.9998).all()]
    flat = [k for k in range(len(ps)) if k not in set(curved)]

    def cat(ks):
        pos, idx, base = [], [], 0
        for k in ks:
            pos.append(ps[k])
            idx.append(ixs[k].astype(np.int64) + base)
            base += len(ps[k])
        if not ks:
            return np.zeros((0, 3), np.float32), np.zeros((0, 3), np.int64)
        return np.concatenate(pos).astype(np.float32), np.concatenate(idx)

    Pc, Ic = cat(curved)
    if len(Pc):
        nc = np.concatenate([ns[k] for k in curved])
        ln = np.linalg.norm(nc, axis=1, keepdims=True)
        ln[ln == 0] = 1
        nq = np.round(nc / ln * 127).astype(np.int64)
        qc = np.round(Pc / WELD).astype(np.int64)
        _, first, inv = np.unique(np.hstack([qc, nq]), axis=0, return_index=True, return_inverse=True)
        Ic = inv.reshape(-1)[Ic]
        P, q = Pc[first], qc[first]
        N = np.zeros((len(first), 4), dtype=np.int8)
        N[:, :3] = nq[first]
    else:
        P, q, N = Pc, np.zeros((0, 3), np.int64), np.zeros((0, 4), np.int8)
    Pf, If = cat(flat)
    if len(Pf):
        P, N, q, m = _match_positions(P, N, q, Pf)
        If = m[If]
    I = np.vstack([Ic, If])
    bad = (I[:, 0] == I[:, 1]) | (I[:, 1] == I[:, 2]) | (I[:, 0] == I[:, 2])
    return P, N, q, I[~bad]


def _attach_edges(P, N, q, edges):
    """Edges as index pairs into the vertices (new vertices for points off the mesh)."""
    pts, segs = edges
    P, N, q, m = _match_positions(P, N, q, pts)
    E = m[segs.astype(np.int64)]
    return P, N, E[E[:, 0] != E[:, 1]]


def part_geometry(path):
    """Worker: load one OL file, return list of (rgba, positions f32 (n,3), normals i8 (n,4),
    indices (m,3), edges (k,2) or None)."""
    if not os.path.exists(path):
        return []
    try:
        mesh, _ = load_ol(path, with_edges=True)
    except Exception as exc:  # corrupt / unsupported file
        sys.stderr.write("WARN %s: %s\n" % (os.path.basename(path), exc))
        return []
    groups = list(mesh.groups.items())
    big = max(range(len(groups)), key=lambda g: sum(len(i) for i in groups[g][1][2])) if groups else -1
    out = []
    for gi, (color, (ps, ns, ixs)) in enumerate(groups):
        P, N, q, I = _weld_group(ps, ns, ixs)
        if len(I) == 0:
            continue
        E = None
        if gi == big and mesh.edges is not None:
            P, N, E = _attach_edges(P, N, q, mesh.edges)
        rgba = tuple(int(max(0, min(255, round(c * 255)))) for c in color)
        out.append((rgba, P, N, I.astype(np.uint32), E))
    return out


def split_part(P, N, I, E):
    """Split a mesh with more than MAX_VERTS vertices into pieces that fit. Each edge goes to the
    piece holding one of its ends (the other end is copied there if needed)."""
    if len(P) <= MAX_VERTS:
        yield P, N, I, E
        return
    piece = {}
    pieces = []

    def new_piece():
        pieces.append({"used": {}, "tris": [], "edges": []})
        return len(pieces) - 1

    def put(pi, v):
        used = pieces[pi]["used"]
        if v in used:
            piece[v] = pi
            return used[v]
        if len(used) >= MAX_VERTS:
            return -1
        used[v] = len(used)
        piece[v] = pi
        return used[v]

    cur = new_piece()
    for t in I.tolist():
        used = pieces[cur]["used"]
        if len(used) + sum(1 for v in t if v not in used) > MAX_VERTS:
            cur = new_piece()
        pieces[cur]["tris"].append([put(cur, v) for v in t])
    if E is not None:
        spill = -1
        for a, b in E.tolist():
            pi = piece.get(a, piece.get(b, len(pieces) - 1))
            la = put(pi, a)
            lb = put(pi, b) if la >= 0 else -1
            if la < 0 or lb < 0:
                if spill < 0 or len(pieces[spill]["used"]) + 2 > MAX_VERTS:
                    spill = new_piece()
                pi = spill
                la, lb = put(pi, a), put(pi, b)
            pieces[pi]["edges"].append([la, lb])
    for pc in pieces:
        if not pc["used"]:
            continue
        verts = np.empty(len(pc["used"]), dtype=np.int64)
        for v, j in pc["used"].items():
            verts[j] = v
        T = np.asarray(pc["tris"], dtype=np.uint32).reshape(-1, 3)
        Ep = np.asarray(pc["edges"], dtype=np.uint32).reshape(-1, 2) if pc["edges"] else None
        yield P[verts], N[verts], T, Ep


class ChunkWriter:
    def __init__(self, out_dir):
        self.dir = os.path.join(out_dir, "c")
        os.makedirs(self.dir, exist_ok=True)
        self.chunks = []
        self.items = []  # (part, rgba)
        self._reset()

    def _reset(self):
        self.pos, self.nrm, self.idx, self.edges, self.loc = [], [], [], [], []
        self.nv = 0
        self.item_start = len(self.items)

    def add(self, part, rgba, P, N, I, E):
        for p, n, i, e in split_part(P, N, I, E):
            if self.nv + len(p) > MAX_VERTS:
                self.flush()
            local = len(self.items) - self.item_start
            self.items.append((part, rgba))
            self.pos.append(p)
            self.nrm.append(n)
            self.loc.append(np.full(len(p), local, dtype=np.uint16))
            self.idx.append(i.astype(np.int64) + self.nv)
            if e is not None and len(e):
                self.edges.append(e.astype(np.int64) + self.nv)
            self.nv += len(p)

    def flush(self):
        if self.nv == 0:
            return
        P = np.concatenate(self.pos)
        Nn = np.concatenate(self.nrm).astype(np.int8)
        I = np.concatenate(self.idx).astype(np.uint16).reshape(-1)
        E = np.concatenate(self.edges).astype(np.uint16).reshape(-1) if self.edges else np.zeros(0, np.uint16)
        L = np.concatenate(self.loc)
        lo = P.min(0).astype(np.float64)
        hi = P.max(0).astype(np.float64)
        ext = np.maximum(hi - lo, 1e-6)
        Q = np.round((P - lo) / ext * 65535.0).clip(0, 65535).astype(np.uint16)
        V = np.empty((len(P), 4), dtype=np.uint16)
        V[:, :3] = Q
        V[:, 3] = L
        n = len(self.chunks)
        name = "%05d.bin" % n
        with open(os.path.join(self.dir, name), "wb") as f:
            f.write(V.tobytes())
            f.write(Nn.tobytes())
            f.write(I.tobytes())
            f.write(E.tobytes())
        self.chunks.append({
            "f": name, "min": [round(float(x), 5) for x in lo], "max": [round(float(x), 5) for x in hi],
            "io": self.item_start, "ic": len(self.items) - self.item_start,
            "nv": int(len(P)), "ni": int(len(I)), "ne": int(len(E)),
        })
        self._reset()


def main():
    pvs_path, out_dir = sys.argv[1], sys.argv[2]
    workers = int(sys.argv[3]) if len(sys.argv) > 3 else max(1, (os.cpu_count() or 2) - 1)
    base = os.path.dirname(os.path.abspath(pvs_path))
    os.makedirs(out_dir, exist_ok=True)
    t0 = time.time()
    model = PVS(pvs_path)
    comps = model.components
    root = model.roots()[0]
    print("structure: %d components, %.1fs" % (len(comps), time.time() - t0), flush=True)

    # DFS: tree nodes + parts in order
    names, parents, part_of, ends, shapes, node_comp = [], [], [], [], [], []
    stack = [(root, -1, False)]
    while stack:
        ci, parent, done = stack.pop()
        if done:
            ends[parent] = len(shapes)  # parent holds node index here
            continue
        node = len(names)
        c = comps[ci]
        names.append(c["name"])
        node_comp.append(ci)
        parents.append(parent)
        ends.append(0)
        if c["shape"]:
            part_of.append(len(shapes))
            shapes.append(c["shape"])
        else:
            part_of.append(-1)
        stack.append((ci, node, True))
        for inst in reversed(c["children"]):
            stack.append((inst["comp"], node, False))
    # a node's parts are the contiguous range [p0, p1) of DFS-ordered parts
    pstart = [0] * len(names)
    running = 0
    for n in range(len(names)):
        pstart[n] = running
        if part_of[n] >= 0:
            running += 1
    # properties: keys / unique values tables + flat (key, value) pairs per node
    keys, key_ix, vals, val_ix = [], {}, [], {}
    kv_start, pkv, thumbs = [0], [], []
    for ci in node_comp:
        c = comps[ci]
        for k, v in c.get("props", {}).items():
            if k not in key_ix:
                key_ix[k] = len(keys)
                keys.append(k)
            if v not in val_ix:
                val_ix[v] = len(vals)
                vals.append(v)
            pkv += [key_ix[k], val_ix[v]]
        kv_start.append(len(pkv) // 2)
        thumbs.append(c.get("thumb") or "")
    tree = {"names": names, "parent": parents, "p0": pstart, "p1": ends, "part": part_of,
            "props": {"keys": keys, "vals": vals, "start": kv_start, "kv": pkv}, "thumbs": thumbs, "shapes": shapes}
    with open(os.path.join(out_dir, "tree.json"), "w", encoding="utf-8") as f:
        json.dump(tree, f, ensure_ascii=False, separators=(",", ":"))
    print("tree: %d nodes, %d parts" % (len(names), len(shapes)), flush=True)

    writer = ChunkWriter(out_dir)
    pbox = np.zeros((len(shapes), 6), dtype=np.float32)
    pbox[:, :3] = np.inf
    pbox[:, 3:] = -np.inf
    paths = [os.path.join(base, s) for s in shapes]
    limit = int(os.environ.get("BUILD_LIMIT", "0"))
    if limit:
        paths = paths[:limit]
    tris = 0
    t1 = time.time()
    with Pool(workers) as pool:
        for k, groups in enumerate(pool.imap(part_geometry, paths, chunksize=16)):
            for rgba, P, N, I, E in groups:
                writer.add(k, rgba, P, N, I, E)
                tris += len(I)
                pbox[k, :3] = np.minimum(pbox[k, :3], P.min(0))
                pbox[k, 3:] = np.maximum(pbox[k, 3:], P.max(0))
            if k % 2000 == 0:
                el = time.time() - t1
                print("  %d/%d parts, %.1fM tris, %d chunks, %.0fs" % (k, len(paths), tris / 1e6, len(writer.chunks), el), flush=True)
    writer.flush()

    items = np.zeros(len(writer.items), dtype=[("p", "<u4"), ("c", "u1", 4)])
    for i, (p, c) in enumerate(writer.items):
        items[i] = (p, c)
    with open(os.path.join(out_dir, "items.bin"), "wb") as f:
        f.write(items.tobytes())
    pbox[~np.isfinite(pbox)] = 0
    with open(os.path.join(out_dir, "parts.bin"), "wb") as f:
        f.write(pbox.tobytes())
    lo = np.min([c["min"] for c in writer.chunks], axis=0).tolist()
    hi = np.max([c["max"] for c in writer.chunks], axis=0).tolist()
    meta = {"format": 2, "source": os.path.basename(pvs_path), "parts": len(shapes), "items": len(writer.items),
            "tris": tris, "min": lo, "max": hi, "chunks": writer.chunks}
    with open(os.path.join(out_dir, "chunks.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    print("done: %d chunks, %.1fM tris, %.0fs" % (len(writer.chunks), tris / 1e6, time.time() - t0))


if __name__ == "__main__":
    main()
