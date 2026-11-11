import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { LlmError, createClient, testConnection } from '../src/llm/index.ts'
import type { UsageRecord } from '../src/llm/index.ts'
import { anthropicConfig, openaiConfig, user } from './helpers.ts'
import { MockLlm } from './mock-llm.ts'

const REQ = { system: 's', messages: [user('hi')], tools: [] }

describe('重试、用量回调、测试连接', () => {
  const llm = new MockLlm()
  before(async () => {
    await llm.start()
  })
  after(() => llm.stop())
  beforeEach(() => {
    llm.requests.length = 0
  })

  it('接口过载两次后恢复：调用方拿到结果，一共请求了三次', async () => {
    llm.enqueue({ status: 529, errorType: 'overloaded_error' }, { status: 529, errorType: 'overloaded_error' }, { text: 'finally' })
    const client = createClient(anthropicConfig(llm.anthropicBaseUrl), { retry: { baseDelayMs: 5, maxDelayMs: 20 } })
    const result = await client.generate(REQ)
    assert.deepEqual(result.message.content, [{ type: 'text', text: 'finally' }])
    assert.equal(llm.requests.length, 3)
  })

  it('鉴权失败不重试，只请求一次', async () => {
    llm.enqueue({ status: 401, errorMessage: 'bad key' }, { text: 'should not be reached' })
    const client = createClient(openaiConfig(llm.openaiBaseUrl), { retry: { baseDelayMs: 5 } })
    await assert.rejects(client.generate(REQ), (e: unknown) => e instanceof LlmError && e.kind === 'auth')
    assert.equal(llm.requests.length, 1)
    // 把没用掉的那条脚本清掉
    await createClient(openaiConfig(llm.openaiBaseUrl), { retry: false }).generate(REQ)
  })

  it('一直失败时在 maxAttempts 次后放弃，把最后的错误交给调用方', async () => {
    llm.enqueue({ status: 500 }, { status: 500 }, { status: 500 })
    const client = createClient(openaiConfig(llm.openaiBaseUrl), { retry: { maxAttempts: 3, baseDelayMs: 5 } })
    await assert.rejects(client.generate(REQ), (e: unknown) => e instanceof LlmError && e.kind === 'server')
    assert.equal(llm.requests.length, 3)
  })

  it('服务端给了 Retry-After 时至少等那么久', async () => {
    llm.enqueue({ status: 429, headers: { 'retry-after': '2' } }, { text: 'ok' })
    const waits: number[] = []
    const client = createClient(openaiConfig(llm.openaiBaseUrl), {
      retry: {
        baseDelayMs: 5,
        sleep: async (ms) => {
          waits.push(ms)
        },
      },
    })
    await client.generate(REQ)
    assert.equal(waits.length, 1)
    assert.ok(waits[0]! >= 2000, `waited ${waits[0]} ms`)
  })

  it('等待重试期间被 AbortSignal 打断，立刻以 aborted 结束，不再请求', async () => {
    llm.enqueue({ status: 503 }, { text: 'should not be reached' })
    const client = createClient(openaiConfig(llm.openaiBaseUrl), { retry: { baseDelayMs: 60_000, maxDelayMs: 60_000 } })
    const ctl = new AbortController()
    const started = Date.now()
    setTimeout(() => ctl.abort(), 50)
    await assert.rejects(client.generate({ ...REQ, signal: ctl.signal }), (e: unknown) => e instanceof LlmError && e.kind === 'aborted')
    assert.ok(Date.now() - started < 2000)
    assert.equal(llm.requests.length, 1)
    await createClient(openaiConfig(llm.openaiBaseUrl), { retry: false }).generate(REQ)
  })

  it('超时照常重试；这次调用说了“超时不重试”（写交接记录的那种）就只请求一次，别的可重试的错它也照常重试', async () => {
    // 模型的超时 60 毫秒，接口 400 毫秒才回：每次都超时
    const slow = { text: 'too late', delayMs: 400 }
    const client = (kind: 'openai' | 'anthropic') =>
      createClient(kind === 'openai' ? openaiConfig(llm.openaiBaseUrl, { timeoutMs: 60 }) : anthropicConfig(llm.anthropicBaseUrl, { timeoutMs: 60 }), { retry: { baseDelayMs: 5, maxDelayMs: 10, maxAttempts: 3 } })
    llm.enqueue(slow, slow, slow)
    await assert.rejects(client('openai').generate(REQ), (e: unknown) => e instanceof LlmError && e.kind === 'timeout' && e.message === 'no response within 60 ms')
    assert.equal(llm.requests.length, 3)

    llm.requests.length = 0
    llm.enqueue(slow, { text: 'never asked' })
    await assert.rejects(client('anthropic').generate({ ...REQ, noRetryOnTimeout: true }), (e: unknown) => e instanceof LlmError && e.kind === 'timeout')
    assert.equal(llm.requests.length, 1)

    // 说了“超时不重试”的调用碰上过载，还是会重试
    await new Promise((r) => setTimeout(r, 450))
    llm.requests.length = 0
    llm.clearScript()
    llm.enqueue({ status: 529, errorType: 'overloaded_error' }, { text: 'ok now' })
    const result = await client('anthropic').generate({ ...REQ, noRetryOnTimeout: true })
    assert.deepEqual([result.message.content, llm.requests.length], [[{ type: 'text', text: 'ok now' }], 2])
  })

  it('这次调用要求“至少等这么久”（写交接记录的那种）：模型配置的超时比它短就用它，配置得更长的照配置；等得比 fetch 自己那五分钟还长时换成不设上限的连接器', async () => {
    // 模型的超时 60 毫秒，接口 300 毫秒才回：平时超时；这次调用要求至少等 2 秒，就等到了
    llm.enqueue({ text: 'slow but fine', delayMs: 300 })
    const short = createClient(openaiConfig(llm.openaiBaseUrl, { timeoutMs: 60 }), { retry: { maxAttempts: 1 } })
    assert.deepEqual((await short.generate({ ...REQ, minTimeoutMs: 2000 })).message.content, [{ type: 'text', text: 'slow but fine' }])
    // 模型配置的 2 秒比这次要求的 60 毫秒长：照配置的等
    llm.enqueue({ text: 'also fine', delayMs: 300 })
    const long = createClient(anthropicConfig(llm.anthropicBaseUrl, { timeoutMs: 2000 }), { retry: { maxAttempts: 1 } })
    assert.deepEqual((await long.generate({ ...REQ, minTimeoutMs: 60 })).message.content, [{ type: 'text', text: 'also fine' }])

    // 看发出去的请求用的是哪个连接器：平时不带（用全局的，它等响应头只等五分钟）；要等二十分钟的带一个不设上限的
    const seen: unknown[] = []
    const spy: typeof fetch = (url, init) => {
      seen.push((init as { dispatcher?: unknown } | undefined)?.dispatcher)
      return fetch(url, init)
    }
    llm.enqueue({ text: 'a' }, { text: 'b' })
    const watched = createClient(openaiConfig(llm.openaiBaseUrl), { fetch: spy })
    await watched.generate(REQ)
    await watched.generate({ ...REQ, minTimeoutMs: 20 * 60_000 })
    assert.equal(seen[0], undefined)
    const usual = (globalThis as unknown as Record<symbol, object>)[Symbol.for('undici.globalDispatcher.1')]!
    assert.ok(typeof seen[1] === 'object' && seen[1] !== null && seen[1] !== usual && seen[1].constructor === usual.constructor, 'a dispatcher of its own, of the same kind as the global one')
  })

  it('每次成功的调用都把用量交给回调；失败的尝试不计', async () => {
    llm.enqueue({ status: 500 }, { text: 'a', usage: { input: 300, output: 12 } })
    const records: UsageRecord[] = []
    const client = createClient(openaiConfig(llm.openaiBaseUrl), { retry: { baseDelayMs: 5 }, onUsage: (r) => records.push(r) })
    await client.generate(REQ)
    assert.equal(records.length, 1)
    assert.equal(records[0]!.providerId, 'oa')
    assert.equal(records[0]!.model, 'gpt-mock')
    assert.deepEqual(records[0]!.usage, { inputTokens: 300, outputTokens: 12 })
  })

  it('测试连接：通了返回模型名和耗时', async () => {
    llm.enqueue({ text: 'pong' })
    const res = await testConnection(anthropicConfig(llm.anthropicBaseUrl))
    assert.equal(res.ok, true)
    assert.equal(res.model, 'claude-mock')
    assert.equal(res.reply, 'pong')
    assert.ok(res.durationMs >= 0)
    // 最小请求：不带工具
    assert.equal(llm.requests[0]!.body.tools, undefined)
  })

  it('测试连接：key 不对时返回失败原因，不抛错也不重试', async () => {
    llm.enqueue({ status: 401, errorMessage: 'Incorrect API key provided' })
    const res = await testConnection(openaiConfig(llm.openaiBaseUrl))
    assert.equal(res.ok, false)
    assert.equal(res.error?.kind, 'auth')
    assert.equal(res.error?.status, 401)
    assert.match(res.error?.message ?? '', /Incorrect API key/)
    assert.equal(llm.requests.length, 1)
  })

  it('模拟模型服务像真实接口一样拒绝配不上对的工具调用和结果（这样适配器漏了整理时测试会失败）', async () => {
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${llm.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, json: (await res.json()) as any }
    }
    // Anthropic：调用了工具却没有紧跟结果
    const a = await post('/v1/messages', {
      model: 'm',
      max_tokens: 10,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'say', input: {} }] },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
    })
    assert.equal(a.status, 400)
    assert.match(a.json.error.message, /tu_1 were found without tool_result/)
    // Anthropic：连续两条 user
    const b = await post('/v1/messages', { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] })
    assert.match(b.json.error.message, /roles must alternate/)
    // OpenAI：tool 消息前面没有对应的调用
    const c = await post('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'hi' }, { role: 'tool', tool_call_id: 'call_x', content: 'r' }] })
    assert.equal(c.status, 400)
    assert.match(c.json.error.message, /must follow an assistant message with a matching tool_call/)
    assert.equal(llm.rejected.length, 3)
  })
})
