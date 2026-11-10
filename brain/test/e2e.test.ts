// 端到端：模拟 bridge + 模拟模型服务 + 真实启动 src/main.ts（子进程）。
// 像主人那样操作：看启动输出里的口令 → 登录面板 → 配模型 → 让 bot 上线 → 游戏里说一句话。
// 然后从这条聊天一路走到任务启动、任务结束再唤醒、say 回话。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { tmpDir, waitFor } from './helpers.ts'
import { MockBridge } from './mock-bridge.ts'
import { MockLlm } from './mock-llm.ts'

const BRAIN_ROOT = path.resolve(import.meta.dirname, '..')

interface Brain {
  child: ChildProcess
  output: () => string
  exited: Promise<number | null>
}

function startBrain(dataDir: string, bridge: MockBridge): Brain {
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
  child.stderr!.on('data', (d: Buffer) => (out += d.toString()))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  return { child, output: () => out, exited }
}

it('端到端：聊天 → 任务启动 → 任务结束再唤醒 → say 回话（中途把模型从 OpenAI 兼容换成 Anthropic 兼容）', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge()
  const llm = new MockLlm()
  await bridge.start()
  await llm.start()
  const brain = startBrain(tmp.dir, bridge)
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
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

  // 4. 配一个 OpenAI 兼容的服务商，测试连接，让 bot 上线
  llm.enqueue({ text: 'pong' })
  const created = await call('POST', '/providers', { kind: 'openai-chat', label: '模拟 OpenAI', baseUrl: llm.openaiBaseUrl, apiKey: 'sk-e2e-openai-key-0001', model: 'gpt-e2e' })
  const test = await call('POST', '/providers/test', { id: created.json.provider.id, kind: 'openai-chat', label: '模拟 OpenAI', baseUrl: llm.openaiBaseUrl, apiKey: '', model: 'gpt-e2e' })
  assert.equal(test.json.ok, true)
  assert.equal(llm.requests[0]!.headers.authorization, 'Bearer sk-e2e-openai-key-0001')
  await call('POST', '/bot/spawn', {})
  assert.equal(bridge.bots.get('Alu')?.online, true)

  // 5. 游戏里有人叫它干活
  llm.enqueue(
    {
      toolCalls: [
        { name: 'say', input: { message: '好，我来平。' } },
        { name: 'flatten_area', input: { x1: 0, z1: 0, x2: 15, z2: 15, y: 64, dropoff: [{ x: 20, y: 64, z: 0 }] } },
      ],
    },
    { text: '任务已启动，等它结束。' },
  )
  bridge.chat('Steve', 'Alu 把 0,0 到 15,15 这块平到 64')
  const startReq = await bridge.waitForRequest('task.start', () => true, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.deepEqual(startReq.params, {
    bot: 'Alu',
    task: { type: 'flatten', x1: 0, z1: 0, x2: 15, z2: 15, y: 64, dropoff: [{ x: 20, y: 64, z: 0 }] },
    mode: 'replace',
  })
  await waitFor('first turn finished', () => llm.requests.length === 3, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.deepEqual(bridge.chatLog, [{ bot: 'Alu', message: '好，我来平。' }])
  // 模型第一次看到的是那句聊天和当前状态
  const firstTurn = llm.requests[1]!
  assert.equal(firstTurn.api, 'openai')
  const firstUser = firstTurn.body.messages.at(-1)
  assert.match(firstUser.content, /Steve 说：Alu 把 0,0 到 15,15 这块平到 64/)
  assert.match(firstUser.content, /Alu: online in overworld/)
  assert.ok(firstTurn.body.tools.some((x: any) => x.function.name === 'flatten_area'))
  // 任务在跑，模型没有被再次调用
  assert.equal(bridge.bots.get('Alu')?.task?.type, 'flatten')

  // 6. 任务进行期间，在面板上把模型换成 Anthropic 兼容的那条
  const second = await call('POST', '/providers', { kind: 'anthropic-messages', label: '模拟 Anthropic', baseUrl: llm.anthropicBaseUrl, apiKey: 'sk-ant-e2e-key-0002', model: 'claude-e2e' })
  await call('POST', `/providers/${second.json.provider.id}/activate`, {})

  // 7. 任务结束 → 再次唤醒 → say 回话
  llm.enqueue({ thinking: { thinking: '任务完成了，告诉他。', signature: 'sig-e2e' }, toolCalls: [{ name: 'say', input: { message: '平好了。' } }] }, { text: '' })
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
  assert.deepEqual(followUp.content[0], { type: 'thinking', thinking: '任务完成了，告诉他。', signature: 'sig-e2e' })

  // 8. 面板上看得到整个过程，用量记了账（1 次测试连接 + 4 次决策）
  const log = (await call('GET', '/log')).json.entries as { kind: string; who?: string; text: string }[]
  const seen = (kind: string, re: RegExp) => assert.ok(log.some((e) => e.kind === kind && re.test(`${e.who ?? ''} ${e.text}`)), `log has ${kind} ${re}${diag()}`)
  seen('chat', /Steve Alu 把 0,0 到 15,15/)
  seen('tool_call', /flatten_area/)
  seen('tool_result', /Task t1 \(flatten\) started/)
  seen('say', /好，我来平。/)
  seen('event', /任务 t1（flatten）完成了/)
  seen('say', /平好了。/)
  const overview = (await call('GET', '/overview')).json
  assert.equal(overview.usage.today.calls, 5)
  assert.equal(overview.provider.kind, 'anthropic-messages')
  assert.equal(overview.agent.lastCall.ok, true)
  assert.equal(JSON.stringify(overview).includes('sk-ant-e2e-key-0002'), false)

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
  for (const name of ['config.json', 'history.json', 'usage.json', 'bridge-state.json', 'agent-state.json']) {
    assert.equal(fs.statSync(path.join(tmp.dir, name)).mode & 0o777, 0o600, name)
  }
  const history = JSON.parse(fs.readFileSync(path.join(tmp.dir, 'history.json'), 'utf8'))
  assert.equal(history.turns.length, 2)
  const resume = JSON.parse(fs.readFileSync(path.join(tmp.dir, 'bridge-state.json'), 'utf8'))
  assert.equal(resume.serverEpoch, bridge.epoch)
  assert.equal(resume.lastSeq, bridge.seq)
})

it('端到端：大脑进程重启后，重启期间结束的任务照样把它叫醒', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  await bridge.start()
  await llm.start()
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
  let brain = startBrain(tmp.dir, bridge)
  t.after(async () => {
    if (brain.child.exitCode === null) brain.child.kill('SIGKILL')
    await bridge.stop()
    await llm.stop()
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
  llm.enqueue({ toolCalls: [{ name: 'whisper', input: { player: 'Steve', message: '过不去，路被挡住了。' } }] }, { text: '' })
  brain = startBrain(tmp.dir, bridge)
  await waitFor('brain told Steve', () => bridge.commandLog.length === 1, 15_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.deepEqual(bridge.commandLog[0], { bot: 'Alu', command: 'tell Steve 过不去，路被挡住了。' })
  assert.match(JSON.stringify(llm.requests[2]!.body.messages.at(-1)), /任务 t1（goto）失败了：unreachable/)
  // 第二次握手带着落盘的续传位置
  assert.equal(bridge.hellos[1]!.serverEpoch, bridge.epoch)
  assert.equal(typeof bridge.hellos[1]!.lastSeq, 'number')

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})
