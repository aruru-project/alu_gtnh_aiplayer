// 走完整棵配方树并算数的内核（src/tools/material-tree.ts）。
// 它现在只有一个用的人：total_materials（“只用点了名的那几条”，那条路从工具入口测，见 planner / chisel / fluids-covers 三个测试）。
// 这里测的是工具还够不着的那部分：换一个选择函数（取列在最前的、查一张记好的表……）时，树照样走完、数照样对。
// 所以入口只能是内核自己：给它一本配方册和一个选择函数，看它交回来的“要做的、原料、不消耗的、流体”。
// 配方册是 fixture-plan.ts 那本小样本，后面接了几条这里才用得到的（编号从 53 起）。
// 预期的数都是照配方手算的（4 根柄 × 9 锭 = 36 锭；4 个玄钢粉、搅拌机一轮 3 个 = 2 轮……）。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { loadPackData } from '../src/packdata/index.ts'
import type { Recipe, RecipeSlot } from '../src/packdata/index.ts'
import { useLocalNames } from '../src/tools/format.ts'
import { MaterialTree, isRecycling } from '../src/tools/material-tree.ts'
import type { Choose, TreeResult, TreeThing } from '../src/tools/material-tree.ts'
import { namer, slotName } from '../src/tools/recipe-book.ts'
import { HANDLERS, ITEMS, P, R, RECIPES } from './fixture-plan.ts'
import { tmpDir } from './helpers.ts'

const SHAPED = 'codechicken.nei.recipe.ShapedRecipeHandler'
const SHAPELESS = 'codechicken.nei.recipe.ShapelessRecipeHandler'
const X = {
  latch: { id: 'demo:latch', meta: 0 },
  lock: { id: 'demo:lock', meta: 0 },
  paintedLock: { id: 'demo:lock', meta: 1 },
  nugget: { id: 'demo:nugget', meta: 0 },
  crank: { id: 'demo:crank', meta: 0 },
}
const MORE_ITEMS = [
  { ...X.latch, name: '门闩', en: 'Latch' },
  { ...X.lock, name: '锁', en: 'Lock' },
  { ...X.paintedLock, name: '上了漆的锁', en: 'Painted Lock' },
  { ...X.nugget, name: '钢粒', en: 'Steel Nugget' },
  { ...X.crank, name: '曲柄', en: 'Crank' },
]
const item = (p: { id: string; meta: number }, n: number) => ({ ...p, n })
const hammer = { ore: 'craftingToolHardHammer', n: 1, any: [[P.hammer.id, P.hammer.meta]], more: 0 }
/** 接在小配方册后面的几条；编号就是 RECIPES.length + 下标。 */
const M = {
  latch: RECIPES.length,
  lockRepaint: RECIPES.length + 1,
  lock: RECIPES.length + 2,
  nuggetRecycle: RECIPES.length + 3,
  nuggetByChance: RECIPES.length + 4,
  nugget: RECIPES.length + 5,
  crank: RECIPES.length + 6,
  rodShape: RECIPES.length + 7,
  meltIngot: RECIPES.length + 8,
  castIngot: RECIPES.length + 9,
}
const MORE_RECIPES = [
  // 门闩 = 2 个“钢销或钢片”（没有矿辞名，就是列出来的两种里任一种）+ 1 钢螺丝
  { h: SHAPELESS, in: [{ n: 2, any: [[P.pin.id, P.pin.meta], [P.sheet.id, P.sheet.meta]] }, item(P.steelScrew, 1)], out: [item(X.latch, 1)] },
  // 把锁（上没上漆都行）洗回没上漆的锁：拿它自己当原料，不算“做”锁的办法；它排在真做法前面
  { h: SHAPELESS, in: [{ n: 1, any: [[X.lock.id, 0], [X.lock.id, 1]] }], out: [item(X.lock, 1)] },
  // 锁 = 1 钢片 + 1 门闩
  { h: SHAPED, in: [item(P.sheet, 1), item(X.latch, 1)], out: [item(X.lock, 1)] },
  // 钢粒：回收页排在最前（把钢销拆成 2 个）；研磨钢片时有一半的机会掉一个（靠不住，不算做法）；真做法是 1 钢锭 9 个
  { h: 'gt.recipe.category.arc_furnace_recycling', in: [item(P.pin, 1)], out: [item(X.nugget, 2)], eut: 30, ticks: 100 },
  { h: 'gt.recipe.macerator', in: [item(P.sheet, 1)], out: [item(P.steelDust, 1), { ...X.nugget, n: 1, chance: 0.5 }], eut: 2, ticks: 100 },
  { h: SHAPED, in: [item(P.steelIngot, 1)], out: [item(X.nugget, 9)] },
  // 曲柄 = 1 钢杆 + 1 模头（转轴）——模头在这里是用掉的
  { h: SHAPED, in: [item(P.steelRod, 1), item(P.shaftShape, 1)], out: [item(X.crank, 1)] },
  // 模头（杆）= 4 钢板，用锤（不消耗）
  { h: SHAPED, in: [hammer, item(P.steelPlate, 4)], out: [item(P.rodShape, 1)] },
  // 钢锭化成 144 mB 熔融钢；144 mB 熔融钢又浇得回 1 个钢锭
  { h: 'gt.recipe.fluidextractor', in: [item(P.steelIngot, 1)], out: [], fout: [{ f: 'molten.steel', name: '熔融钢', mb: 144 }], eut: 32, ticks: 40 },
  { h: 'gt.recipe.fluidsolidifier', in: [], out: [item(P.steelIngot, 1)], fin: [{ f: 'molten.steel', name: '熔融钢', mb: 144 }], eut: 8, ticks: 40 },
]

function setup(t: { after(fn: () => void): void }) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  const lines = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
  fs.writeFileSync(path.join(tmp.dir, 'items.jsonl'), lines([...ITEMS, ...MORE_ITEMS]))
  fs.writeFileSync(path.join(tmp.dir, 'handlers.json'), JSON.stringify([...HANDLERS, { key: 'gt.recipe.fluidextractor', name: '流体提取机', mod: 'GregTech', machines: [], read: 'gregtech' }]))
  fs.writeFileSync(path.join(tmp.dir, 'recipes.jsonl'), lines([...RECIPES, ...MORE_RECIPES]))
  const packdata = loadPackData(tmp.dir)
  t.after(() => packdata.recipes?.close())
  useLocalNames(packdata.items)
  t.after(() => useLocalNames(undefined))
  const book = packdata.recipes!
  const items = packdata.items
  const nm = namer(items)
  const name = (thing: TreeThing): string => (thing.fluid ? thing.fluid.name : thing.made ? nm.name(thing.made.id, thing.made.meta) : slotName(thing.slot!, nm, false))
  /** 一份结果写成人看得懂的几行：要做的（先做的在前）、原料、不消耗的、流体。 */
  const show = (res: TreeResult) => ({
    made: res.made.map((x) => `#${x.recipe!.ref} ${x.recipe!.handler.name} × ${x.rounds} → ${x.rounds * x.yield!} ${name(x)}（要 ${x.needed}，第 ${x.level} 层）`),
    raw: res.raw.map((x) => `${x.needed} ${name(x)}${x.loop ? `（#${x.loop.recipe.ref} 要回头用${name(x.loop.needs)}）` : ''}${x.unfit ? `（#${x.unfit.ref} 做不出它）` : ''}`),
    kept: res.kept.map(name),
    fluids: res.fluids.map((x) => `${x.needed} mB ${name(x)}${x.loop ? `（#${x.loop.recipe.ref} 要回头用${name(x.loop.needs)}）` : ''}`),
  })
  const slot = (p: { id: string; meta: number }): RecipeSlot => ({ kind: 'item', id: p.id, meta: p.meta, n: 1 })
  const walk = (target: { id: string; meta: number }, count: number, choose: Choose) => show(new MaterialTree(book, items, choose).run({ slot: slot(target) }, count))
  /** 一张记好的表：哪样东西（TreeThing.key）用哪条配方；表里没有的不做。 */
  const byTable = (table: Record<string, number>): Choose => (thing) => {
    const ref = table[thing.key]
    return ref === undefined ? {} : { recipe: book.get(ref) as Recipe }
  }
  return { book, items, walk, byTable, show, slot }
}

/** 每样取配方册里列在最前的那条；回收的页不取；模具、工具（不消耗的）不做。 */
const firstListed: Choose = (_thing, options, asked) => {
  if (asked.kept) return {}
  const recipe = options.first((way) => !isRecycling(way))
  return recipe ? { recipe } : {}
}

describe('走完整棵配方树（内核）', () => {
  it('每样都取配方册里列在最前的那条：直升机桨叶的树走到底——4 根柄 36 个钢锭，钢锭从钢粉炼；钢粉的配方要回头用钢锭，所以钢粉算原料，并记下是哪条配方绕回去的', (t) => {
    const s = setup(t)
    assert.deepEqual(s.walk(P.blades, 1, firstListed), {
      made: [`#${R.smeltSteel} 工业高炉 × 36 → 36 钢锭（要 36，第 2 层）`, `#${R.shaft} 压模机 × 4 → 4 精炼铁柄（要 4，第 1 层）`, `#${R.blades} 有序合成 × 1 → 1 直升机桨叶（要 1，第 0 层）`],
      raw: ['3 钢螺丝', '1 钢齿轮', `36 钢粉（#${R.grindIngot} 要回头用钢锭）`],
      kept: ['any craftingToolScrewdriver (e.g. 螺丝刀)', '模头（转轴）'],
      fluids: [],
    })
    // 回收的页（把钢销拆成钢粒）列在最前，选择函数说了不取；有概率才掉钢粒的那条不算做法；取的是后面那条真做法：1 钢锭出 9 个，要 10 个就是 2 轮
    assert.deepEqual(s.walk(X.nugget, 10, firstListed).made.at(-1), `#${M.nugget} 有序合成 × 2 → 18 钢粒（要 10，第 0 层）`)
    // 换一个连回收页也取的选择函数：同一样东西走的就是回收那条（一个钢销拆 2 个，10 个要 5 轮）
    const anyFirst: Choose = (_thing, options, asked) => {
      const recipe = asked.kept ? undefined : options.first()
      return recipe ? { recipe } : {}
    }
    assert.deepEqual(s.walk(X.nugget, 10, anyFirst).made.at(-1), `#${M.nuggetRecycle} 电弧炉回收 × 5 → 10 钢粒（要 10，第 0 层）`)
  })

  it('照一张记好的表走（哪样东西用哪条配方）：3 个桨叶——12 根柄 108 个钢锭，模头（转轴）只做 1 个，玄钢粉搅拌机一轮出 3 个所以 4 个要 2 轮，高炉要的氧合计 4000 mB；表里没有的都算原料', (t) => {
    const s = setup(t)
    const table = {
      'adventurebackpack:backpackComponent/6': R.blades,
      'IC2:itemRecipePart/12': R.shaft,
      'miscutils:MU-metaitem.01/32040': R.shaftShape,
      // 材料件按矿辞名记：配方点名的是 EnderIO 的玄钢锭，高炉出的也是那一种，和 GregTech 的玄钢锭算同一样
      'ore:plateDarkSteel': R.bendDark,
      'ore:ingotDarkSteel': R.smeltDarkOxygen,
      'ore:dustDarkSteel': R.mixDark,
    }
    assert.deepEqual(s.walk(P.blades, 3, s.byTable(table)), {
      made: [
        `#${R.mixDark} 搅拌机 × 2 → 6 玄钢粉（要 4，第 5 层）`,
        `#${R.smeltDarkOxygen} 工业高炉 × 4 → 4 玄钢锭（要 4，第 4 层）`,
        `#${R.bendDark} 卷板机 × 4 → 4 玄钢板（要 4，第 3 层）`,
        `#${R.shaftShape} 有序合成 × 1 → 1 模头（转轴）（要 1，第 2 层）`,
        `#${R.shaft} 压模机 × 12 → 12 精炼铁柄（要 12，第 1 层）`,
        `#${R.blades} 有序合成 × 3 → 3 直升机桨叶（要 3，第 0 层）`,
      ],
      raw: ['9 钢螺丝', '3 钢齿轮', '108 钢锭', '1 模头（杆）', '2 磁钢粉', '2 煤粉', '2 黑曜石粉'],
      kept: ['any craftingToolScrewdriver (e.g. 螺丝刀)', 'any craftingToolHardHammer (e.g. 锤)'],
      fluids: ['4000 mB 氧'],
    })
  })

  it('两格写法不同、定下来是同一条配方的同一样产物：并成一行、数量加在一起（锁要 1 个钢片，门闩那格“钢销或钢片”要 2 个 → 钢片一共压 3 个）；拿锁自己当原料的那条不算做锁的办法', (t) => {
    const s = setup(t)
    assert.deepEqual(s.walk(X.lock, 1, firstListed), {
      // 3 个钢片 3 个钢锭；钢锭照“列在最前的”是从钢粉炼，钢粉又绕回钢锭
      made: [`#${R.smeltSteel} 工业高炉 × 3 → 3 钢锭（要 3，第 2 层）`, `#${R.sheetExtrude} 压模机 × 3 → 3 钢片（要 3，第 1 层）`, `#${M.latch} 无序合成 × 1 → 1 门闩（要 1，第 1 层）`, `#${M.lock} 有序合成 × 1 → 1 锁（要 1，第 0 层）`],
      raw: ['1 钢螺丝', `3 钢粉（#${R.grindIngot} 要回头用钢锭）`],
      kept: ['模头（板）'],
      fluids: [],
    })
  })

  it('模头（杆）先只是留在压模机里（不消耗），后来又被合进模头（转轴）用掉：被用掉时再问一次要不要做——做的话是 2 个（留在机器里的 1 个 + 用掉的 1 个），8 块钢板', (t) => {
    const s = setup(t)
    const table = s.byTable({ 'demo:crank/0': M.crank, 'ore:stickSteel': R.rodExtrude, 'miscutils:MU-metaitem.01/32040': R.shaftShape, 'gregtech:gt.metaitem.01/32351': M.rodShape })
    // 只是放在机器里不消耗的东西不做；要用掉的才照表做
    const consumedOnly: Choose = (thing, options, asked) => (asked.kept ? {} : table(thing, options, asked))
    const res = s.walk(X.crank, 1, consumedOnly)
    assert.deepEqual(res.made, [
      `#${M.rodShape} 有序合成 × 2 → 2 模头（杆）（要 2，第 2 层）`,
      `#${R.rodExtrude} 压模机 × 1 → 2 钢杆（要 1，第 1 层）`,
      `#${R.shaftShape} 有序合成 × 1 → 1 模头（转轴）（要 1，第 1 层）`,
      `#${M.crank} 有序合成 × 1 → 1 曲柄（要 1，第 0 层）`,
    ])
    assert.deepEqual([res.raw, res.kept], [['4 玄钢板', '1 钢锭', '8 钢板'], ['any craftingToolHardHammer (e.g. 锤)']])
  })

  it('流体：表里记了出它的配方，就算到那条配方头上，按 mB 取整轮数（5 个钢销 180 mB，一轮化出 144，所以化 2 个钢锭）；钢锭要是又记成拿熔融钢浇，那是绕回去了，钢锭算原料', (t) => {
    const s = setup(t)
    const pour = { 'demo:pin/0': R.pinCast, 'fluid:molten.steel': M.meltIngot }
    assert.deepEqual(s.walk(P.pin, 5, s.byTable(pour)), {
      made: [`#${M.meltIngot} 流体提取机 × 2 → 288 熔融钢（要 180，第 1 层）`, `#${R.pinCast} 流体固化器 × 5 → 5 钢销（要 5，第 0 层）`],
      raw: ['2 钢锭'],
      kept: [],
      fluids: [],
    })
    // 没记熔融钢怎么来：它是要现成的流体
    assert.deepEqual(s.walk(P.pin, 5, s.byTable({ 'demo:pin/0': R.pinCast })), { made: [`#${R.pinCast} 流体固化器 × 5 → 5 钢销（要 5，第 0 层）`], raw: [], kept: [], fluids: ['180 mB 熔融钢'] })
    assert.deepEqual(s.walk(P.pin, 5, s.byTable({ ...pour, 'ore:ingotSteel': M.castIngot })).raw, [`2 钢锭（#${M.castIngot} 要回头用熔融钢）`])
  })

  it('表里记的配方做不出那样东西（配方册重新导出、编号对不上了）：那样东西算原料，并带着那条对不上的配方', (t) => {
    const s = setup(t)
    // 柄记成了卷板机压钢板的那条
    assert.deepEqual(s.walk(P.blades, 1, s.byTable({ 'adventurebackpack:backpackComponent/6': R.blades, 'IC2:itemRecipePart/12': R.bendSteel })), {
      made: [`#${R.blades} 有序合成 × 1 → 1 直升机桨叶（要 1，第 0 层）`],
      raw: [`4 精炼铁柄（#${R.bendSteel} 做不出它）`, '3 钢螺丝', '1 钢齿轮'],
      kept: ['any craftingToolScrewdriver (e.g. 螺丝刀)'],
      fluids: [],
    })
    // 连目标自己都没有配方：目标算原料，要几个是几个
    assert.deepEqual(s.walk(P.blades, 2, s.byTable({})), { made: [], raw: ['2 直升机桨叶'], kept: [], fluids: [] })
  })
})
