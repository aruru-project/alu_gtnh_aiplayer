import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { chooseCut, compactHistory, historyTokens, truncateOldToolResults } from '../src/agent/compaction.ts'
import type { GenerateRequest, LlmClient, Message } from '../src/llm/index.ts'
import type { Turn } from '../src/store/history.ts'
import { assertToolPairs, makeAgent, reply, sentToTalk, taskEnded, told } from './agent-harness.ts'

/** 一轮：事件 → 模型调两个工具 → 结果 → 模型收尾。resultSize 控制工具结果有多长。 */
function turn(id: number, resultSize = 100): Turn {
  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: `event of turn ${id}` }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool_call', id: `a${id}`, name: 'scan_area', input: { x1: 0, z1: 0, x2: 9, z2: 9 } },
        { type: 'tool_call', id: `b${id}`, name: 'say', input: { message: 'ok' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: `a${id}`, content: 'h'.repeat(resultSize) },
        { type: 'tool_result', toolCallId: `b${id}`, content: 'Said.' },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: `wrap up ${id}` }] },
  ]
  return { id, startedAt: id * 1000, messages }
}

function summarizer(text = '摘要：主人要在 (0,0)-(9,9) 平地到 y=64。'): LlmClient & { requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = []
  return {
    requests,
    async generate(req) {
      requests.push(req)
      return { message: { role: 'assistant', content: [{ type: 'text', text }] }, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'm' }
    },
  }
}

describe('历史压缩', () => {
  it('没超阈值时什么都不动，也不调模型', async () => {
    const llm = summarizer()
    const turns = [turn(1), turn(2)]
    const res = await compactHistory('', turns, { threshold: 100_000, llm })
    assert.equal(res.action, 'nothing')
    assert.deepEqual(res.turns, turns)
    assert.equal(llm.requests.length, 0)
  })

  it('旧的超长工具结果先被截断，最近两轮的不动；截断够用时不调模型', async () => {
    const turns = [turn(1, 9000), turn(2, 9000), turn(3, 9000), turn(4, 9000)]
    const before = historyTokens('', turns)
    const llm = summarizer()
    const res = await compactHistory('', turns, { threshold: Math.floor(before * 0.7), llm })
    assert.equal(res.action, 'truncated')
    assert.equal(llm.requests.length, 0)
    const sizes = res.turns.map((t) => {
      const m = t.messages[2]!
      const p = m.content[0]!
      return p.type === 'tool_result' ? p.content.length : -1
    })
    assert.ok(sizes[0]! < 600 && sizes[1]! < 600, `old results were shortened: ${sizes.join(',')}`)
    assert.deepEqual(sizes.slice(2), [9000, 9000])
    assertToolPairs(res.turns.flatMap((t) => t.messages))
    // 原数组没被改
    const original = turns[0]!.messages[2]!.content[0]!
    assert.ok(original.type === 'tool_result' && original.content.length === 9000)
  })

  it('截断还不够时把较早的整轮压成摘要：留下的轮完整，工具调用和结果成对', async () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(i + 1, 300))
    const total = historyTokens('', turns)
    const llm = summarizer()
    const res = await compactHistory('旧摘要：它叫 Alu。', turns, { threshold: Math.floor(total / 2), llm })

    assert.equal(res.action, 'summarized')
    assert.equal(res.summary, '摘要：主人要在 (0,0)-(9,9) 平地到 y=64。')
    assert.ok(res.removedTurns > 0 && res.removedTurns < 12)
    assert.equal(res.turns.length, 12 - res.removedTurns)
    // 留下的是最新的那些轮，一轮都没被拆开
    assert.deepEqual(res.turns, turns.slice(res.removedTurns))
    assertToolPairs(res.turns.flatMap((t) => t.messages))
    assert.ok(historyTokens(res.summary, res.turns) <= Math.floor(total / 2))
    // 写摘要的那次调用不带工具，内容里有旧摘要和被压掉的轮
    const req = llm.requests[0]!
    assert.deepEqual(req.tools, [])
    const text = req.messages[0]!.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
    assert.match(text, /旧摘要：它叫 Alu。/)
    assert.match(text, /event of turn 1/)
    assert.equal(text.includes(`event of turn ${res.turns[0]!.id}`), false)
  })

  it('切点只落在轮的边界上，至少留下最新的一轮', () => {
    const turns = [turn(1, 3000), turn(2, 3000), turn(3, 3000)]
    assert.equal(chooseCut(turns, 0), 2)
    assert.equal(chooseCut(turns, 1_000_000), 0)
    assert.equal(chooseCut([turn(1, 50_000)], 10), 0)
  })

  it('摘要没写成：没超太多就原样留着下次再试，超过两倍阈值才丢弃旧轮', async () => {
    const failing: LlmClient = {
      async generate() {
        throw new Error('model is down')
      },
    }
    const turns = Array.from({ length: 10 }, (_, i) => turn(i + 1, 300))
    const total = historyTokens('', turns)

    const kept = await compactHistory('', turns, { threshold: Math.floor(total * 0.8), llm: failing })
    assert.equal(kept.action, 'nothing')
    assert.equal(kept.turns.length, 10)
    assert.match(kept.error ?? '', /model is down/)

    const dropped = await compactHistory('', turns, { threshold: Math.floor(total / 4), llm: failing })
    assert.equal(dropped.action, 'dropped')
    assert.ok(dropped.turns.length < 10)
    assert.match(dropped.summary, /被丢弃/)
    assertToolPairs(dropped.turns.flatMap((t) => t.messages))
  })

  it('截断旧结果不影响调用和结果的对应关系', () => {
    const { turns, changed } = truncateOldToolResults([turn(1, 5000), turn(2, 5000), turn(3, 5000)], 1, 200)
    assert.equal(changed, true)
    assertToolPairs(turns.flatMap((t) => t.messages))
    const ids = turns.flatMap((t) => t.messages).flatMap((m) => (m.role === 'user' ? m.content.filter((p) => p.type === 'tool_result').map((p) => p.toolCallId) : []))
    assert.deepEqual(ids, ['a1', 'b1', 'a2', 'b2', 'a3', 'b3'])
  })
})

describe('agent 跑久了以后的历史', () => {
  it('历史超过阈值后被压成摘要；之后发给模型的消息以摘要开头，工具调用和结果仍然成对', async (t) => {
    const h = makeAgent({ settings: { historyTokenThreshold: 2000 } })
    t.after(h.cleanup)
    // 每一轮：看一眼状态（结果较长）再结束。写摘要的调用（不带工具）回一段固定的摘要。
    h.game.handlers['world.scan'] = (p) => ({
      x1: p.x1,
      z1: p.z1,
      x2: p.x2,
      z2: p.z2,
      heights: Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 64)),
    })
    let summaries = 0
    const respond = (req: GenerateRequest) => {
      if (req.tools.length === 0) {
        summaries++
        return reply('【摘要】主人让我把 (0,0)-(19,19) 平到 64，已经扫过地形。')
      }
      const last = req.messages[req.messages.length - 1]!
      const afterTool = last.role === 'user' && last.content.some((p) => p.type === 'tool_result')
      return afterTool ? reply('') : reply('', [{ name: 'scan_area', input: { x1: 0, z1: 0, x2: 19, z2: 19 } }])
    }
    h.llm.enqueue(...Array.from({ length: 60 }, () => respond))

    for (let i = 1; i <= 8; i++) {
      h.agent.handleEvent(i === 1 ? told('把 0,0 到 19,19 平到 64') : taskEnded(`t${i}`, 'done'))
      await h.agent.whenIdle()
    }

    assert.ok(summaries >= 1, 'history was summarized at least once')
    const state = h.history.get()
    assert.match(state.summary, /【摘要】/)
    assert.ok(state.turns.length < 8)
    assert.ok(historyTokens(state.summary, state.turns) <= 2000)

    // 再来一轮，看实际发给模型的消息
    h.agent.handleEvent(taskEnded('t99', 'done'))
    await h.agent.whenIdle()
    const sent = h.llm.requests.filter((r) => r.tools.length > 0).at(-1)!.messages
    const first = sent[0]!
    assert.ok(first.role === 'user' && first.content[0]!.type === 'text' && first.content[0]!.text.includes('【摘要】'))
    assertToolPairs(sent)
  })

  it('模型说上下文超长时，先压缩历史再重试同一轮，而不是直接放弃', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(reply('第一轮'), reply('第二轮'))
    h.agent.handleEvent(told('Alu 一'))
    await h.agent.whenIdle()
    h.agent.handleEvent(told('Alu 二'))
    await h.agent.whenIdle()
    assert.equal(h.history.get().turns.length, 2)

    const { LlmError } = await import('../src/llm/index.ts')
    h.llm.enqueue(
      new LlmError('context_length', 'prompt is too long', { status: 400 }),
      (req) => (req.tools.length === 0 ? reply('压缩后的摘要') : reply('不该先到这里')),
      reply('', [{ name: 'get_status' }]),
      reply('好的'),
    )
    h.agent.handleEvent(told('Alu 三'))
    await h.agent.whenIdle()

    assert.deepEqual(sentToTalk(h).at(-1), '好的')
    assert.equal(h.agent.status().outage, undefined)
    assert.match(h.history.get().summary, /压缩后的摘要/)
    // 重试的那次请求比第一次短：旧的轮已经换成了摘要
    const retried = h.llm.requests.filter((r) => r.tools.length > 0).at(-2)!
    assert.ok(JSON.stringify(retried.messages).includes('压缩后的摘要'))
    assert.equal(JSON.stringify(retried.messages).includes('Alu 一'), false)
    assert.match(JSON.stringify(retried.messages), /Alu 三/)
  })
})
