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
from bridge import Bridge  # noqa: E402

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
                if not edge and block != "minecraft:air":
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


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    s = Session()
    print("prepare")
    origin = prepare(s)
    pad = None
    steps = [("goto", lambda: scenario_goto(s, origin)), ("flatten", None), ("build", None), ("items", None),
             ("homes", None), ("no_tool", None), ("safety", None)]
    for name, fn in steps:
        needs_pad = fn is None
        if only and only not in name and not (name == "flatten" and only != "goto"):
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
