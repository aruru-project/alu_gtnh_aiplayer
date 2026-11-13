#!/usr/bin/env python3
"""End-to-end check of the body mod on the local test instance.

Drives a throwaway bot through the bridge and checks the results in the world itself: after flattening, the
height map must be level; after building, the wall blocks must be there; after moving items, the chests must hold
exactly what was asked. Run with the test server up (tools/testserver start):

    tools/scenario.py            # all scenarios
    tools/scenario.py flatten    # only those whose name contains "flatten"

Uses its own bot ("Scout") and works on fresh ground next to wherever that bot stands, so it can be re-run.
"""
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bridge import Bridge, _local_env  # noqa: E402
import rcon as rcon_client  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BOT = "Scout"
TINKER = (
    "BaseDurability:3000,TotalDurability:3000,BonusDurability:0,ModDurability:0.0f,Shoddy:0.0f,HarvestLevel:5,"
    "MiningSpeed:700,Attack:4,BaseAttack:4,Damage:0,Broken:0b,Modifiers:0,Unbreaking:2,ToolLevel:1,ToolEXP:0L,HeadEXP:0L"
)

failures = []


def check(name, ok, detail=""):
    print(("  ok    " if ok else "  FAIL  ") + name + ("" if ok else f"  -- {detail}"))
    if not ok:
        failures.append(name)


def rcon(command):
    out = subprocess.run([os.path.join(ROOT, "tools", "testserver"), "rcon", command], capture_output=True, text=True)
    return out.stdout.strip()


class Builder:
    """Many setblock commands over one RCON connection: building a test fixture block by block."""

    def __init__(self):
        port = int(_local_env("AIPLAYER_TEST_RCON_PORT") or "25576")
        with open(os.path.join(ROOT, "testserver", ".rcon-password"), encoding="utf-8") as fh:
            password = fh.read().strip()
        self.sock = rcon_client.socket.create_connection(("127.0.0.1", port), timeout=10)
        rcon_client._send(self.sock, 1, 3, password)
        if rcon_client._recv(self.sock)[0] == -1:
            raise PermissionError("rcon authentication failed")
        self.n = 1

    def cmd(self, command):
        self.n += 1
        rcon_client._send(self.sock, self.n, 2, command)
        return rcon_client._recv(self.sock)[2]

    def put(self, x, y, z, block, meta=0):
        return self.cmd(f"setblock {x} {y} {z} {block} {meta}")

    def close(self):
        self.sock.close()


class Session:
    def __init__(self):
        self.b = Bridge()

    def call(self, method, params=None):
        return self.b.call(method, params or {})

    def status(self):
        return self.call("bot.status", {"bot": BOT})

    def counts(self):
        totals = {}
        for item in self.status()["inventory"]:
            totals[item["id"]] = totals.get(item["id"], 0) + item["count"]
        return totals

    def run(self, task, timeout=600):
        """Runs one task to its end and returns its final TaskInfo."""
        self.call("task.start", {"bot": BOT, "task": task})
        deadline = time.time() + timeout
        while time.time() < deadline:
            tasks = self.call("task.list", {"bot": BOT})
            if tasks["active"] is None and not tasks["queue"]:
                return tasks["recent"][0]
            time.sleep(0.5)
        self.call("task.cancel", {"bot": BOT})
        return {"state": "timeout", "type": task["type"]}

    def heights(self, x1, z1, x2, z2):
        return self.call("world.scan", {"bot": BOT, "x1": x1, "z1": z1, "x2": x2, "z2": z2})

    def block(self, x, y, z):
        return self.call("world.block", {"bot": BOT, "x": x, "y": y, "z": z}).get("id")

    def chest(self, x, y, z):
        found = self.call("world.containers", {"x": x, "y": y, "z": z, "radius": 1})["containers"]
        for c in found:
            if (c["x"], c["y"], c["z"]) == (x, y, z):
                return {i["id"]: i["count"] for i in c["items"]}
        return None


def prepare(s):
    """A fresh bot with the tools GTNH players dig with, standing on the ground."""
    names = [b["name"] for b in s.call("bot.list")["bots"]]
    if BOT in names and s.status()["online"]:
        s.call("task.cancel", {"bot": BOT})
    else:
        s.call("bot.spawn", {"name": BOT})
    time.sleep(1.5)
    have = s.counts()
    kit = {
        "TConstruct:pickaxe": f"TConstruct:pickaxe 1 0 {{InfiTool:{{Head:16,Handle:16,Accessory:16,RenderHead:16,RenderHandle:16,RenderAccessory:16,{TINKER}}}}}",
        "TConstruct:shovel": f"TConstruct:shovel 1 0 {{InfiTool:{{Head:16,Handle:16,RenderHead:16,RenderHandle:16,{TINKER}}}}}",
        "TConstruct:hatchet": f"TConstruct:hatchet 1 0 {{InfiTool:{{Head:16,Handle:16,RenderHead:16,RenderHandle:16,{TINKER}}}}}",
    }
    for item, spec in kit.items():
        if have.get(item, 0) == 0:
            rcon(f"give {BOT} {spec}")
    if have.get("minecraft:dirt", 0) < 128:
        rcon(f"give {BOT} minecraft:dirt 64")
        rcon(f"give {BOT} minecraft:dirt 64")
    if have.get("minecraft:cobblestone", 0) < 128:
        rcon(f"give {BOT} minecraft:cobblestone 64")
        rcon(f"give {BOT} minecraft:cobblestone 64")
    # Given items appear at the bot's feet and are picked up a moment later.
    deadline = time.time() + 8
    while time.time() < deadline and s.counts().get("TConstruct:pickaxe", 0) < 1:
        time.sleep(0.5)
    st = s.status()
    check("bot is online and carries a pickaxe", st["online"] and s.counts().get("TConstruct:pickaxe", 0) >= 1)
    return st["block"]


# What untouched land is made of. A site with anything else in it (a roof, a path, a pipe) is somebody's work:
# flatten digs whatever stands above its level, and a run that started on a roof once took part of it away.
WILD = {"minecraft:air", "minecraft:dirt", "minecraft:grass", "minecraft:stone", "minecraft:sand", "minecraft:gravel",
        "minecraft:sandstone", "minecraft:clay", "minecraft:snow", "minecraft:snow_layer", "minecraft:ice",
        "minecraft:tallgrass", "minecraft:double_plant", "minecraft:red_flower", "minecraft:yellow_flower",
        "minecraft:deadbush", "minecraft:leaves", "minecraft:leaves2", "minecraft:log", "minecraft:log2",
        "minecraft:vine", "minecraft:mycelium", "minecraft:cactus", "minecraft:reeds", "minecraft:brown_mushroom",
        "minecraft:red_mushroom", "minecraft:coal_ore", "minecraft:iron_ore"}


# The same, for what the pack's world generation adds: its plants and trees, its rock and the ore in it.
WILD_MODS = ("BiomesOPlenty:", "gregtech:gt.blockores", "gregtech:gt.blockstones", "gregtech:gt.blockgranites",
             "Thaumcraft:blockMagicalLeaves", "Thaumcraft:blockMagicalLog", "Thaumcraft:blockCustomPlant",
             "Natura:", "TwilightForest:")


def wild(s, x1, z1, size, min_y, max_y):
    box = s.call("world.blocks", {"dim": 0, "x1": x1 - 1, "y1": max(1, min_y - 3), "z1": z1 - 1,
                                  "x2": x1 + size, "y2": min(255, max_y + 12), "z2": z1 + size})
    if box.get("unloaded"):
        return False
    return all(p["id"] in WILD or p["id"].startswith(WILD_MODS) for p in box["palette"])


def pick_site(s, origin, size):
    """A size x size square of loaded dry sloping land a short walk from the bot."""
    for ring in range(1, 12):
        for dx, dz in ((1, 0), (0, 1), (-1, 0), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            x1 = origin["x"] + dx * ring * (size + 3)
            z1 = origin["z"] + dz * ring * (size + 3)
            scan = s.heights(x1, z1, x1 + size - 1, z1 + size - 1)
            st = scan["stats"]
            if st["unloaded"] or scan["liquidColumns"] or scan["tileEntities"]:
                continue
            if st["maxY"] - st["minY"] > 8 or st["maxY"] - st["minY"] < 1:
                continue  # want a real slope, but not a cliff
            if not wild(s, x1, z1, size, st["minY"], st["maxY"]):
                continue  # somebody built here: the scenarios dig and fill, so only untouched ground will do
            return x1, z1, scan
    raise RuntimeError("no suitable test site near the bot")


def scenario_goto(s, origin):
    r = s.run({"type": "goto", "x": origin["x"] + 6, "z": origin["z"] + 4}, 90)
    st = s.status()["block"]
    near = abs(st["x"] - (origin["x"] + 6)) <= 1 and abs(st["z"] - (origin["z"] + 4)) <= 1
    check("goto without a height ends next to the target column", r["state"] == "done" and near, json.dumps(r.get("error")))


def scenario_flatten(s, origin):
    size = 6
    x1, z1, before = pick_site(s, origin, size)
    level = before["stats"]["modeY"]
    r = s.run({"type": "flatten", "x1": x1, "z1": z1, "x2": x1 + size - 1, "z2": z1 + size - 1, "y": level, "maxFillDepth": 8}, 900)
    after = s.heights(x1, z1, x1 + size - 1, z1 + size - 1)
    flat = all(h == level for row in after["heights"] for h in row)
    check("flatten finishes", r["state"] == "done", json.dumps(r.get("error") or r.get("result")))
    check("every column of the flattened square is at the requested level", flat, f"level {level}, heights {after['heights']}")
    return x1, z1, level, size


def scenario_build(s, pad):
    x1, z1, level, size = pad
    y = level + 1
    bx1, bz1, bx2, bz2 = x1 + 1, z1 + 1, x1 + 4, z1 + 4
    r = s.run({"type": "fill", "x1": bx1, "y1": y, "z1": bz1, "x2": bx2, "y2": y + 2, "z2": bz2,
               "item": "minecraft:cobblestone", "shape": "walls"}, 300)
    walls = hollow = True
    for yy in range(y, y + 3):
        for x in range(bx1, bx2 + 1):
            for z in range(bz1, bz2 + 1):
                edge = x in (bx1, bx2) or z in (bz1, bz2)
                block = s.block(x, yy, z)
                if edge and block != "minecraft:cobblestone":
                    walls = False
                # Snow settling inside while the walls go up is weather, not the bot's doing.
                if not edge and block not in ("minecraft:air", "minecraft:snow_layer"):
                    hollow = False
    check("fill with shape walls places every wall block", r["state"] == "done" and walls, json.dumps(r.get("result")))
    check("the inside of the walls stays empty", hollow)
    r = s.run({"type": "clear", "x1": bx1, "y1": y, "z1": bz1, "x2": bx2, "y2": y + 2, "z2": bz2}, 300)
    gone = all(s.block(x, yy, z) == "minecraft:air" for yy in range(y, y + 3) for x in range(bx1, bx2 + 1) for z in range(bz1, bz2 + 1))
    check("clear removes the walls again", r["state"] == "done" and gone, json.dumps(r.get("error") or r.get("result")))


def scenario_items(s, pad):
    x1, z1, level, size = pad
    y = level + 1
    a = (x1, y, z1)
    b = (x1 + size - 1, y, z1 + size - 1)
    rcon(f"setblock {a[0]} {a[1]} {a[2]} minecraft:chest")
    rcon(f"setblock {b[0]} {b[1]} {b[2]} minecraft:chest")
    time.sleep(0.5)
    before = s.counts()
    cobble, dirt = before.get("minecraft:cobblestone", 0), before.get("minecraft:dirt", 0)
    r = s.run({"type": "deposit", "container": dict(zip("xyz", a)), "items": [{"id": "minecraft:cobblestone", "count": 70}]}, 120)
    check("deposit puts exactly the asked number into the chest",
          r["state"] == "done" and (s.chest(*a) or {}).get("minecraft:cobblestone") == 70
          and s.counts().get("minecraft:cobblestone", 0) == cobble - 70, json.dumps(r.get("error") or r.get("result")))
    r = s.run({"type": "withdraw", "container": dict(zip("xyz", a)),
               "items": [{"id": "minecraft:cobblestone", "count": 7}, {"id": "minecraft:diamond", "count": 2}]}, 120)
    missing = (r.get("result") or {}).get("missing") or []
    check("withdraw takes exactly the asked number and reports what the chest lacks",
          r["state"] == "done" and (s.chest(*a) or {}).get("minecraft:cobblestone") == 63
          and s.counts().get("minecraft:cobblestone", 0) == cobble - 63
          and [m["id"] for m in missing] == ["minecraft:diamond"], json.dumps(r.get("result")))
    r = s.run({"type": "haul", "from": dict(zip("xyz", a)), "to": dict(zip("xyz", b))}, 180)
    check("haul empties one chest into the other and leaves the bot's own items alone",
          r["state"] == "done" and not (s.chest(*a) or {}) and (s.chest(*b) or {}).get("minecraft:cobblestone") == 63
          and s.counts().get("minecraft:dirt", 0) == dirt, json.dumps(r.get("result")))
    r = s.run({"type": "withdraw", "container": dict(zip("xyz", b)), "items": [{"id": "minecraft:cobblestone"}]}, 120)
    rcon(f"setblock {a[0]} {a[1]} {a[2]} minecraft:air")
    rcon(f"setblock {b[0]} {b[1]} {b[2]} minecraft:air")


def scenario_homes(s, pad):
    x1, z1, level, size = pad
    out = s.call("bot.command", {"bot": BOT, "command": "sethome scenario"})["output"]
    check("sethome is accepted by the server", any("scenario" in line for line in out), str(out))
    s.run({"type": "goto", "x": x1 + size + 6, "z": z1 + size + 6}, 120)
    r = s.run({"type": "home", "name": "scenario"}, 30)
    st = s.status()["block"]
    check("home teleports back onto the pad", r["state"] == "done" and x1 - 1 <= st["x"] <= x1 + size and z1 - 1 <= st["z"] <= z1 + size, json.dumps(r))
    r = s.run({"type": "home", "name": "no-such-home"}, 30)
    check("an unknown home fails with the server's message", r["state"] == "failed" and r["error"]["code"] == "invalid", json.dumps(r.get("error")))
    s.call("bot.command", {"bot": BOT, "command": "delhome scenario"})


def scenario_no_tool(s, pad):
    """Without a usable pickaxe, stone must not be pounded on bare-handed: the task says what is missing."""
    x1, z1, level, size = pad
    chest = (x1 + 2, level + 1, z1 + 2)
    rcon(f"setblock {chest[0]} {chest[1]} {chest[2]} minecraft:chest")
    rcon(f"setblock {x1} {level + 1} {z1} minecraft:stone")
    time.sleep(0.5)
    s.run({"type": "deposit", "container": dict(zip("xyz", chest)), "items": [{"id": "TConstruct:pickaxe"}]}, 60)
    r = s.run({"type": "dig", "blocks": [{"x": x1, "y": level + 1, "z": z1}]}, 120)
    ok = r["state"] == "failed" and r["error"]["code"] == "no_tool" and s.block(x1, level + 1, z1) == "minecraft:stone"
    check("digging stone without a pickaxe fails with no_tool and leaves the block", ok, json.dumps(r.get("error") or r.get("result")))
    s.run({"type": "withdraw", "container": dict(zip("xyz", chest)), "items": [{"id": "TConstruct:pickaxe"}]}, 60)
    r = s.run({"type": "dig", "blocks": [{"x": x1, "y": level + 1, "z": z1}]}, 120)
    check("with the pickaxe back, the same dig succeeds", r["state"] == "done" and s.block(x1, level + 1, z1) == "minecraft:air", json.dumps(r.get("error") or r.get("result")))
    rcon(f"setblock {chest[0]} {chest[1]} {chest[2]} minecraft:air")


def scenario_safety(s, pad):
    """Things a mistaken or manipulated brain must not be able to do through the bridge."""
    for text in ("/sethome hacked1", "/ /sethome hacked2", "\u00a7/sethome hacked3", "x" * 100 + "/sethome hacked4"):
        s.call("bot.chat", {"bot": BOT, "message": text})
    time.sleep(6)
    homes = " ".join(s.call("bot.command", {"bot": BOT, "command": "home list"})["output"])
    check("chat text is never run as a command, however it is dressed up", "hacked" not in homes, homes)
    for command in ("gamemode 1", "team leave", "op " + BOT):
        try:
            s.call("bot.command", {"bot": BOT, "command": command})
            refused = False
        except RuntimeError as exc:
            refused = str(exc).startswith("denied")
        check(f"command outside the allow list is refused: {command}", refused)
    r = s.run({"type": "goto", "x": s.status()["block"]["x"] + 5000, "z": 0}, 30)
    check("a destination kilometres away is refused instead of walked to",
          r["state"] == "failed" and r["error"]["code"] == "unreachable", json.dumps(r.get("error") or r.get("result")))
    try:
        s.call("task.start", {"bot": BOT, "task": {"type": "clear", "x1": -1500000000, "y1": 60, "z1": 0, "x2": 1500000000, "y2": 60, "z2": 0}})
        refused = False
        s.call("task.cancel", {"bot": BOT})
    except RuntimeError as exc:
        refused = True
    check("a box with absurd coordinates is rejected up front", refused)
    try:
        s.call("bot.spawn", {"name": "Skinny", "skin": {"value": "abc"}})
        refused = False
        s.call("bot.despawn", {"bot": "Skinny"})
        s.call("bot.remove", {"bot": "Skinny"})
    except RuntimeError as exc:
        refused = True
    check("a skin without a signature is rejected", refused)


def nav_pad(s, origin):
    """A level 16x16 stone floor on untouched land near the bot, with nothing above it: room for the walking fixtures."""
    x1, z1, scan = pick_site(s, origin, 14)
    level = scan["stats"]["maxY"] + 1
    b = Builder()
    for x in range(x1 - 1, x1 + 15):
        for z in range(z1 - 1, z1 + 15):
            b.put(x, level, z, "minecraft:stone")
            for y in range(level + 1, level + 11):
                b.put(x, y, z, "minecraft:air")
    return b, x1, level + 1, z1


def scenario_nav(s, origin):
    """Walking where a house's owner walks: through a door over a stair threshold, up a ladder, up a stairwell; and
    saying so, without stacking anything, when a destination cannot be stood on or reached without climbing blocks."""
    b, x1, f, z1 = nav_pad(s, origin)
    stone = "minecraft:stone"
    # A: a 5x5 room (walls two high, a roof) whose only doorway, in the north wall, has a door and a stair outside it
    # as its threshold: the cell above that stair is the only way in.
    for x in range(x1, x1 + 5):
        for z in range(z1 + 2, z1 + 7):
            if x in (x1, x1 + 4) or z in (z1 + 2, z1 + 6):
                for y in (f, f + 1):
                    b.put(x, y, z, stone)
            b.put(x, f + 2, z, stone)
    door = (x1 + 2, f, z1 + 2)
    b.put(door[0], f, door[2], "minecraft:air")
    b.put(door[0], f + 1, door[2], "minecraft:air")
    b.put(door[0], f, door[2], "minecraft:wooden_door", 3)
    b.put(door[0], f + 1, door[2], "minecraft:wooden_door", 8)
    stair = (x1 + 2, f - 1, z1 + 1)
    b.put(*stair, "minecraft:spruce_stairs", 2)
    # B: a ladder up a stone column to a platform four blocks up.
    for y in range(f, f + 5):
        b.put(x1 + 12, y, z1 + 2, stone)
    for x in range(x1 + 10, x1 + 13):
        for z in range(z1 + 1, z1 + 4):
            if (x, z) != (x1 + 11, z1 + 2):
                b.put(x, f + 4, z, stone)
    for y in range(f, f + 5):
        b.put(x1 + 11, y, z1 + 2, "minecraft:ladder", 4)
    # C: a stairwell, walls on both sides and air under the steps: four spruce stairs, all facing /2, up to an upper
    # floor (the case dev-place built: with the stairs taken for obstacles the bot could only stack its way up).
    for z in range(z1 + 5, z1 + 10):
        for y in range(f, f + 5):
            b.put(x1 + 6, y, z, stone)
            b.put(x1 + 8, y, z, stone)
    for k in range(4):
        b.put(x1 + 7, f + k, z1 + 6 + k, "minecraft:spruce_stairs", 2)
    for x in range(x1 + 5, x1 + 10):
        for z in range(z1 + 10, z1 + 13):
            b.put(x, f + 3, z, "minecraft:planks", 1)
    # D: a stone room with no way in, standing on dirt (natural ground the bot may dig through on a walk). The bot
    # once dug down beside such a house and tunnelled under its floor, only to end up below where it was going.
    for x in range(x1 - 1, x1 + 6):
        for z in range(z1 + 8, z1 + 15):
            for y in range(f - 4, f):
                b.put(x, y, z, "minecraft:dirt")
    # Walls five high, so that its roof is no nearer to the bot than the ground outside (the stairwell's upper floor
    # is next to it).
    for x in range(x1, x1 + 5):
        for z in range(z1 + 9, z1 + 14):
            b.put(x, f - 1, z, stone)
            b.put(x, f + 5, z, stone)
            if x in (x1, x1 + 4) or z in (z1 + 9, z1 + 13):
                for y in range(f, f + 5):
                    b.put(x, y, z, stone)
    # E: a stone pillar three high, nothing to climb it by; F, another, for someone to stand on; G, a column seven
    # high whose top is out of reach from the ground.
    for y in range(f, f + 3):
        b.put(x1 + 12, y, z1 + 11, stone)
        b.put(x1 + 12, y, z1 + 7, stone)
    for y in range(f, f + 7):
        b.put(x1 + 14, y, z1 + 13, stone)
    b.close()
    s.call("bot.configure", {"bot": BOT, "settings": {"invulnerable": True}})
    rcon(f"tp {BOT} {x1 + 2}.5 {f} {z1}.5")
    time.sleep(1.5)
    box = {"dim": 0, "x1": x1 - 1, "y1": f, "z1": z1 - 1, "x2": x1 + 14, "y2": f + 8, "z2": z1 + 14}

    def placed_here():
        found = s.call("world.blocks", box)
        return sum(r for i, r in zip(found["runs"][0::2], found["runs"][1::2])
                   if found["palette"][i] and found["palette"][i]["id"] in ("minecraft:dirt", "minecraft:cobblestone"))

    def at(x, y, z):
        st = s.status()["block"]
        return (st["x"], st["y"], st["z"]) == (x, y, z)

    def walk(x, y, z, **more):
        return s.run({"type": "goto", "x": x, "y": y, "z": z, "range": 0, "yRange": 0, "climb": False, **more}, 180)

    def clean(r):
        res = r.get("result") or {}
        return r["state"] == "done" and res.get("dy") == 0 and "climbingBlocks" not in res and "dugOnTheWay" not in res

    # Something traces a ray through the threshold stair, as a player pointing at it does: since then every spruce
    # stair keeps the bounds of an eighth of a block until an entity bumps into one.
    s.call("bot.look", {"bot": BOT, "x": stair[0], "y": stair[1], "z": stair[2]})
    s.call("world.player", {"name": BOT})
    r = walk(x1 + 2, f, z1 + 4)
    check("through a door whose threshold stair was just pointed at: in, at the height asked, nothing dug or stacked",
          clean(r) and at(x1 + 2, f, z1 + 4), json.dumps(r.get("error") or r.get("result")))
    s.call("bot.look", {"bot": BOT, "x": stair[0], "y": stair[1], "z": stair[2]})
    s.call("world.player", {"name": BOT})
    r = walk(x1 + 2, f, z1)
    check("and out again the same way", clean(r) and at(x1 + 2, f, z1), json.dumps(r.get("error") or r.get("result")))

    r = walk(x1 + 10, f + 5, z1 + 1)
    check("up a ladder onto a platform, no blocks stacked", clean(r) and at(x1 + 10, f + 5, z1 + 1) and placed_here() == 0,
          json.dumps(r.get("error") or r.get("result")))
    s.call("bot.configure", {"bot": BOT, "settings": {"invulnerable": False}})
    health = s.status()["health"]
    r = walk(x1 + 9, f, z1 + 2)
    check("down the ladder again when a five-block drop would hurt", clean(r) and at(x1 + 9, f, z1 + 2) and s.status()["health"] == health,
          json.dumps(r.get("error") or r.get("result")))
    s.call("bot.configure", {"bot": BOT, "settings": {"invulnerable": True}})

    r = walk(x1 + 7, f + 4, z1 + 11)
    check("up a stairwell of four stairs to the floor above, no blocks stacked",
          clean(r) and at(x1 + 7, f + 4, z1 + 11) and placed_here() == 0, json.dumps(r.get("error") or r.get("result")))

    started = time.time()
    r = walk(x1 + 7, f + 4, z1 + 7)
    err = r.get("error") or {}
    check("a destination over the stairwell's open hole fails at once and says there is nothing to stand on",
          r["state"] == "failed" and err.get("code") == "unreachable"
          and err.get("message", "").startswith("nothing to stand on at the destination")
          and (err.get("detail") or {}).get("below", {}).get("id") == "minecraft:air"
          and time.time() - started < 5 and placed_here() == 0, json.dumps(r))

    rcon(f"tp {BOT} {x1 + 2}.5 {f} {z1 + 7}.5")
    time.sleep(1.5)
    # Without yRange the feet may end two blocks off the height asked for, which makes the dirt under the floor look
    # nearer than the ground outside the wall: the case of the house.
    r = s.run({"type": "goto", "x": x1 + 2, "y": f, "z": z1 + 11, "range": 0, "climb": False}, 180)
    res = r.get("result") or {}
    check("into a room with no way in: unreachable, and nothing dug on the way (no tunnel under its floor)",
          r["state"] == "failed" and (r.get("error") or {}).get("code") == "unreachable" and "dugOnTheWay" not in res
          and s.status()["block"]["y"] >= f, json.dumps(r))

    r = walk(x1 + 12, f + 3, z1 + 11)
    err = r.get("error") or {}
    check("the top of a bare pillar without climb: unreachable, says how many stacked blocks would do it, stacks none",
          r["state"] == "failed" and err.get("code") == "unreachable"
          and (err.get("detail") or {}).get("climbingBlocksWouldTake", 0) >= 1 and placed_here() == 0, json.dumps(r))
    r = walk(x1 + 12, f + 3, z1 + 11, climb=True, takeBack=True)
    res = r.get("result") or {}
    listed = res.get("climbingBlocks") or []
    truthful = all((s.block(c["x"], c["y"], c["z"]) == c["id"]) == c["standing"] for c in listed)
    check("with climb and takeBack: there, every block it stacked listed, and each said to stand only if it does",
          r["state"] == "done" and at(x1 + 12, f + 3, z1 + 11) and len(listed) >= 1 and truthful
          and placed_here() == sum(1 for c in listed if c["standing"]), json.dumps(res))

    def dirt():
        return s.counts().get("minecraft:dirt", 0)

    # Following someone who stands on top of F: without climb the bot cannot keep up and says so where its task
    # says what it is doing; with climb it stacks a block beside the pillar and is there.
    other = "Perch"
    s.call("bot.spawn", {"name": other, "x": x1 + 12, "y": f + 3, "z": z1 + 7})
    s.call("bot.configure", {"bot": other, "settings": {"invulnerable": True}})
    rcon(f"tp {BOT} {x1 + 10}.5 {f} {z1 + 7}.5")
    time.sleep(1.5)
    before = placed_here()

    trace = []

    def follow(climb, until, seconds=40):
        s.call("task.start", {"bot": BOT, "task": {"type": "follow", "player": other, "distance": 2, "climb": climb}})
        deadline = time.time() + seconds
        seen = None
        trace.clear()
        while time.time() < deadline:
            active = s.call("task.list", {"bot": BOT})["active"] or {}
            seen = active
            st = s.status()
            step = (st["block"]["x"], st["block"]["y"], st["block"]["z"], (active.get("progress") or {}).get("note", ""))
            if not trace or trace[-1] != step:
                trace.append(step)
            if until(active):
                break
            time.sleep(0.25)
        s.call("task.cancel", {"bot": BOT})
        time.sleep(0.5)
        return seen, s.call("task.list", {"bot": BOT})["recent"][0]

    seen, _ = follow(False, lambda a: "stacking blocks" in (a.get("progress") or {}).get("note", ""))
    note = (seen.get("progress") or {}).get("note", "")
    check("following someone up on a pillar without climb: it says it cannot keep up without stacking blocks, stacks none",
          "cannot reach Perch right now: no way there without stacking blocks to climb on" in note
          and placed_here() == before and s.status()["block"]["y"] == f, json.dumps(seen))

    def up_beside(_a):
        # Standing (not in the middle of a jump) up on a block of its own, within the distance asked of the pillar
        # and at most two below its top.
        st = s.status()
        me = st["block"]
        return st["onGround"] and me["y"] >= f + 1 and (me["x"] - (x1 + 12)) ** 2 + (me["z"] - (z1 + 7)) ** 2 <= 4
    # From a corner of the pillar: mid-jump the bot is nearer someone above than on landing, and the follow took
    # that for close enough, stopped the walk and threw away the block it was about to put under itself.
    rcon(f"tp {BOT} {x1 + 11}.5 {f} {z1 + 6}.5")
    time.sleep(1.5)
    seen, ended = follow(True, up_beside)
    res = ended.get("result") or {}
    listed = res.get("climbingBlocks") or []
    now = placed_here()
    check("with climb it keeps up, and when stopped its result lists the blocks it stacked",
          up_beside(None) and len(listed) >= 1 and now == before + len(listed),
          json.dumps({"ended": ended, "at": s.status()["block"], "stacked": now - before, "pillar": [x1 + 12, f + 3, z1 + 7],
                      "them": s.call("bot.status", {"bot": other})["block"], "trace": trace[-12:]}))
    s.call("bot.despawn", {"bot": other})
    s.call("bot.remove", {"bot": other})

    # An area task that has to climb to place a block (place_blocks, on top of G): every climbing block it put down is listed,
    # each with whether it still stands and whether the task took it down, and what did not come back into the
    # inventory is counted (feedback f25: a blueprint for one iron bar said only "removed 6", and 5 dirt were gone).
    rcon(f"tp {BOT} {x1 + 12}.5 {f} {z1 + 13}.5")
    time.sleep(1.5)
    had = dirt()
    r = s.run({"type": "place", "blocks": [{"x": x1 + 14, "y": f + 7, "z": z1 + 13, "item": "minecraft:cobblestone"}]}, 240)
    res = r.get("result") or {}
    listed = res.get("climbingBlocks") or []
    truthful = all((s.block(c["x"], c["y"], c["z"]) == c["id"]) == c["standing"] for c in listed)
    # The dirt carried: each block stacked takes one, each taken down gives one back unless it is counted as not
    # picked up (more can come back: the sweep after taking them down picks up whatever lies there).
    taken = sum(1 for c in listed if c.get("takenDown")) + len(res.get("olderClimbingBlocksTakenDown") or [])
    accounted = dirt() - had >= -len(listed) + taken - res.get("climbingBlockDropsNotPickedUp", 0)
    check("an area task that climbed: each climbing block listed, said standing or taken down as it is, none counted as removed, "
          "and any that did not come back into the inventory counted",
          r["state"] == "done" and s.block(x1 + 14, f + 7, z1 + 13) == "minecraft:cobblestone" and len(listed) >= 1 and truthful
          and all(c.get("takenDown") is True or c["standing"] for c in listed) and res.get("removed") == 0 and accounted,
          json.dumps({"result": res, "dirtBefore": had, "dirtAfter": dirt()}))


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    s = Session()
    print("prepare")
    origin = prepare(s)
    pad = None
    steps = [("goto", lambda: scenario_goto(s, origin)), ("nav", lambda: scenario_nav(s, origin)), ("flatten", None),
             ("build", None), ("items", None), ("homes", None), ("no_tool", None), ("safety", None)]
    for name, fn in steps:
        needs_pad = fn is None
        if only and only not in name and not (name == "flatten" and only not in ("goto", "nav")):
            continue
        print(name)
        if name == "flatten":
            pad = scenario_flatten(s, origin)
        elif name == "build":
            scenario_build(s, pad)
        elif name == "items":
            scenario_items(s, pad)
        elif name == "homes":
            scenario_homes(s, pad)
        elif name == "no_tool":
            scenario_no_tool(s, pad)
        elif name == "safety":
            scenario_safety(s, pad)
        else:
            fn()
    info = s.call("server.info")
    print(f"server: {info['tps']} tps, {info['tickMs']} ms per tick")
    if failures:
        print(f"{len(failures)} check(s) failed: " + "; ".join(failures))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, TimeoutError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(2)
