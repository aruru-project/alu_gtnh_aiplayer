// 任务书的按钮：意见簿 f23 那件事——主人让它“打开自己的任务书看看能不能操作”，它拿着任务书 open_screen 什么也没打开，
// press_key 里也没有任务书的键，于是交不了要收走东西的子任务、打不了勾、领不了奖。任务书的界面只在游戏客户端里画，
// 服务器上没有；身体替它做客户端那一半（quest.submit / check / choose / claim），大脑给干活线一个 quest_book。
// 入口是模型用的工具（quest_book、get_quest、find_quests、open_screen、press_key）；游戏是按方法名应答的假服务器，
// 应答的样子取自测试服上真的身体（木棍与石头交掉 2 个原木、子任务进度 [9,5] [2]、3 秒内任务书标成完成……）。
// 编号的口径：模型看到的 task N、option N 从 1 数，是 get_quest 列出来的第 N 个；身体收到的是从 0 数的“第几个”
// （quest.get 的顺序，也就是任务书自己的顺序），任务书里存的编号不一定连着（a6b 的两个子任务存的是 1、2），那由身体去换。

import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import { loadPackData } from '../src/packdata/index.ts'
import type { PackData } from '../src/packdata/index.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { ALL_TOOLS, QuestProgressCache, runTool } from '../src/tools/index.ts'
import type { ToolContext, ToolResult } from '../src/tools/index.ts'
import { questSettle } from '../src/tools/quest-actions.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { buildFixturePackdata, pythonMissing } from './fixture-pack.ts'
import { tmpDir, waitFor } from './helpers.ts'
import { MockBridge } from './mock-bridge.ts'

const NOW = 1_800_000_000_000
const BOOK = 'questbook:ItemQuestBook'
const CLIENT_ONLY = {
  screen: 'the quest book (BetterQuesting)',
  item: { id: BOOK },
  key: 'key.betterquesting.quests',
  keyName: 'Open Quests',
  instead: ['quest.submit', 'quest.check', 'quest.choose', 'quest.claim'],
}

describe('任务书的按钮（本地有任务书资料）', { skip: pythonMissing() }, () => {
  let packdata: PackData
  const shared = tmpDir('aiplayer-questbook-')
  after(shared.cleanup)
  before(() => {
    packdata = loadPackData(buildFixturePackdata(shared.dir).packdata)
  })
  const settle = { ...questSettle }
  after(() => Object.assign(questSettle, settle))

  /** 干活线的工具上下文；bot 叫 Alu，默认看的是主人 Steve 的进度。 */
  function setup(t: { after(fn: () => void): void }) {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const game = new FakeGame()
    const clock = { now: NOW }
    const bridge = new BridgeApi(game)
    const ctx: ToolContext = {
      botName: 'Alu',
      bridge,
      memory: new MemoryStore(tmp.dir, () => 300),
      manuals: new ManualStore(DEFAULT_MANUALS_DIR, path.join(tmp.dir, 'manuals')),
      packdata,
      questProgress: new QuestProgressCache(bridge, () => clock.now),
      defaultPlayer: () => 'Steve',
      reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
      hooks: {},
      now: () => clock.now,
    }
    game.handlers['quest.progress'] = (p) => ({ player: p.player, completed: ['1', '2'], unclaimed: p.player === 'Alu' ? ['2'] : [] })
    const run = (name: string, input: unknown = {}): Promise<ToolResult> => runTool(ALL_TOOLS, ctx, name, input)
    questSettle.ms = 400
    questSettle.pollMs = 50
    return { game, clock, run }
  }

  it('打勾：不给 task 时按它唯一的勾选框；模型说的 task 2 是第 2 个子任务，身体收到的是从 0 数的 1；等到任务书标完成再报', async (t) => {
    const s = setup(t)
    s.game.handlers['quest.check'] = () => ({
      pressed: true,
      quest: { id: '53', name: 'Daily Bread', state: 'available' },
      tasks: [
        { task: 0, type: 'retrieval', complete: false, progress: [0, 0] },
        { task: 1, type: 'checkbox', complete: true, was: false },
      ],
      tasksDone: true,
      freeSlots: 30,
    })
    let asked = 0
    s.game.handlers['quest.get'] = () => ({ id: '53', name: 'Daily Bread', state: ++asked >= 2 ? 'complete, reward unclaimed' : 'available' })
    const res = await s.run('quest_book', { id: '53', action: 'tick' })
    assert.equal(res.isError, undefined, res.content)
    assert.deepEqual(s.game.callsOf('quest.check'), [{ bot: 'Alu', id: '53', task: 1 }])
    const lines = res.content.split('\n')
    assert.equal(lines[0], 'Ticked task 2 on quest 53 "每日面包", for yourself.')
    assert.deepEqual(lines.slice(1, 4), ['Its tasks now:', '- task 1 (retrieval): not done; 0/1, 0/1', '- task 2 (checkbox): done (was not done)'])
    assert.match(lines[4]!, /^Its tasks are all done; the quest book marked the quest complete, reward unclaimed \d\.\d s later\.$/)
    assert.deepEqual(s.game.callsOf('quest.get'), [
      { id: '53', player: 'Alu' },
      { id: '53', player: 'Alu' },
    ])

    // 点名第 2 个也一样；点名的不是勾选框、或者没有这一个：不发给身体，照实说
    await s.run('quest_book', { id: '53', action: 'tick', task: 2 })
    assert.deepEqual(s.game.callsOf('quest.check')[1], { bot: 'Alu', id: '53', task: 1 })
    const wrong = await s.run('quest_book', { id: '53', action: 'tick', task: 1 })
    assert.deepEqual([wrong.isError, wrong.content], [true, 'Task 1 of quest 53 is a retrieval task, not a checkbox; its checkbox is task 2.'])
    const beyond = await s.run('quest_book', { id: '53', action: 'tick', task: 3 })
    assert.deepEqual([beyond.isError, beyond.content], [true, 'Quest 53 has 2 task(s); there is no task 3.'])
    const none = await s.run('quest_book', { id: '43', action: 'tick' })
    assert.deepEqual([none.isError, none.content], [true, 'Quest 43 has no checkbox task (its tasks: 1 retrieval).'])
    assert.equal(s.game.callsOf('quest.check').length, 2)
  })

  it('勾一个还锁着的任务：照收（真玩家在查看模式下也点得了），结果写明勾留着、解锁后算；不等任务书标完成', async (t) => {
    const s = setup(t)
    s.game.handlers['quest.check'] = () => ({
      pressed: true,
      quest: { id: '50', name: 'All Roads', state: 'locked' },
      tasks: [{ task: 0, type: 'checkbox', complete: true, was: false }],
      note: 'the quest is locked: the tick is kept and counts once the quest unlocks; it needs 47 "Basic Crafting: Motors" (requirement logic OR)',
      freeSlots: 30,
    })
    const res = await s.run('quest_book', { id: '50', action: 'tick' })
    assert.match(res.content, /^- task 1 \(checkbox\): done \(was not done\)$/m)
    assert.match(res.content, /^Its state for you: locked\.$/m)
    assert.match(res.content, /^Note: the quest is locked: the tick is kept and counts once the quest unlocks; it needs 47 "Basic Crafting: Motors" \(requirement logic OR\)\.$/m)
    assert.equal(s.game.callsOf('quest.get').length, 0)
  })

  it('提交：交掉了什么、每个子任务的数（对着要几个，前后都有）；任务书没在等的时间里标完成就照实说，不猜', async (t) => {
    const s = setup(t)
    // 测试服上真的身体交“木棍与石头”时的样子，换成这里的 43（要收走 4 根锡导线）
    s.game.handlers['quest.submit'] = () => ({
      pressed: true,
      quest: { id: '43', name: 'Wired, Weird?!', state: 'available' },
      tasks: [{ task: 0, type: 'retrieval', complete: true, was: false, progress: [4], progressWas: [1] }],
      tasksDone: true,
      lost: [{ id: 'gregtech:gt.blockmachines', meta: 1246, name: '1x Tin Cable', count: 3 }],
      freeSlots: 31,
    })
    s.game.handlers['quest.get'] = () => ({ id: '43', name: 'Wired, Weird?!', state: 'available' })
    const res = await s.run('quest_book', { id: '43', action: 'submit' })
    assert.deepEqual(s.game.callsOf('quest.submit'), [{ bot: 'Alu', id: '43' }])
    assert.deepEqual(res.content.split('\n'), [
      'Pressed Detect/Submit on quest 43 "导线，奇怪？", for yourself.',
      'Handed in (taken from your inventory): 3× gregtech:gt.blockmachines/1246 "1x Tin Cable".',
      'Its tasks now:',
      '- task 1 (retrieval): done (was not done); 4/4 (was 1/4)',
      'Its tasks are all done, but the quest book had not marked the quest complete within 0.4 s (it checks each player every 3 s): state for you still available. get_quest shows it once it has.',
    ])
    assert.ok(s.game.callsOf('quest.get').length >= 2, 'it looked again while waiting')
  })

  it('提交了却什么都没变（身上没有它要的）：照实说没交掉东西、子任务没动，怎么看还差什么；还锁着的任务说清卡在哪个前置', async (t) => {
    const s = setup(t)
    s.game.handlers['quest.submit'] = (p) =>
      p.id === '47'
        ? {
            pressed: true,
            quest: { id: '47', name: 'Basic Crafting: Motors', state: 'locked' },
            tasks: [
              { task: 0, type: 'crafting', complete: false, progress: [0] },
              { task: 1, type: 'optional_retrieval', complete: false, progress: [0] },
            ],
            note: 'the quest is locked: the quest book takes a submission only for an unlocked quest, so nothing was looked at; it needs 43 "Wired, Weird?!" (requirement logic AND)',
            freeSlots: 30,
          }
        : { pressed: true, quest: { id: '43', name: 'Wired, Weird?!', state: 'available' }, tasks: [{ task: 0, type: 'retrieval', complete: false, progress: [0] }], freeSlots: 30 }
    const nothing = await s.run('quest_book', { id: '43', action: 'submit' })
    assert.match(nothing.content, /^- task 1 \(retrieval\): not done; 0\/4$/m)
    assert.match(nothing.content, /^Nothing changed: nothing was taken from or given to you, and no task moved\. get_quest with your own name as "player" shows what each task still needs\.$/m)
    const locked = await s.run('quest_book', { id: '47', action: 'submit' })
    assert.match(locked.content, /^Note: the quest is locked: the quest book takes a submission only for an unlocked quest, so nothing was looked at; it needs 43 "Wired, Weird\?!" \(requirement logic AND\)\.$/m)
  })

  it('领奖：挑一样的奖励给 choice，option 2 是第 2 样——身体收到 reward 0、choice 1，再按领取；拿到的照实写，背包放不下的掉在脚边', async (t) => {
    const s = setup(t)
    s.game.handlers['quest.choose'] = () => ({
      pressed: true,
      quest: { id: '2', name: 'Tools of the Trade', state: 'complete, reward unclaimed' },
      chosen: { reward: 0, choice: 1, item: { id: 'minecraft:torch', meta: 0, count: 16, name: 'Torch' } },
      note: 'the server keeps a choice in memory only, not in the save: if it restarts before the reward is claimed, the choice has to be made again',
      freeSlots: 0,
    })
    s.game.handlers['quest.claim'] = () => ({
      pressed: true,
      quest: { id: '2', name: 'Tools of the Trade', state: 'complete', was: 'complete, reward unclaimed' },
      dropped: [{ id: 'minecraft:torch', meta: 0, count: 16, name: 'Torch' }],
      freeSlots: 0,
    })
    const res = await s.run('quest_book', { id: '2', action: 'claim', choice: 2 })
    assert.deepEqual(s.game.callsOf('quest.choose'), [{ bot: 'Alu', id: '2', reward: 0, choice: 1 }])
    assert.deepEqual(s.game.callsOf('quest.claim'), [{ bot: 'Alu', id: '2' }])
    assert.deepEqual(res.content.split('\n'), [
      'Picked option 2 of reward 1 (16× minecraft:torch "Torch"). The server keeps a choice in memory only, not in the save: if it restarts before the reward is claimed, the choice has to be made again.',
      'Pressed Claim on quest 2 "趁手的工具", for yourself.',
      'Dropped at your feet (it did not fit in your inventory): 16× minecraft:torch "Torch".',
      'Its state for you: complete (was complete, reward unclaimed).',
    ])
    const tooMany = await s.run('quest_book', { id: '2', action: 'claim', choice: 3 })
    assert.deepEqual([tooMany.isError, tooMany.content], [true, 'Reward 1 of quest 2 has 2 option(s); there is no option 3.'])
    const noPick = await s.run('quest_book', { id: '43', action: 'claim', choice: 1 })
    assert.deepEqual([noPick.isError, noPick.content], [true, 'Quest 43 has no reward to pick from; claim it without "choice".'])
    assert.equal(s.game.callsOf('quest.choose').length, 1)
  })

  it('领取按钮是灰的：说为什么、任务对它的状态；挑一样的还没挑时，把选项按 option 1、2 列出来', async (t) => {
    const s = setup(t)
    s.game.handlers['quest.claim'] = () => ({
      pressed: false,
      button: 'Claim',
      why: "a reward is one to pick from and nothing is picked yet (choices lists it): pick one first; a pick is kept in the server's memory only, so a restart forgets it",
      quest: { id: '2', name: 'Tools of the Trade', state: 'complete, reward unclaimed' },
      choices: [
        {
          reward: 0,
          items: [
            { id: 'minecraft:bread', meta: 0, count: 8, name: 'Bread' },
            { id: 'minecraft:torch', meta: 0, count: 16, name: 'Torch' },
          ],
        },
      ],
    })
    const res = await s.run('quest_book', { id: '2', action: 'claim' })
    assert.deepEqual(res.content.split('\n'), [
      "Not pressed: the Claim button of quest 2 \"趁手的工具\" is greyed out in your quest book: a reward is one to pick from and nothing is picked yet (choices lists it): pick one first; a pick is kept in the server's memory only, so a restart forgets it. Its state for you: complete, reward unclaimed.",
      'Reward 1 is one to pick: option 1: 8× minecraft:bread "Bread", option 2: 16× minecraft:torch "Torch". quest_book claim with "choice" picks one and claims.',
    ])
  })

  it('在队伍里：结果里写明打勾、交东西算全队，奖励各领各的', async (t) => {
    const s = setup(t)
    s.game.handlers['quest.check'] = () => ({
      pressed: true,
      quest: { id: '50', name: 'All Roads', state: 'available' },
      tasks: [{ task: 0, type: 'checkbox', complete: true, was: false }],
      party: { name: 'Base', members: ['Alu', 'Steve'], claimForAll: false },
    })
    const res = await s.run('quest_book', { id: '50', action: 'tick' })
    assert.match(res.content, /^Alu is in the quest book party "Base" with Steve: a tick or a hand-in counts for the whole party; each member claims rewards for themselves\.$/m)
  })

  it('有任务在跑、身体太旧、任务 id 不对：不按，照实说', async (t) => {
    const s = setup(t)
    s.game.handlers['quest.submit'] = (p) => {
      if (p.id === '43') throw new BridgeError('busy', 'a task is running; the quest book is for when the bot is idle')
      throw new BridgeError('not_found', `there is no quest with id ${String(p.id)}`)
    }
    const busy = await s.run('quest_book', { id: '43', action: 'submit' })
    assert.deepEqual([busy.isError, busy.content], [true, 'A task of yours is running: the quest book is used while you have no task. Wait for it to end (or cancel_task), then press it.'])
    const missing = await s.run('quest_book', { id: '7777', action: 'submit' })
    assert.deepEqual([missing.isError, missing.content], [true, 'Not pressed: there is no quest with id 7777. find_quests gives the ids; get_quest numbers the tasks and the options.'])
    delete s.game.handlers['quest.submit']
    const old = await s.run('quest_book', { id: '43', action: 'submit' })
    assert.deepEqual([old.isError, old.content], [true, "The body on the game server is older than the quest book's buttons: it cannot press them."])
  })

  it('按过以后，它自己的进度马上重新问（不用留着的旧进度）', async (t) => {
    const s = setup(t)
    s.game.handlers['quest.claim'] = () => ({ pressed: true, quest: { id: '1', name: 'The Beginning', state: 'complete', was: 'complete, reward unclaimed' } })
    await s.run('find_quests', { state: 'unclaimed', player: 'Alu' })
    await s.run('find_quests', { state: 'unclaimed', player: 'Alu' })
    assert.equal(s.game.callsOf('quest.progress').length, 1)
    await s.run('quest_book', { id: '1', action: 'claim' })
    await s.run('find_quests', { state: 'unclaimed', player: 'Alu' })
    assert.equal(s.game.callsOf('quest.progress').length, 2)
  })

  it('get_quest 看它自己的：子任务编号、每个做完没和数到几个、挑一样的选了哪个、两个按钮现在能不能按（quest_book 替它按）', async (t) => {
    const s = setup(t)
    s.game.handlers['quest.get'] = (p) =>
      p.id === '53'
        ? {
            id: '53',
            name: 'Daily Bread',
            state: 'available',
            buttons: { submit: true, claim: false },
            tasks: [
              { type: 'retrieval', complete: false, progress: [0, 0], consumed: true },
              { type: 'checkbox', complete: true },
            ],
            rewards: [{ type: 'xp' }, { type: 'questcompletion' }],
          }
        : {
            id: '2',
            name: 'Tools of the Trade',
            state: 'complete, reward unclaimed',
            buttons: { submit: false, claim: true },
            tasks: [{ type: 'crafting', complete: true, progress: [1] }],
            rewards: [{ type: 'choice', chosen: 1, items: [] }],
          }
    const daily = (await s.run('get_quest', { id: '53', player: 'Alu' })).content.split('\n')
    assert.equal(daily[1], "The quest's buttons in Alu's quest book now: Detect/Submit can be pressed, Claim is greyed out (quest_book presses them for you).")
    assert.deepEqual(daily.slice(2, 5), [
      'Tasks (any one of them completes the quest):',
      '- task 1: retrieval, the items are taken when handed in, any one of these is enough: 1× minecraft:bread, 1× minecraft:cookie [not done; so far 0/1, 0/1]',
      '- task 2: checkbox: nothing to bring: the player ticks it in the quest book [done]',
    ])
    const tools = (await s.run('get_quest', { id: '2', player: 'Alu' })).content
    assert.match(tools, /^- reward 1: choice \(the player picks one\): option 1: 8× minecraft:bread, option 2: 16× minecraft:torch; chosen now: option 2$/m)
    // 看主人的：按钮那一行不说 quest_book（那是它自己的按钮）
    const steve = (await s.run('get_quest', { id: '53' })).content
    assert.match(steve, /^The quest's buttons in Steve's quest book now: Detect\/Submit can be pressed, Claim is greyed out\.$/m)
  })

  it('拿着任务书 open_screen：照实说这个界面只在客户端里画、服务器上没有，不空等；它的按钮用 quest_book；press_key 的列表里也这样说', async (t) => {
    const s = setup(t)
    s.game.handlers['screen.open'] = () => ({ open: false, clientOnly: { screen: CLIENT_ONLY.screen, instead: CLIENT_ONLY.instead, text: 'the quest book (BetterQuesting) is a screen drawn only by a game client' } })
    s.game.handlers['screen.look'] = () => ({ open: false })
    const res = await s.run('open_screen', { item: { id: BOOK } })
    assert.equal(
      res.content,
      'No screen opened, and none will: the quest book (BetterQuesting) is a screen drawn only by the game client, and the game server has no such screen to open. Instead, quest_book does what its buttons do (submit: Detect/Submit, tick: a checkbox, claim: Claim, with "choice" for a reward to pick); get_quest and find_quests show what is in it and your progress (give your own name as "player").',
    )
    assert.equal(s.game.callsOf('screen.look').length, 0, 'nothing will appear, so it does not wait for one')

    s.game.handlers['bot.keys'] = () => ({ keys: [], clientOnly: [CLIENT_ONLY] })
    const keys = await s.run('press_key')
    assert.deepEqual(keys.content.split('\n'), [
      'No mod on this server adds a key the body can press.',
      'Keys of a game client that only open a screen the server does not have:',
      '- key.betterquesting.quests "Open Quests": only opens the quest book (BetterQuesting) in a game client; there is nothing to press here. Instead, quest_book does what its buttons do (submit: Detect/Submit, tick: a checkbox, claim: Claim, with "choice" for a reward to pick); get_quest and find_quests show what is in it and your progress (give your own name as "player").',
    ])
  })
})

describe('模拟身体（npm run mock-bridge、面板开发用的）', () => {
  it('照协议应答任务书的四个按钮、只在客户端里的界面：交东西收走背包里的、打勾、挑一样、领奖进背包；按钮灰的 pressed:false；有任务在跑 busy', async (t) => {
    const bridge = new MockBridge({ bots: ['Alu'] })
    await bridge.start()
    const client = new BridgeClient({
      address: () => ({ host: '127.0.0.1', port: bridge.port }),
      token: () => bridge.token,
      clientName: 'brain/test',
      requestTimeoutMs: 2000,
      reconnectMinMs: 20,
      reconnectMaxMs: 100,
      resume: { load: () => undefined, save: () => {} },
    })
    client.start()
    t.after(async () => {
      client.stop()
      await bridge.stop()
    })
    await waitFor('connected', () => client.isConnected())
    const api = new BridgeApi(client)
    assert.deepEqual((await api.botKeys()).clientOnly, [CLIENT_ONLY])
    const alu = bridge.bots.get('Alu')!
    alu.inventory.push({ slot: 20, id: BOOK, meta: 0, count: 1, name: 'Quest Book' })
    assert.equal((await api.screenOpen('Alu', { item: { id: BOOK } })).clientOnly?.screen, CLIENT_ONLY.screen)

    // 假任务书：2 要 1 先做完、奖励挑一样；43 要 2 先做完、收走 4 根锡导线
    bridge.questProgress.set('alu', { complete: new Set(['1']), claimed: new Set() })
    alu.inventory.push({ slot: 21, id: 'gregtech:gt.blockmachines', meta: 1246, count: 6, name: '1x Tin Cable' })
    const locked = await api.questSubmit('Alu', '43')
    assert.match(locked.note ?? '', /the quest is locked/)
    bridge.questProgress.get('alu')!.complete.add('2')
    const submitted = await api.questSubmit('Alu', '43')
    assert.deepEqual([submitted.lost, submitted.tasksDone, submitted.tasks?.[0]?.progress], [[{ id: 'gregtech:gt.blockmachines', meta: 1246, name: '1x Tin Cable', count: 4 }], true, [4]])
    assert.equal(alu.inventory.find((i) => i.meta === 1246)?.count, 2)
    assert.equal((await api.questGet('43', 'Alu')).state, 'complete, reward unclaimed')

    const grey = await api.questClaim('Alu', '2')
    assert.deepEqual([grey.pressed, grey.choices?.[0]?.reward], [false, 0])
    const chosen = await api.questChoose('Alu', '2', 0, 1)
    assert.equal(chosen.chosen?.choice, 1)
    const claimed = await api.questClaim('Alu', '2')
    assert.deepEqual([claimed.pressed, claimed.gained, claimed.quest.state], [true, [{ id: 'minecraft:torch', meta: 0, name: 'Torch', count: 16 }], 'complete'])
    assert.equal((await api.questClaim('Alu', '2')).why, 'the reward has already been claimed')
    await assert.rejects(api.questCheck('Alu', '43', 0), (e: unknown) => e instanceof BridgeError && e.code === 'bad_request')

    await api.taskStart('Alu', { type: 'wait', ticks: 40 })
    await assert.rejects(api.questSubmit('Alu', '1'), (e: unknown) => e instanceof BridgeError && e.code === 'busy')
  })
})
