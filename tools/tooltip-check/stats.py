#!/usr/bin/env python3
"""Numbers about tooltips.jsonl: how big, how long, which lines come up most, which depend on who looks.

  tools/tooltip-check/stats.py [--out DIR] [--top N]
"""
import collections
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def opt(flag, default):
    argv = sys.argv[1:]
    return argv[argv.index(flag) + 1] if flag in argv else default


out = opt("--out", os.path.join(ROOT, "brain", "packdata"))
top = int(opt("--top", "50"))
path = os.path.join(out, "tooltips.jsonl")
rows = [json.loads(l) for l in open(path, encoding="utf8")]
names = {}
for l in open(os.path.join(out, "items.jsonl"), encoding="utf8"):
    o = json.loads(l)
    names[(o["id"], o["meta"])] = o.get("name", "")
total_items = len(names)
mod = lambda o: o["id"].split(":")[0]

print("file: %s, %.1f MB, %d lines of it" % (path, os.path.getsize(path) / 1e6, len(rows)))
print("items in items.jsonl: %d; with a tooltip: %d (%.0f%%); with another one for Shift: %d; for Ctrl: %d"
      % (total_items, len(rows), 100.0 * len(rows) / total_items, sum("shift" in o for o in rows), sum("ctrl" in o for o in rows)))
n_tip = sum(len(o["tip"]) for o in rows)
n_shift = sum(len(o.get("shift", [])) for o in rows)
n_ctrl = sum(len(o.get("ctrl", [])) for o in rows)
print("lines: %d in tip, %d in shift, %d in ctrl" % (n_tip, n_shift, n_ctrl))
sizes = sorted(len(o["tip"]) for o in rows)
print("lines of tip per item: median %d, 90%% have at most %d, 99%% at most %d" % (sizes[len(sizes) // 2], sizes[int(len(sizes) * 0.9)], sizes[int(len(sizes) * 0.99)]))
for key in ("tip", "shift", "ctrl"):
    o = max(rows, key=lambda o: len(o.get(key, [])))
    print("longest %s: %d lines, %s/%d %s" % (key, len(o.get(key, [])), o["id"], o["meta"], names.get((o["id"], o["meta"]), "")))
chars = max(rows, key=lambda o: sum(len(l) for k in ("tip", "shift", "ctrl") for l in o.get(k, [])))
print("most text: %d characters, %s/%d %s" % (sum(len(l) for k in ("tip", "shift", "ctrl") for l in chars.get(k, [])), chars["id"], chars["meta"], names.get((chars["id"], chars["meta"]), "")))

# How many items a line is on (once per item, whichever of the three lists it is in).
on = collections.Counter()
where = {}
mods_of = collections.defaultdict(collections.Counter)
for o in rows:
    seen = set()
    for key in ("tip", "shift", "ctrl"):
        for l in o.get(key, []):
            if l and l not in seen:
                seen.add(l)
                on[l] += 1
                where.setdefault(l, (o["id"], o["meta"]))
                mods_of[l][mod(o)] += 1
print("\ndistinct lines: %d" % len(on))
print("\nthe %d lines that are on the most items (items, line, mods it is mostly on):" % top)
for l, n in on.most_common(top):
    m = ", ".join("%s %d" % kv for kv in mods_of[l].most_common(3))
    print("%6d  %-60s  [%s]" % (n, l, m))

print("\nby mod: items with a tooltip")
c = collections.Counter(mod(o) for o in rows)
print(", ".join("%s %d" % kv for kv in c.most_common(25)))

# Lines that say something about the one who looks or about this one stack rather than about the kind of item.
watch = [
    ("eaten before / food history", r"食用任何食物|食物恢复的饥饿值|尚未食用|已食用|吃过"),
    ("a key that is not bound here (shows as NONE)", r"NONE"),
    ("research, knowledge, scanning", r"未研究|需要研究|未解锁|尚未解锁|未扫描|未知的|未鉴定|未分析|<未知|unknown|not researched"),
    ("owner, binding, linking", r"所有者|拥有者|绑定|未链接|未连接|Owner|未绑定"),
    ("charge or contents of this one stack", r"^(充能|已存储能量|电量|能量)[:：]|^\d[\d,\.]* ?/ ?[\d,\.]+ ?[kMG]? ?(EU|RF|AE|J|字节|类型)|/ ?[\d,\.]+[kMG]? (EU|RF)\b"),
    ("experience or level of this one tool", r"经验[:：] ?\d|工具等级|备受摧残"),
    ("guide hint", r"长按 \[G\] 打开指南"),
    ("asks for a key", r"按住|Hold |按下 |<按住"),
]
print("\nlines that depend on who looks at them or on the one stack (items, pattern; examples):")
for label, pattern in watch:
    rx = re.compile(pattern, re.I)
    hits = [(l, n) for l, n in on.items() if rx.search(l)]
    items = set()
    for o in rows:
        if any(rx.search(l) for key in ("tip", "shift", "ctrl") for l in o.get(key, [])):
            items.add((o["id"], o["meta"]))
    hits.sort(key=lambda x: -x[1])
    print("%6d items  %s  (%d distinct lines)" % (len(items), label, len(hits)))
    for l, n in hits[:6]:
        print("          %5d  %s   <- %s/%d" % (n, l[:90], where[l][0], where[l][1]))
