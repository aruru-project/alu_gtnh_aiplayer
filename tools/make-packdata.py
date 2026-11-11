#!/usr/bin/env python3
"""Builds the brain's local pack data from the game client pack (docs/PACKDATA.md). Stdlib only.

  make-packdata.py quests --client CLIENT.zip --out brain/packdata
  make-packdata.py textures --client CLIENT.zip --jar minecraft-1.7.10-client.jar --out brain/packdata
  make-packdata.py guide --client CLIENT.zip --out brain/packdata

quests    the quest book (BetterQuesting) in Chinese: quests.jsonl, questlines.json and the "quests" section
          of meta.json
textures  the block textures that blocks.jsonl names (and every vanilla block texture), taken from the mod jars
          in the pack and packed into one image: textures/atlas.png, textures/atlas.json and the "textures"
          section of meta.json
guide     the pages of the in-game guide (GuideNH, the book a player opens with G), as they are written:
          guide.jsonl and the "guide" section of meta.json

The client pack is only read. Each output file is replaced in one step, and meta.json keeps the sections that
other subcommands wrote.
"""
import argparse
import base64
import datetime
import io
import json
import os
import re
import struct
import sys
import uuid
import zipfile
import zlib

QUESTS_FORMAT = 1
QUEST_DIR = "config/betterquesting/DefaultQuests/"
LANG_FILE = "config/txloader/forceload/betterquesting/lang/%s.lang"
# Must stay the same as shortId in mod/src/main/java/alu/aiplayer/world/Quests.java: the server reports progress
# with these ids.
LEGACY = "00000000-0000-0000-0000-"
MASK64 = (1 << 64) - 1
WILDCARD_META = 32767


def fail(message):
    print("make-packdata: " + message, file=sys.stderr)
    sys.exit(1)


def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    os.replace(tmp, path)


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def update_meta(out_dir, section, values):
    """Replaces one section of meta.json and leaves the others as they are."""
    path = os.path.join(out_dir, "meta.json")
    meta = {}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                meta = json.load(fh)
        except ValueError as e:
            fail("%s is not valid JSON (%s); fix or delete it, it also holds what other subcommands recorded" % (path, e))
        if not isinstance(meta, dict):
            fail("%s does not hold a JSON object; fix or delete it" % path)
    meta[section] = values
    write_atomic(path, json.dumps(meta, ensure_ascii=False, indent=2) + "\n")


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── BetterQuesting's files ──
# They are NBT written as JSON: every key carries its tag type ("name:8", "questIDLow:4"), and a list (type 9)
# is an object keyed by position ("0:10", "1:10").


def split_key(key):
    name, sep, kind = key.rpartition(":")
    return (name, kind) if sep and kind.isdigit() else (key, "")


def position(key):
    name, _ = split_key(key)
    return int(name) if name.isdigit() else 1 << 30


def untyped(value, kind=""):
    """The same data with plain keys and real lists."""
    if isinstance(value, dict):
        if kind == "9":
            return [untyped(v, split_key(k)[1]) for k, v in sorted(value.items(), key=lambda kv: position(kv[0]))]
        out = {}
        for key, v in value.items():
            name, sub = split_key(key)
            out[name] = untyped(v, sub)
        return out
    if isinstance(value, list):
        return [untyped(v) for v in value]
    return value


def uuid_of(high, low):
    """The UUID two signed 64-bit halves stand for."""
    return uuid.UUID(int=((int(high) & MASK64) << 64) | (int(low) & MASK64))


def short_id(u):
    """The id the mod uses: old quests are a number dressed up as a UUID, and go by that number in hex."""
    s = str(u)
    if not s.startswith(LEGACY):
        return s
    return s[len(LEGACY):].lstrip("0") or "0"


def lang_key(u):
    """How the language files name a quest or chapter: its UUID in URL-safe base64 without padding."""
    return base64.urlsafe_b64encode(u.bytes).decode("ascii").rstrip("=")


def uuid_from_base64(text):
    try:
        raw = base64.urlsafe_b64decode(text.strip() + "=" * (-len(text.strip()) % 4))
    except ValueError:
        return None
    return uuid.UUID(bytes=raw) if len(raw) == 16 else None


def read_lang(text):
    out = {}
    for line in text.split("\n"):
        line = line.rstrip("\r")
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if sep:
            out[key.strip()] = value
    return out


def unescape_lang(value):
    """Language values go through String.format in the game: %n is a line break and %% a percent sign."""
    return re.sub(r"%([%n])", lambda m: "\n" if m.group(1) == "n" else "%", value)


# ── Text ──

IMAGE = re.compile(r"\[img(?: [^\]\n]*)?\].*?\[/img\]", re.I | re.S)
QUEST_LINK = re.compile(r"\[questlink\]\s*([A-Za-z0-9_\-+/=]+)\s*\[/questlink\]", re.I)
# The tags the quest book itself understands; anything else in square brackets is ordinary text.
STYLE_TAG = re.compile(r"\[/?(?:note|warn|quest|bold|url|questlink)(?: [0-9a-zA-Z]+=[^ \]]+)*\]", re.I)
HEX_COLOUR = re.compile(r"(?:&[a-z])?(?:&#[0-9A-Fa-f]{6})+")


def strip_codes(text):
    """Without the colour and style codes, which mean nothing outside the game."""
    if "&#" in text:
        text = HEX_COLOUR.sub("", text).replace("&r", "")
    # The game swallows whatever character follows a section sign.
    return re.sub("\u00a7[^\n]?", "", text)


def plain_name(text):
    return re.sub(r"\s+", " ", strip_codes(text or "")).strip()


def plain_text(text, link=None):
    """A description as plain text: markup removed, links to other quests spelled out, blank runs collapsed."""
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n").replace("\t", " ")
    text = IMAGE.sub("", text)
    if link is not None:
        text = QUEST_LINK.sub(lambda m: link(m.group(1)), text)
    text = strip_codes(STYLE_TAG.sub("", text))
    text = "\n".join(line.rstrip() for line in text.split("\n"))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


# ── Quests ──


def item(raw):
    out = {}
    if isinstance(raw.get("id"), str):
        out["id"] = raw["id"]
    meta = raw.get("Damage")
    if isinstance(meta, int) and 0 <= meta != WILDCARD_META:
        out["meta"] = meta
    count = raw.get("Count")
    out["count"] = max(1, count) if isinstance(count, int) else 1
    if raw.get("OreDict"):
        out["ore"] = raw["OreDict"]
    if raw.get("tag"):
        out["nbt"] = raw["tag"]
    return out


def items(raw, key):
    value = raw.get(key)
    return [item(i) for i in value if isinstance(i, dict)] if isinstance(value, list) else []


def kind(type_id):
    """"bq_standard:retrieval" reads better as "retrieval"."""
    return str(type_id or "unknown").rpartition(":")[2] or "unknown"


def task(raw):
    out = {"type": kind(raw.get("taskID"))}
    wanted = items(raw, "requiredItems")
    if wanted:
        out["items"] = wanted
        if raw.get("requireOnlyOneItem"):
            out["anyOne"] = True
        if raw.get("ignoreNBT"):
            out["ignoreNBT"] = True
    if "consume" in raw:
        out["consume"] = bool(raw["consume"])
    fluids = [
        {"fluid": f.get("FluidName"), "mb": f.get("Amount")}
        for f in raw.get("requiredFluids") or []
        if isinstance(f, dict) and f.get("FluidName")
    ]
    if fluids:
        out["fluids"] = fluids
    if "allowCraft" in raw or "allowSmelt" in raw or "allowAnvil" in raw:
        out["allow"] = [way for key, way in (("allowCraft", "craft"), ("allowSmelt", "smelt"), ("allowAnvil", "anvil")) if raw.get(key)]
    if isinstance(raw.get("target"), str) and raw["target"]:
        # Hunting (kill that many) and meeting (be near that many) both name a creature.
        out["target"] = raw["target"]
        number = raw.get("required", raw.get("amount"))
        out["count"] = max(1, number) if isinstance(number, int) else 1
        if out["type"] != "hunt" and isinstance(raw.get("range"), int):
            out["range"] = raw["range"]
    if "posX" in raw and "posZ" in raw:
        place = {}
        if raw.get("name"):
            place["name"] = plain_name(raw["name"])
        if isinstance(raw.get("dimension"), int):
            place["dim"] = raw["dimension"]
        reach = raw.get("range")
        if isinstance(reach, int) and reach >= 0:
            # Without a range anywhere in the dimension counts and the position means nothing.
            place.update(x=raw.get("posX", 0), y=raw.get("posY", 0), z=raw["posZ"], range=reach)
        if isinstance(raw.get("biome"), int) and raw["biome"] >= 0:
            place["biome"] = raw["biome"]
        if raw.get("structure"):
            place["structure"] = raw["structure"]
        if raw.get("invert"):
            place["invert"] = True
        out["location"] = place
    return out


def reward(raw):
    out = {"type": kind(raw.get("rewardID"))}
    given = items(raw, "rewards") or items(raw, "choices")
    if given:
        out["items"] = given
    if isinstance(raw.get("questID"), str):
        target = uuid_from_base64(raw["questID"])
        if target is not None:
            out["quest"] = short_id(target)
    if isinstance(raw.get("amount"), int):
        out["amount"] = raw["amount"]
        out["levels"] = bool(raw.get("isLevels"))
    return out


def id_order(quest_id):
    """Old quests by their number, then the UUID ones."""
    return (0, int(quest_id, 16), "") if len(quest_id) <= 12 else (1, 0, quest_id)


def find_root(names):
    """Where the game directory sits inside the pack ("instance/.minecraft/" in a launcher export)."""
    marker = QUEST_DIR + "QuestSettings.json"
    roots = sorted(n[: -len(marker)] for n in names if n.endswith(marker))
    if not roots:
        fail("the pack has no %s: is this a GTNH client pack?" % marker)
    return roots[0]


def cmd_quests(args):
    if not os.path.isfile(args.client):
        fail("no such file: " + args.client)
    try:
        pack = zipfile.ZipFile(args.client)
    except (zipfile.BadZipFile, OSError) as e:
        fail("cannot read %s: %s" % (args.client, e))
    with pack:
        names = pack.namelist()
        root = find_root(names)
        base = root + QUEST_DIR

        def load(name):
            try:
                return untyped(json.loads(pack.read(name).decode("utf-8-sig")))
            except (ValueError, KeyError) as e:
                fail("cannot read %s in the pack: %s" % (name, e))

        lang = {}
        lang_name = root + LANG_FILE % args.lang
        if lang_name in names:
            lang = read_lang(pack.read(lang_name).decode("utf-8-sig"))
        else:
            print("warning: the pack has no %s; names and descriptions stay in English" % lang_name, file=sys.stderr)

        raw_quests = {}  # short id -> (uuid, file contents)
        for name in names:
            if name.startswith(base + "Quests/") and name.endswith(".json"):
                doc = load(name)
                u = uuid_of(doc.get("questIDHigh", 0), doc.get("questIDLow", 0))
                if short_id(u) in raw_quests:
                    fail("two quest files have the id %s (%s)" % (short_id(u), name))
                raw_quests[short_id(u)] = (u, doc)
        if not raw_quests:
            fail("found no quests under %sQuests/" % base)

        raw_lines = {}  # short id -> (uuid, properties, [(quest id, x, y)])
        for name in names:
            if not (name.startswith(base + "QuestLines/") and name.endswith("/QuestLine.json")):
                continue
            doc = load(name)
            u = uuid_of(doc.get("questLineIDHigh", 0), doc.get("questLineIDLow", 0))
            folder = name[: -len("QuestLine.json")]
            members = []
            for entry in names:
                if entry.startswith(folder) and entry.endswith(".json") and entry != name:
                    e = load(entry)
                    members.append((short_id(uuid_of(e.get("questIDHigh", 0), e.get("questIDLow", 0))), e.get("x", 0), e.get("y", 0)))
            raw_lines[short_id(u)] = (u, (doc.get("properties") or {}).get("betterquesting") or {}, members)

        order = []
        order_name = base + "QuestLinesOrder.txt"
        if order_name in names:
            for row in pack.read(order_name).decode("utf-8-sig").split("\n"):
                u = uuid_from_base64(row.partition(":")[0])
                if u is not None and short_id(u) in raw_lines and short_id(u) not in order:
                    order.append(short_id(u))
        # A chapter the order file does not list still belongs in the book: after the others.
        order += sorted((i for i in raw_lines if i not in order), key=id_order)

    def props(doc):
        return (doc.get("properties") or {}).get("betterquesting") or {}

    def names_of(kind_key, u, english_name, english_text, link):
        """The Chinese name and text where the language file has them, the pack's English otherwise."""
        key = "betterquesting.%s.%s." % (kind_key, lang_key(u))
        en = plain_name(english_name)
        name = plain_name(unescape_lang(lang.get(key + "name", ""))) or en
        text_en = plain_text(english_text, link)
        text = plain_text(unescape_lang(lang.get(key + "desc", "")), link) or text_en
        out = {"name": name or str(u)}
        if en and en != name:
            out["en"] = en
        out["desc"] = text
        if text_en and text_en != text:
            out["descEn"] = text_en
        return out

    def title(quest_id):
        u, doc = raw_quests[quest_id]
        return plain_name(unescape_lang(lang.get("betterquesting.quest.%s.name" % lang_key(u), ""))) or plain_name(props(doc).get("name"))

    def link(encoded):
        """[questlink]…[/questlink] holds another quest's id; the reader wants its name."""
        u = uuid_from_base64(encoded)
        if u is None or short_id(u) not in raw_quests:
            return encoded
        return "\u201c%s\u201d\uff08\u4efb\u52a1 %s\uff09" % (title(short_id(u)), short_id(u))

    requires = {}
    for quest_id, (_, doc) in raw_quests.items():
        requires[quest_id] = [
            short_id(uuid_of(p.get("questIDHigh", 0), p.get("questIDLow", 0))) for p in doc.get("preRequisites") or [] if isinstance(p, dict)
        ]

    # How deep each quest sits behind its requirements: the order a player meets them in.
    depth = {}
    for start in raw_quests:
        stack = [start]
        while stack:
            q = stack[-1]
            if q in depth:
                stack.pop()
                continue
            waiting = [p for p in requires[q] if p in raw_quests and p not in depth and p not in stack]
            if waiting:
                stack.extend(waiting)
                continue
            depth[q] = 1 + max((depth.get(p, 0) for p in requires[q] if p in raw_quests), default=-1)
            stack.pop()

    lines = []
    chapters_of = {}  # quest id -> chapter ids, in the book's order
    for line_id in order:
        u, p, members = raw_lines[line_id]
        seen = set()
        placed = []
        for quest_id, x, y in sorted(members, key=lambda m: (depth.get(m[0], 0), m[2], m[1], id_order(m[0]))):
            if quest_id in raw_quests and quest_id not in seen:
                seen.add(quest_id)
                placed.append(quest_id)
                chapters_of.setdefault(quest_id, []).append(line_id)
        entry = {"id": line_id}
        entry.update(names_of("questline", u, p.get("name"), p.get("desc"), link))
        entry["quests"] = placed
        lines.append(entry)

    quests = {}
    translated = 0
    for quest_id, (u, doc) in raw_quests.items():
        p = props(doc)
        if "betterquesting.quest.%s.name" % lang_key(u) in lang:
            translated += 1
        q = {"id": quest_id}
        q.update(names_of("quest", u, p.get("name"), p.get("desc"), link))
        q["lines"] = chapters_of.get(quest_id, [])
        q["main"] = bool(p.get("isMain"))
        if p.get("visibility") and p["visibility"] != "NORMAL":
            q["visibility"] = p["visibility"]
        q["pre"] = requires[quest_id]
        q["logic"] = p.get("questLogic") or "AND"
        q["taskLogic"] = p.get("taskLogic") or "AND"
        if isinstance(p.get("repeatTime"), int) and p["repeatTime"] >= 0:
            q["repeat"] = p["repeatTime"]
        if p.get("autoClaim"):
            q["autoClaim"] = True
        q["tasks"] = [task(t) for t in doc.get("tasks") or [] if isinstance(t, dict)]
        q["rewards"] = [reward(r) for r in doc.get("rewards") or [] if isinstance(r, dict)]
        quests[quest_id] = q

    # The book's order: chapter by chapter, each quest where it first appears; then the ones in no chapter.
    ordered = []
    listed = set()
    for entry in lines:
        for quest_id in entry["quests"]:
            if quest_id not in listed:
                listed.add(quest_id)
                ordered.append(quest_id)
    ordered += sorted((i for i in quests if i not in listed), key=id_order)

    os.makedirs(args.out, exist_ok=True)
    write_atomic(os.path.join(args.out, "quests.jsonl"), "".join(dump(quests[i]) + "\n" for i in ordered))
    write_atomic(os.path.join(args.out, "questlines.json"), dump({"lines": lines}) + "\n")
    update_meta(
        args.out,
        "quests",
        {
            "format": QUESTS_FORMAT,
            "source": os.path.basename(args.client),
            "generatedAt": now_utc(),
            "lang": args.lang,
            "quests": len(quests),
            "lines": len(lines),
            "translated": translated,
        },
    )
    unknown = sum(1 for q in quests.values() for p in q["pre"] if p not in quests)
    print(
        "quests: %d quests in %d chapters (%d named in %s.lang, %d in no chapter, %d requirements point at quests that do not exist) -> %s"
        % (len(quests), len(lines), translated, args.lang, len(quests) - len(listed), unknown, args.out)
    )


# ── Block textures ──
# blocks.jsonl names the texture of each block ("tex" for the sides, "texTop" for the top when it differs) the way
# the game does: "wool_colored_red", "chisel:nucrete/concrete-7". The file is
# assets/<part before the colon, "minecraft" if there is none>/textures/blocks/<the rest>.png inside a mod jar.

TEXTURES_FORMAT = 1
ATLAS_COLUMNS = 64
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# Adam7: where each pass starts and how far apart its pixels are (x start, y start, x step, y step).
ADAM7 = ((0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2))
PNG_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


class BadImage(Exception):
    pass


def unfilter(data, at, width_bytes, height, bpp):
    """Undoes the PNG row filters of `height` rows starting at data[at]. Returns the rows and where they end."""
    rows = []
    previous = bytearray(width_bytes)
    for _ in range(height):
        if at + 1 + width_bytes > len(data):
            raise BadImage("the pixel data is cut short")
        kind = data[at]
        row = bytearray(data[at + 1 : at + 1 + width_bytes])
        at += 1 + width_bytes
        if kind == 1:
            for i in range(bpp, width_bytes):
                row[i] = (row[i] + row[i - bpp]) & 255
        elif kind == 2:
            for i in range(width_bytes):
                row[i] = (row[i] + previous[i]) & 255
        elif kind == 3:
            for i in range(width_bytes):
                left = row[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + ((left + previous[i]) >> 1)) & 255
        elif kind == 4:
            for i in range(width_bytes):
                a = row[i - bpp] if i >= bpp else 0
                b = previous[i]
                c = previous[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                row[i] = (row[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        elif kind != 0:
            raise BadImage("unknown row filter %d" % kind)
        rows.append(row)
        previous = row
    return rows, at


def samples_of(row, count, depth):
    """The first `count` samples of a row as numbers (16-bit samples keep all 16 bits)."""
    if depth == 8:
        return row[:count]
    if depth == 16:
        return [(row[2 * i] << 8) | row[2 * i + 1] for i in range(count)]
    mask = (1 << depth) - 1
    return [(row[(i * depth) >> 3] >> (8 - depth - ((i * depth) & 7))) & mask for i in range(count)]


def decode_png(data):
    """Reads a PNG into (width, height, RGBA bytes). Every colour type and bit depth, interlaced or not."""
    if data[:8] != PNG_SIGNATURE:
        raise BadImage("not a PNG file")
    at = 8
    header = palette = transparency = None
    packed = []
    while at + 12 <= len(data):
        length, kind = struct.unpack(">I4s", data[at : at + 8])
        body = data[at + 8 : at + 8 + length]
        at += 12 + length
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body[:13])
        elif kind == b"PLTE":
            palette = body
        elif kind == b"tRNS":
            transparency = body
        elif kind == b"IDAT":
            packed.append(body)
        elif kind == b"IEND":
            break
    if header is None:
        raise BadImage("no header")
    width, height, depth, colour, _, _, interlace = header
    if colour not in PNG_CHANNELS or depth not in (1, 2, 4, 8, 16) or width < 1 or height < 1 or width * height > 4096 * 4096:
        raise BadImage("unsupported PNG (%dx%d, colour type %d, %d bit)" % (width, height, colour, depth))
    if colour == 3 and palette is None:
        raise BadImage("no palette")
    try:
        raw = zlib.decompress(b"".join(packed))
    except zlib.error as e:
        raise BadImage("the pixel data does not decompress: %s" % e)
    channels = PNG_CHANNELS[colour]
    bpp = max(1, channels * depth // 8)
    top = (1 << depth) - 1
    scale = (lambda v: v >> 8) if depth == 16 else (lambda v: v * 255 // top)
    # A colour the file declares fully transparent (grey and RGB images only); 16-bit values, compared unscaled.
    clear = None
    if transparency is not None and colour == 0 and len(transparency) >= 2:
        clear = (struct.unpack(">H", transparency[:2])[0],)
    elif transparency is not None and colour == 2 and len(transparency) >= 6:
        clear = struct.unpack(">HHH", transparency[:6])
    out = bytearray(width * height * 4)

    def put(row, columns, y, x_start, x_step):
        values = samples_of(row, columns * channels, depth)
        for i in range(columns):
            o = (y * width + x_start + i * x_step) * 4
            if colour == 3:
                index = values[i]
                if index * 3 + 2 >= len(palette):
                    raise BadImage("a pixel names a palette entry that does not exist")
                out[o : o + 3] = palette[index * 3 : index * 3 + 3]
                out[o + 3] = transparency[index] if transparency is not None and index < len(transparency) else 255
            elif colour == 0:
                v = values[i]
                out[o] = out[o + 1] = out[o + 2] = scale(v)
                out[o + 3] = 0 if clear == (v,) else 255
            elif colour == 4:
                out[o] = out[o + 1] = out[o + 2] = scale(values[2 * i])
                out[o + 3] = scale(values[2 * i + 1])
            elif colour == 2:
                r, g, b = values[3 * i], values[3 * i + 1], values[3 * i + 2]
                out[o], out[o + 1], out[o + 2] = scale(r), scale(g), scale(b)
                out[o + 3] = 0 if clear == (r, g, b) else 255
            else:
                for c in range(4):
                    out[o + c] = scale(values[4 * i + c])

    row_bytes = lambda columns: (columns * channels * depth + 7) // 8
    at = 0
    if interlace == 0:
        rows, at = unfilter(raw, 0, row_bytes(width), height, bpp)
        for y, row in enumerate(rows):
            put(row, width, y, 0, 1)
    elif interlace == 1:
        for x0, y0, dx, dy in ADAM7:
            columns = (width - x0 + dx - 1) // dx
            lines = (height - y0 + dy - 1) // dy
            if columns <= 0 or lines <= 0:
                continue
            rows, at = unfilter(raw, at, row_bytes(columns), lines, bpp)
            for n, row in enumerate(rows):
                put(row, columns, y0 + n * dy, x0, dx)
    else:
        raise BadImage("unknown interlace method %d" % interlace)
    return width, height, bytes(out)


def encode_png(width, height, rgba):
    """Writes RGBA bytes as an 8-bit RGBA PNG."""

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)

    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw += rgba[y * stride : (y + 1) * stride]
    return PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def tile_of(width, height, rgba, size):
    """One square tile of size x size out of a texture: the first frame of an animation (the square at the top),
    shrunk by averaging when it is a whole multiple bigger, sampled to the nearest pixel otherwise."""
    side = min(width, height)
    out = bytearray(size * size * 4)
    if side == size:
        for y in range(size):
            out[y * size * 4 : (y + 1) * size * 4] = rgba[y * width * 4 : y * width * 4 + size * 4]
        return bytes(out)
    if side % size == 0:
        k = side // size
        for ty in range(size):
            for tx in range(size):
                r = g = b = a = 0
                for y in range(ty * k, ty * k + k):
                    o = (y * width + tx * k) * 4
                    for _ in range(k):
                        alpha = rgba[o + 3]
                        # Colours count by how opaque they are, so a clear pixel does not darken its neighbours.
                        r += rgba[o] * alpha
                        g += rgba[o + 1] * alpha
                        b += rgba[o + 2] * alpha
                        a += alpha
                        o += 4
                o = (ty * size + tx) * 4
                if a > 0:
                    out[o], out[o + 1], out[o + 2] = (r + a // 2) // a, (g + a // 2) // a, (b + a // 2) // a
                out[o + 3] = (a + k * k // 2) // (k * k)
        return bytes(out)
    for ty in range(size):
        for tx in range(size):
            o = ((ty * side // size) * width + tx * side // size) * 4
            out[(ty * size + tx) * 4 : (ty * size + tx) * 4 + 4] = rgba[o : o + 4]
    return bytes(out)


def texture_path(name):
    """"chisel:nucrete/concrete-7" -> ("chisel", "nucrete/concrete-7"). The game lower-cases the part before the colon."""
    domain, colon, rest = name.partition(":")
    return (domain.lower(), rest) if colon else ("minecraft", name)


def block_textures(sources):
    """Every block texture in the given archives: "assets/<domain>/textures/blocks/<path>.png" -> a function that
    reads it. The first archive that has a file wins."""
    found = {}
    marker = "/textures/blocks/"

    def add(archive):
        for name in archive.namelist():
            if name.startswith("assets/") and marker in name and name.lower().endswith(".png") and name not in found:
                found[name] = lambda archive=archive, name=name: archive.read(name)

    for label, opener in sources:
        try:
            add(opener())
        except (zipfile.BadZipFile, OSError) as e:
            print("make-packdata: skipping %s: %s" % (label, e), file=sys.stderr)
    return found


def cmd_textures(args):
    if not args.client and not args.jar:
        fail("give --client (the pack with the mod jars), --jar (a single jar), or both")
    blocks_path = args.blocks or os.path.join(args.out, "blocks.jsonl")
    if not os.path.isfile(blocks_path):
        fail("no such file: %s (the block colour table names the textures; export it first or give --blocks)" % blocks_path)
    wanted = []
    seen = set()
    with open(blocks_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            for key in ("tex", "texTop"):
                name = row.get(key) if isinstance(row, dict) else None
                if isinstance(name, str) and name and name not in seen:
                    seen.add(name)
                    wanted.append(name)

    sources = []
    pack = None
    if args.client:
        if not os.path.isfile(args.client):
            fail("no such file: " + args.client)
        try:
            pack = zipfile.ZipFile(args.client)
        except (zipfile.BadZipFile, OSError) as e:
            fail("cannot read %s: %s" % (args.client, e))
        # The mods' own files come before the extra jars: a mod that replaces a vanilla texture wins, as in the game.
        for name in sorted(n for n in pack.namelist() if n.lower().endswith(".jar")):
            sources.append((name, lambda name=name: zipfile.ZipFile(io.BytesIO(pack.read(name)))))
    for jar in args.jar or []:
        if not os.path.isfile(jar):
            fail("no such file: " + jar)
        sources.append((jar, lambda jar=jar: zipfile.ZipFile(jar)))
    files = block_textures(sources)
    # Names are matched as written; a jar that spells a folder in another case is still found.
    any_case = {}
    for path in files:
        any_case.setdefault(path.lower(), path)
    named = len(wanted)

    # Every vanilla block texture comes along too: the brain colours common blocks that the table leaves out
    # (grass, leaves, glass, water) from them.
    vanilla = "assets/minecraft/textures/blocks/"
    for path in sorted(files):
        if path.startswith(vanilla) and "/" not in path[len(vanilla) :]:
            name = path[len(vanilla) : -4]
            if name not in seen:
                seen.add(name)
                wanted.append(name)

    size = args.tile
    tiles = {}
    pixels = []
    missing = []
    unreadable = []
    for name in wanted:
        domain, rest = texture_path(name)
        path = "assets/%s/textures/blocks/%s.png" % (domain, rest)
        read = files.get(path) or files.get(any_case.get(path.lower()))
        if read is None:
            missing.append(name)
            continue
        try:
            pixels.append(tile_of(*decode_png(read()), size))
        except (BadImage, KeyError, OSError, zlib.error, struct.error, IndexError) as e:
            unreadable.append(name)
            print("make-packdata: cannot read the texture %s: %s" % (name, e), file=sys.stderr)
            continue
        tiles[name] = len(pixels) - 1
    if pack is not None:
        pack.close()
    if not pixels:
        fail("none of the %d textures was found in the jars; nothing written" % len(wanted))

    columns = min(ATLAS_COLUMNS, len(pixels))
    rows = (len(pixels) + columns - 1) // columns
    atlas = bytearray(columns * size * rows * size * 4)
    for index, tile in enumerate(pixels):
        left = (index % columns) * size
        top = (index // columns) * size
        for y in range(size):
            o = ((top + y) * columns * size + left) * 4
            atlas[o : o + size * 4] = tile[y * size * 4 : (y + 1) * size * 4]

    out_dir = os.path.join(args.out, "textures")
    os.makedirs(out_dir, exist_ok=True)
    png_path = os.path.join(out_dir, "atlas.png")
    with open(png_path + ".tmp", "wb") as fh:
        fh.write(encode_png(columns * size, rows * size, atlas))
    os.replace(png_path + ".tmp", png_path)
    generated = now_utc()
    write_atomic(
        os.path.join(out_dir, "atlas.json"),
        dump({"format": TEXTURES_FORMAT, "generatedAt": generated, "tile": size, "columns": columns, "rows": rows, "tiles": tiles, "missing": missing + unreadable}) + "\n",
    )
    source = " + ".join(os.path.basename(p) for p in ([args.client] if args.client else []) + (args.jar or []))
    update_meta(args.out, "textures", {"format": TEXTURES_FORMAT, "source": source, "generatedAt": generated, "tile": size, "tiles": len(tiles), "missing": len(missing) + len(unreadable)})
    print(
        "textures: %d tiles of %d px in a %dx%d image (%d of the %d named in %s, %d more vanilla ones; %d not found, %d unreadable) -> %s"
        % (
            len(tiles),
            size,
            columns * size,
            rows * size,
            sum(1 for n in wanted[:named] if n in tiles),
            named,
            os.path.basename(blocks_path),
            sum(1 for n in wanted[named:] if n in tiles),
            len(missing),
            len(unreadable),
            out_dir,
        )
    )


# ── the in-game guide (GuideNH) ──
# A guide pack is a resource pack: assets/<book>/guidenh/_<language>/<page>.md, each page Markdown with a few
# lines of YAML in front (its title and place in the contents, the items it is about). The pack ships one as
# config/guidenh/DefaultGuide.zip. Pages are taken as written; what their tags mean is the reader's business.

GUIDE_FORMAT = 1
GUIDE_DIR = "config/guidenh/"
GUIDE_PAGE = re.compile(r"^(?:.*/)?assets/([^/]+)/guidenh/_([a-z]{2}_[a-z]{2})/(.+\.md)$")
GUIDE_HEAD = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*(?:\n|\Z)", re.S)


def yaml_scalar(text):
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        return text[1:-1]
    if text.startswith("[") and text.endswith("]"):
        return [yaml_scalar(part) for part in text[1:-1].split(",") if part.strip()]
    return text


def front_matter(head):
    """The little of YAML that guide pages use: `key: value`, `key:` with a list or a map of such under it."""
    out = {}
    key = None
    for line in head.split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        body = line.strip()
        if body.startswith("- ") or body == "-":
            if key is not None:
                if not isinstance(out.get(key), list):
                    out[key] = []
                value = yaml_scalar(body[1:])
                if value != "":
                    out[key].append(value)
            continue
        name, colon, rest = body.partition(":")
        if not colon:
            continue
        if indent == 0:
            key = name.strip()
            out[key] = yaml_scalar(rest) if rest.strip() else None
        elif key is not None:
            if not isinstance(out.get(key), dict):
                out[key] = {}
            out[key][name.strip()] = yaml_scalar(rest)
    return out


def guide_item(text):
    """`mod:name`, `mod:name:meta`, `mod:name:*`, or `mod:name 1,2,5-9` as the guide writes the items of a page."""
    text = str(text).strip()
    name, _, tail = text.partition(" ")
    parts = name.split(":")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        return None
    out = {"id": parts[0] + ":" + parts[1]}
    if tail.strip():
        metas = []
        for piece in tail.replace(" ", "").split(","):
            low, dash, high = piece.partition("-")
            if low.isdigit() and (not dash or high.isdigit()):
                metas.append([int(low), int(high)] if dash else int(low))
        if metas:
            out["metas"] = metas
    elif len(parts) >= 3 and parts[2].isdigit():
        out["meta"] = int(parts[2])
    return out


def as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def guide_packs(args):
    """(name, ZipFile) of every guide pack to read."""
    if args.pack:
        for path in args.pack:
            if not os.path.isfile(path):
                fail("no such file: " + path)
            try:
                yield os.path.basename(path), zipfile.ZipFile(path)
            except (zipfile.BadZipFile, OSError) as e:
                fail("cannot read %s: %s" % (path, e))
        return
    if not args.client:
        fail("give --client CLIENT.zip (the guide is read from config/guidenh/ in it) or --pack GUIDE.zip")
    if not os.path.isfile(args.client):
        fail("no such file: " + args.client)
    try:
        client = zipfile.ZipFile(args.client)
    except (zipfile.BadZipFile, OSError) as e:
        fail("cannot read %s: %s" % (args.client, e))
    with client:
        inner = sorted(n for n in client.namelist() if ("/" + n).find("/" + GUIDE_DIR) >= 0 and n.lower().endswith(".zip"))
        if not inner:
            fail("the pack has no guide (%s*.zip): is GuideNH part of it?" % GUIDE_DIR)
        for name in inner:
            try:
                yield os.path.basename(name), zipfile.ZipFile(io.BytesIO(client.read(name)))
            except zipfile.BadZipFile as e:
                fail("cannot read %s inside %s: %s" % (name, args.client, e))


def cmd_guide(args):
    rows = {}
    sources = []
    others = {}
    for source, pack in guide_packs(args):
        with pack:
            version = None
            try:
                info = json.loads(pack.read("pack.mcmeta").decode("utf-8-sig"))
                version = (info.get("gtnh_resource_pack_updater") or {}).get("pack_version")
            except (KeyError, ValueError):
                pass
            sources.append({"file": source, "version": version} if version else {"file": source})
            for name in pack.namelist():
                if name.endswith("/"):
                    continue
                m = GUIDE_PAGE.match(name)
                if not m:
                    if "/guidenh/" in name:
                        kind = name.rsplit(".", 1)[-1].lower() if "." in name.rsplit("/", 1)[-1] else "other"
                        others[kind] = others.get(kind, 0) + 1
                    continue
                book, lang, path = m.group(1), m.group(2), m.group(3)
                text = pack.read(name).decode("utf-8-sig", "replace").replace("\r\n", "\n").replace("\r", "\n")
                head = GUIDE_HEAD.match(text)
                meta = front_matter(head.group(1)) if head else {}
                body = text[head.end():] if head else text
                nav = meta.get("navigation") if isinstance(meta.get("navigation"), dict) else {}
                row = {"book": book, "lang": lang, "path": path}
                title = nav.get("title")
                if not title:
                    h1 = re.search(r"^#\s+(.+?)\s*$", body, re.M)
                    title = h1.group(1) if h1 else None
                if title:
                    row["title"] = str(title)
                if nav.get("parent"):
                    row["parentAsWritten"] = str(nav["parent"])
                if str(nav.get("position", "")).lstrip("-").isdigit():
                    row["position"] = int(nav["position"])
                icon = guide_item(nav["icon"]) if nav.get("icon") else None
                if icon:
                    row["icon"] = icon
                items = [i for i in (guide_item(v) for v in as_list(meta.get("item_ids")) + as_list(meta.get("item_id"))) if i]
                if items:
                    row["items"] = items
                quests = [str(q) for q in as_list(meta.get("quest_ids"))]
                if quests:
                    row["quests"] = quests
                categories = [str(c) for c in as_list(meta.get("categories"))]
                if categories:
                    row["categories"] = categories
                for key in ("author", "date"):
                    if meta.get(key) and not isinstance(meta[key], (list, dict)):
                        row[key] = str(meta[key])
                row["text"] = body.strip("\n")
                rows[(book, lang, path)] = row  # a later pack replaces the page of an earlier one
    if not rows:
        fail("no guide pages found (assets/<book>/guidenh/_<language>/*.md)")
    # A page names its parent from the top of the book, or from its own folder when it starts with a dot. Kept
    # as the path inside the book, as "path" is; one that names no page of the book is kept as written.
    unknown = 0
    for (book, lang, path), row in rows.items():
        written = row.pop("parentAsWritten", None)
        if written is None:
            continue
        name = written.split(":", 1)[1] if ":" in written else written
        here = os.path.dirname(path)
        tries = [os.path.join(here, name)] if name.startswith(".") else [name.lstrip("/"), os.path.join(here, name.lstrip("/"))]
        for candidate in tries:
            candidate = os.path.normpath(candidate).replace(os.sep, "/")
            if (book, lang, candidate) in rows:
                row["parent"] = candidate
                break
        else:
            row["parent"] = written
            row["parentUnknown"] = True
            unknown += 1
    os.makedirs(args.out, exist_ok=True)
    ordered = [rows[k] for k in sorted(rows)]
    write_atomic(os.path.join(args.out, "guide.jsonl"), "".join(dump(r) + "\n" for r in ordered))
    books = {}
    for r in ordered:
        b = books.setdefault(r["book"], {})
        b[r["lang"]] = b.get(r["lang"], 0) + 1
    update_meta(
        args.out,
        "guide",
        {
            "format": GUIDE_FORMAT,
            "source": sources,
            "generatedAt": now_utc(),
            "pages": len(ordered),
            "chars": sum(len(r["text"]) for r in ordered),
            "books": books,
            "parentsUnknown": unknown,
            "notTaken": others,
        },
    )
    print("guide: %d pages (%d characters) of %d books; left out: %s" % (
        len(ordered), sum(len(r["text"]) for r in ordered), len(books),
        ", ".join("%d %s" % (n, k) for k, n in sorted(others.items())) or "nothing"))


def main():
    parser = argparse.ArgumentParser(description="Builds the brain's local pack data from the game client pack (docs/PACKDATA.md).")
    commands = parser.add_subparsers(dest="command", metavar="COMMAND")
    commands.required = True
    quests = commands.add_parser("quests", help="the quest book: quests.jsonl, questlines.json")
    quests.add_argument("--client", required=True, metavar="ZIP", help="the client pack (only read)")
    quests.add_argument("--out", required=True, metavar="DIR", help="where the pack data goes, e.g. brain/packdata")
    quests.add_argument("--lang", default="zh_CN", help="which language file of the quest book to take names and texts from (default zh_CN)")
    quests.set_defaults(run=cmd_quests)
    textures = commands.add_parser("textures", help="the block textures: textures/atlas.png, textures/atlas.json")
    textures.add_argument("--client", metavar="ZIP", help="the client pack (only read): the mod jars inside it are searched")
    textures.add_argument("--jar", action="append", metavar="JAR", help="one more jar to search, e.g. the vanilla minecraft-1.7.10-client.jar; may be given several times")
    textures.add_argument("--blocks", metavar="FILE", help="the block colour table that names the textures (default OUT/blocks.jsonl)")
    textures.add_argument("--out", required=True, metavar="DIR", help="where the pack data goes, e.g. brain/packdata")
    textures.add_argument("--tile", type=int, default=16, choices=(16, 32), help="pixels along the side of one texture in the image (default 16)")
    textures.set_defaults(run=cmd_textures)
    guide = commands.add_parser("guide", help="the pages of the in-game guide (GuideNH): guide.jsonl")
    guide.add_argument("--client", metavar="ZIP", help="the client pack (only read): the guide packs in its config/guidenh/ are taken")
    guide.add_argument("--pack", action="append", metavar="ZIP", help="a guide pack to read instead of the ones in the client pack; may be given several times, a later one's pages replace an earlier one's")
    guide.add_argument("--out", required=True, metavar="DIR", help="where the pack data goes, e.g. brain/packdata")
    guide.set_defaults(run=cmd_guide)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
