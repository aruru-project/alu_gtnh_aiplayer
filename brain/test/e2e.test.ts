// 端到端：模拟 bridge + 模拟模型服务 + 真实启动 src/main.ts（子进程）。
// 像主人那样操作：看启动输出里的口令 → 登录面板 → 配模型 → 让 bot 上线 → 游戏里说一句话。
// 然后从这条聊天一路走到任务启动、任务结束再唤醒、say 回话。

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { makeSchematic, tmpDir, waitFor } from './helpers.ts'
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

it('端到端：主人在面板上传图纸 → 叫它照着盖 → 先对比再动手 → 材料不够时它被叫醒，看到每种还缺多少', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  await bridge.start()
  await llm.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      panel: { password: 'preset-password-for-e2e' },
      providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }],
      activeProviderId: 'mock',
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

  // 3. 主人叫它盖：它先对比，再启动任务
  llm.enqueue(
    { toolCalls: [{ name: 'check_blueprint', input: { name: 'cabin', x: 30, y: 65, z: 30 } }] },
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
  llm.enqueue({ toolCalls: [{ name: 'whisper', input: { player: 'Steve', message: '还差 15 块石砖，箱子得你自己放。' } }] }, { text: '' })
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
  await bridge.start()
  await llm.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }],
      activeProviderId: 'mock',
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

  // 2. 取料任务一做完就轮到合成（3x3 的配方，它旁边有工作台）；取料结束把它叫醒了一次，它什么都不用做
  await waitFor('woken by the withdraw', () => llm.requests.length === 6, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.match(seen(5), /任务 t1（withdraw）完成了。 结果：\{\\"moved\\":8\}/)
  assert.equal(bridge.bots.get('Alu')?.task?.type, 'craft')

  // 3. 合成做完：被叫醒，看到做出了什么，告诉主人
  llm.enqueue({ toolCalls: [{ name: 'whisper', input: { player: 'Steve', message: '桨叶做好了。' } }] }, { text: '' })
  bridge.completeTask('Alu')
  await waitFor('brain told Steve', () => bridge.commandLog.length === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.match(seen(6), /任务 t2（craft）完成了。 结果：crafted 1× adventurebackpack:backpackComponent\/6 \\"Copter Blades\\", freeSlots \d+/)
  // 背包里：成品在，轴和螺丝用掉了，螺丝刀还在
  const carried = (id: string, meta: number) => bridge.bots.get('Alu')!.inventory.filter((i) => i.id === id && i.meta === meta).reduce((n, i) => n + i.count, 0)
  assert.deepEqual(
    [carried(blades.id, 6), carried('IC2:itemRecipePart', 12), carried('gregtech:gt.metaitem.01', 27305), carried('gregtech:gt.metatool.01', 22)],
    [1, 0, 0, 1],
  )

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})

it('端到端：主人在面板写了一本手册，然后问“任务书下一步做什么” → 它先翻手册再查任务书 → 把能做的任务告诉主人', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  await bridge.start()
  await llm.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      panel: { password: 'preset-password-for-e2e' },
      providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }],
      activeProviderId: 'mock',
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
    { toolCalls: [{ name: 'whisper', input: { player: 'Steve', message: '能做的有 3 个，最近的是做个直升机背包交任务。' } }] },
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
  assert.match(seen(1), /任务书里的文字是英文的/)
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

it('端到端：只有机器配方的东西（钢杆）→ 它查配方、找机器、取料、用车床加工 → 取回产物后告诉主人；没电的机器开不了工', async (t) => {
  const tmp = tmpDir('aiplayer-e2e-')
  const bridge = new MockBridge({ bots: ['Alu'] })
  const llm = new MockLlm()
  await bridge.start()
  await llm.start()
  fs.writeFileSync(
    path.join(tmp.dir, 'config.json'),
    JSON.stringify({
      providers: [{ id: 'mock', label: 'mock', kind: 'anthropic-messages', baseUrl: llm.anthropicBaseUrl, apiKey: 'k', model: 'claude-e2e' }],
      activeProviderId: 'mock',
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

  // 2. 取料做完就轮到加工；车床做完，它被叫醒，看到取回了什么
  await waitFor('woken by the withdraw', () => llm.requests.length === 5, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.equal(bridge.bots.get('Alu')?.task?.type, 'process')
  llm.enqueue(
    // 再拿这两根钢杆去没电的组装机试一下：开不了工
    { toolCalls: [{ name: 'process_items', input: { machine: { x: assembler.x, y: assembler.y, z: assembler.z }, inputs: [{ id: GT, meta: 23305, count: 2 }] } }] },
    { text: '' },
  )
  bridge.completeTask('Alu')
  await waitFor('second process task ended', () => bridge.bots.get('Alu')?.recent.some((x) => x.id === 't3'), 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  assert.match(seen(5), /任务 t2（process）完成了。 结果：put 2 item\(s\) into the machine; took out: 2× gregtech:gt\.metaitem\.01\/23305 \\"Steel Rod\\", 4× gregtech:gt\.metaitem\.01\/1305 \\"Small Pile of Steel Dust\\"; freeSlots \d+/)

  // 3. 没电的机器：任务以 invalid 失败，它看到机器状态，告诉主人
  llm.enqueue({ toolCalls: [{ name: 'whisper', input: { player: 'Steve', message: '钢杆车好了两根；组装机没电，开不了。' } }] }, { text: '' })
  await waitFor('brain told Steve', () => bridge.commandLog.length === 1, 10_000).catch((e) => assert.fail(`${e.message}${diag()}`))
  const failed = seen(7)
  assert.match(failed, /任务 t3（process）失败了：invalid — the machine did not start/)
  assert.match(failed, /machine \\"Basic Assembling Machine\\" at \(18,64,-4\): runs Assembler recipes, tier LV, NO POWER \(0 EU stored\), idle\. It has no power/)
  // 原料拿回来了：两根钢杆还在身上，钢锭用掉了
  const carried = (meta: number) => bridge.bots.get('Alu')!.inventory.filter((i) => i.id === GT && i.meta === meta).reduce((n, i) => n + i.count, 0)
  assert.deepEqual([carried(23305), carried(1305), carried(11305)], [2, 4, 0])

  brain.child.kill('SIGTERM')
  assert.equal(await brain.exited, 0, diag())
})
