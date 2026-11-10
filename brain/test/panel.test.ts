import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { AgentEvent } from '../src/agent/events.ts'
import { DEFAULT_PERSONA } from '../src/agent/prompt.ts'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import type { ProviderConfig, TestConnectionResult } from '../src/llm/index.ts'
import { PanelServer } from '../src/panel/server.ts'
import { ActivityLog } from '../src/store/activity-log.ts'
import { ConfigStore, overridesFromEnv } from '../src/store/config.ts'
import { HistoryStore } from '../src/store/history.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { UsageStore } from '../src/store/usage.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { tmpDir, waitFor } from './helpers.ts'

const FULL_KEY = 'sk-live-ABCDEFGHIJKLMNOP-9876'

async function setup(t: { after(fn: () => void | Promise<void>): void }, env: NodeJS.ProcessEnv = {}) {
  const tmp = tmpDir()
  const config = new ConfigStore(tmp.dir, overridesFromEnv(env))
  const game = new FakeGame()
  const log = new ActivityLog()
  const memory = new MemoryStore(tmp.dir, () => config.get().bot.limits.memoryMaxChars)
  const manuals = new ManualStore(DEFAULT_MANUALS_DIR, path.join(tmp.dir, 'manuals'))
  const events: AgentEvent[] = []
  const tested: ProviderConfig[] = []
  let expectedCancels = 0
  const panel = new PanelServer({
    config,
    memory,
    usage: new UsageStore(tmp.dir),
    log,
    history: new HistoryStore(tmp.dir),
    manuals,
    bridge: new BridgeApi(game),
    bridgeStatus: () => ({ state: 'connected', address: '127.0.0.1:1' }),
    agent: {
      handleEvent: (ev) => events.push(ev),
      status: () => ({ busy: false, pending: 0, background: 0, botOnline: true, trackedTasks: [] }),
      ownCancel: async (fn) => {
        expectedCancels++
        return fn()
      },
    },
    reminders: { list: () => [], remove: () => false },
    testConnection: async (p): Promise<TestConnectionResult> => {
      tested.push(p)
      return { ok: true, durationMs: 12, model: p.model, reply: 'pong' }
    },
  })
  const { port } = await panel.listen('127.0.0.1', 0)
  t.after(async () => {
    await panel.close()
    tmp.cleanup()
  })
  const origin = `http://127.0.0.1:${port}`
  let cookie = ''

  /** 像面板页面里的 fetch 那样发请求：带会话 cookie，写操作带同源的 Origin。 */
  const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${origin}${route}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: res.status, json, text, headers: res.headers }
  }
  const login = async () => {
    const res = await call('POST', '/api/login', { password: config.get().panel.password })
    assert.equal(res.status, 200)
    cookie = res.headers.getSetCookie()[0]!.split(';')[0]!
    return res
  }
  return { tmp, config, game, log, memory, manuals, events, tested, call, login, origin, port, cancels: () => expectedCancels, setCookie: (c: string) => (cookie = c) }
}

const PROVIDER = {
  kind: 'openai-chat',
  label: '主力',
  baseUrl: 'https://api.example.com/v1',
  apiKey: FULL_KEY,
  model: 'gpt-x',
}

describe('面板：鉴权', () => {
  it('没登录时页面能打开，但所有数据接口都返回 401', async (t) => {
    const s = await setup(t)
    const page = await s.call('GET', '/')
    assert.equal(page.status, 200)
    assert.match(page.text, /<title>AI 玩家/)
    assert.equal((await s.call('GET', '/app.js')).status, 200)
    for (const route of ['/api/overview', '/api/providers', '/api/bot', '/api/memory', '/api/manuals', '/api/blueprints', '/api/events', '/api/log']) {
      assert.equal((await s.call('GET', route)).status, 401, route)
    }
    assert.equal((await s.call('POST', '/api/command', { text: '回家' })).status, 401)
    assert.equal((await s.call('POST', '/api/blueprints', { name: 'hut', data: 'AAAA' })).status, 401)
    assert.equal((await s.call('DELETE', '/api/blueprints', { name: 'hut' })).status, 401)
    assert.equal((await s.call('PUT', '/api/manuals', { name: 'base', summary: 's', body: 'b' })).status, 401)
    assert.equal((await s.call('DELETE', '/api/manuals', { name: 'base' })).status, 401)
    assert.equal(s.manuals.list().some((m) => m.source === 'user'), false)
    assert.deepEqual((await s.call('GET', '/api/session')).json, { authenticated: false })
    assert.equal(s.events.length, 0)
    assert.equal(s.game.calls.length, 0)
  })

  it('口令不对登不上；口令对了拿到 HttpOnly、SameSite=Strict 的会话 cookie，之后能访问', async (t) => {
    const s = await setup(t)
    const bad = await s.call('POST', '/api/login', { password: 'guess' })
    assert.equal(bad.status, 401)
    assert.equal(bad.headers.getSetCookie().length, 0)

    const ok = await s.login()
    const setCookie = ok.headers.getSetCookie()[0]!
    assert.match(setCookie, /^aiplayer_session=[^;]+;/)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)
    assert.equal((await s.call('GET', '/api/overview')).status, 200)
    assert.deepEqual((await s.call('GET', '/api/session')).json, { authenticated: true })
  })

  it('首次启动生成的口令是随机的，并且存进了配置文件', async (t) => {
    const s = await setup(t)
    const onDisk = JSON.parse(fs.readFileSync(path.join(s.tmp.dir, 'config.json'), 'utf8'))
    assert.equal(onDisk.panel.password, s.config.get().panel.password)
    assert.ok(onDisk.panel.password.length >= 20)
    assert.equal(s.config.passwordGenerated, true)
    // 再开一次不会换口令
    const again = new ConfigStore(s.tmp.dir)
    assert.equal(again.passwordGenerated, false)
    assert.equal(again.get().panel.password, onDisk.panel.password)
  })

  it('连续输错 5 次后被暂时锁住，这时连正确的口令也不行', async (t) => {
    const s = await setup(t)
    for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/login', { password: `wrong${i}` })).status, 401)
    const locked = await s.call('POST', '/api/login', { password: s.config.get().panel.password })
    assert.equal(locked.status, 429)
    assert.ok(Number(locked.headers.get('retry-after')) > 0)
  })

  it('写操作必须带同源的 Origin：没带或来自别的站点都被拒绝，什么都不会发生', async (t) => {
    const s = await setup(t)
    await s.login()
    const foreign = await s.call('POST', '/api/command', { text: '把箱子清空' }, { origin: 'https://evil.example' })
    assert.equal(foreign.status, 403)
    const none = await fetch(`${s.origin}/api/command`, {
      method: 'POST',
      headers: { cookie: (await s.login()).headers.getSetCookie()[0]!.split(';')[0]!, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '把箱子清空' }),
    })
    assert.equal(none.status, 403)
    assert.equal(s.events.length, 0)
    // 登录也是写操作
    assert.equal((await s.call('POST', '/api/login', { password: s.config.get().panel.password }, { origin: 'https://evil.example' })).status, 403)
  })

  it('改了口令以后，旧的会话立刻失效', async (t) => {
    const s = await setup(t)
    await s.login()
    assert.equal((await s.call('GET', '/api/overview')).status, 200)
    s.config.update((c) => {
      c.panel.password = 'a-new-password-chosen-by-owner'
    })
    assert.equal((await s.call('GET', '/api/overview')).status, 401)
  })

  it('不能通过路径读到面板目录以外的文件', async (t) => {
    const s = await setup(t)
    for (const p of ['/../server.ts', '/..%2f..%2f..%2fdata%2fconfig.json', '/.env', '/public/app.js', '/config.json']) {
      const res = await fetch(`${s.origin}${p}`)
      assert.equal(res.status, 404, p)
    }
  })
})

describe('面板：API key 只写不读', () => {
  it('保存后任何接口都拿不回完整的 key，只有掩码和“已设置”标记；key 在配置文件里可用', async (t) => {
    const s = await setup(t)
    await s.login()
    const created = await s.call('POST', '/api/providers', PROVIDER)
    assert.equal(created.status, 200)
    const listed = await s.call('GET', '/api/providers')
    const overview = await s.call('GET', '/api/overview')
    for (const res of [created, listed, overview]) {
      assert.equal(res.text.includes(FULL_KEY), false)
      assert.equal(res.text.includes('ABCDEFGH'), false)
    }
    const p = listed.json.providers[0]
    assert.equal(p.apiKey, undefined)
    assert.equal(p.apiKeySet, true)
    assert.equal(p.apiKeyMasked, 'sk-…9876')
    assert.equal(listed.json.activeProviderId, p.id)
    // 大脑自己用的那份是完整的
    assert.equal(s.config.activeProvider()?.apiKey, FULL_KEY)
    // 文件权限 600
    assert.equal(fs.statSync(path.join(s.tmp.dir, 'config.json')).mode & 0o777, 0o600)
  })

  it('编辑时 key 留空表示不修改；填了新值才替换', async (t) => {
    const s = await setup(t)
    await s.login()
    const id = (await s.call('POST', '/api/providers', PROVIDER)).json.provider.id as string

    const renamed = await s.call('PUT', `/api/providers/${id}`, { ...PROVIDER, apiKey: '', model: 'gpt-y', label: '改名了' })
    assert.equal(renamed.status, 200)
    assert.equal(s.config.activeProvider()?.apiKey, FULL_KEY)
    assert.equal(s.config.activeProvider()?.model, 'gpt-y')

    await s.call('PUT', `/api/providers/${id}`, { ...PROVIDER, apiKey: 'sk-brand-new-key-0001' })
    assert.equal(s.config.activeProvider()?.apiKey, 'sk-brand-new-key-0001')
  })

  it('把服务地址改到别的主机却不重填 key 会被拒绝（否则能把 key 套走）', async (t) => {
    const s = await setup(t)
    await s.login()
    const id = (await s.call('POST', '/api/providers', PROVIDER)).json.provider.id as string
    const moved = await s.call('PUT', `/api/providers/${id}`, { ...PROVIDER, apiKey: '', baseUrl: 'https://attacker.example/v1' })
    assert.equal(moved.status, 400)
    assert.equal(s.config.activeProvider()?.baseUrl, 'https://api.example.com/v1')
    const probed = await s.call('POST', '/api/providers/test', { ...PROVIDER, id, apiKey: '', baseUrl: 'https://attacker.example/v1' })
    assert.equal(probed.status, 400)
    assert.equal(s.tested.length, 0)
    // 同一台主机上换个路径是允许的
    assert.equal((await s.call('PUT', `/api/providers/${id}`, { ...PROVIDER, apiKey: '', baseUrl: 'https://api.example.com/openai/v1' })).status, 200)
  })

  it('测试连接用的是已保存的 key，结果里不带 key', async (t) => {
    const s = await setup(t)
    await s.login()
    const id = (await s.call('POST', '/api/providers', PROVIDER)).json.provider.id as string
    const res = await s.call('POST', '/api/providers/test', { ...PROVIDER, id, apiKey: '', model: 'gpt-draft' })
    assert.deepEqual(res.json, { ok: true, durationMs: 12, model: 'gpt-draft', reply: 'pong' })
    assert.equal(s.tested[0]!.apiKey, FULL_KEY)
    assert.equal(s.tested[0]!.model, 'gpt-draft')
    // 测试草稿不会改动已保存的配置
    assert.equal(s.config.activeProvider()?.model, 'gpt-x')
  })

  it('像 key 一样敏感的自定义请求头也只显示掩码，原样交回时不会被掩码覆盖', async (t) => {
    const s = await setup(t)
    await s.login()
    const headers = { 'x-api-key': 'secret-gateway-token-7777', 'anthropic-beta': 'tools-2024' }
    const created = await s.call('POST', '/api/providers', { ...PROVIDER, extraHeaders: headers })
    const shown = created.json.provider.extraHeaders
    assert.deepEqual(shown, { 'x-api-key': '…7777', 'anthropic-beta': 'tools-2024' })
    await s.call('PUT', `/api/providers/${created.json.provider.id}`, { ...PROVIDER, apiKey: '', extraHeaders: shown })
    assert.deepEqual(s.config.activeProvider()?.extraHeaders, headers)
  })

  it('可以存多条服务商、切换当前使用的、删除', async (t) => {
    const s = await setup(t)
    await s.login()
    const a = (await s.call('POST', '/api/providers', PROVIDER)).json.provider.id as string
    const b = (await s.call('POST', '/api/providers', { ...PROVIDER, kind: 'anthropic-messages', label: '备用', baseUrl: 'https://api.anthropic.example', model: 'claude-x' })).json.provider.id as string
    assert.equal(s.config.get().activeProviderId, a)
    assert.equal((await s.call('POST', `/api/providers/${b}/activate`, {})).json.activeProviderId, b)
    assert.equal(s.config.activeProvider()?.kind, 'anthropic-messages')
    const afterDelete = await s.call('DELETE', `/api/providers/${b}`, {})
    assert.equal(afterDelete.json.providers.length, 1)
    assert.equal(s.config.get().activeProviderId, a)
    // 接口类型下拉框的内容来自适配器注册表
    assert.deepEqual(afterDelete.json.adapters.map((x: { kind: string }) => x.kind), ['openai-chat', 'anthropic-messages'])
  })

  it('不合法的服务商配置被拒绝并说明原因', async (t) => {
    const s = await setup(t)
    await s.login()
    const badUrl = await s.call('POST', '/api/providers', { ...PROVIDER, baseUrl: 'api.example.com' })
    const badKind = await s.call('POST', '/api/providers', { ...PROVIDER, kind: 'gemini' })
    const noModel = await s.call('POST', '/api/providers', { ...PROVIDER, model: ' ' })
    assert.deepEqual([badUrl.status, badKind.status, noModel.status], [400, 400, 400])
    assert.match(badUrl.json.error.message, /URL/)
    assert.match(badKind.json.error.message, /接口类型/)
    assert.equal(s.config.get().providers.length, 0)
  })
})

describe('面板：对话、AI 玩家、记忆', () => {
  it('对话框里发的话以面板指令的身份交给 agent', async (t) => {
    const s = await setup(t)
    await s.login()
    assert.equal((await s.call('POST', '/api/command', { text: '  回家把东西存了  ' })).status, 200)
    assert.equal(s.events.length, 1)
    assert.equal(s.events[0]!.type, 'panel_command')
    assert.equal((s.events[0] as { text: string }).text, '回家把东西存了')
    assert.equal((await s.call('POST', '/api/command', { text: '   ' })).status, 400)
  })

  it('实时日志：连上时先收到已有的记录，之后新的记录实时推过来', async (t) => {
    const s = await setup(t)
    const { headers } = await s.login()
    s.log.add({ kind: 'chat', who: 'Steve', text: '之前说的话' })
    const res = await fetch(`${s.origin}/api/events`, { headers: { cookie: headers.getSetCookie()[0]!.split(';')[0]! } })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let received = ''
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        received += decoder.decode(value, { stream: true })
      }
    })()
    await waitFor('backlog', () => received.includes('之前说的话'))
    s.log.add({ kind: 'say', who: 'Alu', text: '刚刚说的话' })
    await waitFor('live entry', () => received.includes('刚刚说的话'))
    const frames = received.split('\n\n').filter((f) => f.includes('data: '))
    const last = JSON.parse(frames.at(-1)!.split('data: ')[1]!)
    assert.deepEqual([last.kind, last.who, last.text], ['say', 'Alu', '刚刚说的话'])
    assert.match(frames.at(-1)!, /^id: \d+$/m)
    await reader.cancel()
    await pump
  })

  it('AI 玩家设置保存后立刻反映在配置里；名字不合法时拒绝', async (t) => {
    const s = await setup(t)
    await s.login()
    const saved = await s.call('PUT', '/api/bot', {
      name: 'Lulu',
      aliases: '阿鲁, 小鲁',
      owners: 'Steve Alex',
      systemPrompt: '你是 {{name}}，只说文言文。',
      wake: { mode: 'all', conversationWindowSec: 120 },
      limits: { maxSteps: 8, dailyTokenLimit: 500000 },
    })
    assert.equal(saved.status, 200)
    const bot = s.config.get().bot
    assert.equal(bot.name, 'Lulu')
    assert.deepEqual(bot.aliases, ['阿鲁', '小鲁'])
    assert.deepEqual(bot.owners, ['Steve', 'Alex'])
    assert.equal(bot.systemPrompt, '你是 {{name}}，只说文言文。')
    assert.deepEqual(bot.wake, { mode: 'all', conversationWindowSec: 120 })
    assert.equal(bot.limits.maxSteps, 8)
    assert.equal(bot.limits.dailyTokenLimit, 500000)
    // 没提交的上限保持原值
    assert.equal(bot.limits.historyTokenThreshold, 24000)

    const bad = await s.call('PUT', '/api/bot', { name: '有 空格' })
    assert.equal(bad.status, 400)
    assert.equal(s.config.get().bot.name, 'Lulu')
  })

  it('人设提示词可以恢复默认：交回默认原文后存成“用默认”', async (t) => {
    const s = await setup(t)
    await s.login()
    const info = await s.call('GET', '/api/bot')
    assert.equal(info.json.defaultPersona, DEFAULT_PERSONA)
    await s.call('PUT', '/api/bot', { systemPrompt: '自定义的' })
    assert.equal(s.config.get().bot.systemPrompt, '自定义的')
    await s.call('PUT', '/api/bot', { systemPrompt: info.json.defaultPersona })
    assert.equal(s.config.get().bot.systemPrompt, '')
  })

  it('上线、下线、无敌和饥饿开关、取消任务都透传给游戏', async (t) => {
    const s = await setup(t)
    await s.login()
    s.game.handlers['bot.spawn'] = () => ({ name: 'Alu', online: true })
    s.game.handlers['bot.despawn'] = () => ({})
    s.game.handlers['bot.configure'] = (p) => ({ settings: p.settings })
    s.game.handlers['task.cancel'] = (p) => ({ canceled: 1, ids: [p.id] })

    s.game.online = false
    assert.equal((await s.call('POST', '/api/bot/spawn', {})).status, 200)
    assert.equal(s.config.get().bot.wantOnline, true)
    // 已经在线时再点“上线”：身体会拒绝重复 spawn，所以面板不再发，只把选择记下来
    s.game.online = true
    assert.equal((await s.call('POST', '/api/bot/spawn', {})).status, 200)
    assert.equal((await s.call('POST', '/api/bot/configure', { invulnerable: false, hunger: true, fly: true })).status, 200)
    assert.deepEqual((await s.call('POST', '/api/tasks/cancel', { id: 't7' })).json, { canceled: 1 })
    assert.equal((await s.call('POST', '/api/bot/despawn', {})).status, 200)
    assert.equal(s.config.get().bot.wantOnline, false)

    assert.deepEqual(s.game.callsOf('bot.spawn'), [{ name: 'Alu' }])
    // 只透传面板支持的两个开关
    assert.deepEqual(s.game.callsOf('bot.configure'), [{ bot: 'Alu', settings: { invulnerable: false, hunger: true } }])
    assert.deepEqual(s.game.callsOf('task.cancel'), [{ bot: 'Alu', id: 't7' }])
    assert.deepEqual(s.game.callsOf('bot.despawn'), [{ bot: 'Alu' }])
    // 主人自己取消的任务：经由 agent 发出，这样对应的“任务被取消”不会再把模型叫醒
    assert.equal(s.cancels(), 1)
  })

  it('游戏那边没连上时，操作给出看得懂的错误而不是 500', async (t) => {
    const s = await setup(t)
    await s.login()
    s.game.connected = false
    const res = await s.call('POST', '/api/bot/spawn', {})
    assert.equal(res.status, 503)
    assert.equal(res.json.error.code, 'disconnected')
  })

  it('记忆可以查看、新增、改名、删除', async (t) => {
    const s = await setup(t)
    await s.login()
    s.memory.set('home:base', '(0,64,0) 主仓库')
    const listed = await s.call('GET', '/api/memory')
    assert.deepEqual(listed.json.notes.map((n: { key: string; text: string }) => [n.key, n.text]), [['home:base', '(0,64,0) 主仓库']])
    assert.equal(listed.json.maxChars, 4000)

    await s.call('PUT', '/api/memory', { key: 'job', text: '平地中' })
    await s.call('PUT', '/api/memory', { key: 'home:main', text: '(0,64,0) 主仓库，一楼', previousKey: 'home:base' })
    assert.deepEqual(s.memory.list().map((n) => n.key), ['home:main', 'job'])
    assert.equal(s.memory.get('home:main')?.text, '(0,64,0) 主仓库，一楼')

    const afterDelete = await s.call('DELETE', '/api/memory', { key: 'job' })
    assert.equal(afterDelete.json.notes.length, 1)
    const tooLong = await s.call('PUT', '/api/memory', { key: 'x', text: 'y'.repeat(1001) })
    assert.equal(tooLong.status, 400)
  })

  it('手册页：能看默认手册的内容；可以新写、改名、删除自己的手册', async (t) => {
    const s = await setup(t)
    await s.login()
    const listed = await s.call('GET', '/api/manuals')
    assert.equal(listed.status, 200)
    const blueprint = listed.json.manuals.find((m: { name: string }) => m.name === 'blueprint')
    assert.equal(blueprint.source, 'default')
    assert.match(blueprint.summary, /图纸/)
    assert.match(blueprint.body, /check_blueprint/)
    assert.deepEqual(listed.json.limits, { nameMaxChars: 40, summaryMaxChars: 150, bodyMaxChars: 8000, maxUserManuals: 50 })

    const created = await s.call('PUT', '/api/manuals', { name: '基地布局', summary: '要在基地里找仓库、机器时看。', body: '仓库在 (100,64,200) 一带。' })
    assert.equal(created.status, 200)
    assert.deepEqual(created.json.saved, { name: '基地布局', summary: '要在基地里找仓库、机器时看。', body: '仓库在 (100,64,200) 一带。', source: 'user', overridesDefault: false })
    // 它下次要用时读到的就是这一本
    assert.equal(s.manuals.get('基地布局')?.body, '仓库在 (100,64,200) 一带。')
    assert.equal(created.json.manuals.at(-1).name, '基地布局')

    // 改名并改内容：旧名字的那本没了
    const renamed = await s.call('PUT', '/api/manuals', { name: '基地', summary: '找仓库时看。', body: '仓库搬到 (300,64,200) 了。', previousName: '基地布局' })
    assert.equal(renamed.status, 200)
    assert.deepEqual(s.manuals.list().filter((m) => m.source === 'user').map((m) => [m.name, m.body]), [['基地', '仓库搬到 (300,64,200) 了。']])

    const removed = await s.call('DELETE', '/api/manuals', { name: '基地' })
    assert.deepEqual([removed.json.removed, removed.json.restoredDefault], [true, false])
    assert.equal(s.manuals.get('基地'), undefined)
    assert.ok(s.log.recent(0, 50).some((e) => e.kind === 'info' && /删除了手册 基地/.test(e.text)))
  })

  it('手册页：改默认手册等于写一本同名的盖住它（默认的原文还看得到）；“恢复默认”把自己那份删掉', async (t) => {
    const s = await setup(t)
    await s.login()
    const original = s.manuals.get('blueprint')!
    const edited = await s.call('PUT', '/api/manuals', { name: 'blueprint', summary: '盖房子之前看（我们服的规矩）。', body: '一律先问我，不许自己清场。' })
    assert.equal(edited.status, 200)
    assert.equal(edited.json.saved.overridesDefault, true)
    const shown = edited.json.manuals.find((m: { name: string }) => m.name === 'blueprint')
    assert.deepEqual([shown.source, shown.overridesDefault, shown.body], ['user', true, '一律先问我，不许自己清场。'])
    // 默认的原文一起给面板，好对照
    assert.deepEqual(shown.default, { summary: original.summary, body: original.body })
    assert.equal(s.manuals.get('blueprint')?.body, '一律先问我，不许自己清场。')

    const restored = await s.call('DELETE', '/api/manuals', { name: 'blueprint' })
    assert.deepEqual([restored.json.removed, restored.json.restoredDefault], [true, true])
    assert.deepEqual(s.manuals.get('blueprint'), original)
    // 默认手册本身删不掉：再删一次什么都不会发生
    const again = await s.call('DELETE', '/api/manuals', { name: 'blueprint' })
    assert.deepEqual([again.json.removed, again.json.restoredDefault], [false, false])
    assert.deepEqual(s.manuals.get('blueprint'), original)
  })

  it('手册页：名字带路径的、内容不合规的、不是从面板页面发来的，都存不进去', async (t) => {
    const s = await setup(t)
    await s.login()
    // 数据目录里别的文件（比如带着 API key 的 config.json）不能被当成手册改掉或删掉
    const config = fs.readFileSync(path.join(s.tmp.dir, 'config.json'), 'utf8')
    for (const name of ['../config', '../config.json', 'a/b', '..', '.hidden', 'x.md', 'has space', '']) {
      assert.equal((await s.call('PUT', '/api/manuals', { name, summary: '什么时候看', body: '正文' })).status, 400, `save "${name}"`)
      assert.equal((await s.call('DELETE', '/api/manuals', { name })).status, 400, `delete "${name}"`)
    }
    assert.equal(fs.readFileSync(path.join(s.tmp.dir, 'config.json'), 'utf8'), config)
    const tooLong = await s.call('PUT', '/api/manuals', { name: 'base', summary: '找仓库时看', body: '长'.repeat(8001) })
    assert.equal(tooLong.status, 400)
    assert.match(tooLong.json.error.message, /最长 8000/)
    assert.equal((await s.call('PUT', '/api/manuals', { name: 'base', summary: '', body: '正文' })).status, 400)
    assert.equal((await s.call('PUT', '/api/manuals', { name: 'base', summary: '找仓库时看', body: '正文' }, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await s.call('DELETE', '/api/manuals', { name: 'blueprint' }, { origin: 'https://evil.example' })).status, 403)
    assert.equal(s.manuals.list().some((m) => m.source === 'user'), false)
    assert.equal(fs.existsSync(path.join(s.tmp.dir, 'manuals')) ? fs.readdirSync(path.join(s.tmp.dir, 'manuals')).length : 0, 0)
  })

  it('图纸页：列出游戏服务器上的图纸（读不了的带原因）；上传把文件内容转给游戏；可以删除', async (t) => {
    const s = await setup(t)
    await s.login()
    const stored: Record<string, unknown>[] = [
      { name: '02_Workshop_v3', size: { x: 32, y: 27, z: 32 }, blocks: 5294 },
      { name: 'broken', error: 'not a .schematic file (it is not gzip-compressed NBT)' },
    ]
    s.game.handlers['blueprint.list'] = () => ({ blueprints: stored, folder: 'config/aiplayer/schematics' })
    s.game.handlers['blueprint.put'] = (p) => {
      const saved = { name: p.name, size: { x: 5, y: 4, z: 5 }, blocks: 81 }
      stored.push(saved)
      return saved
    }
    s.game.handlers['blueprint.remove'] = (p) => {
      const at = stored.findIndex((b) => b.name === p.name)
      if (at !== -1) stored.splice(at, 1)
      return { removed: at !== -1 }
    }

    const listed = await s.call('GET', '/api/blueprints')
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.json.blueprints, [
      { name: '02_Workshop_v3', size: { x: 32, y: 27, z: 32 }, blocks: 5294 },
      { name: 'broken', error: 'not a .schematic file (it is not gzip-compressed NBT)' },
    ])
    // 上传大小的上限按协议：2 MiB
    assert.equal(listed.json.maxBytes, 2 * 1024 * 1024)

    // 浏览器把文件读成 base64 交上来；文件名带着后缀也行
    const data = Buffer.from('pretend this is a gzip-compressed schematic').toString('base64')
    const uploaded = await s.call('POST', '/api/blueprints', { name: 'hut.schematic', data })
    assert.equal(uploaded.status, 200)
    assert.deepEqual(s.game.callsOf('blueprint.put'), [{ name: 'hut', data }])
    assert.deepEqual(uploaded.json.saved, { name: 'hut', size: { x: 5, y: 4, z: 5 }, blocks: 81 })
    assert.deepEqual(uploaded.json.blueprints.map((b: { name: string }) => b.name), ['02_Workshop_v3', 'broken', 'hut'])
    assert.ok(s.log.recent(0, 50).some((e) => e.kind === 'info' && /上传了图纸 hut（5×4×5，81 个方块）/.test(e.text)))

    const removed = await s.call('DELETE', '/api/blueprints', { name: 'broken' })
    assert.equal(removed.status, 200)
    assert.equal(removed.json.removed, true)
    assert.deepEqual(s.game.callsOf('blueprint.remove'), [{ name: 'broken' }])
    assert.deepEqual(removed.json.blueprints.map((b: { name: string }) => b.name), ['02_Workshop_v3', 'hut'])
  })

  it('图纸页：刚好 2 MiB 的文件传得上去；超过的、名字带路径的、不是从面板页面发来的，游戏那边什么都收不到', async (t) => {
    const s = await setup(t)
    await s.login()
    s.game.handlers['blueprint.list'] = () => ({ blueprints: [], folder: 'config/aiplayer/schematics' })
    s.game.handlers['blueprint.put'] = (p) => ({ name: p.name, size: { x: 1, y: 1, z: 1 }, blocks: 1 })
    const MiB = 1024 * 1024

    const largest = Buffer.alloc(2 * MiB, 7).toString('base64')
    const ok = await s.call('POST', '/api/blueprints', { name: 'big', data: largest })
    assert.equal(ok.status, 200, ok.text)
    assert.equal(Buffer.from(String(s.game.callsOf('blueprint.put')[0]!.data), 'base64').length, 2 * MiB)

    const tooBig = await s.call('POST', '/api/blueprints', { name: 'bigger', data: Buffer.alloc(2 * MiB + 1, 7).toString('base64') })
    assert.equal(tooBig.status, 413)
    assert.match(tooBig.json.error.message, /最大 2 MiB/)
    for (const name of ['../outside', 'folder/plan', '.hidden', 'a\\b', '']) {
      assert.equal((await s.call('POST', '/api/blueprints', { name, data: 'AAAA' })).status, 400, name)
      assert.equal((await s.call('DELETE', '/api/blueprints', { name })).status, 400, name)
    }
    assert.equal((await s.call('POST', '/api/blueprints', { name: 'x', data: 'not base64!' })).status, 400)
    assert.equal((await s.call('POST', '/api/blueprints', { name: 'x', data: 'AAAA' }, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await s.call('DELETE', '/api/blueprints', { name: 'big' }, { origin: 'https://evil.example' })).status, 403)
    assert.equal(s.game.callsOf('blueprint.put').length, 1)
    assert.equal(s.game.callsOf('blueprint.remove').length, 0)
  })

  it('图纸页：游戏说这个文件不是能用的图纸时，把它给的原因原样显示出来', async (t) => {
    const s = await setup(t)
    await s.login()
    s.game.handlers['blueprint.put'] = () => {
      throw new BridgeError('bad_request', 'the file does not say which blocks its numbers stand for; save it with Schematica')
    }
    const res = await s.call('POST', '/api/blueprints', { name: 'worldedit-export', data: 'AAAA' })
    assert.equal(res.status, 400)
    assert.match(res.json.error.message, /the file does not say which blocks its numbers stand for; save it with Schematica/)
    // 没连上游戏时和别的操作一样，给出看得懂的错误
    s.game.connected = false
    assert.equal((await s.call('GET', '/api/blueprints')).status, 503)
  })

  it('设置页：改 bridge 端口和口令文件路径后存进配置；不合法的端口被拒绝', async (t) => {
    const s = await setup(t)
    await s.login()
    const before = (await s.call('GET', '/api/settings')).json
    // 默认按正式部署来：端口 25590，口令文件没有默认值
    assert.deepEqual(before.bridge, { port: 25590, tokenFile: '' })
    assert.equal(before.effective.configured, false)
    assert.equal(before.effective.host, '127.0.0.1')

    const saved = await s.call('PUT', '/api/settings/bridge', { port: 25591, tokenFile: ' /srv/gtnh/config/aiplayer/bridge-token.txt ' })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.json.bridge, { port: 25591, tokenFile: '/srv/gtnh/config/aiplayer/bridge-token.txt' })
    assert.equal(saved.json.effective.configured, true)
    assert.equal(s.config.bridgeSettings().port, 25591)
    assert.equal(s.config.bridgeSettings().tokenFile, '/srv/gtnh/config/aiplayer/bridge-token.txt')

    for (const port of [0, 70000, 'abc', 25591.5]) {
      assert.equal((await s.call('PUT', '/api/settings/bridge', { port, tokenFile: '' })).status, 400, String(port))
    }
    assert.equal(s.config.get().bridge.port, 25591)
    // 主机不能从面板改（改了也不生效）
    await s.call('PUT', '/api/settings/bridge', { port: 25591, tokenFile: '', host: 'attacker.example' })
    assert.equal(s.config.get().bridge.host, '127.0.0.1')
  })

  it('设置页：被环境变量盖住的项会标出来，并显示实际在用的值', async (t) => {
    const s = await setup(t, { AIPLAYER_BRIDGE_PORT: '25591', AIPLAYER_BRIDGE_TOKEN_FILE: '../testserver/config/aiplayer/bridge-token.txt' })
    await s.login()
    const got = (await s.call('GET', '/api/settings')).json
    assert.deepEqual(got.bridge, { port: 25590, tokenFile: '' })
    assert.equal(got.effective.port, 25591)
    assert.equal(got.effective.tokenFile, '../testserver/config/aiplayer/bridge-token.txt')
    assert.equal(got.overridden.bridgePort, true)
    assert.equal(got.overridden.bridgeTokenFile, true)
    assert.equal(got.overridden.bridgeToken, false)
  })

  it('设置页：改面板口令要先给对当前口令；改完旧登录失效，这个浏览器接着能用，新口令能登录', async (t) => {
    const s = await setup(t)
    const oldPassword = s.config.get().panel.password
    const oldCookie = (await s.login()).headers.getSetCookie()[0]!.split(';')[0]!

    const wrong = await s.call('PUT', '/api/settings/password', { current: 'not-it', next: 'a-brand-new-password' })
    assert.equal(wrong.status, 403)
    const short = await s.call('PUT', '/api/settings/password', { current: oldPassword, next: 'short' })
    assert.equal(short.status, 400)
    assert.equal(s.config.get().panel.password, oldPassword)

    const changed = await s.call('PUT', '/api/settings/password', { current: oldPassword, next: 'a-brand-new-password' })
    assert.equal(changed.status, 200)
    assert.equal(s.config.get().panel.password, 'a-brand-new-password')
    const newCookie = changed.headers.getSetCookie()[0]!.split(';')[0]!
    assert.notEqual(newCookie, oldCookie)

    // 旧的会话失效
    assert.equal((await s.call('GET', '/api/overview')).status, 401)
    // 响应里给的新会话可用
    s.setCookie(newCookie)
    assert.equal((await s.call('GET', '/api/overview')).status, 200)
    // 旧口令登不上，新口令可以
    assert.equal((await s.call('POST', '/api/login', { password: oldPassword })).status, 401)
    assert.equal((await s.call('POST', '/api/login', { password: 'a-brand-new-password' })).status, 200)
    // 口令不出现在任何响应里
    assert.equal(changed.text.includes('a-brand-new-password'), false)
  })

  it('概览汇总连接、bot、任务、当前模型和今日用量', async (t) => {
    const s = await setup(t)
    await s.login()
    await s.call('POST', '/api/providers', PROVIDER)
    const o = (await s.call('GET', '/api/overview')).json
    assert.equal(o.bridge.state, 'connected')
    assert.equal(o.bot.name, 'Alu')
    assert.equal(o.bot.status.online, true)
    assert.deepEqual(o.tasks, { active: null, queue: [], recent: [] })
    assert.deepEqual(o.provider, { id: o.provider.id, label: '主力', kind: 'openai-chat', model: 'gpt-x', baseUrl: 'https://api.example.com/v1' })
    assert.deepEqual(o.usage, { today: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, dailyTokenLimit: 0 })
    assert.equal(o.agent.busy, false)
  })
})
