// 对着测试服联调放方块和挖方块的两件事，走的是大脑的工具（place_blocks、use_item、run_program 里的 probe_block、dig_blocks），
// 和模型用的一样：
//   1. 意见簿 f16：室内一条一格宽的梯道，两边是墙，四级云杉木楼梯往南升上二楼。place_blocks 每格给 blockMeta 2（朝南升），
//      四级都是 /2，梯道里没有多出别的方块。（走上去是寻路的事，意见簿 f17：现在的寻路不会走楼梯的半格台阶，这里不测。）
//   2. 同一条里的另一半：拿着楼梯点地面的上表面，结果写明楼梯进的是上面那一格（以前只说“点的那一格还是石头”）；
//      拿着梯子点空地的上表面，结果写明没放进去、为什么（梯子要贴着墙）。
//   4. 意见簿 f24：空桶对水源右键没反应。地面里嵌着两格水源、一个一格深的坑。空桶对第一格水源用：身体看着水面右键，桶装满；
//      装满的水桶对着坑底用：水倒进坑里；空单元对第二格水源用：装成水单元。
//   3. 拍视频时的工具缺口：一格钢管道方块（gregtech:gt.blockcasings2 的 13），身上是铁镐和一把没有材料的扳手（0 级）。
//      probe_block 写明要的是 wrench 类、2 级，每件工具为什么不行；dig_blocks 以 no_tool 失败，消息里写着同样的事。
// 模拟模型服务按脚本回应干活线：每一步看了上一步的结果再定下一步，对话线只传话。大脑是真启动的进程（src/main.ts），
// 连这一份检出的测试服（live-brain.ts）。
//
//   node test/live-place.ts --at x,y,z [--transcript /tmp/place-model.txt]
//
// --at 是摆场景的地方（bot 站的那一格）：脚本先把以它为中心 13×6×13 的盒子清空、脚下那一层铺上石头，再摆梯道（x+2..x+4，
// z-4..z+3）、二楼（y+3，z+1..z+3）和钢管道方块（x-3, y, z+3），把 bot 传送到 --at，清空它的背包再给它要用的东西。
// 不要放在出生点保护的范围里。不属于 npm test；不使用任何真实的模型接口。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import { TESTSERVER_BRIDGE_PORT, TOKEN_FILE, lastTurnText, openRcon, say, sleep, stamp, startBrain, until } from './live-brain.ts'
import type { Step } from './live-brain.ts'
import { MockLlm, talkRelay } from './mock-llm.ts'
import type { MockReply, RecordedLlmRequest } from './mock-llm.ts'

const BOT = process.env.LIVE_BOT ?? 'Alu'
const PANEL_PORT = Number(process.env.LIVE_PANEL_PORT ?? 28775)
const LLM_PORT = Number(process.env.LIVE_LLM_PORT ?? 25622)
const ARGS = process.argv.slice(2)
const arg = (name: string) => (ARGS.includes(name) ? ARGS[ARGS.indexOf(name) + 1] : undefined)
const TRANSCRIPT = arg('--transcript')
const AT = (arg('--at') ?? process.env.LIVE_AT ?? '').split(',').map(Number)

const STAIRS = 'minecraft:spruce_stairs'
const CASING = 'gregtech:gt.blockcasings2'

async function main(): Promise<number> {
  if (AT.length !== 3 || AT.some((n) => !Number.isInteger(n))) throw new Error('给 --at x,y,z：摆场景的地方（bot 站的那一格）')
  const [cx, cy, cz] = AT as [number, number, number]
  /** 四级楼梯：往南（+z）一级一级升，最上一级和二楼平。 */
  const steps = [0, 1, 2, 3].map((i) => ({ x: cx + 3, y: cy + i, z: cz - 3 + i }))
  const casing = { x: cx - 3, y: cy, z: cz + 3 }
  const stairFloor = { x: cx - 1, y: cy - 1, z: cz - 3 }
  const ladderFloor = { x: cx - 3, y: cy - 1, z: cz - 3 }
  const pool = { x: cx - 5, y: cy - 1, z: cz - 5 }
  const pool2 = { x: cx - 5, y: cy - 1, z: cz - 1 }
  const pitFloor = { x: cx - 3, y: cy - 2, z: cz - 5 }

  const observer = new BridgeClient({
    address: () => ({ host: '127.0.0.1', port: TESTSERVER_BRIDGE_PORT }),
    token: () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(),
    clientName: 'live-place-driver',
    reconnectMinMs: 500,
    reconnectMaxMs: 3000,
  })
  observer.start()
  const game = new BridgeApi(observer)
  await until(`连上测试服的 bridge（127.0.0.1:${TESTSERVER_BRIDGE_PORT}）`, () => observer.isConnected(), 8000)

  // ── 模拟模型和大脑 ──
  const llm = new MockLlm()
  llm.fallback = (req) => (Array.isArray(req.body?.tools) && req.body.tools.length > 0 ? { text: '' } : { text: '（联调脚本的摘要）' })
  await llm.start(LLM_PORT)
  const talkLlm = new MockLlm()
  talkLlm.fallback = talkRelay()
  await talkLlm.start(LLM_PORT + 1)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplayer-live-place-'))
  fs.chmodSync(dataDir, 0o700)
  const brain = await startBrain(dataDir, undefined, PANEL_PORT)
  say(`大脑已启动，面板 ${brain.origin}，数据目录 ${dataDir}`)

  const problems: string[] = []
  let calls = 0
  if (TRANSCRIPT) fs.writeFileSync(TRANSCRIPT, `放方块和挖方块联调 ${new Date().toLocaleString('zh-CN')}\n`)
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
    if (!m) throw new Error(`${what}：结果里没有 ${re}；看到的是 ${text.slice(0, 1200)}`)
    return m
  }
  const call = (name: string, input: unknown): MockReply => ({ toolCalls: [{ name, input }] })
  const waiting = (note: string): MockReply => ({ text: note })
  const at = (p: { x: number; y: number; z: number }) => `\\(${p.x},${p.y},${p.z}\\)`

  llm.enqueue(
    // ── 1. 楼梯：每格朝南升 ──
    step(call('place_blocks', { blocks: steps.map((p) => ({ ...p, item: STAIRS, blockMeta: 2 })) })),
    step(waiting('在放楼梯。')),
    step((seen) => {
      expect(seen, /任务 \w+（place）完成了。/, '放楼梯的任务完成了')
      expect(seen, /"placed":4/, '四级都放了')
      expect(seen, /placed from: 4× minecraft:spruce_stairs/, '放的是云杉木楼梯')
      if (/skipped|cameOutDifferent/.test(seen)) throw new Error(`有跳过的或者朝向不对的：${seen.slice(0, 900)}`)
      return call('use_item', { id: STAIRS, on: stairFloor, side: 'up' })
    }),
    // ── 2. 拿着方块点一个面 ──
    step(waiting('点地面放一级楼梯。')),
    step((seen) => {
      expect(seen, new RegExp(`the cell on that face, ${at({ ...stairFloor, y: stairFloor.y + 1 })}, where a block from the hand goes, was [^;]*\\[minecraft:air/0\\], now [^;]*\\[minecraft:spruce_stairs/\\d+\\]`), '写明楼梯进了上面那一格')
      return call('use_item', { id: 'minecraft:ladder', on: ladderFloor, side: 'up' })
    }),
    step(waiting('点空地放梯子。')),
    step((seen) => {
      expect(seen, new RegExp(`the cell on that face, ${at({ ...ladderFloor, y: ladderFloor.y + 1 })}, where a block from the hand goes, is still [^;]*\\[minecraft:air/0\\]; the block in your hand did not go in: the block's own rule says it cannot stand`), '写明梯子没放进去、为什么')
      return call('run_program', { code: `return (await tool('probe_block', { x: ${casing.x}, y: ${casing.y}, z: ${casing.z} })).text` })
    }),
    // ── 3. 钢管道方块要什么工具 ──
    step((seen) => {
      expect(seen, /It needs a tool of class "wrench" at level 2 or higher \(what the block itself names\)\./, 'probe 写明要扳手 2 级')
      expect(seen, /minecraft:iron_pickaxe:0 \(a tool of class pickaxe \d+\) cannot harvest it: not a "wrench"/, '铁镐不是扳手')
      expect(seen, /gregtech:gt\.metatool\.01:16 cannot harvest it: as a "wrench" it is level 0, 2 needed/, '扳手等级不够')
      return call('dig_blocks', { blocks: [casing] })
    }),
    step(waiting('试着挖。')),
    step((seen) => {
      expect(seen, /任务 \w+（dig）失败了：no_tool — no carried tool can harvest gregtech:gt\.blockcasings2\/13: it needs tool class "wrench" of level 2 or higher; your tools: [^\n]*gregtech:gt\.metatool\.01:16 level 0, too low/, 'no_tool 的消息写着要什么、身上的为什么不行')
      return call('use_item', { id: 'minecraft:bucket', on: pool })
    }),
    // ── 4. 水 ──
    step(waiting('拿空桶装水。')),
    step((seen) => {
      expect(seen, /you looked at the up face of the [^;]* \(a source block\) and right-clicked/, '看着水面右键')
      expect(seen, /gained: 1× minecraft:water_bucket/, '桶装满了')
      return call('use_item', { id: 'minecraft:water_bucket', on: pitFloor, side: 'up' })
    }),
    step(waiting('把水倒进坑里。')),
    step((seen) => {
      expect(seen, new RegExp(`the cell on that face, ${at({ ...pitFloor, y: pitFloor.y + 1 })}, where a block from the hand goes, was [^;]*\\[minecraft:air/0\\], now [^;]*\\[minecraft:(flowing_)?water/0\\]`), '水倒进了坑里')
      expect(seen, /gained: 1× minecraft:bucket/, '水桶变回空桶')
      return call('use_item', { id: 'IC2:itemCellEmpty', meta: 0, on: pool2 })
    }),
    step(waiting('拿空单元装水。')),
    step((seen) => {
      expect(seen, /gained: 1× IC2:itemCellEmpty\/1/, '装成了水单元')
      return { text: '楼梯四级都朝南放好了；钢管道方块要 2 级以上的扳手，我身上的扳手是 0 级的；桶和单元都装上了水。' }
    }),
  )
  const scripted = llm.remaining

  let code = 0
  try {
    const work = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: '模拟（干活线脚本）', baseUrl: llm.anthropicBaseUrl, apiKey: 'sk-ant-live-fake-place', model: 'scripted-work' })
    await brain.call('POST', '/models/use', { providerId: work.provider.id, modelId: work.provider.models[0].id, line: 'work' })
    const talk = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: '对话线（只传话）', baseUrl: talkLlm.anthropicBaseUrl, apiKey: 'sk-ant-live-fake-talk', model: 'talk-relay' })
    await brain.call('POST', '/models/use', { providerId: talk.provider.id, modelId: talk.provider.models[0].id, line: 'talk' })
    await until('大脑连上测试服', async () => (await brain.call('GET', '/overview')).bridge.state === 'connected', 10_000)
    await brain.call('POST', '/bot/spawn', {})
    await until(`${BOT} 在线`, async () => (await game.botStatus(BOT)).online === true, 15_000)
    await game.taskCancel(BOT)
    await game.screenClose(BOT).catch(() => undefined)

    // ── 场景：一条 rcon 连接，一条接一条 ──
    const rcon = await openRcon()
    const set = (x: number, y: number, z: number, block: string, meta = 0) => rcon.send(`setblock ${x} ${y} ${z} ${block} ${meta} replace`)
    try {
      for (let y = cy - 1; y <= cy + 5; y++) for (let x = cx - 6; x <= cx + 6; x++) for (let z = cz - 6; z <= cz + 6; z++) await set(x, y, z, y === cy - 1 ? 'minecraft:stone' : 'minecraft:air')
      for (const wx of [cx + 2, cx + 4]) for (let z = cz - 4; z <= cz + 3; z++) for (let y = cy; y <= cy + 4; y++) await set(wx, y, z, 'minecraft:stone')
      for (let z = cz + 1; z <= cz + 3; z++) await set(cx + 3, cy + 3, z, 'minecraft:stone')
      for (const w of [pool, pool2]) await set(w.x, w.y, w.z, 'minecraft:water')
      await set(pitFloor.x, pitFloor.y, pitFloor.z, 'minecraft:stone')
      await set(pitFloor.x, pitFloor.y + 1, pitFloor.z, 'minecraft:air')
      const placed = await set(casing.x, casing.y, casing.z, CASING, 13)
      if (!/placed/i.test(placed)) throw new Error(`摆钢管道方块：${placed}`)
      say(await rcon.send(`tp ${BOT} ${cx} ${cy} ${cz}`))
      await rcon.send(`clear ${BOT}`)
      for (const give of [`${STAIRS} 8 0`, 'minecraft:ladder 2 0', 'minecraft:iron_pickaxe 1 0', 'gregtech:gt.metatool.01 1 16', 'minecraft:bucket 1 0', 'IC2:itemCellEmpty 1 0']) say(await rcon.send(`give ${BOT} ${give}`))
    } finally {
      rcon.close()
    }
    await sleep(1000)

    say('面板上对它说：在梯道里放四级朝南升的楼梯上二楼，再看看那块钢管道方块拆不拆得动')
    await brain.call('POST', '/command', { text: '在东边那条梯道里放四级往南升的云杉木楼梯通到二楼；再试试放楼梯和梯子；再看看那块钢管道方块拆不拆得动；最后拿桶和空单元装点水。' })
    await until('脚本用完、大脑空闲', async () => {
      if (problems.length > 0) return true
      if (llm.remaining !== 0) return false
      const o = await brain.call('GET', '/overview')
      return o.agent.busy === false && o.agent.pending === 0 && o.talk.busy === false && o.talk.pending === 0
    }, 300_000, 500)
    await sleep(1000)
    if (problems.length > 0) throw new Error(problems.join(' ‖ '))

    // ── 世界里看一遍 ──
    const metas: string[] = []
    for (const p of steps) {
      const b = await game.worldBlock(p)
      metas.push(`${b.id}/${b.meta}`)
    }
    say(`四级楼梯：${metas.join(', ')}`)
    if (metas.some((m) => m !== `${STAIRS}/2`)) throw new Error('楼梯不是都朝南升（/2）')
    // 梯道里除了四级楼梯什么都没有：没有垫脚的方块
    for (let z = cz - 4; z <= cz; z++) {
      for (let y = cy; y <= cy + 3; y++) {
        const b = await game.worldBlock({ x: cx + 3, y, z })
        const stair = steps.some((p) => p.y === y && p.z === z)
        if (!stair && b.air !== true) throw new Error(`梯道里多了方块：(${cx + 3},${y},${z}) ${b.id}`)
      }
    }
    const status = await game.botStatus(BOT)
    say(`${BOT} 现在在 ${JSON.stringify(status.block)}`)
    const pit = await game.worldBlock({ ...pitFloor, y: pitFloor.y + 1 })
    say(`坑里：${pit.id}/${pit.meta}`)
    if (pit.id !== 'minecraft:water' && pit.id !== 'minecraft:flowing_water') throw new Error('坑里没有水')
    const casingNow = await game.worldBlock(casing)
    if (casingNow.id !== CASING) throw new Error('钢管道方块不见了')
    say(`✔ 走完了：干活线调了 ${calls} 次模型（脚本 ${scripted} 步）`)
  } catch (e) {
    code = 1
    say(`✖ ${e instanceof Error ? e.message : String(e)}`)
    const log = await brain.call('GET', '/log').catch(() => ({ entries: [] }))
    for (const entry of (log.entries as { kind: string; who?: string; text: string }[]).slice(-16)) say(`  | ${entry.kind} ${entry.who ?? ''} ${entry.text.slice(0, 240)}`)
  } finally {
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
