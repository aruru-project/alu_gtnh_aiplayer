// “基地的做法”：这个基地怎么做东西的记录（主人教的、它自己定过的）。
// 入口是模型用的两个工具（base_methods 看，set_base_method 记、改、删）、它本来会看的地方（find_recipes、find_machines、inspect_block）、
// 每一轮的系统提示词，和面板的 /api/methods。配方册是 fixture-plan.ts 那本小样本，基地是它的假基地。
// 记下来的东西落在临时目录的 methods.json 里；“重启”就是照同一个目录再读一遍。

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
import { methodsList } from '../src/panel/data-api.ts'
import { partMethodFor } from '../src/tools/methods.ts'
import type { Method } from '../src/store/methods.ts'
import type { LineName } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/types.ts'
import { DEFAULT_MANUALS_DIR, FakeGame, chat, makeAgent, told } from './agent-harness.ts'
import { BENDER, P, R, RECIPES, chest, installBase, stack, writePlanFixture } from './fixture-plan.ts'
import { tmpDir } from './helpers.ts'

/** 2027-01-15：记录上写的“什么时候”。 */
const NOW = 1_800_000_000_000
const DAY = '2027-01-15'
const BENDER_AT = { x: BENDER.x, y: BENDER.y, z: BENDER.z }

function setup(t: { after(fn: () => void): void }, opts: { dir?: string; recipes?: Record<string, unknown>[] } = {}) {
  const tmp = opts.dir === undefined ? tmpDir() : undefined
  if (tmp) t.after(tmp.cleanup)
  const dir = opts.dir ?? tmp!.dir
  if (!fs.existsSync(path.join(dir, 'items.jsonl'))) writePlanFixture(dir)
  // 换一本配方册（重新导出过：编号变了、少了几条）
  if (opts.recipes) fs.writeFileSync(path.join(dir, 'recipes.jsonl'), `${opts.recipes.map((r) => JSON.stringify(r)).join('\n')}\n`)
  const packdata = loadPackData(dir)
  t.after(() => packdata.recipes?.close())
  useLocalNames(packdata.items)
  t.after(() => useLocalNames(undefined))
  const game = new FakeGame()
  installBase(game, { boxes: [chest([stack(P.steelIngot, 20)])] })
  game.handlers['world.block'] = () => ({ id: 'gregtech:gt.blockmachines', meta: 221, name: 'Basic Bending Machine', loaded: true, tileEntity: true })
  const methods = new MethodStore(dir)
  const ctx = (line: LineName): ToolContext => ({
    botName: 'Alu',
    line,
    bridge: new BridgeApi(game),
    memory: new MemoryStore(dir, () => 300),
    manuals: new ManualStore(DEFAULT_MANUALS_DIR, `${dir}/manuals`),
    packdata,
    methods,
    reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
    hooks: {},
    now: () => NOW,
  })
  const run = async (line: LineName, name: string, input: unknown) => {
    const res = await runTool(LINE_TOOLS[line], ctx(line), name, input)
    return { ok: res.isError !== true, text: res.content, lines: res.content.split('\n'), data: res.data as any }
  }
  return { dir, methods, run, packdata }
}

/** 主人今晚教的那几件事，各记一条。 */
async function teach(s: ReturnType<typeof setup>) {
  // 对话线：主人在聊天里说的，它直接记
  await s.run('talk', 'set_base_method', { part: 'plate', way: '卷板机', from: 'ingot', by: 'owner', why: '一锭一板' })
  await s.run('talk', 'set_base_method', { part: 'stick', material: 'Steel', way: '压模机', from: 'ingot', by: 'owner', why: '一锭两杆' })
  // 干活线：它自己查了以后定的、主人指着机器说的
  await s.run('work', 'set_base_method', { ...P.pin, recipe: R.furnacePin, by: 'self', why: '一锭八个，最省' })
  await s.run('work', 'set_base_method', { order: ['有序合成', '无序合成', '压模机'], by: 'owner', why: '手工不耗电' })
  await s.run('work', 'set_base_method', { machine: BENDER_AT, does: '专门压板', feed: { x: 16, y: 65, z: -8 }, collect: { x: 17, y: 64, z: -8 }, keep: '电路别动', by: 'owner' })
}

const TAUGHT = [
  "The base's methods: 5 entries (how this base makes things: what your owner taught and what you decided; total_materials follows them).",
  'Kinds of parts (ore-dictionary prefix ← the way that makes it) (2):',
  `- plate ← 卷板机, from ingot — your owner, ${DAY}: 一锭一板 [key part:plate]`,
  `- stick of Steel ← 压模机, from ingot — your owner, ${DAY}: 一锭两杆 [key part:stick:Steel]`,
  'Order of ways when nothing more specific applies:',
  `- 有序合成 > 无序合成 > 压模机 — your owner, ${DAY}: 手工不耗电 [key order]`,
  'Particular things (thing ← its recipe) (1):',
  `- 钢销 ← #${R.furnacePin} 烧制: 1× 钢锭 → 8× 钢销 — you, ${DAY}: 一锭八个，最省 [key thing:demo:pin/0]`,
  'Machines (what each is for) (1):',
  `- 基础卷板机 at (16,64,-8): 专门压板; feed: (16,65,-8); collect: (17,64,-8); do not touch: 电路别动 — your owner, ${DAY} [key machine:16,64,-8]`,
]

describe('基地的做法', () => {
  it('主人教的四种事（一类零件走哪种做法、某样东西用哪条配方、总的先后、某台机器是干什么的）两条线都能记，记下的带着谁定的、什么时候、理由；两条线看到的是同一份；大脑重启后还在', async (t) => {
    const s = setup(t)
    assert.equal((await s.run('talk', 'base_methods', {})).text, "The base's methods are empty: nothing has been recorded yet. set_base_method records an entry.")
    // 记的时候写的名字只要认得出是哪种做法就行：“压模”就是压模机
    assert.equal((await s.run('talk', 'set_base_method', { part: 'stick', material: 'Steel', way: '压模', from: 'ingot', by: 'owner', why: '一锭两杆' })).text, `Recorded in the base's methods: stick of Steel ← 压模机, from ingot — your owner, ${DAY}: 一锭两杆 [key part:stick:Steel]`)
    await teach(s)
    assert.deepEqual((await s.run('talk', 'base_methods', {})).lines, TAUGHT)
    assert.deepEqual((await s.run('work', 'base_methods', {})).lines, TAUGHT)
    // 只看一种、按字找
    assert.deepEqual((await s.run('work', 'base_methods', { kind: 'part', query: 'steel' })).lines, [
      "The base's methods: 5 entries, 1 shown (how this base makes things: what your owner taught and what you decided; total_materials follows them).",
      'Kinds of parts (ore-dictionary prefix ← the way that makes it) (1):',
      TAUGHT[3],
    ])
    // 重启：照同一个数据目录再起一个
    const again = setup(t, { dir: s.dir })
    assert.deepEqual((await again.run('work', 'base_methods', {})).lines, TAUGHT)
    // 程序拿得到结构化的条目
    assert.deepEqual(
      (await again.run('work', 'base_methods', { kind: 'part' })).data.entries.map((m: { key: string; prefix: string; way: string; from: string; by: string; why: string }) => [m.key, m.prefix, m.way, m.from, m.by, m.why]),
      [
        ['part:plate', 'plate', '卷板机', 'ingot', 'owner', '一锭一板'],
        ['part:stick:Steel', 'stick', '压模机', 'ingot', 'owner', '一锭两杆'],
      ],
    )
  })

  it('改一条就是照同一个键再记一次，结果写明换掉的是哪条；删一条给它的键；键不对如实说', async (t) => {
    const s = setup(t)
    await teach(s)
    // 主人改主意了：钢杆走车床……没有车床这种做法，换成手工
    assert.deepEqual((await s.run('talk', 'set_base_method', { part: 'stick', material: 'Steel', way: '有序合成', by: 'owner', why: '压模机被占着' })).lines, [
      `Changed in the base's methods: stick of Steel ← 有序合成 — your owner, ${DAY}: 压模机被占着 [key part:stick:Steel]`,
      `It replaces: stick of Steel ← 压模机, from ingot — your owner, ${DAY}: 一锭两杆 [key part:stick:Steel]`,
    ])
    assert.equal((await s.run('work', 'set_base_method', { remove: 'part:stick:Steel' })).text, `Removed from the base's methods: stick of Steel ← 有序合成 — your owner, ${DAY}: 压模机被占着 [key part:stick:Steel]`)
    assert.deepEqual((await s.run('work', 'base_methods', { kind: 'part' })).data.entries.map((m: { key: string }) => m.key), ['part:plate'])
    const gone = await s.run('work', 'set_base_method', { remove: 'part:gear' })
    assert.deepEqual([gone.ok, gone.text], [false, 'The base\'s methods have no entry with the key "part:gear". base_methods shows the keys.'])
  })

  it('记不对的记不进去，说清哪里不对：做法的名字认不出或者说不清是哪种、配方做不出那样东西、没有这条配方、材料没有这种零件、一次给了两种、没说是谁定的', async (t) => {
    const s = setup(t)
    const refused = async (input: Record<string, unknown>) => {
      const res = await s.run('work', 'set_base_method', input)
      assert.equal(res.ok, false, res.text)
      return res.text
    }
    assert.equal(await refused({ part: 'plate', way: '水力压裂', by: 'owner' }), 'no way of making is named "水力压裂": use a name as find_recipes lists the ways (e.g. "卷板机", "有序合成")')
    assert.equal(await refused({ part: 'plate', way: '合成', by: 'owner' }), '"合成" fits several ways: 有序合成, 无序合成, AE 合成. Give the one you mean by its full name')
    assert.equal(await refused({ part: 'plate', material: 'Stel', way: '卷板机', by: 'owner' }), 'No item is registered under the ore name plateStel: "material" is the rest of the ore name after the prefix, e.g. "Steel" in plateSteel.')
    assert.equal(await refused({ ...P.pin, recipe: R.bendSteel, by: 'self' }), `Recipe #${R.bendSteel} (卷板机) does not make 钢销 [demo:pin]: it is 1× 钢锭 + circuit 1 → 1× 钢板.`)
    assert.equal(await refused({ ...P.pin, recipe: 999, by: 'self' }), 'There is no recipe #999. Take the number from find_recipes (numbers change when the recipe book is re-exported).')
    assert.equal(await refused({ ...P.pin, by: 'self' }), 'A particular thing needs "recipe": the # number of the recipe that makes it (from find_recipes).')
    assert.match(await refused({ part: 'plate', way: '卷板机', order: ['有序合成'], by: 'owner' }), /^Give exactly one of: "part"/)
    assert.equal(await refused({ part: 'plate', way: '卷板机' }), 'Say who decided it: by "owner" (your owner said so) or "self" (you decided).')
    assert.equal(await refused({ machine: { x: 1, y: 2, z: 3 }, by: 'owner' }), 'A machine needs "does": what it is for, in a sentence.')
    assert.deepEqual(s.methods.list(), [])
  })

  it('它本来会看的地方带上相关的那一条：查一样东西的做法时说基地给它（或者它这一类零件）定的是什么，看机器时说这台机器是干什么的、料从哪进、货从哪出；列出来的做法照旧是全的', async (t) => {
    const s = setup(t)
    const plain = await s.run('work', 'find_recipes', { ...P.pin })
    await teach(s)
    // 钢销：记了它自己的配方
    const pin = await s.run('work', 'find_recipes', { ...P.pin })
    assert.equal(pin.lines[1], `The base's methods have a recipe for this thing: #${R.furnacePin} (烧制) — you, ${DAY}: 一锭八个，最省.`)
    // 多的只有这一行
    assert.deepEqual([pin.lines[0], ...pin.lines.slice(2)], plain.lines)
    // 钢板：没有单独记它，它这一类零件（plate）记了
    assert.equal((await s.run('talk', 'find_recipes', { ...P.steelPlate })).lines[1], `The base's methods for plate parts: 卷板机, from ingot — your owner, ${DAY}: 一锭一板.`)
    // 钢杆：限定了材料的那条
    assert.equal((await s.run('talk', 'find_recipes', { ...P.steelRod })).lines[1], `The base's methods for stick parts of Steel: 压模机, from ingot — your owner, ${DAY}: 一锭两杆.`)
    // 没记过的东西：什么都不多
    assert.equal((await s.run('work', 'find_recipes', { ...P.blades })).lines.some((line) => line.includes("base's methods")), false)
    // 看机器：记过的那台下面带着
    const machines = await s.run('work', 'find_machines', {})
    const at = machines.lines.findIndex((line) => line.startsWith('- (16,64,-8) "基础卷板机"'))
    assert.equal(machines.lines[at + 1], `    in the base's methods: 专门压板; feed: (16,65,-8); collect: (17,64,-8); do not touch: 电路别动 — your owner, ${DAY}`)
    assert.equal(machines.lines.filter((line) => line.includes("base's methods")).length, 1)
    assert.deepEqual((await s.run('talk', 'inspect_block', BENDER_AT)).lines, [
      '(16,64,-8): gregtech:gt.blockmachines/221 "基础卷板机" [tileEntity]',
      `In the base's methods: 专门压板; feed: (16,65,-8); collect: (17,64,-8); do not touch: 电路别动 — your owner, ${DAY}`,
    ])
  })

  it('配方册重新导出、编号全变了：记的那条配方照它的样子（做法、原料、产物）认回来，给的是现在的编号；配方没了的那条照实说，还写着它原来是什么', async (t) => {
    const s = setup(t)
    await s.run('work', 'set_base_method', { ...P.pin, recipe: R.furnacePin, by: 'self', why: '一锭八个，最省' })
    await s.run('work', 'set_base_method', { ...P.shaftShape, recipe: R.shaftShape, by: 'owner' })
    // 新导出的一本：最前面多了两条别的配方、做模头（转轴）的那条玄钢板配方没了，后面的编号全都变了
    const added = { h: 'gt.recipe.metalbender', in: [{ ...P.titanPlate, n: 9 }], out: [{ ...P.sheet, n: 1 }], eut: 24, ticks: 56 }
    const reexported = [added, { ...added, in: [{ ...P.titanPlate, n: 8 }] }, ...RECIPES.filter((_, n) => n !== R.shaftShape)]
    const again = setup(t, { dir: s.dir, recipes: reexported })
    const pinNow = reexported.findIndex((r) => r === RECIPES[R.furnacePin])
    assert.notEqual(pinNow, R.furnacePin)
    assert.deepEqual((await again.run('work', 'base_methods', { kind: 'thing' })).lines.slice(2), [
      `- 钢销 ← #${pinNow} 烧制: 1× 钢锭 → 8× 钢销 — you, ${DAY}: 一锭八个，最省 [key thing:demo:pin/0]`,
      `- 模头（转轴） ← NO LONGER IN THE RECIPE BOOK — it was 有序合成: 4× 玄钢板 + 1× 模头（杆） + any craftingToolHardHammer (e.g. 锤) (not used up) → 1× 模头（转轴） — your owner, ${DAY} [key thing:miscutils:MU-metaitem.01/32040]`,
    ])
    assert.equal((await again.run('work', 'find_recipes', { ...P.pin })).lines[1], `The base's methods have a recipe for this thing: #${pinNow} (烧制) — you, ${DAY}: 一锭八个，最省.`)
    // 面板拿到的条目带着现在的编号（recipeNow）和对不对得上（stale）：对不回来的是 null 和 true
    const env = { book: again.packdata.recipes, items: again.packdata.items }
    const listed = methodsList(again.methods, env) as { entries: { key: string; recipeNow?: number | null; stale?: boolean }[] }
    assert.deepEqual(listed.entries.map((m) => [m.key, m.recipeNow, m.stale]), [
      ['thing:demo:pin/0', pinNow, false],
      ['thing:miscutils:MU-metaitem.01/32040', null, true],
    ])
    // 没有配方册时不判断，这两项都不带
    assert.deepEqual(Object.keys((methodsList(again.methods, {}) as { entries: object[] }).entries[0]!).filter((k) => k === 'recipeNow' || k === 'stale'), [])
    assert.equal(
      (await again.run('work', 'find_recipes', { ...P.shaftShape })).lines[1],
      `The base's methods have a recipe for this thing, but it is no longer in the recipe book (it was 有序合成: 4× 玄钢板 + 1× 模头（杆） + any craftingToolHardHammer (e.g. 锤) (not used up) → 1× 模头（转轴）) — your owner, ${DAY}. [key thing:miscutils:MU-metaitem.01/32040]`,
    )
  })

  it('“板怎么做”的记录管不到双层板、小撮粉这些自己另算一种的零件；“导线”写成 wireGt 管得到各种粗细的；限定了材料的在先，其次是前缀写得更细的', () => {
    const part = (prefix: string, material?: string): Method => ({ kind: 'part', key: material ? `part:${prefix}:${material}` : `part:${prefix}`, prefix, way: '卷板机', by: 'owner', at: NOW, why: '', ...(material ? { material } : {}) })
    const hit = (methods: Method[], ore: string) => {
      const found = partMethodFor(methods, [ore])
      return found ? [found.entry.key, found.material] : undefined
    }
    const plate = [part('plate')]
    assert.deepEqual(hit(plate, 'plateSteel'), ['part:plate', 'Steel'])
    assert.equal(hit(plate, 'plateDoubleSteel'), undefined)
    assert.equal(hit([part('dust')], 'dustSmallIron'), undefined)
    // 不是一个词的前半截：plateau 不是 plate 的一种
    assert.equal(hit(plate, 'plateau'), undefined)
    assert.deepEqual(hit([part('wireGt')], 'wireGt01Tin'), ['part:wireGt', '01Tin'])
    assert.deepEqual(hit([part('wireGt'), part('wireGt01')], 'wireGt01Tin'), ['part:wireGt01', 'Tin'])
    assert.deepEqual(hit([part('plate'), part('plateDouble')], 'plateDoubleSteel'), ['part:plateDouble', 'Steel'])
    assert.deepEqual(hit([part('plate'), part('plate', 'Steel')], 'plateSteel'), ['part:plate:Steel', 'Steel'])
    assert.deepEqual(hit([part('plate'), part('plate', 'Steel')], 'plateIron'), ['part:plate', 'Iron'])
  })

  it('“当现成的”和“同料时用哪种”也记得下：矿辞前缀、矿辞名、具体物品都认，写错的说清；查一样东西的做法时说它是当现成的', async (t) => {
    const s = setup(t)
    assert.equal((await s.run('talk', 'set_base_method', { ready: 'ingot', by: 'owner', why: '从零算时停在锭' })).text, `Recorded in the base's methods: ingot parts: taken ready-made, not made — your owner, ${DAY}: 从零算时停在锭 [key ready:ingot]`)
    assert.equal((await s.run('work', 'set_base_method', { ready: 'dustSteel', by: 'self' })).text, `Recorded in the base's methods: dustSteel: taken ready-made, not made — you, ${DAY} [key ready:dustSteel]`)
    assert.equal((await s.run('work', 'set_base_method', { ready: 'gregtech:gt.metaitem.01/2365', by: 'owner' })).text, `Recorded in the base's methods: 磁钢粉 [gregtech:gt.metaitem.01/2365]: taken ready-made, not made — your owner, ${DAY} [key ready:gregtech:gt.metaitem.01/2365]`)
    assert.equal(
      (await s.run('talk', 'set_base_method', { use: '有序合成', over: '压模', noTools: true, by: 'owner', why: '料一样，手工不耗电' })).text,
      `Recorded in the base's methods: same ingredients: 有序合成 over 压模机 (only when the 有序合成 recipe needs no tools) — your owner, ${DAY}: 料一样，手工不耗电 [key same:有序合成>压模机]`,
    )
    const refused = async (input: Record<string, unknown>) => {
      const res = await s.run('work', 'set_base_method', { by: 'owner', ...input })
      assert.equal(res.ok, false, res.text)
      return res.text
    }
    assert.equal(await refused({ ready: 'ingto' }), 'No ore name starts with "ingto": a prefix is the part of an ore name before the material, such as "ingot" in ingotSteel (find_item shows an item\'s ore names).')
    assert.equal(await refused({ ready: 'x:y' }), 'No item x:y is known: give an item id as find_item shows it, or an ore-dictionary prefix such as "ingot".')
    assert.equal(await refused({ use: '有序合成' }), '"use" and "over" go together: the way to use, and the way not to use, when both make a thing from the same ingredients.')
    assert.equal(await refused({ use: '压模机', over: '压模' }), '"use" and "over" are the same way (压模机).')
    assert.equal(await refused({ use: '水力压裂', over: '压模机' }), 'no way of making is named "水力压裂": use a name as find_recipes lists the ways (e.g. "卷板机", "有序合成")')
    assert.match(await refused({ ready: 'ingot', part: 'plate', way: '卷板机' }), /^Give exactly one of: "part" \(a kind of part and the way that makes it\), "ready"/)
    // 查钢锭的做法：说它是当现成的（照的是那条前缀）
    assert.equal((await s.run('work', 'find_recipes', { ...P.steelIngot })).lines[1], `The base's methods take ingot parts ready-made (total_materials does not make them) — your owner, ${DAY}: 从零算时停在锭.`)
    assert.deepEqual((await s.run('work', 'base_methods', { kind: 'ready' })).lines.slice(1), [
      // 同一时刻记的照键排
      'Taken ready-made (not made) (3):',
      `- dustSteel: taken ready-made, not made — you, ${DAY} [key ready:dustSteel]`,
      `- 磁钢粉 [gregtech:gt.metaitem.01/2365]: taken ready-made, not made — your owner, ${DAY} [key ready:gregtech:gt.metaitem.01/2365]`,
      `- ingot parts: taken ready-made, not made — your owner, ${DAY}: 从零算时停在锭 [key ready:ingot]`,
    ])
  })

  it('每一轮两条线的系统提示词里有“基地的做法”一节：一类零件怎么做、总的先后全文列出，具体的东西和机器只说各有几条、怎么看；记了新的下一轮就在；一条都没有时也说还没记', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    h.agent.handleEvent(told('去仓库'))
    await h.agent.whenIdle()
    const empty = '# 基地的做法\n这个基地怎么做东西的记录：主人教的，和你自己定过的。total_materials 展开一样东西要的材料时按它走；base_methods 看全部，set_base_method 记一条、改一条、删一条。\n（现在一条都还没记。）\n\n# 你的记忆\n'
    for (const system of [h.llm.requests[0]!.system ?? '', h.talk.requests[0]!.system ?? '']) assert.ok(system.includes(empty), system.slice(-500))
    // 记了几条（存储是两条线共用的那一份）
    h.methods.set({ kind: 'part', key: 'part:plate', prefix: 'plate', way: '卷板机', from: 'ingot', by: 'owner', at: NOW, why: '一锭一板' })
    h.methods.set({ kind: 'part', key: 'part:stick:Steel', prefix: 'stick', material: 'Steel', way: '压模机', by: 'self', at: NOW, why: '' })
    h.methods.set({ kind: 'order', key: 'order', ways: ['有序合成', '组装机'], by: 'owner', at: NOW, why: '手工不耗电' })
    h.methods.set({ kind: 'ready', key: 'ready:ingot', match: 'prefix', text: 'ingot', by: 'owner', at: NOW, why: '停在锭' })
    h.methods.set({ kind: 'ready', key: 'ready:minecraft:stone', match: 'item', text: 'minecraft:stone', name: '石头', by: 'self', at: NOW + 1, why: '' })
    h.methods.set({ kind: 'same', key: 'same:有序合成>组装机', use: '有序合成', over: '组装机', noTools: true, by: 'owner', at: NOW, why: '组装机还要耗电' })
    h.methods.set({ kind: 'thing', key: 'thing:demo:pin/0', thing: 'demo:pin/0', name: '钢销', recipe: { ref: 51, way: 'k', wayName: '烧制', in: [], out: [], fin: [], fout: [], text: '1× 钢锭 → 8× 钢销' }, by: 'self', at: NOW, why: '' })
    h.methods.set({ kind: 'machine', key: 'machine:16,64,-8', x: 16, y: 64, z: -8, does: '专门压板', by: 'owner', at: NOW, why: '' })
    h.agent.handleEvent(chat('Steve', 'Alu 还在吗'))
    h.agent.handleEvent(told('再去一趟'))
    await h.agent.whenIdle()
    const section = [
      '# 基地的做法',
      '这个基地怎么做东西的记录：主人教的，和你自己定过的。total_materials 展开一样东西要的材料时按它走；base_methods 看全部，set_base_method 记一条、改一条、删一条。',
      '一类零件怎么做（2 条，写的是矿辞前缀）：',
      '- plate ← 卷板机，从 ingot（主人定的：一锭一板）',
      '- stick（只管 Steel） ← 压模机（你定的）',
      '当现成的、不往下做：ingot（这一类）（主人定的：停在锭）；石头（minecraft:stone）（你定的）',
      '两种做法用的料一样时（工具不算料）：用 有序合成，不用 组装机；只在 有序合成 那条不用工具时（主人定的：组装机还要耗电）',
      '没有更具体的记录时，做法的先后：有序合成 > 组装机（主人定的：手工不耗电）',
      '另外记着 1 样具体的东西各用哪条配方、 1 台机器各是干什么的：base_methods 看。',
      '',
      '# 你的记忆',
    ].join('\n')
    for (const system of [h.llm.requests.at(-1)!.system ?? '', h.talk.requests.at(-1)!.system ?? '']) assert.ok(system.includes(section), system.slice(-700))
    // 钢销用哪条配方、卷板机是干什么的，不在提示词里
    assert.equal((h.llm.requests.at(-1)!.system ?? '').includes('专门压板'), false)
  })
})
