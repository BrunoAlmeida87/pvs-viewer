"""A small made-up installation, written as a converted folder (the format of build.py), to try the
walking map and the routes ("Ir até…") without a real model.

Two decks (0 m and 4,5 m), an inclined stair between them, a vertical ladder through a hatch, a
wall with a closed door (it should be left out by the name pattern), railings, a grating platform
and some equipments with LPR-XX codes (bigramas).

Usage: python navsample.py <out_dir>
"""
import json
import os
import sys

import numpy as np

# (normal, the 4 corners of the face as indices into the 8 corners of a box)
FACES = [((-1, 0, 0), (0, 2, 6, 4)), ((1, 0, 0), (1, 5, 7, 3)), ((0, -1, 0), (0, 4, 5, 1)),
         ((0, 1, 0), (2, 3, 7, 6)), ((0, 0, -1), (0, 1, 3, 2)), ((0, 0, 1), (4, 6, 7, 5))]


def box_mesh(b):
    x0, y0, z0, x1, y1, z1 = b
    C = np.array([[x, y, z] for z in (z0, z1) for y in (y0, y1) for x in (x0, x1)], dtype=np.float64)
    P, N, I = [], [], []
    for n, f in FACES:
        k = len(P)
        for c in f:
            P.append(C[c])
            N.append([int(v * 127) for v in n] + [0])
        I += [k, k + 2, k + 1, k, k + 3, k + 2]  # counter-clockwise seen from outside
    return np.array(P), np.array(N, dtype=np.int8), np.array(I, dtype=np.int64)


def model():
    """[(path of assembly names, part name, props, colour, [boxes])]"""
    parts = []

    def add(group, name, boxes, color, code=None):
        props = {"part_objectid": "LPR/" + code} if code else {}
        if code:
            props["Description"] = name
        parts.append((group, (code + " - " + name) if code else name, props, color, boxes))

    grey, steel, yellow, blue, green, red = (150, 150, 150), (110, 120, 130), (230, 190, 40), (40, 90, 200), (40, 150, 80), (200, 50, 40)
    # lower deck, 40 x 16 m
    add("CONVES_INFERIOR", "CHAPA CONVES INFERIOR", [(0, 0, -0.02, 40, 16, 0)], grey)
    # upper deck at 4.5 m over x 20-40, with a hatch at x 35.5-36.5, y 12.5-13.5
    add("CONVES_SUPERIOR", "CHAPA CONVES SUPERIOR", [
        (20, 0, 4.48, 40, 12.5, 4.5), (20, 13.5, 4.48, 40, 16, 4.5),
        (20, 12.5, 4.48, 35.5, 13.5, 4.5), (36.5, 12.5, 4.48, 40, 13.5, 4.5)], grey)
    # columns under the upper deck
    for i, (x, y) in enumerate([(25, 4), (25, 12), (32, 4), (32, 12)]):
        add("CONVES_SUPERIOR", "COLUNA C-%02d" % (i + 1), [(x - 0.15, y - 0.15, 0, x + 0.15, y + 0.15, 4.48)], steel)
    # wall under the edge of the upper deck (x = 20), with a door opening at y 7-8 and a closed door in it
    add("CONVES_INFERIOR", "ANTEPARA A-01", [(19.9, 0, 0, 20, 7, 4.48), (19.9, 8, 0, 20, 16, 4.48), (19.9, 7, 2.1, 20, 8, 4.48)], (190, 190, 170))
    add("CONVES_INFERIOR", "PORTA P-01", [(19.92, 7, 0, 19.98, 8, 2.1)], (120, 80, 50))
    # railing along the edge of the upper deck (x = 20) except where the stair arrives (y 1-2.2)
    rail = [(20, 2.2, 4.5, 20.05, 16, 5.6), (20, 0, 4.5, 20.05, 1, 5.6)]
    add("CONVES_SUPERIOR", "GUARDA-CORPO GC-01", rail, yellow)
    # inclined stair from x = 13.7 (0 m) up to x = 20 (4.5 m): 18 steps of 0.25 m, 0.35 m deep, y 1-2.2
    steps = []
    for i in range(18):
        top = 0.25 * (i + 1)
        x = 13.7 + 0.35 * i
        steps.append((x, 1, top - 0.04, x + 0.35, 2.2, top))
    stringers = [(13.7, 0.92, 0, 20, 1, 4.5), (13.7, 2.2, 0, 20, 2.28, 4.5)]
    add("ESCADAS", "ESCADA E-01", steps + stringers, yellow)
    # vertical ladder through the hatch (x 35.9-36.1, y 13.3), up to 1 m over the upper deck
    rungs = [(35.75, 13.35, 0.3 * k, 36.25, 13.4, 0.3 * k + 0.03) for k in range(1, 18)]
    sides = [(35.7, 13.3, 0, 35.75, 13.4, 5.5), (36.25, 13.3, 0, 36.3, 13.4, 5.5)]
    add("ESCADAS", "ESCADA DE MARINHEIRO EM-01", rungs + sides, yellow)
    # grating platform at 1.5 m (x 2-8, y 10-15) with bars every 0.1 m, on four legs, reached by
    # a short stair at x = 8 (6 steps of 0.25 m)
    bars = [(2 + 0.1 * k, 10, 1.47, 2 + 0.1 * k + 0.03, 15, 1.5) for k in range(60)]
    cross = [(2, 10 + 0.5 * k, 1.44, 8, 10 + 0.5 * k + 0.03, 1.47) for k in range(11)]
    legs = [(x, y, 0, x + 0.1, y + 0.1, 1.44) for x in (2, 7.9) for y in (10, 14.9)]
    add("PLATAFORMAS", "PLATAFORMA GRADEADA PL-01", bars + cross + legs, steel)
    small = [(8 + 0.3 * i, 11, 1.25 - 0.25 * i - 0.04, 8 + 0.3 * (i + 1), 12.2, 1.25 - 0.25 * i) for i in range(5)]
    add("PLATAFORMAS", "ESCADA E-02", small, yellow)
    # equipment
    add("EQUIPAMENTOS", "BOMBA DE AGUA", [(4, 2, 0, 5.2, 2.8, 0.9), (4.4, 2.2, 0.9, 4.8, 2.6, 1.3)], blue, "LPR-DT20003")
    add("EQUIPAMENTOS", "BOMBA RESERVA", [(4, 4, 0, 5.2, 4.8, 0.9)], blue, "LPR-DT20004")
    add("EQUIPAMENTOS", "TROCADOR DE CALOR", [(10, 12, 0, 13, 14, 2.2)], green, "LPR-HE10001")
    add("EQUIPAMENTOS", "PAINEL ELETRICO", [(28, 0, 0, 30, 0.6, 2.2)], (90, 90, 90), "LPR-EL50001")
    add("EQUIPAMENTOS", "TANQUE DE OLEO", [(28, 8, 4.5, 31, 11, 7.5)], red, "LPR-TQ30001")
    add("EQUIPAMENTOS", "VALVULA NA PLATAFORMA", [(5, 12.3, 1.5, 5.4, 12.7, 2.1)], red, "LPR-VA40001")
    add("EQUIPAMENTOS", "COMPRESSOR", [(37, 2, 4.5, 39, 4, 6.2)], green, "LPR-CP60001")
    # a big pipe across the lower deck at 1.2 m (one cannot walk under it: it blocks the way)
    add("TUBULACAO", "TUBO 8 POL", [(15, 5.5, 1.0, 19.9, 5.9, 1.4)], (200, 200, 200), "LPR-TB70001")
    return parts


def main():
    out = sys.argv[1]
    os.makedirs(os.path.join(out, "c"), exist_ok=True)
    parts = model()
    # tree: root, one assembly per group, the parts under them (DFS order)
    groups = []
    for g, *_ in parts:
        if g not in groups:
            groups.append(g)
    names, parent, p0, p1, part, props = ["INSTALACAO_TESTE"], [-1], [0], [len(parts)], [-1], [{}]
    order = []
    for g in groups:
        gi = len(names)
        names.append(g); parent.append(0); p0.append(len(order)); part.append(-1); props.append({})
        p1.append(0)
        for k, pt in enumerate(parts):
            if pt[0] != g:
                continue
            names.append(pt[1]); parent.append(gi); p0.append(len(order)); p1.append(len(order) + 1)
            part.append(len(order)); props.append(pt[2])
            order.append(k)
        p1[gi] = len(order)
    keys, vals, kv, start = [], [], [], [0]
    for pr in props:
        for k, v in pr.items():
            if k not in keys:
                keys.append(k)
            if v not in vals:
                vals.append(v)
            kv += [keys.index(k), vals.index(v)]
        start.append(len(kv) // 2)
    tree = {"names": names, "parent": parent, "p0": p0, "p1": p1, "part": part,
            "props": {"keys": keys, "vals": vals, "start": start, "kv": kv},
            "thumbs": [""] * len(names), "shapes": ["p%03d.ol" % i for i in range(len(order))]}
    with open(os.path.join(out, "tree.json"), "w", encoding="utf-8") as f:
        json.dump(tree, f, ensure_ascii=False)
    # one chunk per part (small model: no need to pack)
    chunks, items, pbox = [], [], np.zeros((len(order), 6), np.float32)
    for p, k in enumerate(order):
        _, name, _, color, boxes = parts[k]
        P, N, I = [], [], []
        nv = 0
        for b in boxes:
            bp, bn, bi = box_mesh(b)
            P.append(bp); N.append(bn); I.append(bi + nv); nv += len(bp)
        P, N, I = np.vstack(P), np.vstack(N), np.concatenate(I)
        assert len(P) < 65535
        lo, hi = P.min(0), P.max(0)
        ext = np.maximum(hi - lo, 1e-6)
        V = np.zeros((len(P), 4), np.uint16)
        V[:, :3] = np.round((P - lo) / ext * 65535).clip(0, 65535)
        fname = "%05d.bin" % p
        with open(os.path.join(out, "c", fname), "wb") as f:
            f.write(V.tobytes()); f.write(N.astype(np.int8).tobytes()); f.write(I.astype(np.uint16).tobytes())
        chunks.append({"f": fname, "min": lo.tolist(), "max": hi.tolist(), "io": p, "ic": 1, "nv": len(P), "ni": len(I), "ne": 0,
                       "ps": float(np.linalg.norm(hi - lo)), "small": False})
        items.append((p, color + (255,)))
        pbox[p, :3], pbox[p, 3:] = lo, hi
    it = np.zeros(len(items), dtype=[("p", "<u4"), ("c", "u1", 4)])
    for i, (p, c) in enumerate(items):
        it[i] = (p, c)
    with open(os.path.join(out, "items.bin"), "wb") as f:
        f.write(it.tobytes())
    with open(os.path.join(out, "layers.bin"), "wb") as f:
        f.write(np.zeros(len(items), "<u2").tobytes())
    with open(os.path.join(out, "parts.bin"), "wb") as f:
        f.write(pbox.tobytes())
    with open(os.path.join(out, "pvsbox.bin"), "wb") as f:
        f.write(pbox.tobytes())
    meta = {"format": 2, "source": "instalacao_teste.pvs", "parts": len(order), "items": len(items),
            "tris": int(sum(c["ni"] for c in chunks) // 3), "min": pbox[:, :3].min(0).tolist(), "max": pbox[:, 3:].max(0).tolist(),
            "layers": [""], "chunks": chunks}
    with open(os.path.join(out, "chunks.json"), "w") as f:
        json.dump(meta, f)
    print("%d parts, %d chunks -> %s" % (len(order), len(chunks), out))


if __name__ == "__main__":
    main()
