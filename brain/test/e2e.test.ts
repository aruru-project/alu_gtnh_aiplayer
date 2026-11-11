// 端到端：模拟 bridge + 模拟模型服务 + 真实启动 src/main.ts（子进程）。
// 像主人那样操作：看启动输出里的口令 → 登录面板 → 配模型 → 让 bot 上线 → 游戏里说一句话。
// 然后从这条聊天一路走到对话线应声并把事交出去、干活线启动任务、任务结束再唤醒、对话线回话。
// 两条线各接一个模拟模型服务：头一个场景里两个都按脚本回（对话线怎么说、怎么交事都在脚本里）；
// 后面那些场景要证明的是干活线怎么把事办成，对话线接的是只传话的那个（relayTalk）。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { buildFixturePackdata, pythonMissing } from './fixture-pack.ts'
import { P, R, installMockBase, stack, writePlanFixture } from './fixture-plan.ts'
import { encodePng, makeSchematic, sleep, tmpDir, waitFor } from './helpers.ts'
import { MockBridge } from './mock-bridge.ts'
import { MockLlm, imagesInRequest, isTalkLine, talkRelay } from './mock-llm.ts'

const BRAIN_ROOT = path.resolve(import.meta.dirname, '..')

interface Brain {
  child: ChildProcess
  output: () => string
  exited: Promise<number | null>
}

/**
 * 对话线用的假模型：只传话的（mock-llm.ts 的 talkRelay）。主人说的话它原样交给干活线，干活线送来的话它用悄悄话说给 Steve。
 * 这些场景要证明的是干活线怎么把事办成；两条线之间怎么往来、对话线怎么说话在 lines.test.ts 和下面头一个场景里。
 */
function relayTalk(): MockLlm {
  const talk = new MockLlm()
  talk.fallback = talkRelay({ whisperTo: 'Steve' })
  return talk
}

/** 往已经写好的配置里加上对话线用的那个模型服务（已经加过就不动）。 */
function useTalk(dataDir: string, talk: MockLlm): void {
  const file = path.join(dataDir, 'config.json')
  if (!fs.existsSync(file)) return
  const config = JSON.parse(fs.readFileSync(file, 'utf8'))
  if ((config.providers ?? []).some((p: { id: string }) => p.id === 'talk')) return
  config.providers = [...(config.providers ?? []), { id: 'talk', label: 'talk', kind: 'anthropic-messages', baseUrl: talk.anthropicBaseUrl, apiKey: 'k', models: [{ id: 't', name: 'talk-e2e', label: '' }] }]
  config.talkProviderId = 'talk'
  config.talkModelId = 't'
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 })
}

function startBrain(dataDir: string, bridge: MockBridge, opts: { packdata?: string; talk?: MockLlm } = {}): Brain {
  if (opts.talk) useTalk(dataDir, opts.talk)
  const env = { ...process.env }
  delete env.NODE_USE_ENV_PROXY
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: BRAIN_ROOT,
    env: {
      ...env,
      AIPLAYER_DATA_DIR: dataDir,
      AIPLAYER_PANEL_HOST: '127.0.0.1',
      AIPLAYER_PANEL_PORT: '0',
      AIPLAYER_BRIDGE_HOST: '127.0.0.1',
      AIPLAYER_BRIDGE_PORT: String(bridge.port),
      AIPLAYER_BRIDGE_TOKEN: bridge.token,
      // 开发机上的 brain/packdata 是真实整合包生成的，不能混进测试：没指定就指向一个不存在的目录
      AIPLAYER_PACKDATA: opts.packdata ?? path.join(dataDir, 'no-packdata'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
  child.stderr!.on('data', (d: Buffer) => (out += d.toString()))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, output: () => out, exited }
}

it('端到端：聊天 → 对话线应一声并交给干活线 → 干活线启动任务 → 任务结束再唤醒它 → 它的话由对话线说出去（两条线各用各的模型；中途把干活线的模型从 OpenAI 兼容换成 Anthropic 兼容）', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge()
  const llm = new MockLlm()
  // 这个场景里对话线也按脚本回：它说什么、交什么都看得见
  const talk = new MockLlm()
  talk.fallback = () => ({ text: '' })
  await bridge.start()
  await llm.start()
  await talk.start()
  const brain = startBrain(tmp.dir, bridge)
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`

  // 1. 启动输出里有面板地址和首次生成的口令
  const started = await waitFor('brain startup output', () => {
    const url = /面板地址：(http:\/\/127\.0\.0\.1:\d+)\//.exec(brain.output())
    const pw = /已生成面板访问口令：(\S+)/.exec(brain.output())
    return url && pw ? { origin: url[1]!, password: pw[1]! } : undefined
  }, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const { origin, password } = started

  // 2. 登录面板
  let cookie = ''
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${origin}/api${route}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const json: any = await res.json().catch(() => undefined)
    assert.equal(res.status, 200, `${method} ${route} → ${res.status} ${JSON.stringify(json)}${diag()}`)
    return { json, headers: res.headers }
  }
  cookie = (await call('POST', '/login', { password })).headers.getSetCookie()[0]!.split(';')[0]!

  // 3. 大脑已经连上模拟 bridge
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.match(String(bridge.hellos[0]!.client), /^brain\//)

  // 4. 配一个 OpenAI 兼容的服务商，测试连接；再配一个给对话线用的，只把对话线换过去；让 bot 上线
  llm.enqueue({ text: 'pong' })
  const created = await call('POST', '/providers', { kind: 'openai-chat', label: '模拟 OpenAI', baseUrl: llm.openaiBaseUrl, apiKey: 'sk-e2e-openai-key-0001', model: 'gpt-e2e' })
  const test = await call('POST', '/providers/test', { id: created.json.provider.id, kind: 'openai-chat', label: '模拟 OpenAI', baseUrl: llm.openaiBaseUrl, apiKey: '', model: 'gpt-e2e' })
  assert.equal(test.json.ok, true)
  assert.equal(llm.requests[0]!.headers.authorization, 'Bearer sk-e2e-openai-key-0001')
  // 头一个服务商配上以后两条线都用它；对话线另选一家回话快的
  assert.deepEqual(created.json.lines, { talk: { providerId: created.json.provider.id, modelId: created.json.provider.models[0].id }, work: { providerId: created.json.provider.id, modelId: created.json.provider.models[0].id } })
  const forTalk = await call('POST', '/providers', { kind: 'anthropic-messages', label: '对话用的', baseUrl: talk.anthropicBaseUrl, apiKey: 'sk-ant-e2e-talk-key-0009', model: 'claude-talk' })
  await call('POST', '/models/use', { providerId: forTalk.json.provider.id, modelId: forTalk.json.provider.models[0].id, line: 'talk' })
  await call('POST', '/bot/spawn', {})
  assert.equal(bridge.bots.get('Alu')?.online, true)

  // 5. 游戏里有人叫它干活：对话线一步里应一声、把事交出去；干活线启动任务
  talk.enqueue({ text: '好，我来平。', toolCalls: [{ name: 'tell_worker', input: { text: '把 (0,0)-(15,15) 平到 y=64，挖出来的放 (20,64,0) 的箱子' } }] }, { text: '' })
  llm.enqueue({ toolCalls: [{ name: 'flatten_area', input: { x1: 0, z1: 0, x2: 15, z2: 15, y: 64, dropoff: [{ x: 20, y: 64, z: 0 }] } }] }, { text: '' })
  bridge.chat('Steve', 'Alu 把 0,0 到 15,15 这块平到 64')
  const startReq = await bridge.waitForRequest('task.start', () => true, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.deepEqual(startReq.params, {
    bot: 'Alu',
    task: { type: 'flatten', x1: 0, z1: 0, x2: 15, z2: 15, y: 64, dropoff: [{ x: 20, y: 64, z: 0 }] },
    mode: 'replace',
  })
  await waitFor('first turns finished', () => llm.requests.length === 3 && talk.requests.length === 2, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.deepEqual(bridge.chatLog, [{ bot: 'Alu', message: '好，我来平。' }])
  // 对话线看到的是那句聊天和当前状态（里面有干活线的现状）；它的清单里有交事的工具，没有平地的
  const talkTurn = talk.requests[0]!
  assert.equal(talkTurn.headers['x-api-key'], 'sk-ant-e2e-talk-key-0009')
  const talkSaw = JSON.stringify(talkTurn.body.messages.at(-1))
  assert.match(talkSaw, /Steve 说：Alu 把 0,0 到 15,15 这块平到 64/)
  assert.match(talkSaw, /干活线：空闲，没有在想（大脑启动以后它还没有做过事）；身体上没有它开的任务，也没有例程在跑。/)
  const talkTools = (talkTurn.body.tools as { name: string }[]).map((x) => x.name)
  assert.ok(talkTools.includes('tell_worker') && talkTools.includes('find_recipes') && !talkTools.includes('flatten_area') && !talkTools.includes('say'), talkTools.join(' '))
  // 干活线第一次看到的是交来的事（对话线写的一句，和主人的原话）和当前状态；它的清单里有平地的，没有对玩家说话的
  const firstTurn = llm.requests[1]!
  assert.equal(firstTurn.api, 'openai')
  const firstUser = firstTurn.body.messages.at(-1)
  assert.match(firstUser.content, /对话线交给你的（这一句是它写的）：把 \(0,0\)-\(15,15\) 平到 y=64，挖出来的放 \(20,64,0\) 的箱子/)
  assert.match(firstUser.content, /Steve 说：Alu 把 0,0 到 15,15 这块平到 64/)
  assert.match(firstUser.content, /Alu: online in overworld/)
  const workTools = (firstTurn.body.tools as { function: { name: string } }[]).map((x) => x.function.name)
  assert.ok(workTools.includes('flatten_area') && workTools.includes('report') && !workTools.includes('say') && !workTools.includes('whisper') && !workTools.includes('tell_worker'), workTools.join(' '))
  // 任务在跑，模型没有被再次调用
  assert.equal(bridge.bots.get('Alu')?.task?.type, 'flatten')

  // 6. 任务进行期间，在面板上把干活线的模型换成 Anthropic 兼容的那条（对话线的不动）
  const second = await call('POST', '/providers', { kind: 'anthropic-messages', label: '模拟 Anthropic', baseUrl: llm.anthropicBaseUrl, apiKey: 'sk-ant-e2e-key-0002', model: 'claude-e2e' })
  await call('POST', '/models/use', { providerId: second.json.provider.id, modelId: second.json.provider.models[0].id, line: 'work' })

  // 7. 任务结束 → 只有干活线被叫醒 → 它汇报 → 对话线把话说出去
  llm.enqueue({ thinking: { thinking: '任务完成了，告诉对话线。', signature: 'sig-e2e' }, toolCalls: [{ name: 'report', input: { text: '平好了：挖了 37 格、填了 4 格。' } }] }, { text: '' })
  talk.enqueue({ text: '平好了。' })
  bridge.finishTask('Alu', { result: { dug: 37, placed: 4, skipped: [] } })
  await waitFor('bot reported back', () => bridge.chatLog.length === 2, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.deepEqual(bridge.chatLog[1], { bot: 'Alu', message: '平好了。' })
  await waitFor('second turn finished', () => llm.requests.length === 5, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))

  const wake = llm.requests[3]!
  assert.equal(wake.api, 'anthropic')
  assert.equal(wake.headers['x-api-key'], 'sk-ant-e2e-key-0002')
  const wakeText = JSON.stringify(wake.body.messages.at(-1))
  assert.match(wakeText, /任务 t1（flatten）完成了/)
  assert.match(wakeText, /\\"dug\\":37/)
  // 上一轮（OpenAI 那边产生的）工具调用和结果，被翻译成了 Anthropic 的格式带过来
  const earlier = JSON.stringify(wake.body.messages)
  assert.match(earlier, /"type":"tool_use","id":"[^"]+","name":"flatten_area"/)
  assert.match(earlier, /"type":"tool_result"/)
  // 带思考的工具循环：思考块在下一次请求里原样回传
  const followUp = llm.requests[4]!.body.messages.at(-2)
  assert.deepEqual(followUp.content[0], { type: 'thinking', thinking: '任务完成了，告诉对话线。', signature: 'sig-e2e' })
  // 对话线是被干活线的汇报叫醒的；任务结束这件事本身没有到它那里；它那边一直是对话用的那家接口
  await waitFor('the talk line finished', () => talk.requests.length === 3, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const reported = JSON.stringify(talk.requests[2]!.body.messages.at(-1))
  assert.match(reported, /干活线汇报：平好了：挖了 37 格、填了 4 格。/)
  assert.equal(talk.requests.some((r) => /任务 t1（flatten）完成了/.test(JSON.stringify(r.body.messages))), false)
  assert.ok(talk.requests.every((r) => r.api === 'anthropic' && r.body.model === 'claude-talk'))

  // 8. 面板上看得到整个过程（每条带着是哪条线的），两条线之间的往来各是一条 relay；用量记了账（1 次测试连接 + 干活线 4 次 + 对话线 3 次）
  type LogEntry = { kind: string; who?: string; text: string; agent?: string; relay?: { type: string; from: string; to: string; quotes?: number } }
  const fetchLog = async (): Promise<LogEntry[]> => (await call('GET', '/log')).json.entries
  // 聊天发出去以后大脑才把这句记进日志：等它记完
  let log = await fetchLog()
  for (let i = 0; i < 100 && !log.some((e) => e.kind === 'say' && e.text === '平好了。'); i++) {
    await sleep(20)
    log = await fetchLog()
  }
  const seen = (kind: string, agent: string, re: RegExp) => assert.ok(log.some((e) => e.kind === kind && e.agent === agent && re.test(`${e.who ?? ''} ${e.text}`)), `log has ${kind} of ${agent} ${re}${diag()}`)
  seen('chat', 'talk', /Steve Alu 把 0,0 到 15,15/)
  seen('say', 'talk', /好，我来平。/)
  seen('tool_call', 'work', /flatten_area/)
  seen('tool_result', 'work', /Task t1 \(flatten\) started/)
  seen('event', 'work', /任务 t1（flatten）完成了/)
  seen('say', 'talk', /平好了。/)
  assert.deepEqual(log.filter((e) => e.kind === 'relay').map((e) => [e.agent, e.relay]), [
    ['talk', { type: 'tell', from: 'talk', to: 'work', quotes: 1 }],
    ['work', { type: 'report', from: 'work', to: 'talk' }],
  ])
  const overview = (await call('GET', '/overview')).json
  assert.equal(overview.usage.today.calls, 8)
  assert.deepEqual([overview.provider.kind, overview.lineModels.talk.label], ['anthropic-messages', '对话用的'])
  assert.deepEqual([overview.agent.lastCall.ok, overview.talk.lastCall.ok], [true, true])
  assert.equal(JSON.stringify(overview).includes('sk-ant-e2e-key-0002'), false)
  assert.equal(JSON.stringify(overview).includes('sk-ant-e2e-talk-key-0009'), false)

  // 9. 游戏服务器重启：bot 自己回来（mod 的行为）。大脑重连、补上重启后的事件，不重复去 spawn
  const spawnsBefore = bridge.requestsOf('bot.spawn').length
  const oldEpoch = bridge.epoch
  bridge.restart()
  await waitFor('brain reconnected after the server restart', () => bridge.hellos.length === 2 && bridge.connectedClients === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.equal(bridge.hellos[1]!.serverEpoch, oldEpoch)
  const logHas = async (re: RegExp) => ((await call('GET', '/log')).json.entries as { text: string }[]).some((e) => re.test(e.text))
  const untilLogged = async (what: string, re: RegExp) => {
    for (let i = 0; i < 100; i++) {
      if (await logHas(re)) return
      await new Promise((r) => setTimeout(r, 50))
    }
    assert.fail(`brain never logged: ${what}${diag()}`)
  }
  // 重启后的 bot.spawned 发生在大脑重连之前，靠补发收到
  await untilLogged('the replayed spawn event', /你上线了/)
  assert.equal(bridge.requestsOf('bot.spawn').length, spawnsBefore, 'the bot came back by itself; the brain must not spawn it again')

  // 服务器重启不算“被弄下线”：面板上的选择还是“上线”
  assert.equal((await call('GET', '/bot')).json.bot.wantOnline, true)

  // 9b. bot 被踢下线：选择变成“下线”，之后大脑重连（哪怕服务器重启）也不会把它叫回来，直到有人在面板上点“上线”
  bridge.kick('Alu', 'Kicked by an operator.')
  await untilLogged('the kick', /Alu 被弄下线了（Kicked by an operator\.）。它会一直保持下线/)
  assert.equal((await call('GET', '/bot')).json.bot.wantOnline, false)
  bridge.restart()
  await waitFor('brain reconnected again', () => bridge.hellos.length === 3 && bridge.connectedClients === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(bridge.bots.get('Alu')?.online, false, 'a kicked bot stays offline')
  assert.equal(bridge.requestsOf('bot.spawn').length, spawnsBefore, 'the brain does not bring a kicked bot back by itself')
  // 主人在面板上点“上线”
  await call('POST', '/bot/spawn', {})
  assert.equal(bridge.bots.get('Alu')?.online, true)
  assert.equal(bridge.requestsOf('bot.spawn').length, spawnsBefore + 1)
  assert.equal((await call('GET', '/bot')).json.bot.wantOnline, true)
  await untilLogged('the spawn event after the owner brought it back', /在面板上让 Alu 上线了/)

  // 10. 正常退出，数据落盘且权限收紧
  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
  assert.equal(fs.statSync(tmp.dir).mode & 0o777, 0o700)
  for (const name of ['config.json', 'history.json', 'talk-history.json', 'usage.json', 'bridge-state.json', 'agent-state.json', 'talk-state.json', 'lines-state.json', 'chat-log.json']) {
    assert.equal(fs.statSync(path.join(tmp.dir, name)).mode & 0o777, 0o600, name)
  }
  // 两条线的历史各落各的：干活线两轮（领事、任务结束），对话线两轮（主人说话、干活线汇报）；轮的编号不重
  const history = JSON.parse(fs.readFileSync(path.join(tmp.dir, 'history.json'), 'utf8'))
  const talkHistory = JSON.parse(fs.readFileSync(path.join(tmp.dir, 'talk-history.json'), 'utf8'))
  assert.deepEqual([history.turns.length, talkHistory.turns.length], [2, 2])
  assert.equal(new Set([...history.turns, ...talkHistory.turns].map((x: { id: number }) => x.id)).size, 4)
  assert.equal(JSON.stringify(talkHistory).includes('flatten_area'), false)
  // 聊天记录里有主人的话和它自己说的话
  const chatLines = JSON.parse(fs.readFileSync(path.join(tmp.dir, 'chat-log.json'), 'utf8')) as { kind: string; who: string; text: string }[]
  assert.deepEqual(chatLines.map((l) => [l.kind, l.who, l.text]), [['chat', 'Steve', 'Alu 把 0,0 到 15,15 这块平到 64'], ['said', 'Alu', '好，我来平。'], ['said', 'Alu', '平好了。']])
  const resume = JSON.parse(fs.readFileSync(path.join(tmp.dir, 'bridge-state.json'), 'utf8'))
  assert.equal(resume.serverEpoch, bridge.epoch)
  assert.equal(resume.lastSeq, bridge.seq)
})

it('端到端：大脑进程重启后，重启期间结束的任务照样把它叫醒', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  // 直接写好配置：一个可用的模型服务
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      panel: { password: 'preset-password-for-e2e' },
      providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }],
      activeProviderId: 'mock',
    }),
    { mode: 0o600 },
  )
  let brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))

  llm.enqueue({ toolCalls: [{ name: 'go_to', input: { x: 30, y: 64, z: 30 } }] }, { text: '' })
  bridge.whisper('Alu', 'Steve', '到 30 64 30 来')
  await bridge.waitForRequest('task.start', () => true, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('first turn finished', () => llm.requests.length === 2, 10_000)

  // 停掉大脑；它不在的时候任务失败了
  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
  bridge.finishTask('Alu', { error: { code: 'unreachable', message: 'no path to 30,64,30' } })

  // 重新启动：续传把错过的事件补回来，模型被叫醒处理这次失败
  llm.enqueue({ toolCalls: [{ name: 'report', input: { text: '过不去，路被挡住了。' } }] }, { text: '' })
  brain = startBrain(tmp.dir, bridge, { talk })
  await waitFor('brain told Steve', () => bridge.commandLog.length === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.deepEqual(bridge.commandLog[0], { bot: 'Alu', command: 'tell Steve 过不去，路被挡住了。' })
  assert.match(JSON.stringify(llm.requests[2]!.body.messages.at(-1)), /任务 t1（goto）失败了：unreachable/)
  // 第二次握手带着落盘的续传位置
  assert.equal(bridge.hellos[1]!.serverEpoch, bridge.epoch)
  assert.equal(typeof bridge.hellos[1]!.lastSeq, 'number')

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：主人在面板上传图纸 → 叫它照着盖 → 先对比（库函数，写一行程序调）再动手 → 材料不够时它被叫醒，看到每种还缺多少', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      panel: { password: 'preset-password-for-e2e' },
      providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }],
      activeProviderId: 'mock',
    }),
    { mode: 0o600 },
  )
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  const origin = await waitFor('panel address', () => /面板地址：(http:\/\/127\.0\.0\.1:\d+)\//.exec(brain.output())?.[1], 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))

  // 1. 主人登录面板，在“图纸”页上传一张图纸：4×3×4 的石砖小屋（地板加两层墙），屋里一个箱子
  let cookie = ''
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${origin}/api${route}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, json: (await res.json().catch(() => undefined)) as any, headers: res.headers }
  }
  cookie = (await call('POST', '/login', { password: 'preset-password-for-e2e' })).headers.getSetCookie()[0]!.split(';')[0]!
  const cabin = makeSchematic({ width: 4, height: 3, length: 4 }, (x, y, z) => {
    if (x === 1 && y === 1 && z === 1) return ['minecraft:chest', 3]
    return y === 0 || x === 0 || x === 3 || z === 0 || z === 3 ? 'minecraft:stonebrick' : undefined
  })
  const notAPlan = await call('POST', '/blueprints', { name: 'notes.schematic', data: Buffer.from('just some text').toString('base64') })
  assert.equal(notAPlan.status, 400)
  assert.match(notAPlan.json.error.message, /not a \.schematic file/)
  const uploaded = await call('POST', '/blueprints', { name: 'cabin.schematic', data: cabin.toString('base64') })
  assert.equal(uploaded.status, 200, `${JSON.stringify(uploaded.json)}${diag()}`)
  assert.deepEqual(uploaded.json.saved, { name: 'cabin', size: { x: 4, y: 3, z: 4 }, blocks: 41 })
  assert.ok((await call('GET', '/blueprints')).json.blueprints.some((b: { name: string }) => b.name === 'cabin'))

  // 2. 箱子里只有 25 块石砖，盖这间小屋要 40 块
  const chest = bridge.containers[0]!
  chest.items.push({ id: 'minecraft:stonebrick', meta: 0, count: 25, name: 'Stone Bricks' })
  const supply = [{ x: chest.x, y: chest.y, z: chest.z }]

  // 3. 主人叫它盖：它先对比（check_blueprint 是库函数，写一行程序调），再启动任务
  llm.enqueue(
    { toolCalls: [{ name: 'run_program', input: { code: 'return (await tool("check_blueprint", { name: "cabin", x: 30, y: 65, z: 30 })).text' } }] },
    { toolCalls: [{ name: 'build_blueprint', input: { name: 'cabin', x: 30, y: 65, z: 30, supply } }] },
    { text: '' },
  )
  bridge.whisper('Alu', 'Steve', '照 cabin 那张图纸在 30 65 30 盖，石砖在你旁边的箱子里')
  const startReq = await bridge.waitForRequest('task.start', () => true, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.deepEqual(startReq.params, { bot: 'Alu', task: { type: 'blueprint', name: 'cabin', x: 30, y: 65, z: 30, supply }, mode: 'replace' })
  await waitFor('first turn finished', () => llm.requests.length === 3, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  // 对比的结果：要 40 块石砖、它身上一块都没有；箱子得由人放
  const checked = JSON.stringify(llm.requests[1]!.body.messages.at(-1))
  assert.match(checked, /- toPlace: 40 empty spots you can fill/)
  assert.match(checked, /- 40× minecraft:stonebrick \\"Stonebrick\\" \(you carry 0\)/)
  assert.match(checked, /- 1× minecraft:chest\/3 \\"Chest\\" \(it holds contents or settings\)/)

  // 4. 任务做完能做的部分后以 no_material 失败：它被叫醒，看到还缺什么，告诉主人
  llm.enqueue({ toolCalls: [{ name: 'report', input: { text: '还差 15 块石砖，箱子得你自己放。' } }] }, { text: '' })
  bridge.completeTask('Alu')
  await waitFor('brain told Steve', () => bridge.commandLog.length === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const woken = JSON.stringify(llm.requests[3]!.body.messages.at(-1))
  assert.match(woken, /任务 t1（blueprint）失败了：no_material — 15 blocks were left unplaced for want of material/)
  assert.match(woken, /missing \(left unplaced for want of material\): 15× minecraft:stonebrick/)
  assert.match(woken, /removed 0, placed 25, freeSlots \d+/)
  assert.match(woken, /now \(the world compared with the blueprint\): cells 41, done 25, toPlace 15, byHand 1, blocked 0, extra 0/)
  assert.match(woken, /byHandBlocks \(a player has to place them\): 1× minecraft:chest\/3/)

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：主人只给目标（做一个 Copter Blades）→ 它查物品、查配方、找库存、取料、合成 → 做成后告诉主人', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }],
      activeProviderId: 'mock',
    }),
    { mode: 0o600 },
  )
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  /** 第 n 次请求里，模型看到的最后一条消息（工具结果或事件），JSON 文本。 */
  const seen = (n: number) => JSON.stringify(llm.requests[n]!.body.messages.at(-1))
  const chest = bridge.containers[0]!
  const at = { x: chest.x, y: chest.y, z: chest.z }
  const blades = { id: 'adventurebackpack:backpackComponent', meta: 6 }

  // 1. 一轮里：确认物品 → 看配方 → 找库存 → 把取料和合成排好队
  llm.enqueue(
    { toolCalls: [{ name: 'find_item', input: { query: 'copter blades' } }] },
    { toolCalls: [{ name: 'find_recipes', input: blades }] },
    { toolCalls: [{ name: 'find_in_storage', input: { items: [{ id: 'IC2:itemRecipePart', meta: 12 }, { ore: 'screwSteel' }, { ore: 'craftingToolScrewdriver' }] } }] },
    {
      toolCalls: [
        {
          name: 'withdraw_items',
          input: {
            container: at,
            items: [
              { id: 'IC2:itemRecipePart', meta: 12, count: 4 },
              { id: 'gregtech:gt.metaitem.01', meta: 27305, count: 3 },
              { id: 'gregtech:gt.metatool.01', meta: 22, count: 1 },
            ],
          },
        },
        { name: 'craft_item', input: { ...blades, queue: true } },
      ],
    },
    { text: '' },
  )
  bridge.whisper('Alu', 'Steve', '做一个直升机桨叶')
  await waitFor('goal turn finished', () => llm.requests.length === 5, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.match(seen(1), /adventurebackpack:backpackComponent\/6 \\"Copter Blades\\": recipes: 1 crafting/)
  assert.match(seen(2), /recipe 0: gives 1, 3x3 grid/)
  assert.match(seen(2), /4× IC2:itemRecipePart\/12 \\"Shaft \(Refined Iron\)\\", you carry 0/)
  assert.match(seen(2), /3× any screwSteel \(ore name; e\.g\. gregtech:gt\.metaitem\.01\/27305 \\"Steel Screw\\"\), you carry 0/)
  assert.match(seen(2), /1× any craftingToolScrewdriver \(ore name; e\.g\. gregtech:gt\.metatool\.01\/22 \\"Screwdriver\\"\) \[tool: /)
  assert.match(seen(3), /IC2:itemRecipePart\/12: 8 in total\\n  - \(12,64,-4\) Chest: 8/)
  assert.match(seen(3), /any screwSteel \(ore name\): 16 in total\\n  - \(12,64,-4\) Chest: 16 \(16× gregtech:gt\.metaitem\.01\/27305 \\"Steel Screw\\"\)/)
  assert.deepEqual(
    bridge.requestsOf('task.start').map((p) => [(p.task as { type: string }).type, p.mode]),
    [
      ['withdraw', 'replace'],
      ['craft', 'append'],
    ],
  )

  // 2. 取料任务一做完就轮到合成（3x3 的配方，它旁边有工作台）。取料是在它这一步还没走完时结束的：
  //    这个消息接在这一步的工具结果后面，它这一轮里就看到了，不为它另开一轮
  assert.match(seen(4), /需要你处理的事（你做上一步的时候新到的）[^"]*任务 t1（withdraw）完成了。 结果：\{\\"moved\\":8\}/)
  assert.equal(bridge.bots.get('Alu')?.task?.type, 'craft')

  // 3. 合成做完：被叫醒，看到做出了什么，告诉主人
  llm.enqueue({ toolCalls: [{ name: 'report', input: { text: '桨叶做好了。' } }] }, { text: '' })
  bridge.completeTask('Alu')
  await waitFor('brain told Steve', () => bridge.commandLog.length === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.match(seen(5), /任务 t2（craft）完成了。 结果：crafted 1× adventurebackpack:backpackComponent\/6 \\"Copter Blades\\", freeSlots \d+/)
  // 取料那次结束没有再叫醒它一次：一共就是“目标那一轮 5 次 + 合成做完那一轮 2 次”
  await waitFor('the last turn finished', () => llm.requests.length >= 7, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await sleep(150)
  assert.equal(llm.requests.length, 7)
  // 背包里：成品在，轴和螺丝用掉了，螺丝刀还在
  const carried = (id: string, meta: number) => bridge.bots.get('Alu')!.inventory.filter((i) => i.id === id && i.meta === meta).reduce((n, i) => n + i.count, 0)
  assert.deepEqual(
    [carried(blades.id, 6), carried('IC2:itemRecipePart', 12), carried('gregtech:gt.metaitem.01', 27305), carried('gregtech:gt.metatool.01', 22)],
    [1, 0, 0, 1],
  )

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：大脑带着本地配方册启动，主人指着箱子说“做一个直升机桨叶” → 它用中文名找到物品、看到所有做法和附近做得了的、照配方的编号合成（摆法是大脑给身体的）→ 做成', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(path.join(tmp.dir, 'config.json'), JSON.stringify({ providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }], activeProviderId: 'mock' }), { mode: 0o600 })
  // 一本小配方册：桨叶是手工 3×3（四个柄、三个“任何 screwSteel”、一把螺丝刀），和模拟服务器上的配方是同一条
  const packdata = path.join(tmp.dir, 'packdata')
  fs.mkdirSync(packdata)
  const GT = 'gregtech:gt.metaitem.01'
  fs.writeFileSync(
    path.join(packdata, 'items.jsonl'),
    [
      { id: 'adventurebackpack:backpackComponent', meta: 6, name: '直升机桨叶', en: 'Copter Blades' },
      { id: 'IC2:itemRecipePart', meta: 12, name: '精炼铁柄', en: 'Shaft (Refined Iron)' },
      { id: GT, meta: 27305, name: '钢螺丝', en: 'Steel Screw', ores: ['screwSteel'] },
      { id: 'gregtech:gt.metatool.01', meta: 22, name: '螺丝刀', en: 'Screwdriver', ores: ['craftingToolScrewdriver'] },
      { id: 'minecraft:chest', meta: 0, name: '箱子', en: 'Chest' },
    ]
      .map((i) => JSON.stringify(i))
      .join('\n'),
  )
  fs.writeFileSync(path.join(packdata, 'handlers.json'), JSON.stringify([{ key: 'codechicken.nei.recipe.ShapedRecipeHandler', name: '有序合成', grid: true, machines: [], recipes: 1, read: 'all' }]))
  const shaft = (g: number) => ({ id: 'IC2:itemRecipePart', meta: 12, n: 1, g })
  const screw = (g: number) => ({ ore: 'screwSteel', n: 1, g, any: [[GT, 27305]], more: 0 })
  fs.writeFileSync(
    path.join(packdata, 'recipes.jsonl'),
    `${JSON.stringify({ h: 'codechicken.nei.recipe.ShapedRecipeHandler', in: [shaft(0), screw(1), shaft(2), screw(3), screw(5), shaft(6), { ore: 'craftingToolScrewdriver', n: 1, g: 7, any: [['gregtech:gt.metatool.01', 22]], more: 0 }, shaft(8)], out: [{ id: 'adventurebackpack:backpackComponent', meta: 6, n: 1 }] })}\n`,
  )
  const brain = startBrain(tmp.dir, bridge, { packdata, talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.match(brain.output(), /\[packdata\] 配方册：1 条配方、1 个配方页/)
  /** 第 n 次请求里模型看到的最后一条消息里的文字。 */
  const seen = (n: number): string => {
    const last = llm.requests[n]!.body.messages.at(-1)
    return (last.content as { type: string; text?: string; content?: unknown }[]).map((b) => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join('\n')
  }
  const chest = bridge.containers[0]!
  const at = { x: chest.x, y: chest.y, z: chest.z }

  // 1. 一轮里：找物品 → 看做法 → 取料 → 合成（后两步排队）
  llm.enqueue(
    { toolCalls: [{ name: 'find_item', input: { query: '直升机桨叶' } }] },
    { toolCalls: [{ name: 'find_recipes', input: { id: 'adventurebackpack:backpackComponent', meta: 6 } }] },
    {
      toolCalls: [
        { name: 'withdraw_items', input: { container: at, items: [{ id: 'IC2:itemRecipePart', meta: 12, count: 4 }, { id: GT, meta: 27305, count: 3 }, { id: 'gregtech:gt.metatool.01', count: 1 }] } },
        { name: 'craft_item', input: { recipe: 0, queue: true } },
      ],
    },
    { text: '' },
  )
  bridge.whisper('Alu', 'Steve', '做一个直升机桨叶')
  await waitFor('first turn finished', () => llm.requests.length === 4, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  // 主人说话时指着什么：身体给的，整理成一行跟在那句话下面（箱子的名字是物品表里的中文名）
  assert.match(seen(0), /Steve 私聊你：做一个直升机桨叶\n {6}（Steve 站在 \(12,64,3\) 面朝北，指着 箱子 \(12,64,-4\)［容器］；面前还有：Oak Drawers 1x2 \(14,64,-4\)［抽屉］）/)
  // 找物品：读的是本地物品表，没有问服务器
  assert.equal(seen(1), '"直升机桨叶" matches 1 item(s), most alike first.\n- 直升机桨叶 [adventurebackpack:backpackComponent/6]: 1 recipe(s) make it; used in none')
  assert.equal(bridge.requestsOf('item.search').length + bridge.requestsOf('recipe.find').length, 0)
  // 看做法：配方册里的那一条，附近有工作台
  assert.deepEqual(seen(2).split('\n').slice(0, 3), [
    "直升机桨叶 [adventurebackpack:backpackComponent/6] can be made 1 way(s), 1 recipe(s) in all. Listed by way of making, in the recipe book's order; what stands in your base for each way is stated, nothing is ranked or recommended:",
    '1. 有序合成 — 1 recipe(s); CAN CRAFT NOW (needs a crafting table, the nearest 2 block(s) from here; craft_item walks to the nearest one by itself); uses hand tools (not used up, but they wear)',
    '   #0: 4× 精炼铁柄 [IC2:itemRecipePart/12] + 3× any screwSteel (e.g. 钢螺丝 [gregtech:gt.metaitem.01/27305]); needs tool any craftingToolScrewdriver (e.g. 螺丝刀 [gregtech:gt.metatool.01/22]) (worn, not used up) → 1× 直升机桨叶 — needs a crafting table (3x3)',
  ])
  // 合成任务：摆法是大脑照配方册给的，不是让服务器自己找配方
  const craft = bridge.requestsOf('task.start').map((r) => r.task as Record<string, unknown>).find((task) => task.type === 'craft')!
  const S = { id: 'IC2:itemRecipePart', meta: 12 }
  const W = { ore: 'screwSteel' }
  assert.deepEqual(craft, { type: 'craft', grid: [S, W, S, W, null, W, S, { ore: 'craftingToolScrewdriver' }, S], gives: { id: 'adventurebackpack:backpackComponent', meta: 6 }, rounds: 1 })

  // 2. 取料一做完就轮到合成（模拟的身体里取料是立刻做完的）：取料结束的消息接在这一步的工具结果后面，这一轮里就看到了
  assert.equal(bridge.requestsOf('task.start').length, 2)
  await waitFor('the goal turn finished', () => llm.requests.length === 4, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.match(seen(3), /需要你处理的事（你做上一步的时候新到的）[\s\S]*任务 t1（withdraw）完成了。 结果：\{"moved":8\}/)
  assert.equal(bridge.bots.get('Alu')?.task?.type, 'craft', `the craft task is running after the withdraw${diag()}`)

  // 3. 合成做完：它被叫醒，结果里的东西叫的是中文名
  llm.enqueue({ toolCalls: [{ name: 'report', input: { text: '直升机桨叶做好了。' } }] }, { text: '' })
  bridge.completeTask('Alu')
  await waitFor('told the owner', () => bridge.commandLog.some((c) => c.command.includes('直升机桨叶做好了')), 10_000).catch((e) => assert.fail(`${e.message}\n${llm.requests.map((_, n) => seen(n)).join('\n---\n')}${diag()}`))
  const ended = llm.requests.map((_, n) => seen(n)).find((text) => /（craft）完成了/.test(text))!
  assert.match(ended, /crafted 1× adventurebackpack:backpackComponent\/6 "直升机桨叶"/)
  // 背包里真的多了一个，用掉的是柄和螺丝，螺丝刀还在
  const inventory = bridge.bots.get('Alu')!.inventory
  const count = (id: string, meta: number) => inventory.filter((i) => i.id === id && i.meta === meta).reduce((n, i) => n + i.count, 0)
  assert.deepEqual([count('adventurebackpack:backpackComponent', 6), count('IC2:itemRecipePart', 12), count(GT, 27305), count('gregtech:gt.metatool.01', 22)], [1, 0, 0, 1])

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：主人在面板写了一本手册，然后问“任务书下一步做什么” → 它先翻手册再查任务书（本地没有资料，问的是服务器）→ 把能做的任务告诉主人', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      panel: { password: 'preset-password-for-e2e' },
      providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }],
      activeProviderId: 'mock',
    }),
    { mode: 0o600 },
  )
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  const origin = await waitFor('panel address', () => /面板地址：(http:\/\/127\.0\.0\.1:\d+)\//.exec(brain.output())?.[1], 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))

  // 1. 面板的“手册”页：默认手册都在；主人新写一本
  let cookie = ''
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${origin}/api${route}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, json: (await res.json().catch(() => undefined)) as any, headers: res.headers }
  }
  cookie = (await call('POST', '/login', { password: 'preset-password-for-e2e' })).headers.getSetCookie()[0]!.split(';')[0]!
  const shipped = (await call('GET', '/manuals')).json.manuals.map((m: { name: string }) => m.name)
  for (const name of ['blueprint', 'crafting', 'containers', 'terrain', 'travel', 'quests']) assert.ok(shipped.includes(name), `the panel shows the default manual ${name}${diag()}`)
  const saved = await call('PUT', '/manuals', { name: '基地布局', summary: '要在基地里找仓库、机器、工作台时看。', body: '仓库在 (12,64,-4) 那一排箱子。' })
  assert.equal(saved.status, 200, JSON.stringify(saved.json))
  // 落在数据目录里
  assert.equal(fs.readFileSync(path.join(tmp.dir, 'manuals', '基地布局.md'), 'utf8'), '要在基地里找仓库、机器、工作台时看。\n\n仓库在 (12,64,-4) 那一排箱子。\n')

  // 2. 主人问下一步做什么：先翻任务书手册，再查他现在能做的任务，看其中一个的详情，然后回话
  llm.enqueue(
    { toolCalls: [{ name: 'read_manual', input: { name: 'quests' } }] },
    { toolCalls: [{ name: 'find_quests', input: { state: 'available' } }] },
    { toolCalls: [{ name: 'get_quest', input: { id: '4a' } }] },
    { toolCalls: [{ name: 'report', input: { text: '能做的有 3 个，最近的是做个直升机背包交任务。' } }] },
    { text: '' },
  )
  bridge.whisper('Alu', 'Steve', '任务书下一步做什么')
  await waitFor('brain told Steve', () => bridge.commandLog.length === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('turn finished', () => llm.requests.length === 5, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const seen = (n: number) => JSON.stringify(llm.requests[n]!.body.messages.at(-1))

  // 提示词里只有手册目录：默认的和主人刚写的；正文没塞进去
  const system = JSON.stringify(llm.requests[0]!.body.system)
  assert.match(system, /# 手册/)
  assert.match(system, /- quests：[^\\]+/)
  assert.match(system, /- 基地布局（主人写的）：要在基地里找仓库、机器、工作台时看。/)
  assert.equal(system.includes('仓库在 (12,64,-4)'), false)
  assert.match(seen(0), /手册：这段对话里现在没有任何一本手册的内容/)
  // 读到的是整本任务书手册
  assert.match(seen(1), /Manual \\"quests\\": /)
  assert.match(seen(1), /任务书的内容你本地有一份中文的/)
  // 这个大脑启动时没有本地资料（日志里说了一句），所以任务书是问服务器的
  assert.match(brain.output(), /\[packdata\] 没有本地资料（[^）]*no-packdata 不存在）：任务书改问服务器/)
  // 没设主人名单：看刚才跟它说话的那个人的进度
  assert.deepEqual(bridge.requestsOf('quest.search'), [{ state: 'available', player: 'Steve' }])
  assert.match(seen(2), /3 quest\(s\) match \(state available\) for Steve:/)
  assert.match(seen(2), /- 43 \\"Wired, Weird\?!\\" \[Tier 0\.5 - Steam\]: available/)
  assert.match(seen(2), /- 4a \\"Take to the Skies\\" \[Tier 0\.5 - Steam\]: available/)
  assert.equal(/Basic Crafting: Motors/.test(seen(2)), false, 'a locked quest is not listed as available')
  assert.deepEqual(bridge.requestsOf('quest.get'), [{ id: '4a', player: 'Steve' }])
  assert.match(seen(3), /Quest 4a \\"Take to the Skies\\", chapter \\"Tier 0\.5 - Steam\\"\. State for Steve: available/)
  assert.match(seen(3), /- retrieval, not done, the items are kept: 1× adventurebackpack:copterPack \\"Copter Pack\\"/)
  assert.match(seen(3), /- item: 10× gregtech:gt\.metaitem\.01\/32000 \\"Copper Coin\\"/)
  assert.deepEqual(bridge.commandLog[0], { bot: 'Alu', command: 'tell Steve 能做的有 3 个，最近的是做个直升机背包交任务。' })

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：大脑带着本地任务书资料启动，主人问“任务书下一步做什么” → 它查的是本地的中文任务书，只向服务器问谁做完了哪些', { skip: pythonMissing() }, async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  // 资料是生成器从一个小客户端包里生成的，和模拟 bridge 自带的那本任务书是同一本（Steve 做完了 1 和 2）
  const { packdata } = buildFixturePackdata(tmp.dir)
  const dataDir = path.join(tmp.dir, 'data')
  fs.mkdirSync(dataDir)
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({
      providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }],
      activeProviderId: 'mock',
    }),
    { mode: 0o600 },
  )
  const brain = startBrain(dataDir, bridge, { packdata, talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.match(brain.output(), /\[packdata\] 任务书：12 个任务、3 章（来自 Fixture-client\.zip/, diag())

  llm.enqueue(
    { toolCalls: [{ name: 'find_quests', input: { state: 'available' } }] },
    { toolCalls: [{ name: 'get_quest', input: { id: '4a' } }] },
    { toolCalls: [{ name: 'report', input: { text: '能做的有 6 个，比如“飞向天空”：做个直升机背包。' } }] },
    { text: '' },
  )
  bridge.whisper('Alu', 'Steve', '任务书下一步做什么')
  await waitFor('brain told Steve', () => bridge.commandLog.length === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('turn finished', () => llm.requests.length === 4, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const seen = (n: number) => JSON.stringify(llm.requests[n]!.body.messages.at(-1))

  // 能做的 6 个是按前置和 Steve 做完的 1、2 算出来的；任务名、章节名是中文
  assert.match(seen(1), /6 quest\(s\) match \(state available\) for Steve:/)
  assert.match(seen(1), /- 43 \\"导线，奇怪？\\" \[第0\.5阶 - 蒸汽时代\] \(main\): available/)
  assert.equal(/基础制作：马达/.test(seen(1)), false, 'a locked quest is not listed as available')
  assert.match(seen(2), /Quest 4a \\"飞向天空\\" \(Take to the Skies\), chapters \\"游历四方……\\", \\"第0\.5阶 - 蒸汽时代\\"\. State for Steve: available/)
  assert.match(seen(2), /- retrieval, the items are kept: 1× adventurebackpack:copterPack/)
  assert.match(seen(2), /直升机背包能让你在基地上空悬停/)
  // 向服务器只问了进度，而且两次查询只问一次；任务的内容一个字都没问
  assert.deepEqual(bridge.requestsOf('quest.progress'), [{ player: 'Steve' }])
  assert.deepEqual(bridge.requests.map((r) => r.method).filter((m) => /^quest\.(lines|search|get)$/.test(m)), [])
  assert.deepEqual(bridge.commandLog[0], { bot: 'Alu', command: 'tell Steve 能做的有 6 个，比如“飞向天空”：做个直升机背包。' })

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：主人在面板传一张图，叫它做成像素画 → 它写程序出草稿、报给主人 → 主人同意后发布成图纸、对比、开工（它照旧习惯直接调了两个已经不在工具清单里的名字，照常执行）', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      panel: { password: 'preset-password-for-e2e' },
      providers: [{ id: 'mock', label: 'mock', kind: 'openai-chat', baseUrl: llm.openaiBaseUrl, apiKey: 'k', model: 'gpt-e2e' }],
      activeProviderId: 'mock',
    }),
    { mode: 0o600 },
  )
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  const origin = await waitFor('panel address', () => /面板地址：(http:\/\/127\.0\.0\.1:\d+)\//.exec(brain.output())?.[1], 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  let cookie = ''
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${origin}/api${route}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, json: (await res.json().catch(() => undefined)) as any, headers: res.headers }
  }
  cookie = (await call('POST', '/login', { password: 'preset-password-for-e2e' })).headers.getSetCookie()[0]!.split(';')[0]!

  // 1. 主人在面板“图纸”页传一张 3×3 的小图：一个红心（红色正好是红色羊毛的颜色），其余透明
  const R = [151, 52, 49, 255]
  const O = [0, 0, 0, 0]
  const heart = encodePng({ width: 3, height: 3, rgba: Buffer.from([R, O, R, R, R, R, O, R, O].flat()) })
  const uploaded = await call('POST', '/images', { name: 'heart', data: heart.toString('base64') })
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.json))

  // 这一场里它照旧习惯直接调两个已经不在工具清单里的名字：list_images（并进了 list_designs 的旧名字）和
  // check_blueprint（库函数）。两个都照常执行，和以前一样的结果——旧笔记、旧例程、小模型的误调不会变成一次失败。
  // 2. 主人叫它做成像素画：它看有哪些图 → 写程序出草稿 → 把样子、材料告诉主人，等他点头
  const program = [
    "const img = image('heart')",
    'const b = blueprint(img.width, img.height, 1)',
    'for (let y = 0; y < img.height; y++) {',
    '  for (let x = 0; x < img.width; x++) {',
    '    const [r, g, bl, a] = img.pixel(x, y)',
    '    if (a >= 128) b.set(x, img.height - 1 - y, 0, nearestBlock(r, g, bl))',
    '  }',
    '}',
    "b.save('heart-art')",
  ].join('\n')
  llm.enqueue(
    { toolCalls: [{ name: 'list_images', input: {} }] },
    { toolCalls: [{ name: 'run_program', input: { code: program } }] },
    { toolCalls: [{ name: 'report', input: { text: '画好了：3×3 的红心，要 6 块红色羊毛，立在 40 65 40。你去面板图纸页看看草稿，行我就盖。' } }] },
    { text: '' },
  )
  bridge.whisper('Alu', 'Steve', '把我传的 heart 那张图做成像素画，竖着立起来')
  await waitFor('brain asked Steve', () => bridge.commandLog.length === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('first turn finished', () => llm.requests.length === 4, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const seen = (n: number) => JSON.stringify(llm.requests[n]!.body.messages.at(-1))
  // 提示词里指了路：手册目录里有 design
  assert.match(JSON.stringify(llm.requests[0]!.body.messages[0]), /- design：[^\\]+/)
  // 这两个名字都不在发给它的工具清单里
  const offered = (llm.requests[0]!.body.tools as { function: { name: string } }[]).map((tool) => tool.function.name)
  assert.deepEqual([offered.includes('list_images'), offered.includes('check_blueprint'), offered.includes('list_designs'), offered.includes('build_blueprint')], [false, false, true, true])
  assert.match(seen(1), /1 image\(s\) \(name: width×height in pixels\):\\n- heart: 3×3/)
  assert.match(seen(2), /Saved draft \\"heart-art\\": 3×3×1 \(x east-west × y up × z north-south\), 6 block\(s\) of 1 kind\(s\)\./)
  assert.match(seen(2), /- 6× minecraft:wool\/14 \\"红色羊毛\\"/)
  // 预览是从南面看的整幅画：和图片一样，上面两个角、下面一个尖
  assert.match(seen(2), /z=0:\\nA\.A\\nAAA\\n\.A\./)
  // 这时游戏里还什么都没有；主人在面板上看得到这张草稿
  assert.equal(bridge.requestsOf('blueprint.put').length, 0)
  assert.deepEqual((await call('GET', '/drafts')).json.drafts.map((d: { name: string }) => d.name), ['heart-art'])

  // 3. 主人同意：发布成图纸 → 对比 → 开工
  llm.enqueue(
    { toolCalls: [{ name: 'publish_draft', input: { name: 'heart-art' } }] },
    { toolCalls: [{ name: 'check_blueprint', input: { name: 'heart-art', x: 40, y: 65, z: 40 } }] },
    { toolCalls: [{ name: 'build_blueprint', input: { name: 'heart-art', x: 40, y: 65, z: 40 } }] },
    { text: '' },
  )
  bridge.whisper('Alu', 'Steve', '可以，盖吧')
  const startReq = await bridge.waitForRequest('task.start', () => true, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.deepEqual(startReq.params, { bot: 'Alu', task: { type: 'blueprint', name: 'heart-art', x: 40, y: 65, z: 40 }, mode: 'replace' })
  await waitFor('second turn finished', () => llm.requests.length === 8, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  // 身体收到的图纸，照它的读法就是那个红心
  const blueprint = bridge.blueprints.get('heart-art')
  assert.ok(blueprint && !('error' in blueprint), diag())
  assert.deepEqual(blueprint.size, { x: 3, y: 3, z: 1 })
  assert.deepEqual(blueprint.kinds.map((k) => `${k.id}/${k.meta}`), ['minecraft:air/0', 'minecraft:wool/14'])
  // 最下面一层（y=0）是尖，最上面一层（y=2）是两个角
  assert.deepEqual([...blueprint.cells], [0, 1, 0, 1, 1, 1, 1, 0, 1])
  assert.match(seen(5), /Published draft \\"heart-art\\" as blueprint \\"heart-art\\" on the server \(3×3×1, 6 blocks\)/)
  // 对比的结果：6 块红色羊毛都还要放
  assert.match(seen(6), /- 6× minecraft:wool\/14/)

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：它干活时往意见簿里记了一条 → 主人在面板上看得到，带着这一轮的原话、刚才的工具调用和两边的版本', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      panel: { password: 'preset-password-for-e2e' },
      providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'sk-e2e-anthropic-key-0002', model: 'claude-e2e' }],
      activeProviderId: 'mock',
    }),
    { mode: 0o600 },
  )
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  const origin = await waitFor('panel address', () => /面板地址：(http:\/\/127\.0\.0\.1:\d+)\//.exec(brain.output())?.[1], 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))

  llm.enqueue(
    { toolCalls: [{ name: 'list_containers', input: { radius: 8 } }] },
    {
      toolCalls: [
        {
          name: 'report_problem',
          input: { title: '看不出附魔书是什么附魔', category: 'missing_tool', goal: '把时运书拿给主人', problem: 'list_containers 只给物品 id', wish: '带上 NBT 摘要' },
        },
      ],
    },
    { toolCalls: [{ name: 'report', input: { text: '我分不出哪本是时运，你自己来拿一下' } }] },
    { text: '' },
  )
  bridge.whisper('Alu', 'Steve', '把箱子里那本时运书给我')
  await waitFor('brain told Steve', () => bridge.commandLog.length === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('turn finished', () => llm.requests.length === 4, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))

  // 主人打开面板：导航上有个 1，意见簿里是这一条
  const res = await fetch(`${origin}/api/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'preset-password-for-e2e' }) })
  const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!
  const get = async (route: string) => (await (await fetch(`${origin}/api${route}`, { headers: { cookie } })).json()) as any
  assert.deepEqual((await get('/overview')).feedback, { unread: 1 })
  const listed = await get('/feedback')
  assert.deepEqual(listed.reports.map((r: Record<string, unknown>) => [r.id, r.title, r.category, r.status]), [['f1', '看不出附魔书是什么附魔', 'missing_tool', 'new']])
  const report = await get('/feedback/view?id=f1')
  assert.deepEqual([report.goal, report.problem, report.wish], ['把时运书拿给主人', 'list_containers 只给物品 id', '带上 NBT 摘要'])
  assert.deepEqual([report.context.bot, report.context.brainVersion, report.context.modVersion], ['Alu', '0.1.0', 'v0.1.0-mock'])
  assert.match(report.context.instruction, /Steve 私聊你：把箱子里那本时运书给我/)
  assert.deepEqual(report.context.recentTools.map((c: { tool: string; input: string }) => [c.tool, c.input]), [['list_containers', '{"radius":8}']])
  // 存在数据目录里；里面没有 API key
  const saved = fs.readFileSync(path.join(tmp.dir, 'feedback.jsonl'), 'utf8')
  assert.match(saved, /看不出附魔书是什么附魔/)
  assert.equal(saved.includes('sk-e2e-anthropic-key-0002'), false)

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：两条线各用各的模型，主人在面板上只换了干活线的 → 不用重启，干活线下一轮用的就是新模型和它自己的设置，对话线的没动；日志里每一轮写着是哪条线、用的是哪个', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      version: 2,
      panel: { password: 'preset-password-for-e2e' },
      providers: [
        {
          id: 'mock',
          label: '模拟接口',
          kind: 'openai-chat',
          baseUrl: llm.openaiBaseUrl,
          apiKey: 'sk-e2e-switch-key-0003',
          models: [
            { id: 'fast', name: 'gpt-fast', maxOutputTokens: 1111 },
            { id: 'think', name: 'gpt-think', label: '思考版', maxOutputTokens: 2222, extraBody: { reasoning_effort: 'high' }, options: { maxTokensField: 'max_completion_tokens' } },
          ],
        },
      ],
      activeProviderId: 'mock',
      activeModelId: 'fast',
    }),
    { mode: 0o600 },
  )
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  const origin = await waitFor('panel address', () => /面板地址：(http:\/\/127\.0\.0\.1:\d+)\//.exec(brain.output())?.[1], 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  let cookie = ''
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${origin}/api${route}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, json: (await res.json().catch(() => undefined)) as any, headers: res.headers }
  }
  cookie = (await call('POST', '/login', { password: 'preset-password-for-e2e' })).headers.getSetCookie()[0]!.split(';')[0]!

  // 1. 第一轮：对话线用的是它自己那家接口（只传话的那个），干活线用的是选中的 gpt-fast 和它的输出上限
  llm.enqueue({ toolCalls: [{ name: 'report', input: { text: '在' } }] }, { text: '' })
  bridge.whisper('Alu', 'Steve', '在吗')
  await waitFor('first turn finished', () => llm.requests.length === 2, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.deepEqual([llm.requests[0]!.body.model, llm.requests[0]!.body.max_tokens, llm.requests[0]!.body.reasoning_effort], ['gpt-fast', 1111, undefined])
  await waitFor('the talk line passed the answer on', () => bridge.commandLog.length === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))

  // 2. 主人在页头把干活线的模型换成“思考版”：列表里能选的都在；换完概览上干活线是它，对话线的没动
  const before = (await call('GET', '/overview')).json
  assert.deepEqual(before.models.map((m: { modelId: string; label: string }) => [m.modelId, m.label]), [['fast', 'gpt-fast'], ['think', '思考版'], ['t', 'talk-e2e']])
  assert.deepEqual([before.provider.modelId, before.lineModels.work.modelId, before.lineModels.talk.modelId], ['fast', 'fast', 't'])
  const switched = await call('POST', '/models/use', { providerId: 'mock', modelId: 'think', line: 'work' })
  assert.equal(switched.status, 200, JSON.stringify(switched.json))
  assert.deepEqual(switched.json.lines, { talk: { providerId: 'talk', modelId: 't' }, work: { providerId: 'mock', modelId: 'think' } })
  const after = (await call('GET', '/overview')).json
  assert.deepEqual([after.provider.model, after.provider.modelLabel, after.lineModels.talk.model], ['gpt-think', '思考版', 'talk-e2e'])

  // 3. 大脑没重启；下一轮发出去的请求用的就是新模型和它自己的设置（输出上限的字段名、思考参数）
  llm.enqueue({ toolCalls: [{ name: 'report', input: { text: '还在' } }] }, { text: '' })
  bridge.whisper('Alu', 'Steve', '还在吗')
  await waitFor('second turn finished', () => llm.requests.length === 4, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const second = llm.requests[2]!.body
  assert.deepEqual([second.model, second.max_completion_tokens, second.max_tokens, second.reasoning_effort], ['gpt-think', 2222, undefined, 'high'])
  assert.equal(llm.requests[2]!.headers.authorization, 'Bearer sk-e2e-switch-key-0003')

  // 对话线从头到尾用的是它自己的模型，一次都没有发到干活线那家接口去
  await waitFor('the talk line passed the second answer on', () => bridge.commandLog.length === 2, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.ok(talk.requests.length >= 4 && talk.requests.every((r) => r.body.model === 'talk-e2e'))
  assert.equal(llm.requests.length, 4)

  // 4. 日志里每一轮写着是哪条线、用的是哪个服务商的哪个模型，换模型也记了一笔
  const entries = (await call('GET', '/log')).json.entries as { kind: string; text: string; agent?: string }[]
  const log = entries.map((e) => e.text)
  const turnStart = (agent: string, re: RegExp) => assert.ok(entries.some((e) => e.kind === 'turn' && e.agent === agent && re.test(e.text)), `${agent} ${re}\n${log.join('\n')}`)
  turnStart('talk', /^第 \d+ 轮开始（talk \/ talk-e2e）：Steve 私聊你：在吗/)
  turnStart('work', /^第 \d+ 轮开始（模拟接口 \/ gpt-fast）：对话线交给你的（这一句是它写的）：在吗/)
  turnStart('work', /^第 \d+ 轮开始（模拟接口 \/ 思考版）：对话线交给你的（这一句是它写的）：还在吗/)
  turnStart('talk', /^第 \d+ 轮开始（talk \/ talk-e2e）：干活线汇报：还在/)
  assert.ok(log.includes('在面板上把干活线的模型换成了 模拟接口 / 思考版，下一轮起生效。'))

  // 5. 添加模型时可以问接口它有哪些：用的是存着的 key
  llm.modelList = [{ id: 'gpt-think' }, { id: 'gpt-fast' }, { id: 'gpt-other' }]
  const remote = await call('POST', '/providers/remote-models', { id: 'mock' })
  assert.deepEqual(remote.json, { ok: true, models: [{ id: 'gpt-fast' }, { id: 'gpt-other' }, { id: 'gpt-think' }] })
  assert.equal(llm.modelListRequests[0]!.headers.authorization, 'Bearer sk-e2e-switch-key-0003')
  // 接口没有这个功能时：说明原因，不是一个 500
  llm.modelList = { status: 404, message: 'no such route' }
  const none = await call('POST', '/providers/remote-models', { id: 'mock' })
  assert.deepEqual([none.status, none.json.ok, none.json.error.status], [200, false, 404])

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：主人让它看看周围 → 它要一张简图 → 能看图的模型真的收到这张图（下一轮不再重发）；换成看不了图的模型，工具清单里就没有看图的工具了，它照旧直接调也只给文字；面板上看得到它看的图', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      version: 2,
      panel: { password: 'preset-password-for-e2e' },
      providers: [
        { id: 'ant', label: '能看图的', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'sk-e2e-vision-key-0004', models: [{ id: 'eyes', name: 'claude-eyes', vision: true }] },
        { id: 'oa', label: '只认字的', kind: 'openai-chat', baseUrl: llm.openaiBaseUrl, apiKey: 'sk-e2e-vision-key-0005', models: [{ id: 'text', name: 'gpt-text' }, { id: 'eyes', name: 'gpt-eyes', vision: true }] },
      ],
      activeProviderId: 'ant',
      activeModelId: 'eyes',
    }),
    { mode: 0o600 },
  )
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}\n--- rejected by the mock llm ---\n${JSON.stringify(llm.rejected)}`
  const origin = await waitFor('panel address', () => /面板地址：(http:\/\/127\.0\.0\.1:\d+)\//.exec(brain.output())?.[1], 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  let cookie = ''
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${origin}/api${route}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, json: (await res.json().catch(() => undefined)) as any, headers: res.headers }
  }
  cookie = (await call('POST', '/login', { password: 'preset-password-for-e2e' })).headers.getSetCookie()[0]!.split(';')[0]!
  const isPng = (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  /** 让它看一眼周围，等这一轮跑完；返回这一轮发给模型的请求。 */
  const look = async (words: string, input: Record<string, unknown>) => {
    const before = llm.requests.length
    llm.enqueue({ toolCalls: [{ name: 'view_area', input }] }, { toolCalls: [{ name: 'report', input: { text: '看到了' } }] }, { text: '' })
    bridge.whisper('Alu', 'Steve', words)
    await waitFor(`turn "${words}" finished`, () => llm.requests.length === before + 3, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
    return llm.requests.slice(before)
  }

  // 1. Anthropic 兼容、能看图：身体被问到了那个盒子，图放在 tool_result 里发给了模型（模拟服务像真实接口那样检查过这张图）
  const first = await look('看看你周围', { radius: 6 })
  assert.deepEqual(llm.rejected, [], diag())
  // bot 站在 (10, 64, -4)：四周各 6 格，脚下 3 层，往上 8 层
  assert.deepEqual(bridge.requestsOf('world.blocks'), [{ x1: 4, z1: -10, x2: 16, z2: 2, y1: 61, y2: 72, dim: 0 }])
  assert.deepEqual(first.map((r) => imagesInRequest(r).length), [0, 1, 1])
  const sent = imagesInRequest(first[1]!)[0]!
  assert.equal(sent.mediaType, 'image/png')
  assert.ok(isPng(sent.bytes) && sent.bytes.length > 1000)
  const result = first[1]!.body.messages.at(-1).content[0]
  assert.equal(result.type, 'tool_result')
  assert.match(result.content[0].text, /^Picture of x 4\.\.16, y 61\.\.72, z -10\.\.2 \(13×12×13 blocks\): iso view from the southeast corner/)
  // 假世界里 y=64 是草地、往下是石头，bot 旁边有箱子和机器；自己被标在图上
  assert.match(result.content[0].text, /- the magenta marker is you \(Alu\)/)
  // （草地那一层有 4 格是箱子、抽屉、工作台和机器）
  assert.match(result.content[0].text, /- 507× minecraft:stone \(gray\)\n- 165× minecraft:grass \(green top, brown sides\)\n/)
  assert.match(result.content[0].text, /- 1× gregtech:gt\.blockmachines \([a-z ]+; colour made up, not its real colour\)/)
  assert.deepEqual(result.content[1].source.media_type, 'image/png')

  // 2. 下一轮：之前那张图不再发，原处是一句占位文字；这一轮新要的图照常发
  const second = await look('再从上面看看', { radius: 6, view: 'top' })
  assert.deepEqual(llm.rejected, [], diag())
  assert.deepEqual(second.map((r) => imagesInRequest(r).length), [0, 1, 1])
  assert.equal(JSON.stringify(second[0]!.body).includes(sent.bytes.toString('base64').slice(0, 300)), false)
  assert.match(JSON.stringify(second[0]!.body), /\[picture seen earlier, no longer attached: iso view from the southeast corner of the world at x 4\.\.16, y 61\.\.72, z -10\.\.2\./)

  // 3. 面板上：对话日志里这两条结果各带一张图，按编号取得到，就是发给模型的那张
  const entries = ((await call('GET', '/log')).json.entries as { kind: string; who?: string; pictures?: string[] }[]).filter((e) => e.kind === 'tool_result' && e.who === 'view_area')
  assert.deepEqual(entries.map((e) => e.pictures?.length), [1, 1])
  const shown = await fetch(`${origin}/api/pictures/file?id=${entries[0]!.pictures![0]}`, { headers: { cookie } })
  assert.equal(shown.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await shown.arrayBuffer()), sent.bytes)

  // 能看图的模型，工具清单里有看图的三个
  const namesIn = (request: (typeof first)[number]): string[] => (request.body.tools as { name?: string; function?: { name: string } }[]).map((tool) => tool.name ?? tool.function!.name)
  assert.deepEqual(['view_area', 'view_image', 'view_draft'].map((name) => namesIn(first[0]!).includes(name)), [true, true, true])

  // 4. 换成看不了图的模型（OpenAI 兼容）：工具清单里没有 view_area、view_image 了（view_draft 留着，只出文字）；
  //    它照旧习惯直接调 view_area 也照常执行，只给文字，请求里一张图都没有
  assert.equal((await call('POST', '/models/use', { providerId: 'oa', modelId: 'text' })).status, 200)
  const blind = await look('现在呢', { radius: 6 })
  assert.deepEqual(['view_area', 'view_image', 'view_draft'].map((name) => namesIn(blind[0]!).includes(name)), [false, false, true])
  assert.deepEqual(llm.rejected, [], diag())
  assert.deepEqual(blind.map((r) => [r.api, imagesInRequest(r).length]), [['openai', 0], ['openai', 0], ['openai', 0]])
  const words = blind[1]!.body.messages.at(-1)
  assert.equal(words.role, 'tool')
  assert.match(words.content, /^No picture is attached: the model you are running on cannot see pictures/)
  assert.match(words.content, /\nLayer by layer, from the bottom up:\ny=61\.\.63: 169 of 169 cells filled: 169 stone\n/)

  // 5. 同一家换成能看图的那个模型：OpenAI 的写法是图放在紧跟工具结果的一条 user 消息里
  assert.equal((await call('POST', '/models/use', { providerId: 'oa', modelId: 'eyes' })).status, 200)
  const again = await look('再看一眼', { radius: 6, view: 'side', from: 'south' })
  assert.deepEqual(llm.rejected, [], diag())
  assert.deepEqual(again.map((r) => imagesInRequest(r).length), [0, 1, 1])
  const tail = again[1]!.body.messages.slice(-2)
  assert.deepEqual([tail[0].role, tail[1].role, tail[1].content.map((part: { type: string }) => part.type)], ['tool', 'user', ['text', 'image_url']])
  assert.match(tail[0].content, /\[The picture is in the next message\.\]$/)

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
  // 落盘的历史里没有任何一张图的内容
  const history = fs.readFileSync(path.join(tmp.dir, 'history.json'), 'utf8')
  assert.equal(history.includes('iVBORw0KGgo'), false)
  assert.ok(history.includes('picture seen earlier, no longer attached'))
})

it('端到端：只有机器配方的东西（钢杆）→ 它查配方、找机器、取料、用车床加工 → 取回产物后告诉主人；没电的机器开不了工', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }],
      activeProviderId: 'mock',
    }),
    { mode: 0o600 },
  )
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const seen = (n: number) => JSON.stringify(llm.requests[n]!.body.messages.at(-1))
  const GT = 'gregtech:gt.metaitem.01'
  const chest = bridge.containers[0]!
  const lathe = bridge.machines.find((m) => m.recipes === 'Lathe')!
  const assembler = bridge.machines.find((m) => m.recipes === 'Assembler')!

  // 1. 查配方 → 找车床 → 取两个钢锭、排上加工
  llm.enqueue(
    { toolCalls: [{ name: 'find_recipes', input: { id: GT, meta: 23305 } }] },
    { toolCalls: [{ name: 'find_machines', input: {} }] },
    {
      toolCalls: [
        { name: 'withdraw_items', input: { container: { x: chest.x, y: chest.y, z: chest.z }, items: [{ id: GT, meta: 11305, count: 2 }] } },
        { name: 'process_items', input: { machine: { x: lathe.x, y: lathe.y, z: lathe.z }, inputs: [{ id: GT, meta: 11305, count: 2 }], queue: true } },
      ],
    },
    { text: '' },
  )
  bridge.whisper('Alu', 'Steve', '车两根钢杆')
  await waitFor('first turn finished', () => llm.requests.length === 4, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.match(seen(1), /Lathe, LV \(16 EU\/t\), 8 s: 1× gregtech:gt\.metaitem\.01\/11305 \\"Steel Ingot\\" -> 1× gregtech:gt\.metaitem\.01\/23305 \\"Steel Rod\\" \+ 2× gregtech:gt\.metaitem\.01\/1305 \\"Small Pile of Steel Dust\\"/)
  assert.match(seen(2), /- \(16,64,-4\) \\"Advanced Lathe\\": runs Lathe recipes, tier MV, has power \(51200 EU stored\), idle, 6 blocks away/)
  assert.match(seen(2), /- \(18,64,-4\) \\"Basic Assembling Machine\\": runs Assembler recipes, tier LV, NO POWER \(0 EU stored\), idle/)
  assert.deepEqual(
    bridge.requestsOf('task.start').map((p) => p.task),
    [
      { type: 'withdraw', container: { x: chest.x, y: chest.y, z: chest.z }, items: [{ id: GT, meta: 11305, count: 2 }] },
      { type: 'process', machine: { x: lathe.x, y: lathe.y, z: lathe.z }, inputs: [{ id: GT, meta: 11305, count: 2 }] },
    ],
  )

  // 2. 取料做完就轮到加工（取料结束的消息它这一轮里就看到了）；车床做完，它被叫醒，看到取回了什么
  await waitFor('the goal turn finished', () => llm.requests.length === 4, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.equal(bridge.bots.get('Alu')?.task?.type, 'process')
  llm.enqueue(
    // 再拿这两根钢杆去没电的组装机试一下：开不了工。任务当场失败，这个消息它紧接着就看到（赶上这一轮的哪一步算哪一步，
    // 赶不上就是为它再醒一次），它告诉主人
    { toolCalls: [{ name: 'process_items', input: { machine: { x: assembler.x, y: assembler.y, z: assembler.z }, inputs: [{ id: GT, meta: 23305, count: 2 }] } }] },
    { toolCalls: [{ name: 'report', input: { text: '钢杆车好了两根；组装机没电，开不了。' } }] },
    { text: '' },
  )
  llm.fallback = () => ({ text: '' })
  bridge.completeTask('Alu')
  await waitFor('second process task ended', () => bridge.bots.get('Alu')?.recent.some((x) => x.id === 't3'), 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.match(seen(4), /任务 t2（process）完成了。 结果：put 2 item\(s\) into the machine; took out: 2× gregtech:gt\.metaitem\.01\/23305 \\"Steel Rod\\", 4× gregtech:gt\.metaitem\.01\/1305 \\"Small Pile of Steel Dust\\"; freeSlots \d+/)

  // 3. 没电的机器：任务以 invalid 失败，它看到机器状态，告诉主人
  await waitFor('brain told Steve', () => bridge.commandLog.length === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('the turn finished', () => llm.requests.length >= 7, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  // 失败的消息只到干活线，而且只出现一次：接在它某一步的工具结果后面，或者这一轮已经结束、为它再醒一次
  const newest = (): string[] => llm.requests.map((_, n) => seen(n)).filter((text) => /任务 t3（process）失败了/.test(text))
  await waitFor('the failure reached the worker', () => newest().length > 0, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const failed = newest()[0]!
  assert.equal(llm.requests.filter((_, n) => seen(n).includes('任务 t3（process）失败了') && seen(n).includes('需要你处理的事')).length, 1)
  assert.equal(talk.requests.some((r) => JSON.stringify(r.body.messages).includes('任务 t3')), false)
  assert.match(failed, /需要你处理的事/)
  assert.match(failed, /任务 t3（process）失败了：invalid — the machine did not start/)
  assert.match(failed, /machine \\"Basic Assembling Machine\\" at \(18,64,-4\): runs Assembler recipes, tier LV, NO POWER \(0 EU stored\), idle\. It has no power/)
  // 原料拿回来了：两根钢杆还在身上，钢锭用掉了
  const carried = (meta: number) => bridge.bots.get('Alu')!.inventory.filter((i) => i.id === GT && i.meta === meta).reduce((n, i) => n + i.count, 0)
  assert.deepEqual([carried(23305), carried(1305), carried(11305)], [2, 4, 0])

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：主人指着一个箱子说“把抽屉管理器管着的、不到 128 个的东西都搬到这个箱子里” → 它看清哪个箱子没接管道、写一行程序调库函数列出不到 128 的格子、写一个例程一样样搬 → 例程在后台跑完才把它叫醒 → 东西真的搬过去了', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  // 一个抽屉管理器管着两组抽屉（四格里两格不到 128 个）；两个压缩箱子，远的那个接着管道
  const CHEST = { x: 12, y: 64, z: -4 }
  const CONTROLLER = { x: 14, y: 66, z: -6 }
  bridge.containers = [
    { ...CHEST, id: 'IronChest:BlockIronChest', name: 'Compressed Chest', slots: 243, items: [] },
    { x: 6, y: 66, z: -6, id: 'IronChest:BlockIronChest', name: 'Compressed Chest', slots: 243, items: [], attached: [{ x: 6, y: 66, z: -7, name: 'Brass Item Pipe', kind: 'item pipe' }] },
    { ...CONTROLLER, id: 'StorageDrawers:controller', name: 'Drawer Controller', slots: 0, kind: 'drawer_controller', items: [] },
    {
      x: 15, y: 64, z: -6, id: 'StorageDrawers:fullDrawers2', name: 'Oak Drawers 1x2', slots: 2, kind: 'drawers',
      items: [{ id: 'minecraft:coal', meta: 0, count: 40, name: 'Coal' }, { id: 'minecraft:cobblestone', meta: 0, count: 12800, name: 'Cobblestone' }],
    },
    {
      x: 16, y: 64, z: -6, id: 'StorageDrawers:fullDrawers2', name: 'Oak Drawers 1x2', slots: 2, kind: 'drawers',
      items: [{ id: 'gregtech:gt.metaitem.01', meta: 11305, count: 7, name: 'Steel Ingot' }, { id: 'minecraft:redstone', meta: 0, count: 128, name: 'Redstone' }],
    },
  ]
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(path.join(tmp.dir, 'config.json'), JSON.stringify({ providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }], activeProviderId: 'mock' }), { mode: 0o600 })
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const seen = (n: number): string => {
    const last = llm.requests[n]!.body.messages.at(-1)
    return (last.content as { type: string; text?: string; content?: unknown }[]).map((b) => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join('\n')
  }

  // 例程的程序就是 routines 手册里的那个例子，只把两个坐标换成这里的
  const manual = fs.readFileSync(path.join(BRAIN_ROOT, 'manuals', 'routines.md'), 'utf8')
  const example = /# 例子：把抽屉里不到 128 个的东西都搬到一个箱子里\n```js\n([\s\S]*?)```/.exec(manual)?.[1]
  assert.ok(example, 'the routines manual has the example')
  const code = example.replace(/const controller = \{[^}]*\}/, `const controller = ${JSON.stringify(CONTROLLER)}`).replace(/const chest = \{[^}]*\}/, `const chest = ${JSON.stringify(CHEST)}`)
  assert.notEqual(code, example)

  // 1. 一轮里：看附近的容器 → 看抽屉管理器管着的、不到 128 的格子 → 启动例程 → 结束这一轮。
  //    list_drawers 是库函数，不在它的工具清单里：它照 run_program 说明后面的索引，写一行程序调
  llm.enqueue(
    { toolCalls: [{ name: 'list_containers', input: {} }] },
    { toolCalls: [{ name: 'run_program', input: { code: `return (await tool("list_drawers", ${JSON.stringify({ ...CONTROLLER, below: 128 })})).text` } }] },
    { toolCalls: [{ name: 'start_routine', input: { code, name: '整理抽屉' } }] },
    { text: '' },
  )
  // 2. 例程跑完把它叫醒：告诉主人
  llm.enqueue({ toolCalls: [{ name: 'report', input: { text: '搬完了，两样。' } }] }, { text: '' })
  bridge.whisper('Alu', 'Steve', '把抽屉管理器管着的、不到 128 个的东西都搬到这个箱子里')
  await waitFor('told the owner', () => bridge.commandLog.some((c) => c.command.includes('搬完了，两样。')), 20_000).catch((e) => assert.fail(`${e.message}\n${llm.requests.map((_, n) => seen(n)).join('\n---\n')}${diag()}`))

  // 主人指着的是近处那个没接管道的箱子；另一个接着管道，消息里写明了
  assert.match(seen(0), /Steve 站在 \(12,64,3\) 面朝北，指着 Compressed Chest \(12,64,-4\)［容器］；面前还有：/)
  assert.match(seen(0), /Compressed Chest \(6,66,-6\)［容器］（接着Brass Item Pipe）/)
  assert.match(seen(1), /\n- \(6,66,-6\) Compressed Chest \[IronChest:BlockIronChest\] 0\/243 slots used \(AUTOMATED: Brass Item Pipe at \(6,66,-7\) feeds or drains it\): empty/)
  // 它拿到的工具清单里没有 list_drawers；它是从 run_program 说明后面的库函数索引、和 list_containers 的结果里知道有这个函数的
  const offered = llm.requests[0]!.body.tools as { name: string; description: string }[]
  assert.equal(offered.some((tool) => tool.name === 'list_drawers'), false)
  assert.match(offered.find((tool) => tool.name === 'run_program')!.description, /\n- list_drawers \{x, y, z, below\?, page\?\}: /)
  assert.match(seen(1), /\n- \(14,66,-6\) Drawer Controller \[StorageDrawers:controller\] \[drawer controller\] 4\/4 drawer slots used \(manages 2 drawer block\(s\); the library function list_drawers lists what they hold, given this position\)/)
  assert.deepEqual(seen(2).split('\n').slice(1), [
    'Returned: The drawer controller at (14,66,-6) manages 2 drawer block(s): 4 of 4 slots hold something. 2 slots holding fewer than 128:',
    '- (15,64,-6) slot 0: 40× Coal [minecraft:coal], room for 2008 more',
    '- (16,64,-6) slot 0: 7× Steel Ingot [gregtech:gt.metaitem.01/11305], room for 2041 more',
  ])
  assert.match(seen(3), /^Routine r1 \("整理抽屉"\) started in the background\. It may run for up to 120 minutes\. It runs on its own: when it finishes, fails or is stopped, its outcome and log come to you by themselves/)

  // 例程自己一步步做：取一样放一样。四个任务一个都没有单独把模型叫醒，模型一共只被叫了两轮
  assert.deepEqual(
    bridge.requestsOf('task.start').map((p) => p.task),
    [
      { type: 'withdraw', container: { x: 15, y: 64, z: -6 }, items: [{ id: 'minecraft:coal', meta: 0, count: 40 }] },
      { type: 'deposit', container: CHEST, items: [{ id: 'minecraft:coal', meta: 0 }] },
      { type: 'withdraw', container: { x: 16, y: 64, z: -6 }, items: [{ id: 'gregtech:gt.metaitem.01', meta: 11305, count: 7 }] },
      { type: 'deposit', container: CHEST, items: [{ id: 'gregtech:gt.metaitem.01', meta: 11305 }] },
    ],
  )
  await waitFor('second turn finished', () => llm.requests.length === 6, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const woken = seen(4)
  assert.match(woken, /你启动的例程有结果了/)
  assert.match(woken, /Routine r1 \("整理抽屉"\) finished: the program finished\. 5 tool call\(s\), 4 task\(s\), \d+ s in all\.\nIt returned: 搬完 2 格\n/)
  assert.match(woken, /Its log \(last 1 line\(s\)\):\n {2}要搬 2 格/)
  assert.equal(llm.requests.some((_, n) => /任务 t\d+（(withdraw|deposit)）/.test(seen(n))), false, 'no task of the routine woke the model by itself')

  // 游戏里：不到 128 的两样进了主人指的箱子，够数的两样还在抽屉里，身上没留下
  const chest = bridge.containers[0]!
  assert.deepEqual(chest.items.map((i) => [i.id, i.meta, i.count]), [['minecraft:coal', 0, 40], ['gregtech:gt.metaitem.01', 11305, 7]])
  assert.deepEqual(bridge.containers.filter((c) => c.kind === 'drawers').map((c) => c.items.map((i) => [i.id, i.count])), [[['minecraft:cobblestone', 12800]], [['minecraft:redstone', 128]]])
  assert.equal(bridge.bots.get('Alu')!.inventory.some((i) => i.id === 'minecraft:coal' || i.meta === 11305), false)
  assert.deepEqual(bridge.containers[1]!.items, [], 'the chest with a pipe attached was left alone')

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：主人指着一个装了 102 种东西的压缩箱问“里面都有什么” → 它看附近的容器，那一行只列了前 30 种并写明怎么看全 → 它以那个箱子为中心、radius 0 再看一次，102 种一样不少', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  // 身体一个容器默认只列 60 种；要全得带 kinds（协议里 world.containers 的可选参数）
  const BIG = { x: 14, y: 64, z: -6 }
  const things = Array.from({ length: 102 }, (_, n) => ({ id: 'demo:thing', meta: n, count: 200 - n, name: `Thing ${n}` }))
  bridge.containers = [
    { x: 12, y: 64, z: -4, id: 'minecraft:chest', name: 'Chest', slots: 27, items: [{ id: 'minecraft:coal', meta: 0, count: 5, name: 'Coal' }] },
    { ...BIG, id: 'IronChest:BlockIronChest', name: 'Compressed Chest', slots: 243, items: things },
  ]
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(path.join(tmp.dir, 'config.json'), JSON.stringify({ providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }], activeProviderId: 'mock' }), { mode: 0o600 })
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const seen = (n: number): string => {
    const last = llm.requests[n]!.body.messages.at(-1)
    return (last.content as { type: string; text?: string; content?: unknown }[]).map((b) => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join('\n')
  }

  llm.enqueue(
    { toolCalls: [{ name: 'list_containers', input: {} }] },
    { toolCalls: [{ name: 'list_containers', input: { at: BIG, radius: 0 } }] },
    { toolCalls: [{ name: 'report', input: { text: '一共 102 种，最多的是 Thing 0（200 个）。' } }] },
    { text: '' },
  )
  bridge.whisper('Alu', 'Steve', '那个压缩箱里都有什么')
  await waitFor('told the owner', () => bridge.commandLog.some((c) => c.command.includes('一共 102 种')), 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))

  // 第一次看附近：大箱子那一行列到第 30 种为止，写明还有 72 种，结果末尾写着怎么看全
  const around = seen(1).split('\n')
  assert.match(around.find((line) => line.includes('Compressed Chest'))!, /102\/243 slots used: 200× demo:thing "Thing 0", .*, 171× demo:thing\/29 "Thing 29", … and 72 more kinds$/)
  assert.equal(around.at(-1), 'Where a line ends in "… more kinds", the rest is not shown here: list_containers with "at" that container and radius 0 lists everything in it (in a program, r.data.containers has every kind).')
  // 第二次只看这一个：102 种都在，没有“还有没列的”
  const whole = seen(2).split('\n')
  assert.deepEqual([whole.length, whole[0]], [2, 'Within 0 blocks of (14,64,-6): 1 container(s).'])
  assert.equal(whole[1]!.split(': ')[1]!.split(', ').length, 102)
  assert.match(whole[1]!, /, 99× demo:thing\/101 "Thing 101"$/)
  assert.doesNotMatch(seen(2), /more kinds/)
  // 向身体要的：两次都要每个容器的全部（kinds），第二次以那个箱子为中心、radius 0
  assert.deepEqual(bridge.requestsOf('world.containers').map((p) => [p.radius, p.kinds, p.x ?? p.bot]), [[16, 2000, 'Alu'], [0, 2000, 14]])

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：主人说“做一个小背包，做好后把圆石放进去” → 它照本地配方册手工合成 → 右键试了一下新做的包 → 把圆石放进身上的包里（不用走到哪个箱子）→ 告诉主人', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  const RING = { id: 'gregtech:gt.metaitem.01', meta: 28305 }
  // 仓库里有做小背包的料；服务器上这条配方是：5 鞣制皮革 + 3 织棉 + 1 钢环
  bridge.containers[0]!.items.push(
    { id: 'Backpack:tannedLeather', meta: 0, count: 8, name: 'Tanned Leather' },
    { id: 'harvestcraft:wovencottonItem', meta: 0, count: 5, name: 'Woven Cotton' },
    { ...RING, count: 2, name: 'Steel Ring' },
  )
  bridge.recipeBook.push({
    id: 'Backpack:backpack',
    meta: 0,
    name: 'Backpack',
    crafting: [{ gives: 1, grid: '3x3', ingredients: [{ count: 5, id: 'Backpack:tannedLeather', meta: 0 }, { count: 3, id: 'harvestcraft:wovencottonItem', meta: 0 }, { count: 1, ...RING }] }],
  })
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(path.join(tmp.dir, 'config.json'), JSON.stringify({ providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }], activeProviderId: 'mock' }), { mode: 0o600 })
  // 本地的小配方册：只有这一条
  const packdata = path.join(tmp.dir, 'packdata')
  fs.mkdirSync(packdata)
  fs.writeFileSync(
    path.join(packdata, 'items.jsonl'),
    [
      { id: 'Backpack:backpack', meta: 0, name: '小背包', en: 'Backpack' },
      { id: 'Backpack:tannedLeather', meta: 0, name: '鞣制皮革', en: 'Tanned Leather' },
      { id: 'harvestcraft:wovencottonItem', meta: 0, name: '织棉', en: 'Woven Cotton' },
      { ...RING, name: '钢环', en: 'Steel Ring', ores: ['ringSteel'] },
      { id: 'minecraft:cobblestone', meta: 0, name: '圆石', en: 'Cobblestone' },
    ]
      .map((i) => JSON.stringify(i))
      .join('\n'),
  )
  fs.writeFileSync(path.join(packdata, 'handlers.json'), JSON.stringify([{ key: 'codechicken.nei.recipe.ShapedRecipeHandler', name: '有序合成', grid: true, machines: [], recipes: 1, read: 'all' }]))
  const leather = (g: number) => ({ id: 'Backpack:tannedLeather', meta: 0, n: 1, g })
  const cotton = (g: number) => ({ id: 'harvestcraft:wovencottonItem', meta: 0, n: 1, g })
  fs.writeFileSync(
    path.join(packdata, 'recipes.jsonl'),
    `${JSON.stringify({ h: 'codechicken.nei.recipe.ShapedRecipeHandler', in: [leather(0), cotton(1), leather(2), leather(3), { ...RING, n: 1, g: 4 }, leather(5), leather(6), cotton(7), cotton(8)], out: [{ id: 'Backpack:backpack', meta: 0, n: 1 }] })}\n`,
  )
  const brain = startBrain(tmp.dir, bridge, { packdata, talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const seen = (n: number): string => {
    const last = llm.requests[n]!.body.messages.at(-1)
    return (last.content as { type: string; text?: string; content?: unknown }[]).map((b) => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join('\n')
  }
  const all = () => llm.requests.map((_, n) => seen(n)).join('\n---\n')
  const chest = bridge.containers[0]!
  const at = { x: chest.x, y: chest.y, z: chest.z }
  const BAG = { id: 'Backpack:backpack' }

  // 1. 查做法、取料、合成（后一步排队）
  llm.enqueue(
    { toolCalls: [{ name: 'find_recipes', input: { id: 'Backpack:backpack' } }] },
    {
      toolCalls: [
        { name: 'withdraw_items', input: { container: at, items: [{ id: 'Backpack:tannedLeather', count: 5 }, { id: 'harvestcraft:wovencottonItem', count: 3 }, { ...RING, count: 1 }] } },
        { name: 'craft_item', input: { recipe: 0, queue: true } },
      ],
    },
    { text: '' },
  )
  bridge.whisper('Alu', 'Steve', '做一个小背包，做好后把圆石放进去')
  await waitFor('the goal turn finished', () => llm.requests.length === 3, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.match(seen(1), /\n {3}#0: 5× 鞣制皮革 \[Backpack:tannedLeather\] \+ 3× 织棉 \[harvestcraft:wovencottonItem\] \+ 1× 钢环 \[gregtech:gt\.metaitem\.01\/28305\] → 1× 小背包 — needs a crafting table \(3x3\)/)
  assert.equal(bridge.bots.get('Alu')?.task?.type, 'craft', `the craft task is running${diag()}`)

  // 2. 合成做完 → 右键用一下这个包（看它是什么）→ 知道它能打开 → 把圆石放进包里 → 告诉主人。
  //    模拟的身体里这两个任务都是立刻做完的：结果接在那一步的工具结果后面，它一轮里接着往下做
  llm.enqueue(
    { toolCalls: [{ name: 'use_item', input: BAG }] },
    { toolCalls: [{ name: 'deposit_items', input: { bag: BAG, items: [{ id: 'minecraft:cobblestone', count: 64 }] } }] },
    { toolCalls: [{ name: 'report', input: { text: '小背包做好了，圆石放进去了。' } }] },
    { text: '' },
  )
  bridge.completeTask('Alu')
  await waitFor('told the owner', () => bridge.commandLog.some((c) => c.command.includes('小背包做好了')), 15_000).catch((e) => assert.fail(`${e.message}\n${all()}${diag()}`))
  assert.match(all(), /任务 t2（craft）完成了。 结果：crafted 1× Backpack:backpack "小背包", freeSlots \d+/)
  // 右键用了以后看得见的变化：没多没少，打开过一个界面
  assert.match(all(), /任务 t3（use）完成了。 结果：used "小背包"; gained: nothing; lost: nothing; it opened a screen, which was closed again: to put things in or take them out, use deposit_items \/ withdraw_items with "bag"; health 20; food 20; freeSlots \d+/)
  assert.match(all(), /任务 t4（deposit）完成了。 结果：\{"moved":64,"freeSlots":\d+\}/)
  // 交给身体的任务：包是“我身上这件东西右键打开的界面”，不是一个位置
  assert.deepEqual(
    bridge.requestsOf('task.start').slice(2).map((p) => p.task),
    [
      { type: 'use', item: BAG },
      { type: 'deposit', container: { item: BAG }, items: [{ id: 'minecraft:cobblestone', count: 64 }] },
    ],
  )
  // 游戏里：包在身上，64 个圆石在包里，身上没有圆石了
  const inventory = bridge.bots.get('Alu')!.inventory
  assert.equal(inventory.filter((i) => i.id === 'Backpack:backpack').reduce((n, i) => n + i.count, 0), 1)
  assert.equal(inventory.some((i) => i.id === 'minecraft:cobblestone'), false)
  assert.deepEqual(bridge.bags.get('Backpack:backpack'), [{ id: 'minecraft:cobblestone', meta: 0, name: 'Cobblestone', count: 64 }])

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：例程在后台跑的时候，主人在面板概览页看得到它做到哪一步，点“停止例程” → 例程停下、它正在做的任务被取消、它被叫醒时知道是主人停的', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({ panel: { password: 'preset-password-for-e2e' }, providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }], activeProviderId: 'mock' }),
    { mode: 0o600 },
  )
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  const origin = await waitFor('panel address', () => /面板地址：(http:\/\/127\.0\.0\.1:\d+)\//.exec(brain.output())?.[1], 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  let cookie = ''
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${origin}/api${route}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, json: (await res.json().catch(() => undefined)) as any, headers: res.headers }
  }
  cookie = (await call('POST', '/login', { password: 'preset-password-for-e2e' })).headers.getSetCookie()[0]!.split(';')[0]!
  const seen = (n: number): string => {
    const last = llm.requests[n]!.body.messages.at(-1)
    return (last.content as { type: string; text?: string; content?: unknown }[]).map((b) => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join('\n')
  }

  // 1. 它启动一个例程：走一段路（模拟的身体里，走路的任务要等人喊完成才结束，所以例程会一直等在这一步）
  llm.enqueue({ toolCalls: [{ name: 'start_routine', input: { code: `log('出发'); await tool('go_to', { x: 40, z: 40 }); return '到了'`, name: '走一趟' } }] }, { text: '' })
  bridge.whisper('Alu', 'Steve', '去那边转一圈')
  await waitFor('the routine started walking', () => bridge.bots.get('Alu')?.task?.type === 'goto', 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))

  // 2. 面板概览页：例程在跑，正等着哪一步、是哪个任务，程序的日志
  let shown: any
  // 概览有短暂的缓存，例程记下任务编号也要一拍：等到面板上看得到它正等着的那个任务
  for (let n = 0; n < 50 && shown?.current?.taskId !== 't1'; n++) {
    if (n > 0) await new Promise((r) => setTimeout(r, 100))
    shown = (await call('GET', '/overview')).json.agent.routine
  }
  assert.ok(shown?.current, `the panel shows the routine and the step it waits for: ${JSON.stringify(shown)}${diag()}`)
  assert.deepEqual(
    { id: shown.id, name: shown.name, status: shown.status, calls: shown.calls, actions: shown.actions, tool: shown.current.tool, task: shown.current.taskId, logs: shown.logs },
    { id: 'r1', name: '走一趟', status: 'running', calls: 1, actions: 1, tool: 'go_to', task: 't1', logs: ['出发'] },
  )

  // 3. 主人点“停止例程”：例程停下，它正在做的任务被取消；它被叫醒，知道是主人停的
  llm.enqueue({ toolCalls: [{ name: 'report', input: { text: '好，不走了。' } }] }, { text: '' })
  assert.deepEqual((await call('POST', '/routine/stop', {})).json, { stopped: true })
  await waitFor('told the owner', () => bridge.commandLog.some((c) => c.command.includes('好，不走了。')), 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.deepEqual(bridge.requestsOf('task.cancel'), [{ bot: 'Alu', id: 't1' }])
  assert.equal(bridge.bots.get('Alu')?.task, null)
  await waitFor('wake turn finished', () => llm.requests.length === 4, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.match(seen(2), /你启动的例程有结果了/)
  assert.match(seen(2), /Routine r1 \("走一趟"\) was STOPPED: your owner stopped it on the control panel\. 1 tool call\(s\), 1 task\(s\)/)
  // 被取消的那个任务只是背景，没有另外再把它叫醒一轮（上面等到的就是一共四次模型调用）
  assert.match(seen(2), /\[最近发生的事（只是背景，不需要回应）\]\n\[[\d:]+\] 任务 t1（goto）被取消了。/)
  const after = (await call('GET', '/overview')).json.agent.routine
  assert.deepEqual([after.status, after.ending], ['stopped', 'your owner stopped it on the control panel'])
  // 没有在跑的了
  assert.deepEqual((await call('POST', '/routine/stop', {})).json, { stopped: false })

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：主人说“做一个直升机桨叶” → 它自己一层层查做法、查库存，自己挑 → 查到模头（杆）没有库存也没有配方，卡住了：把查到的链作为提问交给对话线，由它问主人 → 主人说压模机里有一个，这句话原样带回给它 → 它把这条做法写成自己的手册，从压模机原料格里取出来，接着做完', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'], autoFinishMs: 30 })
  const llm = new MockLlm()
  const talk = relayTalk()
  // 基地：仓库里钢锭、玄钢板、螺丝、齿轮、螺丝刀、锤都有，就是没有模头（杆）；压模机的原料格里放着主人的一个
  installMockBase(bridge, [stack(P.steelIngot, 40), stack(P.steelScrew, 3), stack(P.steelGear, 1), stack(P.darkPlate, 4), stack(P.screwdriver, 1), stack(P.hammer, 1)], {}, [stack(P.rodShape, 1)])
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(path.join(tmp.dir, 'config.json'), JSON.stringify({ providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }], activeProviderId: 'mock' }), { mode: 0o600 })
  const packdata = path.join(tmp.dir, 'packdata')
  writePlanFixture(packdata)
  const brain = startBrain(tmp.dir, bridge, { packdata, talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const at = (m: { x: number; y: number; z: number }) => ({ x: m.x, y: m.y, z: m.z })
  const EXTRUDER_AT = at(bridge.machines.find((m) => m.name === 'Advanced Extruder')!)
  const CHEST_AT = at(bridge.containers[0]!)

  // 模型：没有谁替它排好路线。它一层层查（查做法 → 查库存 → 缺的再查做法），每一步看了结果再决定下一步。
  // 脚本按顺序写着“看到什么 → 做什么”；看到的不是下一条等着的，就什么都不做。
  const call = (name: string, input: unknown) => ({ toolCalls: [{ name, input }] })
  const say = (message: string) => call('report', { text: message })
  const ask = (message: string) => call('report', { text: message, question: true })
  const done = /任务 \w+（\w+）完成了/
  const script: [RegExp, ReturnType<typeof call>][] = [
    [/Steve 私聊你：做一个直升机桨叶/, call('find_recipes', P.blades)],
    // 桨叶：4 精炼铁柄 + 3 钢螺丝 + 钢齿轮，要螺丝刀 → 这几样库存里有没有
    [/^直升机桨叶 \[/, call('find_in_storage', { items: [P.shaft, P.steelScrew, P.steelGear, { ore: 'craftingToolScrewdriver' }] })],
    // 柄没有 → 查柄怎么做
    [/IC2:itemRecipePart\/12[^\n]*: none in storage here/, call('find_recipes', P.shaft)],
    // 压模机，9 钢锭一根，要模头（转轴）→ 查钢锭和模头（转轴）
    [/^精炼铁柄 \[/, call('find_in_storage', { items: [P.steelIngot, P.shaftShape] })],
    [/miscutils:MU-metaitem\.01\/32040[^\n]*: none in storage here/, call('find_recipes', P.shaftShape)],
    // 模头（转轴）：手工，4 玄钢板 + 模头（杆），要锤 → 查这三样
    [/^模头（转轴） \[/, call('find_in_storage', { items: [P.darkPlate, P.rodShape, { ore: 'craftingToolHardHammer' }] })],
    // 模头（杆）库存里没有 → 查它怎么做
    [/gregtech:gt\.metaitem\.01\/32351[^\n]*: none in storage here/, call('find_recipes', P.rodShape)],
    // 没有配方。卡住了：把查到的链、卡在哪作为提问送给对话线（它在等回答），由对话线去问主人
    [/模头（杆） \[gregtech:gt\.metaitem\.01\/32351\]/, ask('查到这了：桨叶要 4 根精炼铁柄，柄用压模机做、要模头（转轴），模头（转轴）要 4 玄钢板加 1 个模头（杆）。模头（杆）仓库里没有，配方册里也没有做法。卡在这，你那有现成的吗？')],
    // 主人教了：记成自己的手册，然后照他说的去取
    [/Steve 私聊你：压模机里有一个/, call('write_manual', { name: '模具从哪来', when: '缺模具、模头的时候', text: '主人说：缺模头时先看压模机的原料格里有没有（withdraw_items 给压模机的坐标，带 fromInputs）。那是他留在机器里的，拿之前问他。' })],
    [/^Saved as your manual "模具从哪来"/, call('withdraw_items', { container: EXTRUDER_AT, items: [stack(P.rodShape, 1)], fromInputs: true })],
    [done, call('withdraw_items', { container: CHEST_AT, items: [stack(P.darkPlate, 4), stack(P.hammer, 1), stack(P.steelIngot, 36), stack(P.steelScrew, 3), stack(P.steelGear, 1), stack(P.screwdriver, 1)] })],
    [done, call('craft_item', { recipe: R.shaftShape })],
    [done, call('process_items', { machine: EXTRUDER_AT, recipe: R.shaft, rounds: 4, wait: 400 })],
    [done, call('craft_item', { recipe: R.blades })],
    [done, say('直升机桨叶做好了。')],
  ]
  const seen: string[] = []
  let next = 0
  llm.fallback = (req) => {
    const last = req.body.messages.at(-1)
    const text = (last.content as { type: string; text?: string; content?: unknown }[]).map((b) => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join('\n')
    seen.push(text)
    if (next < script.length && script[next]![0].test(text)) return script[next++]![1]
    return { text: '' }
  }

  // 1. 它自己查到底，卡在模头（杆）上，问了主人；这之前一个任务都没开
  bridge.whisper('Alu', 'Steve', '做一个直升机桨叶')
  await waitFor('it asked the owner', () => bridge.commandLog.some((c) => c.command.includes('卡在这')), 20_000).catch((e) => assert.fail(`${e.message}\n(script stopped at step ${next})\n${seen.at(-1)}${diag()}`))
  assert.equal(bridge.requestsOf('task.start').length, 0, 'nothing is started before the owner answers')
  // 问的话里是它查到的那条链和卡住的那一样，用的是工具给的中文名
  assert.match(bridge.commandLog.at(-1)!.command, /精炼铁柄.*模头（转轴）.*模头（杆）仓库里没有，配方册里也没有做法/)
  // 这句话是干活线作为提问送给对话线的（它自己不对玩家说话），对话线替它说给了主人
  assert.ok(talk.requests.some((r) => /干活线提问（它在等回答，用 tell_worker 带话给它）：查到这了/.test(JSON.stringify(r.body.messages.at(-1)))))
  assert.ok(seen.some((x) => x.startsWith('Sent to the talk line as a question.')))
  // 工具告诉它的是事实，没有替它挑：柄那一层写着压模机在哪、什么状况
  assert.match(seen.find((x) => x.startsWith('精炼铁柄 ['))!, /\n1\. 压模机 — 1 recipe\(s\); CAN RUN NOW on 进阶压模机 at \(18,64,-8\) MV\n/)

  // 2. 主人教了它一句：它记成自己的手册，照着去取，接着把剩下的做完
  bridge.whisper('Alu', 'Steve', '压模机里有一个，拿出来用吧')
  await waitFor('it reported the blades done', () => bridge.commandLog.some((c) => c.command.includes('直升机桨叶做好了')), 30_000).catch((e) => assert.fail(`${e.message}\n(script stopped at step ${next})\n${seen.at(-1)}${diag()}`))
  // 主人的回答是对话线带回来的，原话附在后面；干活线的上下文连着，接着刚才卡住的地方干
  assert.ok(seen.some((x) => /对话线交给你的（这一句是它写的）：压模机里有一个，拿出来用吧\n[^\n]*\n {4}\[[\d:]+\] Steve 私聊你：压模机里有一个，拿出来用吧/.test(x)), seen.join('\n---\n'))
  assert.deepEqual(bridge.requestsOf('task.start').map((p) => (p.task as { type: string }).type), ['withdraw', 'withdraw', 'craft', 'process', 'craft'])
  assert.deepEqual(bridge.requestsOf('task.start')[0]!.task, { type: 'withdraw', container: EXTRUDER_AT, items: [stack(P.rodShape, 1)], fromInputs: true })
  assert.deepEqual([...bridge.bots.get('Alu')!.recent].reverse().map((task) => task.state), ['done', 'done', 'done', 'done', 'done'])
  const inventory = bridge.bots.get('Alu')!.inventory
  const has = (p: { id: string; meta: number }) => inventory.filter((i) => i.id === p.id && i.meta === p.meta).reduce((n, i) => n + i.count, 0)
  assert.deepEqual([has(P.blades), has(P.shaftShape), has(P.rodShape), has(P.steelIngot)], [1, 1, 0, 0])
  // 主人教的那句成了它自己的一本手册：在数据目录里，标着是它写的（面板上主人看得到、改得了、删得掉）
  assert.match(fs.readFileSync(path.join(tmp.dir, 'manuals', '模具从哪来.md'), 'utf8'), /^缺模具、模头的时候\n\n主人说：缺模头时先看压模机的原料格里有没有/)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp.dir, 'manuals', '.self.json'), 'utf8')), ['模具从哪来'])

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：主人让它压 4 根精炼铁柄、别站在机器前干等 → process_items 带 leave：料放进去、压模机开工，任务就结束，它被告知一轮多久、四轮大概多久、产物和模头留在机器里 → 趁这会儿去卷板机压 2 块钢板（也是放下就走，电路设成 1 不恢复）→ 回头从两台机器里把产物取回来，模头带 fromInputs 取回', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'], autoFinishMs: 30 })
  const llm = new MockLlm()
  const talk = relayTalk()
  installMockBase(bridge, [stack(P.steelIngot, 40), stack(P.shaftShape, 1)])
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(path.join(tmp.dir, 'config.json'), JSON.stringify({ providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }], activeProviderId: 'mock' }), { mode: 0o600 })
  const packdata = path.join(tmp.dir, 'packdata')
  writePlanFixture(packdata)
  const brain = startBrain(tmp.dir, bridge, { packdata, talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const at = (m: { x: number; y: number; z: number }) => ({ x: m.x, y: m.y, z: m.z })
  const extruder = bridge.machines.find((m) => m.name === 'Advanced Extruder')!
  const bender = bridge.machines.find((m) => m.name === 'Basic Bending Machine')!
  const CHEST_AT = at(bridge.containers[0]!)

  const call = (name: string, input: unknown) => ({ toolCalls: [{ name, input }] })
  const done = /任务 \w+（withdraw）完成了/
  const script: [RegExp, ReturnType<typeof call>][] = [
    [/Steve 私聊你：压 4 根精炼铁柄/, call('withdraw_items', { container: CHEST_AT, items: [stack(P.steelIngot, 38), stack(P.shaftShape, 1)] })],
    [done, call('process_items', { machine: at(extruder), recipe: R.shaft, rounds: 4, leave: true })],
    // 压模机那边放下就走了：趁它转，去卷板机压两块钢板
    [/任务 \w+（process）完成了。 结果：put 37 item/, call('process_items', { machine: at(bender), recipe: R.bendSteel, rounds: 2, leave: true })],
    [/任务 \w+（process）完成了。 结果：put 2 item/, call('withdraw_items', { container: at(bender), items: [stack(P.steelPlate, 2)] })],
    [done, call('withdraw_items', { container: at(extruder), items: [stack(P.shaft, 4)] })],
    [done, call('withdraw_items', { container: at(extruder), items: [stack(P.shaftShape, 1)], fromInputs: true })],
    [done, call('report', { text: '4 根柄和 2 块钢板都取回来了。' })],
  ]
  const seen: string[] = []
  let next = 0
  llm.fallback = (req) => {
    const last = req.body.messages.at(-1)
    const text = (last.content as { type: string; text?: string; content?: unknown }[]).map((b) => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join('\n')
    seen.push(text)
    if (next < script.length && script[next]![0].test(text)) return script[next++]![1]
    return { text: '' }
  }

  bridge.whisper('Alu', 'Steve', '压 4 根精炼铁柄，别站在机器前干等')
  await waitFor('it reported everything fetched', () => bridge.commandLog.some((c) => c.command.includes('都取回来了')), 30_000).catch((e) => assert.fail(`${e.message}\n(script stopped at step ${next})\n${seen.at(-1)}${diag()}`))

  // 交给身体的：带着 leave，和这一批是哪条配方的几轮（身体不用这一项，原样带回）
  const started = bridge.requestsOf('task.start').map((p) => p.task as Record<string, unknown>)
  assert.deepEqual(started.map((task) => task.type), ['withdraw', 'process', 'process', 'withdraw', 'withdraw', 'withdraw'])
  assert.deepEqual(started[1], { type: 'process', machine: at(extruder), inputs: [stack(P.steelIngot, 36), stack(P.shaftShape, 1)], expect: [stack(P.shaft, 4)], leave: true, recipe: { ref: R.shaft, rounds: 4, ticks: 1280 } })
  // 压模机一轮 1280 tick（64 秒），离开那一刻第一轮转了 1 秒：这一轮还剩 63 秒，四轮一共还要 4×64−1 = 255 秒
  const left = seen.find((x) => /结果：put 37 item/.test(x))!
  assert.match(left, /put 37 item\(s\) into the machine; it started, and the task ended there without waiting for it\. On this machine a round takes 1 min 4 s; the one running has about 1 min 3 s left, all 4 rounds about 4 min 15 s from now\. Nothing reports when it finishes: find_machines or inspect_block shows whether it is still busy, and set_reminder wakes you after the minutes you give\./)
  assert.match(left, /withdraw_items with container \(18,64,-8\) takes the products \(a multiblock: from its output bus\), and with fromInputs: true what sits in its input slots; freeSlots \d+/)
  // 卷板机的电路设成了 1，没有恢复
  assert.match(seen.find((x) => /结果：put 2 item/.test(x))!, /a round takes 2\.8 s; the one running has about 1\.8 s left, all 2 rounds about 4\.6 s from now\..*Programmed circuit: now 1, it was 0 \(none\); it stays 1 until someone sets it again/)
  assert.equal(bender.circuit, 1)
  // 回头取的时候东西都在机器里：产物在产物格，模头在原料格
  assert.deepEqual([...bridge.bots.get('Alu')!.recent].reverse().map((task) => [task.type, task.state, (task.result as { moved?: number }).moved]), [
    ['withdraw', 'done', 39],
    ['process', 'done', undefined],
    ['process', 'done', undefined],
    ['withdraw', 'done', 2],
    ['withdraw', 'done', 4],
    ['withdraw', 'done', 1],
  ])
  const inventory = bridge.bots.get('Alu')!.inventory
  const has = (p: { id: string; meta: number }) => inventory.filter((i) => i.id === p.id && i.meta === p.meta).reduce((n, i) => n + i.count, 0)
  assert.deepEqual([has(P.shaft), has(P.shaftShape), has(P.steelPlate), has(P.steelIngot)], [4, 1, 2, 0])

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：自动上下线开着 → 服务器上没有真人、它也没事，过几秒自己下线（不算“被弄下线”）→ 主人在面板上发指令：它先上线，指令照常到对话线 → 办完又下线 → 大脑重启：它还是下线，不被叫出来 → 有真人进服：它上线 → 主人手动点下线后，再有人进服也不上来', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  bridge.players = []
  const llm = new MockLlm()
  llm.fallback = () => ({ text: '' })
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  // 主人要它在线；自动上下线开着，没人没事 3 秒（0.05 分钟）就下线
  const password = 'e2e-panel-password'
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }],
      activeProviderId: 'mock',
      bot: { name: 'Alu', wantOnline: true, presence: { idleOffline: true, idleMinutes: 0.05 }, environment: { name: '测试服', rules: '材料随便用。' } },
      panel: { password },
    }),
    { mode: 0o600 },
  )
  let brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  const alu = () => bridge.bots.get('Alu')!
  const saved = () => JSON.parse(fs.readFileSync(path.join(tmp.dir, 'config.json'), 'utf8')).bot as { wantOnline: boolean; awayIdle: boolean }
  let origin = ''
  let cookie = ''
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${origin}/api${route}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    const json: any = await res.json().catch(() => undefined)
    assert.equal(res.status, 200, `${method} ${route} → ${res.status} ${JSON.stringify(json)}${diag()}`)
    return { json, headers: res.headers }
  }
  const panelUp = () => waitFor('the panel address', () => /面板地址：(http:\/\/127\.0\.0\.1:\d+)\//.exec(brain.output())?.[1], 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const logged = async (): Promise<string[]> => ((await call('GET', '/log')).json.entries as { text: string }[]).map((e) => e.text)
  /** 活动日志里出现这一条为止（下线、上线的那一条是身体答应以后才记的）。 */
  const untilLogged = async (text: string): Promise<string[]> => {
    for (let i = 0; i < 100; i++) {
      const all = await logged()
      if (all.includes(text)) return all
      await new Promise((r) => setTimeout(r, 50))
    }
    return assert.fail(`the brain never logged: ${text}\n${(await logged()).join('\n')}${diag()}`)
  }

  // 1. 连上游戏，照主人的意思上线；没人、没事，几秒后自己下线
  origin = (await panelUp())!
  cookie = (await call('POST', '/login', { password })).headers.getSetCookie()[0]!.split(';')[0]!
  await waitFor('it came online', () => alu().online, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('it went offline by itself', () => !alu().online, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const first = await untilLogged('Alu 自动下线了：服务器上没有真人，它手上也没有事，已经 0.05 分钟。有真人进服、主人在面板上发指令、或者它定的提醒到点，它会自己再上来。')
  // 这是它自己下的：主人的选择还是“上线”，没有被当成“被人弄下线”
  assert.deepEqual(saved(), { ...saved(), wantOnline: true, awayIdle: true })
  assert.equal(first.some((x) => x.includes('被弄下线了')), false)
  assert.equal((await call('GET', '/status')).json.agents[1].body.awayIdle, true)

  // 2. 主人在面板上发指令：它先上线，指令照常到了对话线
  await call('POST', '/command', { text: '看一眼仓库还剩多少钢锭' })
  assert.equal(alu().online, true)
  await waitFor('the command reached the talk line', () => talk.requests.some((r) => JSON.stringify(r.body.messages).includes('看一眼仓库还剩多少钢锭')), 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await untilLogged('Alu 自动上线了：主人在面板上发了指令。')
  // 设置里写的“这个服务器”在它这一轮的提示词里
  assert.ok(talk.requests.some((r) => JSON.stringify(r.body).includes('主人叫它「测试服」') && JSON.stringify(r.body).includes('材料随便用。')))
  // 事办完、还是没人：又下线
  await waitFor('it went offline again', () => !alu().online, 20_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.equal(saved().awayIdle, true)

  // 3. 大脑重启：它正自动下线，连上游戏以后不把它叫出来
  const spawns = bridge.requestsOf('bot.spawn').length
  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
  brain = startBrain(tmp.dir, bridge, { talk })
  origin = (await panelUp())!
  await waitFor('brain reconnected', () => bridge.connectedClients === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await new Promise((r) => setTimeout(r, 1200))
  cookie = (await call('POST', '/login', { password })).headers.getSetCookie()[0]!.split(';')[0]!
  assert.deepEqual([alu().online, bridge.requestsOf('bot.spawn').length, saved().awayIdle], [false, spawns, true], (await logged()).join('\n'))

  // 4. 有真人进服：它上线（它不在线时身体照样把进服的事告诉大脑）
  bridge.playerJoin('Steve')
  await waitFor('it came back for Steve', () => alu().online, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await untilLogged('Alu 自动上线了：Steve 进了服务器。')
  assert.equal(saved().awayIdle, false)
  // 人在的时候不下线
  await new Promise((r) => setTimeout(r, 3600))
  assert.equal(alu().online, true)

  // 5. 主人手动点“下线”：之后人走了又来，它也不上来
  await call('POST', '/bot/despawn', {})
  assert.deepEqual([alu().online, saved().wantOnline, saved().awayIdle], [false, false, false])
  bridge.playerLeave('Steve')
  bridge.playerJoin('Steve')
  await new Promise((r) => setTimeout(r, 1200))
  assert.equal(alu().online, false)

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：主人让它用旁边的熔炉（身体不认识的机器）烧钢锭 → find_machines 照配方册认出它 → process_items 直接试，没放燃料所以没开工 → 它打开熔炉的界面自己看格子，把木炭 Shift 点进去，关掉 → 再试一次就烧出来了', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'], autoFinishMs: 30 })
  const llm = new MockLlm()
  const talk = relayTalk()
  const alu = bridge.bots.get('Alu')!
  const FURNACE = { x: Math.floor(alu.pos.x) + 2, y: Math.floor(alu.pos.y), z: Math.floor(alu.pos.z) }
  const CHARCOAL = { id: 'minecraft:coal', meta: 1 }
  // 这个世界里没有身体认识的机器；只有一个原版熔炉：两个能放东西的格子（原料、燃料）和一个产物格。它烧钢粉要有木炭
  bridge.machines = []
  bridge.devices = [
    {
      ...FURNACE,
      id: 'minecraft:furnace',
      name: 'Furnace',
      slots: [{ kind: 'in' }, { kind: 'in' }, { kind: 'out' }],
      recipes: [{ inputs: [{ ...P.steelDust, count: 1 }], fuel: CHARCOAL, outputs: [{ ...P.steelIngot, count: 1, name: 'Steel Ingot' }] }],
    },
  ]
  alu.inventory = [
    { slot: 0, ...P.steelDust, count: 2, name: 'Steel Dust' },
    { slot: 4, ...CHARCOAL, count: 1, name: 'Charcoal' },
  ]
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(path.join(tmp.dir, 'config.json'), JSON.stringify({ providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }], activeProviderId: 'mock' }), { mode: 0o600 })
  const packdata = path.join(tmp.dir, 'packdata')
  writePlanFixture(packdata)
  const brain = startBrain(tmp.dir, bridge, { packdata, talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))

  const lastText = (req: { body: any }): string => {
    const last = req.body.messages.at(-1)
    return (last.content as { type: string; text?: string; content?: unknown }[]).map((b) => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join('\n')
  }
  const seen: string[] = []
  const say = (message: string) => ({ toolCalls: [{ name: 'report', input: { text: message } }] })
  const smelt = { name: 'process_items', input: { machine: FURNACE, recipe: R.furnaceSteel, rounds: 2 } }
  llm.fallback = (req) => {
    const text = lastText(req)
    seen.push(text)
    if (/Steve 私聊你：用旁边的熔炉/.test(text)) return { toolCalls: [{ name: 'find_machines', input: {} }] }
    // 认出了熔炉：照配方直接试
    if (/other machine\(s\)/.test(text)) return { toolCalls: [smelt] }
    // 没开工：打开界面自己看
    if (/任务 \w+（process）失败了/.test(text)) return { toolCalls: [{ name: 'open_screen', input: { at: FURNACE } }] }
    if (/^Screen "Furnace" is open/.test(text)) {
      // 木炭还在自己背包里：按着 Shift 点它，让它进熔炉；已经进去了就关掉界面
      const mine = /^- slot (\d+): \d+× 木炭 /m.exec(text.slice(text.indexOf('Your own inventory')))
      return mine ? { toolCalls: [{ name: 'click_slot', input: { slot: Number(mine[1]), shift: true } }] } : { toolCalls: [{ name: 'close_screen', input: {} }] }
    }
    if (text === 'The screen is closed.') return { toolCalls: [smelt] }
    if (/任务 \w+（process）完成了/.test(text)) return say('钢锭烧好了。')
    return { text: '' }
  }

  bridge.whisper('Alu', 'Steve', '用旁边的熔炉把钢粉烧成钢锭')
  await waitFor('it reported the ingots done', () => bridge.commandLog.some((c) => c.command.includes('钢锭烧好了')), 30_000).catch((e) => assert.fail(`${e.message}\n${seen.join('\n---\n')}${diag()}`))

  // find_machines：身体那边一台都没有，照配方册认出了这个熔炉
  const found = seen.find((x) => /other machine\(s\)/.test(x))!
  assert.match(found, new RegExp(`\\n- \\(${FURNACE.x},${FURNACE.y},${FURNACE.z}\\) "熔炉": runs "烧制" recipes$`))
  // 两次 process：给身体的就是机器的位置和照配方算出来的原料，没有编程电路
  const tasks = bridge.requestsOf('task.start').map((p) => p.task)
  assert.deepEqual(tasks, [
    { type: 'process', machine: FURNACE, inputs: [stack(P.steelDust, 2)], expect: [stack(P.steelIngot, 2)] },
    { type: 'process', machine: FURNACE, inputs: [stack(P.steelDust, 2)], expect: [stack(P.steelIngot, 2)] },
  ])
  assert.deepEqual([...alu.recent].reverse().map((task) => [task.type, task.state]), [['process', 'failed'], ['process', 'done']])
  // 第一次失败时它被告知的原因，是身体对“不认识的机器”的说法：里面什么都没变
  assert.match(seen.find((x) => /（process）失败了/.test(x))!, /nothing inside it changed in 10 seconds/)
  // 界面：它看到的是熔炉自己的三格（两格能放、一格产物）和自己背包里的东西；点的是自己背包里木炭那一格
  const opened = seen.find((x) => x.startsWith('Screen "Furnace" is open'))!
  assert.deepEqual(opened.split('\n').slice(1, 8), [
    'Its slots (3):',
    '- slots 0–1: empty (2)',
    '- slot 2 (OUTPUT: products appear here, nothing can be put in): empty',
    'Your own inventory (only the slots holding something):',
    '- slot 3: 2× 钢粉 [gregtech:gt.metaitem.01/2305]',
    '- slot 7: 1× 木炭 [minecraft:coal/1]',
    'Nothing on your cursor.',
  ])
  assert.deepEqual(bridge.requestsOf('screen.click'), [{ bot: 'Alu', slot: 7, shift: true }])
  assert.equal(bridge.requestsOf('screen.close').length, 1)
  // 做成了：钢锭在身上，钢粉和木炭用掉了
  const has = (p: { id: string; meta: number }) => alu.inventory.filter((i) => i.id === p.id && i.meta === p.meta).reduce((n, i) => n + i.count, 0)
  assert.deepEqual([has(P.steelIngot), has(P.steelDust), has(CHARCOAL)], [2, 0, 0])

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：面板拿到的数据——模型还在想时状态里看得出是第几轮第几步；每次模型调用在日志里一条（用时、token、缓存命中、怎么结束的），它直接调的工具标着是哪一步的；例程是一条跟着更新的汇总加出错的那一步，每一步的明细翻得到；状态里两条线各一项，例程和身体挂在干活线下面', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({ panel: { password: 'preset-password-for-e2e' }, providers: [{ id: 'mock', label: '主力', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }], activeProviderId: 'mock' }),
    { mode: 0o600 },
  )
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  const origin = await waitFor('panel address', () => /面板地址：(http:\/\/127\.0\.0\.1:\d+)\//.exec(brain.output())?.[1], 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  let cookie = ''
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${origin}/api${route}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, json: (await res.json().catch(() => undefined)) as any, headers: res.headers }
  }
  cookie = (await call('POST', '/login', { password: 'preset-password-for-e2e' })).headers.getSetCookie()[0]!.split(';')[0]!
  const lines = async () => (await call('GET', '/status')).json.agents as any[]
  /** 干活线那一项（例程和身体挂在它下面）。 */
  const main = async () => (await lines()).find((a) => a.agent === 'work')
  /** 一直问状态，直到看到要的样子。 */
  const until = async (what: string, ok: (agent: any) => boolean) => {
    let agent: any
    for (let n = 0; n < 100; n++) {
      agent = await main()
      if (ok(agent)) return agent
      await sleep(30)
    }
    return assert.fail(`the status never showed ${what}: ${JSON.stringify(agent)}${diag()}`)
  }

  // 没事的时候：两条线的模型都空闲，各是各选的那个；没有例程，身体闲着。对话线那一项没有例程和身体
  const [talkIdle, idle] = await lines()
  assert.deepEqual([idle.agent, idle.name, idle.model.state, idle.model.provider, idle.model.model, idle.turn, idle.routine, idle.lastRoutine, idle.waitingAnswer, idle.lastReport], ['work', 'Alu', 'idle', '主力', 'claude-e2e', null, null, null, null, null])
  assert.deepEqual(idle.body, { online: true, task: null, queue: [] })
  assert.deepEqual([talkIdle.agent, talkIdle.title, talkIdle.model.state, talkIdle.model.provider, talkIdle.model.model, talkIdle.turn, 'routine' in talkIdle, 'body' in talkIdle], ['talk', '对话线', 'idle', 'talk', 'talk-e2e', null, false, false])
  assert.deepEqual([talkIdle.history, idle.history], [{ turns: 0, hasSummary: false, estimatedTokens: 0, threshold: 120000 }, { turns: 0, hasSummary: false, estimatedTokens: 0, threshold: 240000 }])

  // 例程：看一眼自己 → 一步参数不对（出错）→ 走一段路（模拟的身体里要等人喊完成，所以会停在这一步）
  const code = `await tool('get_status')\nlog('看过了')\nawait tool('withdraw_items', { container: { x: 1 } })\nawait tool('go_to', { x: 40, z: 40 })\nreturn '到了'`
  llm.enqueue(
    // 第 1 步想得久一点：这期间状态里看得到“正在想”
    { toolCalls: [{ name: 'get_status', input: {} }], usage: { input: 200, output: 20, cacheRead: 800 }, delayMs: 700 },
    { toolCalls: [{ name: 'start_routine', input: { code, name: '走一趟' } }], usage: { input: 300, output: 30 } },
    { text: '', usage: { input: 310, output: 5 } },
  )
  bridge.whisper('Alu', 'Steve', '去那边转一圈')

  // 1. 干活线的模型正在想：第几轮、第几步、从什么时候开始、这一轮是为什么起的
  const thinking = await until('the model thinking', (a) => a.model.state === 'thinking')
  assert.deepEqual([thinking.model.step, thinking.model.purpose, thinking.turn.steps, thinking.turn.maxSteps, thinking.turn.about], [1, 'turn', 0, 60, '对话线交给你的（这一句是它写的）：去那边转一圈'])
  assert.equal(thinking.model.turn, thinking.turn.id)
  assert.ok(Math.abs(Date.now() - thinking.model.since) < 5000, JSON.stringify(thinking.model))

  // 2. 例程跑到走路那一步：状态里三样分开——模型闲了，例程在跑（实时的次数、正等着哪一步），身体在走
  await waitFor('the routine is walking', () => bridge.bots.get('Alu')?.task?.type === 'goto', 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const walking = await until('the routine waiting for its task', (a) => a.model.state === 'idle' && a.routine?.waitingTask === 't1' && a.body.task?.id === 't1')
  assert.deepEqual(
    { id: walking.routine.id, name: walking.routine.name, status: walking.routine.status, calls: walking.routine.calls, tasks: walking.routine.tasks, errors: walking.routine.errors, limitMs: walking.routine.limitMs },
    { id: 'r1', name: '走一趟', status: 'running', calls: 3, tasks: 1, errors: 1, limitMs: 120 * 60_000 },
  )
  assert.match(walking.routine.waiting, /^go_to \{"x":40,"z":40\}$/)
  assert.deepEqual([walking.body.online, walking.body.task.type, walking.body.task.state, walking.body.queue], [true, 'goto', 'running', []])
  assert.deepEqual([walking.turn, walking.model.lastCall.ok, walking.model.lastCall.inputTokens], [null, true, 310])

  // 3. 日志：这一轮三次模型调用各一条，带着用时、token、缓存命中、怎么结束的；它直接调的工具标着是第几步的
  const log = (await call('GET', '/log')).json.entries as any[]
  const turn = thinking.turn.id
  const calls = log.filter((e) => e.kind === 'model_call' && e.agent === 'work')
  assert.deepEqual(
    calls.map((e) => [e.turn, e.step, e.call.state, e.call.purpose, e.call.stop, e.call.toolCalls, e.call.inputTokens, e.call.outputTokens, e.call.cacheReadTokens ?? null, e.call.model]),
    [
      // 输入的 1000 里有 800 是缓存命中的
      [turn, 1, 'done', 'turn', 'tool_calls', 1, 1000, 20, 800, 'claude-e2e'],
      [turn, 2, 'done', 'turn', 'tool_calls', 1, 300, 30, null, 'claude-e2e'],
      [turn, 3, 'done', 'turn', 'end', 0, 310, 5, null, 'claude-e2e'],
    ],
  )
  assert.ok(calls[0].call.ms >= 700 && calls[0].call.ms < 10_000, `the first call took ${calls[0].call.ms} ms`)
  assert.match(calls[0].text, /^第 1 步：\d+\.\d 秒，输入 1000（缓存命中 800） \/ 输出 20 token，要调 1 个工具$/)
  assert.match(calls[2].text, /^第 3 步：\d+\.\d 秒，输入 310 \/ 输出 5 token，说完了$/)
  assert.deepEqual(
    log.filter((e) => e.source === 'model' && e.agent === 'work').map((e) => [e.kind, e.who, e.turn, e.step]),
    [
      ['tool_call', 'get_status', turn, 1],
      ['tool_result', 'get_status', turn, 1],
      ['tool_call', 'start_routine', turn, 2],
      ['tool_result', 'start_routine', turn, 2],
    ],
  )
  // 一条 model_call 排在它那一步的工具前面
  const at = (pick: (e: any) => boolean) => log.findIndex(pick)
  assert.ok(at((e) => e.kind === 'model_call' && e.agent === 'work' && e.step === 2) < at((e) => e.kind === 'tool_call' && e.who === 'start_routine'))
  // 对话线自己的那一轮（把主人的话交出去）是另一个编号，它的模型调用和工具标着是对话线的；交事是一条 relay
  const talkCalls = log.filter((e) => e.kind === 'model_call' && e.agent === 'talk')
  assert.ok(talkCalls.length >= 1 && talkCalls.every((e) => e.turn !== turn && e.call.model === 'talk-e2e'), JSON.stringify(talkCalls))
  assert.deepEqual(log.filter((e) => e.kind === 'relay').map((e) => [e.agent, e.turn, e.relay.type, e.relay.quotes, e.text]), [['talk', talkCalls[0].turn, 'tell', 1, '对话线 → 干活线：去那边转一圈']])
  assert.deepEqual(log.filter((e) => e.who === 'tell_worker').map((e) => [e.kind, e.agent, e.source]), [['tool_call', 'talk', 'model'], ['tool_result', 'talk', 'model']])

  // 例程的三次调用没有各记两条：一条跟着更新的汇总（在跑），加上出错的那一步；开始那条带着结构化的样子
  const ofRun = log.filter((e) => e.runId === 'r1')
  assert.deepEqual(ofRun.map((e) => [e.kind, e.source, e.who ?? null, e.isError === true]), [
    ['info', 'routine', null, false],
    ['run', 'routine', null, false],
    ['tool_result', 'routine', 'withdraw_items', true],
  ])
  assert.deepEqual([ofRun[0].text, ofRun[0].detail, ofRun[0].run.status, ofRun[0].run.calls], ['例程 r1（走一趟）开始在后台跑。', code, 'running', 0])
  assert.equal(ofRun[2].text, '[例程 r1 #2] Invalid arguments for withdraw_items: items is required; container.y is required; container.z is required')
  const summaryId = ofRun[1].id
  assert.deepEqual([ofRun[1].run.id, ofRun[1].run.kind, ofRun[1].run.name, ofRun[1].run.status], ['r1', 'routine', '走一趟', 'running'])

  // 4. 走到了：例程跑完。那条汇总原地改成定稿（还是那个 id），另有一条结束的
  llm.enqueue({ text: '', usage: { input: 400, output: 3 } })
  bridge.completeTask('Alu')
  const done = await until('the routine finished', (a) => a.lastRoutine?.status === 'done' && a.model.state === 'idle' && a.turn === null && a.model.lastCall?.inputTokens === 400)
  assert.deepEqual([done.routine, done.lastRoutine.calls, done.lastRoutine.tasks, done.lastRoutine.errors, done.lastRoutine.ending, done.lastRoutine.endingText, done.body.task], [null, 3, 1, 1, 'the program finished', '程序跑到头了', null])
  const later = (await call('GET', '/log')).json.entries as any[]
  const summary = later.filter((e) => e.kind === 'run')
  assert.deepEqual(summary.map((e) => [e.id, e.run.status, e.run.calls, e.run.tasks, e.run.errors, typeof e.run.endedAt]), [[summaryId, 'done', 3, 1, 1, 'number']])
  assert.match(summary[0].text, /^例程 r1（走一趟）：跑完了，调了 3 次工具，开了 1 个任务，1 次出错，\d+ 秒$/)
  const ended = later.filter((e) => e.runId === 'r1').at(-1)
  assert.deepEqual([ended.kind, ended.source, ended.text, ended.run.status, ended.run.calls], ['info', 'routine', '例程 r1（走一趟）跑完了：调了 3 次工具，开了 1 个任务', 'done', 3])

  // 5. 每一步的明细：按运行翻页读得到（参数、结果全文、用时、开的任务）
  const runs = (await call('GET', '/runs')).json.runs as any[]
  assert.deepEqual(runs.map((r) => [r.id, r.kind, r.name, r.status, r.calls, r.tasks, r.errors]), [['r1', 'routine', '走一趟', 'done', 3, 1, 1]])
  assert.equal(runs[0].file, summary[0].run.file)
  const first = (await call('GET', `/runs/records?file=${encodeURIComponent(runs[0].file)}&limit=3`)).json
  assert.deepEqual([first.file, first.total, first.next], [runs[0].file, 6, 3])
  assert.deepEqual(first.records.map((r: any) => [r.t, r.tool ?? r.text ?? r.name]), [['start', '走一趟'], ['call', 'get_status'], ['log', '看过了']])
  assert.equal(first.records[0].code, code)
  assert.match(first.records[1].text, /^Alu: online in overworld \(dim 0\) at block \(10,64,-4\), health 20\/20, food 20\nHolding: /)
  // 接着读下一页；也可以按编号找（这个编号最近的一次）
  const rest = (await call('GET', `/runs/records?id=r1&after=${first.next}`)).json
  assert.deepEqual([rest.total, rest.next], [6, 6])
  assert.deepEqual(
    rest.records.map((r: any) => (r.t === 'call' ? [r.n, r.tool, r.ok, r.input, r.task ?? null] : r.t === 'end' ? [r.status, r.calls, r.tasks, r.errors, r.value] : r.t)),
    [
      [2, 'withdraw_items', false, { container: { x: 1 } }, null],
      [3, 'go_to', true, { x: 40, z: 40 }, 't1'],
      ['done', 3, 1, 1, '到了'],
    ],
  )
  assert.equal((await call('GET', '/runs/records?id=r9')).status, 404)

  // 6. 往回翻日志：紧挨在某一条之前的几条，顺序不变；翻到头 more 是 false
  const ids = later.map((e) => e.id)
  const page = (await call('GET', `/log?before=${ids[5]}&limit=3`)).json
  assert.deepEqual([page.entries.map((e: any) => e.id), page.more], [ids.slice(2, 5), true])
  assert.deepEqual((await call('GET', `/log?before=${ids[2]}&limit=50`)).json, { entries: later.slice(0, 2), more: false })
  // 往后追：只给新的；一次给不完时 more 是 true
  const tail = (await call('GET', `/log?after=${ids[ids.length - 3]}`)).json
  assert.deepEqual([tail.entries.map((e: any) => e.id), tail.more], [ids.slice(-2), false])
  assert.deepEqual([(await call('GET', '/log?after=0&limit=2')).json.entries.map((e: any) => e.id), (await call('GET', '/log?after=0&limit=2')).json.more], [ids.slice(-2), true])

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：带着只有一条线时留下的数据目录启动 → 配置自动补上对话线的那几项、原文件留底、改过的旧人设清空并在日志里说明；老历史和任务的事归干活线，排着的那句聊天归对话线；之后两条线照常干活', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  // 升级后两条线默认用的是原来选的那一个模型：同一家接口按“是哪条线发的”回——对话线只传话，干活线回一句话
  const llm = new MockLlm()
  const relay = talkRelay({ whisperTo: 'Steve' })
  llm.fallback = (req) => {
    if (isTalkLine(req)) return relay(req)
    const last = JSON.stringify(req.body.messages.at(-1))
    return /圆石也放进去/.test(last) ? { text: '圆石也放进去了。' } : { text: '' }
  }
  await bridge.start()
  await llm.start()
  // 升级前的数据：版本 2 的配置（主人改过人设）、一轮带 say 的历史、排着没处理的一句聊天和一个结束了的任务
  const oldConfig = JSON.stringify({
    version: 2,
    panel: { password: 'preset-password-for-e2e' },
    bot: { name: 'Alu', systemPrompt: '你是 {{name}}。玩家只能看到你用 say 说的话。干活靠任务。', limits: { maxSteps: 40, historyTokenThreshold: 180_000 } },
    providers: [{ id: 'mock', label: '主力', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', models: [{ id: 'm1', name: 'claude-e2e', label: '' }] }],
    activeProviderId: 'mock',
    activeModelId: 'm1',
  })
  fs.writeFileSync(path.join(tmp.dir, 'config.json'), oldConfig, { mode: 0o600 })
  const oldHistory = {
    summary: '',
    nextTurnId: 8,
    turns: [
      {
        id: 7,
        startedAt: Date.now() - 3_600_000,
        messages: [
          { role: 'user', content: [{ type: 'text', text: '[需要你处理的事]\n[10:00:00] Steve 说：Alu 把土放进箱子' }] },
          { role: 'assistant', content: [{ type: 'tool_call', id: 'old1', name: 'say', input: { message: '好' } }] },
          { role: 'user', content: [{ type: 'tool_result', toolCallId: 'old1', content: 'Said in public chat.' }] },
        ],
      },
    ],
  }
  fs.writeFileSync(path.join(tmp.dir, 'history.json'), JSON.stringify(oldHistory), { mode: 0o600 })
  const now = Date.now()
  fs.writeFileSync(
    path.join(tmp.dir, 'agent-state.json'),
    JSON.stringify({
      tracked: [],
      endedSeen: ['t7'],
      queue: [
        { type: 'chat', time: now, player: 'Steve', message: 'Alu 圆石也放进去', isBot: false },
        { type: 'task_ended', time: now, task: { id: 't7', type: 'deposit', state: 'done', result: { moved: 64 } } },
      ],
    }),
    { mode: 0o600 },
  )
  const brain = startBrain(tmp.dir, bridge)
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  const origin = await waitFor('panel address', () => /面板地址：(http:\/\/127\.0\.0\.1:\d+)\//.exec(brain.output())?.[1], 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  let cookie = ''
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${origin}/api${route}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return { status: res.status, json: (await res.json().catch(() => undefined)) as any, headers: res.headers }
  }
  cookie = (await call('POST', '/login', { password: 'preset-password-for-e2e' })).headers.getSetCookie()[0]!.split(';')[0]!

  // 1. 排着的那句聊天到了对话线，它交给干活线，干活线做完的话由对话线说给主人
  await waitFor('the owner was told', () => bridge.commandLog.some((c) => c.command === 'tell Steve 圆石也放进去了。'), 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const talkSaw = llm.requests.filter(isTalkLine).map((r) => JSON.stringify(r.body.messages))
  const workSaw = llm.requests.filter((r) => !isTalkLine(r)).map((r) => JSON.stringify(r.body.messages))
  // 对话线从空历史开始：它头一次看到的只有那句聊天，没有老历史，也没有任务的事
  assert.equal(llm.requests.filter(isTalkLine)[0]!.body.messages.length, 1)
  assert.match(talkSaw[0]!, /大脑刚重启过/)
  assert.match(talkSaw[0]!, /Steve 说：Alu 圆石也放进去/)
  assert.equal(talkSaw.some((x) => x.includes('把土放进箱子') || x.includes('任务 t7')), false)
  // 干活线接着老历史：里面有升级前它用 say 说话的那一轮；任务结束归它；它被告知这段历史是怎么来的
  assert.ok(workSaw[0]!.includes('Alu 把土放进箱子') && workSaw[0]!.includes('"name":"say"'), workSaw[0])
  assert.ok(workSaw.some((x) => /任务 t7（deposit）完成了/.test(x)))
  assert.ok(workSaw.some((x) => x.includes('大脑升级过：从现在起“跟人说话”和“操作身体干活”分成了两条线，你是干活线。')))
  // 干活线现在的清单里没有 say 了
  assert.equal(llm.requests.filter((r) => !isTalkLine(r)).some((r) => (r.body.tools as { name: string }[]).some((x) => x.name === 'say')), false)

  // 2. 配置：补上了对话线的那几项（和原来选的一样），原来的上限是干活线的；原文件留了底；旧人设清空
  const saved = JSON.parse(fs.readFileSync(path.join(tmp.dir, 'config.json'), 'utf8'))
  assert.deepEqual([saved.version, saved.activeProviderId, saved.activeModelId, saved.talkProviderId, saved.talkModelId], [3, 'mock', 'm1', 'mock', 'm1'])
  assert.deepEqual([saved.bot.limits.maxSteps, saved.bot.limits.historyTokenThreshold, saved.bot.limits.talkMaxSteps, saved.bot.limits.talkHistoryTokenThreshold, saved.bot.systemPrompt], [40, 180_000, 20, 120_000, ''])
  assert.equal(fs.readFileSync(path.join(tmp.dir, 'config.json.v2.bak'), 'utf8'), oldConfig)
  assert.equal(fs.statSync(path.join(tmp.dir, 'config.json.v2.bak')).mode & 0o777, 0o600)
  // 对话线用的是新的默认说话风格，不是那段旧人设
  const talkSystem = JSON.stringify(llm.requests.filter(isTalkLine)[0]!.body.system)
  assert.ok(talkSystem.includes('你写出来的文字就是你在公共聊天里说的话') && !talkSystem.includes('玩家只能看到你用 say 说的话'))

  // 3. 日志里两件事都说了；状态里两条线各有各的历史
  const log = ((await call('GET', '/log')).json.entries as { kind: string; text: string }[]).map((e) => e.text)
  assert.ok(log.some((text) => text.startsWith('大脑升级：从这次启动起分成对话线和干活线。')), log.join('\n'))
  assert.ok(log.some((text) => /^配置升级：原来面板上改过的人设提示词是分成对话线、干活线之前的整段核心提示词.*留在 .*config\.json\.v2\.bak 的 bot\.systemPrompt 里/.test(text)), log.join('\n'))
  const [talkState, workState] = (await call('GET', '/status')).json.agents
  assert.ok(talkState.history.turns >= 1 && workState.history.turns >= 2, JSON.stringify([talkState.history, workState.history]))
  assert.equal(workState.history.threshold, 180_000)

  // 4. 再启动一次：不再当成升级，不再动那份底，也不再说一遍
  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
  for (const name of ['talk-state.json', 'talk-history.json', 'history.json', 'agent-state.json']) assert.ok(fs.existsSync(path.join(tmp.dir, name)), name)
  const again = startBrain(tmp.dir, bridge)
  t.after(() => {
    if (again.child.exitCode === null) again.child.kill('SIGKILL')
  })
  const origin2 = await waitFor('panel address after the restart', () => /面板地址：(http:\/\/127\.0\.0\.1:\d+)\//.exec(again.output())?.[1], 15_000)
  const res = await fetch(`${origin2}/api/login`, { method: 'POST', headers: { origin: origin2, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'preset-password-for-e2e' }) })
  const cookie2 = res.headers.getSetCookie()[0]!.split(';')[0]!
  const page2 = (await (await fetch(`${origin2}/api/log`, { headers: { cookie: cookie2 } })).json()) as { entries: { text: string }[] }
  const log2 = page2.entries.map((e) => e.text)
  assert.equal(log2.filter((text) => text.startsWith('大脑升级：')).length, 1)
  assert.equal(log2.filter((text) => text.startsWith('配置升级：')).length, 1)
  again.child.kill('SIGTERM')
  assert.equal(await again.exited, 0)
})

it('端到端：主人说模具在流体固化器的覆盖板里 → 它搜库存搜到“在那台机器西面的覆盖板里” → 照结果里写的容器（带着面和“蹲着”）去取 → 模具到了身上；它再看那台机器，罐里的流体和各面的覆盖板都看得到，还能把机器自己存的全部数据调出来', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  const GT = 'gregtech:gt.metaitem.01'
  const SOLIDIFIER = { x: 20, y: 65, z: -8 }
  const MOLD = { id: GT, meta: 32322, count: 1, name: 'Mold (Ring)' }
  // 一台流体固化器：西面的覆盖板“槽位扩展”里放着模具（环），罐里有 144 mB 熔融钢
  bridge.machines = [
    {
      ...SOLIDIFIER, name: 'Basic Fluid Solidifier', recipes: 'Fluid Solidifier', tier: 'LV', inputSlots: 1, storedEU: 4000, inputVoltage: 32,
      covers: [{ side: 'west', id: GT, meta: 32380, name: 'Basic Item Holder', slots: 9, items: [MOLD] }],
      tanks: [{ fluid: 'molten.steel', name: 'Molten Steel', amount: 144, capacity: 16000 }],
      says: ['Fluid Solidifier', 'Progress: 0 s / 0 s'],
      saved: { mActive: 0, mFluid: { FluidName: 'molten.steel', Amount: 144 }, 'gt.covers': [{ side: 4, items: [{ item: GT, meta: 32322, count: 1, name: 'Mold (Ring)' }] }] },
    },
  ]
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(path.join(tmp.dir, 'config.json'), JSON.stringify({ providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }], activeProviderId: 'mock' }), { mode: 0o600 })
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const seen = (n: number): string => {
    const last = llm.requests[n]!.body.messages.at(-1)
    return (last.content as { type: string; text?: string; content?: unknown }[]).map((b) => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join('\n')
  }

  llm.enqueue(
    { toolCalls: [{ name: 'find_in_storage', input: { items: [{ id: GT, meta: 32322 }], radius: 32 } }] },
    // 取的容器照搜到的那一行写
    { toolCalls: [{ name: 'withdraw_items', input: { container: { ...SOLIDIFIER, side: 'west', sneak: true }, items: [{ id: GT, meta: 32322, count: 1 }] } }] },
    { toolCalls: [{ name: 'inspect_block', input: SOLIDIFIER }, { name: 'inspect_block', input: { ...SOLIDIFIER, detail: true } }] },
    { toolCalls: [{ name: 'report', input: { text: '模具拿到了。' } }] },
    { text: '' },
  )
  bridge.whisper('Alu', 'Steve', '模具（环）在流体固化器的覆盖板里，拿出来')
  await waitFor('told the owner', () => bridge.commandLog.some((c) => c.command.includes('模具拿到了')), 15_000).catch((e) => assert.fail(`${e.message}\n${llm.requests.map((_, n) => seen(n)).join('\n---\n')}${diag()}`))

  // 搜到的那一行：哪台机器、哪个面、哪块覆盖板，和取它用的容器
  assert.match(seen(1), /\n {2}- \(20,65,-8\) Basic Fluid Solidifier, in the cover "Basic Item Holder" on its west face: 1 — container \{x: 20, y: 65, z: -8, side: "west", sneak: true\}\n/)
  // 身体收到的取货任务带着面和“蹲着”；模具真的从覆盖板里到了身上
  assert.deepEqual(bridge.requestsOf('task.start').map((p) => p.task), [{ type: 'withdraw', container: { ...SOLIDIFIER, side: 'west', sneak: true }, items: [{ id: GT, meta: 32322, count: 1 }] }])
  assert.equal(bridge.bots.get('Alu')!.inventory.filter((i) => i.id === GT && i.meta === 32322).reduce((n, i) => n + i.count, 0), 1)
  assert.deepEqual(bridge.machines[0]!.covers![0]!.items, [])
  // 取完再看这台机器：罐里的流体、西面那块（现在空了的）覆盖板；带 detail 时还有它自己说的话和存的全部数据
  const looked = seen(3)
  assert.match(looked, /\(20,65,-8\): gregtech:gt\.blockmachines "Basic Fluid Solidifier" \[solid, tileEntity, inventory\] hardness 2\ntank: 144 of 16000 mB Molten Steel \[fluid molten\.steel\]\ncover on its west face: Basic Item Holder \[gregtech:gt\.metaitem\.01\/32380\], 0\/9 slots used: empty\n/)
  assert.match(looked, /What it says of itself \(as to a scanner\):\n {2}Fluid Solidifier\n {2}Progress: 0 s \/ 0 s\nIts own saved data, whole \(class gregtech\.api\.metatileentity\.BaseMetaTileEntity\); the keys are its internal names, the values raw:\n {2}mActive: 0\n {2}mFluid: \{"FluidName":"molten\.steel","Amount":144\}\n {2}gt\.covers: \[\{"side":4,"items":\[\{"item":"gregtech:gt\.metaitem\.01","meta":32322,"count":1,"name":"Mold \(Ring\)"\}\]\}\]/)

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：钢板在流体提取机里化成了熔融钢，隔壁的固化器却是空的 → 加工的结果告诉它“做成了，产物是流体，在提取机的罐里” → 它打开提取机的界面，看到“流体自动输出”关着，按开 → 再看固化器，罐里有熔融钢了', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  const talk = relayTalk()
  const GT = 'gregtech:gt.metaitem.01'
  // 两台机器挨着，都在它够得着的地方
  const EXTRACTOR = { x: 10, y: 64, z: -8 }
  const SOLIDIFIER = { x: 11, y: 64, z: -8 }
  const PANEL = 'basicmachine.fluidextractor.tier.02'
  bridge.machines = [
    {
      ...EXTRACTOR, name: 'Basic Fluid Extractor', recipes: 'Fluid Extractor', tier: 'LV', inputSlots: 1, storedEU: 4000, inputVoltage: 32,
      tanks: [{ capacity: 16000 }],
      // 一个钢板化成 144 mB 熔融钢；流体自动输出关着（开了以后流到隔壁的固化器）
      melts: [{ id: GT, meta: 17305, fluid: 'molten.steel', name: 'Molten Steel', mb: 144 }],
      controls: [
        { panel: PANEL, key: 'fluidAutoOutput:0', kind: 'switch', value: false },
        { panel: PANEL, key: 'powerfail:0', kind: 'switch', value: false, readOnly: true },
      ],
      autoOutputTo: SOLIDIFIER,
    },
    { ...SOLIDIFIER, name: 'Basic Fluid Solidifier', recipes: 'Fluid Solidifier', tier: 'LV', inputSlots: 1, storedEU: 4000, inputVoltage: 32, tanks: [{ capacity: 16000 }] },
  ]
  await bridge.start()
  await llm.start()
  await talk.start()
  fs.writeFileSync(path.join(tmp.dir, 'config.json'), JSON.stringify({ providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }], activeProviderId: 'mock' }), { mode: 0o600 })
  const brain = startBrain(tmp.dir, bridge, { talk })
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
    await talk.stop()
    tmp.cleanup()
  })
  const diag = () => `\n--- brain output ---\n${brain.output()}`
  await waitFor('bridge connected', () => bridge.connectedClients === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const alu = bridge.bots.get('Alu')!
  alu.inventory = [{ slot: 0, id: GT, meta: 17305, count: 2, name: 'Steel Plate' }]
  const seen = (n: number): string => {
    const last = llm.requests[n]!.body.messages.at(-1)
    return (last.content as { type: string; text?: string; content?: unknown }[]).map((b) => (typeof b.text === 'string' ? b.text : typeof b.content === 'string' ? b.content : JSON.stringify(b.content))).join('\n')
  }
  const all = () => llm.requests.map((_, n) => seen(n)).join('\n---\n')

  // 1. 把两个钢板放进流体提取机
  llm.enqueue({ toolCalls: [{ name: 'process_items', input: { machine: EXTRACTOR, inputs: [{ id: GT, meta: 17305, count: 2 }] } }] }, { text: '' })
  bridge.whisper('Alu', 'Steve', '把这两个钢板做成钢环')
  await waitFor('the first turn ended', () => llm.requests.length === 2, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))

  // 2. 加工做完：没有物品出来，罐里多了熔融钢——任务是“完成”，结果说清产物是流体、在哪、多少。
  //    它接着：打开提取机的界面 → 按开“流体自动输出” → 关界面，看一眼固化器 → 汇报
  llm.enqueue(
    { toolCalls: [{ name: 'open_screen', input: { at: EXTRACTOR } }] },
    { toolCalls: [{ name: 'use_control', input: { key: 'fluidAutoOutput' } }] },
    { toolCalls: [{ name: 'close_screen', input: {} }, { name: 'inspect_block', input: SOLIDIFIER }] },
    { toolCalls: [{ name: 'report', input: { text: '熔融钢已经到固化器了。' } }] },
    { text: '' },
  )
  bridge.completeTask('Alu')
  await waitFor('told the owner', () => bridge.commandLog.some((c) => c.command.includes('熔融钢已经到固化器了')), 15_000).catch((e) => assert.fail(`${e.message}\n${all()}${diag()}`))

  const text = all()
  assert.match(text, /任务 t1（process）完成了。 结果：put 2 item\(s\) into the machine; took out: nothing; it ran, and what it made is a fluid, not an item: it is in the machine's tank, which now holds 288 of 16000 mB Molten Steel \[fluid molten\.steel\]\. A fluid stays where it is until the machine's own auto-output, a pipe or a fluid container moves it; freeSlots 36/)
  // 界面上格子以外的东西：开关关着、只是显示的那个、罐那一格
  assert.match(text, /Its controls besides slots \(3; the names are the screen's own, use_control works them\):\non panel "basicmachine\.fluidextractor\.tier\.02":\n- fluidAutoOutput:0 \[switch\]: off\n- powerfail:0 \[switch, display only\]: off\n- auto_sync:tank:0 \[fluid slot\]: 288 of 16000 mB Molten Steel \[fluid molten\.steel\]; gives to a fluid container on your cursor\n/)
  // 身体收到的就是“按这个控件”；按完开关是开的，提取机的罐空了
  assert.deepEqual(bridge.requestsOf('screen.press'), [{ bot: 'Alu', key: 'fluidAutoOutput' }])
  assert.match(text, /- fluidAutoOutput:0 \[switch\]: on\n- powerfail:0 \[switch, display only\]: off\n- auto_sync:tank:0 \[fluid slot\]: empty \(holds up to 16000 mB\); gives to a fluid container on your cursor\n/)
  // 固化器的罐里有熔融钢了（它自己看到的，也是模拟的游戏里真的发生的）
  assert.match(text, /\(11,64,-8\): gregtech:gt\.blockmachines "Basic Fluid Solidifier" \[solid, tileEntity, inventory\] hardness 2\ntank: 288 of 16000 mB Molten Steel \[fluid molten\.steel\]/)
  assert.deepEqual(bridge.machines.map((m) => m.tanks!.map((tank) => tank.amount ?? 0)), [[0], [288]])
  assert.equal(alu.inventory.some((i) => i.id === GT && i.meta === 17305), false)

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})
