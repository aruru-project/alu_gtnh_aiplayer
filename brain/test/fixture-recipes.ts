// 一本自造的小配方册（格式同 docs/PACKDATA.md）：够得着真实数据里那些要紧的情形——
// 同一个物品好几种做法耗料不同、手工工具配方、编程电路和模具、一模一样的重复、只是示意的 fake、
// 高炉的炉温、同一种东西两个 id（玄钢锭）、每种材质一条的工具配方、摆得进 2×2 的无序合成、
// 不用工具的手工配方和机器配方并存（手工搅粉 2 个、搅拌机 3 个）。
// 配方的编号就是它在 RECIPE_LINES 里的下标。

import fs from 'node:fs'
import path from 'node:path'

export const ITEMS = [
  { id: 'gregtech:gt.metaitem.01', meta: 11305, name: '钢锭', en: 'Steel Ingot', ores: ['ingotSteel'] },
  { id: 'IC2:itemIngot', meta: 3, name: '精炼铁锭', en: 'Refined Iron Ingot', ores: ['ingotSteel'] },
  { id: 'gregtech:gt.metaitem.01', meta: 17305, name: '钢板', en: 'Steel Plate', ores: ['plateSteel'] },
  { id: 'gregtech:gt.metaitem.01', meta: 17364, name: '玄钢板', en: 'Dark Steel Plate', ores: ['plateDarkSteel'] },
  { id: 'gregtech:gt.metaitem.01', meta: 2305, name: '钢粉', en: 'Steel Dust', ores: ['dustSteel'] },
  { id: 'gregtech:gt.metaitem.01', meta: 1305, name: '小撮钢粉', en: 'Tiny Pile of Steel Dust', ores: ['dustTinySteel'] },
  { id: 'gregtech:gt.metaitem.01', meta: 2364, name: '玄钢粉', en: 'Dark Steel Dust', ores: ['dustDarkSteel'] },
  { id: 'gregtech:gt.metaitem.01', meta: 11364, name: '玄钢锭', en: 'Dark Steel Ingot', ores: ['ingotDarkSteel'] },
  { id: 'EnderIO:itemAlloy', meta: 6, name: '玄钢锭', en: 'Dark Steel', ores: ['ingotDarkSteel'] },
  { id: 'gregtech:gt.metatool.01', meta: 12, name: '锤', en: 'Hammer', ores: ['craftingToolHardHammer'], variants: 3 },
  { id: 'gregtech:gt.metatool.01', meta: 22, name: '螺丝刀', en: 'Screwdriver', ores: ['craftingToolScrewdriver'] },
  { id: 'gregtech:gt.integrated_circuit', meta: 1, name: '编程电路 1', en: 'Programmed Circuit' },
  { id: 'gregtech:gt.integrated_circuit', meta: 11, name: '编程电路 11', en: 'Programmed Circuit' },
  { id: 'gregtech:gt.metaitem.01', meta: 32301, name: '模具（板）', en: 'Mold (Plate)' },
  { id: 'gregtech:gt.blockmetal6', meta: 13, name: '钢块', en: 'Block of Steel', ores: ['blockSteel'] },
  { id: 'IC2:itemRecipePart', meta: 12, name: '精炼铁柄', en: 'Shaft (Refined Iron)' },
  { id: 'gregtech:gt.metaitem.01', meta: 27305, name: '钢螺丝', en: 'Steel Screw', ores: ['screwSteel'] },
  { id: 'gregtech:gt.metaitem.02', meta: 31305, name: '钢齿轮', en: 'Steel Gear', ores: ['gearGtSteel'] },
  { id: 'adventurebackpack:backpackComponent', meta: 6, name: '直升机桨叶', en: 'Copter Blades' },
  { id: 'minecraft:stick', meta: 0, name: '木棍', en: 'Stick', ores: ['stickWood'] },
  { id: 'demo:plateOnAStick', meta: 0, name: '钢板标牌', en: 'Plate on a Stick' },
  { id: 'Backpack:backpack', meta: 0, name: '小背包', en: 'Backpack' },
  { id: 'Backpack:tannedLeather', meta: 0, name: '鞣制皮革', en: 'Tanned Leather' },
  { id: 'harvestcraft:wovencottonItem', meta: 0, name: '织棉', en: 'Woven Cotton' },
  { id: 'gregtech:gt.metaitem.01', meta: 28305, name: '钢环', en: 'Steel Ring', ores: ['ringSteel'] },
  { id: 'gregtech:gt.blockcasings2', meta: 0, name: '钢机器外壳', en: 'Solid Steel Machine Casing' },
  { id: 'minecraft:iron_ingot', meta: 0, name: '铁锭', en: 'Iron Ingot', ores: ['ingotIron'] },
  { id: 'gregtech:gt.metaitem.01', meta: 2032, name: '铁粉', en: 'Iron Dust', ores: ['dustIron'] },
  { id: 'gregtech:gt.blockmachines', meta: 221, name: '基础卷板机', en: 'Basic Bending Machine' },
  { id: 'gregtech:gt.blockmachines', meta: 1000, name: '工业高炉', en: 'Electric Blast Furnace' },
  { id: 'gregtech:gt.blockmachines', meta: 611, name: '基础锻造锤', en: 'Basic Forge Hammer' },
  { id: 'minecraft:chest', meta: 0, name: '箱子', en: 'Chest' },
  { id: 'IronChest:BlockIronChest', meta: 3, name: '压缩箱子', en: 'Compressed Chest' },
  { id: 'gregtech:gt.metaitem.01', meta: 2365, name: '磁钢粉', en: 'Magnetic Steel Dust', ores: ['dustSteelMagnetic'] },
  { id: 'gregtech:gt.metaitem.01', meta: 2535, name: '煤粉', en: 'Coal Dust', ores: ['dustCoal'] },
  { id: 'gregtech:gt.metaitem.01', meta: 2804, name: '黑曜石粉', en: 'Obsidian Dust', ores: ['dustObsidian'] },
  { id: 'gregtech:gt.blockmachines', meta: 581, name: '基础搅拌机', en: 'Basic Mixer' },
  // 每种材质一把锤子用的锭
  ...Array.from({ length: 12 }, (_, n) => ({ id: 'demo:ingot', meta: n, name: `${['铜', '锡', '青铜', '钢质', '金', '银', '铅', '镍', '锌', '钴', '钛', '钨钢'][n]}锭`, en: `Ingot ${n}` })),
]

export const HANDLERS = [
  { key: 'gt.recipe.metalbender', name: '卷板机', mod: 'GregTech', machines: [{ id: 'gregtech:gt.blockmachines', meta: 221 }], recipes: 3, read: 'gregtech' },
  { key: 'gt.recipe.hammer', name: '锻造锤', mod: 'GregTech', machines: [{ id: 'gregtech:gt.blockmachines', meta: 611 }], recipes: 1, read: 'gregtech' },
  { key: 'gt.recipe.alloysmelter', name: '合金炉', mod: 'GregTech', machines: [], recipes: 1, read: 'gregtech' },
  { key: 'gt.recipe.fakecuttingsaw', name: '板材切割机', mod: 'GregTech', machines: [], recipes: 1, read: 'gregtech' },
  { key: 'gt.recipe.blastfurnace', name: '工业高炉', mod: 'GregTech', machines: [{ id: 'gregtech:gt.blockmachines', meta: 1000 }], recipes: 2, read: 'gregtech' },
  { key: 'gt.recipe.assembler', name: '组装机', mod: 'GregTech', machines: [], recipes: 1, read: 'gregtech' },
  { key: 'gt.recipe.macerator', name: '研磨机', mod: 'GregTech', machines: [], recipes: 1, read: 'gregtech' },
  { key: 'codechicken.nei.recipe.ShapedRecipeHandler', name: '有序合成', mod: 'Minecraft', grid: true, machines: [{ id: 'minecraft:crafting_table', meta: 0 }], recipes: 15, read: 'all' },
  { key: 'codechicken.nei.recipe.ShapelessRecipeHandler', name: '无序合成', mod: 'Minecraft', grid: true, machines: [], recipes: 1, read: 'all' },
  { key: 'codechicken.nei.recipe.FurnaceRecipeHandler', name: '烧制', mod: 'Minecraft', machines: [{ id: 'minecraft:furnace', meta: 0 }], recipes: 1, read: 'all' },
  { key: 'gt.recipe.mixer', name: '搅拌机', mod: 'GregTech', machines: [{ id: 'gregtech:gt.blockmachines', meta: 581 }], recipes: 1, read: 'gregtech' },
]

const gt = (meta: number, n: number) => ({ id: 'gregtech:gt.metaitem.01', meta, n })
const circuit = (number: number) => ({ id: 'gregtech:gt.integrated_circuit', meta: number, n: 0 })
const ore = (name: string, g: number, any: [string, number][]) => ({ ore: name, n: 1, g, any, more: 0 })
const SHAPED = 'codechicken.nei.recipe.ShapedRecipeHandler'
const INGOT_STEEL: [string, number][] = [['IC2:itemIngot', 3], ['gregtech:gt.metaitem.01', 11305]]
const HAMMER: [string, number][] = [['gregtech:gt.metatool.01', 12]]

/** 一行一条；下标就是配方的编号。 */
export const RECIPE_LINES: (Record<string, unknown> | string)[] = [
  // 0、1：卷板机，一模一样的两条
  { h: 'gt.recipe.metalbender', in: [gt(11305, 1), circuit(1)], out: [gt(17305, 1)], eut: 24, ticks: 56 },
  { h: 'gt.recipe.metalbender', in: [gt(11305, 1), circuit(1)], out: [gt(17305, 1)], eut: 24, ticks: 56 },
  // 2：锻造锤，3 锭出 2 板
  { h: 'gt.recipe.hammer', in: [gt(11305, 3)], out: [gt(17305, 2)], eut: 16, ticks: 56 },
  // 3：手工，锤子加两个锭（竖着摆一列）
  { h: SHAPED, in: [ore('craftingToolHardHammer', 0, HAMMER), ore('ingotSteel', 3, INGOT_STEEL), ore('ingotSteel', 6, INGOT_STEEL)], out: [gt(17305, 1)] },
  // 4：合金炉，模具不消耗
  { h: 'gt.recipe.alloysmelter', in: [gt(11305, 2), { id: 'gregtech:gt.metaitem.01', meta: 32301, n: 0 }], out: [gt(17305, 1)], eut: 30, ticks: 112 },
  // 5：只是示意的，不该出现在任何地方
  { h: 'gt.recipe.fakecuttingsaw', in: [{ id: 'gregtech:gt.blockmetal6', meta: 13, n: 1 }], out: [gt(17305, 9)], fin: [{ f: 'water', name: '水', mb: 52 }], eut: 30, ticks: 1120, fake: true },
  // 6、7：高炉出的玄钢锭是 EnderIO 的那个 id；一条要氧气、炉温 1800，一条炉温 2200
  { h: 'gt.recipe.blastfurnace', in: [gt(2364, 1), circuit(11)], out: [{ id: 'EnderIO:itemAlloy', meta: 6, n: 1 }], fin: [{ f: 'oxygen', name: '氧气', mb: 1000 }], eut: 120, ticks: 1000, special: 1800 },
  { h: 'gt.recipe.blastfurnace', in: [gt(2364, 1), circuit(1)], out: [{ id: 'EnderIO:itemAlloy', meta: 6, n: 1 }], eut: 120, ticks: 2000, special: 2200 },
  // 8：卷板机配方点名的是 EnderIO 的玄钢锭
  { h: 'gt.recipe.metalbender', in: [{ id: 'EnderIO:itemAlloy', meta: 6, n: 1 }, circuit(1)], out: [gt(17364, 1)], eut: 24, ticks: 28 },
  // 9：直升机桨叶，3×3 摆满
  {
    h: SHAPED,
    in: [
      { id: 'IC2:itemRecipePart', meta: 12, n: 1, g: 0 }, { id: 'gregtech:gt.metaitem.01', meta: 27305, n: 1, g: 3 }, { id: 'IC2:itemRecipePart', meta: 12, n: 1, g: 6 },
      { id: 'gregtech:gt.metaitem.01', meta: 27305, n: 1, g: 1 }, { id: 'gregtech:gt.metaitem.02', meta: 31305, n: 1, g: 4 }, ore('craftingToolScrewdriver', 7, [['gregtech:gt.metatool.01', 22]]),
      { id: 'IC2:itemRecipePart', meta: 12, n: 1, g: 2 }, { id: 'gregtech:gt.metaitem.01', meta: 27305, n: 1, g: 5 }, { id: 'IC2:itemRecipePart', meta: 12, n: 1, g: 8 },
    ],
    out: [{ id: 'adventurebackpack:backpackComponent', meta: 6, n: 1 }],
  },
  // 10：无序合成，两样东西，一次出 2 个
  { h: 'codechicken.nei.recipe.ShapelessRecipeHandler', in: [gt(17305, 1), { ore: 'stickWood', n: 1, any: [['minecraft:stick', 0]], more: 0 }], out: [{ id: 'demo:plateOnAStick', meta: 0, n: 2 }] },
  // 11：小背包
  {
    h: SHAPED,
    in: [
      ...[0, 2, 3, 5, 6].map((g) => ({ id: 'Backpack:tannedLeather', meta: 0, n: 1, g })),
      ...[1, 7, 8].map((g) => ({ id: 'harvestcraft:wovencottonItem', meta: 0, n: 1, g })),
      { id: 'gregtech:gt.metaitem.01', meta: 28305, n: 1, g: 4 },
    ],
    out: [{ id: 'Backpack:backpack', meta: 0, n: 1 }],
  },
  // 12–23：每种材质一把锤子
  ...Array.from({ length: 12 }, (_, n) => ({
    h: SHAPED,
    in: [...[0, 1, 2, 3, 4, 5].map((g) => ({ id: 'demo:ingot', meta: n, n: 1, g })), { ore: 'stickWood', n: 1, g: 7, any: [['minecraft:stick', 0]] as [string, number][], more: 0 }],
    out: [{ id: 'gregtech:gt.metatool.01', meta: 12, n: 1 }],
  })),
  // 24：熔炉（它操作不了的那类）
  { h: 'codechicken.nei.recipe.FurnaceRecipeHandler', in: [gt(2032, 1)], out: [{ id: 'minecraft:iron_ingot', meta: 0, n: 1 }] },
  // 25：组装机用钢板
  { h: 'gt.recipe.assembler', in: [gt(17305, 8), circuit(1)], out: [{ id: 'gregtech:gt.blockcasings2', meta: 0, n: 1 }], eut: 15, ticks: 50 },
  // 26：坏行
  '{not json',
  // 27：研磨机，副产物有概率
  { h: 'gt.recipe.macerator', in: [gt(17305, 1)], out: [gt(2305, 1), { id: 'gregtech:gt.metaitem.01', meta: 1305, n: 1, chance: 0.1 }], eut: 2, ticks: 100 },
  // 28、29：玄钢粉。手工把三种粉搅在一起出 2 个（不要工具，摆得进 2×2）；搅拌机同样的料出 3 个
  {
    h: 'codechicken.nei.recipe.ShapelessRecipeHandler',
    in: [gt(2365, 1), { ore: 'dustCoal', n: 1, any: [['gregtech:gt.metaitem.01', 2535]], more: 0 }, { ore: 'dustObsidian', n: 1, any: [['gregtech:gt.metaitem.01', 2804]], more: 0 }],
    out: [gt(2364, 2)],
  },
  { h: 'gt.recipe.mixer', in: [gt(2365, 1), gt(2535, 1), gt(2804, 1), circuit(2)], out: [gt(2364, 3)], eut: 7, ticks: 100 },
]

/** 把这本小配方册写进 dir（items.jsonl、handlers.json、recipes.jsonl）。 */
export function writeRecipeFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'items.jsonl'), `${ITEMS.map((i) => JSON.stringify(i)).join('\n')}\n`)
  fs.writeFileSync(path.join(dir, 'handlers.json'), JSON.stringify(HANDLERS))
  fs.writeFileSync(path.join(dir, 'recipes.jsonl'), `${RECIPE_LINES.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')}\n`)
}

/** 附近的机器（world.machines）：一台有电的卷板机、一台没电的锻造锤、一座炉温 1801 K 的高炉。 */
export const MACHINES = [
  { x: 16, y: 64, z: -4, name: 'Basic Bending Machine', id: 'gregtech:gt.blockmachines', meta: 221, recipes: 'Bending Machine', recipeKey: 'gt.recipe.metalbender', tier: 'LV', inputSlots: 2, active: false, storedEU: 5000, inputVoltage: 32, dist: 6 },
  { x: 18, y: 64, z: -4, name: 'Basic Forge Hammer', id: 'gregtech:gt.blockmachines', meta: 611, recipes: 'Forge Hammer', recipeKey: 'gt.recipe.hammer', tier: 'LV', inputSlots: 1, active: false, storedEU: 0, inputVoltage: 32, dist: 8 },
  {
    x: -5, y: 64, z: 9, name: 'Electric Blast Furnace', id: 'gregtech:gt.blockmachines', meta: 1000, kind: 'multiblock', formed: true, recipes: 'Blast Furnace', recipeKey: 'gt.recipe.blastfurnace',
    inputVoltage: 512, tier: 'HV', heat: 1801, active: false, idleReason: 'No valid recipe found',
    inputBuses: [{ x: -4, y: 64, z: 9, name: 'Input Bus (LV)', kind: 'input bus', slots: 4, usedSlots: 4, circuit: 2, attached: [{ x: -4, y: 64, z: 10, name: 'Hopper', kind: 'hopper' }] }],
    outputBuses: [{ x: -6, y: 64, z: 9, name: 'Output Bus (LV)', kind: 'output bus', slots: 4, usedSlots: 0, passesTo: [{ x: -6, y: 64, z: 10, name: 'Chest' }] }],
    inputHatches: [{ x: -6, y: 64, z: 8, name: 'Input Hatch (LV)', kind: 'input hatch', capacity: 16000, fluid: 'oxygen', fluidName: 'Oxygen', amount: 8000 }],
    dist: 20,
  },
]
