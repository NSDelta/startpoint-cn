#!/usr/bin/env python3
"""Pure-python DEX string/type/class extractor.

Parses the DEX string_ids table (full MUTF-8 strings, in dex order) plus
type_ids / class_defs so we can grep for class names and field names without
jadx. Usage:
    python dex_dump.py classes.dex --strings out.txt
    python dex_dump.py classes.dex --grep '\\.auto'
"""
import struct, sys, os, io, re, argparse


def uleb128(buf, off):
    result = 0
    shift = 0
    while True:
        b = buf[off]
        off += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return result, off


def read_mutf8(buf, off):
    # uleb128 utf16 size, then MUTF-8 bytes, NUL terminated
    n, off = uleb128(buf, off)
    end = buf.index(b"\x00", off)
    raw = buf[off:end]
    return raw.decode("utf-8", "replace"), end + 1


class Dex:
    def __init__(self, path):
        self.path = path
        with open(path, "rb") as f:
            self.buf = f.read()
        b = self.buf
        if b[:4] not in (b"dex\n", b"dey\n"):
            raise ValueError(f"not a dex: {b[:8]!r}")
        self.version = b[4:7].decode("ascii", "replace")
        (self.string_ids_size, self.string_ids_off,
         self.type_ids_size, self.type_ids_off,
         self.proto_ids_size, self.proto_ids_off,
         self.field_ids_size, self.field_ids_off,
         self.method_ids_size, self.method_ids_off,
         self.class_defs_size, self.class_defs_off,
         self.data_size, self.data_off) = struct.unpack_from("<14I", b, 56)

    def string_at(self, idx):
        off = struct.unpack_from("<I", self.buf, self.string_ids_off + 4 * idx)[0]
        s, _ = read_mutf8(self.buf, off)
        return s

    def strings(self):
        return [self.string_at(i) for i in range(self.string_ids_size)]

    def type_at(self, idx):
        sidx = struct.unpack_from("<I", self.buf, self.type_ids_off + 4 * idx)[0]
        return self.string_at(sidx)

    def types(self):
        return [self.type_at(i) for i in range(self.type_ids_size)]

    def classes(self):
        out = []
        types = None
        for i in range(self.class_defs_size):
            base = self.class_defs_off + 32 * i
            class_idx, access, super_idx, interfaces_off, source_idx, \
                annotations_off, class_data_off, static_values_off = struct.unpack_from("<8I", self.buf, base)
            if types is None:
                types = self.types()
            out.append(types[class_idx])
        return out

    def field_names(self):
        out = []
        for i in range(self.field_ids_size):
            base = self.field_ids_off + 8 * i
            class_idx, type_idx, name_idx = struct.unpack_from("<HHI", self.buf, base)
            out.append(self.string_at(name_idx))
        return out

    def method_names(self):
        out = []
        for i in range(self.method_ids_size):
            base = self.method_ids_off + 8 * i
            class_idx, proto_idx, name_idx = struct.unpack_from("<HHI", self.buf, base)
            out.append(self.string_at(name_idx))
        return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dex")
    ap.add_argument("--strings", help="write all strings to file")
    ap.add_argument("--grep", help="regex over strings")
    ap.add_argument("--classes", help="regex over class names")
    ap.add_argument("--stats", action="store_true")
    args = ap.parse_args()

    d = Dex(args.dex)
    print(f"{os.path.basename(args.dex)} dex v{d.version} "
          f"strings={d.string_ids_size} types={d.type_ids_size} "
          f"fields={d.field_ids_size} methods={d.method_ids_size} "
          f"classes={d.class_defs_size}")

    if args.strings:
        ss = d.strings()
        with open(args.strings, "w", encoding="utf-8") as f:
            for s in ss:
                f.write(s + "\n")
        print(f"wrote {len(ss)} strings -> {args.strings}")

    if args.grep:
        rx = re.compile(args.grep)
        for s in d.strings():
            if rx.search(s):
                print(s)

    if args.classes:
        rx = re.compile(args.classes)
        for c in d.classes():
            if rx.search(c):
                print(c)


if __name__ == "__main__":
    main()
