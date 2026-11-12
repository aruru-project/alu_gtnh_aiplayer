// 对着测试服联调意见簿里身体的三件事，走的是大脑的工具（process_items、withdraw_items、fill_area、open_screen、click_slot），
// 和模型用的一样：
//   1. 压缩机的物品自动输出开着、输出面朝下、下面是一个输入总线：54 个钢锭进去，任务是“完成”，结果里写着跑了 6 轮、做了 6 个钢块、
//      一个没取回、6 个在下面的总线里、自动输出朝下；照结果去总线里取回来。
//   2. 身上先放着 10 个钢管道方块（gregtech:gt.blockcasings2 的 13）、再放 8 个坚固钢机械方块（0），fill_area 不给 meta 填 18 格：
//      只放了 8 个 0，以 no_material（缺的是 :0）停下，结果写着是从哪种物品放的；世界里那一排只有 meta 0。
//   3. 部件加工台：照意见簿里那样把绑定结模具放进格 2、木板放进格 3，产物格是空的；这时界面写着 0、1 两格是 SlotPattern、
//      只收模具一类（不再说成产物格），最后一行写着格子一行行怎么排。照那一行重放：模具进 0、木板进 2，产物格出木绑定结，取出来。
// 模拟模型服务按脚本回应干活线：每一步看了上一步的结果再定下一步（格子编号从结果里读），对话线只传话。大脑是真启动的进程（src/main.ts），
// 连这一份检出的测试服（live-brain.ts）。
//
//   node test/live-tasks.ts --at x,y,z [--transcript /tmp/tasks-model.txt]
//
// --at 是摆场景的地方（bot 站的那一格，脚下要是实地）：脚本先把以它为中心 11×3×7 的盒子清空、脚下那一层铺上石头，
// 再用 rcon 摆上压缩机和下面的输入总线（x+2）、部件加工台（x-2）、要填的那一排（z+3，x-4..x+4，两层高），把 bot 传送到 --at，
// 清空它的背包再给它要用的东西。不要放在出生点保护的范围里（那里不是 op 的玩家点不开方块）。
// 不属于 npm test；不使用任何真实的模型接口。

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
const PANEL_PORT = Number(process.env.LIVE_PANEL_PORT ?? 28772)
const LLM_PORT = Number(process.env.LIVE_LLM_PORT ?? 25612)
const ARGS = process.argv.slice(2)
const arg = (name: string) => (ARGS.includes(name) ? ARGS[ARGS.indexOf(name) + 1] : undefined)
const TRANSCRIPT = arg('--transcript')
const AT = (arg('--at') ?? process.env.LIVE_AT ?? '').split(',').map(Number)

const INGOT = { id: 'gregtech:gt.metaitem.01', meta: 11305 }
const BLOCK = { id: 'gregtech:gt.blockmetal6', meta: 13 }
const CASING = 'gregtech:gt.blockcasings2'
const PATTERN = 'TConstruct:woodPattern'

async function main(): Promise<number> {
  if (AT.length !== 3 || AT.some((n) => !Number.isInteger(n))) throw new Error('给 --at x,y,z：摆场景的地方（bot 站的那一格）')
  const [cx, cy, cz] = AT as [number, number, number]
  const compressor = { x: cx + 2, y: cy + 1, z: cz }
  const bus = { x: cx + 2, y: cy, z: cz }
  const partBuilder = { x: cx - 2, y: cy, z: cz }
  const row = { x1: cx - 4, y1: cy, z1: cz + 3, x2: cx + 4, y2: cy + 1, z2: cz + 3 }

  const observer = new BridgeClient({
    address: () => ({ host: '127.0.0.1', port: TESTSERVER_BRIDGE_PORT }),
    token: () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(),
    clientName: 'live-tasks-driver',
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplayer-live-tasks-'))
  fs.chmodSync(dataDir, 0o700)
  const brain = await startBrain(dataDir, undefined, PANEL_PORT)
  say(`大脑已启动，面板 ${brain.origin}，数据目录 ${dataDir}`)

  const problems: string[] = []
  let calls = 0
  if (TRANSCRIPT) fs.writeFileSync(TRANSCRIPT, `身体三件事联调 ${new Date().toLocaleString('zh-CN')}\n`)
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
    if (!m) throw new Error(`${what}：结果里没有 ${re}；看到的是 ${text.slice(0, 900)}`)
    return m
  }
  const call = (name: string, input: unknown): MockReply => ({ toolCalls: [{ name, input }] })
  const waiting = (note: string): MockReply => ({ text: note })
  /** 界面里自己背包那一段：某样东西在哪一格。 */
  const mySlot = (seen: string, id: string, what: string): number => Number(expect(seen.split('Your own inventory')[1] ?? '', new RegExp(`- slot (\\d+): \\d+× [^\\n]*\\[${id.replace(/[.:/]/g, (c) => `\\${c}`)}`), what)[1])
  const its = (seen: string): string => seen.split('Your own inventory')[0]!

  llm.enqueue(
    // ── 1. 压缩机 ──
    step(call('process_items', { machine: compressor, inputs: [{ ...INGOT, count: 54 }] })),
    step(waiting('压缩机在转。')),
    step((seen) => {
      expect(seen, /任务 \w+（process）完成了。/, '加工算做成（不是失败）')
      expect(seen, /it finished 6 round\(s\) of a recipe, making 6× gregtech:gt\.blockmetal6\/13/, '跑了 6 轮、做了 6 个钢块')
      expect(seen, /took out: nothing/, '一个没取回')
      expect(seen, new RegExp(`is now in: 6× gregtech:gt\\.blockmetal6/13 [^;]*at \\(${bus.x},${bus.y},${bus.z}\\), against the down face of the machine`), '6 个钢块在下面的输入总线里')
      expect(seen, /AUTO-OUTPUT of items on: what it makes leaves by its down face/, '自动输出朝下')
      return call('withdraw_items', { container: bus, items: [{ ...BLOCK, count: 6 }] })
    }),
    step(waiting('去总线里取。')),
    step((seen) => {
      expect(seen, /任务 \w+（withdraw）完成了。 结果：\{"moved":6\}/, '从总线取回 6 个')
      return call('fill_area', { ...row, item: CASING })
    }),
    // ── 2. 填一排机械方块，不给 meta ──
    step(waiting('在砌那一排。')),
    step((seen) => {
      expect(seen, /任务 \w+（fill）失败了：no_material — out of gregtech:gt\.blockcasings2:0; 10 more needed/, '只认 meta 0，用完就停')
      expect(seen, /placed from: 8× gregtech:gt\.blockcasings2 "[^"]+"\n/, '结果写着放的是 8 个 meta 0')
      return call('open_screen', { at: partBuilder })
    }),
    // ── 3. 部件加工台：先照意见簿里那样放 ──
    step((seen) => {
      expect(seen, /Screen "PartCrafterContainer" is open/, '打开了部件加工台')
      expect(seen, /- slots 0–1 \[SlotPattern\] \(takes only some things; of what you carry: [^)]*\[TConstruct:woodPattern\/9\]\): empty \(2\)/, '0、1 两格只收模具，写着身上的模具')
      return call('click_slot', { slot: mySlot(seen, PATTERN, '身上的模具在哪一格') })
    }),
    step(call('click_slot', { slot: 2 })),
    step((seen) => call('click_slot', { slot: mySlot(seen, 'minecraft:planks', '身上的木板在哪一格') })),
    step(call('click_slot', { slot: 3 })),
    step((seen) => {
      const mine = its(seen)
      expect(mine, /- slots 0–1 \[SlotPattern\] \(takes only some things; of what you carry: none; it takes e\.g\. [^)]*\): empty \(2\)/, '模具不在身上时 0、1 两格仍是只收模具的格子（以前说成产物格）')
      expect(mine, /- slot 2: 1× [^\n]*\[TConstruct:woodPattern\/9\]/, '模具在格 2')
      expect(mine, /- slot 4 \[SlotOnlyTake\] \(OUTPUT: products appear here, nothing can be put in\): empty/, '产物格是空的')
      expect(mine, /Where the screen draws them [^\n]*: y 27: 0 \(x 40\), 2 \(x 58\), 4–5 \(x 102–120\); y 45: 1 \(x 40\), 3 \(x 58\), 6–7 \(x 102–120\)/, '格子一行行怎么排')
      return call('click_slot', { slot: 2, shift: true })
    }),
    step(call('click_slot', { slot: 3, shift: true })),
    // ── 照那一行重放：模具进 0、木板进 2 ──
    step((seen) => call('click_slot', { slot: mySlot(seen, PATTERN, '模具回到身上') })),
    step(call('click_slot', { slot: 0 })),
    step((seen) => call('click_slot', { slot: mySlot(seen, 'minecraft:planks', '木板回到身上') })),
    step(call('click_slot', { slot: 2 })),
    step((seen) => {
      expect(its(seen), /- slot 4 \[SlotOnlyTake\] \(OUTPUT: products appear here, nothing can be put in\): 1× [^\n]*\[TConstruct:binding\]/, '产物格出了木绑定结')
      return call('click_slot', { slot: 4, shift: true })
    }),
    step((seen) => {
      mySlot(seen, 'TConstruct:binding', '木绑定结到了身上')
      return call('click_slot', { slot: 0, shift: true })
    }),
    step(call('click_slot', { slot: 2, shift: true })),
    step(call('close_screen', {})),
    step({ text: '钢块做了 6 个（压缩机推进了下面的总线，取回来了）；那一排只放了 8 个坚固钢机械方块，缺 10 个；部件加工台做出了一个木绑定结。' }),
  )
  const scripted = llm.remaining

  let code = 0
  try {
    const work = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: '模拟（干活线脚本）', baseUrl: llm.anthropicBaseUrl, apiKey: 'sk-ant-live-fake-tasks', model: 'scripted-work' })
    await brain.call('POST', '/models/use', { providerId: work.provider.id, modelId: work.provider.models[0].id, line: 'work' })
    const talk = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: '对话线（只传话）', baseUrl: talkLlm.anthropicBaseUrl, apiKey: 'sk-ant-live-fake-talk', model: 'talk-relay' })
    await brain.call('POST', '/models/use', { providerId: talk.provider.id, modelId: talk.provider.models[0].id, line: 'talk' })
    await until('大脑连上测试服', async () => (await brain.call('GET', '/overview')).bridge.state === 'connected', 10_000)
    await brain.call('POST', '/bot/spawn', {})
    await until(`${BOT} 在线`, async () => (await game.botStatus(BOT)).online === true, 15_000)
    await game.taskCancel(BOT)
    await game.screenClose(BOT).catch(() => undefined)

    // ── 场景：一条 rcon 连接，一条接一条（同时开好几个连接会被服务器断掉） ──
    const rcon = await openRcon()
    const set = (x: number, y: number, z: number, block: string, meta = 0, nbt = '') => rcon.send(`setblock ${x} ${y} ${z} ${block} ${meta} replace${nbt ? ` ${nbt}` : ''}`)
    try {
      // 先清成空气再摆：同一种方块原样 setblock 一遍是“放不了”，旧的方块和它存的东西（机器里的电、总线里的货）会留着
      for (let x = cx - 5; x <= cx + 5; x++) for (let z = cz - 2; z <= cz + 4; z++) for (let y = cy - 1; y <= cy + 2; y++) await set(x, y, z, y === cy - 1 ? 'minecraft:stone' : 'minecraft:air')
      for (const [p, block, meta, nbt] of [
        [bus, 'gregtech:gt.blockmachines', 0, '{mID:71s,mFacing:1s}'],
        [compressor, 'gregtech:gt.blockmachines', 0, '{mID:241s,mFacing:0s,mMainFacing:2,mItemTransfer:1b,mStoredEnergy:2048L}'],
        [partBuilder, 'TConstruct:ToolStationBlock', 1, ''],
      ] as const) {
        const placed = await set(p.x, p.y, p.z, block, meta, nbt)
        if (!/placed/i.test(placed) || /couldn't/i.test(placed)) throw new Error(`摆 ${block} 在 (${p.x},${p.y},${p.z})：${placed}`)
      }
      say(await rcon.send(`tp ${BOT} ${cx} ${cy} ${cz}`))
      await rcon.send(`clear ${BOT}`)
      for (const give of [`${INGOT.id} 54 ${INGOT.meta}`, `${CASING} 10 13`, `${CASING} 8 0`, `${PATTERN} 1 9`, 'minecraft:planks 8 0']) say(await rcon.send(`give ${BOT} ${give}`))
    } finally {
      rcon.close()
    }
    await sleep(1000)

    say('面板上对它说：用压缩机把钢锭压成钢块，砌那一排机械方块，再用部件加工台做一个木绑定结')
    await brain.call('POST', '/command', { text: '用旁边的压缩机把 54 个钢锭压成钢块；然后砌那一排机械方块；再用部件加工台做一个木绑定结。' })
    await until('脚本用完、大脑空闲', async () => {
      if (problems.length > 0) return true
      if (llm.remaining !== 0) return false
      const o = await brain.call('GET', '/overview')
      return o.agent.busy === false && o.agent.pending === 0 && o.talk.busy === false && o.talk.pending === 0
    }, 300_000, 500)
    await sleep(1000)
    if (problems.length > 0) throw new Error(problems.join(' ‖ '))

    // ── 世界里看一遍 ──
    const filled = await game.worldBlocks({ x1: row.x1, y1: row.y1, z1: row.z1, x2: row.x2, y2: row.y2, z2: row.z2 })
    const kinds = (filled.palette ?? []).map((p) => `${p.id}/${p.meta}`)
    say(`那一排里的方块：${JSON.stringify(kinds)}，runs ${JSON.stringify(filled.runs)}`)
    if (kinds.some((k) => k === `${CASING}/13`)) throw new Error('那一排里放了钢管道方块（meta 13）')
    const inv = (await game.botStatus(BOT)).inventory ?? []
    const count = (id: string, meta?: number) => inv.filter((i) => i.id === id && (meta === undefined || i.meta === meta)).reduce((n, i) => n + i.count, 0)
    say(`${BOT} 身上：钢块 ${count(BLOCK.id, BLOCK.meta)}，钢管道方块 ${count(CASING, 13)}，坚固钢机械方块 ${count(CASING, 0)}，木绑定结 ${count('TConstruct:binding')}，模具 ${count(PATTERN, 9)}`)
    if (count(BLOCK.id, BLOCK.meta) !== 6 || count(CASING, 13) !== 10 || count('TConstruct:binding') !== 1) throw new Error('身上的东西和预期不符')
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
