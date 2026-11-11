// 模型拿到哪些工具，不在清单里的那些（库函数、合并掉的旧名字、不能看图时的看图工具）还用不用得到。
// 入口是 agent：有人跟它说话 → 它收到工具清单 → 调工具（或者写程序调）→ 看到结果。
// 游戏是按方法名应答的假服务器，模型是按脚本回应的假模型，跑程序的沙箱是真的。
//
// 出发点：从清单里挪走不等于拿掉能力。挪走的东西模型仍然要知道它存在（run_program 说明后面的索引），
// 仍然一步就能用到（程序里 await tool(名字, 参数)），照旧习惯直接调也照常执行。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { AgentSettings } from '../src/agent/agent.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import { DesignWorkspace } from '../src/design/index.ts'
import { loadPackData } from '../src/packdata/index.ts'
import { ALL_TOOLS, modelToolSpecs } from '../src/tools/index.ts'
import { DEFAULT_MANUALS_DIR, chat, makeAgent, modelCalls, reply, taskEnded } from './agent-harness.ts'
import type { AgentHarness } from './agent-harness.ts'
import { writeRecipeFixture } from './fixture-recipes.ts'
import { encodePng, tmpDir, waitFor, worldBlocksAnswer } from './helpers.ts'

const PLATE = { id: 'gregtech:gt.metaitem.01', meta: 17305 }
const CHEST = { x: 5, y: 64, z: 5 }
const BARREL = { x: 9, y: 64, z: 9 }

function setup(t: { after(fn: () => void): void }, opts: { vision?: boolean; settings?: Partial<AgentSettings> } = {}): AgentHarness & { design: DesignWorkspace } {
  const tmp = tmpDir()
  // 本地资料：一本小配方册（查用途要它）；任务书没有，问的是服务器
  const packdataDir = path.join(tmp.dir, 'packdata')
  writeRecipeFixture(packdataDir)
  const packdata = loadPackData(packdataDir, () => {})
  const design = new DesignWorkspace({ dataDir: tmp.dir, packdata })
  const h = makeAgent({ dir: tmp.dir, design, packdata, ...(opts.vision !== undefined ? { vision: opts.vision } : {}), ...(opts.settings ? { settings: opts.settings } : {}) })
  t.after(async () => {
    await h.agent.stop()
    packdata.recipes?.close()
    tmp.cleanup()
  })
  // 一个箱子里 64 个钢锭
  h.game.handlers['world.containers'] = () => ({ containers: [{ ...CHEST, id: 'minecraft:chest', name: 'Chest', slots: 27, usedSlots: 1, items: [{ id: 'gregtech:gt.metaitem.01', meta: 11305, count: 64, name: 'Steel Ingot' }] }], total: 1, offset: 0 })
  // 一个抽屉管理器管着两格
  h.game.handlers['world.drawers'] = () => ({
    controller: { x: 1, y: 64, z: 1 },
    drawers: 2,
    slotsTotal: 4,
    slotsUsed: 2,
    slots: [
      { x: 2, y: 64, z: 1, slot: 0, id: 'minecraft:coal', meta: 0, name: 'Coal', count: 40, room: 2008 },
      { x: 3, y: 64, z: 1, slot: 1, id: 'gregtech:gt.metaitem.01', meta: 11305, name: 'Steel Ingot', count: 7, room: 2041 },
    ],
    total: 2,
    offset: 0,
  })
  h.game.handlers['bot.probe'] = () => ({ id: 'minecraft:stone', meta: 0, name: 'Stone', solid: true, hardness: 1.5, canDig: true, digTicks: 12, toolSlot: 0, inReach: true, candidates: [{ slot: 0, item: 'TConstruct:pickaxe', harvest: true, ticks: 12 }] })
  h.game.handlers['blueprint.check'] = (p) => ({ name: p.name, origin: { x: p.x, y: p.y, z: p.z }, cells: 10, done: 4, toPlace: 6, byHand: 0, blocked: 0, extra: 0, materials: [{ id: 'minecraft:planks', meta: 0, name: 'Oak Wood Planks', need: 6, have: 2 }] })
  h.game.handlers['quest.lines'] = () => ({ quests: 9, lines: [{ name: 'Steam', quests: 9, complete: 3, available: 2 }] })
  h.game.handlers['blueprint.list'] = () => ({ folder: 'config/aiplayer/schematics', blueprints: [{ name: 'cabin', size: { x: 4, y: 3, z: 4 }, blocks: 41 }] })
  return Object.assign(h, { design })
}

/** 模型用 run_program 跑一段程序，返回它 return 的值（JSON）。程序出错就让测试带着报错失败。 */
async function program(h: AgentHarness, code: string): Promise<any> {
  const res = await modelCalls(h, 'run_program', { code })
  assert.equal(res.isError, false, res.content)
  const returned = /^Returned: (.*)$/ms.exec(res.content)
  assert.ok(returned, res.content)
  return JSON.parse(returned[1]!)
}

/** 这一次发给模型的工具清单。 */
async function offered(h: AgentHarness): Promise<{ name: string; description: string; inputSchema: { properties: Record<string, unknown> } }[]> {
  const before = h.llm.requests.length
  h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
  await waitFor('the model was asked', () => h.llm.requests.length > before)
  await h.agent.whenIdle()
  return h.llm.requests[before]!.tools as never
}

// 能看图的模型拿到的全部工具。不能看图的少两个：view_area、view_image。
const TOOLS_WITH_VISION = [
  'say', 'whisper',
  'get_status', 'look_around', 'scan_area', 'view_area', 'inspect_block', 'find_blocks', 'list_containers', 'get_player_position',
  'go_to', 'go_to_player', 'follow_player', 'go_home', 'run_command',
  'flatten_area', 'clear_area', 'fill_area', 'dig_blocks', 'place_blocks',
  'list_designs', 'build_blueprint',
  'run_program', 'start_routine', 'routine_status', 'stop_routine', 'view_image', 'view_draft', 'publish_draft', 'delete_draft',
  'deposit_items', 'withdraw_items', 'collect_items', 'give_items', 'use_item', 'open_screen', 'click_slot', 'close_screen',
  'find_item', 'find_recipes', 'find_in_storage', 'find_machines', 'craft_item', 'process_items',
  'find_quests', 'get_quest',
  'task_status', 'cancel_task', 'remember', 'forget', 'set_reminder',
  'list_manuals', 'read_manual', 'write_manual',
  'report_problem',
]
const LIBRARY = ['list_stock', 'list_drawers', 'find_uses', 'list_quest_lines', 'probe_block', 'check_blueprint', 'haul_items', 'read_blocks', 'find_structure', 'check_structure', 'total_materials']
const OLD_NAMES = ['list_blueprints', 'list_drafts', 'list_images', 'set_home', 'list_homes', 'join_team']

describe('模型拿到的工具清单', () => {
  it('能看图的模型：看图的三个工具都在；不能看图的模型：没有 view_area 和 view_image，view_draft 留着但只有出文字的那些参数', async (t) => {
    const seeing = await offered(setup(t, { vision: true }))
    assert.deepEqual(seeing.map((tool) => tool.name).sort(), [...TOOLS_WITH_VISION].sort())
    assert.deepEqual(Object.keys(seeing.find((tool) => tool.name === 'view_draft')!.inputSchema.properties), ['name', 'along', 'x1', 'x2', 'y1', 'y2', 'z1', 'z2', 'program', 'picture', 'from', 'layer'])

    const blind = await offered(setup(t, { vision: false }))
    assert.deepEqual(blind.map((tool) => tool.name).sort(), TOOLS_WITH_VISION.filter((name) => name !== 'view_area' && name !== 'view_image').sort())
    const draft = blind.find((tool) => tool.name === 'view_draft')!
    assert.deepEqual(Object.keys(draft.inputSchema.properties), ['name', 'along', 'x1', 'x2', 'y1', 'y2', 'z1', 'z2', 'program'])
    assert.doesNotMatch(draft.description, /picture/i)
  })

  it('库函数和合并掉的旧名字都不在清单里；run_program 的说明后面有库函数的索引，每个一行，整份不超过 2000 字符；start_routine 的说明指过去', async (t) => {
    for (const vision of [true, false]) {
      const tools = await offered(setup(t, { vision }))
      const names = tools.map((tool) => tool.name)
      for (const name of [...LIBRARY, ...OLD_NAMES]) assert.equal(names.includes(name), false, name)
      const run = tools.find((tool) => tool.name === 'run_program')!.description
      const index = run.slice(run.indexOf('\nLibrary functions') + 1)
      assert.ok(index.length <= 2000, `the index is ${index.length} characters`)
      const lines = index.split('\n')
      assert.equal(lines[0], 'Library functions are not in your tool list; a program calls them like tools. To read one: return (await tool(name, input)).text; to compute with one, use .data. Below: name {input}: what -> data')
      // 不能看图时，没进清单的 view_area、view_image 也列在索引里：它们给的文字照样拿得到
      const listed = vision ? LIBRARY : [...LIBRARY, 'view_area', 'view_image']
      assert.deepEqual(lines.slice(1).map((line) => /^- (\w+) \{[^}]*\}: .+ -> .+$/.exec(line)?.[1]), listed)
      assert.match(tools.find((tool) => tool.name === 'start_routine')!.description, /The library functions listed under run_program can be called here too\./)
    }
  })

  it('发给它的参数 schema 里没有对调对没用的键（additionalProperties、minLength:1、空的 required），校验照旧：空字符串、缺必填的一样被拦下并说明', async (t) => {
    const h = setup(t)
    const sent = JSON.stringify(await offered(h))
    for (const key of ['"additionalProperties"', '"minLength"', '"required":[]']) assert.equal(sent.includes(key), false, key)
    // 范围、必填、枚举这些“调对所必需的”还在
    const fill = (await offered(h)).find((tool) => tool.name === 'fill_area')!.inputSchema as unknown as { required: string[]; properties: Record<string, Record<string, unknown>> }
    assert.deepEqual(fill.required, ['x1', 'y1', 'z1', 'x2', 'y2', 'z2', 'item'])
    assert.deepEqual([fill.properties.y1, fill.properties.shape!.enum], [{ type: 'integer', minimum: 0, maximum: 255 }, ['solid', 'hollow', 'walls']])
    const empty = await modelCalls(h, 'fill_area', { x1: 0, y1: 64, z1: 0, x2: 1, y2: 64, z2: 1, item: '' })
    assert.deepEqual([empty.isError, empty.content], [true, 'Invalid arguments for fill_area: item must not be empty'])
    const missing = await modelCalls(h, 'withdraw_items', { container: { x: 1, y: 64 }, items: [{ count: 3 }] })
    assert.deepEqual([missing.isError, missing.content], [true, 'Invalid arguments for withdraw_items: container.z is required; items[0].id is required'])
    assert.equal(h.game.callsOf('task.start').length, 0)
  })

  it('手册里教它在程序里调的每一个名字都真的调得到', () => {
    const callable = new Set([...TOOLS_WITH_VISION, ...LIBRARY, ...OLD_NAMES])
    for (const file of fs.readdirSync(DEFAULT_MANUALS_DIR)) {
      const text = fs.readFileSync(path.join(DEFAULT_MANUALS_DIR, file), 'utf8')
      for (const call of text.matchAll(/\btool\(\s*["']([a-z_]+)["']/g)) assert.ok(callable.has(call[1]!), `${file} calls tool("${call[1]}"), which does not exist`)
    }
  })

  // 每个工具的说明和参数 schema 每一轮都发给模型。加一个工具之前先想：通用能力（走、挖放、用物品、开界面点格子、
  // 存取、写程序）加上模型自己的脑子做得到的事，不做成专用工具；“查一查、算一算”的做成库函数（索引里只占一行）。
  // 确实要加，再有意识地把这个上限调高。上限是 2026-11 瘦身两步做完时的实际值（42,576）往上留约 5%。
  // 量的是发给模型的那份（modelToolSpecs）：说明加上瘦过的参数 schema。
  it('防回涨：不能看图的模型每一轮收到的工具清单不超过 44,700 字符', () => {
    const CEILING = 44_700
    const sizes = modelToolSpecs(ALL_TOOLS, { canSee: false })
      .map((spec) => ({ name: spec.name, chars: JSON.stringify(spec).length }))
      .sort((a, b) => b.chars - a.chars)
    const total = sizes.reduce((n, s) => n + s.chars, 0)
    assert.ok(
      total <= CEILING,
      `发给模型的工具清单现在是 ${total} 字符（${sizes.length} 个工具），超过了上限 ${CEILING}。\n` +
        '这些字符每一轮都发。先看新加的东西能不能做成库函数（src/tools/index.ts 的 LIBRARY_TOOLS，只在索引里占一行）、' +
        '能不能并进现有的工具、说明能不能只留“调对它所必需的”（怎么用好写进手册，调错了才要知道的写进出错的结果）；确实要加，再把这条测试里的上限调高。\n' +
        `各工具的大小（大的在前）：\n${sizes.map((s) => `  ${String(s.chars).padStart(5)}  ${s.name}`).join('\n')}`,
    )
  })
})

describe('库函数：不在清单里，在程序里调', () => {
  it('只查不动的库函数在 run_program 里都调得到，程序从 data 里直接拿数', async (t) => {
    const h = setup(t)
    const got = await program(
      h,
      `
      const data = async (name, input) => {
        const r = await tool(name, input)
        if (!r.ok) throw new Error(name + ': ' + r.text)
        return r.data
      }
      const probe = await data('probe_block', { x: 0, y: 60, z: 0 })
      const check = await data('check_blueprint', { name: 'hut', x: 0, y: 64, z: 0 })
      return {
        stock: (await data('list_stock', {})).items.map((i) => [i.id, i.meta, i.count, i.places.length]),
        drawers: (await data('list_drawers', { x: 1, y: 64, z: 1 })).slots.map((s) => [s.x, s.id, s.count]),
        uses: (await data('find_uses', ${JSON.stringify(PLATE)})).ways.find((w) => w.way === '研磨机'),
        ground: (await data('find_uses', { ...${JSON.stringify(PLATE)}, way: '研磨机' })).recipes.map((r) => [r.recipe, r.in.map((s) => s.name), r.out.map((o) => o.name)]),
        chapters: (await data('list_quest_lines', {})).lines,
        probe: [probe.canDig, probe.digTicks, probe.candidates[0].item],
        check: [check.done, check.toPlace, check.materials[0].need, check.materials[0].have],
      }`,
    )
    assert.deepEqual(got, {
      stock: [['gregtech:gt.metaitem.01', 11305, 64, 1]],
      drawers: [[2, 'minecraft:coal', 40], [3, 'gregtech:gt.metaitem.01', 7]],
      uses: { way: '研磨机', name: '研磨机', recipes: 1 },
      ground: [[27, ['钢板'], ['钢粉', '小撮钢粉']]],
      chapters: [{ name: 'Steam', quests: 9, complete: 3, available: 2 }],
      probe: [true, 12, 'TConstruct:pickaxe'],
      check: [4, 6, 6, 2],
    })
  })

  it('模型照旧习惯直接调库函数的名字：照常执行，看到的和程序里拿到的是同一段文字', async (t) => {
    const h = setup(t)
    const calls: [string, unknown][] = [
      ['list_stock', {}],
      ['list_drawers', { x: 1, y: 64, z: 1 }],
      ['find_uses', PLATE],
      ['list_quest_lines', {}],
      ['probe_block', { x: 0, y: 60, z: 0 }],
      ['check_blueprint', { name: 'hut', x: 0, y: 64, z: 0 }],
    ]
    const inProgram = (await program(h, `const out = {}\nfor (const [name, input] of ${JSON.stringify(calls)}) out[name] = (await tool(name, input)).text\nreturn out`)) as Record<string, string>
    for (const [name, input] of calls) {
      const direct = await modelCalls(h, name, input)
      assert.equal(direct.isError, false, `${name}: ${direct.content}`)
      assert.equal(direct.content, inProgram[name], name)
    }
    // 是真的结果，不是一句“请写程序”
    assert.match(inProgram.list_drawers!, /^The drawer controller at \(1,64,1\) manages 2 drawer block\(s\): 2 of 4 slots hold something\. 2 slots:\n- \(2,64,1\) slot 0: 40× Coal /)
    assert.match(inProgram.check_blueprint!, /^Blueprint "hut" with its lowest corner at \(0,64,0\)\.\nBlueprint blocks in this range \(cells\): 10\n- done: 4 already in place\n- toPlace: 6 empty spots you can fill\n/)
    // 参数不对时是同一份校验
    const bad = await modelCalls(h, 'list_drawers', { x: 1 })
    assert.deepEqual([bad.isError, bad.content], [true, 'Invalid arguments for list_drawers: y is required; z is required'])
  })

  it('haul_items 会开任务：例程里调，等任务做完拿到它的结局；run_program 里调不了并指到 start_routine；模型直接调也照常开任务', async (t) => {
    const h = setup(t)
    const haul = { from: CHEST, to: BARREL, items: [{ id: 'minecraft:coal', count: 64 }] }
    const refused = await program(h, `const r = await tool('haul_items', ${JSON.stringify(haul)}); return [r.ok, r.text]`)
    assert.equal(refused[0], false)
    assert.match(refused[1], /^haul_items cannot be called from run_program: a program there can only look things up \(get_status, .*\)\. To act, start the program with start_routine\.$/)
    assert.equal(h.game.callsOf('task.start').length, 0)

    await modelCalls(h, 'start_routine', { code: `const r = await tool('haul_items', ${JSON.stringify(haul)}); return [r.ok, r.data]`, name: '搬煤' })
    await waitFor('the routine started the task', () => h.game.callsOf('task.start').length === 1)
    assert.deepEqual(h.game.callsOf('task.start')[0], { bot: 'Alu', task: { type: 'haul', ...haul }, mode: 'replace' })
    h.agent.handleEvent(taskEnded('t1', 'done', { type: 'haul', result: { moved: 64 } }))
    await waitFor('the routine finished', () => h.agent.status().routine?.status === 'done')
    assert.equal(h.agent.status().routine!.value, '[true,{"task":"t1","state":"done","result":{"moved":64}}]')
    await h.agent.whenIdle()

    const direct = await modelCalls(h, 'haul_items', haul)
    assert.deepEqual([direct.isError, direct.content], [false, 'Task t2 (haul) started. It runs in the game on its own. End your turn now; you will be woken with the outcome when it ends.'])
    assert.deepEqual(h.agent.status().trackedTasks, ['t2'])
  })

  it('调了一个不存在的名字：报错里分两组列出能调的——它的工具，和库函数；看图的两个按它能不能看图归组', async (t) => {
    const blind = (await modelCalls(setup(t, { vision: false }), 'fly_to_the_moon')).content
    assert.match(blind, /^There is no tool named "fly_to_the_moon"\. Your tools: say, whisper, get_status, .*, report_problem\. Library functions \(in a program: await tool\(name, input\)\): list_stock, list_drawers, find_uses, list_quest_lines, probe_block, check_blueprint, haul_items, read_blocks, find_structure, check_structure, total_materials, view_area, view_image\.$/)
    assert.doesNotMatch(/Your tools: (.*)\. Library functions/.exec(blind)![1]!, /view_area|view_image/)
    assert.ok(blind.length < 1100, `${blind.length} characters`)
    for (const old of OLD_NAMES) assert.equal(blind.includes(old), false, old)

    const seeing = (await modelCalls(setup(t, { vision: true }), 'fly_to_the_moon')).content
    assert.match(seeing, /Your tools: .*\bview_area\b.*\bview_image\b.*\. Library functions \(in a program: await tool\(name, input\)\): list_stock, .*, total_materials\.$/)
  })

  it('不能看图的模型：view_area、view_image 给的文字和数据在程序里拿得到——范围、各种方块各多少、一层层各有什么；图片的尺寸和主要颜色', async (t) => {
    const h = setup(t, { vision: false })
    // 世界里一小堆：下面一层 8 块石头，上面一层 2 块木板
    const blocks: Record<string, string> = {}
    for (let x = 0; x < 4; x++) for (let z = 0; z < 2; z++) blocks[`${x},60,${z}`] = 'minecraft:stone'
    blocks['0,61,0'] = blocks['1,61,0'] = 'minecraft:planks'
    h.game.handlers['world.blocks'] = (p) => worldBlocksAnswer(p, blocks)
    const red = [151, 52, 49, 255]
    h.design.images.save('flag', encodePng({ width: 2, height: 1, rgba: Buffer.from([...red, 0, 0, 0, 0]) }))

    const got = await program(h, `
      const area = await tool('view_area', { x1: 0, y1: 60, z1: 0, x2: 3, y2: 61, z2: 1 })
      const image = await tool('view_image', { name: 'flag' })
      return { area: area.text.split('\\n'), kinds: area.data.kinds.map((k) => [k.id, k.count]), box: [area.data.sx, area.data.sy, area.data.sz], image: image.text.split('\\n'), size: [image.data.width, image.data.height, image.data.transparent] }`)
    assert.equal(got.area[1], 'Area x 0..3, y 60..61, z 0..1 (4×2×2 blocks).')
    assert.deepEqual(got.area.slice(-3), ['Layer by layer, from the bottom up:', 'y=60: 8 of 8 cells filled: 8 stone', 'y=61: 2 of 8 cells filled: 2 planks'])
    assert.deepEqual([got.kinds, got.box], [[['minecraft:stone', 8], ['minecraft:planks', 2]], [4, 2, 2]])
    assert.deepEqual(got.image.slice(1, 3), ['Image "flag": 2×1 pixels.', '50% of it is transparent.'])
    assert.match(got.image[3], /^Main colours: \w+ 100%\.$/)
    assert.deepEqual(got.size, [2, 1, 0.5])
  })
})

describe('合并后的工具', () => {
  it('list_designs：服务器上的图纸、它存的草稿、主人传的图片一起列，或者只列一种；旧的三个名字在程序里照样能调，给的是同样的内容', async (t) => {
    const h = setup(t)
    await modelCalls(h, 'run_program', { code: `blueprint(2, 1, 1).fill(0, 0, 0, 1, 0, 0, 'minecraft:planks').save('step')` })
    h.design.images.save('flag', encodePng({ width: 2, height: 1, rgba: Buffer.from([151, 52, 49, 255, 0, 0, 0, 0]) }))

    const all = (await modelCalls(h, 'list_designs')).content.split('\n')
    assert.deepEqual(all, [
      '1 blueprint(s) on the server. Sizes are x × y (height) × z, counted from the lowest corner:',
      '- cabin: 4×3×4, 41 blocks',
      '1 draft(s), newest first:',
      '- step: 2×1×1 (x east-west × y up × z north-south), 2 block(s) of 1 kind(s), saved 0 min ago',
      '1 image(s) (name: width×height in pixels):',
      '- flag: 2×1',
    ])
    assert.equal((await modelCalls(h, 'list_designs', { kind: 'images' })).content, all.slice(4).join('\n'))

    const got = await program(h, `
      const all = await tool('list_designs', {})
      const old = {}
      for (const name of ['list_blueprints', 'list_drafts', 'list_images']) old[name] = (await tool(name, {})).text
      return { data: [all.data.blueprints.map((b) => b.name), all.data.drafts.map((d) => [d.name, d.blocks]), all.data.images], old }`)
    assert.deepEqual(got.data, [['cabin'], [['step', 2]], [{ name: 'flag', width: 2, height: 1 }]])
    assert.deepEqual(got.old, { list_blueprints: all.slice(0, 2).join('\n'), list_drafts: all.slice(2, 4).join('\n'), list_images: all.slice(4).join('\n') })

    // 没连上游戏时图纸列不出来：照实说，草稿和图片照列
    h.game.handlers['blueprint.list'] = () => {
      throw new BridgeError('disconnected', 'bridge is not connected to the game server')
    }
    assert.deepEqual((await modelCalls(h, 'list_designs')).content.split('\n').slice(0, 2), ['The blueprints on the game server could not be listed (disconnected: bridge is not connected to the game server).', '1 draft(s), newest first:'])
  })

  it('set_home、list_homes、join_team 这三个旧名字在程序里照样能调：列家只查不动，run_program 里就行；设家、加入队伍在例程里', async (t) => {
    const h = setup(t)
    const replies: Record<string, string[]> = { 'home list': ['Alu: 1 / 99: base'], 'sethome mine': ["Home 'mine' set!"], 'team join steves_base': ["You joined team 'steves_base'"] }
    h.game.handlers['bot.command'] = (p) => ({ output: replies[String(p.command)] ?? [] })
    const looked = await program(h, `const homes = await tool('list_homes', {}); const set = await tool('set_home', { name: 'mine' }); return [homes.ok, homes.text, set.ok]`)
    assert.deepEqual(looked, [true, 'Server replied: Alu: 1 / 99: base', false])

    await modelCalls(h, 'start_routine', { code: `const set = await tool('set_home', { name: 'mine', note: '矿洞口' }); const joined = await tool('join_team', { team: 'steves_base' }); return [set.ok, joined.ok, joined.text]` })
    await waitFor('the routine finished', () => h.agent.status().routine?.status === 'done')
    assert.equal(h.agent.status().routine!.value, `[true,true,"Ran /team join steves_base. The server replied: You joined team 'steves_base'"]`)
    assert.deepEqual(h.game.callsOf('bot.command').map((p) => p.command), ['home list', 'sethome mine', 'team join steves_base'])
    assert.equal(h.memory.get('home:mine')?.text, '(10,64,-4) dim 0 — 矿洞口')
  })
})

describe('用 run_command 发悄悄话', () => {
  it('tell / msg / w 送到了就算已经对人说过话：它这一轮最后留的那段文字不会再被替它公开说一遍；对方不在线没送到的不算', async (t) => {
    const h = setup(t)
    h.game.handlers['bot.command'] = (p) => ({ output: String(p.command).includes('Herobrine') ? ['That player cannot be found'] : [`You whisper to Steve: ${String(p.command).slice('tell Steve '.length)}`] })
    h.llm.enqueue(reply('', [{ name: 'run_command', input: { command: 'tell Steve 东西放你箱子里了' } }]), reply('已经私聊告诉他了。'))
    h.agent.handleEvent(chat('Steve', 'Alu 弄好了悄悄告诉我'))
    await waitFor('the turn ended', () => h.llm.requests.length === 2)
    await h.agent.whenIdle()
    assert.deepEqual(h.game.callsOf('bot.command').map((p) => p.command), ['tell Steve 东西放你箱子里了'])
    assert.deepEqual(h.game.said, [])
    // 面板的对话日志里这句话记成它说的
    assert.ok(h.log.recent(0, 50).some((e) => e.kind === 'say' && e.text === '（私聊 Steve）东西放你箱子里了'))

    h.llm.enqueue(reply('', [{ name: 'run_command', input: { command: 'msg Herobrine 在吗' } }]), reply('他不在线。'))
    h.agent.handleEvent(chat('Steve', 'Alu 问问 Herobrine'))
    await waitFor('the second turn ended', () => h.llm.requests.length === 4)
    await h.agent.whenIdle()
    assert.deepEqual(h.game.said, ['他不在线。'])
  })
})

describe('程序 return 的值和一个工具结果一样长', () => {
  it('五千字符的结果整段给；主人把“单个工具结果上限”调小以后照新上限截，并写明一共多少、给了多少、剩下的怎么拿', async (t) => {
    const code = `return 'x'.repeat(5000)`
    const whole = await modelCalls(setup(t), 'run_program', { code })
    assert.match(whole.content, /^The program finished in [\d.]+ s\.\nReturned: x{5000}$/)

    const h = setup(t, { settings: { toolResultMaxChars: 1000 } })
    const cut = await modelCalls(h, 'run_program', { code })
    const shown = /^The program finished in [\d.]+ s\.\nReturned \(CUT: this is only the first (\d+) of 5000 characters; one result holds at most 1000 characters\. To get the rest, return less at a time: pick the fields you need from r\.data, narrow the tool call with its own filters or its page argument, or return a later slice of the text\): (x+)$/.exec(cut.content)
    assert.ok(shown, cut.content)
    assert.equal(shown[2]!.length, Number(shown[1]))
    assert.ok(Number(shown[1]) > 500 && cut.content.length <= 1000, `${shown[1]} shown, ${cut.content.length} in all`)
    // 设置是现问的：调回去马上生效，不用重启
    h.settings.toolResultMaxChars = 6000
    assert.match((await modelCalls(h, 'run_program', { code })).content, /\nReturned: x{5000}$/)
  })
})
