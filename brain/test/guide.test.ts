// 游戏内指南：read_guide（看目录、按词找、按物品找、读一页），别的工具里那一行“指南里有这一页”，提示词里的那句事实，面板的只读接口。
// 资料是 fixture-guide.ts 那本小指南，经 tools/make-packdata.py guide 生成；入口是模型用的工具（两条线）、面板的 HTTP 接口。

import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { DesignWorkspace } from '../src/design/index.ts'
import { loadPackData } from '../src/packdata/index.ts'
import type { PackData } from '../src/packdata/index.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { useLocalNames } from '../src/tools/format.ts'
import { LINE_TOOLS, runTool } from '../src/tools/index.ts'
import type { LineName } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/types.ts'
import { DEFAULT_MANUALS_DIR, FakeGame, chat, lineCalls, makeAgent, modelCalls, reply, told } from './agent-harness.ts'
import { EBF, VF, buildGuidePackdata, pythonMissing } from './fixture-guide.ts'
import { writeStructureFixture } from './fixture-structures.ts'
import { tmpDir } from './helpers.ts'

const skip = pythonMissing()

interface Fixture {
  packdata: PackData
  log: string[]
  dir: string
  game: FakeGame
  /** 像模型那样调一次 read_guide（line：哪条线；cap：单个工具结果上限）。 */
  read(input: unknown, opts?: { line?: LineName; cap?: number }): Promise<{ text: string; data: any; isError: boolean }>
  call(name: string, input: unknown): Promise<{ text: string; data: any; isError: boolean }>
}

function setup(t: { after(fn: () => void): void }, opts: { guide?: boolean } = {}): Fixture {
  const tmp = tmpDir()
  const dir = buildGuidePackdata(tmp.dir, opts)
  writeStructureFixture(dir)
  const log: string[] = []
  const packdata = loadPackData(dir, (m) => log.push(m))
  // 大脑启动时就是这么设的：物品和流体都叫游戏里的中文名
  useLocalNames(packdata.items, packdata.fluids)
  t.after(() => {
    useLocalNames(undefined)
    packdata.recipes?.close()
    tmp.cleanup()
  })
  const game = new FakeGame()
  const ctx = (line: LineName, cap: number): ToolContext => ({
    botName: 'Alu',
    line,
    bridge: new BridgeApi(game),
    memory: new MemoryStore(tmp.dir, () => 4000),
    manuals: new ManualStore(DEFAULT_MANUALS_DIR, path.join(tmp.dir, 'manuals')),
    reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
    packdata,
    maxResultChars: () => cap,
    hooks: {},
    now: () => 0,
  })
  const call = async (name: string, input: unknown, line: LineName = 'work', cap = 20_000) => {
    const res = await runTool(LINE_TOOLS[line], ctx(line, cap), name, input)
    return { text: res.content, data: res.data as any, isError: res.isError === true }
  }
  return { packdata, log, dir, game, read: (input, o = {}) => call('read_guide', input, o.line ?? 'work', o.cap ?? 20_000), call: (name, input) => call(name, input) }
}

const VF_PAGE = 'gregtech:multiblocks/hv/vacuum_freezer.md'
const EBF_PAGE = 'gregtech:multiblocks/lv/electric_blast_furnace.md'

describe('游戏内指南', { skip }, () => {
  it('启动时读进来，日志里一行：几本书、几页（同一路径两种语言算一页）、几页只有英文', (t) => {
    const f = setup(t)
    assert.deepEqual(f.log.filter((line) => line.includes('指南')), ['游戏内指南：2 本书、7 页（其中 1 页只有英文；文件里两种语言一共 11 行）。'])
  })

  it('这份资料没导出：工具照实说没有，别的工具照常、不提指南；日志里不提', async (t) => {
    const f = setup(t, { guide: false })
    assert.equal(f.packdata.guide, undefined)
    assert.deepEqual(f.log.filter((line) => line.includes('指南')), [])
    const res = await f.read({ query: '冷冻' })
    assert.deepEqual([res.isError, res.text], [true, 'This brain has no in-game guide: that data (guide.jsonl) was not exported for it.'])
    assert.equal((await f.call('find_item', { query: '真空冷冻机' })).text.includes('guide'), false)
  })

  it('不带参数：有哪几本书、各多少页、顶上有哪几章，和四种问法', async (t) => {
    const f = setup(t)
    assert.equal(
      (await f.read({})).text,
      [
        'The in-game guide of this pack (the book players open with G): 2 book(s), 7 pages. A page that exists in Chinese is given in Chinese; 1 exist in English only.',
        '- changelog "2.9 新内容": 1 page (changelog:index.md)',
        '- gregtech "GT 新视野": 6 pages, 1 of them in English only. Top: 导线与线缆, 多方块机器',
        "book: a book's pages. query: search. id (+meta): the pages about an item. path: read a page.",
      ].join('\n'),
    )
  })

  it('看一本书的目录：一页一行、缩进是上下级；同一路径两种语言都有的只列一次（中文名），只有英文的照常列并标 [en]；under 只看一页下面的', async (t) => {
    const f = setup(t)
    const toc = await f.read({ book: 'gregtech' })
    assert.equal(
      toc.text,
      [
        'Pages of the guide book gregtech: 6. Each line is title — path; read one with path: "gregtech:<path>". [en]: in English only.',
        '- GT 新视野 — index.md',
        '  - 导线与线缆 — power/cable.md',
        '  - 多方块机器 — multiblocks/multiblocks_index.md',
        '    - 工业高炉 — multiblocks/lv/electric_blast_furnace.md',
        '    - 真空冷冻机 — multiblocks/hv/vacuum_freezer.md',
        '    - Vacuum Freezer [en] — multiblocks/vacuum_freezer.md',
      ].join('\n'),
    )
    // 程序里拿到的是这本书的全部页，带上一级
    assert.deepEqual(
      toc.data.pages.map((p: any) => [p.path, p.title, p.lang, p.english ?? false, p.parent ?? null]),
      [
        ['gregtech:index.md', 'GT 新视野', 'zh_cn', true, null],
        ['gregtech:power/cable.md', '导线与线缆', 'zh_cn', true, 'gregtech:index.md'],
        ['gregtech:multiblocks/multiblocks_index.md', '多方块机器', 'zh_cn', true, 'gregtech:index.md'],
        [EBF_PAGE, '工业高炉', 'zh_cn', false, 'gregtech:multiblocks/multiblocks_index.md'],
        [VF_PAGE, '真空冷冻机', 'zh_cn', false, 'gregtech:multiblocks/multiblocks_index.md'],
        ['gregtech:multiblocks/vacuum_freezer.md', 'Vacuum Freezer', 'en_us', false, 'gregtech:multiblocks/multiblocks_index.md'],
      ],
    )
    const under = await f.read({ book: 'gregtech', under: 'multiblocks/multiblocks_index.md' })
    assert.match(under.text, /^Pages of the guide book gregtech under "多方块机器": 4\. /)
    assert.equal(under.text.includes('power/cable.md'), false)
    // 目录比一次放得下的长：深的那一层收起来，写明下面还有几页、怎么看
    const folded = await f.read({ book: 'gregtech' }, { cap: 450 })
    assert.match(folded.text, /\n {2}- 多方块机器 — multiblocks\/multiblocks_index\.md \(\+3 below: under: "multiblocks\/multiblocks_index\.md"\)$/)
    assert.equal(folded.text.includes('vacuum_freezer'), false)
    // 没有这本书
    assert.equal((await f.read({ book: 'thaumcraft' })).text, 'There is no book "thaumcraft" in the guide. Its books: changelog, gregtech.')
  })

  it('读一页：物品是“中文名 [id/meta]”，配方框、立体图、图片各是一句“游戏里这里显示的是什么”，排版的标签只留字，页间链接能直接拿去读，不认识的标签和代码原样', async (t) => {
    const f = setup(t)
    const res = await f.read({ path: VF_PAGE })
    const [head, body] = res.text.split('\n---\n')
    assert.equal(
      head,
      [
        `Guide page "真空冷冻机" — ${VF_PAGE}, Chinese. Written 2026-05-27 by Skorched.`,
        'About: 真空冷冻机 [gregtech:gt.blockmachines/1002].',
        'Under: "多方块机器" (gregtech:multiblocks/multiblocks_index.md).',
        'Other pages about the same item: "Vacuum Freezer" [en] (gregtech:multiblocks/vacuum_freezer.md).',
      ].join('\n'),
    )
    assert.equal(
      body!.split('\n## 故障排查\n')[0],
      [
        '# 真空冷冻机',
        '',
        // GameScene + ImportStructureLib：哪台机器的结构立体图、第几级
        '[3D scene shown here in the game: the structure of 真空冷冻机 [gregtech:gt.blockmachines/1002], tier 2]',
        '',
        // 图标紧挨着同一件物品的链接只说一次；页间链接换成 book:path（带 #节 的留着）；网址不动；
        // 流体展示物品说成流体；物品表里没有的只留 id；任务是名字加任务 id
        '真空冷冻机 [gregtech:gt.blockmachines/1002]（俗称“冰箱”）把[工业高炉](gregtech:multiblocks/lv/electric_blast_furnace.md)出的热锭冷却成普通锭，冷却液用液氧 [fluid liquidoxygen]，也有人用[gregtech:gt.metaitem.99/5]。电怎么接见[导线](gregtech:power/cable.md#线损)，官网在[这里](https://example.org/vf.md)。任务：“冰箱造好了” [quest 531]。',
        '',
        '| 部件 | 数量 |',
        '| --- | --- |',
        // Color 只留字；Tooltip 是标签加括号里的提示；<br> 不认识，原样
        '| 防冻机械方块 [gregtech:gt.blockcasings2/1] | 至少 16 个 |',
        '| 能源仓哪种 (普通的和多安的都行) | 1 个<br>任意位置 |',
        '',
        '## 合成',
        '',
        '[the recipes for 真空冷冻机 [gregtech:gt.blockmachines/1002] are shown here in the game]',
        '',
        '[a recipe for 防冻机械方块 [gregtech:gt.blockcasings2/1] is shown here in the game (handler gt.recipe.assembler; with input 钢板 [gregtech:gt.metaitem.01/17305])]',
        '',
        // 代码里的尖括号是字；没见过的标签原样留着
        '指令 `/gt <player> freeze` 里的尖括号是字，`<PlayerName />` 写在代码里也是字。<Mystery kind="x">没见过的标签</Mystery>',
        '',
        '[image shown here in the game: 结构图 (vacuum_freezer.png)]',
        '',
      ].join('\n'),
    )
    // 程序里拿到的是整页读成字以后的正文、各小节从哪里起、讲的物品、挂的任务
    assert.equal(res.data.text, body)
    assert.deepEqual(res.data.sections.map((s: any) => [s.level, s.title]), [[1, '真空冷冻机'], [2, '合成'], [2, '故障排查']])
    assert.deepEqual([res.data.path, res.data.title, res.data.lang, res.data.parent, res.data.items, res.data.quests, res.data.author, res.data.date], [VF_PAGE, '真空冷冻机', 'zh_cn', 'gregtech:multiblocks/multiblocks_index.md', [VF], ['AAAAAAAAAAAAAAAAAAAFMQ=='], 'Skorched', '2026-05-27'])
  })

  it('读一页：场景里摆的东西和批注的字都在，图表留标题、坐标轴和曲线的式子，页签留标题，浮动图留标题和批注，公式和按键留原样', async (t) => {
    const f = setup(t)
    const body = (await f.read({ path: EBF_PAGE })).text.split('\n---\n')[1]
    assert.equal(
      body,
      [
        '# 工业高炉',
        '',
        // ImportStructure、Block、RemoveBlocks 是场景里摆了什么；IsometricCamera 只管视角，不留；没有字的线不留
        '[3D scene shown here in the game: a built example (ebf_built.snbt); the block 熔炉 [minecraft:furnace] at (2,1,0) facing north; without the blocks 泥土 [minecraft:dirt]]',
        '- note on the scene, box (0 0 0) to (3 1 3): 底层一圈是隔热机械方块 [gregtech:gt.blockcasings/11]。',
        '- note on the scene, label at (1 3 1): 消声仓放在顶上正中',
        '',
        '[3D scene shown here in the game: an animation (ebf_ponder.json)]',
        '',
        // Row、Column 只留里面的字（去掉为排进标签而缩进的那几格）
        '线圈：白铜线圈方块 [gregtech:gt.blockcasings5/0]',
        '[picture of the block 坎塔尔线圈方块 [gregtech:gt.blockcasings5/1] shown here in the game]',
        '',
        '[graph shown here in the game: 炉温与耗电; x: 炉温 (K); y: 耗电倍率; x from 1800..5400]',
        '- curve "每 900K 省 5%": 0.95^((x-1800)/900) (x in 1800..5400)',
        '',
        '配方表',
        '',
        '**按电压分**',
        '',
        '铝要 MV。',
        '',
        '[image shown here in the game: 高炉界面 (ebf_gui.png)] 右上角是炉温',
        '',
        '[the recipes that use 白铜线圈方块 [gregtech:gt.blockcasings5/0] are shown here in the game]',
      ].join('\n'),
    )
    const cable = (await f.read({ path: 'gregtech:power/cable.md' })).text
    assert.ok(cable.includes('电流越大，线损越大：$P = U \\times I$。按 [key binding key.gt.wire] 看导线的参数。'))
  })

  it('读一页：<SubPages /> 和 <Category /> 列出它指的那些页（能直接拿去读）；<PlayerName /> 是一个中性的词', async (t) => {
    const f = setup(t)
    const index = await f.read({ path: 'gregtech:index.md' })
    assert.equal(
      index.text,
      [
        'Guide page "GT 新视野" — gregtech:index.md, Chinese; english: true gives the English version.',
        'Sub-pages: 2 — "导线与线缆" (gregtech:power/cable.md), "多方块机器" (gregtech:multiblocks/multiblocks_index.md).',
        '---',
        '# GT 新视野',
        '',
        '这本书讲 GregTech 的机器。玩家，从这里开始：',
        '',
        '- 导线与线缆 (gregtech:power/cable.md)',
        '- 多方块机器 (gregtech:multiblocks/multiblocks_index.md)',
      ].join('\n'),
    )
    const machines = (await f.read({ path: 'gregtech:multiblocks/multiblocks_index.md' })).text.split('\n---\n')[1]
    assert.equal(machines, ['# 多方块机器', '', '## 机器一览', '', `- 工业高炉 (${EBF_PAGE})`, `- 真空冷冻机 (${VF_PAGE})`, '- Vacuum Freezer [en] (gregtech:multiblocks/vacuum_freezer.md)'].join('\n'))
  })

  it('语言：同一路径两种语言都有的给中文，并说英文也有、怎么要；只有英文的照实说没有中文版', async (t) => {
    const f = setup(t)
    const zh = await f.read({ path: 'gregtech:power/cable.md' })
    assert.match(zh.text, /^Guide page "导线与线缆" — gregtech:power\/cable\.md, Chinese; english: true gives the English version\.\n/)
    const en = await f.read({ path: 'gregtech:power/cable.md', english: true })
    assert.equal(en.text, ['Guide page "Wires and Cables" — gregtech:power/cable.md, the English version.', 'Under: "GT 新视野" (gregtech:index.md).', '---', '# Wires and Cables', '', 'Cables lose power over distance.'].join('\n'))
    const only = await f.read({ path: 'gregtech:multiblocks/vacuum_freezer.md' })
    assert.equal(
      only.text,
      [
        'Guide page "Vacuum Freezer" — gregtech:multiblocks/vacuum_freezer.md, English (there is no Chinese version).',
        'About: 真空冷冻机 [gregtech:gt.blockmachines/1002].',
        'Under: "多方块机器" (gregtech:multiblocks/multiblocks_index.md).',
        `Other pages about the same item: "真空冷冻机" (${VF_PAGE}).`,
        '---',
        '# Vacuum Freezer',
        '',
        // 英文页里物品也用游戏里的中文名；<PlayerName /> 在英文页里是 player
        'The 真空冷冻机 [gregtech:gt.blockmachines/1002] cools hot ingots. Hello, player.',
      ].join('\n'),
    )
  })

  it('一页比单个结果的上限长：给到放得下为止，写明给了第几到第几个字符、一共多少、怎么接着读，并列出各小节从哪里起；接着读能读到头；程序里一次拿到全文', async (t) => {
    const f = setup(t)
    const first = await f.read({ path: VF_PAGE }, { cap: 3000 })
    assert.ok(first.text.length <= 3000, `${first.text.length} chars`)
    const total = first.data.text.length
    const tail = /\n---\n\[chars 0–(\d+) of (\d+) of this page\. The rest: the same path with offset: (\d+)\.\]\nIts sections \(offset: heading\): 0: # 真空冷冻机 · (\d+): ## 合成 · (\d+): ## 故障排查$/.exec(first.text)
    assert.ok(tail, first.text.slice(-300))
    const end = Number(tail[1])
    assert.deepEqual([Number(tail[2]), Number(tail[3])], [total, end])
    assert.ok(end > 1500 && end < total)
    // 给出来的那一段就是全文的前 end 个字符
    assert.equal(first.text.split('\n---\n')[1], first.data.text.slice(0, end).trim())
    // 接着读：从那里到页尾，不再重复小节的清单
    const rest = await f.read({ path: VF_PAGE, offset: end }, { cap: 3000 })
    assert.match(rest.text, new RegExp(`\\n---\\n\\[chars ${end}–${total} of ${total} of this page\\. This is the end of the page\\.\\]$`))
    assert.equal(rest.text.split('\n---\n')[1], first.data.text.slice(end).trim())
    assert.ok(rest.text.includes('- 第 40 条：'))
    // 小节的那个数可以直接当 offset；path 后面写 #小节 也从那一节读起
    const section = await f.read({ path: VF_PAGE, offset: Number(tail[5]) }, { cap: 3000 })
    assert.ok(section.text.split('\n---\n')[1]!.startsWith('## 故障排查\n\n- 第 1 条：'))
    const anchored = await f.read({ path: `${VF_PAGE}#合成` }, { cap: 3000 })
    assert.ok(anchored.text.split('\n---\n')[1]!.startsWith('## 合成\n\n[the recipes for 真空冷冻机'))
    const missing = await f.read({ path: `${VF_PAGE}#没有这一节` })
    assert.match(missing.text, /^Guide page "真空冷冻机" — [^\n]+ No heading of this page matches "#没有这一节": this is from the top\.\n/)
  })

  it('按词找：标题、读成字以后的正文、讲的物品的名字（中英文）里都找；几个词都要有；标题对上的排前面；给对上的那一处前后的一小段', async (t) => {
    const f = setup(t)
    // “防冻”不在原文里（原文是 <ItemLink id=…>），读成字以后才有
    const casing = await f.read({ query: '防冻' })
    assert.match(casing.text, new RegExp(`^1 guide page\\(s\\) match "防冻", title matches first\\. Read one with path\\.\\n- 真空冷冻机 — ${VF_PAGE.replace(/[.]/g, '\\.')}\\n    [^\\n]*防冻机械方块 \\[gregtech:gt\\.blockcasings2/1\\][^\\n]*$`))
    // 英文名：英文页的标题对上了排最前；中文页讲的物品英文名也叫这个
    const english = await f.read({ query: 'vacuum freezer' })
    assert.deepEqual(english.data.hits.map((h: any) => [h.path, h.score]).slice(0, 2), [['gregtech:multiblocks/vacuum_freezer.md', 3], [VF_PAGE, 2]])
    // 两个词各在一页里：一起找就没有
    assert.equal((await f.read({ query: '损耗 冰箱' })).text, 'No guide page has all the words of "损耗 冰箱" in its title, its text or the name of the item it is about. The guide is searched in the language of each page (Chinese where there is one).')
    assert.deepEqual((await f.read({ query: '线损' })).data.hits.map((h: any) => h.path), ['gregtech:power/cable.md', VF_PAGE])
    // 只在一本书里找
    assert.deepEqual((await f.read({ query: '久等', book: 'changelog' })).data.hits.map((h: any) => h.path), ['changelog:index.md'])
    assert.equal((await f.read({ query: '久等', book: 'gregtech' })).data.matched, 0)
  })

  it('按物品找讲它的页：中文的在前，只有英文的也列；没有讲它的页照实说', async (t) => {
    const f = setup(t)
    assert.equal(
      (await f.read({ id: VF.id, meta: VF.meta })).text,
      ['2 guide page(s) about 真空冷冻机 [gregtech:gt.blockmachines/1002]. Read one with path.', `- 真空冷冻机 — ${VF_PAGE}`, '- Vacuum Freezer [en] — gregtech:multiblocks/vacuum_freezer.md'].join('\n'),
    )
    assert.equal(
      (await f.read({ id: 'gregtech:gt.metaitem.01', meta: 17305 })).text,
      'No guide page names 钢板 [gregtech:gt.metaitem.01/17305] as its subject. A page can still mention it in its text: query searches the text.',
    )
    // 这个 id 别的 meta 有页
    assert.match((await f.read({ id: VF.id, meta: 5 })).text, /^No guide page names gregtech:gt\.blockmachines\/5 as its subject \(other metas of gregtech:gt\.blockmachines have pages: leave out meta to see them\)\./)
  })

  it('页写错了：照实说没有，文件名一样的页列出来', async (t) => {
    const f = setup(t)
    const res = await f.read({ path: 'gregtech:multiblocks/mv/vacuum_freezer.md' })
    assert.equal(res.isError, true)
    assert.equal(
      res.text,
      `There is no guide page "gregtech:multiblocks/mv/vacuum_freezer.md". A page is written book:path, e.g. "gregtech:index.md". Pages with that file name: ${VF_PAGE} "真空冷冻机", gregtech:multiblocks/vacuum_freezer.md "Vacuum Freezer". read_guide {book} lists a book's pages; {query} searches.`,
    )
  })

  it('别的工具说到一件物品时带一行“指南里有这一页”（页名和怎么读）：find_item、find_structure、inspect_block、find_machines；指南里没有的不带', async (t) => {
    const f = setup(t)
    const note = `in the guide: "真空冷冻机" — read_guide {path: "${VF_PAGE}"} (+1 more: read_guide {id: "gregtech:gt.blockmachines", meta: 1002})`
    // find_item：讲它的不止一页时写第一页，并说还有几页、怎么列出来
    const items = await f.call('find_item', { query: '真空冷冻机' })
    assert.ok(items.text.includes(`- 真空冷冻机 [gregtech:gt.blockmachines/1002]: `) && items.text.includes(`; ${note}`), items.text)
    assert.equal((await f.call('find_item', { query: '钢板' })).text.includes('guide'), false)
    // find_item 找到的物品多（超过五个）时不逐个带，结尾说其中几个在指南里有页、怎么看某一个的
    const many = await f.call('find_item', { query: 'gregtech' })
    assert.equal(many.data.total, 7)
    assert.equal(many.text.includes('in the guide:'), false)
    assert.ok(many.text.endsWith('\n3 of these have a page in the in-game guide: read_guide {id, meta} lists the pages about one.'), many.text)
    // find_structure
    const structure = await f.call('find_structure', { name: '工业高炉' })
    assert.ok(structure.text.includes(`\nIn the guide: "工业高炉" — read_guide {path: "${EBF_PAGE}"}\n`), structure.text)
    assert.equal((await f.call('find_structure', { name: '大型蒸汽离心机' })).text.includes('guide'), false)
    // inspect_block：机器在世界里的 meta 不是物品的 meta，靠身体给的英文名认出是哪件物品
    f.game.handlers['world.block'] = (p) =>
      p.x === 1
        ? { id: VF.id, meta: 3, name: 'Vacuum Freezer', solid: true, tileEntity: true }
        : p.x === 2
          ? // 名字对不上物品表的机器：它在世界里的 meta 碰巧是 1002 也不拿来认（机器的 meta 不是物品的 meta）
            { id: VF.id, meta: 1002, name: 'Some Unknown Machine', solid: true, tileEntity: true }
          : // 普通方块（没有方块实体）：世界里的 meta 就是物品的 meta
            { id: 'gregtech:gt.blockcasings5', meta: 0, solid: true }
    const block = await f.call('inspect_block', { x: 1, y: 64, z: 1 })
    assert.equal(block.text, `(1,64,1): gregtech:gt.blockmachines/3 "真空冷冻机" [solid, tileEntity]\nI${note.slice(1)}`)
    assert.equal((await f.call('inspect_block', { x: 2, y: 64, z: 1 })).text.includes('guide'), false)
    assert.equal((await f.call('inspect_block', { x: 3, y: 64, z: 1 })).text, `(3,64,1): gregtech:gt.blockcasings5 [solid]\nIn the guide: "工业高炉" — read_guide {path: "${EBF_PAGE}"}`)
    // find_machines：同一种机器两台，那一行只在头一台下面
    f.game.handlers['world.machines'] = () => ({
      machines: [
        // 身体给机器的 id + meta 就是它作为物品的那一对
        { x: 1, y: 64, z: 1, name: 'Vacuum Freezer', ...VF, kind: 'multiblock', formed: true, recipes: 'Vacuum Freezer', tier: 'HV', active: false, storedEU: 100 },
        { x: 9, y: 64, z: 1, name: 'Vacuum Freezer', ...VF, kind: 'multiblock', formed: true, recipes: 'Vacuum Freezer', tier: 'HV', active: false, storedEU: 100 },
        { x: 5, y: 64, z: 5, name: 'Electric Blast Furnace', ...EBF, kind: 'multiblock', formed: true, recipes: 'Blast Furnace', tier: 'MV', active: false, storedEU: 100 },
      ],
      total: 3,
    })
    f.game.handlers['world.containers'] = () => ({ containers: [], total: 0, offset: 0 })
    const machines = (await f.call('find_machines', {})).text
    assert.equal(machines.split(note).length - 1, 1, machines)
    assert.ok(machines.includes(`    in the guide: "工业高炉" — read_guide {path: "${EBF_PAGE}"}`), machines)
    assert.ok(machines.indexOf(note) < machines.indexOf('(9,64,1)'), 'under the first of the two freezers')
  })
})

describe('按名字找机器：中文名、英文名都认', { skip }, () => {
  it('find_structure 的 name：结构数据里的中文名和物品表里这台主机的英文名都认，几个词都要在同一个名字里', async (t) => {
    const f = setup(t)
    const zh = await f.call('find_structure', { name: '工业高炉' })
    const en = await f.call('find_structure', { name: 'electric blast furnace' })
    assert.match(zh.text, /^工业高炉 \[gregtech:gt\.blockmachines\/1000\]: a multiblock machine with 6 tier\(s\)/)
    assert.equal(en.text, zh.text)
    // 名字的一部分也行（英文不分大小写）
    assert.equal((await f.call('find_structure', { name: 'Blast' })).text, zh.text)
    // 两种名字里都没有
    assert.equal(
      (await f.call('find_structure', { name: 'fusion reactor' })).text,
      'No multiblock machine whose Chinese or English name contains "fusion reactor" is in the structure data. Try a shorter part of the name, or find the controller with find_item and give its id and meta.',
    )
  })

  it('find_machines 的 name：结果里写的是中文名，照中文名筛也认（身体只认英文名，所以把范围里的都要来在这边筛）；英文名照旧交给身体筛', async (t) => {
    const f = setup(t)
    const machines = [
      { x: 1, y: 64, z: 1, name: 'Vacuum Freezer', ...VF, kind: 'multiblock', formed: true, recipes: 'Vacuum Freezer', recipeKey: 'gt.recipe.vacuumfreezer', tier: 'HV', active: false, storedEU: 100 },
      { x: 5, y: 64, z: 5, name: 'Electric Blast Furnace', ...EBF, kind: 'multiblock', formed: true, recipes: 'Blast Furnace', tier: 'MV', active: false, storedEU: 100 },
    ]
    // 身体照它自己的英文名筛
    f.game.handlers['world.machines'] = (p) => {
      const word = typeof p.name === 'string' ? p.name.toLowerCase() : undefined
      const kept = machines.filter((m) => word === undefined || m.name.toLowerCase().includes(word))
      return { machines: kept, total: kept.length }
    }
    f.game.handlers['world.containers'] = () => ({ containers: [], total: 0, offset: 0 })
    const zh = await f.call('find_machines', { name: '高炉' })
    assert.match(zh.text, /^1 GregTech machine\(s\) whose name or recipe type contains "高炉" within 32 blocks of you, nearest first\./)
    assert.ok(zh.text.includes('- (5,64,5) "工业高炉"') && !zh.text.includes('真空冷冻机'), zh.text)
    // 中文名没有交给身体（它认不了），要的是范围里的全部
    assert.deepEqual(f.game.callsOf('world.machines').at(-1), { bot: 'Alu', radius: 32, limit: 60 })
    // 配方页的中文名也认：冰箱跑的那一页叫“急冻”，它自己的名字里没有这两个字
    assert.deepEqual((await f.call('find_machines', { name: '急冻' })).data.machines.map((m: any) => m.name), ['真空冷冻机'])
    // 英文名：照旧交给身体
    const en = await f.call('find_machines', { name: 'Blast' })
    assert.deepEqual(f.game.callsOf('world.machines').at(-1), { bot: 'Alu', radius: 32, name: 'Blast' })
    assert.ok(en.text.includes('- (5,64,5) "工业高炉"') && !en.text.includes('真空冷冻机'))
    // 范围里的机器比一次要得来的多：照实说只看了最近的多少台
    f.game.handlers['world.machines'] = () => ({ machines, total: 75 })
    assert.ok((await f.call('find_machines', { name: '高炉' })).text.endsWith('\nOnly the nearest 2 of the 75 machines in range were looked at for that Chinese name: a smaller radius, or the English name, covers the others.'))
  })
})

describe('游戏内指南：两条线', { skip }, () => {
  function agents(t: { after(fn: () => void | Promise<void>): void }, opts: { guide?: boolean } = {}) {
    const tmp = tmpDir()
    const dir = buildGuidePackdata(tmp.dir, opts)
    writeStructureFixture(dir)
    const packdata = loadPackData(dir)
    useLocalNames(packdata.items, packdata.fluids)
    const h = makeAgent({ dir: tmp.dir, design: new DesignWorkspace({ dataDir: tmp.dir, packdata }), packdata })
    t.after(async () => {
      await h.agent.stop()
      useLocalNames(undefined)
      packdata.recipes?.close()
      tmp.cleanup()
    })
    return h
  }

  it('两条线都有 read_guide，调出来的是同一份；程序里也能调（只查不动），从 data 拿全文', async (t) => {
    const h = agents(t)
    const work = await modelCalls(h, 'read_guide', { id: VF.id, meta: VF.meta })
    const talk = await lineCalls(h, 'talk', 'read_guide', { id: VF.id, meta: VF.meta }, 'Alu 冰箱怎么用')
    assert.deepEqual([work.isError, talk.isError], [false, false])
    assert.equal(work.content, talk.content)
    assert.match(work.content, /^2 guide page\(s\) about 真空冷冻机 /)
    for (const llm of [h.llm, h.talk]) assert.ok(llm.requests[0]!.tools.some((tool) => tool.name === 'read_guide'))
    // 对话线写的程序里调它：拿到的是整页，不受单个结果上限的限制
    const program = await lineCalls(h, 'talk', 'run_program', { code: `const r = await tool('read_guide', { path: '${VF_PAGE}' }); return [r.ok, r.data.text.length, r.data.text.includes('第 40 条')]` }, 'Alu 再看看')
    assert.match(program.content, /\[true,\d{4},true\]/)
    // 程序里的 data.structure 按名字取机器：中文名、物品表里的英文名（不分大小写）都认
    const named = await modelCalls(h, 'run_program', { code: `return [data.structure('工业高炉').meta, data.structure('electric blast furnace').name, data.structure('Fusion Reactor')]` }, 'Alu 查结构')
    assert.match(named.content, /\[1000,"工业高炉",null\]/)
  })

  it('读到了指南时，两条线的提示词里各有同一句事实：包里有这本指南、主人看到的是同一份、它是人写的、配方和结构以导出的资料为准；没读到就没有这一节', async (t) => {
    const h = agents(t)
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    h.agent.handleEvent(told('去仓库'))
    await h.agent.whenIdle()
    const section =
      '# 游戏内指南\n这个整合包带着一本游戏内指南（玩家在游戏里按 G 打开的那本，7 页），read_guide 读到的和主人看到的是同一份。它是人写的说明，2026 年 5 月前后照 2.9 写的；配方和多方块结构以从这个客户端导出来的资料为准（find_recipes、find_structure）。'
    for (const llm of [h.llm, h.talk]) assert.ok(llm.requests[0]!.system.includes(`\n\n${section}\n\n`), llm.requests[0]!.system.slice(-600))

    const bare = agents(t, { guide: false })
    bare.llm.enqueue(reply('好'))
    bare.agent.handleEvent(told('去仓库'))
    await bare.agent.whenIdle()
    assert.equal(bare.llm.requests[0]!.system.includes('游戏内指南'), false)
  })
})
