// 配方册这一条路：找物品、查做法（按加工方式汇总、算每个成品耗多少、附近做不做得了、筛选和翻页）、查用途，
// 以及照一条配方去合成、去加工时交给身体的任务参数。
// 入口是模型用的工具；资料是一本自造的小配方册（fixture-recipes.ts）经 loadPackData 读进来的；游戏是按方法名应答的假服务器。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import { loadPackData } from '../src/packdata/index.ts'
import type { PackData } from '../src/packdata/index.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { useLocalNames } from '../src/tools/format.ts'
import { ALL_TOOLS, runTool } from '../src/tools/index.ts'
import type { ToolContext, ToolResult } from '../src/tools/index.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { MACHINES, RECIPE_LINES, writeRecipeFixture } from './fixture-recipes.ts'
import { tmpDir } from './helpers.ts'

const NOW = 1_800_000_000_000
/** 汇总的开头和结尾：按加工方式一种种列，说的是事实，不排好坏、不推荐。 */
const LISTED = "Listed by way of making, in the recipe book's order; what stands in your base for each way is stated, nothing is ranked or recommended:"
const FACTS_ONLY =
  '"CAN RUN NOW" states only this: a machine of that kind stands in the base, has power, is not switched off, and its tier (voltage, coil heat) covers the least demanding of those recipes. "CAN TRY" is a machine whose state cannot be read. Neither says anything about the ingredients (find_in_storage) or about which way is better; a fluid a recipe needs is stated in brackets after it, from what the machine\'s tanks or input hatches hold now. A recipe is used by its # number: craft_item or process_items.'
/** 游戏标成“NEI 里显示用”的配方后面带的标记是什么意思：结果里说一次。 */
const NEI_DISPLAY =
  '[NEI display]: the game marks these recipes as shown in NEI for display — the machine finds what to make its own way, not by matching this exact line (a cutting machine shows one line per coolant). They are what a player sees in NEI for the thing, and process_items can try them like any other.'
const PLATE = { id: 'gregtech:gt.metaitem.01', meta: 17305 }
const HAMMER = { id: 'gregtech:gt.metatool.01', meta: 12 }

function setup(t: { after(fn: () => void): void }, opts: { inventory?: { id: string; meta?: number; count: number }[] } = {}) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  writeRecipeFixture(tmp.dir)
  const lines: string[] = []
  const packdata: PackData = loadPackData(tmp.dir, (line) => lines.push(line))
  t.after(() => packdata.recipes?.close())
  // 服务器回来的东西也用这本物品表的中文名（大脑启动时就是这么设的）
  useLocalNames(packdata.items)
  t.after(() => useLocalNames(undefined))
  const game = new FakeGame()
  const status = game.handlers['bot.status']!
  game.handlers['bot.status'] = (p) => ({ ...(status(p) as object), inventory: (opts.inventory ?? []).map((i, slot) => ({ slot, meta: 0, name: 'whatever the server calls it', ...i })) })
  game.handlers['world.machines'] = () => ({ machines: MACHINES, total: MACHINES.length })
  game.handlers['world.find'] = () => ({ matches: [{ x: 8, y: 64, z: -4, id: 'minecraft:crafting_table', meta: 0, dist: 3 }], total: 1 })
  const ctx: ToolContext = {
    botName: 'Alu',
    bridge: new BridgeApi(game),
    memory: new MemoryStore(tmp.dir, () => 300),
    manuals: new ManualStore(DEFAULT_MANUALS_DIR, `${tmp.dir}/manuals`),
    packdata,
    reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
    hooks: {},
    now: () => NOW,
  }
  const run = (name: string, input: unknown = {}): Promise<ToolResult> => runTool(ALL_TOOLS, ctx, name, input, { maxResultChars: 6000 })
  /** 最后一次交给身体的任务。 */
  const lastTask = (): Record<string, unknown> => game.callsOf('task.start').at(-1)!.task as Record<string, unknown>
  return { game, packdata, lines, run, lastTask }
}

describe('配方册：读进来', () => {
  it('启动时读一遍建索引：游戏标成“NEI 里显示用”的配方照常进索引、照常读得到（带着这个标记），日志里说有几条；坏行跳过并说明，编号就是行号', (t) => {
    const s = setup(t)
    assert.ok(s.lines.includes('物品表：52 种物品。'), s.lines.join('\n'))
    const loaded = s.lines.find((l) => l.startsWith('配方册：'))!
    assert.match(loaded, /^配方册：30 条配方、11 个配方页，做得出 13 种物品（读了 \d+ 毫秒；其中 2 条游戏标成了“NEI 里显示用的”，照常查得到；1 行认不出来，跳过了）。$/)
    const book = s.packdata.recipes!
    assert.equal(book.size, RECIPE_LINES.length)
    // 钢板：0–5 这六条做它；第 5 条（板材切割机）是游戏标了 fake 的，一样在里面
    assert.deepEqual([...book.makesOf(PLATE.id, PLATE.meta)], [0, 1, 2, 3, 4, 5])
    assert.deepEqual([book.get(5)?.fake, book.get(5)?.handler.name, book.get(5)?.fin, book.get(0)?.fake], [true, '板材切割机', [{ f: 'water', name: '水', mb: 52 }], undefined])
    // 钢块能拿来做什么：也查得到那一条
    assert.deepEqual([...book.usesOf('gregtech:gt.blockmetal6', 13)], [5])
    assert.equal(book.get(26), undefined)
    assert.equal(book.get(999), undefined)
    const hammered = book.get(2)!
    assert.deepEqual([hammered.ref, hammered.handler.name, hammered.in, hammered.out, hammered.eut, hammered.ticks], [2, '锻造锤', [{ kind: 'item', id: PLATE.id, meta: 11305, n: 3 }], [{ id: PLATE.id, meta: 17305, n: 2 }], 16, 56])
    // 用到钢锭的：点名要它的（0、1、2、4），加上要“任何 ingotSteel”的那条手工配方（3）
    assert.deepEqual(book.usesOf(PLATE.id, 11305, ['ingotSteel']), [0, 1, 2, 3, 4])
    assert.deepEqual(book.usesOf(PLATE.id, 11305), [0, 1, 2, 4])
  })

  it('没有配方册、配方册读不了时照常起来，说明原因', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const lines: string[] = []
    assert.equal(loadPackData(tmp.dir, (l) => lines.push(l)).recipes, undefined)
    assert.ok(lines.includes('没有配方册（recipes.jsonl），查做法、查用途退回去问服务器（只有英文，也不全）。'), lines.join('\n'))
  })
})

describe('find_item：找物品', () => {
  it('中文名、英文名、id、矿辞名都能搜；名字正好对上的排最前；带上有几条配方做它、用它', async (t) => {
    const s = setup(t)
    const zh = (await s.run('find_item', { query: '钢板' })).content.split('\n')
    assert.equal(zh[0], '"钢板" matches 3 item(s), most alike first.')
    // 正好叫“钢板”的在最前；“钢板标牌”以它开头，排在“玄钢板”前面
    assert.deepEqual(zh.slice(1).map((l) => l.split(':')[0]), ['- 钢板 [gregtech', '- 钢板标牌 [demo', '- 玄钢板 [gregtech'])
    // 做钢板的六条里有一条是板材切割机的（游戏标成“NEI 里显示用的”）：照常算数
    assert.equal(zh[1], '- 钢板 [gregtech:gt.metaitem.01/17305]: 6 recipe(s) make it; used in 3; ore names: plateSteel')
    // 拿英文搜：结果里带上英文名
    const en = await s.run('find_item', { query: 'steel plate' })
    assert.match(en.content, /^"steel plate" matches 2 item\(s\), most alike first\.\n- 钢板 \[gregtech:gt\.metaitem\.01\/17305\] \(Steel Plate\): /)
    assert.match((await s.run('find_item', { query: 'craftingToolHardHammer' })).content, /- 锤 \[gregtech:gt\.metatool\.01\/12\]: 12 recipe\(s\) make it; used in 1; ore names: craftingToolHardHammer; 3 variants that differ only in their data/)
    assert.match((await s.run('find_item', { query: 'metaitem.01/2364' })).content, /^"metaitem\.01\/2364" matches 1 item\(s\), most alike first\.\n- 玄钢粉 /)
    // 两个都叫“玄钢锭”：带英文名好区分
    const twins = (await s.run('find_item', { query: '玄钢锭' })).content
    assert.match(twins, /- 玄钢锭 \[gregtech:gt\.metaitem\.01\/11364\] \(Dark Steel Ingot\): /)
    assert.match(twins, /- 玄钢锭 \[EnderIO:itemAlloy\/6\] \(Dark Steel\): 2 recipe\(s\) make it/)
  })

  it('结果多时一页一页给，写明一共多少、这是第几个到第几个；没有对上的也说清楚', async (t) => {
    const s = setup(t)
    const first = await s.run('find_item', { query: '锭', limit: 5 })
    // 17 种锭：钢锭、精炼铁锭、铁锭、两个玄钢锭，加十二种材质的
    assert.match(first.content, /^"锭" matches 17 items; these are 1–5, most alike first \(page 1 of 4\)\. Add a word to narrow it, or ask for the next page\.\n/)
    assert.equal(first.content.split('\n').length, 6)
    const last = await s.run('find_item', { query: '锭', limit: 5, page: 4 })
    assert.match(last.content, /^"锭" matches 17 items; these are 16–17, most alike first \(page 4 of 4\)/)
    assert.equal(last.content.split('\n').length, 3)
    const beyond = await s.run('find_item', { query: '锭', limit: 5, page: 5 })
    assert.deepEqual([beyond.isError, beyond.content], [true, '"锭" matches 17 item(s): there is no page 5 (4 page(s)).'])
    assert.match((await s.run('find_item', { query: '不存在的东西' })).content, /^No item or fluid matches "不存在的东西"\. Try fewer or other words/)
  })
})

describe('find_recipes：查做法', () => {
  it('先按加工方式汇总：每种几条、每个成品耗多少料、电压和时长、要不要电路和模具；照配方册的先后列，不排好坏；重复的合并；游戏标成“NEI 里显示用”的照常列、带着标记，那是什么意思在末尾说一次', async (t) => {
    const s = setup(t)
    const res = await s.run('find_recipes', PLATE)
    assert.equal(res.isError, undefined, res.content)
    assert.deepEqual(res.content.split('\n'), [
      '钢板 [gregtech:gt.metaitem.01/17305] can be made 5 way(s), 5 recipe(s) in all (1 exact duplicate(s) in the book are merged). ' + LISTED,
      // 卷板机：1 锭出 1 板，附近那台有电
      '1. 卷板机 — 1 recipe(s); CAN RUN NOW on 基础卷板机 at (16,64,-4) LV',
      '   #0: 1× 钢锭 [gregtech:gt.metaitem.01/11305] (or any ingotSteel); needs programmed circuit 1 → 1× 钢板 — LV (24 EU/t), 2.8 s',
      // 锻造锤：3 锭出 2 板，每个板 1.5 锭；附近那台没电
      '2. 锻造锤 — 1 recipe(s); machine here but not usable now: 基础锻造锤 at (18,64,-4) LV: NO POWER',
      '   #2: 3× 钢锭 [gregtech:gt.metaitem.01/11305] (or any ingotSteel) → 2× 钢板 (per 钢板: 1.5 钢锭) — LV (16 EU/t), 2.8 s',
      // 手工锤：2 锭出 1 板；照实说它要工具（用不用由它自己定）
      // 要工作台的只说附近有、离多远，不给坐标（合成时由 craft_item 找离它那时最近的）
      '3. 有序合成 — 1 recipe(s); CAN CRAFT NOW (needs a crafting table, the nearest 2 block(s) from here; craft_item walks to the nearest one by itself); uses hand tools (not used up, but they wear)',
      '   #3: 2× any ingotSteel (e.g. 钢锭 [gregtech:gt.metaitem.01/11305]); needs tool any craftingToolHardHammer (e.g. 锤 [gregtech:gt.metatool.01/12]) (worn, not used up) → 1× 钢板 — needs a crafting table (3x3)',
      '4. 合金炉 — 1 recipe(s); no such machine within 112 blocks',
      '   #4: 2× 钢锭 [gregtech:gt.metaitem.01/11305] (or any ingotSteel); needs 模具（板） [gregtech:gt.metaitem.01/32301] (stays in the machine, not used up) → 1× 钢板 — LV (30 EU/t), 5.6 s',
      // 板材切割机：游戏把这一页的配方都标成“NEI 里显示用的”。它照常列出来，行尾带着标记
      '5. 板材切割机 — 1 recipe(s); no such machine within 112 blocks',
      '   #5: 1× 钢块 [gregtech:gt.blockmetal6/13] + 52 mB 水 (fluid) → 9× 钢板 (per 钢板: 0.11 钢块 + 5.78 mB 水) — LV (30 EU/t), 56 s [NEI display]',
      NEI_DISPLAY,
      FACTS_ONLY,
    ])
    // 看了一眼基地里的机器和工作台。基地常常比身体一次查询的范围大（仓库在这头，高炉在那头）：
    // 以它站的地方 (10,64,-4) 为中心，往四个斜方向各错开一点各查一次，合起来每个方向看得到一百来格
    const around = (step: number) => [[-step, -step], [-step, step], [step, -step], [step, step]].map(([dx, dz]) => ({ x: 10 + dx!, y: 64, z: -4 + dz!, dim: 0 }))
    assert.deepEqual(s.game.callsOf('world.machines'), around(48).map((at) => ({ ...at, radius: 64, limit: 60 })))
    // 身体自己会去找的四种合成台都认
    assert.deepEqual(s.game.callsOf('world.find'), around(40).map((at) => ({ ...at, blocks: ['minecraft:crafting_table', 'TConstruct:CraftingStation', 'TConstruct:CraftingSlab', 'Natura:Natura.workbench'], radius: 48, limit: 4 })))
  })

  it('主人问“钻石板够不够材料做”，它查钻石板的做法：配方册里只有板材切割机那一条（游戏标成“NEI 里显示用的”），照样给出来——1 钻石块 + 720 mB 水出 9 个；照这个编号能开机器；钻石块能做什么也查得到它', async (t) => {
    const s = setup(t)
    const DIAMOND_PLATE = { id: 'gregtech:gt.metaitem.01', meta: 17500 }
    const res = await s.run('find_recipes', DIAMOND_PLATE)
    assert.equal(res.isError, undefined, res.content)
    assert.deepEqual(res.content.split('\n'), [
      '钻石板 [gregtech:gt.metaitem.01/17500] can be made 1 way(s), 1 recipe(s) in all. ' + LISTED,
      '1. 板材切割机 — 1 recipe(s); no such machine within 112 blocks',
      '   #30: 1× 钻石块 [minecraft:diamond_block] + 720 mB 水 (fluid) → 9× 钻石板 (per 钻石板: 0.11 钻石块 + 80 mB 水) — LV (30 EU/t), 648 s [NEI display]',
      NEI_DISPLAY,
      FACTS_ONLY,
    ])
    // 一条条看的时候也在，同样带着标记和那句话
    assert.deepEqual((await s.run('find_recipes', { ...DIAMOND_PLATE, way: '板材切割机' })).content.split('\n'), [
      '钻石板 [gregtech:gt.metaitem.01/17500]: 1 recipe(s).',
      '#30: 1× 钻石块 [minecraft:diamond_block] (you carry 0) + 720 mB 水 (fluid) → 9× 钻石板 (per 钻石板: 0.11 钻石块 + 80 mB 水) — LV (30 EU/t), 648 s [NEI display]',
      NEI_DISPLAY,
      'Use a recipe by its # number: craft_item (hand crafting) or process_items (machine).',
    ])
    // 找物品时的“几条配方做它”把它算上了
    assert.equal((await s.run('find_item', { query: '钻石板' })).content.split('\n')[1], '- 钻石板 [gregtech:gt.metaitem.01/17500]: 1 recipe(s) make it; used in none; ore names: plateDiamond')
    // 照这条配方的编号开机器：不因为它带着标记就不让试
    const started = await s.run('process_items', { machine: { x: 30, y: 64, z: 0 }, recipe: 30, rounds: 2 })
    assert.equal(started.isError, undefined, started.content)
    assert.match(started.content, / This recipe also takes 1440 mB 水 in all, from inside the machine/)
    assert.deepEqual([s.lastTask().inputs, s.lastTask().expect], [[{ id: 'minecraft:diamond_block', meta: 0, count: 2 }], [{ id: 'gregtech:gt.metaitem.01', meta: 17500, count: 18 }]])
    // 钻石块能拿来做什么：这一条，数据里写着这个事实
    const uses = await s.run('find_uses', { id: 'minecraft:diamond_block', way: '板材切割机' })
    assert.deepEqual(uses.content.split('\n'), [
      'Recipes that use 钻石块 [minecraft:diamond_block]: 1 recipe(s).',
      '#30: 1× 钻石块 [minecraft:diamond_block] + 720 mB 水 (fluid) → 9× 钻石板 — LV (30 EU/t), 648 s [NEI display]',
      NEI_DISPLAY,
    ])
    assert.equal((uses.data as { recipes: { fake?: boolean }[] }).recipes[0]!.fake, true)
  })

  it('手工配方和机器配方都做得了时：不替它排先后，两边每个成品耗多少都写着（手工搅粉出 2 个，搅拌机同样的料出 3 个）', async (t) => {
    const s = setup(t)
    s.game.handlers['world.machines'] = () => ({
      machines: [...MACHINES, { x: 20, y: 64, z: -4, name: 'Basic Mixer', id: 'gregtech:gt.blockmachines', meta: 581, recipes: 'Mixer', recipeKey: 'gt.recipe.mixer', tier: 'LV', inputSlots: 6, active: false, storedEU: 5000, inputVoltage: 32, dist: 9 }],
      total: MACHINES.length + 1,
    })
    assert.deepEqual((await s.run('find_recipes', { id: 'gregtech:gt.metaitem.01', meta: 2364 })).content.split('\n').slice(1, 5), [
      '1. 无序合成 — 1 recipe(s); CAN CRAFT NOW in your own 2x2 grid (no table needed)',
      '   #28: 1× 磁钢粉 [gregtech:gt.metaitem.01/2365] + 1× any dustCoal (e.g. 煤粉 [gregtech:gt.metaitem.01/2535]) + 1× any dustObsidian (e.g. 黑曜石粉 [gregtech:gt.metaitem.01/2804]) → 2× 玄钢粉 (per 玄钢粉: 0.5 磁钢粉 + 0.5 any dustCoal (e.g. 煤粉) + 0.5 any dustObsidian (e.g. 黑曜石粉)) — fits your 2x2 grid',
      '2. 搅拌机 — 1 recipe(s); CAN RUN NOW on 基础搅拌机 at (20,64,-4) LV',
      '   #29: 1× 磁钢粉 [gregtech:gt.metaitem.01/2365] + 1× 煤粉 [gregtech:gt.metaitem.01/2535] + 1× 黑曜石粉 [gregtech:gt.metaitem.01/2804]; needs programmed circuit 2 → 3× 玄钢粉 (per 玄钢粉: 0.33 磁钢粉 + 0.33 煤粉 + 0.33 黑曜石粉) — ULV (7 EU/t), 5 s',
    ])
  })

  it('机器的状况逐条比：电压不够、炉温不够、结构没搭好、被关了，都说出是哪台、差在哪', async (t) => {
    const s = setup(t)
    // 高炉炉温 1801 K：要 1800 K 的那条做得了，要 2200 K 的那条做不了
    const ingot = (await s.run('find_recipes', { id: 'EnderIO:itemAlloy', meta: 6 })).content.split('\n')
    assert.equal(ingot[1], '1. 工业高炉 — 2 recipe(s); CAN RUN NOW on 工业高炉 at (-5,64,9) HV')
    assert.equal(ingot[2], '   #6: 1× 玄钢粉 [gregtech:gt.metaitem.01/2364] + 1000 mB 氧气 (fluid); needs programmed circuit 11 → 1× 玄钢锭 — MV (120 EU/t), 50 s, coil heat 1800 K [the input hatches of the 工业高炉 at (-5,64,9) now hold 8000 mB 氧气 (one round takes 1000)]')
    assert.match(ingot[3]!, /^ {3}#7: .* coil heat 2200 K \[NOT on the machine\(s\) here: the recipe needs 2200 K, its coils reach 1801 K\]$/)

    const judge = async (machine: Record<string, unknown>): Promise<string> => {
      s.game.handlers['world.machines'] = () => ({ machines: [{ ...MACHINES[2], ...machine }], total: 1 })
      return (await s.run('find_recipes', { id: 'EnderIO:itemAlloy', meta: 6 })).content.split('\n')[1]!
    }
    assert.equal(await judge({ inputVoltage: 32, tier: 'LV' }), '1. 工业高炉 — 2 recipe(s); machine here but not usable now: 工业高炉 at (-5,64,9) LV: the recipe needs MV, it is LV')
    assert.equal(await judge({ formed: false, idleReason: 'Incomplete Structure' }), '1. 工业高炉 — 2 recipe(s); machine here but not usable now: 工业高炉 at (-5,64,9) HV: its structure is not complete (Incomplete Structure)')
    assert.equal(await judge({ switchedOff: true }), '1. 工业高炉 — 2 recipe(s); machine here but not usable now: 工业高炉 at (-5,64,9) HV: switched off')
    assert.equal(await judge({ heat: 1500 }), '1. 工业高炉 — 2 recipe(s); machine here but not usable now: 工业高炉 at (-5,64,9) HV: the recipe needs 1800 K, its coils reach 1500 K')
    // 只凭配方页的 recipeKey 也认得出这台机器跑这类配方（id/meta 不在页的机器表里）
    assert.equal(await judge({ id: 'gregtech:gt.blockmachines', meta: 9999 }), '1. 工业高炉 — 2 recipe(s); CAN RUN NOW on 工业高炉 at (-5,64,9) HV')
    assert.equal(await judge({ recipeKey: 'gt.recipe.other', meta: 9999 }), '1. 工业高炉 — 2 recipe(s); no such machine within 112 blocks')
  })

  it('手工合成：附近没有工作台时说要工作台，摆得进 2×2 的不用；身体不认识的机器（熔炉）附近有就说可以试、怎么试；没连上游戏时照样给配方', async (t) => {
    const s = setup(t)
    s.game.handlers['world.find'] = () => ({ matches: [], total: 0 })
    assert.equal((await s.run('find_recipes', { id: 'Backpack:backpack' })).content.split('\n')[1], '1. 有序合成 — 1 recipe(s); needs a crafting table: none within 88 blocks')
    const pocket = (await s.run('find_recipes', { id: 'demo:plateOnAStick' })).content.split('\n')
    assert.equal(pocket[1], '1. 无序合成 — 1 recipe(s); CAN CRAFT NOW in your own 2x2 grid (no table needed)')
    // 一次出 2 个：每个耗半份料
    assert.equal(pocket[2], '   #10: 1× 钢板 [gregtech:gt.metaitem.01/17305] + 1× any stickWood (e.g. 木棍 [minecraft:stick]) → 2× 钢板标牌 (per 钢板标牌: 0.5 钢板 + 0.5 any stickWood (e.g. 木棍)) — fits your 2x2 grid')
    // 熔炉不是身体认识的机器（world.machines 里没有它）。附近没有熔炉：没有这种机器
    assert.equal((await s.run('find_recipes', { id: 'minecraft:iron_ingot' })).content.split('\n')[1], '1. 烧制 — 1 recipe(s); no such machine within 112 blocks')
    // 附近有一个（正烧着的熔炉是另一个方块 id）：配方册说“烧制”这一页的机器是熔炉，世界里那个容器就是一台——可以试
    s.game.handlers['world.containers'] = () => ({ containers: [{ x: 14, y: 64, z: -4, id: 'minecraft:lit_furnace', name: 'Furnace', slots: 3, usedSlots: 1, items: [{ id: 'minecraft:coal', meta: 1, count: 3, name: 'Charcoal' }] }], total: 1, offset: 0 })
    assert.equal(
      (await s.run('find_recipes', { id: 'minecraft:iron_ingot' })).content.split('\n')[1],
      '1. 烧制 — 1 recipe(s); CAN TRY on 熔炉 at (14,64,-4): its state cannot be read (not a machine the body knows): it is used the way a player would — inputs in, wait, products out; if it needs fuel or anything else the recipe does not list, add that to "inputs"',
    )
    // 照这条配方用它：和别的机器一样，给机器的位置和配方编号（没有编程电路）
    await s.run('process_items', { machine: { x: 14, y: 64, z: -4 }, recipe: 24, rounds: 4 })
    assert.deepEqual(s.lastTask(), { type: 'process', machine: { x: 14, y: 64, z: -4 }, inputs: [{ id: 'gregtech:gt.metaitem.01', meta: 2032, count: 4 }], expect: [{ id: 'minecraft:iron_ingot', meta: 0, count: 4 }] })
    s.game.handlers['world.containers'] = () => ({ containers: [], total: 0, offset: 0 })
    // 要工具的配方照实说要工具
    assert.equal((await s.run('find_recipes', { id: 'adventurebackpack:backpackComponent', meta: 6 })).content.split('\n')[1], '1. 有序合成 — 1 recipe(s); needs a crafting table: none within 88 blocks; uses hand tools (not used up, but they wear)')

    s.game.connected = false
    const offline = (await s.run('find_recipes', PLATE)).content.split('\n')
    assert.equal(offline[1], '(Which machines and crafting tables are around you could not be checked: disconnected: bridge is not connected to the game server.)')
    assert.equal(offline[2], '1. 卷板机 — 1 recipe(s); machine recipe')
    // 五种做法各两行（那种做法、它的一条配方），加开头两行、“NEI 里显示用的”那一句、末尾一句
    assert.equal(offline.length, 14)
  })

  it('同一种东西有两个 id（玄钢锭）：查哪个都给出做法，说明它们可以互换', async (t) => {
    const s = setup(t)
    const gt = (await s.run('find_recipes', { id: 'gregtech:gt.metaitem.01', meta: 11364 })).content.split('\n')
    assert.equal(
      gt[0],
      '玄钢锭 [gregtech:gt.metaitem.01/11364] can be made 1 way(s), 2 recipe(s) in all. Recipes that make 玄钢锭 [EnderIO:itemAlloy/6] are included: under the ore name ingotDarkSteel it is the same thing (GregTech machines and "any ingotDarkSteel" recipes take either). ' + LISTED,
    )
    assert.match(gt[2]!, /^ {3}#6: 1× 玄钢粉 /)
    // 机器配方里点名的是另一个 id：写明同名矿辞下的都行
    assert.match((await s.run('find_recipes', { id: 'gregtech:gt.metaitem.01', meta: 17364 })).content, /#8: 1× 玄钢锭 \[EnderIO:itemAlloy\/6\] \(or any ingotDarkSteel\); needs programmed circuit 1 → 1× 玄钢板/)
  })

  it('一种方式下配方很多（每种材质一把锤子）：汇总里只举例并说明还有多少；按方式、按“原料里含某物”筛，翻页，总数和这是第几页都写明', async (t) => {
    const s = setup(t, { inventory: [{ id: 'demo:ingot', meta: 3, count: 9 }, { id: 'minecraft:stick', count: 2 }] })
    const summary = (await s.run('find_recipes', HAMMER)).content.split('\n')
    assert.equal(summary[0], '锤 [gregtech:gt.metatool.01/12] can be made 1 way(s), 12 recipe(s) in all. ' + LISTED)
    assert.equal(summary[1], '1. 有序合成 — 12 recipe(s); CAN CRAFT NOW (needs a crafting table, the nearest 2 block(s) from here; craft_item walks to the nearest one by itself)')
    assert.match(summary[2]!, /^ {3}#12: 6× 铜锭 \[demo:ingot\] \+ 1× any stickWood \(e\.g\. 木棍 \[minecraft:stick\]\) → 1× 锤 — needs a crafting table \(3x3\)$/)
    assert.equal(summary[4], '   … 10 more recipe(s) of this way are not shown (often one per material). See them with way "有序合成", narrowed with "contains" (a word of an ingredient), page by page.')

    // 含“钢”的：两条；带着身上有多少
    const steel = (await s.run('find_recipes', { ...HAMMER, contains: '钢' })).content.split('\n')
    assert.deepEqual(steel, [
      '锤 [gregtech:gt.metatool.01/12] with an ingredient containing "钢": 2 recipe(s).',
      '#15: 6× 钢质锭 [demo:ingot/3] (you carry 9) + 1× any stickWood (e.g. 木棍 [minecraft:stick]) (you carry 2) → 1× 锤 — needs a crafting table (3x3)',
      '#23: 6× 钨钢锭 [demo:ingot/11] (you carry 0) + 1× any stickWood (e.g. 木棍 [minecraft:stick]) (you carry 2) → 1× 锤 — needs a crafting table (3x3)',
      'Use a recipe by its # number: craft_item (hand crafting) or process_items (machine).',
    ])
    // 按方式看全部：12 条，一页 10 条
    const page1 = (await s.run('find_recipes', { ...HAMMER, way: '有序合成' })).content.split('\n')
    assert.equal(page1[0], '锤 [gregtech:gt.metatool.01/12]: recipes 1–10 of 12 (page 1 of 2).')
    assert.deepEqual(page1.slice(1, 11).map((l) => l.split(':')[0]), ['#12', '#13', '#14', '#15', '#16', '#17', '#18', '#19', '#20', '#21'])
    const page2 = (await s.run('find_recipes', { ...HAMMER, page: 2 })).content.split('\n')
    assert.equal(page2[0], '锤 [gregtech:gt.metatool.01/12]: recipes 11–12 of 12 (page 2 of 2).')
    assert.deepEqual(page2.slice(1, 3).map((l) => l.split(':')[0]), ['#22', '#23'])
    const beyond = await s.run('find_recipes', { ...HAMMER, page: 3 })
    assert.deepEqual([beyond.isError, beyond.content], [true, 'There is no page 3: 12 recipe(s), 2 page(s).'])
    // 用配方页的编号、页名的一部分也挑得出方式
    assert.match((await s.run('find_recipes', { ...PLATE, way: 'gt.recipe.hammer' })).content, /^钢板 \[gregtech:gt\.metaitem\.01\/17305\] by "锻造锤": 1 recipe\(s\)/)
    assert.match((await s.run('find_recipes', { ...PLATE, way: '卷板' })).content, / by "卷板机": 1 recipe\(s\) \(1 exact duplicate/)
  })

  it('问得不对时说清楚：没有这种方式（列出有哪些）、筛完一条不剩、物品不存在、它没有配方', async (t) => {
    const s = setup(t)
    const way = await s.run('find_recipes', { ...PLATE, way: '车床' })
    assert.deepEqual([way.isError, way.content], [true, '钢板 [gregtech:gt.metaitem.01/17305] is not made by any way matching "车床". Its ways: "卷板机" (1), "锻造锤" (1), "有序合成" (1), "合金炉" (1), "板材切割机" (1).'])
    assert.equal((await s.run('find_recipes', { ...PLATE, contains: '铜' })).content, 'No recipe for 钢板 [gregtech:gt.metaitem.01/17305] with an ingredient containing "铜" (5 recipe(s) before the "contains" filter; 5 in all). Try another word: part of an ingredient\'s Chinese or English name, id or ore name.')
    const unknown = await s.run('find_recipes', { id: 'gregtech:gt.metaitem.01', meta: 99999 })
    assert.deepEqual([unknown.isError, unknown.content], [true, 'No item gregtech:gt.metaitem.01/99999 is known. Get the exact id and meta with find_item (many GregTech items share one id and differ only in meta).'])
    // 配方册里没有它的配方：只陈述这一点（配方册是这个客户端的 NEI 导出来的），不替它担保“这东西做不出来”
    assert.equal((await s.run('find_recipes', { id: 'Backpack:tannedLeather' })).content, "The recipe book has no recipe that makes 鞣制皮革 [Backpack:tannedLeather] (the recipe book is what this client's NEI shows, exported). The library function find_uses shows what it is used for.")
  })
})

describe('find_uses：查用途', () => {
  it('这个物品能做什么：按方式汇总各有几条、举几个产物；按方式和产物筛着看具体的', async (t) => {
    const s = setup(t)
    assert.deepEqual((await s.run('find_uses', PLATE)).content.split('\n'), [
      '钢板 [gregtech:gt.metaitem.01/17305] is an ingredient of 3 recipe(s), in 3 way(s) (the same recipe can be listed more than once in the book):',
      '- 无序合成: 1 recipe(s), e.g. makes 钢板标牌',
      '- 组装机: 1 recipe(s), e.g. makes 钢机器外壳',
      '- 研磨机: 1 recipe(s), e.g. makes 钢粉',
      'See the recipes with "way" (one of the names above), narrowed with "contains" (a word of the product or of another ingredient) and "circuit" (the programmed circuit number), page by page.',
    ])
    // 钢锭：点名要它的机器配方，和要“任何 ingotSteel”的手工配方都算
    const ingot = (await s.run('find_uses', { id: 'gregtech:gt.metaitem.01', meta: 11305 })).content
    assert.match(ingot, /^钢锭 \[gregtech:gt\.metaitem\.01\/11305\] is an ingredient of 5 recipe\(s\), in 4 way\(s\)/)
    assert.match(ingot, /\n- 有序合成: 1 recipe\(s\), e\.g\. makes 钢板\n/)
    // 另一个 id 的玄钢锭：卷板机配方点名的是 EnderIO 那个，也算用到它
    assert.match((await s.run('find_uses', { id: 'gregtech:gt.metaitem.01', meta: 11364 })).content, /^玄钢锭 \[gregtech:gt\.metaitem\.01\/11364\] is an ingredient of 1 recipe\(s\), in 1 way\(s\)[^\n]*\n- 卷板机: 1 recipe\(s\), e\.g\. makes 玄钢板/)

    const casing = (await s.run('find_uses', { ...PLATE, contains: '外壳' })).content.split('\n')
    assert.deepEqual(casing, [
      'Recipes that use 钢板 [gregtech:gt.metaitem.01/17305] whose product or other ingredient contains "外壳": 1 recipe(s).',
      // 没指定方式时，每条前面写着它是哪种方式的
      '[组装机] #25: 8× 钢板 [gregtech:gt.metaitem.01/17305]; needs programmed circuit 1 → 1× 钢机器外壳 — LV (15 EU/t), 2.5 s',
    ])
    // 副产物有概率的写出来
    assert.match((await s.run('find_uses', { ...PLATE, way: '研磨机' })).content, /#27: 1× 钢板 .* → 1× 钢粉, 1× 小撮钢粉 \(10% chance\) — ULV \(2 EU\/t\), 5 s/)
    assert.equal((await s.run('find_uses', { id: 'Backpack:backpack' })).content, 'Nothing in the recipe book uses 小背包 [Backpack:backpack] as an ingredient.')
    const none = await s.run('find_uses', { ...PLATE, way: '高炉' })
    assert.deepEqual([none.isError, none.content], [true, '钢板 [gregtech:gt.metaitem.01/17305] is not used by any way matching "高炉". Ways that use it: "无序合成" (1), "组装机" (1), "研磨机" (1).'])
  })
})

describe('craft_item：照配方册里的配方手工合成', () => {
  it('有序合成：每样原料摆在配方册说的那一格，矿辞名的格子交给身体认（工具也是）；要几个就做几轮', async (t) => {
    const s = setup(t)
    // 它查做法时旁边的工作台在 (8,64,-4)；后来走到别处去取料，动手合成时最近的是另一个
    s.game.handlers['world.find'] = () => ({ matches: [{ x: -503, y: 69, z: 105, id: 'TConstruct:CraftingStation', meta: 0, dist: 2 }], total: 2 })
    const res = await s.run('craft_item', { recipe: 9 })
    assert.match(res.content, /^Task t1 \(craft\) started\./)
    const shaft = { id: 'IC2:itemRecipePart', meta: 12 }
    const screw = { id: 'gregtech:gt.metaitem.01', meta: 27305 }
    assert.deepEqual(s.lastTask(), {
      type: 'craft',
      // 3×3 一行一行数：柄 螺丝 柄 / 螺丝 齿轮 螺丝 / 柄 螺丝刀 柄
      grid: [shaft, screw, shaft, screw, { id: 'gregtech:gt.metaitem.02', meta: 31305 }, screw, shaft, { ore: 'craftingToolScrewdriver' }, shaft],
      gives: { id: 'adventurebackpack:backpackComponent', meta: 6 },
      rounds: 1,
      // 没指定工作台：用的是动手这一刻离它最近的那个（身体认的四种都找），不是早先查做法时看到的
      table: { x: -503, y: 69, z: 105 },
    })
    assert.deepEqual(s.game.callsOf('world.find').at(-1), { x: 50, y: 64, z: 36, dim: 0, blocks: ['minecraft:crafting_table', 'TConstruct:CraftingStation', 'TConstruct:CraftingSlab', 'Natura:Natura.workbench'], radius: 48, limit: 1 })
    // 排队的不知道轮到时它在哪：不替它定，留给身体到时自己找最近的
    await s.run('craft_item', { recipe: 9, queue: true })
    assert.equal('table' in s.lastTask(), false)
    // 附近找不到工作台：照样开工，由身体去找（找不到它会说）
    s.game.handlers['world.find'] = () => ({ matches: [], total: 0 })
    await s.run('craft_item', { recipe: 9 })
    assert.equal('table' in s.lastTask(), false)
    // 钢板的手工配方只占左边一列；要 3 个就是 3 轮；指定工作台
    await s.run('craft_item', { recipe: 3, count: 3, table: { x: 8, y: 64, z: -4 }, queue: true })
    assert.deepEqual(s.lastTask(), {
      type: 'craft',
      grid: [{ ore: 'craftingToolHardHammer' }, null, null, { ore: 'ingotSteel' }, null, null, { ore: 'ingotSteel' }, null, null],
      gives: PLATE,
      rounds: 3,
      table: { x: 8, y: 64, z: -4 },
    })
    assert.equal(s.game.callsOf('task.start').at(-1)!.mode, 'append')
  })

  it('无序合成从头往后摆；一轮出 2 个时要 5 个就做 3 轮；三四样原料摆成 2×2（身体在随身的合成格里就能做，和查做法时说的一致）', async (t) => {
    const s = setup(t)
    await s.run('craft_item', { recipe: 10, count: 5 })
    assert.deepEqual(s.lastTask(), { type: 'craft', grid: [PLATE, { ore: 'stickWood' }, null, null, null, null, null, null, null], gives: { id: 'demo:plateOnAStick', meta: 0 }, rounds: 3 })
    // 三样粉：占左上角的 2×2（第一行两格，第二行一格），不是横着一排三个
    await s.run('craft_item', { recipe: 28 })
    assert.deepEqual(s.lastTask().grid, [{ id: 'gregtech:gt.metaitem.01', meta: 2365 }, { ore: 'dustCoal' }, null, { ore: 'dustObsidian' }, null, null, null, null, null])
  })

  it('不是手工配方、编号不对、一次要得太多：不开任务，说清原因', async (t) => {
    const s = setup(t)
    const refused = async (input: unknown, why: string) => {
      const res = await s.run('craft_item', input)
      assert.deepEqual([res.isError, res.content], [true, why])
    }
    await refused({ recipe: 0 }, 'Recipe #0 is a "卷板机" recipe, not hand crafting: run it on a machine with process_items.')
    await refused({ recipe: 24 }, 'Recipe #24 is a "烧制" recipe, not hand crafting: run it on a machine with process_items.')
    // 游戏标成“NEI 里显示用”的那条也是一条配方：它是机器配方
    await refused({ recipe: 5 }, 'Recipe #5 is a "板材切割机" recipe, not hand crafting: run it on a machine with process_items.')
    await refused({ recipe: 26 }, 'There is no recipe #26. Take the number from find_recipes (numbers change when the recipe book is re-exported).')
    await refused({}, 'Give "recipe": the # number of a hand-crafting recipe from find_recipes.')
    await refused({ recipe: 10, count: 200 }, '200 would take 100 rounds of this recipe (2 per round); one task does at most 64 rounds (128). Split it into several tasks.')
    assert.equal(s.game.callsOf('task.start').length, 0)
  })
})

describe('身体读不全状态的机器：照配方册认，可以试', () => {
  it('find_machines 也列别的 mod 的机器和熔炉：配方页把它（作为物品）列为做这类配方的机器，而它在世界里是一个容器；箱子不算；可以按名字筛', async (t) => {
    const s = setup(t)
    s.game.handlers['world.containers'] = () => ({
      containers: [
        { x: 14, y: 64, z: -4, id: 'minecraft:furnace', name: 'Furnace', slots: 3, usedSlots: 0, items: [], attached: [{ x: 14, y: 65, z: -4, name: 'Hopper', kind: 'hopper' }] },
        { x: 12, y: 64, z: -4, id: 'minecraft:chest', name: 'Chest', slots: 27, usedSlots: 0, items: [] },
        // 身体认识的机器也是容器：已经在上面那一段里了，不重复列
        { x: 16, y: 64, z: -4, id: 'gregtech:gt.blockmachines', name: 'Basic Bending Machine', kind: 'machine', slots: 4, usedSlots: 0, items: [] },
      ],
      total: 3,
      offset: 0,
    })
    const lines = (await s.run('find_machines')).content.split('\n')
    assert.match(lines[0]!, /^3 GregTech machine\(s\) within 32 blocks of you, nearest first\./)
    assert.deepEqual(lines.slice(-2), [
      "1 other machine(s) within 32 blocks (other mods' machines, furnaces: recognised from the recipe book; their state cannot be read, but process_items works on them the way a player would — inputs in, wait, products out):",
      '- (14,64,-4) "熔炉": runs "烧制" recipes; AUTOMATED: Hopper at (14,65,-4) feeds or drains it',
    ])
    // 和身体认识的机器查的是同一片地方
    assert.deepEqual(s.game.callsOf('world.containers').at(-1), { bot: 'Alu', radius: 32, limit: 100 })
    // 按名字筛：身体那边没有叫这个的，照配方册认出来的那台有
    s.game.handlers['world.machines'] = () => ({ machines: [], total: 0 })
    const furnace = (await s.run('find_machines', { name: '烧制' })).content.split('\n')
    assert.match(furnace[0]!, /^No GregTech machine whose name or recipe type contains "烧制" within 32 blocks of you/)
    assert.equal(furnace.at(-1), '- (14,64,-4) "熔炉": runs "烧制" recipes; AUTOMATED: Hopper at (14,65,-4) feeds or drains it')
    assert.doesNotMatch((await s.run('find_machines', { name: 'Lathe' })).content, /other machine/)
  })

  it('蒸汽机器不烧电：存着 0 EU 不是“没电”，电压也无从比——算做得了，写明蒸汽读不出来、要试；没有能源仓却成型了的多方块（蒸汽多方块）一样', async (t) => {
    const s = setup(t)
    const steamHammer = { x: 18, y: 64, z: -4, name: 'Steam Forge Hammer', id: 'gregtech:gt.blockmachines', meta: 112, recipes: 'Forge Hammer', recipeKey: 'gt.recipe.hammer', tier: 'ULV', inputSlots: 1, active: false, storedEU: 0, inputVoltage: 0, dist: 8 }
    s.game.handlers['world.machines'] = () => ({ machines: [steamHammer], total: 1 })
    const way = async (): Promise<string> => (await s.run('find_recipes', PLATE)).content.split('\n').find((l) => / 锻造锤 — /.test(l))!
    assert.match(await way(), / CAN RUN NOW on Steam Forge Hammer at \(18,64,-4\) ULV \(steam-powered: whether it has steam, and whether this recipe is within its pressure, cannot be read — try it\)$/)
    assert.match((await s.run('find_machines')).content, /\(18,64,-4\) "Steam Forge Hammer": runs "锻造锤" recipes, tier ULV, 1 input slot\(s\), steam-powered \(whether it has steam cannot be read\), idle/)
    // 同一台锤子要是电动的（名字里没有 Steam）：0 EU 就是没电
    s.game.handlers['world.machines'] = () => ({ machines: [{ ...steamHammer, name: 'Basic Forge Hammer', tier: 'LV' }], total: 1 })
    assert.match(await way(), / machine here but not usable now: .*NO POWER$/)
    // 蒸汽多方块：成型了、没有能源仓（0 V）——不拿电压去卡它
    s.game.handlers['world.machines'] = () => ({ machines: [{ x: 30, y: 64, z: 0, name: 'Steam Presser', id: 'gregtech:gt.blockmachines', meta: 31083, kind: 'multiblock', formed: true, recipes: 'Forge Hammer', recipeKey: 'gt.recipe.hammer', inputVoltage: 0, tier: 'ULV', active: false, inputBuses: [{ x: 31, y: 64, z: 0, name: 'Input Bus (Steam)', kind: 'input bus', slots: 4, usedSlots: 0 }], dist: 20 }], total: 1 })
    assert.match(await way(), / CAN RUN NOW on Steam Presser at \(30,64,0\) ULV \(steam-powered: /)
  })
})

describe('process_items：照配方册里的配方用机器加工', () => {
  it('给机器和配方编号：原料乘上轮数，编程电路从配方里取出来单独设（不当物品放），预期的产物一并告诉身体', async (t) => {
    const s = setup(t)
    const furnace = await s.run('process_items', { machine: { x: -5, y: 64, z: 9 }, recipe: 6, rounds: 3, wait: 600 })
    // 配方要的流体不替它准备：没带单元时提醒要多少、得已经在机器里
    assert.match(furnace.content, /^Task t1 \(process\) started\..* This recipe also takes 3000 mB 氧气 in all, from inside the machine \(its tank, or a multiblock's input hatch\)\. Its input hatches now hold 8000 mB 氧气\.$/)
    assert.deepEqual(s.lastTask(), {
      type: 'process',
      machine: { x: -5, y: 64, z: 9 },
      inputs: [{ id: 'gregtech:gt.metaitem.01', meta: 2364, count: 3 }],
      circuit: 11,
      expect: [{ id: 'EnderIO:itemAlloy', meta: 6, count: 3 }],
      wait: 600,
    })
    // 模具这类不消耗的只放 1 个，不乘轮数
    assert.doesNotMatch((await s.run('process_items', { machine: { x: 1, y: 64, z: 1 }, recipe: 4, rounds: 5 })).content, /also needs/)
    assert.deepEqual(s.lastTask().inputs, [
      { id: 'gregtech:gt.metaitem.01', meta: 11305, count: 10 },
      { id: 'gregtech:gt.metaitem.01', meta: 32301, count: 1 },
    ])
    assert.equal(s.lastTask().circuit, undefined)
    // 模具已经在那台机器里（moldInside）：不带、不放，只放要消耗的
    await s.run('process_items', { machine: { x: 1, y: 64, z: 1 }, recipe: 4, rounds: 5, moldInside: true })
    assert.deepEqual(s.lastTask().inputs, [{ id: 'gregtech:gt.metaitem.01', meta: 11305, count: 10 }])
    // 有概率才出的副产物不算进“一定要取回来的”
    await s.run('process_items', { machine: { x: 1, y: 64, z: 1 }, recipe: 27 })
    assert.deepEqual(s.lastTask().expect, [{ id: 'gregtech:gt.metaitem.01', meta: 2305, count: 1 }])
  })

  it('带 leave（放下就走）：这句话原样交给身体，并带上这一批是哪条配方的几轮、配方册上一轮多少 tick；自己写 inputs 时几轮说不准，不带', async (t) => {
    const s = setup(t)
    // 卷板机 #0：一轮 56 tick
    await s.run('process_items', { machine: { x: 16, y: 64, z: -4 }, recipe: 0, rounds: 5, leave: true })
    assert.deepEqual(s.lastTask(), {
      type: 'process',
      machine: { x: 16, y: 64, z: -4 },
      inputs: [{ id: 'gregtech:gt.metaitem.01', meta: 11305, count: 5 }],
      circuit: 1,
      expect: [{ id: 'gregtech:gt.metaitem.01', meta: 17305, count: 5 }],
      leave: true,
      recipe: { ref: 0, rounds: 5, ticks: 56 },
    })
    // 给了配方、又自己写了要放什么（7 个锭）：放进去的是几轮由不得配方说，所以不带
    await s.run('process_items', { machine: { x: 16, y: 64, z: -4 }, recipe: 0, inputs: [{ id: 'gregtech:gt.metaitem.01', meta: 11305, count: 7 }], leave: true })
    assert.deepEqual(s.lastTask(), {
      type: 'process',
      machine: { x: 16, y: 64, z: -4 },
      inputs: [{ id: 'gregtech:gt.metaitem.01', meta: 11305, count: 7 }],
      circuit: 1,
      expect: [{ id: 'gregtech:gt.metaitem.01', meta: 17305, count: 1 }],
      leave: true,
    })
    // 不带 leave：和以前一样，这两项都没有
    await s.run('process_items', { machine: { x: 16, y: 64, z: -4 }, recipe: 0, rounds: 5 })
    assert.deepEqual(Object.keys(s.lastTask()).sort(), ['circuit', 'expect', 'inputs', 'machine', 'type'])
  })

  it('配方点名的那个 id 身上没有、同一种东西的另一个 id 有：放身上有的那种', async (t) => {
    // 卷板机配方写的是 EnderIO 的玄钢锭，身上是 GregTech 的
    const s = setup(t, { inventory: [{ id: 'gregtech:gt.metaitem.01', meta: 11364, count: 4 }] })
    await s.run('process_items', { machine: { x: 16, y: 64, z: -4 }, recipe: 8, rounds: 4 })
    assert.deepEqual([s.lastTask().inputs, s.lastTask().circuit], [[{ id: 'gregtech:gt.metaitem.01', meta: 11364, count: 4 }], 1])
    // 两种都不够时照配方写的来（任务会报缺什么）
    await s.run('process_items', { machine: { x: 16, y: 64, z: -4 }, recipe: 8, rounds: 9 })
    assert.deepEqual(s.lastTask().inputs, [{ id: 'EnderIO:itemAlloy', meta: 6, count: 9 }])
  })

  it('也可以自己把要放的东西写出来；多方块的流体单元、指定总线、预期产物原样交给身体', async (t) => {
    const s = setup(t)
    await s.run('process_items', {
      machine: { x: -5, y: 64, z: 9 },
      inputs: [{ id: 'gregtech:gt.metaitem.01', meta: 2364, count: 2 }],
      circuit: 1,
      fluids: [{ id: 'IC2:itemCellEmpty', meta: 5, count: 2 }],
      expect: [{ id: 'EnderIO:itemAlloy', meta: 6, count: 2 }],
      bus: { x: -4, y: 64, z: 9 },
    })
    assert.deepEqual(s.lastTask(), {
      type: 'process',
      machine: { x: -5, y: 64, z: 9 },
      inputs: [{ id: 'gregtech:gt.metaitem.01', meta: 2364, count: 2 }],
      circuit: 1,
      fluids: [{ id: 'IC2:itemCellEmpty', meta: 5, count: 2 }],
      expect: [{ id: 'EnderIO:itemAlloy', meta: 6, count: 2 }],
      bus: { x: -4, y: 64, z: 9 },
    })
    // 给了配方，也可以自己改电路号
    await s.run('process_items', { machine: { x: -5, y: 64, z: 9 }, recipe: 7, circuit: 2 })
    assert.equal(s.lastTask().circuit, 2)
    for (const [input, why] of [
      [{ machine: { x: 1, y: 1, z: 1 }, recipe: 3 }, 'Recipe #3 is a "有序合成" recipe, not a machine recipe: make it with craft_item.'],
      [{ machine: { x: 1, y: 1, z: 1 } }, 'Give "recipe" (the # number from find_recipes) or "inputs".'],
    ] as const) {
      const res = await s.run('process_items', input)
      assert.deepEqual([res.isError, res.content], [true, why])
    }
  })
})

describe('没有本地配方册时', () => {
  it('找物品、查做法退回去问服务器；合成用服务器自己知道的配方；查用途说明做不了', async (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const game = new FakeGame()
    game.handlers['item.search'] = () => ({ items: [{ id: 'minecraft:stick', meta: 0, name: 'Stick', recipes: { crafting: 1 } }] })
    game.handlers['recipe.find'] = () => {
      throw new BridgeError('not_found', 'no such item is known: x/0; item.search finds ids')
    }
    const ctx: ToolContext = { botName: 'Alu', bridge: new BridgeApi(game), memory: new MemoryStore(tmp.dir, () => 300), manuals: new ManualStore(DEFAULT_MANUALS_DIR, `${tmp.dir}/manuals`), reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) }, hooks: {}, now: () => NOW }
    const run = (name: string, input: unknown): Promise<ToolResult> => runTool(ALL_TOOLS, ctx, name, input)
    assert.match((await run('find_item', { query: 'stick' })).content, /minecraft:stick "Stick"/)
    assert.deepEqual(game.callsOf('item.search'), [{ query: 'stick' }])
    assert.match((await run('find_recipes', { id: 'x' })).content, /^No item x is known on this server\. Use find_item/)
    assert.match((await run('find_uses', { id: 'x' })).content, /^There is no recipe book on this brain/)
    await run('craft_item', { id: 'minecraft:stick', count: 4, recipe: 0 })
    assert.deepEqual(game.callsOf('task.start').at(-1)!.task, { type: 'craft', id: 'minecraft:stick', count: 4, recipe: 0 })
    assert.equal((await run('craft_item', { recipe: 3 })).isError, true)
    assert.equal((await run('process_items', { machine: { x: 1, y: 1, z: 1 }, recipe: 3 })).content, 'There is no recipe book on this brain: give "inputs" (and "circuit") yourself.')
  })
})
