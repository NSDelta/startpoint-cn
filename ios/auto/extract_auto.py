#!/usr/bin/env python3
"""Extract and pretty-print selected entries from a .auto archive."""
import sys, zipfile, json, os

def main(path, outdir, names):
    os.makedirs(outdir, exist_ok=True)
    z = zipfile.ZipFile(path)
    for n in names:
        try:
            data = z.read(n)
        except KeyError:
            print(f"[MISS] {n}")
            continue
        dst = os.path.join(outdir, n.replace("/", "_"))
        with open(dst, "wb") as f:
            f.write(data)
        print(f"[OK] {n} -> {dst} ({len(data)} bytes)")
        if n.endswith(".json"):
            try:
                obj = json.loads(data.decode("utf-8"))
                pretty = os.path.join(outdir, n.replace("/", "_") + ".pretty.json")
                with open(pretty, "w", encoding="utf-8") as f:
                    json.dump(obj, f, ensure_ascii=False, indent=2)
                print(f"     pretty -> {pretty}")
                def shape(o, d=0, k=""):
                    pad = "  " * d
                    if d > 4:
                        return
                    if isinstance(o, dict):
                        print(f"{pad}{k}: dict[{len(o)}] keys={list(o.keys())[:20]}")
                        for kk, vv in list(o.items())[:12]:
                            shape(vv, d + 1, kk)
                    elif isinstance(o, list):
                        print(f"{pad}{k}: list[{len(o)}]")
                        if o:
                            shape(o[0], d + 1, "[0]")
                    else:
                        s = repr(o)
                        print(f"{pad}{k}: {type(o).__name__} = {s[:120]}")
                print("  --- shape ---")
                shape(obj)
            except Exception as e:
                print(f"     (not json: {e})")
                print("     raw head:", data[:400])
        else:
            print("     raw:", data[:200])

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
