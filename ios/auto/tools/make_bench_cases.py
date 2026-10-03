import json, struct, os, collections

PKG = r"matcher_golden_pkg\pkg"
script = json.load(open(os.path.join(PKG, "script.json"), encoding="utf-8"))

def png_size(path):
    d = open(path, "rb").read(33)
    assert d[:8] == b"\x89PNG\r\n\x1a\n", path
    w, h = struct.unpack(">II", d[16:24])
    return w, h

dims = {}
for n in os.listdir(PKG):
    if n.endswith(".png"):
        dims[n] = png_size(os.path.join(PKG, n))

cnt = collections.Counter(dims.values())
print("size histogram:")
for k, v in sorted(cnt.items(), key=lambda x: -x[1]):
    print(f"  {k[0]}x{k[1]}  x{v}")

frames = [n for n, d in dims.items() if d == (1080, 1920)]
print("\n1080x1920 files (candidate frames/ori):")
for n in sorted(frames): print("  ", n)

# 脚本里 1080 变体的模板文件名
tpls = []
for g in script["image_list"]:
    for im in g["images"]:
        if im["screen_info"]["width"] == 1080:
            tpls.append((g["name"], im["file"], im["rect"]))
print(f"\n1080x1920 template variants ({len(tpls)}):")
for name, f, rect in tpls:
    w, h = dims.get(f, (0, 0))
    print(f"  {f}  {w}x{h}  rect={rect}  group={name!r}")

# 生成 bench 数据头
L = []
L.append("/* bench_cases.h —— 由 tools/make_bench_cases.py 生成，请勿手改 */")
L.append("#ifndef BENCH_CASES_H")
L.append("#define BENCH_CASES_H")
L.append("")
L.append("/* 帧候选（1080x1920）：原图平铺在 pkg/ 下，按 size_info 来源区分 */")
L.append("typedef struct { const char *file; int is_frame; int is_template; int rect_x, rect_y, rect_w, rect_h; } bench_case;")
L.append("")
L.append("static const bench_case BENCH_REAL_CASES[] = {")
for name, f, rect in tpls:
    x, y, w, h = [int(v) for v in rect.split(",")]
    L.append(f'    {{ "{f}", 0, 1, {x}, {y}, {w}, {h} }},   /* {name} */')
L.append("};")
L.append(f"#define BENCH_REAL_CASE_COUNT {len(tpls)}")
L.append("")
L.append("#endif /* BENCH_CASES_H */")
open("tests/bench_cases.h", "w", encoding="utf-8").write("\n".join(L) + "\n")
print("\nwrote tests/bench_cases.h")
