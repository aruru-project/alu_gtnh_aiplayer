import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import path from 'node:path'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { ALL_TOOLS, runTool } from '../src/tools/index.ts'
import type { ToolContext, ToolResult } from '../src/tools/index.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { tmpDir } from './helpers.ts'

const NOW = 1_800_000_000_000

function setup(t: { after(fn: () => void): void }) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  const game = new FakeGame()
  const memory = new MemoryStore(tmp.dir, () => 300)
  // 默认手册是随代码发布的那几本；主人写的放在这次测试的临时目录里
  const manuals = new ManualStore(DEFAULT_MANUALS_DIR, path.join(tmp.dir, 'manuals'))
  /** 查任务书进度默认看谁的（主人名单里的第一个，或者刚才跟它说话的人）。 */
  const who: { defaultPlayer: string | undefined } = { defaultPlayer: undefined }
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
    manuals,
    defaultPlayer: () => who.defaultPlayer,
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
  return { game, memory, manuals, who, reminders, spoke, started, cancels, open: () => ({ cancels: cancelsOpen, commands: commandsOpen }), run }
}

describe('工具清单', () => {
  it('规格里列出的第一版工具都在，名字不重复，参数 schema 都是对象', () => {
    const expected = [
      'say', 'whisper', 'get_status', 'look_around', 'scan_area', 'view_area', 'inspect_block', 'probe_block', 'find_blocks', 'list_containers', 'list_drawers', 'list_stock',
      'get_player_position', 'go_to', 'go_to_player', 'follow_player', 'go_home', 'set_home', 'list_homes', 'join_team',
      'flatten_area', 'clear_area', 'fill_area', 'dig_blocks', 'place_blocks',
      'list_blueprints', 'check_blueprint', 'build_blueprint',
      'run_program', 'start_routine', 'routine_status', 'stop_routine', 'list_images', 'view_image', 'list_drafts', 'view_draft', 'publish_draft', 'delete_draft',
      'deposit_items', 'withdraw_items', 'haul_items', 'collect_items', 'give_items', 'use_item', 'open_screen', 'click_slot', 'close_screen',
      'find_item', 'find_recipes', 'find_uses', 'find_in_storage', 'find_machines', 'craft_item', 'process_items',
      'list_quest_lines', 'find_quests', 'get_quest',
      'task_status', 'cancel_task', 'remember', 'forget', 'set_reminder',
      'list_manuals', 'read_manual', 'write_manual',
      'report_problem',
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
      'place_blocks', 'build_blueprint', 'deposit_items', 'withdraw_items', 'haul_items', 'collect_items', 'give_items', 'use_item', 'craft_item', 'process_items',
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

  it('不开正版验证的服务器上玩家可以叫中文名：私聊、走过去、跟随、递东西都认', async (t) => {
    const s = setup(t)
    s.game.handlers['bot.command'] = () => ({ output: ['You whisper to 阿露: 在'] })
    assert.deepEqual(await s.run('whisper', { player: '阿露', message: '在' }), { content: 'Whisper sent.' })
    assert.deepEqual(s.game.callsOf('bot.command'), [{ bot: 'Alu', command: 'tell 阿露 在' }])
    for (const tool of ['go_to_player', 'follow_player']) {
      const res = await s.run(tool, { player: '阿露' })
      assert.equal(res.isError, undefined, `${tool}: ${res.content}`)
    }
    const give = await s.run('give_items', { player: '阿露', items: [{ id: 'minecraft:dirt', count: 1 }] })
    assert.equal(give.isError, undefined, give.content)
    // 名字里夹着空格的仍然不行：拼进指令后，后半截会变成指令的别的参数。
    assert.equal((await s.run('whisper', { player: '阿露 op', message: 'x' })).isError, true)
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
    // 一页一页要：从头起的 20 个
    assert.deepEqual(s.game.callsOf('world.containers')[0], { bot: 'Alu', radius: 16, offset: 0, limit: 20 })
    // 一次 bot.status 都没多查
    assert.equal(s.game.callsOf('bot.status').length, 0)
  })

  it('主人说的是五十格外那个地方的东西：以自己为中心什么都看不到，结果里提醒换个中心；给 at 就以那里为中心看，六个“看周围”的工具都一样', async (t) => {
    const s = setup(t)
    // 抽屉管理器在 (60,64,-4)，旁边是主人的箱子和一台车床；它站在 (10,64,-4)，离着五十格。
    // 像身体那样：每次查询只看得到中心周围 radius 格以内的东西，中心是 {bot} 时就是它站的地方
    const CHEST = { x: 61, y: 64, z: -4 }
    const sees = (p: Record<string, unknown>): boolean => {
      const c = typeof p.x === 'number' ? (p as unknown as { x: number; y: number; z: number }) : { x: 10, y: 64, z: -4 }
      return Math.max(Math.abs(CHEST.x - c.x), Math.abs(CHEST.y - c.y), Math.abs(CHEST.z - c.z)) <= Number(p.radius)
    }
    const dirt = { id: 'minecraft:dirt', meta: 0, count: 27, name: 'Dirt' }
    s.game.handlers['world.containers'] = (p) => (sees(p) ? { containers: [{ ...CHEST, id: 'minecraft:chest', name: 'Chest', slots: 27, usedSlots: 1, items: [dirt] }], total: 1, offset: 0 } : { containers: [], total: 0, offset: 0 })
    s.game.handlers['world.find'] = (p) => (sees(p) ? { matches: [{ ...CHEST, id: 'minecraft:chest', meta: 3, dist: 1 }], total: 1 } : { matches: [], total: 0 })
    s.game.handlers['world.stock'] = (p) => (sees(p) ? { items: [{ id: 'minecraft:dirt', meta: 0, total: 27, places: [{ ...CHEST, container: 'Chest', count: 27 }] }], containersLookedInto: 1 } : { items: [{ id: 'minecraft:dirt', meta: 0, total: 0, places: [] }], containersLookedInto: 0 })
    s.game.handlers['world.machines'] = (p) => (sees(p) ? { machines: [{ x: 62, y: 64, z: -4, name: 'Basic Lathe', recipes: 'Lathe', tier: 'LV', inputSlots: 1, active: false, storedEU: 900, inputVoltage: 32, dist: 2 }], total: 1 } : { machines: [], total: 0 })
    s.game.handlers['world.entities'] = () => ({ entities: [] })
    s.game.handlers['world.scan'] = (p) => ({ ...p, heights: [[64]], tops: [[0]], palette: ['minecraft:grass'] })

    const AT = { x: 60, y: 64, z: -4 }
    const hint = ' If it is at some other place (where your owner is, or a position they named), look around that place: give "at".'
    // 以自己为中心：没有。这不等于那边没有，所以每个结果都说可以换个中心
    assert.equal((await s.run('list_containers')).content, `No containers within 16 blocks of you.${hint}`)
    assert.equal((await s.run('list_stock')).content, `No containers within 16 blocks of you.${hint}`)
    assert.equal((await s.run('find_blocks', { ids: ['minecraft:chest'] })).content, `No minecraft:chest within 24 blocks of you.${hint}`)
    assert.match((await s.run('find_machines')).content, /^No GregTech machine within 32 blocks of you .* give "at"\.$/)
    // find_in_storage 不给范围时看的是整个基地（往四周错开四个点各查 64 格）：五十格外的那个箱子它看得到
    assert.match((await s.run('find_in_storage', { items: [{ id: 'minecraft:dirt' }] })).content, /^Looked into 1 container\(s\) within 112 blocks of you \(the whole base, as far as chunks are loaded\)\.[^\n]*\n- minecraft:dirt \(any meta\): 27 in total\n  - \(61,64,-4\) Chest: 27$/)
    // 给了半径就只看身边那么远：没有，并说可以换个中心
    assert.match((await s.run('find_in_storage', { items: [{ id: 'minecraft:dirt' }], radius: 32 })).content, /^There is no container within 32 blocks of you .*give "at" \(the position of a chest or drawer controller there, or where your owner stands\), or go there\.$/)
    assert.match((await s.run('look_around')).content, /\nContainers: none near you \(to look around another place, give "at"\)\n/)

    // 以抽屉管理器为中心：都看得到，结果里写明是那个地方的周围
    const boxes = await s.run('list_containers', { at: AT })
    assert.deepEqual(boxes.content.split('\n'), ['Within 16 blocks of (60,64,-4): 1 container(s).', '- (61,64,-4) Chest [minecraft:chest] 1/27 slots used: 27× minecraft:dirt "Dirt"'])
    assert.match((await s.run('list_stock', { at: AT })).content, /^Looked into 1 chest\(s\) and drawer\(s\) within 16 blocks of \(60,64,-4\): 1 kind\(s\) of item\. 1 item\(s\), most first:\n- 27× /)
    assert.equal((await s.run('find_blocks', { ids: ['minecraft:chest'], at: AT })).content, 'Found 1, nearest to (60,64,-4) first:\n(61,64,-4) minecraft:chest/3 — 1 away')
    assert.match((await s.run('find_machines', { at: AT })).content, /^1 GregTech machine\(s\) within 32 blocks of \(60,64,-4\), nearest first\.[^\n]*\n- \(62,64,-4\) "Basic Lathe"/)
    assert.deepEqual((await s.run('find_in_storage', { items: [{ id: 'minecraft:dirt' }], at: AT })).content.split('\n').map((l) => l.replace(/\. withdraw_items takes things out.*$/, '.')), ['Looked into 1 container(s) within 32 blocks of (60,64,-4).', '- minecraft:dirt: 27 in total', '  - (61,64,-4) Chest: 27'])
    const around = await s.run('look_around', { at: AT })
    assert.match(around.content, /^You are at \(10,64,-4\) in overworld \(dim 0\)\. Within 16 blocks of \(60,64,-4\):\n/)
    assert.match(around.content, /\nContainers \(1\):\n- \(61,64,-4\) Chest /)
    // 地形也是那个地方的，不是它脚下的
    assert.deepEqual(s.game.callsOf('world.scan').at(-1), { x1: 44, z1: -20, x2: 76, z2: 12, dim: 0 })
    // 坐标不带维度，不说的话身体当成主世界：带上它自己所在的维度
    assert.deepEqual(s.game.callsOf('world.containers').at(-1), { x: 60, y: 64, z: -4, dim: 0, radius: 16 })
    // at 要给全
    const half = await s.run('list_containers', { at: { x: 60, z: -4 } })
    assert.equal(half.isError, true)
  })

  it('抽屉在 list_containers 和 look_around 里标成 [drawers]，数量是抽屉里的真实库存；箱子照旧', async (t) => {
    const s = setup(t)
    s.game.handlers['world.containers'] = () => ({
      containers: [
        { x: -47, y: 99, z: -83, id: 'minecraft:chest', name: 'Chest', slots: 27, usedSlots: 1, items: [{ id: 'minecraft:dirt', meta: 0, count: 27, name: 'Dirt' }] },
        // 一组两格的抽屉：一格装着一万多圆石，另一格空着
        { x: -45, y: 99, z: -83, id: 'StorageDrawers:fullDrawers2', name: 'Oak Drawers 1x2', slots: 2, usedSlots: 1, kind: 'drawers', items: [{ id: 'minecraft:cobblestone', meta: 0, count: 12800, name: 'Cobblestone' }] },
      ],
      total: 2,
    })
    const listed = (await s.run('list_containers')).content.split('\n')
    assert.equal(listed[1], '- (-47,99,-83) Chest [minecraft:chest] 1/27 slots used: 27× minecraft:dirt "Dirt"')
    assert.equal(listed[2], '- (-45,99,-83) Oak Drawers 1x2 [StorageDrawers:fullDrawers2] [drawers] 1/2 drawer slots used: 12800× minecraft:cobblestone "Cobblestone"')
    const around = await s.run('look_around')
    assert.match(around.content, /^- \(-45,99,-83\) Oak Drawers 1x2 \[StorageDrawers:fullDrawers2\] \[drawers\] .*12800× minecraft:cobblestone/m)
  })

  it('模型看到的工具说明里写明：存取、搬运、补给和卸货的位置都可以是抽屉', () => {
    // 用户实测时模型说“抽屉不一定能识别成容器”，根本没去试；它只能从这些说明里知道行不行
    const tool = (name: string) => ALL_TOOLS.find((x) => x.name === name)!
    for (const name of ['deposit_items', 'withdraw_items', 'haul_items', 'list_containers', 'look_around']) {
      assert.match(tool(name).description, /drawers/i, name)
    }
    for (const name of ['flatten_area', 'clear_area', 'fill_area', 'place_blocks', 'build_blueprint']) {
      const props = tool(name).inputSchema.properties
      for (const key of ['supply', 'dropoff']) {
        if (props[key]) assert.match(JSON.stringify(props[key]), /drawers/i, `${name}.${key}`)
      }
    }
  })

  it('inspect_block：区块没加载时说清楚看不到，而不是报一个空方块', async (t) => {
    const s = setup(t)
    s.game.handlers['world.block'] = (p) => ({ x: p.x, y: p.y, z: p.z, loaded: false })
    const far = await s.run('inspect_block', { x: 5000, y: 64, z: 5000 })
    assert.match(far.content, /\(5000,64,5000\): unknown: that chunk is not loaded/)
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

  it('随身的包当容器：deposit_items / withdraw_items 给 bag 时，交给身体的容器是“这件物品打开的界面”；往包里放没列东西、位置和包都给或都没给，不开任务', async (t) => {
    const s = setup(t)
    await s.run('deposit_items', { bag: { id: 'Backpack:backpack' }, items: [{ id: 'minecraft:coal', count: 16 }] })
    await s.run('withdraw_items', { bag: { id: 'Backpack:backpack', meta: 3 }, items: [{ id: 'minecraft:coal', count: 4 }], queue: true })
    assert.deepEqual(s.game.callsOf('task.start'), [
      { bot: 'Alu', task: { type: 'deposit', container: { item: { id: 'Backpack:backpack' } }, items: [{ id: 'minecraft:coal', count: 16 }] }, mode: 'replace' },
      { bot: 'Alu', task: { type: 'withdraw', container: { item: { id: 'Backpack:backpack', meta: 3 } }, items: [{ id: 'minecraft:coal', count: 4 }] }, mode: 'append' },
    ])
    const everything = await s.run('deposit_items', { bag: { id: 'Backpack:backpack' } })
    assert.deepEqual([everything.isError, everything.content], [true, 'Putting things into a bag needs "items": list what goes in.'])
    const both = await s.run('withdraw_items', { container: { x: 1, y: 64, z: 1 }, bag: { id: 'Backpack:backpack' }, items: [{ id: 'minecraft:coal' }] })
    const neither = await s.run('deposit_items', { items: [{ id: 'minecraft:coal' }] })
    for (const res of [both, neither]) assert.deepEqual([res.isError, res.content], [true, 'give exactly one of "container" (a position) or "bag" (a bag you carry)'])
    assert.equal(s.game.callsOf('task.start').length, 2)
  })

  it('从机器的原料格里取（主人留在里面的模具、模头）：withdraw_items 给 fromInputs，原样交给身体；不给时不带这一项；对随身的包没有这回事', async (t) => {
    const s = setup(t)
    const shape = { id: 'gregtech:gt.metaitem.01', meta: 32351, count: 1 }
    await s.run('withdraw_items', { container: { x: -525, y: 69, z: 38 }, items: [shape], fromInputs: true })
    await s.run('withdraw_items', { container: { x: -525, y: 69, z: 38 }, items: [shape] })
    assert.deepEqual(s.game.callsOf('task.start').map((c) => c.task), [
      { type: 'withdraw', container: { x: -525, y: 69, z: 38 }, items: [shape], fromInputs: true },
      { type: 'withdraw', container: { x: -525, y: 69, z: 38 }, items: [shape] },
    ])
    const bag = await s.run('withdraw_items', { bag: { id: 'Backpack:backpack' }, items: [shape], fromInputs: true })
    assert.deepEqual([bag.isError, bag.content], [true, '"fromInputs" is for a machine: give its position as "container", not a bag.'])
    assert.equal(s.game.callsOf('task.start').length, 2)
  })

  it('use_item 把身上的一件东西拿到手里右键用：对空中、对某个方块、蹲着用；做完以后模型看到的是背包里多了少了什么、血量和饱食度、是否打开了界面', async (t) => {
    const s = setup(t)
    await s.run('use_item', { id: 'minecraft:bread' })
    await s.run('use_item', { id: 'minecraft:flint_and_steel', meta: 0, on: { x: 3, y: 64, z: 5 }, sneak: true, queue: true })
    assert.deepEqual(s.game.callsOf('task.start'), [
      { bot: 'Alu', task: { type: 'use', item: { id: 'minecraft:bread' } }, mode: 'replace' },
      { bot: 'Alu', task: { type: 'use', item: { id: 'minecraft:flint_and_steel', meta: 0 }, on: { x: 3, y: 64, z: 5 }, sneak: true }, mode: 'append' },
    ])
    s.game.handlers['task.list'] = () => ({
      active: null,
      queue: [],
      recent: [
        { id: 't3', type: 'use', state: 'done', finishedAt: 300, params: { type: 'use', item: { id: 'Backpack:backpack' } }, result: { used: 'Backpack', gained: [], lost: [], openedScreen: true, health: 20, food: 20, freeSlots: 30 } },
        { id: 't2', type: 'use', state: 'done', finishedAt: 200, params: { type: 'use', item: { id: 'minecraft:stick' } }, result: { used: 'Stick', gained: [], lost: [], health: 20, food: 20, freeSlots: 30 } },
        { id: 't1', type: 'use', state: 'done', finishedAt: 100, params: { type: 'use', item: { id: 'minecraft:mushroom_stew' } }, result: { used: 'Mushroom Stew', gained: [{ id: 'minecraft:bowl', meta: 0, name: 'Bowl', count: 1 }], lost: [{ id: 'minecraft:mushroom_stew', meta: 0, name: 'Mushroom Stew', count: 1 }], health: 18.5, food: 16, freeSlots: 30 } },
      ],
    })
    const lines = (await s.run('task_status')).content.split('\n')
    assert.deepEqual(lines.slice(-3), [
      '- t3 use [done]; result: used "Backpack"; gained: nothing; lost: nothing; it opened a screen, which was closed again: to put things in or take them out, use deposit_items / withdraw_items with "bag"; health 20; food 20; freeSlots 30',
      '- t2 use [done]; result: used "Stick"; gained: nothing; lost: nothing; nothing visible changed in your inventory; health 20; food 20; freeSlots 30',
      '- t1 use [done]; result: used "Mushroom Stew"; gained: 1× minecraft:bowl "Bowl"; lost: 1× minecraft:mushroom_stew "Mushroom Stew"; health 18.5; food 16; freeSlots 30',
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

/** docs/PROTOCOL.md 里 blueprint.check 的那个例子：一座 32×27×32 的车间，地基埋在土里，旁边有几台机器。 */
const WORKSHOP_CHECK = {
  name: '02_Workshop_v3',
  origin: { x: -592, y: 63, z: 80 },
  box: { x1: -592, y1: 63, z1: 80, x2: -561, y2: 89, z2: 111 },
  cells: 5294,
  done: 10,
  toPlace: 3823,
  byHand: 2,
  blocked: 1461,
  extra: 2581,
  willRemove: 4019,
  materials: [
    { id: 'chisel:nucrete', meta: 7, name: 'Structural Concrete', need: 1874, have: 0 },
    { id: 'minecraft:stonebrick', meta: 0, name: 'Stone Bricks', need: 640, have: 128 },
    { id: 'TConstruct:GlassBlock', meta: 0, name: 'Clear Glass', need: 96, have: 96 },
  ],
  byHandBlocks: [{ id: 'minecraft:chest', meta: 3, name: 'Chest', count: 2, why: 'it holds contents or settings' }],
  blockedBy: [
    { id: 'minecraft:dirt', name: 'Dirt', count: 1196, removable: 1196, natural: true },
    { id: 'minecraft:stone', name: 'Stone', count: 265, removable: 0 },
  ],
  extraBlocks: [
    { id: 'minecraft:grass', name: 'Grass Block', count: 2567, removable: 2567, natural: true },
    // GregTech 的机器在服务器端没有翻译好的名字
    { id: 'gregtech:gt.blockmachines', name: 'gt.blockmachines.name', count: 14, removable: 0, holdsData: 14 },
  ],
  // 每层 [y, 图纸方块数, done, toPlace, blocked, extra]
  layers: [
    [63, 1024, 0, 0, 1024, 0],
    [64, 124, 0, 0, 124, 2581],
    [65, 124, 0, 124, 0, 0],
    [66, 124, 0, 124, 0, 0],
    [67, 124, 0, 124, 0, 0],
    [68, 10, 10, 0, 0, 0],
    [69, 1024, 0, 1024, 0, 0],
  ],
}

describe('图纸', () => {
  it('list_blueprints 列出每张图纸的名字、尺寸和方块数；读不了的写明原因', async (t) => {
    const s = setup(t)
    s.game.handlers['blueprint.list'] = () => ({
      blueprints: [
        { name: '02_Workshop_v3', size: { x: 32, y: 27, z: 32 }, blocks: 5294 },
        { name: 'broken', error: 'not a .schematic file (it is not gzip-compressed NBT)' },
      ],
      folder: 'config/aiplayer/schematics',
    })
    const res = await s.run('list_blueprints')
    assert.equal(res.isError, undefined)
    assert.match(res.content, /^- 02_Workshop_v3: 32×27×32, 5294 blocks$/m)
    assert.match(res.content, /^- broken: cannot be used \(not a \.schematic file \(it is not gzip-compressed NBT\)\)$/m)

    s.game.handlers['blueprint.list'] = () => ({ blueprints: [], folder: 'config/aiplayer/schematics' })
    assert.match((await s.run('list_blueprints')).content, /no blueprints on the server yet.*upload/)
  })

  it('check_blueprint 带着 bot 去对比，把结果排成短文本：计数、材料（要多少、身上有多少）、得由人放的、挡路的', async (t) => {
    const s = setup(t)
    s.game.handlers['blueprint.check'] = () => WORKSHOP_CHECK
    const res = await s.run('check_blueprint', { name: '02_Workshop_v3', x: -592, y: 63, z: 80, clear: ['natural'] })
    assert.equal(res.isError, undefined)
    // 带上 bot，身体才会在 materials 里给出它身上有多少
    assert.deepEqual(s.game.callsOf('blueprint.check'), [{ name: '02_Workshop_v3', x: -592, y: 63, z: 80, clear: ['natural'], bot: 'Alu' }])

    const text = res.content
    assert.match(text, /Blueprint "02_Workshop_v3" with its lowest corner at \(-592,63,80\)\. Compared x -592\.\.-561, y 63\.\.89, z 80\.\.111 \(32×27×32/)
    for (const line of ['cells): 5294', '- done: 10 ', '- toPlace: 3823 ', '- byHand: 2 ', '- blocked: 1461 ', '- extra: 2581 ']) {
      assert.ok(text.includes(line), `counts include "${line}"`)
    }
    assert.match(text, /With this clear list 4019 of those 4042 blocked\/extra blocks would be dug out/)
    // 材料：id、meta、名字、要多少、身上有多少；合计还差多少
    assert.match(text, /^- 1874× chisel:nucrete\/7 "Structural Concrete" \(you carry 0\)$/m)
    assert.match(text, /^- 640× minecraft:stonebrick "Stone Bricks" \(you carry 128\)$/m)
    assert.match(text, /^- 96× TConstruct:GlassBlock "Clear Glass" \(you carry 96\)$/m)
    assert.match(text, /You are 2386 blocks short in total/)
    // 得由人放的，带原因
    assert.match(text, /A player has to place these.*\n- 2× minecraft:chest\/3 "Chest" \(it holds contents or settings\)$/m)
    // 挡路的和多出来的：每种多少个、clear 会挖掉多少、多少个带数据谁也不动、是不是天然方块
    assert.match(text, /^- 1196× minecraft:dirt "Dirt" \(natural terrain, clear digs 1196\)$/m)
    assert.match(text, /^- 265× minecraft:stone "Stone" \(not natural terrain, clear digs 0\)$/m)
    assert.match(text, /^- 2567× minecraft:grass "Grass Block" \(natural terrain, clear digs 2567\)$/m)
    assert.match(text, /^- 14× gregtech:gt\.blockmachines \(not natural terrain, clear digs 0, 14 of them hold data and are never dug\)$/m)
    // 层：只列还有活要干的，相邻又一样的合成一行；已经对上的 y=68 不列
    assert.match(text, /^- y 63: done 0\/1024, toPlace 0, blocked 1024, extra 0$/m)
    assert.match(text, /^- y 65\.\.67 \(each layer\): done 0\/124, toPlace 124, blocked 0, extra 0$/m)
    assert.equal(/^- y 68/m.test(text), false)
    // 不是把原始 JSON 倒给模型
    assert.equal(/"need"|"removable"|\[63,1024/.test(text), false)
    assert.equal(text.includes('INCOMPLETE'), false)
  })

  it('check_blueprint：有格子所在的区块没加载时，提醒结果不完整、要走近再查', async (t) => {
    const s = setup(t)
    s.game.handlers['blueprint.check'] = () => ({ ...WORKSHOP_CHECK, unloaded: 1820 })
    const res = await s.run('check_blueprint', { name: '02_Workshop_v3', x: -592, y: 63, z: 80 })
    assert.match(res.content, /INCOMPLETE: 1820 cells are in chunks that are not loaded.*only be compared from near enough for the chunks to be loaded/)
  })

  it('check_blueprint：没给 clear 时说明一块都不会挖；clear 会挖到不是天然地形的方块时单独点出来', async (t) => {
    const s = setup(t)
    s.game.handlers['blueprint.check'] = () => ({ ...WORKSHOP_CHECK, willRemove: 0 })
    const none = await s.run('check_blueprint', { name: '02_Workshop_v3', x: -592, y: 63, z: 80 })
    assert.match(none.content, /No clear list was given, so nothing would be dug out/)
    assert.equal(/Someone may have built them/.test(none.content), false)

    s.game.handlers['blueprint.check'] = () => ({
      ...WORKSHOP_CHECK,
      blockedBy: [{ id: 'minecraft:dirt', name: 'Dirt', count: 1196, removable: 1196, natural: true }, { id: 'minecraft:planks', name: 'Oak Wood Planks', count: 35, removable: 35 }],
    })
    const planks = await s.run('check_blueprint', { name: '02_Workshop_v3', x: -592, y: 63, z: 80, clear: ['natural', 'minecraft:planks'] })
    assert.match(planks.content, /this clear list would dig out blocks that are not natural terrain \(35× minecraft:planks "Oak Wood Planks"\)\. Someone may have built them\./)
  })

  it('build_blueprint 启动 blueprint 任务：位置、分块范围、方块选项、补给和卸货的容器原样带过去；queue 时排到队尾', async (t) => {
    const s = setup(t)
    const res = await s.run('build_blueprint', {
      name: '02_Workshop_v3', x: -592, y: 63, z: 80,
      x1: -592, x2: -561, z1: 80, z2: 111, y1: 63, y2: 68,
      skip: ['minecraft:carpet'], clear: ['natural', 'plants'],
      supply: [{ x: -600, y: 64, z: 70 }, { x: -598, y: 64, z: 70 }], dropoff: [{ x: -600, y: 64, z: 72 }], overflow: 'leave',
      queue: true,
    })
    assert.match(res.content, /Task t1 \(blueprint\) added to the end of your queue/)
    assert.deepEqual(s.game.callsOf('task.start'), [
      {
        bot: 'Alu',
        task: {
          type: 'blueprint', name: '02_Workshop_v3', x: -592, y: 63, z: 80,
          x1: -592, x2: -561, z1: 80, z2: 111, y1: 63, y2: 68,
          skip: ['minecraft:carpet'], clear: ['natural', 'plants'],
          supply: [{ x: -600, y: 64, z: 70 }, { x: -598, y: 64, z: 70 }], dropoff: [{ x: -600, y: 64, z: 72 }], overflow: 'leave',
        },
        mode: 'append',
      },
    ])
    // 不给 clear 就不带 clear：身体那边不给就一块都不挖
    await s.run('build_blueprint', { name: 'hut', x: 20, y: 65, z: 20 })
    assert.deepEqual(s.game.callsOf('task.start')[1], { bot: 'Alu', task: { type: 'blueprint', name: 'hut', x: 20, y: 65, z: 20 }, mode: 'replace' })
    assert.deepEqual(s.started, ['t1', 't2'])
  })

  it('模型把“不限制”写成空列表时当作没给（身体那边 only: [] 的意思是哪种方块都不管）', async (t) => {
    const s = setup(t)
    s.game.handlers['blueprint.check'] = () => WORKSHOP_CHECK
    const check = await s.run('check_blueprint', { name: 'hut', x: 20, y: 65, z: 20, only: [], skip: [], clear: [] })
    assert.deepEqual(s.game.callsOf('blueprint.check'), [{ name: 'hut', x: 20, y: 65, z: 20, bot: 'Alu' }])
    assert.match(check.content, /No clear list was given/)
    await s.run('build_blueprint', { name: 'hut', x: 20, y: 65, z: 20, only: [], skip: [], clear: [] })
    assert.deepEqual(s.game.callsOf('task.start')[0]!.task, { type: 'blueprint', name: 'hut', x: 20, y: 65, z: 20 })
  })

  it('图纸超过 64×64 列、没有这张图纸时，身体的原话转给模型', async (t) => {
    const s = setup(t)
    // 真实 mod 的原话
    const tooWide = 'one task works on at most 64x64 columns and this covers 160x160; give x1, x2, z1, z2 to take it a part at a time'
    const unknown = 'there is no blueprint named "castle"; blueprint.list shows the ones there are'
    s.game.handlers['task.start'] = () => {
      throw new BridgeError('bad_request', tooWide)
    }
    s.game.handlers['blueprint.check'] = () => {
      throw new BridgeError('bad_request', unknown)
    }
    const build = await s.run('build_blueprint', { name: '99_Campus_Reference_v2', x: 0, y: 64, z: 0 })
    assert.equal(build.isError, true)
    assert.ok(build.content.includes(tooWide), build.content)
    assert.deepEqual(s.started, [])
    const check = await s.run('check_blueprint', { name: 'castle', x: 0, y: 64, z: 0 })
    assert.equal(check.isError, true)
    assert.ok(check.content.includes(unknown), check.content)
  })

  it('task_status 里照图纸建的任务：缺的材料和现在的对比是整理过的文字，不是截掉半截的 JSON', async (t) => {
    const s = setup(t)
    s.game.handlers['task.list'] = () => ({
      active: null,
      queue: [],
      recent: [
        {
          id: 't7', type: 'blueprint', state: 'failed', finishedAt: 100,
          error: {
            code: 'no_material',
            message: '1874 blocks were left unplaced for want of material; no supply container was given',
            detail: { missing: [{ id: 'chisel:nucrete', meta: 7, name: 'Structural Concrete', count: 1874 }] },
          },
          result: {
            removed: 4019, placed: 1949, freeSlots: 3,
            now: { cells: 5294, done: 1959, toPlace: 1874, byHand: 2, blocked: 265, extra: 14 },
            materials: [{ id: 'chisel:nucrete', meta: 7, name: 'Structural Concrete', need: 1874, have: 0 }],
            byHandBlocks: [{ id: 'minecraft:chest', meta: 3, name: 'Chest', count: 2, why: 'it holds contents or settings' }],
            blockedBy: [{ id: 'minecraft:stone', name: 'Stone', count: 265, removable: 0 }],
            extraBlocks: [{ id: 'gregtech:gt.blockmachines', name: 'gt.blockmachines.name', count: 14, removable: 0, holdsData: 14 }],
          },
        },
      ],
    })
    const text = (await s.run('task_status')).content
    assert.match(text, /- t7 blueprint \[failed\] error=no_material: 1874 blocks were left unplaced for want of material; no supply container was given; missing \(left unplaced for want of material\): 1874× chisel:nucrete\/7 "Structural Concrete"/)
    assert.match(text, /partial result: removed 4019, placed 1949, freeSlots 3; now \(the world compared with the blueprint\): cells 5294, done 1959, toPlace 1874, byHand 2, blocked 265, extra 14/)
    // 排在最后的那张表也完整地在
    assert.match(text, /extraBlocks \(still where the blueprint is empty\): 14× gregtech:gt\.blockmachines \(not natural terrain, clear digs 0, 14 of them hold data and are never dug\)$/m)
  })
})

const GT = 'gregtech:gt.metaitem.01'

/** recipe.find 的结果，形状照 docs/PROTOCOL.md：Copter Blades 只有合成台配方，其中一条读不出原料。 */
const BLADES_RECIPES = {
  item: { id: 'adventurebackpack:backpackComponent', meta: 6, name: 'Copter Blades' },
  crafting: [
    {
      index: 0,
      gives: 1,
      grid: '3x3',
      ingredients: [
        { count: 4, name: 'Shaft (Refined Iron)', id: 'IC2:itemRecipePart', meta: 12, have: 0 },
        { count: 3, name: 'Steel Screw (any screwSteel)', ore: 'screwSteel', example: { id: GT, meta: 27305 }, have: 2 },
        { count: 1, name: 'Single Use Screwdriver (any craftingToolScrewdriver)', ore: 'craftingToolScrewdriver', example: { id: 'gregtech:gt.metatool.01', meta: 22 }, alternatives: 6, tool: true, have: 0 },
        // 没有 meta：任何颜色的羊毛都行
        { count: 2, name: 'Wool (any variant)', id: 'minecraft:wool', have: 5 },
      ],
    },
    { index: 1, gives: 2, unreadable: true },
  ],
  machines: [],
  total: { crafting: 2, machines: 0, smelting: 0 },
}

/** Steel Screw 只有机器配方：车床一条，流体固化机三条（默认每种机器最多列两条）。 */
const SCREW_RECIPES = {
  item: { id: GT, meta: 27305, name: 'Steel Screw' },
  crafting: [],
  machines: [
    { machine: 'Lathe', tier: 'LV', eut: 16, seconds: 2.5, inputs: [{ id: GT, meta: 26305, name: 'Steel Bolt', count: 1 }], outputs: [{ id: GT, meta: 27305, name: 'Steel Screw', count: 1 }] },
    {
      machine: 'Fluid Solidifier',
      tier: 'ULV',
      eut: 8,
      seconds: 1.6,
      inputs: [{ id: GT, meta: 32307, name: 'Mold (Screw)', count: 0, notConsumed: true }],
      fluidInputs: [{ name: 'Molten Steel', mb: 18 }],
      outputs: [{ id: GT, meta: 27305, name: 'Steel Screw', count: 1 }],
    },
    {
      machine: 'Fluid Solidifier',
      tier: 'LV',
      eut: 24,
      seconds: 0.8,
      inputs: [{ id: GT, meta: 32307, name: 'Mold (Screw)', count: 0, notConsumed: true }],
      fluidInputs: [{ name: 'Molten Steel', mb: 18 }],
      outputs: [{ id: GT, meta: 27305, name: 'Steel Screw', count: 1 }],
      fluidOutputs: [{ name: 'Steam', mb: 40 }],
    },
  ],
  machineRecipeCounts: { Lathe: 1, 'Fluid Solidifier': 3 },
  smeltedFrom: [{ id: GT, meta: 2305, name: 'Steel Dust', count: 1 }],
  total: { crafting: 0, machines: 4, smelting: 1 },
}

describe('物品、配方、库存、合成', () => {
  it('find_item 按名字找物品：给出 id/meta、名字、各类配方有几条、矿辞名；中文名搜不到时提醒用英文名', async (t) => {
    const s = setup(t)
    s.game.handlers['item.search'] = (p) =>
      p.query === 'copter'
        ? {
            items: [
              { id: 'adventurebackpack:copterPack', meta: 0, name: 'Copter Pack', recipes: { crafting: 1, machine: 0, smelting: 0 } },
              { id: 'adventurebackpack:backpackComponent', meta: 6, name: 'Copter Blades', recipes: { crafting: 1, machine: 0, smelting: 0 } },
              { id: GT, meta: 27305, name: 'Steel Screw', recipes: { crafting: 0, machine: 4, smelting: 1 }, ores: ['screwSteel'] },
              { id: 'IC2:itemRecipePart', meta: 12, name: 'Shaft (Refined Iron)', recipes: { crafting: 0, machine: 0, smelting: 0 } },
            ],
          }
        : { items: [] }
    const found = await s.run('find_item', { query: ' copter ', limit: 20 })
    assert.equal(found.isError, undefined)
    assert.deepEqual(s.game.callsOf('item.search'), [{ query: 'copter', limit: 20 }])
    assert.match(found.content, /^- adventurebackpack:copterPack "Copter Pack": recipes: 1 crafting$/m)
    assert.match(found.content, /^- adventurebackpack:backpackComponent\/6 "Copter Blades": recipes: 1 crafting$/m)
    assert.match(found.content, /^- gregtech:gt\.metaitem\.01\/27305 "Steel Screw": recipes: 4 machine, 1 smelting; ore names: screwSteel$/m)
    assert.match(found.content, /^- IC2:itemRecipePart\/12 "Shaft \(Refined Iron\)": no known recipe$/m)

    const none = await s.run('find_item', { query: '直升机背包' })
    assert.match(none.content, /No item has all the words of "直升机背包"/)
    assert.match(none.content, /names on this server are in English: translate the name/)
    assert.equal(/in English/.test((await s.run('find_item', { query: 'helicopter' })).content), false)
  })

  it('find_recipes：合成配方里每样原料写清要几个、是确定的物品还是“任何 xxx”、是不是只磨损的工具、身上已有几个', async (t) => {
    const s = setup(t)
    s.game.handlers['recipe.find'] = () => BLADES_RECIPES
    const res = await s.run('find_recipes', { id: 'adventurebackpack:backpackComponent', meta: 6 })
    assert.equal(res.isError, undefined)
    // 带上 bot，身体才会给出它身上现有的数量
    assert.deepEqual(s.game.callsOf('recipe.find'), [{ id: 'adventurebackpack:backpackComponent', meta: 6, bot: 'Alu' }])
    const text = res.content
    assert.match(text, /^Recipes for adventurebackpack:backpackComponent\/6 "Copter Blades": 2 crafting, 0 machine, 0 smelting\.$/m)
    assert.match(text, /^- recipe 0: gives 1, 3x3 grid \(needs a crafting table or crafting station\)\. Ingredients for one round:$/m)
    assert.match(text, /^  - 4× IC2:itemRecipePart\/12 "Shaft \(Refined Iron\)", you carry 0$/m)
    assert.match(text, /^  - 3× any screwSteel \(ore name; e\.g\. gregtech:gt\.metaitem\.01\/27305 "Steel Screw"\), you carry 2$/m)
    assert.match(
      text,
      /^  - 1× any craftingToolScrewdriver \(ore name, 6 kinds fit; e\.g\. gregtech:gt\.metatool\.01\/22 "Single Use Screwdriver"\) \[tool: must be in your inventory, wears but is not used up\], you carry 0$/m,
    )
    assert.match(text, /^  - 2× minecraft:wool \(any meta\) "Wool \(any variant\)", you carry 5$/m)
    // 读不出原料的配方如实说明 craft_item 做不了
    assert.match(text, /^- recipe 1: its ingredients cannot be read .* craft_item cannot make it$/m)
    assert.equal(/"ingredients"|"example"|\{"count"/.test(text), false)
  })

  it('find_recipes：机器配方写清机器、等级、电压、耗时、原料（标出不消耗的）、流体、产物；每种机器有几条压成一行', async (t) => {
    const s = setup(t)
    s.game.handlers['recipe.find'] = () => SCREW_RECIPES
    const text = (await s.run('find_recipes', { id: GT, meta: 27305 })).content
    assert.match(text, /^Crafting by hand: no recipe\. craft_item cannot make it\.$/m)
    // 机器配方现在能自己做：说明用哪个工具、挑什么样的机器
    assert.match(text, /^Machine recipes \(run one with process_items on a single-block machine that find_machines lists with this recipe type and at least this tier/m)
    assert.match(text, /^- Lathe, LV \(16 EU\/t\), 2\.5 s: 1× gregtech:gt\.metaitem\.01\/26305 "Steel Bolt" -> 1× gregtech:gt\.metaitem\.01\/27305 "Steel Screw"$/m)
    assert.match(
      text,
      /^- Fluid Solidifier, ULV \(8 EU\/t\), 1\.6 s: gregtech:gt\.metaitem\.01\/32307 "Mold \(Screw\)" \(stays in the machine, not used up\) \+ 18 mB Molten Steel -> 1× gregtech:gt\.metaitem\.01\/27305 "Steel Screw"$/m,
    )
    assert.match(text, /^- Fluid Solidifier, LV \(24 EU\/t\), 0\.8 s: .* -> 1× gregtech:gt\.metaitem\.01\/27305 "Steel Screw" \+ 40 mB Steam$/m)
    assert.match(text, /^Machine recipes per machine: Lathe 1, Fluid Solidifier 3\. 3 of 4 shown; give "way" \(a machine name\) to see the recipes of one machine\.$/m)
    assert.match(text, /^Furnace: smelted from 1× gregtech:gt\.metaitem\.01\/2305 "Steel Dust"\.$/m)

    // 只看某一种机器的
    await s.run('find_recipes', { id: GT, meta: 27305, way: 'Fluid Solidifier' })
    assert.deepEqual(s.game.callsOf('recipe.find')[1], { id: GT, meta: 27305, machine: 'Fluid Solidifier', bot: 'Alu' })
  })

  it('find_recipes：没有任何做法的物品、服务器不认识的 id，都说清楚下一步', async (t) => {
    const s = setup(t)
    s.game.handlers['recipe.find'] = () => ({ item: { id: 'IC2:itemRecipePart', meta: 12, name: 'Shaft (Refined Iron)' }, crafting: [], machines: [], total: { crafting: 0, machines: 0, smelting: 0 } })
    const raw = await s.run('find_recipes', { id: 'IC2:itemRecipePart', meta: 12 })
    assert.match(raw.content, /^No recipe is known for IC2:itemRecipePart\/12 "Shaft \(Refined Iron\)".*Look for it in storage or ask the owner\.$/)
    // 真实 mod 的原话里说的是协议方法名 item.search；模型只认得工具名
    s.game.handlers['recipe.find'] = () => {
      throw new BridgeError('not_found', 'no such item is known: gregtech:gt.metaitem.01/0; item.search finds ids')
    }
    const unknown = await s.run('find_recipes', { id: GT })
    assert.equal(unknown.isError, true)
    assert.match(unknown.content, /No item gregtech:gt\.metaitem\.01 is known on this server\. Use find_item to get the exact id and meta/)
  })

  it('find_in_storage：每样东西一共多少、在哪几处（坐标、容器、是不是抽屉、数量、具体是哪种物品）；没有的也说明', async (t) => {
    const s = setup(t)
    s.game.handlers['world.stock'] = () => ({
      items: [
        { id: 'IC2:itemRecipePart', meta: 12, total: 9, places: [{ x: -51, y: 99, z: -87, container: 'Chest', count: 8 }, { x: -47, y: 99, z: -83, container: 'Iron Chest', count: 1 }], morePlaces: 2 },
        {
          ore: 'screwSteel',
          total: 12804,
          places: [
            { x: -45, y: 99, z: -83, container: 'Oak Drawers 1x2', kind: 'drawers', count: 12800, items: [{ id: GT, meta: 27305, count: 12800, name: 'Steel Screw' }] },
            { x: -51, y: 99, z: -87, container: 'Chest', count: 4, items: [{ id: GT, meta: 27305, count: 3, name: 'Steel Screw' }, { id: 'TConstruct:toughRod', meta: 16, count: 1, name: 'Steel Tough Tool Rod' }] },
          ],
        },
        { id: 'minecraft:wool', total: 0, places: [] },
      ],
      containersLookedInto: 37,
    })
    const res = await s.run('find_in_storage', { items: [{ id: 'IC2:itemRecipePart', meta: 12 }, { ore: 'screwSteel' }, { id: 'minecraft:wool' }] })
    assert.equal(res.isError, undefined)
    // 没说看哪、看多远：看整个基地——以它站的 (10,64,-4) 为中心往四个斜方向各错开 48 格，各查 64 格；不带 meta 的就不带 meta（任何变体都算）
    const wanted = [{ id: 'IC2:itemRecipePart', meta: 12 }, { ore: 'screwSteel' }, { id: 'minecraft:wool' }]
    assert.deepEqual(s.game.callsOf('world.stock'), [[-38, -52], [-38, 44], [58, -52], [58, 44]].map(([x, z]) => ({ x, y: 64, z, dim: 0, items: wanted, radius: 64 })))
    const lines = res.content.split('\n')
    // 四次查询看到的是同一批容器：一个容器只算一次，数量不翻倍
    assert.match(lines[0]!, /^Looked into 37 container\(s\) within 112 blocks of you \(the whole base, as far as chunks are loaded\)\./)
    assert.deepEqual(lines.slice(1), [
      '- IC2:itemRecipePart/12: 9 in total',
      '  - (-51,99,-87) Chest: 8',
      '  - (-47,99,-83) Iron Chest: 1',
      '  - … and 2 more place(s) holding less',
      '- any screwSteel (ore name): 12804 in total',
      '  - (-45,99,-83) Oak Drawers 1x2 [drawers]: 12800 (12800× gregtech:gt.metaitem.01/27305 "Steel Screw")',
      '  - (-51,99,-87) Chest: 4 (3× gregtech:gt.metaitem.01/27305 "Steel Screw", 1× TConstruct:toughRod/16 "Steel Tough Tool Rod")',
      '- minecraft:wool (any meta): none in storage here',
    ])
  })

  it('find_in_storage：附近一个容器都没有时提醒先去仓库；每一项只能是物品 id 或矿辞名之一', async (t) => {
    const s = setup(t)
    s.game.handlers['world.stock'] = () => ({ items: [{ ore: 'screwSteel', total: 0, places: [] }], containersLookedInto: 0 })
    const nothing = await s.run('find_in_storage', { items: [{ ore: 'screwSteel' }], radius: 48 })
    assert.match(nothing.content, /no container within 48 blocks of you.*Look around where the storage is instead: give "at"/)
    for (const bad of [{}, { id: 'minecraft:wool', ore: 'blockWool' }, { meta: 3 }]) {
      const res = await s.run('find_in_storage', { items: [{ ore: 'screwSteel' }, bad] })
      assert.equal(res.isError, true)
      assert.match(res.content, /items\[1\] needs exactly one of "id" .* or "ore"/)
    }
    assert.equal(s.game.callsOf('world.stock').length, 1)
  })

  it('craft_item 启动 craft 任务：要几个、用第几条配方、用哪个工作台都带过去；只给 id 时其余用身体的默认值', async (t) => {
    const s = setup(t)
    const queued = await s.run('craft_item', { id: 'adventurebackpack:backpackComponent', meta: 6, count: 2, recipe: 1, table: { x: -49, y: 99, z: -85 }, queue: true })
    assert.match(queued.content, /Task t1 \(craft\) added to the end of your queue/)
    await s.run('craft_item', { id: 'minecraft:stick' })
    assert.deepEqual(s.game.callsOf('task.start'), [
      { bot: 'Alu', task: { type: 'craft', id: 'adventurebackpack:backpackComponent', meta: 6, count: 2, recipe: 1, table: { x: -49, y: 99, z: -85 } }, mode: 'append' },
      { bot: 'Alu', task: { type: 'craft', id: 'minecraft:stick' }, mode: 'replace' },
    ])
    assert.deepEqual(s.started, ['t1', 't2'])
  })

  it('服务器刚启动、配方索引还没建好（busy）时，模型得知没出错、过几秒再试', async (t) => {
    const s = setup(t)
    // 真实 mod 的原话
    const busy = () => {
      throw new BridgeError('busy', 'the recipe index is still being built; try again in a few seconds')
    }
    s.game.handlers['item.search'] = busy
    s.game.handlers['recipe.find'] = busy
    for (const res of [await s.run('find_item', { query: 'copter' }), await s.run('find_recipes', { id: GT, meta: 27305 })]) {
      assert.equal(res.isError, true)
      assert.match(res.content, /^busy: the recipe index is still being built; try again in a few seconds \(Nothing is wrong: .*again in a few seconds\.\)$/)
    }
  })

  it('find_machines：每台机器的坐标、名字、跑哪种配方、等级、有没有电、是不是正在忙或被关了；可以按名字筛', async (t) => {
    const s = setup(t)
    // world.machines 的结果，形状照 docs/PROTOCOL.md
    s.game.handlers['world.machines'] = (p) =>
      p.name === 'Centrifuge'
        ? { machines: [], total: 0 }
        : {
            machines: [
              { x: -40, y: 99, z: -80, name: 'Advanced Lathe', recipes: 'Lathe', tier: 'MV', inputSlots: 1, active: false, storedEU: 51200, inputVoltage: 128, dist: 5.4 },
              { x: -38, y: 99, z: -80, name: 'Basic Assembling Machine', recipes: 'Assembler', tier: 'LV', inputSlots: 6, active: false, storedEU: 0, inputVoltage: 0, dist: 7 },
              { x: -36, y: 99, z: -80, name: 'Basic Macerator', recipes: 'Macerator', tier: 'LV', inputSlots: 1, active: true, progress: 74, maxProgress: 200, storedEU: 900, inputVoltage: 32, dist: 9.2 },
              { x: -34, y: 99, z: -80, name: 'Basic Wiremill', recipes: 'Wiremill', tier: 'LV', inputSlots: 1, active: false, storedEU: 300, inputVoltage: 32, switchedOff: true, dist: 11 },
            ],
            total: 9,
          }
    const res = await s.run('find_machines')
    assert.equal(res.isError, undefined)
    // 以 bot 为中心
    assert.deepEqual(s.game.callsOf('world.machines'), [{ bot: 'Alu', radius: 32 }])
    const lines = res.content.split('\n')
    assert.match(lines[0]!, /^4 GregTech machine\(s\) within 32 blocks of you \(9 in range, the nearest 4 shown: give "name" or a smaller radius to see the others\), nearest first\./)
    assert.deepEqual(lines.slice(1), [
      '- (-40,99,-80) "Advanced Lathe": runs Lathe recipes, tier MV, has power (51200 EU stored), idle, 5 blocks away',
      '- (-38,99,-80) "Basic Assembling Machine": runs Assembler recipes, tier LV, NO POWER (0 EU stored), idle, 7 blocks away',
      '- (-36,99,-80) "Basic Macerator": runs Macerator recipes, tier LV, has power (900 EU stored), BUSY (37% of the current item done), 9 blocks away',
      '- (-34,99,-80) "Basic Wiremill": runs Wiremill recipes, tier LV, has power (300 EU stored), SWITCHED OFF, idle, 11 blocks away',
    ])

    const none = await s.run('find_machines', { name: ' Centrifuge ', radius: 48, limit: 5 })
    assert.deepEqual(s.game.callsOf('world.machines')[1], { bot: 'Alu', radius: 48, name: 'Centrifuge', limit: 5 })
    assert.match(none.content, /^No GregTech machine whose name or recipe type contains "Centrifuge" within 48 blocks of you/)
    // 没列出来不等于用不了：带界面的方块都能当机器用
    assert.match(none.content, /Any block with a screen can still be used as a machine: give its position to process_items, or open it with open_screen\./)
  })

  it('process_items 启动 process 任务：哪台机器、放进去什么（含不消耗的编程电路）、最多等多久；原料没写数量的不发出去', async (t) => {
    const s = setup(t)
    const machine = { x: -38, y: 99, z: -80 }
    const inputs = [
      { id: GT, meta: 32600, count: 2 },
      { id: GT, meta: 17305, count: 4 },
      // 编程电路：meta 就是它的编号；不消耗，数量 1
      { id: 'gregtech:gt.integrated_circuit', meta: 2, count: 1 },
    ]
    const res = await s.run('process_items', { machine, inputs, wait: 600, queue: true })
    assert.match(res.content, /Task t1 \(process\) added to the end of your queue/)
    await s.run('process_items', { machine, inputs: [{ id: GT, meta: 11305, count: 2 }] })
    assert.deepEqual(s.game.callsOf('task.start'), [
      { bot: 'Alu', task: { type: 'process', machine, inputs, wait: 600 }, mode: 'append' },
      { bot: 'Alu', task: { type: 'process', machine, inputs: [{ id: GT, meta: 11305, count: 2 }] }, mode: 'replace' },
    ])
    const noCount = await s.run('process_items', { machine, inputs: [{ id: GT, meta: 11305 }] })
    assert.equal(noCount.isError, true)
    assert.match(noCount.content, /inputs\[0\]\.count is required/)
    assert.equal(s.game.callsOf('task.start').length, 2)
  })

  it('task_status 里合成失败的任务：还缺的原料是整理过的文字（要几个、是什么、是不是工具）', async (t) => {
    const s = setup(t)
    s.game.handlers['task.list'] = () => ({
      active: null,
      queue: [],
      recent: [
        {
          id: 't5', type: 'craft', state: 'failed', finishedAt: 100,
          error: {
            code: 'no_material',
            message: 'the inventory lacks ingredients for 2 round(s) of this recipe',
            detail: {
              missing: [
                { count: 8, name: 'Shaft (Refined Iron)', id: 'IC2:itemRecipePart', meta: 12 },
                { count: 1, name: 'Single Use Screwdriver (any craftingToolScrewdriver)', ore: 'craftingToolScrewdriver', example: { id: 'gregtech:gt.metatool.01', meta: 22 }, alternatives: 6, tool: true },
              ],
            },
          },
          result: { crafted: 0, item: { id: 'adventurebackpack:backpackComponent', meta: 6, name: 'Copter Blades' }, freeSlots: 20 },
        },
      ],
    })
    const text = (await s.run('task_status')).content
    assert.match(
      text,
      /- t5 craft \[failed\] error=no_material: the inventory lacks ingredients for 2 round\(s\) of this recipe; missing \(not in your inventory, per ingredient\): 8× IC2:itemRecipePart\/12 "Shaft \(Refined Iron\)"; 1× any craftingToolScrewdriver \(ore name, 6 kinds fit; e\.g\. gregtech:gt\.metatool\.01\/22 "Single Use Screwdriver"\) \[tool: [^\]]*\]; partial result: crafted 0× adventurebackpack:backpackComponent\/6 "Copter Blades", freeSlots 20$/m,
    )
  })
})

describe('手册', () => {
  it('list_manuals 列出每本手册的名字和“什么时候看”；主人写的标出来', async (t) => {
    const s = setup(t)
    s.manuals.save({ name: '基地布局', summary: '要在基地里找仓库、机器、工作台时看。', body: '仓库在 (100,64,200) 一带，工作台在仓库门口。' })
    const res = await s.run('list_manuals')
    assert.equal(res.isError, undefined)
    const lines = res.content.split('\n')
    // 随代码发布的那几本，各带一句什么时候看
    for (const name of ['blueprint', 'crafting', 'containers', 'terrain', 'travel', 'quests']) {
      assert.ok(lines.some((l) => new RegExp(`^- ${name}: .{8,}`).test(l)), `lists ${name} with its one-line summary`)
    }
    assert.equal(lines.at(-1), '- 基地布局 (written by your owner): 要在基地里找仓库、机器、工作台时看。')
  })

  it('它把主人教的做法写成自己的手册（write_manual）：之后列得出、读得到，标着是它写的；盖不了默认的和主人写的；有长度和本数的上限', async (t) => {
    const s = setup(t)
    const saved = await s.run('write_manual', { name: '模具从哪来', when: '缺模具、模头的时候', text: '主人说：先看压模机的原料格。' })
    assert.equal(saved.content, 'Saved as your manual "模具从哪来" (14 characters). It is in the list of manuals from now on, and your owner can see and edit it on the control panel.')
    assert.match((await s.run('list_manuals')).content, /\n- 模具从哪来 \(written by you\): 缺模具、模头的时候$/m)
    assert.match((await s.run('read_manual', { name: '模具从哪来' })).content, /^Manual "模具从哪来" \(written by you, from what your owner taught you\): 缺模具、模头的时候\n\n主人说：先看压模机的原料格。\n/)
    // 用自己那本的名字再写：改写它
    await s.run('write_manual', { name: '模具从哪来', when: '缺模具、模头的时候', text: '主人说：先看压模机的原料格，拿之前问他。' })
    assert.match((await s.run('read_manual', { name: '模具从哪来' })).content, /拿之前问他。/)
    // 默认手册的名字、主人写的那本的名字：不让盖
    const builtin = await s.run('write_manual', { name: 'crafting', when: 'x', text: 'y' })
    assert.deepEqual([builtin.isError, builtin.content], [true, 'there already is a manual named "crafting" (a built-in one): pick another name for yours'])
    s.manuals.save({ name: '基地', summary: '找基地里的东西时', body: '仓库在南边。' })
    assert.match((await s.run('write_manual', { name: '基地', when: 'x', text: 'y' })).content, /^there already is a manual named "基地" \(written by your owner\)/)
    // 太长、写得太多本
    assert.match((await s.run('write_manual', { name: '长', when: 'x', text: '字'.repeat(4001) })).content, /^Invalid arguments|at most 4000/)
    for (let n = 2; n <= 20; n++) await s.run('write_manual', { name: `笔记${n}`, when: '第 n 本', text: '内容' })
    const full = await s.run('write_manual', { name: '第二十一本', when: 'x', text: 'y' })
    assert.match(full.content, /^you have written 20 manuals, the most you can keep \(20\): rewrite one of yours instead/)
  })

  it('read_manual 给出整本手册，比“单个工具结果上限”长也不截断；主人改过的默认手册读到的是主人的那份', async (t) => {
    const s = setup(t)
    const whole = await s.run('read_manual', { name: 'blueprint' }, 300)
    assert.equal(whole.isError, undefined)
    assert.match(whole.content, /^Manual "blueprint": /)
    assert.match(whole.content, /check_blueprint/)
    assert.ok(whole.content.length > 1000, 'the whole manual, not the first 300 characters')
    assert.equal(whole.content.includes('[truncated'), false)
    assert.match(whole.content, /\[end of manual "blueprint", version [0-9a-f]{8}\]$/)

    s.manuals.save({ name: 'blueprint', summary: '盖房子之前看（我们服的规矩）。', body: '一律先问我，不许自己清场。' })
    const mine = await s.run('read_manual', { name: 'blueprint' })
    assert.match(mine.content, /^Manual "blueprint" \(written by your owner\): 盖房子之前看（我们服的规矩）。\n\n一律先问我，不许自己清场。\n\n\[end of manual/)
  })

  it('read_manual：没有这本手册时列出有哪些', async (t) => {
    const s = setup(t)
    const res = await s.run('read_manual', { name: 'cooking' })
    assert.equal(res.isError, true)
    assert.match(res.content, /There is no manual named "cooking"\. The manuals are: .*blueprint.*quests/)
  })
})

// 本地没有任务书资料时的退路：整件事问服务器（英文）。读本地资料的那条正路在 packdata.test.ts。
describe('任务书（本地没有资料，问服务器）', () => {
  it('list_quest_lines：每章的总数、主人已完成的和现在能做的', async (t) => {
    const s = setup(t)
    s.who.defaultPlayer = 'Steve'
    s.game.handlers['quest.lines'] = () => ({
      lines: [
        { name: 'Tier 0 - Stone Age', quests: 52, complete: 45, available: 3 },
        { name: 'Tier 0.5 - Steam', quests: 80, complete: 12, available: 8 },
      ],
      quests: 3814,
    })
    const res = await s.run('list_quest_lines')
    assert.equal(res.isError, undefined)
    // 模型没说看谁的：看主人的
    assert.deepEqual(s.game.callsOf('quest.lines'), [{ player: 'Steve' }])
    assert.match(res.content, /The quest book has 3814 quests in 2 chapters.*Progress of Steve per chapter: done \/ can be done now \/ total\./)
    assert.match(res.content, /^- Tier 0 - Stone Age: 45 \/ 3 \/ 52$/m)
    assert.match(res.content, /^- Tier 0\.5 - Steam: 12 \/ 8 \/ 80$/m)
  })

  it('find_quests：可以只按状态列（主人现在能做的），也可以按章节和词筛；结果是 id、标题、章节、状态', async (t) => {
    const s = setup(t)
    s.who.defaultPlayer = 'Steve'
    s.game.handlers['quest.search'] = () => ({
      quests: [
        { id: '43', name: 'Wired, Weird?!', line: 'Tier 0.5 - Steam', state: 'available' },
        { id: 'a81f1f2c-3d7e-4a4c-9a55-1f2e3d4c5b6a', name: 'Night Watch', line: 'Tier 0 - Stone Age', state: 'available' },
      ],
      total: 57,
    })
    const available = await s.run('find_quests', { state: 'available' })
    assert.deepEqual(s.game.callsOf('quest.search')[0], { state: 'available', player: 'Steve' })
    assert.match(available.content, /^57 quests match \(state available\) for Steve; the first 2 are shown\./)
    assert.match(available.content, /^- 43 "Wired, Weird\?!" \[Tier 0\.5 - Steam\]: available$/m)
    assert.match(available.content, /^- a81f1f2c-3d7e-4a4c-9a55-1f2e3d4c5b6a "Night Watch" \[Tier 0 - Stone Age\]: available$/m)

    await s.run('find_quests', { query: ' electric motor ', line: 'Steam', state: 'complete', player: 'Alex', limit: 40 })
    assert.deepEqual(s.game.callsOf('quest.search')[1], { query: 'electric motor', line: 'Steam', state: 'complete', player: 'Alex', limit: 40 })

    // 搜不到，而且用的是中文词：这条退路上搜的是服务器那本英文的任务书
    s.game.handlers['quest.search'] = () => ({ quests: [], total: 0 })
    const none = await s.run('find_quests', { query: '电动马达' })
    assert.match(none.content, /No quest matches \(words "电动马达"\) for Steve\. The local quest book data is not loaded, so this search ran on the game server, whose quest book is in English: search with English words\./)
    // 服务器那边只给前几个，翻不了页
    const paged = await s.run('find_quests', { state: 'available', page: 2 })
    assert.equal(paged.isError, true)
    assert.match(paged.content, /Pages are not available: the local quest book data is not loaded/)
    assert.equal(s.game.callsOf('quest.search').length, 3)
    // 服务器只会按三种状态筛；“奖励没领”的要本地资料
    const unclaimed = await s.run('find_quests', { state: 'unclaimed' })
    assert.equal(unclaimed.isError, true)
    assert.match(unclaimed.content, /state "unclaimed" is not available: the local quest book data is not loaded/)
    assert.equal(s.game.callsOf('quest.search').length, 3)
  })

  it('get_quest：说明、前置任务完成没、每个子任务要什么（类型、物品、是否收走、完成没）、奖励', async (t) => {
    const s = setup(t)
    s.who.defaultPlayer = 'Steve'
    // docs/PROTOCOL.md 里的例子，补全了省略的部分
    s.game.handlers['quest.get'] = () => ({
      id: '47',
      name: 'Basic Crafting: Motors',
      line: 'Tier 0.5 - Steam',
      description: 'Motors are little devices that turn electricity\ninto motion.',
      state: 'complete, reward unclaimed',
      requires: [{ id: '43', name: 'Wired, Weird?!', complete: true }, { id: '44', name: 'Magnets', complete: false }],
      tasks: [
        { type: 'crafting', complete: true, items: [{ id: 'gregtech:gt.metaitem.01', meta: 32600, count: 2, name: 'Electric Motor (LV)' }] },
        { type: 'optional_retrieval', complete: false, consumed: false, items: [{ id: 'minecraft:log', count: 4, name: 'Oak Wood', ore: 'logWood' }] },
        { type: 'retrieval', complete: false, consumed: true, items: [{ id: 'minecraft:iron_ingot', meta: 0, count: 8, name: 'Iron Ingot' }] },
        { type: 'hunt', complete: false, target: 'Zombie', count: 10 },
        { type: 'location', complete: false, location: { x: 120, y: 70, z: -340, dim: 0 } },
        { type: 'fluid', complete: false, fluids: [{ fluid: 'water', mb: 1000 }] },
      ],
      rewards: [{ type: 'item', items: [{ id: 'gregtech:gt.metaitem.01', meta: 32000, count: 15, name: 'Copper Coin' }] }],
    })
    const res = await s.run('get_quest', { id: ' 47 ' })
    assert.deepEqual(s.game.callsOf('quest.get'), [{ id: '47', player: 'Steve' }])
    const lines = res.content.split('\n')
    assert.deepEqual(lines, [
      'Quest 47 "Basic Crafting: Motors", chapter "Tier 0.5 - Steam". State for Steve: complete, reward unclaimed (done; the reward has not been collected).',
      'Description: Motors are little devices that turn electricity into motion.',
      'Requires these quests to be complete first:',
      '- 43 "Wired, Weird?!": done',
      '- 44 "Magnets": NOT done',
      'Tasks (what the quest asks for):',
      '- crafting, done: 2× gregtech:gt.metaitem.01/32600 "Electric Motor (LV)"',
      '- optional_retrieval, not done, the items are kept: 4× minecraft:log (any meta) "Oak Wood" (or any logWood)',
      '- retrieval, not done, the items are taken when handed in: 8× minecraft:iron_ingot "Iron Ingot"',
      '- hunt, not done: kill 10× Zombie',
      '- location, not done: be at (120,70,-340) in overworld (dim 0)',
      '- fluid, not done: 1000 mB water',
      'Rewards:',
      '- item: 15× gregtech:gt.metaitem.01/32000 "Copper Coin"',
    ])
  })

  it('看谁的进度：没有默认的人就不带 player；按状态筛却不知道看谁的，说明要给 player', async (t) => {
    const s = setup(t)
    s.game.handlers['quest.lines'] = () => ({ lines: [{ name: 'Tier 0 - Stone Age', quests: 52 }], quests: 3814 })
    s.game.handlers['quest.search'] = () => ({ quests: [], total: 0 })
    const lines = await s.run('list_quest_lines')
    assert.deepEqual(s.game.callsOf('quest.lines'), [{}])
    assert.match(lines.content, /no player given, so no progress/)
    assert.match(lines.content, /^- Tier 0 - Stone Age: 52$/m)
    const byState = await s.run('find_quests', { state: 'available' })
    assert.equal(byState.isError, true)
    assert.match(byState.content, /needs a player whose progress to look at: give "player"/)
    assert.equal(s.game.callsOf('quest.search').length, 0)
  })

  it('默认要看的那个玩家任务书不认识（从没进过服务器）时，照样给出不带进度的结果并说明；服务器没装任务书时说清楚', async (t) => {
    const s = setup(t)
    s.who.defaultPlayer = 'Ghost'
    // 真实 mod 的原话
    s.game.handlers['quest.lines'] = (p) => {
      if (p.player !== undefined) throw new BridgeError('not_found', 'the quest book knows no player named Ghost')
      return { lines: [{ name: 'Tier 0 - Stone Age', quests: 52 }], quests: 3814 }
    }
    const res = await s.run('list_quest_lines')
    assert.equal(res.isError, undefined)
    assert.deepEqual(s.game.callsOf('quest.lines'), [{ player: 'Ghost' }, {}])
    assert.match(res.content, /^- Tier 0 - Stone Age: 52$/m)
    assert.match(res.content, /the quest book does not know a player named Ghost, so no progress is shown/)
    // 模型自己点名要看的人不认识：原样报错，不悄悄换成别的
    const named = await s.run('list_quest_lines', { player: 'Ghost' })
    assert.equal(named.isError, true)
    assert.match(named.content, /knows no player named Ghost/)

    s.game.handlers['quest.get'] = () => {
      throw new BridgeError('not_found', 'this server has no quest book (BetterQuesting)')
    }
    const noBook = await s.run('get_quest', { id: '47' })
    assert.equal(noBook.isError, true)
    assert.match(noBook.content, /This server has no quest book/)
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
      manuals: new ManualStore(DEFAULT_MANUALS_DIR, path.join(tmp.dir, 'manuals')),
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
