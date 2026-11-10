#!/usr/bin/env python3
"""Writes a small Schematica .schematic for testing the blueprint task: a hut with a floor, walls with windows,
a doorway, a roof with a skylight and a lamp hanging under it, plus two blocks only a player can place.

usage: tools/make-test-schematic.py OUT.schematic
"""
import gzip, struct, sys

def tag(t, name, payload):
    n = name.encode()
    return struct.pack('>bH', t, len(n)) + n + payload

def short(name, v): return tag(2, name, struct.pack('>h', v))
def string(name, v):
    b = v.encode(); return tag(8, name, struct.pack('>H', len(b)) + b)
def bytes_(name, v): return tag(7, name, struct.pack('>i', len(v)) + bytes(v))
def compound(name, children): return tag(10, name, b''.join(children) + b'\x00')
def empty_list(name): return tag(9, name, struct.pack('>bi', 10, 0))

# Arbitrary file-local ids, some above 255 on purpose; the names are what count.
IDS = {'minecraft:air': 0, 'chisel:nucrete': 2121, 'chisel:cobblestone': 2014, 'TConstruct:GlassBlock': 572,
       'chisel:glowstone': 2047, 'minecraft:stone_brick_stairs': 109, 'minecraft:chest': 54}
W, H, L = 5, 5, 5
cells = {}
def put(x, y, z, name, meta=0): cells[(x, y, z)] = (name, meta)

for x in range(W):
    for z in range(L):
        put(x, 0, z, 'chisel:nucrete', 7)                      # floor
        put(x, 4, z, 'chisel:cobblestone', 15)                 # roof
        if x in (0, W - 1) or z in (0, L - 1):
            for y in (1, 2, 3): put(x, y, z, 'chisel:cobblestone', 14)   # walls
for x, z in ((2, 4), (0, 2), (4, 2)): put(x, 2, z, 'TConstruct:GlassBlock')   # windows
for y in (1, 2): cells.pop((2, y, 0))                           # doorway
put(2, 4, 2, 'TConstruct:GlassBlock')                           # skylight
put(1, 3, 1, 'chisel:glowstone', 9)                             # lamp under the roof, nothing below it
put(3, 1, 3, 'minecraft:chest', 3)                              # needs a player: holds contents
put(1, 1, 3, 'minecraft:stone_brick_stairs', 3)                 # needs a player: faces a direction

blocks, data, add = bytearray(W * H * L), bytearray(W * H * L), bytearray((W * H * L + 1) // 2)
for (x, y, z), (name, meta) in cells.items():
    i = x + (y * L + z) * W
    v = IDS[name]
    blocks[i] = v & 0xFF
    data[i] = meta
    hi = v >> 8
    add[i >> 1] |= (hi << 4) if i % 2 == 0 else hi              # Schematica's order: even index, high half
root = compound('Schematic', [
    short('Width', W), short('Height', H), short('Length', L), string('Materials', 'Alpha'),
    bytes_('Blocks', blocks), bytes_('Data', data), bytes_('AddBlocks', add),
    empty_list('Entities'), empty_list('TileEntities'),
    compound('SchematicaMapping', [short(n, v) for n, v in IDS.items()]),
])
with gzip.open(sys.argv[1], 'wb') as f:
    f.write(root)
print(f'{sys.argv[1]}: {W}x{H}x{L}, {len(cells)} blocks')
