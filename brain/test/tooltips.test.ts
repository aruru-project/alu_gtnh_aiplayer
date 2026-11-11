// 物品的提示文字（玩家把鼠标放到物品上看到的那几行）：find_item 在物品少的时候带上它、能按提示里的字找物品；面板的只读接口。
// 资料是这里自造的一小份（十几样物品和它们的提示，照 docs/PACKDATA.md “物品的提示文字”的格式写）；入口是模型用的工具和面板的 HTTP 接口。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { itemLines } from '../src/packdata/icons.ts'
import { loadPackData } from '../src/packdata/index.ts'
import type { PackData } from '../src/packdata/index.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { useLocalNames } from '../src/tools/format.ts'
import { LINE_TOOLS, runTool } from '../src/tools/index.ts'
import type { LineName } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/types.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { tmpDir } from './helpers.ts'

const GT = 'gregtech:gt.metaitem.01'
const M = 'gregtech:gt.blockmachines'
const FRAMES = [
  [6, '锂'],
  [8, '铍'],
  [10, '碳'],
  [18, '镁'],
  [19, '铝'],
  [20, '生硅'],
] as const

const ITEMS = [
  { id: GT, meta: 32380, name: '基础槽位扩展', en: 'Basic Item Holder' },
  { id: GT, meta: 32381, name: '优质槽位扩展', en: 'Good Item Holder' },
  { id: M, meta: 221, name: '基础卷板机', en: 'Basic Bending Machine' },
  // meta 以 221 开头的另一台（没有提示）
  { id: M, meta: 2210, name: '高级卷板机', en: 'Advanced Bending Machine' },
  { id: M, meta: 31080, name: '大型蒸汽离心机', en: 'Steam Separator' },
  { id: 'minecraft:apple', meta: 0, name: '苹果', en: 'Apple' },
  { id: 'Thaumcraft:WandCap', meta: 0, name: '铁杖端', en: 'Iron Wand Cap' },
  { id: 'IC2:itemCellEmpty', meta: 1, name: '冷却单元', en: 'Coolant Cell' },
  { id: 'Ztones:tile.auroraBlock', meta: 0, name: '极光方块', en: 'Aurora Block' },
  { id: GT, meta: 32500, name: '小型锂电池', en: 'Small Lithium Battery' },
  { id: 'minecraft:stone', meta: 0, name: '石头', en: 'Stone' },
  ...FRAMES.map(([meta, name]) => ({ id: 'gregtech:gt.blockframes', meta, name: `${name}框架`, en: 'Frame Box' })),
]

/** 大型蒸汽离心机按住 Shift 时的那一版：十六行（比一页里每个画面给的十二行多）。 */
const SEPARATOR_SHIFT = [
  '长按 [G] 打开指南',
  '大小: 5x5x5 (LxWxH)',
  '结构:',
  '   控制器: 第二层，正面中央',
  '   1 蒸汽仓: 任意机械方块',
  '   1+ 蒸汽输入总线: 任意机械方块',
  '   1+ 输出总线（蒸汽）或普通输出仓: 任意机械方块',
  '',
  '   基础（T1）',
  '   60-65 镀铜砖块',
  '   8 青铜齿轮箱机械方块',
  '   4 青铜管道方块',
  '   3 青铜燃烧室',
  '投影仪堆叠数量确定结构等级',
  '---',
  '使用多方块机器全息投影仪来查看或建造整体结构！',
]

const TOOLTIPS = [
  { id: GT, meta: 32380, tip: ['作为覆盖板在机器GUI中使用，可容纳9个物品'] },
  { id: GT, meta: 32381, tip: ['作为覆盖板在机器GUI中使用，可容纳12个物品'] },
  { id: M, meta: 221, tip: ['嘘,他是坏的!我们要本德! ! !', '机器类型: 卷板机', '电压输入：32 (LV)', '容量：2,048 EU'] },
  { id: M, meta: 31080, tip: ['长按 [G] 打开指南', '机器类型: 离心机', '并行：8'], shift: SEPARATOR_SHIFT },
  // 食物：Spice of Life 对一个没吃过东西的新号说的那两行，和它前面的空行
  { id: 'minecraft:apple', meta: 0, tip: ['饥饿值：2', '饱和度：0.3', '', '食物恢复的饥饿值递减开始在', '食用任何食物超过 10次 之后'] },
  { id: 'Thaumcraft:WandCap', meta: 0, tip: ['按住CTRL以显示神秘时代法杖信息'], ctrl: ['魔力减免：-10%', '无法保留节点！'] },
  // 不按键时什么都没有，按住 Shift 才有
  { id: 'IC2:itemCellEmpty', meta: 1, tip: [], shift: ['容器大小：1,000 L = 6 * 144 L + 136 L', '冷却剂'] },
  // 只有按键提示的：去掉以后就没有提示了
  { id: 'Ztones:tile.auroraBlock', meta: 0, tip: ['Alt/Ctrl+Scroll to', 'Cycle Between Blocks'] },
  { id: GT, meta: 32500, tip: ['0 / 100,000 EU', '电压：32 (LV)'] },
  ...FRAMES.map(([meta]) => ({ id: 'gregtech:gt.blockframes', meta, tip: ['只是一个能安装覆盖板的方块'] })),
]

const FACT =
  "A tooltip is what a new player reads hovering over a fresh sample of the item: lines about charge, stored amount, bindings or a tool's level are the sample's, not those of the one you hold."

interface Fixture {
  packdata: PackData
  log: string[]
  find(input: unknown, line?: LineName): Promise<{ text: string; data: any; isError: boolean }>
}

/** tooltips: false 不写 tooltips.jsonl；sha：meta.json 里记的“照哪一份物品表取的”——same 是现在这份，other 是另一份，none 是没记。 */
function setup(t: { after(fn: () => void): void }, opts: { tooltips?: boolean; sha?: 'same' | 'other' | 'none' } = {}): Fixture {
  const tmp = tmpDir()
  const dir = path.join(tmp.dir, 'packdata')
  fs.mkdirSync(dir, { recursive: true })
  const lines = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
  fs.writeFileSync(path.join(dir, 'items.jsonl'), lines(ITEMS))
  if (opts.tooltips !== false) {
    fs.writeFileSync(path.join(dir, 'tooltips.jsonl'), lines(TOOLTIPS))
    const sha = opts.sha === 'other' ? '0000000000000000000000000000000000000000' : opts.sha === 'none' ? undefined : itemLines(lines(ITEMS)).sha1
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ tooltips: { format: 1, items: TOOLTIPS.length, ...(sha !== undefined ? { itemsSha1: sha } : {}) } }))
  }
  const log: string[] = []
  const packdata = loadPackData(dir, (m) => log.push(m))
  useLocalNames(packdata.items, packdata.fluids)
  t.after(() => {
    useLocalNames(undefined)
    tmp.cleanup()
  })
  const ctx = (line: LineName): ToolContext => ({
    botName: 'Alu',
    line,
    bridge: new BridgeApi(new FakeGame()),
    memory: new MemoryStore(tmp.dir, () => 4000),
    manuals: new ManualStore(DEFAULT_MANUALS_DIR, path.join(tmp.dir, 'manuals')),
    reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
    packdata,
    hooks: {},
    now: () => 0,
  })
  const find = async (input: unknown, line: LineName = 'work') => {
    const res = await runTool(LINE_TOOLS[line], ctx(line), 'find_item', input)
    return { text: res.content, data: res.data as any, isError: res.isError === true }
  }
  return { packdata, log, find }
}

describe('物品的提示文字', () => {
  it('启动时读进来，日志里一行：多少个物品有提示（只剩界面提示的不算）、另有 Shift 版和 Ctrl 版的各多少', (t) => {
    const f = setup(t)
    assert.deepEqual(f.log.filter((line) => line.includes('提示')), ['物品的提示文字：14 个物品有（按住 Shift 另有一版的 2 个、按住 Ctrl 的 1 个；文件里 15 行，去掉只是界面提示的行以后剩这些）。'])
  })

  it('它不是照现在这份物品表取的：日志里说一声，按 id/meta 照用；没记是照哪一份取的就不说', async (t) => {
    const other = setup(t, { sha: 'other' })
    assert.match(other.log.find((line) => line.includes('提示'))!, /^物品的提示文字：14 个物品有（[^）]*）；它不是照现在这份物品表取的（itemsSha1 对不上），按 id\/meta 照用。$/)
    assert.ok((await other.find({ query: '基础槽位扩展' })).text.includes('      | 作为覆盖板在机器GUI中使用，可容纳9个物品'))
    assert.equal(setup(t, { sha: 'none' }).log.find((line) => line.includes('提示'))!.includes('对不上'), false)
  })

  it('这份资料没导出：find_item 照常找物品、不带提示；按提示里的字找时照实说没有这份资料', async (t) => {
    const f = setup(t, { tooltips: false })
    assert.deepEqual(f.log.filter((line) => line.includes('提示')), [])
    assert.equal((await f.find({ query: '基础卷板机' })).text, '"基础卷板机" matches 1 item(s), most alike first.\n- 基础卷板机 [gregtech:gt.blockmachines/221]')
    const res = await f.find({ tip: '覆盖板' })
    assert.deepEqual([res.isError, res.text], [true, 'This brain has no tooltips of the items: that data (tooltips.jsonl) was not exported for it. "query" searches names.'])
  })

  it('找到的物品不多（不超过五个）：每个下面带着它的提示，原样的行；末尾说一句这些字是谁、对着什么看到的；没有提示的物品照常列', async (t) => {
    const f = setup(t)
    const res = await f.find({ query: '基础' })
    assert.equal(
      res.text,
      [
        '"基础" matches 2 item(s), most alike first.',
        '- 基础卷板机 [gregtech:gt.blockmachines/221]',
        '    tooltip:',
        '      | 嘘,他是坏的!我们要本德! ! !',
        '      | 机器类型: 卷板机',
        '      | 电压输入：32 (LV)',
        '      | 容量：2,048 EU',
        '- 基础槽位扩展 [gregtech:gt.metaitem.01/32380]',
        '    tooltip:',
        '      | 作为覆盖板在机器GUI中使用，可容纳9个物品',
        FACT,
      ].join('\n'),
    )
    // 没有提示的物品：照常一行，也没有那句话
    assert.equal((await f.find({ query: '石头' })).text, '"石头" matches 1 item(s), most alike first.\n- 石头 [minecraft:stone]')
    // 两条线都一样
    assert.equal((await f.find({ query: '基础' }, 'talk')).text, res.text)
  })

  it('三个画面分开给、各标明是哪个：不按键的、按住 Shift 换成的、按住 Ctrl 换成的；不按键时没有字的只给按键的那一版', async (t) => {
    const f = setup(t)
    assert.equal(
      (await f.find({ query: '铁杖端' })).text,
      [
        '"铁杖端" matches 1 item(s), most alike first.',
        '- 铁杖端 [Thaumcraft:WandCap]',
        '    tooltip:',
        '      | 按住CTRL以显示神秘时代法杖信息',
        '    tooltip while Ctrl is held (it replaces the lines above):',
        '      | 魔力减免：-10%',
        '      | 无法保留节点！',
        FACT,
      ].join('\n'),
    )
    assert.equal(
      (await f.find({ query: '冷却单元' })).text,
      ['"冷却单元" matches 1 item(s), most alike first.', '- 冷却单元 [IC2:itemCellEmpty/1]', '    tooltip while Shift is held (it replaces the lines above):', '      | 容器大小：1,000 L = 6 * 144 L + 136 L', '      | 冷却剂', FACT].join('\n'),
    )
  })

  it('只是界面提示、不是这件物品的信息的行不给：“长按 [G] 打开指南”、Spice of Life 对新号说的两行、Ztones 的滚轮提示；去掉以后什么都不剩的物品算没有提示', async (t) => {
    const f = setup(t)
    // 食物：留下饥饿值和饱和度，那两行和它们前面的空行不在
    const apple = await f.find({ query: '苹果' })
    assert.equal(apple.text, ['"苹果" matches 1 item(s), most alike first.', '- 苹果 [minecraft:apple]', '    tooltip:', '      | 饥饿值：2', '      | 饱和度：0.3', FACT].join('\n'))
    assert.deepEqual(apple.data.items[0].tooltip, { tip: ['饥饿值：2', '饱和度：0.3'] })
    // 只有滚轮提示的方块：没有提示
    const aurora = await f.find({ query: '极光方块' })
    assert.equal(aurora.text, '"极光方块" matches 1 item(s), most alike first.\n- 极光方块 [Ztones:tile.auroraBlock]')
    assert.equal('tooltip' in aurora.data.items[0], false)
    // 多方块主机：两版里的“长按 [G] 打开指南”都不在；缩进和分隔线原样
    const separator = await f.find({ query: '大型蒸汽离心机' })
    assert.equal(separator.text.includes('长按 [G]'), false)
    assert.ok(separator.text.includes('    tooltip:\n      | 机器类型: 离心机\n      | 并行：8\n    tooltip while Shift is held (it replaces the lines above):\n      | 大小: 5x5x5 (LxWxH)\n      | 结构:\n      |    控制器: 第二层，正面中央\n'))
    assert.ok(separator.text.includes('\n      | \n      |    基础（T1）\n'))
    assert.ok(separator.text.endsWith(`\n      | ---\n      | 使用多方块机器全息投影仪来查看或建造整体结构！\n${FACT}`))
  })

  it('只有一个物品时提示全给；有几个物品时每个画面最多给十二行，写明还有几行、怎么看全；query 写成 id/meta 就是那一个物品', async (t) => {
    const f = setup(t)
    // 用“机”找：三台机器
    const two = await f.find({ query: '机' })
    assert.deepEqual(two.data.items.map((i: any) => i.name), ['基础卷板机', '高级卷板机', '大型蒸汽离心机'])
    // 按住 Shift 的那一版去掉界面提示以后十五行：给十二行，剩三行
    assert.ok(two.text.includes('      |    3 青铜燃烧室\n      | … 3 more line(s): find_item {query: "gregtech:gt.blockmachines/31080"} gives all of it\n'), two.text)
    assert.equal(two.text.includes('使用多方块机器全息投影仪'), false)
    // 程序里拿到的是全的
    assert.equal(two.data.items[2].tooltip.shift.length, 15)
    // 照它说的问：只有这一个物品，全给
    const one = await f.find({ query: 'gregtech:gt.blockmachines/31080' })
    assert.deepEqual([one.data.total, one.data.items.map((i: any) => i.name)], [1, ['大型蒸汽离心机']])
    assert.ok(one.text.includes('      | 使用多方块机器全息投影仪来查看或建造整体结构！'))
    assert.equal(one.text.includes('more line(s)'), false)
    // 它是另一个物品的 id/meta 的开头时也只是它自己：221 不带出 2210
    assert.deepEqual((await f.find({ query: 'gregtech:gt.blockmachines/221' })).data.items.map((i: any) => i.name), ['基础卷板机'])
    // 不是哪个物品的 id/meta 的（这里是三个 meta 的开头）照旧当词找
    assert.deepEqual((await f.find({ query: 'gregtech:gt.blockframes/1' })).data.items.map((i: any) => i.meta), [10, 18, 19])
    // meta 是 0 的物品，别处写它不带“/0”；写全了也认
    assert.deepEqual((await f.find({ query: 'minecraft:apple/0' })).data.items.map((i: any) => i.name), ['苹果'])
  })

  it('找到的物品多（超过五个）：不逐个带提示，结尾说物品少的时候才带、怎么看某一个的；程序里每个物品的提示照样是全的', async (t) => {
    const f = setup(t)
    const res = await f.find({ query: '框架' })
    assert.equal(
      res.text,
      [
        '"框架" matches 6 item(s), most alike first.',
        '- 锂框架 [gregtech:gt.blockframes/6]',
        '- 铍框架 [gregtech:gt.blockframes/8]',
        '- 碳框架 [gregtech:gt.blockframes/10]',
        '- 镁框架 [gregtech:gt.blockframes/18]',
        '- 铝框架 [gregtech:gt.blockframes/19]',
        '- 生硅框架 [gregtech:gt.blockframes/20]',
        'Tooltips (what a player reads hovering over an item) are given when 5 or fewer items are listed: find_item {query: "<id/meta>"} is that one item.',
      ].join('\n'),
    )
    assert.deepEqual(res.data.items.map((i: any) => i.tooltip), Array.from({ length: 6 }, () => ({ tip: ['只是一个能安装覆盖板的方块'] })))
    assert.deepEqual([res.data.total, res.data.page, res.data.pages], [6, 1, 1])
  })

  it('按提示里的字找物品（tip）：和按名字找分开——名字里没有“覆盖板”的东西也找得到，名字搜不会被提示里的字带出一堆；多的时候每条给对上的那一行', async (t) => {
    const f = setup(t)
    // 名字里有“覆盖板”的一个都没有：按名字找不到
    assert.match((await f.find({ query: '覆盖板' })).text, /^No item or fluid matches "覆盖板"\./)
    // 按提示找：八个（两个槽位扩展、六个框架），按物品表的顺序；每条写着对上的那一行
    const byTip = await f.find({ tip: '覆盖板' })
    assert.equal(
      byTip.text,
      [
        '"覆盖板" in its tooltip matches 8 item(s).',
        '- 基础槽位扩展 [gregtech:gt.metaitem.01/32380]: tooltip has: "作为覆盖板在机器GUI中使用，可容纳9个物品"',
        '- 优质槽位扩展 [gregtech:gt.metaitem.01/32381]: tooltip has: "作为覆盖板在机器GUI中使用，可容纳12个物品"',
        ...FRAMES.map(([meta, name]) => `- ${name}框架 [gregtech:gt.blockframes/${meta}]: tooltip has: "只是一个能安装覆盖板的方块"`),
        'Tooltips (what a player reads hovering over an item) are given when 5 or fewer items are listed: find_item {query: "<id/meta>"} is that one item.',
      ].join('\n'),
    )
    // 几个词都要在同一个物品的提示里；按住键才有的那一版里的字也找，并说是哪一版
    assert.deepEqual((await f.find({ tip: '覆盖板 12个' })).data.items.map((i: any) => i.name), ['优质槽位扩展'])
    const held = await f.find({ tip: '青铜燃烧室', limit: 1, page: 1 })
    assert.equal(held.data.items[0].name, '大型蒸汽离心机')
    // 名字和提示一起给：两样都要对上，物品少了就带上整个提示
    const both = await f.find({ query: '槽位', tip: '覆盖板' })
    assert.equal(
      both.text,
      [
        '"覆盖板" in its tooltip and "槽位" in its name matches 2 item(s), most alike first.',
        '- 基础槽位扩展 [gregtech:gt.metaitem.01/32380]',
        '    tooltip:',
        '      | 作为覆盖板在机器GUI中使用，可容纳9个物品',
        '- 优质槽位扩展 [gregtech:gt.metaitem.01/32381]',
        '    tooltip:',
        '      | 作为覆盖板在机器GUI中使用，可容纳12个物品',
        FACT,
      ].join('\n'),
    )
    // 只是界面提示的那几行搜不到（它们没读进来）
    assert.equal((await f.find({ tip: '打开指南' })).text, 'No item has "打开指南" in its tooltip (every word must be there; a tooltip is the text a player reads hovering over the item, in Chinese here).')
    assert.equal((await f.find({ query: '石头', tip: '覆盖板' })).text, 'No item has "覆盖板" in its tooltip and "石头" in its name (every word must be there; a tooltip is the text a player reads hovering over the item, in Chinese here). 8 item(s) have "覆盖板" in their tooltip under any name.')
  })

  it('按提示找到很多、对上的那一行在按住键的那一版里：写明是哪一版', async (t) => {
    const f = setup(t)
    // 让结果超过五个：框架六个加离心机一个，都有“方块”
    const res = await f.find({ tip: '方块' })
    assert.equal(res.data.total, 7)
    assert.ok(res.text.includes('- 大型蒸汽离心机 [gregtech:gt.blockmachines/31080]: tooltip while Shift is held has: "1 蒸汽仓: 任意机械方块"'), res.text)
  })
})
