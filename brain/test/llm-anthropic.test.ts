import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { LlmError, createClient } from '../src/llm/index.ts'
import type { GenerateRequest, Message, ToolSpec } from '../src/llm/index.ts'
import { anthropicConfig, user } from './helpers.ts'
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

describe('Anthropic 兼容适配器', () => {
  const llm = new MockLlm()
  before(async () => {
    await llm.start()
  })
  after(() => llm.stop())
  beforeEach(() => {
    llm.requests.length = 0
  })

  const client = (extra = {}) => createClient(anthropicConfig(llm.anthropicBaseUrl, extra), { retry: false })

  it('发到 /v1/messages，带版本头和 x-api-key；system 和最后一个工具带缓存标记', async () => {
    llm.enqueue({ text: 'hi' })
    await client({ extraBody: { top_k: 5 } }).generate(request([user('hello')], { toolChoice: 'required' }))
    const sent = llm.requests[0]!
    assert.equal(sent.path, '/v1/messages')
    assert.equal(sent.headers['anthropic-version'], '2023-06-01')
    assert.equal(sent.headers['x-api-key'], 'sk-ant-test-5678')
    assert.equal(sent.headers.authorization, undefined)
    assert.equal(sent.body.model, 'claude-mock')
    assert.equal(sent.body.max_tokens, 4096)
    assert.equal(sent.body.top_k, 5)
    assert.deepEqual(sent.body.system, [{ type: 'text', text: 'You are a test bot.', cache_control: { type: 'ephemeral' } }])
    assert.deepEqual(sent.body.tools, [
      { name: 'say', description: 'Say something', input_schema: TOOLS[0]!.inputSchema },
      { name: 'go_to', description: 'Walk', input_schema: TOOLS[1]!.inputSchema, cache_control: { type: 'ephemeral' } },
    ])
    assert.deepEqual(sent.body.tool_choice, { type: 'any' })
    assert.deepEqual(sent.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  })

  it('authStyle=bearer 改用 Authorization 头；关掉 promptCaching 后不带缓存标记', async () => {
    llm.enqueue({ text: 'hi' })
    await client({ maxOutputTokens: 900, options: { authStyle: 'bearer', promptCaching: false } }).generate(request([user('hello')]))
    const sent = llm.requests[0]!
    assert.equal(sent.headers.authorization, 'Bearer sk-ant-test-5678')
    assert.equal(sent.headers['x-api-key'], undefined)
    assert.equal(sent.body.max_tokens, 900)
    assert.equal(sent.body.system, 'You are a test bot.')
    assert.equal(JSON.stringify(sent.body).includes('cache_control'), false)
  })

  it('这次调用要求“输出至少给这么多”（写交接记录的调用）：配置的上限比它小或者没配就用它，配置得更大的照配置', async () => {
    llm.enqueue({ text: 'a' }, { text: 'b' }, { text: 'c' })
    await client({ maxOutputTokens: 900 }).generate(request([user('hello')], { minOutputTokens: 30_000 }))
    await client({}).generate(request([user('hello')], { minOutputTokens: 30_000 }))
    await client({ maxOutputTokens: 64_000 }).generate(request([user('hello')], { minOutputTokens: 30_000 }))
    assert.deepEqual(llm.requests.map((r) => r.body.max_tokens), [30_000, 30_000, 64_000])
  })

  it('连续的同角色消息合并，工具结果紧跟工具调用并排在文本前面', async () => {
    llm.enqueue({ text: 'ok' })
    await client().generate(
      request([
        user('first'),
        user('second'),
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'working' },
            { type: 'tool_call', id: 'tu_1', name: 'say', input: { message: 'a' } },
            { type: 'tool_call', id: 'tu_2', name: 'go_to', input: { x: 1 } },
          ],
        },
        // 文本写在结果前面、结果顺序颠倒：适配器要摆正
        {
          role: 'user',
          content: [
            { type: 'text', text: 'step limit reached' },
            { type: 'tool_result', toolCallId: 'tu_2', content: 'unreachable', isError: true },
            { type: 'tool_result', toolCallId: 'tu_1', content: 'Said.' },
          ],
        },
        user('new event'),
      ]),
    )
    assert.deepEqual(llm.requests[0]!.body.messages, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'working' },
          { type: 'tool_use', id: 'tu_1', name: 'say', input: { message: 'a' } },
          { type: 'tool_use', id: 'tu_2', name: 'go_to', input: { x: 1 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'Said.' },
          { type: 'tool_result', tool_use_id: 'tu_2', content: 'unreachable', is_error: true },
          { type: 'text', text: 'step limit reached' },
          { type: 'text', text: 'new event' },
        ],
      },
    ])
  })

  it('历史里缺了结果的工具调用会被补上一个错误结果，接口不会因为配对不上而拒绝', async () => {
    llm.enqueue({ text: 'ok' })
    await client().generate(
      request([
        user('go'),
        { role: 'assistant', content: [{ type: 'tool_call', id: 'tu_lost', name: 'go_to', input: { x: 1 } }] },
        user('next event'),
      ]),
    )
    const last = llm.requests[0]!.body.messages[2]
    assert.equal(last.role, 'user')
    assert.equal(last.content[0].type, 'tool_result')
    assert.equal(last.content[0].tool_use_id, 'tu_lost')
    assert.equal(last.content[0].is_error, true)
    assert.deepEqual(last.content[1], { type: 'text', text: 'next event' })
  })

  it('解析出文本、工具调用、结束原因；用量把缓存读写算进输入', async () => {
    llm.enqueue({
      text: 'Starting.',
      toolCalls: [
        { id: 'tu_a', name: 'say', input: { message: '好' } },
        { id: 'tu_b', name: 'go_to', input: { x: 2 } },
      ],
      usage: { input: 50, output: 30, cacheRead: 2000, cacheWrite: 400 },
    })
    const result = await client().generate(request([user('hi')]))
    assert.deepEqual(result.message.content, [
      { type: 'text', text: 'Starting.' },
      { type: 'tool_call', id: 'tu_a', name: 'say', input: { message: '好' } },
      { type: 'tool_call', id: 'tu_b', name: 'go_to', input: { x: 2 } },
    ])
    assert.equal(result.stopReason, 'tool_use')
    assert.deepEqual(result.usage, { inputTokens: 2450, outputTokens: 30, cacheReadTokens: 2000, cacheWriteTokens: 400 })
  })

  it('thinking 和 redacted_thinking 块在下一次请求里原样、原位置回传', async () => {
    llm.enqueue({
      thinking: { thinking: 'I should flatten first.', signature: 'sig-abc123' },
      redactedThinking: 'ENCRYPTED==',
      text: 'Let me do it.',
      toolCalls: [{ id: 'tu_t', name: 'go_to', input: { x: 9 } }],
    })
    const first = await client().generate(request([user('flatten please')]))
    assert.deepEqual(
      first.message.content.map((p) => p.type),
      ['opaque', 'opaque', 'text', 'tool_call'],
    )

    llm.enqueue({ text: 'done' })
    await client().generate(
      request([
        user('flatten please'),
        first.message,
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 'tu_t', content: 'started' }] },
      ]),
    )
    assert.deepEqual(llm.requests[1]!.body.messages[1], {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I should flatten first.', signature: 'sig-abc123' },
        { type: 'redacted_thinking', data: 'ENCRYPTED==' },
        { type: 'text', text: 'Let me do it.' },
        { type: 'tool_use', id: 'tu_t', name: 'go_to', input: { x: 9 } },
      ],
    })
  })

  it('别的适配器产生的 OpaquePart 被丢弃', async () => {
    llm.enqueue({ text: 'ok' })
    await client().generate(
      request([
        user('q'),
        {
          role: 'assistant',
          content: [
            { type: 'opaque', provider: 'openai-chat', data: { reasoning_content: 'private reasoning' } },
            { type: 'text', text: 'answer' },
          ],
        },
        user('next'),
      ]),
    )
    assert.deepEqual(llm.requests[0]!.body.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'answer' }] })
  })

  it('cacheConversation 打开后最后一条消息也带缓存标记', async () => {
    llm.enqueue({ text: 'ok' })
    await client({ options: { cacheConversation: true } }).generate(request([user('one'), { role: 'assistant', content: [{ type: 'text', text: 'two' }] }, user('three')]))
    const messages = llm.requests[0]!.body.messages
    assert.deepEqual(messages[2].content[0], { type: 'text', text: 'three', cache_control: { type: 'ephemeral' } })
    assert.equal(messages[0].content[0].cache_control, undefined)
  })

  describe('错误分类', () => {
    it('529 overloaded_error 是 overloaded，可重试', async () => {
      llm.enqueue({ status: 529, errorType: 'overloaded_error', errorMessage: 'Overloaded' })
      const e = await failure(client().generate(request([user('hi')])))
      assert.deepEqual([e.kind, e.retryable, e.status], ['overloaded', true, 529])
    })

    it('401 authentication_error 是 auth', async () => {
      llm.enqueue({ status: 401, errorType: 'authentication_error', errorMessage: 'invalid x-api-key' })
      const e = await failure(client().generate(request([user('hi')])))
      assert.deepEqual([e.kind, e.retryable], ['auth', false])
    })

    it('400 且说 prompt is too long 是 context_length', async () => {
      llm.enqueue({ status: 400, errorType: 'invalid_request_error', errorMessage: 'prompt is too long: 210000 tokens > 200000 maximum' })
      const e = await failure(client().generate(request([user('hi')])))
      assert.deepEqual([e.kind, e.retryable], ['context_length', false])
    })

    it('429 rate_limit_error 是 rate_limit', async () => {
      llm.enqueue({ status: 429, errorType: 'rate_limit_error', errorMessage: 'rate limited', headers: { 'retry-after': '3' } })
      const e = await failure(client().generate(request([user('hi')])))
      assert.deepEqual([e.kind, e.retryable, e.retryAfterMs], ['rate_limit', true, 3000])
    })
  })
})
