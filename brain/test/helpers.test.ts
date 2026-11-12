// 子思维（src/agent/helpers.ts）：对话线派出去专门想一件事的那部分心思。
// 入口是整个 agent（h.agent，真的两条线）：对话线的模型调 start_helper / helper_status → 子思维用它自己的模型一步步想 →
// 结束时交回的话作为一个事件叫醒对话线。游戏是按方法名应答的假服务器，模型是按脚本回应的假模型；画草稿那条用真的沙箱。
// 自动下线用真的 Presence 接上 h.agent.busy()；重启用同一个数据目录再造一个 agent。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Presence } from '../src/agent/presence.ts'
import { DesignWorkspace } from '../src/design/index.ts'
import { LlmError } from '../src/llm/index.ts'
import type { GenerateRequest, GenerateResult } from '../src/llm/index.ts'
import { ConfigStore, normalizeConfig } from '../src/store/config.ts'
import { HelperStore } from '../src/store/helpers.ts'
import { HELPER_TOOLS, TALK_TOOLS } from '../src/tools/index.ts'
import { chat, lineCalls, llmDown, makeAgent, reply } from './agent-harness.ts'
import type { AgentHarness, MakeAgentOptions } from './agent-harness.ts'
import { tmpDir, waitFor } from './helpers.ts'

const TASK = '主人 Steve 想做 64 块钢板，问仓库里的钢锭够不够。\n查一下钢板怎么做、仓库里有多少钢锭，算一算还差多少。'
const HELPER_SYSTEM = /^你是 Alu 派出去专门想一件事的那部分心思。/

function setup(t: { after(fn: () => void | Promise<void>): void }, opts: MakeAgentOptions = {}): AgentHarness {
  const h = makeAgent({ helper: true, ...opts })
  t.after(async () => {
    await h.agent.stop()
    h.cleanup()
  })
  return h
}

/**
 * 一步“在想”的模型：放行（release）以前一直不回来；被停下（请求的 signal 中止）时像真的适配器那样抛 aborted。
 * then 是放行以后回的。
 */
function held(then: () => GenerateResult = () => reply('')): { fn: (req: GenerateRequest) => Promise<GenerateResult>; release(): void; asked: Promise<void> } {
  let release!: () => void
  let asked!: () => void
  const opened = new Promise<void>((resolve) => (release = resolve))
  const askedP = new Promise<void>((resolve) => (asked = resolve))
  const fn = (req: GenerateRequest): Promise<GenerateResult> =>
    new Promise((resolve, reject) => {
      asked()
      const onAbort = (): void => reject(new LlmError('aborted', 'the request was aborted'))
      if (req.signal?.aborted) return onAbort()
      req.signal?.addEventListener('abort', onAbort, { once: true })
      void opened.then(() => resolve(then()))
    })
  return { fn, release, asked: askedP }
}

/** 对话线第 n 次请求里，某个工具调用的结果。 */
function toolResult(h: AgentHarness, n: number, callId: string): string {
  const messages = h.talk.requests[n]!.messages
  const part = messages[messages.length - 1]!.content.find((p) => p.type === 'tool_result' && p.toolCallId === callId)
  assert.ok(part && part.type === 'tool_result', `no result for ${callId}`)
  return part.content
}

/** 子思维第 n 次请求里，某个工具调用的结果。 */
function helperResult(h: AgentHarness, n: number, callId: string): { content: string; isError: boolean } {
  const messages = h.helper!.requests[n]!.messages
  const part = messages[messages.length - 1]!.content.find((p) => p.type === 'tool_result' && p.toolCallId === callId)
  assert.ok(part && part.type === 'tool_result', `no result for ${callId}`)
  return { content: part.content, isError: part.isError === true }
}

describe('子思维：派出去、想完了交回', () => {
  it('对话线派一个出去：工具马上回编号，这一轮照常结束；子思维用自己的模型、提示词和清单一步步想，想完了交回的话全文作为事件叫醒对话线，不进游戏聊天', async (t) => {
    const h = setup(t)
    h.memory.set('仓库', '主仓库在 (100,64,200)')
    // 交回的话很长：一个字都不能少
    const answer = `结论：做 64 块钢板要 96 个钢锭（卷板机 3 锭出 2 板），主仓库里有 64 个，还差 32 个。\n${'明细：'.repeat(800)}`
    const first = held(() => reply('先看看身上', [{ id: 'k1', name: 'get_status' }]))
    h.helper!.enqueue(first.fn, reply(answer))
    h.talk.enqueue(reply('', [{ id: 'c1', name: 'start_helper', input: { task: TASK } }]), reply('我让一部分心思去算了，回头告诉你。'))
    h.agent.handleEvent(chat('Steve', 'Alu 钢锭够做 64 块钢板吗'))

    // 派出去以后对话线这一轮照常结束，子思维还在想
    await waitFor('the talk turn ended', () => h.talk.requests.length === 2 && h.agent.talk.idle())
    assert.match(toolResult(h, 1, 'c1'), /^Helper h1 is thinking about it now \(at most 40 steps\)\. There is nothing to wait for: when it ends, what it wrote last comes to you whole, as an event that wakes you\. 1 of 3 helpers are thinking now\.$/)
    await first.asked
    assert.equal(h.agent.helpers.busy(), true)

    // 它自己的上下文：子思维的提示词（带着她的记忆，只读）、子思维的清单、对话线写的任务
    const req = h.helper!.requests[0]!
    assert.match(req.system, HELPER_SYSTEM)
    assert.match(req.system, /# 她的记忆（只读，两条线每一轮看到的就是这一份）\n.*主仓库在 \(100,64,200\)/)
    assert.match(req.system, /base_methods 看全部，你这里只能看，要记、要改的写进交回的话里。/)
    assert.equal(req.system.includes('set_base_method'), false)
    const opening = req.messages[0]!.content[0]!
    assert.ok(opening.type === 'text' && opening.text.startsWith(`[交给你的事]（对话线写的）\n${TASK}\n\n[当前状态]（派你出去的那一刻）\n`), JSON.stringify(opening))
    assert.equal(req.messages.length, 1)
    // 对话线的模型没被拿去想子思维的事（子思维有自己的模型）
    assert.ok(h.talk.requests.every((r) => !HELPER_SYSTEM.test(r.system)))

    first.release()
    await waitFor('the talk line was woken by the helper', () => h.talk.requests.length === 3)
    const seen = h.talk.lastUserText(2)
    assert.match(seen, /\[需要你处理的事\]\n\[[\d:]+\] 你派出去的子思维 h1 想完了（2 步，\d+ 秒）。\n/)
    assert.ok(seen.includes(`  交给它的事（你当时写的）：${TASK}\n`))
    assert.ok(seen.includes(`  它交回的话（原样，只有你看得到）：\n${answer}\n`), '交回的话全文都在')
    assert.match(seen, /\[谁在跟你说话\] 这一轮没有人跟你说话。/)
    await h.agent.whenIdle()
    assert.equal(h.agent.helpers.busy(), false)
    // 内部的话：游戏里一句都没说
    assert.deepEqual(h.game.said, [])

    // 活动日志：每一步照两条线的格式记，带着它的编号；模型调用的账 purpose 是 helper
    const mine = h.log.recent(0, 500).filter((e) => e.agent === 'helper')
    assert.ok(mine.length > 0 && mine.every((e) => e.helper === 'h1' && e.turn === undefined))
    assert.deepEqual(mine.filter((e) => e.kind === 'model_call').map((e) => [e.step, e.call?.purpose, e.call?.state]), [[1, 'helper', 'done'], [2, 'helper', 'done']])
    assert.deepEqual(mine.filter((e) => e.kind === 'tool_call').map((e) => [e.step, e.who]), [[1, 'get_status']])
    assert.deepEqual(mine.filter((e) => e.kind === 'model_text').map((e) => e.text), ['先看看身上', answer])
    assert.match(mine.find((e) => e.kind === 'turn')!.text, /^子思维 h1 开始（子思维的模型）：主人 Steve 想做 64 块钢板/)
    const relay = mine.find((e) => e.kind === 'relay')!
    assert.deepEqual([relay.relay, relay.text.startsWith('子思维 h1 → 对话线（想完了）：结论：做 64 块钢板'), relay.detail], [{ type: 'helper', from: 'helper', to: 'talk' }, true, answer])

    // 整个过程存了一份：面板看、helper_status 翻
    const record = h.helperStore.get('h1')!
    assert.deepEqual([record.status, record.steps, record.final, record.task, record.model], ['done', 2, answer, TASK, '子思维的模型'])
    assert.deepEqual(record.transcript.map((s) => [s.n, s.text, s.calls.map((c) => c.name)]), [[1, '先看看身上', ['get_status']], [2, answer, []]])
    assert.match(record.transcript[0]!.calls[0]!.result!, /^Alu/)
    assert.deepEqual(record.usage, { inputTokens: 2000, outputTokens: 100 })
    assert.deepEqual(h.helperStore.state(), { nextId: 2, running: [] })

    // 对话线翻得到：helper_status 给 id 就是全文；read_log 能只看这一个
    const status = (await lineCalls(h, 'talk', 'helper_status', { id: 'h1' })).content
    assert.match(status, /^h1 finished after 2 step\(s\) in \d+ s\.\nTask: /)
    assert.ok(status.includes(`Task: ${TASK}\nWhat it handed back:\n${answer}\nIts whole log: read_log with helper: "h1".`))
    const log = (await lineCalls(h, 'talk', 'read_log', { helper: 'h1', limit: 50 })).content
    assert.match(log, /^Activity log, only helper h1: \d+ entries match;/)
    assert.match(log, / helper h1 step 1 · tool_call get_status:/)
  })

  it('同时最多 3 个：第 4 个如实回“已经有 3 个在想”，列出是哪 3 个、各自的任务；有一个想完了就能再派', async (t) => {
    const h = setup(t)
    const gates = [held(() => reply('一号高炉：缺 12 块耐火砖。')), held(), held()]
    h.helper!.enqueue(...gates.map((g) => g.fn))
    const tasks = ['查一号高炉缺什么\n（主人刚问的）', '查二号高炉缺什么', '设计一个 9×9 的仓库', '算算还要多少铜']
    h.talk.enqueue(reply('', tasks.map((task, n) => ({ id: `c${n + 1}`, name: 'start_helper', input: { task } }))), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 查一下这几件事'))
    await waitFor('the talk turn ended', () => h.talk.requests.length === 2 && h.agent.talk.idle())
    for (const n of [1, 2, 3]) assert.match(toolResult(h, 1, `c${n}`), new RegExp(`^Helper h${n} is thinking about it now .* ${n} of 3 helpers are thinking now\\.$`))
    const refused = toolResult(h, 1, 'c4').split('\n')
    assert.equal(refused[0], 'Not started: 3 helpers are already thinking, the most there can be at once:')
    assert.match(refused[1]!, /^- h1: "查一号高炉缺什么" \(thinking for \d+ s, 0 of at most 40 steps\)$/)
    assert.match(refused[2]!, /^- h2: "查二号高炉缺什么" /)
    assert.match(refused[3]!, /^- h3: "设计一个 9×9 的仓库" /)
    assert.equal(refused[4], 'When one ends, what it found comes to you. helper_status with an id and stop: true stops one.')
    assert.equal(h.agent.helperOverview().running.length, 3)
    assert.equal(h.helperStore.state().nextId, 4)

    // 一号想完了：空出一个位子
    gates[0]!.release()
    await waitFor('h1 ended', () => h.agent.helperOverview().running.length === 2)
    assert.match(h.agent.helpers.access().start('算算还要多少铜'), /^Helper h4 is thinking about it now/)
  })
})

describe('子思维：只查不改', () => {
  // 不能看图的模型：没有 view_area、view_image（和两条线一样）
  const OFFERED = [
    'worker_status', 'get_status', 'look_around', 'scan_area', 'inspect_block', 'find_blocks', 'list_containers', 'get_player_position',
    'list_designs', 'run_program', 'view_draft', 'find_item', 'find_recipes', 'find_in_storage', 'find_machines', 'find_quests', 'get_quest',
    'read_guide', 'task_status', 'base_methods', 'list_manuals', 'read_manual', 'report_problem',
  ]
  const RECORDING = 'records something, and what gets kept is for the talk line (the part of you that sent you) to decide. Put what is worth keeping in what you hand back.'
  const TALKS = 'is the talk line\'s: you do not speak in the game, hand work to the worker or send helpers. What you write last goes back to the talk line, which decides what to say, to whom, and what to hand to the worker.'
  const ACTS = 'acts with the body or changes something in the game or on the brain (publishing or deleting a draft included), and only the worker line does that, when the talk line hands it the job. Say in what you hand back what should be done.'

  it('它的清单里只有查的、run_program 和意见簿：没有说话、交事、再派、动身体、记忆、提醒、基地的做法的记和改、清单、写手册、删和发布草稿；这些都在对话线的清单里', async (t) => {
    const h = setup(t)
    h.helper!.enqueue(reply('没什么可查的。'))
    h.agent.helpers.access().start('看看就行')
    await waitFor('the helper was asked', () => h.helper!.requests.length === 1)
    const names = h.helper!.requests[0]!.tools.map((tool) => tool.name)
    assert.deepEqual([...names].sort(), [...OFFERED].sort())
    for (const name of ['say', 'whisper', 'tell_worker', 'stop_work', 'start_helper', 'helper_status', 'remember', 'forget', 'set_reminder', 'set_base_method', 'todo', 'write_manual', 'publish_draft', 'delete_draft', 'go_to', 'start_routine', 'run_command']) {
      assert.equal(names.includes(name), false, name)
    }
    // 每一个都是对话线也有的（它是对话线只查不改的那一部分）
    for (const tool of HELPER_TOOLS) assert.ok(TALK_TOOLS.includes(tool), tool.name)
    // run_program 后面的库函数索引和对话线一样只有只查不动的
    const run = h.helper!.requests[0]!.tools.find((tool) => tool.name === 'run_program')!.description
    assert.equal(run.includes('haul_items'), false)
    assert.ok(run.includes('- read_log '))
  })

  it('按名字硬调说话、交事、再派、记东西、动身体、删和发布草稿的：一个都不执行，照实告诉它归谁、它该怎么办；程序里调也一样；画草稿和查的照常', async (t) => {
    const tmp = tmpDir()
    const design = new DesignWorkspace({ dataDir: tmp.dir })
    const h = setup(t, { design })
    t.after(tmp.cleanup)
    h.memory.set('仓库', '主仓库在 (100,64,200)')
    const tried: [string, unknown][] = [
      ['remember', { key: 'x', text: 'y' }],
      ['forget', { key: '仓库' }],
      ['set_reminder', { minutes: 1, note: '回来看' }],
      ['set_base_method', { part: 'plate', way: '卷板机' }],
      ['todo', { add: [{ text: '做钢板' }] }],
      ['write_manual', { name: 'plates', summary: 's', body: 'b' }],
      ['say', { text: '大家好' }],
      ['whisper', { player: 'Steve', text: '嘘' }],
      ['tell_worker', { text: '去拿钢锭' }],
      ['stop_work', {}],
      ['start_helper', { task: '再派一个' }],
      ['helper_status', {}],
      ['go_to', { x: 1, y: 64, z: 1 }],
      ['dig_blocks', { blocks: [{ x: 1, y: 64, z: 1 }] }],
      ['publish_draft', { name: 'hut' }],
      ['delete_draft', { name: 'hut' }],
      ['start_routine', { code: 'return 1' }],
      ['haul_items', { from: { x: 0, y: 64, z: 0 }, to: { x: 1, y: 64, z: 1 }, items: [{ id: 'minecraft:coal', count: 1 }] }],
      ['set_home', { name: 'base' }],
    ]
    h.helper!.enqueue(
      // 画一张草稿（设计建筑就是这样画的）
      reply('', [{ id: 'd1', name: 'run_program', input: { code: `blueprint(2, 1, 1).fill(0, 0, 0, 1, 0, 0, 'minecraft:planks').save('hut')\nreturn 'ok'` } }]),
      reply('', tried.map(([name, input], n) => ({ id: `x${n}`, name, input }))),
      reply('', [
        { id: 'p1', name: 'run_program', input: { code: `const r = await tool('remember', { key: 'x', text: 'y' }); const m = await tool('base_methods', {}); return [r.ok, r.text, m.ok]` } },
        { id: 'q1', name: 'base_methods', input: {} },
        { id: 'q2', name: 'read_log', input: { minutes: 10 } },
      ]),
      reply('都查完了。'),
    )
    h.agent.helpers.access().start('试试手')
    await waitFor('the helper finished', () => h.helper!.requests.length === 4)
    await h.agent.whenIdle()

    assert.match(helperResult(h, 1, 'd1').content, /^The program finished in [\d.]+ s\.\nReturned: ok\nSaved draft "hut": 2×1×1/)
    assert.match(helperResult(h, 1, 'd1').content, /\nCheck the design\. The talk line sees only what you hand back: put in the draft's name, .* Publishing and building it are for the worker, once your owner agrees\.$/)
    for (const [n, [name]] of tried.entries()) {
      const res = helperResult(h, 2, `x${n}`)
      const why = ['remember', 'forget', 'set_reminder', 'set_base_method', 'todo', 'write_manual'].includes(name) ? RECORDING : ['say', 'whisper', 'tell_worker', 'stop_work', 'start_helper', 'helper_status'].includes(name) ? TALKS : ACTS
      assert.deepEqual([res.isError, res.content], [true, `Not done: "${name}" ${why}`], name)
    }
    const inProgram = helperResult(h, 3, 'p1').content
    assert.match(inProgram, /Returned: \[false,"remember cannot be called from run_program: a program there can only look things up \(get_status, .*\)\. Acting is the worker line's; say in what you hand back what should be done\.",true\]$/)
    assert.equal(helperResult(h, 3, 'q1').isError, false)
    assert.equal(helperResult(h, 3, 'q2').isError, false)

    // 什么都没变：记忆、提醒、清单、手册、草稿；游戏里没说话、没开任务、没发指令、没传图纸；也没有再派出一个
    assert.deepEqual(h.memory.list().map((n) => n.key), ['仓库'])
    assert.deepEqual([h.reminders, h.todo.list()], [[], []])
    assert.equal(h.manuals.list().some((m) => m.name === 'plates'), false)
    assert.ok(design.drafts.get('hut'))
    for (const method of ['bot.chat', 'task.start', 'task.cancel', 'bot.command', 'blueprint.put']) assert.deepEqual(h.game.callsOf(method), [], method)
    assert.deepEqual([h.agent.helperOverview().running, h.helperStore.state().nextId], [[], 2])
    // 干活线、对话线照样不能把它们当自己的：干活线调派子思维的工具被告知那是对话线的
    const worker = await lineCalls(h, 'work', 'start_helper', { task: '帮我查查' })
    assert.deepEqual([worker.isError, worker.content], [true, 'Not done: "start_helper" is the talk line\'s tool for sending helpers off to think; you are the worker. To tell the talk line something, use report.'])
  })
})

describe('子思维：怎么结束', () => {
  it('到了步数上限：再给它一次不能调工具的机会写交回的话（toolChoice none，消息末尾写明），交回的事件里写着到了上限', async (t) => {
    const h = setup(t, { helperSteps: 3 })
    h.helper!.enqueue(
      reply('钢锭在主仓库', [{ name: 'get_status' }]),
      reply('', [{ name: 'get_status' }]),
      reply('', [{ name: 'get_status' }]),
      reply('结论：钢锭 64 个，还差 32 个；配方没查完。', [{ name: 'find_recipes', input: { query: 'plate' } }]),
    )
    h.agent.helpers.access().start(TASK)
    await waitFor('the talk line was woken', () => h.talk.requests.length === 1)
    await h.agent.whenIdle()
    assert.equal(h.helper!.requests.length, 4)
    assert.deepEqual(h.helper!.requests.map((r) => r.toolChoice), [undefined, undefined, undefined, 'none'])
    assert.match(h.helper!.lastUserText(3), /\n\[系统\] 到了 3 步的上限，这一步调不了工具了（调了也不会执行）。这一步写的话会原样交回给对话线：到现在为止查到的、想到的，和还没查完的。$/)
    const seen = h.talk.lastUserText(0)
    assert.match(seen, /你派出去的子思维 h1 到了步数上限（4 步，\d+ 秒）。到了每个子思维 3 步的上限；这段是它在上限时、不能再调工具的那一步写的。它在这一步还要调 1 个工具，没有执行。\n/)
    assert.ok(seen.includes('  它交回的话（原样，只有你看得到）：\n结论：钢锭 64 个，还差 32 个；配方没查完。'))
    const record = h.helperStore.get('h1')!
    assert.deepEqual([record.status, record.steps, record.transcript.at(-1)!.final], ['limit', 4, true])
    // 不能调工具的那一步要的工具没有执行
    assert.equal(h.log.recent(0, 500).some((e) => e.kind === 'tool_call' && e.who === 'find_recipes'), false)
  })

  it('被对话线停下：helper_status 带 stop，它正在想的那一步被打断；交回它被停下前最后写的话，写明是谁停的、停在第几步', async (t) => {
    const h = setup(t)
    const second = held()
    h.helper!.enqueue(reply('钢锭在主仓库，有 64 个；正在算钢板。', [{ name: 'get_status' }]), second.fn)
    h.talk.enqueue(reply('', [{ id: 'c1', name: 'start_helper', input: { task: TASK } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 钢锭够吗'))
    await second.asked
    await waitFor('the talk turn ended', () => h.agent.talk.idle())
    h.talk.enqueue(reply('', [{ id: 'c2', name: 'helper_status', input: { id: 'h1', stop: true } }]), reply('好，停了。'))
    h.agent.handleEvent(chat('Steve', 'Alu 不用算了'))
    await waitFor('the talk line saw the stop result', () => h.talk.requests.length >= 4)
    assert.equal(toolResult(h, 3, 'c2'), 'Stopping h1. What it has so far comes to you as an event once it has stopped.')
    // 停下的事件可能接在对话线这一轮的工具结果后面，也可能另叫醒它一轮：哪一次请求里有它都行
    const at = await waitFor('the helper event reached the talk line', () => h.talk.requests.findIndex((_, n) => n >= 3 && h.talk.lastUserText(n).includes('子思维 h1 被停下了')) + 1)
    const seen = h.talk.lastUserText(at - 1)
    assert.match(seen, /你派出去的子思维 h1 被停下了（1 步，\d+ 秒）。对话线用 helper_status 停的（停在第 1 步）。下面是它被停下前最后写的话，不一定是结论。\n/)
    assert.ok(seen.includes('  它最后写下的话（原样，只有你看得到）：\n钢锭在主仓库，有 64 个；正在算钢板。'))
    // 想到一半被打断的那一步：日志里是被叫停，不是出错
    const calls = h.log.recent(0, 500).filter((e) => e.agent === 'helper' && e.kind === 'model_call')
    assert.deepEqual(calls.map((e) => [e.step, e.call?.state, e.isError === true]), [[1, 'done', false], [2, 'halted', false]])
    assert.equal(h.helperStore.get('h1')!.status, 'stopped')
    // 再停一次：如实说它已经不在想了
    assert.equal(h.agent.helpers.access().status('h1', true), 'h1 is not thinking any more: it was stopped.')
    assert.equal(h.agent.helpers.access().status('h9', true), 'There is no helper h9.')
  })

  it('模型接口出错、上下文超长、今天的用量到上限：都结束并交回它之前最后写的话，照实写明怎么结束的', async (t) => {
    const h = setup(t, { settings: { dailyTokenLimit: 50_000 } })
    h.helper!.enqueue(reply('看了一半', [{ name: 'get_status' }]), llmDown('context_length'))
    h.agent.helpers.access().start('任务一')
    await waitFor('h1 ended', () => h.helperStore.get('h1') !== undefined)
    h.helper!.enqueue(llmDown('auth'))
    h.agent.helpers.access().start('任务二')
    await waitFor('h2 ended', () => h.helperStore.get('h2') !== undefined)
    // 第一步回来时今天的用量已经过了上限：下一步不再想
    h.helper!.enqueue(() => {
      h.usedTokens.value = 60_000
      return reply('钢锭 64 个', [{ name: 'get_status' }])
    })
    h.agent.helpers.access().start('任务三')
    await waitFor('h3 ended', () => h.helperStore.get('h3') !== undefined)
    assert.deepEqual(['h1', 'h2', 'h3'].map((id) => [h.helperStore.get(id)!.status, h.helperStore.get(id)!.steps, h.helperStore.get(id)!.final ?? null]), [
      ['context', 1, '看了一半'],
      ['failed', 0, null],
      ['budget', 1, '钢锭 64 个'],
    ])
    assert.equal(h.helperStore.get('h1')!.note, '模型接口说上下文太长了（它在第 2 步），子思维不压缩历史，就停在这里。下面是它之前最后写的话。')
    assert.equal(h.helperStore.get('h2')!.note, '模型接口出错（auth (HTTP 401): scripted auth failure），它停在第 1 步。')
    assert.equal(h.helperStore.get('h3')!.note, '今天的模型用量到了上限（50000 token，两条线和子思维合计），它停在第 1 步。下面是它之前最后写的话。')
    // 每个都交回了对话线（它这时也想不了：额度用完了，事件留作背景，下次醒来看得到）
    const ended = h.log.recent(0, 500).filter((e) => e.kind === 'relay' && e.relay?.type === 'helper')
    assert.deepEqual(ended.map((e) => [e.helper, e.isError === true]), [['h1', true], ['h2', true], ['h3', true]])
  })
})

describe('子思维：和别处的关系', () => {
  it('对话线每一轮的“当前状态”里列着在想的子思维：编号、在干什么、几步了、多久、任务的第一行；都想完了就不列', async (t) => {
    const h = setup(t)
    const gate = held(() => reply('算完了'))
    h.helper!.enqueue(reply('', [{ name: 'get_status' }]), gate.fn)
    h.agent.helpers.access().start(TASK)
    await gate.asked
    h.agent.handleEvent(chat('Steve', 'Alu 你在干嘛'))
    await waitFor('the talk line was asked', () => h.talk.requests.length === 1)
    assert.match(h.talk.lastUserText(0), /\n子思维（你派出去想事的，最多 3 个同时在想；想完了交回的话会叫醒你）：\n {2}h1：在想第 2 步（最多 40 步），已经 \d+ 秒——「主人 Steve 想做 64 块钢板，问仓库里的钢锭够不够。」\n/)
    gate.release()
    await waitFor('the helper woke the talk line', () => h.talk.requests.length === 2)
    assert.equal(h.talk.lastUserText(1).includes('子思维（你派出去想事的'), false)
  })

  it('有子思维在想就不自动下线（和工作清单上有没做的一个道理）；它想完了、对话线也看完了，照常过 5 分钟下线', async (t) => {
    const h = setup(t)
    const gate = held(() => reply('算完了'))
    h.helper!.enqueue(gate.fn)
    const MIN = 60_000
    const world = { now: 1_000_000, calls: [] as string[], away: false }
    const presence = new Presence({
      settings: () => ({ botName: 'Alu', wantOnline: true, enabled: true, idleMinutes: 5, away: world.away }),
      setAway: (away) => (world.away = away),
      bridge: {
        serverInfo: async () => ({ players: [{ name: 'Alu', isBot: true }] }),
        taskList: async () => ({ active: null, queue: [] }),
        botStatus: async () => ({ online: !world.away }),
        botSpawn: async () => (world.calls.push('spawn'), {}),
        botDespawn: async () => (world.calls.push('despawn'), {}),
      },
      connected: () => true,
      online: () => !world.away,
      busy: () => h.agent.busy(),
      log: () => {},
      now: () => world.now,
    })
    const after = async (minutes: number): Promise<void> => {
      world.now += minutes * MIN
      await presence.tick()
    }
    await presence.onReady()
    h.agent.helpers.access().start(TASK)
    await gate.asked
    await after(0)
    await after(10)
    assert.deepEqual(world.calls, [], '子思维在想')
    gate.release()
    await waitFor('the talk line looked at what it handed back', () => h.talk.requests.length === 1)
    await h.agent.whenIdle()
    await after(0)
    await after(5)
    assert.deepEqual(world.calls, ['despawn'])
  })

  it('没给子思维单独选模型：用对话线的模型想（请求里是子思维的提示词和清单）', async (t) => {
    const h = makeAgent()
    t.after(async () => {
      await h.agent.stop()
      h.cleanup()
    })
    h.talk.auto = (seen, req) => {
      if (HELPER_SYSTEM.test(req.system)) return reply('结论：够。')
      if (seen.includes('Alu 帮我算算')) return reply('', [{ name: 'start_helper', input: { task: TASK } }])
      return reply('')
    }
    h.agent.handleEvent(chat('Steve', 'Alu 帮我算算钢锭'))
    await waitFor('the helper handed back', () => h.helperStore.get('h1')?.status === 'done')
    await h.agent.whenIdle()
    const asked = h.talk.requests.filter((r) => HELPER_SYSTEM.test(r.system))
    assert.equal(asked.length, 1)
    assert.ok(asked[0]!.tools.some((tool) => tool.name === 'find_recipes') && !asked[0]!.tools.some((tool) => tool.name === 'say'))
    assert.ok(h.talk.requests.some((r) => !HELPER_SYSTEM.test(r.system) && h.talk.lastUserText(h.talk.requests.indexOf(r)).includes('你派出去的子思维 h1 想完了')))
  })

  it('配置：子思维的模型没选时是空的（用对话线的，不存成对话线的 id）；选了就是那个；选的那家删掉了又回到没选', () => {
    const provider = { id: 'p1', kind: 'openai-chat', label: '主力', baseUrl: 'https://api.example.com/v1', apiKey: 'k', models: [{ id: 'm1', name: 'gpt-a', label: '' }, { id: 'm2', name: 'gpt-b', label: '' }] }
    const old = normalizeConfig({ providers: [provider], activeProviderId: 'p1', activeModelId: 'm1', talkProviderId: 'p1', talkModelId: 'm2' })
    assert.deepEqual([old.helperProviderId, old.helperModelId, old.bot.limits.helperMaxSteps], ['', '', 40])
    const tmp = tmpDir()
    try {
      const config = new ConfigStore(tmp.dir)
      config.update((c) => {
        c.providers = [provider as never]
        c.talkProviderId = 'p1'
        c.talkModelId = 'm2'
      })
      assert.equal(config.helperSelection(), undefined)
      config.update((c) => {
        c.helperProviderId = 'p1'
        c.helperModelId = 'm1'
      })
      assert.equal(config.helperProvider()?.model, 'gpt-a')
      config.update((c) => (c.providers = []))
      assert.deepEqual([config.get().helperProviderId, config.helperSelection()], ['', undefined])
    } finally {
      tmp.cleanup()
    }
  })
})

describe('子思维：大脑重启', () => {
  it('重启时在想的没了：停下时落一个小文件，启动后告诉对话线哪几个没想完（一起叫醒一次），编号接着数；被强杀没来得及收尾的也一样', async (t) => {
    const h = makeAgent({ helper: true })
    t.after(h.cleanup)
    const gates = [held(), held()]
    h.helper!.enqueue(reply('看了一半', [{ name: 'get_status' }]), gates[0]!.fn, gates[1]!.fn)
    h.agent.helpers.access().start(TASK)
    h.agent.helpers.access().start('设计一个 9×9 的仓库')
    await Promise.all(gates.map((g) => g.asked))
    await h.agent.stop()
    const kept = h.helperStore.state()
    assert.deepEqual([kept.nextId, kept.running.map((r) => r.id)], [3, ['h1', 'h2']])
    // 面板上看得到它们没想完，想到的那几步也在
    assert.equal(h.helperStore.get('h1')!.status, 'interrupted')

    const h2 = h.restart()
    t.after(() => h2.agent.stop())
    await waitFor('the talk line was told', () => h.talk.requests.length === 1)
    await h2.agent.whenIdle()
    const seen = h.talk.lastUserText(0)
    assert.match(seen, /你派出去的子思维 h1 没想完：大脑重启了，它想到的都没了（\d 步，\d+ 秒）。要的话重新派一个。\n {2}交给它的事（你当时写的）：主人 Steve/)
    assert.match(seen, /你派出去的子思维 h2 没想完：大脑重启了，它想到的都没了/)
    // 编号接着数：下一个是 h3，不会和日志里的 h1、h2 重号
    assert.deepEqual(h2.helperStore.state(), { nextId: 3, running: [] })
    await h2.agent.stop()

    // 被强杀：只有那个小文件，没有收尾时存的记录
    const store = new HelperStore(h.dir)
    store.saveState({ nextId: 9, running: [{ id: 'h8', task: '旧的任务', startedAt: Date.now() - 60_000, steps: 5, updatedAt: Date.now() - 30_000 }] })
    const before = h.talk.requests.length
    const h3 = h.restart()
    t.after(() => h3.agent.stop())
    await waitFor('the talk line was told again', () => h.talk.requests.length === before + 1)
    assert.match(h.talk.lastUserText(before), /你派出去的子思维 h8 没想完：大脑重启了，它想到的都没了（5 步，30 秒）。/)
    assert.deepEqual([h3.helperStore.get('h8')!.status, h3.helperStore.get('h8')!.steps], ['interrupted', 5])
  })
})
