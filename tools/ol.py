"""Reader for Creo View OL geometry files (DIV-OL06..09, "V6Reader" layout).

Format notes (recovered from libolparser_vs16.dll):
  * "DIV-OLnnBL", u32 ?, u32 ?, u32 n, then n 8-byte entries
    {u24 section id, u8 compressed, u32 file offset}; id 0xffffff marks EOF.
  * Each section is (optionally) one gzip member holding a flat record stream.
    Record header: u32 word (tag = word & 0xffffff, bit 24 = has children),
    i32 payload length.  Children follow the payload and end with a tag-0 record.
  * Section 0: tag 5 = material (ambient3, diffuse3, specular3, shininess,
    emissive3, u32), indexed in order of appearance.
  * Section 1 (facets): 0x0B body > 0x0C shell > 0x0D face{i32 material,
    i32 layer, u8, u32 n, n*i32} > 0x16 vertex pool{u8 flags (1 normals,
    2 rgba, 4 uv), u32 count, per-vertex floats} > 0x17 polyform > 0x18 mesh
    {i32 type, i32 material, u8, u8, u8 vtype} > 0x19 fan / 0x1A strip /
    0x1B triangles / 0x1C polyline / 0x1D lines (u32 indices).
  * Section 2 (edges): 0x12 edge {u32 id, f32 t0, f32 t1} > 0x16 points > 0x17 > 0x18
    > 0x1C polyline | 0x1D line pairs.
  * Triangles are counter-clockwise around the CAD normals (outward); the few that are not
    are flipped here.
"""
import struct
import zlib

import numpy as np


class Rec:
    __slots__ = ("tag", "children_flag", "payload", "children")

    def __init__(self, tag, cf, payload):
        self.tag = tag
        self.children_flag = cf
        self.payload = payload
        self.children = []


def parse_records(buf):
    """Parse a flat record stream into a tree."""
    root = Rec(-1, True, b"")
    stack = [root]
    p = 0
    n = len(buf)
    while p + 8 <= n:
        word, ln = struct.unpack_from("<Ii", buf, p)
        p += 8
        tag = word & 0xFFFFFF
        if tag == 0:
            if len(stack) > 1:
                stack.pop()
            p += max(ln, 0)
            continue
        rec = Rec(tag, bool(word & 0x1000000), buf[p:p + ln])
        p += ln
        stack[-1].children.append(rec)
        if rec.children_flag:
            stack.append(rec)
    return root


def read_sections(path):
    data = open(path, "rb").read()
    if not data.startswith(b"DIV-OL"):
        raise ValueError("not an OL file: %s" % path)
    count = struct.unpack_from("<I", data, 18)[0]
    entries = []
    p = 22
    for _ in range(count):
        w, off = struct.unpack_from("<II", data, p)
        p += 8
        sid = w & 0xFFFFFF
        if sid == 0xFFFFFF:
            sid = -1
        entries.append((sid, w >> 24, off))
    out = {}
    for sid, comp, off in entries:
        if sid < 0:
            continue
        if comp:
            d = zlib.decompressobj(31)
            out[sid] = d.decompress(data[off:])
        else:
            nxt = min([o for s, c, o in entries if o > off] or [len(data)])
            out[sid] = data[off:nxt]
    return out


def _strip_to_tris(idx):
    tris = []
    for i in range(len(idx) - 2):
        a, b, c = idx[i], idx[i + 1], idx[i + 2]
        if a == b or b == c or a == c:
            continue
        tris.append((a, b, c) if i % 2 == 0 else (b, a, c))
    return tris


def _fan_to_tris(idx):
    return [(idx[0], idx[i], idx[i + 1]) for i in range(1, len(idx) - 1)]


def _walk(rec, fn):
    for c in rec.children:
        fn(c)
        _walk(c, fn)


class OLMesh:
    """Triangles grouped by diffuse colour."""

    def __init__(self):
        self.groups = {}  # rgb tuple -> (list of pos arrays, list of normal arrays, list of index arrays)
        self.edges = None  # (points (N,3) float32, segments (M,2) uint32) or None


def _str(p, o):
    n = struct.unpack_from("<I", p, o)[0]
    return p[o + 4:o + 4 + n].rstrip(b"\0").decode("latin1"), o + 4 + n


WELD = 1e-4


def load_ol(path, with_edges=False):
    """Returns (OLMesh, materials). mesh.groups: {(rgba, layer): (pos list, normal list, tri list)};
    mesh.edges: {layer: (points, segments)}. Layers: section 0 tag 3 = {str "Layer", u32 n,
    n x str name}; a face's 0x0A child {i32 0, i32 count, count x i32} indexes those names."""
    secs = read_sections(path)
    materials, layer_names = [], []
    if 0 in secs:
        r0 = parse_records(secs[0])

        def mat(rec):
            if rec.tag == 5 and len(rec.payload) >= 52:
                f = struct.unpack_from("<13f", rec.payload, 0)
                diffuse = f[3:6]
                alpha = 1.0
                if len(rec.payload) >= 56:
                    alpha = struct.unpack_from("<f", rec.payload, 52)[0]
                    if not (0.0 <= alpha <= 1.0):
                        alpha = 1.0
                materials.append((diffuse, alpha))
            elif rec.tag == 3 and len(rec.payload) >= 8:
                try:
                    p = rec.payload
                    _, o = _str(p, 0)
                    n = struct.unpack_from("<I", p, o)[0]
                    o += 4
                    for _ in range(n):
                        name, o = _str(p, o)
                        layer_names.append(name)
                except struct.error:
                    pass
        _walk(r0, mat)

    mesh = OLMesh()
    if 1 not in secs:
        return mesh, materials
    r1 = parse_records(secs[1])
    default_layer = layer_names[0] if len(layer_names) == 1 else ""

    def color_of(mi):
        if 0 <= mi < len(materials):
            (r, g, b), a = materials[mi]
            return (round(r, 3), round(g, 3), round(b, 3), round(a, 3))
        return (0.7, 0.7, 0.7, 1.0)

    def face(rec):
        if rec.tag != 0x0D:
            return
        face_mat = struct.unpack_from("<i", rec.payload, 0)[0]
        layer = default_layer
        for k in rec.children:
            if k.tag == 0x0A and len(k.payload) >= 12:
                _, count, li = struct.unpack_from("<3i", k.payload, 0)
                if count > 0 and 0 <= li < len(layer_names):
                    layer = layer_names[li]
        for vp in rec.children:
            if vp.tag != 0x16:
                continue
            flags = vp.payload[0]
            cnt = struct.unpack_from("<I", vp.payload, 1)[0]
            stride = 3 + (3 if flags & 1 else 0) + (4 if flags & 2 else 0) + (2 if flags & 4 else 0)
            arr = np.frombuffer(vp.payload, dtype="<f4", count=cnt * stride, offset=5).reshape(cnt, stride)
            pos = arr[:, 0:3]
            nrm = arr[:, 3:6] if flags & 1 else None
            for pf in vp.children:
                if pf.tag != 0x17:
                    continue
                for m in pf.children:
                    if m.tag != 0x18:
                        continue
                    mi = struct.unpack_from("<i", m.payload, 4)[0]
                    if mi < 0:
                        mi = face_mat
                    tris = []
                    for prim in m.children:
                        idx = np.frombuffer(prim.payload, dtype="<u4")
                        if prim.tag == 0x1B:
                            tris.extend(idx.reshape(-1, 3).tolist())
                        elif prim.tag == 0x1A:
                            tris.extend(_strip_to_tris(idx.tolist()))
                        elif prim.tag == 0x19:
                            tris.extend(_fan_to_tris(idx.tolist()))
                    if not tris:
                        continue
                    T = np.asarray(tris, dtype=np.uint32)
                    if nrm is not None:
                        a, b, c = pos[T[:, 0]], pos[T[:, 1]], pos[T[:, 2]]
                        s = nrm[T[:, 0]] + nrm[T[:, 1]] + nrm[T[:, 2]]
                        flip = (np.cross(b - a, c - a) * s).sum(1) < 0
                        if flip.any():
                            T[flip] = T[flip][:, [0, 2, 1]]
                    g = mesh.groups.setdefault((color_of(mi), layer), ([], [], []))
                    g[0].append(pos)
                    g[1].append(nrm)
                    g[2].append(T)
    _walk(r1, face)

    if with_edges and 2 in secs:
        # edges have no layer: with several layers, an edge takes the layer of the face vertex at
        # its first point (or the layer with the most triangles)
        size = {}
        for (col, layer), (ps, ns, ixs) in mesh.groups.items():
            size[layer] = size.get(layer, 0) + sum(len(t) for t in ixs)
        main = max(size, key=size.get) if size else default_layer
        where = None
        if len(size) > 1:
            where = {}
            for (col, layer), (ps, ns, ixs) in mesh.groups.items():
                for p in ps:
                    for k in map(tuple, np.round(p / WELD).astype(np.int64).tolist()):
                        where.setdefault(k, layer)
        acc = {}
        r2 = parse_records(secs[2])

        def edge(rec):
            if rec.tag != 0x16 or len(rec.payload) < 5:
                return
            flags = rec.payload[0]
            cnt = struct.unpack_from("<I", rec.payload, 1)[0]
            stride = 3 + (3 if flags & 1 else 0) + (4 if flags & 2 else 0) + (2 if flags & 4 else 0)
            if len(rec.payload) < 5 + cnt * stride * 4:
                return
            segs = []
            stack = list(rec.children)
            while stack:
                r = stack.pop()
                stack.extend(r.children)
                if r.tag not in (0x1C, 0x1D):
                    continue
                ix = np.frombuffer(r.payload, dtype="<u4").astype(np.int64)
                s = np.stack([ix[:-1], ix[1:]], 1) if r.tag == 0x1C else ix[: len(ix) // 2 * 2].reshape(-1, 2)
                s = s[(s < cnt).all(1)]
                if len(s):
                    segs.append(s)
            if not segs:
                return
            a = np.frombuffer(rec.payload, dtype="<f4", count=cnt * stride, offset=5).reshape(cnt, stride)[:, :3]
            layer = main
            if where is not None:
                layer = where.get(tuple(np.round(a[0] / WELD).astype(np.int64).tolist()), main)
            e = acc.setdefault(layer, [[], [], 0])
            e[0].append(a)
            e[1].append(np.concatenate(segs) + e[2])
            e[2] += cnt
        _walk(r2, edge)
        mesh.edges = {l: (np.concatenate(e[0]).astype(np.float32), np.concatenate(e[1]).astype(np.uint32)) for l, e in acc.items()}
    return mesh, materials

if __name__ == "__main__":
    import sys
    m, mats = load_ol(sys.argv[1], with_edges=True)
    print("materials", mats)
    for (col, layer), (ps, ns, ix) in m.groups.items():
        allp = np.concatenate(ps)
        print(col, "layer", layer, "verts", sum(len(p) for p in ps), "tris", sum(len(i) for i in ix),
              "bbox", allp.min(0), allp.max(0))
    print("edges", {l: len(e[1]) for l, e in (m.edges or {}).items()})
