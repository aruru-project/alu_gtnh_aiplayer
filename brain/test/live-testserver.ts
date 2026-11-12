// 对着真实 mod 的联调：模拟模型服务（按脚本回应）+ 真实启动的大脑进程 + 测试服的 bridge（127.0.0.1:25591，另一份检出的测试服见 live-brain.ts）。
// 两条线各接一个模拟模型服务：脚本写的是干活线（它操作身体）；对话线接的是只传话的那个（mock-llm.ts 的 talkRelay）——
// 面板和悄悄话发来的话它原样交给干活线，干活线停下来留的话、提问它用 say 在公共聊天里说出去（脚本里干活线做完一件事就停下留一句话）。
//
//   npm run live:testserver                       跑不需要重启服务器的场景（约 2 分钟）
//   npm run live:testserver -- --restart-server   最后再加一场“测试服重启”（多花 1–2 分钟，期间测试服不可用）
//   npm run live:testserver -- --only flatten,home   只跑名字里含这些词的场景
//   npm run live:testserver -- --transcript /tmp/live.txt   把每次给模型看的内容和它的回应写进文件
//
// 前提：测试服在运行（tools/testserver status），bot Alu 在线并带着匠魂镐和铲（没有就先跑 tools/test-kit.sh Alu），
// 32 格内有两个箱子、其中一个是空的。give_items 那一场要另一个 bot（默认 Scout）在线，不在线就跳过。
// 它不属于 npm test：要真实的游戏服务器，而且会真的在世界里挖和放方块（范围很小，见 pickFlattenWindow）。
// 动过的箱子和背包都会还原；结束时打印背包和箱子与开始时相比的变化。
// 只连测试服的 bridge；正式服的端口写死在 ports.ts 里，一律拒绝。不使用任何真实的模型接口。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import type { BotStatus, BridgeEvent, ScanResult, TaskInfo } from '../src/bridge/protocol.ts'
import { REPO_ROOT, TESTSERVER_BRIDGE_PORT, TOKEN_FILE, lastTurnText, rcon, run, say, sleep, stamp, startBrain, until } from './live-brain.ts'
import type { Step } from './live-brain.ts'
import { MockLlm, talkRelay } from './mock-llm.ts'
import type { MockReply, RecordedLlmRequest } from './mock-llm.ts'
import { RESERVED_PORTS } from './ports.ts'

const BOT = process.env.LIVE_BOT ?? 'Alu'
/** give_items 的对象：另一个在线的 bot（测试服上没有真人）。只往它脚边扔几个雪球，别的不动它。 */
const OTHER = process.env.LIVE_OTHER_BOT ?? 'Scout'
const HOME = 'braintest'
/**
 * 联调用的两个箱子（测试服上专门放的；要一个空的、一个有货的）。可以用 LIVE_CHESTS="x,y,z;x,y,z" 换。
 * 只用这两个：世界里还有地牢之类的天然箱子，绝不能让它自己去找“最近的箱子”。
 */
const CHESTS = (process.env.LIVE_CHESTS ?? '-51,99,-87;-47,99,-83').split(';').map((t) => {
  const [x, y, z] = t.split(',').map(Number)
  return { x: x!, y: y!, z: z! }
})
const ARGS = process.argv.slice(2)
const RESTART_SERVER = ARGS.includes('--restart-server')
const ONLY = ARGS.includes('--only') ? (ARGS[ARGS.indexOf('--only') + 1] ?? '').split(',').filter(Boolean) : []
const TRANSCRIPT = ARGS.includes('--transcript') ? ARGS[ARGS.indexOf('--transcript') + 1] : undefined

// ── 主流程 ──

interface Outcome {
  name: string
  ok: boolean
  /** 前提不满足，没有跑（不算通过）。 */
  skipped?: string
  seconds: number
  notes: string[]
  error?: string
}

/** 场景里抛它表示“前提不满足，这一场没法跑”。 */
class Skip extends Error {}

async function main(): Promise<number> {
  assert.ok(!RESERVED_PORTS.includes(TESTSERVER_BRIDGE_PORT) || TESTSERVER_BRIDGE_PORT === 25591, '只允许连测试服的 bridge')
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error(`找不到测试服的 bridge 口令文件：${TOKEN_FILE}\n测试服要先带着 mod 启动过一次。`)
    return 2
  }

  // 脚本自己的一条 bridge 连接：只用来看真实情况（状态、任务、事件），不经过大脑
  const events: BridgeEvent[] = []
  const observer = new BridgeClient({
    address: () => ({ host: '127.0.0.1', port: TESTSERVER_BRIDGE_PORT }),
    token: () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(),
    clientName: 'brain-live-driver',
    reconnectMinMs: 500,
    reconnectMaxMs: 3000,
  })
  observer.onEvent((e) => events.push(e))
  observer.start()
  const game = new BridgeApi(observer)
  try {
    await until('连上测试服的 bridge', () => observer.isConnected(), 8000)
  } catch {
    console.error(`连不上测试服的 bridge（127.0.0.1:${TESTSERVER_BRIDGE_PORT}）：${observer.status().lastError ?? '未知原因'}\n先确认 tools/testserver status 是 running。`)
    observer.stop()
    return 2
  }
  const hello = observer.status().hello!
  say(`已连上测试服：mod ${hello.modVersion}，协议 ${hello.protocol}，epoch ${hello.serverEpoch}`)

  let status: BotStatus = await game.botStatus(BOT).catch(() => ({ name: BOT, online: false }))
  if (!status.online) {
    console.error(`${BOT} 不在线。先让它上线（tools/bridge.py call bot.spawn '{"name":"${BOT}"}'）。`)
    observer.stop()
    return 2
  }
  const tools = (status.inventory ?? []).filter((i) => i.id.startsWith('TConstruct:')).map((i) => i.id)
  if (!tools.includes('TConstruct:shovel') || !tools.includes('TConstruct:pickaxe')) {
    console.error(`${BOT} 没有匠魂镐或铲（现有：${tools.join(', ') || '无'}）。先跑 tools/test-kit.sh ${BOT}。`)
    observer.stop()
    return 2
  }
  // 清掉残留的任务，免得上一次跑到一半的东西干扰
  await game.taskCancel(BOT)
  await sleep(300)

  if (TRANSCRIPT) fs.writeFileSync(TRANSCRIPT, `联调记录 ${new Date().toLocaleString('zh-CN')}\n`)
  const llm = new MockLlm()
  // 脚本之外的请求只有一种是预料之中的：历史太长时大脑让模型写摘要（那种请求不带工具）。
  let summaryCalls = 0
  llm.fallback = (req) => {
    const tools = req.api === 'openai' ? req.body?.tools : req.body?.tools
    if (Array.isArray(tools) && tools.length > 0) return { text: '' }
    summaryCalls++
    return { text: `（联调脚本写的第 ${summaryCalls} 份摘要）之前在测试服上做过一串联调动作：设过家 ${HOME}，平过一小块地，在两个箱子之间存取和搬运过东西，都已经做完，没有遗留的事。` }
  }
  await llm.start() // 临时端口
  // 对话线的模型：只传话
  const talkLlm = new MockLlm()
  talkLlm.fallback = talkRelay()
  await talkLlm.start()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplayer-live-'))
  fs.chmodSync(dataDir, 0o700)
  let brain = await startBrain(dataDir)
  const password = /已生成面板访问口令：(\S+)/.exec(brain.output())![1]!
  say(`大脑已启动，面板 ${brain.origin}，数据目录 ${dataDir}`)

  const outcomes: Outcome[] = []
  const findings: string[] = []
  const fixtureChanges: string[] = []
  let scripted = 0

  // 开始时的背包和箱子：有些场景要用箱子，结束时拿它们和最后的情况对比
  const totals = (items: readonly { id: string; meta?: number; count: number }[] | undefined) => {
    const m = new Map<string, number>()
    for (const it of items ?? []) m.set(it.meta ? `${it.id}/${it.meta}` : it.id, (m.get(it.meta ? `${it.id}/${it.meta}` : it.id) ?? 0) + it.count)
    return m
  }
  const readChests = async () => (await game.worldContainers({ bot: BOT }, { radius: 32 })).containers ?? []
  const chestAt = async (at: { x: number; y: number; z: number }) => (await game.worldContainers(at, { radius: 1 })).containers?.find((c) => c.x === at.x && c.y === at.y && c.z === at.z)
  const directTask = async (task: { type: string } & Record<string, unknown>, timeoutMs = 120_000) => {
    const mark = events.length
    const res = await game.taskStart(BOT, task)
    return until(`${task.type}（还原用）结束`, () => {
      const e = events.slice(mark).find((ev) => ev.event === 'task.update' && (ev.data.task as TaskInfo).id === res.task.id && ['done', 'failed', 'canceled'].includes((ev.data.task as TaskInfo).state) && (ev.data.task as TaskInfo).finishedAt !== undefined)
      return e ? (e.data.task as TaskInfo) : undefined
    }, timeoutMs)
  }
  // 用箱子的场景要求它站在那两个箱子旁边。不在的话先让它走过去（走不到就不跑了，不去别处凑合）。
  for (const c of CHESTS) {
    const block = await game.worldBlock(c)
    if (block.id !== 'minecraft:chest') {
      console.error(`(${c.x},${c.y},${c.z}) 不是箱子（${block.loaded === false ? '区块没加载' : block.id}）。用 LIVE_CHESTS 指定联调用的两个箱子。`)
      observer.stop()
      return 2
    }
  }
  const base = CHESTS[CHESTS.length - 1]!
  const farFromChests = () => Math.hypot((status.block?.x ?? 0) - base.x, (status.block?.z ?? 0) - base.z)
  if (farFromChests() > 8) {
    say(`${BOT} 离联调用的箱子 ${Math.round(farFromChests())} 格，先让它走到箱子旁边`)
    const walk = await directTask({ type: 'goto', x: base.x, y: base.y, z: base.z, range: 3 }, 300_000)
    status = await game.botStatus(BOT)
    if (walk.state !== 'done' || farFromChests() > 8) {
      console.error(`${BOT} 走不到箱子旁边（${JSON.stringify(walk.error ?? walk.result)}），现在在 ${JSON.stringify(status.block)}。先把它弄到 (${base.x},${base.y},${base.z}) 附近再跑。`)
      observer.stop()
      return 2
    }
  }
  const startInventory = totals(status.inventory)
  const startChests = (await readChests()).filter((c) => CHESTS.some((k) => k.x === c.x && k.y === c.y && k.z === c.z))
  /** 空箱子（当卸货箱、临时存东西）和有货的箱子（haul 的来源）。 */
  const emptyChest = startChests.find((c) => (c.usedSlots ?? 0) === 0)
  const stockChest = startChests.find((c) => (c.usedSlots ?? 0) > 0)
  const posOf = (c: { x: number; y: number; z: number }) => ({ x: c.x, y: c.y, z: c.z })
  /** 不经过大脑，直接让身体做一个任务并等它结束。只用来还原夹具。 */
  /** 从 list_containers 的工具结果里读出某个箱子的内容（“模型”就是这样知道箱子里有什么的）。 */
  const parseChest = (text: string, at: { x: number; y: number; z: number }) => {
    const line = text.split('\n').find((l) => l.includes(`(${at.x},${at.y},${at.z})`))
    assert.ok(line, `list_containers 的结果里有 (${at.x},${at.y},${at.z}) 这个箱子：${text.slice(0, 300)}`)
    const items: { id: string; meta?: number; count: number }[] = []
    for (const m of line.slice(line.indexOf('slots used:')).matchAll(/(\d+)× ([^\s\/,]+)(?:\/(\d+))?/g)) {
      items.push(m[3] === undefined ? { id: m[2]!, count: Number(m[1]) } : { id: m[2]!, meta: Number(m[3]), count: Number(m[1]) })
    }
    return items
  }
  /** “模型”看到的内容和预期不符时记在这里（不让模拟模型服务报错，免得大脑进入接口故障的退避）。 */
  const scriptErrors: string[] = []
  const failIfScriptBroke = () => {
    if (scriptErrors.length > 0) throw new Error(`模型看到的内容和预期不符：${scriptErrors.splice(0).join(' ‖ ')}`)
  }

  /** 排入这一场要用的模型回应。每个回应可以是固定的，也可以看了“最后给模型看的内容”再决定。 */
  const script = (...steps: Step[]) => {
    scripted += steps.length
    llm.enqueue(
      ...steps.map((s) => (req: RecordedLlmRequest): MockReply => {
        const seen = lastTurnText(req)
        let reply: MockReply
        try {
          reply = typeof s === 'function' ? s(seen, req) : s
        } catch (e) {
          scriptErrors.push(e instanceof Error ? e.message : String(e))
          reply = { text: '' }
        }
        if (TRANSCRIPT) {
          const said = [reply.text ? `文本：${reply.text}` : '', ...(reply.toolCalls ?? []).map((c) => `调用 ${c.name} ${JSON.stringify(c.input ?? {})}`)].filter(Boolean)
          fs.appendFileSync(
            TRANSCRIPT,
            `\n━━━ 第 ${llm.requests.length} 次模型调用（${req.api}，${stamp()}）━━━\n【模型看到的（最后一条）】\n${seen}\n【模型的回应（脚本）】\n${said.join('\n') || '（空文本，结束这一轮）'}\n`,
          )
        }
        return reply
      }),
    )
  }
  const modelCalls = () => llm.requests.length
  const idle = async () => {
    // 大脑这一轮跑完、脚本里的回应用完
    await until('大脑空闲且脚本用完', async () => {
      if (llm.remaining !== 0) return false
      const overview = await brain.call('GET', '/overview')
      return overview.agent.busy === false && overview.agent.pending === 0 && overview.talk.busy === false && overview.talk.pending === 0
    }, 30_000)
  }
  const eventsSince = (mark: number) => events.slice(mark)
  const taskEnd = (mark: number, type: string, timeoutMs: number) =>
    until(`${type} 任务结束`, () => {
      failIfScriptBroke()
      const e = eventsSince(mark).find((ev) => ev.event === 'task.update' && ev.data.bot === BOT && (ev.data.task as TaskInfo).type === type && ['done', 'failed', 'canceled'].includes((ev.data.task as TaskInfo).state))
      return e ? (e.data.task as TaskInfo) : undefined
    }, timeoutMs)
  const botSaid = (mark: number, re: RegExp, timeoutMs = 20_000) =>
    until(`${BOT} 在聊天里说 ${re}`, () => {
      failIfScriptBroke()
      return eventsSince(mark).find((ev) => ev.event === 'chat' && ev.data.player === BOT && re.test(String(ev.data.message)))
    }, timeoutMs)
  const command = (text: string) => brain.call('POST', '/command', { text })

  const scenario = async (name: string, fn: (notes: string[]) => Promise<void>) => {
    if (ONLY.length > 0 && !ONLY.some((w) => name.includes(w))) return
    say(`▶ ${name}`)
    const started = Date.now()
    const notes: string[] = []
    const callsBefore = modelCalls()
    const scriptedBefore = scripted
    const summariesBefore = summaryCalls
    try {
      await fn(notes)
      await idle()
      failIfScriptBroke()
      await sleep(600) // 留一点时间，看有没有计划之外的模型调用
      // 写摘要的调用不算“被多叫醒”
      const extra = modelCalls() - callsBefore - (scripted - scriptedBefore) - (summaryCalls - summariesBefore)
      if (extra > 0) {
        const texts = llm.requests.slice(-extra - (summaryCalls - summariesBefore)).map((r) => lastTurnText(r).split('[当前状态]')[0]!.trim().slice(0, 300))
        findings.push(`「${name}」里模型被多叫醒了 ${extra} 次（脚本没预料到）。最近的几次请求：${texts.join(' ‖ ')}`)
      }
      outcomes.push({ name, ok: true, seconds: (Date.now() - started) / 1000, notes })
      say(`  ✔ 通过（${((Date.now() - started) / 1000).toFixed(1)} 秒）`)
      for (const n of notes) say(`    · ${n}`)
    } catch (e) {
      if (e instanceof Skip) {
        outcomes.push({ name, ok: false, skipped: e.message, seconds: 0, notes })
        say(`  – 跳过（没有验证）：${e.message}`)
        return
      }
      const error = [e instanceof Error ? e.message : String(e), ...scriptErrors.splice(0)].join(' ‖ ')
      outcomes.push({ name, ok: false, seconds: (Date.now() - started) / 1000, notes, error })
      say(`  ✖ 失败：${error}`)
      for (const n of notes) say(`    · ${n}`)
      const log = await brain.call('GET', '/log').catch(() => ({ entries: [] }))
      for (const entry of (log.entries as { kind: string; who?: string; text: string }[]).slice(-14)) say(`    | ${entry.kind} ${entry.who ?? ''} ${entry.text.slice(0, 220)}`)
      // 把没用完的脚本清掉，别串到下一场；手上的任务也停掉
      scripted -= llm.clearScript()
      await game.taskCancel(BOT).catch(() => {})
      await sleep(1500)
    }
  }

  try {
    // ── 准备：在面板上配模型（先用 Anthropic 兼容，后半程换 OpenAI 兼容）、让 bot “上线” ──
    script({ text: 'pong' })
    const anthropic = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: '模拟 Anthropic', baseUrl: llm.anthropicBaseUrl, apiKey: 'sk-ant-live-fake-0001', model: 'claude-live' })
    const test = await brain.call('POST', '/providers/test', { id: anthropic.provider.id, kind: 'anthropic-messages', label: '模拟 Anthropic', baseUrl: llm.anthropicBaseUrl, apiKey: '', model: 'claude-live' })
    assert.equal(test.ok, true, '面板上测试连接')
    const openai = await brain.call('POST', '/providers', { kind: 'openai-chat', label: '模拟 OpenAI', baseUrl: llm.openaiBaseUrl, apiKey: 'sk-live-fake-0002', model: 'gpt-live' })
    // 对话线另用一家（只传话的那个）；干活线用上面配的
    const forTalk = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: '对话线（只传话）', baseUrl: talkLlm.anthropicBaseUrl, apiKey: 'sk-ant-live-fake-0003', model: 'talk-live' })
    await brain.call('POST', '/models/use', { providerId: forTalk.provider.id, modelId: forTalk.provider.models[0].id, line: 'talk' })
    await until('大脑连上测试服', async () => (await brain.call('GET', '/overview')).bridge.state === 'connected', 10_000)
    await brain.call('POST', '/bot/spawn', {})
    // 把历史压缩的阈值调低，让压缩在这一趟里一定会发生；之后的场景顺便证明压缩完还能接着干
    await brain.call('PUT', '/bot', { limits: { historyTokenThreshold: 12_000 } })
    const overview = await brain.call('GET', '/overview')
    assert.equal(overview.bot.status.online, true)
    say(`准备好了：面板概览里 ${BOT} 在线，位置 ${JSON.stringify(overview.bot.status.block)}，背包空位 ${overview.bot.status.freeSlots}`)

    // ── 1. 设 home（之后走远了再传送回来） ──
    let homeBlock = status.block!
    await scenario('set_home：把现在的位置设成家并记进记忆', async (notes) => {
      status = await game.botStatus(BOT)
      homeBlock = status.block!
      const mark = events.length
      let probe = ''
      script(
        {
          toolCalls: [
            { name: 'set_home', input: { name: HOME, note: '联调用的临时家' } },
            { name: 'list_homes', input: {} },
            // 顺便问一下脚下那一格现在挖不挖得动（bot.probe）
            { name: 'probe_block', input: { x: homeBlock.x, y: homeBlock.y - 1, z: homeBlock.z } },
            // 加入一个不存在的队伍：指令在允许列表里（不是 denied），服务器说找不到
            { name: 'join_team', input: { team: 'no_such_team_xyz' } },
          ],
        },
        (text) => {
          assert.match(text, new RegExp(`Home '${HOME}' set!`), 'sethome 的真实回显')
          assert.match(text, new RegExp(`${BOT}: \\d+ / 99: .*${HOME}`), 'home list 的真实回显')
          const m = /^\(-?\d+,\d+,-?\d+\): \S+.*\nYou can dig it in about [\d.]+ s \(\d+ ticks\) using (TConstruct:\w+:\d+ \(slot \d+\)|your bare hand)\./m.exec(text)
          assert.ok(m, `probe_block 的结果：${text.slice(-400)}`)
          probe = m[0].replace('\n', ' / ')
          assert.match(text, /Could not join\. The server replied: Team 'no_such_team_xyz' not found!/, 'team join 的真实回显')
          return { text: `家设好了，叫 ${HOME}。` }
        },
      )
      await command(`把你现在站的地方设成家，名字叫 ${HOME}`)
      await botSaid(mark, /家设好了/)
      const memory = await brain.call('GET', '/memory')
      const note = (memory.notes as { key: string; text: string }[]).find((n) => n.key === `home:${HOME}`)
      assert.ok(note, '记忆里有 home 这一条')
      assert.match(note.text, new RegExp(`\\(${homeBlock.x},${homeBlock.y},${homeBlock.z}\\) dim 0 — 联调用的临时家`))
      notes.push(`家在 (${homeBlock.x},${homeBlock.y},${homeBlock.z})，记忆：${note.text}`)
      notes.push(`probe_block 脚下那一格：${probe}`)
    })

    // ── 2. 面板下指令 → get_status + scan_area → 小 flatten → 任务结束叫醒 → say ──
    let flat: { x1: number; z1: number; y: number } | undefined
    await scenario('flatten：面板下指令 → 看状态和地形 → 平一小块地 → 任务结束后被叫醒 → 回话', async (notes) => {
      const area = await pickFlattenWindow(game, BOT)
      notes.push(`选的区域：x ${area.x1}..${area.x2}，z ${area.z1}..${area.z2}（${area.note}）`)
      const mark = events.length
      let chosenY = -1
      let firstTurnDoneAt = 0
      // 两轮的回应都先排好再下指令：第一轮 3 步（看 → 动手 → 收尾），任务结束被叫醒后的第二轮 2 步
      script(
        { toolCalls: [{ name: 'get_status', input: {} }, { name: 'scan_area', input: { x1: area.x1, z1: area.z1, x2: area.x2, z2: area.z2 } }] },
        (text) => {
          // “模型”从真实的扫描结果里读出最常见的高度，定为平地的高度
          assert.match(text, new RegExp(`${BOT}: online in overworld`), 'get_status 的结果')
          const m = /most common (\d+)/.exec(text)
          assert.ok(m, `scan_area 的结果里有最常见高度：${text.slice(0, 300)}`)
          chosenY = Number(m[1])
          return {
            thinking: { thinking: `这块地大多在 y=${chosenY}，就平到这个高度。`, signature: 'sig-live' },
            toolCalls: [
              { name: 'flatten_area', input: { x1: area.x1, z1: area.z1, x2: area.x2, z2: area.z2, y: chosenY } },
            ],
          }
        },
        (text) => {
          assert.match(text, /Task t\w+ \(flatten\) started\./, '任务启动后的工具结果')
          firstTurnDoneAt = Date.now()
          return { text: '' }
        },
        // 任务结束 → 大脑被叫醒 → 回话。回话内容取自真实的任务结果。
        (text) => {
          const m = /任务 (t\w+)（flatten）完成了。 结果：(\{.*\})/.exec(text)
          assert.ok(m, `被叫醒时看到任务结果：${text.slice(0, 400)}`)
          const result = JSON.parse(m[2]!)
          return { text: `平好了，挖了 ${result.removed} 块，填了 ${result.placed} 块。` }
        },
      )
      await command(`把 x ${area.x1}..${area.x2}、z ${area.z1}..${area.z2} 这一小块地平一下，高度你自己看着定。`)
      const task = await taskEnd(mark, 'flatten', 180_000)
      assert.equal(task.state, 'done', `flatten 的结局：${JSON.stringify(task.error ?? task.result)}`)
      const report = await botSaid(mark, /平好了，挖了 \d+ 块/)
      // bot 干活期间不消耗模型调用：第一轮收尾之后、任务结束之前，没有任何请求打到模型
      const duringWork = llm.requests.filter((r) => r.at > firstTurnDoneAt + 50 && r.at < (task.finishedAt ?? 0)).length
      assert.equal(duringWork, 0, '任务进行期间没有调用模型')
      const seconds = ((task.finishedAt ?? 0) - (task.startedAt ?? 0)) / 1000
      notes.push(`任务 ${task.id}：${seconds.toFixed(1)} 秒，结果 ${JSON.stringify(task.result)}`)
      notes.push(`它说：${String(report.data.message)}`)
      assert.equal(task.result?.level, chosenY)
      flat = { x1: area.x1, z1: area.z1, y: chosenY }
      if (task.result?.climbingBlocksLeftStanding) findings.push(`flatten ${task.id} 留下了 ${String(task.result.climbingBlocksLeftStanding)} 块没拆掉的垫脚方块。`)
      // 真实世界里确实平了：区域内（除了被跳过的列）高度都是 chosenY
      const after = await game.worldScan(area)
      const skippedColumns = Object.values((task.result?.skipped ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0)
      const off = after.heights.flat().filter((y) => y !== chosenY).length
      notes.push(`平完再扫：${after.heights.flat().length - off}/${after.heights.flat().length} 列在 y=${chosenY}`)
      if (off > skippedColumns) {
        // 大脑这边的流程是通的；任务报告“完成、没有跳过”，世界里却不平，这是身体那边要看的
        findings.push(
          `flatten ${task.id}（x ${area.x1}..${area.x2}，z ${area.z1}..${area.z2}，y=${chosenY}）报告 done、跳过 ${skippedColumns} 列，但再扫时有 ${off} 列不在 y=${chosenY}：${JSON.stringify(after.heights)}。同样的参数再跑一次 flatten 可以清掉。`,
        )
      }
    })

    // ── 2b. clear_area（带 dropoff）→ 把卸进箱子的东西取回来 → fill_area 填回去 ──
    await scenario('clear + dropoff + fill：清掉一小块、东西自动卸进箱子、取回来、再填上', async (notes) => {
      if (!flat || !emptyChest || !stockChest) {
        throw new Skip('需要先跑过 flatten，并且附近要有一个空箱子和一个有货的箱子')
      }
      const y = flat.y
      const box = { x1: flat.x1, y1: y, z1: flat.z1, x2: flat.x1 + 1, y2: y, z2: flat.z1 + 1 }
      const cells = [0, 1].flatMap((dx) => [0, 1].map((dz) => ({ x: box.x1 + dx, y, z: box.z1 + dz })))
      const B = posOf(emptyChest)
      const A = posOf(stockChest)
      const invBefore = totals((await game.botStatus(BOT)).inventory)
      const aBefore = totals((await chestAt(A))?.items)
      const mark = events.length
      let clearResult: Record<string, unknown> = {}
      let unloaded = 0
      const restoreAndFill: Step[] = [
        // 被 clear 的结束叫醒：看看箱子里多了什么
        (text) => {
          const m = /任务 t\w+（clear）完成了。 结果：(\{.*\})/.exec(text)
          assert.ok(m, `被叫醒时看到 clear 的结果：${text.slice(0, 400)}`)
          clearResult = JSON.parse(m[1]!)
          return { toolCalls: [{ name: 'list_containers', input: { radius: 32 } }] }
        },
        // 把卸进空箱子的东西全取回来；溢出到另一个箱子的那部分下一步再取
        (text) => {
          const inB = parseChest(text, B)
          unloaded = inB.reduce((n, i) => n + i.count, 0)
          assert.ok(inB.length > 0, '清完以后东西卸进了箱子')
          const inA = parseChest(text, A)
          const extraA = inA.map((i) => ({ ...i, count: i.count - (aBefore.get(i.meta ? `${i.id}/${i.meta}` : i.id) ?? 0) })).filter((i) => i.count > 0)
          const fill: Step[] = [
            { toolCalls: [{ name: 'fill_area', input: { ...box, item: 'minecraft:dirt' } }] },
            { text: '' },
            (t3) => {
              assert.match(t3, /任务 t\w+（fill）完成了。 结果：\{"removed":0,"placed":4/, `被叫醒时看到 fill 的结果：${t3.slice(0, 300)}`)
              return { text: '清掉又填回去了，东西也都拿回来了。' }
            },
          ]
          // 后面几步现在才知道要不要多取一次，所以在这里接着排
          if (extraA.length > 0) {
            unloaded += extraA.reduce((n, i) => n + i.count, 0)
            script({ text: '' }, { toolCalls: [{ name: 'withdraw_items', input: { container: A, items: extraA } }] }, { text: '' }, ...fill)
          } else {
            script({ text: '' }, ...fill)
          }
          return { toolCalls: [{ name: 'withdraw_items', input: { container: B, items: inB } }] }
        },
      ]
      script({ toolCalls: [{ name: 'clear_area', input: { ...box, dropoff: [B, A] } }] }, { text: '' }, ...restoreAndFill)
      try {
        await command(`把 (${box.x1},${y},${box.z1}) 到 (${box.x2},${y},${box.z2}) 这四格清掉，挖出来的东西卸到箱子里，然后把东西拿回来、用泥土填上。`)
        const clear = await taskEnd(mark, 'clear', 120_000)
        assert.equal(clear.state, 'done', JSON.stringify(clear.error ?? clear.result))
        for (const c of cells) assert.equal((await game.worldBlock(c)).air, true, `清完以后 (${c.x},${c.y},${c.z}) 是空的`)
        assert.equal(clear.result?.removed, 4)
        assert.equal(clear.result?.clearedDownTo, y)
        // 结束时卸过货：记下卸完以后背包还剩多少
        const afterClear = await game.botStatus(BOT)
        notes.push(`clear ${clear.id}：${JSON.stringify(clear.result)}；任务结束时背包空位 ${afterClear.freeSlots}（开始时 ${36 - [...invBefore.keys()].length} 左右）`)
        const fill = await taskEnd(mark, 'fill', 240_000)
        assert.equal(fill.state, 'done', JSON.stringify(fill.error ?? fill.result))
        await botSaid(mark, /清掉又填回去了/)
        for (const c of cells) assert.equal((await game.worldBlock(c)).id, 'minecraft:dirt', `填完以后 (${c.x},${c.y},${c.z}) 是泥土`)
        notes.push(`从箱子里取回 ${unloaded} 个东西；fill ${fill.id}：${JSON.stringify(fill.result)}`)
        void clearResult
      } finally {
        // 不管成没成，箱子里多出来的东西都要回到背包里
        await sleep(300)
        await game.taskCancel(BOT).catch(() => {})
        const leftB = (await chestAt(B))?.items ?? []
        if (leftB.length > 0) await directTask({ type: 'withdraw', container: B, items: leftB.map((i) => ({ id: i.id, meta: i.meta ?? 0, count: i.count })) }).catch(() => {})
        const extra = ((await chestAt(A))?.items ?? []).map((i) => ({ id: i.id, meta: i.meta ?? 0, count: i.count - (aBefore.get(i.meta ? `${i.id}/${i.meta}` : i.id) ?? 0) })).filter((i) => i.count > 0)
        if (extra.length > 0) await directTask({ type: 'withdraw', container: A, items: extra }).catch(() => {})
      }
      const invAfter = totals((await game.botStatus(BOT)).inventory)
      const changed = [...new Set([...invBefore.keys(), ...invAfter.keys()])].filter((k) => invBefore.get(k) !== invAfter.get(k)).map((k) => `${k} ${invBefore.get(k) ?? 0}→${invAfter.get(k) ?? 0}`)
      notes.push(`背包和这一场开始时相比：${changed.join('，') || '没有变化'}`)
      assert.equal((await chestAt(B))?.usedSlots ?? 0, 0, '空箱子还原成空的')
    })

    // ── 3. 传送回家（平地的地方离家十几格） ──
    await scenario('go_home：传送回一开始设的家', async (notes) => {
      let before = (await game.botStatus(BOT)).block!
      if (Math.hypot(before.x - homeBlock.x, before.z - homeBlock.z) < 5) {
        // 离家太近看不出传送：先让它往东南（下坡的草地）走开十来格
        const away = { x: homeBlock.x + 9, z: homeBlock.z + 7 }
        const m = events.length
        script({ toolCalls: [{ name: 'go_to', input: away }] }, { text: '' }, { text: '' })
        await command(`先走到 x=${away.x} z=${away.z}`)
        const walk = await taskEnd(m, 'goto', 60_000)
        assert.equal(walk.state, 'done', JSON.stringify(walk.error ?? walk.result))
        await idle()
        before = (await game.botStatus(BOT)).block!
        notes.push(`先走开：goto ${walk.id} → (${before.x},${before.y},${before.z})`)
      }
      assert.ok(Math.hypot(before.x - homeBlock.x, before.z - homeBlock.z) >= 5, `传送前它应该离家有一段距离，现在在 ${JSON.stringify(before)}，家在 ${JSON.stringify(homeBlock)}`)
      const mark = events.length
      script(
        { toolCalls: [{ name: 'go_home', input: { name: HOME } }] },
        { text: '' },
        (text) => {
          assert.match(text, /任务 t\w+（home）完成了。 结果：\{"dim":0,"block":\{/, `被叫醒时看到结果：${text.slice(0, 300)}`)
          return { text: '到家了。' }
        },
      )
      await command(`回 ${HOME}`)
      const task = await taskEnd(mark, 'home', 30_000)
      assert.equal(task.state, 'done', JSON.stringify(task.error ?? task.result))
      await botSaid(mark, /到家了/)
      const after = (await game.botStatus(BOT)).block!
      const dist = Math.hypot(after.x - homeBlock.x, after.z - homeBlock.z)
      assert.ok(dist <= 1.5 && Math.abs(after.y - homeBlock.y) <= 1, `传送后在 ${JSON.stringify(after)}，家在 ${JSON.stringify(homeBlock)}`)
      notes.push(`从 (${before.x},${before.y},${before.z}) 传送到 (${after.x},${after.y},${after.z})；任务结果 ${JSON.stringify(task.result)}`)
    })

    // ── 4. 存进箱子，再原样取回来 ──
    await scenario('deposit / withdraw：把一种东西存进箱子，再取回同样的数量', async (notes) => {
      if (!emptyChest) throw new Skip('附近要有一个空箱子')
      const box = emptyChest
      status = await game.botStatus(BOT)
      const counts = new Map<string, number>()
      for (const it of status.inventory ?? []) if (!it.id.startsWith('TConstruct:') && !it.meta) counts.set(it.id, (counts.get(it.id) ?? 0) + it.count)
      const [itemId, have] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? []
      assert.ok(itemId && have, '背包里有能存的东西')
      const amount = Math.min(have, 70)
      const before = (box.items ?? []).filter((i) => i.id === itemId).reduce((n, i) => n + i.count, 0)
      const at = { x: box.x, y: box.y, z: box.z }
      notes.push(`箱子 (${at.x},${at.y},${at.z})，物品 ${itemId} ×${amount}（背包里有 ${have}，箱子里原有 ${before}）`)

      const mark = events.length
      // 三轮的回应都先排好：看箱子并存 → （存完被叫醒）取回来 → （取完被叫醒）回话
      script(
        { toolCalls: [{ name: 'list_containers', input: { radius: 32 } }] },
        (text) => {
          assert.match(text, new RegExp(`\\(${at.x},${at.y},${at.z}\\) Chest \\[minecraft:chest\\]`), 'list_containers 的结果里有这个箱子')
          return { toolCalls: [{ name: 'deposit_items', input: { container: at, items: [{ id: itemId, count: amount }] } }] }
        },
        { text: '' },
        (text) => {
          assert.match(text, /任务 t\w+（deposit）完成了。 结果：\{"moved":\d+/, `被叫醒时看到 deposit 的结果：${text.slice(0, 300)}`)
          return { toolCalls: [{ name: 'withdraw_items', input: { container: at, items: [{ id: itemId, count: amount }] } }] }
        },
        { text: '' },
        (text) => {
          assert.match(text, /任务 t\w+（withdraw）完成了。 结果：\{"moved":\d+/, `被叫醒时看到 withdraw 的结果：${text.slice(0, 300)}`)
          return { text: '存进去又取回来了，数量没变。' }
        },
      )
      const sent = await rcon(`tell ${BOT} 把 ${amount} 个 ${itemId} 存进箱子`)
      assert.equal(sent.code, 0, `RCON tell：${sent.out}`)
      const deposit = await taskEnd(mark, 'deposit', 90_000)
      assert.equal(deposit.state, 'done', JSON.stringify(deposit.error ?? deposit.result))
      assert.equal(deposit.result?.moved, amount)
      const whisper = eventsSince(mark).find((e) => e.event === 'whisper')
      notes.push(`触发方式：RCON tell → whisper 事件 from=${String(whisper?.data.from)}`)
      notes.push(`deposit ${deposit.id}：${JSON.stringify(deposit.result)}`)
      const withdraw = await taskEnd(mark, 'withdraw', 90_000)
      assert.equal(withdraw.state, 'done', JSON.stringify(withdraw.error ?? withdraw.result))
      assert.equal(withdraw.result?.moved, amount)
      await botSaid(mark, /数量没变/)
      notes.push(`withdraw ${withdraw.id}：${JSON.stringify(withdraw.result)}`)
      const after = await game.botStatus(BOT)
      const haveAfter = (after.inventory ?? []).filter((i) => i.id === itemId).reduce((n, i) => n + i.count, 0)
      assert.equal(haveAfter, have, '背包里这种东西的数量和开始时一样')
    })

    // ── 4b. haul：在两个箱子之间搬过去再搬回来 ──
    await scenario('haul_items：把一种东西从一个箱子搬到另一个，再搬回去', async (notes) => {
      if (!emptyChest || !stockChest) {
        throw new Skip('附近要有一个空箱子和一个有货的箱子')
      }
      const A = posOf(stockChest)
      const B = posOf(emptyChest)
      // 挑有货箱子里数量最少的一种（一趟就能搬完）
      const stock = ((await chestAt(A))?.items ?? []).filter((i) => !i.id.startsWith('questbook:')).sort((x, y) => x.count - y.count)[0]
      assert.ok(stock, '有货的箱子里有东西可搬')
      const filter = stock.meta ? { id: stock.id, meta: stock.meta } : { id: stock.id }
      const mark = events.length
      script(
        { toolCalls: [{ name: 'haul_items', input: { from: A, to: B, items: [filter] } }] },
        { text: '' },
        (text) => {
          assert.match(text, new RegExp(`任务 t\\w+（haul）完成了。 结果：\\{"moved":${stock.count},"trips":\\d+`), `被叫醒时看到 haul 的结果：${text.slice(0, 300)}`)
          return { toolCalls: [{ name: 'haul_items', input: { from: B, to: A, items: [filter] } }] }
        },
        { text: '' },
        (text) => {
          assert.match(text, new RegExp(`任务 t\\w+（haul）完成了。 结果：\\{"moved":${stock.count},"trips":\\d+`), `被叫醒时看到第二趟 haul 的结果：${text.slice(0, 300)}`)
          return { text: '搬过去又搬回来了。' }
        },
      )
      await command(`把箱子 (${A.x},${A.y},${A.z}) 里的 ${stock.id} 全搬到 (${B.x},${B.y},${B.z})，再搬回来`)
      const first = await taskEnd(mark, 'haul', 120_000)
      assert.equal(first.state, 'done', JSON.stringify(first.error ?? first.result))
      await botSaid(mark, /搬过去又搬回来了/, 120_000)
      const hauls = eventsSince(mark).filter((e) => e.event === 'task.update' && (e.data.task as TaskInfo).type === 'haul' && (e.data.task as TaskInfo).state === 'done').map((e) => e.data.task as TaskInfo)
      notes.push(`${stock.id} ×${stock.count}：去 ${hauls[0]?.id} ${JSON.stringify(hauls[0]?.result)}，回 ${hauls[1]?.id} ${JSON.stringify(hauls[1]?.result)}`)
      // 两个箱子都和开始时一样；bot 自己背包里的同种东西没被动过
      const key = stock.meta ? `${stock.id}/${stock.meta}` : stock.id
      assert.equal(totals((await chestAt(A))?.items).get(key), stock.count)
      assert.equal(totals((await chestAt(B))?.items).get(key), undefined)
    })

    // ── 换成 OpenAI 兼容的那条服务商，后面的场景都走它 ──
    await brain.call('POST', '/models/use', { providerId: openai.provider.id, modelId: openai.provider.models[0].id, line: 'work' })
    say('已在面板上把干活线的模型换成 OpenAI 兼容的那一条')

    // ── 5. 任务失败后的再唤醒 ──
    await scenario('失败再唤醒：fill 用背包里没有的方块（no_material）', async (notes) => {
      // 要一个确定是空气、脚下是实心方块的格子：刚平好的那块地正上方最可靠（地面上常有一层薄雪，不算空气）
      let spot = flat ? { x: flat.x1 + 2, y: flat.y + 1, z: flat.z1 + 2 } : undefined
      if (spot) {
        const [here, below] = await Promise.all([game.worldBlock(spot), game.worldBlock({ ...spot, y: spot.y - 1 })])
        if (!here.air || !below.solid) spot = undefined
      }
      spot ??= await findEmptySpot(game, BOT)
      notes.push(`要放的位置：(${spot.x},${spot.y},${spot.z})`)
      const mark = events.length
      script(
        { toolCalls: [{ name: 'fill_area', input: { x1: spot.x, y1: spot.y, z1: spot.z, x2: spot.x, y2: spot.y, z2: spot.z, item: 'minecraft:diamond_block' } }] },
        { text: '' },
        (text) => {
          const m = /任务 t\w+（fill）失败了：no_material — (.*?) detail=(\{.*?\})(?: 已完成的部分|$)/m.exec(text)
          assert.ok(m, `被叫醒时看到失败原因：${text.slice(0, 400)}`)
          const detail = JSON.parse(m[2]!)
          const what = detail.item?.id ?? detail.items?.[0]?.id ?? '东西'
          return { text: `放不了：我没有 ${what}，还差 ${detail.missing} 个。` }
        },
      )
      await command(`在 (${spot.x},${spot.y},${spot.z}) 放一个钻石块`)
      const task = await taskEnd(mark, 'fill', 60_000)
      assert.equal(task.state, 'failed')
      assert.equal(task.error?.code, 'no_material')
      const said = await botSaid(mark, /我没有 minecraft:diamond_block，还差 1 个/)
      notes.push(`fill ${task.id} 失败：${JSON.stringify(task.error)}`)
      notes.push(`它说：${String(said.data.message)}`)
    })

    await scenario('失败再唤醒：go_home 去一个不存在的家（invalid）', async (notes) => {
      const mark = events.length
      script(
        { toolCalls: [{ name: 'go_home', input: { name: 'no_such_home_xyz' } }] },
        { text: '' },
        (text) => {
          assert.match(text, /任务 t\w+（home）失败了：invalid — Unknown Home: 'no_such_home_xyz'!/, `被叫醒时看到失败原因：${text.slice(0, 300)}`)
          return { text: '没有叫 no_such_home_xyz 的家。' }
        },
      )
      await command('回 no_such_home_xyz')
      const task = await taskEnd(mark, 'home', 30_000)
      assert.equal(task.state, 'failed')
      await botSaid(mark, /没有叫 no_such_home_xyz 的家/)
      notes.push(`home ${task.id} 失败：${JSON.stringify(task.error)}`)
    })

    await scenario('withdraw 箱子里没有的东西：任务算完成，但结果里有 missing', async (notes) => {
      if (!emptyChest) throw new Skip('附近要有一个空箱子')
      const box = emptyChest
      const mark = events.length
      script(
        { toolCalls: [{ name: 'withdraw_items', input: { container: { x: box.x, y: box.y, z: box.z }, items: [{ id: 'minecraft:diamond', count: 2 }] } }] },
        { text: '' },
        (text) => {
          const m = /任务 t\w+（withdraw）完成了。 结果：(\{.*\})/.exec(text)
          assert.ok(m, `被叫醒时看到结果：${text.slice(0, 300)}`)
          const result = JSON.parse(m[1]!)
          assert.equal(result.moved, 0)
          return { text: `箱子里没有钻石，缺 ${result.missing[0].count} 个。` }
        },
      )
      await command('从箱子里拿 2 个钻石')
      const task = await taskEnd(mark, 'withdraw', 60_000)
      assert.equal(task.state, 'done')
      await botSaid(mark, /箱子里没有钻石，缺 2 个/)
      notes.push(`withdraw ${task.id}：${JSON.stringify(task.result)}`)
    })

    await scenario('失败再唤醒：go_to 一个 5000 格外的地方（unreachable，太远）', async (notes) => {
      const here = (await game.botStatus(BOT)).block!
      const mark = events.length
      script(
        { toolCalls: [{ name: 'go_to', input: { x: here.x + 5000, z: here.z } }] },
        { text: '' },
        (text) => {
          const hits = text.match(/任务 t\w+（goto）失败了：unreachable — that is 5000 blocks away and the bot walks at most \d+; teleport closer first/g) ?? []
          assert.equal(hits.length, 1, `被叫醒时看到一次“太远”的失败：${text.slice(0, 400)}`)
          return { text: '太远了走不过去，得先传送到附近。' }
        },
      )
      await command(`走到 x=${here.x + 5000} z=${here.z}`)
      const task = await taskEnd(mark, 'goto', 30_000)
      assert.equal(task.state, 'failed')
      assert.equal(task.error?.code, 'unreachable')
      await botSaid(mark, /太远了走不过去/)
      const copies = eventsSince(mark).filter((e) => e.event === 'task.update' && (e.data.task as TaskInfo).id === task.id && (e.data.task as TaskInfo).state === 'failed').length
      notes.push(`goto ${task.id} 失败：${task.error?.message}；身体为这次失败发了 ${copies} 个 task.update`)
      if (copies > 1) findings.push(`任务一开始就失败时（goto 太远），身体发了 ${copies} 次 failed 的 task.update（第一次没有 finishedAt）。大脑按任务 id 去重了，模型只看到一次。`)
    })

    await scenario('失败再唤醒：把镐存进箱子后去挖石头（no_tool），再把镐取回来', async (notes) => {
      if (!emptyChest) {
        throw new Skip('附近要有一个空箱子')
      }
      const B = posOf(emptyChest)
      const pick = { id: 'TConstruct:pickaxe', count: 1 }
      const hasPick = async () => ((await game.botStatus(BOT)).inventory ?? []).some((i) => i.id === pick.id)
      assert.ok(await hasPick(), '开始时背包里有匠魂镐')
      const stone = await findSurfaceStone(game, BOT)
      notes.push(`要挖的石头：(${stone.x},${stone.y},${stone.z})`)
      const mark = events.length
      script(
        { toolCalls: [{ name: 'deposit_items', input: { container: B, items: [pick] } }] },
        { text: '' },
        (text) => {
          assert.match(text, /任务 t\w+（deposit）完成了。 结果：\{"moved":1/, `镐存进去了：${text.slice(0, 300)}`)
          return { toolCalls: [{ name: 'probe_block', input: stone }, { name: 'dig_blocks', input: { blocks: [stone] } }] }
        },
        (text) => {
          // 没有镐时 probe 就已经说挖不动了
          assert.match(text, /You cannot dig it/, `没有镐时 probe_block 的结果：${text.slice(0, 400)}`)
          return { text: '' }
        },
        (text) => {
          const m = /任务 t\w+（dig）失败了：no_tool — (.*?) detail=(\{.*?\})(?: 已完成的部分|$)/m.exec(text)
          assert.ok(m, `被叫醒时看到 no_tool：${text.slice(0, 400)}`)
          const detail = JSON.parse(m[2]!)
          assert.equal(detail.block, 'minecraft:stone')
          return {
            toolCalls: [
              { name: 'withdraw_items', input: { container: B, items: [pick] } },
            ],
          }
        },
        { text: '' },
        (text) => {
          assert.match(text, /任务 t\w+（withdraw）完成了。 结果：\{"moved":1/, `镐取回来了：${text.slice(0, 300)}`)
          return { text: '镐拿回来了。' }
        },
      )
      try {
        await command(`把镐存进箱子 (${B.x},${B.y},${B.z})，然后去挖 (${stone.x},${stone.y},${stone.z}) 那块石头`)
        const dig = await taskEnd(mark, 'dig', 120_000)
        assert.equal(dig.state, 'failed', JSON.stringify(dig.result))
        assert.equal(dig.error?.code, 'no_tool')
        notes.push(`dig ${dig.id} 失败：${JSON.stringify(dig.error)}`)
        await botSaid(mark, /镐拿回来了/, 90_000)
        assert.equal((await game.worldBlock(stone)).id, 'minecraft:stone', '那块石头还在')
      } finally {
        // 不管成没成，镐必须回到背包里
        await sleep(300)
        if (!(await hasPick())) {
          await game.taskCancel(BOT).catch(() => {})
          await directTask({ type: 'withdraw', container: B, items: [pick] }).catch(() => {})
        }
      }
      assert.ok(await hasPick(), '结束时镐在背包里')
    })

    // ── 5b. 捡地上的东西 ──
    await scenario('collect_items：捡起几格外掉在地上的东西', async (notes) => {
      const here = (await game.botStatus(BOT)).block!
      const spot = { x: here.x + 4, y: here.y + 1, z: here.z + 1 }
      const before = totals((await game.botStatus(BOT)).inventory).get('minecraft:snowball') ?? 0
      // 用 RCON 在几格外放一个掉落物（5 个雪球，1.7.10 的物品数字 id 是 332）
      const summoned = await rcon(`summon Item ${spot.x} ${spot.y} ${spot.z} {Item:{id:332,Count:5,Damage:0}}`)
      assert.match(summoned.out, /summoned/i, `RCON summon：${summoned.out}`)
      await sleep(600)
      const lying = ((await game.worldEntities(spot, { radius: 6 })).entities ?? []).filter((e) => e.type === 'item')
      assert.ok(lying.length >= 1, '地上有掉落物')
      const expected = lying.filter((e) => e.item?.id === 'minecraft:snowball').reduce((n, e) => n + (e.item?.count ?? 0), 0)
      const mark = events.length
      script(
        { toolCalls: [{ name: 'look_around', input: { radius: 8 } }] },
        (text) => {
          assert.match(text, /\d+× dropped item minecraft:snowball/, `look_around 看得到地上的雪球：${text.slice(0, 400)}`)
          return { toolCalls: [{ name: 'collect_items', input: { x: spot.x, y: here.y, z: spot.z, radius: 6 } }] }
        },
        { text: '' },
        (text) => {
          assert.match(text, /任务 t\w+（collect）完成了。 结果：\{"pickedUpStacks":\d+/, `被叫醒时看到 collect 的结果：${text.slice(0, 300)}`)
          return { text: '地上的东西捡起来了。' }
        },
      )
      await command('把你旁边地上的东西捡起来')
      const task = await taskEnd(mark, 'collect', 60_000)
      assert.equal(task.state, 'done', JSON.stringify(task.error ?? task.result))
      await botSaid(mark, /捡起来了/)
      const left = ((await game.worldEntities(spot, { radius: 4 })).entities ?? []).filter((e) => e.type === 'item' && e.item?.id === 'minecraft:snowball')
      assert.equal(left.length, 0, '放下的雪球被捡走了')
      const after = totals((await game.botStatus(BOT)).inventory).get('minecraft:snowball') ?? 0
      assert.ok(after - before >= 5, `背包里的雪球至少多了放下的 5 个（${before} → ${after}）`)
      notes.push(`collect ${task.id}：${JSON.stringify(task.result)}；雪球 ${before} → ${after}（当时地上共有 ${expected} 个）`)
    })

    // ── 5c. 把东西送给别人（另一个 bot），然后传送回家 ──
    await scenario(`give_items：走到 ${OTHER} 面前把东西扔给它，再传送回家`, async (notes) => {
      const other = await game.botStatus(OTHER).catch(() => undefined)
      if (!other?.online) {
        throw new Skip(`${OTHER} 不在线`)
      }
      const before = totals((await game.botStatus(BOT)).inventory).get('minecraft:snowball') ?? 0
      assert.ok(before >= 3, '背包里有雪球可送')
      const from = (await game.botStatus(BOT)).block!
      const mark = events.length
      script(
        { toolCalls: [{ name: 'get_player_position', input: { player: OTHER } }] },
        (text) => {
          assert.match(text, new RegExp(`${OTHER} is in overworld \\(dim 0\\) at \\(-?\\d+,\\d+,-?\\d+\\)`), `get_player_position 的结果：${text.slice(0, 200)}`)
          return { toolCalls: [{ name: 'give_items', input: { player: OTHER, items: [{ id: 'minecraft:snowball', count: 3 }] } }] }
        },
        { text: '' },
        (text) => {
          assert.match(text, /任务 t\w+（give）完成了。 结果：\{"dropped":3/, `被叫醒时看到 give 的结果：${text.slice(0, 300)}`)
          return { toolCalls: [{ name: 'go_home', input: { name: HOME } }] }
        },
        { text: '' },
        (text) => {
          assert.match(text, /任务 t\w+（home）完成了/, `传送回家：${text.slice(0, 200)}`)
          return { text: '东西送到了，我回来了。' }
        },
      )
      await command(`给 ${OTHER} 送 3 个雪球，然后回家`)
      const give = await taskEnd(mark, 'give', 180_000)
      assert.equal(give.state, 'done', JSON.stringify(give.error ?? give.result))
      await botSaid(mark, /东西送到了/, 60_000)
      const after = totals((await game.botStatus(BOT)).inventory).get('minecraft:snowball') ?? 0
      assert.equal(before - after, 3, '背包里少了 3 个雪球')
      const dist = Math.hypot(from.x - (other.block?.x ?? 0), from.z - (other.block?.z ?? 0))
      const seconds = ((give.finishedAt ?? 0) - (give.startedAt ?? 0)) / 1000
      notes.push(`give ${give.id}：走了约 ${dist.toFixed(0)} 格，${seconds.toFixed(1)} 秒，结果 ${JSON.stringify(give.result)}；雪球 ${before} → ${after}`)
      const still = await game.botStatus(OTHER)
      const moved = JSON.stringify(still.block) !== JSON.stringify(other.block)
      notes.push(`${OTHER} ${moved ? `的位置变了：${JSON.stringify(other.block)} → ${JSON.stringify(still.block)}` : `没被挪动：还在 (${still.block?.x},${still.block?.y},${still.block?.z})`}，任务 ${still.task ? still.task.type : '无'}`)
      if (moved) findings.push(`give_items 之后 ${OTHER} 的位置变了：${JSON.stringify(other.block)} → ${JSON.stringify(still.block)}（可能是被走过去的 ${BOT} 挤开的）。`)
    })

    // ── 6. 自己取消任务：不该被“任务被取消”再叫醒一次 ──
    await scenario('cancel_task：跟随任务被它自己取消后，不会为“任务被取消”再叫醒模型', async (notes) => {
      let mark = events.length
      script({ toolCalls: [{ name: 'follow_player', input: { player: 'Nobody_Online' } }] }, { text: '' })
      await command('跟着 Nobody_Online')
      await until('follow 任务开始', () => eventsSince(mark).some((e) => e.event === 'task.update' && (e.data.task as TaskInfo).type === 'follow' && (e.data.task as TaskInfo).state === 'running'), 10_000)
      await idle()
      mark = events.length
      script(
        { toolCalls: [{ name: 'cancel_task', input: {} }] },
        (text) => {
          assert.match(text, /Canceled 1 task\(s\): t\w+\./, `cancel_task 的结果：${text.slice(0, 200)}`)
          return { text: '不跟了。' }
        },
      )
      await command('别跟了')
      await botSaid(mark, /不跟了/)
      const canceled = await taskEnd(mark, 'follow', 5000)
      assert.equal(canceled.state, 'canceled')
      notes.push(`follow ${canceled.id} 被取消；之后模型没有被再次叫醒（由本场结束时的“多余调用”检查保证）`)
    })

    // ── 7. 大脑重启续传：任务在大脑不在的时候结束，重启后照样被叫醒 ──
    await scenario('大脑重启续传：任务在大脑停着的时候结束，重启后靠补发的事件被叫醒', async (notes) => {
      const here = (await game.botStatus(BOT)).block!
      // 走到十几格外（往东南的下坡草地），够它走上几秒
      const target = { x: here.x + 12, z: here.z + 9 }
      const mark = events.length
      script({ toolCalls: [{ name: 'go_to', input: target }] }, { text: '' })
      await command(`走到 x=${target.x} z=${target.z}`)
      await until('goto 任务开始', () => eventsSince(mark).some((e) => e.event === 'task.update' && (e.data.task as TaskInfo).type === 'goto' && (e.data.task as TaskInfo).state === 'running'), 10_000)
      await idle()
      brain.child.kill('SIGTERM')
      assert.equal(await brain.exited, 0, '大脑正常退出')
      const task = await taskEnd(mark, 'goto', 90_000)
      notes.push(`大脑停着的时候 goto ${task.id} 结束了：${task.state} ${JSON.stringify(task.result ?? task.error)}`)
      const resume = JSON.parse(fs.readFileSync(path.join(dataDir, 'bridge-state.json'), 'utf8'))
      const endSeq = events.find((e) => e.event === 'task.update' && (e.data.task as TaskInfo).id === task.id && (e.data.task as TaskInfo).state === task.state)!.seq!
      assert.ok(resume.lastSeq < endSeq, `大脑落盘的位置（${resume.lastSeq}）在任务结束事件（${endSeq}）之前`)

      script(
        (text) => {
          assert.match(text, new RegExp(`任务 ${task.id}（goto）${task.state === 'done' ? '完成了' : '失败了'}`), `重启后被叫醒时看到任务结局：${text.slice(0, 300)}`)
          return { text: '我回来了，刚才那段路走完了。' }
        },
      )
      const mark2 = events.length
      brain = await startBrain(dataDir, password)
      await botSaid(mark2, /我回来了/, 30_000)
      assert.match(brain.output(), /resuming after seq \d+/, '重启后带着落盘的位置续传')
      notes.push(`重启后的握手：${/\[bridge\] connected.*$/m.exec(brain.output())?.[0] ?? ''}`)
    })

    // ── 8. 测试服重启（可选）──
    if (RESTART_SERVER) {
      await scenario('测试服重启：bot 自动上线，大脑自己重连，之后照常听指令', async (notes) => {
        // 重启前留一个不会自己结束的任务（跟着一个不在线的人会原地等）
        const m0 = events.length
        script({ toolCalls: [{ name: 'follow_player', input: { player: 'Nobody_Online' } }] }, { text: '' })
        await command('跟着 Nobody_Online')
        const started = await until('follow 任务开始', () => eventsSince(m0).find((e) => e.event === 'task.update' && (e.data.task as TaskInfo).type === 'follow' && (e.data.task as TaskInfo).state === 'running'), 10_000)
        const followId = (started.data.task as TaskInfo).id
        await idle()

        const epochBefore = (await brain.call('GET', '/overview')).bridge.hello.serverEpoch
        const spawnLogBefore = ((await brain.call('GET', '/log')).entries as { text: string }[]).filter((e) => /已经让它上线/.test(e.text)).length
        say('    正在重启测试服（tools/testserver restart），要等它完全起来…')
        const t0 = Date.now()
        const res = await run(path.join(REPO_ROOT, 'tools', 'testserver'), ['restart'], 600_000)
        assert.equal(res.code, 0, `tools/testserver restart：${res.out.slice(-300)}`)
        notes.push(`tools/testserver restart：${res.out.split('\n').slice(-2).join(' / ')}（共 ${((Date.now() - t0) / 1000).toFixed(0)} 秒）`)
        const ov = await until('大脑重连上新启动的服务器', async () => {
          const o = await brain.call('GET', '/overview')
          return o.bridge.state === 'connected' && o.bridge.hello.serverEpoch !== epochBefore ? o : undefined
        }, 60_000, 500)
        notes.push(`大脑重连：epoch ${epochBefore} → ${ov.bridge.hello.serverEpoch}`)
        await until(`${BOT} 自动上线`, async () => (await brain.call('GET', '/overview')).bot.status?.online === true, 30_000, 500)
        await until('脚本自己的连接也回来了', () => observer.isConnected(), 30_000)
        await sleep(1500)
        const log = (await brain.call('GET', '/log')).entries as { kind: string; text: string }[]
        const spawnLogAfter = log.filter((e) => /已经让它上线/.test(e.text)).length
        notes.push(spawnLogAfter > spawnLogBefore ? '它不是自己回来的：大脑发现它不在线后把它叫了出来' : 'bot 是自己回来的（mod 的行为），大脑没有重复 spawn')
        assert.ok(log.some((e) => e.kind === 'event' && /你上线了/.test(e.text)), '大脑收到了重启后的上线事件（靠补发）')

        // 重启前没做完的任务：身体自己从头重新开始，大脑不用（也没有）再启动一遍
        const tasks = await game.taskList(BOT)
        assert.equal(tasks.active?.id, followId, `重启后正在执行的还是那个任务：${JSON.stringify(tasks.active)}`)
        assert.equal(tasks.active?.state, 'running')
        assert.deepEqual((await brain.call('GET', '/overview')).agent.trackedTasks, [followId], '大脑还记着这个没结束的任务')
        notes.push(`重启前的 follow ${followId} 在重启后自己重新开始了`)
        // 主人在面板上取消它：模型不该为这个被叫醒（由本场结束时的“多余调用”检查保证）
        const m1 = events.length
        assert.deepEqual(await brain.call('POST', '/tasks/cancel', { id: followId }), { canceled: 1 })
        const canceled = await taskEnd(m1, 'follow', 5000)
        assert.equal(canceled.state, 'canceled')
        await sleep(800)

        const mark = events.length
        script({ toolCalls: [{ name: 'get_status', input: {} }] }, (text) => {
          assert.match(text, new RegExp(`${BOT}: online in overworld`))
          return { text: '服务器重启后我还在。' }
        })
        await command('服务器刚重启过，你还好吗')
        await botSaid(mark, /服务器重启后我还在/, 30_000)
      })
    }
  } finally {
    // 收尾：停大脑、停模拟模型、删掉临时的 home、断开观察连接；世界里留下的只有那一小块平地
    if (brain.child.exitCode === null) {
      brain.child.kill('SIGTERM')
      await Promise.race([brain.exited, sleep(5000)])
      if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    }
    await game.taskCancel(BOT).catch(() => {})
    await game.botCommand(BOT, `delhome ${HOME}`).catch(() => {})
    // 背包和箱子与开始时相比
    try {
      const diff = (a: Map<string, number>, b: Map<string, number>) =>
        [...new Set([...a.keys(), ...b.keys()])].filter((k) => (a.get(k) ?? 0) !== (b.get(k) ?? 0)).map((k) => `${k} ${a.get(k) ?? 0}→${b.get(k) ?? 0}`)
      const end = await game.botStatus(BOT)
      fixtureChanges.push(`${BOT} 的背包：${diff(startInventory, totals(end.inventory)).join('，') || '没有变化'}（现在在 ${JSON.stringify(end.block)}）`)
      for (const c of startChests) {
        const now = await chestAt(c)
        fixtureChanges.push(`箱子 (${c.x},${c.y},${c.z})：${diff(totals(c.items), totals(now?.items)).join('，') || '没有变化'}`)
      }
    } catch (e) {
      fixtureChanges.push(`没能比较背包和箱子：${e instanceof Error ? e.message : String(e)}`)
    }
    observer.stop()
    await llm.stop()
    await talkLlm.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }

  // ── 汇总 ──
  console.log('\n══ 联调结果 ══')
  for (const o of outcomes) {
    if (o.skipped) console.log(`– ${o.name}：跳过，没有验证（${o.skipped}）`)
    else console.log(`${o.ok ? '✔' : '✖'} ${o.name}（${o.seconds.toFixed(1)} 秒）${o.error ? `\n    ${o.error}` : ''}`)
  }
  const apis = new Map<string, number>()
  for (const r of llm.requests) apis.set(r.api, (apis.get(r.api) ?? 0) + 1)
  console.log(`模型调用：${llm.requests.length} 次（${[...apis.entries()].map(([k, v]) => `${k} ${v}`).join('，')}），全部发往本机的模拟模型服务`)
  console.log(
    summaryCalls > 0
      ? `其中 ${summaryCalls} 次是历史太长时写摘要（压缩阈值被这个脚本调低到了 12000）；压缩之后的场景见上面的结果`
      : '这一趟没有触发历史压缩',
  )
  // 模拟模型服务按真实接口的规矩检查每个请求（角色交替、工具调用和结果配对）；被它拒绝过就是大脑发出了不合规的请求
  if (llm.rejected.length > 0) {
    findings.push(`有 ${llm.rejected.length} 个请求的消息格式不合规，被模拟模型服务拒绝：${llm.rejected.slice(0, 3).map((r) => `${r.api} ${r.reason}`).join(' ‖ ')}`)
  }
  console.log(`请求格式：${llm.requests.length - llm.rejected.length}/${llm.requests.length} 个通过了模拟模型服务按真实接口规矩做的检查`)
  if (findings.length > 0) {
    console.log('\n需要留意：')
    for (const f of findings) console.log(`- ${f}`)
  }
  console.log('\n和开始时相比（挖出来的土石、送出去和捡回来的雪球会体现在这里）：')
  for (const f of fixtureChanges) console.log(`- ${f}`)
  const skipped = outcomes.filter((o) => o.skipped).length
  const failed = outcomes.filter((o) => !o.ok && !o.skipped).length
  const passed = outcomes.length - skipped - failed
  console.log(`\n${passed} 场通过，${failed} 场失败，${skipped} 场跳过（跳过的没有验证）。`)
  // 发出过不合规的请求也算没过：真实接口会直接拒绝。有跳过的也不算全过。
  return failed === 0 && skipped === 0 && llm.rejected.length === 0 ? 0 : 1
}

/**
 * 在 bot 东南方向的天然地形里找一小块（4×4）不平、没有树、没有带数据方块的地。
 * 多次运行会把这一片慢慢平掉；都平了就退回到第一块（那时 flatten 什么都不用挖，也算通过）。
 */
async function pickFlattenWindow(game: BridgeApi, bot: string): Promise<{ x1: number; z1: number; x2: number; z2: number; note: string }> {
  // bot 这时站在箱子旁边；它东南方向 16–39 格是一片下坡的天然地形（在测试服上就是 x -58..-35、z -67..-44）
  const me = (await game.botStatus(bot)).block!
  const region = { x1: me.x - 6, z1: me.z + 16, x2: me.x + 17, z2: me.z + 39 }
  const scan: ScanResult = await game.worldScan(region)
  const size = 4
  let best: { x1: number; z1: number; x2: number; z2: number; note: string; score: number } | undefined
  for (let zi = 0; zi + size <= scan.heights.length; zi++) {
    for (let xi = 0; xi + size <= scan.heights[0]!.length; xi++) {
      const cells: number[] = []
      for (let dz = 0; dz < size; dz++) for (let dx = 0; dx < size; dx++) cells.push(scan.heights[zi + dz]![xi + dx]!)
      const min = Math.min(...cells)
      const max = Math.max(...cells)
      const spread = max - min
      if (spread < 1 || spread > 3) continue // 完全平的没意思；落差大的多半有树或坑
      const x1 = scan.x1 + xi
      const z1 = scan.z1 + zi
      const dist = Math.hypot(x1 - me.x, z1 - me.z)
      // 优先选离它 8 格以外、但又最近的：之后要从那里传送回家，太近看不出传送
      const score = dist >= 8 ? dist : 1000 - dist
      if (!best || score < best.score) best = { x1, z1, x2: x1 + size - 1, z2: z1 + size - 1, note: `高度 ${min}..${max}，离它 ${dist.toFixed(0)} 格`, score }
    }
  }
  if (best) return best
  return { x1: region.x2 - 3, z1: region.z2 - 3, x2: region.x2, z2: region.z2, note: '这一片已经没有不平的小块了，用一块已经平的' }
}

/** bot 附近找一块露在地表的石头（顶上就是它，不用先挖别的才够得着）。 */
async function findSurfaceStone(game: BridgeApi, bot: string): Promise<{ x: number; y: number; z: number }> {
  const b = (await game.botStatus(bot)).block!
  const scan = await game.worldScan({ x1: b.x - 10, z1: b.z - 10, x2: b.x + 10, z2: b.z + 10 })
  const stone = scan.palette?.indexOf('minecraft:stone') ?? -1
  let best: { x: number; y: number; z: number; d: number } | undefined
  scan.heights.forEach((row, zi) => {
    row.forEach((y, xi) => {
      if (scan.tops?.[zi]?.[xi] !== stone) return
      const x = scan.x1 + xi
      const z = scan.z1 + zi
      const d = Math.hypot(x - b.x, z - b.z)
      // 不要它脚下那一块，也别离得太远、高差太大
      if (d < 2 || Math.abs(y - b.y) > 4) return
      if (!best || d < best.d) best = { x, y, z, d }
    })
  })
  if (!best) throw new Error('bot 附近 10 格内没有露在地表的石头')
  const found = best as { x: number; y: number; z: number }
  return { x: found.x, y: found.y, z: found.z }
}

/** bot 身边找一个脚下是实心方块的空气格（用来放一个它没有的方块）。由近到远找，同一高度和高低一格的都算。 */
async function findEmptySpot(game: BridgeApi, bot: string): Promise<{ x: number; y: number; z: number }> {
  const b = (await game.botStatus(bot)).block!
  const offsets: [number, number][] = []
  for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) if (Math.max(Math.abs(dx), Math.abs(dz)) >= 2) offsets.push([dx, dz])
  offsets.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]))
  for (const [dx, dz] of offsets) {
    for (const dy of [0, 1, -1]) {
      const at = { x: b.x + dx, y: b.y + dy, z: b.z + dz }
      const here = await game.worldBlock(at)
      if (!here.air) continue
      const below = await game.worldBlock({ ...at, y: at.y - 1 })
      const above = await game.worldBlock({ ...at, y: at.y + 1 })
      if (below.solid && !below.tileEntity && above.air) return at
    }
  }
  throw new Error('bot 身边 5 格内找不到可以放方块的空位')
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('联调脚本自己出错了：', e)
    process.exit(3)
  },
)
