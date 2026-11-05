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
        self.edges = []   # list of (N,3) float32 polylines


def load_ol(path, with_edges=False):
    secs = read_sections(path)
    materials = []
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
        _walk(r0, mat)

    mesh = OLMesh()
    if 1 not in secs:
        return mesh, materials
    r1 = parse_records(secs[1])

    def color_of(mi):
        if 0 <= mi < len(materials):
            (r, g, b), a = materials[mi]
            return (round(r, 3), round(g, 3), round(b, 3), round(a, 3))
        return (0.7, 0.7, 0.7, 1.0)

    def face(rec):
        if rec.tag != 0x0D:
            return
        face_mat = struct.unpack_from("<i", rec.payload, 0)[0]
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
                    g = mesh.groups.setdefault(color_of(mi), ([], [], []))
                    g[0].append(pos)
                    g[1].append(nrm)
                    g[2].append(np.asarray(tris, dtype=np.uint32))
    _walk(r1, face)

    if with_edges and 2 in secs:
        r2 = parse_records(secs[2])

        def edge(rec):
            if rec.tag == 0x16 and len(rec.payload) >= 5:
                flags = rec.payload[0]
                cnt = struct.unpack_from("<I", rec.payload, 1)[0]
                stride = 3 + (3 if flags & 1 else 0)
                if cnt >= 2 and len(rec.payload) >= 5 + cnt * stride * 4:
                    a = np.frombuffer(rec.payload, dtype="<f4", count=cnt * stride, offset=5).reshape(cnt, stride)
                    mesh.edges.append(a[:, :3].copy())
        _walk(r2, edge)
    return mesh, materials


if __name__ == "__main__":
    import sys
    m, mats = load_ol(sys.argv[1], with_edges=True)
    print("materials", mats)
    for col, (ps, ns, ix) in m.groups.items():
        allp = np.concatenate(ps)
        print(col, "verts", sum(len(p) for p in ps), "tris", sum(len(i) for i in ix),
              "bbox", allp.min(0), allp.max(0))
    print("edges", len(m.edges))
