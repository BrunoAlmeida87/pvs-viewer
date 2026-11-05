"""Reader for Creo View binary structure files (PV-PVS03xx).

Format notes (recovered from libpvsparser_vs16.dll):
  * File header "PV-PVSxxxxC", then a section index; the payload is a series of
    gzip members that together form the tag stream.
  * Tag header: u16 h.  id = h & 0x1ff, len bytes = (h>>9)&7, flag bytes = (h>>12)&7,
    has_children = h>>15.  Then `len` (LE, n bytes) and `flags` (LE, n bytes).
    h == 0 terminates the children of the enclosing tag.
  * Varints are LEB128.  A "symbol" is a varint v: 0 = empty, even = inline
    string of v>>1 bytes, odd = index v>>1 into the symbol table.
  * Tag 1 = symbol table, 2 = structure, 0x20 = component, 0x21 = component
    instance (child of a component), 0x23 = shape source (.ol file + bbox),
    0x26 = thumbnail image (.jpg) of the component.
  * Tag 3 = properties: children 0x2a, one per component in order (flag bit 0:
    a varint gives the index step instead of 1), each holding 0x2b records =
    symbol name + symbol value.
"""
import struct
import zlib


def _gunzip_all(data, start):
    out = []
    pos = start
    while pos < len(data):
        if data[pos:pos + 2] != b"\x1f\x8b":
            nxt = data.find(b"\x1f\x8b\x08", pos)
            if nxt < 0:
                break
            pos = nxt
            continue
        d = zlib.decompressobj(31)
        out.append(d.decompress(data[pos:]))
        pos = len(data) - len(d.unused_data)
    return b"".join(out)


def _text(b):
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("cp1252", "replace")


class Reader:
    def __init__(self, buf):
        self.b = buf
        self.p = 0

    def u8(self):
        v = self.b[self.p]
        self.p += 1
        return v

    def uint(self, n):
        v = int.from_bytes(self.b[self.p:self.p + n], "little")
        self.p += n
        return v

    def varint(self):
        v = 0
        s = 0
        while True:
            c = self.b[self.p]
            self.p += 1
            v |= (c & 0x7F) << s
            if c < 0x80:
                return v
            s += 7

    def raw(self, n):
        v = self.b[self.p:self.p + n]
        self.p += n
        return v

    def tag(self):
        h = self.uint(2)
        if h == 0:
            return (0, 0, 0, False)
        tid = h & 0x1FF
        ln = self.uint((h >> 9) & 7)
        fl = self.uint((h >> 12) & 7)
        return (tid, ln, fl, bool(h >> 15))

    def skip_children(self):
        depth = 1
        while depth > 0:
            tid, ln, fl, ch = self.tag()
            if tid == 0:
                depth -= 1
                continue
            self.p += ln
            if ch:
                depth += 1


class PVS:
    def __init__(self, path, version3_doubles=None):
        data = open(path, "rb").read()
        if not data.startswith(b"PV-PVS"):
            raise ValueError("not a PVS file")
        self.version = data[6:10].decode()
        first = data.find(b"\x1f\x8b\x08")
        self.stream = _gunzip_all(data, first)
        self.symbols = []
        self.components = []  # dicts
        self.double_matrix = (int(self.version[:2]) >= 3) if version3_doubles is None else version3_doubles
        self._parse()

    def symbol(self, r):
        v = r.varint()
        if v == 0:
            return ""
        if v & 1:
            i = v >> 1
            return self.symbols[i] if i < len(self.symbols) else ""
        return _text(r.raw(v >> 1))

    def _parse(self):
        r = Reader(self.stream)
        while r.p < len(r.b):
            start = r.p
            tid, ln, fl, ch = r.tag()
            body = r.p
            if tid == 1:
                n = r.varint()
                for _ in range(n):
                    k = r.varint()
                    self.symbols.append(_text(r.raw(k)))
                r.p = body + ln
                if ch:
                    r.skip_children()
            elif tid == 2:
                r.p = body + ln
                if ch:
                    self._structure(r)
            elif tid == 3:
                r.p = body + ln
                if ch:
                    self._properties(r)
            elif tid == 0:
                continue
            else:
                r.p = body + ln
                if ch:
                    r.skip_children()

    def _structure(self, r):
        while True:
            tid, ln, fl, ch = r.tag()
            if tid == 0:
                return
            body = r.p
            if tid == 0x20:
                self._component(r, ln, fl, ch, body)
            else:
                r.p = body + ln
                if ch:
                    r.skip_children()

    def _properties(self, r):
        idx = -1
        while True:
            tid, ln, fl, ch = r.tag()
            if tid == 0:
                return
            body = r.p
            if tid == 0x2A:
                idx += r.varint() if fl & 1 else 1
            r.p = body + ln
            if not ch:
                continue
            props = {}
            while True:
                t, cln, cfl, cch = r.tag()
                if t == 0:
                    break
                cbody = r.p
                if t == 0x2B:
                    k = self.symbol(r)
                    v = self.symbol(r)
                    if v and v != "null":
                        props[k] = v
                r.p = cbody + cln
                if cch:
                    r.skip_children()
            if tid == 0x2A and 0 <= idx < len(self.components):
                self.components[idx]["props"] = props

    def _component(self, r, ln, fl, ch, body):
        comp = {"index": len(self.components), "name": self.symbol(r), "flags": fl,
                "shape": None, "bbox": None, "thumb": None, "props": {}, "children": []}
        r.p = body + ln
        self.components.append(comp)
        if not ch:
            return
        while True:
            tid, cln, cfl, cch = r.tag()
            if tid == 0:
                return
            cbody = r.p
            if tid == 0x21:
                comp["children"].append(self._instance(r, cln, cfl))
            elif tid == 0x23:
                comp["shape"] = self.symbol(r)
                if cfl & 1:
                    comp["bbox"] = struct.unpack("<6f", r.raw(24))
            elif tid == 0x26:
                comp["thumb"] = self.symbol(r)
            r.p = cbody + cln
            if cch:
                r.skip_children()

    def _instance(self, r, ln, fl):
        inst = {"comp": r.varint(), "pos": (0.0, 0.0, 0.0), "mat": None, "id": "", "name": ""}
        if fl & 1:
            inst["rel"] = r.varint()
        if fl & 2:
            inst["pos"] = struct.unpack("<3d", r.raw(24))
        if fl & 4:
            if self.double_matrix:
                inst["mat"] = struct.unpack("<9d", r.raw(72))
            else:
                inst["mat"] = struct.unpack("<9f", r.raw(36))
        if fl & 8:
            inst["id"] = self.symbol(r)
        if fl & 0x10:
            inst["name"] = self.symbol(r)
        inst["hidden"] = bool(fl & 0x20)
        return inst

    def roots(self):
        used = set()
        for c in self.components:
            for i in c["children"]:
                used.add(i["comp"])
        return [c["index"] for c in self.components if c["index"] not in used]


if __name__ == "__main__":
    import sys
    p = PVS(sys.argv[1])
    print("version", p.version, "symbols", len(p.symbols), "components", len(p.components))
    shapes = sum(1 for c in p.components if c["shape"])
    insts = sum(len(c["children"]) for c in p.components)
    print("with shape", shapes, "instances", insts, "roots", p.roots()[:10])
    for c in p.components[:3]:
        print(c)
    big = max(p.components, key=lambda c: len(c["children"]))
    print("biggest", big["name"], len(big["children"]), big["children"][:3])
