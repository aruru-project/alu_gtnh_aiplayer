#!/usr/bin/env python3
"""A piece of one sheet, enlarged, on a loud background with the cell borders drawn in: for spotting spill-over.

  region.py PACKDATA OUT.png FIRST_ROW_NUMBER [COLS ROWS ZOOM]
"""
import json, os, sys
from PIL import Image, ImageDraw
pack, out, first = sys.argv[1], sys.argv[2], int(sys.argv[3])
cols, rows, zoom = (int(v) for v in (sys.argv[4:7] + ["16", "8", "3"][len(sys.argv) - 4:]))
info = json.load(open(os.path.join(pack, "icons", "icons.json"), encoding="utf8"))
cell, C, R = info["cell"], info["columns"], info["rows"]
im = Image.open(os.path.join(pack, "icons", info["files"][first // (C * R)])).convert("RGBA")
i = first % (C * R)
x0, y0 = (i % C) * cell, (i // C) * cell
piece = im.crop((x0, y0, x0 + cols * cell, y0 + rows * cell)).resize((cols * cell * zoom, rows * cell * zoom), Image.NEAREST)
bg = Image.new("RGBA", piece.size, (255, 0, 255, 255))
bg.alpha_composite(piece)
d = ImageDraw.Draw(bg)
for c in range(cols + 1):
    d.line((c * cell * zoom, 0, c * cell * zoom, piece.size[1]), fill=(0, 255, 255, 255))
for r in range(rows + 1):
    d.line((0, r * cell * zoom, piece.size[0], r * cell * zoom), fill=(0, 255, 255, 255))
bg.convert("RGB").save(out)
print(out, bg.size)
