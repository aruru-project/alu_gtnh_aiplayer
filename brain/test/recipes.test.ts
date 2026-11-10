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
  it('启动时读一遍建索引：只是示意的配方哪里都查不到，坏行跳过并说明，编号就是行号', (t) => {
    const s = setup(t)
    assert.ok(s.lines.includes('物品表：45 种物品。'), s.lines.join('\n'))
    const loaded = s.lines.find((l) => l.startsWith('配方册：'))!
    assert.match(loaded, /^配方册：26 条配方、10 个配方页，做得出 11 种物品（读了 \d+ 毫秒；另有 1 条只是示意的不列；1 行认不出来，跳过了）。$/)
    const book = s.packdata.recipes!
    assert.equal(book.size, RECIPE_LINES.length)
    // 钢板：0–4 这五条做它；第 5 条是 fake 的，不在里面
    assert.deepEqual([...book.makesOf(PLATE.id, PLATE.meta)], [0, 1, 2, 3, 4])
    assert.equal(book.get(5), undefined)
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
    assert.equal(zh[1], '- 钢板 [gregtech:gt.metaitem.01/17305]: 5 recipe(s) make it; used in 3; ore names: plateSteel')
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
    assert.match((await s.run('find_item', { query: '不存在的东西' })).content, /^No item matches "不存在的东西"\. Try fewer or other words/)
  })
})

describe('find_recipes：查做法', () => {
  it('先按加工方式汇总：每种几条、每个成品耗多少料、电压和时长、要不要电路和模具；附近现在做得了的排前面；重复的合并，示意的不列', async (t) => {
    const s = setup(t)
    const res = await s.run('find_recipes', PLATE)
    assert.equal(res.isError, undefined, res.content)
    assert.deepEqual(res.content.split('\n'), [
      '钢板 [gregtech:gt.metaitem.01/17305] can be made 4 way(s), 4 recipe(s) in all (1 exact duplicate(s) in the book are merged). Ways you can use now come first:',
      // 卷板机：1 锭出 1 板，附近那台有电
      '1. 卷板机 — 1 recipe(s); CAN RUN NOW on 基础卷板机 at (16,64,-4) LV',
      '   #0: 1× 钢锭 [gregtech:gt.metaitem.01/11305] (or any ingotSteel); needs programmed circuit 1 → 1× 钢板 — LV (24 EU/t), 2.8 s',
      // 手工锤：2 锭出 1 板；有机器做法时提醒别用它
      '2. 有序合成 — 1 recipe(s); CAN CRAFT NOW (crafting table at (8,64,-4)); hand-tool recipe: use it only when no machine can make this',
      '   #3: 2× any ingotSteel (e.g. 钢锭 [gregtech:gt.metaitem.01/11305]); needs tool any craftingToolHardHammer (e.g. 锤 [gregtech:gt.metatool.01/12]) (worn, not used up) → 1× 钢板 — needs a crafting table (3x3)',
      // 锻造锤：3 锭出 2 板，每个板 1.5 锭；附近那台没电
      '3. 锻造锤 — 1 recipe(s); machine here but not usable now: 基础锻造锤 at (18,64,-4) LV: NO POWER',
      '   #2: 3× 钢锭 [gregtech:gt.metaitem.01/11305] (or any ingotSteel) → 2× 钢板 (per 钢板: 1.5 钢锭) — LV (16 EU/t), 2.8 s',
      '4. 合金炉 — 1 recipe(s); no such machine within 64 blocks',
      '   #4: 2× 钢锭 [gregtech:gt.metaitem.01/11305] (or any ingotSteel); needs 模具（板） [gregtech:gt.metaitem.01/32301] (stays in the machine, not used up) → 1× 钢板 — LV (30 EU/t), 5.6 s',
      '"CAN … NOW" is about machines and tables only: check the ingredients with find_in_storage. Use a recipe by its # number: craft_item or process_items.',
    ])
    // 看了一眼附近的机器和工作台
    assert.deepEqual(s.game.callsOf('world.machines'), [{ bot: 'Alu', radius: 64, limit: 60 }])
    assert.deepEqual(s.game.callsOf('world.find'), [{ bot: 'Alu', blocks: ['minecraft:crafting_table', 'TConstruct:CraftingStation', 'TConstruct:CraftingSlab'], radius: 48, limit: 4 }])
    // 板材切割机那条是 fake 的
    assert.ok(!res.content.includes('板材切割机') && !res.content.includes('#5'))
  })

  it('机器的状况逐条比：电压不够、炉温不够、结构没搭好、被关了，都说出是哪台、差在哪', async (t) => {
    const s = setup(t)
    // 高炉炉温 1801 K：要 1800 K 的那条做得了，要 2200 K 的那条做不了
    const ingot = (await s.run('find_recipes', { id: 'EnderIO:itemAlloy', meta: 6 })).content.split('\n')
    assert.equal(ingot[1], '1. 工业高炉 — 2 recipe(s); CAN RUN NOW on 工业高炉 at (-5,64,9) HV')
    assert.equal(ingot[2], '   #6: 1× 玄钢粉 [gregtech:gt.metaitem.01/2364] + 1000 mB 氧气 (fluid); needs programmed circuit 11 → 1× 玄钢锭 — MV (120 EU/t), 50 s, coil heat 1800 K')
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
    assert.equal(await judge({ recipeKey: 'gt.recipe.other', meta: 9999 }), '1. 工业高炉 — 2 recipe(s); no such machine within 64 blocks')
  })

  it('手工合成：附近没有工作台时说要工作台，摆得进 2×2 的不用；它操作不了的方式（熔炉）照实说；没连上游戏时照样给配方', async (t) => {
    const s = setup(t)
    s.game.handlers['world.find'] = () => ({ matches: [], total: 0 })
    assert.equal((await s.run('find_recipes', { id: 'Backpack:backpack' })).content.split('\n')[1], '1. 有序合成 — 1 recipe(s); needs a crafting table: none within 48 blocks')
    const pocket = (await s.run('find_recipes', { id: 'demo:plateOnAStick' })).content.split('\n')
    assert.equal(pocket[1], '1. 无序合成 — 1 recipe(s); CAN CRAFT NOW in your own 2x2 grid (no table needed)')
    // 一次出 2 个：每个耗半份料
    assert.equal(pocket[2], '   #10: 1× 钢板 [gregtech:gt.metaitem.01/17305] + 1× any stickWood (e.g. 木棍 [minecraft:stick]) → 2× 钢板标牌 (per 钢板标牌: 0.5 钢板 + 0.5 any stickWood (e.g. 木棍)) — fits your 2x2 grid')
    assert.equal((await s.run('find_recipes', { id: 'minecraft:iron_ingot' })).content.split('\n')[1], '1. 烧制 — 1 recipe(s); you cannot run this yourself (not hand crafting, not a GregTech machine you can use)')
    // 只有工具配方一条路时不说“有机器就别用”
    assert.equal((await s.run('find_recipes', { id: 'adventurebackpack:backpackComponent', meta: 6 })).content.split('\n')[1], '1. 有序合成 — 1 recipe(s); needs a crafting table: none within 48 blocks')

    s.game.connected = false
    const offline = (await s.run('find_recipes', PLATE)).content.split('\n')
    assert.equal(offline[1], '(Which machines and crafting tables are around you could not be checked: disconnected: bridge is not connected to the game server.)')
    assert.equal(offline[2], '1. 卷板机 — 1 recipe(s); machine recipe')
    assert.equal(offline.length, 11)
  })

  it('同一种东西有两个 id（玄钢锭）：查哪个都给出做法，说明它们可以互换', async (t) => {
    const s = setup(t)
    const gt = (await s.run('find_recipes', { id: 'gregtech:gt.metaitem.01', meta: 11364 })).content.split('\n')
    assert.equal(
      gt[0],
      '玄钢锭 [gregtech:gt.metaitem.01/11364] can be made 1 way(s), 2 recipe(s) in all. Recipes that make 玄钢锭 [EnderIO:itemAlloy/6] are included: under the ore name ingotDarkSteel it is the same thing (GregTech machines and "any ingotDarkSteel" recipes take either). Ways you can use now come first:',
    )
    assert.match(gt[2]!, /^ {3}#6: 1× 玄钢粉 /)
    // 机器配方里点名的是另一个 id：写明同名矿辞下的都行
    assert.match((await s.run('find_recipes', { id: 'gregtech:gt.metaitem.01', meta: 17364 })).content, /#8: 1× 玄钢锭 \[EnderIO:itemAlloy\/6\] \(or any ingotDarkSteel\); needs programmed circuit 1 → 1× 玄钢板/)
  })

  it('一种方式下配方很多（每种材质一把锤子）：汇总里只举例并说明还有多少；按方式、按“原料里含某物”筛，翻页，总数和这是第几页都写明', async (t) => {
    const s = setup(t, { inventory: [{ id: 'demo:ingot', meta: 3, count: 9 }, { id: 'minecraft:stick', count: 2 }] })
    const summary = (await s.run('find_recipes', HAMMER)).content.split('\n')
    assert.equal(summary[0], '锤 [gregtech:gt.metatool.01/12] can be made 1 way(s), 12 recipe(s) in all. Ways you can use now come first:')
    assert.equal(summary[1], '1. 有序合成 — 12 recipe(s); CAN CRAFT NOW (crafting table at (8,64,-4))')
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
    assert.deepEqual([way.isError, way.content], [true, '钢板 [gregtech:gt.metaitem.01/17305] is not made by any way matching "车床". Its ways: "卷板机" (1), "锻造锤" (1), "有序合成" (1), "合金炉" (1).'])
    assert.equal((await s.run('find_recipes', { ...PLATE, contains: '铜' })).content, 'No recipe for 钢板 [gregtech:gt.metaitem.01/17305] with an ingredient containing "铜" (4 recipe(s) before the "contains" filter; 4 in all). Try another word: part of an ingredient\'s Chinese or English name, id or ore name.')
    const unknown = await s.run('find_recipes', { id: 'gregtech:gt.metaitem.01', meta: 99999 })
    assert.deepEqual([unknown.isError, unknown.content], [true, 'No item gregtech:gt.metaitem.01/99999 is known. Get the exact id and meta with find_item (many GregTech items share one id and differ only in meta).'])
    assert.match((await s.run('find_recipes', { id: 'Backpack:tannedLeather' })).content, /^No recipe makes 鞣制皮革 \[Backpack:tannedLeather\]: it is not crafted or processed from anything in the recipe book/)
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
      'See the recipes with "way" (one of the names above), narrowed with "contains" (a word of the product or of another ingredient), page by page.',
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
    })
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

  it('无序合成从头往后摆；一轮出 2 个时要 5 个就做 3 轮', async (t) => {
    const s = setup(t)
    await s.run('craft_item', { recipe: 10, count: 5 })
    assert.deepEqual(s.lastTask(), { type: 'craft', grid: [PLATE, { ore: 'stickWood' }, null, null, null, null, null, null, null], gives: { id: 'demo:plateOnAStick', meta: 0 }, rounds: 3 })
  })

  it('不是手工配方、编号不对、一次要得太多：不开任务，说清原因', async (t) => {
    const s = setup(t)
    const refused = async (input: unknown, why: string) => {
      const res = await s.run('craft_item', input)
      assert.deepEqual([res.isError, res.content], [true, why])
    }
    await refused({ recipe: 0 }, 'Recipe #0 is a "卷板机" recipe, not hand crafting: run it on a machine with process_items.')
    await refused({ recipe: 24 }, 'Recipe #24 is a "烧制" recipe, not hand crafting.')
    await refused({ recipe: 5 }, 'There is no recipe #5. Take the number from find_recipes (numbers change when the recipe book is re-exported).')
    await refused({}, 'Give "recipe": the # number of a hand-crafting recipe from find_recipes.')
    await refused({ recipe: 10, count: 200 }, '200 would take 100 rounds of this recipe (2 per round); one task does at most 64 rounds (128). Split it into several tasks.')
    assert.equal(s.game.callsOf('task.start').length, 0)
  })
})

describe('process_items：照配方册里的配方用机器加工', () => {
  it('给机器和配方编号：原料乘上轮数，编程电路从配方里取出来单独设（不当物品放），预期的产物一并告诉身体', async (t) => {
    const s = setup(t)
    await s.run('process_items', { machine: { x: -5, y: 64, z: 9 }, recipe: 6, rounds: 3, wait: 600 })
    assert.deepEqual(s.lastTask(), {
      type: 'process',
      machine: { x: -5, y: 64, z: 9 },
      inputs: [{ id: 'gregtech:gt.metaitem.01', meta: 2364, count: 3 }],
      circuit: 11,
      expect: [{ id: 'EnderIO:itemAlloy', meta: 6, count: 3 }],
      wait: 600,
    })
    // 模具这类不消耗的只放 1 个，不乘轮数
    await s.run('process_items', { machine: { x: 1, y: 64, z: 1 }, recipe: 4, rounds: 5 })
    assert.deepEqual(s.lastTask().inputs, [
      { id: 'gregtech:gt.metaitem.01', meta: 11305, count: 10 },
      { id: 'gregtech:gt.metaitem.01', meta: 32301, count: 1 },
    ])
    assert.equal(s.lastTask().circuit, undefined)
    // 有概率才出的副产物不算进“一定要取回来的”
    await s.run('process_items', { machine: { x: 1, y: 64, z: 1 }, recipe: 27 })
    assert.deepEqual(s.lastTask().expect, [{ id: 'gregtech:gt.metaitem.01', meta: 2305, count: 1 }])
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
      [{ machine: { x: 1, y: 1, z: 1 }, recipe: 3 }, 'Recipe #3 is a "有序合成" recipe, not a GregTech machine recipe: make it with craft_item.'],
      [{ machine: { x: 1, y: 1, z: 1 }, recipe: 24 }, 'Recipe #24 is a "烧制" recipe, not a GregTech machine recipe, and you cannot run it.'],
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
