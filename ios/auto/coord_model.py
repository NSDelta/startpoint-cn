"""Establish the click-point model for .auto scripts.

For every scene item/action (which references image_id = a template group and
search_id = a var crop), report:
    match_tl (via TM_CCOEFF_NORMED on the stored full screenshot)
    tpl_center, crop_center, offset = crop_center - tpl_center
If offset is constant across scenes/screens -> click = match_center + offset.
"""
import zipfile, json, os, sys
import numpy as np, cv2

sys.stdout.reconfigure(encoding='utf-8')
AUTO = sys.argv[1] if len(sys.argv) > 1 else \
    r'C:\Users\relea\.dsh\attachments\v1\files\aa\aaa4fe1aa0ea55fc45aa43578e1814152671ef3d1f82a99f9dd61a91f003d017\幻想连战.auto'
z = zipfile.ZipFile(AUTO)
s = json.loads(z.read('script.json').decode('utf-8'))


def load_png(b):
    return cv2.imdecode(np.frombuffer(b, np.uint8), cv2.IMREAD_COLOR)


def rect_of(o):
    return [int(v) for v in o['rect'].split(',')]


imgs_by_id, ori_cache = {}, {}
for grp in s['image_list']:
    for im in grp['images']:
        # image_id refers to the GROUP id; a group carries one variant per device res
        imgs_by_id.setdefault(str(grp['id']), []).append((grp, im))
vars_by_id = {str(v['id']): v for v in s.get('var_list', [])}
print('image_list groups =', len(s['image_list']), ' image entries =', len(imgs_by_id),
      ' var_list =', len(vars_by_id))

offs = []
for sc in s['default_scene']:
    print()
    print(f"SCENE {sc['name']}  disabled={sc.get('disabled')}")
    refs = []
    ig = sc.get('item_group') or {}
    for it in (ig.get('item_list') or []):
        refs.append(('cond', it))
    for ac in (sc.get('action_list') or []):
        refs.append(('act ', ac))
    for kind, o in refs:
        variants = imgs_by_id[str(o['image_id'])]
        var = vars_by_id.get(str(o['search_id']))
        print(f"  {kind} image_id={o['image_id']} -> group '{variants[0][0]['name']}' "
              f"variant_count={len(variants)} sim={variants[0][0].get('sim')} "
              f"search_id={o['search_id']} extra_keys={[k for k in o if k not in ('is_new','is_deleted','modified','conflict','type','id','relation','state','image_id','search_id','timeout','reset_timeout','postpone','button','press_time','click_times','interval')]}")
        for grp, im in variants:
            ori = ori_cache.get(im['ori'])
            if ori is None:
                ori = load_png(z.read('ori/' + im['ori']))
                ori_cache[im['ori']] = ori
            tpl = load_png(z.read('image/' + im['file']))
            res = cv2.matchTemplate(ori, tpl, cv2.TM_CCOEFF_NORMED)
            _, mx, _, mxloc = cv2.minMaxLoc(res)
            r = rect_of(im)
            mw, mh = tpl.shape[1], tpl.shape[0]
            mc = (mxloc[0] + mw // 2, mxloc[1] + mh // 2)
            tc = (r[0] + r[2] // 2, r[1] + r[3] // 2)
            oh, ow = ori.shape[:2]
            cr = rect_of(var['crops'][0]) if (var and var.get('crops')) else None
            cc = (cr[0] + cr[2] // 2, cr[1] + cr[3] // 2) if cr else None
            off = (cc[0] - mc[0], cc[1] - mc[1]) if cc else None
            if off:
                offs.append((off, sc['name'], grp['name'], mc[0], mc[1], im['ori'], ow, oh))
            print(f"        ori={im['ori']} {ow}x{oh} tpl={r} score={mx:.3f} match_tl={mxloc} "
                  f"match_center={mc} tpl_center={tc}")
            print(f"        crop_rect={cr} crop_center={cc} (crop_center - match_center)={off}")

print()
print('=== offset (crop_center - match_center) distribution ===')
dxs = [o[0][0] for o in offs]
dys = [o[0][1] for o in offs]
print('  n =', len(offs), ' dx range', min(dxs), max(dxs), ' dy range', min(dys), max(dys))
for o in offs:
    print(f"    {o[1]:<8} {o[2]:<8} center=({o[3]},{o[4]}) ori={o[5]:<20} off={o[0]}")

# Are crop rects always a small box around the template?  Compare crop size vs tpl size
print()
print('=== crop size vs template size ===')
for sc in s['default_scene']:
    ig = sc.get('item_group') or {}
    for it in (ig.get('item_list') or []) + (sc.get('action_list') or []):
        grp, im = imgs_by_id[str(it['image_id'])]
        var = vars_by_id.get(str(it['search_id']))
        if not var or not var.get('crops'):
            continue
        cr = rect_of(var['crops'][0])
        r = rect_of(im)
        print(f"  {sc['name']:<8} {grp['name']:<8} tpl={r[2]}x{r[3]} crop={cr[2]}x{cr[3]} "
              f"crop/tpl=({cr[2]/r[2]:.2f},{cr[3]/r[3]:.2f}) crop_in_ori={cr[0]},{cr[1]} tpl_in_ori={r[0]},{r[1]}")
