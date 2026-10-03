#!/usr/bin/env python3
"""Verify the .auto matching semantics against the sample archive.

Hypothesis H1: `image.rect` is in `screen_info` pixel space; the template PNG
`image/<file>` is exactly that crop of the full screenshot `ori/<ori>`; the
runtime locates it with multi-scale matchTemplate at ratio >= `sim`, and the
tap point is `match_topleft + (rect.w/2, rect.h/2)` in the SAME pixel space.
"""
import sys, os, zipfile, json, io

import cv2
import numpy as np

ARCHIVE = r"C:\Users\relea\.dsh\attachments\v1\files\aa\aaa4fe1aa0ea55fc45aa43578e1814152671ef3d1f82a99f9dd61a91f003d017\幻想连战.auto"
WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample")


def load_png(blob, color=True):
    arr = np.frombuffer(blob, np.uint8)
    flag = cv2.IMREAD_COLOR if color else cv2.IMREAD_UNCHANGED
    img = cv2.imdecode(arr, flag)
    return img


def ratio_masked(img_a, img_b):
    """normalized agreement of two same-size BGR images."""
    a = img_a[:, :, :3].astype(np.int16)
    b = img_b[:, :, :3].astype(np.int16)
    diff = np.abs(a - b)
    return 1.0 - diff.mean() / 255.0


def main():
    z = zipfile.ZipFile(ARCHIVE)
    script = json.loads(z.read("script.json").decode("utf-8"))

    ori_cache = {}
    groups = list(script["image_list"])
    print("=== A. crop reproduction check (template == ori[rect]) ===")
    ok = bad = 0
    for grp in groups:
        for im in grp["images"]:
            ori = ori_cache.get(im["ori"])
            if ori is None:
                ori = load_png(z.read("ori/" + im["ori"]))
                ori_cache[im["ori"]] = ori
            tpl = load_png(z.read("image/" + im["file"]))
            x, y, w, h = [int(v) for v in im["rect"].split(",")]
            si = im["screen_info"]
            oh, ow = ori.shape[:2]
            crop = ori[y:y + h, x:x + w]
            shape_ok = (crop.shape[:2] == tpl.shape[:2])
            r = ratio_masked(crop, tpl) if shape_ok else -1
            flag = "OK " if (shape_ok and r > 0.999) else "BAD"
            if flag == "OK ":
                ok += 1
            else:
                bad += 1
            print(f"  {flag} {im['file'][:14]:>14} ori={im['ori'][:14]:>14} "
                  f"ori={ow}x{oh} si={si['width']}x{si['height']} rect={im['rect']:>20} "
                  f"tpl={tpl.shape[1]}x{tpl.shape[0]} crop={crop.shape[1]}x{crop.shape[0]} match={r:.4f}")
    print(f"  -> crop reproduction: {ok} ok / {bad} bad")

    print()
    print("=== B. full-screen match localisation (single scale, TM_CCOEFF_NORMED) ===")
    for grp in groups:
        gsim = float(grp.get("sim", "0.8"))
        for im in grp["images"]:
            ori = ori_cache[im["ori"]]
            tpl = load_png(z.read("image/" + im["file"]))
            oh, ow = ori.shape[:2]
            res = cv2.matchTemplate(ori, tpl, cv2.TM_CCOEFF_NORMED)
            mn, mx, mnloc, mxloc = cv2.minMaxLoc(res)
            ys, xs = np.where(res >= gsim)
            peaks = len(set(zip(xs.tolist(), ys.tolist())))
            print(f"  {im['file'][:14]:>14} ori={ow}x{oh} sim={gsim} thr={im['threshold']} "
                  f"best={mx:.4f}@{mxloc} expect_rect_tl={tuple(int(v) for v in im['rect'].split(',')[:2])} "
                  f"pixels>=sim={peaks}")

    print()
    print("=== C. rect==match position? (compare rect to best-match topleft) ===")
    hit = 0
    tot = 0
    for grp in groups:
        for im in grp["images"]:
            ori = ori_cache[im["ori"]]
            tpl = load_png(z.read("image/" + im["file"]))
            res = cv2.matchTemplate(ori, tpl, cv2.TM_CCOEFF_NORMED)
            _, mx, _, mxloc = cv2.minMaxLoc(res)
            x, y, w, h = [int(v) for v in im["rect"].split(",")]
            tot += 1
            d = max(abs(mxloc[0] - x), abs(mxloc[1] - y))
            if d <= 2:
                hit += 1
            print(f"  {im['file'][:14]:>14} rect_tl=({x},{y}) best={mxloc} delta={d} score={mx:.4f}")
    print(f"  -> exact reproduction: {hit}/{tot}")


if __name__ == "__main__":
    main()
