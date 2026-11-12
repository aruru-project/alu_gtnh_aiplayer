// 对着测试服联调意见簿 f22 那件事：直升机背包灌上柴油、穿上、开机、升到离地约 10 格、悬停几秒、往前飞一段、降落、关机——
// 走的是大脑的工具（open_screen、click_slot、use_control、press_key、hold_keys、get_status），和模型用的一样。
// 模拟模型服务按脚本回应干活线：每一步看了上一步的结果再定下一步（槽位号、现在的高度、离地多高都是从结果里读出来的），
// 对话线只传话。大脑是真启动的进程（src/main.ts），连这一份检出的测试服（live-brain.ts）。
// 全程用一条自己的 bridge 连接每 0.25 秒记一次 bot.status：位置、着没着地、离地多高、上一刻的移动、背上那件的状态和油量。
//
//   node test/live-wear.ts [--log /tmp/flight.log] [--transcript /tmp/flight-model.txt]
//
// 前提：测试服在运行，bot Alu 在线。背上穿着东西的话先卸下来。用 rcon 给它一个直升机背包（和 GTNH 的配方做出来的一样带着
// wearableData）和 16 个柴油单元。飞的方向挑一个 40 格内地面不比它高 4 格以上的。结束时直升机背包还穿在它背上（关着）。
// 不属于 npm test；不使用任何真实的模型接口。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import type { BotStatus } from '../src/bridge/protocol.ts'
import { TESTSERVER_BRIDGE_PORT, TOKEN_FILE, lastTurnText, rcon, say, sleep, stamp, startBrain, until } from './live-brain.ts'
import type { Step } from './live-brain.ts'
import { MockLlm, talkRelay } from './mock-llm.ts'
import type { MockReply, RecordedLlmRequest } from './mock-llm.ts'

const BOT = process.env.LIVE_BOT ?? 'Alu'
const COPTER = 'adventurebackpack:copterPack'
const DIESEL = 'gregtech:gt.metaitem.01/30708'
const ACTION = 'keys.adventureBackpack.toggleActions'
const OPEN = 'keys.adventureBackpack.openInventory'
/** 这台机器上几份检出、几个服务同时在跑：面板和两个模拟模型各用固定的端口（只听 127.0.0.1），可以用环境变量换。 */
const PANEL_PORT = Number(process.env.LIVE_PANEL_PORT ?? 28771)
const LLM_PORT = Number(process.env.LIVE_LLM_PORT ?? 25610)
const ARGS = process.argv.slice(2)
const arg = (name: string) => (ARGS.includes(name) ? ARGS[ARGS.indexOf(name) + 1] : undefined)
const LOG = arg('--log')
const TRANSCRIPT = arg('--transcript')

/** 一行状态：时间、位置、着地、离地多高、上一刻的移动、背上那件的 status 和罐。 */
function statusLine(s: BotStatus): string {
  const w = s.worn?.[0]
  const status = (w?.data as { wearableData?: { status?: number } } | undefined)?.wearableData?.status
  const tank = w?.tanks?.[0]
  const p = s.pos
  const m = s.motion
  const r = (v: number | undefined) => (typeof v === 'number' ? v.toFixed(2) : '?')
  return `pos=(${r(p?.x)}, ${r(p?.y)}, ${r(p?.z)}) onGround=${String(s.onGround)} aboveGround=${r(s.aboveGround)} moved=(${r(m?.x)}, ${r(m?.y)}, ${r(m?.z)}) worn=${w ? `${w.id} status=${String(status)} fuel=${String(tank?.amount ?? 0)}/${String(tank?.capacity ?? '?')}` : 'nothing'}`
}

async function main(): Promise<number> {
  const observer = new BridgeClient({
    address: () => ({ host: '127.0.0.1', port: TESTSERVER_BRIDGE_PORT }),
    token: () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(),
    clientName: 'live-wear-driver',
    reconnectMinMs: 500,
    reconnectMaxMs: 3000,
  })
  observer.start()
  const game = new BridgeApi(observer)
  await until(`连上测试服的 bridge（127.0.0.1:${TESTSERVER_BRIDGE_PORT}）`, () => observer.isConnected(), 8000)
  let status = await game.botStatus(BOT)
  if (!status.online) throw new Error(`${BOT} 不在线`)
  await game.taskCancel(BOT)

  // ── 夹具：背上空着，身上一个直升机背包、16 个柴油单元 ──
  if ((status.worn ?? []).length > 0) {
    say(`${BOT} 背上穿着 ${status.worn![0]!.id}，先卸下来`)
    await game.screenClose(BOT)
    await game.botKey(BOT, OPEN)
    await game.screenPress(BOT, { key: 'unequip' })
    await sleep(600)
  }
  await rcon(`clear ${BOT} ${COPTER}`)
  await rcon(`clear ${BOT} gregtech:gt.metaitem.01 30708`)
  await rcon(`clear ${BOT} IC2:itemCellEmpty`)
  say((await rcon(`give ${BOT} ${COPTER} 1 0 {wearableData:{fuelTank:{Empty:""}}}`)).out)
  say((await rcon(`give ${BOT} gregtech:gt.metaitem.01 16 30708`)).out)
  status = await game.botStatus(BOT)

  // ── 往哪飞：四个方向里挑一个，40 格内的地面不比脚高 4 格以上 ──
  const b = status.block!
  const directions = [
    { name: '西', dx: -1, dz: 0 },
    { name: '东', dx: 1, dz: 0 },
    { name: '北', dx: 0, dz: -1 },
    { name: '南', dx: 0, dz: 1 },
  ]
  // 每个方向一条 40 格长、3 格宽的带子（身体一次最多看 64×64 列）
  const ways = []
  for (const d of directions) {
    const far = { x: b.x + d.dx * 40 + d.dz, z: b.z + d.dz * 40 + d.dx }
    const scan = await game.worldScan({ x1: b.x + d.dx - d.dz, z1: b.z + d.dz - d.dx, x2: far.x, z2: far.z })
    ways.push({ ...d, highest: Math.max(...scan.heights.flat()) })
  }
  const way = ways.sort((p, q) => p.highest - q.highest)[0]!
  if (way.highest > b.y + 4) throw new Error(`四个方向 40 格内都有比 ${BOT} 高 4 格以上的地面（最低的是往${way.name}，${way.highest}）`)
  const target = { x: b.x + way.dx * 30, z: b.z + way.dz * 30 }
  say(`${BOT} 在 (${b.x},${b.y},${b.z})；往${way.name}飞，目标 (${target.x}, ${target.z})，路上地面最高 ${way.highest}`)

  // ── 模拟模型和大脑 ──
  const llm = new MockLlm()
  llm.fallback = (req) => (Array.isArray(req.body?.tools) && req.body.tools.length > 0 ? { text: '' } : { text: '（联调脚本的摘要）' })
  await llm.start(LLM_PORT)
  const talkLlm = new MockLlm()
  talkLlm.fallback = talkRelay()
  await talkLlm.start(LLM_PORT + 1)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplayer-live-wear-'))
  fs.chmodSync(dataDir, 0o700)
  const brain = await startBrain(dataDir, undefined, PANEL_PORT)
  say(`大脑已启动，面板 ${brain.origin}，数据目录 ${dataDir}`)

  const problems: string[] = []
  let calls = 0
  if (TRANSCRIPT) fs.writeFileSync(TRANSCRIPT, `直升机背包联调 ${new Date().toLocaleString('zh-CN')}\n`)
  /** 干活线的一步：看了它最后看到的内容再回应；内容和预期不符时记下来，回一个空文本结束这一轮。 */
  const step = (s: Step) => (req: RecordedLlmRequest): MockReply => {
    const seen = lastTurnText(req)
    let reply: MockReply
    try {
      reply = typeof s === 'function' ? s(seen, req) : s
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e))
      reply = { text: '' }
    }
    calls++
    if (TRANSCRIPT) {
      const did = [reply.text ? `文本：${reply.text}` : '', ...(reply.toolCalls ?? []).map((c) => `调用 ${c.name} ${JSON.stringify(c.input ?? {})}`)].filter(Boolean)
      fs.appendFileSync(TRANSCRIPT, `\n━━━ 干活线第 ${calls} 次（${stamp()}）━━━\n【它看到的（最后一条）】\n${seen}\n【它的回应】\n${did.join('\n') || '（空文本，这一轮结束）'}\n`)
    }
    return reply
  }
  const expect = (text: string, re: RegExp, what: string): RegExpExecArray => {
    const m = re.exec(text)
    if (!m) throw new Error(`${what}：结果里没有 ${re}；看到的是 ${text.slice(0, 600)}`)
    return m
  }
  const call = (name: string, input: unknown): MockReply => ({ toolCalls: [{ name, input }] })
  const waitTask = (note: string): MockReply => ({ text: note })

  let y0 = 0
  let ground = 0
  llm.enqueue(
    step(call('read_manual', { name: 'wear' })),
    step((seen) => (expect(seen, /# 飞（直升机背包）/, '读到 wear 手册'), call('open_screen', { item: { id: COPTER } }))),
    step((seen) => {
      const slot = expect(seen, new RegExp(`- slot (\\d+): 16× .*\\[${DIESEL}\\]`), '身上 16 个柴油单元在哪一格')[1]
      expect(seen, /takes only some things; of what you carry: .*\[gregtech:gt\.metaitem\.01\/30708\]/, '燃料格写着收柴油单元')
      expect(seen, /- equip \[button\]: "Shoulder Copter Pack"/, '界面上有 equip 按钮')
      return call('click_slot', { slot: Number(slot), shift: true })
    }),
    step((seen) => {
      const slot = expect(seen.split('Your own inventory')[0]!, /- slot (\d+): 16× .*\[IC2:itemCellEmpty\]/, '空单元落在哪一格')[1]
      return call('click_slot', { slot: Number(slot), shift: true })
    }),
    step(call('use_control', { key: 'equip' })),
    step((seen) => (expect(seen, /on your back: .*\[adventurebackpack:copterPack\]; tank: 16000 of 16000 mB/, '背上穿着灌满的直升机背包'), call('press_key', { key: ACTION, sneak: true }))),
    step((seen) => (expect(seen, /wearableData\.status 0 → 1/, '开机'), call('press_key', { key: ACTION }))),
    step((seen) => (expect(seen, /wearableData\.status 1 → 2/, '切到悬停'), call('get_status', {}))),
    step((seen) => {
      y0 = Number(expect(seen, /at block \(-?\d+,(\d+),-?\d+\)/, '现在的高度')[1])
      return call('hold_keys', { seconds: 15, jump: true, above: 10 })
    }),
    step(waitTask('在往上升。')),
    step((seen) => {
      expect(seen, /held jump for [\d.]+ s \(\d+ ticks\), let go because your height above the ground reached the one given/, '升到了离地 10 格')
      return call('hold_keys', { seconds: 3 })
    }),
    step(waitTask('悬停三秒。')),
    step((seen) => {
      expect(seen, /in the air, ([\d.]+) blocks above the ground, not moving/, '悬停时不动')
      return call('hold_keys', { seconds: 15, toward: target, range: 8 })
    }),
    step(waitTask('往前飞。')),
    step((seen) => {
      expect(seen, /let go because you came within range of the point/, '飞到了目标附近')
      return call('hold_keys', { seconds: 20, sneak: true, above: 0 })
    }),
    step(waitTask('往下降。')),
    step((seen) => {
      ground = Number(expect(seen, /now at \(-?[\d.]+, ([\d.]+), -?[\d.]+\): on the ground/, '落地了')[1])
      return call('press_key', { key: ACTION, sneak: true })
    }),
    step((seen) => (expect(seen, /wearableData\.status 2 → 0/, '关机'), { text: '直升机背包灌满了柴油、穿上了；升到离地 10 格、悬停 3 秒、往前飞了一段、落地关机了。' })),
  )
  const scripted = llm.remaining

  // ── 记录：每 0.25 秒一次状态 ──
  const samples: string[] = []
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      try {
        samples.push(`${stamp()}.${String(Date.now() % 1000).padStart(3, '0')} ${statusLine(await game.botStatus(BOT))}`)
      } catch (e) {
        samples.push(`${stamp()} (status failed: ${String(e)})`)
      }
      await sleep(250)
    }
  })()

  let code = 0
  try {
    const work = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: '模拟（干活线脚本）', baseUrl: llm.anthropicBaseUrl, apiKey: 'sk-ant-live-fake-wear', model: 'scripted-work' })
    await brain.call('POST', '/models/use', { providerId: work.provider.id, modelId: work.provider.models[0].id, line: 'work' })
    const talk = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: '对话线（只传话）', baseUrl: talkLlm.anthropicBaseUrl, apiKey: 'sk-ant-live-fake-talk', model: 'talk-relay' })
    await brain.call('POST', '/models/use', { providerId: talk.provider.id, modelId: talk.provider.models[0].id, line: 'talk' })
    await until('大脑连上测试服', async () => (await brain.call('GET', '/overview')).bridge.state === 'connected', 10_000)
    await brain.call('POST', '/bot/spawn', {})
    say('面板上对它说：给直升机背包灌满柴油，穿上，飞起来')
    await brain.call('POST', '/command', { text: '给直升机背包灌满柴油，穿上，开机，升到离地十格左右，悬停几秒，往前飞一段，再降落、关机。' })
    await until('脚本用完、大脑空闲', async () => {
      if (problems.length > 0) return true
      if (llm.remaining !== 0) return false
      const o = await brain.call('GET', '/overview')
      return o.agent.busy === false && o.agent.pending === 0 && o.talk.busy === false && o.talk.pending === 0
    }, 240_000, 500)
    await sleep(1500)
    if (problems.length > 0) throw new Error(problems.join(' ‖ '))
    say(`✔ 走完了：干活线调了 ${calls} 次模型（脚本 ${scripted} 步），从 y ${y0} 起飞、落地 y ${ground}`)
  } catch (e) {
    code = 1
    say(`✖ ${e instanceof Error ? e.message : String(e)}`)
    const log = await brain.call('GET', '/log').catch(() => ({ entries: [] }))
    for (const entry of (log.entries as { kind: string; who?: string; text: string }[]).slice(-16)) say(`  | ${entry.kind} ${entry.who ?? ''} ${entry.text.slice(0, 240)}`)
  } finally {
    sampling = false
    await sampler
    if (LOG) fs.writeFileSync(LOG, `${samples.join('\n')}\n`)
    say(`状态记录 ${samples.length} 行${LOG ? `，写在 ${LOG}` : ''}；最后一行：${samples.at(-1) ?? ''}`)
    brain.child.kill('SIGTERM')
    await brain.exited
    await llm.stop()
    await talkLlm.stop()
    observer.stop()
  }
  return code
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('联调脚本自己出错了：', e)
    process.exit(3)
  },
)
