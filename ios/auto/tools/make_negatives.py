#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成"错配用例"夹具：把 A 场景的模板拿去 B 场景的截图上匹配。

为什么需要：正例（模板就是从该截图里裁的）峰值恒为 1.0，只能验"找得到"，验不出**判别力**。
真正致命的是假阳性 —— 一张不相干的界面被打了 0.8 以上，导致脚本乱点。
所以这里造一批"应当被拒绝"的组合，把 cv2 的分数固化成黄金值，让 C 实现证明它同样拒绝。

做法：对每张 ori 截图 × 每个模板变体（只取与该截图同分辨率的变体，避免尺寸不匹配），
按该模板自己的 rect 为中心外扩 3 倍做搜索区（靠近边界时贴边），算 cv2 的 NCC 峰值。
只保留 peak < 0.8 的"真·错配"（这些是判别力证据），并把 peak >= 0.8 的打印出来人工看。

用法： python tools/make_negatives.py <.auto> <outdir>
产出： <outdir>/raw/<tag>_roi.bin, <tag>_tpl.bin, golden_neg_cases.h, neg_report.txt
"""
import json
import os
import sys
import zipfile

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_matcher_golden import decode_gray, rect4  # noqa: E402


def main():
    auto_path, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(os.path.join(outdir, "raw"), exist_ok=True)
    zf = zipfile.ZipFile(auto_path)
    script = json.loads(zf.read("script.json").decode("utf-8"))

    # 去重后的截图（按 (w,h) 分组，每组挑一张）
    frames = {}
    for o in script.get("ori_infos") or []:
        key = (o["width"], o["height"])
        if key not in frames:
            try:
                img = cv2.imdecode(np.frombuffer(zf.read("ori/" + o["name"]), np.uint8),
                                   cv2.IMREAD_COLOR)
            except KeyError:
                continue
            if img is not None:
                frames[key] = (o["name"], img)

    # 模板变体（按 (w,h) 索引），并记录它"属于"哪个截图（ori 字段），用于排除自家人
    variants = []
    for g in script.get("image_list") or []:
        for im in g.get("images") or []:
            si = im.get("screen_info") or {}
            variants.append((g, im, (si.get("width"), si.get("height"))))

    cases, report = [], []
    for (fw, fh), (fname, fimg) in sorted(frames.items()):
        fgray = cv2.cvtColor(fimg, cv2.COLOR_BGR2GRAY)
        for g, im, vkey in variants:
            if vkey != (fw, fh):
                continue  # 只测同分辨率的错配（跨分辨率另有缩放逻辑，不属本测试范围）
            if im.get("ori") == fname:
                continue  # 自家截图 → 峰值恒 1.0，不是错配
            tpl = decode_gray(zf.read("image/" + im["file"]), "bgra2gray")
            tx, ty, tw, th = rect4(im["rect"])
            if tw > fw or th > fh:
                continue
            # 搜索区：以模板 rect 为中心外扩 2 倍模板尺寸，贴边裁剪
            rx = max(0, tx - tw)
            ry = max(0, ty - th)
            rw = min(fw - rx, tw * 3)
            rh = min(fh - ry, th * 3)
            if rw < tw or rh < th:
                continue
            # 退化几何：搜索区若只剩一个候选位置，NCC 恒为 1.0（零方差窗口），没有任何判别力信息。
            # 要求至少 2x2 个候选位置，否则这个"用例"只会污染黄金数据。
            if (rw - tw + 1) * (rh - th + 1) < 4:
                continue
            roi = fgray[ry:ry + rh, rx:rx + rw].copy()
            res = cv2.matchTemplate(roi, tpl, cv2.TM_CCOEFF_NORMED)
            _, mv, _, ml = cv2.minMaxLoc(res)
            peak = float(max(mv, 0.0))
            if peak >= 1.0 - 1e-12:
                continue  # 逐像素完全相同，属于"其实是同一图案"，不算错配
            tag = "n%02d_%s_on_%s" % (len(cases), g["id"][:6], fname.split(".")[0][-6:])
            line = "%-28s tpl=%-18s %3dx%-3d on %dx%d  peak=%.6f @(%d,%d)%s" % (
                tag, g["name"], tw, th, fw, fh, peak, ml[0], ml[1],
                "   <== >=0.8 需人工确认" if peak >= 0.8 else "")
            report.append(line)
            if peak >= 0.8:
                continue  # 疑似真阳性，不进错配夹具
            open(os.path.join(outdir, "raw", tag + "_roi.bin"), "wb").write(roi.tobytes())
            open(os.path.join(outdir, "raw", tag + "_tpl.bin"), "wb").write(tpl.tobytes())
            cases.append({"tag": tag, "group": g["name"], "frame": fname,
                          "tpl_w": int(tpl.shape[1]), "tpl_h": int(tpl.shape[0]),
                          "roi_w": int(roi.shape[1]), "roi_h": int(roi.shape[0]),
                          "expect_peak": peak, "expect_x": int(ml[0]), "expect_y": int(ml[1])})

    with open(os.path.join(outdir, "golden_neg_cases.h"), "w", encoding="utf-8") as f:
        f.write("/* 由 tools/make_negatives.py 生成，请勿手改。*/\n")
        f.write("#ifndef AUTO_MATCH_GOLDEN_NEG_CASES_H\n#define AUTO_MATCH_GOLDEN_NEG_CASES_H\n\n")
        f.write("typedef struct {\n    const char *tag;\n")
        f.write("    int tpl_w, tpl_h, roi_w, roi_h;\n")
        f.write("    double expect_peak;\n    int expect_x, expect_y;\n} am_golden_neg_case;\n\n")
        f.write("static const am_golden_neg_case AM_GOLDEN_NEG_CASES[] = {\n")
        for c in cases:
            f.write('    { "%s", %d, %d, %d, %d, %.17g, %d, %d },\n'
                    % (c["tag"], c["tpl_w"], c["tpl_h"], c["roi_w"], c["roi_h"],
                       c["expect_peak"], c["expect_x"], c["expect_y"]))
        f.write("};\n\n#define AM_GOLDEN_NEG_COUNT %d\n\n#endif\n" % len(cases))

    open(os.path.join(outdir, "neg_report.txt"), "w", encoding="utf-8").write("\n".join(report) + "\n")
    json.dump(cases, open(os.path.join(outdir, "golden_neg.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("frames=%d variants=%d negatives=%d" % (len(frames), len(variants), len(cases)))
    for line in report:
        print(line.encode("ascii", "replace").decode("ascii"))


if __name__ == "__main__":
    main()
