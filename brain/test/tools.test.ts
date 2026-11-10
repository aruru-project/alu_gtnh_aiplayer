import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { ALL_TOOLS, runTool } from '../src/tools/index.ts'
import type { ToolContext, ToolResult } from '../src/tools/index.ts'
import { FakeGame } from './agent-harness.ts'
import { tmpDir } from './helpers.ts'

const NOW = 1_800_000_000_000

function setup(t: { after(fn: () => void): void }) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  const game = new FakeGame()
  const memory = new MemoryStore(tmp.dir, () => 300)
  const reminders: { dueAt: number; note: string }[] = []
  const spoke: { kind: string; to?: string; text: string }[] = []
  const started: string[] = []
  /** 每一次“会取消任务的请求”结束时身体报告的被取消的 id。 */
  const cancels: string[][] = []
  let cancelsOpen = 0
  let commandsOpen = 0
  const ctx: ToolContext = {
    botName: 'Alu',
    bridge: new BridgeApi(game),
    memory,
    reminders: {
      add: (dueAt, note) => {
        reminders.push({ dueAt, note })
        return { id: 'r1', dueAt }
      },
    },
    hooks: {
      spoke: (info) => spoke.push(info),
      taskStarted: (task) => started.push(task.id),
      cancelStart: () => cancelsOpen++,
      cancelEnd: (ids) => {
        cancelsOpen--
        cancels.push([...ids])
      },
      commandStart: () => commandsOpen++,
      commandEnd: () => commandsOpen--,
    },
    now: () => NOW,
  }
  const run = (name: string, input: unknown = {}, max?: number): Promise<ToolResult> =>
    runTool(ALL_TOOLS, ctx, name, input, max === undefined ? {} : { maxResultChars: max })
  return { game, memory, reminders, spoke, started, cancels, open: () => ({ cancels: cancelsOpen, commands: commandsOpen }), run }
}

describe('工具清单', () => {
  it('规格里列出的第一版工具都在，名字不重复，参数 schema 都是对象', () => {
    const expected = [
      'say', 'whisper', 'get_status', 'look_around', 'scan_area', 'inspect_block', 'probe_block', 'find_blocks', 'list_containers',
      'get_player_position', 'go_to', 'go_to_player', 'follow_player', 'go_home', 'set_home', 'list_homes', 'join_team',
      'flatten_area', 'clear_area', 'fill_area', 'dig_blocks', 'place_blocks',
      'deposit_items', 'withdraw_items', 'haul_items', 'collect_items', 'give_items',
      'task_status', 'cancel_task', 'remember', 'forget', 'set_reminder',
    ]
    const names = ALL_TOOLS.map((x) => x.name)
    assert.deepEqual([...names].sort(), [...expected].sort())
    assert.equal(new Set(names).size, names.length)
    for (const tool of ALL_TOOLS) {
      assert.equal(tool.inputSchema.type, 'object', tool.name)
      assert.ok(tool.description.length > 10 && /^[\x20-\x7e×≤–—“”’]+$/.test(tool.description), `${tool.name} description should be English`)
    }
  })

  it('所有启动任务的工具都带 queue 参数', () => {
    const taskTools = [
      'go_to', 'go_to_player', 'follow_player', 'go_home', 'flatten_area', 'clear_area', 'fill_area', 'dig_blocks',
      'place_blocks', 'deposit_items', 'withdraw_items', 'haul_items', 'collect_items', 'give_items',
    ]
    for (const name of taskTools) {
      const tool = ALL_TOOLS.find((x) => x.name === name)!
      assert.equal(tool.inputSchema.properties.queue?.type, 'boolean', name)
    }
  })
})

describe('说话', () => {
  it('say 把换行压成一行；以 / 开头的内容不会被当成指令发出去', async (t) => {
    const s = setup(t)
    await s.run('say', { message: '第一行\n第二行' })
    await s.run('say', { message: '/op Steve' })
    assert.deepEqual(s.game.said, ['第一行 第二行', 'op Steve'])
    assert.deepEqual(s.spoke.map((x) => x.kind), ['say', 'say'])
  })

  it('whisper 用 tell 指令私聊指定玩家；名字不合法时不执行任何指令', async (t) => {
    const s = setup(t)
    s.game.handlers['bot.command'] = (p) => ({ output: [`You whisper to Steve: ${String(p.command).slice('tell Steve '.length)}`] })
    const ok = await s.run('whisper', { player: 'Steve', message: '东西放你箱子里了' })
    assert.deepEqual(ok, { content: 'Whisper sent.' })
    assert.deepEqual(s.game.callsOf('bot.command'), [{ bot: 'Alu', command: 'tell Steve 东西放你箱子里了' }])
    assert.deepEqual(s.spoke, [{ kind: 'whisper', to: 'Steve', text: '东西放你箱子里了' }])
    const bad = await s.run('whisper', { player: 'Steve op', message: 'x' })
    assert.equal(bad.isError, true)
    assert.equal(s.game.callsOf('bot.command').length, 1)
    assert.deepEqual(s.open(), { cancels: 0, commands: 0 })
  })

  it('长的私聊拆成几条 tell，每条指令都不超过身体允许的 99 个字符', async (t) => {
    const s = setup(t)
    s.game.handlers['bot.command'] = () => ({ output: [] })
    const long = '这是一段很长的悄悄话，'.repeat(15) // 165 个字
    const res = await s.run('whisper', { player: 'LongPlayerName16', message: long })
    assert.equal(res.isError, undefined)
    const commands = s.game.callsOf('bot.command').map((p) => String(p.command))
    assert.ok(commands.length >= 2 && commands.length <= 3, `split into ${commands.length} commands`)
    for (const c of commands) {
      assert.ok(c.length <= 99, `command is ${c.length} chars`)
      assert.ok(c.startsWith('tell LongPlayerName16 '))
    }
    // 拼回去就是原话
    assert.equal(commands.map((c) => c.slice('tell LongPlayerName16 '.length)).join(''), long)
  })

  it('说话和指令太密被身体拒绝时，模型得知“等几秒再说”，而不是“不让用”', async (t) => {
    const s = setup(t)
    // 真实 mod 的两种 denied，消息原文
    s.game.handlers['bot.chat'] = () => {
      throw new BridgeError('denied', 'too many chat lines and commands in a short time; try again in a few seconds')
    }
    s.game.handlers['bot.command'] = () => {
      throw new BridgeError('denied', 'command is not on the bot allow list: team leave')
    }
    const busy = await s.run('say', { message: '还有一句' })
    assert.equal(busy.isError, true)
    assert.match(busy.content, /wait a few seconds, then do it once more/)
    assert.equal(/not allowed|ask a player/i.test(busy.content), false)
    assert.deepEqual(s.spoke, [], '没说出去就不算说过话')

    const forbidden = await s.run('list_homes')
    assert.equal(forbidden.isError, true)
    assert.match(forbidden.content, /Bots are not allowed to use this command/)
    assert.equal(/wait a few seconds/.test(forbidden.content), false)
  })

  it('whisper 的对象不在线时，模型得知没送到，也不算它说过话', async (t) => {
    const s = setup(t)
    s.game.handlers['bot.command'] = () => ({ output: ['That player cannot be found'] })
    const res = await s.run('whisper', { player: 'Herobrine', message: '在吗' })
    assert.equal(res.isError, true)
    assert.match(res.content, /Herobrine did not get it\. The server replied: That player cannot be found/)
    assert.deepEqual(s.spoke, [])
  })
})

describe('观察', () => {
  it('get_status 把背包按物品合并', async (t) => {
    const s = setup(t)
    s.game.handlers['bot.status'] = () => ({
      name: 'Alu',
      online: true,
      dim: 0,
      block: { x: 1, y: 70, z: 2 },
      health: 18,
      maxHealth: 20,
      food: 17,
      freeSlots: 31,
      inventory: [
        { slot: 0, id: 'minecraft:iron_pickaxe', meta: 0, count: 1, name: 'Iron Pickaxe', durability: 0.25 },
        { slot: 9, id: 'minecraft:dirt', meta: 0, count: 64, name: 'Dirt' },
        { slot: 10, id: 'minecraft:dirt', meta: 0, count: 32, name: 'Dirt' },
        { slot: 11, id: 'minecraft:wool', meta: 14, count: 5, name: 'Red Wool' },
        { slot: 12, id: 'gregtech:gt.metaitem.01', meta: 5036, count: 3, name: 'Crushed Zinc Ore' },
        // 整合包里停用的 GT 工具在服务器端没有翻译好的名字
        { slot: 13, id: 'gregtech:gt.metatool.01', meta: 12, count: 2, name: 'gt.metatool.01.12.name' },
      ],
      task: { id: 't7', type: 'flatten', state: 'running', progress: { done: 120, total: 400, phase: 'clearing' } },
      queue: [{ id: 't8', type: 'deposit', state: 'queued' }],
    })
    const res = await s.run('get_status')
    assert.match(res.content, /at block \(1,70,2\), health 18\/20, food 17/)
    assert.match(res.content, /96× minecraft:dirt "Dirt"/)
    assert.match(res.content, /5× minecraft:wool\/14 "Red Wool"/)
    // GregTech 的普通物品有正常的显示名，照常给模型看（同时带着 id/meta）
    assert.match(res.content, /3× gregtech:gt\.metaitem\.01\/5036 "Crushed Zinc Ore"/)
    // 没翻译的显示名（语言键）不给模型看，只留 id/meta
    assert.match(res.content, /2× gregtech:gt\.metatool\.01\/12(,|$)/m)
    assert.equal(res.content.includes('12.name'), false)
    assert.match(res.content, /^Tools: 1× minecraft:iron_pickaxe "Iron Pickaxe" \(25% durability\)$/m)
    assert.match(res.content, /^Inventory \(31 of 36 slots free\): 96× minecraft:dirt/m)
    assert.match(res.content, /Current task: t7 flatten \[running\] 120\/400 clearing/)
    assert.match(res.content, /Queued tasks: t8 deposit/)
  })

  it('scan_area：24×24 以内给每一列的确切高度', async (t) => {
    const s = setup(t)
    s.game.handlers['world.scan'] = () => ({
      x1: 100,
      z1: 200,
      x2: 102,
      z2: 201,
      heights: [
        [64, 64, 65],
        [63, 64, -1],
      ],
      tops: [
        [0, 0, 0],
        [1, 0, 0],
      ],
      palette: ['minecraft:grass', 'minecraft:water'],
      liquidPalette: [1],
      liquidColumns: 1,
      tileEntities: [{ x: 101, y: 65, z: 200, id: 'minecraft:chest' }],
    })
    const res = await s.run('scan_area', { x1: 102, z1: 201, x2: 100, z2: 200 })
    assert.equal(res.isError, undefined)
    assert.match(res.content, /^z=200: 64 64 65$/m)
    // 顶上是水的那一列带 ~
    assert.match(res.content, /^z=201: 63~ 64 --$/m)
    assert.match(res.content, /min 63, max 65, most common 64/)
    assert.match(res.content, /63:1 64:3 65:1/)
    assert.match(res.content, /minecraft:grass 4, minecraft:water \(liquid\) 1/)
    assert.match(res.content, /1 columns have liquid on top \(marked ~ in the grid\)/)
    assert.match(res.content, /Blocks with data near the surface.*: minecraft:chest \(101,65,200\)$/m)
  })

  it('scan_area：更大的区域给直方图和降采样网格，不给全量网格', async (t) => {
    const s = setup(t)
    s.game.handlers['world.scan'] = () => ({
      x1: 0,
      z1: 0,
      x2: 39,
      z2: 39,
      // 西半边 64，东半边 70
      heights: Array.from({ length: 40 }, () => Array.from({ length: 40 }, (_, x) => (x < 20 ? 64 : 70))),
    })
    const res = await s.run('scan_area', { x1: 0, z1: 0, x2: 39, z2: 39 })
    assert.match(res.content, /Downsampled height grid: each cell is the rounded mean height of a 2×2 block/)
    assert.match(res.content, /64:800 70:800/)
    const rows = res.content.split('\n').filter((l) => l.startsWith('z='))
    assert.equal(rows.length, 20)
    assert.equal(rows[0], `z=0: ${[...Array(10).fill('64'), ...Array(10).fill('70')].join(' ')}`)
    assert.equal(rows[19]!.startsWith('z=38: '), true)
  })

  it('scan_area：超过 64×64 直接报错让模型分块，不去问游戏', async (t) => {
    const s = setup(t)
    const res = await s.run('scan_area', { x1: 0, z1: 0, x2: 64, z2: 10 })
    assert.equal(res.isError, true)
    assert.match(res.content, /65×11; at most 64×64/)
    assert.equal(s.game.callsOf('world.scan').length, 0)
  })

  it('look_around 合并实体、箱子摘要和地形摘要；其中一项拿不到时其余照给', async (t) => {
    const s = setup(t)
    s.game.handlers['world.entities'] = () => ({
      entities: [
        { type: 'player', name: 'Alu', pos: { x: 10.5, y: 64, z: -3.5 }, dist: 0 },
        { type: 'player', name: 'Steve', pos: { x: 12.5, y: 64, z: 3.5 }, dist: 7.3 },
        { type: 'mob', name: 'Zombie', dist: 9 },
        { type: 'mob', name: 'Zombie', dist: 14 },
        { type: 'item', name: 'Dirt', dist: 2, item: { id: 'minecraft:dirt', meta: 0, count: 3 } },
      ],
    })
    s.game.handlers['world.containers'] = () => {
      throw new BridgeError('internal', 'chunk not loaded')
    }
    s.game.handlers['world.scan'] = () => ({ x1: -6, z1: -20, x2: 26, z2: 12, heights: [[64, 64], [64, 66]], tops: [[0, 0], [0, 0]], palette: ['minecraft:grass'] })
    const res = await s.run('look_around')
    assert.equal(res.isError, undefined)
    assert.match(res.content, /player Steve at \(12,64,3\) \(7 blocks away\)/)
    assert.equal(/player Alu/.test(res.content), false)
    assert.match(res.content, /2× mob Zombie \(nearest 9 away\)/)
    assert.match(res.content, /3× dropped item minecraft:dirt/)
    assert.match(res.content, /Containers: unavailable \(chunk not loaded\)/)
    assert.match(res.content, /ground height 64\.\.66 \(most common 64\)/)
    // 以 bot 为中心去查，不用先自己换算坐标
    assert.deepEqual(s.game.callsOf('world.entities')[0], { bot: 'Alu', radius: 16 })
  })

  it('find_blocks / list_containers 以 bot 为中心；结果比显示的多时说明总数', async (t) => {
    const s = setup(t)
    s.game.handlers['world.find'] = () => ({
      matches: [
        { x: -47, y: 99, z: -83, id: 'minecraft:chest', meta: 3, dist: 22.02 },
        { x: -51, y: 99, z: -87, id: 'minecraft:chest', meta: 3, dist: 26.32 },
      ],
      total: 57,
    })
    s.game.handlers['world.containers'] = () => ({
      containers: [{ x: -47, y: 99, z: -83, id: 'minecraft:chest', name: 'Chest', slots: 27, usedSlots: 2, items: [{ id: 'minecraft:dirt', meta: 0, count: 27, name: 'Dirt' }] }],
      total: 1,
    })
    const found = await s.run('find_blocks', { ids: ['minecraft:chest'], radius: 48 })
    assert.match(found.content, /Found 2 \(57 in range, showing the nearest 2\)/)
    assert.match(found.content, /\(-47,99,-83\) minecraft:chest\/3 — 22 away/)
    assert.deepEqual(s.game.callsOf('world.find')[0], { bot: 'Alu', blocks: ['minecraft:chest'], radius: 48, limit: 32 })
    const boxes = await s.run('list_containers')
    assert.match(boxes.content, /\(-47,99,-83\) Chest \[minecraft:chest\] 2\/27 slots used: 27× minecraft:dirt "Dirt"/)
    assert.deepEqual(s.game.callsOf('world.containers')[0], { bot: 'Alu', radius: 16 })
    // 一次 bot.status 都没多查
    assert.equal(s.game.callsOf('bot.status').length, 0)
  })

  it('inspect_block：区块没加载时说清楚看不到，而不是报一个空方块', async (t) => {
    const s = setup(t)
    s.game.handlers['world.block'] = (p) => ({ x: p.x, y: p.y, z: p.z, loaded: false })
    const far = await s.run('inspect_block', { x: 5000, y: 64, z: 5000 })
    assert.match(far.content, /\(5000,64,5000\): unknown, that chunk is not loaded/)
    s.game.handlers['world.block'] = () => ({ id: 'minecraft:chest', meta: 3, name: 'Chest', air: false, solid: true, hardness: 2.5, tileEntity: true, inventory: true })
    const chest = await s.run('inspect_block', { x: -51, y: 99, z: -87 })
    assert.equal(chest.content, '(-51,99,-87): minecraft:chest/3 "Chest" [solid, tileEntity, inventory] hardness 2.5')
  })

  it('probe_block：说明现在能不能挖、用哪件工具、要多久', async (t) => {
    const s = setup(t)
    s.game.handlers['bot.probe'] = () => ({
      id: 'minecraft:grass', meta: 0, name: 'Grass Block', air: false, solid: true, hardness: 0.6,
      canDig: true, digTicks: 3, toolSlot: 1, inReach: true,
      candidates: [
        { slot: -1, item: 'hand', harvest: true, strength: 0.055, ticks: 18 },
        { slot: 1, item: 'TConstruct:shovel:3', harvest: true, strength: 0.388, ticks: 3 },
        { slot: 3, item: 'TConstruct:pickaxe:15', harvest: true, strength: 0.055, ticks: 18 },
      ],
    })
    const ok = await s.run('probe_block', { x: -45, y: 89, z: -63 })
    assert.match(ok.content, /minecraft:grass "Grass Block"/)
    assert.match(ok.content, /You can dig it in about 0\.15 s \(3 ticks\) using TConstruct:shovel:3 \(slot 1\)\./)
    assert.match(ok.content, /Other options: hand 18 ticks; TConstruct:pickaxe:15 18 ticks/)
    assert.deepEqual(s.game.callsOf('bot.probe')[0], { bot: 'Alu', x: -45, y: 89, z: -63 })

    // 没有匠魂镐时的石头：什么都挖不动
    s.game.handlers['bot.probe'] = () => ({
      id: 'minecraft:stone', meta: 0, name: 'Stone', air: false, solid: true, hardness: 1.5,
      canDig: false, digTicks: 0, toolSlot: -1, inReach: false,
      candidates: [{ slot: -1, item: 'hand', harvest: false, strength: 0.02, ticks: 0 }, { slot: 0, item: 'minecraft:iron_pickaxe:0', harvest: false, strength: 0, ticks: 0 }],
    })
    const no = await s.run('probe_block', { x: 0, y: 60, z: 0 })
    assert.match(no.content, /You cannot dig it: nothing you carry can break this block\. A digging task here would fail with no_tool\./)
    assert.match(no.content, /out of reach from where you stand/)

    // 背包里唯一能挖石头的是匠魂锤（一次挖一片），身体不用它：等于挖不了
    s.game.handlers['bot.probe'] = () => ({
      id: 'minecraft:stone', meta: 0, name: 'Stone', air: false, solid: true, hardness: 1.5,
      canDig: false, digTicks: 0, toolSlot: -1, inReach: true,
      candidates: [{ slot: -1, item: 'hand', harvest: false, ticks: 150 }, { slot: 4, item: 'TConstruct:hammer:0', harvest: true, ticks: 9, excluded: true }],
    })
    const hammer = await s.run('probe_block', { x: 0, y: 60, z: 0 })
    assert.match(hammer.content, /You cannot dig it: nothing you carry can break this block/)
    assert.match(hammer.content, /TConstruct:hammer:0 is never used \(it breaks several blocks at once\)/)
  })

  it('get_player_position：不在线时说明谁在线', async (t) => {
    const s = setup(t)
    const there = await s.run('get_player_position', { player: 'steve' })
    assert.match(there.content, /Steve is in overworld \(dim 0\) at \(12,64,3\)/)
    const gone = await s.run('get_player_position', { player: 'Herobrine' })
    assert.equal(gone.isError, true)
    assert.match(gone.content, /Online now: Steve/)
  })

  it('bot 不在线时，需要位置的工具给出明确的错误', async (t) => {
    const s = setup(t)
    s.game.online = false
    const res = await s.run('look_around')
    assert.equal(res.isError, true)
    assert.match(res.content, /Alu is offline/)
  })
})

describe('任务类工具', () => {
  it('默认 replace，queue: true 时用 append 排到队尾', async (t) => {
    const s = setup(t)
    const a = await s.run('go_to', { x: 1, y: 64, z: 2 })
    const b = await s.run('deposit_items', { container: { x: 5, y: 64, z: 5 }, keep: ['minecraft:torch'], queue: true })
    // 身体在响应里总是报 queued；工具按“怎么启动的”来说
    assert.match(a.content, /Task t1 \(goto\) started\./)
    assert.match(b.content, /Task t2 \(deposit\) added to the end of your queue/)
    assert.deepEqual(s.game.callsOf('task.start'), [
      { bot: 'Alu', task: { type: 'goto', x: 1, y: 64, z: 2 }, mode: 'replace' },
      { bot: 'Alu', task: { type: 'deposit', container: { x: 5, y: 64, z: 5 }, keep: ['minecraft:torch'] }, mode: 'append' },
    ])
    assert.deepEqual(s.started, ['t1', 't2'])
    // 只有 replace 会取消正在做的事
    assert.equal(s.cancels.length, 1)
    assert.deepEqual(s.open(), { cancels: 0, commands: 0 })
  })

  it('go_to 可以只给 x 和 z（走到那里的地面）；place_blocks 可以带补给箱', async (t) => {
    const s = setup(t)
    await s.run('go_to', { x: -60, z: -60 })
    await s.run('place_blocks', { blocks: [{ x: 1, y: 65, z: 1, item: 'minecraft:cobblestone' }], supply: [{ x: 5, y: 64, z: 5 }] })
    assert.deepEqual(
      s.game.callsOf('task.start').map((p) => p.task),
      [
        { type: 'goto', x: -60, z: -60 },
        { type: 'place', blocks: [{ x: 1, y: 65, z: 1, item: 'minecraft:cobblestone' }], supply: [{ x: 5, y: 64, z: 5 }] },
      ],
    )
  })

  it('顶掉旧任务时，把身体报告的被取消任务告诉上层和模型', async (t) => {
    const s = setup(t)
    s.game.handlers['task.start'] = () => ({ task: { id: 't9', type: 'goto', state: 'queued' }, replaced: ['t7', 't8'] })
    const res = await s.run('go_to', { x: 1, z: 2 })
    assert.match(res.content, /Task t9 \(goto\) started\. It replaced 2 earlier task\(s\): t7, t8\./)
    assert.deepEqual(s.cancels, [['t7', 't8']])
  })

  it('各任务工具把参数原样映射到协议里的任务类型', async (t) => {
    const s = setup(t)
    await s.run('flatten_area', { x1: 0, z1: 0, x2: 15, z2: 15, y: 64, fill: false, maxFillDepth: 2, dropoff: [{ x: 1, y: 65, z: 1 }] })
    await s.run('fill_area', { x1: 0, y1: 64, z1: 0, x2: 4, y2: 66, z2: 4, item: 'minecraft:cobblestone', shape: 'walls' })
    await s.run('haul_items', { from: { x: 1, y: 64, z: 1 }, to: { x: 9, y: 64, z: 9 }, items: [{ id: 'minecraft:iron_ingot', count: 64 }] })
    await s.run('follow_player', { player: 'Steve', distance: 4 })
    await s.run('go_home', { name: 'base' })
    const tasks = s.game.callsOf('task.start').map((p) => p.task)
    assert.deepEqual(tasks, [
      { type: 'flatten', x1: 0, z1: 0, x2: 15, z2: 15, y: 64, fill: false, maxFillDepth: 2, dropoff: [{ x: 1, y: 65, z: 1 }] },
      { type: 'fill', x1: 0, y1: 64, z1: 0, x2: 4, y2: 66, z2: 4, item: 'minecraft:cobblestone', shape: 'walls' },
      { type: 'haul', from: { x: 1, y: 64, z: 1 }, to: { x: 9, y: 64, z: 9 }, items: [{ id: 'minecraft:iron_ingot', count: 64 }] },
      { type: 'follow', player: 'Steve', distance: 4 },
      { type: 'home', name: 'base' },
    ])
  })

  it('挖东西的区域任务可以指定背包满了怎么办（overflow）；别的取值被拒绝', async (t) => {
    const s = setup(t)
    await s.run('clear_area', { x1: 0, y1: 60, z1: 0, x2: 3, y2: 62, z2: 3, overflow: 'leave' })
    await s.run('flatten_area', { x1: 0, z1: 0, x2: 3, z2: 3, y: 64, overflow: 'fail' })
    assert.deepEqual(
      s.game.callsOf('task.start').map((p) => p.task),
      [
        { type: 'clear', x1: 0, y1: 60, z1: 0, x2: 3, y2: 62, z2: 3, overflow: 'leave' },
        { type: 'flatten', x1: 0, z1: 0, x2: 3, z2: 3, y: 64, overflow: 'fail' },
      ],
    )
    const bad = await s.run('clear_area', { x1: 0, y1: 60, z1: 0, x2: 3, y2: 62, z2: 3, overflow: 'void' })
    assert.equal(bad.isError, true)
    assert.match(bad.content, /overflow must be one of: fail, leave/)
    assert.equal(s.game.callsOf('task.start').length, 2)
  })

  it('give_items 把东西送给玩家；任务队列满了时模型得知要先等或取消', async (t) => {
    const s = setup(t)
    const res = await s.run('give_items', { player: 'Steve', items: [{ id: 'minecraft:cobblestone', count: 64 }, { id: 'minecraft:torch' }] })
    assert.match(res.content, /Task t1 \(give\) started/)
    assert.deepEqual(s.game.callsOf('task.start')[0], {
      bot: 'Alu',
      task: { type: 'give', player: 'Steve', items: [{ id: 'minecraft:cobblestone', count: 64 }, { id: 'minecraft:torch' }] },
      mode: 'replace',
    })
    assert.equal((await s.run('give_items', { player: 'not a name', items: [{ id: 'minecraft:dirt' }] })).isError, true)

    s.game.handlers['task.start'] = () => {
      throw new BridgeError('too_large', 'at most 32 tasks may wait in the queue')
    }
    const full = await s.run('go_to', { x: 1, z: 2, queue: true })
    assert.equal(full.isError, true)
    assert.match(full.content, /^too_large: at most 32 tasks may wait in the queue \(Your task queue is full/)
  })

  it('超出协议上限的参数在本地就被拒绝，并告诉模型怎么拆', async (t) => {
    const s = setup(t)
    const clear = await s.run('clear_area', { x1: 0, y1: 60, z1: 0, x2: 63, y2: 70, z2: 63 })
    const flatten = await s.run('flatten_area', { x1: 0, z1: 0, x2: 64, z2: 3, y: 64 })
    const dig = await s.run('dig_blocks', { blocks: Array.from({ length: 257 }, (_, i) => ({ x: i, y: 64, z: 0 })) })
    assert.match(clear.content, /box volume is 45056; at most 32768/)
    assert.match(flatten.content, /65×4; at most 64×64/)
    assert.match(dig.content, /257 items, at most 256 allowed/)
    assert.deepEqual([clear.isError, flatten.isError, dig.isError], [true, true, true])
    assert.equal(s.game.callsOf('task.start').length, 0)
  })

  it('collect_items 不给坐标时用 bot 自己的位置', async (t) => {
    const s = setup(t)
    await s.run('collect_items', { radius: 6 })
    assert.deepEqual(s.game.callsOf('task.start')[0]!.task, { type: 'collect', x: 10, y: 64, z: -4, radius: 6 })
  })

  it('任务被游戏拒绝时，模型看到错误码', async (t) => {
    const s = setup(t)
    s.game.handlers['task.start'] = () => {
      throw new BridgeError('offline', 'Alu is offline')
    }
    const res = await s.run('go_to', { x: 1, y: 64, z: 2 })
    assert.equal(res.isError, true)
    assert.match(res.content, /^offline: Alu is offline/)
    assert.deepEqual(s.started, [])
  })

  it('task_status 列出正在做的、排队的和最近结束的（含失败原因）', async (t) => {
    const s = setup(t)
    s.game.handlers['task.list'] = () => ({
      active: { id: 't3', type: 'clear', state: 'running', progress: { done: 10, total: 90, phase: 'digging' }, params: { x1: 0 } },
      queue: [{ id: 't4', type: 'deposit', state: 'queued' }],
      recent: [
        { id: 't1', type: 'goto', state: 'done', finishedAt: 100 },
        { id: 't2', type: 'fill', state: 'failed', finishedAt: 200, error: { code: 'no_material', message: 'need more', detail: { item: 'minecraft:dirt', missing: 40 } } },
      ],
    })
    const res = await s.run('task_status')
    assert.match(res.content, /Running: t3 clear \[running\] 10\/90 digging/)
    assert.match(res.content, /- t4 deposit \[queued\]/)
    assert.match(res.content, /- t2 fill \[failed\] error=no_material: need more detail=\{"item":"minecraft:dirt","missing":40\}/)
    assert.ok(res.content.indexOf('t2 fill') < res.content.indexOf('t1 goto'), 'newest first')
  })

  it('cancel_task 可以取消单个任务或全部', async (t) => {
    const s = setup(t)
    s.game.handlers['task.cancel'] = (p) => (p.id ? { canceled: 1, ids: [p.id] } : { canceled: 2, ids: ['t5', 't6'] })
    const one = await s.run('cancel_task', { id: 't4' })
    const all = await s.run('cancel_task')
    assert.deepEqual(s.game.callsOf('task.cancel'), [{ bot: 'Alu', id: 't4' }, { bot: 'Alu' }])
    assert.equal(one.content, 'Canceled 1 task(s): t4.')
    assert.equal(all.content, 'Canceled 2 task(s): t5, t6.')
    assert.deepEqual(s.cancels, [['t4'], ['t5', 't6']])
  })

  it('任务被游戏拒绝后，“正在取消”的状态不会卡住', async (t) => {
    const s = setup(t)
    s.game.handlers['task.start'] = () => {
      throw new BridgeError('bad_request', 'unknown task type: goto')
    }
    await s.run('go_to', { x: 1, z: 2 })
    assert.deepEqual(s.open(), { cancels: 0, commands: 0 })
    assert.deepEqual(s.cancels, [[]])
  })
})

describe('home、记忆、提醒', () => {
  it('set_home 执行 sethome 指令，并把地点和用途记进记忆', async (t) => {
    const s = setup(t)
    s.game.handlers['bot.command'] = () => ({ output: ["Home 'base' set!"] })
    const res = await s.run('set_home', { name: 'base', note: '主仓库' })
    assert.deepEqual(s.game.callsOf('bot.command'), [{ bot: 'Alu', command: 'sethome base' }])
    assert.match(res.content, /Server replied: Home 'base' set!/)
    assert.equal(s.memory.get('home:base')?.text, '(10,64,-4) dim 0 — 主仓库')
  })

  it('指令当下没有回显、回显晚一步才到时，list_homes 也能把它拿到', async (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const game = new FakeGame()
    game.handlers['bot.command'] = () => ({ output: [] })
    const asked: [number, number][] = []
    const ctx: ToolContext = {
      botName: 'Alu',
      bridge: new BridgeApi(game),
      memory: new MemoryStore(tmp.dir, () => 300),
      reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
      hooks: {},
      now: () => NOW,
      laterMessages: async (since, waitMs) => {
        asked.push([since, waitMs])
        return ['Alu: 2 / 99: base, mine']
      },
    }
    const res = await runTool(ALL_TOOLS, ctx, 'list_homes', {})
    assert.equal(res.content, 'Server replied: Alu: 2 / 99: base, mine')
    assert.equal(asked.length, 1)
    assert.equal(asked[0]![0], NOW)
    assert.ok(asked[0]![1] > 0)
  })

  it('join_team 执行 team join；队伍不存在时模型得知没加成', async (t) => {
    const s = setup(t)
    s.game.handlers['bot.command'] = (p) => ({ output: String(p.command).endsWith('steves_base') ? ["You joined team 'steves_base'"] : ["Team 'nope' not found!"] })
    const ok = await s.run('join_team', { team: 'steves_base' })
    assert.equal(ok.isError, undefined)
    assert.match(ok.content, /The server replied: You joined team 'steves_base'/)
    const missing = await s.run('join_team', { team: 'nope' })
    assert.equal(missing.isError, true)
    assert.match(missing.content, /Could not join\. The server replied: Team 'nope' not found!/)
    assert.deepEqual(s.game.callsOf('bot.command').map((p) => p.command), ['team join steves_base', 'team join nope'])
    // 只能是队伍 id，不能夹带别的词（允许列表只放行 team join）
    assert.equal((await s.run('join_team', { team: 'x leave' })).isError, true)
    assert.equal(s.game.callsOf('bot.command').length, 2)
  })

  it('home 名字里有空格等字符时拒绝，不执行指令', async (t) => {
    const s = setup(t)
    const res = await s.run('set_home', { name: 'base; op Steve' })
    assert.equal(res.isError, true)
    assert.equal(s.game.callsOf('bot.command').length, 0)
  })

  it('remember / forget 读写记忆；记忆满了时把原因告诉模型', async (t) => {
    const s = setup(t)
    await s.run('remember', { key: 'job', text: '在给 Steve 平 0,0 到 31,31' })
    assert.equal(s.memory.get('job')?.text, '在给 Steve 平 0,0 到 31,31')
    const full = await s.run('remember', { key: 'big', text: 'x'.repeat(400) })
    assert.equal(full.isError, true)
    assert.match(full.content, /memory is full/)
    assert.equal((await s.run('forget', { key: 'job' })).isError, undefined)
    assert.equal(s.memory.get('job'), undefined)
    assert.equal((await s.run('forget', { key: 'job' })).isError, true)
  })

  it('set_reminder 登记一个若干分钟后的提醒', async (t) => {
    const s = setup(t)
    await s.run('set_reminder', { minutes: 30, note: '看看熔炉' })
    assert.deepEqual(s.reminders, [{ dueAt: NOW + 30 * 60_000, note: '看看熔炉' }])
  })
})

describe('工具结果', () => {
  it('超长的结果被截断并说明截掉了多少', async (t) => {
    const s = setup(t)
    s.game.handlers['bot.command'] = () => ({ output: ['h'.repeat(5000)] })
    const res = await s.run('list_homes', {}, 800)
    assert.ok(res.content.length < 900)
    assert.match(res.content, /\[truncated: \d+ more characters\]$/)
  })

  it('数字写成了字符串也能用；类型完全不对时列出问题', async (t) => {
    const s = setup(t)
    const ok = await s.run('go_to', { x: '12', y: '64', z: '-3' })
    assert.equal(ok.isError, undefined)
    assert.deepEqual(s.game.callsOf('task.start')[0]!.task, { type: 'goto', x: 12, y: 64, z: -3 })
    const bad = await s.run('go_to', { x: 'north', y: 64.5, z: 1 })
    assert.equal(bad.isError, true)
    assert.match(bad.content, /x must be a number; y must be an integer/)
  })
})
