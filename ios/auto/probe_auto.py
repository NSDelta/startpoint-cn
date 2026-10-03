#!/usr/bin/env python3
"""Probe a .auto archive: list entries, sizes, detect text/json."""
import sys, zipfile, os

def human(n):
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f}{u}"
        n /= 1024
    return f"{n:.1f}TB"

def main(path, maxnames=200):
    z = zipfile.ZipFile(path)
    infos = z.infolist()
    print(f"file: {path}")
    print(f"size: {os.path.getsize(path)} ({human(os.path.getsize(path))})")
    print(f"entries: {len(infos)}")
    total_u = sum(i.file_size for i in infos)
    total_c = sum(i.compress_size for i in infos)
    print(f"uncompressed total: {total_u} ({human(total_u)})  compressed: {total_c} ({human(total_c)})")
    print("-" * 100)
    for i in infos[:maxnames]:
        print(f"{i.compress_type} {i.file_size:>12} {i.compress_size:>12}  {i.filename}")
    if len(infos) > maxnames:
        print(f"... {len(infos)-maxnames} more")
        for i in infos[-10:]:
            print(f"{i.compress_type} {i.file_size:>12} {i.compress_size:>12}  {i.filename}")

if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 200)
