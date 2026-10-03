#!/usr/bin/env python3
"""List APK entries with a name filter."""
import sys, zipfile, os

def human(n):
    for u in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f}{u}"
        n /= 1024
    return f"{n:.1f}TB"

def main(path, needle=None, limit=300):
    z = zipfile.ZipFile(path)
    infos = z.infolist()
    print(f"entries: {len(infos)}")
    sel = [i for i in infos if (needle is None or needle.lower() in i.filename.lower())]
    print(f"matched: {len(sel)}")
    for i in sel[:limit]:
        print(f"{i.file_size:>12} {i.compress_size:>12}  {i.filename}")
    if len(sel) > limit:
        print(f"... {len(sel)-limit} more")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None,
         int(sys.argv[3]) if len(sys.argv) > 3 else 300)
