// 交接记录在后台写（limits.backgroundCompaction，默认开）：一轮结束时过了阈值就拍一张快照在后台写，这条线照常接下一轮；
// 写回来以后在下一次调模型之前换进去——写回来的记录 + 快照里没换掉的轮 + 这期间新记进历史的轮。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { LlmError } from '../src/llm/index.ts'
import type { GenerateRequest, GenerateResult, Message } from '../src/llm/index.ts'
import { DEFAULT_LIMITS, normalizeConfig } from '../src/store/config.ts'
import type { HistoryStore } from '../src/store/history.ts'
import type { LineName } from '../src/tools/index.ts'
import { ScriptedLlm, assertToolPairs, chat, makeAgent, reply, sentToTalk, told } from './agent-harness.ts'
import type { AgentHarness } from './agent-harness.ts'
import { sleep, waitFor } from './helpers.ts'

/**
 * 一条线的假模型：一轮里的调用（带工具）照脚本回，脚本用完回一段 pad 个字的话（让历史一轮轮长起来）；
 * 写交接记录的调用（不带工具）交给 writer，测试自己定它什么时候回、回什么。
 */
class SplitLlm extends ScriptedLlm {
  readonly writes: GenerateRequest[] = []
  pad = 1500
  writer: (req: GenerateRequest, n: number) => Promise<GenerateResult> = async () => reply('<summary>记录</summary>')

  constructor() {
    super()
    this.auto = () => reply(`做完了。${'话'.repeat(this.pad)}`)
  }

  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (req.tools.length > 0) return super.generate(req)
    this.writes.push(req)
    return this.writer(req, this.writes.length)
  }
}

/** 拦着的写手：open 之前不回，open 时给了错误就抛它；请求被中止时像真的客户端一样抛 aborted。signals 是它收到的请求带的信号。 */
function held(text = '<summary>后台写的记录</summary>') {
  let open!: (failure?: Error) => void
  const opened = new Promise<Error | undefined>((resolve) => (open = resolve))
  const signals: AbortSignal[] = []
  const writer = (req: GenerateRequest): Promise<GenerateResult> =>
    new Promise((resolve, reject) => {
      if (req.signal) {
        signals.push(req.signal)
        req.signal.addEventListener('abort', () => reject(new LlmError('aborted', 'request aborted')), { once: true })
      }
      void opened.then((failure) => (failure ? reject(failure) : resolve(reply(text))))
    })
  return { writer, open, signals }
}

const NAME: Record<LineName, string> = { talk: '对话线', work: '干活线' }

/** 叫醒这条线的一件事：对话线是 Steve 说话，干活线是对话线交来的事。 */
function event(line: LineName, n: number) {
  return line === 'talk' ? chat('Steve', `Alu 第 ${n} 句`) : told(`做第 ${n} 件`)
}

function lineOf(h: AgentHarness, line: LineName): { llm: SplitLlm; history: HistoryStore; settings: AgentHarness['settings'] } {
  return line === 'talk' ? { llm: h.talk as SplitLlm, history: h.talkHistory, settings: h.talkSettings } : { llm: h.llm as SplitLlm, history: h.history, settings: h.settings }
}

type SplitHarness = AgentHarness & { llm: SplitLlm; talk: SplitLlm }

/** 两条线都用 SplitLlm、阈值先放得很高的一套。now：大脑的钟。 */
function harness(now?: () => number): SplitHarness {
  return makeAgent({ llm: new SplitLlm(), talk: new SplitLlm(), settings: { historyTokenThreshold: 1_000_000 }, ...(now ? { now } : {}) }) as SplitHarness
}

/**
 * 先在阈值很高时跑五轮，再把这条线的阈值定在“现在的上下文”上，然后第六轮：它结束时过了线，开始在后台写（写手拦着）。
 * 返回快照里各轮的编号、阈值和拦着的写手。
 */
async function startWriting(h: AgentHarness, line: LineName, pen = held()): Promise<{ snapshot: number[]; threshold: number; pen: ReturnType<typeof held> }> {
  const { llm, history, settings } = lineOf(h, line)
  for (let n = 1; n <= 5; n++) {
    h.agent.handleEvent(event(line, n))
    await h.agent.whenIdle()
  }
  settings.historyTokenThreshold = h.agent.contextTokens(line)
  llm.writer = pen.writer
  const writes = llm.writes.length
  h.agent.handleEvent(event(line, 6))
  await waitFor('the record is being written in the background', () => llm.writes.length === writes + 1 && !h.agent.statusOf(line).busy)
  return { snapshot: history.get().turns.map((t) => t.id), threshold: settings.historyTokenThreshold, pen }
}

/** 这条线又跑完一轮（后台还在写，不能用 whenIdle）。 */
async function oneTurn(h: AgentHarness, line: LineName, n: number): Promise<void> {
  const { history } = lineOf(h, line)
  const before = history.get().turns.length
  h.agent.handleEvent(event(line, n))
  await waitFor(`turn ${n} of the ${line} line to end`, () => history.get().turns.length === before + 1 && !h.agent.statusOf(line).busy)
}

/** 活动日志里这条线的 info、error 的正文。 */
function logOf(h: AgentHarness, line: LineName): string[] {
  return h.log
    .recent(0, 1000)
    .filter((e) => e.agent === line && (e.kind === 'info' || e.kind === 'error'))
    .map((e) => e.text)
}

/** 一条消息的全部文字。 */
function textOf(m: Message | undefined): string {
  return (m?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')
}

/** 一轮里的调用（带工具的那些）。 */
const turnCalls = (llm: SplitLlm): GenerateRequest[] => llm.requests.filter((r) => r.tools.length > 0)

describe('在后台写交接记录', () => {
  for (const line of ['work', 'talk'] as const) {
    it(`${NAME[line]}：过了阈值就在后台写，这期间这条线照常接下一轮；写回来以后换进去——记录 + 快照里没换掉的轮 + 这期间新的轮（原样、按顺序、不重不漏）`, async (t) => {
      const h = harness()
      t.after(h.cleanup)
      const { llm, history } = lineOf(h, line)
      const started = Date.now()
      const { snapshot, pen } = await startWriting(h, line)
      const upTo = snapshot[snapshot.length - 1]!

      // 写的是快照里较早的几轮，最近那一段不写；状态里看得到写的是哪几轮、快照到第几轮、什么时候开始的
      const writing = h.agent.state(line).compacting!
      assert.ok(writing, 'the state shows the record being written')
      assert.deepEqual([writing.from, writing.upTo], [snapshot[0], upTo])
      assert.ok(writing.to < upTo && writing.turns === snapshot.filter((id) => id <= writing.to).length, JSON.stringify(writing))
      assert.ok(writing.since >= started && writing.since <= Date.now())
      const begun = logOf(h, line).filter((text) => text.includes('开始在后台'))
      assert.equal(begun.length, 1)
      assert.match(begun[0]!, new RegExp(`^历史超过了阈值（上下文约 \\d+ token）：开始在后台把较早的 ${writing.turns} 轮（第 ${writing.from} 轮到第 ${writing.to} 轮）写成交接记录，这条线照常接着跑。写回来以后在下一次调模型之前换进去，第 ${upTo} 轮以后的轮原样接在后面。$`))

      // 写的这段时间里这条线接着跑了两轮（不再等它写完）；一条线同时只写一份
      llm.pad = 100
      await oneTurn(h, line, 7)
      await oneTurn(h, line, 8)
      assert.equal(llm.writes.length, 1)
      assert.ok(h.agent.state(line).compacting)
      assert.equal(h.agent.state(line).compacting!.waiting, undefined)
      // 这两轮看到的还是原来的历史：最前面没有交接记录
      for (const req of turnCalls(llm).slice(-2)) assert.equal(textOf(req.messages[0]).startsWith('[更早经历的交接记录'), false)
      const newer = history.get().turns.filter((turn) => turn.id > upTo)
      assert.equal(newer.length, 2)
      const newerBytes = JSON.stringify(newer)

      pen.open()
      await h.agent.whenIdle()
      const after = history.get()
      assert.equal(after.summary, '后台写的记录')
      assert.deepEqual(after.summaryOf, { from: writing.from, to: writing.to, turns: writing.turns })
      // 快照里没换掉的轮，接着这期间新的两轮：按顺序，不重不漏
      const kept = snapshot.filter((id) => id > writing.to)
      assert.deepEqual(after.turns.map((turn) => turn.id), [...kept, ...newer.map((turn) => turn.id)])
      // 新的两轮一个字节都没变
      assert.equal(JSON.stringify(after.turns.slice(-2)), newerBytes)
      assertToolPairs(after.turns.flatMap((turn) => turn.messages))
      assert.equal(h.agent.state(line).compacting, undefined)
      const swapped = logOf(h, line).filter((text) => text.startsWith('这份交接记录是在后台写的'))
      assert.equal(swapped.length, 1)
      assert.match(swapped[0]!, new RegExp(`^这份交接记录是在后台写的：从开始写到换进去 \\d+ 秒，这期间这条线照常跑了 2 轮；换进去时把这期间新记进历史的 2 轮（第 ${newer[0]!.id} 轮到第 ${newer[1]!.id} 轮）原样接在了后面。$`))

      // 下一轮发给模型的：最前面是这份记录，开头写明写到第几轮为止、后面的轮比它新
      h.agent.handleEvent(event(line, 9))
      await h.agent.whenIdle()
      const sent = turnCalls(llm).at(-1)!.messages
      assert.ok(
        textOf(sent[0]).startsWith(`[更早经历的交接记录：第 ${writing.from} 轮到第 ${writing.to} 轮（共 ${writing.turns} 轮）的经过换成了下面这一份，那些轮的原文不在你的对话历史里了。这一份写到第 ${writing.to} 轮结束时为止，后面接着的轮都比它新。`),
        textOf(sent[0]).slice(0, 200),
      )
      assert.ok(textOf(sent[0]).endsWith('\n后台写的记录'))
      assertToolPairs(sent)
    })
  }

  it('干活线一轮很长、写回来时它正跑到一半：从下一步起就用新的历史，这一轮自己的消息原样跟在后面，轮末照常记在最后', async (t) => {
    const h = harness()
    t.after(h.cleanup)
    const { snapshot, pen } = await startWriting(h, 'work')
    const upTo = snapshot[snapshot.length - 1]!
    const writing = h.agent.state('work').compacting!
    h.llm.pad = 100
    // 第一步时放写手回去，等它写回来，再要一个工具：第二步之前换进去
    h.llm.enqueue(async () => {
      pen.open()
      await waitFor('the record came back', () => h.agent.state('work').compacting === undefined)
      return reply('', [{ name: 'get_status' }])
    }, reply('看过了'))
    h.agent.handleEvent(told('看一眼状态'))
    await h.agent.whenIdle()
    const [first, second] = turnCalls(h.llm).slice(-2)
    assert.equal(textOf(first!.messages[0]).startsWith('[更早经历的交接记录'), false)
    assert.ok(textOf(second!.messages[0]).startsWith(`[更早经历的交接记录：第 ${writing.from} 轮到第 ${writing.to} 轮`))
    // 这一轮自己的：开头那条、它要的工具、工具结果
    assert.deepEqual(second!.messages.at(-3), first!.messages.at(-1))
    assert.ok(second!.messages.at(-2)!.content.some((p) => p.type === 'tool_call' && p.name === 'get_status'))
    assertToolPairs(second!.messages)
    // 历史：记录 + 没换掉的轮 + 这一轮（它是换进去以后才记的，在最后）
    const after = h.history.get()
    const thisTurn = after.turns.at(-1)!.id
    assert.ok(thisTurn > upTo)
    assert.deepEqual(after.turns.map((turn) => turn.id), [...snapshot.filter((id) => id > writing.to), thisTurn])
    assert.ok(
      logOf(h, 'work').some((text) => new RegExp(`^这份交接记录是在后台写的：从开始写到换进去 \\d+ 秒，这期间这条线照常跑了 1 轮（第 ${thisTurn} 轮正跑着，从它的下一步起用新的历史）；换进去时把这期间新记进历史的 0 轮原样接在了后面。$`).test(text)),
      logOf(h, 'work').join('\n'),
    )
  })

  it('写的这段时间里历史被别的路径整个换过（面板上清空了）：写回来的这份不用，历史照现在的样子，日志写明为什么；这期间面板上“现在就压”如实说后台在写', async (t) => {
    const h = harness()
    t.after(h.cleanup)
    const { pen } = await startWriting(h, 'work')
    // 一条线同时只写一份：面板上真压回 busy
    assert.deepEqual(await h.agent.compactNow('work', {}), { ok: false, reason: 'busy', message: '干活线后台正在写一份交接记录，等它回来再压（或者带 dryRun 只试不存）' })
    // 面板上清空历史（POST /api/history/clear 就是这么做的），之后又跑了一轮
    h.history.clear()
    h.llm.pad = 100
    await oneTurn(h, 'work', 7)
    const now = structuredClone(h.history.get())
    assert.equal(now.turns.length, 1)
    pen.open()
    await h.agent.whenIdle()
    assert.deepEqual(h.history.get(), now)
    assert.ok(logOf(h, 'work').some((text) => /^后台写的交接记录没有用：写的这 \d+ 秒里这条线的历史被别的路径整个换过（面板上清空了历史，或者别处压过一次），这一份是照换之前的历史写的。历史照现在的样子，没动。$/.test(text)))
    assert.equal(logOf(h, 'work').some((text) => text.startsWith('这份交接记录是在后台写的')), false)
  })

  it('后台那份还没回来、上下文又过了阈值的 1.5 倍：这条线等它回来再接下一轮，日志写明在等', async (t) => {
    const h = harness()
    t.after(h.cleanup)
    const { threshold, pen } = await startWriting(h, 'work')
    // 这一轮写了很长一段：一下子过了阈值的 1.5 倍
    h.llm.enqueue(reply(`很长。${'话'.repeat(Math.round(threshold * 1.4))}`))
    h.agent.handleEvent(told('做第 7 件'))
    await waitFor('the line waits for the record', () => logOf(h, 'work').some((text) => text.endsWith('这条线等它回来再接下一轮。')))
    const waiting = logOf(h, 'work').find((text) => text.endsWith('这条线等它回来再接下一轮。'))!
    assert.match(waiting, new RegExp(`^上下文约 \\d+ token，超过了阈值的 1\\.5 倍（${Math.round(threshold * 1.5)} token），后台那份交接记录还没写完：这条线等它回来再接下一轮。$`))
    assert.ok(Number(/上下文约 (\d+) token/.exec(waiting)![1]) > threshold * 1.5)
    // 状态里：没有在跑的一轮，但后台那份写着、这条线在等它
    assert.deepEqual([h.agent.state('work').turn, h.agent.state('work').compacting?.waiting], [null, true])
    // 这时它还占着这条线：又来的事排着，不开新的一轮
    const asked = turnCalls(h.llm).length
    h.agent.handleEvent(told('做第 8 件'))
    await sleep(100)
    assert.deepEqual([h.agent.statusOf('work').busy, h.agent.statusOf('work').pending, turnCalls(h.llm).length], [true, 1, asked])
    pen.open()
    await h.agent.whenIdle()
    // 写回来、换进去以后才接第 8 件
    assert.equal(h.history.get().summary, '后台写的记录')
    assert.ok(turnCalls(h.llm).length > asked)
    assert.ok(textOf(turnCalls(h.llm)[asked]!.messages[0]).startsWith('[更早经历的交接记录'))
    assert.ok(logOf(h, 'work').some((text) => text.startsWith('这份交接记录是在后台写的')))
  })

  it('后台没有在写的那份、上下文却一下子过了阈值的 1.5 倍：就地压，写完才接下一轮', async (t) => {
    const h = harness()
    t.after(h.cleanup)
    for (let n = 1; n <= 5; n++) {
      h.agent.handleEvent(told(`做第 ${n} 件`))
      await h.agent.whenIdle()
    }
    const threshold = h.agent.contextTokens('work')
    h.settings.historyTokenThreshold = threshold
    const pen = held('<summary>就地写的记录</summary>')
    h.llm.writer = pen.writer
    h.llm.enqueue(reply(`很长。${'话'.repeat(Math.round(threshold * 1.8))}`))
    h.agent.handleEvent(told('做第 6 件'))
    await waitFor('the record is being written', () => h.llm.writes.length === 1)
    assert.ok(logOf(h, 'work').some((text) => new RegExp(`^上下文约 \\d+ token，超过了阈值的 1\\.5 倍（${Math.round(threshold * 1.5)} token），后台没有在写的交接记录：就地压，写完再接下一轮。$`).test(text)))
    // 占着这条线：又来的事排着；状态里不是“后台在写”
    const asked = turnCalls(h.llm).length
    h.agent.handleEvent(told('做第 7 件'))
    await sleep(100)
    assert.deepEqual([h.agent.statusOf('work').busy, h.agent.statusOf('work').pending, turnCalls(h.llm).length, h.agent.state('work').compacting], [true, 1, asked, undefined])
    pen.open()
    await h.agent.whenIdle()
    assert.equal(h.history.get().summary, '就地写的记录')
    assert.ok(textOf(turnCalls(h.llm)[asked]!.messages[0]).startsWith('[更早经历的交接记录'))
  })

  it('后台没写成：历史一个字不动、一轮都不丢，日志写明几分钟以后再试；这之前的一轮结束时不再试，到点以后的一轮结束时再在后台写', async (t) => {
    let later = 0
    const h = harness(() => Date.now() + later)
    t.after(h.cleanup)
    const { pen } = await startWriting(h, 'work')
    const before = structuredClone(h.history.get())
    pen.open(new Error('model is down'))
    await h.agent.whenIdle()
    assert.deepEqual(h.history.get(), before)
    const failed = h.log.recent(0, 1000).filter((e) => e.agent === 'work' && e.kind === 'error' && e.text.startsWith('后台写的交接记录没写成'))
    assert.deepEqual(
      failed.map((e) => e.text.replace(/\d+ (字符|秒)/g, 'N $1')),
      ['后台写的交接记录没写成：model is down（写它调了 1 次模型、给它看了 N 字符、等了 N 秒）。历史没动，没有丢掉任何一轮；5 分钟以后再在后台试，在那之前上下文超过阈值的 1.5 倍就就地压。'],
    )
    // 四分钟以后的一轮结束时还超阈值，但还没到再试的时候：不写
    h.llm.pad = 100
    later = 4 * 60_000
    h.agent.handleEvent(told('做第 7 件'))
    await h.agent.whenIdle()
    assert.equal(h.llm.writes.length, 1)
    assert.equal(h.history.get().summary, '')
    // 过了五分钟：这一轮结束时再在后台写，这次写成了
    later = 5 * 60_000 + 1000
    h.llm.writer = async () => reply('<summary>第二次写成的记录</summary>')
    h.agent.handleEvent(told('做第 8 件'))
    await h.agent.whenIdle()
    assert.deepEqual([h.llm.writes.length, h.history.get().summary], [2, '第二次写成的记录'])
  })

  it('模型说上下文太长：后台在写的那份先停掉（它的请求被中止，结果不用），改成就地强制压，压完重试这一步', async (t) => {
    const h = harness()
    t.after(h.cleanup)
    const pen = held('<summary>后台那份（不该用上）</summary>')
    await startWriting(h, 'work', pen)
    h.llm.writer = async (req, n) => (n === 1 ? pen.writer(req) : reply('<summary>强制压出来的记录</summary>'))
    h.llm.enqueue(new LlmError('context_length', 'prompt is too long', { status: 400 }), reply('好的'))
    h.agent.handleEvent(told('做第 7 件'))
    await h.agent.whenIdle()
    assert.equal(pen.signals[0]!.aborted, true)
    assert.equal(h.llm.writes.length, 2)
    assert.equal(h.history.get().summary, '强制压出来的记录')
    assert.equal(sentToTalk(h).at(-1), '好的')
    const log = logOf(h, 'work')
    const at = log.indexOf('模型说上下文太长，先压缩历史再试一次。')
    assert.ok(at >= 0 && log[at + 1] === '后台正在写的那份交接记录停掉了：模型说上下文太长，改成就地压。', log.join('\n'))
    assert.equal(log.some((text) => text.startsWith('这份交接记录是在后台写的')), false)
    // 被中止的那次调用在日志里照实写
    assert.ok(h.log.recent(0, 1000).some((e) => e.kind === 'model_call' && e.call?.state === 'failed' && e.call.error === '后台写的这份交接记录停掉了（大脑在停，或者模型说上下文太长、改成了就地压）'))
    // 那份后台的自己收完尾，也不会再换进去
    await sleep(50)
    assert.equal(h.history.get().summary, '强制压出来的记录')
  })

  it('叫停干活线不影响后台那份：照写，回来照换', async (t) => {
    const h = harness()
    t.after(h.cleanup)
    const { pen } = await startWriting(h, 'work')
    await h.agent.stopWork('主人在面板上叫停', 'panel')
    assert.equal(pen.signals[0]!.aborted, false)
    assert.ok(h.agent.state('work').compacting)
    pen.open()
    await h.agent.whenIdle()
    assert.equal(h.history.get().summary, '后台写的记录')
  })

  it('大脑停下时后台那份停掉：不换进去，也不落盘', async (t) => {
    const h = harness()
    t.after(h.cleanup)
    const { pen } = await startWriting(h, 'work')
    const file = path.join(h.dir, 'history.json')
    const onDisk = fs.readFileSync(file, 'utf8')
    const inMemory = structuredClone(h.history.get())
    await h.agent.stop()
    assert.equal(pen.signals[0]!.aborted, true)
    await sleep(50)
    assert.deepEqual(h.history.get(), inMemory)
    assert.equal(fs.readFileSync(file, 'utf8'), onDisk)
  })

  it('开关（limits.backgroundCompaction）默认开着；配置里写 false 就关，写别的当没写', () => {
    assert.equal(DEFAULT_LIMITS.backgroundCompaction, true)
    assert.equal(normalizeConfig({}).bot.limits.backgroundCompaction, true)
    assert.equal(normalizeConfig({ bot: { limits: { backgroundCompaction: false } } }).bot.limits.backgroundCompaction, false)
    assert.equal(normalizeConfig({ bot: { limits: { backgroundCompaction: 'no' } } }).bot.limits.backgroundCompaction, true)
  })
})
