import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { AgentEvent } from '../src/agent/events.ts'
import { DEFAULT_PERSONA } from '../src/agent/prompt.ts'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import type { ProviderConfig, RemoteModelsResult, TestConnectionResult } from '../src/llm/index.ts'
import { DesignWorkspace, decodePng } from '../src/design/index.ts'
import { StructureBook } from '../src/packdata/index.ts'
import type { TextureAtlas } from '../src/packdata/index.ts'
import { PanelServer } from '../src/panel/server.ts'
import { ActivityLog } from '../src/store/activity-log.ts'
import { ConfigStore, overridesFromEnv } from '../src/store/config.ts'
import { FeedbackStore } from '../src/store/feedback.ts'
import { HistoryStore } from '../src/store/history.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { PictureStore } from '../src/store/pictures.ts'
import { UsageStore } from '../src/store/usage.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { S, writeStructureFixture } from './fixture-structures.ts'
import { encodePng, tmpDir, waitFor } from './helpers.ts'
import { readBlueprintAnswer, readSchematic } from './mock-bridge.ts'

const FULL_KEY = 'sk-live-ABCDEFGHIJKLMNOP-9876'

async function setup(t: { after(fn: () => void | Promise<void>): void }, env: NodeJS.ProcessEnv = {}, opts: { textures?: TextureAtlas; structures?: StructureBook; log?: ActivityLog; dir?: { dir: string; cleanup(): void } } = {}) {
  const tmp = opts.dir ?? tmpDir()
  const config = new ConfigStore(tmp.dir, overridesFromEnv(env))
  const game = new FakeGame()
  const log = opts.log ?? new ActivityLog()
  const memory = new MemoryStore(tmp.dir, () => config.get().bot.limits.memoryMaxChars)
  const manuals = new ManualStore(DEFAULT_MANUALS_DIR, path.join(tmp.dir, 'manuals'))
  const design = new DesignWorkspace({ dataDir: tmp.dir })
  const clock = { now: Date.now() }
  const feedback = new FeedbackStore(tmp.dir, { now: () => clock.now })
  const pictures = new PictureStore(tmp.dir)
  const events: AgentEvent[] = []
  const tested: ProviderConfig[] = []
  /** 拉模型列表时问的是哪一家；remote.result 是这家接口假装回的。 */
  const asked: ProviderConfig[] = []
  const remote: { result: RemoteModelsResult } = { result: { ok: true, models: [] } }
  let expectedCancels = 0
  const panel = new PanelServer({
    config,
    memory,
    usage: new UsageStore(tmp.dir),
    log,
    history: new HistoryStore(tmp.dir),
    manuals,
    design,
    feedback,
    pictures,
    ...(opts.textures ? { textures: opts.textures } : {}),
    ...(opts.structures ? { structures: opts.structures } : {}),
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
    listModels: async (p) => {
      asked.push(p)
      return remote.result
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
  return { tmp, config, game, log, memory, manuals, design, feedback, pictures, clock, events, tested, asked, remote, call, login, origin, port, cookie: () => cookie, cancels: () => expectedCancels, setCookie: (c: string) => (cookie = c) }
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
    for (const route of ['/api/overview', '/api/providers', '/api/bot', '/api/memory', '/api/manuals', '/api/blueprints', '/api/drafts', '/api/drafts/view?name=x', '/api/drafts/picture?name=x', '/api/drafts/model?name=x', '/api/pictures/file?id=x', '/api/pictures/model?id=x', '/api/structures', '/api/structures/model?id=x', '/api/textures/atlas.png', '/api/images', '/api/images/file?name=x', '/api/feedback', '/api/feedback/view?id=f1', '/api/feedback/export', '/api/events', '/api/log', '/api/log?before=5', '/api/status', '/api/runs', '/api/runs/records?id=r1', '/api/blueprints/read?name=x']) {
      assert.equal((await s.call('GET', route)).status, 401, route)
    }
    assert.equal((await s.call('POST', '/api/command', { text: '回家' })).status, 401)
    assert.equal((await s.call('POST', '/api/blueprints', { name: 'hut', data: 'AAAA' })).status, 401)
    assert.equal((await s.call('DELETE', '/api/blueprints', { name: 'hut' })).status, 401)
    assert.equal((await s.call('POST', '/api/images', { name: 'cat', data: 'AAAA' })).status, 401)
    assert.equal((await s.call('POST', '/api/drafts/publish', { name: 'hut' })).status, 401)
    assert.equal((await s.call('POST', '/api/feedback/status', { id: 'f1', status: 'handled' })).status, 401)
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

    const renamed = await s.call('PUT', `/api/providers/${id}`, { ...PROVIDER, apiKey: '', label: '改名了' })
    assert.equal(renamed.status, 200)
    assert.equal(s.config.activeProvider()?.apiKey, FULL_KEY)
    assert.equal(s.config.activeProvider()?.label, '改名了')
    // 改服务商不动它下面的模型
    assert.equal(s.config.activeProvider()?.model, 'gpt-x')

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

describe('面板：一个服务商下面的多个模型', () => {
  /** 建一个服务商（带第一个模型 gpt-x），返回它和那个模型的 id。 */
  async function withProvider(s: Awaited<ReturnType<typeof setup>>) {
    const created = await s.call('POST', '/api/providers', PROVIDER)
    assert.equal(created.status, 200, created.text)
    return { providerId: created.json.provider.id as string, firstId: created.json.provider.models[0].id as string }
  }

  it('在同一个服务商下面再加模型：各有各的名字和设置（输出上限、温度、超时、额外参数、开关），服务商的地址和 key 是共用的', async (t) => {
    const s = await setup(t)
    await s.login()
    const { providerId, firstId } = await withProvider(s)
    const added = await s.call('POST', `/api/providers/${providerId}/models`, {
      name: 'gpt-x-thinking',
      label: '思考版',
      maxOutputTokens: 8000,
      temperature: 1,
      timeoutMs: 300_000,
      extraBody: { reasoning_effort: 'high' },
      options: { maxTokensField: 'max_completion_tokens', systemRole: 'developer' },
    })
    assert.equal(added.status, 200, added.text)
    const thinkingId = added.json.model.id as string
    assert.notEqual(thinkingId, firstId)
    const shown = added.json.providers[0]
    assert.deepEqual(shown.models.map((m: { name: string; label: string }) => [m.name, m.label]), [['gpt-x', ''], ['gpt-x-thinking', '思考版']])
    // key 还是只写不读
    assert.equal(added.text.includes(FULL_KEY), false)
    assert.deepEqual([shown.apiKey, shown.apiKeySet], [undefined, true])
    // 加模型不会改“现在用哪个”
    assert.equal(s.config.activeProvider()?.model, 'gpt-x')

    // 测试连接测的是这个模型自己的设置，加上服务商的地址和 key
    await s.call('POST', '/api/providers/test', { id: providerId, modelId: thinkingId })
    assert.deepEqual(s.tested[0], {
      id: providerId,
      label: '主力',
      kind: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      apiKey: FULL_KEY,
      model: 'gpt-x-thinking',
      maxOutputTokens: 8000,
      temperature: 1,
      timeoutMs: 300_000,
      extraBody: { reasoning_effort: 'high' },
      options: { maxTokensField: 'max_completion_tokens', systemRole: 'developer' },
    })
    // 表单里还没保存的模型也能测：用的是已保存的服务商
    await s.call('POST', '/api/providers/test', { id: providerId, name: 'gpt-draft', maxOutputTokens: 100 })
    assert.deepEqual([s.tested[1]!.model, s.tested[1]!.maxOutputTokens, s.tested[1]!.apiKey, s.tested[1]!.extraBody], ['gpt-draft', 100, FULL_KEY, undefined])

    const edited = await s.call('PUT', `/api/providers/${providerId}/models/${thinkingId}`, { name: 'gpt-x-thinking', label: '思考版', maxOutputTokens: 4000 })
    assert.equal(edited.status, 200, edited.text)
    assert.deepEqual(edited.json.model, { id: thinkingId, name: 'gpt-x-thinking', label: '思考版', maxOutputTokens: 4000 })
    assert.equal((await s.call('POST', `/api/providers/${providerId}/models`, { name: '  ' })).status, 400)
    assert.equal((await s.call('PUT', `/api/providers/${providerId}/models/nope`, { name: 'x' })).status, 404)
    assert.equal((await s.call('POST', '/api/providers/p_nope/models', { name: 'x' })).status, 404)
  })

  it('模型上的“能看图”开关：默认关；开了以后存得住，交给模型调用层的配置里带着它，测试连接也按它来', async (t) => {
    const s = await setup(t)
    await s.login()
    const { providerId, firstId } = await withProvider(s)
    assert.equal(s.config.activeProvider()?.vision, undefined)
    const seeing = await s.call('POST', `/api/providers/${providerId}/models`, { name: 'gpt-x-vision', vision: true })
    assert.equal(seeing.status, 200, seeing.text)
    assert.deepEqual(seeing.json.model, { id: seeing.json.model.id, name: 'gpt-x-vision', label: '', vision: true })
    await s.call('POST', '/api/models/use', { providerId, modelId: seeing.json.model.id })
    assert.equal(s.config.activeProvider()?.vision, true)
    assert.equal(new ConfigStore(s.tmp.dir).activeProvider()?.vision, true)
    await s.call('POST', '/api/providers/test', { id: providerId, modelId: seeing.json.model.id })
    await s.call('POST', '/api/providers/test', { id: providerId, modelId: firstId })
    // 表单里还没保存的：勾没勾都照表单上的来
    await s.call('POST', '/api/providers/test', { id: providerId, name: 'gpt-draft', vision: true })
    assert.deepEqual(s.tested.map((p) => [p.model, p.vision]), [['gpt-x-vision', true], ['gpt-x', undefined], ['gpt-draft', true]])
    // 关掉
    const off = await s.call('PUT', `/api/providers/${providerId}/models/${seeing.json.model.id}`, { name: 'gpt-x-vision', vision: false })
    assert.deepEqual(off.json.model, { id: seeing.json.model.id, name: 'gpt-x-vision', label: '' })
    assert.equal(s.config.activeProvider()?.vision, undefined)
  })

  it('换现在用的模型：换完下一次调用用的就是它的设置；日志里记一笔；页头的切换拿得到全部可选的', async (t) => {
    const s = await setup(t)
    await s.login()
    const { providerId, firstId } = await withProvider(s)
    const thinkingId = (await s.call('POST', `/api/providers/${providerId}/models`, { name: 'gpt-x-thinking', label: '思考版', extraBody: { reasoning_effort: 'high' } })).json.model.id as string
    const other = await s.call('POST', '/api/providers', { ...PROVIDER, kind: 'anthropic-messages', label: '备用', baseUrl: 'https://api.anthropic.example', model: 'claude-x', options: { authStyle: 'bearer', promptCaching: false } })
    const otherId = other.json.provider.id as string
    const claudeId = other.json.provider.models[0].id as string
    // 接口类型的开关：跟着服务商走的留在服务商上，跟着模型走的在模型上
    assert.deepEqual([other.json.provider.options, other.json.provider.models[0].options], [{ authStyle: 'bearer' }, { promptCaching: false }])

    const switched = await s.call('POST', '/api/models/use', { providerId, modelId: thinkingId })
    assert.equal(switched.status, 200, switched.text)
    assert.deepEqual([switched.json.activeProviderId, switched.json.activeModelId], [providerId, thinkingId])
    assert.deepEqual([s.config.activeProvider()?.model, s.config.activeProvider()?.extraBody], ['gpt-x-thinking', { reasoning_effort: 'high' }])
    assert.ok(s.log.recent(0, 50).some((e) => e.kind === 'info' && e.text === '在面板上把模型换成了 主力 / 思考版，下一轮起生效。'))

    await s.call('POST', '/api/models/use', { providerId: otherId, modelId: claudeId })
    assert.deepEqual([s.config.activeProvider()?.kind, s.config.activeProvider()?.model, s.config.activeProvider()?.options], ['anthropic-messages', 'claude-x', { authStyle: 'bearer', promptCaching: false }])
    const o = (await s.call('GET', '/api/overview')).json
    assert.deepEqual([o.provider.label, o.provider.model, o.provider.modelId], ['备用', 'claude-x', claudeId])
    assert.deepEqual(o.models.map((m: { providerLabel: string; label: string }) => `${m.providerLabel} / ${m.label}`), ['主力 / gpt-x', '主力 / 思考版', '备用 / claude-x'])

    // 不存在的、不属于这个服务商的模型切不过去（模型的 id 只在它自己的服务商里算数）
    assert.equal((await s.call('POST', '/api/models/use', { providerId: otherId, modelId: thinkingId })).status, 404)
    assert.equal((await s.call('POST', '/api/models/use', { providerId: 'p_nope', modelId: firstId })).status, 404)
    assert.equal(s.config.activeProvider()?.model, 'claude-x')
  })

  it('删模型：删掉正在用的那个，改用同一个服务商下面剩下的第一个；删光了就是没配模型，不会自己跳到别家去', async (t) => {
    const s = await setup(t)
    await s.login()
    const { providerId, firstId } = await withProvider(s)
    const secondId = (await s.call('POST', `/api/providers/${providerId}/models`, { name: 'gpt-y' })).json.model.id as string
    await s.call('POST', '/api/providers', { ...PROVIDER, label: '备用', model: 'other-model' })
    await s.call('POST', '/api/models/use', { providerId, modelId: secondId })

    const removed = await s.call('DELETE', `/api/providers/${providerId}/models/${secondId}`, {})
    assert.deepEqual([removed.json.activeProviderId, removed.json.activeModelId], [providerId, firstId])
    assert.equal(s.config.activeProvider()?.model, 'gpt-x')
    const emptied = await s.call('DELETE', `/api/providers/${providerId}/models/${firstId}`, {})
    assert.deepEqual([emptied.json.activeProviderId, emptied.json.activeModelId], [providerId, ''])
    assert.equal(s.config.activeProvider(), undefined)
    assert.equal((await s.call('GET', '/api/overview')).json.provider, null)
    assert.equal((await s.call('DELETE', `/api/providers/${providerId}/models/${firstId}`, {})).status, 404)
  })

  it('从接口拉模型列表：用已保存的 key 去问，拉到了给出列表；拉不到把原因给人看（照样可以手填）；正在填的草稿也能拉', async (t) => {
    const s = await setup(t)
    await s.login()
    const { providerId } = await withProvider(s)
    s.remote.result = { ok: true, models: [{ id: 'gpt-x' }, { id: 'gpt-y', label: 'GPT Y' }] }
    const pulled = await s.call('POST', '/api/providers/remote-models', { id: providerId })
    assert.deepEqual(pulled.json, { ok: true, models: [{ id: 'gpt-x' }, { id: 'gpt-y', label: 'GPT Y' }] })
    assert.deepEqual([s.asked[0]!.kind, s.asked[0]!.baseUrl, s.asked[0]!.apiKey], ['openai-chat', 'https://api.example.com/v1', FULL_KEY])
    assert.equal(pulled.text.includes(FULL_KEY), false)

    s.remote.result = { ok: false, error: { kind: 'auth', status: 401, message: 'Incorrect API key provided' } }
    const failed = await s.call('POST', '/api/providers/remote-models', { id: providerId })
    assert.equal(failed.status, 200)
    assert.deepEqual(failed.json, { ok: false, error: { kind: 'auth', status: 401, message: 'Incorrect API key provided' } })

    // 还没保存的服务商：拿表单里填的地址和 key 去问
    await s.call('POST', '/api/providers/remote-models', { kind: 'anthropic-messages', baseUrl: 'https://gateway.example', apiKey: 'sk-draft-key-000001', options: { authStyle: 'bearer' } })
    assert.deepEqual([s.asked[2]!.kind, s.asked[2]!.baseUrl, s.asked[2]!.apiKey, s.asked[2]!.options], ['anthropic-messages', 'https://gateway.example', 'sk-draft-key-000001', { authStyle: 'bearer' }])
    // 正在改已保存的服务商、把地址指到别的主机却不重填 key：不拿存着的 key 去问
    const moved = await s.call('POST', '/api/providers/remote-models', { ...PROVIDER, id: providerId, apiKey: '', baseUrl: 'https://attacker.example/v1' })
    assert.equal(moved.status, 400)
    assert.equal(s.asked.length, 3)
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

  it('实时日志：跟着更新的条目（正在想的那次模型调用、程序运行的汇总）改了以后，用同一个 id 再推一次新的样子', async (t) => {
    const s = await setup(t)
    const { headers } = await s.login()
    const res = await fetch(`${s.origin}/api/events`, { headers: { cookie: headers.getSetCookie()[0]!.split(';')[0]! } })
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
    const entry = s.log.add({ kind: 'model_call', turn: 3, step: 1, text: '第 1 步：模型在想…', call: { state: 'thinking', purpose: 'turn', step: 1, startedAt: 1000 } })
    await waitFor('the thinking entry', () => received.includes('模型在想'))
    s.log.update(entry.id, { text: '第 1 步：2.0 秒，输入 900 / 输出 12 token，说完了', call: { state: 'done', purpose: 'turn', step: 1, startedAt: 1000, ms: 2000, inputTokens: 900, outputTokens: 12, stop: 'end', toolCalls: 0 } })
    await waitFor('the settled entry', () => received.includes('说完了'))
    const raw = received.split('\n\n').filter((f) => f.includes('data: '))
    // 改过的那一次不带 SSE 自己的 id 行（断线重连时不会从这条旧 id 起把后面的重发一遍）；条目的 id 在数据里
    assert.deepEqual(raw.map((f) => /^id: \d+$/m.test(f)), [true, false])
    const frames = raw.map((f) => JSON.parse(f.split('data: ')[1]!))
    assert.deepEqual(frames.map((f) => [f.id, f.kind, f.turn, f.step, f.call.state, f.call.ms ?? null]), [
      [entry.id, 'model_call', 3, 1, 'thinking', null],
      [entry.id, 'model_call', 3, 1, 'done', 2000],
    ])
    // 之后再来拿日志的，拿到的是改过之后的那一条，只有一条
    assert.deepEqual((await s.call('GET', '/api/log')).json.entries.map((e: { id: number; call: { state: string } }) => [e.id, e.call.state]), [[entry.id, 'done']])
    await reader.cancel()
    await pump
  })

  it('对话日志往回翻：一页页用 before 翻到头（翻过了内存里留的那 500 条，接着读按天存的文件），不重不漏、顺序不变；跟着更新过的条目给的是最后的样子；大脑重启以后照样翻得到', async (t) => {
    const dir = tmpDir()
    const first = new ActivityLog(dir.dir)
    // 昨天 300 条、今天 400 条；其中一条（程序运行的汇总）后来改过
    const day = 24 * 3600_000
    const start = Date.now() - day
    for (let n = 1; n <= 300; n++) first.add({ kind: 'info', text: `昨天 ${n}`, time: start + n })
    const summary = first.add({ kind: 'run', text: '例程 r1：在跑', time: start + day })
    for (let n = 2; n <= 400; n++) first.add({ kind: 'info', text: `今天 ${n}`, time: start + day + n })
    first.update(summary.id, { text: '例程 r1：跑完了' }, { persist: true })
    // 重启：内存里只读回最近那个文件的末尾
    const s = await setup(t, {}, { dir, log: new ActivityLog(dir.dir) })
    await s.login()
    const latest = (await s.call('GET', '/api/log?limit=100')).json
    assert.deepEqual([latest.entries.length, latest.entries[0].id, latest.entries.at(-1).id, latest.more], [100, 601, 700, true])
    const seen: { id: number; text: string }[] = [...latest.entries]
    let pages = 0
    for (let more = true; more; pages++) {
      const page = (await s.call('GET', `/api/log?before=${seen[0]!.id}&limit=128`)).json
      assert.ok(page.entries.length > 0 && page.entries.length <= 128)
      seen.unshift(...page.entries)
      more = page.more
      assert.ok(pages < 20)
    }
    assert.deepEqual([pages, seen.length], [5, 700])
    assert.deepEqual(seen.map((e) => e.id), Array.from({ length: 700 }, (_, n) => n + 1))
    assert.deepEqual([seen[0]!.text, seen[299]!.text, seen[300]!.text, seen[301]!.text, seen[699]!.text], ['昨天 1', '昨天 300', '例程 r1：跑完了', '今天 2', '今天 400'])
    // 翻到头以后再翻：没有了
    assert.deepEqual((await s.call('GET', '/api/log?before=1')).json, { entries: [], more: false })
  })

  it('图纸里有什么：一张图纸的尺寸和材料表（得由人放的带着原因）；要格子时一并给；没有这张图纸、没有这张草稿时说没有', async (t) => {
    const s = await setup(t)
    await s.login()
    // 3×2×3：一层石砖地板，上面一个箱子（得由人放）
    const cells = new Uint16Array(18)
    cells.fill(1, 0, 9)
    cells[13] = 2
    const HUT = { name: 'hut', size: { x: 3, y: 2, z: 3 }, kinds: [{ id: 'minecraft:air', meta: 0, name: 'Air' }, { id: 'minecraft:stonebrick', meta: 0, name: 'Stone Bricks' }, { id: 'minecraft:chest', meta: 3, name: 'Chest', byHand: 'it holds contents or settings' }], cells }
    s.game.handlers['blueprint.read'] = (p) => {
      if (p.name !== 'hut') throw new BridgeError('bad_request', `no blueprint named ${String(p.name)}`)
      return readBlueprintAnswer(HUT, p)
    }
    const read = await s.call('GET', '/api/blueprints/read?name=hut')
    assert.equal(read.status, 200)
    assert.deepEqual(read.json, {
      name: 'hut',
      source: 'server',
      size: { x: 3, y: 2, z: 3 },
      blocks: 10,
      materials: [
        { id: 'minecraft:stonebrick', meta: 0, name: 'Stone Bricks', count: 9 },
        { id: 'minecraft:chest', meta: 3, name: 'Chest', count: 1, byHand: 'it holds contents or settings' },
      ],
    })
    assert.deepEqual(s.game.callsOf('blueprint.read'), [{ name: 'hut', cells: false }])
    const whole = (await s.call('GET', '/api/blueprints/read?name=hut&cells=1')).json
    assert.deepEqual([whole.sx, whole.sy, whole.sz, whole.palette.map((k: { id: string }) => k.id), whole.cells], [3, 2, 3, ['minecraft:air', 'minecraft:stonebrick', 'minecraft:chest'], [1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0]])
    const missing = await s.call('GET', '/api/blueprints/read?name=nope')
    assert.deepEqual([missing.status, missing.json.error.code], [502, 'bad_request'])
    assert.deepEqual([(await s.call('GET', '/api/blueprints/read?name=../x')).status, (await s.call('GET', '/api/blueprints/read?name=nope&draft=1')).status], [400, 404])
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

  it('图纸页的草稿：列出它设计的草稿；看一张的内容（尺寸、每种方块的数量和颜色、格子、程序）；发布成游戏里的图纸；删除', async (t) => {
    const s = await setup(t)
    await s.login()
    assert.deepEqual((await s.call('GET', '/api/drafts')).json.drafts, [])
    const code = "const b = blueprint(2, 1, 2)\nb.set(0, 0, 0, 'minecraft:wool/14').set(1, 0, 1, 'chisel:marble/3')\nb.save('小样')"
    const made = await s.design.run(code)
    assert.equal(made.outcome.status, 'ok')

    const listed = await s.call('GET', '/api/drafts')
    assert.deepEqual(listed.json.drafts.map((d: { name: string; size: unknown; blocks: number }) => [d.name, d.size, d.blocks]), [['小样', { x: 2, y: 1, z: 2 }, 2]])
    const view = await s.call('GET', `/api/drafts/view?name=${encodeURIComponent('小样')}`)
    assert.equal(view.status, 200)
    assert.deepEqual([view.json.name, view.json.size, view.json.blocks, view.json.program], ['小样', { x: 2, y: 1, z: 2 }, 2, code])
    // 红色羊毛在内置的颜色表里；大理石不在，给了一个只用来区分的颜色
    assert.deepEqual(view.json.kinds[0], { key: 'minecraft:wool/14', name: '红色羊毛', count: 1, color: [151, 52, 49], colorKnown: true })
    assert.deepEqual([view.json.kinds[1].key, view.json.kinds[1].name, view.json.kinds[1].count, view.json.kinds[1].colorKnown], ['chisel:marble/3', null, 1, false])
    // 格子按 x + (y * 长 + z) * 宽 的顺序，写成“下标, 连续几格”：(0,0,0) 是第 1 种，中间两格空，(1,0,1) 是第 2 种
    assert.deepEqual(view.json.runs, [1, 1, 0, 2, 2, 1])
    assert.equal((await s.call('GET', '/api/drafts/view?name=nope')).status, 404)

    // 主人看过觉得行，直接在面板上发布：文件转给游戏，照 mod 的读法读得出同样的东西
    let received: { name: string; cells: number[]; kinds: string[] } | undefined
    s.game.handlers['blueprint.put'] = (p) => {
      const b = readSchematic(String(p.name), Buffer.from(String(p.data), 'base64'))
      received = { name: b.name, cells: [...b.cells], kinds: b.kinds.map((k) => `${k.id}/${k.meta}`) }
      return { name: b.name, size: b.size, blocks: 2 }
    }
    const published = await s.call('POST', '/api/drafts/publish', { name: '小样' })
    assert.equal(published.status, 200, published.text)
    assert.deepEqual(received, { name: '小样', cells: [1, 0, 0, 2], kinds: ['minecraft:air/0', 'minecraft:wool/14', 'chisel:marble/3'] })
    assert.ok(s.log.recent(0, 50).some((e) => e.kind === 'info' && /把草稿 小样 发布成了图纸/.test(e.text)))

    const removed = await s.call('DELETE', '/api/drafts', { name: '小样' })
    assert.deepEqual([removed.json.removed, removed.json.drafts], [true, []])
    assert.equal((await s.call('POST', '/api/drafts/publish', { name: '小样' })).status, 404)
  })

  it('草稿的图：大脑画的 PNG（和它自己看到的是同一种），能换角度、看俯视和立面、一层层看，列表里用不带说明的小图', async (t) => {
    const s = await setup(t)
    await s.login()
    // 3×2×1：底下一排红羊毛，西头上面摞一块蓝的
    const made = await s.design.run("const b = blueprint(3, 2, 1)\nb.fill(0, 0, 0, 2, 0, 0, 'minecraft:wool/14')\nb.set(0, 1, 0, 'minecraft:wool/11')\nb.save('wall')")
    assert.equal(made.outcome.status, 'ok')
    const picture = async (query: string) => {
      const res = await fetch(`${s.origin}/api/drafts/picture?name=wall${query}`, { headers: { cookie: s.cookie() } })
      const bytes = Buffer.from(await res.arrayBuffer())
      return { status: res.status, type: res.headers.get('content-type'), bytes, image: res.status === 200 ? decodePng(bytes) : undefined }
    }
    const count = (image: { rgba: Buffer }, c: number[]): number => {
      let n = 0
      for (let at = 0; at < image.rgba.length; at += 4) if (image.rgba[at] === c[0] && image.rgba[at + 1] === c[1] && image.rgba[at + 2] === c[2]) n++
      return n
    }
    const RED = [151, 52, 49]
    const BLUE = [46, 57, 142]

    // 默认：立体图，带说明和图例
    const iso = await picture('')
    assert.deepEqual([iso.status, iso.type], [200, 'image/png'])
    assert.ok(iso.image!.width <= 1024 && iso.image!.height <= 1024 && iso.image!.width >= 300)
    assert.ok(count(iso.image!, RED) > 500 && count(iso.image!, BLUE) > 500)
    // 换个角：是另一张图
    const turned = await picture('&view=iso&from=northwest')
    assert.equal(turned.status, 200)
    assert.notDeepEqual(turned.bytes, iso.bytes)
    // 俯视：蓝的压在西头那块红的上面，所以红的只看得见两块；只看第 0 层就没有蓝的
    const top = await picture('&view=top&plain=1')
    const cell = top.image!.width / 3
    assert.equal(top.image!.height, cell)
    // （格子之间有细线，所以一格里不是每个像素都是原色）
    assert.ok(count(top.image!, BLUE) > cell * cell * 0.8 && count(top.image!, BLUE) <= cell * cell)
    const ground = await picture('&view=layer&layer=0&plain=1')
    assert.equal(count(ground.image!, BLUE), 0)
    assert.ok(count(ground.image!, RED) > cell * cell * 2.4)
    // 从北面看：西在右手边，蓝的在右上角
    const north = await picture('&view=side&from=north&plain=1')
    const at = (x: number, y: number) => [...north.image!.rgba.subarray((y * north.image!.width + x) * 4, (y * north.image!.width + x) * 4 + 3)]
    const c = north.image!.width / 3
    assert.deepEqual([at(Math.floor(2.5 * c), Math.floor(0.5 * c)), at(Math.floor(0.5 * c), Math.floor(1.5 * c))], [BLUE, RED])
    // 列表里的小图：不超过要的大小，没有说明和图例
    const thumb = await picture('&plain=1&size=96')
    assert.ok(thumb.image!.width <= 96 && thumb.image!.height <= 96)
    assert.ok(thumb.bytes.length < iso.bytes.length)

    // 草稿重新存过（内容变了）：同一个地址给的是新的图
    assert.equal(count(ground.image!, BLUE), 0)
    await s.design.run("const b = blueprint(3, 2, 1)\nb.fill(0, 0, 0, 2, 1, 0, 'minecraft:wool/11')\nb.save('wall')")
    assert.ok(count((await picture('&view=layer&layer=0&plain=1')).image!, BLUE) > cell * cell * 2.4)

    for (const bad of ['&view=iso&from=south', '&view=side&from=southeast', '&view=layer&layer=2', '&view=layer&layer=x', '&view=3d']) {
      assert.equal((await picture(bad)).status, 400, bad)
    }
    assert.equal((await s.call('GET', '/api/drafts/picture?name=nope')).status, 404)
  })

  it('多方块结构：按名字搜得到机器，一台机器某个等级的材料、说明和三维预览的数据都给得出；没有这份资料时照实说', async (t) => {
    const dir = tmpDir()
    t.after(dir.cleanup)
    writeStructureFixture(dir.dir)
    const s = await setup(t, {}, { structures: StructureBook.load(dir.dir)!.book })
    await s.login()
    const all = await s.call('GET', '/api/structures')
    assert.deepEqual([all.json.available, all.json.total, all.json.machines[0]], [true, 4, { ...S.centrifuge, name: '大型蒸汽离心机', tiers: [1, 2] }])
    assert.deepEqual((await s.call('GET', `/api/structures?q=${encodeURIComponent('高炉')}`)).json.machines.map((m: { name: string; tiers: number[] }) => [m.name, m.tiers.length]), [['工业高炉', 6]])
    // 小离心机的 2 级：3×2×3，15 个脱氧钢机械方块、1 个钢齿轮箱、1 个主机；格子和草稿的预览同一种写法
    const model = await s.call('GET', `/api/structures/model?id=${encodeURIComponent(S.centrifuge.id)}&meta=${S.centrifuge.meta}&tier=2`)
    assert.equal(model.status, 200, model.text)
    assert.deepEqual([model.json.name, model.json.tier, model.json.tiers, model.json.size, model.json.controller], ['大型蒸汽离心机', 2, [1, 2], { x: 3, y: 2, z: 3 }, [1, 0, 2]])
    assert.deepEqual(model.json.blocks.map((b: { name: string; n: number }) => [b.name, b.n]), [['脱氧钢机械方块', 15], ['钢齿轮箱机械方块', 1], ['大型蒸汽离心机', 1]])
    assert.deepEqual(model.json.runs, [1, 4, 2, 1, 1, 2, 3, 1, 1, 5, 0, 1, 1, 4])
    assert.deepEqual(model.json.kinds.slice(1).map((k: { key: string; count: number }) => [k.key, k.count]), [['gregtech:gt.blockcasings2', 15], ['gregtech:gt.blockcasings2/3', 1], ['gregtech:gt.blockmachines', 1]])
    assert.equal(model.json.structureInfo[2], '控制器: 底层，正面中央')
    // 不给等级就是最低的那一级；没有的等级、没有的机器是 404
    assert.equal((await s.call('GET', `/api/structures/model?id=${encodeURIComponent(S.centrifuge.id)}&meta=${S.centrifuge.meta}`)).json.tier, 1)
    assert.equal((await s.call('GET', `/api/structures/model?id=${encodeURIComponent(S.centrifuge.id)}&meta=${S.centrifuge.meta}&tier=9`)).status, 404)
    assert.equal((await s.call('GET', '/api/structures/model?id=minecraft:stone&meta=0')).status, 404)
    // 大脑没有这份资料
    const bare = await setup(t)
    await bare.login()
    assert.deepEqual((await bare.call('GET', '/api/structures')).json, { available: false, total: 0, machines: [] })
  })

  it('三维预览的数据：草稿和对话日志里的简图都给得出“每一格是什么、每种方块怎么画”；有贴图图集时指到图集的第几格，图集那张图也取得到', async (t) => {
    // 一份只有两格的图集：第 0 格是红羊毛的贴图
    const dir = tmpDir()
    t.after(dir.cleanup)
    const atlasFile = path.join(dir.dir, 'atlas.png')
    const atlasPng = encodePng({ width: 2, height: 1, rgba: Buffer.from([200, 0, 0, 255, 0, 0, 200, 255]) })
    fs.writeFileSync(atlasFile, atlasPng)
    const s = await setup(t, {}, { textures: { file: atlasFile, tile: 1, columns: 2, rows: 1, tiles: new Map([['wool_colored_red', 0]]), version: '2026-01-01T00:00:00Z' } })
    await s.login()
    const made = await s.design.run("const b = blueprint(2, 1, 2)\nb.set(0, 0, 0, 'minecraft:wool/14').set(1, 0, 1, 'chisel:marble/3')\nb.save('小样')")
    assert.equal(made.outcome.status, 'ok')

    const model = await s.call('GET', `/api/drafts/model?name=${encodeURIComponent('小样')}`)
    assert.equal(model.status, 200, model.text)
    assert.deepEqual([model.json.name, model.json.size, model.json.origin], ['小样', { x: 2, y: 1, z: 2 }, { x: 0, y: 0, z: 0 }])
    // 格子按 x 最快、其次 z 的顺序：(0,0,0) 是第 1 种，中间两格空，(1,0,1) 是第 2 种
    assert.deepEqual(model.json.runs, [1, 1, 0, 2, 2, 1])
    assert.equal(model.json.kinds[0], null)
    // 内置的颜色表里红羊毛没有贴图名，所以只有颜色；大理石不认识，颜色是配的
    assert.deepEqual(model.json.kinds[1], { key: 'minecraft:wool/14', name: '红色羊毛', count: 1, side: [151, 52, 49], top: [151, 52, 49], alpha: 1, shape: 'full', known: true })
    assert.deepEqual([model.json.kinds[2].key, model.json.kinds[2].known, model.json.kinds[2].tex], ['chisel:marble/3', false, undefined])
    assert.deepEqual(model.json.atlas, { url: '/api/textures/atlas.png?v=2026-01-01T00%3A00%3A00Z', tile: 1, columns: 2, rows: 1 })
    assert.equal((await s.call('GET', '/api/drafts/model?name=nope')).status, 404)

    // 图集那张图：原样给，浏览器可以一直留着（地址里带着版本）
    const atlas = await fetch(`${s.origin}${model.json.atlas.url}`, { headers: { cookie: s.cookie() } })
    assert.deepEqual([atlas.status, atlas.headers.get('content-type')], [200, 'image/png'])
    assert.match(atlas.headers.get('cache-control') ?? '', /immutable/)
    assert.deepEqual(Buffer.from(await atlas.arrayBuffer()), atlasPng)

    // 对话日志里的简图：存图时一起存了画它用的盒子（world.blocks 那个样子），按编号取
    const blocks = { x: -3, y: 64, z: 7, sx: 2, sy: 1, sz: 1, palette: [{ id: 'minecraft:air', meta: 0 }, { id: 'minecraft:stained_glass', meta: 14 }, { id: '@Alu', meta: 0 }], runs: [1, 1, 2, 1] }
    const withScene = s.pictures.save(atlasPng, blocks)
    const world = await s.call('GET', `/api/pictures/model?id=${withScene}`)
    assert.equal(world.status, 200, world.text)
    assert.deepEqual([world.json.size, world.json.origin, world.json.runs], [{ x: 2, y: 1, z: 1 }, { x: -3, y: 64, z: 7 }, [1, 1, 2, 1]])
    // 染色玻璃照着羊毛上色，半透明；位置记号有标记
    assert.deepEqual([world.json.kinds[1].key, world.json.kinds[1].side, world.json.kinds[1].alpha < 1], ['minecraft:stained_glass/14', [151, 52, 49], true])
    assert.deepEqual([world.json.kinds[2].key, world.json.kinds[2].marker, world.json.kinds[2].name], ['@Alu', true, undefined])
    // 没有盒子的图（主人传的图片）、不存在的编号、存坏了的盒子：404
    const plain = s.pictures.save(atlasPng)
    const broken = s.pictures.save(atlasPng, { sx: 2, sy: 1, sz: 1, x: 0, y: 0, z: 0, palette: [{ id: 'minecraft:air' }], runs: [0, 1] })
    for (const id of [plain, 'nope', broken]) assert.equal((await s.call('GET', `/api/pictures/model?id=${id}`)).status, 404, id)
  })

  it('没有贴图图集时：三维预览的数据里没有图集，图集那张图是 404（面板按颜色画）', async (t) => {
    const s = await setup(t)
    await s.login()
    await s.design.run("const b = blueprint(1, 1, 1)\nb.set(0, 0, 0, 'minecraft:wool/14')\nb.save('dot')")
    const model = await s.call('GET', '/api/drafts/model?name=dot')
    assert.deepEqual([model.status, model.json.atlas, model.json.kinds[1].tex], [200, undefined, undefined])
    assert.equal((await s.call('GET', '/api/textures/atlas.png')).status, 404)
  })

  it('对话日志里的图：工具结果带的图按编号取得到；清理掉了的、编号不对的是 404', async (t) => {
    const s = await setup(t)
    await s.login()
    const png = encodePng({ width: 1, height: 1, rgba: Buffer.from([1, 2, 3, 255]) })
    const id = s.pictures.save(png)
    s.log.add({ kind: 'tool_result', who: 'view_area', text: 'Picture of x 0..3', pictures: [id] })
    // 日志条目带着编号，面板据此去取图
    const entry = (await s.call('GET', '/api/log')).json.entries.at(-1)
    assert.deepEqual(entry.pictures, [id])
    const res = await fetch(`${s.origin}/api/pictures/file?id=${id}`, { headers: { cookie: s.cookie() } })
    assert.deepEqual([res.status, res.headers.get('content-type')], [200, 'image/png'])
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png)
    for (const bad of ['nope', '', '../config.json', `${id}x`]) {
      assert.equal((await s.call('GET', `/api/pictures/file?id=${encodeURIComponent(bad)}`)).status, 404, bad)
    }
  })

  it('图纸页的图片：上传浏览器缩好的 PNG，列得出、页面上显示得出、它的程序读得到，可以删除；不是 PNG 的、太大的、名字带路径的存不进去', async (t) => {
    const s = await setup(t)
    await s.login()
    const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0])
    const file = encodePng({ width: 2, height: 2, rgba: pixels })
    const uploaded = await s.call('POST', '/api/images', { name: '小旗', data: file.toString('base64') })
    assert.equal(uploaded.status, 200, uploaded.text)
    assert.deepEqual([uploaded.json.saved.name, uploaded.json.saved.width, uploaded.json.saved.height], ['小旗', 2, 2])
    assert.deepEqual(uploaded.json.images.map((i: { name: string; width: number; height: number }) => [i.name, i.width, i.height]), [['小旗', 2, 2]])
    assert.deepEqual([uploaded.json.maxSide, uploaded.json.max], [256, 30])

    // 页面上的 <img> 拿得到原图；没登录拿不到
    const shown = await fetch(`${s.origin}/api/images/file?name=${encodeURIComponent('小旗')}`, { headers: { cookie: s.cookie() } })
    assert.equal(shown.status, 200)
    assert.equal(shown.headers.get('content-type'), 'image/png')
    assert.ok(Buffer.from(await shown.arrayBuffer()).equals(file))
    assert.equal((await fetch(`${s.origin}/api/images/file?name=${encodeURIComponent('小旗')}`)).status, 401)
    // 它写的程序读到的就是这些像素
    const read = await s.design.run("const img = image('小旗')\nreturn [img.pixel(0, 0), img.pixel(1, 0), img.pixel(0, 1), img.pixel(1, 1)]")
    assert.equal(read.outcome.status === 'ok' && read.outcome.value, '[[255,0,0,255],[0,255,0,255],[0,0,255,255],[0,0,0,0]]')

    const jpeg = await s.call('POST', '/api/images', { name: 'photo', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]).toString('base64') })
    assert.deepEqual([jpeg.status, jpeg.json.error.message], [400, '这不是 PNG 文件'])
    const wide = await s.call('POST', '/api/images', { name: 'wide', data: encodePng({ width: 300, height: 2, rgba: Buffer.alloc(300 * 2 * 4) }).toString('base64') })
    assert.deepEqual([wide.status, wide.json.error.message], [400, '这张图是 300×2，每一边最大 256 像素'])
    assert.equal((await s.call('POST', '/api/images', { name: '../config', data: file.toString('base64') })).status, 400)
    assert.equal((await s.call('POST', '/api/images', { name: 'a/b', data: file.toString('base64') })).status, 400)
    assert.deepEqual(fs.readdirSync(path.join(s.tmp.dir, 'images')).sort(), ['小旗.png', '小旗.rgba'])
    assert.equal((await s.call('GET', '/api/images/file?name=..%2Fconfig.json')).status, 404)

    const removed = await s.call('DELETE', '/api/images', { name: '小旗' })
    assert.deepEqual([removed.json.removed, removed.json.images], [true, []])
    assert.deepEqual(fs.readdirSync(path.join(s.tmp.dir, 'images')), [])
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

  it('意见簿页：列出它记的反馈（新的在前，可按类别和状态筛）；点开看详情；标成看过、已处理；导航上的数字是还没看过的条数；导出成一个文件', async (t) => {
    const s = await setup(t)
    await s.login()
    const context = {
      bot: 'Alu',
      brainVersion: '0.1.0',
      modVersion: '0.3.1',
      turn: 12,
      instruction: '[12:00:00] Steve 说：Alu 把时运书给我',
      recentTools: [{ tool: 'list_containers', input: '{"radius":8}', result: '1 container: chest at (3,64,5): 2× minecraft:enchanted_book' }],
      tasks: [{ id: 't4', type: 'withdraw', state: 'done' }],
    }
    const book = { title: '看不出箱子里的附魔书是什么附魔', category: 'missing_tool', goal: '把时运书拿给主人', problem: 'list_containers 只给 id' } as const
    const path2 = { title: '走不到下界传送门跟前', category: 'cannot_do', goal: '去下界', problem: 'goto 一直 unreachable', wish: '能穿过传送门' } as const
    assert.deepEqual((await s.call('GET', '/api/feedback')).json, { reports: [], more: 0, total: 0, unread: 0 })
    s.feedback.submit(book, context)
    s.clock.now += 60_000
    s.feedback.submit(path2, context)
    s.clock.now += 60_000
    // 第一个问题又出现了一次：还是那一条，次数加一，排到最前面
    s.feedback.submit(book, context)

    // 导航上的数字跟着概览一起来
    assert.deepEqual((await s.call('GET', '/api/overview')).json.feedback, { unread: 2 })
    const listed = await s.call('GET', '/api/feedback')
    assert.deepEqual([listed.json.total, listed.json.unread, listed.json.more], [2, 2, 0])
    assert.deepEqual(
      listed.json.reports.map((r: Record<string, unknown>) => [r.id, r.title, r.category, r.count, r.status]),
      [
        ['f1', book.title, 'missing_tool', 2, 'new'],
        ['f2', path2.title, 'cannot_do', 1, 'new'],
      ],
    )
    // 列表里不带附带的现场；点开才有
    assert.equal(listed.json.reports[0].context, undefined)
    assert.deepEqual((await s.call('GET', '/api/feedback?category=cannot_do')).json.reports.map((r: { id: string }) => r.id), ['f2'])

    const opened = await s.call('GET', '/api/feedback/view?id=f2')
    assert.deepEqual([opened.json.goal, opened.json.problem, opened.json.wish, opened.json.context], [path2.goal, path2.problem, path2.wish, context])
    assert.equal((await s.call('GET', '/api/feedback/view?id=f99')).status, 404)

    // 看过了：导航上的数字减一，但它还算没处理
    const seen = await s.call('POST', '/api/feedback/status', { id: 'f2', status: 'seen' })
    assert.deepEqual([seen.json.report.status, seen.json.unread], ['seen', 1])
    assert.deepEqual((await s.call('GET', '/api/overview')).json.feedback, { unread: 1 })
    assert.deepEqual((await s.call('GET', '/api/feedback?status=new')).json.reports.map((r: { id: string }) => r.id), ['f1'])
    assert.deepEqual((await s.call('GET', '/api/feedback?status=open')).json.reports.map((r: { id: string }) => r.id), ['f1', 'f2'])
    // 已处理：从“还没处理的”里出去
    const handled = await s.call('POST', '/api/feedback/status', { id: 'f2', status: 'handled' })
    assert.equal(handled.json.report.status, 'handled')
    assert.deepEqual((await s.call('GET', '/api/feedback?status=open')).json.reports.map((r: { id: string }) => r.id), ['f1'])
    assert.deepEqual((await s.call('GET', '/api/feedback?status=handled')).json.reports.map((r: { id: string }) => r.id), ['f2'])
    assert.equal((await s.call('POST', '/api/feedback/status', { id: 'f2', status: 'fixed' })).status, 400)
    assert.equal((await s.call('POST', '/api/feedback/status', { id: 'f99', status: 'seen' })).status, 404)
    assert.equal((await s.call('POST', '/api/feedback/status', { id: 'f1', status: 'handled' }, { origin: 'https://evil.example' })).status, 403)

    // 导出：一个 JSON 文件，筛出来的每一条连同现场
    const exported = await fetch(`${s.origin}/api/feedback/export?status=open`, { headers: { cookie: s.cookie() } })
    assert.equal(exported.status, 200)
    assert.match(exported.headers.get('content-disposition') ?? '', /^attachment; filename="aiplayer-feedback-\d{8}-\d{4}\.json"$/)
    const file = JSON.parse(await exported.text())
    assert.deepEqual([file.bot, file.filter, file.count], ['Alu', { status: 'open' }, 1])
    assert.deepEqual([file.reports[0].id, file.reports[0].count, file.reports[0].title, file.reports[0].context], ['f1', 2, book.title, context])
    const everything = JSON.parse(await (await fetch(`${s.origin}/api/feedback/export`, { headers: { cookie: s.cookie() } })).text())
    assert.deepEqual(everything.reports.map((r: { id: string }) => r.id), ['f1', 'f2'])
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
    // 现在用的是哪个服务商的哪个模型，以及能切过去的全部模型（页头那个切换用）
    assert.deepEqual(o.provider, { id: o.provider.id, label: '主力', kind: 'openai-chat', baseUrl: 'https://api.example.com/v1', model: 'gpt-x', modelId: o.provider.modelId, modelLabel: 'gpt-x' })
    assert.deepEqual(o.models, [{ providerId: o.provider.id, providerLabel: '主力', modelId: o.provider.modelId, label: 'gpt-x' }])
    assert.deepEqual(o.usage, { today: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, dailyTokenLimit: 0 })
    assert.equal(o.agent.busy, false)
  })
})
