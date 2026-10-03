#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
auto_match.h 的对照实验夹具生成器。

目的：把"OpenCV TM_CCOEFF_NORMED 的答案"固化成黄金数据，让纯 C 实现（core/auto_match.c）可以被
逐点核对 —— 这是 iOS 端能否与 Android 端行为一致的唯一可验证保证。

变体选择（严格照抄 Android `EditorImage.createImage` / `getAdapterInfo`，见反编译证据）：
    int adapter = group.adapter_type;
    if (adapter == -1) adapter = script.adapter;          // 样本: script.adapter = 1
    info = getImageInfo(curScreen);                       // 屏幕信息精确相等
    if (info == null && adapter != 0) info = getAdapterInfo(curScreen, adapter);
    // getAdapterInfo(_, mode): mode==2 → 按长宽比最近; 否则 → |Δdensity| 最小（取先出现者）
    orientation = (info.screen.width > info.screen.height) ? 1 : 2;   // 1=landscape 2=portrait

搜索矩形（crop）：Android `EditorCrop.getAdapterValue` 按"当前长边/录制长边(x) + 当前短边/录制短边(y)"
独立缩放；crop 只有一个分辨率版本，录制分辨率 = crop.screen_info。

本脚本的取舍：为了让夹具同时（a）覆盖真实尺度、（b）避免把一个变体的模板配到另一台设备的截图上从而
人为拉低分数，**按每个搜索矩形各自记录的分辨率选取模板变体与截图**（这正是 Android 在同分辨率设备上
走的那条路径：getImageInfo 精确命中，不缩放）。跨设备的缩放路径由 C 单元测试另行覆盖。

灰度化：模板 PNG 是 4 通道（RGBA），Android base/c.java 对 4 通道走 `Imgproc.a(m, m2, 6)`
（OpenCV 3.4.1 = COLOR_BGRA2GRAY，加权亮度），脚本里的 `threshold=150` 是阈值化模式(type 3)用的，
与本实验无关。这里用 cv2.COLOR_BGRA2GRAY 复现之；同时输出 channel-mean 版本用于对照。

用法：
    python tools/make_matcher_golden.py <.auto> <outdir>
产出：
    <outdir>/raw/<tag>_roi.bin / _tpl.bin   单通道灰度原始字节
    <outdir>/golden_cases.h                 C 头文件（尺寸 + 期望峰值/位置）
    <outdir>/golden.json / golden_report.txt
"""
import json
import os
import sys
import zipfile

import cv2
import numpy as np


def rect4(s):
    p = [int(x) for x in str(s).replace("，", ",").split(",")]
    return (p[0], p[1], p[2], p[3]) if len(p) >= 4 else (p[0], p[1], 1, 1)


def decode_gray(buf, mode):
    """mode: 'bgra2gray' | 'mean'。IMREAD_UNCHANGED 保留 alpha 才能做真 BGRA2GRAY。"""
    img = cv2.imdecode(np.frombuffer(buf, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    if img.ndim == 2:
        return img
    if mode == "mean":
        if img.shape[2] == 4:
            img = img[:, :, :3]
        return np.clip(img.astype(np.float64).mean(axis=2), 0, 255).astype(np.uint8)
    if img.shape[2] == 4:
        return cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY)
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def main():
    auto_path, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(os.path.join(outdir, "raw"), exist_ok=True)

    zf = zipfile.ZipFile(auto_path)
    script = json.loads(zf.read("script.json").decode("utf-8"))
    imgs = {g["id"]: g for g in script.get("image_list") or []}
    vars_ = {v["id"]: v for v in script.get("var_list") or []}
    script_adapter = int(script.get("adapter", 1) or 0)

    def pick_variant(grp, want_si):
        """复刻 getImageInfo → getAdapterInfo(_, mode) 的选变体逻辑。"""
        cand = grp.get("images") or []
        if want_si:
            for im in cand:  # 精确相等优先
                si = im.get("screen_info") or {}
                if (si.get("width"), si.get("height"), si.get("density"),
                        si.get("pixelStride"), si.get("rowPadding")) == (
                        want_si.get("width"), want_si.get("height"), want_si.get("density"),
                        want_si.get("pixelStride"), want_si.get("rowPadding")):
                    return im, "exact"
        adapter = grp.get("adapter_type")
        adapter = script_adapter if adapter is None or adapter == -1 else int(adapter)
        if not want_si or adapter == 0:
            return (cand[0] if cand else None), "fallback-first"
        best, bestd = None, None
        for im in cand:
            si = im.get("screen_info") or {}
            d = abs(int(want_si.get("density") or 0) - int(si.get("density") or 0))
            if bestd is None or d < bestd:
                best, bestd = im, d
        return best, "min-density-delta(%d)" % bestd

    cases, report = [], []
    seen = set()
    for si, sc in enumerate(script.get("default_scene") or []):
        if sc.get("disabled"):
            continue
        for kind, lst in (("cond", (sc.get("item_group") or {}).get("item_list") or []),
                          ("act", sc.get("action_list") or [])):
            for ii, it in enumerate(lst):
                gid, sid = it.get("image_id"), it.get("search_id")
                if not gid or not sid or gid not in imgs or sid not in vars_:
                    continue
                grp, var = imgs[gid], vars_[sid]
                crops = var.get("crops") or []
                if not crops:
                    continue
                crop = crops[0]
                sr = rect4(crop["rect"])
                key = (gid, sr)
                if key in seen:
                    continue
                seen.add(key)

                chosen, how = pick_variant(grp, crop.get("screen_info"))
                if chosen is None:
                    continue
                ori_name = crop.get("ori") or chosen.get("ori")
                ori = cv2.imdecode(np.frombuffer(zf.read("ori/" + ori_name), np.uint8),
                                   cv2.IMREAD_COLOR)
                if ori is None:
                    continue
                H, W = ori.shape[:2]

                tpl = decode_gray(zf.read("image/" + chosen["file"]), "bgra2gray")
                tpl_mean = decode_gray(zf.read("image/" + chosen["file"]), "mean")
                tx, ty, tw, th = rect4(chosen["rect"])

                frame_gray = cv2.cvtColor(ori, cv2.COLOR_BGR2GRAY)
                rx, ry, rw, rh = sr
                rw, rh = min(rw, W - rx), min(rh, H - ry)
                if rw <= 0 or rh <= 0 or rw < tw or rh < th:
                    report.append("skip %s/%s: roi %dx%d < tpl %dx%d" % (sc.get("name"), grp["name"], rw, rh, tw, th))
                    continue
                roi = frame_gray[ry:ry + rh, rx:rx + rw].copy()

                res = cv2.matchTemplate(roi, tpl, cv2.TM_CCOEFF_NORMED)
                _, mv, _, ml = cv2.minMaxLoc(res)
                res2 = cv2.matchTemplate(roi, tpl_mean, cv2.TM_CCOEFF_NORMED)
                mv2, ml2 = cv2.minMaxLoc(res2)[1], cv2.minMaxLoc(res2)[3]

                tag = "c%02d_%s_%s" % (len(cases), kind, grp["id"][:6])
                open(os.path.join(outdir, "raw", tag + "_roi.bin"), "wb").write(roi.tobytes())
                open(os.path.join(outdir, "raw", tag + "_tpl.bin"), "wb").write(tpl.tobytes())
                cases.append({
                    "tag": tag, "scene": sc.get("name"), "kind": kind, "group": grp["name"],
                    "variant": how, "tpl_file": chosen["file"], "ori": ori_name,
                    "screen": chosen.get("screen_info"), "tpl_rect": chosen["rect"],
                    "tpl_w": int(tpl.shape[1]), "tpl_h": int(tpl.shape[0]),
                    "roi_w": int(roi.shape[1]), "roi_h": int(roi.shape[0]),
                    "roi_x": rx, "roi_y": ry,
                    "expect_peak": float(max(mv, 0.0)), "expect_x": int(ml[0]), "expect_y": int(ml[1]),
                    "expect_match_x": rx + int(ml[0]), "expect_match_y": ry + int(ml[1]),
                    "peak_mean_gray": float(max(mv2, 0.0)),
                    "x_mean_gray": int(ml2[0]), "y_mean_gray": int(ml2[1]),
                    "sim": grp.get("sim"),
                })
                report.append("%-20s %-22s tpl=%3dx%-3d roi=%3dx%-3d peak=%.9f @(%3d,%3d) | meangray %.9f @(%3d,%3d) | %s"
                              % (tag, "%s/%s" % (sc.get("name"), grp["name"]),
                                 tpl.shape[1], tpl.shape[0], roi.shape[1], roi.shape[0],
                                 max(mv, 0.0), ml[0], ml[1], max(mv2, 0.0), ml2[0], ml2[1], how))

    with open(os.path.join(outdir, "golden_cases.h"), "w", encoding="utf-8") as f:
        f.write("/* 由 tools/make_matcher_golden.py 生成，请勿手改。*/\n")
        f.write("#ifndef AUTO_MATCH_GOLDEN_CASES_H\n#define AUTO_MATCH_GOLDEN_CASES_H\n\n")
        f.write("typedef struct {\n    const char *tag;\n")
        f.write("    int tpl_w, tpl_h, roi_w, roi_h;\n")
        f.write("    double expect_peak;\n    int expect_x, expect_y;\n} am_golden_case;\n\n")
        f.write("static const am_golden_case AM_GOLDEN_CASES[] = {\n")
        for c in cases:
            f.write('    { "%s", %d, %d, %d, %d, %.17g, %d, %d },\n'
                    % (c["tag"], c["tpl_w"], c["tpl_h"], c["roi_w"], c["roi_h"],
                       c["expect_peak"], c["expect_x"], c["expect_y"]))
        f.write("};\n\n#define AM_GOLDEN_COUNT %d\n\n#endif\n" % len(cases))

    json.dump(cases, open(os.path.join(outdir, "golden.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    open(os.path.join(outdir, "golden_report.txt"), "w", encoding="utf-8").write("\n".join(report) + "\n")
    print("cases=%d" % len(cases))
    for line in report:
        print(line.encode("ascii", "replace").decode("ascii"))


if __name__ == "__main__":
    main()
