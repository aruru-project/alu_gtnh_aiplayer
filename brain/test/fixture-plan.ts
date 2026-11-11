// 做法规划用的小配方册和一个假基地：够得着规划要紧的情形——
// 一条四五层深的链（直升机桨叶）、同一样东西机器和手工两种做法耗料不同、一轮出多个、不消耗的模头和工具、
// 每种材质一条的工具配方、同一种东西两个 id、粉和锭互相变（循环）、回收配方、要流体和炉温的高炉配方、一条很长的链（上限）；
// 一个矿辞名下既有普通工具又有电动的、“拿普通的升级”的（剪线钳）；同一样东西手工、压模机（要模头）、流体固化器（要流体）三种做法（钢销）；
// 用基地里没有的材质也能做的东西（钛板浇出来再做模头）。
// 配方的编号就是它在 RECIPES 里的下标。

import fs from 'node:fs'
import path from 'node:path'
import type { FakeGame } from './agent-harness.ts'
import type { MockBridge, MockCrafting, MockMachine, MockRecipeItem } from './mock-bridge.ts'

const GT = 'gregtech:gt.metaitem.01'
const MACHINE = 'gregtech:gt.blockmachines'
export const P = {
  steelIngot: { id: GT, meta: 11305 },
  steelPlate: { id: GT, meta: 17305 },
  steelDust: { id: GT, meta: 2305 },
  steelGear: { id: 'gregtech:gt.metaitem.02', meta: 31305 },
  steelScrew: { id: GT, meta: 27305 },
  darkIngot: { id: 'EnderIO:itemAlloy', meta: 6 },
  darkIngotGt: { id: GT, meta: 11364 },
  darkPlate: { id: GT, meta: 17364 },
  darkDust: { id: GT, meta: 2364 },
  magneticDust: { id: GT, meta: 2365 },
  coalDust: { id: GT, meta: 2535 },
  obsidianDust: { id: GT, meta: 2804 },
  rodShape: { id: GT, meta: 32351 },
  shaftShape: { id: 'miscutils:MU-metaitem.01', meta: 32040 },
  shaft: { id: 'IC2:itemRecipePart', meta: 12 },
  blades: { id: 'adventurebackpack:backpackComponent', meta: 6 },
  hammer: { id: 'gregtech:gt.metatool.01', meta: 12 },
  screwdriver: { id: 'gregtech:gt.metatool.01', meta: 22 },
  stick: { id: 'minecraft:stick', meta: 0 },
  steelRod: { id: GT, meta: 23305 },
  plateShape: { id: GT, meta: 32350 },
  sheet: { id: 'demo:sheet', meta: 0 },
  pin: { id: 'demo:pin', meta: 0 },
  wire: { id: 'demo:wire', meta: 0 },
  wireCutter: { id: 'gregtech:gt.metatool.01', meta: 26 },
  multitool: { id: 'gregtech:gt.metatool.01', meta: 192 },
  snips: { id: 'miscutils:gt.plusplus.metatool.01', meta: 7934 },
  motor: { id: GT, meta: 32600 },
  battery: { id: GT, meta: 32518 },
  titanPlate: { id: GT, meta: 17028 },
  /** 每种材质一把锤子用的锭：demo:ingot/0…11。 */
  demoIngot: (n: number) => ({ id: 'demo:ingot', meta: n }),
  /** 一条长链上的第 n 节。 */
  link: (n: number) => ({ id: 'demo:link', meta: n }),
}

const DEMO = ['铜', '锡', '青铜', '钢质', '金', '银', '铅', '镍', '锌', '钴', '钛', '钨钢']
export const LINKS = 13

export const ITEMS = [
  { ...P.steelIngot, name: '钢锭', en: 'Steel Ingot', ores: ['ingotSteel'] },
  { ...P.steelPlate, name: '钢板', en: 'Steel Plate', ores: ['plateSteel'] },
  { ...P.steelDust, name: '钢粉', en: 'Steel Dust', ores: ['dustSteel'] },
  { ...P.steelGear, name: '钢齿轮', en: 'Steel Gear', ores: ['gearGtSteel'] },
  { ...P.steelScrew, name: '钢螺丝', en: 'Steel Screw', ores: ['screwSteel'] },
  { ...P.darkIngot, name: '玄钢锭', en: 'Dark Steel', ores: ['ingotDarkSteel'] },
  { ...P.darkIngotGt, name: '玄钢锭', en: 'Dark Steel Ingot', ores: ['ingotDarkSteel'] },
  { ...P.darkPlate, name: '玄钢板', en: 'Dark Steel Plate', ores: ['plateDarkSteel'] },
  { ...P.darkDust, name: '玄钢粉', en: 'Dark Steel Dust', ores: ['dustDarkSteel'] },
  { ...P.magneticDust, name: '磁钢粉', en: 'Magnetic Steel Dust', ores: ['dustSteelMagnetic'] },
  { ...P.coalDust, name: '煤粉', en: 'Coal Dust', ores: ['dustCoal'] },
  { ...P.obsidianDust, name: '黑曜石粉', en: 'Obsidian Dust', ores: ['dustObsidian'] },
  { ...P.rodShape, name: '模头（杆）', en: 'Extruder Shape (Rod)' },
  { ...P.shaftShape, name: '模头（转轴）', en: 'Extruder Shape (Shaft)' },
  { ...P.shaft, name: '精炼铁柄', en: 'Shaft (Refined Iron)' },
  { ...P.blades, name: '直升机桨叶', en: 'Copter Blades' },
  { ...P.hammer, name: '锤', en: 'Hammer', ores: ['craftingToolHardHammer'], variants: 12 },
  { ...P.screwdriver, name: '螺丝刀', en: 'Screwdriver', ores: ['craftingToolScrewdriver'] },
  { ...P.stick, name: '木棍', en: 'Stick', ores: ['stickWood'] },
  { ...P.steelRod, name: '钢杆', en: 'Steel Rod', ores: ['stickSteel'] },
  { ...P.plateShape, name: '模头（板）', en: 'Extruder Shape (Plate)' },
  { ...P.sheet, name: '钢片', en: 'Steel Sheet' },
  { ...P.pin, name: '钢销', en: 'Steel Pin' },
  { ...P.wire, name: '细钢丝', en: 'Fine Steel Wire' },
  { ...P.wireCutter, name: '剪线钳', en: 'Wire Cutter', ores: ['craftingToolWireCutter'] },
  { ...P.multitool, name: '万能工具（剪线钳）', en: 'Pocket Multitool (Wire Cutter)', ores: ['craftingToolWireCutter'] },
  { ...P.snips, name: '自动剪线钳', en: 'Automatic Snips', ores: ['craftingToolWireCutter'] },
  { ...P.motor, name: '电动马达（LV）', en: 'Electric Motor (LV)' },
  { ...P.battery, name: '小型锂电池', en: 'Small Lithium Battery', ores: ['batteryLV'] },
  { ...P.titanPlate, name: '钛板', en: 'Titanium Plate', ores: ['plateTitanium'] },
  { id: 'gregtech:gt.integrated_circuit', meta: 1, name: '编程电路 1', en: 'Programmed Circuit' },
  { id: MACHINE, meta: 221, name: '基础卷板机', en: 'Basic Bending Machine' },
  { id: MACHINE, meta: 282, name: '进阶压模机', en: 'Advanced Extruder' },
  { id: MACHINE, meta: 581, name: '基础搅拌机', en: 'Basic Mixer' },
  { id: MACHINE, meta: 1000, name: '工业高炉', en: 'Electric Blast Furnace' },
  { id: MACHINE, meta: 301, name: '基础研磨机', en: 'Basic Macerator' },
  { id: MACHINE, meta: 521, name: '基础流体固化器', en: 'Basic Fluid Solidifier' },
  { id: 'minecraft:chest', meta: 0, name: '箱子', en: 'Chest' },
  { id: 'minecraft:hopper', meta: 0, name: '漏斗', en: 'Hopper' },
  { id: 'avaritiaddons:CompressedChest', meta: 0, name: '压缩箱子', en: 'Compressed Chest' },
  ...DEMO.map((zh, n) => ({ ...P.demoIngot(n), name: `${zh}锭`, en: `Ingot ${n}`, ores: [`ingotDemo${n}`] })),
  ...Array.from({ length: LINKS }, (_, n) => ({ ...P.link(n), name: `链节${n}`, en: `Link ${n}` })),
]

const SHAPED = 'codechicken.nei.recipe.ShapedRecipeHandler'
const SHAPELESS = 'codechicken.nei.recipe.ShapelessRecipeHandler'
export const HANDLERS = [
  { key: 'gt.recipe.metalbender', name: '卷板机', mod: 'GregTech', machines: [{ id: MACHINE, meta: 221 }], read: 'gregtech' },
  { key: 'gt.recipe.extruder', name: '压模机', mod: 'GregTech', machines: [{ id: MACHINE, meta: 282 }], read: 'gregtech' },
  { key: 'gt.recipe.mixer', name: '搅拌机', mod: 'GregTech', machines: [{ id: MACHINE, meta: 581 }], read: 'gregtech' },
  { key: 'gt.recipe.blastfurnace', name: '工业高炉', mod: 'GregTech', machines: [{ id: MACHINE, meta: 1000 }], read: 'gregtech' },
  { key: 'gt.recipe.macerator', name: '研磨机', mod: 'GregTech', machines: [{ id: MACHINE, meta: 301 }], read: 'gregtech' },
  { key: 'gt.recipe.fluidsolidifier', name: '流体固化器', mod: 'GregTech', machines: [{ id: MACHINE, meta: 521 }], read: 'gregtech' },
  { key: 'gt.recipe.category.arc_furnace_recycling', name: '电弧炉回收', mod: 'GregTech', machines: [{ id: MACHINE, meta: 301 }], read: 'gregtech' },
  { key: SHAPED, name: '有序合成', mod: 'Minecraft', grid: true, machines: [{ id: 'minecraft:crafting_table', meta: 0 }], read: 'all' },
  { key: SHAPELESS, name: '无序合成', mod: 'Minecraft', grid: true, machines: [], read: 'all' },
  { key: 'codechicken.nei.recipe.FurnaceRecipeHandler', name: '烧制', mod: 'Minecraft', machines: [{ id: 'minecraft:furnace', meta: 0 }], read: 'all' },
]

const item = (p: { id: string; meta: number }, n: number, g?: number) => ({ ...p, n, ...(g !== undefined ? { g } : {}) })
const circuit = (number: number) => ({ id: 'gregtech:gt.integrated_circuit', meta: number, n: 0 })
const ore = (name: string, any: { id: string; meta: number }[], g?: number) => ({ ore: name, n: 1, any: any.map((a) => [a.id, a.meta]), more: 0, ...(g !== undefined ? { g } : {}) })
const HAMMER = ore('craftingToolHardHammer', [P.hammer], 0)

/** 下标就是配方的编号。 */
export const R = {
  bendSteel: 0,
  hammerSteel: 1,
  smeltSteel: 2,
  grindIngot: 3,
  grindPlate: 4,
  recycleGear: 5,
  mixDark: 6,
  handMixDark: 7,
  smeltDark: 8,
  smeltDarkOxygen: 9,
  bendDark: 10,
  shaftShape: 11,
  shaft: 12,
  blades: 13,
  /** 14…25：十二种材质的锤子。 */
  hammer: (n: number) => 14 + n,
  /** 26…37：链节 n 用链节 n+1 加一根木棍做。 */
  link: (n: number) => 26 + n,
  furnaceSteel: 38,
  rodExtrude: 39,
  rodHand: 40,
  cutter: 41,
  multitool: 42,
  snips: 43,
  wire: 44,
  sheetExtrude: 45,
  pinExtrude: 46,
  pinHand: 47,
  pinCast: 48,
  shaftShapeTitan: 49,
  castTitanPlate: 50,
}

export const RECIPES: Record<string, unknown>[] = [
  // 0、1：钢板。卷板机 1 锭 1 板；手工锤 2 锭 1 板
  { h: 'gt.recipe.metalbender', in: [item(P.steelIngot, 1), circuit(1)], out: [item(P.steelPlate, 1)], eut: 24, ticks: 56 },
  { h: SHAPED, in: [HAMMER, ore('ingotSteel', [P.steelIngot], 3), ore('ingotSteel', [P.steelIngot], 6)], out: [item(P.steelPlate, 1)] },
  // 2–5：钢粉炼成钢锭，钢锭、钢板又磨得回钢粉（绕圈子）；钢齿轮回收成钢锭（不算做法）
  { h: 'gt.recipe.blastfurnace', in: [item(P.steelDust, 1), circuit(1)], out: [item(P.steelIngot, 1)], eut: 120, ticks: 500, special: 1000 },
  { h: 'gt.recipe.macerator', in: [item(P.steelIngot, 1)], out: [item(P.steelDust, 1)], eut: 2, ticks: 100 },
  { h: 'gt.recipe.macerator', in: [item(P.steelPlate, 1)], out: [item(P.steelDust, 1)], eut: 2, ticks: 100 },
  { h: 'gt.recipe.category.arc_furnace_recycling', in: [item(P.steelGear, 1)], out: [item(P.steelIngot, 4)], eut: 30, ticks: 100 },
  // 6、7：玄钢粉。搅拌机三样粉各 1 出 3 个；手工搅出 2 个
  { h: 'gt.recipe.mixer', in: [item(P.magneticDust, 1), item(P.coalDust, 1), item(P.obsidianDust, 1), circuit(2)], out: [item(P.darkDust, 3)], eut: 7, ticks: 100 },
  { h: SHAPELESS, in: [item(P.magneticDust, 1, 0), ore('dustCoal', [P.coalDust], 1), ore('dustObsidian', [P.obsidianDust], 3)], out: [item(P.darkDust, 2)] },
  // 8、9：玄钢锭（出的是 EnderIO 的那个 id）。电路 1 要 2200 K；电路 11 加氧只要 1800 K
  { h: 'gt.recipe.blastfurnace', in: [item(P.darkDust, 1), circuit(1)], out: [item(P.darkIngot, 1)], eut: 120, ticks: 2000, special: 2200 },
  { h: 'gt.recipe.blastfurnace', in: [item(P.darkDust, 1), circuit(11)], out: [item(P.darkIngot, 1)], fin: [{ f: 'oxygen', name: '氧', mb: 1000 }], eut: 120, ticks: 1000, special: 1800 },
  // 10：玄钢板，卷板机点名的是 EnderIO 的玄钢锭
  { h: 'gt.recipe.metalbender', in: [item(P.darkIngot, 1), circuit(1)], out: [item(P.darkPlate, 1)], eut: 24, ticks: 28 },
  // 11：模头（转轴）= 4 玄钢板 + 模头（杆）+ 锤（不消耗）
  { h: SHAPED, in: [HAMMER, item(P.darkPlate, 1, 1), item(P.darkPlate, 1, 3), item(P.rodShape, 1, 4), item(P.darkPlate, 1, 5), item(P.darkPlate, 1, 7)], out: [item(P.shaftShape, 1)] },
  // 12：精炼铁柄 = 压模机，9 钢锭，模头（转轴）不消耗，64 秒一根
  { h: 'gt.recipe.extruder', in: [item(P.steelIngot, 9), item(P.shaftShape, 0)], out: [item(P.shaft, 1)], eut: 120, ticks: 1280 },
  // 13：直升机桨叶 = 4 柄 + 3 钢螺丝 + 钢齿轮 + 螺丝刀（不消耗）
  {
    h: SHAPED,
    in: [item(P.shaft, 1, 0), item(P.steelScrew, 1, 1), item(P.shaft, 1, 2), item(P.steelScrew, 1, 3), item(P.steelGear, 1, 4), item(P.steelScrew, 1, 5), item(P.shaft, 1, 6), ore('craftingToolScrewdriver', [P.screwdriver], 7), item(P.shaft, 1, 8)],
    out: [item(P.blades, 1)],
  },
  // 14–25：每种材质一把锤子
  ...Array.from({ length: 12 }, (_, n) => ({ h: SHAPED, in: [...[0, 1, 2, 3, 4, 5].map((g) => item(P.demoIngot(n), 1, g)), ore('stickWood', [P.stick], 7)], out: [item(P.hammer, 1)] })),
  // 26–37：一条长链
  ...Array.from({ length: LINKS - 1 }, (_, n) => ({ h: SHAPED, in: [item(P.link(n + 1), 1, 0), ore('stickWood', [P.stick], 3)], out: [item(P.link(n), 1)] })),
  // 38：熔炉也能把钢粉烧成锭（它操作不了的那类）
  { h: 'codechicken.nei.recipe.FurnaceRecipeHandler', in: [item(P.steelDust, 1)], out: [item(P.steelIngot, 1)] },
  // 39、40：钢杆。压模机 1 锭 2 根，模头（杆）不消耗；手工锤 1 锭 1 根
  { h: 'gt.recipe.extruder', in: [item(P.steelIngot, 1), item(P.rodShape, 0)], out: [item(P.steelRod, 2)], eut: 64, ticks: 100 },
  { h: SHAPED, in: [HAMMER, ore('ingotSteel', [P.steelIngot], 3)], out: [item(P.steelRod, 1)] },
  // 41–43：剪线钳（矿辞名 craftingToolWireCutter 下有三种）。普通的 = 3 钢板 + 2 钢杆 + 1 钢螺丝 + 锤；
  // 万能工具是拿一把普通剪线钳加一个钢螺丝“升级”的；自动剪线钳是电动的（马达 + 电池 + 钢锭）
  { h: SHAPED, in: [HAMMER, item(P.steelPlate, 1, 1), item(P.steelPlate, 1, 3), item(P.steelPlate, 1, 4), item(P.steelScrew, 1, 5), item(P.steelRod, 1, 6), item(P.steelRod, 1, 7)], out: [item(P.wireCutter, 1)] },
  { h: SHAPELESS, in: [item(P.wireCutter, 1, 0), item(P.steelScrew, 1, 1)], out: [item(P.multitool, 1)] },
  { h: SHAPELESS, in: [item(P.motor, 1, 0), item(P.battery, 1, 1), item(P.steelIngot, 1, 3)], out: [item(P.snips, 1)] },
  // 44：细钢丝 = 1 钢板，用剪线钳剪（不消耗）
  { h: SHAPELESS, in: [ore('craftingToolWireCutter', [P.wireCutter, P.multitool, P.snips], 0), item(P.steelPlate, 1, 1)], out: [item(P.wire, 1)] },
  // 45：钢片 = 压模机，1 钢锭，模头（板）不消耗
  { h: 'gt.recipe.extruder', in: [item(P.steelIngot, 1), item(P.plateShape, 0)], out: [item(P.sheet, 1)], eut: 64, ticks: 100 },
  // 46–48：钢销。压模机 1 锭 4 个（模头（转轴）不消耗）；手工锤 1 锭 1 个；流体固化器 36 mB 熔融钢 1 个
  { h: 'gt.recipe.extruder', in: [item(P.steelIngot, 1), item(P.shaftShape, 0)], out: [item(P.pin, 4)], eut: 64, ticks: 100 },
  { h: SHAPED, in: [HAMMER, ore('ingotSteel', [P.steelIngot], 4)], out: [item(P.pin, 1)] },
  { h: 'gt.recipe.fluidsolidifier', in: [], out: [item(P.pin, 1)], fin: [{ f: 'molten.steel', name: '熔融钢', mb: 36 }], eut: 8, ticks: 40 },
  // 49、50：模头（转轴）也可以用 4 钛板做；钛板只有流体固化器浇得出来（144 mB 熔融钛）——基地里没有钛
  { h: SHAPED, in: [HAMMER, item(P.titanPlate, 1, 1), item(P.titanPlate, 1, 3), item(P.rodShape, 1, 4), item(P.titanPlate, 1, 5), item(P.titanPlate, 1, 7)], out: [item(P.shaftShape, 1)] },
  { h: 'gt.recipe.fluidsolidifier', in: [], out: [item(P.titanPlate, 1)], fin: [{ f: 'molten.titanium', name: '熔融钛', mb: 144 }], eut: 30, ticks: 40 },
]

export function writePlanFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'items.jsonl'), `${ITEMS.map((i) => JSON.stringify(i)).join('\n')}\n`)
  fs.writeFileSync(path.join(dir, 'handlers.json'), JSON.stringify(HANDLERS))
  fs.writeFileSync(path.join(dir, 'recipes.jsonl'), `${RECIPES.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

// ── 假基地 ──

export interface Box {
  x: number
  y: number
  z: number
  id?: string
  name?: string
  kind?: string
  attached?: { x: number; y: number; z: number; name: string; kind: string }[]
  items: { id: string; meta: number; count: number }[]
}

/** 主仓库：一个压缩箱子。 */
export const CHEST = { x: 12, y: 64, z: -4 }
export const chest = (items: Box['items'], extra: Partial<Box> = {}): Box => ({ ...CHEST, id: 'avaritiaddons:CompressedChest', name: 'Compressed Chest', items, ...extra })
export const stack = (p: { id: string; meta: number }, count: number) => ({ ...p, count })

const single = (x: number, name: string, meta: number, recipes: string, recipeKey: string, tier: string, volts: number, inputSlots = 2) => ({ x, y: 64, z: -8, name, id: MACHINE, meta, recipes, recipeKey, tier, inputSlots, active: false, storedEU: 5000, inputVoltage: volts })
export const BENDER = single(16, 'Basic Bending Machine', 221, 'Bending Machine', 'gt.recipe.metalbender', 'LV', 32)
export const EXTRUDER = single(18, 'Advanced Extruder', 282, 'Extruder', 'gt.recipe.extruder', 'MV', 128)
export const MIXER = single(20, 'Basic Mixer', 581, 'Mixer', 'gt.recipe.mixer', 'LV', 32, 6)
export const MACERATOR = single(22, 'Basic Macerator', 301, 'Macerator', 'gt.recipe.macerator', 'LV', 32)
/** 流体固化器：单方块，罐子里有什么它看不到。默认的基地里没有，要的测试自己加。 */
export const SOLIDIFIER = single(24, 'Basic Fluid Solidifier', 521, 'Fluid Solidifier', 'gt.recipe.fluidsolidifier', 'LV', 32)
/** 一台机器的格子里放着的东西（world.containers 里，机器也是一个容器，kind 是 machine）。 */
export const inside = (m: { x: number; y: number; z: number; name: string }, items: Box['items'], extra: Partial<Box> = {}): Box => ({ x: m.x, y: m.y, z: m.z, id: MACHINE, name: m.name, kind: 'machine', items, ...extra })
/** 工业高炉：炉温、输入总线接没接漏斗、输入仓里有多少氧，都可以调。 */
export function furnace(opts: { heat?: number; fed?: boolean; oxygen?: number; more?: Record<string, unknown> } = {}) {
  return {
    x: -5, y: 64, z: 9, name: 'Electric Blast Furnace', id: MACHINE, meta: 1000, kind: 'multiblock', formed: true, recipes: 'Blast Furnace', recipeKey: 'gt.recipe.blastfurnace',
    inputVoltage: 512, tier: 'HV', heat: opts.heat ?? 2300, active: false, idleReason: 'No valid recipe found',
    inputBuses: [{ x: -4, y: 64, z: 9, name: 'Input Bus (LV)', kind: 'input bus', slots: 4, usedSlots: 0, ...(opts.fed ? { attached: [{ x: -4, y: 64, z: 10, name: 'Hopper', kind: 'hopper' }] } : {}) }],
    outputBuses: [{ x: -6, y: 64, z: 9, name: 'Output Bus (LV)', kind: 'output bus', slots: 4, usedSlots: 0 }],
    inputHatches: [{ x: -6, y: 64, z: 8, name: 'Input Hatch (LV)', kind: 'input hatch', capacity: 16000, ...(opts.oxygen ? { fluid: 'oxygen', fluidName: 'Oxygen', amount: opts.oxygen } : {}) }],
    ...(opts.more ?? {}),
  }
}
export const ALL_MACHINES = [BENDER, EXTRUDER, MIXER, MACERATOR, furnace()]

/** 假基地里它站的地方（和 agent-harness 的 FakeGame 报的位置一样）。 */
export const STANDS = { x: 10, y: 64, z: -4 }

/**
 * 让假服务器像身体那样回答“附近有什么”：机器、合成台、容器（翻页）、某几样东西在哪（world.stock，认矿辞名）、身上有什么。
 * 和身体一样，每次查询只看得到给的中心周围 radius 格以内的东西（中心是 {bot} 时就是它站的地方）。
 * 返回的 world 可以随时改（换机器、换箱子里的东西）。
 */
export function installBase(game: FakeGame, init: { boxes?: Box[]; machines?: unknown[]; inventory?: Box['items']; tables?: boolean } = {}) {
  const world = { boxes: init.boxes ?? [], machines: init.machines ?? ALL_MACHINES, inventory: init.inventory ?? [], tables: init.tables !== false }
  const info = new Map(ITEMS.map((i) => [`${i.id}/${i.meta}`, i]))
  const en = (id: string, meta: number): string => info.get(`${id}/${meta}`)?.en ?? id
  const within = (p: Record<string, unknown>, b: { x: number; y: number; z: number }, radius: number): boolean => {
    const c = typeof p.x === 'number' ? (p as unknown as { x: number; y: number; z: number }) : STANDS
    return Math.max(Math.abs(b.x - c.x), Math.abs(b.y - c.y), Math.abs(b.z - c.z)) <= Number(p.radius ?? radius)
  }
  const status = game.handlers['bot.status']!
  game.handlers['bot.status'] = (p) => ({ ...(status(p) as object), inventory: world.inventory.map((i, slot) => ({ slot, name: en(i.id, i.meta), ...i })), freeSlots: 36 - world.inventory.length })
  game.handlers['world.machines'] = (p) => {
    const seen = (world.machines as { x: number; y: number; z: number }[]).filter((m) => within(p, m, 32))
    return { machines: seen.map((m, n) => ({ ...m, dist: 6 + n })), total: seen.length }
  }
  game.handlers['world.find'] = (p) => (world.tables && within(p, { x: 8, y: 64, z: -4 }, 24) ? { matches: [{ x: 8, y: 64, z: -4, id: 'TConstruct:CraftingStation', meta: 0, dist: 3 }], total: 1 } : { matches: [], total: 0 })
  game.handlers['world.containers'] = (p) => {
    const all = world.boxes.filter((b) => within(p, b, 16)).map((b) => ({ x: b.x, y: b.y, z: b.z, id: b.id ?? 'minecraft:chest', name: b.name ?? 'Chest', ...(b.kind ? { kind: b.kind } : {}), ...(b.attached ? { attached: b.attached } : {}), slots: 27, usedSlots: b.items.length, items: b.items.map((i) => ({ ...i, name: en(i.id, i.meta) })) }))
    const offset = Number(p.offset ?? 0)
    return { containers: all.slice(offset, offset + Number(p.limit ?? 40)), total: all.length, offset }
  }
  game.handlers['world.stock'] = (p) => ({
    containersLookedInto: world.boxes.length,
    items: (p.items as { id?: string; meta?: number; ore?: string }[]).map((q) => {
      const fits = (i: { id: string; meta: number }): boolean => (q.ore !== undefined ? ((info.get(`${i.id}/${i.meta}`) as { ores?: string[] } | undefined)?.ores ?? []).includes(q.ore) : i.id === q.id && (q.meta === undefined || i.meta === q.meta))
      const places = world.boxes
        .filter((b) => within(p, b, 32))
        .map((b) => ({ b, found: b.items.filter(fits) }))
        .filter((x) => x.found.length > 0)
        .map(({ b, found }) => ({ x: b.x, y: b.y, z: b.z, container: b.name ?? 'Chest', count: found.reduce((n, i) => n + i.count, 0), ...(q.ore !== undefined || q.meta === undefined ? { items: found.map((i) => ({ ...i, name: en(i.id, i.meta) })) } : {}) }))
        .sort((a, b) => b.count - a.count)
      return { ...q, total: places.reduce((n, pl) => n + pl.count, 0), places: places.slice(0, 6) }
    }),
  })
  return world
}

// ── 同一个基地，放到模拟身体（MockBridge）上：端到端测试用 ──

const TIER_VOLTS: [string, number][] = [['ULV', 8], ['LV', 32], ['MV', 128], ['HV', 512], ['EV', 2048]]

/**
 * 把模拟身体布置成上面那个基地：一个装着 items 的压缩箱子、四台单方块机器和一座工业高炉，
 * 身体自己的配方书换成和这本小配方册同一套（它拿来判断“摆成这样出什么”“这些原料机器开不开工”）。
 */
export function installMockBase(bridge: MockBridge, items: Box['items'], furnaceOpts: Parameters<typeof furnace>[0] = {}, extruderHolds: Box['items'] = []): void {
  const info = new Map(ITEMS.map((i) => [`${i.id}/${i.meta}`, i as { id: string; meta: number; name: string; en: string; ores?: string[] }]))
  const en = (id: string, meta: number): string => info.get(`${id}/${meta}`)?.en ?? id
  bridge.containers = [{ ...CHEST, id: 'avaritiaddons:CompressedChest', name: 'Compressed Chest', slots: 243, items: items.map((i) => ({ ...i, name: en(i.id, i.meta) })) }]
  const { x, y, z, name, id, meta, recipes, recipeKey, tier, inputVoltage, ...multiblock } = furnace(furnaceOpts)
  bridge.machines = [
    // 压模机的原料格里可以放着主人留下的模头
    ...[BENDER, EXTRUDER, MIXER, MACERATOR].map((m): MockMachine => ({ ...m, ...(m === EXTRUDER && extruderHolds.length > 0 ? { inputs: extruderHolds.map((i) => ({ ...i, name: en(i.id, i.meta) })) } : {}) })),
    { x, y, z, name, id, meta, recipes, recipeKey, tier, inputVoltage, inputSlots: 4, storedEU: 100_000, more: multiblock },
  ]
  // 配方书：每个物品一项（带矿辞名），做它的手工配方和机器配方照 RECIPES 转过来
  const book = new Map<string, MockRecipeItem>(ITEMS.map((i) => [`${i.id}/${i.meta}`, { id: i.id, meta: i.meta, name: i.en, ...('ores' in i && i.ores ? { ores: i.ores } : {}) }]))
  const machineName = new Map(bridge.machines.map((m) => [m.recipeKey, m.recipes]))
  for (const r of RECIPES as { h: string; in: { id?: string; meta?: number; ore?: string; n: number }[]; out: { id: string; meta: number; n: number }[]; fin?: { name: string; mb: number }[]; eut?: number; ticks?: number }[]) {
    const product = book.get(`${r.out[0]!.id}/${r.out[0]!.meta}`)
    if (!product) continue
    if (r.h === SHAPED || r.h === SHAPELESS) {
      const merged = new Map<string, MockCrafting['ingredients'][number]>()
      for (const slot of r.in) {
        const key = slot.ore ?? `${slot.id}/${slot.meta}`
        const seen = merged.get(key)
        if (seen) seen.count += slot.n
        else merged.set(key, slot.ore !== undefined ? { count: slot.n, ore: slot.ore, ...(slot.ore.startsWith('craftingTool') ? { tool: true } : {}) } : { count: slot.n, id: slot.id!, meta: slot.meta! })
      }
      ;(product.crafting ??= []).push({ gives: r.out[0]!.n, grid: r.in.length <= 4 && r.h === SHAPELESS ? '2x2' : '3x3', ingredients: [...merged.values()] })
    } else if (machineName.has(r.h)) {
      ;(product.machines ??= []).push({
        machine: machineName.get(r.h)!,
        tier: TIER_VOLTS.find(([, volts]) => (r.eut ?? 0) <= volts)![0],
        eut: r.eut ?? 0,
        seconds: (r.ticks ?? 0) / 20,
        inputs: r.in.map((slot) => ({ id: slot.id!, meta: slot.meta!, name: en(slot.id!, slot.meta!), count: slot.n, ...(slot.n === 0 ? { notConsumed: true } : {}) })),
        ...(r.fin ? { fluidInputs: r.fin } : {}),
        outputs: r.out.map((o) => ({ id: o.id, meta: o.meta, name: en(o.id, o.meta), count: o.n })),
      })
    }
  }
  bridge.recipeBook = [...book.values()]
}
