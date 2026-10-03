#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dump_sample.py —— 把一份 .auto 的 script.json 结构化成可直接读的 Markdown/JSON 清单。

为什么需要它：Windows 控制台是 GBK，直接 print 中文场景名会 UnicodeEncodeError 或乱码。
所以**所有输出一律写文件**（UTF-8），stdout 只打印 ASCII 统计。

用法：
    python dump_sample.py <script.json> <outdir>

产出：
    <outdir>/structure.md   —— 人读：顶层键、image_list、var_list、逐场景逐条件逐动作
    <outdir>/structure.json —— 机读：同上 + 解析后的 int rect
"""
import json
import os
import sys


def parse_rect(s):
    """'x,y,w,h' -> (x, y, w, h)；只有两段时 w=h=1（与 Android b2.a.C 一致）。"""
    if not s:
        return None
    parts = [p for p in s.replace("，", ",").split(",")]
    try:
        v = [int(p) for p in parts]
    except ValueError:
        return None
    if len(v) >= 4:
        return tuple(v[:4])
    if len(v) == 2:
        return (v[0], v[1], 1, 1)
    return None


def main():
    src = sys.argv[1]
    outdir = sys.argv[2]
    os.makedirs(outdir, exist_ok=True)
    d = json.load(open(src, encoding="utf-8"))

    imgs = {g["id"]: g for g in d.get("image_list") or []}
    vars_ = {v["id"]: v for v in d.get("var_list") or []}
    oris = {o.get("name"): o for o in d.get("ori_infos") or []}

    L = []
    A = L.append

    A("# .auto script.json 结构清单")
    A("")
    A("## 顶层")
    A("")
    A("| 键 | 值 |")
    A("| --- | --- |")
    for k, v in d.items():
        if isinstance(v, (list, dict)):
            A("| `%s` | <%s len=%d> |" % (k, type(v).__name__, len(v)))
        else:
            A("| `%s` | `%s` |" % (k, v))
    A("")

    A("## ori_infos（录制设备屏幕）")
    A("")
    A("| name | width | height | density | pixelStride | rowPadding |")
    A("| --- | --- | --- | --- | --- | --- |")
    for o in d.get("ori_infos") or []:
        A("| `%s` | %s | %s | %s | %s | %s |" % (
            o.get("name"), o.get("width"), o.get("height"), o.get("density"),
            o.get("pixelStride"), o.get("rowPadding")))
    A("")

    A("## image_list（模板组）共 %d 组" % len(imgs))
    A("")
    A("| name | id | sim | adapter_type | 变体数 | 变体(file / screen_info / rect / type / threshold) |")
    A("| --- | --- | --- | --- | --- | --- |")
    for g in d.get("image_list") or []:
        cells = []
        for im in g.get("images") or []:
            si = im.get("screen_info") or {}
            cells.append("`%s` %sx%s@%s rect=%s type=%s thr=%s" % (
                im.get("file"), si.get("width"), si.get("height"), si.get("density"),
                im.get("rect"), im.get("type"), im.get("threshold")))
        A("| %s | `%s` | %s | %s | %d | %s |" % (
            g.get("name"), g.get("id"), g.get("sim"), g.get("adapter_type"),
            len(g.get("images") or []), "<br>".join(cells)))
    A("")

    A("## var_list（变量 / 裁切矩形）共 %d 个" % len(vars_))
    A("")
    A("| name | type | value(=默认 crop 串) | is_local | is_config | crops |")
    A("| --- | --- | --- | --- | --- | --- |")
    for v in d.get("var_list") or []:
        cs = []
        for c in v.get("crops") or []:
            si = c.get("screen_info") or {}
            cs.append("`%s` ori=%s %sx%s@%s orientation=%s" % (
                c.get("rect"), c.get("ori"), si.get("width"), si.get("height"),
                si.get("density"), c.get("orientation")))
        A("| %s | %s | `%s` | %s | %s | %s |" % (
            v.get("name"), v.get("type"), v.get("value"), v.get("is_local"),
            v.get("is_config"), "<br>".join(cs)))
    A("")

    for top in ("common_event", "common_event_low", "scene_list", "default_scene"):
        scenes = d.get(top) or []
        if not scenes:
            A("## %s —— 空" % top)
            A("")
            continue
        A("## %s —— %d 个场景" % (top, len(scenes)))
        A("")
        for s in scenes:
            A("### 场景 `%s`（id=%s%s）" % (
                s.get("name", s.get("id")), s.get("id"),
                "，disabled" if s.get("disabled") else ""))
            A("")
            gate = s.get("scene_event")
            A("- 场景门（scene_event）：%s" % ("有" if gate else "无"))
            if gate:
                A("- 门内条件项：%d，动作：%d" % (
                    len((gate.get("item_group") or {}).get("item_list") or []),
                    len(gate.get("action_list") or [])))
            grp = s.get("item_group") or {}
            A("- item_group.type=%s relation=%s" % (grp.get("type"), grp.get("relation")))
            A("")
            items = grp.get("item_list") or []
            if items:
                A("| # | type | state | timeout | reset_timeout | 模板 | sim | 搜索变量 | 裁切矩形(点击范围) | 模板变体数 |")
                A("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
                for i, e in enumerate(items):
                    g = imgs.get(e.get("image_id"))
                    v = vars_.get(e.get("search_id"))
                    crop = (v.get("crops") or [{}])[0].get("rect") if v else None
                    A("| %d | %s | %s | %s | %s | %s | %s | %s | `%s` | %d |" % (
                        i, e.get("type"), e.get("state"), e.get("timeout"),
                        e.get("reset_timeout"), g and g.get("name"),
                        g and g.get("sim"), (v or {}).get("name"), crop,
                        len((g or {}).get("images") or [])))
                A("")
            acts = s.get("action_list") or []
            if acts:
                A("| # | type | postpone | press_time | click_times | interval | 模板 | button | search_id | deviation_id |")
                A("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
                for i, a in enumerate(acts):
                    g = imgs.get(a.get("image_id")) if a.get("image_id") else None
                    A("| %d | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
                        i, a.get("type"), a.get("postpone"), a.get("press_time"),
                        a.get("click_times"), a.get("interval"), g and g.get("name"),
                        a.get("button"), a.get("search_id") or "", a.get("deviation_id") or ""))
                A("")

    md = "\n".join(L) + "\n"
    open(os.path.join(outdir, "structure.md"), "w", encoding="utf-8").write(md)

    # 机读版：补上解析后的 rect
    out = {"header": {k: v for k, v in d.items() if not isinstance(v, (list, dict))},
           "image_list": d.get("image_list"), "var_list": d.get("var_list"),
           "scenes": {}}
    for top in ("common_event", "common_event_low", "scene_list", "default_scene"):
        out["scenes"][top] = d.get(top) or []
    out["parsed_rects"] = {
        "images": {g["id"]: [parse_rect(im.get("rect")) for im in g.get("images") or []]
                   for g in d.get("image_list") or []},
        "crops": {v["id"]: [parse_rect((c or {}).get("rect")) for c in v.get("crops") or []]
                  for v in d.get("var_list") or []},
    }
    json.dump(out, open(os.path.join(outdir, "structure.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    print("scenes(default)=%d scenes(list)=%d images=%d vars=%d oris=%d" % (
        len(d.get("default_scene") or []), len(d.get("scene_list") or []),
        len(imgs), len(vars_), len(oris)))
    print("wrote %s and %s" % (os.path.join(outdir, "structure.md"),
                               os.path.join(outdir, "structure.json")))


if __name__ == "__main__":
    main()
