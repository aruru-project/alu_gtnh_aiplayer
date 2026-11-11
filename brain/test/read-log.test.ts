import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { ActivityLog } from '../src/store/activity-log.ts'
import type { ActivityInput } from '../src/store/activity-log.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { LINE_TOOLS, runTool } from '../src/tools/index.ts'
import type { LineName } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/types.ts'
import { DEFAULT_MANUALS_DIR, FakeGame, chat, makeAgent, reply, taskEnded, told } from './agent-harness.ts'
import type { GenerateRequest } from '../src/llm/index.ts'
import { tmpDir } from './helpers.ts'

/** 本地时间的某一刻（月从 1 数）。 */
const at = (month: number, day: number, hour: number, minute: number, second = 0): number => new Date(2026, month - 1, day, hour, minute, second).getTime()
const NOW = at(11, 11, 18, 0)

/**
 * 一份两天的活动日志（落在磁盘上，内存里只留最后几条）：昨天第 3 轮主人交代了一件事、查了一次箱子；今天第 7 轮对话线交了一件事，
 * 干活线第 8 轮查了一个很长的结果。
 */
function setup(t: { after(fn: () => void): void }, opts: { line?: LineName; memoryLimit?: number; maxResultChars?: number } = {}) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  const log = new ActivityLog(tmp.dir, { memoryLimit: opts.memoryLimit ?? 4 })
  const add = (time: number, entry: ActivityInput) => log.add({ ...entry, time })
  // 昨天
  add(at(11, 10, 9, 0, 0), { kind: 'chat', who: 'Steve', text: 'Alu 把钢板放进左边第二个箱子，别动红色的那个' })
  add(at(11, 10, 9, 0, 1), { kind: 'turn', agent: 'work', turn: 3, text: '第 3 轮开始：Steve 说：Alu 把钢板放进左边第二个箱子…', detail: '[需要你处理的事]\n[09:00:00] Steve 说：Alu 把钢板放进左边第二个箱子，别动红色的那个\n\n[当前状态]\nAlu: online at (10,64,-4)' })
  add(at(11, 10, 9, 0, 5), { kind: 'tool_call', agent: 'work', turn: 3, step: 1, source: 'model', who: 'list_containers', text: '{"radius":8}' })
  add(at(11, 10, 9, 0, 6), { kind: 'tool_result', agent: 'work', turn: 3, step: 1, source: 'model', who: 'list_containers', text: '2 containers within 8 blocks.', detail: '2 containers within 8 blocks.\nChest at (12,64,-4): 64× 钢板 [gregtech:gt.metaitem.01/17305]\nChest at (13,64,-4): empty' })
  add(at(11, 10, 9, 0, 9), { kind: 'model_text', agent: 'work', turn: 3, step: 2, text: '钢板在 (12,64,-4) 的箱子里，先不动红色的。' })
  add(at(11, 10, 9, 0, 10), { kind: 'model_call', agent: 'work', turn: 3, step: 2, text: '第 2 步：想了 3 秒', call: { state: 'done', purpose: 'turn', startedAt: at(11, 10, 9, 0, 7), step: 2 } })
  // 今天
  add(at(11, 11, 14, 30, 0), { kind: 'command', who: '面板', text: '去看看高炉缺什么' })
  add(at(11, 11, 14, 30, 2), { kind: 'say', agent: 'talk', turn: 7, step: 1, who: 'Alu', text: '好，我让身体去看高炉。' })
  add(at(11, 11, 14, 30, 3), { kind: 'relay', agent: 'talk', turn: 7, step: 1, text: '对话线 → 干活线：去看看高炉缺什么', relay: { type: 'tell', from: 'talk', to: 'work', quotes: 1 } })
  add(at(11, 11, 14, 30, 8), { kind: 'tool_call', agent: 'work', turn: 8, step: 1, source: 'model', who: 'inspect_block', text: '{"x":5,"y":64,"z":9,"detail":true}' })
  add(at(11, 11, 14, 30, 9), { kind: 'tool_result', agent: 'work', turn: 8, step: 1, source: 'model', who: 'inspect_block', text: 'Electric Blast Furnace at (5,64,9): incomplete structure.', detail: `Electric Blast Furnace at (5,64,9): incomplete structure.\n${'coil row. '.repeat(1200)}END OF RESULT` })
  add(at(11, 11, 14, 31, 0), { kind: 'error', agent: 'work', turn: 8, text: '模型调用失败：timeout。30 秒后再试。' })
  const ctx: ToolContext = {
    botName: 'Alu',
    line: opts.line ?? 'work',
    bridge: new BridgeApi(new FakeGame()),
    memory: new MemoryStore(tmp.dir, () => 4000),
    manuals: new ManualStore(DEFAULT_MANUALS_DIR, `${tmp.dir}/manuals`),
    reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
    activityLog: log,
    ...(opts.maxResultChars !== undefined ? { maxResultChars: () => opts.maxResultChars! } : {}),
    hooks: {},
    now: () => NOW,
  }
  const read = async (input: unknown) => {
    const res = await runTool(LINE_TOOLS[opts.line ?? 'work'], ctx, 'read_log', input)
    return { text: res.content, data: res.data as any, isError: res.isError === true }
  }
  return { log, read }
}

describe('read_log：翻自己的活动日志', () => {
  it('按第几轮读（那一轮已经不在对话历史里、也不在内存里了）：开头那条消息、每次工具调用和结果、它写的字，按时间从头排；模型调用的账不点名不给', async (t) => {
    const { read } = setup(t)
    const res = await read({ turn: 3 })
    assert.equal(
      res.text,
      [
        'Activity log, turn 3: 4 entries match; here are #2–#5 (4), oldest first.',
        '#2 [11-10 09:00:01] work turn 3 · turn: 第 3 轮开始：Steve 说：Alu 把钢板放进左边第二个箱子…',
        '    detail (87 chars): [需要你处理的事]',
        '    [09:00:00] Steve 说：Alu 把钢板放进左边第二个箱子，别动红色的那个',
        '    ',
        '    [当前状态]',
        '    Alu: online at (10,64,-4)',
        '#3 [11-10 09:00:05] work turn 3 step 1 · tool_call list_containers: {"radius":8}',
        '#4 [11-10 09:00:06] work turn 3 step 1 · tool_result list_containers: 2 containers within 8 blocks.',
        '    detail (116 chars): 2 containers within 8 blocks.',
        '    Chest at (12,64,-4): 64× 钢板 [gregtech:gt.metaitem.01/17305]',
        '    Chest at (13,64,-4): empty',
        '#5 [11-10 09:00:09] work turn 3 step 2 · model_text: 钢板在 (12,64,-4) 的箱子里，先不动红色的。',
        'The log goes back to 11-10 09:00:00; now is 11-11 18:00:00.',
      ].join('\n'),
    )
    // 程序里拿到的是整条（详细内容是全的）
    assert.deepEqual(res.data.entries.map((e: any) => [e.id, e.kind, e.turn]), [[2, 'turn', 3], [3, 'tool_call', 3], [4, 'tool_result', 3], [5, 'model_text', 3]])
    assert.deepEqual([res.data.matched, res.data.earlier, res.data.later], [4, 0, 0])
    // 点名要模型调用的账才给
    const calls = await read({ turn: 3, kinds: ['calls'] })
    assert.match(calls.text, /1 entry matches; here is #6, oldest first\.\n#6 \[11-10 09:00:10\] work turn 3 step 2 · model_call: 第 2 步：想了 3 秒\n/)
  })

  it('按词找主人以前说过的话：只看别人说的那一类；几个词都要有', async (t) => {
    const { read } = setup(t)
    const res = await read({ query: '钢板 红色', kinds: ['heard'] })
    assert.equal(
      res.text,
      [
        'Activity log, containing "钢板" and "红色", kinds heard: 1 entry matches; here is #1, oldest first.',
        '#1 [11-10 09:00:00] · chat Steve: Alu 把钢板放进左边第二个箱子，别动红色的那个',
        'The log goes back to 11-10 09:00:00; now is 11-11 18:00:00.',
      ].join('\n'),
    )
    // 面板上发来的也算“别人说的”；它自己说的是另一类
    assert.deepEqual((await read({ kinds: ['heard'] })).data.entries.map((e: any) => e.text), ['Alu 把钢板放进左边第二个箱子，别动红色的那个', '去看看高炉缺什么'])
    assert.deepEqual((await read({ kinds: ['said'] })).data.entries.map((e: any) => e.text), ['好，我让身体去看高炉。'])
    // 几个词得在同一条里都有：“钢板”和“高炉”各在一条里，一起找就没有
    assert.equal((await read({ query: '钢板 高炉', kinds: ['heard'] })).data.matched, 0)
    // 没有的词：照实说没有，并说日志从什么时候起
    assert.equal((await read({ query: '钻石' })).text, 'No entries match (asked for: containing "钻石"). The log goes back to 11-10 09:00:00; now is 11-11 18:00:00.')
  })

  it('两条线的都看得到（别人说的话记在对话线名下，干活线也翻得到），每条写着是谁的；line 只看一条线的，连同不分线的', async (t) => {
    const { read } = setup(t)
    const all = await read({ from: '11-11 14:00' })
    assert.deepEqual(all.data.entries.map((e: any) => `${e.agent ?? '-'}:${e.kind}`), ['-:command', 'talk:say', 'talk:relay', 'work:tool_call', 'work:tool_result', 'work:error'])
    assert.match(all.text, /\n#8 \[11-11 14:30:02\] talk turn 7 step 1 · say Alu: 好，我让身体去看高炉。\n/)
    assert.match(all.text, /\n#12 \[11-11 14:31:00\] work turn 8 · error \(error\): 模型调用失败：timeout。30 秒后再试。\n|\n#12 \[11-11 14:31:00\] work turn 8 · error: 模型调用失败：timeout。30 秒后再试。\n/)
    const work = await read({ from: '11-11 14:00', line: 'work' })
    assert.deepEqual(work.data.entries.map((e: any) => `${e.agent ?? '-'}:${e.kind}`), ['-:command', 'work:tool_call', 'work:tool_result', 'work:error'])
    assert.match(work.text, /^Activity log, from 11-11 14:00:00, only the worker's entries and what belongs to no line: 4 entries match; /)
    const talk = await read({ from: '11-11 14:00', line: 'talk' })
    assert.deepEqual(talk.data.entries.map((e: any) => `${e.agent ?? '-'}:${e.kind}`), ['-:command', 'talk:say', 'talk:relay'])
  })

  it('按时间段读：from / to 写本地时间（带不带日期都行），minutes 是最近多少分钟；写得读不懂的照实说怎么写', async (t) => {
    const { read } = setup(t)
    const ids = async (input: unknown) => (await read(input)).data.entries.map((e: any) => e.id)
    assert.deepEqual(await ids({ from: '2026-11-10 09:00:05', to: '2026-11-10 09:00:09' }), [3, 4, 5])
    // 只写时刻就是今天的；只写到分的 to 包含这一整分钟
    assert.deepEqual(await ids({ from: '14:30', to: '14:30' }), [7, 8, 9, 10, 11])
    // 只写日期：这一整天
    assert.deepEqual(await ids({ from: '11-10', to: '11-10' }), [1, 2, 3, 4, 5])
    // 现在是 18:00：最近 210 分钟是 14:30 以后的
    assert.deepEqual(await ids({ minutes: 210 }), [7, 8, 9, 10, 11, 12])
    const bad = await read({ from: 'yesterday' })
    assert.equal(bad.isError, true)
    assert.equal(bad.text, 'from: "yesterday" is not a time I can read. Write it like "2026-11-11 14:30", "11-11 14:30" or "14:30" (local time; now is 11-11 18:00:00).')
  })

  it('一页放不下：给了起点从头往后读，写明后面还有多少、怎么接着读；没给起点给最晚的那些，写明前面还有多少', async (t) => {
    const { read } = setup(t)
    const first = await read({ turn: 3, limit: 2 })
    assert.match(first.text, /4 entries match; here are #2–#3 \(2\), oldest first\./)
    assert.match(first.text, /\n2 later one\(s\) match: the same input with after: 3\. The log goes back to/)
    const next = await read({ turn: 3, limit: 2, after: 3 })
    assert.deepEqual(next.data.entries.map((e: any) => e.id), [4, 5])
    assert.match(next.text, /\n2 earlier one\(s\) match: the same input with before: 4\. id: <number> reads one entry whole\. The log goes back to|\n2 earlier one\(s\) match: the same input with before: 4\. The log goes back to/)
    // 没给起点：最晚的两条，早的在前
    const latest = await read({ limit: 2 })
    assert.deepEqual(latest.data.entries.map((e: any) => e.id), [11, 12])
    assert.match(latest.text, /11 entries match; here are #11–#12 \(2\), oldest first\./)
    assert.match(latest.text, /\n9 earlier one\(s\) match: the same input with before: 11\. id: <number> reads one entry whole\. The log goes back to/)
    const earlier = await read({ limit: 3, before: 11 })
    assert.deepEqual(earlier.data.entries.map((e: any) => e.id), [8, 9, 10])
  })

  it('一页里每条只给详细内容的开头；id 读一条的全文，一次放不下时写明还剩多少、怎么接着读；日志落盘时截过的照实说', async (t) => {
    const { read } = setup(t, { maxResultChars: 3000 })
    const page = await read({ turn: 8, kinds: ['tools'] })
    // 详细内容 12,000 多字符，日志只留了前 8000；一页里只给开头 300
    assert.match(page.text, /#11 \[11-11 14:30:09\] work turn 8 step 1 · tool_result inspect_block: Electric Blast Furnace at \(5,64,9\): incomplete structure\.\n    detail \(8000 chars, the log kept that much of 12071; id: 11 shows it whole\): Electric Blast Furnace at \(5,64,9\): incomplete structure\.\n    (coil row\. ){24}co…\n/)
    const one = await read({ id: 11 })
    assert.match(one.text, /^#11 \[11-11 14:30:09\] work turn 8 step 1 · tool_result inspect_block: Electric Blast Furnace at \(5,64,9\): incomplete structure\.\ndetail, chars 0–2543 of 8000:\nElectric Blast Furnace at \(5,64,9\): incomplete structure\.\ncoil row\. /)
    assert.match(one.text, /\n5457 more chars of this detail: id: 11, offset: 2543\.\nThe log kept only the first 8000 of the 12071 chars this had \(it cuts a detail at 8000\); the rest is not stored anywhere\.$/)
    assert.ok(one.text.length <= 3000, `${one.text.length} chars`)
    // 接着读到头
    const rest = await read({ id: 11, offset: 7000 })
    assert.match(rest.text, /\ndetail, chars 7000–8000 of 8000:\n/)
    assert.equal(rest.text.includes('more chars of this detail'), false)
    // 程序里一次拿到存着的全部
    assert.equal(one.data.entry.detail.length > 8000, true)
    // 没有这一条
    assert.equal((await read({ id: 999 })).text, 'There is no entry #999 in the log (it goes back to 11-10 09:00:00; older days are deleted).')
  })

  it('一页的文字不超过单个结果的上限：放得下几条给几条，接着读的起点跟着实际给出的最后一条走', async (t) => {
    const { read, log } = setup(t, { maxResultChars: 1500 })
    for (let n = 0; n < 12; n++) log.add({ time: at(11, 11, 15, n), kind: 'model_text', agent: 'work', turn: 9, text: `第 ${n} 段想法：${'想'.repeat(300)}` })
    const res = await read({ turn: 9 })
    assert.ok(res.text.length <= 1500, `${res.text.length} chars`)
    // 十二条里放得下两条；程序里拿到的是整页
    assert.match(res.text, /12 entries match; here are #13–#14 \(2\), oldest first\./)
    assert.match(res.text, /\n10 later one\(s\) match: the same input with after: 14\. /)
    assert.deepEqual([res.data.entries.length, res.data.shown], [12, 2])
  })
})

describe('read_log：两条线都能调，历史换成交接记录以后翻得回原文', () => {
  it('较早的轮换成交接记录以后，干活线用 read_log 按轮号翻回当时那次工具调用的结果', async (t) => {
    const h = makeAgent({ settings: { historyTokenThreshold: 6000 } })
    t.after(h.cleanup)
    h.game.handlers['world.scan'] = (p) => ({ x1: p.x1, z1: p.z1, x2: p.x2, z2: p.z2, heights: Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 64)) })
    const respond = (req: GenerateRequest) => {
      if (req.tools.length === 0) return reply('<summary>## 做完的事\n扫过几次地形。</summary>')
      const last = req.messages[req.messages.length - 1]!
      const afterTool = last.role === 'user' && last.content.some((p) => p.type === 'tool_result')
      return afterTool ? reply('') : reply('', [{ name: 'scan_area', input: { x1: 0, z1: 0, x2: 19, z2: 19 } }])
    }
    h.llm.enqueue(...Array.from({ length: 17 }, () => respond))
    for (let i = 1; i <= 8; i++) {
      h.agent.handleEvent(i === 1 ? told('把 0,0 到 19,19 平到 64') : taskEnded(`t${i}`, 'done'))
      await h.agent.whenIdle()
    }
    const folded = h.history.get().summaryOf!
    assert.equal(folded.turns, 6)
    // 第一轮已经不在历史里了：它直接调 read_log（库函数，不在清单里，照常执行）
    h.llm.enqueue(reply('', [{ name: 'read_log', input: { turn: folded.from, kinds: ['tools'] } }]), reply('看到了'))
    h.agent.handleEvent(taskEnded('t9', 'done'))
    await h.agent.whenIdle()
    const result = h.llm.requests.at(-1)!.messages.at(-1)!.content[0]!
    assert.ok(result.type === 'tool_result' && !result.isError)
    const text = result.type === 'tool_result' ? result.content : ''
    assert.match(text, new RegExp(`^Activity log, turn ${folded.from}, kinds tools: 2 entries match; here are #\\d+–#\\d+ \\(2\\), oldest first\\.\\n#\\d+ \\[[\\d-]+ [\\d:]+\\] work turn ${folded.from} step 1 · tool_call scan_area: \\{"x1":0,"z1":0,"x2":19,"z2":19\\}\\n#\\d+ \\[[\\d-]+ [\\d:]+\\] work turn ${folded.from} step 1 · tool_result scan_area: `))
  })

  it('对话线也有：库函数索引里列着它，对话线调它照常执行（只看）', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.talk.enqueue(reply('', [{ name: 'read_log', input: { kinds: ['heard'] } }]), reply('查到了'))
    h.agent.handleEvent(chat('Steve', 'Alu 你记得我昨天说的吗'))
    await h.agent.whenIdle()
    const run = h.talk.requests[0]!.tools.find((tool) => tool.name === 'run_program')!.description
    assert.match(run, /\n- read_log \{turn\?, turnTo\?, from\?, to\?, query\?, kinds\?, id\?, after\?, before\?\}: your activity log, which still holds turns that left your history -> entries\[\{id, time, kind, turn, who, text, detail\}\]\n/)
    const result = h.talk.requests.at(-1)!.messages.at(-1)!.content[0]!
    assert.ok(result.type === 'tool_result' && !result.isError)
    assert.match(result.type === 'tool_result' ? result.content : '', /^Activity log, kinds heard: 1 entry matches; here is #\d+, oldest first\.\n#\d+ \[[\d-]+ [\d:]+\] talk · chat Steve: Alu 你记得我昨天说的吗\n/)
  })
})
