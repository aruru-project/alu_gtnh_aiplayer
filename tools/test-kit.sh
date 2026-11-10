#!/usr/bin/env bash
# Gives a test bot the tools GTNH players actually dig with (Tinkers' Construct, steel) and some filler.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
BOT=${1:-Alu}
T='BaseDurability:3000,TotalDurability:3000,BonusDurability:0,ModDurability:0.0f,Shoddy:0.0f,HarvestLevel:5,MiningSpeed:700,Attack:4,BaseAttack:4,Damage:0,Broken:0b,Modifiers:0,Unbreaking:2,ToolLevel:1,ToolEXP:0L,HeadEXP:0L'
rcon() { "$ROOT/tools/testserver" rcon "$@"; }
rcon "give $BOT TConstruct:pickaxe 1 0 {InfiTool:{Head:16,Handle:16,Accessory:16,RenderHead:16,RenderHandle:16,RenderAccessory:16,$T}}"
rcon "give $BOT TConstruct:shovel 1 0 {InfiTool:{Head:16,Handle:16,RenderHead:16,RenderHandle:16,$T}}"
rcon "give $BOT TConstruct:hatchet 1 0 {InfiTool:{Head:16,Handle:16,RenderHead:16,RenderHandle:16,$T}}"
rcon "give $BOT minecraft:dirt 64"
