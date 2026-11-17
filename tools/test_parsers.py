"""Tests of the Python readers on small files written here (no real model needed).

    python -m unittest discover -s tools -p "test_*.py"

The same cases as desktop/test/ol.test.js and pvs.test.js: a damaged file must stop with an error,
never loop forever or grow without end; a valid file must read as before.
"""
import os
import signal
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from build import flatten_tree  # noqa: E402
from ol import load_ol  # noqa: E402


# ------------------------------------------------------------ a small .ol file, written by hand
def rec(tag, payload, kids=None):
    """Record: u32 word (tag, bit 24 = has children), i32 payload length, payload, children, end mark."""
    out = struct.pack("<Ii", tag | (0x1000000 if kids is not None else 0), len(payload)) + payload
    if kids is not None:
        out += b"".join(kids) + struct.pack("<Ii", 0, 0)
    return out


def f32(*v):
    return struct.pack("<%df" % len(v), *v)


def u32s(*v):
    return struct.pack("<%dI" % len(v), *v)


def ol_file(sections):
    """'DIV-OL07BL', 8 bytes, u32 section count, {u32 id, u32 offset} per section, the sections."""
    head = 22 + len(sections) * 8
    table, off = b"", head
    for sid, data in sections:
        table += struct.pack("<II", sid, off)
        off += len(data)
    return b"DIV-OL07BL" + bytes(8) + struct.pack("<I", len(sections)) + table + b"".join(d for _, d in sections)


# one red material; one face: a 1 x 1 m square on z = 0 (two triangles, normals +z); one edge
MATERIAL = rec(5, f32(0, 0, 0) + f32(1, 0, 0) + bytes(28) + f32(1))
POOL = rec(0x16, b"\x01" + struct.pack("<I", 4) + f32(0, 0, 0, 0, 0, 1) + f32(1, 0, 0, 0, 0, 1)
           + f32(1, 1, 0, 0, 0, 1) + f32(0, 1, 0, 0, 0, 1),
           [rec(0x17, b"", [rec(0x18, struct.pack("<ii", 0, -1), [rec(0x1B, u32s(0, 1, 2, 0, 2, 3))])])])
FACE = rec(0x0D, struct.pack("<i", 0), [POOL])
EDGES = rec(0x16, b"\x00" + struct.pack("<I", 2) + f32(0, 0, 0) + f32(1, 0, 0),
            [rec(0x17, b"", [rec(0x18, struct.pack("<ii", 0, -1), [rec(0x1D, u32s(0, 1))])])])


def negative(data):
    """The same record with its length made negative (it points back at its own header)."""
    return data[:4] + struct.pack("<i", -8) + data[8:]


class TimeLimit:
    """Fails instead of hanging when the block takes longer than `seconds` (Unix only)."""

    def __init__(self, seconds):
        self.seconds = seconds

    def __enter__(self):
        if hasattr(signal, "SIGALRM"):
            def stop(*_):
                raise TimeoutError("não terminou em %d s (laço infinito?)" % self.seconds)
            self.old = signal.signal(signal.SIGALRM, stop)
            signal.alarm(self.seconds)

    def __exit__(self, *exc):
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)
            signal.signal(signal.SIGALRM, self.old)


class OLReader(unittest.TestCase):
    def load(self, data):
        fd, path = tempfile.mkstemp(suffix=".ol")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            with TimeLimit(5):
                return load_ol(path, with_edges=True)
        finally:
            os.remove(path)

    def test_valid_file(self):
        mesh, _ = self.load(ol_file([(0, MATERIAL), (1, FACE), (2, EDGES)]))
        self.assertEqual(list(mesh.groups), [((1.0, 0.0, 0.0, 1.0), "")])
        pos, nrm, tris = mesh.groups[((1.0, 0.0, 0.0, 1.0), "")]
        self.assertEqual(tris[0].tolist(), [[0, 1, 2], [0, 2, 3]])
        self.assertEqual(sorted(mesh.edges), [""])
        self.assertEqual(mesh.edges[""][1].tolist(), [[0, 1]])

    def test_negative_length_is_an_error_not_a_loop(self):
        with self.assertRaisesRegex(ValueError, "corrompido"):
            self.load(ol_file([(0, MATERIAL), (1, negative(FACE)), (2, EDGES)]))

    def test_damaged_edges_keep_the_faces(self):
        mesh, _ = self.load(ol_file([(0, MATERIAL), (1, FACE), (2, negative(EDGES))]))
        self.assertEqual(len(mesh.groups), 1)
        self.assertEqual(mesh.edges, {})


class Tree(unittest.TestCase):
    @staticmethod
    def comp(name, kids=(), shape=None):
        return {"name": name, "shape": shape, "children": [{"comp": k} for k in kids]}

    def test_a_part_used_twice_appears_twice(self):
        c = self.comp
        names, parents, part_of, ends, shapes, node_comp, part_comp = flatten_tree(
            [c("L", shape="l.ol"), c("A", [0, 0]), c("R", [1])], 2)
        self.assertEqual(names, ["R", "A", "L", "L"])
        self.assertEqual(parents, [-1, 0, 1, 1])
        self.assertEqual(part_of, [-1, -1, 0, 1])
        self.assertEqual(ends, [2, 2, 1, 2])
        self.assertEqual(shapes, ["l.ol", "l.ol"])

    def test_cycles_and_bad_references_are_errors(self):
        c = self.comp
        with TimeLimit(5):
            for comps, root in (([c("A", [0])], 0), ([c("A", [1]), c("B", [0]), c("R", [0])], 2)):
                with self.assertRaisesRegex(ValueError, "contém a si mesmo"):
                    flatten_tree(comps, root)
            with self.assertRaisesRegex(ValueError, "inexistente"):
                flatten_tree([c("A", [7]), c("R", [0])], 1)
            with self.assertRaisesRegex(ValueError, "sem componentes"):
                flatten_tree([], 0)


if __name__ == "__main__":
    unittest.main()
