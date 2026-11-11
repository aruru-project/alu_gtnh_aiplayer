// total_materials：做一样东西，整棵树要什么、先干哪些——照“基地的做法”定配方，库存先扣掉，没定过的摆出来不替它选。
// 入口是模型用的工具（它是库函数，程序里调或者直接按名字调）；配方册是 fixture-plan.ts 的小样本，基地是它的假基地：
// 一台卷板机、一台压模机、一台搅拌机、一台研磨机、一座高炉、一个合成站，主仓库一个压缩箱子，旁边一个接着漏斗的箱子。
// 预期的数都是照配方手算的：一个桨叶 4 根柄，一根柄 9 个钢锭；模头（转轴）4 块玄钢板；搅拌机一轮出 3 个玄钢粉……
// 走树和算数本身（环、取整、不消耗的只算一个）在 material-tree.test.ts；凿子和流体那两步在 chisel / fluids-covers 的测试里。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { loadPackData } from '../src/packdata/index.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { MethodStore } from '../src/store/methods.ts'
import { useLocalNames } from '../src/tools/format.ts'
import { LINE_TOOLS, runTool } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/types.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { BENDER, MACERATOR, MIXER, P, R, RECIPES, chest, furnace, inside, installBase, stack, writePlanFixture } from './fixture-plan.ts'
import type { Box } from './fixture-plan.ts'
import { tmpDir } from './helpers.ts'

const DAY = '2027-01-15'
/**
 * 主仓库：20 个钢锭、3 个钢螺丝、一把锤、一个模头（杆）。旁边一个箱子上面接着漏斗，里面 64 个钢锭（主人的自动化：不计入）。
 * 卷板机的格子里还放着 50 个钢锭（正在加工的料：不算库存）。
 */
const STORE: Box[] = [
  chest([stack(P.steelIngot, 20), stack(P.steelScrew, 3), stack(P.hammer, 1), stack(P.rodShape, 1)]),
  { x: 14, y: 64, z: -4, name: 'Chest', attached: [{ x: 14, y: 65, z: -4, name: 'Hopper', kind: 'hopper' }], items: [stack(P.steelIngot, 64)] },
  inside(BENDER, [stack(P.steelIngot, 50)]),
]
const UNDECIDED_HEAD =
  'NOT DECIDED, {n} (each has more than one recipe and nothing says which: no recipe named, no base method for it or its kind of part, no way of the base\'s order makes it). Nothing below them is expanded. To decide one: set_base_method (it is then followed every time), or name a recipe # in "recipes" for this once; then run this again.'
const LOOKED = 'Storage was looked into (3 container(s); what you carry counts too): what is there is used first, only what is short is expanded. Things inside machines do not count.'
const TABLE = 'CAN CRAFT NOW (needs a crafting table, the nearest 2 block(s) from here; craft_item walks to the nearest one by itself); uses hand tools (not used up, but they wear)'
const AUTOMATED = "In containers with pipes or hoppers attached (your owner's automation: not counted, not used): 64× 钢锭 [gregtech:gt.metaitem.01/11305] ((14,64,-4), Hopper)"
const SCREWDRIVER = 'any craftingToolScrewdriver (e.g. 螺丝刀 [gregtech:gt.metatool.01/22])'

function setup(t: { after(fn: () => void): void }, init: Parameters<typeof installBase>[1] = {}) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  writePlanFixture(tmp.dir)
  let packdata = loadPackData(tmp.dir)
  t.after(() => packdata.recipes?.close())
  useLocalNames(packdata.items)
  t.after(() => useLocalNames(undefined))
  const game = new FakeGame()
  const world = installBase(game, { boxes: STORE, ...init })
  const methods = new MethodStore(tmp.dir)
  let cap = 20_000
  const ctx = (): ToolContext => ({
    botName: 'Alu',
    line: 'work',
    bridge: new BridgeApi(game),
    memory: new MemoryStore(tmp.dir, () => 300),
    manuals: new ManualStore(DEFAULT_MANUALS_DIR, `${tmp.dir}/manuals`),
    packdata,
    methods,
    reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
    hooks: {},
    now: () => 1_800_000_000_000,
    maxResultChars: () => cap,
  })
  const run = async (name: string, input: unknown) => {
    const res = await runTool(LINE_TOOLS.work, ctx(), name, input)
    return { ok: res.isError !== true, text: res.content, lines: res.content.split('\n'), data: res.data as any }
  }
  const total = (input: Record<string, unknown>) => run('total_materials', input)
  /** 主人教过的三件事：板走卷板机（从锭）、模头（转轴）用玄钢板那条、没有更具体的规矩时高炉和搅拌机在前；外加卷板机是专门压板的。 */
  const teach = async () => {
    await run('set_base_method', { part: 'plate', way: '卷板机', from: 'ingot', by: 'owner', why: '一锭一板' })
    await run('set_base_method', { ...P.shaftShape, recipe: R.shaftShape, by: 'self', why: '玄钢板的那条' })
    await run('set_base_method', { order: ['工业高炉', '搅拌机'], by: 'owner' })
    await run('set_base_method', { machine: { x: BENDER.x, y: BENDER.y, z: BENDER.z }, does: '专门压板', feed: { x: 16, y: 65, z: -8 }, collect: { x: 17, y: 64, z: -8 }, keep: '电路别动', by: 'owner' })
  }
  /** 换一本重新导出的配方册。 */
  const reexport = (recipes: Record<string, unknown>[]) => {
    fs.writeFileSync(path.join(tmp.dir, 'recipes.jsonl'), `${recipes.map((r) => JSON.stringify(r)).join('\n')}\n`)
    packdata.recipes?.close()
    packdata = loadPackData(tmp.dir)
  }
  return { game, world, run, total, teach, reexport, limit: (chars: number) => (cap = chars) }
}

describe('total_materials：照基地的做法展开整棵树', () => {
  it('基地的做法还是空的、不带配方号问“做一个直升机桨叶要什么”：只有一条配方的照做，有得选的不展开、把它的几种做法摆出来；库存先用掉，接着漏斗的箱子里的另算、不计入', async (t) => {
    const s = setup(t)
    const res = await s.total({ ...P.blades })
    assert.deepEqual(res.lines, [
      "For 1× 直升机桨叶 [adventurebackpack:backpackComponent/6]: 2 thing(s) to make in 2 wave(s) (2 with only one recipe); 2 thing(s) NOT DECIDED — the tree stops at them. This adds up amounts by the base's methods (0 entries); it chooses no recipe.",
      LOOKED,
      UNDECIDED_HEAD.replace('{n}', '2'),
      // 4 根柄 36 个钢锭，仓库里 20 个，缺 16 个；钢锭有两种做法（回收齿轮的那页不算做法）
      '1. 16× 钢锭 [gregtech:gt.metaitem.01/11305] (need 36, 20 in storage; 64 more in automated containers, not counted)',
      `   - 工业高炉 #${R.smeltSteel}: 1× 钢粉 + circuit 1 → 1× 钢锭 — CAN RUN NOW on 工业高炉 at (-5,64,9) HV`,
      `   - 烧制 #${R.furnaceSteel}: 1× 钢粉 → 1× 钢锭 — no such machine within 112 blocks`,
      // 模头只是留在压模机里：要 1 个；它有两条配方（玄钢板的、钛板的）
      '2. 1× 模头（转轴） [miscutils:MU-metaitem.01/32040] (need 1, none in storage) — not used up, one is enough',
      `   - 有序合成 #${R.shaftShape}: 4× 玄钢板 + 1× 模头（杆） + any craftingToolHardHammer (e.g. 锤) (not used up) → 1× 模头（转轴） (+1 more of this way) — ${TABLE}`,
      'Raw materials still missing after storage (1):',
      '- nothing in the recipe book makes it (1): 1× 钢齿轮 [gregtech:gt.metaitem.02/31305] (need 1, none in storage)',
      'Missing capability:',
      `- needed at hand but not used up, one of each, none in storage: ${SCREWDRIVER}`,
      'Used from storage (2): 3× 钢螺丝 [gregtech:gt.metaitem.01/27305] (there are 3 at (12,64,-4)); 20× 钢锭 [gregtech:gt.metaitem.01/11305] (there are 20 at (12,64,-4))',
      AUTOMATED,
      'Jobs, 2, by when they can start and by way:',
      'Wave 1 — these take only raw materials and what is in storage:',
      '- 压模机 (1 job(s)) — CAN RUN NOW on 进阶压模机 at (18,64,-8) MV',
      `  - #${R.shaft} × 4 → 4× 精炼铁柄 [IC2:itemRecipePart/12] [only recipe] — takes NOT DECIDED: 钢锭, 模头（转轴）`,
      'Wave 2 — these take things made in wave 1 (or earlier):',
      `- 有序合成 (1 job(s)) — ${TABLE}`,
      `  - #${R.blades} × 1 → 1× 直升机桨叶 [adventurebackpack:backpackComponent/6] [only recipe]`,
    ])
    // 程序拿得到同样的事实：没定的每样带着它的做法，还缺的带着库存里有多少
    assert.deepEqual(res.data.summary, { toMake: 2, waves: 2, byMethods: 0, named: 0, onlyRecipe: 2, undecided: 2, missing: 1, stock: 'used' })
    assert.deepEqual(
      res.data.undecided.map((u: any) => [u.name, u.count, u.needed, u.inStorage, u.automated ?? 0, u.ways.map((w: any) => [w.way, w.recipe])]),
      [
        ['钢锭', 16, 36, 20, 64, [['工业高炉', R.smeltSteel], ['烧制', R.furnaceSteel]]],
        ['模头（转轴）', 1, 1, 0, 0, [['有序合成', R.shaftShape]]],
      ],
    )
    assert.deepEqual(res.data.missing, [{ id: 'gregtech:gt.metaitem.02', meta: 31305, name: '钢齿轮', count: 1, needed: 1, why: 'none', inStorage: 0 }])
  })

  it('主人教过几条以后做 3 个桨叶：每样照基地的做法走到底，每一步写明是照哪一条定的；活儿按先后分批、按做法分组，记过用途的机器带着它的进料和收货的地方；只把库存不够的那部分往下算', async (t) => {
    const s = setup(t)
    await s.teach()
    const res = await s.total({ ...P.blades, count: 3 })
    assert.deepEqual(res.lines, [
      "For 3× 直升机桨叶 [adventurebackpack:backpackComponent/6]: 7 thing(s) to make in 6 wave(s) (5 by the base's methods, 2 with only one recipe); 1 thing(s) NOT DECIDED — the tree stops at them. This adds up amounts by the base's methods (4 entries); it chooses no recipe.",
      LOOKED,
      UNDECIDED_HEAD.replace('{n}', '1'),
      // 12 根柄 108 个钢锭，仓库 20 个，缺的 88 个照“总的先后”走高炉，要 88 个钢粉——钢粉怎么来没人定过
      '1. 88× 钢粉 [gregtech:gt.metaitem.01/2305] (need 88, none in storage)',
      `   - 研磨机 #${R.grindIngot}: 1× 钢锭 → 1× 钢粉 (+1 more of this way) — CAN RUN NOW on 基础研磨机 at (22,64,-8) LV`,
      'Raw materials still missing after storage (5):',
      '- nothing in the recipe book makes it (5): 6× 钢螺丝 [gregtech:gt.metaitem.01/27305] (need 9, 3 in storage), 3× 钢齿轮 [gregtech:gt.metaitem.02/31305] (need 3, none in storage), 2× 磁钢粉 [gregtech:gt.metaitem.01/2365] (need 2, none in storage), 2× 煤粉 [gregtech:gt.metaitem.01/2535] (need 2, none in storage), 2× 黑曜石粉 [gregtech:gt.metaitem.01/2804] (need 2, none in storage)',
      'Missing capability:',
      `- needed at hand but not used up, one of each, none in storage: ${SCREWDRIVER}`,
      // 模头（杆）和锤仓库里有：做模头（转轴）用的就是它们
      'Used from storage (4): 3× 钢螺丝 [gregtech:gt.metaitem.01/27305] (there are 3 at (12,64,-4)); 1× 模头（杆） [gregtech:gt.metaitem.01/32351] (there are 1 at (12,64,-4)); 1× any craftingToolHardHammer (e.g. 锤 [gregtech:gt.metatool.01/12]) (there are 1 at (12,64,-4)); 20× 钢锭 [gregtech:gt.metaitem.01/11305] (there are 20 at (12,64,-4))',
      AUTOMATED,
      'Jobs, 7, by when they can start and by way:',
      'Wave 1 — these take only raw materials and what is in storage:',
      '- 工业高炉 (1 job(s)) — CAN RUN NOW on 工业高炉 at (-5,64,9) HV',
      `  - #${R.smeltSteel} × 88 → 88× 钢锭 [gregtech:gt.metaitem.01/11305]; 20 more come from storage [base order: 工业高炉] — takes NOT DECIDED: 钢粉`,
      '- 搅拌机 (1 job(s)) — CAN RUN NOW on 基础搅拌机 at (20,64,-8) LV',
      // 4 个玄钢粉，搅拌机一轮出 3 个：2 轮，多 2 个
      `  - #${R.mixDark} × 2 → 6× 玄钢粉 [gregtech:gt.metaitem.01/2364]; 2 left over [base order: 搅拌机]`,
      'Wave 2 — these take things made in wave 1 (or earlier):',
      '- 工业高炉 (1 job(s)) — CAN RUN NOW on 工业高炉 at (-5,64,9) HV',
      `  - #${R.smeltDark} × 4 → 4× 玄钢锭 [EnderIO:itemAlloy/6] [base order: 工业高炉]`,
      'Wave 3 — these take things made in wave 2 (or earlier):',
      '- 卷板机 (1 job(s)) — CAN RUN NOW on 基础卷板机 at (16,64,-8) LV',
      `  基础卷板机 at (16,64,-8) LV — base's methods: 专门压板; feed: (16,65,-8); collect: (17,64,-8); do not touch: 电路别动 (your owner, ${DAY})`,
      `  - #${R.bendDark} × 4 → 4× 玄钢板 [gregtech:gt.metaitem.01/17364] [base method part:plate]`,
      'Wave 4 — these take things made in wave 3 (or earlier):',
      `- 有序合成 (1 job(s)) — ${TABLE}`,
      // 模头不管做几根柄都只要 1 个
      `  - #${R.shaftShape} × 1 → 1× 模头（转轴） [miscutils:MU-metaitem.01/32040] [base method for it (you)]`,
      'Wave 5 — these take things made in wave 4 (or earlier):',
      '- 压模机 (1 job(s)) — CAN RUN NOW on 进阶压模机 at (18,64,-8) MV',
      `  - #${R.shaft} × 12 → 12× 精炼铁柄 [IC2:itemRecipePart/12] [only recipe]`,
      'Wave 6 — these take things made in wave 5 (or earlier):',
      `- 有序合成 (1 job(s)) — ${TABLE}`,
      `  - #${R.blades} × 3 → 3× 直升机桨叶 [adventurebackpack:backpackComponent/6] [only recipe]`,
    ])
    assert.deepEqual(
      res.data.jobs.map((j: any) => [j.wave, j.way, j.recipe, j.rounds, j.rule, j.method ?? '']),
      [
        [1, '工业高炉', R.smeltSteel, 88, 'order', 'order'],
        [1, '搅拌机', R.mixDark, 2, 'order', 'order'],
        [2, '工业高炉', R.smeltDark, 4, 'order', 'order'],
        [3, '卷板机', R.bendDark, 4, 'part', 'part:plate'],
        [4, '有序合成', R.shaftShape, 1, 'thing', 'thing:miscutils:MU-metaitem.01/32040'],
        [5, '压模机', R.shaft, 12, 'only', ''],
        [6, '有序合成', R.blades, 3, 'only', ''],
      ],
    )
  })

  it('这一次点名的配方排在基地的做法前面；stock: false 是从零算（仓库里有的也不扣，手里没有的工具也成了要定的事）', async (t) => {
    const s = setup(t)
    await s.teach()
    // 钢锭点名用熔炉那条、玄钢锭点名加氧的那条、玄钢粉点名手工搅（一轮 2 个）
    const named = await s.total({ ...P.blades, count: 3, recipes: [R.furnaceSteel, R.smeltDarkOxygen, R.handMixDark] })
    assert.match(named.lines[0]!, /7 thing\(s\) to make in 6 wave\(s\) \(2 by the base's methods, 3 named by you, 2 with only one recipe\); 1 thing\(s\) NOT DECIDED/)
    const job = (res: Awaited<ReturnType<typeof s.total>>, recipe: number) => res.lines.find((line) => line.startsWith(`  - #${recipe} `))
    assert.equal(job(named, R.furnaceSteel), `  - #${R.furnaceSteel} × 88 → 88× 钢锭 [gregtech:gt.metaitem.01/11305]; 20 more come from storage [named by you] — takes NOT DECIDED: 钢粉`)
    assert.equal(job(named, R.handMixDark), `  - #${R.handMixDark} × 2 → 4× 玄钢粉 [gregtech:gt.metaitem.01/2364] [named by you]`)
    assert.equal(job(named, R.smeltDarkOxygen), `  - #${R.smeltDarkOxygen} × 4 → 4× 玄钢锭 [EnderIO:itemAlloy/6] [named by you]`)
    // 没点名的照旧照基地的做法
    assert.equal(job(named, R.bendDark), `  - #${R.bendDark} × 4 → 4× 玄钢板 [gregtech:gt.metaitem.01/17364] [base method part:plate]`)
    // 点了名的配方要的流体、它那种做法基地里没有机器，都在“缺的能力”里
    assert.deepEqual(named.lines.slice(named.lines.indexOf('Missing capability:') + 1, named.lines.indexOf('Missing capability:') + 3), [
      `- 烧制, 1 of its 1 job(s) (#${R.furnaceSteel}): no such machine within 112 blocks`,
      "- fluids to supply (a fluid is made only by a recipe you name or one the base's methods record for it): 4000 mB 氧 [fluid oxygen] (no machine tank here holds any that can be read)",
    ])

    const zero = await s.total({ ...P.blades, count: 3, stock: false })
    assert.equal(zero.lines[1], 'Storage was not looked into (stock: false): everything is counted from nothing.')
    // 108 个钢锭全要炼；锤仓库里有一把，可这回不看仓库：它有十二条配方，成了没定的
    assert.deepEqual(zero.lines.slice(3, 7), [
      '1. 108× 钢粉 [gregtech:gt.metaitem.01/2305]',
      `   - 研磨机 #${R.grindIngot}: 1× 钢锭 → 1× 钢粉 (+1 more of this way) — CAN RUN NOW on 基础研磨机 at (22,64,-8) LV`,
      '2. 1× any craftingToolHardHammer (e.g. 锤 [gregtech:gt.metatool.01/12]) — not used up, one is enough',
      `   - 有序合成 #${R.hammer(0)}: 6× 铜锭 + 1× any stickWood (e.g. 木棍) → 1× 锤 (+11 more of this way) — CAN CRAFT NOW (needs a crafting table, the nearest 2 block(s) from here; craft_item walks to the nearest one by itself)`,
    ])
    assert.equal(zero.lines[8], '- nothing in the recipe book makes it (6): 9× 钢螺丝 [gregtech:gt.metaitem.01/27305], 3× 钢齿轮 [gregtech:gt.metaitem.02/31305], 1× 模头（杆） [gregtech:gt.metaitem.01/32351], 2× 磁钢粉 [gregtech:gt.metaitem.01/2365], 2× 煤粉 [gregtech:gt.metaitem.01/2535], 2× 黑曜石粉 [gregtech:gt.metaitem.01/2804]')
    assert.equal(zero.text.includes('Used from storage'), false)
    assert.equal(job(zero, R.smeltSteel), `  - #${R.smeltSteel} × 108 → 108× 钢锭 [gregtech:gt.metaitem.01/11305] [base order: 工业高炉] — takes NOT DECIDED: 钢粉`)
  })

  it('缺的能力照实列出来：用到的做法基地里没有机器、有机器可炉温不够、要的流体现在哪个罐里有多少', async (t) => {
    // 压模机不在了；高炉的炉温只有 1900 K，输入仓里有 8000 mB 氧
    const s = setup(t, { machines: [BENDER, MIXER, MACERATOR, furnace({ heat: 1900, oxygen: 8000 })] })
    await s.teach()
    const lacking = (res: Awaited<ReturnType<typeof s.total>>) => res.lines.slice(res.lines.indexOf('Missing capability:') + 1, res.lines.findIndex((line) => line.startsWith('Used from storage')))
    // 玄钢锭照“总的先后”走高炉：列在最前的那条要 2200 K
    assert.deepEqual(lacking(await s.total({ ...P.blades, count: 3 })), [
      `- 工业高炉, 1 of its 2 job(s) (#${R.smeltDark}): machine here but not usable now: 工业高炉 at (-5,64,9) HV: the recipe needs 2200 K, its coils reach 1900 K`,
      `- 压模机, 1 of its 1 job(s) (#${R.shaft}): no such machine within 112 blocks`,
      `- needed at hand but not used up, one of each, none in storage: ${SCREWDRIVER}`,
    ])
    // 点名加氧的那条（1800 K）：高炉做得了，要 4000 mB 氧，仓里现在有 8000
    const oxygen = await s.total({ ...P.blades, count: 3, recipes: [R.smeltDarkOxygen] })
    assert.deepEqual(lacking(oxygen), [
      `- 压模机, 1 of its 1 job(s) (#${R.shaft}): no such machine within 112 blocks`,
      "- fluids to supply (a fluid is made only by a recipe you name or one the base's methods record for it): 4000 mB 氧 [fluid oxygen] (tanks here hold 8000 mB in 工业高炉 at (-5,64,9) HV)",
      `- needed at hand but not used up, one of each, none in storage: ${SCREWDRIVER}`,
    ])
    // 活儿清单里那一组也写着同一个事实
    assert.ok(oxygen.lines.includes('- 压模机 (1 job(s)) — no such machine within 112 blocks'))
  })

  it('一类零件的记录怎么对上一样东西：写了“从哪种料来”就挑那一条（不是那种做法里列在最前的）；限定了材料的那条在先；身上带着的东西也算库存', async (t) => {
    // 身上带着 1 个钢齿轮、2 个钢螺丝
    const s = setup(t, { inventory: [stack(P.steelGear, 1), stack(P.steelScrew, 2)] })
    // 重新导出的一本：最前面多了一条卷板机拿钢粉压钢板的配方（#0），原来的编号都加一
    s.reexport([{ h: 'gt.recipe.metalbender', in: [{ ...P.steelDust, n: 1 }, { id: 'gregtech:gt.integrated_circuit', meta: 2, n: 0 }], out: [{ ...P.steelPlate, n: 1 }], eut: 24, ticks: 56 }, ...RECIPES])
    const plateJob = async () => (await s.total({ ...P.steelPlate, count: 2 })).lines.at(-1)
    // 只说“板走卷板机”：取的是卷板机里列在最前的那条（钢粉的）
    await s.run('set_base_method', { part: 'plate', way: '卷板机', by: 'owner' })
    assert.equal(await plateJob(), '  - #0 × 2 → 2× 钢板 [gregtech:gt.metaitem.01/17305] [base method part:plate] — takes NOT DECIDED: 钢粉')
    // 说了“从锭来”：是钢锭那条
    await s.run('set_base_method', { part: 'plate', way: '卷板机', from: 'ingot', by: 'owner', why: '一锭一板' })
    assert.equal(await plateJob(), `  - #${R.bendSteel + 1} × 2 → 2× 钢板 [gregtech:gt.metaitem.01/17305] [base method part:plate]`)
    // 另记一条只管钢的：钢板照它走手工，玄钢板还是照“板走卷板机”
    await s.run('set_base_method', { part: 'plate', material: 'Steel', way: '有序合成', by: 'self', why: '卷板机被占着' })
    assert.equal(await plateJob(), `  - #${R.hammerSteel + 1} × 2 → 2× 钢板 [gregtech:gt.metaitem.01/17305] [base method part:plate:Steel]`)
    await s.run('set_base_method', { order: ['工业高炉', '搅拌机'], by: 'owner' })
    const blades = await s.total({ ...P.blades, recipes: [R.shaftShape + 1] })
    assert.ok(blades.lines.includes(`  - #${R.bendDark + 1} × 4 → 4× 玄钢板 [gregtech:gt.metaitem.01/17364] [base method part:plate]`), blades.text)
    // 身上的 1 个齿轮够了；螺丝要 3 个：仓库 3 个加身上 2 个，一个都不缺
    assert.equal(blades.lines.find((line) => line.startsWith('- nothing in the recipe book makes it')), '- nothing in the recipe book makes it (3): 2× 磁钢粉 [gregtech:gt.metaitem.01/2365] (need 2, none in storage), 2× 煤粉 [gregtech:gt.metaitem.01/2535] (need 2, none in storage), 2× 黑曜石粉 [gregtech:gt.metaitem.01/2804] (need 2, none in storage)')
    assert.match(blades.text, /1× 钢齿轮 \[gregtech:gt\.metaitem\.02\/31305\] \(there are 1 on you\)/)
    assert.match(blades.text, /3× 钢螺丝 \[gregtech:gt\.metaitem\.01\/27305\] \(there are 2 on you, 3 at \(12,64,-4\)\)/)
  })

  it('“当现成的”：从零算整条线要多少时停在锭——钢锭、玄钢锭不往下做，记成要现成的，写明是照哪一条（具体的矿辞名在前缀前面）；目标自己是锭时照样往下做', async (t) => {
    const s = setup(t)
    await s.teach()
    await s.run('set_base_method', { ready: 'ingot', by: 'owner', why: '从零算时停在锭' })
    await s.run('set_base_method', { ready: 'ingotSteel', by: 'owner' })
    const res = await s.total({ ...P.blades, count: 3, stock: false })
    // 玄钢锭以下（玄钢粉、搅拌机那一步）、钢锭以下（钢粉、高炉那一步）都不做了：要做的只剩板、模头、柄、桨叶
    assert.match(res.lines[0]!, /^For 3× 直升机桨叶 \[adventurebackpack:backpackComponent\/6\]: 4 thing\(s\) to make in 4 wave\(s\)/)
    assert.deepEqual(res.lines.slice(res.lines.indexOf('Raw materials needed (5):'), res.lines.indexOf('Raw materials needed (5):') + 3), [
      'Raw materials needed (5):',
      "- taken ready-made, by the base's methods (2): 108× 钢锭 [gregtech:gt.metaitem.01/11305] [ready:ingotSteel], 4× 玄钢锭 [EnderIO:itemAlloy/6] [ready:ingot]",
      '- nothing in the recipe book makes it (3): 9× 钢螺丝 [gregtech:gt.metaitem.01/27305], 3× 钢齿轮 [gregtech:gt.metaitem.02/31305], 1× 模头（杆） [gregtech:gt.metaitem.01/32351]',
    ])
    assert.deepEqual(res.data.missing.filter((m: any) => m.why === 'ready').map((m: any) => [m.name, m.count]), [['钢锭', 108], ['玄钢锭', 4]])
    assert.equal(res.text.includes('#' + R.mixDark + ' '), false)
    // 问的就是钢锭：照常往下做（照总的先后走高炉，钢粉没定）
    const ingot = await s.total({ ...P.steelIngot, count: 5, stock: false })
    assert.match(ingot.lines[0]!, /: 1 thing\(s\) to make in 1 wave\(s\) \(1 by the base's methods\); 1 thing\(s\) NOT DECIDED/)
    assert.equal(ingot.lines.at(-1), `  - #${R.smeltSteel} × 5 → 5× 钢锭 [gregtech:gt.metaitem.01/11305] [base order: 工业高炉] — takes NOT DECIDED: 钢粉`)
  })

  it('“两种做法用的料一样时用哪一种”：玄钢粉手工和搅拌机用的料一样（都是三样粉各一个、出 3 个），记了“无序合成胜过搅拌机，只在手工不用工具时”就走手工，写明照的是这一条；手工要工具、或者料不一样时它不起作用，往下照总的先后', async (t) => {
    const s = setup(t)
    const dusts = [{ ...P.magneticDust, n: 1 }, { ore: 'dustCoal', n: 1, any: [[P.coalDust.id, P.coalDust.meta]], more: 0 }, { ore: 'dustObsidian', n: 1, any: [[P.obsidianDust.id, P.obsidianDust.meta]], more: 0 }]
    const SHAPELESS = 'codechicken.nei.recipe.ShapelessRecipeHandler'
    const SHAPED = 'codechicken.nei.recipe.ShapedRecipeHandler'
    const hammer = { ore: 'craftingToolHardHammer', n: 1, any: [[P.hammer.id, P.hammer.meta]], more: 0 }
    // 新导出的一本：多一条手工的，和搅拌机那条（#6：三样粉 + 编程电路 2 → 3 个）一样的料、一样出 3 个
    const HAND = RECIPES.length
    s.reexport([...RECIPES, { h: SHAPELESS, in: dusts, out: [{ ...P.darkDust, n: 3 }] }])
    await s.teach()
    const darkDust = async () => (await s.total({ ...P.blades, count: 3 })).lines.find((line) => line.includes('玄钢粉 [gregtech:gt.metaitem.01/2364]'))
    // 还没记这条：照总的先后（工业高炉 > 搅拌机）走搅拌机
    assert.equal(await darkDust(), `  - #${R.mixDark} × 2 → 6× 玄钢粉 [gregtech:gt.metaitem.01/2364]; 2 left over [base order: 搅拌机]`)
    await s.run('set_base_method', { use: '无序合成', over: '搅拌机', noTools: true, by: 'owner', why: '料一样，手工不耗电' })
    // 手工那两条里，#7 出 2 个（料不一样，不算），新的那条出 3 个：用它
    assert.equal(await darkDust(), `  - #${HAND} × 2 → 6× 玄钢粉 [gregtech:gt.metaitem.01/2364]; 2 left over [base rule: same ingredients → 无序合成]`)
    // 换一本：同样的料、同样出 3 个，可手工那条要锤子
    s.reexport([...RECIPES, { h: SHAPED, in: [hammer, ...dusts], out: [{ ...P.darkDust, n: 3 }] }])
    await s.run('set_base_method', { use: '有序合成', over: '搅拌机', noTools: true, by: 'owner' })
    assert.equal(await darkDust(), `  - #${R.mixDark} × 2 → 6× 玄钢粉 [gregtech:gt.metaitem.01/2364]; 2 left over [base order: 搅拌机]`)
    // 不要“不用工具”这个条件：用手工那条
    await s.run('set_base_method', { use: '有序合成', over: '搅拌机', by: 'owner' })
    assert.equal(await darkDust(), `  - #${HAND} × 2 → 6× 玄钢粉 [gregtech:gt.metaitem.01/2364]; 2 left over [base rule: same ingredients → 有序合成]`)
  })

  it('一个结果装不下全部活儿时：没定的、还缺的在最前，活儿能列几条列几条，写明一共多少、剩下的怎么拿；程序拿到的 data 是全的', async (t) => {
    const s = setup(t)
    await s.teach()
    s.limit(2600)
    const first = await s.total({ ...P.blades, count: 3 })
    assert.ok(first.text.length <= 2600, `${first.text.length} characters`)
    assert.equal(first.lines.find((line) => line.startsWith('Jobs, ')), 'Jobs, 7, by when they can start and by way (jobs 1–2 of 7; the rest: the same call with from: 3; data has all of them):')
    assert.equal(first.lines.at(-1), `  - #${R.mixDark} × 2 → 6× 玄钢粉 [gregtech:gt.metaitem.01/2364]; 2 left over [base order: 搅拌机]`)
    // 单子放不下的也照实说还有几样
    assert.match(first.text, /2× 煤粉 \[gregtech:gt\.metaitem\.01\/2535\] \(need 2, none in storage\), … and 1 more \(all of them are in data\)/)
    assert.deepEqual([first.data.jobs.length, first.data.missing.length], [7, 5])
    const rest = await s.total({ ...P.blades, count: 3, from: 4 })
    assert.deepEqual(rest.lines.slice(0, 6), [
      'For 3× 直升机桨叶 [adventurebackpack:backpackComponent/6], the jobs from 4 on (what is not decided, what is missing and the rest are in the first part).',
      'Jobs, 7, by when they can start and by way (jobs 4–7 of 7; data has all of them):',
      'Wave 3 — these take things made in wave 2 (or earlier):',
      '- 卷板机 (1 job(s)) — CAN RUN NOW on 基础卷板机 at (16,64,-8) LV',
      `  基础卷板机 at (16,64,-8) LV — base's methods: 专门压板; feed: (16,65,-8); collect: (17,64,-8); do not touch: 电路别动 (your owner, ${DAY})`,
      `  - #${R.bendDark} × 4 → 4× 玄钢板 [gregtech:gt.metaitem.01/17364] [base method part:plate]`,
    ])
    assert.equal(rest.lines.at(-1), `  - #${R.blades} × 3 → 3× 直升机桨叶 [adventurebackpack:backpackComponent/6] [only recipe]`)
  })

  it('它不在游戏里时：库存和机器都看不到，照实说，数量照从零算', async (t) => {
    const s = setup(t)
    await s.teach()
    s.game.online = false
    const res = await s.total({ ...P.blades })
    assert.equal(res.lines[1], 'Storage could not be looked into (offline: Alu is not in the game world): nothing is deducted, and which machines stand in the base is not known.')
    assert.equal(res.lines.find((line) => line.startsWith('Raw materials')), 'Raw materials needed (6):')
    assert.ok(res.lines.includes('Which machines and crafting tables stand in the base could not be checked (offline: Alu is not in the game world).'))
    assert.equal(res.lines[3], '1. 36× 钢粉 [gregtech:gt.metaitem.01/2305]')
    assert.ok(res.lines.includes('- 工业高炉 (1 job(s))'))
    assert.equal(res.data.summary.stock, 'unknown')
  })

  it('基地的做法里记的配方在重新导出的配方册里没了：照实说哪条失效、它原来是什么，这样东西接着照后面的规矩走', async (t) => {
    const s = setup(t)
    await s.teach()
    // 新的一本：前面多了一条（编号都变了），做模头（转轴）的玄钢板那条没了，只剩钛板那条
    s.reexport([{ h: 'gt.recipe.metalbender', in: [{ ...P.titanPlate, n: 9 }], out: [{ ...P.sheet, n: 1 }] }, ...RECIPES.filter((_, n) => n !== R.shaftShape)])
    const res = await s.total({ ...P.blades })
    assert.equal(
      res.lines[2],
      "Recorded in the base's methods but no longer in the recipe book (set_base_method records it anew, or removes it): 模头（转轴） — it was 有序合成: 4× 玄钢板 + 1× 模头（杆） + any craftingToolHardHammer (e.g. 锤) (not used up) → 1× 模头（转轴） [key thing:miscutils:MU-metaitem.01/32040]",
    )
    // 模头（转轴）现在只有一条配方（钛板的）：没得选；编号是新的（少了一条、多了一条，还是原来的数）
    assert.ok(res.lines.includes(`  - #${R.shaftShapeTitan} × 1 → 1× 模头（转轴） [miscutils:MU-metaitem.01/32040] [only recipe]`), res.text)
    // 卷板机那条“板从锭来”的做法管不到钛板（钛板只有流体固化器浇得出来）：它也只有一条配方
    assert.ok(res.lines.includes(`  - #${R.castTitanPlate} × 4 → 4× 钛板 [gregtech:gt.metaitem.01/17028] [only recipe]`), res.text)
    assert.deepEqual(res.data.stale, [{ id: 'miscutils:MU-metaitem.01', meta: 32040, name: '模头（转轴）', key: 'thing:miscutils:MU-metaitem.01/32040', was: '4× 玄钢板 + 1× 模头（杆） + any craftingToolHardHammer (e.g. 锤) (not used up) → 1× 模头（转轴）' }])
  })

  it('回收的页（把钢齿轮拆回钢锭）不算一种做法：钢锭除了它只剩一条配方时，就是没得选', async (t) => {
    const s = setup(t)
    // 重新导出的一本里熔炉烧钢粉的那条没了：做钢锭的只剩高炉那条，和回收齿轮的那页
    s.reexport(RECIPES.filter((_, n) => n !== R.furnaceSteel))
    const res = await s.total({ ...P.blades })
    assert.ok(res.lines.includes(`  - #${R.smeltSteel} × 16 → 16× 钢锭 [gregtech:gt.metaitem.01/11305]; 20 more come from storage [only recipe] — takes NOT DECIDED: 钢粉`), res.text)
    // 没定的是钢粉（研磨机有两条），摆出来的做法里也没有回收页
    assert.equal(res.lines[3], '1. 16× 钢粉 [gregtech:gt.metaitem.01/2305] (need 16, none in storage)')
    assert.equal(res.text.includes('回收'), false)
  })

  it('目标自己没有配方、点名的配方绕成了圈、目标没说清：各说各的，不猜；仓库里的料够时什么都不缺', async (t) => {
    const s = setup(t)
    await s.teach()
    assert.deepEqual((await s.total({ ...P.steelGear })).lines, [
      "For 1× 钢齿轮 [gregtech:gt.metaitem.02/31305]: 0 thing(s) to make; 0 thing(s) NOT DECIDED. This adds up amounts by the base's methods (4 entries); it chooses no recipe.",
      LOOKED,
      'Nothing is expanded: no recipe is settled for the target itself — nothing in the recipe book makes it.',
      'Raw materials still missing after storage (1):',
      '- nothing in the recipe book makes it (1): 1× 钢齿轮 [gregtech:gt.metaitem.02/31305] (need 1, none in storage)',
    ])
    // 钢锭从钢粉炼、钢粉又从钢锭磨：两条都点了名
    const circle = await s.total({ ...P.steelIngot, recipes: [R.smeltSteel, R.grindIngot] })
    assert.deepEqual([circle.ok, circle.text], [false, `These recipes feed each other in a circle (recipe #${R.smeltSteel} ends up needing its own product), so the amounts cannot be added up. Leave out the recipe that turns a product back into its ingredient.`])
    assert.deepEqual([(await s.total({ id: 'x', fluid: 'y' })).text, (await s.total({})).text], Array(2).fill('Give exactly one target: "id" (an item) or "fluid" (a fluid; "count" is then mB).'))
    // 2 块钢板：照“板走卷板机”，2 个钢锭仓库里有
    assert.deepEqual((await s.total({ ...P.steelPlate, count: 2 })).lines, [
      "For 2× 钢板 [gregtech:gt.metaitem.01/17305]: 1 thing(s) to make in 1 wave(s) (1 by the base's methods); 0 thing(s) NOT DECIDED. This adds up amounts by the base's methods (4 entries); it chooses no recipe.",
      LOOKED,
      'No raw material is missing: storage covers them.',
      'Used from storage (1): 2× 钢锭 [gregtech:gt.metaitem.01/11305] (there are 20 at (12,64,-4))',
      AUTOMATED,
      'Jobs, 1, by when they can start and by way:',
      'Wave 1 — these take only raw materials and what is in storage:',
      '- 卷板机 (1 job(s)) — CAN RUN NOW on 基础卷板机 at (16,64,-8) LV',
      `  基础卷板机 at (16,64,-8) LV — base's methods: 专门压板; feed: (16,65,-8); collect: (17,64,-8); do not touch: 电路别动 (your owner, ${DAY})`,
      `  - #${R.bendSteel} × 2 → 2× 钢板 [gregtech:gt.metaitem.01/17305] [base method part:plate]`,
    ])
  })
})
