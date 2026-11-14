// 意见簿：模型觉得哪里有问题时用 report_problem 记一条；大脑附上当时的现场，存在数据目录里；主人在面板上看、标记、导出。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { BridgeError } from '../src/bridge/protocol.ts'
import { FEEDBACK_LIMITS, FeedbackStore } from '../src/store/feedback.ts'
import type { FeedbackContext, FeedbackInput } from '../src/store/feedback.ts'
import { chat, makeAgent, reply, taskEnded, sentToTalk, told } from './agent-harness.ts'
import { tmpDir } from './helpers.ts'

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000

const REPORT: FeedbackInput = {
  title: '没有能看箱子里附魔书是什么附魔的工具',
  category: 'missing_tool',
  goal: '主人让我把带“时运”的附魔书拿给他',
  problem: 'list_containers 只给出 minecraft:enchanted_book，看不出是哪种附魔',
  wish: '容器里的物品带上 NBT 摘要',
}
const CONTEXT: FeedbackContext = { bot: 'Alu', brainVersion: '0.1.0', modVersion: '0.3.1', turn: 7, instruction: '[12:00:00] Steve 说：Alu 把时运书给我', recentTools: [], tasks: [] }

function store(t: { after(fn: () => void): void }, opts: { secrets?: string[] } = {}) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  const clock = { now: NOW }
  const open = () => new FeedbackStore(tmp.dir, { now: () => clock.now, secrets: () => opts.secrets ?? [] })
  return { tmp, clock, open, book: open(), file: path.join(tmp.dir, 'feedback.jsonl') }
}

describe('意见簿：提交', () => {
  it('模型干活时记一条：它填的内容原样留下，大脑附上这一轮的指令原文、最近的工具调用和结果、相关任务和失败码、版本；然后它照常接着干', async (t) => {
    const s = store(t)
    const h = makeAgent({ feedback: s.book })
    t.after(h.cleanup)
    // 一个任务以 no_material 失败把它叫醒；它去查物品，结果工具出错；它记一条，然后照常告诉主人
    h.game.handlers['item.search'] = () => {
      throw new BridgeError('internal', 'NullPointerException in ItemSearch')
    }
    h.llm.enqueue(
      reply('', [{ name: 'find_item', input: { query: 'stone bricks' } }]),
      reply('', [{ name: 'report_problem', input: REPORT }]),
      reply('石砖不够，查物品的工具还报错了，先停一下'),
    )
    h.agent.handleEvent(told('接着把墙砌完', [chat('Steve', 'Alu 接着把墙砌完')]))
    h.agent.handleEvent(taskEnded('t9', 'failed', { error: { code: 'no_material', message: '15 blocks were left unplaced for want of material' } }))
    await h.agent.whenIdle()

    const [report] = s.book.list()
    assert.ok(report)
    assert.deepEqual(
      { title: report.title, category: report.category, goal: report.goal, problem: report.problem, wish: report.wish, count: report.count, status: report.status },
      { ...REPORT, count: 1, status: 'new' },
    )
    const c = report.context
    assert.deepEqual([c.bot, c.brainVersion, c.modVersion, typeof c.turn], ['Alu', 'brain-under-test', 'mod-under-test', 'number'])
    // 这一轮是被什么叫醒的：主人的原话和任务失败的原因都在
    assert.match(c.instruction, /Steve 说：Alu 接着把墙砌完/)
    assert.match(c.instruction, /任务 t9（flatten）失败了：no_material — 15 blocks were left unplaced for want of material/)
    assert.deepEqual(c.tasks, [{ id: 't9', type: 'flatten', state: 'failed', error: 'no_material' }])
    // 记这条之前的那次工具调用：调了什么、参数、结果、是不是出错
    assert.equal(c.recentTools.length, 1)
    assert.deepEqual([c.recentTools[0]!.tool, c.recentTools[0]!.input, c.recentTools[0]!.isError], ['find_item', '{"query":"stone bricks"}', true])
    assert.match(c.recentTools[0]!.result, /^internal: NullPointerException in ItemSearch/)

    // 模型得知记下了、没人会回复；它接着把该让人知道的事留给了对话线；主人在对话日志里看得到记了一条
    assert.match(h.llm.lastUserText(2), /^Noted as f1\. Nobody will answer it: carry on with what you were doing/)
    assert.deepEqual(sentToTalk(h), ['石砖不够，查物品的工具还报错了，先停一下'])
    assert.ok(h.log.recent(0, 100).some((e) => e.kind === 'info' && e.text === `它在意见簿里记了一条（f1）：${REPORT.title}`))
  })

  it('两条线的核心提示词里都告诉了它什么时候记；对话线也能记，附的是它那一轮的原话', async (t) => {
    const s = store(t)
    const h = makeAgent({ feedback: s.book })
    t.after(h.cleanup)
    h.talk.enqueue(reply('', [{ name: 'report_problem', input: REPORT }]), reply('记下了'))
    h.agent.handleEvent(chat('Steve', 'Alu 你查不到石砖吗'))
    h.agent.handleEvent(told('去仓库'))
    await h.agent.whenIdle()
    assert.match(h.llm.requests[0]!.system, /普通游戏困难不等于 Bug；处理后仍异常或回执与实际矛盾，再记 report_problem，写清证据与未确定之处。/)
    assert.match(h.talk.requests[0]!.system, /工具不够用、结果不对、手册和实际对不上：report_problem 记一条，留给维护的人看，没人回复。/)
    const [report] = s.book.list()
    assert.match(report!.context.instruction, /Steve 说：Alu 你查不到石砖吗/)
  })
})

describe('意见簿：同一个问题不刷屏', () => {
  it('类别和标题一样的，一天之内再提交只加次数；标题不同、隔了一天、或者原来那条已经处理了，才另记一条', async (t) => {
    const s = store(t)
    const first = s.book.submit(REPORT, CONTEXT)
    assert.deepEqual('full' in first ? null : [first.report.id, first.merged], ['f1', false])
    s.clock.now += 2 * HOUR
    // 标题的大小写、空白不一样也算同一个；模型这次写的别的内容不覆盖第一次的
    const again = s.book.submit({ ...REPORT, title: `  ${REPORT.title} `, problem: '又遇到了' }, { ...CONTEXT, turn: 9 })
    assert.deepEqual('full' in again ? null : [again.report.id, again.merged, again.report.count, again.report.problem], ['f1', true, 2, REPORT.problem])
    assert.deepEqual(s.book.list().map((r) => [r.id, r.count, r.time, r.lastTime]), [['f1', 2, NOW, NOW + 2 * HOUR]])

    const other = s.book.submit({ ...REPORT, title: '找不到去下界的路' }, CONTEXT)
    assert.deepEqual('full' in other ? null : [other.report.id, other.merged], ['f2', false])
    const otherCategory = s.book.submit({ ...REPORT, category: 'tool_problem' }, CONTEXT)
    assert.deepEqual('full' in otherCategory ? null : otherCategory.report.id, 'f3')

    // 离上一次超过一天：是一条新的
    s.clock.now += 25 * HOUR
    const nextDay = s.book.submit(REPORT, CONTEXT)
    assert.deepEqual('full' in nextDay ? null : [nextDay.report.id, nextDay.merged], ['f4', false])
    // 主人标成已处理之后又出现：也是新的一条（说明没修好）
    s.book.setStatus('f4', 'handled')
    s.clock.now += HOUR
    const afterFix = s.book.submit(REPORT, CONTEXT)
    assert.deepEqual('full' in afterFix ? null : [afterFix.report.id, afterFix.merged], ['f5', false])
    // 新的在前
    assert.deepEqual(s.book.list().map((r) => r.id), ['f5', 'f4', 'f2', 'f3', 'f1'])
  })

  it('一天里新记的条数有上限：再多的不记，并让模型知道', async (t) => {
    const s = store(t)
    for (let i = 0; i < FEEDBACK_LIMITS.perDay; i++) assert.equal('full' in s.book.submit({ ...REPORT, title: `问题 ${i}` }, CONTEXT), false)
    assert.deepEqual(s.book.submit({ ...REPORT, title: '又一个' }, CONTEXT), { full: true })
    // 已经记过的问题照样可以加次数
    assert.equal('full' in s.book.submit({ ...REPORT, title: '问题 3' }, CONTEXT), false)
    assert.equal(s.book.list().length, FEEDBACK_LIMITS.perDay)
    s.clock.now += 25 * HOUR
    assert.equal('full' in s.book.submit({ ...REPORT, title: '第二天的' }, CONTEXT), false)
  })
})

describe('意见簿：附带的现场', () => {
  it('太长的裁短并写明裁了多少：指令原文、工具的参数和结果各有上限，工具调用只留最近的几次', (t) => {
    const s = store(t)
    const calls = Array.from({ length: 10 }, (_, i) => ({ tool: `tool_${i}`, input: `{"n":${i},"pad":"${'p'.repeat(1000)}"}`, result: `result ${i} ${'r'.repeat(3000)}`, ...(i === 9 ? { isError: true } : {}) }))
    const res = s.book.submit({ ...REPORT, problem: 'x'.repeat(5000) }, { ...CONTEXT, instruction: `主人说：${'很长的话'.repeat(1000)}`, recentTools: calls, tasks: Array.from({ length: 30 }, (_, i) => ({ id: `t${i}` })) })
    assert.ok(!('full' in res))
    const { report } = res
    const cut = (text: string, max: number, original: number) => {
      assert.equal(text.slice(max), `…[${original - max} more characters]`)
      assert.equal(text.slice(0, 4), text.slice(0, 4).trim())
    }
    cut(report.problem, FEEDBACK_LIMITS.problem, 5000)
    cut(report.context.instruction, FEEDBACK_LIMITS.instruction, 4 + 4000)
    assert.ok(report.context.instruction.startsWith('主人说：很长的话'))
    // 离出问题最近的 6 次：第 4 到第 9 次
    assert.deepEqual(report.context.recentTools.map((c) => c.tool), ['tool_4', 'tool_5', 'tool_6', 'tool_7', 'tool_8', 'tool_9'])
    const last = report.context.recentTools.at(-1)!
    assert.equal(last.isError, true)
    assert.ok(last.input.startsWith('{"n":9,"pad":"ppp'))
    cut(last.input, FEEDBACK_LIMITS.toolInput, calls[9]!.input.length)
    cut(last.result, FEEDBACK_LIMITS.toolResult, calls[9]!.result.length)
    assert.deepEqual(report.context.tasks.map((x) => x.id), Array.from({ length: 10 }, (_, i) => `t${20 + i}`))
    // 一条的大小有上限：各项上限加起来，再加一点壳
    const L = FEEDBACK_LIMITS
    const budget = L.title + L.goal + L.problem + L.wish + L.instruction + L.tools * (L.toolInput + L.toolResult) + 1500
    assert.ok(JSON.stringify(report).length < budget, `one report stays within ${budget} characters (${JSON.stringify(report).length})`)
  })

  it('不带密钥：这台大脑上真正的 key 和口令、长得像 key 的串，存之前都被抹掉', (t) => {
    const s = store(t, { secrets: ['panel-password-123', 'bridge-token-abcdef', 'my-api-key-0001'] })
    const res = s.book.submit(
      { ...REPORT, problem: '主人把口令 panel-password-123 发给了我' },
      {
        ...CONTEXT,
        instruction: '主人通过控制面板对你说：key 是 my-api-key-0001，还有 sk-live-ABCDEFGHIJKLMNOP-9876',
        recentTools: [{ tool: 'say', input: '{"message":"Authorization: Bearer abcdefghijklmnop123456"}', result: 'token bridge-token-abcdef' }],
      },
    )
    assert.ok(!('full' in res))
    const saved = fs.readFileSync(s.file, 'utf8')
    for (const secret of ['panel-password-123', 'bridge-token-abcdef', 'my-api-key-0001', 'sk-live-ABCDEFGHIJKLMNOP-9876', 'abcdefghijklmnop123456']) {
      assert.equal(saved.includes(secret), false, secret)
    }
    assert.equal(res.report.problem, '主人把口令 [redacted] 发给了我')
    assert.equal(res.report.context.instruction, '主人通过控制面板对你说：key 是 [redacted]，还有 [redacted]')
  })
})

describe('意见簿：存盘', () => {
  it('记过的、加过的次数、标过的状态，大脑重启后都在；文件只往后加，坏掉的一行不连累别的', (t) => {
    const s = store(t)
    s.book.submit(REPORT, { ...CONTEXT, recentTools: [{ tool: 'find_item', input: '{}', result: 'ok' }], tasks: [{ id: 't1', error: 'stuck' }] })
    const afterFirst = fs.readFileSync(s.file, 'utf8')
    s.clock.now += HOUR
    s.book.submit(REPORT, CONTEXT)
    s.book.submit({ ...REPORT, title: '另一个问题', category: 'cannot_do' }, CONTEXT)
    s.book.setStatus('f1', 'seen')
    s.book.setStatus('f2', 'handled')
    // 前面写下的内容一个字都没被改
    assert.ok(fs.readFileSync(s.file, 'utf8').startsWith(afterFirst))
    fs.appendFileSync(s.file, '{"t":"report","id":"f9","report":{"title":"半截\n')

    const reopened = s.open()
    assert.deepEqual(reopened.list().map((r) => [r.id, r.title, r.category, r.count, r.status, r.time, r.lastTime]), [
      ['f2', '另一个问题', 'cannot_do', 1, 'handled', NOW + HOUR, NOW + HOUR],
      ['f1', REPORT.title, 'missing_tool', 2, 'seen', NOW, NOW + HOUR],
    ])
    assert.deepEqual(reopened.get('f1')!.context, { ...CONTEXT, recentTools: [{ tool: 'find_item', input: '{}', result: 'ok' }], tasks: [{ id: 't1', error: 'stuck' }] })
    assert.equal(reopened.unread(), 0)
    // 接着记，编号往后排
    const next = reopened.submit({ ...REPORT, title: '第三个问题' }, CONTEXT)
    assert.equal('full' in next ? '' : next.report.id, 'f3')
    assert.equal(reopened.unread(), 1)
  })
})
