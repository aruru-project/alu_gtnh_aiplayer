// 看仓库和“主人指着说”：容器一页一页列、抽屉管理器管着的每一格、一片仓库合成一张存货总表；
// 说话的人站在哪、指着什么；服务器回来的名字换成本地物品表的中文名。
// 入口是模型用的工具和 agent 给模型的那条消息；游戏是按方法名应答的假服务器。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { eventLine, fromBridgeEvent } from '../src/agent/events.ts'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import type { ContainerInfo } from '../src/bridge/protocol.ts'
import { loadPackData } from '../src/packdata/index.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { useLocalNames } from '../src/tools/format.ts'
import { ROUTINE_BLOCKED_TOOLS } from '../src/agent/routine.ts'
import { ALL_TOOLS, QUERY_TOOLS, runTool } from '../src/tools/index.ts'
import type { ToolContext, ToolResult } from '../src/tools/index.ts'
import { DEFAULT_MANUALS_DIR, FakeGame, chat, makeAgent, reply } from './agent-harness.ts'
import { writeRecipeFixture } from './fixture-recipes.ts'
import { tmpDir } from './helpers.ts'

const NOW = 1_800_000_000_000

function setup(t: { after(fn: () => void): void }, opts: { names?: boolean } = {}) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  if (opts.names) {
    writeRecipeFixture(tmp.dir)
    const packdata = loadPackData(tmp.dir)
    useLocalNames(packdata.items)
    t.after(() => {
      useLocalNames(undefined)
      packdata.recipes?.close()
    })
  }
  const game = new FakeGame()
  const ctx: ToolContext = {
    botName: 'Alu',
    bridge: new BridgeApi(game),
    memory: new MemoryStore(tmp.dir, () => 300),
    manuals: new ManualStore(DEFAULT_MANUALS_DIR, `${tmp.dir}/manuals`),
    reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
    hooks: {},
    now: () => NOW,
  }
  const run = (name: string, input: unknown = {}): Promise<ToolResult> => runTool(ALL_TOOLS, ctx, name, input, { maxResultChars: 6000 })
  return { game, run }
}

const chest = (n: number, items: ContainerInfo['items'] = [], extra: Partial<ContainerInfo> = {}): ContainerInfo => ({ x: n, y: 64, z: 0, id: 'minecraft:chest', name: 'Chest', slots: 27, usedSlots: items.length, items, ...extra })
const COAL = { id: 'minecraft:coal', meta: 0, name: 'Coal' }
const STEEL = { id: 'gregtech:gt.metaitem.01', meta: 11305, name: 'Steel Ingot' }

/** 像身体那样翻页：从 offset 起给 limit 个，total 是全部。 */
function paged(all: ContainerInfo[]) {
  return (p: Record<string, unknown>) => {
    const offset = Number(p.offset ?? 0)
    return { containers: all.slice(offset, offset + Number(p.limit ?? 40)), total: all.length, offset }
  }
}

/**
 * 像身体那样回答 world.containers：只有中心周围 radius 格（每个方向）以内的才算，radius 0 就是中心那一格上的容器；
 * 每个容器最多列 kinds 种（默认 60），没列的记在 moreKinds 里。中心是 {bot} 时就是它站的地方 (10,64,-4)。
 */
function body(all: ContainerInfo[]) {
  return (p: Record<string, unknown>) => {
    const at = typeof p.bot === 'string' ? { x: 10, y: 64, z: -4 } : { x: Number(p.x), y: Number(p.y), z: Number(p.z) }
    const radius = Number(p.radius ?? 12)
    const kinds = Number(p.kinds ?? 60)
    const near = all.filter((c) => Math.max(Math.abs(c.x - at.x), Math.abs(c.y - at.y), Math.abs(c.z - at.z)) <= radius)
    const offset = Number(p.offset ?? 0)
    const listed = near.slice(offset, offset + Number(p.limit ?? 40)).map((c) => ((c.items ?? []).length > kinds ? { ...c, items: c.items!.slice(0, kinds), moreKinds: c.items!.length - kinds } : c))
    return { containers: listed, total: near.length, offset }
  }
}

describe('list_containers：容器一页一页列', () => {
  it('写明这是多少个里的第几到第几个；翻到下一页；没有那一页时说有几页', async (t) => {
    const s = setup(t)
    s.game.handlers['world.containers'] = paged(Array.from({ length: 45 }, (_, n) => chest(n, [{ ...COAL, count: n + 1 }])))
    const first = await s.run('list_containers', { radius: 24 })
    assert.deepEqual(s.game.callsOf('world.containers')[0], { bot: 'Alu', radius: 24, offset: 0, limit: 20, kinds: 2000 })
    const lines = first.content.split('\n')
    assert.equal(lines[0], 'Within 24 blocks of you: containers 1–20 of 45 (page 1 of 3), nearest first.')
    assert.equal(lines.length, 21)
    assert.equal(lines[1], '- (0,64,0) Chest [minecraft:chest] 1/27 slots used: 1× minecraft:coal "Coal"')
    const third = await s.run('list_containers', { radius: 24, page: 3 })
    assert.deepEqual(s.game.callsOf('world.containers')[1], { bot: 'Alu', radius: 24, offset: 40, limit: 20, kinds: 2000 })
    assert.equal(third.content.split('\n')[0], 'Within 24 blocks of you: containers 41–45 of 45 (page 3 of 3), nearest first.')
    assert.equal(third.content.split('\n').length, 6)
    const beyond = await s.run('list_containers', { radius: 24, page: 4 })
    assert.deepEqual([beyond.isError, beyond.content], [true, 'There is no page 4: 45 container(s) within 24 blocks, 3 page(s).'])
    s.game.handlers['world.containers'] = paged([])
    // 身边一个都没有：这不等于别处没有，提醒可以换个中心看
    assert.equal((await s.run('list_containers')).content, 'No containers within 16 blocks of you. If it is at some other place (where your owner is, or a position they named), look around that place: give "at".')
  })

  it('一个 102 种东西的大箱子：一页列好几个容器时每个只列前 30 种，并写明怎么看全；以它为中心、radius 0 就把 102 种全列出来；程序拿到的 data 一直是全的', async (t) => {
    const s = setup(t)
    const BIG = { x: 12, y: 64, z: -4 }
    const things = Array.from({ length: 102 }, (_, n) => ({ id: 'demo:thing', meta: n, name: `Thing ${n}`, count: 200 - n }))
    s.game.handlers['world.containers'] = body([{ ...BIG, id: 'IronChest:BlockIronChest', name: 'Compressed Chest', slots: 243, usedSlots: 102, items: things }, chest(14, [{ ...COAL, count: 5 }], { z: -4 })])

    // 附近两个容器：大箱子那一行只列前 30 种，末尾写明还有多少、怎么看全
    const around = await s.run('list_containers')
    const lines = around.content.split('\n')
    assert.equal(lines.length, 4)
    assert.match(lines[1]!, /^- \(12,64,-4\) Compressed Chest \[IronChest:BlockIronChest\] 102\/243 slots used: 200× demo:thing "Thing 0", .*, 171× demo:thing\/29 "Thing 29", … and 72 more kinds$/)
    assert.equal(lines[3], 'Where a line ends in "… more kinds", the rest is not shown here: list_containers with "at" that container and radius 0 lists everything in it (in a program, r.data.containers has every kind).')
    // 向身体要的是每个容器的全部，所以程序拿到的是全的
    assert.equal((around.data as { containers: ContainerInfo[] }).containers[0]!.items!.length, 102)

    // 就看这一个：102 种一样不少
    const whole = await s.run('list_containers', { at: BIG, radius: 0 })
    assert.deepEqual(s.game.callsOf('world.containers').at(-1), { ...BIG, dim: 0, radius: 0, offset: 0, limit: 20, kinds: 2000 })
    const text = whole.content.split('\n')
    assert.equal(text.length, 2)
    assert.equal(text[0], 'Within 0 blocks of (12,64,-4): 1 container(s).')
    assert.equal(text[1]!.split(': ')[1]!.split(', ').length, 102)
    assert.match(text[1]!, /, 99× demo:thing\/101 "Thing 101"$/)
    assert.doesNotMatch(whole.content, /more kinds/)

    // 看周围的概要里每个容器只列三种：也写明怎么把一个容器看全
    assert.match((await s.run('look_around')).content, /\nContainers \(2\), the 3 main kinds of each \(everything in one: list_containers with "at" it and radius 0\):\n- \(12,64,-4\) Compressed Chest [^\n]*, … and 99 more kinds\n/)

    // radius 0 要说是哪个容器；那里没有容器时如实说
    assert.deepEqual(await s.run('list_containers', { radius: 0 }), { content: 'radius 0 looks at one container: give its position as "at".', isError: true })
    assert.equal((await s.run('list_containers', { at: { x: 40, y: 64, z: 40 }, radius: 0 })).content, 'There is no container at (40,64,40).')
  })

  it('接着漏斗、管道的容器标成 AUTOMATED；抽屉写明归哪个管理器管；抽屉管理器自己不装东西，指到库函数 list_drawers；老的身体没列全的种类如实说', async (t) => {
    const s = setup(t)
    s.game.handlers['world.containers'] = paged([
      chest(1, [{ ...COAL, count: 5 }], { attached: [{ x: 1, y: 65, z: 0, name: 'Hopper', kind: 'hopper' }, { x: 2, y: 64, z: 0, name: 'Brass Item Pipe', kind: 'item pipe' }] }),
      { x: 5, y: 64, z: 0, id: 'StorageDrawers:fullDrawers2', name: 'Oak Drawers 1x2', kind: 'drawers', slots: 2, usedSlots: 1, items: [{ ...COAL, count: 12800 }], controller: { x: 9, y: 64, z: 0 } },
      { x: 9, y: 64, z: 0, id: 'StorageDrawers:controller', name: 'Drawer Controller', kind: 'drawer_controller', drawers: 120, slots: 353, usedSlots: 166, items: [] },
      chest(3, [{ ...COAL, count: 1 }], { moreKinds: 7 }),
    ])
    assert.deepEqual((await s.run('list_containers')).content.split('\n'), [
      'Within 16 blocks of you: 4 container(s).',
      '- (1,64,0) Chest [minecraft:chest] 1/27 slots used (AUTOMATED: Hopper at (1,65,0), Brass Item Pipe at (2,64,0) feeds or drains it): 5× minecraft:coal "Coal"',
      '- (5,64,0) Oak Drawers 1x2 [StorageDrawers:fullDrawers2] [drawers] 1/2 drawer slots used (managed by the drawer controller at (9,64,0)): 12800× minecraft:coal "Coal"',
      '- (9,64,0) Drawer Controller [StorageDrawers:controller] [drawer controller] 166/353 drawer slots used (manages 120 drawer block(s); the library function list_drawers lists what they hold, given this position)',
      '- (3,64,0) Chest [minecraft:chest] 1/27 slots used: 1× minecraft:coal "Coal", … and 7 more kinds',
      'Where a line ends in "… more kinds", the rest is not shown here: list_containers with "at" that container and radius 0 lists everything in it (in a program, r.data.containers has every kind).',
    ])
    // 老的身体不认“每个容器列多少种”：就看这一个也只拿得到它给的那些，照实说
    s.game.handlers['world.containers'] = paged([chest(3, [{ ...COAL, count: 1 }], { moreKinds: 7 })])
    assert.deepEqual((await s.run('list_containers', { at: { x: 3, y: 64, z: 0 }, radius: 0 })).content.split('\n').slice(1), [
      '- (3,64,0) Chest [minecraft:chest] 1/27 slots used: 1× minecraft:coal "Coal", … and 7 more kinds',
      'The game server did not list all of it (its mod is too old to list more than 60 kinds of a container). find_in_storage still finds a particular item in it.',
    ])
  })
})

describe('list_drawers：抽屉管理器管着的每一格', () => {
  it('每格是什么、真实数量、在哪个抽屉方块；below 只列少于某个数的；空格合成一句；翻页写明总数', async (t) => {
    const s = setup(t)
    s.game.handlers['world.drawers'] = (p) => ({
      controller: { x: 9, y: 64, z: 0 },
      drawers: 120,
      slotsTotal: 353,
      slotsUsed: 166,
      slots:
        p.below !== undefined
          ? [
              { x: -515, y: 70, z: 86, slot: 0, ...STEEL, count: 4, room: 2044 },
              { x: -516, y: 69, z: 91, slot: 1, ...COAL, count: 100, room: 1948 },
            ]
          : [{ x: -515, y: 70, z: 86, slot: 0, ...STEEL, count: 4, room: 2044 }, { x: -516, y: 69, z: 91, slot: 0, empty: true }, { x: -516, y: 69, z: 92, slot: 1, empty: true }],
      total: p.below !== undefined ? 54 : 3,
      offset: Number(p.offset ?? 0),
    })
    const low = await s.run('list_drawers', { x: 9, y: 64, z: 0, below: 128 })
    assert.deepEqual(s.game.callsOf('world.drawers')[0], { x: 9, y: 64, z: 0, below: 128, offset: 0, limit: 60 })
    assert.deepEqual(low.content.split('\n'), [
      'The drawer controller at (9,64,0) manages 120 drawer block(s): 166 of 353 slots hold something. These are slots holding fewer than 128 1–2 of 54 (page 1 of 1).',
      '- (-515,70,86) slot 0: 4× Steel Ingot [gregtech:gt.metaitem.01/11305], room for 2044 more',
      '- (-516,69,91) slot 1: 100× Coal [minecraft:coal], room for 1948 more',
    ])
    // 程序拿到的是数据（例程里一格一格搬靠它）
    assert.deepEqual((low.data as { slots: unknown[] }).slots[0], { x: -515, y: 70, z: 86, slot: 0, ...STEEL, count: 4, room: 2044 })
    const all = (await s.run('list_drawers', { x: 9, y: 64, z: 0 })).content.split('\n')
    assert.equal(all[0], 'The drawer controller at (9,64,0) manages 120 drawer block(s): 166 of 353 slots hold something. 3 slots:')
    assert.equal(all[2], '- 2 empty slot(s) with no item set: (-516,69,91) slot 0, (-516,69,92) slot 1')
    s.game.handlers['world.drawers'] = () => ({ controller: { x: 9, y: 64, z: 0 }, drawers: 2, slotsTotal: 4, slotsUsed: 4, slots: [], total: 0, offset: 0 })
    assert.equal((await s.run('list_drawers', { x: 9, y: 64, z: 0, below: 10 })).content, 'The drawer controller at (9,64,0) manages 2 drawer block(s): 4 of 4 slots hold something. No slots holding fewer than 10.')
  })
})

describe('list_stock：一片仓库合成一张存货总表', () => {
  it('把范围里的箱子和抽屉一页页读全，按物品合计，多的在前，写明主要在哪；机器和抽屉管理器不算；自动化容器里的标出来', async (t) => {
    const s = setup(t)
    const all: ContainerInfo[] = [
      // 130 个箱子：一页要 50 个（每个箱子里的东西都要全，一页不要太大），翻三页才读得全
      ...Array.from({ length: 130 }, (_, n) => chest(n, [{ ...COAL, count: 2 }])),
      { x: 200, y: 64, z: 0, id: 'StorageDrawers:fullDrawers2', name: 'Oak Drawers', kind: 'drawers', slots: 2, usedSlots: 2, items: [{ ...COAL, count: 5000 }, { ...STEEL, count: 40 }] },
      chest(201, [{ ...STEEL, count: 24 }], { attached: [{ x: 201, y: 65, z: 0, name: 'Hopper', kind: 'hopper' }] }),
      { x: 202, y: 64, z: 0, id: 'gregtech:gt.blockmachines', name: 'Basic Macerator', kind: 'machine', slots: 3, usedSlots: 1, items: [{ ...STEEL, count: 999 }] },
      { x: 203, y: 64, z: 0, id: 'StorageDrawers:controller', name: 'Drawer Controller', kind: 'drawer_controller', drawers: 1, slots: 2, usedSlots: 2, items: [] },
    ]
    s.game.handlers['world.containers'] = paged(all)
    const res = await s.run('list_stock', { radius: 32 })
    assert.deepEqual(s.game.callsOf('world.containers'), [
      { bot: 'Alu', radius: 32, offset: 0, limit: 50, kinds: 2000 },
      { bot: 'Alu', radius: 32, offset: 50, limit: 50, kinds: 2000 },
      { bot: 'Alu', radius: 32, offset: 100, limit: 50, kinds: 2000 },
    ])
    assert.deepEqual(res.content.split('\n'), [
      'Looked into 132 chest(s) and drawer(s) within 32 blocks of you (the own slots of 2 machine(s) and drawer controller(s) not counted): 2 kind(s) of item. 2 item(s), most first:',
      // 5000 + 130×2
      '- 5260× Coal [minecraft:coal]: (200,64,0) drawers 5000, (0,64,0) 2, and 129 more place(s)',
      '- 64× Steel Ingot [gregtech:gt.metaitem.01/11305]: (200,64,0) drawers 40, (201,64,0) AUTOMATED 24 (24 of them in automated containers)',
    ])
    assert.deepEqual((res.data as { items: { id: string; count: number }[] }).items.map((i) => [i.id, i.count]), [['minecraft:coal', 5260], ['gregtech:gt.metaitem.01', 64]])
  })

  it('大箱子里的东西一样不落：一个箱子 102 种，存货总表里 102 种都在，没有“没列全”的话', async (t) => {
    const s = setup(t)
    const things = Array.from({ length: 102 }, (_, n) => ({ id: 'demo:thing', meta: n, name: `Thing ${n}`, count: 200 - n }))
    s.game.handlers['world.containers'] = body([{ x: 12, y: 64, z: -4, id: 'IronChest:BlockIronChest', name: 'Compressed Chest', slots: 243, usedSlots: 102, items: things }])
    const res = await s.run('list_stock', { page: 3 })
    assert.deepEqual(res.content.split('\n').slice(0, 2), ['Looked into 1 chest(s) and drawer(s) within 16 blocks of you: 102 kind(s) of item. Items 81–102 of 102 (page 3 of 3), most first:', '- 120× Thing 80 [demo:thing/80]: (12,64,-4) 120'])
    assert.equal((res.data as { items: unknown[] }).items.length, 102)
  })

  it('按名字筛、只看少于某个数的、翻页；容器太多、或者老的身体没把容器列全时说明总数不全', async (t) => {
    const s = setup(t)
    // 50 种东西各放一个箱子，数量 1 到 50
    s.game.handlers['world.containers'] = paged(Array.from({ length: 50 }, (_, n) => chest(n, [{ id: 'demo:thing', meta: n, name: `Thing ${n}`, count: n + 1 }], n === 0 ? { moreKinds: 3 } : {})))
    const few = (await s.run('list_stock', { below: 4 })).content.split('\n')
    assert.match(few[0]!, /: 50 kind\(s\) of item\. The game server did not list everything in 1 container\(s\) \(its mod is too old to list more than 60 kinds of a container\): what it left out is missing from these totals\. find_in_storage still finds a particular item\. 3 item\(s\) with fewer than 4, most first:$/)
    assert.deepEqual(few.slice(1), ['- 3× Thing 2 [demo:thing/2]: (2,64,0) 3', '- 2× Thing 1 [demo:thing/1]: (1,64,0) 2', '- 1× Thing 0 [demo:thing]: (0,64,0) 1'])
    // 按名字、按 id 都筛得出
    assert.match((await s.run('list_stock', { contains: 'thing/49' })).content, /1 item\(s\) containing "thing\/49", most first:\n- 50× Thing 49 \[demo:thing\/49\]: \(49,64,0\) 50$/)
    assert.match((await s.run('list_stock', { contains: 'THING 7' })).content, /1 item\(s\) containing "THING 7", most first:\n- 8× Thing 7 /)
    const page2 = (await s.run('list_stock', { page: 2 })).content.split('\n')
    assert.match(page2[0]!, /Items 41–50 of 50 \(page 2 of 2\), most first:$/)
    assert.equal(page2.length, 11)
    assert.equal((await s.run('list_stock', { page: 3 })).content, 'There is no page 3: 50 item(s), 2 page(s).')
    assert.match((await s.run('list_stock', { contains: 'nothing-like-this' })).content, /None containing "nothing-like-this"\.$/)

    // 500 个容器：只读最近的 400 个，说明不全
    s.game.handlers['world.containers'] = paged(Array.from({ length: 500 }, (_, n) => chest(n, [{ ...COAL, count: 1 }])))
    const many = await s.run('list_stock', {})
    assert.match(many.content, /Only the nearest 400 of 500 containers were read: the totals are not complete\. Use a smaller radius\./)
    assert.match(many.content, /\n- 400× Coal \[minecraft:coal\]: /)
  })
})

describe('中文名：服务器回来的东西按本地物品表叫名字', () => {
  it('背包和箱子里的物品、机器、任务结果里的东西都用中文名；世界里的方块按服务器给的英文名在同一个 id 下对；物品表里没有的保持原样', async (t) => {
    const s = setup(t, { names: true })
    const status = s.game.handlers['bot.status']!
    s.game.handlers['bot.status'] = (p) => ({
      ...(status(p) as object),
      inventory: [
        { slot: 0, ...STEEL, count: 9 },
        // 服务器端没翻译的名字
        { slot: 1, id: 'gregtech:gt.metaitem.01', meta: 17305, count: 3, name: 'gt.metaitem.01.17305.name' },
        { slot: 2, id: 'somemod:unknown', meta: 0, count: 1, name: 'Mystery Thing' },
        // 同一个 id/meta 下每种材质一个变体的工具：物品表里只有其中一种的名字（“锤”，英文 Hammer）
        { slot: 3, id: 'gregtech:gt.metatool.01', meta: 12, count: 1, name: 'Steel Hammer', durability: 0.5 },
      ],
    })
    const mine = (await s.run('get_status')).content
    // 手里这件是另一种变体：用服务器给的名字，不拿表里那一种的名字顶替（否则钢镐会被叫成别的材质的镐）
    assert.match(mine, /Tools: 1× gregtech:gt\.metatool\.01\/12 "Steel Hammer" \(50% durability\)/)
    assert.match(mine, /9× gregtech:gt\.metaitem\.01\/11305 "钢锭"/)
    assert.match(mine, /3× gregtech:gt\.metaitem\.01\/17305 "钢板"/)
    assert.match(mine, /1× somemod:unknown "Mystery Thing"/)

    // 箱子：方块的 meta 是朝向，不是物品的 meta；靠 id 加英文名认出是“压缩箱子”
    s.game.handlers['world.containers'] = paged([{ x: 1, y: 64, z: 1, id: 'IronChest:BlockIronChest', name: 'Compressed Chest', slots: 243, usedSlots: 1, items: [{ ...STEEL, count: 64 }] }, chest(2), { x: 3, y: 64, z: 3, id: 'othermod:crate', name: 'Wooden Crate', slots: 9, usedSlots: 0, items: [] }])
    const boxes = (await s.run('list_containers')).content.split('\n')
    assert.equal(boxes[1], '- (1,64,1) 压缩箱子 [IronChest:BlockIronChest] 1/243 slots used: 64× gregtech:gt.metaitem.01/11305 "钢锭"')
    assert.equal(boxes[2], '- (2,64,0) 箱子 [minecraft:chest] 0/27 slots used: empty')
    assert.equal(boxes[3], '- (3,64,3) Wooden Crate [othermod:crate] 0/9 slots used: empty')
    assert.match((await s.run('list_stock')).content, /\n- 64× 钢锭 \[gregtech:gt\.metaitem\.01\/11305\]: \(1,64,1\) 64$/)

    // 程序拿到的 data 里也是游戏里的中文名（英文原名留在 en 里）：统计完不用自己翻译
    const data = (await s.run('list_containers')).data as { containers: { name: string; en?: string; items: { name: string; en?: string; id: string }[] }[] }
    assert.deepEqual(data.containers.map((c) => [c.name, c.en]), [['压缩箱子', 'Compressed Chest'], ['箱子', 'Chest'], ['Wooden Crate', undefined]])
    assert.deepEqual(data.containers[0]!.items, [{ ...STEEL, name: '钢锭', en: 'Steel Ingot', count: 64 }])
    const stock = (await s.run('list_stock')).data as { items: { name: string; en?: string }[] }
    assert.deepEqual([stock.items[0]!.name, stock.items[0]!.en], ['钢锭', 'Steel Ingot'])
    const mine2 = (await s.run('get_status')).data as { inventory: { slot: number; name: string; en?: string }[] }
    // 物品表里没有的保持原样；同一个 id/meta 下的另一种变体不拿表里那一种的名字顶替
    assert.deepEqual(mine2.inventory.map((i) => [i.name, i.en]), [['钢锭', 'Steel Ingot'], ['钢板', undefined], ['Mystery Thing', undefined], ['Steel Hammer', undefined]])

    s.game.handlers['world.machines'] = () => ({ machines: [{ x: 16, y: 64, z: -4, name: 'Basic Bending Machine', id: 'gregtech:gt.blockmachines', meta: 221, recipes: 'Bending Machine', recipeKey: 'gt.recipe.metalbender', tier: 'LV', active: false, storedEU: 5000, dist: 6 }], total: 1 })
    assert.match((await s.run('find_machines')).content, /\n- \(16,64,-4\) "基础卷板机": runs Bending Machine recipes, tier LV, has power \(5000 EU stored\), idle, 6 blocks away$/)
  })
})

describe('中文名：只有英文名、或者只有 id 的地方', () => {
  /** 一张小物品表：箱子另有一条“任何 meta”的同名条目（真实的物品表里配方引用过的物品都有），管道和机器是 GregTech 的。 */
  function names(t: { after(fn: () => void): void }) {
    const s = setup(t)
    const dir = tmpDir()
    t.after(dir.cleanup)
    const items = [
      { id: 'minecraft:chest', meta: 0, name: '箱子', en: 'Chest' },
      { id: 'minecraft:chest', meta: 32767, name: '箱子', en: 'Chest' },
      { id: 'avaritiaddons:CompressedChest', meta: 0, name: '压缩箱子', en: 'Compressed Chest' },
      { id: 'gregtech:gt.blockmachines', meta: 5602, name: '黄铜物品管道', en: 'Brass Item Pipe' },
      { id: 'gregtech:gt.blockmachines', meta: 282, name: '进阶压模机', en: 'Advanced Extruder' },
      { id: 'gregtech:gt.metaitem.01', meta: 11305, name: '钢锭', en: 'Steel Ingot' },
      // 两个 mod 各有一个英文名都叫 Hopper、中文名不同的东西：只凭英文名认不出是哪个，不认
      { id: 'minecraft:hopper', meta: 0, name: '漏斗', en: 'Hopper' },
      { id: 'othermod:hopper', meta: 0, name: '料斗', en: 'Hopper' },
    ]
    fs.writeFileSync(path.join(dir.dir, 'items.jsonl'), items.map((i) => JSON.stringify(i)).join('\n'))
    useLocalNames(loadPackData(dir.dir).items)
    t.after(() => useLocalNames(undefined))
    return s
  }

  it('箱子、接着的管道、输出总线推往的箱子、东西所在的容器和机器：身体只给了英文名的，也换成物品表里的中文名；认不准的保持原样', async (t) => {
    const s = names(t)
    s.game.handlers['world.containers'] = paged([chest(1, [], { attached: [{ x: 1, y: 65, z: 0, name: 'Brass Item Pipe', kind: 'item pipe' }, { x: 2, y: 64, z: 0, name: 'Hopper', kind: 'hopper' }] })])
    assert.equal((await s.run('list_containers')).content.split('\n')[1], '- (1,64,0) 箱子 [minecraft:chest] 0/27 slots used (AUTOMATED: 黄铜物品管道 at (1,65,0), Hopper at (2,64,0) feeds or drains it): empty')

    s.game.handlers['world.stock'] = () => ({
      containersLookedInto: 3,
      items: [{ id: 'gregtech:gt.metaitem.01', meta: 11305, total: 9, places: [{ x: 5, y: 64, z: 5, container: 'Compressed Chest', count: 8 }, { x: 6, y: 64, z: 5, container: 'Advanced Extruder', count: 1 }] }],
    })
    assert.deepEqual((await s.run('find_in_storage', { items: [{ id: 'gregtech:gt.metaitem.01', meta: 11305 }] })).content.split('\n').slice(1), [
      '- gregtech:gt.metaitem.01/11305 "钢锭": 9 in total',
      '  - (5,64,5) 压缩箱子: 8',
      '  - (6,64,5) 进阶压模机: 1',
    ])

    s.game.handlers['world.machines'] = () => ({
      machines: [{ x: 0, y: 64, z: 0, name: 'Advanced Extruder', id: 'gregtech:gt.blockmachines', meta: 282, kind: 'multiblock', formed: true, recipes: 'Extruder', active: false, outputBuses: [{ x: 1, y: 64, z: 0, kind: 'output bus', slots: 4, usedSlots: 0, passesTo: [{ x: 1, y: 64, z: 1, name: 'Chest' }] }], dist: 2 }],
      total: 1,
    })
    const machines = (await s.run('find_machines')).content.split('\n')
    assert.match(machines[1]!, /^- \(0,64,0\) "进阶压模机": /)
    assert.equal(machines[2], '    output bus (1,64,0), 0/4 slots used, keeps nothing: pushes into 箱子 at (1,64,1)')
  })

  it('任务结果、失败详情里只带 id 的东西补上中文名：取货缺的、任务参数里的', async (t) => {
    const s = names(t)
    s.game.handlers['task.list'] = () => ({
      active: { id: 't3', type: 'withdraw', state: 'running', params: { type: 'withdraw', container: { x: 1, y: 64, z: 1 }, items: [{ id: 'gregtech:gt.metaitem.01', meta: 11305, count: 5 }] } },
      queue: [],
      recent: [{ id: 't2', type: 'withdraw', state: 'done', finishedAt: 100, result: { moved: 2, missing: [{ id: 'gregtech:gt.metaitem.01', meta: 11305, count: 3 }] } }],
    })
    const lines = (await s.run('task_status')).content.split('\n')
    assert.equal(lines[0], 'Running: t3 withdraw [running] params={"type":"withdraw","container":{"x":1,"y":64,"z":1},"items":[{"id":"gregtech:gt.metaitem.01","meta":11305,"count":5,"name":"钢锭"}]}')
    assert.equal(lines.at(-1), '- t2 withdraw [done] result={"moved":2,"missing":[{"id":"gregtech:gt.metaitem.01","meta":11305,"count":3,"name":"钢锭"}]}')
    // 被任务结束叫醒时看到的那句话也一样
    const ev = fromBridgeEvent({ event: 'task.update', seq: 1, time: NOW, data: { bot: 'Alu', task: { id: 't2', type: 'withdraw', state: 'done', result: { moved: 2, missing: [{ id: 'gregtech:gt.metaitem.01', meta: 11305, count: 3 }] } } } }, 'Alu', NOW)!
    assert.match(eventLine(ev, NOW), /任务 t2（withdraw）完成了。 结果：\{"moved":2,"missing":\[\{"id":"gregtech:gt\.metaitem\.01","meta":11305,"count":3,"name":"钢锭"\}\]\}$/)
  })
})

describe('主人指着说', () => {
  const VIEW = {
    dim: 0,
    pos: { x: -512.4, y: 69, z: 93.7 },
    block: { x: -513, y: 69, z: 93 },
    yaw: -171.2,
    pitch: 12.5,
    facing: 'north',
    lookingAt: { x: -509, y: 69, z: 90, id: 'IronChest:BlockIronChest', meta: 3, name: 'Compressed Chest', kind: 'container', side: 'west', dist: 4.2 },
    ahead: [
      { x: -509, y: 69, z: 90, id: 'IronChest:BlockIronChest', meta: 3, name: 'Compressed Chest', kind: 'container', dist: 4.2 },
      { x: -517, y: 71, z: 85, id: 'IronChest:BlockIronChest', meta: 3, name: 'Compressed Chest', kind: 'container', dist: 7.9, attached: [{ x: -516, y: 71, z: 85, name: 'Brass Item Pipe', kind: 'item pipe' }] },
      { x: -511, y: 71, z: 86, id: 'StorageDrawers:controller', meta: 2, name: 'Drawer Controller', kind: 'drawer_controller', dist: 8.1 },
    ],
  }

  it('聊天和私聊事件带着说话的人站在哪、朝哪、指着什么、面前有什么：整理成一行放进给模型的消息', (t) => {
    setup(t, { names: true })
    const ev = fromBridgeEvent({ event: 'chat', seq: 1, time: NOW, data: { player: '阿露', uuid: 'u', message: 'Alu 把抽屉里不到 128 个的都搬到这个箱子里', isBot: false, speaker: VIEW } }, 'Alu', NOW)!
    assert.deepEqual(eventLine(ev, NOW).split('\n').slice(1), [
      '  （阿露 站在 (-513,69,93) 面朝北，指着 压缩箱子 (-509,69,90)［容器］；面前还有：压缩箱子 (-517,71,85)［容器］（接着Brass Item Pipe）、Drawer Controller (-511,71,86)［抽屉管理器］）',
    ])
    const whisper = fromBridgeEvent({ event: 'whisper', seq: 2, time: NOW, data: { bot: 'Alu', from: 'Steve', message: '看这里', speaker: { block: { x: 1, y: 64, z: 2 }, facing: 'up' } } }, 'Alu', NOW)!
    assert.match(eventLine(whisper, NOW), /Steve 私聊你：看这里\n {2}（Steve 站在 \(1,64,2\) 面朝上，没有指着什么方块）$/)
    // 老的身体不带 speaker：就只有那句话
    const plain = fromBridgeEvent({ event: 'chat', seq: 3, time: NOW, data: { player: 'Steve', uuid: 'u', message: '在吗', isBot: false } }, 'Alu', NOW)!
    assert.match(eventLine(plain, NOW), /Steve 说：在吗$/)
  })

  it('模型被叫醒时看到的消息里就有这一行，不用再问他指的是哪个', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(reply(''))
    h.agent.handleBridgeEvent({ event: 'chat', seq: 1, time: Date.now(), data: { player: 'Steve', uuid: 'u', message: 'Alu 这个箱子里有什么', isBot: false, speaker: VIEW } })
    await h.agent.whenIdle()
    assert.match(h.llm.lastUserText(0), /Steve 说：Alu 这个箱子里有什么\n {2}（Steve 站在 \(-513,69,93\) 面朝北，指着 Compressed Chest \(-509,69,90\)［容器］；面前还有：/)
    void chat
  })

  it('get_player_position 随时查一个玩家站在哪、朝哪、指着什么、面前有哪些容器；不在线、老的身体各有交代', async (t) => {
    const s = setup(t, { names: true })
    s.game.handlers['world.player'] = (p) => {
      if (p.name !== 'Steve') throw new BridgeError('not_found', `player ${String(p.name)} is not online`)
      return { name: 'Steve', isBot: false, ...VIEW }
    }
    const res = await s.run('get_player_position', { player: 'Steve' })
    assert.deepEqual(res.content.split('\n'), [
      'Steve is in overworld (dim 0) at (-513,69,93), facing north.',
      'Crosshair on: 压缩箱子 at (-509,69,90) (container), 4 blocks from them.',
      'Containers in front of them, most directly ahead first:',
      '- 压缩箱子 at (-517,71,85) (container), 8 blocks from them; AUTOMATED: Brass Item Pipe at (-516,71,85) feeds or drains it',
      '- Drawer Controller at (-511,71,86) (drawer controller), 8 blocks from them',
    ])
    assert.deepEqual(s.game.callsOf('world.player'), [{ name: 'Steve' }])
    // 不在线：退回去看在线名单，说清楚
    const gone = await s.run('get_player_position', { player: 'Nobody' })
    assert.deepEqual([gone.isError, gone.content], [true, 'Nobody is not online. Online now: Steve'])
    // 老的身体没有 world.player：只说位置
    delete s.game.handlers['world.player']
    assert.equal((await s.run('get_player_position', { player: 'steve' })).content, 'Steve is in overworld (dim 0) at (12,64,3).')
  })
})

describe('通用的界面动作：打开、看格子、点、关', () => {
  const STEEL_INGOT = { id: 'gregtech:gt.metaitem.01', meta: 11305, name: 'Steel Ingot' }
  const STEEL_PLATE = { id: 'gregtech:gt.metaitem.01', meta: 17305, name: 'Steel Plate' }
  /** 一台身体不认识的机器的界面：两个原料格、一个产物格、一个只显示的电路格；自己的背包里有两样东西。 */
  const screen = (more: Record<string, unknown> = {}) => ({
    open: true,
    screen: 'Alloy Furnace',
    slotCount: 40,
    slots: [
      { slot: 0, item: { ...STEEL_INGOT, count: 4 } },
      { slot: 1 },
      { slot: 2, takesNothing: true, item: { ...STEEL_PLATE, count: 2 } },
      { slot: 3, ghost: true, item: { id: 'gregtech:gt.integrated_circuit', meta: 1, count: 1, name: 'Programmed Circuit' } },
      { slot: 13, own: true, item: { ...STEEL_INGOT, count: 60 } },
      { slot: 22, own: true, item: { ...COAL, count: 8 } },
    ],
    ...more,
  })

  it('界面的样子说得清：它自己的格子和你背包的格子分开列，产物格和只显示的格子标出来，鼠标上拿着什么，物品是中文名；点一格交给身体的就是左键、右键、Shift', async (t) => {
    const s = setup(t, { names: true })
    s.game.handlers['screen.open'] = () => screen()
    s.game.handlers['screen.look'] = () => screen()
    s.game.handlers['screen.click'] = () => screen({ cursor: { ...COAL, count: 8 } })
    s.game.handlers['screen.close'] = () => ({})
    const opened = await s.run('open_screen', { at: { x: 14, y: 64, z: -4 } })
    assert.deepEqual(s.game.callsOf('screen.open'), [{ bot: 'Alu', x: 14, y: 64, z: -4 }])
    assert.deepEqual(opened.content.split('\n'), [
      'Screen "Alloy Furnace" is open (40 slots in all).',
      'Its slots (4):',
      '- slot 0: 4× 钢锭 [gregtech:gt.metaitem.01/11305]',
      '- slot 1: empty',
      '- slot 2 (OUTPUT: products appear here, nothing can be put in): 2× 钢板 [gregtech:gt.metaitem.01/17305]',
      '- slot 3 (display only: nothing real in it, e.g. a programmed-circuit setting): 1× 编程电路 1 [gregtech:gt.integrated_circuit/1]',
      'Your own inventory (only the slots holding something):',
      '- slot 13: 60× 钢锭 [gregtech:gt.metaitem.01/11305]',
      '- slot 22: 8× Coal [minecraft:coal]',
      'Nothing on your cursor.',
    ])
    // 不给参数：再看一眼已经开着的界面（不重新打开）
    assert.equal((await s.run('open_screen')).content, opened.content)
    assert.deepEqual([s.game.callsOf('screen.look'), s.game.callsOf('screen.open').length], [[{ bot: 'Alu' }], 1])
    // 点：左键、右键、按着 Shift
    const picked = await s.run('click_slot', { slot: 22 })
    assert.equal(picked.content.split('\n').at(-1), 'On your cursor (picked up, not put down yet): 8× Coal [minecraft:coal]. Clicking a slot puts it down; closing the screen sends it back to your inventory.')
    await s.run('click_slot', { slot: 1, right: true })
    await s.run('click_slot', { slot: 13, shift: true })
    assert.deepEqual(s.game.callsOf('screen.click'), [{ bot: 'Alu', slot: 22 }, { bot: 'Alu', slot: 1, button: 1 }, { bot: 'Alu', slot: 13, shift: true }])
    assert.equal((await s.run('close_screen')).content, 'The screen is closed.')
    assert.deepEqual(s.game.callsOf('screen.close'), [{ bot: 'Alu' }])
    // 身上的东西（背包）也能打开
    await s.run('open_screen', { item: { id: 'Backpack:backpack' } })
    assert.deepEqual(s.game.callsOf('screen.open').at(-1), { bot: 'Alu', item: { id: 'Backpack:backpack' } })
  })

  it('开不了时说清下一步：有任务在跑、够不着、右键后没有界面、方块和物品都给或都没给', async (t) => {
    const s = setup(t)
    s.game.handlers['screen.open'] = () => {
      throw new BridgeError('busy', 'a task is running')
    }
    assert.deepEqual(await s.run('open_screen', { at: { x: 1, y: 64, z: 1 } }), { content: 'A task of yours is still running: screens can only be used while you have no task. Wait for it to end (or cancel_task), then try again.', isError: true })
    s.game.handlers['screen.open'] = () => {
      throw new BridgeError('out_of_reach', 'the block at 1,64,1 is 9.2 blocks away')
    }
    assert.equal((await s.run('open_screen', { at: { x: 1, y: 64, z: 1 } })).content, 'That block is out of reach (the block at 1,64,1 is 9.2 blocks away). Walk next to it first (go_to), then open it.')
    // 有的界面点开后过一小会儿才出现；一直不出现的就是没有界面
    // 界面晚一拍才出现（用物品打开的常常这样）：open_screen 自己再看几眼，一次调用就把界面带回来
    const late = [{ open: false }, { open: false }, { open: true, screen: 'Chisel', slotCount: 1, slots: [{ slot: 0, item: { id: 'minecraft:dirt', meta: 0, count: 64, name: 'Dirt' } }] }]
    s.game.handlers['screen.open'] = () => late.shift()!
    s.game.handlers['screen.look'] = () => late.shift() ?? { open: true, screen: 'Chisel', slotCount: 0, slots: [] }
    const calls = s.game.calls.length
    assert.match((await s.run('open_screen', { item: { id: 'chisel:chisel' } })).content, /^Screen "Chisel" is open \(1 slots in all\)\.\nIts slots \(1\):\n- slot 0: 64× /)
    assert.deepEqual(s.game.calls.slice(calls).map((c) => c.method), ['screen.open', 'screen.look', 'screen.look'])
    // 一直没出现：照实说等了多久，不让它再白看一次
    s.game.handlers['screen.open'] = () => ({ open: false })
    s.game.handlers['screen.look'] = () => ({ open: false })
    assert.equal((await s.run('open_screen', { at: { x: 1, y: 64, z: 1 } })).content, 'No screen opened: after asking for it, it was looked for 8 more times over 1.6 s and none appeared. That block (or item) opens no screen this way.')
    assert.equal((await s.run('open_screen')).content, 'No screen is open right now.')
    assert.deepEqual(await s.run('open_screen', { at: { x: 1, y: 64, z: 1 }, item: { id: 'Backpack:backpack' } }), { content: 'Give "at" (a block) or "item" (something you carry), not both; neither to look at the screen that is already open.', isError: true })
    // 方块和物品都给的那一次没有去开
    assert.equal(s.game.callsOf('screen.open').length, 4)
    // 例程里可以调这三个（同样的点法要重复很多遍时）；只算不动手的 run_program 不行
    for (const name of ['open_screen', 'click_slot', 'close_screen']) assert.deepEqual([ROUTINE_BLOCKED_TOOLS.includes(name), QUERY_TOOLS.includes(name)], [false, false], name)
  })
})
