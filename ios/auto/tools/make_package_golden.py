#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成"整条读取链路"夹具：让 C 端自己从 .auto（ZIP + deflate）里读出 PNG、自己解码、
自己转灰度、自己匹配，然后与 cv2 的答案对比。一条命令同时验证 inflate / ZIP / PNG / 灰度 / 匹配。

产物：
  matcher_golden_pkg/pkg/script.json        真实的 script.json（纯字节，让 C 端不带偏移地读）
  matcher_golden_pkg/pkg/*.png              用到的模板与全屏截图，名字 = 条目内原文件名的 basename
  matcher_golden_pkg/golden_pkg_cases.h     用例表（名字 + 期望值）

故意保留 ZIP 内部的原文件名（而非重命名），是为了顺带验证"ZIP 条目名里带 'image/xxx.png' 这类
子目录前缀"也能被正确匹配。

用法： python tools/make_package_golden.py <.auto> <outdir>
"""
import json
import os
import shutil
import sys
import zipfile

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_matcher_golden import rect4  # noqa: E402


def main():
    auto_path, outdir = sys.argv[1], sys.argv[2]
    pkg = os.path.join(outdir, "pkg")
    shutil.rmtree(outdir, ignore_errors=True)
    os.makedirs(pkg, exist_ok=True)

    zf = zipfile.ZipFile(auto_path)
    script_bytes = zf.read("script.json")
    script = json.loads(script_bytes.decode("utf-8"))
    open(os.path.join(pkg, "script.json"), "wb").write(script_bytes)

    groups = {g["id"]: g for g in script.get("image_list") or []}
    frames = {}
    for o in script.get("ori_infos") or []:
        frames.setdefault((o["width"], o["height"]), o["name"])

    # 复制用到的 PNG（模板 + 截图），并记录它们在本包内的名字
    def copy_entry(entry_name):
        base = os.path.basename(entry_name)
        with open(os.path.join(pkg, base), "wb") as f:
            f.write(zf.read(entry_name))
        return base

    for o in script.get("ori_infos") or []:
        copy_entry("ori/" + o["name"])
    for g in script.get("image_list") or []:
        for im in g.get("images") or []:
            copy_entry("image/" + im["file"])

    cases = []
    for sc in script.get("default_scene") or []:
        if sc.get("is_deleted") or sc.get("disabled"):
            continue
        grp_items = (sc.get("item_group") or {}).get("item_list") or []
        acts = sc.get("action_list") or []
        # 逐个条件项/动作取"它自己的"模板与搜索矩形 —— 注意两者必须来自同一条记录，
        # 否则会拿 A 的模板去 B 的搜索区里找，峰值必然很低（这是第一版的 bug）。
        pairs = []
        for it in grp_items:
            if it.get("image_id") and it.get("search_id"):
                pairs.append(("cond", it["image_id"], it["search_id"]))
        for ac in acts:
            if ac.get("image_id") and ac.get("search_id"):
                pairs.append(("act", ac["image_id"], ac["search_id"]))

        for kind, tpl_id, search_id in pairs:
            g = groups.get(tpl_id)
            if not g:
                continue
            var = next((v for v in script.get("var_list") or [] if v["id"] == search_id), None)
            if not var or not var.get("crops"):
                continue
            rec = var["crops"][0]
            si = rec.get("screen_info") or {}
            key = (si.get("width"), si.get("height"))
            # 选变体：必须是与该搜索矩形同一次录制分辨率的那个（精确相等）
            im = next((x for x in g["images"]
                       if (x["screen_info"]["width"], x["screen_info"]["height"]) == key), None)
            if im is None:
                continue
            # 关键：模板变体自带 `ori` 字段 —— 它就是该模板被裁出来的那张全屏截图。
            # 必须用它，**不能**按"分辨率相同的第一张截图"去猜：同一个分辨率下有多张截图
            # （不同场景各拍一张），猜错就变成"拿 A 的模板到 B 的截图里找"，峰值只有 0.2 左右。
            fname = im.get("ori") or frames.get(key)
            if not fname:
                continue

            tpl_path = os.path.join(pkg, os.path.basename(im["file"]))
            ori_path = os.path.join(pkg, fname)
            tpl_rgb = cv2.imdecode(np.frombuffer(open(tpl_path, "rb").read(), np.uint8),
                                   cv2.IMREAD_COLOR)
            ori_rgb = cv2.imdecode(np.frombuffer(open(ori_path, "rb").read(), np.uint8),
                                   cv2.IMREAD_COLOR)
            if tpl_rgb is None or ori_rgb is None:
                continue
            tgray = (tpl_rgb[:, :, 0].astype(np.uint32) * 77 + tpl_rgb[:, :, 1].astype(np.uint32) * 150
                     + tpl_rgb[:, :, 2].astype(np.uint32) * 29) >> 8
            fgray = cv2.cvtColor(ori_rgb, cv2.COLOR_BGR2GRAY)
            rx, ry, rw, rh = rect4(rec["rect"])
            roi = np.ascontiguousarray(fgray[ry:ry + rh, rx:rx + rw])
            tpl = np.ascontiguousarray(tgray.astype(np.uint8))
            if tpl.shape[0] > roi.shape[0] or tpl.shape[1] > roi.shape[1]:
                continue
            res = cv2.matchTemplate(roi, tpl, cv2.TM_CCOEFF_NORMED)
            _, mv, _, ml = cv2.minMaxLoc(res)
            cases.append({
                "tag": "p%02d_%s_%s" % (len(cases), kind, _ascii(g["name"])),
                "scene": _ascii(sc["name"]),
                "group": _ascii(g["name"]),
                "kind": kind,
                "tpl_file": os.path.basename(im["file"]),
                "ori_file": fname,
                "roi_x": rx, "roi_y": ry, "roi_w": rw, "roi_h": rh,
                "tpl_w": int(tpl.shape[1]), "tpl_h": int(tpl.shape[0]),
                "sim": float(g.get("sim", 0.8)),
                "expect_peak": float(max(mv, 0.0)),
                "expect_x": int(ml[0]), "expect_y": int(ml[1]),
            })

    with open(os.path.join(outdir, "golden_pkg_cases.h"), "w", encoding="utf-8") as f:
        f.write("/* 由 tools/make_package_golden.py 生成，请勿手改。*/\n")
        f.write("#ifndef AM_GOLDEN_PKG_CASES_H\n#define AM_GOLDEN_PKG_CASES_H\n\n")
        f.write("typedef struct {\n    const char *tag;\n")
        f.write("    const char *kind;\n    const char *scene;\n    const char *group;\n")
        f.write("    const char *tpl_file;\n    const char *ori_file;\n")
        f.write("    int roi_x, roi_y, roi_w, roi_h;\n")
        f.write("    int tpl_w, tpl_h;\n    double sim, expect_peak;\n")
        f.write("    int expect_x, expect_y;\n} am_pkg_case;\n\n")
        f.write("static const am_pkg_case AM_PKG_CASES[] = {\n")
        for c in cases:
            f.write('    { "%s", "%s", "%s", "%s", "%s", "%s", %d, %d, %d, %d, %d, %d, %.6f, %.17g, %d, %d },\n'
                    % (c["tag"], c["kind"], c["scene"], c["group"], c["tpl_file"], c["ori_file"],
                       c["roi_x"], c["roi_y"], c["roi_w"], c["roi_h"], c["tpl_w"], c["tpl_h"],
                       c["sim"], c["expect_peak"], c["expect_x"], c["expect_y"]))
        f.write("};\n\n#define AM_PKG_COUNT %d\n\n#endif\n" % len(cases))

    json.dump(cases, open(os.path.join(outdir, "golden_pkg.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("cases=%d pkg_files=%d" % (len(cases), len(os.listdir(pkg))))
    for c in cases:
        print("  %-26s tpl=%-16s %3dx%-3d roi=%3dx%-3d peak=%.6f @(%d,%d)"
              % (c["tag"], c["tpl_file"], c["tpl_w"], c["tpl_h"], c["roi_w"], c["roi_h"],
                 c["expect_peak"], c["expect_x"], c["expect_y"]))


def _ascii(s):
    return s.encode("ascii", "replace").decode("ascii").replace("?", "")


if __name__ == "__main__":
    main()
