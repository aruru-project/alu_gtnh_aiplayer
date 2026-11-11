#!/usr/bin/env python3
"""Numbers about the icon sheets: empty cells, cells that are the game's "missing texture" pattern, by mod."""
import json, os, sys, collections
from PIL import Image
import numpy as np
pack = sys.argv[1]
info = json.load(open(os.path.join(pack, "icons", "icons.json"), encoding="utf8"))
items = [json.loads(l) for l in open(os.path.join(pack, "items.jsonl"), encoding="utf8")]
cell, C, R = info["cell"], info["columns"], info["rows"]
per = C * R
mod = lambda it: it["id"].split(":")[0]
empty, checker, flatcol, few = [], [], [], []
hashes = collections.Counter()
for s, name in enumerate(info["files"]):
    a = np.array(Image.open(os.path.join(pack, "icons", name)).convert("RGBA"))
    for i in range(per):
        n = s * per + i
        if n >= len(items): break
        x, y = (i % C) * cell, (i // C) * cell
        c = a[y:y + cell, x:x + cell]
        al = c[..., 3]
        cover = int((al > 0).sum())
        if cover == 0:
            empty.append(n); continue
        if cover < 16: few.append(n)
        rgb = c[..., :3][al > 0]
        mag = ((rgb[:, 0] > 240) & (rgb[:, 1] < 10) & (rgb[:, 2] > 240)).sum()
        blk = ((rgb[:, 0] < 10) & (rgb[:, 1] < 10) & (rgb[:, 2] < 10)).sum()
        if mag > 0.3 * cover and mag + blk > 0.9 * cover: checker.append(n)
        if cover > 900 and len(np.unique(rgb, axis=0)) == 1: flatcol.append(n)
        hashes[c.tobytes()] += 1
print("items", len(items), "empty", len(empty), "== missing in json:", sorted(empty) == info["missing"])
def by_mod(rows):
    c = collections.Counter(mod(items[n]) for n in rows)
    return ", ".join("%s %d" % kv for kv in c.most_common(40))
print("missing-texture pattern:", len(checker), "|", by_mod(checker))
print("one flat colour over most of the cell:", len(flatcol), "|", by_mod(flatcol))
print("fewer than 16 pixels drawn:", len(few), [ (n, items[n]["id"], items[n]["meta"], items[n].get("name")) for n in few[:30]])
print("distinct pictures:", len(hashes))
var = [n for n, it in enumerate(items) if it.get("variants")]
print("rows with NBT variants:", len(var), "|", by_mod(var))
json.dump({"checker": checker, "flat": flatcol, "few": few}, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "stats.json"), "w"))
