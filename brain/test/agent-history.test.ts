import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { STATE_DROPPED, chooseCut, compactHistory, historyTokens, summaryCap, truncateOldToolResults } from '../src/agent/compaction.ts'
import { LlmError } from '../src/llm/index.ts'
import type { GenerateRequest, GenerateResult, LlmClient, Message } from '../src/llm/index.ts'
import { DEFAULT_LIMITS } from '../src/store/config.ts'
import type { Turn } from '../src/store/history.ts'
import { assertToolPairs, makeAgent, reply, sentToTalk, taskEnded, told } from './agent-harness.ts'
import { tmpDir, waitFor } from './helpers.ts'

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

/** 模型回的一段字（写交接记录的那种调用）。 */
function wrote(text: string, more: Partial<GenerateResult> = {}): GenerateResult {
  return { message: { role: 'assistant', content: [{ type: 'text', text }] }, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', ...more }
}

/** 请求里给模型看的那段字。 */
function shownTo(req: GenerateRequest): string {
  return req.messages[0]!.content.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

/** 写交接记录的假模型：每次回同一段字，记下收到的请求。 */
function summarizer(text = '主人要在 (0,0)-(9,9) 平地到 y=64。'): LlmClient & { requests: GenerateRequest[] } {
  const requests: GenerateRequest[] = []
  return {
    requests,
    async generate(req) {
      requests.push(req)
      return wrote(text)
    },
  }
}

/** 写交接记录的假模型：第 n 次回“第 n 版”，记下每次给它看的字。 */
function versions(): LlmClient & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    async generate(req) {
      seen.push(shownTo(req))
      return wrote(`第 ${seen.length} 版`)
    },
  }
}

/** 开头带着一大段“当前状态”的一轮（和真的一轮开头一样的排法）。 */
function stateTurn(id: number): Turn {
  const opening = `[需要你处理的事]\n[10:00:0${id}] 任务 t${id} 完成了。\n\n[最近发生的事（只是背景，不需要回应）]\n[09:59:00] Steve 上线了。\n\n[当前状态]\nAlu: online at (10,64,-4)\n${'Inventory: 64× dirt\n'.repeat(40)}Game time: 07:00`
  return { id, startedAt: id, messages: [{ role: 'user', content: [{ type: 'text', text: opening }] }, { role: 'assistant', content: [{ type: 'text', text: `ok ${id}` }] }] }
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

  it('默认的阈值：干活线 240,000，对话线 120,000；交接记录的上限：干活线两万字符、对话线一万，阈值调小了的跟着小（阈值折合字符的 15%）', () => {
    assert.deepEqual([DEFAULT_LIMITS.historyTokenThreshold, DEFAULT_LIMITS.talkHistoryTokenThreshold], [240_000, 120_000])
    assert.deepEqual([summaryCap(240_000, false), summaryCap(120_000, true)], [20_000, 10_000])
    // 24,000 的阈值折合 72,000 字符，15% 是 10,800；对话线还有它自己那一万的顶
    assert.deepEqual([summaryCap(24_000, false), summaryCap(24_000, true), summaryCap(6000, true)], [10_800, 10_000, 2700])
  })

  it('第一步：最近的一段（至少两轮）原样不动，更早的轮里超长的工具结果留前两千字符、写明原来多长和“要用可以重新调”；这样就不到阈值的七成时不调模型', async () => {
    // 一轮三千一百多 token，六轮一万八千九；阈值一万六。最近那段是阈值的四分之一（四千）：放得下一轮，至少算两轮
    const turns = Array.from({ length: 6 }, (_, i) => turn(i + 1, 9000))
    const llm = summarizer()
    const res = await compactHistory('', turns, { threshold: 16_000, llm })
    assert.deepEqual([res.action, res.recentTurns, llm.requests.length], ['truncated', 2, 0])
    const results = res.turns.map((t) => {
      const p = t.messages[2]!.content[0]!
      return p.type === 'tool_result' ? p.content : ''
    })
    for (const text of results.slice(0, 4)) assert.equal(text, `${'h'.repeat(2000)} …[older result shortened: it was 9000 chars, the first 2000 are kept; call the tool again if you need the rest]`)
    assert.deepEqual(results.slice(4).map((text) => text.length), [9000, 9000])
    assertToolPairs(res.turns.flatMap((t) => t.messages))
    // 截完九千七百多 token，不到阈值的七成（一万一千二）：到此为止
    assert.deepEqual([res.tokensBefore, res.tokensAfter], [18_942, historyTokens('', res.turns)])
    assert.ok(res.tokensAfter < 11_200)
    assert.equal(res.tidied!.results, 4)
    // 原数组没被改
    const original = turns[0]!.messages[2]!.content[0]!
    assert.ok(original.type === 'tool_result' && original.content.length === 9000)
    // 截过的不会再截一遍
    const again = await compactHistory('', res.turns, { threshold: 5000, llm: { generate: async () => wrote('x') } })
    assert.equal(again.tidied?.results ?? 0, 0)
  })

  it('第一步也拿掉旧轮开头那段“当前状态”（它早就过时了），换成一句说明；“需要你处理的事”“最近发生的事”留着；最近那一段的不动', async () => {
    // 一轮三百七十来 token，其中状态占大半；八轮，阈值是总量的八成：最近那段是两轮
    const turns = Array.from({ length: 8 }, (_, i) => stateTurn(i + 1))
    const before = historyTokens('', turns)
    const llm = summarizer()
    const res = await compactHistory('', turns, { threshold: Math.floor(before * 0.8), llm })
    assert.deepEqual([res.action, res.recentTurns, llm.requests.length], ['truncated', 2, 0])
    const texts = res.turns.map((t) => {
      const p = t.messages[0]!.content[0]!
      return p.type === 'text' ? p.text : ''
    })
    for (const id of [1, 2, 3, 4, 5, 6]) assert.equal(texts[id - 1], `[需要你处理的事]\n[10:00:0${id}] 任务 t${id} 完成了。\n\n[最近发生的事（只是背景，不需要回应）]\n[09:59:00] Steve 上线了。\n\n${STATE_DROPPED}`)
    for (const id of [7, 8]) assert.match(texts[id - 1]!, /\n\n\[当前状态\]\nAlu: online at \(10,64,-4\)\n/)
    // 动了什么交代清楚：没截短工具结果，拿掉了六段状态，历史从多少字符变成多少
    const size = (list: readonly Turn[]) => list.reduce((n, t) => n + JSON.stringify(t.messages).length, 0)
    assert.deepEqual(res.tidied, { results: 0, states: 6, charsBefore: size(turns), charsAfter: size(res.turns) })
    assert.ok(res.tidied!.charsAfter < res.tidied!.charsBefore * 0.6, JSON.stringify(res.tidied))
  })

  it('最近的一段有多长：从最新往回数到阈值的四分之一', async () => {
    // 一轮 370 来 token，二十轮七千四；阈值六千，四分之一是一千五：放得下四轮
    const turns = Array.from({ length: 20 }, (_, i) => stateTurn(i + 1))
    const res = await compactHistory('', turns, { threshold: 6000, llm: summarizer() })
    assert.equal(res.recentTurns, 4)
    const kept = res.turns.filter((t) => {
      const p = t.messages[0]!.content[0]!
      return p.type === 'text' && p.text.includes('[当前状态]')
    })
    assert.deepEqual(kept.map((t) => t.id), [17, 18, 19, 20])
  })

  it('第二步：收拾完还超过阈值的七成，把较早的轮换成一份交接记录，换完在阈值的一半上下；留下的轮完整，工具调用和结果成对', async () => {
    // 十二轮各 257 token，共 3090；阈值 2400。最近那段两轮；记录上限 1080 字符（阈值折合字符的 15%）；
    // 一半是 1200，去掉给记录留的 360，留得下三轮：换掉前九轮
    const turns = Array.from({ length: 12 }, (_, i) => turn(i + 1, 300))
    const llm = summarizer('<analysis>\n先过一遍：主人让平地。\n</analysis>\n<summary>\n## 主人交代的事和要求\n在 (0,0)-(9,9) 平地到 y=64。\n</summary>')
    const res = await compactHistory('旧记录：它叫 Alu。', turns, { threshold: 2400, llm })

    assert.deepEqual([res.action, res.removedTurns, res.recentTurns, res.calls], ['summarized', 9, 2, 1])
    // 存的只有 <summary> 里面的；草稿单独交回来，不进历史
    assert.equal(res.summary, '## 主人交代的事和要求\n在 (0,0)-(9,9) 平地到 y=64。')
    assert.deepEqual(res.analysis, ['先过一遍：主人让平地。'])
    assert.deepEqual(res.folded, { from: 1, to: 9, turns: 9 })
    // 留下的是最新的那些轮，一轮都没被拆开
    assert.deepEqual(res.turns, turns.slice(9))
    assertToolPairs(res.turns.flatMap((t) => t.messages))
    // 之前 3094 token（十二轮加那句旧记录），之后 789（三轮加新记录）：阈值的三分之一，不到一半
    assert.deepEqual([res.tokensBefore, res.tokensAfter, res.capChars], [3094, 789, 1080])
    // 写记录的那次调用：不带工具；输出至少要给三万 token；提示词里是这条线的上限；给它看的是已有的记录和被换掉的轮
    const req = llm.requests[0]!
    assert.deepEqual([req.tools, req.minOutputTokens], [[], 30_000])
    assert.match(req.system, /^你在替一个 Minecraft（GTNH 整合包）服务器里的 AI 玩家写“交接记录”。/)
    assert.match(req.system, /上限 1080 字，/)
    const text = shownTo(req)
    assert.match(text, /^【已有的交接记录】\n旧记录：它叫 Alu。\n\n【之后的经历】\n=== 第 1 轮 ===\n\[它看到的\] event of turn 1\n/)
    assert.match(text, /=== 第 9 轮 ===/)
    assert.equal(text.includes('=== 第 10 轮 ==='), false)
    assert.match(text, /\n\n先写 <analysis>，再在 <summary> 里写出合并后的完整交接记录。$/)
  })

  it('模型没按标签写：整段当交接记录存；只写了草稿标签的，草稿以外的当记录', async () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(i + 1, 300))
    const plain = await compactHistory('', turns, { threshold: 2400, llm: summarizer('主人让平地，做到一半。') })
    assert.deepEqual([plain.summary, plain.analysis], ['主人让平地，做到一半。', undefined])
    const half = await compactHistory('', turns, { threshold: 2400, llm: summarizer('<analysis>想了想</analysis>\n主人让平地，做到一半。') })
    assert.deepEqual([half.summary, half.analysis], ['主人让平地，做到一半。', ['想了想']])
  })

  it('写记录的那次调用停在了输出上限：半截的不当记录存，算没写成，历史原样留着', async () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(i + 1, 300))
    const cut: LlmClient = { generate: async () => wrote('<analysis>想了很久</analysis><summary>## 主人交代的事和要求\n在 (0,0)-(9', { stopReason: 'max_tokens' }) }
    const res = await compactHistory('旧记录', turns, { threshold: 2400, llm: cut })
    assert.deepEqual([res.action, res.summary, res.turns.length, res.calls], ['nothing', '旧记录', 12, 1])
    assert.match(res.error ?? '', /cut off by the output limit of the model \(max_tokens\)/)
  })

  it('给写记录的模型看的记录：它自己写的字、叫醒它的事全给；工具调用的参数留两千字符；工具结果是第一步之后的样子（两千字符加那句说明）', async () => {
    const long: Turn = {
      id: 1,
      startedAt: 1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `主人说：${'事'.repeat(5000)}。` }] },
        { role: 'assistant', content: [{ type: 'text', text: `我想：${'想'.repeat(3000)}。` }, { type: 'tool_call', id: 'c1', name: 'run_program', input: { code: 'x'.repeat(3000) } }] },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 'c1', content: 'r'.repeat(2500) }] },
        { role: 'assistant', content: [{ type: 'text', text: '做完了' }] },
      ],
    }
    const llm = summarizer()
    const res = await compactHistory('', [long, turn(2), turn(3)], { threshold: 1000, llm })
    assert.equal(res.action, 'summarized')
    const text = shownTo(llm.requests[0]!)
    assert.ok(text.includes(`[它看到的] 主人说：${'事'.repeat(5000)}。\n`))
    assert.ok(text.includes(`[它的想法] 我想：${'想'.repeat(3000)}。\n`))
    assert.ok(text.includes(`[它调用工具] run_program {"code":"${'x'.repeat(1991)}…（原来 3011 字符，这里是前 2000 个）\n`))
    assert.ok(text.includes(`[工具结果 run_program] ${'r'.repeat(2000)} …[older result shortened: it was 2500 chars, the first 2000 are kept; call the tool again if you need the rest]\n`))
  })

  it('要换掉的记录一次看不完：按顺序一段段折进去——每段一次调用，前一段写成的记录带进下一段，被换掉的每一轮都有人看过，一轮不丢', async () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(i + 1, 300))
    const llm = versions()
    // 一轮的记录四百六十多字符，一段最多 1500：一段装三轮。要换掉前九轮：三段
    const res = await compactHistory('旧记录：它叫 Alu。', turns, { threshold: 2400, llm, segmentChars: 1500 })
    assert.deepEqual([res.action, res.removedTurns, res.calls, llm.seen.length], ['summarized', 9, 3, 3])
    // 每一段写着一共几段、这是第几段；第一段带着原来的记录，之后每一段带着上一段写出来的
    llm.seen.forEach((text, n) => {
      assert.ok(text.includes(`【之后的经历（一共 3 段，这是第 ${n + 1} 段）】\n=== 第 ${n * 3 + 1} 轮 ===\n`), text.slice(0, 120))
      assert.ok(text.startsWith(n === 0 ? '【已有的交接记录】\n旧记录：它叫 Alu。\n\n' : `【已有的交接记录】\n第 ${n} 版\n\n`), text.slice(0, 60))
    })
    // 被换掉的每一轮正好出现在一段里；没被换的不在任何一段里
    for (const t of turns) {
      const seen = llm.seen.filter((text) => text.includes(`[它看到的] event of turn ${t.id}\n`)).length
      assert.equal(seen, t.id <= 9 ? 1 : 0, `turn ${t.id} was read ${seen} time(s)`)
    }
    assert.equal(res.summary, '第 3 版')
    assert.deepEqual(res.folded, { from: 1, to: 9, turns: 9 })
    assert.deepEqual(res.turns, turns.slice(9))
    // 一共给它看了多少字符，交代清楚
    assert.equal(res.inputChars, llm.seen.reduce((n, text) => n + text.length, 0))
  })

  it('一轮自己就比一段长（一轮里调了很多次工具）：拆到几段里，后面的写明是续；这一轮整个看完才算换掉', async () => {
    // 一轮 40 步，每步一次工具调用和一个结果
    const big: Turn = {
      id: 7,
      startedAt: 7000,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'event of the big turn' }] },
        ...Array.from({ length: 40 }, (_, n): Message[] => [
          { role: 'assistant', content: [{ type: 'tool_call', id: `c${n}`, name: 'inspect_block', input: { x: n, y: 64, z: 0 } }] },
          { role: 'user', content: [{ type: 'tool_result', toolCallId: `c${n}`, content: `block number ${n}.` }] },
        ]).flat(),
        { role: 'assistant', content: [{ type: 'text', text: 'done with the big turn' }] },
      ],
    }
    const turns = [big, turn(8), turn(9), turn(10)]
    const llm = versions()
    const res = await compactHistory('', turns, { threshold: 400, llm, segmentChars: 1200 })
    assert.equal(res.action, 'summarized')
    assert.ok(llm.seen.length >= 3, `${llm.seen.length} calls`)
    assert.ok(llm.seen[0]!.includes('】\n=== 第 7 轮 ===\n[它看到的] event of the big turn\n'))
    assert.ok(llm.seen[1]!.includes('】\n=== 第 7 轮（续）===\n'))
    // 四十个结果一个不少，各出现一次
    for (let n = 0; n < 40; n++) assert.equal(llm.seen.filter((text) => text.includes(`block number ${n}.`)).length, 1, `result ${n}`)
    assert.deepEqual(res.turns.map((t) => t.id), [9, 10])
  })

  it('接口说给写记录的模型看的这一段太长：一段减半再试，直到写成；每一轮还是都有人看过', async () => {
    // 一轮的记录两千一百多字符；要换掉前九轮，一共一万九千五
    const turns = Array.from({ length: 12 }, (_, i) => turn(i + 1, 2000))
    const seen: string[] = []
    let refused = 0
    // 这个模型一次看不了九千字符以上
    const small: LlmClient = {
      async generate(req) {
        const text = shownTo(req)
        if (text.length > 9000) {
          refused++
          throw new LlmError('context_length', 'prompt is too long', { status: 400 })
        }
        seen.push(text)
        return wrote(`第 ${seen.length} 版`)
      },
    }
    // 一段 64000：整个一段，被拒；减半到 32000 还是一段，被拒；16000 装七轮，被拒；8000 装三轮，成了——三段
    const res = await compactHistory('', turns, { threshold: 8000, llm: small, segmentChars: 64_000 })
    assert.deepEqual([res.action, res.removedTurns, res.error], ['summarized', 9, undefined])
    assert.deepEqual([refused, seen.length, res.calls], [3, 3, 6])
    for (const t of turns) assert.equal(seen.filter((text) => text.includes(`[它看到的] event of turn ${t.id}\n`)).length, t.id <= 9 ? 1 : 0, `turn ${t.id}`)
    assert.equal(res.summary, `第 ${seen.length} 版`)
  })

  it('这个模型收不了“输出至少三万 token”（接口回 bad_request）：去掉这个数、按它自己配置的上限再试一次', async () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(i + 1, 300))
    const asked: (number | undefined)[] = []
    const strict: LlmClient = {
      async generate(req) {
        asked.push(req.minOutputTokens)
        if (req.minOutputTokens !== undefined) throw new LlmError('bad_request', 'max_tokens: 30000 > 8192, which is the maximum allowed', { status: 400 })
        return wrote('写成了')
      },
    }
    const res = await compactHistory('', turns, { threshold: 2400, llm: strict })
    assert.deepEqual([res.action, res.summary, res.calls, asked], ['summarized', '写成了', 2, [30_000, undefined]])
  })

  it('折到一半有一段没写成：已经折进去的那几轮去掉、记录留着，没折的留到下次，不是整个作废', async () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(i + 1, 300))
    let calls = 0
    const flaky: LlmClient = {
      async generate() {
        calls++
        if (calls === 2) throw new Error('model is down')
        return wrote(`第 ${calls} 版`)
      },
    }
    // 三段，第二段没成：前三轮折进去了。剩下九轮不到两倍阈值，所以不丢
    const res = await compactHistory('', turns, { threshold: 2400, llm: flaky, segmentChars: 1500 })
    assert.deepEqual([res.action, res.removedTurns, res.summary, res.calls], ['summarized', 3, '第 1 版', 2])
    assert.deepEqual(res.folded, { from: 1, to: 3, turns: 3 })
    assert.match(res.error ?? '', /model is down/)
    assert.deepEqual(res.turns.map((t) => t.id), [4, 5, 6, 7, 8, 9, 10, 11, 12])
    assertToolPairs(res.turns.flatMap((t) => t.messages))
  })

  it('折到一半没写成、剩下的又超过两倍阈值：折进去的留在记录里，没折成的那几轮丢掉，记录里照实写明丢的是第几轮到第几轮', async () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(i + 1, 300))
    let calls = 0
    const flaky: LlmClient = {
      async generate() {
        calls++
        if (calls >= 2) throw new Error('model is down')
        return wrote('前三轮的记录')
      },
    }
    // 阈值 900：要换掉前十轮（留最近两轮），四段；第一段成了，之后没成，剩下九轮两千三百多 token
    const res = await compactHistory('', turns, { threshold: 900, llm: flaky, segmentChars: 1500 })
    assert.equal(res.action, 'dropped')
    assert.deepEqual([res.folded, res.discarded], [{ from: 1, to: 3, turns: 3 }, { from: 4, to: 10, turns: 7 }])
    assert.deepEqual(res.turns.map((t) => t.id), [11, 12])
    assert.equal(res.summary, '前三轮的记录\n（第 4 轮到第 10 轮共 7 轮因为太长被丢弃了，当时没能写成交接记录。原始记录还在活动日志里。）')
  })

  it('记录一段都没写成：没超太多就原样留着下次再试，超过两倍阈值才丢弃旧轮', async () => {
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
    assert.deepEqual(dropped.turns.map((t) => t.id), [9, 10])
    assert.match(dropped.summary, /^（第 1 轮到第 8 轮共 8 轮因为太长被丢弃了/)
    assertToolPairs(dropped.turns.flatMap((t) => t.messages))
  })

  it('该换的那部分太少（不到阈值的一成）：先攒着，不为它写一次记录', async () => {
    // 最近两轮各三千多 token，更早的只有一轮 190 token；阈值六千
    const turns = [turn(1, 100), turn(2, 9000), turn(3, 9000)]
    const llm = summarizer()
    const res = await compactHistory('', turns, { threshold: 6000, llm })
    assert.deepEqual([res.action, llm.requests.length, res.turns.length], ['nothing', 0, 3])
  })

  it('阈值比的是真实的上下文：有最近一次调用接口报的输入 token 时，按它折算（连提示词和工具清单）；报的数离谱就当没报', async () => {
    // 十二轮按“字符 ÷ 3”是 3090。最近那次调用：提示词加工具清单估 1410，整份请求估 4500，接口报的是 9000（估算的两倍）
    const turns = Array.from({ length: 12 }, (_, i) => turn(i + 1, 300))
    const llm = summarizer('记录')
    const res = await compactHistory('', turns, { threshold: 8000, llm, gauge: { inputTokens: 9000, requestEstimate: 4500, overheadEstimate: 1410 } })
    // 9000 超过了 8000：压。最近那段是两千 token，折回估算是一千，三轮；提示词和工具清单就占了两千八，所以更早的九轮全换掉
    assert.deepEqual([res.tokensBefore, res.action, res.recentTurns, res.removedTurns], [9000, 'summarized', 3, 9])
    // 之后：提示词和工具清单 1410、留下的三轮 777、新记录 1，折成真实的乘二
    assert.equal(res.tokensAfter, 4376)
    // 只按字符估的话 3090，没到 8000
    const plain = await compactHistory('', turns, { threshold: 8000, llm })
    assert.deepEqual([plain.tokensBefore, plain.action], [3090, 'nothing'])
    // 接口报了个离谱的数（有的中转不报、乱报）：不信它
    const odd = await compactHistory('', turns, { threshold: 8000, llm, gauge: { inputTokens: 100, requestEstimate: 4500, overheadEstimate: 1410 } })
    assert.deepEqual([odd.tokensBefore, odd.action], [3090, 'nothing'])
  })

  it('“现在就压”（不看阈值）：最近那一段以外的全部换成交接记录', async () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(i + 1, 300))
    const llm = summarizer('记录')
    // 3090 没到阈值 4000，平时不动
    assert.equal((await compactHistory('', turns, { threshold: 4000, llm })).action, 'nothing')
    // 最近那段是阈值的四分之一（一千）：三轮。其余九轮换掉
    const res = await compactHistory('', turns, { threshold: 4000, llm, mode: 'all' })
    assert.deepEqual([res.action, res.removedTurns, res.recentTurns, res.turns.map((t) => t.id)], ['summarized', 9, 3, [10, 11, 12]])
  })

  it('模型说上下文太长时（不看阈值）：留最近那一段，更早的换成记录；记录写不成就把那些轮丢掉、照实留一句', async () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(i + 1, 300))
    // 阈值定得比模型装得下的还高：按现在的大小（3090）算，最近那段是它的四分之一，放得下两轮
    const res = await compactHistory('', turns, { threshold: 1_000_000, llm: summarizer('记录'), mode: 'overflow' })
    assert.deepEqual([res.action, res.removedTurns, res.turns.map((t) => t.id)], ['summarized', 10, [11, 12]])
    const failing: LlmClient = { generate: async () => Promise.reject(new Error('model is down')) }
    const lost = await compactHistory('', turns, { threshold: 1_000_000, llm: failing, mode: 'overflow' })
    assert.deepEqual([lost.action, lost.discarded, lost.turns.map((t) => t.id)], ['dropped', { from: 1, to: 10, turns: 10 }, [11, 12]])
    assert.equal(lost.summary, '（第 1 轮到第 10 轮共 10 轮因为太长被丢弃了，当时没能写成交接记录。原始记录还在活动日志里。）')
    // 历史里只有最近那一段：把它里面的也收拾一下（最新的一轮先不动）
    const two = await compactHistory('', [stateTurn(1), stateTurn(2)], { threshold: 1_000_000, llm: failing, mode: 'overflow' })
    assert.deepEqual([two.action, two.tidied?.states, two.turns.length], ['truncated', 1, 2])
    const first = two.turns[1]!.messages[0]!.content[0]!
    assert.ok(first.type === 'text' && first.text.includes('[当前状态]'))
  })

  it('切点只落在轮的边界上，至少留下最新的一轮', () => {
    const turns = [turn(1, 3000), turn(2, 3000), turn(3, 3000)]
    assert.equal(chooseCut(turns, 0), 2)
    assert.equal(chooseCut(turns, 1_000_000), 0)
    assert.equal(chooseCut([turn(1, 50_000)], 10), 0)
  })

  it('截断旧结果不影响调用和结果的对应关系', () => {
    const { turns, changed } = truncateOldToolResults([turn(1, 5000), turn(2, 5000), turn(3, 5000)], 1, 200)
    assert.equal(changed, true)
    assertToolPairs(turns.flatMap((t) => t.messages))
    const ids = turns.flatMap((t) => t.messages).flatMap((m) => (m.role === 'user' ? m.content.filter((p) => p.type === 'tool_result').map((p) => p.toolCallId) : []))
    assert.deepEqual(ids, ['a1', 'b1', 'a2', 'b2', 'a3', 'b3'])
  })
})

/** 历史最前面那条消息开头的那句话（range：第几轮到第几轮，共多少轮）。 */
function headLine(which: string): string {
  return `[更早经历的交接记录：${which}的经过换成了下面这一份，那些轮的原文不在你的对话历史里了。当时查到、看到的东西，这一份里没写的就不在这里；原始记录还在活动日志里（按天存，留最近 14 天有记录的），read_log 能按第几轮、按时间、按词翻回去。你记的笔记和手册不在这一份里，它们一直都在。]`
}

/** 活动日志里干活线关于压缩的那几条（数字换成 N，好对着看）。 */
function compactionLog(h: ReturnType<typeof makeAgent>): string[] {
  return h.log
    .recent(0, 500)
    .filter((e) => e.agent === 'work' && (e.kind === 'info' || e.kind === 'error') && /历史|交接记录|上下文/.test(e.text))
    .map((e) => e.text.replace(/\d+ (字符|token)/g, 'N $1'))
}

describe('agent 跑久了以后的历史', () => {
  it('上下文超过阈值：较早的轮换成一份交接记录，最近两轮原样留着；之后发给模型的消息以这份记录开头，开头那句把事实写全；日志里交代了每一步', async (t) => {
    const h = makeAgent({ settings: { historyTokenThreshold: 6000 } })
    t.after(h.cleanup)
    // 每一轮：扫一次地形（结果八百来 token）再结束。写记录的调用（不带工具）按标签回草稿和正文。
    h.game.handlers['world.scan'] = (p) => ({ x1: p.x1, z1: p.z1, x2: p.x2, z2: p.z2, heights: Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 64)) })
    const written: GenerateRequest[] = []
    const respond = (req: GenerateRequest) => {
      if (req.tools.length === 0) {
        written.push(req)
        return reply('<analysis>\n主人让平地，扫过八次地形。\n</analysis>\n<summary>\n## 主人交代的事和要求\n[10:00:00] Steve：把 0,0 到 19,19 平到 64\n</summary>')
      }
      const last = req.messages[req.messages.length - 1]!
      const afterTool = last.role === 'user' && last.content.some((p) => p.type === 'tool_result')
      return afterTool ? reply('') : reply('', [{ name: 'scan_area', input: { x1: 0, z1: 0, x2: 19, z2: 19 } }])
    }
    h.llm.enqueue(...Array.from({ length: 60 }, () => respond))
    for (let i = 1; i <= 7; i++) {
      h.agent.handleEvent(i === 1 ? told('把 0,0 到 19,19 平到 64') : taskEnded(`t${i}`, 'done'))
      await h.agent.whenIdle()
    }
    // 七轮五千六百多 token，还没到 6000：一次都没压
    assert.deepEqual([written.length, h.history.get().turns.length], [0, 7])
    const ids = h.history.get().turns.map((turn) => turn.id)
    h.agent.handleEvent(taskEnded('t8', 'done'))
    await h.agent.whenIdle()

    // 第八轮结束时过了线：前六轮换成记录，最近两轮留着
    const state = h.history.get()
    assert.equal(written.length, 1)
    assert.equal(state.summary, '## 主人交代的事和要求\n[10:00:00] Steve：把 0,0 到 19,19 平到 64')
    assert.equal(state.turns.length, 2)
    assert.deepEqual(state.summaryOf, { from: ids[0], to: ids[5], turns: 6 })
    // 给写记录的模型看的：前六轮的经过，其中旧轮的状态快照已经拿掉了
    const shown = shownTo(written[0]!)
    assert.ok(shown.startsWith(`【之后的经历】\n=== 第 ${ids[0]} 轮 ===\n[它看到的] [需要你处理的事]\n`))
    assert.equal(shown.includes('[当前状态]'), false)
    // 那句“状态快照已经拿掉了”是留给它自己看的，不给写记录的模型看
    assert.equal(shown.includes('状态快照已经从历史里拿掉了'), false)
    assert.match(shown, new RegExp(`\\n=== 第 ${ids[1]} 轮 ===\\n\\[它看到的\\] \\[需要你处理的事\\]\\n\\[[\\d:]+\\] 任务 t2（flatten）完成了。\\n\\[它调用工具\\] scan_area `))
    assert.match(written[0]!.system, /上限 2700 字，/)
    // 活动日志：先说为什么动、收拾了什么（历史从多少变成多少），再说换了哪几轮、记录多长、调了几次模型、上下文前后多大；草稿另记一条
    const log = h.log.recent(0, 500).filter((e) => e.agent === 'work' && e.kind === 'info' && /历史|交接记录/.test(e.text))
    assert.deepEqual(
      log.map((e) => e.text.replace(/\d+ (字符|token)/g, 'N $1')),
      [
        '历史超过了阈值（上下文约 N token），先收拾最近 2 轮以外的：拿掉了 6 段旧的状态快照（每轮开头那段“当前状态”）。历史从 N 字符变成 N 字符。',
        `收拾完还是太长，把较早的 6 轮（第 ${ids[0]} 轮到第 ${ids[5]} 轮）换成了交接记录（N 字符，上限 2700），写它调了 1 次模型、给它看了 N 字符。上下文从约 N token 变成约 N token。`,
        '写交接记录前它打的草稿（不存进历史）。',
      ],
    )
    assert.deepEqual([log[1]!.detail, log[2]!.detail], [state.summary, '主人让平地，扫过八次地形。'])

    // 再来一轮，看实际发给模型的消息
    h.agent.handleEvent(taskEnded('t99', 'done'))
    await h.agent.whenIdle()
    const sent = h.llm.requests.filter((r) => r.tools.length > 0).at(-1)!.messages
    const head = sent[0]!.content[0]!
    assert.equal(head.type === 'text' ? head.text : '', `${headLine(`第 ${ids[0]} 轮到第 ${ids[5]} 轮（共 6 轮）`)}\n${state.summary}`)
    assertToolPairs(sent)
  })

  it('旧轮里的状态快照拿掉就够了的时候：不调模型写记录；日志里记一条拿掉了多少；模型下一轮看到的旧轮里是那句说明，最近的状态还在', async (t) => {
    // 一轮（一句话就结束的）连状态 160 多 token，其中状态占大半：1300 的阈值到第 8 轮超，拿掉前六轮的状态就回到阈值的七成以下
    const h = makeAgent({ settings: { historyTokenThreshold: 1300 } })
    t.after(h.cleanup)
    let summaries = 0
    for (let i = 1; i <= 10; i++) {
      h.llm.enqueue((req) => {
        if (req.tools.length === 0) summaries++
        return reply(`做完第 ${i} 件`)
      })
      h.agent.handleEvent(i === 1 ? told('开始干活') : taskEnded(`t${i}`, 'done'))
      await h.agent.whenIdle()
    }
    assert.equal(summaries, 0)
    assert.equal(h.history.get().summary, '')
    assert.equal(h.history.get().turns.length, 10)
    // 第 8 轮结束时超了阈值：当时最近两轮以外的是前六轮
    assert.deepEqual(compactionLog(h), ['历史超过了阈值（上下文约 N token），先收拾最近 2 轮以外的：拿掉了 6 段旧的状态快照（每轮开头那段“当前状态”）。历史从 N 字符变成 N 字符。'])
    // 再来一轮，看发给模型的：前六轮开头是“任务完成了”加那句说明，没有当时的背包和位置；之后的几轮和这一轮带着状态
    h.llm.enqueue(reply('好'))
    h.agent.handleEvent(taskEnded('t99', 'done'))
    await h.agent.whenIdle()
    const openings = h.llm.requests.at(-1)!.messages.filter((m) => m.role === 'user' && m.content[0]!.type === 'text' && m.content[0]!.text.startsWith('[需要你处理的事]')).map((m) => (m.content[0]!.type === 'text' ? m.content[0]!.text : ''))
    assert.equal(openings.length, 11)
    assert.match(openings[1]!, new RegExp(`^\\[需要你处理的事\\]\\n\\[[\\d:]+\\] 任务 t2（flatten）完成了。\\n\\n${STATE_DROPPED.replace(/[[\]]/g, '\\$&')}$`))
    assert.equal(openings.slice(0, 6).filter((text) => text.includes('[当前状态]')).length, 0)
    assert.equal(openings.slice(6).filter((text) => /\n\n\[当前状态\]\nAlu: online /.test(text)).length, 5)
  })

  it('攒了很多轮才压（阈值调小了）：一次看不完就分几次写，日志里写清换了哪几轮、调了几次；每一轮都进了某一次', async (t) => {
    const h = makeAgent({ settings: { historyTokenThreshold: 1_000_000_000 } })
    t.after(h.cleanup)
    const seen: string[] = []
    // 每一轮留一段一万五千字的话
    const respond = (i: number) => (req: GenerateRequest) => {
      if (req.tools.length > 0) return reply(`第 ${i} 轮做完了。${'话'.repeat(15_000)}`)
      seen.push(shownTo(req))
      return reply(`第 ${seen.length} 版`)
    }
    for (let i = 1; i <= 18; i++) {
      h.llm.enqueue(respond(i))
      h.agent.handleEvent(i === 1 ? told('开始') : taskEnded(`t${i}`, 'done'))
      await h.agent.whenIdle()
    }
    assert.equal(seen.length, 0)
    const ids = h.history.get().turns.map((turn) => turn.id)
    assert.equal(ids.length, 18)
    // 主人把阈值调小：下一轮结束时要换掉十七轮（留最近两轮），记录有二十六万多字符，一次只看二十四万
    h.settings.historyTokenThreshold = 20_000
    h.llm.enqueue(respond(19), respond(19), respond(19))
    h.agent.handleEvent(taskEnded('t19', 'done'))
    await h.agent.whenIdle()
    assert.equal(seen.length, 2)
    assert.ok(seen[0]!.startsWith(`【之后的经历（一共 2 段，这是第 1 段）】\n=== 第 ${ids[0]} 轮 ===\n`))
    assert.ok(seen[1]!.startsWith('【已有的交接记录】\n第 1 版\n\n【之后的经历（一共 2 段，这是第 2 段）】\n=== 第 '))
    assert.ok(seen[0]!.length <= 240_100 && seen[0]!.length > 200_000, `first segment ${seen[0]!.length} chars`)
    const state = h.history.get()
    assert.equal(state.summary, '第 2 版')
    // 换掉的每一轮正好在一段里，留下的两轮不在
    assert.equal(state.turns.length, 2)
    for (let i = 1; i <= 19; i++) {
      const times = seen.filter((text) => text.includes(`第 ${i} 轮做完了。`)).length
      assert.equal(times, i >= 18 ? 0 : 1, `my turn ${i}`)
    }
    assert.deepEqual(state.summaryOf, { from: ids[0], to: ids[16], turns: 17 })
    assert.deepEqual(compactionLog(h), [
      '历史超过了阈值（上下文约 N token），先收拾最近 2 轮以外的：拿掉了 17 段旧的状态快照（每轮开头那段“当前状态”）。历史从 N 字符变成 N 字符。',
      `收拾完还是太长，把较早的 17 轮（第 ${ids[0]} 轮到第 ${ids[16]} 轮）换成了交接记录（N 字符，上限 9000），写它调了 2 次模型、给它看了 N 字符。上下文从约 N token 变成约 N token。`,
    ])
  })

  it('和阈值比的是接口报的真实大小：提示词和工具清单也算在里面，字符估算少算的也补上', async (t) => {
    // 这个模型的 token 比“字符 ÷ 3”的估算多一半（两个字符一个 token），每次如实报整份请求的输入 token
    const real = (req: GenerateRequest): number => Math.round((req.system.length + JSON.stringify(req.tools).length + JSON.stringify(req.messages).length) / 2)
    const h = makeAgent({ settings: { historyTokenThreshold: 60_000 } })
    t.after(h.cleanup)
    let summaries = 0
    const respond = (i: number) => (req: GenerateRequest) => {
      if (req.tools.length === 0) {
        summaries++
        return reply('记录')
      }
      return reply(`第 ${i} 轮。${'话'.repeat(6000)}`, [], { usage: { inputTokens: real(req), outputTokens: 3000 } })
    }
    // 还没调过模型：只有历史的字符估算（空的）
    assert.equal(h.agent.contextTokens('work'), 0)
    h.llm.enqueue(respond(1))
    h.agent.handleEvent(told('开始'))
    await h.agent.whenIdle()
    // 调过一次以后：光提示词和工具清单就两万五千多 token，历史本身按字符估才两千多
    const one = h.history.get()
    assert.ok(historyTokens(one.summary, one.turns) < 2500)
    assert.ok(h.agent.contextTokens('work') > 25_000 && h.agent.contextTokens('work') < 32_000, `context ${h.agent.contextTokens('work')}`)
    for (let i = 2; i <= 12; i++) {
      h.llm.enqueue(respond(i), respond(i))
      h.agent.handleEvent(taskEnded(`t${i}`, 'done'))
      await h.agent.whenIdle()
      if (summaries > 0) break
    }
    // 压的时候，历史按字符估还不到阈值的一半（只看它的话不会压）；按接口报的算已经过了六万
    assert.equal(summaries, 1)
    const line = h.log.recent(0, 500).find((e) => e.agent === 'work' && e.text.startsWith('历史超过了阈值'))!
    const reported = Number(/上下文约 (\d+) token/.exec(line.text)![1])
    assert.ok(reported > 60_000 && reported < 66_000, line.text)
    const state = h.history.get()
    assert.ok(state.summary === '记录' && state.turns.length >= 2 && state.turns.length < 8, `${state.turns.length} turns left`)
  })

  it('老数据：历史里有一段摘要、却没记着是哪几轮压成的——照常读；开头照实说“没有记下是哪几轮”；之后再压，范围从这次起记', async (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    // 加这项记录之前留下的 history.json：一段摘要，两轮
    const old: Turn[] = [41, 42].map((id) => ({ id, startedAt: id, messages: [{ role: 'user', content: [{ type: 'text', text: `[需要你处理的事]\n老的第 ${id} 轮` }] }, { role: 'assistant', content: [{ type: 'text', text: `老的回答 ${id}` }] }] }))
    fs.writeFileSync(path.join(tmp.dir, 'history.json'), JSON.stringify({ summary: '很久以前：主人让我守着基地。', turns: old, nextTurnId: 43 }))
    const h = makeAgent({ dir: tmp.dir, settings: { historyTokenThreshold: 1_000_000 } })
    t.after(h.cleanup)
    h.llm.enqueue(reply('在'))
    h.agent.handleEvent(told('还在吗'))
    await h.agent.whenIdle()
    const head = h.llm.requests[0]!.messages[0]!.content[0]!
    assert.equal(head.type === 'text' ? head.text : '', `${headLine('较早的若干轮（是哪几轮当时没有记下）')}\n很久以前：主人让我守着基地。`)
    // 现在阈值小了，再压一次：新换掉的那两轮记下来，更早的照实说没记
    h.settings.historyTokenThreshold = 60
    h.llm.enqueue(reply('好'), (req) => (req.tools.length === 0 ? reply('新记录') : reply('不该到这里')))
    h.agent.handleEvent(told('接着干'))
    await h.agent.whenIdle()
    const state = h.history.get()
    assert.equal(state.summary, '新记录')
    assert.deepEqual(state.summaryOf, { from: 41, to: 42, turns: 2, unknownBefore: true })
    h.settings.historyTokenThreshold = 1_000_000
    h.llm.enqueue(reply('嗯'))
    h.agent.handleEvent(told('再说一句'))
    await h.agent.whenIdle()
    const later = h.llm.requests.at(-1)!.messages[0]!.content[0]!
    assert.equal(later.type === 'text' ? later.text.split('\n')[0] : '', headLine('更早的若干轮（是哪几轮当时没有记下），加上第 41 轮到第 42 轮（共 2 轮）'))
  })

  it('模型说上下文超长时，先压历史再重试同一轮：最近那一段留着，更早的换成交接记录', async (t) => {
    // 阈值很高，平时不压
    const h = makeAgent({ settings: { historyTokenThreshold: 1_000_000 } })
    t.after(h.cleanup)
    for (let i = 1; i <= 8; i++) {
      h.llm.enqueue(reply(`第 ${i} 轮做完了`))
      h.agent.handleEvent(told(`Alu 做第 ${i} 件`))
      await h.agent.whenIdle()
    }
    const ids = h.history.get().turns.map((turn) => turn.id)
    assert.equal(ids.length, 8)

    h.llm.enqueue(
      new LlmError('context_length', 'prompt is too long', { status: 400 }),
      (req) => (req.tools.length === 0 ? reply('压出来的记录') : reply('不该先到这里')),
      reply('', [{ name: 'get_status' }]),
      reply('好的'),
    )
    h.agent.handleEvent(told('Alu 做第 9 件'))
    await h.agent.whenIdle()

    assert.deepEqual(sentToTalk(h).at(-1), '好的')
    assert.equal(h.agent.status().outage, undefined)
    // 八轮里最近的两轮（现在大小的四分之一放得下的）留着，前六轮换成了记录；这一轮自己照常记进历史
    const state = h.history.get()
    assert.equal(state.summary, '压出来的记录')
    assert.deepEqual(state.turns.map((turn) => turn.id).slice(0, 2), [ids[6], ids[7]])
    assert.deepEqual(state.summaryOf, { from: ids[0], to: ids[5], turns: 6 })
    // 重试的那次请求：旧的轮已经换成了记录，最近两轮和这一轮的事还在
    const retried = JSON.stringify(h.llm.requests.filter((r) => r.tools.length > 0).at(-2)!.messages)
    assert.ok(retried.includes('压出来的记录'))
    assert.equal(retried.includes('Alu 做第 6 件'), false)
    assert.ok(retried.includes('Alu 做第 7 件') && retried.includes('Alu 做第 8 件') && retried.includes('Alu 做第 9 件'))
    assert.deepEqual(compactionLog(h).slice(0, 3), [
      '模型说上下文太长，先压缩历史再试一次。',
      '模型说上下文太长，先收拾最近 2 轮以外的：拿掉了 6 段旧的状态快照（每轮开头那段“当前状态”）。历史从 N 字符变成 N 字符。',
      `收拾完还是太长，把较早的 6 轮（第 ${ids[0]} 轮到第 ${ids[5]} 轮）换成了交接记录（N 字符，上限 20000），写它调了 1 次模型、给它看了 N 字符。上下文从约 N token 变成约 N token。`,
    ])
  })

  it('模型说上下文超长、历史里又什么都收拾不出来：把历史里的轮丢掉，记录里和日志里都照实写明丢的是第几轮到第几轮', async (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    // 历史里只有两轮（都在“最近那一段”里），开头没有状态快照可拿，工具结果也不长
    const old: Turn[] = [5, 6].map((id) => ({ id, startedAt: id, messages: [{ role: 'user', content: [{ type: 'text', text: `[需要你处理的事]\n第 ${id} 件` }] }, { role: 'assistant', content: [{ type: 'text', text: `回答 ${id}` }] }] }))
    fs.writeFileSync(path.join(tmp.dir, 'history.json'), JSON.stringify({ summary: '', turns: old, nextTurnId: 7 }))
    const h = makeAgent({ dir: tmp.dir })
    t.after(h.cleanup)
    h.llm.enqueue(new LlmError('context_length', 'prompt is too long', { status: 400 }), reply('好的'))
    h.agent.handleEvent(told('Alu 在吗'))
    await h.agent.whenIdle()
    assert.deepEqual(sentToTalk(h).at(-1), '好的')
    const state = h.history.get()
    assert.equal(state.summary, '（第 5 轮到第 6 轮共 2 轮因为上下文超长被丢弃了，没能写成交接记录。原始记录还在活动日志里。）')
    assert.equal(state.turns.length, 1)
    assert.ok(h.log.recent(0, 100).some((e) => e.kind === 'error' && e.text === '模型说上下文超长，历史里的 2 轮（第 5 轮到第 6 轮）没法再压，从历史里直接丢掉了（活动日志里还有）。'))
  })

  it('面板上“现在就压”：先试一次（只写不存）看它会写成什么，历史不动；再真压，历史换掉；这条线正在跑一轮时不真压、如实说，试写不受影响', async (t) => {
    const h = makeAgent({ settings: { historyTokenThreshold: 4000 } })
    t.after(h.cleanup)
    for (let i = 1; i <= 8; i++) {
      h.llm.enqueue(reply(`第 ${i} 轮做完了。${'话'.repeat(600)}`))
      h.agent.handleEvent(told(`Alu 做第 ${i} 件`))
      await h.agent.whenIdle()
    }
    const before = structuredClone(h.history.get())
    const ids = before.turns.map((turn) => turn.id)
    assert.deepEqual([before.turns.length, before.summary], [8, ''])

    // 试写：最近那段是阈值的四分之一（一千 token，两轮），其余六轮写成记录——历史一个字没动
    h.llm.enqueue(reply('<analysis>草稿</analysis><summary>## 现在在做的事\n（无）</summary>', [], { usage: { inputTokens: 5000, outputTokens: 300 } }))
    const tried = await h.agent.compactNow('work', { dryRun: true })
    assert.ok(tried.ok)
    assert.deepEqual(
      [tried.applied, tried.action, tried.summary, tried.analysis, tried.turns, tried.kept, tried.calls, tried.usage, tried.summaryChars, tried.capChars],
      [false, 'summarized', '## 现在在做的事\n（无）', '草稿', { from: ids[0], to: ids[5], count: 6 }, 2, 1, { inputTokens: 5000, outputTokens: 300 }, 13, 1800],
    )
    assert.equal(tried.inputChars, shownTo(h.llm.requests.at(-1)!).length)
    assert.deepEqual(h.history.get(), before)

    // 这条线正在跑一轮：真压不做，如实说；试写照样能做
    let release: (r: GenerateResult) => void = () => {}
    h.llm.enqueue(() => new Promise<GenerateResult>((resolve) => (release = resolve)))
    h.agent.handleEvent(told('Alu 做第 9 件'))
    await waitFor('the worker to be in a turn', () => h.agent.statusOf('work').busy)
    assert.deepEqual(await h.agent.compactNow('work', {}), { ok: false, reason: 'busy', message: '干活线正在跑一轮，等它停下来再压（或者带 dryRun 只试不存）' })
    h.llm.enqueue(reply('试写的'))
    const meanwhile = await h.agent.compactNow('work', { dryRun: true })
    assert.ok(meanwhile.ok && meanwhile.summary === '试写的' && !meanwhile.applied)
    release(reply('第 9 轮做完了'))
    await h.agent.whenIdle()

    // 停下来以后真压（第九轮很短，最近那段现在放得下三轮）：前六轮换掉了，历史里记着是哪几轮
    h.llm.enqueue(reply('<summary>真压的记录</summary>'))
    const done = await h.agent.compactNow('work', {})
    assert.ok(done.ok && done.applied)
    const state = h.history.get()
    assert.deepEqual([state.summary, state.turns.length, state.summaryOf], ['真压的记录', 3, { from: ids[0], to: ids[5], turns: 6 }])
    assert.deepEqual(compactionLog(h).slice(-2), [
      '面板上要求现在就压，先收拾最近 3 轮以外的：拿掉了 6 段旧的状态快照（每轮开头那段“当前状态”）。历史从 N 字符变成 N 字符。',
      `收拾完，把较早的 6 轮（第 ${ids[0]} 轮到第 ${ids[5]} 轮）换成了交接记录（N 字符，上限 1800），写它调了 1 次模型、给它看了 N 字符。上下文从约 N token 变成约 N token。`,
    ])
    // 试写的那两次也各记了一条，写明历史没动
    assert.equal(compactionLog(h).filter((text) => text.startsWith('面板上试写了一次交接记录（历史没动）：')).length, 2)
  })
})
