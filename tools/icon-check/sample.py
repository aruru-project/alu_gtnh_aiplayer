#!/usr/bin/env python3
"""Many icons at once on the grey of an inventory slot: sample.py PACKDATA OUT.png [random N SEED | rows A,B,C… | prefix ID_PREFIX [N]]"""
import json, os, random, sys
from PIL import Image, ImageDraw
pack, out, mode = sys.argv[1], sys.argv[2], sys.argv[3]
info = json.load(open(os.path.join(pack, "icons", "icons.json"), encoding="utf8"))
items = [json.loads(l) for l in open(os.path.join(pack, "items.jsonl"), encoding="utf8")]
cell, C, R = info["cell"], info["columns"], info["rows"]
per = C * R
if mode == "random":
    random.seed(int(sys.argv[5]) if len(sys.argv) > 5 else 1)
    rows = sorted(random.sample(range(len(items)), int(sys.argv[4])))
elif mode == "rows":
    rows = [int(v) for v in sys.argv[4].split(",")]
else:
    rows = [n for n, it in enumerate(items) if it["id"].startswith(sys.argv[4])]
    if len(sys.argv) > 5:
        step = max(1, len(rows) // int(sys.argv[5])); rows = rows[::step][:int(sys.argv[5])]
sheets = {}
def icon(n):
    s = n // per
    if s not in sheets: sheets[s] = Image.open(os.path.join(pack, "icons", info["files"][s])).convert("RGBA")
    i = n % per
    x, y = (i % C) * cell, (i // C) * cell
    return sheets[s].crop((x, y, x + cell, y + cell))
Z, per_row, slot = 2, 24, 36 * 2
W = per_row * slot
H = ((len(rows) + per_row - 1) // per_row) * slot
im = Image.new("RGBA", (W, H), (198, 198, 198, 255))
d = ImageDraw.Draw(im)
for k, n in enumerate(rows):
    x, y = (k % per_row) * slot, (k // per_row) * slot
    d.rectangle((x + 2, y + 2, x + slot - 3, y + slot - 3), fill=(139, 139, 139, 255))
    im.alpha_composite(icon(n).resize((cell * Z, cell * Z), Image.NEAREST), (x + 4, y + 4))
im.convert("RGB").save(out)
print(out, im.size, len(rows))
print(" ".join("%d:%s/%d" % (n, items[n]["id"], items[n]["meta"]) for n in rows[:per_row * 2]))
