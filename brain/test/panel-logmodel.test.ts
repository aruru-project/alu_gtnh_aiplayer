// 面板把活动日志画成时间线之前的那一步（src/panel/public/logmodel.js）：条目 → 一句话、一轮决策里的每一步、一次程序运行……
// 日志有新旧两种形状（旧的留 14 天，往上翻会翻到），两种都要认对：认错了，主人在“对话”页看到的就是错的。
// 画到页面上的那一半是在浏览器里看的（test/panel-shots.ts 截图）。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

type Json = Record<string, any>
interface LogModel {
  buildTimeline(entries: Json[]): { items: Json[]; turns: Map<number, Json> }
  layoutRows(items: Json[], maxLevel?: number): { key: string; left: Json[]; right: Json[]; both?: Json }[]
  recentActivity(items: Json[], limit?: number): Json[]
  describeArgs(raw: unknown, itemName?: (id: string, meta: number) => string | undefined): string | undefined
}
// 面板的脚本是浏览器里直接跑的 JS（没有类型声明），这里按地址载入
const model = (await import(new URL('../src/panel/public/logmodel.js', import.meta.url).href)) as LogModel

let nextId = 1
let clock = 1_000_000
/** 造一条日志条目：id 和时间自己往后排。 */
const e = (kind: string, text: string, extra: Json = {}): Json => ({ id: nextId++, time: (clock += 1000), kind, text, ...extra })
const kinds = (items: Json[]): string[] => items.map((i) => i.type)
const toolNames = (turn: Json): string[] => turn.parts.flatMap((p: Json) => p.steps.flatMap((s: Json) => s.tools.map((t: Json) => t.name)))

describe('对话页的时间线：旧形状的日志', () => {
  it('例程调的工具（正文以“[例程 r1]”开头）不一条条摊在时间线上，收成这次运行的一块：调了几次、开了几个任务、哪几步出错', () => {
    const { items } = model.buildTimeline([
      e('info', '例程 r1（搬东西）开始在后台跑。', { detail: 'await tool(…)' }),
      e('tool_call', '[例程 r1] {"x":1}', { who: 'list_drawers' }),
      e('tool_result', '[例程 r1] 2 slots', { who: 'list_drawers' }),
      e('tool_call', '[例程 r1] {"from":1}', { who: 'haul_items' }),
      e('tool_result', '[例程 r1] t1 haul [done] result={"moved":4}', { who: 'haul_items' }),
      e('tool_call', '[例程 r1] {"from":2}', { who: 'haul_items' }),
      e('tool_result', '[例程 r1] t2 haul [failed] no_space', { who: 'haul_items', isError: true }),
      e('info', '例程 r1（搬东西）跑完了：the program finished', { detail: 'Routine r1 finished…' }),
    ])
    assert.deepEqual(kinds(items), ['run'])
    const run = items[0]!
    assert.deepEqual([run.run.id, run.run.name, run.run.status, run.run.calls, run.run.tasks, run.run.errors], ['r1', '搬东西', 'done', 3, 2, 1])
    assert.equal(run.code, 'await tool(…)')
    assert.equal(run.summary, 'Routine r1 finished…')
    assert.deepEqual(run.failed.map((t: Json) => [t.name, t.result]), [['haul_items', 't2 haul [failed] no_space']])
    // 每一步的正文去掉了前缀
    assert.equal(run.calls[0].args, '{"x":1}')
  })

  it('大脑重启以后编号从头数：又一个 r1 是另一次运行，不和上一个 r1 混在一起', () => {
    const { items } = model.buildTimeline([
      e('info', '例程 r1（头一个）开始在后台跑。'),
      e('tool_call', '[例程 r1] {}', { who: 'look_around' }),
      e('tool_result', '[例程 r1] ok', { who: 'look_around' }),
      e('error', '例程 r1（头一个）停了：stopped'),
      e('info', '例程 r1（第二个）开始在后台跑。'),
      e('tool_call', '[例程 r1] {}', { who: 'say' }),
    ])
    assert.deepEqual(
      items.map((i) => [i.run.name, i.run.status, i.run.calls]),
      [
        ['头一个', 'stopped', 1],
        ['第二个', 'running', 1],
      ],
    )
  })

  it('run_program 的程序里调的工具（“[程序]”）挂在那次 run_program 下面，不算模型自己调的', () => {
    const { items, turns } = model.buildTimeline([
      e('turn', '第 7 轮开始（某模型）：主人说：查一下', { turn: 7, detail: '给模型看的' }),
      e('tool_call', '{"code":"…"}', { turn: 7, who: 'run_program' }),
      e('tool_call', '[程序] {"query":"钢"}', { who: 'find_item' }),
      e('tool_result', '[程序] 3 items', { who: 'find_item' }),
      e('tool_result', 'The program finished.', { turn: 7, who: 'run_program' }),
      e('turn', '第 7 轮结束（调了 2 次模型，某模型）', { turn: 7 }),
    ])
    assert.deepEqual(kinds(items), ['work'])
    const turn = turns.get(7)!
    assert.deepEqual(toolNames(turn), ['run_program'])
    const nested = turn.parts[0].steps[0].tools[0].run
    assert.deepEqual([nested.run.kind, nested.run.calls, nested.calls[0].name, nested.calls[0].result], ['program', 1, 'find_item', '3 items'])
  })

  it('一轮的头：被什么叫醒的、用的哪个模型、调了几次模型（旧日志只在“第 N 轮结束”那一句里有）、给模型看的内容', () => {
    const { turns } = model.buildTimeline([
      e('turn', '第 23 轮开始（codex / gpt-x）：主人通过控制面板对你说：做个背包', { turn: 23, detail: '[需要你处理的事]…' }),
      e('tool_call', '{"query":"背包"}', { turn: 23, who: 'find_item' }),
      e('tool_result', '17 items', { turn: 23, who: 'find_item' }),
      e('model_text', '材料都够。', { turn: 23 }),
      e('turn', '第 23 轮结束（调了 7 次模型，codex / gpt-x）', { turn: 23 }),
    ])
    const t = turns.get(23)!
    assert.deepEqual([t.trigger, t.model, t.calls, t.seen, t.open, t.tools], ['主人通过控制面板对你说：做个背包', 'codex / gpt-x', 7, '[需要你处理的事]…', false, 1])
    // 旧日志没有每一步的账
    assert.equal(t.legacy, true)
  })

  it('它在一轮中间说了话：这句话是时间线上单独的一句，这一轮在它前后各成一段，先后顺序不乱', () => {
    const { items, turns } = model.buildTimeline([
      e('command', '做个背包', { who: '面板' }),
      e('turn', '第 3 轮开始：主人说：做个背包', { turn: 3 }),
      e('tool_call', '{"message":"好"}', { turn: 3, who: 'say' }),
      e('say', '好', { who: 'Alu' }),
      e('tool_result', 'Said in public chat.', { turn: 3, who: 'say' }),
      e('tool_call', '{"query":"背包"}', { turn: 3, who: 'find_item' }),
      e('tool_result', '17 items', { turn: 3, who: 'find_item' }),
      e('turn', '第 3 轮结束（调了 2 次模型）', { turn: 3 }),
    ])
    assert.deepEqual(
      items.map((i) => (i.type === 'msg' ? `${i.role}:${i.text}` : `${i.type}:${i.steps.flatMap((s: Json) => s.tools.map((t: Json) => t.name)).join(',')}`)),
      ['owner:做个背包', 'work:say', 'bot:好', 'work:find_item'],
    )
    // 两段是同一轮
    assert.equal(turns.get(3)!.parts.length, 2)
    assert.equal(items[1]!.turn, items[3]!.turn)
  })

  it('没叫醒模型的聊天带着原因；一串系统消息和进出服务器并成一组，不一条条占地方', () => {
    const { items } = model.buildTimeline([
      e('chat', 'sethome x', { who: 'Scout', detail: '没有叫醒模型：这是另一个 bot 说的。' }),
      e('event', '系统消息：Welcome'),
      e('event', '系统消息：See what is new'),
      e('event', '任务 t1（goto）开始执行'),
    ])
    assert.deepEqual(kinds(items), ['msg', 'events'])
    assert.equal(items[0]!.note, '没有叫醒模型：这是另一个 bot 说的。')
    assert.deepEqual(items[1]!.lines.map((l: Json) => [l.system, l.text]), [[true, 'Welcome'], [true, 'See what is new'], [false, '任务 t1（goto）开始执行']])
  })
})

describe('对话页的时间线：新形状的日志', () => {
  it('每次模型调用是一步：用时和 token 在这一步上，这一步要的工具挂在它下面；一轮的 token 是各步加起来', () => {
    const { turns } = model.buildTimeline([
      e('turn', '第 12 轮开始（A / m）：阿露 说：不对', { turn: 12 }),
      e('model_call', '第 1 步：…', { turn: 12, step: 1, call: { state: 'done', purpose: 'turn', step: 1, startedAt: 1, ms: 7500, inputTokens: 1000, outputTokens: 30, cacheReadTokens: 900, stop: 'tool_calls', toolCalls: 2 } }),
      e('tool_call', '{}', { turn: 12, step: 1, source: 'model', who: 'look_around' }),
      e('tool_result', 'ok', { turn: 12, step: 1, source: 'model', who: 'look_around' }),
      e('tool_call', '{"x":1}', { turn: 12, step: 1, source: 'model', who: 'go_to' }),
      e('tool_result', 'Task t1 started', { turn: 12, step: 1, source: 'model', who: 'go_to' }),
      e('model_call', '第 2 步：…', { turn: 12, step: 2, call: { state: 'done', purpose: 'turn', step: 2, startedAt: 2, ms: 2500, inputTokens: 1200, outputTokens: 10, cacheReadTokens: 1000, stop: 'end', toolCalls: 0 } }),
      e('model_text', '走过去了。', { turn: 12, step: 2 }),
      e('turn', '第 12 轮结束（调了 2 次模型，A / m）', { turn: 12 }),
    ])
    const t = turns.get(12)!
    const steps = t.parts.flatMap((p: Json) => p.steps)
    assert.deepEqual(steps.map((s: Json) => [s.n, s.call.ms, s.tools.map((x: Json) => x.name), s.texts.map((x: Json) => x.text)]), [
      [1, 7500, ['look_around', 'go_to'], []],
      [2, 2500, [], ['走过去了。']],
    ])
    assert.deepEqual([t.calls, t.inputTokens, t.outputTokens, t.cacheReadTokens, t.modelMs, t.legacy], [2, 2200, 40, 1900, 10000, false])
  })

  it('一轮“几处出错”：模型接口真的失败算一处；想到一半被叫停的（halted）、大脑进程要停时中止的（failed + aborted）都不算', () => {
    const { turns } = model.buildTimeline([
      e('turn', '第 6 轮开始', { turn: 6 }),
      e('model_call', '第 2 步：想到一半被叫停了（4.3 秒）', { turn: 6, step: 2, call: { state: 'halted', step: 2, stop: 'halted', ms: 4300 } }),
      e('turn', '第 7 轮开始', { turn: 7 }),
      e('model_call', '第 1 步：模型调用失败（aborted，4.3 秒）：…', { turn: 7, step: 1, isError: true, call: { state: 'failed', step: 1, stop: 'error', errorKind: 'aborted', error: '大脑在停，这次调用被中止了', ms: 4300 } }),
      e('turn', '第 8 轮开始', { turn: 8 }),
      e('model_call', '第 1 步：模型调用失败（http，1 秒）：502', { turn: 8, step: 1, isError: true, call: { state: 'failed', step: 1, stop: 'error', errorKind: 'http', error: '502', ms: 1000 } }),
    ])
    assert.deepEqual([turns.get(6)!.errors, turns.get(7)!.errors, turns.get(8)!.errors], [0, 0, 1])
  })

  it('“正在想”的那一条回来以后是同一个 id 的新样子：换掉原来那条，这一步从在想变成有结果', () => {
    const start = e('turn', '第 5 轮开始：提醒到点', { turn: 5 })
    const thinking = e('model_call', '第 1 步：模型在想…', { turn: 5, step: 1, call: { state: 'thinking', purpose: 'turn', step: 1, startedAt: 9 } })
    const before = model.buildTimeline([start, thinking]).turns.get(5)!
    assert.equal(before.parts[0].steps[0].call.state, 'thinking')
    assert.equal(before.open, true)

    const done = { ...thinking, text: '第 1 步：2 秒', isError: true, call: { state: 'failed', purpose: 'turn', step: 1, startedAt: 9, ms: 2000, stop: 'error', errorKind: 'timeout', error: 'timed out' } }
    const after = model.buildTimeline([start, done]).turns.get(5)!
    assert.equal(after.parts.flatMap((p: Json) => p.steps).length, 1)
    assert.deepEqual([after.parts[0].steps[0].call.state, after.parts[0].steps[0].call.errorKind, after.errors], ['failed', 'timeout', 1])
  })

  it('一次程序运行只有一条汇总，照它带的数显示；出错的那一步（“[例程 r3 #12]”）挂在这次运行上；开始、结束那两条并进来', () => {
    const run = { id: 'r3', kind: 'routine', name: '整理抽屉', status: 'running', startedAt: 5, calls: 0, tasks: 0, errors: 0, file: 'routine-1-r3.jsonl' }
    const { items } = model.buildTimeline([
      e('info', '例程 r3（整理抽屉）开始在后台跑。', { detail: '程序全文', source: 'routine', runId: 'r3', run }),
      e('run', '例程 r3：在跑', { source: 'routine', runId: 'r3', run: { ...run, calls: 312, tasks: 150, errors: 1, waiting: 'withdraw_items {}' } }),
      e('tool_result', '[例程 r3 #12] No screen is open', { who: 'click_slot', isError: true, source: 'routine', runId: 'r3', detail: '参数…结果…' }),
      e('error', '例程 r3（整理抽屉）停了：stopped by owner', { detail: '给模型的总结', source: 'routine', runId: 'r3', run: { ...run, status: 'stopped', endedAt: 99, calls: 320, tasks: 151, errors: 1 } }),
    ])
    assert.deepEqual(kinds(items), ['run'])
    const item = items[0]!
    assert.deepEqual([item.run.status, item.run.calls, item.run.tasks, item.run.errors, item.run.endedAt, item.run.waiting], ['stopped', 320, 151, 1, 99, undefined])
    assert.deepEqual([item.code, item.summary], ['程序全文', '给模型的总结'])
    assert.deepEqual(item.failed.map((t: Json) => [t.name, t.result, t.resultDetail]), [['click_slot', 'No screen is open', '参数…结果…']])
    // 明细不在日志里（在 /api/runs/records）
    assert.equal(item.legacy, false)
  })

  it('两条线：对话线说的话和它自己的几步在“对话”那一道，干活线的在“干活”那一道；两条线之间的往来横跨两边', () => {
    const { items } = model.buildTimeline([
      e('chat', '把箱子拆了', { who: '阿露' }),
      e('turn', '第 40 轮开始：阿露 说：把箱子拆了', { turn: 40, agent: 'talk' }),
      e('model_call', '第 1 步', { turn: 40, step: 1, agent: 'talk', call: { state: 'done', step: 1, ms: 900 } }),
      e('say', '好，这就拆。', { who: 'Alu', agent: 'talk', turn: 40, step: 1 }),
      e('relay', '对话线 → 干活线：把他指着的那个箱子拆了', { agent: 'talk', turn: 40, step: 1, detail: '全文', relay: { type: 'tell', from: 'talk', to: 'work', quotes: 1 } }),
      e('turn', '第 40 轮结束（调了 1 次模型）', { turn: 40, agent: 'talk' }),
      e('turn', '第 41 轮开始：对话线交来的事：把他指着的那个箱子拆了', { turn: 41, agent: 'work' }),
      e('relay', '干活线 → 对话线（提问）：箱子里还有东西，先搬到哪？', { agent: 'work', turn: 41, step: 1, relay: { type: 'question', from: 'work', to: 'talk' } }),
    ])
    assert.deepEqual(
      items.map((i) => [i.type, i.lane]),
      [
        ['msg', 'talk'],
        ['work', 'talk'],
        ['msg', 'talk'],
        ['relay', 'both'],
        ['work', 'work'],
        ['relay', 'both'],
      ],
    )
    const [tell, question] = items.filter((i) => i.type === 'relay')
    assert.deepEqual([tell!.kind, tell!.to, tell!.text, tell!.quotes, tell!.detail, tell!.background], ['tell', 'work', '把他指着的那个箱子拆了', 1, '全文', false])
    assert.deepEqual([question!.kind, question!.to, question!.text], ['question', 'talk', '箱子里还有东西，先搬到哪？'])
  })

  it('干活线还在等自己开的任务时留的话（progress）：是一条往来，带着它在等什么', () => {
    const { items } = model.buildTimeline([
      e('relay', '干活线 → 对话线（只作背景，没有叫醒它）：先取了一组钢锭，还在取', { agent: 'work', turn: 9, relay: { type: 'progress', from: 'work', to: 'talk', waiting: '在等它开的任务结束：t5（withdraw）' } }),
    ])
    assert.deepEqual(items.map((i) => [i.type, i.kind, i.to, i.text, i.waiting]), [['relay', 'progress', 'talk', '先取了一组钢锭，还在取', '在等它开的任务结束：t5（withdraw）']])
  })

  it('两条线空转时的那一条往来（正文开头写着“只作背景，没有叫醒它”）：照样是一条往来，标出它没叫醒对方；面板叫停的没有 agent', () => {
    const { items } = model.buildTimeline([
      e('relay', '干活线 → 对话线（只作背景，没有叫醒它）：还在等你回答', { agent: 'work', relay: { type: 'report', from: 'work', to: 'talk' } }),
      e('relay', '面板 → 干活线：停（主人在面板上点了“全部停下”）。', { relay: { type: 'stop', from: 'panel', to: 'work' } }),
    ])
    assert.deepEqual(items.map((i) => [i.type, i.kind, i.from, i.to, i.background, i.text]), [
      ['relay', 'report', 'work', 'talk', true, '还在等你回答'],
      ['relay', 'stop', 'panel', 'work', false, '停（主人在面板上点了“全部停下”）。'],
    ])
  })
})

describe('对话页的时间线：排成左右两道', () => {
  const items = model.buildTimeline([
    e('command', '平一下地', { who: '面板' }),
    e('turn', '第 1 轮开始：主人说：平一下地', { turn: 1 }),
    e('tool_call', '{}', { turn: 1, who: 'flatten_area' }),
    e('tool_result', 'Task t1 started', { turn: 1, who: 'flatten_area' }),
    e('turn', '第 1 轮结束（调了 1 次模型）', { turn: 1 }),
    e('event', '任务 t1（flatten）完成了。'),
    e('say', '搞定了。', { who: 'Alu' }),
    e('relay', '干活线 → 对话线：做完了', { agent: 'work', relay: { type: 'result', from: 'work', to: 'talk' } }),
  ]).items

  it('说的话在左、紧跟着它的干活在右，排在同一行；后面又有人说话就另起一行；两条线之间的往来自己占一行', () => {
    const rows = model.layoutRows(items, 3)
    assert.deepEqual(
      rows.map((r) => [r.left.map((i) => i.type), r.right.map((i) => i.type), r.both?.type]),
      [
        [['msg'], ['work', 'events'], undefined],
        [['msg'], [], undefined],
        [[], [], 'relay'],
      ],
    )
  })

  it('“只看对话”：只剩说的话和两条线之间的往来；“加上模型的决策”：再加上每一轮，不带游戏事件', () => {
    assert.deepEqual(model.layoutRows(items, 1).flatMap((r) => [...r.left, ...r.right, ...(r.both ? [r.both] : [])].map((i) => i.type)), ['msg', 'msg', 'relay'])
    assert.deepEqual(model.layoutRows(items, 2).flatMap((r) => [...r.left, ...r.right, ...(r.both ? [r.both] : [])].map((i) => i.type)), ['msg', 'work', 'msg', 'relay'])
  })

  it('一模一样的报错连着来（中间隔着的只是这一档里不显示的说明）：并成一条，写着几次和最近一次的时刻', () => {
    const items = model.buildTimeline([
      e('error', '和游戏服务器的连接断了，正在重连。'),
      e('info', '已连上游戏服务器。'),
      e('error', '和游戏服务器的连接断了，正在重连。'),
      e('info', '已连上游戏服务器。'),
      e('error', '和游戏服务器的连接断了，正在重连。'),
      e('error', '模型调用失败：超时'),
    ]).items
    const shown = model.layoutRows(items, 2).flatMap((r) => r.right)
    assert.deepEqual(shown.map((i) => [i.text, i.times ?? 1]), [['和游戏服务器的连接断了，正在重连。', 3], ['模型调用失败：超时', 1]])
    assert.equal(shown[0]!.lastTime, items[4]!.time)
    // “全部”那一档里中间的说明看得见，所以不并
    assert.equal(model.layoutRows(items, 3).flatMap((r) => r.right).length, 6)
  })

  it('“现在”页的最近几步：一行一件事，按时间排；它说的话只出现一次（不再把 say 这次工具调用另列一行）', () => {
    const rows = model.recentActivity(
      model.buildTimeline([
        e('turn', '第 2 轮开始：主人说：在吗', { turn: 2 }),
        e('tool_call', '{}', { turn: 2, who: 'get_status' }),
        e('tool_result', 'online', { turn: 2, who: 'get_status' }),
        e('tool_call', '{"message":"在"}', { turn: 2, who: 'say' }),
        e('say', '在', { who: 'Alu' }),
        e('tool_result', 'Said in public chat.', { turn: 2, who: 'say' }),
      ]).items,
    )
    assert.deepEqual(rows.map((r) => [r.kind, r.label, r.text]), [
      ['tool', 'get_status', 'online'],
      ['say', '它说', '在'],
    ])
  })
})

describe('工具参数读成一句话', () => {
  const names: Record<string, string> = { 'chisel:dirt/0': '泥土', 'chisel:diamondChisel/0': '钻石凿子' }
  const nameOf = (id: string, meta: number): string | undefined => names[`${id}/${meta}`]

  it('物品写名字和数量（查不到名字的写 id），位置写成 (x,y,z)，说的话加引号，程序只写几行', () => {
    assert.equal(model.describeArgs('{"container":{"x":-519,"y":69,"z":85},"items":[{"id":"chisel:dirt","meta":0,"count":64}]}', nameOf), '(-519,69,85) · 泥土 ×64')
    assert.equal(model.describeArgs('{"item":{"id":"chisel:diamondChisel"}}', nameOf), '钻石凿子')
    assert.equal(model.describeArgs('{"id":"Backpack:backpack","meta":0}', nameOf), 'Backpack:backpack')
    assert.equal(model.describeArgs('{"message":"好，我查一下。"}'), '“好，我查一下。”')
    assert.equal(model.describeArgs('{"x1":6,"z1":-8,"x2":13,"z2":-1,"y":64}'), '(6,-8)–(13,-1) · y=64')
    assert.equal(model.describeArgs('{"from":{"x":1,"y":2,"z":3,"slot":2},"to":{"x":4,"y":5,"z":6}}'), '从 (1,2,3) 第 2 格 · 到 (4,5,6)')
    assert.equal(model.describeArgs('{"code":"const a = 1\\nreturn a","name":"整理"}'), '程序（2 行） · 整理')
    assert.equal(model.describeArgs('{"slot":71,"shift":true}'), 'slot=71 · shift')
  })

  it('没有参数是空的；截短了解不出来的 JSON 不硬猜（页面照原样显示）', () => {
    assert.equal(model.describeArgs('{}'), '')
    assert.equal(model.describeArgs('{"item":{"id":"chisel:diamondChi…'), undefined)
    assert.equal(model.describeArgs(undefined), undefined)
  })
})
