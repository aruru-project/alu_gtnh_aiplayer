// 对着测试服重演意见簿 f5，走大脑的 process_items（和模型用的一样）：
//   正式服那台进阶组装机 II（mID 213）留着编程电路 1、物品自动输出开着、输出面朝西挨着一个箱子。小阿露用配方 #109339
//   （1 铁杆 + 2 铁环 → 1 铁矿车车轮，不要电路）做 2 个车轮：机器拿铁杆按“铁杆 + 电路 1 → 铁栅栏”做了 2 个铁栅栏，推进了西边的箱子，
//   4 个铁环取回来，任务报“完成了”。
//   1. 同样摆好，照配方做 2 轮：配方不要电路，大脑把电路清成 0 再放料，做出 2 个车轮（推进西边的箱子），任务是“完成了”，
//      做完电路恢复成 1。
//   2. 再来一次，但给 circuit: 1（模型自己设错了电路）：机器做的是铁栅栏，不是车轮——任务“失败了”，说做了什么、去了哪，
//      还没放进配方的料取回来了，只损失开工那一轮的铁杆。
//   3. 意见簿 f20：例程里放下就走（leave），用 setTimeout 隔一秒看一眼机器，不忙了从箱子里把车轮取回来。放下就走时电路清成了 0，
//      这一批做完身体把它改回 1，并告诉她（意见簿 f3：用完别人的机器照原样还回去）。
// 模拟模型服务按脚本回应干活线，对话线只传话。大脑是真启动的进程（src/main.ts），连这一份检出的测试服（live-brain.ts）。
//
//   node test/live-process.ts --at x,y,z [--transcript /tmp/process-model.txt]
//
// --at 是 bot 站的那一格（脚下要是实地，脚本会铺石头）：机器在它北边 3 格（z-3），箱子在机器西边。不属于 npm test；不使用任何真实的模型接口。
// 端口：LIVE_PANEL_PORT（默认 28772）、LIVE_LLM_PORT 和它的下一个（默认 25612/25613）。

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

const GT = 'gregtech:gt.metaitem.01'
const ROD = { id: GT, meta: 23032 }
const RING = { id: GT, meta: 28032 }
const WHEEL = { id: GT, meta: 32100 }
const FENCE = { id: 'gregtech:gt.blockfencemetal', meta: 0 }
/** 配方册里的 #109339：1 铁杆 + 2 铁环 → 1 铁矿车车轮（组装机，不要电路）。 */
const WHEEL_RECIPE = 109339

async function main(): Promise<number> {
  if (AT.length !== 3 || AT.some((n) => !Number.isInteger(n))) throw new Error('给 --at x,y,z：bot 站的那一格')
  const [cx, cy, cz] = AT as [number, number, number]
  const machine = { x: cx, y: cy, z: cz - 3 }
  const chest = { x: cx - 1, y: cy, z: cz - 3 }

  const observer = new BridgeClient({
    address: () => ({ host: '127.0.0.1', port: TESTSERVER_BRIDGE_PORT }),
    token: () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(),
    clientName: 'live-process-driver',
    reconnectMinMs: 500,
    reconnectMaxMs: 3000,
  })
  observer.start()
  const game = new BridgeApi(observer)
  await until(`连上测试服的 bridge（127.0.0.1:${TESTSERVER_BRIDGE_PORT}）`, () => observer.isConnected(), 8000)

  const llm = new MockLlm()
  llm.fallback = (req) => (Array.isArray(req.body?.tools) && req.body.tools.length > 0 ? { text: '' } : { text: '（联调脚本的摘要）' })
  await llm.start(LLM_PORT)
  const talkLlm = new MockLlm()
  talkLlm.fallback = talkRelay()
  await talkLlm.start(LLM_PORT + 1)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplayer-live-process-'))
  fs.chmodSync(dataDir, 0o700)
  const brain = await startBrain(dataDir, undefined, PANEL_PORT)
  say(`大脑已启动，面板 ${brain.origin}，数据目录 ${dataDir}`)

  const problems: string[] = []
  const seenTexts: string[] = []
  let calls = 0
  if (TRANSCRIPT) fs.writeFileSync(TRANSCRIPT, `f5 组装机联调 ${new Date().toLocaleString('zh-CN')}\n`)
  const step = (s: Step) => (req: RecordedLlmRequest): MockReply => {
    const seen = lastTurnText(req)
    seenTexts.push(seen)
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
  const expect = (text: string, re: RegExp, what: string): void => {
    if (!re.test(text)) throw new Error(`${what}：结果里没有 ${re}；看到的是 ${text.slice(0, 1500)}`)
  }
  const call = (name: string, input: unknown): MockReply => ({ toolCalls: [{ name, input }] })

  // 每一段之后看世界：两次之间由驱动脚本重摆场景（rcon），所以干活线在两段之间停一下
  let phase = 1
  llm.enqueue(
    step(call('process_items', { machine, recipe: WHEEL_RECIPE, rounds: 2 })),
    step({ text: '组装机在做车轮。' }),
    step((seen) => {
      expect(seen, /任务 \w+（process）完成了。/, '照配方做：完成了')
      expect(seen, /it finished 2 round\(s\) of a recipe, making 2× gregtech:gt\.metaitem\.01\/32100/, '做了 2 轮、2 个车轮')
      expect(seen, new RegExp(`is now in: 2× gregtech:gt\\.metaitem\\.01/32100 [^;]*at \\(${chest.x},${chest.y},${chest.z}\\), against the west face`), '车轮在西边的箱子里')
      return { text: '车轮做好了，在西边箱子里。' }
    }),
  )
  const firstPart = llm.remaining

  let code = 0
  try {
    const work = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: '模拟（干活线脚本）', baseUrl: llm.anthropicBaseUrl, apiKey: 'sk-ant-live-fake-process', model: 'scripted-work' })
    await brain.call('POST', '/models/use', { providerId: work.provider.id, modelId: work.provider.models[0].id, line: 'work' })
    const talk = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: '对话线（只传话）', baseUrl: talkLlm.anthropicBaseUrl, apiKey: 'sk-ant-live-fake-talk', model: 'talk-relay' })
    await brain.call('POST', '/models/use', { providerId: talk.provider.id, modelId: talk.provider.models[0].id, line: 'talk' })
    await until('大脑连上测试服', async () => (await brain.call('GET', '/overview')).bridge.state === 'connected', 10_000)
    await brain.call('POST', '/bot/spawn', {}).catch(() => undefined)
    await until(`${BOT} 在线`, async () => (await game.botStatus(BOT)).online === true, 15_000)

    /** 摆场景：和正式服那台一样的机器（电路 1、物品自动输出朝西），西边一个空箱子，bot 身上 5 铁杆 4 铁环。 */
    const stage = async (): Promise<void> => {
      await game.taskCancel(BOT)
      await game.screenClose(BOT).catch(() => undefined)
      const rcon = await openRcon()
      const set = (x: number, y: number, z: number, block: string, meta = 0, nbt = '') => rcon.send(`setblock ${x} ${y} ${z} ${block} ${meta} replace${nbt ? ` ${nbt}` : ''}`)
      try {
        for (let x = cx - 3; x <= cx + 3; x++) for (let z = cz - 5; z <= cz + 2; z++) for (let y = cy - 1; y <= cy + 2; y++) await set(x, y, z, y === cy - 1 ? 'minecraft:stone' : 'minecraft:air')
        // 正式服存档里那台的设置（只读来的）：mID 213、输出面 4（西）、正面 3、物品自动输出开、罐里 21852 mB 熔融聚乙烯
        const nbt = '{mID:213s,mFacing:4s,mMainFacing:3,mItemTransfer:1b,mStoredEnergy:32768L,mFluid:{FluidName:"molten.plastic",Amount:21852}}'
        for (const [p, block, meta, data] of [
          [chest, 'minecraft:chest', 0, ''],
          [machine, 'gregtech:gt.blockmachines', 0, nbt],
        ] as const) {
          const placed = await set(p.x, p.y, p.z, block, meta, data)
          if (!/placed/i.test(placed) || /couldn't/i.test(placed)) throw new Error(`摆 ${block} 在 (${p.x},${p.y},${p.z})：${placed}`)
        }
        say(await rcon.send(`tp ${BOT} ${cx} ${cy} ${cz}`))
        await rcon.send(`clear ${BOT}`)
        for (const give of [`${GT} 5 ${ROD.meta}`, `${GT} 4 ${RING.meta}`]) say(await rcon.send(`give ${BOT} ${give}`))
      } finally {
        rcon.close()
      }
      await sleep(1000)
      // 电路 1：像玩家那样打开机器界面、把电路控件设成 1（物品 id 每个世界不一样，不能写进 NBT）
      const screen = await game.screenOpen(BOT, { x: machine.x, y: machine.y, z: machine.z })
      const control = (screen.controls ?? []).find((c) => c.kind === 'circuit')
      if (!control) throw new Error('机器界面上没有电路控件')
      await game.screenSet(BOT, { key: control.key, value: 1 })
      await game.screenClose(BOT)
      const m = (await game.worldMachines({ x: machine.x, y: machine.y, z: machine.z }, { radius: 0 })).machines?.[0]
      say(`机器：电路 ${m?.circuit}，自动输出 ${JSON.stringify(m?.autoOutput)}`)
      if (m?.circuit !== 1) throw new Error('电路没设成 1')
    }
    /** 现在身上、箱子里、机器上各是什么。 */
    const look = async (): Promise<{ carried: (k: { id: string; meta: number }) => number; inChest: (k: { id: string; meta: number }) => number; circuit: number | undefined }> => {
      const inv = (await game.botStatus(BOT)).inventory ?? []
      const box = (await game.worldContainers({ x: chest.x, y: chest.y, z: chest.z }, { radius: 0 })).containers?.find((c) => c.x === chest.x && c.y === chest.y && c.z === chest.z)
      const m = (await game.worldMachines({ x: machine.x, y: machine.y, z: machine.z }, { radius: 0 })).machines?.[0]
      const sum = (list: { id: string; meta?: number; count: number }[], k: { id: string; meta: number }) => list.filter((i) => i.id === k.id && (i.meta ?? 0) === k.meta).reduce((n, i) => n + i.count, 0)
      return { carried: (k) => sum(inv, k), inChest: (k) => sum(box?.items ?? [], k), circuit: m?.circuit }
    }
    const idle = async (scriptLeft: number, what: string): Promise<void> => {
      await until(what, async () => {
        if (problems.length > 0) return true
        if (llm.remaining > scriptLeft) return false
        const o = await brain.call('GET', '/overview')
        return o.agent.busy === false && o.agent.pending === 0 && o.talk.busy === false && o.talk.pending === 0
      }, 180_000, 500)
      await sleep(1000)
      if (problems.length > 0) throw new Error(problems.join(' ‖ '))
    }

    // ── 1. 照配方做 ──
    await stage()
    say('面板上对它说：用组装机照 #109339 做 2 个铁矿车车轮')
    await brain.call('POST', '/command', { text: `用 (${machine.x},${machine.y},${machine.z}) 的组装机照配方 #${WHEEL_RECIPE} 做 2 个铁矿车车轮。` })
    await idle(firstPart - 3, '第一段脚本用完、大脑空闲')
    let w = await look()
    say(`第 1 段之后：身上铁杆 ${w.carried(ROD)}、铁环 ${w.carried(RING)}；箱子里车轮 ${w.inChest(WHEEL)}、铁栅栏 ${w.inChest(FENCE)}；机器电路 ${w.circuit}`)
    if (w.carried(ROD) !== 3 || w.carried(RING) !== 0 || w.inChest(WHEEL) !== 2 || w.inChest(FENCE) !== 0 || w.circuit !== 1) throw new Error('第 1 段：世界里和预期不符（应是铁杆 3、铁环 0、车轮 2、铁栅栏 0、电路恢复成 1）')

    // ── 2. 模型自己把电路设成 1：机器做铁栅栏 ──
    phase = 2
    await stage()
    llm.enqueue(
      step(call('process_items', { machine, recipe: WHEEL_RECIPE, rounds: 2, circuit: 1 })),
      step({ text: '组装机在做车轮。' }),
      step((seen) => {
        expect(seen, /任务 \w+（process）失败了：invalid — the machine ran another recipe than the one these inputs were for: it made \(or was making\) 1x Iron Fence \[gregtech:gt\.blockfencemetal:0\], none of 2x Iron Minecart Wheels \[gregtech:gt\.metaitem\.01:32100\]/, '做的不是车轮：失败了，说做了什么、要的是什么')
        expect(seen, /it ran with programmed circuit 1 as this task set it \(set back to 1 now\)/, '说了它是带着几号电路跑的')
        expect(seen, /took out: 4× gregtech:gt\.metaitem\.01\/28032 [^,;]*, 1× gregtech:gt\.metaitem\.01\/23032/, '没进配方的 4 铁环 1 铁杆取回来了')
        expect(seen, new RegExp(`is now in: 1× gregtech:gt\\.blockfencemetal [^;]*at \\(${chest.x},${chest.y},${chest.z}\\)`), '铁栅栏在西边的箱子里')
        return { text: '组装机做成了铁栅栏，不是车轮；剩下的料取回来了。' }
      }),
    )
    await brain.call('POST', '/command', { text: '再用那台组装机做 2 个车轮，这次电路设成 1。' })
    await idle(0, '第二段脚本用完、大脑空闲')
    w = await look()
    say(`第 2 段之后：身上铁杆 ${w.carried(ROD)}、铁环 ${w.carried(RING)}；箱子里车轮 ${w.inChest(WHEEL)}、铁栅栏 ${w.inChest(FENCE)}；机器电路 ${w.circuit}`)
    if (w.carried(ROD) !== 4 || w.carried(RING) !== 4 || w.inChest(FENCE) !== 1 || w.circuit !== 1) throw new Error('第 2 段：世界里和预期不符（应是铁杆 4、铁环 4、铁栅栏 1、电路 1）')

    // ── 3. 例程里放下就走、等它做完再取（意见簿 f20：以前例程里没有等的办法，setTimeout 是 ReferenceError） ──
    phase = 3
    await stage()
    const routine = `
const machine = ${JSON.stringify(machine)}, chest = ${JSON.stringify(chest)}
const r = await tool("process_items", { machine, recipe: ${WHEEL_RECIPE}, rounds: 2, leave: true })
if (!r.ok) return "没开工：" + r.text
let looks = 0, idle = false
for (let i = 0; i < 30 && !idle; i++) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  looks++
  const m = (await tool("find_machines", { at: machine, radius: 1 })).data.machines.find((x) => x.x === machine.x && x.y === machine.y && x.z === machine.z)
  idle = m !== undefined && !m.active
}
await wait(0.5)
const took = await tool("withdraw_items", { container: chest, items: [{ id: "${GT}", meta: ${WHEEL.meta}, count: 2 }] })
return looks + " looks; " + took.text`
    llm.enqueue(
      step(call('start_routine', { code: routine, name: '组装机做车轮，等做完再取' })),
      step({ text: '例程在跑。' }),
      step((seen) => {
        expect(seen, /Routine r\d+ \("组装机做车轮，等做完再取"\) finished: the program finished\. \d+ tool call\(s\), 2 task\(s\), \d+ wait\(s\) of its own \([\d.]+ s in all\)/, '例程跑完了，写着等了几次')
        expect(seen, /It returned: \d+ looks; t\w+ withdraw \[done\] result=\{"moved":2\}/, '等做完以后从箱子里取回了 2 个车轮')
        // 放下就走时电路清成了 0；这一批做完，身体把它改回 1，告诉她一声（只作背景）
        expect(seen, new RegExp(`任务 t\\w+ 放下就走的那一批做完了：\\(${machine.x},${machine.y},${machine.z}\\) 的编程电路已经改回原来的 1（这一批用的是 0（无））`), '电路改回去了')
        return { text: '车轮取回来了。' }
      }),
    )
    await brain.call('POST', '/command', { text: '用例程做 2 个车轮，放下就走，等它做完再从箱子里取回来。' })
    await idle(0, '第三段脚本用完、大脑空闲')
    w = await look()
    say(`第 3 段之后：身上铁杆 ${w.carried(ROD)}、铁环 ${w.carried(RING)}、车轮 ${w.carried(WHEEL)}；箱子里车轮 ${w.inChest(WHEEL)}；机器电路 ${w.circuit}`)
    if (w.carried(WHEEL) !== 2 || w.inChest(WHEEL) !== 0 || w.carried(ROD) !== 3 || w.circuit !== 1) throw new Error('第 3 段：世界里和预期不符（应是身上车轮 2、铁杆 3，箱子里没有车轮，电路改回了 1）')
    say(`✔ 走完了：干活线调了 ${calls} 次模型`)
  } catch (e) {
    code = 1
    say(`✖（第 ${phase} 段）${e instanceof Error ? e.message : String(e)}`)
    const log = await brain.call('GET', '/log').catch(() => ({ entries: [] }))
    for (const entry of (log.entries as { kind: string; who?: string; text: string }[]).slice(-16)) say(`  | ${entry.kind} ${entry.who ?? ''} ${entry.text.slice(0, 400)}`)
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
