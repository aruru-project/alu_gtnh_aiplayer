// 看面板用的一整套假环境（不连真的游戏，不用真的模型）：
//   模拟身体（mock-bridge，身上带一背包真实物品 id 的东西）← 真的大脑（子进程，src/main.ts）← 一层代理 ← 浏览器
//
//   node test/panel-dev.ts [--shape fake|real] [--lines 1|2] [--scene idle|thinking|tools|routine|outage|picture|waiting] [--sample <活动日志.jsonl>]
//
// 代理（127.0.0.1:28771）把请求原样转给大脑的面板（127.0.0.1:28772），只有“它在干什么”这几个接口可以由这里顶替：
//   --shape real    什么都不顶替：看到的就是大脑真实给的（模型是模拟的，只认得“平”“跟”“停”“看看”几个字）。
//   --shape fake    （默认）/api/status、/api/log、/api/events、/api/runs、/api/runs/records 由这里给，形状和大脑给的一样
//                   （docs/BRAIN_SPEC.md 的“面板的数据接口”）。这样可以把“正在想第 3 步”“例程跑到一半”这些一闪而过的时刻摆住了看。
//                   时间线是把样本日志（--sample，旧形状：没有 model_call，例程每一步各两条）转成新形状得来的，后面接一段照 --scene 摆的“现在”。
//   --lines 2       假数据里把一条线换成“对话”“干活”两条线（docs/TALK_WORK.md，后端还没实现）：各有各的模型状态，日志条目带 agent。
// 换场景不用重启：POST /__dev/scene {"name":"routine"}；GET /__dev 看现在的设置和面板口令。
//
// 端口只用留给模拟服务的那些（见 ports.ts）：身体 25610，模型 25611，大脑面板 28772，代理 28771。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { MockBridge } from './mock-bridge.ts'
import { MockLlm } from './mock-llm.ts'
import type { MockReply, RecordedLlmRequest } from './mock-llm.ts'

type Json = Record<string, any>

const BRAIN = path.resolve(import.meta.dirname, '..')
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback
}
const SHAPE = arg('shape', 'fake')
const LINES = Number(arg('lines', '1'))
let scene = arg('scene', 'idle')
const DATA_DIR = path.resolve(BRAIN, arg('data', 'data/panel-dev'))
const SAMPLE = path.resolve(BRAIN, arg('sample', 'data/panel-sample/activity-2026-11-11.jsonl'))
const PACKDATA = path.resolve(BRAIN, arg('packdata', process.env.AIPLAYER_PACKDATA ?? 'packdata'))
const BRIDGE_PORT = 25610
const LLM_PORT = 25611
const BRAIN_PORT = 28772
const PROXY_PORT = Number(arg('port', '28771'))
const TOKEN = 'mock-token'
const BOT = 'Alu'

// ── 模拟身体：一背包东西、一身盔甲、旁边有人、脚下有地形 ──

const bridge = new MockBridge({ port: BRIDGE_PORT, token: TOKEN, bots: [BOT], autoFinishMs: 6000 })
const bot = bridge.bots.get(BOT)!
bot.pos = { x: -521.5, y: 69, z: 43.5 }
bot.health = 17
bot.food = 15
bot.inventory = [
  { slot: 0, id: 'TConstruct:pickaxe', meta: 0, count: 1, name: 'Steel Pickaxe', durability: 0.83 },
  { slot: 1, id: 'TConstruct:shovel', meta: 0, count: 1, name: 'Steel Shovel', durability: 0.41 },
  { slot: 2, id: 'TConstruct:hatchet', meta: 0, count: 1, name: 'Steel Hatchet', durability: 0.12 },
  { slot: 3, id: 'chisel:diamondChisel', meta: 0, count: 1, name: 'Diamond Chisel', durability: 0.96 },
  { slot: 4, id: 'gregtech:gt.metatool.01', meta: 22, count: 1, name: 'Screwdriver' },
  { slot: 6, id: 'minecraft:torch', meta: 0, count: 48, name: 'Torch' },
  { slot: 7, id: 'minecraft:bread', meta: 0, count: 12, name: 'Bread' },
  { slot: 8, id: 'Backpack:backpack', meta: 0, count: 1, name: 'Backpack' },
  { slot: 9, id: 'minecraft:dirt', meta: 0, count: 64, name: 'Dirt' },
  { slot: 10, id: 'minecraft:dirt', meta: 0, count: 64, name: 'Dirt' },
  { slot: 11, id: 'chisel:dirt', meta: 0, count: 64, name: 'Dirt' },
  { slot: 12, id: 'minecraft:cobblestone', meta: 0, count: 64, name: 'Cobblestone' },
  { slot: 13, id: 'minecraft:planks', meta: 0, count: 37, name: 'Oak Wood Planks' },
  { slot: 14, id: 'minecraft:log', meta: 0, count: 9, name: 'Oak Wood' },
  { slot: 15, id: 'minecraft:glass', meta: 0, count: 16, name: 'Glass' },
  { slot: 18, id: 'gregtech:gt.metaitem.01', meta: 11305, count: 24, name: 'Steel Ingot' },
  { slot: 19, id: 'gregtech:gt.metaitem.01', meta: 17305, count: 6, name: 'Steel Plate' },
  { slot: 20, id: 'gregtech:gt.metaitem.01', meta: 27305, count: 16, name: 'Steel Screw' },
  { slot: 21, id: 'gregtech:gt.metaitem.01', meta: 2032, count: 5, name: 'Iron Dust' },
  { slot: 22, id: 'gregtech:gt.metaitem.01', meta: 2019, count: 2, name: 'Aluminium Dust' },
  { slot: 23, id: 'gregtech:gt.metaitem.01', meta: 5036, count: 3, name: 'Crushed Zinc Ore' },
  { slot: 24, id: 'IC2:itemRecipePart', meta: 12, count: 4, name: 'Shaft (Refined Iron)' },
  { slot: 27, id: 'harvestcraft:wovencottonItem', meta: 0, count: 3, name: 'Woven Cotton' },
  { slot: 28, id: 'Backpack:tannedLeather', meta: 0, count: 5, name: 'Tanned Leather' },
  { slot: 29, id: 'gregtech:gt.integrated_circuit', meta: 1, count: 1, name: 'Programmed Circuit 1' },
  { slot: 30, id: 'minecraft:coal', meta: 1, count: 20, name: 'Charcoal' },
  { slot: 31, id: 'gregtech:gt.blockmachines', meta: 11, count: 2, name: 'LV Machine Hull' },
  { slot: 32, id: 'adventurebackpack:backpackComponent', meta: 6, count: 1, name: 'Copter Blades' },
  { slot: 35, id: 'unknownmod:mystery_widget', meta: 3, count: 7, name: 'Mystery Widget' },
]
bridge.players = [
  { name: '阿露', uuid: 'uuid-owner', dim: 0, pos: { x: -517.5, y: 69, z: 38.5 } },
  { name: 'Steve', uuid: 'uuid-steve', dim: 0, pos: { x: -560.5, y: 71, z: 90.5 } },
  { name: 'Exporter', uuid: 'uuid-exp', dim: -1, pos: { x: 0.5, y: 64, z: 0.5 } },
]
/** 走开了的真人（POST /__dev/bot { players: false }）。 */
let awayPlayers: typeof bridge.players = []
/** 它身上开着的界面（null 是没开）。 */
let openScreen: Json | null = null

bridge.on('bot.status', () => {
  const online = bot.online
  const base = { name: bot.name, uuid: `uuid-${bot.name}`, online, settings: bot.settings, task: bot.task, queue: bot.queue }
  if (!online) return base
  return {
    ...base,
    dim: 0,
    pos: bot.pos,
    block: { x: Math.floor(bot.pos.x), y: Math.floor(bot.pos.y), z: Math.floor(bot.pos.z) },
    yaw: -160,
    pitch: 8,
    onGround: true,
    inWater: false,
    health: bot.health,
    maxHealth: 20,
    food: bot.food,
    xpLevel: 7,
    heldSlot: 0,
    held: bot.inventory.find((i) => i.slot === 0) ?? null,
    inventory: bot.inventory,
    armor: [
      { id: 'minecraft:leather_boots', meta: 0, count: 1, name: 'Leather Boots', durability: 0.7 },
      null,
      { id: 'minecraft:iron_chestplate', meta: 0, count: 1, name: 'Iron Chestplate', durability: 0.9 },
      { id: 'minecraft:iron_helmet', meta: 0, count: 1, name: 'Iron Helmet', durability: 0.55 },
    ],
    freeSlots: 36 - bot.inventory.length,
  }
})
bridge.on('screen.look', () => openScreen ?? { open: false })

/** 一片有起伏的假地形：草地、一条河、沙岸、一条石路、几棵树、一块圆石地基。 */
bridge.on('world.scan', (p) => {
  const x1 = Math.min(Number(p.x1), Number(p.x2))
  const x2 = Math.max(Number(p.x1), Number(p.x2))
  const z1 = Math.min(Number(p.z1), Number(p.z2))
  const z2 = Math.max(Number(p.z1), Number(p.z2))
  const palette = ['minecraft:grass', 'minecraft:water', 'minecraft:sand', 'minecraft:stonebrick', 'minecraft:log', 'minecraft:cobblestone', 'minecraft:planks', 'chisel:marble', 'gregtech:gt.blockmachines']
  const heights: number[][] = []
  const tops: number[][] = []
  const noise = (x: number, z: number): number => Math.sin(x * 0.19) * 1.6 + Math.cos(z * 0.23) * 1.4 + Math.sin((x + z) * 0.07) * 2.2
  for (let z = z1; z <= z2; z++) {
    const hRow: number[] = []
    const tRow: number[] = []
    for (let x = x1; x <= x2; x++) {
      const river = Math.abs(z - (60 + Math.sin(x * 0.12) * 5))
      let top = 0
      let h = Math.round(69 + noise(x, z))
      if (river < 2.2) {
        top = 1
        h = 66
      } else if (river < 3.6) {
        top = 2
        h = 67
      }
      if (x >= -530 && x <= -512 && z >= 34 && z <= 48 && river >= 3.6) {
        top = (x + z) % 7 === 0 ? 7 : 5
        h = 68
        if (x >= -526 && x <= -520 && z >= 36 && z <= 41) {
          top = 6
          h = 72
        }
      }
      if (x === -510 && river >= 2.2) {
        top = 3
        h = Math.max(h, 68)
      }
      if (top === 0 && (x * 31 + z * 17) % 53 === 0) {
        top = 4
        h += 5
      }
      if (x === -515 && z === 45) {
        top = 8
        h = 69
      }
      hRow.push(h)
      tRow.push(top)
    }
    heights.push(hRow)
    tops.push(tRow)
  }
  return { x1, z1, x2, z2, heights, tops, palette, liquidPalette: [1], stats: { minY: 66, maxY: 78, modeY: 69, meanY: 69.2, columns: (x2 - x1 + 1) * (z2 - z1 + 1), unloaded: 0 }, liquidColumns: 0, tileEntities: [] }
})

function setScreen(on: boolean): void {
  openScreen = on
    ? {
        open: true,
        screen: 'ContainerChisel',
        slotCount: 97,
        slots: [
          ...['minecraft:dirt', 'chisel:dirt', 'chisel:dirt', 'chisel:dirt'].map((id, n) => ({ slot: n, takesNothing: true, item: { id, meta: n > 1 ? n : 0, count: 1, name: 'Dirt' } })),
          ...Array.from({ length: 20 }, (_, n) => ({ slot: 4 + n, takesNothing: true })),
          { slot: 60, item: { id: 'minecraft:dirt', meta: 0, count: 64, name: 'Dirt' } },
          { slot: 61, ghost: true, item: { id: 'gregtech:gt.integrated_circuit', meta: 1, count: 1, name: 'Programmed Circuit 1' } },
          ...bot.inventory.map((i) => ({ slot: 62 + i.slot, own: true, item: { id: i.id, meta: i.meta, count: i.count, name: i.name } })),
        ],
        // 界面上格子以外的东西（形状照 docs/PROTOCOL.md 的“界面上的控件”；内容是随手摆的，为了看面板怎么画）
        controls: [
          { panel: 'basicmachine.fluidextractor.tier.02', key: 'powerSwitch:0', kind: 'switch', value: true },
          { panel: 'basicmachine.fluidextractor.tier.02', key: 'fluidAutoOutput:0', kind: 'switch', value: false },
          { panel: 'basicmachine.fluidextractor.tier.02', key: 'powerfail:0', kind: 'switch', value: false, readOnly: true },
          { panel: 'basicmachine.fluidextractor.tier.02', key: 'cover_panel_west', kind: 'panel', open: false },
          { panel: 'basicmachine.fluidextractor.tier.02', key: 'auto_sync:tank:3', kind: 'fluid', fluid: 'molten.steel', name: 'Molten Steel', amount: 288, capacity: 32000, fills: false, drains: true },
          { panel: 'basicmachine.fluidextractor.tier.02', key: 'auto_sync:tank:4', kind: 'fluid', capacity: 16000, fills: true, drains: false },
          { panel: 'basicmachine.fluidextractor.tier.02', key: 'outputSide', kind: 'choice', value: 'WEST', options: ['NORTH', 'SOUTH', 'WEST', 'EAST'] },
          { panel: 'basicmachine.fluidextractor.tier.02', key: 'progress:0', kind: 'value', value: '37 / 80' },
        ],
      }
    : null
}

// ── 新形状的假数据 ──

interface Entry extends Json {
  id: number
  time: number
  kind: string
  text: string
}

const entries: Entry[] = []
const runFiles = new Map<string, Json[]>()
const runList: Json[] = []
const listeners = new Set<(e: Entry) => void>()
let nextId = 1

function add(e: Omit<Entry, 'id' | 'time'> & { time?: number }): Entry {
  const entry = { ...e, id: nextId++, time: e.time ?? Date.now() } as Entry
  entries.push(entry)
  for (const fn of listeners) fn(entry)
  return entry
}

function update(id: number, patch: Json): void {
  const at = entries.findIndex((e) => e.id === id)
  if (at < 0) return
  entries[at] = { ...entries[at]!, ...patch }
  for (const fn of listeners) fn(entries[at]!)
}

function callText(c: Json): string {
  if (c.state === 'thinking') return `第 ${c.step} 步：正在想`
  return `第 ${c.step} 步：${(c.ms / 1000).toFixed(1)} 秒，输入 ${c.inputTokens}（缓存命中 ${c.cacheReadTokens}）/ 输出 ${c.outputTokens} token${c.toolCalls ? `，要调 ${c.toolCalls} 个工具` : ''}`
}

/** 把旧形状的样本日志转成新形状（步的分界是按时间间隔猜的：模型想的那几秒）。 */
function convertSample(file: string): void {
  let rows: Json[]
  try {
    rows = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Json)
  } catch {
    console.log(`[dev] 没有样本日志（${file}），时间线从空的开始。`)
    return
  }
  // 只要到样本里主人最后一次测试为止（后面是别的测试刷的一串聊天）
  const cut = rows.findLastIndex((r) => r.kind === 'turn' && r.time < 1794383400000)
  rows = rows.slice(0, cut + 1)
  const shift = Date.now() - 20 * 60_000 - (rows[rows.length - 1]?.time ?? Date.now())
  const routines = new Map<string, { entry: Entry; file: string; records: Json[]; run: Json; pending: Map<string, Json> }>()
  let program: { entry: Entry; file: string; records: Json[]; run: Json; pending: Map<string, Json> } | undefined
  let programs = 0
  const steps = new Map<number, { n: number; lastResultAt: number; callEntry?: Entry; tools: number; tokens: number }>()
  const stepOf = (turn: number, time: number, opens: boolean): number => {
    let s = steps.get(turn)
    if (!s) {
      s = { n: 0, lastResultAt: time, tools: 0, tokens: 2000 + (turn % 7) * 9000 }
      steps.set(turn, s)
    }
    // 上一个工具结果之后隔了半秒以上才来的东西：模型又想了一次
    if (opens && (s.n === 0 || time - s.lastResultAt > 500)) {
      s.n++
      s.tools = 0
      s.tokens += 1800 + ((turn * 131 + s.n * 977) % 2600)
      const ms = Math.max(600, time - s.lastResultAt)
      const call = { state: 'done', purpose: 'turn', step: s.n, startedAt: s.lastResultAt + shift, ms, model: 'gpt-6-luna', inputTokens: s.tokens, outputTokens: 60 + ((turn * 37 + s.n * 53) % 420), cacheReadTokens: s.n === 1 ? 0 : Math.round(s.tokens * 0.93), stop: 'tool_calls', toolCalls: 0 }
      s.callEntry = add({ kind: 'model_call', turn, step: s.n, time: s.lastResultAt + shift, text: callText(call), call })
    }
    return s.n
  }
  const runRecord = (r: { records: Json[]; pending: Map<string, Json>; run: Json }, row: Json, text: string): void => {
    if (row.kind === 'tool_call') {
      let input: unknown = text
      try {
        input = JSON.parse(text)
      } catch {
        /* 截短了的参数：原样 */
      }
      const rec = { t: 'call', time: row.time + shift, n: ++r.run.calls, tool: row.who, input, ok: true, text: '', ms: 0 }
      r.records.push(rec)
      r.pending.set(row.who, rec)
    } else {
      const rec = r.pending.get(row.who)
      if (!rec) return
      rec.ok = row.isError !== true
      rec.text = row.detail ?? text
      rec.ms = row.time + shift - rec.time
      const task = /^(\w+) \w+ \[(done|failed|canceled)\]/.exec(text)
      if (task) {
        rec.task = task[1]
        r.run.tasks++
      }
      if (!rec.ok) r.run.errors++
    }
  }
  for (const row of rows) {
    const time = row.time + shift
    const text = String(row.text ?? '')
    if (row.kind === 'tool_call' || row.kind === 'tool_result') {
      const routine = /^\[例程 (r\d+)\] ?/.exec(text)
      if (routine) {
        const r = routines.get(routine[1]!)
        if (!r) continue
        runRecord(r, row, text.slice(routine[0].length))
        if (row.kind === 'tool_result' && row.isError) add({ kind: 'tool_result', who: row.who, time, text: text.slice(routine[0].length), detail: row.detail, isError: true, source: 'routine', runId: routine[1] })
        continue
      }
      if (text.startsWith('[程序] ')) {
        if (!program) {
          const id = `p${++programs}`
          const file = `program-${id}.jsonl`
          const run = { id, kind: 'program', name: '', status: 'running', startedAt: time, calls: 0, tasks: 0, errors: 0, file }
          program = { entry: add({ kind: 'run', source: 'program', runId: id, time, text: '', run: { ...run } }), file, records: [{ t: 'start', time, id, kind: 'program', name: '', code: '' }], run, pending: new Map() }
          runFiles.set(file, program.records)
        }
        runRecord(program, row, text.slice(5))
        continue
      }
      if (typeof row.turn === 'number') {
        const s = steps.get(row.turn)
        if (row.kind === 'tool_call') {
          const n = stepOf(row.turn, row.time, true)
          const st = steps.get(row.turn)!
          st.tools++
          if (st.callEntry) update(st.callEntry.id, { call: { ...st.callEntry.call, toolCalls: st.tools }, text: callText({ ...st.callEntry.call, toolCalls: st.tools }) })
          if (st.callEntry) st.callEntry.call.toolCalls = st.tools
          add({ ...row, id: undefined, time, source: 'model', step: n } as any)
        } else {
          // run_program 的结果回来了：它里面那次程序运行到此为止
          if (row.who === 'run_program' && program) {
            program.run.status = row.isError ? 'failed' : 'done'
            program.run.endedAt = time
            program.records.push({ t: 'end', time, status: program.run.status, ending: 'the program finished', calls: program.run.calls, tasks: 0, errors: program.run.errors })
            update(program.entry.id, { run: { ...program.run }, text: `程序 ${program.run.id}：${program.run.calls} 次调用` })
            runList.unshift({ ...program.run })
            program = undefined
          }
          add({ ...row, id: undefined, time, source: 'model', step: s?.n ?? 1 } as any)
          if (s) s.lastResultAt = row.time
        }
        continue
      }
    }
    if (row.kind === 'model_text' && typeof row.turn === 'number') {
      const n = stepOf(row.turn, row.time, true)
      const st = steps.get(row.turn)!
      if (st.callEntry && st.tools === 0) {
        const call = { ...st.callEntry.call, stop: 'end' }
        st.callEntry.call = call
        update(st.callEntry.id, { call, text: callText(call) })
      }
      add({ ...row, id: undefined, time, step: n } as any)
      continue
    }
    if (row.kind === 'turn' && typeof row.turn === 'number' && text.includes('轮开始')) {
      add({ ...row, id: undefined, time } as any)
      steps.set(row.turn, { n: 0, lastResultAt: row.time, tools: 0, tokens: 2000 + (row.turn % 7) * 9000 })
      continue
    }
    const started = /^例程 (r\d+)（([\s\S]*?)）开始在后台跑/.exec(text)
    if (started) {
      const id = started[1]!
      const file = `routine-${new Date(time).toISOString().replace(/\D/g, '').slice(0, 14)}-${id}.jsonl`
      const run = { id, kind: 'routine', name: started[2], status: 'running', startedAt: time, calls: 0, tasks: 0, errors: 0, file }
      add({ kind: 'info', time, text, detail: row.detail, source: 'routine', runId: id, run: { ...run } })
      const r = { entry: add({ kind: 'run', source: 'routine', runId: id, time, text: '', run: { ...run } }), file, records: [{ t: 'start', time, id, kind: 'routine', name: started[2], code: row.detail ?? '' }] as Json[], run, pending: new Map<string, Json>() }
      routines.set(id, r)
      runFiles.set(file, r.records)
      continue
    }
    const ended = /^例程 (r\d+)（([\s\S]*?)）(跑完了|停了)：?([\s\S]*)$/.exec(text)
    if (ended) {
      const r = routines.get(ended[1]!)
      if (r) {
        r.run.status = ended[3] === '跑完了' ? 'done' : 'stopped'
        r.run.endedAt = time
        r.records.push({ t: 'end', time, status: r.run.status, ending: ended[4], calls: r.run.calls, tasks: r.run.tasks, errors: r.run.errors })
        update(r.entry.id, { run: { ...r.run }, text: `例程 ${r.run.id}（${r.run.name}）：${ended[3]}，调了 ${r.run.calls} 次工具` })
        add({ kind: row.kind, time, text, detail: row.detail, source: 'routine', runId: r.run.id, run: { ...r.run } })
        runList.unshift({ ...r.run })
        routines.delete(ended[1]!)
        continue
      }
    }
    add({ ...row, id: undefined, time } as any)
  }
  console.log(`[dev] 样本日志转成了 ${entries.length} 条新形状的条目，${runFiles.size} 次程序运行。`)
}

// ── “现在”的场景：状态接口回什么，时间线最后接什么 ──

const MODELS = { talk: { provider: '模拟接口', model: 'mock-fast' }, work: { provider: '模拟接口', model: 'mock-deep' }, main: { provider: '模拟接口', model: 'mock-deep' } }
let live: { agents: Json[] } = { agents: [] }
let ticker: NodeJS.Timeout | undefined
let liveTurn = 900

function idleAgent(agent: string, extra: Json = {}): Json {
  const two = agent !== 'main'
  return {
    agent,
    name: BOT,
    ...(two ? { title: agent === 'talk' ? '对话线' : '干活线', history: agent === 'talk' ? { turns: 12, hasSummary: false, estimatedTokens: 5400, threshold: 60000 } : { turns: 80, hasSummary: true, estimatedTokens: 152000, threshold: 200000 } } : {}),
    model: { state: 'idle', ...MODELS[agent as keyof typeof MODELS], lastCall: { time: Date.now() - 95_000, ok: true, durationMs: agent === 'talk' ? 1400 : 4210, model: 'mock', inputTokens: agent === 'talk' ? 9800 : 48211, outputTokens: 212, cacheReadTokens: agent === 'talk' ? 8800 : 44100 } },
    turn: null,
    pending: 0,
    ...extra,
  }
}

const noBody = (): Json => ({ ...(LINES === 2 ? { waitingAnswer: null, lastReport: lastReport } : {}), routine: null, lastRoutine: runList.find((r) => r.kind === 'routine') ?? null, body: { online: bot.online, task: null, queue: [] } })
/** 两条线的那段戏里，干活线最后一次送给对话线的。 */
let lastReport: Json | null = null

function setScene(name: string): void {
  scene = name
  clearInterval(ticker)
  setScreen(false)
  const now = Date.now()
  const worker = LINES === 2 ? 'work' : 'main'
  const agents: Json[] = LINES === 2 ? [idleAgent('talk'), idleAgent('work', noBody())] : [idleAgent('main', noBody())]
  const w = agents[agents.length - 1]!
  const turn = ++liveTurn
  const tag = LINES === 2 ? { agent: worker } : {}
  if (name === 'thinking' || name === 'tools') {
    if (LINES === 2) {
      add({ kind: 'command', who: '面板', time: now - 31_000, text: '把身上的泥土都凿成凿子泥土，放进 (-519,69,85) 的箱子。' })
      add({ kind: 'turn', turn: turn + 1000, agent: 'talk', time: now - 30_500, text: `第 ${turn + 1000} 轮开始（模拟接口 / mock-fast）：主人通过控制面板对你说：把身上的泥土都凿成凿子泥土…`, detail: '[需要你处理的事]\n主人通过控制面板对你说：把身上的泥土都凿成凿子泥土，放进 (-519,69,85) 的箱子。\n\n[干活线]\n空闲' })
      const c = { state: 'done', purpose: 'turn', step: 1, startedAt: now - 30_000, ms: 1900, model: 'mock-fast', inputTokens: 5210, outputTokens: 96, cacheReadTokens: 4400, stop: 'tool_calls', toolCalls: 1 }
      add({ kind: 'model_call', turn: turn + 1000, step: 1, agent: 'talk', time: now - 30_000, text: callText(c), call: c })
      add({ kind: 'say', who: BOT, agent: 'talk', turn: turn + 1000, step: 1, time: now - 28_000, text: '好，我这就去凿。' })
      add({ kind: 'tool_call', turn: turn + 1000, step: 1, agent: 'talk', source: 'model', who: 'tell_worker', time: now - 27_800, text: '{"text":"把身上的泥土都用钻石凿子凿成凿子泥土（chisel:dirt），放进 (-519,69,85) 的箱子。"}' })
      add({ kind: 'relay', agent: 'talk', turn: turn + 1000, step: 1, time: now - 27_750, text: '对话线 → 干活线：把身上的泥土都用钻石凿子凿成凿子泥土（chisel:dirt），放进 (-519,69,85) 的箱子。', detail: '把身上的泥土都用钻石凿子凿成凿子泥土（chisel:dirt），放进 (-519,69,85) 的箱子。\n\n[主人的原话]\n（面板）把身上的泥土都凿成凿子泥土，放进 (-519,69,85) 的箱子。', relay: { type: 'tell', from: 'talk', to: 'work', quotes: 1 } })
      add({ kind: 'tool_result', turn: turn + 1000, step: 1, agent: 'talk', source: 'model', who: 'tell_worker', time: now - 27_700, text: 'Handed to the working line; it starts now.' })
      add({ kind: 'turn', turn: turn + 1000, agent: 'talk', time: now - 26_000, text: `第 ${turn + 1000} 轮结束（调了 1 次模型，模拟接口 / mock-fast）` })
    } else {
      add({ kind: 'command', who: '面板', time: now - 27_000, text: '把身上的泥土都凿成凿子泥土，放进 (-519,69,85) 的箱子。' })
    }
    add({ kind: 'turn', turn, ...tag, time: now - 26_000, text: `第 ${turn} 轮开始（模拟接口 / mock-deep）：${LINES === 2 ? '对话线交来的事：把身上的泥土都用钻石凿子凿成凿子泥土…' : '主人通过控制面板对你说：把身上的泥土都凿成凿子泥土…'}`, detail: `[需要你处理的事]\n${LINES === 2 ? '对话线交来的事：把身上的泥土都用钻石凿子凿成凿子泥土（chisel:dirt），放进 (-519,69,85) 的箱子。\n主人的原话：把身上的泥土都凿成凿子泥土，放进 (-519,69,85) 的箱子。' : '主人通过控制面板对你说：把身上的泥土都凿成凿子泥土，放进 (-519,69,85) 的箱子。'}\n\n[当前状态]\nAlu: online in overworld (dim 0) at block (-522,69,43), health 17/20, food 15` })
    const c1 = { state: 'done', purpose: 'turn', step: 1, startedAt: now - 26_000, ms: 6400, model: 'mock-deep', inputTokens: 181204, outputTokens: 412, cacheReadTokens: 176900, cacheWriteTokens: 4100, stop: 'tool_calls', toolCalls: 1 }
    add({ kind: 'model_call', turn, step: 1, ...tag, time: now - 26_000, text: callText(c1), call: c1 })
    add({ kind: 'tool_call', turn, step: 1, ...tag, source: 'model', who: 'read_manual', time: now - 19_500, text: '{"name":"screens"}' })
    add({ kind: 'tool_result', turn, step: 1, ...tag, source: 'model', who: 'read_manual', time: now - 19_450, text: 'Manual "screens": 要用一个没有现成任务的界面（凿子、别的模组的机器）时看。', detail: 'Manual "screens": 要用一个没有现成任务的界面（凿子、别的模组的机器）时看。\n\n先 open_screen 打开，看格子；按着 Shift 点自己的一格，东西会进界面里该去的地方……' })
    const c2 = { state: 'done', purpose: 'turn', step: 2, startedAt: now - 19_400, ms: 5100, model: 'mock-deep', inputTokens: 184460, outputTokens: 158, cacheReadTokens: 181204, stop: 'tool_calls', toolCalls: 2 }
    add({ kind: 'model_call', turn, step: 2, ...tag, time: now - 19_400, text: callText(c2), call: c2 })
    add({ kind: 'tool_call', turn, step: 2, ...tag, source: 'model', who: 'open_screen', time: now - 14_200, text: '{"item":{"id":"chisel:diamondChisel"}}' })
    add({ kind: 'tool_result', turn, step: 2, ...tag, source: 'model', who: 'open_screen', time: now - 14_100, text: 'Screen "ContainerChisel" is open (97 slots in all).', detail: 'Screen "ContainerChisel" is open (97 slots in all).\nIts slots (61):\n- slot 0 (OUTPUT): empty\n- slot 60: empty\n…' })
    add({ kind: 'tool_call', turn, step: 2, ...tag, source: 'model', who: 'click_slot', time: now - 14_000, text: '{"slot":71,"shift":true}' })
    add({ kind: 'tool_result', turn, step: 2, ...tag, source: 'model', who: 'click_slot', time: now - 13_900, text: 'Screen "ContainerChisel" is open (97 slots in all).' })
    setScreen(true)
    if (name === 'thinking') {
      const c3 = { state: 'thinking', purpose: 'turn', step: 3, startedAt: now - 8000 }
      add({ kind: 'model_call', turn, step: 3, ...tag, time: now - 8000, text: callText(c3), call: c3 })
      w.model = { state: 'thinking', ...MODELS[worker as keyof typeof MODELS], turn, step: 3, since: now - 8000, lastCall: { time: now - 14_300, ok: true, durationMs: 5100, model: 'mock-deep', inputTokens: 184460, outputTokens: 158, cacheReadTokens: 181204 } }
      w.turn = { id: turn, startedAt: now - 26_000, steps: 2, maxSteps: 60, ...(LINES === 2 ? { about: '对话线交来的事：把身上的泥土都用钻石凿子凿成凿子泥土（chisel:dirt），放进 (-519,69,85) 的箱子。' } : {}) }
    } else {
      const c3 = { state: 'done', purpose: 'turn', step: 3, startedAt: now - 13_800, ms: 4900, model: 'mock-deep', inputTokens: 186020, outputTokens: 122, cacheReadTokens: 184460, stop: 'tool_calls', toolCalls: 1 }
      add({ kind: 'model_call', turn, step: 3, ...tag, time: now - 13_800, text: callText(c3), call: c3 })
      add({ kind: 'tool_call', turn, step: 3, ...tag, source: 'model', who: 'deposit_items', time: now - 8800, text: '{"container":{"x":-519,"y":69,"z":85},"items":[{"id":"chisel:dirt","meta":0,"count":64}]}' })
      w.model = { state: 'tools', ...MODELS[worker as keyof typeof MODELS], turn, step: 3, lastCall: { time: now - 8900, ok: true, durationMs: 4900, model: 'mock-deep', inputTokens: 186020, outputTokens: 122, cacheReadTokens: 184460 } }
      w.turn = { id: turn, startedAt: now - 26_000, steps: 3, maxSteps: 60, ...(LINES === 2 ? { about: '对话线交来的事：把身上的泥土都用钻石凿子凿成凿子泥土（chisel:dirt），放进 (-519,69,85) 的箱子。' } : {}) }
      w.body = { online: true, task: { id: 'tmwbq001', type: 'deposit', state: 'running', progress: { done: 2, total: 5, phase: '走到箱子旁边' }, startedAt: now - 8700 }, queue: [{ id: 'tmwbq002', type: 'withdraw', state: 'queued' }] }
      w.pending = 1
    }
  } else if (name === 'routine') {
    const id = `r${runList.filter((r) => r.kind === 'routine').length + 1}`
    const file = `routine-live-${id}.jsonl`
    const run: Json = { id, kind: 'routine', name: '把泥土一组组凿好放进箱子', status: 'running', startedAt: now - 64_000, calls: 312, tasks: 150, errors: 1, waiting: 'withdraw_items {"container":{"x":-519,"y":69,"z":85},"items":[{"id":"minecraft:dirt","meta":0,"count":64}]}', file, limitMs: 7_200_000 }
    const code = "const chest = {x:-519,y:69,z:85}\nfor (let n = 0; n < 40; n++) {\n  await tool('withdraw_items', {container: chest, items: [{id:'minecraft:dirt', meta:0, count:64}]})\n  await tool('open_screen', {item:{id:'chisel:diamondChisel'}})\n  await tool('click_slot', {slot: 89, shift: true})\n  await tool('click_slot', {slot: 1, shift: true})\n  await tool('close_screen', {})\n  await tool('deposit_items', {container: chest, items: [{id:'chisel:dirt', meta:0, count:64}]})\n  log('done ' + (n + 1))\n}\nreturn 'ok'"
    add({ kind: 'info', time: now - 64_000, ...tag, text: `例程 ${id}（${run.name}）开始在后台跑。`, detail: code, source: 'routine', runId: id, run: { ...run, calls: 0, tasks: 0, errors: 0, waiting: undefined } })
    const runEntry = add({ kind: 'run', time: now - 64_000, ...tag, source: 'routine', runId: id, text: `例程 ${id}（${run.name}）：在跑`, run: { ...run } })
    add({ kind: 'tool_result', time: now - 31_000, ...tag, who: 'click_slot', source: 'routine', runId: id, isError: true, text: 'No screen is open right now.', detail: '参数：{"slot":89,"shift":true}\n\nNo screen is open right now. A screen can take a moment to appear after opening: look again with open_screen without arguments.' })
    const records: Json[] = [{ t: 'start', time: now - 64_000, id, kind: 'routine', name: run.name, code }]
    const TOOLS = ['withdraw_items', 'open_screen', 'click_slot', 'click_slot', 'close_screen', 'deposit_items']
    for (let n = 1; n <= run.calls; n++) {
      const tool = TOOLS[(n - 1) % TOOLS.length]!
      const task = tool === 'withdraw_items' || tool === 'deposit_items'
      records.push({ t: 'call', time: now - 64_000 + n * 200, n, tool, input: task ? { container: { x: -519, y: 69, z: 85 }, items: [{ id: tool === 'withdraw_items' ? 'minecraft:dirt' : 'chisel:dirt', meta: 0, count: 64 }] } : tool === 'click_slot' ? { slot: n % 2 ? 89 : 1, shift: true } : {}, ok: n !== 157, text: n === 157 ? 'No screen is open right now.' : task ? `tmwb${n} ${tool === 'withdraw_items' ? 'withdraw' : 'deposit'} [done] result={"moved":64}` : 'Screen "ContainerChisel" is open (97 slots in all).', ms: task ? 420 : 48, ...(task ? { task: `tmwb${n}` } : {}) })
      if (n % 6 === 0) records.push({ t: 'log', time: now - 64_000 + n * 200, text: `done ${n / 6}` })
    }
    runFiles.set(file, records)
    w.routine = run
    w.lastRoutine = null
    w.body = { online: true, task: { id: 'tmwbr150', type: 'withdraw', state: 'running', progress: { done: 0, total: 1, phase: '打开箱子' }, startedAt: now - 900 }, queue: [] }
    // 跑着：每秒多几次调用，汇总那一条原地更新
    ticker = setInterval(() => {
      run.calls += 3
      run.tasks += 1
      const tool = TOOLS[run.calls % TOOLS.length]!
      run.waiting = `${tool} {"container":{"x":-519,"y":69,"z":85}}`
      records.push({ t: 'call', time: Date.now(), n: run.calls, tool, input: {}, ok: true, text: 'ok', ms: 50 })
      update(runEntry.id, { run: { ...run }, text: `例程 ${id}（${run.name}）：在跑，已调 ${run.calls} 次工具` })
      w.body.task = { id: `tmwbr${run.tasks}`, type: run.tasks % 2 ? 'deposit' : 'withdraw', state: 'running', progress: { done: run.tasks % 3, total: 3, phase: run.tasks % 2 ? '放进箱子' : '打开箱子' }, startedAt: Date.now() }
    }, 1000)
  } else if (name === 'waiting' && LINES === 2) {
    // 干活线提了问，还没人回答（那段戏的结尾就是一个问题）
    w.waitingAnswer = { text: '桨叶做好了，在我身上。钢螺丝只剩 13 个，要不要补一些？', since: now - 95_000 }
    w.lastReport = { type: 'question', text: '桨叶做好了，在我身上。钢螺丝只剩 13 个，要不要补一些？', time: now - 95_000 }
  } else if (name === 'picture' && samplePicture) {
    // 它看了一张草稿：工具结果带着图，图还存着方块数据
    add({ kind: 'command', who: '面板', time: now - 20_000, text: '看一下小木屋那张草稿，告诉我门朝哪边。' })
    add({ kind: 'turn', turn, ...tag, time: now - 19_000, text: `第 ${turn} 轮开始（模拟接口 / mock-deep）：主人通过控制面板对你说：看一下小木屋那张草稿…` })
    const c = { state: 'done', purpose: 'turn', step: 1, startedAt: now - 19_000, ms: 4200, model: 'mock-deep', inputTokens: 52000, outputTokens: 80, cacheReadTokens: 50000, stop: 'tool_calls', toolCalls: 1 }
    add({ kind: 'model_call', turn, step: 1, ...tag, time: now - 19_000, text: callText(c), call: c })
    add({ kind: 'tool_call', turn, step: 1, ...tag, source: 'model', who: 'view_draft', time: now - 14_500, text: '{"name":"小木屋"}' })
    add({ kind: 'tool_result', turn, step: 1, ...tag, source: 'model', who: 'view_draft', time: now - 14_300, text: 'Draft "小木屋": 9×7×7, 292 blocks of 5 kinds. A picture of it is attached.', detail: 'Draft "小木屋": 9×7×7, 292 blocks of 5 kinds. A picture of it is attached.\n- 橡木木板 × 96\n- 圆石 × 63\n…', pictures: [samplePicture], scenes: [samplePicture] })
    const c2 = { state: 'done', purpose: 'turn', step: 2, startedAt: now - 14_200, ms: 3100, model: 'mock-deep', inputTokens: 53100, outputTokens: 40, cacheReadTokens: 52000, stop: 'tool_calls', toolCalls: 1 }
    add({ kind: 'model_call', turn, step: 2, ...tag, time: now - 14_200, text: callText(c2), call: c2 })
    add({ kind: 'tool_call', turn, step: 2, ...tag, source: 'model', who: 'say', time: now - 11_000, text: '{"message":"门在南面正中间，两格高。"}' })
    add({ kind: 'say', who: BOT, time: now - 10_950, text: '门在南面正中间，两格高。' })
    add({ kind: 'tool_result', turn, step: 2, ...tag, source: 'model', who: 'say', time: now - 10_900, text: 'Said in public chat.' })
    add({ kind: 'turn', turn, ...tag, time: now - 10_000, text: `第 ${turn} 轮结束（调了 2 次模型，模拟接口 / mock-deep）` })
  } else if (name === 'outage') {
    add({ kind: 'error', ...tag, text: '模型调用失败：HTTP 529 overloaded_error: Overloaded。60 秒后再试，改了模型配置会立刻再试。' })
    w.model = { state: 'outage', ...MODELS[worker as keyof typeof MODELS], outage: { failures: 4, since: now - 240_000, nextRetryAt: now + 42_000, lastError: 'HTTP 529 overloaded_error: Overloaded' }, lastCall: { time: now - 18_000, ok: false, errorKind: 'overloaded', error: 'HTTP 529 overloaded_error: Overloaded' } }
    w.pending = 2
  }
  live = { agents }
}

/**
 * 两条线的一段戏（形状照后端定的：对话线写的字就是 say，两条线之间的往来是 relay）：
 * 主人说话 → 对话线回话并交事 → 干活线干（开了个例程）→ 汇报 → 对话线转告 → 再交一件事 → 干活线做完提了个问题。
 */
function playTwoLines(): void {
  const t0 = Date.now() - 9 * 60_000
  let t = t0
  const at = (sec: number): number => (t = t0 + sec * 1000)
  const model = (agent: string): string => (agent === 'talk' ? 'mock-fast' : 'mock-deep')
  const call = (agent: string, turn: number, step: number, ms: number, tools: number, input: number, stop = 'tool_calls'): void => {
    const c = { state: 'done', purpose: 'turn', step, startedAt: t, ms, model: model(agent), inputTokens: input, outputTokens: 80 + step * 31, cacheReadTokens: Math.round(input * 0.9), stop, toolCalls: tools }
    add({ kind: 'model_call', agent, turn, step, time: t, text: callText(c), call: c })
    t += ms
  }
  const tool = (agent: string, turn: number, step: number, who: string, args: string, result: string, detail?: string, ms = 60): void => {
    add({ kind: 'tool_call', agent, turn, step, source: 'model', who, time: t, text: args })
    t += ms
    add({ kind: 'tool_result', agent, turn, step, source: 'model', who, time: t, text: result, ...(detail ? { detail } : {}) })
  }
  const say = (turn: number, step: number, text: string): void => void add({ kind: 'say', who: BOT, agent: 'talk', turn, step, time: (t += 40), text })
  const relay = (agent: string, turn: number, step: number, type: string, text: string, extra: Json = {}): void => {
    const head = agent === 'talk' ? '对话线 → 干活线' : `干活线 → 对话线${type === 'question' ? '（提问）' : type === 'result' ? '（做完了）' : ''}`
    add({ kind: 'relay', agent, turn, step, time: (t += 30), text: `${head}：${text}`, relay: { type, from: agent, to: agent === 'talk' ? 'work' : 'talk', ...(extra.quotes ? { quotes: extra.quotes } : {}) }, ...(extra.detail ? { detail: extra.detail } : {}) })
    if (agent === 'work') lastReport = { type, text, time: t }
  }
  const start = (agent: string, turn: number, trigger: string): void => void add({ kind: 'turn', agent, turn, time: t, text: `第 ${turn} 轮开始（模拟接口 / ${model(agent)}）：${trigger}`, detail: `[需要你处理的事]\n${trigger}` })
  const end = (agent: string, turn: number, calls: number): void => void add({ kind: 'turn', agent, turn, time: (t += 20), text: `第 ${turn} 轮结束（调了 ${calls} 次模型，模拟接口 / ${model(agent)}）` })

  add({ kind: 'info', time: at(-30), text: '已连上游戏服务器（mod v0.1.0-mock）。' })
  add({ kind: 'event', time: at(0), text: '阿露 进入了服务器' })
  add({ kind: 'chat', who: '阿露', time: at(20), text: 'Alu 把抽屉里数量不到 128 的东西都搬到我面前这个箱子里' })
  at(21)
  start('talk', 41, '阿露 说：Alu 把抽屉里数量不到 128 的东西都搬到我面前这个箱子里')
  call('talk', 41, 1, 1800, 1, 6120)
  say(41, 1, '好，我去搬，搬完告诉你。')
  tool('talk', 41, 1, 'tell_worker', '{"text":"把抽屉管理器 (-511,71,86) 管着的、数量不到 128 的东西，都搬到她面前的箱子里。搬完汇报一共搬了几种。"}', 'Handed to the working line; it starts now.')
  relay('talk', 41, 1, 'tell', '把抽屉管理器 (-511,71,86) 管着的、数量不到 128 的东西，都搬到她面前的箱子里。搬完汇报一共搬了几种。', { quotes: 1, detail: '把抽屉管理器 (-511,71,86) 管着的、数量不到 128 的东西，都搬到她面前的箱子里。搬完汇报一共搬了几种。\n\n[主人的原话]\n阿露：Alu 把抽屉里数量不到 128 的东西都搬到我面前这个箱子里\n（她站在 (-513,69,93)，朝北，指着 (-509,69,90) 的压缩箱子）' })
  end('talk', 41, 1)

  start('work', 42, '对话线交来的事：把抽屉管理器 (-511,71,86) 管着的、数量不到 128 的东西，都搬到她面前的箱子里…')
  call('work', 42, 1, 5200, 1, 42100)
  tool('work', 42, 1, 'read_manual', '{"name":"routines"}', 'Manual "routines": 一件事要连着调几十次工具时看。', 'Manual "routines": 一件事要连着调几十次工具时看。\n\n……')
  call('work', 42, 2, 4700, 1, 47900)
  tool('work', 42, 2, 'list_drawers', '{"x":-511,"y":71,"z":86,"below":128}', '81 drawer slot(s) hold fewer than 128; these are 1–40.', '81 drawer slot(s) hold fewer than 128; these are 1–40.\n- (-515,70,86) slot 0: 4× 银锭 [gregtech:gt.metaitem.01/11054]\n…')
  call('work', 42, 3, 7900, 1, 52300)
  const rid = 'r7'
  const file = 'routine-two-lines-r7.jsonl'
  const run: Json = { id: rid, kind: 'routine', name: '整理低库存抽屉物品', status: 'running', startedAt: t, calls: 0, tasks: 0, errors: 0, file }
  tool('work', 42, 3, 'start_routine', '{"name":"整理低库存抽屉物品","code":"const controller={x:-511,y:71,z:86}…"}', `Routine ${rid} started. It runs in the background; end your turn now.`)
  add({ kind: 'info', agent: 'work', time: t, text: `例程 ${rid}（${run.name}）开始在后台跑。`, detail: "const controller={x:-511,y:71,z:86}, chest={x:-509,y:69,z:90}\nfor (const s of slots) {\n  await tool('haul_items', {from: s, to: chest})\n}", source: 'routine', runId: rid, run: { ...run } })
  const runEntry = add({ kind: 'run', agent: 'work', time: t, source: 'routine', runId: rid, text: '', run: { ...run } })
  call('work', 42, 4, 2100, 0, 53100, 'end')
  add({ kind: 'model_text', agent: 'work', turn: 42, step: 4, time: t, text: '例程已经在跑，等它的结果。' })
  end('work', 42, 4)

  add({ kind: 'chat', who: '阿露', time: at(70), text: '对了，直升机背包的桨叶怎么做来着' })
  at(71)
  start('talk', 43, '阿露 说：对了，直升机背包的桨叶怎么做来着')
  call('talk', 43, 1, 1500, 2, 6900)
  tool('talk', 43, 1, 'find_item', '{"query":"直升机桨叶"}', '"直升机桨叶" matches 1 item.', '"直升机桨叶" matches 1 item.\n- 直升机桨叶 [adventurebackpack:backpackComponent/6]: 1 recipe(s)')
  tool('talk', 43, 1, 'find_recipes', '{"id":"adventurebackpack:backpackComponent","meta":6}', '直升机桨叶 can be made 1 way(s).', '直升机桨叶 [adventurebackpack:backpackComponent/6] can be made 1 way(s), 1 recipe(s) in all.\n1. 有序合成 — 4× 精炼铁柄, 3× 钢螺丝, 螺丝刀（不消耗）')
  call('talk', 43, 2, 1700, 0, 7800, 'end')
  say(43, 2, '桨叶是工作台合成：4 个精炼铁柄、3 个钢螺丝，再拿一把螺丝刀。料我身上都有，要我做一个吗？')
  end('talk', 43, 2)

  at(118)
  const recs: Json[] = [{ t: 'start', time: run.startedAt, id: rid, kind: 'routine', name: run.name, code: '' }]
  for (let n = 1; n <= 83; n++) recs.push({ t: 'call', time: run.startedAt + n * 900, n, tool: n < 3 ? 'list_drawers' : 'haul_items', input: n < 3 ? { x: -511, y: 71, z: 86, below: 128, page: n } : { from: { x: -515, y: 70, z: 86, slot: n % 4 }, to: { x: -509, y: 69, z: 90 } }, ok: true, text: n < 3 ? '81 drawer slot(s)…' : `tmwc${n} haul [done] result={"moved":${(n * 7) % 120}}`, ms: 850, ...(n < 3 ? {} : { task: `tmwc${n}` }) })
  recs.push({ t: 'end', time: t, status: 'done', ending: 'the program finished', calls: 83, tasks: 81, errors: 0, value: '搬运成功 81/81 种' })
  runFiles.set(file, recs)
  Object.assign(run, { status: 'done', endedAt: t, calls: 83, tasks: 81 })
  update(runEntry.id, { run: { ...run }, text: `例程 ${rid}（${run.name}）：跑完了，调了 83 次工具，开了 81 个任务` })
  add({ kind: 'info', agent: 'work', time: t, text: `例程 ${rid}（${run.name}）跑完了：the program finished`, detail: `Routine ${rid} ("${run.name}") finished: the program finished. 83 tool call(s), 81 task(s), 77 s in all.\nIt returned: 搬运成功 81/81 种；失败 []`, source: 'routine', runId: rid, run: { ...run } })
  runList.unshift({ ...run })
  start('work', 44, `你启动的例程有结果了，看完决定下一步：Routine ${rid} finished…`)
  call('work', 44, 1, 4300, 0, 55800, 'end')
  add({ kind: 'model_text', agent: 'work', turn: 44, step: 1, time: t, text: '抽屉里不到 128 的 81 种都搬进 (-509,69,90) 的压缩箱子了，没有失败的。箱子还剩 12 格。' })
  relay('work', 44, 1, 'result', '抽屉里不到 128 的 81 种都搬进 (-509,69,90) 的压缩箱子了，没有失败的。箱子还剩 12 格。')
  end('work', 44, 1)
  start('talk', 45, '干活线做完了：抽屉里不到 128 的 81 种都搬进 (-509,69,90) 的压缩箱子了，没有失败的。箱子还剩 12 格。')
  call('talk', 45, 1, 1300, 0, 8400, 'end')
  say(45, 1, '搬完了：81 种都进了你面前的压缩箱子，没有失败的，箱子还剩 12 格。')
  end('talk', 45, 1)

  add({ kind: 'chat', who: '阿露', time: at(150), text: '好，那桨叶做一个吧' })
  at(151)
  start('talk', 46, '阿露 说：好，那桨叶做一个吧')
  call('talk', 46, 1, 1600, 1, 9100)
  say(46, 1, '好，这就做。')
  tool('talk', 46, 1, 'tell_worker', '{"text":"做 1 个直升机桨叶（adventurebackpack:backpackComponent/6）：工作台合成，料在身上。"}', 'Handed to the working line; it starts now.')
  relay('talk', 46, 1, 'tell', '做 1 个直升机桨叶（adventurebackpack:backpackComponent/6）：工作台合成，料在身上。', { quotes: 1, detail: '做 1 个直升机桨叶（adventurebackpack:backpackComponent/6）：工作台合成，料在身上。\n\n[主人的原话]\n阿露：好，那桨叶做一个吧' })
  end('talk', 46, 1)
  start('work', 47, '对话线交来的事：做 1 个直升机桨叶（adventurebackpack:backpackComponent/6）：工作台合成，料在身上。')
  call('work', 47, 1, 5600, 1, 58200)
  tool('work', 47, 1, 'craft_item', '{"id":"adventurebackpack:backpackComponent","meta":6,"count":1}', 'Task tmwd001 (craft) started. It runs in the game on its own.')
  end('work', 47, 1)
  add({ kind: 'event', agent: 'work', time: at(166), text: '任务 tmwd001（craft）完成了。 结果：crafted 1× 直升机桨叶' })
  start('work', 48, '任务 tmwd001（craft）完成了。')
  call('work', 48, 1, 3900, 1, 59000)
  tool('work', 48, 1, 'report', '{"text":"桨叶做好了，在我身上。钢螺丝只剩 13 个，要不要补一些？","question":true}', 'Sent to the talking line; waiting for an answer.')
  relay('work', 48, 1, 'question', '桨叶做好了，在我身上。钢螺丝只剩 13 个，要不要补一些？')
  end('work', 48, 1)
  start('talk', 49, '干活线提问：桨叶做好了，在我身上。钢螺丝只剩 13 个，要不要补一些？')
  call('talk', 49, 1, 1400, 0, 9800, 'end')
  say(49, 1, '桨叶做好了，在我身上。钢螺丝只剩 13 个了，要我补一些吗？')
  end('talk', 49, 1)
}

// ── 模拟模型：两条线各按几条固定的规矩回应（只为了看面板，不是模型）──

/**
 * 认这几个词（都是主人对它说的话里的）：
 *   平 / 搬 / 存     对话线应一声并交给干活线；干活线开一个身体的任务，做完留一句话
 *   问              干活线不动手，先问一个问题（然后等回答）；主人再说什么，对话线带话过去，它就照着干
 *   例程            干活线开一个后台例程（一连串查询）
 *   慢              干活线想得久一点（每步 6 秒），好看“正在想”
 *   停              对话线叫停（stop_work）
 *   查 / 怎么做      对话线自己查一下再回答，不惊动干活线
 * 别的话对话线只回一句。
 */
/** 模拟模型写的交接记录（照提示词要的小节，内容是随手编的，看面板怎么显示）。 */
function handover(talk: boolean): string {
  const sections = talk
    ? [
        ['主人和别人交代的事、提的要求', '- [00:05] 阿露：“帮我把脚下这块地平一下。”\n- [00:06] 阿露：“慢慢平，别把路挖了。”'],
        ['这一段结束时在聊的', '主人让它慢慢平地，它答了“好，我去办”，交给了干活线。之后主人在面板上点了“全部停下”。'],
        ['交给干活线的事', '- 平地（-526,39）到（-519,46），y=69：第一次做完了；第二次被叫停。'],
        ['干活线问过的、主人答过的', '- 问：要平到哪一层？答：“就平到 y=69”。'],
        ['答应过的事', '（无）'],
        ['查到的结论', '- 脚下 y=69，旁边的路 y=68。'],
        ['人', '- 阿露：主人。'],
      ]
    : [
        ['主人交代的事和要求', '- 平地到 y=69，别动路。'],
        ['这一段结束时在做的事', '第二次平地被叫停，没有在跑的任务。'],
        ['做完的事', '- t1 flatten：移走 37 块。'],
        ['动过的东西、还没还原的', '（无）'],
        ['地点和东西', '- 基地 (-522,69,43)。'],
        ['查到的事实', '（无）'],
        ['试过不行的、踩过的坑', '（无）'],
        ['没解决的问题、答应过的事', '（无）'],
      ]
  return `<analysis>按时间过一遍：先是平地，问了一层，主人答了 y=69，做完了；又让慢慢平，被叫停。</analysis>\n<summary>\n${sections.map(([title, body]) => `## ${title}\n${body}`).join('\n\n')}\n</summary>`
}

function twoLineResponder(req: RecordedLlmRequest): MockReply {
  const messages: any[] = Array.isArray(req.body?.messages) ? req.body.messages : []
  const last = messages[messages.length - 1]
  const text = typeof last?.content === 'string' ? last.content : Array.isArray(last?.content) ? last.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n') : ''
  const afterTool = last?.role === 'tool'
  const tools: string[] = Array.isArray(req.body?.tools) ? req.body.tools.map((t: any) => t?.function?.name ?? t?.name) : []
  // 写交接记录（压缩历史、面板上的试写）：照它要的小节写一份；别的不带工具的调用（测试连接）回一句
  if (tools.length === 0) {
    const system = String(messages.find((m) => m.role === 'system')?.content ?? req.body?.system ?? '')
    if (/交接记录/.test(system)) return { text: handover(/对话线/.test(system.slice(0, 80))), delayMs: 2500, usage: { input: 30000, output: 1800 } }
    return { text: 'pong' }
  }
  const talk = tools.includes('tell_worker')
  const todo = text.split('[最近发生的事')[0]?.split('[当前状态]')[0] ?? ''
  const usage = { input: talk ? 6200 : 48000, output: 90, cacheRead: talk ? 5400 : 45000 }

  if (talk) {
    if (afterTool) {
      // 记到清单上了：应一声
      const asked = messages[messages.length - 2]?.tool_calls?.[0]?.function?.name
      return { text: asked === 'todo' ? '记上了。' : '', usage }
    }
    // 主人说“记一下：……”：记到工作清单上（和干活线送来的话一起到的时候也先办这件）
    const remember = /对你说[:：]\s*记(?:一下|上)[:：，,]?\s*([^\n]+)/.exec(todo)
    if (remember) return { toolCalls: [{ name: 'todo', input: { add: [{ text: remember[1]!.trim() }] } }], usage }
    const fromWorker = /干活线(.*?)[:：]\s*([\s\S]*)/.exec(todo)
    if (fromWorker) {
      const body = fromWorker[2]!.split('\n')[0]!.slice(0, 120)
      if (/提问|问你/.test(fromWorker[1]!)) return { text: `它问：${body} 你定一下？`, usage }
      if (/状况/.test(fromWorker[1]!)) return { text: `出了点状况：${body}`, usage }
      return { text: `弄好了：${body}`, usage }
    }
    const said = /(?:说|对你说)[:：]\s*([\s\S]*)/.exec(todo)?.[1]?.split('\n')[0]?.trim() ?? todo.trim().slice(0, 80)
    if (/停/.test(said)) return { text: '好，都停下。', toolCalls: [{ name: 'stop_work', input: { reason: '主人说停' } }], usage }
    if (/查|怎么做/.test(said)) return { toolCalls: [{ name: 'find_item', input: { query: '钢锭' } }], usage }
    if (/平|搬|存|问|例程|慢|做|拿|凿/.test(said)) return { text: '好，我去办。', toolCalls: [{ name: 'tell_worker', input: { text: said } }], usage }
    return { text: '我在。（我是模拟的模型，只认得“平”“搬”“问”“例程”“慢”“停”“查”这几个词。）', usage }
  }

  // 干活线
  // 这一轮是不是“慢”的：看这一轮开头给它的那一条（以前说过的不算）
  const opening = [...messages].reverse().find((m) => m.role === 'user')
  const openingText = typeof opening?.content === 'string' ? opening.content : ''
  const slow = /慢/.test(openingText.split('[最近发生的事')[0] ?? '') ? { delayMs: 6000 } : {}
  // 工作清单把它叫醒了（它停着，清单上还有没做的）：不动手、也不留话（留了话会叫醒对话线，在聊天里说一句）
  if (!afterTool && /工作清单上还有/.test(todo)) return { text: '', usage }
  if (afterTool) {
    const result = typeof last.content === 'string' ? last.content : ''
    // 开了任务或者例程：这一轮到此为止，等它结束再被叫醒
    // 开了任务：留一句“开始了”（任务还在跑，这句话只作背景送给对话线）；开了例程、提了问：这一轮到此为止
    if (/Task \S+ \(flatten\) started/i.test(result)) return { text: '开始平了，等它平完再看。', usage, ...slow }
    if (/started|runs in the background|waiting for an answer|Sent to/i.test(result)) return { text: '', usage, ...slow }
    if (/You are at|Within \d+ blocks/.test(result)) return { text: '看过了，周围没有要紧的东西。', usage, ...slow }
    return { text: '', usage, ...slow }
  }
  if (/完成了/.test(todo)) return { text: '做好了，没有出错。', usage, ...slow }
  if (/失败了/.test(todo)) return { toolCalls: [{ name: 'report', input: { text: '刚才那个任务没干成，要不要换个办法？', question: true } }], usage, ...slow }
  if (/例程.*(有结果|跑完|停)/.test(todo)) return { text: '例程跑完了：看了 6 次周围，没有出错。', usage, ...slow }
  if (/被叫停|stopped/i.test(todo)) return { text: '', usage }
  if (/例程/.test(todo)) {
    return { toolCalls: [{ name: 'start_routine', input: { name: '转一圈看看', code: "for (let n = 0; n < 6; n++) {\n  const r = await tool('look_around', {})\n  log('第 ' + (n + 1) + ' 眼：' + r.text.slice(0, 30))\n  await tool('get_status', {})\n}\nreturn '看了 6 次'" } }], usage, ...slow }
  }
  if (/问/.test(todo) && !/回答|平到|就/.test(todo)) return { toolCalls: [{ name: 'report', input: { text: '要平到哪一层？脚下是 y=69，旁边的路是 y=68。', question: true } }], usage, ...slow }
  if (/搬|存/.test(todo)) return { toolCalls: [{ name: 'look_around', input: {} }, { name: 'deposit_items', input: { container: { x: 12, y: 64, z: -4 }, items: [{ id: 'minecraft:dirt', count: 64 }] } }], usage, ...slow }
  if (/平|y=\d+/.test(todo)) return { toolCalls: [{ name: 'flatten_area', input: { x1: -526, z1: 39, x2: -519, z2: 46, y: 69 } }], usage, ...slow }
  return { text: '不知道要我干什么。', usage, ...slow }
}

// ── 代理 ──

function forward(req: http.IncomingMessage, res: http.ServerResponse): void {
  const upstream = http.request({ host: '127.0.0.1', port: BRAIN_PORT, method: req.method, path: req.url, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers)
    up.pipe(res)
  })
  upstream.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'bad_gateway', message: '大脑进程没在运行' } }))
  })
  req.pipe(upstream)
}

/** 问一下大脑：这个浏览器登录了没有（顶替的接口也要登录了才给）。 */
function authed(req: http.IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: BRAIN_PORT, path: '/api/session', headers: { cookie: req.headers.cookie ?? '' } }, (up) => {
      let body = ''
      up.on('data', (c) => (body += c))
      up.on('end', () => {
        try {
          resolve(JSON.parse(body).authenticated === true)
        } catch {
          resolve(false)
        }
      })
    })
    r.on('error', () => resolve(false))
  })
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req: http.IncomingMessage): Promise<Json> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

async function fake(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const route = `${req.method} ${url.pathname}`
  const q = url.searchParams
  if (route === 'GET /api/status') {
    for (const a of live.agents) if (a.body) a.body.online = bot.online
    json(res, 200, { time: Date.now(), agents: live.agents })
    return true
  }
  if (route === 'GET /api/log') {
    const limit = Math.max(1, Math.min(500, Number(q.get('limit') ?? 300) || 300))
    if (q.has('before')) {
      const before = Number(q.get('before'))
      const older = entries.filter((e) => e.id < before)
      json(res, 200, { entries: older.slice(Math.max(0, older.length - limit)), more: older.length > limit })
    } else {
      const after = Number(q.get('after') ?? 0) || 0
      const newer = entries.filter((e) => e.id > after)
      json(res, 200, { entries: newer.slice(Math.max(0, newer.length - limit)), more: newer.length > limit })
    }
    return true
  }
  if (route === 'GET /api/events') {
    const after = Number(req.headers['last-event-id'] ?? q.get('after') ?? 0) || 0
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    res.write('retry: 3000\n\n')
    const frame = (e: Entry): string => `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`
    const newer = entries.filter((e) => e.id > after)
    for (const e of newer.slice(Math.max(0, newer.length - 300))) res.write(frame(e))
    const fn = (e: Entry): void => void res.write(frame(e))
    listeners.add(fn)
    req.on('close', () => listeners.delete(fn))
    return true
  }
  if (route === 'GET /api/runs') {
    json(res, 200, { runs: runList.slice(0, Number(q.get('limit') ?? 50) || 50) })
    return true
  }
  if (route === 'GET /api/runs/records') {
    const file = q.get('file') ?? runList.find((r) => r.id === q.get('id'))?.file ?? ''
    const records = runFiles.get(file)
    if (!records) {
      json(res, 404, { error: { code: 'not_found', message: '没有这次运行的记录' } })
      return true
    }
    const after = Number(q.get('after') ?? 0) || 0
    const limit = Math.max(1, Math.min(1000, Number(q.get('limit') ?? 200) || 200))
    const page = records.slice(after, after + limit)
    json(res, 200, { file, total: records.length, next: after + page.length, records: page })
    return true
  }
  if (route === 'POST /api/command') {
    const body = await readBody(req)
    const text = String(body.text ?? '').trim()
    if (!text) {
      json(res, 400, { error: { code: 'bad_request', message: '指令不能为空' } })
      return true
    }
    add({ kind: 'command', who: '面板', text })
    // 过一秒“想”两秒，回一句
    const agent = LINES === 2 ? 'talk' : undefined
    const turn = ++liveTurn + 5000
    const who = live.agents[0]!
    setTimeout(() => {
      const startedAt = Date.now()
      add({ kind: 'turn', turn, ...(agent ? { agent } : {}), text: `第 ${turn} 轮开始（模拟接口 / mock）：主人通过控制面板对你说：${text.slice(0, 40)}`, detail: `[需要你处理的事]\n主人通过控制面板对你说：${text}` })
      const thinking = add({ kind: 'model_call', turn, step: 1, ...(agent ? { agent } : {}), text: '第 1 步：正在想', call: { state: 'thinking', purpose: 'turn', step: 1, startedAt } })
      const before = who.model
      who.model = { ...before, state: 'thinking', turn, step: 1, since: startedAt }
      who.turn = { id: turn, startedAt, steps: 0, maxSteps: 60 }
      setTimeout(() => {
        const c = { state: 'done', purpose: 'turn', step: 1, startedAt, ms: Date.now() - startedAt, model: 'mock', inputTokens: 5120, outputTokens: 48, cacheReadTokens: 4000, stop: agent ? 'end' : 'tool_calls', toolCalls: agent ? 0 : 1 }
        update(thinking.id, { text: callText(c), call: c })
        if (agent) {
          // 两条线：对话线写的字就是它说的话
          add({ kind: 'say', who: BOT, agent, turn, step: 1, text: `（模拟）收到：${text.slice(0, 60)}` })
        } else {
          add({ kind: 'tool_call', turn, step: 1, source: 'model', who: 'say', text: JSON.stringify({ message: `（模拟）收到：${text.slice(0, 60)}` }) })
          add({ kind: 'say', who: BOT, text: `（模拟）收到：${text.slice(0, 60)}` })
          add({ kind: 'tool_result', turn, step: 1, source: 'model', who: 'say', text: 'Said in public chat.' })
        }
        add({ kind: 'turn', turn, ...(agent ? { agent } : {}), text: `第 ${turn} 轮结束（调了 1 次模型，模拟接口 / mock）` })
        who.model = before
        who.turn = null
      }, 2500)
    }, 800)
    json(res, 200, { ok: true })
    return true
  }
  if (route === 'POST /api/work/stop') {
    if (LINES !== 2) return false
    const w = live.agents[live.agents.length - 1]!
    const result = { ok: true, turn: w.model?.state === 'thinking' || w.model?.state === 'tools', routine: w.routine?.id ?? null, tasks: (w.body?.task ? 1 : 0) + (w.body?.queue?.length ?? 0), dropped: w.pending ?? 0 }
    add({ kind: 'relay', text: '面板 → 干活线：停下', relay: { type: 'stop', from: 'panel', to: 'work' } })
    setScene('idle')
    json(res, 200, result)
    return true
  }
  if (route === 'POST /api/routine/stop' || route === 'POST /api/tasks/cancel') {
    const stopped = live.agents.some((a) => a.routine)
    if (route === 'POST /api/routine/stop' && stopped) add({ kind: 'info', text: '在面板上停掉了正在跑的例程。' })
    setScene('idle')
    json(res, 200, route.endsWith('stop') ? { stopped } : { canceled: 1 })
    return true
  }
  return false
}

const proxy = http.createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://dev.local')
    if (url.pathname === '/__dev' && req.method === 'GET') return json(res, 200, { shape: SHAPE, lines: LINES, scene, entries: entries.length, password: readPassword() })
    if (url.pathname === '/__dev/scene' && req.method === 'POST') {
      const body = await readBody(req)
      setScene(String(body.name ?? 'idle'))
      return json(res, 200, { scene })
    }
    if (url.pathname === '/__dev/bot' && req.method === 'POST') {
      // 改身体：{ health?, food?, screen?, players? }。players: false 是服务器上的真人都走了（看“自动上下线”），true 是回来
      const body = await readBody(req)
      if (typeof body.health === 'number') bot.health = body.health
      if (typeof body.food === 'number') bot.food = body.food
      if (typeof body.screen === 'boolean') setScreen(body.screen)
      if (body.players === false) {
        awayPlayers = awayPlayers.length > 0 ? awayPlayers : [...bridge.players]
        for (const p of awayPlayers) bridge.playerLeave(p.name)
      } else if (body.players === true) {
        for (const p of awayPlayers) bridge.playerJoin(p.name)
        awayPlayers = []
      }
      return json(res, 200, { ok: true })
    }
    if (SHAPE !== 'real' && url.pathname.startsWith('/api/') && ['/api/status', '/api/log', '/api/events', '/api/runs', '/api/runs/records', '/api/command', '/api/routine/stop', '/api/tasks/cancel', '/api/work/stop'].includes(url.pathname)) {
      if (!(await authed(req))) return json(res, 401, { error: { code: 'unauthorized', message: '请先登录' } })
      if (await fake(req, res, url)) return
    }
    forward(req, res)
  })()
})

function readPassword(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')).panel.password
  } catch {
    return ''
  }
}

// ── 启动 ──

async function brainApi(cookie: string, method: string, route: string, body?: unknown): Promise<Json> {
  const origin = `http://127.0.0.1:${BRAIN_PORT}`
  const res = await fetch(`${origin}${route}`, { method, headers: { cookie, ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return (await res.json()) as Json
}

/** 大脑起来以后：登录，没有模型服务商的话配两个指着模拟模型的。 */
async function seedBrain(): Promise<void> {
  const origin = `http://127.0.0.1:${BRAIN_PORT}`
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: readPassword() }) })
  const cookie = login.headers.getSetCookie()[0]?.split(';')[0] ?? ''
  const have = await brainApi(cookie, 'GET', '/api/providers')
  if ((have.providers ?? []).length === 0) {
    const first = await brainApi(cookie, 'POST', '/api/providers', { kind: 'openai-chat', label: '模拟接口', baseUrl: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: 'sk-mock-not-a-real-key', model: 'mock-deep' })
    const id = first.provider?.id
    if (id) await brainApi(cookie, 'POST', `/api/providers/${id}/models`, { name: 'mock-fast', label: 'mock-fast' })
    await brainApi(cookie, 'POST', '/api/providers', { kind: 'anthropic-messages', label: '模拟接口（Anthropic 线格式）', baseUrl: `http://127.0.0.1:${LLM_PORT}`, apiKey: 'sk-ant-mock-not-a-real-key', model: 'claude-mock' })
    console.log('[dev] 给大脑配了两个指着模拟模型的服务商。')
  }
}

/**
 * “基地的做法”：几条主人教的、几条它自己定的，四种都有；一条“具体的东西”故意弄成配方册里对不回来的（看失效的样子）。
 * 直接写数据目录里的 methods.json（大脑起来时读），这样能定谁定的、什么时候。
 */
async function seedMethods(packdata: ReturnType<typeof import('../src/packdata/index.ts')['loadPackData']>): Promise<void> {
  if (fs.existsSync(path.join(DATA_DIR, 'methods.json')) || !packdata.recipes) return
  const { buildMethod } = await import('../src/tools/methods.ts')
  const { MethodStore } = await import('../src/store/methods.ts')
  {
    const store = new MethodStore(DATA_DIR)
    const env = { book: packdata.recipes, items: packdata.items, fluids: packdata.fluids }
    const day = 24 * 3600 * 1000
    const now = Date.now()
    const plans: [Record<string, unknown>, number][] = [
      [{ part: 'plate', way: '卷板机', from: 'ingot', by: 'owner', why: '卷板机一锭一板，比锤子省一半' }, 6],
      [{ part: 'stick', material: 'Steel', way: '车床', from: 'ingot', by: 'self', why: '车床还多出小堆粉；压模机的模头还没做' }, 4],
      [{ part: 'screw', way: '车床', from: 'bolt', by: 'owner', why: '' }, 3],
      [{ part: 'ring', way: '压模机', from: 'stick', by: 'self', why: '压模机一杆一环' }, 3.5],
      [{ ready: 'ingot', by: 'owner', why: '锭都从仓库里拿，不用从矿算起' }, 2.5],
      [{ ready: 'minecraft:stone/0', by: 'self', why: '仓库里有一大箱石头' }, 2.2],
      [{ ready: 'gregtech:gt.metaitem.01/11019', by: 'owner', why: '铝锭找主人要' }, 2.1],
      [{ use: '有序合成', over: '组装机', noTools: true, by: 'owner', why: '组装机费电，手搓不用工具时就手搓' }, 1.5],
      [{ order: ['卷板机', '车床', '压模机', '有序合成'], by: 'owner', why: '能用机器就别手搓' }, 5],
      [{ id: 'gregtech:gt.metaitem.01', meta: 23305, recipe: 198685, by: 'self', why: '车床一锭一杆' }, 2],
      [{ id: 'gregtech:gt.metaitem.01', meta: 17305, recipe: 206332, by: 'owner', why: '钢块切成板，九块一次' }, 1],
      [{ machine: { x: -510, y: 70, z: 84 }, does: '只做钢板：别拿去做别的', feed: { x: -510, y: 71, z: 84 }, collect: { x: -509, y: 70, z: 84 }, keep: '别拆它侧面的输出覆盖板', by: 'owner', why: '主人专门搭的' }, 0.5],
    ]
    for (const [input, daysAgo] of plans) {
      const built = buildMethod(input as never, { ...env, now: now - daysAgo * day, ...(input.machine ? { machineName: '基础卷板机' } : {}) })
      if ('error' in built) {
        console.log(`[dev] 一条基地的做法没放进去：${built.error}`)
        continue
      }
      // 几条故意弄成对不上的样子（像配方册、物品表重新导出以后那样）：钢板的配方、环用的做法、铝锭那样物品
      if (built.entry.kind === 'thing' && built.entry.thing === 'ore:plateSteel') built.entry.recipe = { ...built.entry.recipe, ref: 999_999, in: built.entry.recipe.in.map(([k, n]) => [k, n + 1] as [string, number]) }
      if (built.entry.kind === 'part' && built.entry.prefix === 'ring') built.entry.way = '环形压制机（旧版）'
      if (built.entry.kind === 'ready' && built.entry.text === 'gregtech:gt.metaitem.01' && built.entry.meta === 11019) Object.assign(built.entry, { key: 'ready:oldmod:aluminium_ingot/0', text: 'oldmod:aluminium_ingot', meta: 0, name: '铝锭（旧版）' })
      store.set(built.entry)
    }
    console.log(`[dev] 放了 ${store.list().length} 条基地的做法。`)
  }
}

/** 样本里那张简图的编号（没做成是空的）。 */
let samplePicture = ''

/** 数据目录里是空的时候放几样东西进去，各页才有的看：两张草稿、几条记忆、两条意见。 */
async function seedData(): Promise<void> {
  const { DesignWorkspace } = await import('../src/design/index.ts')
  const { loadPackData } = await import('../src/packdata/index.ts')
  const { MemoryStore } = await import('../src/store/memory.ts')
  const { FeedbackStore } = await import('../src/store/feedback.ts')
  const packdata = loadPackData(PACKDATA, () => {})
  const design = new DesignWorkspace({ dataDir: DATA_DIR, packdata })
  await seedMethods(packdata)
  if (design.drafts.list().length === 0) {
    const hut = `const b = blueprint(9, 7, 7)
b.fill(0, 0, 0, 8, 0, 6, 'minecraft:cobblestone')
b.walls(0, 1, 0, 8, 3, 6, 'minecraft:planks')
for (const [x, z] of [[0,0],[8,0],[0,6],[8,6]]) b.line(x, 1, z, x, 3, z, 'minecraft:log')
b.set(4, 1, 6, null).set(4, 2, 6, null)
for (const x of [2, 6]) b.set(x, 2, 6, 'minecraft:glass').set(x, 2, 0, 'minecraft:glass')
for (let y = 0; y < 3; y++) b.fill(y, 4 + y, 0, 8 - y, 4 + y, 6, 'minecraft:stonebrick')
b.save('小木屋')
return '9×7×7 的小木屋'`
    const flag = `const colors = [14, 14, 0, 0, 11, 11]
const b = blueprint(12, 6, 1)
for (let y = 0; y < 6; y++) for (let x = 0; x < 12; x++) b.set(x, y, 0, 'minecraft:wool/' + colors[5 - y])
b.save('三色旗')`
    for (const code of [hut, flag]) {
      const made = await design.run(code)
      if (made.outcome.status !== 'ok') console.log(`[dev] 草稿没做成：${JSON.stringify(made.outcome).slice(0, 200)}`)
    }
  }
  // 一张它看过的简图（对话页的工具结果下面显示），带着画它用的方块（可以开三维预览）
  const hutDraft = design.drafts.get('小木屋')
  if (hutDraft) {
    const { BlockLooks, blocksOfGrid, gridFromDraft, renderView } = await import('../src/render/index.ts')
    const { PictureStore } = await import('../src/store/pictures.ts')
    const grid = gridFromDraft(hutDraft.draft)
    const png = renderView(grid, new BlockLooks(design.colors()), { view: 'iso', from: 'southeast' }, { maxSize: 480, title: 'Draft' }).png
    samplePicture = new PictureStore(DATA_DIR).save(png, blocksOfGrid(grid))
  }
  // 工作清单：几条没做的、一条在等人的、两条做完的，谁写的都有
  const { TodoStore } = await import('../src/store/todo.ts')
  const todoStore = new TodoStore(DATA_DIR)
  if (todoStore.list().length === 0) {
    const t0 = Date.now()
    todoStore.apply({ add: [{ text: '平整基地南边那块地，y=69' }, { text: '问阿露明天要不要一起下矿' }] }, 'talk', t0 - 5 * 3600_000)
    todoStore.apply({ change: [{ id: 1, state: 'done' }, { id: 2, state: 'done' }] }, 'work', t0 - 4 * 3600_000)
    todoStore.apply({ add: [{ text: '修二号高炉', note: '不急，耐火砖够了再说' }] }, 'talk', t0 - 3 * 3600_000)
    todoStore.apply({ change: [{ id: 3, waitingFor: 'Steve 把耐火砖送来' }] }, 'work', t0 - 2 * 3600_000)
    todoStore.apply({ add: [{ text: '把身上的钢锭搬进抽屉矩阵' }] }, 'work', t0 - 40 * 60_000)
    todoStore.apply({ add: [{ text: '做 4 台基础卷板机', note: '放在一楼东边' }] }, 'owner', t0 - 20 * 60_000)
  }
  // 两条提醒：一条对话线定的，一条干活线定的（到点叫醒各自那条线）
  const { ReminderStore } = await import('../src/store/reminders.ts')
  const reminders = new ReminderStore(DATA_DIR)
  if (reminders.list().length === 0) {
    reminders.add(Date.now() + 6 * 3600_000, '问阿露明天要不要一起下矿', Date.now(), 'talk')
    reminders.add(Date.now() + 40 * 60_000, '看一眼高炉的钢锭出完没有，出完了收进仓库', Date.now(), 'work')
  }
  const memory = new MemoryStore(DATA_DIR, () => 4000)
  if (memory.list().length === 0) {
    memory.set('home:base', '主基地，(-522,69,43) 附近。仓库在南边那排压缩箱子，抽屉矩阵在 (-511,71,86)。')
    memory.set('主人的习惯', '阿露说“这个箱子”时指的是她准星对着的那个；动接着管道的容器之前先问。')
    memory.set('凿子', '钻石凿子右键打开界面，Shift 点泥土进去，再 Shift 点要的花纹取出来。一次一组。')
  }
  const feedback = new FeedbackStore(DATA_DIR)
  if (feedback.list().length === 0) {
    const context = { bot: BOT, brainVersion: '0.1.0', modVersion: 'v0.1.0-mock', turn: 93, instruction: '主人通过控制面板对你说：把 192 个泥土一次存进抽屉', recentTools: [{ tool: 'use_item', input: '{"id":"minecraft:dirt","on":{"x":-519,"y":69,"z":85}}', result: 'Task tmwbpmfe7 (use) started.' }, { tool: 'deposit_items', input: '{"container":{"x":-519,"y":69,"z":85},"items":[{"id":"minecraft:dirt","count":192}]}', result: 'tmwbpmfe8 deposit [done] result={"moved":192}' }], tasks: [{ id: 'tmwbpmfe7', type: 'use', state: 'done' }] }
    feedback.submit({ title: '无法测试持续右键抽屉', category: 'missing_tool', goal: '像玩家那样按住右键，把同一种东西一次全存进抽屉', problem: 'use_item 只能点一次，单次右键只存进去手上的一组，192 个泥土还在身上。', wish: '给 use_item 一个按住多久（或者连点几次）的参数。' }, context)
    feedback.submit({ title: 'screens 手册没写凿子界面的格子编号', category: 'data_or_manual', goal: '用钻石凿子把泥土凿成凿子泥土', problem: '手册里说“看格子”，但凿子界面有 60 个产物格，不知道哪个是哪种花纹，只能一个个试。', wish: '在手册里补一句：产物格按界面上的顺序排，名字在工具结果里。' }, { ...context, turn: 78 })
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
  await seedData().catch((e) => console.log(`[dev] 没能往数据目录里放样本：${e instanceof Error ? e.message : String(e)}`))
  await bridge.start()
  const llm = new MockLlm()
  llm.fallback = twoLineResponder
  await llm.start(LLM_PORT)

  // 假数据的时间线不用大脑自己的日志；--shape real 时大脑读的就是数据目录里那份样本
  if (SHAPE !== 'real') {
    if (LINES === 2) playTwoLines()
    else convertSample(SAMPLE)
    setScene(scene)
  }

  const child = spawn(process.execPath, ['--disable-sigusr1', 'src/main.ts'], {
    cwd: BRAIN,
    env: { ...process.env, AIPLAYER_PANEL_HOST: '127.0.0.1', AIPLAYER_PANEL_PORT: String(BRAIN_PORT), AIPLAYER_DATA_DIR: DATA_DIR, AIPLAYER_BRIDGE_PORT: String(BRIDGE_PORT), AIPLAYER_BRIDGE_TOKEN: TOKEN, AIPLAYER_PACKDATA: PACKDATA },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  let ready = false
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    // 口令不往终端上打
    for (const line of text.split('\n')) if (line.trim() && !line.includes('访问口令')) console.log(`[brain] ${line}`)
    if (!ready && text.includes('面板地址')) {
      ready = true
      void seedBrain().then(
        () => console.log(`[dev] 面板：http://127.0.0.1:${PROXY_PORT}/  （${SHAPE !== 'real' ? `假数据，${LINES} 条线，场景 ${scene}` : '大脑真实给的数据'}；口令在 GET /__dev 里）`),
        (e) => console.log(`[dev] 给大脑配模型时出错：${e instanceof Error ? e.message : String(e)}`),
      )
    }
  })
  child.on('exit', (code) => {
    console.log(`[dev] 大脑进程退出了（${code}）。`)
    process.exit(code ?? 1)
  })
  proxy.listen(PROXY_PORT, '127.0.0.1')

  const stop = (): void => {
    clearInterval(ticker)
    child.kill('SIGTERM')
    proxy.close()
    void bridge.stop()
    void llm.stop()
    setTimeout(() => process.exit(0), 1500).unref()
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
