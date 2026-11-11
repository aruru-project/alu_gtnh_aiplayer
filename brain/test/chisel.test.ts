// 凿子的组（packdata 的 carving.jsonl）：图纸要的常常是某个具体花纹（chisel:nucrete/7），凿子变体不是配方，配方册里查不到。
// 入口是模型用的工具（find_recipes、find_item）和它写的程序（find_uses、total_materials 这两个库函数，和程序里的 data）；
// 资料是这里自造的一小份：两个组、几样物品、两条配方。预期的数量是照这份资料手算的。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { DesignWorkspace } from '../src/design/index.ts'
import { loadPackData } from '../src/packdata/index.ts'
import { makeAgent, modelCalls } from './agent-harness.ts'
import type { AgentHarness } from './agent-harness.ts'
import { tmpDir } from './helpers.ts'

const NUCRETE = (meta: number) => ({ id: 'chisel:nucrete', meta, name: '结构混凝土' })
const ITEMS = [
  ...[0, 1, 2, 3].map((meta) => ({ ...NUCRETE(meta), en: 'Nucrete' })),
  { id: 'minecraft:cobblestone', meta: 0, name: '圆石', en: 'Cobblestone', ores: ['cobblestone'] },
  { id: 'chisel:cobblestone', meta: 1, name: '圆石砖', en: 'Cobblestone Bricks' },
  { id: 'chisel:cobblestone', meta: 2, name: '碎裂圆石砖', en: 'Cracked Cobblestone Bricks' },
  // 不在组里，但带着“圆石”这一组认的矿辞名
  { id: 'demo:mossy', meta: 0, name: '苔圆石块', en: 'Mossy Cobble', ores: ['cobblestone'] },
  { id: 'minecraft:gravel', meta: 0, name: '沙砾', en: 'Gravel' },
  { id: 'minecraft:furnace', meta: 0, name: '熔炉', en: 'Furnace' },
  { id: 'chisel:chisel', meta: 0, name: '凿子', en: 'Chisel' },
  { id: 'minecraft:stick', meta: 0, name: '木棍', en: 'Stick' },
]
const SHAPED = 'codechicken.nei.recipe.ShapedRecipeHandler'
const HANDLERS = [{ key: SHAPED, name: '有序合成', mod: 'Minecraft', grid: true, machines: [{ id: 'minecraft:crafting_table', meta: 0 }], recipes: 2, read: 'all' }]
const RECIPES = [
  // #0：4 个沙砾合成 2 个结构混凝土 /0（配方册里只有这一种花纹有做法）
  { h: SHAPED, in: [0, 1, 3, 4].map((g) => ({ id: 'minecraft:gravel', meta: 0, n: 1, g })), out: [{ id: 'chisel:nucrete', meta: 0, n: 2 }] },
  // #1：8 个圆石合成 1 个熔炉
  { h: SHAPED, in: [0, 1, 2, 3, 5, 6, 7, 8].map((g) => ({ ore: 'cobblestone', n: 1, g, any: [['minecraft:cobblestone', 0]], more: 0 })), out: [{ id: 'minecraft:furnace', meta: 0, n: 1 }] },
]
const CARVING = [
  { group: 'nucrete', variants: [0, 1, 2, 3].map(NUCRETE) },
  { group: 'cobblestone', ore: 'cobblestone', variants: [{ id: 'minecraft:cobblestone', meta: 0, name: '圆石' }, { id: 'chisel:cobblestone', meta: 1, name: '圆石砖' }, { id: 'chisel:cobblestone', meta: 2, name: '碎裂圆石砖' }] },
  // 认不出来的一行：跳过
  { group: 'broken' },
]

const HOW =
  'A chisel is a hand tool, not a machine and not a recipe: held and right-clicked it opens its own screen (open_screen with "item": the chisel), the blocks go in, and the variant wanted is clicked there (screens manual). Chisels are items: find_item "凿子".'
const COST = 'one block gives one block, nothing else is used up; what a conversion costs the chisel in durability is not in the data'
const POINTER = `   ${HOW} Every block of the group with its id and meta: way "凿子"; in a program, data.chisel of this result, or data.chiselGroupsOf(id, meta).`

function setup(t: { after(fn: () => void): void }, opts: { carving?: boolean } = {}): AgentHarness & { loaded: string[] } {
  const tmp = tmpDir()
  const dir = path.join(tmp.dir, 'packdata')
  fs.mkdirSync(dir, { recursive: true })
  const lines = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
  fs.writeFileSync(path.join(dir, 'items.jsonl'), lines(ITEMS))
  fs.writeFileSync(path.join(dir, 'handlers.json'), JSON.stringify(HANDLERS))
  fs.writeFileSync(path.join(dir, 'recipes.jsonl'), lines(RECIPES))
  if (opts.carving !== false) fs.writeFileSync(path.join(dir, 'carving.jsonl'), lines(CARVING))
  const loaded: string[] = []
  const packdata = loadPackData(dir, (line) => loaded.push(line))
  const h = makeAgent({ dir: tmp.dir, design: new DesignWorkspace({ dataDir: tmp.dir, packdata }), packdata })
  t.after(async () => {
    await h.agent.stop()
    packdata.recipes?.close()
    tmp.cleanup()
  })
  // 身边没有机器；有一张合成台
  h.game.handlers['world.machines'] = () => ({ machines: [], total: 0 })
  h.game.handlers['world.find'] = () => ({ matches: [{ x: 8, y: 64, z: -4, id: 'minecraft:crafting_table', meta: 0, dist: 3 }], total: 1 })
  h.game.handlers['world.containers'] = () => ({ containers: [], total: 0 })
  return Object.assign(h, { loaded })
}

/** 模型用 run_program 跑一段程序，返回它 return 的值（JSON）。 */
async function program(h: AgentHarness, code: string): Promise<any> {
  const res = await modelCalls(h, 'run_program', { code })
  assert.equal(res.isError, false, res.content)
  return JSON.parse(/^Returned: (.*)$/ms.exec(res.content)![1]!)
}

describe('凿子的组', () => {
  it('查一种花纹怎么来：配方册里没有它的配方时，照实说它是凿子哪一组里的一种、同组还有哪些、凿子怎么用；全部变体在 way "凿子" 和 data 里', async (t) => {
    const h = setup(t)
    assert.ok(h.loaded.includes('凿子的组：2 组、7 种方块（1 行认不出来，跳过了）。'), h.loaded.join('\n'))
    const res = await modelCalls(h, 'find_recipes', { id: 'chisel:nucrete', meta: 3 })
    assert.equal(res.isError, false)
    assert.deepEqual(res.content.split('\n'), [
      'No recipe in the recipe book makes 结构混凝土 [chisel:nucrete/3]. It is made another way:',
      `凿子 (Chisel) — 结构混凝土 [chisel:nucrete/3] is one of the 4 blocks of chisel group "nucrete": a chisel turns any block of the group into any other block of the same group (${COST}).`,
      '   It can be chiselled from any of the other 3: chisel:nucrete/0–2 "结构混凝土".',
      POINTER,
    ])
    // 点名要“凿子”这种做法：一行一种，标出问的是哪一个
    const all = await modelCalls(h, 'find_recipes', { id: 'chisel:nucrete', meta: 3, way: '凿子' })
    assert.deepEqual(all.content.split('\n'), [
      `Chisel group "nucrete": 4 blocks; 结构混凝土 [chisel:nucrete/3] is one of them. A chisel turns any block of the group into any other (${COST}).`,
      '- 结构混凝土 [chisel:nucrete/0]',
      '- 结构混凝土 [chisel:nucrete/1]',
      '- 结构混凝土 [chisel:nucrete/2]',
      '- 结构混凝土 [chisel:nucrete/3]  ← this one',
      HOW,
    ])
    // 程序里：同一个结果的 data 里是全部变体
    assert.deepEqual(await program(h, `return (await tool('find_recipes', { id: 'chisel:nucrete', meta: 3 })).data`), {
      item: { id: 'chisel:nucrete', meta: 3, name: '结构混凝土' },
      chisel: [{ group: 'nucrete', member: true, variants: [0, 1, 2, 3].map(NUCRETE) }],
    })
  })

  it('有配方的那一种：配方照旧列，凿子作为又一种做法排在最后（不排好坏）；组认矿辞名的写明', async (t) => {
    const h = setup(t)
    const made = (await modelCalls(h, 'find_recipes', { id: 'chisel:nucrete' })).content.split('\n')
    assert.equal(made[0], "结构混凝土 [chisel:nucrete] can be made 1 way(s), 1 recipe(s) in all, and with a chisel (last entry). Listed by way of making, in the recipe book's order; what stands in your base for each way is stated, nothing is ranked or recommended:")
    assert.match(made[1]!, /^1\. 有序合成 — 1 recipe\(s\); /)
    assert.equal(made[2], '   #0: 4× 沙砾 [minecraft:gravel] → 2× 结构混凝土 (per 结构混凝土: 2 沙砾) — fits your 2x2 grid')
    assert.deepEqual(made.slice(3, 6), [
      `2. 凿子 (Chisel) — 结构混凝土 [chisel:nucrete] is one of the 4 blocks of chisel group "nucrete": a chisel turns any block of the group into any other block of the same group (${COST}).`,
      '   It can be chiselled from any of the other 3: chisel:nucrete/1–3 "结构混凝土".',
      POINTER,
    ])
    // 这一组认矿辞名 cobblestone：带这个名的东西也能凿成它
    const brick = (await modelCalls(h, 'find_recipes', { id: 'chisel:cobblestone', meta: 2 })).content.split('\n')
    assert.deepEqual(brick.slice(1, 4), [
      `凿子 (Chisel) — 碎裂圆石砖 [chisel:cobblestone/2] is one of the 3 blocks of chisel group "cobblestone": a chisel turns any block of the group into any other block of the same group (${COST}).`,
      '   It can be chiselled from any of the other 2: minecraft:cobblestone/0 "圆石"; chisel:cobblestone/1 "圆石砖".',
      '   The group also takes anything under the ore name cobblestone: such a block can be chiselled into 碎裂圆石砖 [chisel:cobblestone/2] too.',
    ])
    // 找物品时：组里的东西标着它在哪一组
    const found = (await modelCalls(h, 'find_item', { query: '结构混凝土', limit: 1 })).content
    assert.match(found, /\n- 结构混凝土 \[chisel:nucrete\]: 1 recipe\(s\) make it; used in none; chisel group "nucrete"$/)
  })

  it('查一样东西能拿来做什么：除了用到它的配方，还列出它能凿成同组的哪些；只带着矿辞名、自己不在组里的东西也能凿成那一组', async (t) => {
    const h = setup(t)
    const stone = await program(h, `const r = await tool('find_uses', { id: 'minecraft:cobblestone' }); return { text: r.text.split('\\n'), data: r.data }`)
    assert.deepEqual(stone.text, [
      '圆石 [minecraft:cobblestone] is an ingredient of 1 recipe(s), in 1 way(s) (the same recipe can be listed more than once in the book):',
      '- 有序合成: 1 recipe(s), e.g. makes 熔炉',
      'See the recipes with "way" (one of the names above), narrowed with "contains" (a word of the product or of another ingredient) and "circuit" (the programmed circuit number), page by page.',
      'Besides the recipes:',
      `- 凿子 (Chisel) — 圆石 [minecraft:cobblestone] is one of the 3 blocks of chisel group "cobblestone": a chisel turns it into any of the other 2 (${COST}): chisel:cobblestone/1–2 "圆石砖", "碎裂圆石砖".`,
      POINTER,
    ])
    assert.deepEqual(stone.data.chisel, [{ group: 'cobblestone', ore: 'cobblestone', member: true, variants: CARVING[1]!.variants }])
    // 苔圆石块不在组里，只是带着 cobblestone 这个矿辞名
    const mossy = await program(h, `const r = await tool('find_uses', { id: 'demo:mossy' }); return { text: r.text.split('\\n'), member: r.data.chisel.map((g) => [g.group, g.member, g.variants.length]) }`)
    assert.equal(mossy.text[4], `- 凿子 (Chisel) — 苔圆石块 [demo:mossy] carries the ore name cobblestone, which chisel group "cobblestone" (3 blocks) takes: a chisel turns it into any block of that group (${COST}): minecraft:cobblestone/0 "圆石"; chisel:cobblestone/1–2 "圆石砖", "碎裂圆石砖".`)
    assert.deepEqual(mossy.member, [['cobblestone', false, 3]])
    // 没有配方用到它的那一种：只有凿子这一条
    const only = await program(h, `const r = await tool('find_uses', { id: 'chisel:nucrete', meta: 2 }); return r.text.split('\\n').slice(0, 2)`)
    assert.deepEqual(only, [
      'Nothing in the recipe book uses 结构混凝土 [chisel:nucrete/2] as an ingredient. It has another use:',
      `- 凿子 (Chisel) — 结构混凝土 [chisel:nucrete/2] is one of the 4 blocks of chisel group "nucrete": a chisel turns it into any of the other 3 (${COST}): chisel:nucrete/0–1, 3 "结构混凝土".`,
    ])
    // 和凿子没关系的东西：结果里不提凿子
    assert.doesNotMatch((await modelCalls(h, 'find_recipes', { id: 'minecraft:furnace' })).content, /chisel|凿子/i)
  })

  it('程序里按物品查组：data.chiselGroupsOf 给它在的组和全部变体，data.chiselGroups 是全部组；这份资料列在 data.available 里', async (t) => {
    const h = setup(t)
    const got = await program(
      h,
      `return {
        available: data.available(),
        groups: data.chiselGroups().map((g) => [g.group, g.ore ?? null, g.variants.length]),
        nucrete: data.chiselGroupsOf('chisel:nucrete', 3).map((g) => [g.group, g.member, g.variants.map((v) => v.id + '/' + v.meta)]),
        mossy: data.chiselGroupsOf('demo:mossy').map((g) => [g.group, g.member]),
        stick: data.chiselGroupsOf('minecraft:stick'),
      }`,
    )
    assert.deepEqual(got, {
      available: ['items', 'carving'],
      groups: [['nucrete', null, 4], ['cobblestone', 'cobblestone', 3]],
      nucrete: [['nucrete', true, ['chisel:nucrete/0', 'chisel:nucrete/1', 'chisel:nucrete/2', 'chisel:nucrete/3']]],
      mossy: [['cobblestone', false]],
      stick: [],
    })
  })

  it('算总料时带着“用凿子从同组另一种变来”的一步：一换一往下乘，凿子不算消耗、耐久照实说不知道；不同组的两样凿不了，说清各在哪一组', async (t) => {
    const h = setup(t)
    // 要 5 个 /3：从 5 个 /0 凿；/0 用 #0 合成，一轮出 2 个，所以 3 轮（多 1 个），要 12 个沙砾
    const sum = await program(h, `const r = await tool('total_materials', { id: 'chisel:nucrete', meta: 3, count: 5, recipes: [0], chisel: [{ id: 'chisel:nucrete', meta: 3, from: { id: 'chisel:nucrete', meta: 0 } }] }); return { ok: r.ok, text: r.text.split('\\n'), data: r.data }`)
    assert.deepEqual(sum.text, [
      'For 5× 结构混凝土 [chisel:nucrete/3], with the 2 step(s) you chose (this only adds up amounts; it checks neither the storage nor the machines):',
      'To make, things that are needed by later lines first:',
      '- #0 (有序合成) × 3 round(s) → 6× 结构混凝土 (5 needed, 1 left over)',
      '- chisel (group "nucrete") × 5 → 5× 结构混凝土 [chisel:nucrete/3], from 5× 结构混凝土 [chisel:nucrete]',
      'Taken ready-made (you gave no recipe for these): 12× 沙砾 [minecraft:gravel]',
      `For the chisel steps: a chisel (an item; find_item "凿子"), which is not used up as an ingredient — ${COST}.`,
    ])
    assert.deepEqual(sum.data, {
      target: { id: 'chisel:nucrete', meta: 3, count: 5 },
      steps: [
        { recipe: 0, way: '有序合成', rounds: 3, makes: { id: 'chisel:nucrete', meta: 0, name: '结构混凝土', count: 6 }, needed: 5 },
        { chisel: { group: 'nucrete', from: { id: 'chisel:nucrete', meta: 0, name: '结构混凝土' } }, way: 'chisel', rounds: 5, makes: { id: 'chisel:nucrete', meta: 3, name: '结构混凝土', count: 5 }, needed: 5 },
      ],
      raw: [{ id: 'minecraft:gravel', meta: 0, name: '沙砾', count: 12 }],
      kept: [{ tool: 'chisel', name: '凿子' }],
      fluids: [],
      unused: [],
    })
    // 只有凿子这一步、没有配方：原料就是同组的另一种，要现成的
    const only = await program(h, `const r = await tool('total_materials', { id: 'chisel:cobblestone', meta: 2, count: 64, chisel: [{ id: 'chisel:cobblestone', meta: 2, from: { id: 'demo:mossy' } }] }); return r.data.raw`)
    assert.deepEqual(only, [{ id: 'demo:mossy', meta: 0, name: '苔圆石块', count: 64 }])
    // 不同组的凿不了
    const wrong = await program(h, `const r = await tool('total_materials', { id: 'chisel:nucrete', meta: 3, chisel: [{ id: 'chisel:nucrete', meta: 3, from: { id: 'minecraft:cobblestone' } }] }); return [r.ok, r.text]`)
    assert.deepEqual(wrong, [false, '结构混凝土 [chisel:nucrete/3] cannot be chiselled from 圆石 [minecraft:cobblestone]: a chisel only turns a block into another block of the same group. 结构混凝土 [chisel:nucrete/3] is in "nucrete"; 圆石 [minecraft:cobblestone] is in "cobblestone".'])
    const nothing = await program(h, `const r = await tool('total_materials', { id: 'chisel:nucrete', meta: 3 }); return [r.ok, r.text]`)
    assert.deepEqual(nothing, [false, 'Give "recipes" (the # numbers of the recipes you chose), "chisel" (blocks chiselled from another block of their group), or both.'])
  })

  it('没有这份资料（carving.jsonl 不在）时：一切照旧，查做法不提凿子，程序里查组是空的', async (t) => {
    const h = setup(t, { carving: false })
    assert.equal(h.loaded.some((line) => line.includes('凿子')), false)
    assert.equal((await modelCalls(h, 'find_recipes', { id: 'chisel:nucrete', meta: 3 })).content, "The recipe book has no recipe that makes 结构混凝土 [chisel:nucrete/3] (the recipe book is what this client's NEI shows, exported). The library function find_uses shows what it is used for.")
    assert.deepEqual(await program(h, `return [data.available(), data.chiselGroups(), data.chiselGroupsOf('chisel:nucrete', 3)]`), [['items'], [], []])
    const sum = await program(h, `const r = await tool('total_materials', { id: 'chisel:nucrete', meta: 3, chisel: [{ id: 'chisel:nucrete', meta: 3, from: { id: 'chisel:nucrete' } }] }); return [r.ok, r.text]`)
    assert.deepEqual(sum, [false, 'There is no chisel data on this brain (carving.jsonl), so a chisel step cannot be checked.'])
  })
})
