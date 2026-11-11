import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { LlmError, createClient } from '../src/llm/index.ts'
import type { GenerateRequest, Message, ToolSpec } from '../src/llm/index.ts'
import { freePort, openaiConfig, user } from './helpers.ts'
import { MockLlm } from './mock-llm.ts'

const TOOLS: ToolSpec[] = [
  { name: 'say', description: 'Say something', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
  { name: 'go_to', description: 'Walk', inputSchema: { type: 'object', properties: { x: { type: 'integer' } } } },
]

function request(messages: Message[], extra: Partial<GenerateRequest> = {}): GenerateRequest {
  return { system: 'You are a test bot.', messages, tools: TOOLS, ...extra }
}

async function failure(p: Promise<unknown>): Promise<LlmError> {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof LlmError, `expected LlmError, got ${String(e)}`)
    return e
  }
  assert.fail('expected the call to fail')
}

describe('OpenAI 兼容适配器', () => {
  const llm = new MockLlm()
  before(async () => {
    await llm.start()
  })
  after(() => llm.stop())
  beforeEach(() => {
    llm.requests.length = 0
  })

  const client = (extra = {}) => createClient(openaiConfig(llm.openaiBaseUrl, extra), { retry: false })

  it('把系统提示词、工具定义、之前的工具调用和结果翻译成 chat completions 的请求', async () => {
    llm.enqueue({ text: 'done' })
    const history: Message[] = [
      user('Steve: flatten here'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'On it.' },
          { type: 'tool_call', id: 'call_a', name: 'say', input: { message: 'ok' } },
          { type: 'tool_call', id: 'call_b', name: 'go_to', input: { x: 5 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'call_a', content: 'Said.' },
          { type: 'tool_result', toolCallId: 'call_b', content: 'no path', isError: true },
          { type: 'text', text: 'task t1 failed' },
        ],
      },
    ]
    await client({ maxOutputTokens: 777, temperature: 0.3, extraBody: { top_p: 0.9 }, extraHeaders: { 'x-extra': 'yes' } }).generate(
      request(history, { toolChoice: 'auto' }),
    )

    const sent = llm.requests[0]!
    assert.equal(sent.path, '/v1/chat/completions')
    assert.equal(sent.headers.authorization, 'Bearer sk-test-openai-1234')
    assert.equal(sent.headers['x-extra'], 'yes')
    assert.equal(sent.body.model, 'gpt-mock')
    assert.equal(sent.body.max_tokens, 777)
    assert.equal(sent.body.temperature, 0.3)
    assert.equal(sent.body.top_p, 0.9)
    assert.equal(sent.body.tool_choice, 'auto')
    assert.deepEqual(sent.body.tools[0], {
      type: 'function',
      function: { name: 'say', description: 'Say something', parameters: TOOLS[0]!.inputSchema },
    })
    assert.deepEqual(sent.body.messages, [
      { role: 'system', content: 'You are a test bot.' },
      { role: 'user', content: 'Steve: flatten here' },
      {
        role: 'assistant',
        content: 'On it.',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'say', arguments: '{"message":"ok"}' } },
          { id: 'call_b', type: 'function', function: { name: 'go_to', arguments: '{"x":5}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'Said.' },
      { role: 'tool', tool_call_id: 'call_b', content: 'ERROR: no path' },
      { role: 'user', content: 'task t1 failed' },
    ])
  })

  it('这次调用要求“输出至少给这么多”（写交接记录的调用）：配置的上限比它小或者没配就用它，配置得更大的照配置', async () => {
    llm.enqueue({ text: 'a' }, { text: 'b' }, { text: 'c' })
    await client({ maxOutputTokens: 777 }).generate(request([user('hi')], { minOutputTokens: 30_000 }))
    await client({}).generate(request([user('hi')], { minOutputTokens: 30_000 }))
    await client({ maxOutputTokens: 128_000 }).generate(request([user('hi')], { minOutputTokens: 30_000 }))
    assert.deepEqual(llm.requests.map((r) => r.body.max_tokens), [30_000, 30_000, 128_000])
  })

  it('开关 maxTokensField 和 systemRole 改变输出上限的字段名和系统提示词的角色', async () => {
    llm.enqueue({ text: 'ok' })
    await client({ maxOutputTokens: 500, options: { maxTokensField: 'max_completion_tokens', systemRole: 'developer' } }).generate(
      request([user('hi')]),
    )
    const body = llm.requests[0]!.body
    assert.equal(body.max_completion_tokens, 500)
    assert.equal(body.max_tokens, undefined)
    assert.equal(body.messages[0].role, 'developer')
  })

  it('解析出文本、多个工具调用、结束原因和用量', async () => {
    llm.enqueue({
      text: 'Starting.',
      toolCalls: [
        { id: 'c1', name: 'say', input: { message: '好' } },
        { id: 'c2', name: 'go_to', input: { x: 1 } },
      ],
      usage: { input: 1200, output: 34, cacheRead: 1000 },
    })
    const result = await client().generate(request([user('hi')]))
    assert.deepEqual(result.message.content, [
      { type: 'text', text: 'Starting.' },
      { type: 'tool_call', id: 'c1', name: 'say', input: { message: '好' } },
      { type: 'tool_call', id: 'c2', name: 'go_to', input: { x: 1 } },
    ])
    assert.equal(result.stopReason, 'tool_use')
    assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 34, cacheReadTokens: 1000 })
    assert.equal(result.model, 'gpt-mock')
  })

  it('没有工具调用时结束原因是 end；被长度截断时是 max_tokens', async () => {
    llm.enqueue({ text: 'bye' }, { text: 'cut o', stop: 'length' })
    assert.equal((await client().generate(request([user('a')]))).stopReason, 'end')
    assert.equal((await client().generate(request([user('b')]))).stopReason, 'max_tokens')
  })

  it('工具参数不是合法 JSON 时不抛错，而是把这次调用标记出来', async () => {
    llm.enqueue({ toolCalls: [{ id: 'bad1', name: 'say', rawArguments: '{"message": "oops' }] })
    const result = await client().generate(request([user('hi')]))
    const call = result.message.content.find((p) => p.type === 'tool_call')
    assert.ok(call && call.type === 'tool_call')
    assert.equal(call.name, 'say')
    assert.equal(call.invalid?.raw, '{"message": "oops')
    assert.equal(result.stopReason, 'tool_use')
  })

  it('reasoning_content 存成 OpaquePart，默认不回传，打开 replayReasoning 才回传', async () => {
    llm.enqueue({ text: 'answer', thinking: { thinking: 'let me think', signature: '' } })
    const first = await client().generate(request([user('q')]))
    assert.deepEqual(first.message.content[0], {
      type: 'opaque',
      provider: 'openai-chat',
      data: { reasoning_content: 'let me think' },
    })

    const history: Message[] = [user('q'), first.message, user('again')]
    llm.enqueue({ text: 'x' }, { text: 'y' })
    await client().generate(request(history))
    await client({ options: { replayReasoning: true } }).generate(request(history))
    const withoutReplay = llm.requests[1]!.body.messages.find((m: { role: string }) => m.role === 'assistant')
    const withReplay = llm.requests[2]!.body.messages.find((m: { role: string }) => m.role === 'assistant')
    assert.equal(withoutReplay.reasoning_content, undefined)
    assert.equal(withReplay.reasoning_content, 'let me think')
    assert.equal(withReplay.content, 'answer')
  })

  it('别的适配器产生的 OpaquePart 不会发给 OpenAI 接口', async () => {
    llm.enqueue({ text: 'ok' })
    await client({ options: { replayReasoning: true } }).generate(
      request([
        user('q'),
        {
          role: 'assistant',
          content: [
            { type: 'opaque', provider: 'anthropic-messages', data: { type: 'thinking', thinking: 'secret', signature: 'sig' } },
            { type: 'text', text: 'a' },
          ],
        },
        user('next'),
      ]),
    )
    assert.equal(JSON.stringify(llm.requests[0]!.body).includes('secret'), false)
  })

  describe('错误分类', () => {
    it('401 是 auth，不可重试', async () => {
      llm.enqueue({ status: 401, errorMessage: 'Incorrect API key', errorType: 'invalid_api_key' })
      const e = await failure(client().generate(request([user('hi')])))
      assert.equal(e.kind, 'auth')
      assert.equal(e.status, 401)
      assert.equal(e.retryable, false)
      assert.match(e.message, /Incorrect API key/)
    })

    it('429 是 rate_limit，可重试，并带上 Retry-After', async () => {
      llm.enqueue({ status: 429, errorMessage: 'slow down', headers: { 'retry-after': '7' } })
      const e = await failure(client().generate(request([user('hi')])))
      assert.equal(e.kind, 'rate_limit')
      assert.equal(e.retryable, true)
      assert.equal(e.retryAfterMs, 7000)
    })

    it('429 但原因是余额用完时不可重试', async () => {
      llm.enqueue({ status: 429, errorType: 'insufficient_quota', errorMessage: 'You exceeded your current quota' })
      const e = await failure(client().generate(request([user('hi')])))
      assert.equal(e.kind, 'rate_limit')
      assert.equal(e.retryable, false)
    })

    it('400 且说上下文超长是 context_length；普通 400 是 bad_request', async () => {
      llm.enqueue(
        { status: 400, errorType: 'context_length_exceeded', errorMessage: "This model's maximum context length is 8192 tokens" },
        { status: 400, errorMessage: 'unknown parameter: foo' },
      )
      assert.equal((await failure(client().generate(request([user('a')])))).kind, 'context_length')
      const e = await failure(client().generate(request([user('b')])))
      assert.equal(e.kind, 'bad_request')
      assert.equal(e.retryable, false)
    })

    it('500 是 server，503 是 overloaded，都可重试', async () => {
      llm.enqueue({ status: 500, errorMessage: 'boom' }, { status: 503, errorMessage: 'busy' })
      const a = await failure(client().generate(request([user('a')])))
      const b = await failure(client().generate(request([user('b')])))
      assert.deepEqual([a.kind, a.retryable], ['server', true])
      assert.deepEqual([b.kind, b.retryable], ['overloaded', true])
    })

    it('连不上是 network，可重试', async () => {
      const port = await freePort()
      const c = createClient(openaiConfig(`http://127.0.0.1:${port}/v1`), { retry: false })
      const e = await failure(c.generate(request([user('hi')])))
      assert.equal(e.kind, 'network')
      assert.equal(e.retryable, true)
    })

    it('超过 timeoutMs 没回应是 timeout', async () => {
      llm.enqueue({ hang: true })
      const e = await failure(client({ timeoutMs: 80 }).generate(request([user('hi')])))
      assert.equal(e.kind, 'timeout')
      assert.equal(e.retryable, true)
    })

    it('被 AbortSignal 打断是 aborted，不可重试', async () => {
      llm.enqueue({ hang: true })
      const ctl = new AbortController()
      setTimeout(() => ctl.abort(), 30)
      const e = await failure(client().generate(request([user('hi')], { signal: ctl.signal })))
      assert.equal(e.kind, 'aborted')
      assert.equal(e.retryable, false)
    })

    it('200 但不是 JSON 时报 server 错误而不是崩溃', async () => {
      llm.enqueue({ rawBody: '<html>gateway</html>' })
      const e = await failure(client().generate(request([user('hi')])))
      assert.equal(e.kind, 'server')
    })

    it('key 里有不能放进请求头的字符时是 bad_request，而不是当成网络故障去重试', async () => {
      const c = createClient(openaiConfig(llm.openaiBaseUrl, { apiKey: '密钥\n换行' }), { retry: false })
      const e = await failure(c.generate(request([user('hi')])))
      assert.equal(e.kind, 'bad_request')
      assert.equal(e.retryable, false)
      assert.equal(llm.requests.length, 0)
    })
  })
})
