// 做法规划（plan_item）：给一个目标，替模型把整棵“怎么做”的树走完，返回可以照着调用的步骤、缺的叶子、要主人先点头的事。
// 入口是模型用的工具；配方册是自造的小样本（fixture-plan.ts），游戏是按方法名应答的假基地（机器、合成台、箱子里的东西）。
// 预期的数量都是照配方手算的（4 根柄 × 9 锭 = 36 锭，搅拌机一轮出 3 个所以 4 个要 2 轮……），不是拿被测的代码算的。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { loadPackData } from '../src/packdata/index.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { useLocalNames } from '../src/tools/format.ts'
import { ALL_TOOLS, runTool } from '../src/tools/index.ts'
import type { PlanData } from '../src/tools/planner.ts'
import type { ToolContext, ToolResult } from '../src/tools/index.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { ALL_MACHINES, BENDER, CHEST, EXTRUDER, MACERATOR, MIXER, P, R, SOLIDIFIER, chest, furnace, inside, installBase, stack, writePlanFixture } from './fixture-plan.ts'
import type { Box } from './fixture-plan.ts'
import { tmpDir } from './helpers.ts'

function setup(t: { after(fn: () => void): void }, init: Parameters<typeof installBase>[1] = {}) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  writePlanFixture(tmp.dir)
  const packdata = loadPackData(tmp.dir)
  t.after(() => packdata.recipes?.close())
  useLocalNames(packdata.items)
  t.after(() => useLocalNames(undefined))
  const game = new FakeGame()
  const world = installBase(game, init)
  const ctx: ToolContext = {
    botName: 'Alu',
    bridge: new BridgeApi(game),
    memory: new MemoryStore(tmp.dir, () => 300),
    manuals: new ManualStore(DEFAULT_MANUALS_DIR, `${tmp.dir}/manuals`),
    packdata,
    reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
    hooks: {},
    now: () => 1_800_000_000_000,
  }
  const plan = async (target: { id: string; meta: number }, more: Record<string, unknown> = {}): Promise<ToolResult & { plan: PlanData; lines: string[] }> => {
    const res = await runTool(ALL_TOOLS, ctx, 'plan_item', { ...target, ...more }, { maxResultChars: 6000 })
    return { ...res, plan: res.data as PlanData, lines: res.content.split('\n') }
  }
  /** 每一步调哪个工具、给什么参数：模型（或者例程）照着调的就是这些。 */
  const calls = (p: PlanData): [string, unknown][] => p.steps.map((s) => [s.tool, s.input])
  return { game, world, plan, calls }
}

const at = (m: { x: number; y: number; z: number }) => ({ x: m.x, y: m.y, z: m.z })
const FURNACE = { x: -5, y: 64, z: 9 }
/** 做一个直升机桨叶要的东西，仓库里都有（多备了一些）。 */
const FULL: Box['items'] = [
  stack(P.steelIngot, 40),
  stack(P.steelScrew, 3),
  stack(P.steelGear, 1),
  stack(P.magneticDust, 5),
  stack(P.coalDust, 5),
  stack(P.obsidianDust, 5),
  stack(P.rodShape, 1),
  stack(P.screwdriver, 1),
  stack(P.hammer, 1),
]
const without = (...gone: { id: string; meta: number }[]): Box['items'] => FULL.filter((i) => !gone.some((g) => g.id === i.id && g.meta === i.meta))

describe('plan_item：把整条做法排出来', () => {
  it('直升机桨叶：桨叶 ← 4 根柄（压模机，9 钢锭一根，模头不消耗）← 模头（转轴）← 4 玄钢板（卷板机）← 玄钢锭（高炉）← 玄钢粉（搅拌机一轮出 3 个），数量沿树算对，先取料再一步步做', async (t) => {
    const s = setup(t, { boxes: [chest(FULL)] })
    const res = await s.plan(P.blades)
    assert.equal(res.isError, undefined, res.content)
    assert.deepEqual(s.calls(res.plan), [
      // 钢锭 4×9=36；三样粉各 2（玄钢粉要 4 个，搅拌机一轮出 3 个，所以 2 轮）；锤、模头（杆）、螺丝刀各 1：不消耗的不乘数量
      ['withdraw_items', { container: CHEST, items: [stack(P.steelIngot, 36), stack(P.hammer, 1), stack(P.magneticDust, 2), stack(P.coalDust, 2), stack(P.obsidianDust, 2), stack(P.rodShape, 1), stack(P.steelScrew, 3), stack(P.steelGear, 1), stack(P.screwdriver, 1)] }],
      ['process_items', { machine: at(MIXER), recipe: R.mixDark, rounds: 2 }],
      // 高炉 100 秒一个，4 个要等 400 秒：把 wait 写上
      ['process_items', { machine: FURNACE, recipe: R.smeltDark, rounds: 4, wait: 510 }],
      ['process_items', { machine: at(BENDER), recipe: R.bendDark, rounds: 4 }],
      ['craft_item', { recipe: R.shaftShape, count: 1 }],
      ['process_items', { machine: at(EXTRUDER), recipe: R.shaft, rounds: 4, wait: 338 }],
      ['craft_item', { recipe: R.blades, count: 1 }],
    ])
    assert.deepEqual([res.plan.feasible, res.plan.missing, res.plan.decisions, res.plan.cutOff], [true, [], [], false])
    // 给模型看的：一句结论，然后每步一行“工具名 + 参数（JSON，照抄就能调）+ 这一步干什么”，底下是为什么挑这种做法
    assert.equal(res.lines[0], 'Plan for 1× 直升机桨叶 [adventurebackpack:backpackComponent/6]: everything needed is here. 7 step(s): 1 to fetch, 6 to make.')
    assert.equal(res.lines[1], 'STEPS — 7 step(s). Do them in this order, one tool call per step, with the arguments exactly as written; wait for each task to end before the next.')
    assert.equal(res.lines[3], `2. process_items {"machine":{"x":20,"y":64,"z":-8},"recipe":${R.mixDark},"rounds":2} — make 6× 玄钢粉 on the 基础搅拌机; programmed circuit 2 is set for you`)
    assert.equal(res.lines[4], `   why: 搅拌机 #${R.mixDark}, 0.33 磁钢粉 + 0.33 煤粉 + 0.33 黑曜石粉 each. other ways: by hand #${R.handMixDark}, 0.5 磁钢粉 + 0.5 煤粉 + 0.5 黑曜石粉 each`)
    assert.match(res.lines.at(-2)!, new RegExp(`^7\\. craft_item \\{"recipe":${R.blades},"count":1\\} — craft 1× 直升机桨叶 by hand at the nearest crafting table$`))
    assert.equal(res.lines.at(-1), `   why: by hand #${R.blades}, 4 精炼铁柄 + 3 钢螺丝 + 1 钢齿轮 each, keeps 螺丝刀`)
    // 每一行步骤里的参数真的是能直接拿去调工具的 JSON
    for (const line of res.lines.filter((l) => /^\d+\. /.test(l))) assert.doesNotThrow(() => JSON.parse(/^\d+\. \w+ (\{.*\}) — /.exec(line)![1]!), line)
  })

  it('挑省料的：钢板用卷板机（1 锭 1 板），不用手工锤（2 锭 1 板）；卷板机没电时只好手工，并提出来让主人拿主意', async (t) => {
    const s = setup(t, { boxes: [chest([stack(P.steelIngot, 10), stack(P.hammer, 1)])] })
    const res = await s.plan(P.steelPlate, { count: 3 })
    assert.deepEqual(s.calls(res.plan), [
      ['withdraw_items', { container: CHEST, items: [stack(P.steelIngot, 3)] }],
      ['process_items', { machine: at(BENDER), recipe: R.bendSteel, rounds: 3 }],
    ])
    assert.equal(res.lines.at(-1), `   why: 卷板机 #${R.bendSteel}, 1 钢锭 each. other ways: by hand #${R.hammerSteel}, 2 钢锭 each, keeps 锤 (hand tools: only when no machine can do it)`)
    assert.deepEqual(res.plan.decisions, [])

    s.world.machines = [{ ...BENDER, storedEU: 0 }, EXTRUDER, MIXER, MACERATOR, furnace()]
    const byHand = await s.plan(P.steelPlate, { count: 3 })
    assert.deepEqual(s.calls(byHand.plan), [
      // 3 块板 × 2 锭；锤只要 1 把
      ['withdraw_items', { container: CHEST, items: [stack(P.hammer, 1), stack(P.steelIngot, 6)] }],
      ['craft_item', { recipe: R.hammerSteel, count: 3 }],
    ])
    assert.equal(byHand.plan.feasible, true)
    assert.deepEqual(byHand.plan.decisions, [
      `step 2 makes the 钢板 by hand #${R.hammerSteel} at 2 钢锭 each, keeps 锤; 卷板机 #${R.bendSteel} would take 1 钢锭 each, but the 基础卷板机 at (16,64,-8) cannot run it now: NO POWER. Ask your owner which they want`,
    ])
    assert.equal(byHand.plan.steps[1]!.ask, true)
    assert.match(byHand.lines[0]!, /everything needed is here\. 2 step\(s\): 1 to fetch, 1 to make\. 1 thing\(s\) need your owner's word before you start\.$/)
    assert.equal(byHand.lines[1], 'ASK YOUR OWNER FIRST:')
  })

  it('库存只够一部分：有的取来用，只把缺的那部分做出来；身上已经有的不用取；配方点名的是另一个 id 的同一种东西（玄钢锭）照样算有', async (t) => {
    // 要 4 块玄钢板：仓库有 1 块，还有 2 个 GregTech 的玄钢锭（卷板机配方写的是 EnderIO 的那个 id）；锤在身上
    const s = setup(t, {
      boxes: [chest([stack(P.darkPlate, 1), stack(P.darkIngotGt, 2), stack(P.magneticDust, 1), stack(P.coalDust, 1), stack(P.obsidianDust, 1), stack(P.rodShape, 1)])],
      inventory: [stack(P.hammer, 1)],
    })
    const res = await s.plan(P.shaftShape)
    assert.deepEqual(s.calls(res.plan), [
      ['withdraw_items', { container: CHEST, items: [stack(P.magneticDust, 1), stack(P.coalDust, 1), stack(P.obsidianDust, 1), stack(P.darkIngotGt, 2), stack(P.darkPlate, 1), stack(P.rodShape, 1)] }],
      // 还差 3 块板 → 3 个锭，其中 2 个现成 → 只炼 1 个 → 搅拌机 1 轮
      ['process_items', { machine: at(MIXER), recipe: R.mixDark, rounds: 1 }],
      ['process_items', { machine: FURNACE, recipe: R.smeltDark, rounds: 1 }],
      ['process_items', { machine: at(BENDER), recipe: R.bendDark, rounds: 3 }],
      ['craft_item', { recipe: R.shaftShape, count: 1 }],
    ])
    assert.ok(res.lines.includes('You already carry: 1× 锤.'), res.content)
  })

  it('工具：仓库里有就取 1 把；没有就挑一种材料现成的做一把（十二种材质里，只有钢质锭够数）；什么料都没有时把“缺一把锤”报出来，不替主人挑材质', async (t) => {
    const s = setup(t, { boxes: [chest([stack(P.darkPlate, 4), stack(P.rodShape, 1), stack(P.demoIngot(3), 6), stack(P.demoIngot(7), 2), stack(P.stick, 2)])] })
    const res = await s.plan(P.shaftShape)
    assert.deepEqual(s.calls(res.plan), [
      ['withdraw_items', { container: CHEST, items: [stack(P.demoIngot(3), 6), stack(P.stick, 1), stack(P.darkPlate, 4), stack(P.rodShape, 1)] }],
      ['craft_item', { recipe: R.hammer(3), count: 1 }],
      ['craft_item', { recipe: R.shaftShape, count: 1 }],
    ])
    assert.equal(res.plan.feasible, true)

    s.world.boxes = [chest([stack(P.darkPlate, 4), stack(P.rodShape, 1)])]
    const none = await s.plan(P.shaftShape)
    assert.equal(none.plan.feasible, false)
    assert.equal(none.plan.missing.length, 1)
    assert.deepEqual([none.plan.missing[0]!.ore, none.plan.missing[0]!.count], ['craftingToolHardHammer', 1])
    assert.match(none.plan.missing[0]!.reason, /^not in storage here, and there is nothing at hand to make one from \(12 recipe\(s\) would do, for instance by hand #\d+, 6 .锭 \+ 1 木棍 each\)$/)
    assert.equal(none.lines[1], 'MISSING — tell your owner exactly these (with their names as written here), not the things in between:')
    assert.match(none.lines[2]!, /^- 1× any craftingToolHardHammer \(e\.g\. 锤 \[gregtech:gt\.metatool\.01\/12\]\): not in storage here, and there is nothing at hand to make one from/)
    // 做转轴模头的那一步在等这把锤
    assert.deepEqual(none.plan.steps.at(-1)!.waitsFor, ['锤'])

    // 两种材质的锭都够做一把：用库存多的那种（镍锭一大堆，钢质锭刚好 6 个），不是配方册里排在前面的那种
    s.world.boxes = [chest([stack(P.darkPlate, 4), stack(P.rodShape, 1), stack(P.demoIngot(3), 6), stack(P.demoIngot(7), 60), stack(P.stick, 2)])]
    const plenty = await s.plan(P.shaftShape)
    assert.deepEqual(s.calls(plenty.plan)[1], ['craft_item', { recipe: R.hammer(7), count: 1 }])
  })
})

describe('plan_item：缺什么', () => {
  it('缺的是最底下那样（黑曜石粉），就只报它：中间的玄钢粉、玄钢锭、玄钢板、模头、柄都不算缺；等着它的步骤标出来，别的照常能做', async (t) => {
    const s = setup(t, { boxes: [chest(without(P.obsidianDust))] })
    const res = await s.plan(P.blades)
    assert.equal(res.plan.feasible, false)
    assert.deepEqual(res.plan.missing, [{ name: '黑曜石粉 [gregtech:gt.metaitem.01/2804] (or any dustObsidian)', ore: 'dustObsidian', count: 2, for: ['玄钢粉'], reason: 'not in storage here, and nothing in the recipe book makes it (a raw material: it has to be mined, bought or found)' }])
    assert.equal(res.lines[0], 'Plan for 1× 直升机桨叶 [adventurebackpack:backpackComponent/6]: it CANNOT be finished yet: 1 thing(s) are missing.')
    // 顺带说它是给什么用的：主人手里要是有现成的玄钢粉，给那个也行
    assert.equal(res.lines[1], 'MISSING — tell your owner exactly these (with their names as written here), not the things in between ("for the …" is what it goes into: being given that instead would do as well):')
    assert.equal(res.lines[2], '- 2× 黑曜石粉 [gregtech:gt.metaitem.01/2804] (or any dustObsidian), for the 玄钢粉: not in storage here, and nothing in the recipe book makes it (a raw material: it has to be mined, bought or found).')
    // 步骤还是那七步：取料不用等，后面六步都卡在黑曜石粉上
    assert.deepEqual(res.plan.steps.map((x) => [x.tool, x.waitsFor ?? []]), [
      ['withdraw_items', []],
      ['process_items', ['黑曜石粉']],
      ['process_items', ['黑曜石粉']],
      ['process_items', ['黑曜石粉']],
      ['craft_item', ['黑曜石粉']],
      ['process_items', ['黑曜石粉']],
      ['craft_item', ['黑曜石粉']],
    ])
    assert.match(res.lines.find((l) => l.startsWith('2. '))!, / \[WAITS FOR 黑曜石粉\]$/)
  })

  it('卡在机器上：没有压模机、高炉炉温不够，都说出是哪样东西、哪台机器、差在哪；没有配方的原料说没有配方', async (t) => {
    // 没有压模机：柄做不了，柄底下的钢锭、模头就不用再排
    const s = setup(t, { boxes: [chest(FULL)], machines: ALL_MACHINES.filter((m) => m !== EXTRUDER) })
    const noExtruder = await s.plan(P.blades)
    assert.deepEqual(noExtruder.plan.missing, [{ name: '精炼铁柄 [IC2:itemRecipePart/12]', id: 'IC2:itemRecipePart', meta: 12, count: 4, reason: 'not in storage here, and it cannot be made here: that takes a 压模机, and there is none nearby' }])
    assert.deepEqual(s.calls(noExtruder.plan), [
      ['withdraw_items', { container: CHEST, items: [stack(P.steelScrew, 3), stack(P.steelGear, 1), stack(P.screwdriver, 1)] }],
      ['craft_item', { recipe: R.blades, count: 1 }],
    ])

    // 高炉只有 1500 K：两条玄钢锭的配方（1800 K、2200 K）都做不了
    s.world.machines = [BENDER, EXTRUDER, MIXER, MACERATOR, furnace({ heat: 1500 })]
    const cold = await s.plan(P.shaftShape)
    assert.equal(cold.plan.missing.length, 1)
    assert.equal(cold.plan.missing[0]!.count, 4)
    assert.match(cold.plan.missing[0]!.reason, /玄钢锭: to make it \(工业高炉 #\d+\), the 工业高炉 at \(-5,64,9\) cannot run it now: the recipe needs 1800 K, its coils reach 1500 K/)

    // 1801 K：只有“加氧”的那条做得了，而输入仓里没有氧 → 缺的是氧，写明要多少、在哪个仓
    s.world.machines = [BENDER, EXTRUDER, MIXER, MACERATOR, furnace({ heat: 1801 })]
    const noOxygen = await s.plan(P.shaftShape)
    assert.deepEqual(noOxygen.plan.missing, [
      { name: '氧 (fluid)', fluid: 'oxygen', count: 4000, reason: 'step 3 needs 4000 mB in the input hatch of the 工业高炉 at (-5,64,9) and it holds 0 mB: have it piped in, or carry full cells and give them with "fluids"' },
    ])
    assert.deepEqual(noOxygen.plan.steps[2]!.input, { machine: FURNACE, recipe: R.smeltDarkOxygen, rounds: 4, wait: 270 })
    assert.deepEqual(noOxygen.plan.steps.map((x) => x.waitsFor ?? []), [[], [], ['氧 (fluid)'], ['氧 (fluid)'], ['氧 (fluid)']])
    // 仓里有够的氧：就用这条，不缺什么
    s.world.machines = [BENDER, EXTRUDER, MIXER, MACERATOR, furnace({ heat: 1801, oxygen: 8000 })]
    assert.deepEqual([(await s.plan(P.shaftShape)).plan.feasible, (await s.plan(P.shaftShape)).plan.steps[2]!.input.recipe], [true, R.smeltDarkOxygen])

    // 模头（杆）没有任何配方：缺的就是它
    s.world.machines = ALL_MACHINES
    s.world.boxes = [chest(without(P.rodShape))]
    const noShape = await s.plan(P.shaftShape)
    assert.deepEqual(noShape.plan.missing.map((m) => [m.id, m.meta, m.count, m.reason]), [[P.rodShape.id, P.rodShape.meta, 1, 'not in storage here, and nothing in the recipe book makes it (a raw material: it has to be mined, bought or found)']])
  })

  it('绕圈子的配方不走：钢锭 ← 钢粉 ← 钢锭／钢板（磨回去）不会被当成做法，回收配方（钢齿轮拆成钢锭）也不算；有钢粉时才走“钢粉炼钢锭”', async (t) => {
    // 仓库里只有钢齿轮：不能靠回收它来凑钢锭
    const s = setup(t, { boxes: [chest([stack(P.steelGear, 4)])] })
    const res = await s.plan(P.steelPlate, { count: 2 })
    assert.deepEqual(res.plan.missing.map((m) => [m.ore, m.count]), [['ingotSteel', 2]])
    assert.match(res.plan.missing[0]!.reason, new RegExp(`^not in storage here, and nothing it is made from is here either \\(it would be made 工业高炉 #${R.smeltSteel}, 1 钢粉 each\\)$`))
    assert.deepEqual(s.calls(res.plan), [['process_items', { machine: at(BENDER), recipe: R.bendSteel, rounds: 2 }]])
    const used = new Set(res.plan.steps.map((x) => x.input.recipe))
    for (const never of [R.recycleGear, R.grindIngot, R.grindPlate, R.furnaceSteel]) assert.equal(used.has(never), false)

    s.world.boxes = [chest([stack(P.steelDust, 5)])]
    const fromDust = await s.plan(P.steelPlate, { count: 2 })
    assert.deepEqual(s.calls(fromDust.plan), [
      ['withdraw_items', { container: CHEST, items: [stack(P.steelDust, 2)] }],
      ['process_items', { machine: FURNACE, recipe: R.smeltSteel, rounds: 2 }],
      ['process_items', { machine: at(BENDER), recipe: R.bendSteel, rounds: 2 }],
    ])
    assert.equal(fromDust.plan.feasible, true)
  })
})

describe('plan_item：要主人先点头的事', () => {
  it('高炉的输入总线接着漏斗（主人的自动化）：那一步标成先问，写明这是“往里放”、放进去会怎样；别的步骤照排', async (t) => {
    const s = setup(t, { boxes: [chest(FULL)], machines: [BENDER, EXTRUDER, MIXER, MACERATOR, furnace({ fed: true })] })
    const res = await s.plan(P.blades)
    // 往自动喂料的口子里放东西：放进去的会和漏斗送来的混在一起
    assert.deepEqual(res.plan.decisions, [`step 3 PUTS your inputs INTO the input bus of the 工业高炉 at (-5,64,9), which 漏斗 at (-4,64,10) feeds automatically (your owner's automation). They can get mixed with what it brings in: the machine may use your items up on your owner's recipe, or the bus may be full`])
    assert.deepEqual(res.plan.steps.map((x) => x.ask === true), [false, false, true, false, false, false, false])
    // 东西都有，只是要先问
    assert.equal(res.plan.feasible, true)
    assert.equal(res.lines[0], "Plan for 1× 直升机桨叶 [adventurebackpack:backpackComponent/6]: everything needed is here. 7 step(s): 1 to fetch, 6 to make. 1 thing(s) need your owner's word before you start.")
    assert.deepEqual(res.lines.slice(1, 3), ['ASK YOUR OWNER FIRST:', `- step 3 PUTS your inputs INTO the input bus of the 工业高炉 at (-5,64,9), which 漏斗 at (-4,64,10) feeds automatically (your owner's automation). They can get mixed with what it brings in: the machine may use your items up on your owner's recipe, or the bus may be full.`])
    assert.match(res.lines.find((l) => l.startsWith('3. '))!, / \[ASK FIRST\]$/)

    // 单方块机器旁边接着管道：同样是“往里放”，后果是原料被混、产物被抽走
    s.world.machines = ALL_MACHINES
    s.world.boxes = [chest(FULL), inside(BENDER, [], { attached: [{ x: 16, y: 65, z: -8, name: 'Hopper', kind: 'hopper' }] })]
    const piped = await s.plan(P.steelPlate, { count: 2 })
    assert.deepEqual(piped.plan.decisions, ["step 2 PUTS your inputs INTO the 基础卷板机 at (16,64,-8), which 漏斗 at (16,65,-8) is attached to (your owner's automation). The pipe may bring in other things that get mixed with yours, or carry what you make away before you take it"])
  })

  it('料在接着管道的箱子里：没接管道的箱子里有就从那边取；只有接着管道的箱子里有时，取之前先问，写明这是“往外取”、取走通常没事', async (t) => {
    const fed: Box = { x: 30, y: 64, z: 0, name: 'Chest', id: 'minecraft:chest', attached: [{ x: 30, y: 65, z: 0, name: 'Hopper', kind: 'hopper' }], items: [stack(P.steelIngot, 64)] }
    const s = setup(t, { boxes: [chest([stack(P.steelIngot, 2)]), fed] })
    const plain = await s.plan(P.steelPlate, { count: 2 })
    assert.deepEqual(plain.plan.steps[0]!.input, { container: CHEST, items: [stack(P.steelIngot, 2)] })
    assert.deepEqual(plain.plan.decisions, [])
    // 要 5 个：普通箱子里的 2 个先用，剩下 3 个只能从接着漏斗的箱子里取
    const more = await s.plan(P.steelPlate, { count: 5 })
    assert.deepEqual(s.calls(more.plan).slice(0, 2), [
      ['withdraw_items', { container: CHEST, items: [stack(P.steelIngot, 2)] }],
      ['withdraw_items', { container: { x: 30, y: 64, z: 0 }, items: [stack(P.steelIngot, 3)] }],
    ])
    assert.deepEqual(more.plan.decisions, ["step 2 TAKES 3× 钢锭 OUT OF the 箱子 at (30,64,0), which 漏斗 at (30,65,0) is attached to (your owner's automation). Taking things out is usually harmless: at worst the automation that draws on it runs short of them"])
    assert.equal(more.plan.steps[1]!.ask, true)
    // 好几个要取货的容器都接着管道（主人的抽屉常常整排这样）：并成一条来问，不是一步问一次
    const pipe = [{ x: 0, y: 70, z: 0, name: 'Hopper', kind: 'hopper' }]
    s.world.boxes = [
      { x: 30, y: 64, z: 0, attached: pipe, items: [stack(P.magneticDust, 4)] },
      { x: 31, y: 64, z: 0, attached: pipe, items: [stack(P.coalDust, 4)] },
      { x: 32, y: 64, z: 0, attached: pipe, items: [stack(P.obsidianDust, 4)] },
    ]
    const drawers = await s.plan(P.darkDust, { count: 3 })
    assert.deepEqual(drawers.plan.decisions, ["steps 1, 2, 3 TAKE things OUT OF containers that pipes or hoppers are attached to (your owner's automation): the 箱子 at (30,64,0) (step 1), the 箱子 at (31,64,0) (step 2), the 箱子 at (32,64,0) (step 3). Taking things out is usually harmless: at worst the automation that draws on it runs short of them"])
  })
})

describe('plan_item：工具只做一把、做最简单的那种', () => {
  it('要一把剪线钳、仓库里没有：做一把普通的就够了——不做电动的（哪怕马达和电池就在仓库里），也不先做一把普通的再拿它“升级”', async (t) => {
    // 细钢丝 = 1 钢板，用剪线钳剪。剪线钳这个矿辞名下有三种：普通的、万能工具（普通的 + 钢螺丝）、自动剪线钳（马达 + 电池 + 钢锭）。
    // 仓库里马达、电池、钢锭都现成：单看“料齐不齐”，电动的那把最省事
    const s = setup(t, { boxes: [chest([stack(P.steelIngot, 20), stack(P.steelScrew, 4), stack(P.hammer, 1), stack(P.motor, 1), stack(P.battery, 1)])] })
    const res = await s.plan(P.wire)
    assert.equal(res.plan.feasible, true, res.content)
    assert.deepEqual(s.calls(res.plan), [
      // 钢锭：4 块钢板（剪线钳 3 + 细钢丝 1）+ 2 根钢杆（没有模头，手工锤 1 锭 1 根）；钢螺丝 1 个；马达和电池不动
      ['withdraw_items', { container: CHEST, items: [stack(P.hammer, 1), stack(P.steelIngot, 6), stack(P.steelScrew, 1)] }],
      ['process_items', { machine: at(BENDER), recipe: R.bendSteel, rounds: 4 }],
      ['craft_item', { recipe: R.rodHand, count: 2 }],
      ['craft_item', { recipe: R.cutter, count: 1 }],
      ['craft_item', { recipe: R.wire, count: 1 }],
    ])
    assert.deepEqual(res.plan.decisions, [])
    // 仓库里有一把（哪一种都行）：直接用，不做
    s.world.boxes = [chest([stack(P.steelIngot, 20), stack(P.snips, 1)])]
    const have = await s.plan(P.wire)
    assert.deepEqual(s.calls(have.plan), [
      ['withdraw_items', { container: CHEST, items: [stack(P.snips, 1), stack(P.steelIngot, 1)] }],
      ['process_items', { machine: at(BENDER), recipe: R.bendSteel, rounds: 1 }],
      ['craft_item', { recipe: R.wire, count: 1 }],
    ])
    // 点名要电动的那把（不是“要一把工具”）：照样排得出来
    const electric = await s.plan(P.snips)
    assert.equal(electric.plan.steps.at(-1)!.input.recipe, R.snips)
  })
})

describe('plan_item：机器里现成的模具、模头', () => {
  const EXTRUDER_AT = at(EXTRUDER)

  it('模头就在要用的那台压模机里：原地用，不取、不问，也不带一个去', async (t) => {
    const s = setup(t, { boxes: [chest([stack(P.steelIngot, 10)]), inside(EXTRUDER, [stack(P.rodShape, 1)])] })
    const res = await s.plan(P.steelRod, { count: 4 })
    assert.deepEqual(s.calls(res.plan), [
      ['withdraw_items', { container: CHEST, items: [stack(P.steelIngot, 2)] }],
      // 压模机 1 锭 2 根；模头（杆）已经在机器里
      ['process_items', { machine: EXTRUDER_AT, recipe: R.rodExtrude, rounds: 2, moldInside: true }],
    ])
    assert.deepEqual([res.plan.feasible, res.plan.decisions], [true, []])
    assert.match(res.lines.find((l) => l.startsWith('2. '))!, / — make 4× 钢杆 on the 进阶压模机; the 模头（杆） already in that machine is used where it is$/)
  })

  it('模头在另一台机器里（那台没电）：借出来用，用完放回去——取之前先问主人，放回去是计划里的一步；主人不同意就自己做（borrow:false）', async (t) => {
    const OFF = { ...EXTRUDER, storedEU: 0 }
    const ON = { ...EXTRUDER, x: 26 }
    const s = setup(t, {
      boxes: [chest([stack(P.steelIngot, 40), stack(P.darkPlate, 4), stack(P.rodShape, 1), stack(P.hammer, 1)]), inside(OFF, [stack(P.shaftShape, 1)])],
      machines: [BENDER, OFF, ON, MIXER, MACERATOR, furnace()],
    })
    const res = await s.plan(P.shaft, { count: 4 })
    assert.deepEqual(s.calls(res.plan), [
      ['withdraw_items', { container: CHEST, items: [stack(P.steelIngot, 36)] }],
      ['withdraw_items', { container: EXTRUDER_AT, items: [stack(P.shaftShape, 1)], fromInputs: true }],
      ['process_items', { machine: at(ON), recipe: R.shaft, rounds: 4, wait: 338 }],
      ['deposit_items', { container: EXTRUDER_AT, items: [stack(P.shaftShape, 1)] }],
    ])
    assert.deepEqual(res.plan.steps.map((x) => x.ask === true), [false, true, false, false])
    assert.deepEqual(res.plan.decisions, [
      `step 2 BORROWS 1× 模头（转轴） from the input slots of the 进阶压模机 at (18,64,-8): it is your owner's, kept there for that machine. Step 4 puts it back. If your owner says no, call plan_item again with "borrow": false (it would then be made by hand #${R.shaftShape}, 4 玄钢板 + 1 模头（杆） each, keeps 锤)`,
    ])
    assert.equal(res.lines[0], "Plan for 4× 精炼铁柄 [IC2:itemRecipePart/12]: everything needed is here. 4 step(s): 2 to fetch, 1 to make, 1 to put back what was taken out of machines (do these too, even though the 精炼铁柄 is made by then). 1 thing(s) need your owner's word before you start.")
    assert.equal(res.lines.at(-1), '4. deposit_items {"container":{"x":18,"y":64,"z":-8},"items":[{"id":"miscutils:MU-metaitem.01","meta":32040,"count":1}]} — put 1× 模头（转轴） back into the 进阶压模机 (taken out at step 2)')

    // 主人说不行：不碰那台机器里的模头，自己做一个
    const own = await s.plan(P.shaft, { count: 4, borrow: false })
    assert.deepEqual(s.calls(own.plan), [
      ['withdraw_items', { container: CHEST, items: [stack(P.steelIngot, 36), stack(P.hammer, 1), stack(P.darkPlate, 4), stack(P.rodShape, 1)] }],
      ['craft_item', { recipe: R.shaftShape, count: 1 }],
      ['process_items', { machine: at(ON), recipe: R.shaft, rounds: 4, wait: 338 }],
    ])
    assert.deepEqual(own.plan.decisions, [])
  })

  it('借来的东西会被这份计划用掉（模头（杆）要合成进模头（转轴））：照实说“用掉、放不回去”，让主人拿主意；没有放回去那一步', async (t) => {
    // 仓库里别的都有，就是没有模头（杆）；压模机的原料格里放着一个
    const s = setup(t, { boxes: [chest(without(P.rodShape)), inside(EXTRUDER, [stack(P.rodShape, 1)])] })
    const res = await s.plan(P.blades)
    assert.deepEqual(s.calls(res.plan), [
      ['withdraw_items', { container: CHEST, items: [stack(P.steelIngot, 36), stack(P.hammer, 1), stack(P.magneticDust, 2), stack(P.coalDust, 2), stack(P.obsidianDust, 2), stack(P.steelScrew, 3), stack(P.steelGear, 1), stack(P.screwdriver, 1)] }],
      ['process_items', { machine: at(MIXER), recipe: R.mixDark, rounds: 2 }],
      ['process_items', { machine: FURNACE, recipe: R.smeltDark, rounds: 4, wait: 510 }],
      ['process_items', { machine: at(BENDER), recipe: R.bendDark, rounds: 4 }],
      // 到要用的那一步之前才取
      ['withdraw_items', { container: EXTRUDER_AT, items: [stack(P.rodShape, 1)], fromInputs: true }],
      ['craft_item', { recipe: R.shaftShape, count: 1 }],
      // 模头（杆）已经取走了，压模机的两个原料格放得下钢锭和模头（转轴）
      ['process_items', { machine: EXTRUDER_AT, recipe: R.shaft, rounds: 4, wait: 338 }],
      ['craft_item', { recipe: R.blades, count: 1 }],
    ])
    assert.deepEqual(res.plan.decisions, [
      'step 5 TAKES 1× 模头（杆） OUT OF the input slots of the 进阶压模机 at (18,64,-8), and this plan USES IT UP (it goes into the 模头（转轴）): it does not come back, so that machine is left without it. If your owner says no, call plan_item again with "borrow": false (there is no other way to get one here: nothing in the recipe book makes it (a raw material: it has to be mined, bought or found))',
    ])
    assert.equal(res.plan.feasible, true)
    // 不借：缺的就是模头（杆）
    const own = await s.plan(P.blades, { borrow: false })
    assert.deepEqual(own.plan.missing.map((m) => [m.id, m.meta, m.count]), [[P.rodShape.id, P.rodShape.meta, 1]])
  })

  it('要用的压模机只有两个原料格，一个被别的模头占着，这次要放钢锭和模头（转轴）：先把占位的取出来（先问主人），做完放回去；格子够时不动它', async (t) => {
    const s = setup(t, { boxes: [chest([stack(P.steelIngot, 40), stack(P.shaftShape, 1)]), inside(EXTRUDER, [stack(P.plateShape, 1)])] })
    const res = await s.plan(P.shaft, { count: 4 })
    assert.deepEqual(s.calls(res.plan), [
      ['withdraw_items', { container: CHEST, items: [stack(P.steelIngot, 36), stack(P.shaftShape, 1)] }],
      ['withdraw_items', { container: EXTRUDER_AT, items: [stack(P.plateShape, 1)], fromInputs: true }],
      ['process_items', { machine: EXTRUDER_AT, recipe: R.shaft, rounds: 4, wait: 338 }],
      ['deposit_items', { container: EXTRUDER_AT, items: [stack(P.plateShape, 1)] }],
    ])
    assert.deepEqual(res.plan.decisions, [
      "step 2 TAKES 1× 模头（板） OUT OF the input slots of the 进阶压模机 at (18,64,-8) to make room: it has 2 input slot(s), 1 taken, and step 3 puts 2 more kind(s) of thing in. It is your owner's, kept there for that machine; step 4 puts it back",
    ])
    assert.deepEqual(res.plan.steps.map((x) => x.ask === true), [false, true, false, false])
    // 不借模具（borrow:false）时照样要挪：这是腾地方，不是借
    assert.deepEqual(s.calls((await s.plan(P.shaft, { count: 4, borrow: false })).plan), s.calls(res.plan))

    // 四个原料格的压模机：放得下，不碰里面的模头
    s.world.machines = [BENDER, { ...EXTRUDER, inputSlots: 4 }, MIXER, MACERATOR, furnace()]
    const roomy = await s.plan(P.shaft, { count: 4 })
    assert.deepEqual(s.calls(roomy.plan).map(([tool]) => tool), ['withdraw_items', 'process_items'])
    assert.deepEqual(roomy.plan.decisions, [])
  })
})

describe('plan_item：还不能直接用的机器做法排在后面', () => {
  it('压模机省料，可它要的模头手头没有（得先另做一个）：手边的办法做得了就用手边的；要得多、省得多时才提出来问主人；模头现成时用压模机', async (t) => {
    // 钢销：压模机 1 锭 4 个（模头（转轴）不消耗），手工锤 1 锭 1 个。仓库里没有模头（转轴），但做它的料都有
    const makings = [stack(P.steelIngot, 64), stack(P.hammer, 1), stack(P.darkPlate, 4), stack(P.rodShape, 1)]
    const s = setup(t, { boxes: [chest(makings)] })
    const few = await s.plan(P.pin, { count: 2 })
    assert.deepEqual(s.calls(few.plan), [
      ['withdraw_items', { container: CHEST, items: [stack(P.hammer, 1), stack(P.steelIngot, 2)] }],
      ['craft_item', { recipe: R.pinHand, count: 2 }],
    ])
    // 只多耗一个半钢锭：不值得为它问主人
    assert.deepEqual(few.plan.decisions, [])
    assert.equal(few.lines.at(-1), `   why: by hand #${R.pinHand}, 1 钢锭 each, keeps 锤. other ways: 压模机 #${R.pinExtrude}, 0.25 钢锭 each, keeps 模头（转轴）`)
    // 要 40 个：手工 40 锭，压模机 10 锭——差得多了，提出来
    const many = await s.plan(P.pin, { count: 40 })
    assert.deepEqual(many.plan.decisions, [`step 2 makes the 钢销 by hand #${R.pinHand} at 1 钢锭 each, keeps 锤, with what is at hand; 压模机 #${R.pinExtrude} would take 0.25 钢锭 each, keeps 模头（转轴）, but more has to be made for it first. Ask your owner which they want`])

    s.world.boxes = [chest([...makings, stack(P.shaftShape, 1)])]
    const withShape = await s.plan(P.pin, { count: 2 })
    assert.deepEqual(s.calls(withShape.plan), [
      ['withdraw_items', { container: CHEST, items: [stack(P.steelIngot, 1), stack(P.shaftShape, 1)] }],
      ['process_items', { machine: at(EXTRUDER), recipe: R.pinExtrude, rounds: 1 }],
    ])
  })

  it('单方块机器要流体的配方（罐子里有没有它看不到）：别的办法做得了就不用它；只剩它时才用，并让主人确认流体；要的熔融金属基地里连这种材料都没有的，不当成做得出来', async (t) => {
    const machines = [...ALL_MACHINES, SOLIDIFIER]
    const s = setup(t, { boxes: [chest([stack(P.steelIngot, 8), stack(P.hammer, 1)])], machines })
    // 钢销：流体固化器 36 mB 熔融钢 1 个，什么都不用带；手工锤 1 锭 1 个
    const byHand = await s.plan(P.pin, { count: 2 })
    assert.deepEqual(s.calls(byHand.plan).at(-1), ['craft_item', { recipe: R.pinHand, count: 2 }])
    assert.deepEqual(byHand.plan.decisions, [])
    // 没有锤、也没有料做锤：只剩流体固化器这一条路（仓库里有钢，罐子里可能接着熔融钢）
    s.world.boxes = [chest([stack(P.steelIngot, 4)])]
    const cast = await s.plan(P.pin, { count: 2 })
    assert.deepEqual(s.calls(cast.plan), [['process_items', { machine: at(SOLIDIFIER), recipe: R.pinCast, rounds: 2 }]])
    assert.deepEqual(cast.plan.decisions, ["step 1 needs 72 mB 熔融钢 inside the 基础流体固化器 at (24,64,-8): you cannot see or fill a single-block machine's tank, so ask your owner whether it is piped in"])

    // 模头（转轴）也能用 4 钛板做，钛板只有流体固化器浇得出来；基地里没有任何钛。
    // 缺黑曜石粉时该报的是“缺黑曜石粉”，不是排一份“用熔融钛浇板”的计划
    s.world.boxes = [chest(without(P.obsidianDust))]
    const res = await s.plan(P.shaftShape)
    assert.deepEqual(res.plan.missing.map((m) => [m.ore, m.count]), [['dustObsidian', 2]])
    assert.equal(res.plan.steps.some((x) => x.input.recipe === R.castTitanPlate || x.input.recipe === R.shaftShapeTitan), false, res.content)
  })
})

describe('plan_item：看的是整个基地', () => {
  it('仓库在东边六十格、高炉在西边九十格（身体一次查询各只看得到三十到六十格）：照样都看得到，排得出来；再远就算没有', async (t) => {
    const far: Box = { x: 70, y: 64, z: -4, name: 'Compressed Chest', id: 'avaritiaddons:CompressedChest', items: [stack(P.darkDust, 4)] }
    const s = setup(t, { boxes: [far], machines: [BENDER, { ...furnace(), x: -80, z: 30 }] })
    const res = await s.plan(P.darkPlate, { count: 4 })
    assert.deepEqual(s.calls(res.plan), [
      ['withdraw_items', { container: { x: 70, y: 64, z: -4 }, items: [stack(P.darkDust, 4)] }],
      ['process_items', { machine: { x: -80, y: 64, z: 30 }, recipe: R.smeltDark, rounds: 4, wait: 510 }],
      ['process_items', { machine: at(BENDER), recipe: R.bendDark, rounds: 4 }],
    ])
    assert.equal(res.plan.feasible, true)
    // 三百格外的箱子不在这个基地里
    s.world.boxes = [{ ...far, x: 300 }]
    const gone = await s.plan(P.darkPlate, { count: 4 })
    assert.equal(gone.plan.feasible, false)
    assert.deepEqual(gone.plan.missing.map((m) => [m.ore, m.count]), [['ingotDarkSteel', 4]])
  })
})

describe('plan_item：大的计划', () => {
  it('上限：一条十几层的链只展开到第十层，说明没展开完、停在哪；层数少的照常排完', async (t) => {
    const s = setup(t, { boxes: [chest([stack(P.stick, 64), stack(P.link(12), 1)])] })
    const deep = await s.plan(P.link(0))
    assert.deepEqual([deep.plan.cutOff, deep.plan.feasible], [true, false])
    assert.deepEqual(deep.plan.missing.map((m) => [m.id, m.meta, m.count]), [['demo:link', 10, 1]])
    assert.match(deep.plan.missing[0]!.reason, /the plan was not worked out further down here \(it reached its size limit\)/)
    assert.match(deep.lines[0]!, /it CANNOT be finished yet: 1 thing\(s\) are missing, and the plan was cut off at its size limit\.$/)
    // 链节 9 到链节 0 一共十步合成，各要一根木棍
    assert.deepEqual(s.calls(deep.plan), [['withdraw_items', { container: CHEST, items: [stack(P.stick, 10)] }], ...[9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((n): [string, unknown] => ['craft_item', { recipe: R.link(n), count: 1 }])])

    const shallow = await s.plan(P.link(8))
    assert.deepEqual(s.calls(shallow.plan), [
      // 最底下那一节先用到，排在前面
      ['withdraw_items', { container: CHEST, items: [stack(P.link(12), 1), stack(P.stick, 4)] }],
      ...[11, 10, 9, 8].map((n): [string, unknown] => ['craft_item', { recipe: R.link(n), count: 1 }]),
    ])
    assert.deepEqual([shallow.plan.feasible, shallow.plan.cutOff], [true, false])
  })

  it('步骤多时一页一页给，开头写明一共多少步、这是第几页；一步放不下的量拆成几步；模头做多少个成品都只要 1 个；背包装不下时提醒分批', async (t) => {
    const s = setup(t, { boxes: [chest([stack(P.steelIngot, 4000), stack(P.steelScrew, 400), stack(P.steelGear, 100), stack(P.shaftShape, 1), stack(P.screwdriver, 1)])] })
    const res = await s.plan(P.blades, { count: 60 })
    // 240 根柄 × 9 锭；压模机一格放 64 个，一步最多 7 轮（63 锭）→ 35 步；模头（转轴）还是 1 个
    assert.deepEqual(res.plan.steps[0]!.input, { container: CHEST, items: [stack(P.steelIngot, 2160), stack(P.shaftShape, 1), stack(P.steelScrew, 180), stack(P.steelGear, 60), stack(P.screwdriver, 1)] })
    const shafts = res.plan.steps.filter((x) => x.input.recipe === R.shaft)
    assert.equal(shafts.length, 35)
    assert.deepEqual(shafts[0]!.input, { machine: at(EXTRUDER), recipe: R.shaft, rounds: 7, wait: 568 })
    assert.equal(shafts.reduce((n, x) => n + (x.input.rounds as number), 0), 240)
    assert.deepEqual(res.plan.steps.at(-1)!.input, { recipe: R.blades, count: 60 })
    assert.equal(res.plan.steps.length, 37)
    assert.equal(res.lines.find((l) => l.startsWith('STEPS'))!.split('.')[0], 'STEPS — steps 1–20 of 37 (page 1 of 2)')
    assert.equal(res.lines.at(-1), 'More steps follow: plan_item with the same arguments and page 2.')
    assert.ok(res.lines.includes('Fetching everything at once takes about 40 inventory slots and you have 36 free: do it a part at a time (make the sub-parts first), or empty your inventory.'), res.content)
    const second = await s.plan(P.blades, { count: 60, page: 2 })
    assert.equal(second.lines[0], 'Plan for 60× 直升机桨叶 [adventurebackpack:backpackComponent/6] — steps 21–37 of 37 (page 2 of 2):')
    assert.match(second.lines[1]!, /^21\. process_items /)
    const beyond = await s.plan(P.blades, { count: 60, page: 3 })
    assert.deepEqual([beyond.isError, beyond.content], [true, 'There is no page 3: the plan for 60× 直升机桨叶 [adventurebackpack:backpackComponent/6] has 37 step(s), 2 page(s).'])
  })

  it('问得不对、现场看不了时说清楚：不认识的物品、压根没有配方的东西、没连上游戏', async (t) => {
    const s = setup(t, { boxes: [chest(FULL)] })
    const unknown = await s.plan({ id: 'gregtech:gt.metaitem.01', meta: 99999 })
    assert.deepEqual([unknown.isError, unknown.content], [true, 'No item gregtech:gt.metaitem.01/99999 is known. Get the exact id and meta with find_item (many GregTech items share one id and differ only in meta).'])
    const raw = await s.plan(P.obsidianDust)
    assert.equal(raw.content, 'Plan for 1× 黑曜石粉 [gregtech:gt.metaitem.01/2804]: it CANNOT be made here: nothing in the recipe book makes it (a raw material: it has to be mined, bought or found).\nNote: 5× 黑曜石粉 already exist (5 in the container at (12,64,-4)); this plan makes new ones.')
    s.game.connected = false
    const offline = await s.plan(P.blades)
    assert.equal(offline.isError, true)
    assert.match(offline.content, /^The game could not be asked what is in storage \(disconnected: /)
  })
})
