// 本地资料：生成器（tools/make-packdata.py）→ 资料文件 → 大脑加载 → 任务书工具。
// 用的客户端包是 fixture-pack.ts 造的小样本，不碰真实的整合包。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import { loadPackData } from '../src/packdata/index.ts'
import type { PackData } from '../src/packdata/index.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { ALL_TOOLS, QuestProgressCache, runTool } from '../src/tools/index.ts'
import type { ToolContext, ToolResult } from '../src/tools/index.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { NIGHT_WATCH, TRAVEL_LINE, buildFixturePackdata, pythonMissing, runGenerator } from './fixture-pack.ts'
import { tmpDir } from './helpers.ts'

type Json = Record<string, any>

function readJsonLines(file: string): Json[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Json)
}

describe('本地资料', { skip: pythonMissing() }, () => {
  /** 生成一次，各个测试只读它。 */
  let made: { zip: string; packdata: string }
  let quests: Map<string, Json>
  let lines: Json[]
  const shared = tmpDir('aiplayer-packdata-')
  after(shared.cleanup)
  before(() => {
    made = buildFixturePackdata(shared.dir)
    quests = new Map(readJsonLines(path.join(made.packdata, 'quests.jsonl')).map((q) => [q.id as string, q]))
    lines = (JSON.parse(fs.readFileSync(path.join(made.packdata, 'questlines.json'), 'utf8')) as Json).lines
  })

  describe('生成器：make-packdata.py quests', () => {
    it('一个任务一行，id 是服务器用的那种：老任务是去掉前导零的十六进制数，新任务是完整的小写 UUID', () => {
      assert.deepEqual([...quests.keys()].sort(), ['1', '2', '43', '47', '4a', '50', '51', '52', '53', '54', '60', NIGHT_WATCH].sort())
    })

    it('名称和描述是中文的，英文原名另外留着；整合包没翻译的任务用任务文件里的英文', () => {
      const motors = quests.get('47')!
      assert.equal(motors.name, '基础制作：马达')
      assert.equal(motors.en, 'Basic Crafting: Motors')
      assert.equal(motors.descEn, 'Motors are little devices that turn electricity into motion. You will need a lot of them.')
      const untranslated = quests.get('52')!
      assert.equal(untranslated.name, 'Tools of the Trade 4 - Rubber Boots')
      assert.equal(untranslated.desc, 'Some crops do not enjoy being stepped on.\n\nWear rubber boots.')
      const steam = lines.find((l) => l.id === '2')!
      assert.deepEqual([steam.name, steam.en, steam.desc], ['第0.5阶 - 蒸汽时代', 'Tier 0.5 - Steam', '蒸汽动力。'])
    })

    it('描述里的格式标记整理成纯文本：颜色码和 [note] [warn] [url] 去掉，%n 是换行，%% 是百分号，[questlink] 换成那个任务的名字和 id', () => {
      assert.equal(quests.get('1')!.desc, '欢迎来到格雷科技：新视野！\n\n先撸树，弄点木头。木头有 100% 的用处。')
      assert.equal(quests.get('47')!.desc, '电动马达把电变成转动，以后要用很多。\n\n磁化铁杆要用红石。\n详见 https://wiki.gtnewhorizons.com')
      assert.equal(quests.get('53')!.desc, '交面包或者曲奇，或者直接打个勾。做马达见“基础制作：马达”（任务 47）。')
    })

    it('前置和它们之间的关系照任务文件来；章节按 QuestLinesOrder.txt 的顺序，章节里前置任务排在前面', () => {
      assert.deepEqual(quests.get('47')!.pre, ['43'])
      assert.deepEqual([quests.get('50')!.pre, quests.get('50')!.logic], [['2', '47'], 'OR'])
      assert.deepEqual([quests.get('51')!.pre, quests.get('51')!.logic], [['1', '2'], 'XOR'])
      assert.deepEqual([quests.get('1')!.pre, quests.get('1')!.logic], [[], 'AND'])
      // 压缩包里目录按字母排是 GettingAround、Tier05Steam、Tier0StoneAge；书里的顺序是另一回事
      assert.deepEqual(lines.map((l) => l.id), ['1', TRAVEL_LINE, '2'])
      const stone = lines[0]!.quests as string[]
      assert.deepEqual([...stone].sort(), ['1', '2', '54', NIGHT_WATCH].sort())
      assert.ok(stone.indexOf('1') < stone.indexOf('2'), 'quest 2 needs quest 1, so it comes after it')
      const steam = lines[2]!.quests as string[]
      assert.ok(steam.indexOf('43') < steam.indexOf('47'))
      // 一个任务可以在两章里；不在任何章节里的内部任务照样有，只是 lines 是空的
      assert.deepEqual(quests.get('4a')!.lines, [TRAVEL_LINE, '2'])
      assert.deepEqual([quests.get('60')!.lines, quests.get('60')!.visibility], [[], 'HIDDEN'])
    })

    it('子任务和奖励：物品的 id、meta、数量，矿辞，交不交出去，以及猎杀、地点、流体、选一样、经验、连带完成', () => {
      // 任何变体都行（Damage 32767）的没有 meta
      assert.deepEqual(quests.get('1')!.tasks, [{ type: 'retrieval', items: [{ id: 'minecraft:log', count: 4, ore: 'logWood' }], consume: false }])
      assert.deepEqual(quests.get('43')!.tasks, [{ type: 'retrieval', items: [{ id: 'gregtech:gt.blockmachines', meta: 1246, count: 4 }], consume: true }])
      assert.deepEqual(quests.get('47')!.tasks, [
        { type: 'crafting', items: [{ id: 'gregtech:gt.metaitem.01', meta: 32600, count: 2 }], ignoreNBT: true, allow: ['craft', 'smelt'] },
        { type: 'optional_retrieval', items: [{ id: 'gregtech:gt.metaitem.01', meta: 23032, count: 2 }], consume: false },
      ])
      assert.deepEqual(quests.get(NIGHT_WATCH)!.tasks, [
        { type: 'hunt', target: 'Zombie', count: 10 },
        { type: 'location', location: { name: 'THE NETHER', dim: -1 } },
        { type: 'fluid', consume: false, fluids: [{ fluid: 'water', mb: 1000 }] },
      ])
      assert.deepEqual(quests.get('54')!.tasks[0].items, [
        { id: 'Forestry:beePrincessGE', meta: 0, count: 1, nbt: { Genome: { Chromosomes: [{ UID0: 'forestry.speciesForest', UID1: 'forestry.speciesForest' }] } } },
      ])
      assert.deepEqual(quests.get('2')!.rewards, [{ type: 'choice', items: [{ id: 'minecraft:bread', meta: 0, count: 8 }, { id: 'minecraft:torch', meta: 0, count: 16 }] }])
      const daily = quests.get('53')!
      assert.deepEqual([daily.repeat, daily.taskLogic], [72000, 'OR'])
      assert.deepEqual(daily.tasks[0], { type: 'retrieval', items: [{ id: 'minecraft:bread', meta: 0, count: 1 }, { id: 'minecraft:cookie', meta: 0, count: 1 }], anyOne: true, consume: true })
      assert.deepEqual(daily.rewards, [{ type: 'xp', amount: 3, levels: true }, { type: 'questcompletion', quest: '60' }])
    })

    it('meta.json 登记来源包名、生成时间和条数；别的子命令登记的内容原样留着', (t) => {
      const tmp = tmpDir()
      t.after(tmp.cleanup)
      fs.writeFileSync(path.join(tmp.dir, 'meta.json'), JSON.stringify({ items: { source: 'nei-export', items: 12345 }, quests: { quests: 1 } }))
      const run = runGenerator(made.zip, tmp.dir)
      assert.equal(run.status, 0, run.stderr)
      const meta = JSON.parse(fs.readFileSync(path.join(tmp.dir, 'meta.json'), 'utf8')) as Json
      assert.deepEqual(meta.items, { source: 'nei-export', items: 12345 })
      assert.equal(meta.quests.source, 'Fixture-client.zip')
      assert.deepEqual([meta.quests.quests, meta.quests.lines], [12, 3])
      assert.ok(Math.abs(Date.parse(meta.quests.generatedAt) - Date.now()) < 60_000, `generatedAt is now: ${meta.quests.generatedAt}`)
    })
  })

  // ── 大脑这一侧 ──

  const NOW = 1_800_000_000_000

  /** 工具用的上下文：真的工具、真的本地资料，游戏那一头是按方法名应答的假服务器。 */
  function setup(t: { after(fn: () => void): void }, packdata: PackData) {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const game = new FakeGame()
    const clock = { now: NOW }
    const who: { defaultPlayer: string | undefined } = { defaultPlayer: 'Steve' }
    const bridge = new BridgeApi(game)
    const ctx: ToolContext = {
      botName: 'Alu',
      bridge,
      memory: new MemoryStore(tmp.dir, () => 300),
      manuals: new ManualStore(DEFAULT_MANUALS_DIR, path.join(tmp.dir, 'manuals')),
      packdata,
      questProgress: new QuestProgressCache(bridge, () => clock.now),
      defaultPlayer: () => who.defaultPlayer,
      reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
      hooks: {},
      now: () => clock.now,
    }
    // Steve 做完了 1 和 2（和模拟 bridge 自带的进度一样）
    game.handlers['quest.progress'] = (p) => ({ player: p.player, completed: ['1', '2'] })
    const run = (name: string, input: unknown = {}): Promise<ToolResult> => runTool(ALL_TOOLS, ctx, name, input)
    return { game, clock, who, run }
  }

  /** 搜索结果里各行的任务 id，按出现的顺序。 */
  function idsIn(content: string): string[] {
    return content
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).split(' ')[0]!)
  }

  describe('加载', () => {
    it('资料目录不存在：什么都没有，日志里说明任务书改问服务器；工具照旧走服务器的三个方法', async (t) => {
      const said: string[] = []
      const packdata = loadPackData(path.join(made.packdata, 'no-such-dir'), (m) => said.push(m))
      assert.equal(packdata.quests, undefined)
      assert.equal(packdata.items, undefined)
      assert.match(said.join('\n'), /没有本地资料.*任务书改问服务器/)

      const s = setup(t, packdata)
      s.game.handlers['quest.lines'] = () => ({ lines: [{ name: 'Tier 0 - Stone Age', quests: 52, complete: 45, available: 3 }], quests: 3814 })
      const res = await s.run('list_quest_lines')
      assert.deepEqual(s.game.calls.map((c) => c.method), ['quest.lines'])
      assert.match(res.content, /^- Tier 0 - Stone Age: 45 \/ 3 \/ 52$/m)
    })

    it('有任务书、没有 items.jsonl：任务书照常加载，日志里说物品只显示 id 和 meta', () => {
      const said: string[] = []
      const packdata = loadPackData(made.packdata, (m) => said.push(m))
      assert.equal(packdata.quests?.size, 12)
      assert.equal(packdata.items, undefined)
      assert.match(said.join('\n'), /任务书：12 个任务、3 章（来自 Fixture-client\.zip/)
      assert.match(said.join('\n'), /没有物品表（items\.jsonl）/)
    })
  })

  describe('任务书工具读本地资料', () => {
    let packdata: PackData
    before(() => {
      packdata = loadPackData(made.packdata)
    })

    it('list_quest_lines：章节按书里的顺序、带中文名；进度只问服务器“做完了哪些”，能做的自己算', async (t) => {
      const s = setup(t, packdata)
      const res = await s.run('list_quest_lines')
      assert.equal(res.isError, undefined, res.content)
      assert.deepEqual(s.game.calls, [{ method: 'quest.progress', params: { player: 'Steve' } }])
      assert.deepEqual(res.content.split('\n'), [
        "The quest book has 12 quests in 3 chapters, in the book's order. Progress of Steve per chapter: done / can be done now / total.",
        // 1、2 做完了；守夜人和蜂后没有前置，现在能做
        '- 第0阶 - 石器时代 (Tier 0 - Stone Age): 2 / 2 / 4',
        '- 游历四方…… (Getting Around...): 0 / 2 / 2',
        // 43（前置 2 做完了）、4a（没有前置）、50（前置任意一个）能做；47、51、52 锁着
        '- 第0.5阶 - 蒸汽时代 (Tier 0.5 - Steam): 0 / 3 / 6',
      ])
    })

    it('find_quests 只按状态筛：列出主人现在能做的，没解锁的、做完的、书里看不到的内部任务都不在里面', async (t) => {
      const s = setup(t, packdata)
      const res = await s.run('find_quests', { state: 'available' })
      assert.equal(res.isError, undefined, res.content)
      assert.match(res.content, /^6 quest\(s\) match \(state available\) for Steve:/)
      assert.deepEqual(idsIn(res.content).sort(), ['43', '4a', '50', '53', '54', NIGHT_WATCH].sort())
      assert.match(res.content, /^- 43 "导线，奇怪？" \[第0\.5阶 - 蒸汽时代\] \(main\): available \{hand in\}$/m)
      // 每日面包要交东西（收走）、要打勾：这两样要在书里亲手按，行尾标出来，开头说明标记的意思
      assert.match(res.content, /^- 53 "每日面包" \[游历四方……\]: available \{hand in, tick\}$/m)
      assert.match(res.content.split('\n')[0]!, /\{…\}: what is done by hand in the quest book: "hand in" \(Detect\/Submit takes items\), "tick" \(a checkbox\), "pick one" \(a reward to choose\)\)$/)
      // 60 没有前置所以也“能做”，但它不在任何章节里
      assert.match(res.content, /^1 more fit but are left out: internal quests that are in no chapter/m)

      const locked = await s.run('find_quests', { state: 'locked' })
      // 51 的前置是“恰好一个”，两个都做完了反而锁着；52 的前置指向一个不存在的任务
      assert.deepEqual(idsIn(locked.content).sort(), ['47', '51', '52'])
      assert.deepEqual(idsIn((await s.run('find_quests', { state: 'complete' })).content).sort(), ['1', '2'])
      assert.deepEqual(s.game.calls.map((c) => c.method), ['quest.progress'], 'nothing but the progress is asked of the server, and only once')
    })

    it('find_quests 按词搜：中文、英文都行，名称和描述都搜，名称里对上的排前面', async (t) => {
      const s = setup(t, packdata)
      // “马达”在 47 的名称里，也在 53 的描述里
      assert.deepEqual(idsIn((await s.run('find_quests', { query: '马达' })).content), ['47', '53'])
      assert.deepEqual(idsIn((await s.run('find_quests', { query: 'motors' })).content), ['47'])
      // 只在英文原名里有的词
      assert.deepEqual(idsIn((await s.run('find_quests', { query: 'skies' })).content), ['4a'])
      // 只在描述里出现的词：中文描述、英文描述
      assert.deepEqual(idsIn((await s.run('find_quests', { query: '红石' })).content), ['47'])
      assert.deepEqual(idsIn((await s.run('find_quests', { query: 'hover' })).content), ['4a'])
      // 几个词要都对上；整合包没翻译的任务按英文搜得到
      assert.deepEqual(idsIn((await s.run('find_quests', { query: '面包 曲奇' })).content), ['53'])
      assert.deepEqual(idsIn((await s.run('find_quests', { query: 'Rubber boots' })).content), ['52'])
      const none = await s.run('find_quests', { query: '核聚变' })
      assert.equal(none.content, 'No quest matches (words "核聚变") for Steve.')
    })

    it('find_quests 按章节筛：章节名的中文或英文的一部分；可以和词、状态混着用；章节名对不上时说清楚', async (t) => {
      const s = setup(t, packdata)
      assert.deepEqual(idsIn((await s.run('find_quests', { line: '蒸汽' })).content).sort(), ['43', '47', '4a', '50', '51', '52'])
      assert.deepEqual(idsIn((await s.run('find_quests', { line: 'steam', state: 'available' })).content).sort(), ['43', '4a', '50'])
      // 4a 在两章里：按哪一章筛，结果里就写哪一章
      const travel = await s.run('find_quests', { line: 'Getting Around', query: '背包' })
      assert.deepEqual(travel.content.split('\n').slice(1), ['- 4a "飞向天空" [游历四方……]: available'])
      const wrong = await s.run('find_quests', { line: '核物理' })
      assert.equal(wrong.isError, true)
      assert.match(wrong.content, /No chapter of the quest book has "核物理" in its name/)
    })

    it('find_quests 结果多时分页：写明一共多少、这是第几页，翻完所有页一个不漏、一个不重', async (t) => {
      const s = setup(t, packdata)
      const first = await s.run('find_quests', { limit: 5 })
      // 书里一共 11 个任务（不算那个内部任务）
      assert.match(first.content, /^11 quests match for Steve\. This is page 1 of 3 \(quests 1-5\); pass page 2 for the next ones/)
      const second = await s.run('find_quests', { limit: 5, page: 2 })
      assert.match(second.content, /^11 quests match for Steve\. This is page 2 of 3 \(quests 6-10\); pass page 3 for the next ones/)
      const third = await s.run('find_quests', { limit: 5, page: 3 })
      assert.match(third.content, /^11 quests match for Steve\. This is page 3 of 3 \(quests 11-11\)\. /)
      const all = [...idsIn(first.content), ...idsIn(second.content), ...idsIn(third.content)]
      assert.deepEqual([idsIn(first.content).length, idsIn(second.content).length, idsIn(third.content).length], [5, 5, 1])
      assert.deepEqual([...all].sort(), ['1', '2', '43', '47', '4a', '50', '51', '52', '53', '54', NIGHT_WATCH].sort())
      // 没给词时按书里的顺序：石器时代那一章在最前面，一章里前置在前
      assert.deepEqual(all.slice(0, 4).sort(), ['1', '2', '54', NIGHT_WATCH].sort())
      assert.ok(all.indexOf('43') < all.indexOf('47'))

      const beyond = await s.run('find_quests', { limit: 5, page: 4 })
      assert.equal(beyond.isError, true)
      assert.match(beyond.content, /There is no page 4: 11 quest\(s\) match for Steve, which is 3 page\(s\) of 5\./)
    })

    it('get_quest：一个任务的全部内容——中文名和英文原名、章节、状态、前置（做完没）、每个子任务要什么、奖励、描述', async (t) => {
      const s = setup(t, packdata)
      const res = await s.run('get_quest', { id: ' 47 ' })
      assert.equal(res.isError, undefined, res.content)
      assert.deepEqual(res.content.split('\n'), [
        'Quest 47 "基础制作：马达" (Basic Crafting: Motors), chapter "第0.5阶 - 蒸汽时代". On the main line. State for Steve: locked (its requirements are not met yet).',
        'Requires these quests to be complete first:',
        '- 43 "导线，奇怪？": NOT done',
        'Tasks (what the quest asks for):',
        '- task 1: crafting, the player has to make it (craft or smelt): 2× gregtech:gt.metaitem.01/32600',
        '- task 2: optional_retrieval, optional, the items are kept: 2× gregtech:gt.metaitem.01/23032',
        'Rewards:',
        '- reward 1: item: 15× gregtech:gt.metaitem.01/32000',
        'Description:',
        '电动马达把电变成转动，以后要用很多。',
        '',
        '磁化铁杆要用红石。',
        '详见 https://wiki.gtnewhorizons.com',
      ])
      // 内容是本地的；向服务器问的是 Steve 做完了哪些，和这个任务对他的样子（子任务的进度、按钮；这个假服务器答不上，就不带）
      assert.deepEqual(s.game.calls, [
        { method: 'quest.progress', params: { player: 'Steve' } },
        { method: 'quest.get', params: { id: '47', player: 'Steve' } },
      ])
    })

    it('get_quest：猎杀、地点、流体、任选其一、要对上 NBT 的物品、可重复、经验和连带完成的奖励都说得清', async (t) => {
      const s = setup(t, packdata)
      const watch = (await s.run('get_quest', { id: NIGHT_WATCH })).content.split('\n')
      assert.equal(watch[0], `Quest ${NIGHT_WATCH} "守夜人" (Night Watch), chapter "第0阶 - 石器时代". State for Steve: available (unlocked, not complete yet).`)
      assert.deepEqual(watch.slice(1, 5), [
        'Tasks (what the quest asks for):',
        '- task 1: hunt: kill 10× Zombie',
        '- task 2: location: be in nether (dim -1) "THE NETHER"',
        '- task 3: fluid, the fluid is kept: 1000 mB water',
      ])

      const daily = (await s.run('get_quest', { id: '53' })).content.split('\n')
      assert.equal(daily[0], 'Quest 53 "每日面包" (Daily Bread), chapter "游历四方……". Repeatable: can be done again 1 h after it was completed. State for Steve: available (unlocked, not complete yet).')
      assert.deepEqual(daily.slice(1, 7), [
        'Tasks (any one of them completes the quest):',
        '- task 1: retrieval, the items are taken when handed in, any one of these is enough: 1× minecraft:bread, 1× minecraft:cookie',
        '- task 2: checkbox: nothing to bring: the player ticks it in the quest book',
        'Rewards:',
        '- reward 1: xp: 3 level(s)',
        '- reward 2: questcompletion: also completes quest 60 "触发器：跳过"',
      ])

      const first = (await s.run('get_quest', { id: '1' })).content
      assert.match(first, /^- task 1: retrieval, the items are kept: 4× minecraft:log \(any meta\) \(or any logWood\)$/m)
      assert.match(first, /State for Steve: complete\./)
      const bee = (await s.run('get_quest', { id: '54' })).content
      assert.match(bee, /^- task 1: retrieval, the items are kept: 1× Forestry:beePrincessGE with NBT \{"Genome":\{"Chromosomes":\[\{"UID0":"forestry\.speciesForest"/m)
      const choice = (await s.run('get_quest', { id: '2' })).content
      // 挑一样的奖励：选项编号，quest_book claim 的 choice 就是它
      assert.match(choice, /^- reward 1: choice \(the player picks one\): option 1: 8× minecraft:bread, option 2: 16× minecraft:torch$/m)
    })

    it('get_quest：前置之间是“任意一个”“恰好一个”的，和前置指向不存在的任务的，状态各算各的', async (t) => {
      const s = setup(t, packdata)
      const either = (await s.run('get_quest', { id: '50' })).content.split('\n')
      assert.match(either[0]!, /State for Steve: available/)
      assert.deepEqual(either.slice(1, 4), ['Requires any one of these quests to be complete first:', '- 2 "趁手的工具": done', '- 47 "基础制作：马达": NOT done'])
      const exactlyOne = (await s.run('get_quest', { id: '51' })).content.split('\n')
      assert.match(exactlyOne[0]!, /State for Steve: locked/)
      assert.deepEqual(exactlyOne.slice(1, 4), ['Requires exactly one of these quests to be complete (no more than one):', '- 1 "万事开头难": done', '- 2 "趁手的工具": done'])
      const dangling = (await s.run('get_quest', { id: '52' })).content.split('\n')
      assert.match(dangling[0]!, /^Quest 52 "Tools of the Trade 4 - Rubber Boots", chapter "第0\.5阶 - 蒸汽时代"\. State for Steve: locked/)
      assert.equal(dangling[2], '- 99 (not in the quest book, so it can never be complete)')
      // 内部任务按 id 还是查得到，并写明它不在书里
      assert.match((await s.run('get_quest', { id: '60' })).content, /^Quest 60 "触发器：跳过" \(Trigger: Skip\), in no chapter \(an internal quest the book never shows\)\./)

      const missing = await s.run('get_quest', { id: '7777' })
      assert.equal(missing.isError, true)
      assert.match(missing.content, /There is no quest with id 7777 in the quest book/)
    })

    it('物品表（items.jsonl）在的时候，任务要的和奖励的物品带上中文名；表里没有的物品只有 id', async (t) => {
      const tmp = tmpDir()
      t.after(tmp.cleanup)
      fs.cpSync(made.packdata, tmp.dir, { recursive: true })
      fs.writeFileSync(
        path.join(tmp.dir, 'items.jsonl'),
        [
          { id: 'gregtech:gt.metaitem.01', meta: 32600, name: '电动马达（LV）', en: 'Electric Motor (LV)' },
          { id: 'gregtech:gt.metaitem.01', meta: 32000, name: '铜币', en: 'Copper Coin', ores: ['coinCopper'] },
          { id: 'minecraft:log', meta: 0, name: '橡木' },
        ]
          .map((i) => `${JSON.stringify(i)}\n`)
          .join(''),
      )
      const said: string[] = []
      const withItems = loadPackData(tmp.dir, (m) => said.push(m))
      assert.match(said.join('\n'), /物品表：3 种物品/)
      const s = setup(t, withItems)
      const motors = (await s.run('get_quest', { id: '47' })).content
      assert.match(motors, /^- task 1: crafting, the player has to make it \(craft or smelt\): 2× gregtech:gt\.metaitem\.01\/32600 "电动马达（LV）"$/m)
      assert.match(motors, /^- task 2: optional_retrieval, optional, the items are kept: 2× gregtech:gt\.metaitem\.01\/23032$/m)
      assert.match(motors, /^- reward 1: item: 15× gregtech:gt\.metaitem\.01\/32000 "铜币"$/m)
      // 任何变体都行的，拿 meta 0 的那个叫名字
      assert.match((await s.run('get_quest', { id: '1' })).content, /4× minecraft:log \(any meta\) "橡木" \(or any logWood\)/)
    })

    it('看谁的进度：默认看主人的，点名就看那个人的；没有人可看时不问服务器，结果不带状态', async (t) => {
      const s = setup(t, packdata)
      s.game.handlers['quest.progress'] = (p) => ({ player: p.player, completed: p.player === 'Alex' ? ['1', '2', '43'] : ['1'] })
      assert.match((await s.run('get_quest', { id: '47' })).content, /State for Steve: locked/)
      assert.match((await s.run('get_quest', { id: '47', player: 'Alex' })).content, /State for Alex: available/)
      assert.deepEqual(s.game.callsOf('quest.progress'), [{ player: 'Steve' }, { player: 'Alex' }])

      s.who.defaultPlayer = undefined
      const calls = s.game.calls.length
      const lines = await s.run('list_quest_lines')
      assert.match(lines.content, /no player given, so no progress/)
      assert.match(lines.content, /^- 第0阶 - 石器时代 \(Tier 0 - Stone Age\): 4$/m)
      const found = await s.run('find_quests', { query: '马达' })
      // 不知道看谁的进度：要亲手按的照内容全标
      assert.deepEqual(found.content.split('\n').slice(1), ['- 47 "基础制作：马达" [第0.5阶 - 蒸汽时代] (main)', '- 53 "每日面包" [游历四方……] {hand in, tick}'])
      const byState = await s.run('find_quests', { state: 'available' })
      assert.equal(byState.isError, true)
      assert.match(byState.content, /needs a player whose progress to look at: give "player"/)
      assert.equal(s.game.calls.length, calls)
    })

    it('进度留一小会儿：紧接着的几次查询只问服务器一次，过了时限再问', async (t) => {
      const s = setup(t, packdata)
      let completed = ['1', '2']
      s.game.handlers['quest.progress'] = (p) => ({ player: p.player, completed })
      assert.match((await s.run('get_quest', { id: '43' })).content, /State for Steve: available/)
      // 主人刚把 43 交了
      completed = ['1', '2', '43']
      s.clock.now += 5_000
      await s.run('find_quests', { state: 'available' })
      assert.equal(s.game.callsOf('quest.progress').length, 1)
      s.clock.now += 60_000
      assert.match((await s.run('get_quest', { id: '43' })).content, /State for Steve: complete/)
      assert.equal(s.game.callsOf('quest.progress').length, 2)
    })

    it('奖励没领的任务：详情和搜索结果里写明，可以单独列出来，列章节时提醒一共几个', async (t) => {
      const s = setup(t, packdata)
      // 1、2 都做完了；2 的奖励还没领
      s.game.handlers['quest.progress'] = (p) => ({ player: p.player, completed: ['1', '2'], unclaimed: ['2'] })
      assert.match((await s.run('get_quest', { id: '2' })).content, /State for Steve: complete, reward unclaimed \(done; the reward has not been collected\)\./)
      assert.match((await s.run('get_quest', { id: '1' })).content, /State for Steve: complete\./)
      const done = (await s.run('find_quests', { state: 'complete' })).content
      assert.match(done, /^- 1 "万事开头难" \[第0阶 - 石器时代\] \(main\): complete$/m)
      // 奖励是挑一样的、还没领：标着 pick one；领过了的、做完的不再标
      assert.match(done, /^- 2 "趁手的工具" \[第0阶 - 石器时代\]: complete, reward unclaimed \{pick one\}$/m)
      assert.deepEqual(idsIn((await s.run('find_quests', { state: 'unclaimed' })).content), ['2'])
      assert.match((await s.run('list_quest_lines')).content, /^1 finished quest\(s\) still have a reward Steve has not collected: find_quests with state "unclaimed" lists them\.$/m)
    })

    it('服务器从没见过这个玩家（known:false）：任务内容照样给，不带进度并说明；按状态筛做不了', async (t) => {
      const s = setup(t, packdata)
      s.who.defaultPlayer = 'Ghost'
      s.game.handlers['quest.progress'] = (p) => ({ player: p.player, completed: [], known: false })
      const res = await s.run('get_quest', { id: '47' })
      assert.equal(res.isError, undefined, res.content)
      assert.match(res.content, /^Quest 47 "基础制作：马达" \(Basic Crafting: Motors\), chapter "第0\.5阶 - 蒸汽时代"\. On the main line\.$/m)
      assert.match(res.content, /^- 43 "导线，奇怪？"$/m)
      assert.match(res.content, /Note: the game server has never seen a player named Ghost, so no progress is shown\./)
      const byState = await s.run('find_quests', { state: 'available' })
      assert.equal(byState.isError, true)
      assert.match(byState.content, /Cannot filter by state: the game server has never seen a player named Ghost\./)
    })

    it('问不到进度（没连上游戏、mod 太旧）：任务书的内容照样查得到，写明为什么没有进度', async (t) => {
      const s = setup(t, packdata)
      s.game.connected = false
      const offline = await s.run('find_quests', { query: '马达' })
      assert.equal(offline.isError, undefined, offline.content)
      assert.deepEqual(idsIn(offline.content), ['47', '53'])
      assert.match(offline.content, /Note: the game server could not be asked who completed what \(disconnected: [^)]+\), so no progress is shown\. What the quests say is still right\./)

      s.game.connected = true
      s.game.handlers['quest.progress'] = () => {
        throw new BridgeError('unknown_method', 'unknown method: quest.progress')
      }
      const old = await s.run('list_quest_lines')
      assert.equal(old.isError, undefined, old.content)
      assert.match(old.content, /^- 第0阶 - 石器时代 \(Tier 0 - Stone Age\): 4$/m)
      assert.match(old.content, /Note: the game server's mod is too old to report quest progress, so no progress is shown\./)
    })
  })
})
