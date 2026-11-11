// 两条线的模型各拿到哪些工具，不在清单里的那些（库函数、合并掉的旧名字、不能看图时的看图工具）还用不用得到，
// 另一条线的事按名字调到时怎么说。
// 入口是 agent：对话线被人说的话叫醒、干活线被交来的事叫醒 → 它收到工具清单 → 调工具（或者写程序调）→ 看到结果。
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
import { LINE_TOOLS, modelToolSpecs } from '../src/tools/index.ts'
import type { LineName } from '../src/tools/index.ts'
import { DEFAULT_MANUALS_DIR, chat, lineCalls, makeAgent, modelCalls, reply, taskEnded, told } from './agent-harness.ts'
import type { AgentHarness } from './agent-harness.ts'
import { writeRecipeFixture } from './fixture-recipes.ts'
import { encodePng, tmpDir, waitFor, worldBlocksAnswer } from './helpers.ts'
import { readBlueprintAnswer } from './mock-bridge.ts'
import type { MockBlueprint } from './mock-bridge.ts'

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

/** 这一次发给这条线的模型的工具清单。 */
async function offered(h: AgentHarness, line: LineName = 'work'): Promise<{ name: string; description: string; inputSchema: { properties: Record<string, unknown> } }[]> {
  const llm = line === 'talk' ? h.talk : h.llm
  const before = llm.requests.length
  h.agent.handleEvent(line === 'talk' ? chat('Steve', 'Alu 在吗') : told('看看'))
  await waitFor('the model was asked', () => llm.requests.length > before)
  await h.agent.whenIdle()
  return llm.requests[before]!.tools as never
}

// 只查不动的工具：两条线都有。能看图的模型才有 view_area、view_image。
const LOOKUPS = [
  'get_status', 'look_around', 'scan_area', 'view_area', 'inspect_block', 'find_blocks', 'list_containers', 'get_player_position',
  'list_designs', 'view_image', 'view_draft',
  'find_item', 'find_recipes', 'find_in_storage', 'find_machines', 'find_quests', 'get_quest', 'read_guide', 'task_status',
]
// 记的：记忆、提醒、基地的做法、手册、意见簿。两条线都有（提醒到点叫醒的是定它的那条线；基地的做法主人在聊天里教的，对话线可以直接记）。
const NOTES = ['remember', 'forget', 'set_reminder', 'base_methods', 'set_base_method', 'todo', 'list_manuals', 'read_manual', 'write_manual', 'report_problem']
// 会让身体动、会改游戏里东西的：只有干活线有。
const ACTING = [
  'go_to', 'go_to_player', 'follow_player', 'go_home', 'run_command',
  'flatten_area', 'clear_area', 'fill_area', 'dig_blocks', 'place_blocks', 'build_blueprint',
  'start_routine', 'routine_status', 'stop_routine', 'publish_draft', 'delete_draft',
  'deposit_items', 'withdraw_items', 'collect_items', 'give_items', 'use_item', 'open_screen', 'click_slot', 'use_control', 'close_screen',
  'craft_item', 'process_items', 'cancel_task',
]
// 能看图的模型拿到的全部工具。不能看图的少两个：view_area、view_image。
const WORK_TOOLS_WITH_VISION = ['report', ...LOOKUPS, 'run_program', ...ACTING, ...NOTES]
const TALK_TOOLS_WITH_VISION = ['say', 'whisper', 'tell_worker', 'worker_status', 'stop_work', ...LOOKUPS, 'run_program', ...NOTES]
const TOOLS_WITH_VISION: Record<LineName, string[]> = { talk: TALK_TOOLS_WITH_VISION, work: WORK_TOOLS_WITH_VISION }
const LIBRARY = ['recent_chat', 'read_log', 'list_stock', 'list_drawers', 'find_uses', 'list_quest_lines', 'probe_block', 'check_blueprint', 'read_blueprint', 'haul_items', 'read_blocks', 'find_structure', 'check_structure', 'total_materials']
const OLD_NAMES = ['list_blueprints', 'list_drafts', 'list_images', 'set_home', 'list_homes', 'join_team']

describe('模型拿到的工具清单', () => {
  it('两条线各有各的清单：干活线有操作身体的全部和 report，没有对玩家说话的；对话线有在游戏里说话的两个（say、whisper）、交事和管干活线的三个、所有只查不动的，没有任何一个会动身体的；记忆、提醒、手册两条线都有', async (t) => {
    const h = setup(t, { vision: true })
    const work = (await offered(h, 'work')).map((tool) => tool.name)
    const talk = (await offered(h, 'talk')).map((tool) => tool.name)
    assert.deepEqual([...work].sort(), [...WORK_TOOLS_WITH_VISION].sort())
    assert.deepEqual([...talk].sort(), [...TALK_TOOLS_WITH_VISION].sort())
    for (const name of ACTING) assert.equal(talk.includes(name), false, `the talk line must not be offered ${name}`)
    for (const name of ['say', 'whisper', 'tell_worker', 'worker_status', 'stop_work']) assert.equal(work.includes(name), false, `the work line must not be offered ${name}`)
    assert.equal(talk.includes('say'), true)
  })

  it('对话线直接调了会动身体的名字（工具、库函数、旧名字）：不执行，如实告诉它这归干活线、用 tell_worker 交过去；程序里调也一样；只查不动的照常执行', async (t) => {
    const h = setup(t)
    const haul = { from: CHEST, to: BARREL, items: [{ id: 'minecraft:coal', count: 64 }] }
    const tried: [string, unknown][] = [
      ['go_to', { x: 1, y: 64, z: 1 }],
      ['dig_blocks', { blocks: [{ x: 1, y: 64, z: 1 }] }],
      ['craft_item', { recipe: 'r1' }],
      ['run_command', { command: 'sethome base' }],
      ['start_routine', { code: `await tool('go_to', { x: 1, y: 64, z: 1 })` }],
      ['click_slot', { slot: 0 }],
      ['publish_draft', { name: 'hut' }],
      ['cancel_task', {}],
      ['haul_items', haul],
      ['set_home', { name: 'base' }],
    ]
    for (const [name, input] of tried) {
      const res = await lineCalls(h, 'talk', name, input)
      assert.deepEqual([res.isError, res.content], [true, `Not done: "${name}" acts with the body or changes something in the game, and only the worker line does that; the talk line has no tool that does. To have it done, hand it over with tell_worker (say what you want done; the worker has ${name}).`], name)
    }
    const inProgram = await lineCalls(h, 'talk', 'run_program', { code: `const r = await tool('go_to', { x: 1, y: 64, z: 1 }); return [r.ok, r.text]` })
    assert.match(inProgram.content, /Returned: \[false,"go_to cannot be called from run_program: a program there can only look things up \(get_status, .*\)\. Acting is the worker line's: hand the job over with tell_worker\."\]$/)
    // 身体一样都没动：没有任务、没有指令、没有界面动作
    for (const method of ['task.start', 'task.cancel', 'bot.command', 'screen.click', 'blueprint.put']) assert.deepEqual(h.game.callsOf(method), [], method)
    // 只查不动的库函数和旧名字它照常调得到
    assert.equal((await lineCalls(h, 'talk', 'list_stock', {})).isError, false)
    assert.equal((await lineCalls(h, 'talk', 'list_blueprints', {})).isError, false)
    // 干活线调对话线的那几个，同样被告知不归它
    const mine = await lineCalls(h, 'work', 'tell_worker', { text: '去挖土' })
    assert.deepEqual([mine.isError, mine.content], [true, `Not done: "tell_worker" is the talk line's tool for handing you work and stopping you; you are the worker. To tell the talk line something, use report.`])
  })

  it('能看图的模型：看图的三个工具都在；不能看图的模型：没有 view_area 和 view_image，view_draft 留着但只有出文字的那些参数', async (t) => {
    for (const line of ['work', 'talk'] as const) {
      const seeing = await offered(setup(t, { vision: true }), line)
      assert.deepEqual(seeing.map((tool) => tool.name).sort(), [...TOOLS_WITH_VISION[line]].sort())
      assert.deepEqual(Object.keys(seeing.find((tool) => tool.name === 'view_draft')!.inputSchema.properties), ['name', 'along', 'x1', 'x2', 'y1', 'y2', 'z1', 'z2', 'program', 'picture', 'from', 'layer'])

      const blind = await offered(setup(t, { vision: false }), line)
      assert.deepEqual(blind.map((tool) => tool.name).sort(), TOOLS_WITH_VISION[line].filter((name) => name !== 'view_area' && name !== 'view_image').sort())
      const draft = blind.find((tool) => tool.name === 'view_draft')!
      assert.deepEqual(Object.keys(draft.inputSchema.properties), ['name', 'along', 'x1', 'x2', 'y1', 'y2', 'z1', 'z2', 'program'])
      assert.doesNotMatch(draft.description, /picture/i)
    }
  })

  it('库函数和合并掉的旧名字都不在清单里；run_program 的说明后面有库函数的索引，每个一行，整份不超过 2400 字符；start_routine 的说明指过去', async (t) => {
    for (const line of ['work', 'talk'] as const) {
      for (const vision of [true, false]) {
        const tools = await offered(setup(t, { vision }), line)
        const names = tools.map((tool) => tool.name)
        for (const name of [...LIBRARY, ...OLD_NAMES]) assert.equal(names.includes(name), false, name)
        const run = tools.find((tool) => tool.name === 'run_program')!.description
        const index = run.slice(run.indexOf('\nLibrary functions') + 1)
        // 上限从 2000 调到 2200：多了 read_log 的一行（约 200 字符）——历史压缩把较早的轮换成交接记录以后，靠它翻回原始记录
        // 上限从 2200 调到 2400：total_materials 的那一行长了约 120 字符——它现在照基地的做法展开整棵树、扣库存，结果里多了没定的、还缺的、活儿清单
        assert.ok(index.length <= 2400, `the index is ${index.length} characters`)
        const lines = index.split('\n')
        assert.equal(lines[0], 'Library functions are not in your tool list; a program calls them like tools. To read one: return (await tool(name, input)).text; to compute with one, use .data. Below: name {input}: what -> data')
        // 对话线的索引里只有只查不动的：会开任务的 haul_items 不在
        const library = line === 'talk' ? LIBRARY.filter((name) => name !== 'haul_items') : LIBRARY
        // 不能看图时，没进清单的 view_area、view_image 也列在索引里：它们给的文字照样拿得到
        const listed = vision ? library : [...library, 'view_area', 'view_image']
        assert.deepEqual(lines.slice(1).map((entry) => /^- (\w+) \{[^}]*\}: .+ -> .+$/.exec(entry)?.[1]), listed)
        if (line === 'work') assert.match(tools.find((tool) => tool.name === 'start_routine')!.description, /The library functions listed under run_program can be called here too\./)
      }
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
    const callable = new Set([...WORK_TOOLS_WITH_VISION, ...LIBRARY, ...OLD_NAMES])
    for (const file of fs.readdirSync(DEFAULT_MANUALS_DIR)) {
      const text = fs.readFileSync(path.join(DEFAULT_MANUALS_DIR, file), 'utf8')
      for (const call of text.matchAll(/\btool\(\s*["']([a-z_]+)["']/g)) assert.ok(callable.has(call[1]!), `${file} calls tool("${call[1]}"), which does not exist`)
    }
  })

  // 每个工具的说明和参数 schema 每一轮都发给模型。加一个工具之前先想：通用能力（走、挖放、用物品、开界面点格子、
  // 存取、写程序）加上模型自己的脑子做得到的事，不做成专用工具；“查一查、算一算”的做成库函数（索引里只占一行）。
  // 确实要加，再有意识地把上限调高。量的是发给模型的那份（modelToolSpecs）：说明加上瘦过的参数 schema。
  // 两条线各有清单、各有上限：
  //   干活线：分线之前单代理的上限是 46,600（第四批——覆盖板、流体、方块的全部数据——之后实际 46,085）。分线后实际 45,753：
  //           少了 say、whisper、set_reminder（-1,233），多了 report（+763）和库函数索引里 recent_chat 的一行（+138）。上限不动。
  //           第五批（界面上格子以外的控件）之后实际约 46,900（report 的说明后来又长了 109），上限从 46,600 调到 47,200（+600）：多了 use_control（+1,005，
  //           按和设界面自己的开关、选项、页签、流体格——没有它就开不了机器的自动输出），open_screen 的说明多一句（+25）。
  //           第六批之后实际 48,420，上限从 47,200 调到 48,700（+1,500）：多了 read_guide（+1,328：整合包带的游戏内指南——看目录、
  //           按词找、按物品找讲它的页、读一页，一个工具四种问法），库函数索引里 read_log 的一行（+190：翻自己的活动日志）。
  //   对话线：实际 20,951（28 个工具），不到干活线的一半；上限留约 2%。它每回一句话都带着这份清单，回话快不快就看它。
  //           里面最大的几个是它用来自己回答问题的：run_program 连库函数索引（2,7xx）、find_in_storage、report_problem、find_recipes。
  //           第六批之后实际 22,479（29 个工具），上限从 21,400 调到 22,800（+1,400）：多的是同样的两样，read_guide 和 read_log 的那一行。
  //   物品的提示文字之后：干活线实际 48,710、上限 48,700 → 49,000；对话线实际 22,769、上限 22,800 → 23,000。多的是 find_item（+290）：
  //           结果里的物品少时带上它的提示（玩家把鼠标放上去看到的那几行）和指南里的页，新参数 tip（按提示里的字找物品）；
  //           find_machines、find_structure 的 name 说明里写了中英文都认（各 +十来个字符）。
  //   加工“放下就走”之后：干活线实际 49,032、上限 49,000 → 49,400（+400）。多的是 process_items（+322）：说明里写明不带 leave 时
  //           这个任务从放料占着身体到取完产物、带了就放进去就走，和 leave 这个参数。对话线没变。
  //   干活线也能定提醒之后：干活线实际 49,572、上限 49,400 → 50,000（+600）。多的是 set_reminder 这一个工具（+540）：料放进机器就走以后，
  //           它手上没别的活时这一轮一结束就没有东西叫它回来收，所以它得能给自己定个到点叫醒。对话线实际 22,812，只是说明多了半句。
  //   “基地的做法”之后：两条线各多两个工具，base_methods（看，约 750）和 set_base_method（记、改、删，约 2,260：四种条目的参数都在这一个里），
  //           加上库函数索引里 total_materials 那一行长了约 120。干活线实际 52,580、上限 50,000 → 53,000；对话线实际 25,820、上限 23,000 → 26,200。
  //           主人在聊天里教的做法对话线要能直接记，所以两条线都有；做成库函数的话模型看不到参数，记不对。
  //   “当现成的”“同料时用哪种”和看一个基地那么大之后：干活线实际 53,133、上限 53,000 → 53,600；对话线实际 26,373、上限 26,200 → 26,800。
  //           多的是 set_base_method（+约 500：ready、use、over、noTools 四个参数和说明里的两句），find_in_storage、list_containers 的
  //           radius 说明写明最大到 160（各 +几十）。
  //   工作清单之后：干活线实际 54,386、上限 53,600 → 54,800；对话线实际 27,259、上限 26,800 → 27,600。
  //           多的是 todo（约 890，两条线都有：清单两条线都要能写、能改）；另外约 370 是上一批之后加的 use_item 的 left、
  //           use_control 的电路、total_materials 的 automated 这几个参数（那时没动上限，余量吃掉了）。
  //   公屏说话和对话线写的字分开之后：对话线实际 27,717、上限 27,600 → 28,200。多的是 say（约 460：它在公共聊天里说话的那个工具，
  //           说明里写着它不调工具写的字只给主人在面板上看）；干活线的 report 说明改写了（普通汇报不叫醒对话线），54,392，没过上限。
  for (const [line, ceiling] of [['work', 54_800], ['talk', 28_200]] as const) {
    it(`防回涨：${line === 'work' ? '干活线' : '对话线'}（不能看图的模型）每一轮收到的工具清单不超过 ${ceiling.toLocaleString('en-US')} 字符`, () => {
      const sizes = modelToolSpecs(LINE_TOOLS[line], { canSee: false, line })
        .map((spec) => ({ name: spec.name, chars: JSON.stringify(spec).length }))
        .sort((a, b) => b.chars - a.chars)
      const total = sizes.reduce((n, s) => n + s.chars, 0)
      assert.ok(
        total <= ceiling,
        `发给${line === 'work' ? '干活线' : '对话线'}的工具清单现在是 ${total} 字符（${sizes.length} 个工具），超过了上限 ${ceiling}。\n` +
          '这些字符每一轮都发。先看新加的东西能不能做成库函数（src/tools/index.ts 的 LIBRARY_TOOLS，只在索引里占一行）、' +
          '能不能并进现有的工具、说明能不能只留“调对它所必需的”（怎么用好写进手册，调错了才要知道的写进出错的结果）；确实要加，再把这条测试里的上限调高。\n' +
          `各工具的大小（大的在前）：\n${sizes.map((s) => `  ${String(s.chars).padStart(5)}  ${s.name}`).join('\n')}`,
      )
    })
  }

  // 原来是“不到一半”。两条线都有的（记忆、提醒、基地的做法、工作清单……）每加一个，两边一样长，比例就往一半上靠：
  // 加了 todo 以后是 27,259 比 54,386（50.1%），放宽到 52%
  it('对话线的清单明显比干活线的小：不到 52%', () => {
    const size = (line: LineName) => modelToolSpecs(LINE_TOOLS[line], { canSee: false, line }).reduce((n, spec) => n + JSON.stringify(spec).length, 0)
    assert.ok(size('talk') < size('work') * 0.52, `talk ${size('talk')}, work ${size('work')}`)
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
    assert.deepEqual([direct.isError, direct.content], [false, 'Task t2 (haul) started. It runs in the game on its own: when it ends, the outcome comes to you by itself (waking you if your turn has ended), so there is nothing to wait or poll for; a look at its progress is one model call each time.'])
    assert.deepEqual(h.agent.status().trackedTasks, ['t2'])
  })

  it('调了一个不存在的名字：报错里分两组列出能调的——这条线的工具，和库函数；看图的两个按它能不能看图归组', async (t) => {
    const blind = (await modelCalls(setup(t, { vision: false }), 'fly_to_the_moon')).content
    assert.match(blind, /^There is no tool named "fly_to_the_moon"\. Your tools: report, get_status, .*, report_problem\. Library functions \(in a program: await tool\(name, input\)\): recent_chat, read_log, list_stock, list_drawers, find_uses, list_quest_lines, probe_block, check_blueprint, read_blueprint, haul_items, read_blocks, find_structure, check_structure, total_materials, view_area, view_image\.$/)
    assert.doesNotMatch(/Your tools: (.*)\. Library functions/.exec(blind)![1]!, /view_area|view_image|\bsay\b|whisper/)
    assert.ok(blind.length < 1100, `${blind.length} characters`)
    for (const old of OLD_NAMES) assert.equal(blind.includes(old), false, old)

    const seeing = (await modelCalls(setup(t, { vision: true }), 'fly_to_the_moon')).content
    assert.match(seeing, /Your tools: .*\bview_area\b.*\bview_image\b.*\. Library functions \(in a program: await tool\(name, input\)\): recent_chat, read_log, list_stock, .*, total_materials\.$/)

    // 对话线：列的是它自己的工具和只查不动的库函数
    const talk = (await lineCalls(setup(t, { vision: false }), 'talk', 'fly_to_the_moon')).content
    assert.match(talk, /^There is no tool named "fly_to_the_moon"\. Your tools: say, whisper, tell_worker, worker_status, stop_work, get_status, .*, report_problem\. Library functions \(in a program: await tool\(name, input\)\): recent_chat, read_log, list_stock, .*, total_materials, view_area, view_image\.$/)
    assert.doesNotMatch(talk, /haul_items|go_to|start_routine/)
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
      'What is in one (its materials, its cells): the library function read_blueprint.',
      '1 draft(s), newest first:',
      '- step: 2×1×1 (x east-west × y up × z north-south), 2 block(s) of 1 kind(s), saved 0 min ago',
      '1 image(s) (name: width×height in pixels):',
      '- flag: 2×1',
    ])
    assert.equal((await modelCalls(h, 'list_designs', { kind: 'images' })).content, all.slice(5).join('\n'))

    const got = await program(h, `
      const all = await tool('list_designs', {})
      const old = {}
      for (const name of ['list_blueprints', 'list_drafts', 'list_images']) old[name] = (await tool(name, {})).text
      return { data: [all.data.blueprints.map((b) => b.name), all.data.drafts.map((d) => [d.name, d.blocks]), all.data.images], old }`)
    assert.deepEqual(got.data, [['cabin'], [['step', 2]], [{ name: 'flag', width: 2, height: 1 }]])
    assert.deepEqual(got.old, { list_blueprints: all.slice(0, 3).join('\n'), list_drafts: all.slice(3, 5).join('\n'), list_images: all.slice(5).join('\n') })

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

describe('图纸里有什么（read_blueprint）', () => {
  /** 4×3×4 的石砖小屋（地板加两层墙），屋里一个箱子：和主人上传的图纸一个样。 */
  const CABIN = blueprintOf('cabin', { x: 4, y: 3, z: 4 }, (x, y, z) => (x === 1 && y === 1 && z === 1 ? 2 : y === 0 || x === 0 || x === 3 || z === 0 || z === 3 ? 1 : 0))
  /** 一张大的：128×40×128，一次读不完。 */
  const HALL = blueprintOf('hall', { x: 128, y: 40, z: 128 }, (_x, y) => (y === 0 ? 1 : 0))
  function blueprintOf(name: string, size: { x: number; y: number; z: number }, at: (x: number, y: number, z: number) => number): MockBlueprint {
    const cells = new Uint16Array(size.x * size.y * size.z)
    for (let y = 0; y < size.y; y++) for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) cells[x + (y * size.z + z) * size.x] = at(x, y, z)
    return { name, size, kinds: [{ id: 'minecraft:air', meta: 0, name: 'Air' }, { id: 'minecraft:stonebrick', meta: 0, name: 'Stone Bricks' }, { id: 'minecraft:chest', meta: 3, name: 'Chest', byHand: 'it holds contents or settings' }], cells }
  }
  function withBlueprints(t: { after(fn: () => void): void }) {
    const h = setup(t)
    h.game.handlers['blueprint.read'] = (p) => readBlueprintAnswer(p.name === 'hall' ? HALL : CABIN, p)
    return h
  }
  /** run_program 跑一段返回文字的程序（手册里的例子），返回它 return 的那段文字。 */
  async function returned(h: AgentHarness, code: string): Promise<string> {
    const res = await modelCalls(h, 'run_program', { code })
    assert.equal(res.isError, false, res.content)
    return /^Returned: ([\s\S]*)$/m.exec(res.content)![1]!
  }
  const example = (title: string): string => {
    const manual = fs.readFileSync(path.join(DEFAULT_MANUALS_DIR, 'blueprint.md'), 'utf8')
    const code = new RegExp(`## 例子：${title}[^\\n]*\\n(?:[^\\n]*\\n)*?\`\`\`js\\n([\\s\\S]*?)\`\`\``).exec(manual)?.[1]
    assert.ok(code, `the blueprint manual has the example "${title}"`)
    return code
  }

  it('主人问“这张图纸要哪些材料”：不用知道它放在哪，就拿到整张的材料表（哪些得由人放）；程序拿到每一格；自己的草稿也一样读', async (t) => {
    const h = withBlueprints(t)
    const text = (await modelCalls(h, 'read_blueprint', { name: 'cabin.schematic' })).content.split('\n')
    assert.deepEqual(text, [
      'Blueprint "cabin" (on the server): 4×3×4 (x × y × z), 41 block(s) of 2 kind(s), 1 of them for a player to place by hand.',
      'Materials, for the whole of it:',
      '- 40× Stone Bricks [minecraft:stonebrick]',
      '- 1× Chest [minecraft:chest/3] — a player has to place it: it holds contents or settings',
      'Its cells are in the result data, for a program (data.palette, data.cells).',
    ])
    // 程序里：(1,1,1) 那一格是箱子，地板全是石砖
    const got = await program(h, `
      const bp = (await tool('read_blueprint', { name: 'cabin' })).data
      const at = (x, y, z) => bp.palette[bp.cells[(y * bp.sz + z) * bp.sx + x]].id
      return [bp.source, bp.size, bp.materials.map((m) => [m.id, m.count, m.byHand ?? null]), at(1, 1, 1), at(2, 0, 2), at(1, 2, 1)]`)
    assert.deepEqual(got, ['server', { x: 4, y: 3, z: 4 }, [['minecraft:stonebrick', 40, null], ['minecraft:chest', 1, 'it holds contents or settings']], 'minecraft:chest', 'minecraft:stonebrick', 'minecraft:air'])

    // 它自己的草稿：同一个函数，同一种 data
    await modelCalls(h, 'run_program', { code: `blueprint(2, 1, 1).fill(0, 0, 0, 1, 0, 0, 'minecraft:planks').save('step')` })
    const draft = await program(h, `const d = (await tool('read_blueprint', { name: 'step', draft: true })).data; return [d.source, d.size, d.materials, d.palette.map((p) => p.id), d.cells]`)
    assert.deepEqual(draft, ['draft', { x: 2, y: 1, z: 1 }, [{ id: 'minecraft:planks', meta: 0, count: 2 }], ['minecraft:air', 'minecraft:planks'], [1, 1]])
    assert.equal((await modelCalls(h, 'read_blueprint', { name: 'nope', draft: true })).content, 'There is no draft named "nope". list_designs shows the ones there are.')
  })

  it('大图纸一次读不完格子：材料表照给，写明怎么一块块读；给了 from、to 就读那一块', async (t) => {
    const h = withBlueprints(t)
    const whole = (await modelCalls(h, 'read_blueprint', { name: 'hall' })).content.split('\n')
    assert.deepEqual(whole, [
      'Blueprint "hall" (on the server): 128×40×128 (x × y × z), 16384 block(s) of 1 kind(s).',
      'Materials, for the whole of it:',
      '- 16384× Stone Bricks [minecraft:stonebrick]',
      'It has 655360 cells, more than one read gives (262144), so no cells came with this: give "from" and "to" (corners inside the blueprint, counted from 0) to read them a part at a time, for instance a few layers.',
    ])
    const floor = await program(h, `const d = (await tool('read_blueprint', { name: 'hall', from: { x: 0, y: 0, z: 0 }, to: { x: 127, y: 1, z: 127 } })).data; return [d.sx, d.sy, d.sz, d.cells.length, d.cells[0], d.cells[128 * 128]]`)
    assert.deepEqual(floor, [128, 2, 128, 32768, 1, 0])
  })

  it('手册里的例子“算一张图纸的材料，对一遍身上和仓库”照抄着能跑：每种要多少、身上和仓库各有多少、还差多少，得由人放的单列', async (t) => {
    const h = withBlueprints(t)
    const status = h.game.handlers['bot.status']!
    h.game.handlers['bot.status'] = (p) => ({ ...(status(p) as object), inventory: [{ slot: 0, id: 'minecraft:stonebrick', meta: 0, count: 10, name: 'Stone Bricks' }] })
    // 像身体那样只看得到中心周围 radius 格以内的：那个箱子在 (12,64,-4)
    const sees = (p: Record<string, unknown>): boolean => typeof p.x !== 'number' || Math.max(Math.abs(12 - Number(p.x)), Math.abs(64 - Number(p.y)), Math.abs(-4 - Number(p.z))) <= Number(p.radius)
    h.game.handlers['world.stock'] = (p) => !sees(p) ? { containersLookedInto: 0, items: (p.items as object[]).map((q) => ({ ...q, total: 0, places: [] })) } : ({ containersLookedInto: 1, items: (p.items as { id: string }[]).map((q) => (q.id === 'minecraft:stonebrick' ? { ...q, total: 25, places: [{ x: 12, y: 64, z: -4, container: 'Chest', count: 25 }] } : { ...q, total: 0, places: [] })) })
    assert.deepEqual((await returned(h, example('算一张图纸的材料'))).split('\n'), ['40× Stone Bricks：身上 10，仓库 25，还差 5', '1× Chest：得主人自己放（it holds contents or settings）'])
  })

  it('手册里的例子“不知道原点时，拿图纸和现场比”照抄着能跑：小屋盖在 (30,65,30)，只知道大概在哪也找得到它的最低角', async (t) => {
    const h = withBlueprints(t)
    const blocks: Record<string, string> = {}
    for (let y = 0; y < 3; y++) for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) {
      const kind = CABIN.kinds[CABIN.cells[x + (y * 4 + z) * 4]!]!
      if (kind.id !== 'minecraft:air') blocks[`${30 + x},${65 + y},${30 + z}`] = `${kind.id}/${kind.meta}`
    }
    h.game.handlers['world.blocks'] = (p) => worldBlocksAnswer(p, blocks)
    // 只知道大概在哪：离真正的原点十来格
    const code = example('不知道原点时').replace(/const near = \{[^}]*\}/, 'const near = { x: 41, y: 70, z: 22 }')
    assert.equal(await returned(h, code), '对得最上的位置：最低角在 (30, 65, 30)，样本 41 格里对上 41 格')
  })
})

describe('用 run_command 发悄悄话', () => {
  it('干活线没有 whisper，但它用 run_command 发的 tell / msg / w 送到了，日志和聊天记录里照样记成它说的；对方不在线没送到的不记', async (t) => {
    const h = setup(t)
    h.game.handlers['bot.command'] = (p) => ({ output: String(p.command).includes('Herobrine') ? ['That player cannot be found'] : [`You whisper to Steve: ${String(p.command).slice('tell Steve '.length)}`] })
    await modelCalls(h, 'run_command', { command: 'tell Steve 东西放你箱子里了' })
    await modelCalls(h, 'run_command', { command: 'msg Herobrine 在吗' })
    assert.deepEqual(h.game.callsOf('bot.command').map((p) => p.command), ['tell Steve 东西放你箱子里了', 'msg Herobrine 在吗'])
    assert.deepEqual(h.game.said, [])
    // 面板的对话日志里这句话记成它说的，标着是干活线
    assert.deepEqual(h.log.recent(0, 80).filter((e) => e.kind === 'say').map((e) => [e.agent, e.channel, e.to, e.text]), [['work', 'whisper', 'Steve', '东西放你箱子里了']])
    assert.deepEqual(h.chatLog.recent().lines.filter((l) => l.kind === 'whispered').map((l) => [l.to, l.text]), [['Steve', '东西放你箱子里了']])
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
