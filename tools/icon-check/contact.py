#!/usr/bin/env python3
"""Contact sheet of chosen icons: each on a checkerboard (shows transparency), on slot grey and on white.

  contact.py PACKDATA OUT.png SPEC...     SPEC = id/meta | id (first row with that id) | name:中文名 | row:N
"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

pack, out, specs = sys.argv[1], sys.argv[2], sys.argv[3:]
info = json.load(open(os.path.join(pack, "icons", "icons.json"), encoding="utf8"))
cell, cols, rows = info["cell"], info["columns"], info["rows"]
per = cols * rows
items = [json.loads(l) for l in open(os.path.join(pack, "items.jsonl"), encoding="utf8")]
assert len(items) == info["count"], (len(items), info["count"])
by_key, by_id, by_name = {}, {}, {}
for n, it in enumerate(items):
    by_key.setdefault("%s/%d" % (it["id"], it["meta"]), n)
    by_id.setdefault(it["id"], n)
    by_name.setdefault(it.get("name", ""), n)
sheets = {}
def icon(n):
    s = n // per
    if s not in sheets:
        sheets[s] = Image.open(os.path.join(pack, "icons", info["files"][s])).convert("RGBA")
    i = n % per
    x, y = (i % cols) * cell, (i // cols) * cell
    return sheets[s].crop((x, y, x + cell, y + cell))
def find(spec):
    if spec.startswith("row:"): return int(spec[4:])
    if spec.startswith("name:"): return by_name.get(spec[5:])
    return by_key.get(spec, by_id.get(spec))
Z = 6
big = cell * Z
font = None
for p in ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
          "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
    if os.path.exists(p):
        font = ImageFont.truetype(p, 15); break
font = font or ImageFont.load_default()
def checker():
    im = Image.new("RGBA", (big, big), (255, 255, 255, 255)); d = ImageDraw.Draw(im)
    q = Z * 4
    for yy in range(0, big, q):
        for xx in range(0, big, q):
            if (xx // q + yy // q) % 2: d.rectangle((xx, yy, xx + q - 1, yy + q - 1), fill=(200, 200, 200, 255))
    return im
pad, label_h = 10, 60
tile_w = big * 3 + pad * 4
per_row = 3
W = tile_w * per_row
nrows = (len(specs) + per_row - 1) // per_row
sheet = Image.new("RGBA", (W, nrows * (big + label_h + pad)), (40, 40, 46, 255))
d = ImageDraw.Draw(sheet)
missing = set(info["missing"])
for k, spec in enumerate(specs):
    n = find(spec)
    ox, oy = (k % per_row) * tile_w, (k // per_row) * (big + label_h + pad)
    if n is None:
        d.text((ox + pad, oy + pad), "not in items.jsonl: " + spec, fill=(255, 120, 120), font=font); continue
    ic = icon(n).resize((big, big), Image.NEAREST)
    for j, bg in enumerate((checker(), Image.new("RGBA", (big, big), (139, 139, 139, 255)), Image.new("RGBA", (big, big), (255, 255, 255, 255)))):
        bg.alpha_composite(ic)
        sheet.paste(bg, (ox + pad + j * (big + pad), oy + pad))
    it = items[n]
    a = icon(n).getchannel("A").getextrema()
    d.text((ox + pad, oy + pad + big + 2), "%s/%d  row %d%s" % (it["id"], it["meta"], n, "  MISSING" if n in missing else ""), fill=(230, 230, 230), font=font)
    d.text((ox + pad, oy + pad + big + 22), "%s | %s | alpha %d..%d" % (it.get("name", ""), it.get("en", ""), a[0], a[1]), fill=(180, 200, 255), font=font)
sheet.convert("RGB").save(out)
print(out, sheet.size)
