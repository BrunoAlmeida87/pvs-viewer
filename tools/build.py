"""Convert a Creo View PVS + OL model into the web viewer's compact format.

Output (in <out>/):
  tree.json   - assembly tree in DFS order: names, parent, part range
  items.bin   - per draw item: u32 part index, u8 r,g,b,a  (8 bytes)
  parts.bin   - per part: f32 min xyz, max xyz (24 bytes)
  chunks.json - list of chunks with bbox, item offset/count, sizes
  c/NNNNN.bin - chunk geometry: u16 x4 per vertex (x,y,z quantized over the
                chunk bbox, w = chunk-local item), followed by u16 indices.

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


def part_geometry(path):
    """Worker: load one OL file, return list of (rgba, positions f32 (n,3), indices u32 (m,3))."""
    if not os.path.exists(path):
        return []
    try:
        mesh, _ = load_ol(path)
    except Exception as exc:  # corrupt / unsupported file
        sys.stderr.write("WARN %s: %s\n" % (os.path.basename(path), exc))
        return []
    out = []
    for color, (ps, _ns, ixs) in mesh.groups.items():
        pos_list, idx_list, base = [], [], 0
        for p, ix in zip(ps, ixs):
            pos_list.append(p)
            idx_list.append(ix + base)
            base += len(p)
        P = np.concatenate(pos_list).astype(np.float32)
        I = np.concatenate(idx_list).astype(np.int64)
        q = np.round(P / WELD).astype(np.int64)
        _, first, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
        inv = inv.reshape(-1)
        P = P[first]
        I = inv[I]
        bad = (I[:, 0] == I[:, 1]) | (I[:, 1] == I[:, 2]) | (I[:, 0] == I[:, 2])
        I = I[~bad]
        if len(I) == 0:
            continue
        rgba = tuple(int(max(0, min(255, round(c * 255)))) for c in color)
        out.append((rgba, P, I.astype(np.uint32)))
    return out


def split_part(P, I):
    """Split a mesh with more than MAX_VERTS vertices into pieces that fit."""
    if len(P) <= MAX_VERTS:
        yield P, I
        return
    start = 0
    n = len(I)
    while start < n:
        used = {}
        tris = []
        k = start
        while k < n:
            t = I[k]
            new = sum(1 for v in t if v not in used)
            if len(used) + new > MAX_VERTS:
                break
            for v in t:
                if v not in used:
                    used[v] = len(used)
            tris.append([used[v] for v in t])
            k += 1
        verts = np.empty(len(used), dtype=np.int64)
        for v, j in used.items():
            verts[j] = v
        yield P[verts], np.asarray(tris, dtype=np.uint32)
        start = k


class ChunkWriter:
    def __init__(self, out_dir):
        self.dir = os.path.join(out_dir, "c")
        os.makedirs(self.dir, exist_ok=True)
        self.chunks = []
        self.items = []  # (part, rgba)
        self._reset()

    def _reset(self):
        self.pos, self.idx, self.loc = [], [], []
        self.nv = 0
        self.item_start = len(self.items)

    def add(self, part, rgba, P, I):
        for p, i in split_part(P, I):
            if self.nv + len(p) > MAX_VERTS:
                self.flush()
            local = len(self.items) - self.item_start
            self.items.append((part, rgba))
            self.pos.append(p)
            self.loc.append(np.full(len(p), local, dtype=np.uint16))
            self.idx.append(i + self.nv)
            self.nv += len(p)

    def flush(self):
        if self.nv == 0:
            return
        P = np.concatenate(self.pos)
        I = np.concatenate(self.idx).astype(np.uint16).reshape(-1)
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
            f.write(I.tobytes())
        self.chunks.append({
            "f": name, "min": [round(float(x), 5) for x in lo], "max": [round(float(x), 5) for x in hi],
            "io": self.item_start, "ic": len(self.items) - self.item_start,
            "nv": int(len(P)), "ni": int(len(I)),
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
    names, parents, part_of, ends, shapes = [], [], [], [], []
    stack = [(root, -1, False)]
    while stack:
        ci, parent, done = stack.pop()
        if done:
            ends[parent] = len(shapes)  # parent holds node index here
            continue
        node = len(names)
        c = comps[ci]
        names.append(c["name"])
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
    tree = {"names": names, "parent": parents, "p0": pstart, "p1": ends, "part": part_of,
            "partNames": [names[n] for n in range(len(names)) if part_of[n] >= 0]}
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
            for rgba, P, I in groups:
                writer.add(k, rgba, P, I)
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
    meta = {"source": os.path.basename(pvs_path), "parts": len(shapes), "items": len(writer.items),
            "tris": tris, "min": lo, "max": hi, "chunks": writer.chunks}
    with open(os.path.join(out_dir, "chunks.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"))
    print("done: %d chunks, %.1fM tris, %.0fs" % (len(writer.chunks), tris / 1e6, time.time() - t0))


if __name__ == "__main__":
    main()
