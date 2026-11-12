// 对着测试服联调意见簿 f23 那件事：它拿着任务书打不开界面，交不了要收走东西的子任务、打不了勾、领不了奖。
// 走的是大脑的工具（open_screen、get_quest、quest_book、find_quests），和模型用的一样；身体替它做任务书客户端的那一半。
// 模拟模型服务按脚本回应干活线：每一步看了上一步的结果再定下一步，对话线只传话。大脑是真启动的进程（src/main.ts），
// 连这一份检出的测试服（live-brain.ts），用本地的中文任务书资料。
//
//   LIVE_PANEL_PORT=… LIVE_LLM_PORT=… node test/live-quests.ts [--transcript /tmp/quests-model.txt]
//
// 走一遍：
//   1. 拿着任务书 open_screen：说清这个界面只在客户端里画，不空等。
//   2. “木棍与石头”（2）：身上 9 个沙砾、7 个原木；get_quest 看自己的，提交（收走 2 个原木），等任务书标完成，领奖（火把、硬币）。
//   3. 勾选框：“蘑菇岛？”（72a）打勾，等它标完成；“准备出发！”（f）还锁着，打勾照收、写明解锁后算。
//   4. 挑一样的奖励：“GT6 型导线和线缆”（47b，奖励在任务书里存的编号是 1、3、4，不连着）先打勾，不带 choice 领奖按不了、
//      列出选项，再带 choice 2 领到 8 个橡胶浆。
// 前提：测试服在运行。脚本自己让 bot 上线、用 rcon 把它的任务进度清掉（bq_admin reset all）、给它东西、
// 把 43（47b 的前置）直接标成完成。不属于 npm test；不使用任何真实的模型接口。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import { TESTSERVER_BRIDGE_PORT, TOKEN_FILE, lastTurnText, rcon, say, sleep, stamp, startBrain, until } from './live-brain.ts'
import type { Step } from './live-brain.ts'
import { MockLlm, talkRelay } from './mock-llm.ts'
import type { MockReply, RecordedLlmRequest } from './mock-llm.ts'

const BOT = process.env.LIVE_BOT ?? 'Alu'
const PANEL_PORT = Number(process.env.LIVE_PANEL_PORT ?? 28771)
const LLM_PORT = Number(process.env.LIVE_LLM_PORT ?? 25610)
const ARGS = process.argv.slice(2)
const TRANSCRIPT = ARGS.includes('--transcript') ? ARGS[ARGS.indexOf('--transcript') + 1] : undefined

/** bq_admin 认的任务 id：UUID 的 16 个字节的 base64（URL 安全）。老任务的 UUID 是 00000000-0000-0000-0000-<十六进制数>。 */
function bqId(short: string): string {
  const hex = short.length <= 12 ? `${'0'.repeat(20)}${short.padStart(12, '0')}` : short.replace(/-/g, '')
  return Buffer.from(hex, 'hex').toString('base64url')
}

async function main(): Promise<number> {
  const observer = new BridgeClient({
    address: () => ({ host: '127.0.0.1', port: TESTSERVER_BRIDGE_PORT }),
    token: () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(),
    clientName: 'live-quests-driver',
    reconnectMinMs: 500,
    reconnectMaxMs: 3000,
  })
  observer.start()
  const game = new BridgeApi(observer)
  await until(`连上测试服的 bridge（127.0.0.1:${TESTSERVER_BRIDGE_PORT}）`, () => observer.isConnected(), 8000)
  if (!(await game.botStatus(BOT).catch(() => ({ online: false }))).online) await game.botSpawn({ name: BOT })
  await game.taskCancel(BOT)

  // ── 夹具：进度清零；身上一本任务书、9 个沙砾、7 个原木；8 个泥土让“你的第一个夜晚”（0）自己完成，2 就解锁了 ──
  say((await rcon(`bq_admin reset all ${BOT}`)).out)
  for (const id of ['questbook:ItemQuestBook', 'minecraft:gravel', 'minecraft:log', 'minecraft:dirt', 'minecraft:torch', 'dreamcraft:CoinSurvivor', 'gregtech:gt.metaitem.01']) await rcon(`clear ${BOT} ${id}`)
  say((await rcon(`give ${BOT} questbook:ItemQuestBook 1`)).out)
  say((await rcon(`give ${BOT} minecraft:gravel 9`)).out)
  say((await rcon(`give ${BOT} minecraft:log 7`)).out)
  await sleep(1500)
  say((await rcon(`give ${BOT} minecraft:dirt 8`)).out)
  // 刚上线的玩家，任务书要过一会儿（最多 10 秒）才把没前置的任务算进“在做的”；在那之前背包变了它不看。背包再变一下它就看了
  await until(
    '“你的第一个夜晚”（0）自己完成了',
    async () => {
      if ((await game.questProgress(BOT)).completed?.includes('0')) return true
      await rcon(`give ${BOT} minecraft:dirt 1`)
      return false
    },
    30_000,
    3000,
  )
  say((await rcon(`bq_admin complete ${bqId('43')} ${BOT}`)).out)

  // ── 模拟模型和大脑 ──
  const llm = new MockLlm()
  llm.fallback = (req) => (Array.isArray(req.body?.tools) && req.body.tools.length > 0 ? { text: '' } : { text: '（联调脚本的摘要）' })
  await llm.start(LLM_PORT)
  const talkLlm = new MockLlm()
  talkLlm.fallback = talkRelay()
  await talkLlm.start(LLM_PORT + 1)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplayer-live-quests-'))
  fs.chmodSync(dataDir, 0o700)
  const brain = await startBrain(dataDir, undefined, PANEL_PORT)
  say(`大脑已启动，面板 ${brain.origin}，数据目录 ${dataDir}`)

  const problems: string[] = []
  const seenBy: Record<string, string> = {}
  let calls = 0
  if (TRANSCRIPT) fs.writeFileSync(TRANSCRIPT, `任务书联调 ${new Date().toLocaleString('zh-CN')}\n`)
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
  /** 交完、打完勾：任务书 4 秒内标完成就照实说标了，没标也照实说；两种都是真话，记下是哪一种。 */
  const settled = (seen: string, quest: string): void => {
    const m = /the quest book marked the quest (complete, reward unclaimed|complete) ([\d.]+) s later|had not marked the quest complete within/.exec(seen)
    if (!m) throw new Error(`${quest}：没说任务书标没标完成；看到的是 ${seen.slice(0, 600)}`)
    seenBy[quest] = m[1] ? `任务书 ${m[2]} 秒后标成 ${m[1]}` : '4 秒内任务书还没标完成（照实说了）'
  }

  llm.enqueue(
    step(call('open_screen', { item: { id: 'questbook:ItemQuestBook' } })),
    step((seen) => {
      expect(seen, /^No screen opened, and none will: the quest book \(BetterQuesting\) is a screen drawn only by the game client.*Instead, quest_book does what its buttons do/m, '任务书的界面打不开，照实说了')
      return call('get_quest', { id: '2', player: BOT })
    }),
    step((seen) => {
      expect(seen, new RegExp(`The quest's buttons in ${BOT}'s quest book now: Detect/Submit can be pressed, Claim is greyed out \\(quest_book presses them for you\\)\\.`), '两个按钮的样子')
      expect(seen, /^- task 2: retrieval, the items are taken when handed in: 2× minecraft:log .*\[not done; so far 0\/2\]$/m, '要收走的那个子任务还没交')
      return call('quest_book', { id: '2', action: 'submit' })
    }),
    step((seen) => {
      expect(seen, /^Handed in \(taken from your inventory\): 2× minecraft:log/m, '交掉了 2 个原木')
      // 不收走的那个子任务，背包一变任务书就自己数（夹具里背包变过），也可能是这一下数到的
      expect(seen, /^- task 1 \(retrieval\): done( \(was not done\))?; 9\/9, 5\/5( \(was 0\/9, 0\/5\))?$/m, '第一个子任务数到了')
      expect(seen, /^- task 2 \(retrieval\): done \(was not done\); 2\/2 \(was 0\/2\)$/m, '第二个子任务交上了')
      settled(seen, '木棍与石头（提交）')
      return call('quest_book', { id: '2', action: 'claim' })
    }),
    step((seen) => {
      expect(seen, /^Received: .*1× minecraft:torch/m, '领到火把')
      expect(seen, /dreamcraft:CoinSurvivor/, '领到硬币')
      expect(seen, /^Its state for you: complete \(was complete, reward unclaimed\)\.$/m, '领过了')
      return call('quest_book', { id: '72a', action: 'tick' })
    }),
    step((seen) => {
      expect(seen, /^Ticked task 1 on quest 72a/m, '打了勾')
      expect(seen, /^- task 1 \(checkbox\): done \(was not done\)$/m, '勾上了')
      settled(seen, '蘑菇岛（打勾）')
      return call('quest_book', { id: 'f', action: 'tick' })
    }),
    step((seen) => {
      expect(seen, /^Its state for you: locked\.$/m, '还锁着')
      expect(seen, /^Note: the quest is locked: the tick is kept and counts once the quest unlocks; it needs d /m, '勾留着、解锁后算')
      return call('quest_book', { id: '47b', action: 'tick' })
    }),
    step((seen) => {
      settled(seen, 'GT6 型导线（打勾）')
      return call('quest_book', { id: '47b', action: 'claim' })
    }),
    step((seen) => {
      expect(seen, /^Not pressed: the Claim button of quest 47b .* is greyed out in your quest book: a reward is one to pick from and nothing is picked yet/m, '没挑之前领取是灰的')
      expect(seen, /^Reward 1 is one to pick: option 1: 1× enhancedlootbags:lootbag\/2.*, option 2: 8× gregtech:gt\.metaitem\.01\/2880/m, '列出了两个选项')
      return call('quest_book', { id: '47b', action: 'claim', choice: 2 })
    }),
    step((seen) => {
      expect(seen, /^Picked option 2 of reward 1 \(8× gregtech:gt\.metaitem\.01\/2880/m, '挑了第二样')
      expect(seen, /^Received: .*8× gregtech:gt\.metaitem\.01\/2880/m, '领到 8 个橡胶浆')
      return call('find_quests', { state: 'unclaimed', player: BOT })
    }),
    step((seen) => {
      for (const id of ['2', '47b']) if (new RegExp(`^- ${id} `, 'm').test(seen)) throw new Error(`${id} 领过了却还在“没领”的里面：${seen.slice(0, 400)}`)
      return { text: '任务书：木棍与石头交了、领了；蘑菇岛打了勾；准备出发还锁着、勾留着；GT6 型导线挑了第二样领了。' }
    }),
  )
  const scripted = llm.remaining

  let code = 0
  try {
    const work = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: '模拟（干活线脚本）', baseUrl: llm.anthropicBaseUrl, apiKey: 'sk-ant-live-fake-quests', model: 'scripted-work' })
    await brain.call('POST', '/models/use', { providerId: work.provider.id, modelId: work.provider.models[0].id, line: 'work' })
    const talk = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: '对话线（只传话）', baseUrl: talkLlm.anthropicBaseUrl, apiKey: 'sk-ant-live-fake-talk', model: 'talk-relay' })
    await brain.call('POST', '/models/use', { providerId: talk.provider.id, modelId: talk.provider.models[0].id, line: 'talk' })
    await until('大脑连上测试服', async () => (await brain.call('GET', '/overview')).bridge.state === 'connected', 10_000)
    say('面板上对它说：打开自己的任务书，把能交的交了、能勾的勾了、奖励领了')
    await brain.call('POST', '/command', { text: '打开你自己的任务书，木棍与石头交了领奖，蘑菇岛和准备出发打勾，GT6 型导线打勾领奖（挑橡胶浆）。' })
    await until('脚本用完、大脑空闲', async () => {
      if (problems.length > 0) return true
      if (llm.remaining !== 0) return false
      const o = await brain.call('GET', '/overview')
      return o.agent.busy === false && o.agent.pending === 0 && o.talk.busy === false && o.talk.pending === 0
    }, 180_000, 500)
    await sleep(1000)
    if (problems.length > 0) throw new Error(problems.join(' ‖ '))
    const progress = await game.questProgress(BOT)
    say(`✔ 走完了：干活线调了 ${calls} 次模型（脚本 ${scripted} 步）。${Object.entries(seenBy).map(([k, v]) => `${k}：${v}`).join('；')}`)
    say(`  ${BOT} 现在做完的：${(progress.completed ?? []).join(', ')}；没领奖的：${(progress.unclaimed ?? []).join(', ') || '无'}`)
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
