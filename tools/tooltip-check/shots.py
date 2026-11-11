#!/usr/bin/env python3
"""Hold the exported tooltips against what the game shows: pictures of the real tooltips next to the exported text.

  tools/tooltip-check/shots.py [--out DIR] [--sheets DIR] [--join HOST:PORT] [--no-real-shift] [--only-sheets]

Starts our own client (as tools/export-packdata does), has it draw the inventory screen with each of the items
below under the mouse, with nothing held, with Shift and with Ctrl, and saves the frames. Then presses the real
Shift key on the client's display for a few seconds and has the Shift pictures taken again, to see that holding
the key the way the export does (inside the game) shows the same as holding it on the keyboard.

Out come sheets (client/tooltip-check/sheet-NN.png): on the left the tooltip cut out of the game's frame, on the
right the lines tooltips.jsonl has for that item and key. They are for reading side by side.
"""
import ctypes
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLIENT = os.path.join(ROOT, "tools", "client")
WORK = os.path.join(ROOT, "client", "export")
SHOTS = os.path.join(WORK, "shots")
MODS = os.path.join(ROOT, "client", "instance", ".minecraft", "mods")
PIDFILE = os.path.join(ROOT, "client", "client.pid")

# What to look at, and with which keys. One of each kind the export is for.
WANTED = [
    ("gregtech:gt.blockmachines", 221, "none"),              # a single-block machine: voltage, capacity
    ("gregtech:gt.blockmachines", 31080, "none shift"),      # a multiblock controller: its structure with Shift
    ("gregtech:gt.blockmachines", 1000, "none shift"),       # another one, long
    ("gregtech:gt.metaitem.01", 32750, "none"),              # covers
    ("gregtech:gt.metaitem.01", 32630, "none"),
    ("gregtech:gt.metaitem.01", 32510, "none"),              # batteries
    ("gregtech:gt.metaitem.01", 32518, "none"),
    ("IC2:itemCellEmpty", 1, "none shift"),                  # fluid cells
    ("gregtech:gt.metaitem.01", 30013, "none shift"),
    ("TConstruct:pickaxe", 0, "none shift ctrl"),            # a Tinkers' tool: stats with Shift, parts with Ctrl
    ("gregtech:gt.metatool.01", 16, "none"),                 # a GregTech tool
    ("minecraft:diamond_pickaxe", 0, "none shift"),          # numbers shown as little pictures, as text with Shift
    ("minecraft:bread", 0, "none shift"),
    ("minecraft:planks", 0, "none ctrl"),                    # burn time; ore dictionary names with Ctrl
    ("minecraft:stone", 0, "none"),                          # plain blocks
    ("minecraft:glass", 0, "none"),
    ("Thaumcraft:WandCap", 0, "none ctrl"),                  # Thaumcraft: wand parts answer to Ctrl
    ("Thaumcraft:blockCrystal", 0, "none"),
    ("appliedenergistics2:item.ItemBasicStorageCell.1k", 0, "none"),   # Applied Energistics
    ("appliedenergistics2:tile.BlockDrive", 0, "none"),
    ("DraconicEvolution:draconicPickaxe", 0, "none shift ctrl"),
    ("LogisticsPipes:item.itemUpgrade", 0, "none shift"),    # keeps its own "hold Shift" line
    ("EnderIO:blockAlloySmelter", 0, "none shift"),
    ("Forestry:beeDroneGE", 0, "none shift"),
    ("OpenComputers:adapter", 0, "none"),
    ("adventurebackpack:copterPack", 0, "none shift ctrl"),
    ("Avaritia:Infinity_Pickaxe", 0, "none"),                # enchantments
    ("IC2:itemTreetapElectric", 26, "none shift"),           # a line from one of NEI's handlers (the charge)
    ("gregtech:gt.blockmachines", 770, "none"),              # lines that look broken in the export: are they in the game?
    ("gregtech:gt.blockmachines", 31785, "none"),
]


def opt(flag, default):
    argv = sys.argv[1:]
    return argv[argv.index(flag) + 1] if flag in argv else default


def running():
    try:
        os.kill(int(open(PIDFILE).read()), 0)
        return True
    except (OSError, ValueError):
        return False


def items_sha1(path):
    h = hashlib.sha1()
    with open(path, encoding="utf8") as f:
        for line in f.read().split("\n")[:-1]:
            row = json.loads(line)
            h.update(("%s/%d\n" % (row["id"], row["meta"])).encode("utf8"))
    return h.hexdigest()


# ---- the real keyboard of the client's display ------------------------------------------------------------------

class Keyboard:
    """Presses keys on an X display through the XTEST extension, with the game's window in front."""

    SHIFT_L = 0xFFE1

    def __init__(self, display):
        self.x11 = ctypes.CDLL("libX11.so.6")
        self.xtst = ctypes.CDLL("libXtst.so.6")
        self.x11.XOpenDisplay.restype = ctypes.c_void_p
        self.x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
        for f in (self.x11.XKeysymToKeycode, self.x11.XFlush, self.x11.XSetInputFocus, self.x11.XRaiseWindow,
                  self.x11.XGetInputFocus, self.x11.XCloseDisplay, self.xtst.XTestFakeKeyEvent):
            f.argtypes = None
        self.dpy = ctypes.c_void_p(self.x11.XOpenDisplay(display.encode()))
        if not self.dpy:
            raise RuntimeError("cannot open display " + display)
        self.before = ctypes.c_ulong()
        self.down = False

    def focus(self, window):
        revert = ctypes.c_int()
        self.x11.XGetInputFocus(self.dpy, ctypes.byref(self.before), ctypes.byref(revert))
        self.x11.XRaiseWindow(self.dpy, ctypes.c_ulong(window))
        self.x11.XSetInputFocus(self.dpy, ctypes.c_ulong(window), 2, ctypes.c_ulong(0))
        self.x11.XFlush(self.dpy)

    def shift(self, down):
        code = self.x11.XKeysymToKeycode(self.dpy, ctypes.c_ulong(self.SHIFT_L))
        self.xtst.XTestFakeKeyEvent(self.dpy, ctypes.c_uint(code), ctypes.c_int(1 if down else 0), ctypes.c_ulong(0))
        self.x11.XFlush(self.dpy)
        self.down = down

    def close(self):
        if self.down:
            self.shift(False)
        if self.before.value not in (0, 1):
            self.x11.XSetInputFocus(self.dpy, self.before, 2, ctypes.c_ulong(0))
        self.x11.XFlush(self.dpy)
        self.x11.XCloseDisplay(self.dpy)


def game_window(display, pid):
    """The X window of the client, found by the process it belongs to."""
    env = dict(os.environ, DISPLAY=display)
    listed = subprocess.run(["xprop", "-root", "_NET_CLIENT_LIST"], env=env, capture_output=True, text=True).stdout
    for word in listed.replace(",", " ").split():
        if not word.startswith("0x"):
            continue
        props = subprocess.run(["xprop", "-id", word, "_NET_WM_PID", "WM_NAME"], env=env, capture_output=True, text=True).stdout
        if "_NET_WM_PID(CARDINAL) = %d" % pid in props or "Minecraft" in props:
            return int(word, 16)
    return None


# ---- taking the pictures -----------------------------------------------------------------------------------------

def take(out, join, real_shift):
    items = [json.loads(l) for l in open(os.path.join(out, "items.jsonl"), encoding="utf8")]
    row_of = {(it["id"], it["meta"]): n for n, it in enumerate(items)}
    lines = []
    for id_, meta, keys in WANTED:
        if (id_, meta) not in row_of:
            print("not in items.jsonl, left out:", id_, meta)
            continue
        for key in keys.split():
            lines.append("%d %s" % (row_of[(id_, meta)], key))
    if running():
        raise SystemExit("a client is already running (tools/client stop)")
    jars = [j for j in sorted(glob.glob(os.path.join(ROOT, "mod", "build", "libs", "*.jar")), key=os.path.getmtime)
            if not j.endswith(("-dev.jar", "-sources.jar", "-javadoc.jar"))]
    for old in glob.glob(os.path.join(MODS, "aiplayer-*.jar")):
        os.remove(old)
    shutil.copy2(jars[-1], MODS)
    work = os.path.join(WORK, "items.jsonl")
    if not os.path.exists(work) or items_sha1(work) != items_sha1(os.path.join(out, "items.jsonl")):
        shutil.copy2(os.path.join(out, "items.jsonl"), work)
    if os.path.isdir(SHOTS):
        shutil.rmtree(SHOTS)
    os.makedirs(SHOTS)
    with open(os.path.join(SHOTS, "list.txt"), "w") as f:
        f.write("\n".join(lines) + "\n")
    for mark in ("export.ok", "export.failed"):
        if os.path.exists(os.path.join(WORK, mark)):
            os.remove(os.path.join(WORK, mark))
    subprocess.run([CLIENT, "start", "--lang", "zh_CN", "-D", "aiplayer.export=" + WORK,
                    "-D", "aiplayer.export.only=shots", "-D", "aiplayer.export.join=" + join,
                    "-D", "fml.readTimeout=180"], check=True)
    display = os.environ.get("DISPLAY", ":10")
    deadline = time.time() + 15 * 60
    keyboard = None
    try:
        while running() and not os.path.exists(os.path.join(SHOTS, "want-shift")) and time.time() < deadline:
            time.sleep(0.5)
        if running() and os.path.exists(os.path.join(SHOTS, "want-shift")) and real_shift:
            window = game_window(display, int(open(PIDFILE).read()))
            if window is None:
                print("the client's window was not found, no pictures with the real key")
            else:
                keyboard = Keyboard(display)
                keyboard.focus(window)
                time.sleep(0.5)
                keyboard.shift(True)
                time.sleep(0.5)
        # Told in either case, so that the client goes on; it looks for itself whether Shift is down.
        open(os.path.join(SHOTS, "shift-down"), "w").close()
        while running() and not os.path.exists(os.path.join(SHOTS, "done")) and time.time() < deadline:
            time.sleep(0.2)
    finally:
        if keyboard is not None:
            keyboard.close()
    while running():
        if time.time() > deadline:
            subprocess.run([CLIENT, "stop"])
            raise SystemExit("the client did not finish; see client/client.log")
        time.sleep(1)
    if not os.path.exists(os.path.join(SHOTS, "done")):
        raise SystemExit("the client closed without taking the pictures; see client/client.log")


# ---- the sheets ----------------------------------------------------------------------------------------------------

def font(size):
    for path in ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                 "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def crop(shot, place):
    if place is None:
        return shot
    x, y, w, h = place[:4]
    pad = 14
    return shot.crop((max(0, x - pad), max(0, y - pad), min(shot.width, x + w + pad), min(shot.height, y + h + pad)))


def same_tooltip(a, place_a, b, place_b):
    """Whether two frames show the same tooltip: the same place, and nothing but flicker different inside it.

    What lies behind a tooltip shines through a little and some of it moves (NEI's panel of items), so single
    pixels may differ slightly; a line of text that is different differs strongly and in many pixels."""
    if place_a is None or place_b is None:
        return "no tooltip in one of the two"
    if place_a[:4] != place_b[:4]:
        return "another size or place: %s against %s" % (place_a[:4], place_b[:4])
    x, y, w, h = place_a[:4]
    box = (x + 4, y + 4, x + w - 4, y + h - 4)
    diff = ImageChops.difference(a.crop(box), b.crop(box))
    strong = sum(1 for px in diff.getdata() if max(px) > 24)
    return "the same tooltip" if strong == 0 else "%d pixels differ inside the tooltip" % strong


def sheets(out, dest):
    items = [json.loads(l) for l in open(os.path.join(out, "items.jsonl"), encoding="utf8")]
    tips = {}
    for l in open(os.path.join(out, "tooltips.jsonl"), encoding="utf8"):
        o = json.loads(l)
        tips[(o["id"], o["meta"])] = o
    result = json.load(open(os.path.join(SHOTS, "result.json"), encoding="utf8"))
    places = result.get("tooltips", {})
    os.makedirs(dest, exist_ok=True)
    for old in glob.glob(os.path.join(dest, "sheet-*.png")):
        os.remove(old)
    title, body = font(17), font(15)
    entries = []
    report = []
    for line in open(os.path.join(SHOTS, "list.txt")):
        row, key = line.split()
        row = int(row)
        it = items[row]
        name = "%d-%s.png" % (row, key)
        if not os.path.exists(os.path.join(SHOTS, name)):
            continue
        shot = Image.open(os.path.join(SHOTS, name)).convert("RGB")
        place = places.get(name)
        game = crop(shot, place)
        tip = tips.get((it["id"], it["meta"]), {})
        if key == "none":
            text, note = tip.get("tip", []), "tip" if tip else "(not in tooltips.jsonl: no tooltip)"
        elif key in tip:
            text, note = tip[key], key
        elif key == "ctrl" and it.get("ores"):
            text, note = ["矿物辞典名称："] + [" - " + o for o in it["ores"]], "(no ctrl in tooltips.jsonl; these are the ores of items.jsonl)"
        else:
            text, note = tip.get("tip", []), "(no %s in tooltips.jsonl: same lines as tip)" % key
        label = "%s  |  %s/%d  |  row %d  |  key: %s  |  exported as: %s" % (it.get("name", ""), it["id"], it["meta"], row, key, note)
        if place is not None and len(place) > 4 and place[4] > 1:
            label += "  |  the game shows page 1 of %d" % place[4]
        real = os.path.join(SHOTS, "%d-shift-real.png" % row)
        if key == "shift" and os.path.exists(real):
            verdict = same_tooltip(shot, place, Image.open(real).convert("RGB"), places.get("%d-shift-real.png" % row))
            report.append("%s/%d with the real Shift key: %s" % (it["id"], it["meta"], verdict))
            label += "  |  real Shift key: " + verdict
        entries.append((label, game, text))
    page, used, pages = [], 0, []
    for e in entries:
        need = 30 + max(e[1].height, 20 * len(e[2]) + 10) + 16
        if page and used + need > 1500:
            pages.append(page)
            page, used = [], 0
        page.append(e)
        used += need
    if page:
        pages.append(page)
    left = max(e[1].width for e in entries) + 20
    for n, page in enumerate(pages):
        height = sum(30 + max(e[1].height, 20 * len(e[2]) + 10) + 16 for e in page)
        sheet = Image.new("RGB", (left + 900, height), (32, 32, 38))
        d = ImageDraw.Draw(sheet)
        y = 0
        for label, game, text in page:
            d.rectangle((0, y, sheet.width, y + 26), fill=(60, 60, 90))
            d.text((8, y + 3), label, fill=(255, 255, 255), font=title)
            y += 30
            sheet.paste(game, (8, y))
            for i, t in enumerate(text):
                d.text((left + 12, y + 4 + 20 * i), t if t else "⏎", fill=(235, 235, 235) if t else (110, 110, 110), font=body)
            y += max(game.height, 20 * len(text) + 10) + 16
        path = os.path.join(dest, "sheet-%02d.png" % n)
        sheet.save(path)
        print(path, sheet.size)
    print("the game saw the real Shift key:", result.get("realShiftSeen"))
    for r in report:
        print(r)


def main():
    out = opt("--out", os.path.join(ROOT, "brain", "packdata"))
    dest = opt("--sheets", os.path.join(ROOT, "client", "tooltip-check"))
    if "--only-sheets" not in sys.argv:
        take(out, opt("--join", "127.0.0.1:10186"), "--no-real-shift" not in sys.argv)
    sheets(out, dest)


if __name__ == "__main__":
    main()
