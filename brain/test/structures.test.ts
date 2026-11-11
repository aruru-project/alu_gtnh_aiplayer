// 多方块机器的结构（玩家说的“投影”）：本地资料加载、程序里拿数据、库函数（查结构、对着世界里那台比、读一个盒子的方块）。
// 库函数只在它写的程序里能调，不是发给模型的工具。数据是自造的小样本（fixture-structures.ts），世界是按方法名应答的假服务器。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { DesignWorkspace } from '../src/design/index.ts'
import { loadPackData } from '../src/packdata/index.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { ALL_TOOLS, LIBRARY_TOOLS, QUERY_TOOLS, programTools, runTool, toToolSpecs } from '../src/tools/index.ts'
import type { ToolContext, ToolResult } from '../src/tools/index.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { S, writeStructureFixture } from './fixture-structures.ts'
import { tmpDir } from './helpers.ts'

type Block = { id: string; meta: number }
const HATCH: Block = { id: 'gregtech:gt.blockmachines', meta: 5 }

function setup(t: { after(fn: () => void): void }, opts: { structures?: boolean; badLine?: boolean } = {}) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  if (opts.structures !== false) writeStructureFixture(tmp.dir, opts.badLine ? ['{"id":"x","size":"not a size"}'] : [])
  const said: string[] = []
  const packdata = loadPackData(tmp.dir, (m) => said.push(m))
  const game = new FakeGame()
  /** 世界里的方块：没写的都是空气。world.blocks 照协议回答（调色板 + 连续个数，x 最快，其次 z，最后 y）。 */
  const world = new Map<string, Block>()
  const put = (x: number, y: number, z: number, b: Block | null): void => void (b ? world.set(`${x},${y},${z}`, { id: b.id, meta: b.meta }) : world.delete(`${x},${y},${z}`))
  game.handlers['world.blocks'] = (p) => {
    const lo = (a: string, b: string) => Math.min(Number(p[a]), Number(p[b]))
    const hi = (a: string, b: string) => Math.max(Number(p[a]), Number(p[b]))
    const [x0, y0, z0, x1, y1, z1] = [lo('x1', 'x2'), lo('y1', 'y2'), lo('z1', 'z2'), hi('x1', 'x2'), hi('y1', 'y2'), hi('z1', 'z2')]
    const palette: Block[] = [{ id: 'minecraft:air', meta: 0 }]
    const runs: number[] = []
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const b = world.get(`${x},${y},${z}`)
      let index = b ? palette.findIndex((q) => q.id === b.id && q.meta === b.meta) : 0
      if (index < 0) index = palette.push(b!) - 1
      if (runs.length > 0 && runs.at(-2) === index) runs[runs.length - 1]!++
      else runs.push(index, 1)
    }
    return { x: x0, y: y0, z: z0, sx: x1 - x0 + 1, sy: y1 - y0 + 1, sz: z1 - z0 + 1, palette, runs, unloaded: 0 }
  }
  const ctx: ToolContext = {
    botName: 'Alu',
    bridge: new BridgeApi(game),
    memory: new MemoryStore(tmp.dir, () => 300),
    manuals: new ManualStore(DEFAULT_MANUALS_DIR, `${tmp.dir}/manuals`),
    design: new DesignWorkspace({ dataDir: tmp.dir, now: () => 1_800_000_000_000, packdata }),
    packdata,
    reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
    hooks: {},
    now: () => 1_800_000_000_000,
    // run_program 里的程序调工具：和大脑（agent.ts 的 queryFromProgram）一样，只许查询类的，工具表是模型的工具加库函数
    queryFromProgram: async (name, input) => {
      if (!QUERY_TOOLS.includes(name)) return { ok: false, text: `${name} cannot be called from run_program` }
      const res = await lib(name, input)
      return { ok: res.isError !== true, text: res.content, ...(res.data !== undefined ? { data: res.data } : {}) }
    },
  }
  /** 程序里调一个库函数走的就是这一步（agent.ts、routine.ts 用 programTools 拿工具表）。 */
  const lib = (name: string, input: unknown = {}): Promise<ToolResult> => runTool(programTools(ALL_TOOLS), ctx, name, input, { maxResultChars: 20_000 })
  const model = (name: string, input: unknown = {}): Promise<ToolResult> => runTool(ALL_TOOLS, ctx, name, input, { maxResultChars: 20_000 })
  /** 模型用 run_program 跑一段程序；失败了就让测试带着它的报错失败。 */
  const program = async (code: string): Promise<string> => {
    const res = await model('run_program', { code })
    assert.equal(res.isError, undefined, res.content)
    return res.content
  }
  return { game, said, packdata, put, lib, model, program }
}

/**
 * 在世界里照 T1 搭一台小离心机，主机在 (100,64,200)、正面朝西。
 * 结构数据里主机朝南；朝西就是把它绕主机转一个直角：数据里的 (x, y, z) 在世界里是 (100 − (z − 2), 64 + y, 200 + (x − 1))。
 */
const AT = { x: 100, y: 64, z: 200 }
function buildFacingWest(put: (x: number, y: number, z: number, b: Block | null) => void): void {
  const layers = [
    ['CCC', 'CGC', 'CMC'],
    ['CCC', 'C.C', 'CCC'],
  ]
  layers.forEach((rows, y) =>
    rows.forEach((row, z) =>
      [...row].forEach((ch, x) => {
        const b = ch === 'C' ? S.copper : ch === 'G' ? S.bronzeGear : ch === 'M' ? S.centrifuge : null
        put(100 - (z - 2), 64 + y, 200 + (x - 1), b)
      }),
    ),
  )
}

describe('多方块结构：本地资料', () => {
  it('structures.jsonl 在就加载（认不出来的行跳过并说明），不在就当没有；库函数不在发给模型的工具里，只在程序里调得到', (t) => {
    const s = setup(t, { badLine: true })
    assert.ok(s.said.includes('多方块结构：4 台机器、10 种等级的结构（1 行认不出来，跳过了）。'), s.said.join('\n'))
    assert.deepEqual(s.packdata.structures!.get(S.centrifuge.id, S.centrifuge.meta)!.rows.map((r) => [r.tiers, r.size, r.blocks.map((b) => b.n)]), [[[1], [3, 2, 3], [15, 1, 1]], [[2], [3, 2, 3], [15, 1, 1]]])
    const none = setup(t, { structures: false })
    assert.equal(none.packdata.structures, undefined)
    assert.equal(none.said.some((m) => m.includes('多方块')), false)
    // 模型的工具清单里没有它们；程序里（连只许查询的 run_program）调得到
    const offered = toToolSpecs(ALL_TOOLS).map((x) => x.name)
    for (const tool of LIBRARY_TOOLS) assert.deepEqual([offered.includes(tool.name), QUERY_TOOLS.includes(tool.name), programTools(ALL_TOOLS).some((x) => x.name === tool.name)], [false, true, true], tool.name)
  })

  it('程序里把它当数据拿：data.structure 按中文名或主机的 id/meta 取一台机器各等级的结构、材料、说明；重名的要给 id/meta', async (t) => {
    const s = setup(t)
    const res = await s.model('run_program', {
      code: `
        const m = data.structure('大型蒸汽离心机')
        const t2 = m.tier(2)
        // 每格是什么：下标 (y*sz + z)*sx + x。主机在 controller 那一格
        const at = (row, x, y, z) => row.palette[row.cells[(y * row.size[2] + z) * row.size[0] + x]]
        let twins
        try { data.structure('工业离心机') } catch (e) { twins = e.message }
        return [data.available(), data.structures().length, m.tiers, t2.size, t2.blocks.map((b) => b.n + ' ' + b.name),
          at(t2, ...t2.controller).name, at(t2, 1, 0, 1).name, at(t2, 1, 1, 1).id, m.structureInfo[2],
          data.structure('${S.furnace.id}', ${S.furnace.meta}).tiers, data.structure('没有这台'), twins]`,
    })
    assert.equal(res.isError, undefined, res.content)
    assert.deepEqual(JSON.parse(/^Returned: (.*)$/m.exec(res.content)![1]!), [
      ['structures'],
      4,
      [1, 2],
      [3, 2, 3],
      ['15 脱氧钢机械方块', '1 钢齿轮箱机械方块', '1 大型蒸汽离心机'],
      '大型蒸汽离心机',
      '钢齿轮箱机械方块',
      'minecraft:air',
      '控制器: 底层，正面中央',
      [1, 2, 3, 4, 5, 6],
      null,
      '2 machines are named 工业离心机: use data.structure(id, meta) with one of gregtech:gt.blockmachines/790, gregtech:gt.blockmachines/31027',
    ])
  })
})

describe('多方块结构：库函数（程序里 await tool(…) 调）', () => {
  it('find_structure：有哪些等级、各要什么方块、机器自己的结构说明、两个等级之间差什么；等级多的把“每级都一样的”和“随等级变的”分开说；重名的列出来让它挑', async (t) => {
    const s = setup(t)
    // 模型自己调不到
    assert.match((await s.model('find_structure', { name: '大型蒸汽离心机' })).content, /^There is no tool named "find_structure"\./)
    const overview = (await s.lib('find_structure', { name: '蒸汽离心' })).content.split('\n')
    assert.deepEqual(overview, [
      '大型蒸汽离心机 [gregtech:gt.blockmachines/31080]: a multiblock machine with 2 tier(s) (1–2; the tier is how many Multiblock Structure Hologram Projectors are stacked when it is built).',
      'About it: 机器类型: 离心机 | 并行：8',
      'How it is built (the machine\'s own notes; "任意机械方块" means that part may replace any casing):',
      '- 大小: 3x3x2 (LxWxH)',
      '- 控制器: 底层，正面中央',
      '- 1+ 蒸汽输入总线: 任意机械方块',
      '- 投影仪堆叠数量确定结构等级',
      'Tier 1 — 3×2×3 blocks (x×y×z): 15× 镀铜砖块 [gregtech:gt.blockcasings/10], 1× 青铜齿轮箱机械方块 [gregtech:gt.blockcasings2/2], 1× 大型蒸汽离心机 [gregtech:gt.blockmachines/31080]',
      'Tier 2 — 3×2×3 blocks (x×y×z): 15× 脱氧钢机械方块 [gregtech:gt.blockcasings2], 1× 钢齿轮箱机械方块 [gregtech:gt.blockcasings2/3], 1× 大型蒸汽离心机 [gregtech:gt.blockmachines/31080]',
      'From tier 1 to tier 2: 15× 镀铜砖块 → 脱氧钢机械方块 [gregtech:gt.blockcasings2]; 1× 青铜齿轮箱机械方块 → 钢齿轮箱机械方块 [gregtech:gt.blockcasings2/3]',
      'Give "tier" for one tier in full, "from" and "tier" for what changes between two. check_structure compares a machine standing in the world with a tier.',
    ])
    const diff = await s.lib('find_structure', { ...S.centrifuge, from: 1, tier: 2 })
    assert.deepEqual(diff.content.split('\n').slice(0, 3), ['大型蒸汽离心机 [gregtech:gt.blockmachines/31080], tier 1 → tier 2:', '- 15× 镀铜砖块 → 脱氧钢机械方块 [gregtech:gt.blockcasings2]', '- 1× 青铜齿轮箱机械方块 → 钢齿轮箱机械方块 [gregtech:gt.blockcasings2/3]'])
    assert.equal((await s.lib('find_structure', { ...S.centrifuge, tier: 3 })).content, '大型蒸汽离心机 [gregtech:gt.blockmachines/31080] has no tier 3: its tiers are 1, 2.')
    // 六种线圈各一级：不逐级把整张清单倒出来
    const many = (await s.lib('find_structure', { name: '工业高炉' })).content.split('\n')
    assert.equal(many[4], '6 different builds. Every tier is 1×3×1 blocks (x×y×z). The same in every tier: 1× 工业高炉 [gregtech:gt.blockmachines/1000], 1× 隔热机械方块 [gregtech:gt.blockcasings/11].')
    assert.deepEqual(many.slice(6, 12), [1, 2, 3, 4, 5, 6].map((n) => `- tier ${n}: 1× ${S.coil(n - 1).name} [gregtech:gt.blockcasings5${n === 1 ? '' : `/${n - 1}`}]`))
    const twins = (await s.lib('find_structure', { name: '工业离心机' })).content.split('\n')
    assert.deepEqual(twins, ['2 multiblock machines match "工业离心机" (several machines share that very name). Ask again with the id and meta of the one you mean:', '- 工业离心机 [gregtech:gt.blockmachines/790], 1 tier(s)', '- 工业离心机 [gregtech:gt.blockmachines/31027], 1 tier(s)'])
    assert.equal((await s.lib('find_structure', { name: '聚变' })).isError, true)
    // 没有这份资料时说清楚
    assert.match((await setup(t, { structures: false }).lib('find_structure', { name: '工业高炉' })).content, /^There is no multiblock structure data on this brain/)
  })

  it('check_structure：世界里那台主机朝西（数据里朝南）也对得上；预览是机械方块、世界里是仓的位置算对；列出哪些位置要换成什么，材料对着身上和仓库算还差多少', async (t) => {
    const s = setup(t)
    buildFacingWest(s.put)
    // 主人在背面上层的角上放了一个仓（数据里的 (0,1,0)，世界里是 (102,65,199)）；背面底层另一个角 (2,0,0) → (102,64,201) 还空着
    s.put(102, 65, 199, HATCH)
    s.put(102, 64, 201, null)
    // 身体认得这台主机；身上有 3 个脱氧钢机械方块，旁边箱子里有 5 个（往四周错开查四次，同一个箱子只算一次）
    s.game.handlers['world.machines'] = () => ({ machines: [{ ...AT, name: 'Steam Separator', ...S.centrifuge, kind: 'multiblock', formed: true }], total: 1 })
    const status = s.game.handlers['bot.status']!
    s.game.handlers['bot.status'] = (p) => ({ ...(status(p) as object), inventory: [{ slot: 0, ...S.steel, count: 3 }] })
    s.game.handlers['world.stock'] = (p) => ({ containersLookedInto: 1, items: (p.items as Block[]).map((q) => (q.id === S.steel.id && q.meta === S.steel.meta ? { ...q, total: 5, places: [{ x: 90, y: 64, z: 190, container: 'Chest', count: 5 }] } : { ...q, total: 0, places: [] })) })

    const res = await s.lib('check_structure', { at: AT, tier: 2 })
    assert.equal(res.isError, undefined, res.content)
    assert.deepEqual(res.content.split('\n'), [
      // 现在是 T1：17 格里 16 格在位（缺的那个角不算，仓算）
      '大型蒸汽离心机 at (100,64,200): its front faces west. Right now it looks like tier 1 (16 of 17 blocks of that build are in place).',
      // 对着 T2：主机和那个仓是对的，其余 15 格要动
      'Against tier 2: 2 of 17 positions are already right, 15 have to change.',
      '(1 position(s) hold a machine part — a bus, a hatch — where the projection shows a casing: they count as right and stay.)',
      'To change:',
      '- 13× 镀铜砖块 [gregtech:gt.blockcasings/10] → 脱氧钢机械方块 [gregtech:gt.blockcasings2], at (102,64,199) (102,64,200) (101,64,199) (101,64,201) (100,64,199) … (8 more)',
      '- 1× nothing (empty) → 脱氧钢机械方块 [gregtech:gt.blockcasings2], at (102,64,201)',
      '- 1× 青铜齿轮箱机械方块 [gregtech:gt.blockcasings2/2] → 钢齿轮箱机械方块 [gregtech:gt.blockcasings2/3], at (101,64,200)',
      'Blocks that takes:',
      '- 14× 脱氧钢机械方块 [gregtech:gt.blockcasings2]: you carry 3, storage has 5 — 6 SHORT',
      '- 1× 钢齿轮箱机械方块 [gregtech:gt.blockcasings2/3]: you carry 0, storage has 0 — 1 SHORT',
      'Taken out in exchange: 13× 镀铜砖块, 1× 青铜齿轮箱机械方块.',
      'Every position is in the result data (data.changes: x, y, z, from, to; data.need: the blocks). How to get a missing block made: crafting manual; how to put them in place: multiblocks manual.',
    ])
    const data = res.data as { facing: string; looksLike: number[]; changes: { x: number; y: number; z: number; from: Block | null; to: Block }[]; need: { id: string; meta: number; count: number; short: number }[] }
    assert.deepEqual([data.facing, data.looksLike, data.changes.length], ['west', [1], 15])
    assert.deepEqual(data.changes.find((c) => c.from === null), { x: 102, y: 64, z: 201, from: null, to: S.steel })
    assert.deepEqual(data.need.map((n) => [n.id, n.meta, n.count, n.short]), [[S.steel.id, 0, 14, 6], [S.steelGear.id, 3, 1, 1]])
    // 已经是这一级了：没有要动的
    assert.match((await s.lib('check_structure', { at: AT, tier: 1 })).content, /\nAgainst tier 1: 16 of 17 positions are already right, 1 have to change\.\n/)
    // 那个位置不是身体认得的主机：要它说清是哪台
    s.game.handlers['world.machines'] = () => ({ machines: [], total: 0 })
    assert.match((await s.lib('check_structure', { at: AT, tier: 2 })).content, /^There is no multiblock controller the body recognises at \(100,64,200\)\./)
    assert.equal((await s.lib('check_structure', { at: AT, tier: 2, ...S.centrifuge })).isError, undefined)
  })

  it('手册里那段示例程序（“这台机器升到某一级要换什么”）是真能跑的：照抄进 run_program，结论和 check_structure 一样', async (t) => {
    const s = setup(t)
    buildFacingWest(s.put)
    s.put(102, 65, 199, HATCH)
    s.put(102, 64, 201, null)
    const status = s.game.handlers['bot.status']!
    s.game.handlers['bot.status'] = (p) => ({ ...(status(p) as object), inventory: [{ slot: 0, ...S.steel, count: 3 }] })
    s.game.handlers['world.stock'] = (p) => ({ containersLookedInto: 1, items: (p.items as Block[]).map((q) => (q.id === S.steel.id && q.meta === S.steel.meta ? { ...q, total: 5, places: [{ x: 90, y: 64, z: 190, container: 'Chest', count: 5 }] } : { ...q, total: 0, places: [] })) })
    const manual = fs.readFileSync(path.join(DEFAULT_MANUALS_DIR, 'multiblocks.md'), 'utf8')
    const code = /```js\n([\s\S]*?)```/.exec(manual)![1]!
    // run_program 里调工具要经大脑（agent.ts）；这里照它的做法接上：只许查询类的，库函数也在里面
    const res = await s.program(code)
    assert.deepEqual(/^Returned: ([\s\S]*)$/m.exec(res)![1]!.split('\n').slice(0, 3), ['主机朝西，现在是 1 级的样子；对着 2 级要换 15 处', '14× 脱氧钢机械方块：身上 3，仓库 5，还差 6', '1× 钢齿轮箱机械方块：身上 0，仓库 0，还差 1'])
  })

  it('read_blocks：一个盒子里每格是什么，给程序自己对结构、数方块用', async (t) => {
    const s = setup(t)
    s.put(10, 64, 10, S.copper)
    s.put(11, 65, 10, S.steel)
    const res = await s.lib('read_blocks', { x1: 11, y1: 65, z1: 11, x2: 10, y2: 64, z2: 10 })
    assert.equal(res.content, '2×2×2 blocks (x×y×z) from (10,64,10): 1× [gregtech:gt.blockcasings/10], 1× [gregtech:gt.blockcasings2]. Every block is in the result data, for a program.')
    // 下标 (dy*sz + dz)*sx + dx：(10,64,10) 是第 0 格，(11,65,10) 是第 5 格
    assert.deepEqual(res.data, { x: 10, y: 64, z: 10, sx: 2, sy: 2, sz: 2, palette: [{ id: 'minecraft:air', meta: 0 }, { id: S.copper.id, meta: 10 }, { id: S.steel.id, meta: 0 }], cells: [1, 0, 0, 0, 0, 2, 0, 0], unloaded: 0 })
    assert.deepEqual(await s.lib('read_blocks', { x1: 0, y1: 0, z1: 0, x2: 64, y2: 1, z2: 1 }), { content: 'The box is 65×2×2 (x × y × z); each side can be at most 64. Read it in several pieces.', isError: true })
  })
})
