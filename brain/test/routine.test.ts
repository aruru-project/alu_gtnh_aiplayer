// 例程：模型写的程序在后台跑，程序里一个个调工具；做完、出错、被停或者碰到上限时再把模型叫醒。
// 入口是模型用的工具（start_routine、routine_status、stop_routine、run_program）；游戏是按方法名应答的假服务器，
// 模型是按脚本回应的假模型，沙箱是真的（每个程序起一个子进程）。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DesignWorkspace } from '../src/design/index.ts'
import type { RoutineLimits } from '../src/agent/routine.ts'
import { chat, makeAgent, reply, taskEnded } from './agent-harness.ts'
import type { AgentHarness } from './agent-harness.ts'
import { tmpDir, waitFor } from './helpers.ts'

function setup(t: { after(fn: () => void): void }, limits: Partial<RoutineLimits> = {}) {
  const tmp = tmpDir()
  const h = makeAgent({ dir: tmp.dir, design: new DesignWorkspace({ dataDir: tmp.dir }), routineLimits: limits })
  t.after(async () => {
    await h.agent.stop()
    tmp.cleanup()
  })
  // 抽屉管理器管着三格：两格不到 128 个
  h.game.handlers['world.drawers'] = (p) => ({
    controller: { x: 1, y: 64, z: 1 },
    drawers: 2,
    slotsTotal: 4,
    slotsUsed: 3,
    slots: [
      { x: 2, y: 64, z: 1, slot: 0, id: 'minecraft:coal', meta: 0, name: 'Coal', count: 40, room: 2008 },
      { x: 3, y: 64, z: 1, slot: 1, id: 'gregtech:gt.metaitem.01', meta: 11305, name: 'Steel Ingot', count: 7, room: 2041 },
    ].filter((s) => typeof p.below !== 'number' || s.count < p.below),
    total: 2,
    offset: 0,
  })
  return h
}

/** 让模型在一轮里调一个工具，等这一轮跑完，返回那个工具的结果。 */
async function modelCalls(h: AgentHarness, name: string, input: unknown, said = 'Alu 干活'): Promise<string> {
  const before = h.llm.requests.length
  h.llm.enqueue(reply('', [{ id: `c${before}`, name, input }]), reply(''))
  h.agent.handleEvent(chat('Steve', said))
  await waitFor(`the model saw the result of ${name}`, () => h.llm.requests.length >= before + 2)
  const messages = h.llm.requests[before + 1]!.messages
  const part = messages[messages.length - 1]!.content.find((p) => p.type === 'tool_result' && p.toolCallId === `c${before}`)
  return part && part.type === 'tool_result' ? part.content : ''
}

/** 等例程开出第 n 个任务（身体回的 id 是 t1、t2……）。 */
const taskStarted = (h: AgentHarness, n: number) => waitFor(`task ${n} started`, () => h.game.callsOf('task.start').length >= n, 5000)

// 主人的那个用例：把抽屉里不到 128 个的东西都取出来，放进一个箱子
const TIDY = `
const found = await tool('list_drawers', { x: 1, y: 64, z: 1, below: 128 })
log('slots below 128:', found.data.slots.length)
let moved = 0
for (const s of found.data.slots) {
  const took = await tool('withdraw_items', { container: { x: s.x, y: s.y, z: s.z }, items: [{ id: s.id, meta: s.meta, count: s.count }] })
  if (!took.ok) { log('could not take', s.id, took.text); continue }
  moved += took.data.result.moved
}
const put = await tool('deposit_items', { container: { x: 9, y: 64, z: 9 } })
log('deposited', put.ok)
return moved
`

describe('例程', () => {
  it('程序一步步调工具：查询的直接拿到数据，开任务的等任务做完才往下走；做完把模型叫醒一次，带着每一步和它的日志', async (t) => {
    const h = setup(t)
    const started = await modelCalls(h, 'start_routine', { code: TIDY, name: '整理抽屉' })
    assert.match(started, /^Routine r1 \("整理抽屉"\) started in the background\. End your turn now: you will be woken when it finishes, fails or is stopped/)
    await h.agent.whenIdle()
    const turnsBefore = h.llm.requests.length

    // 第一步是查询（world.drawers），接着开了第一个取货任务，然后停在那里等
    await taskStarted(h, 1)
    assert.deepEqual(h.game.callsOf('world.drawers'), [{ x: 1, y: 64, z: 1, below: 128, offset: 0, limit: 60 }])
    assert.deepEqual(h.game.callsOf('task.start')[0], { bot: 'Alu', task: { type: 'withdraw', container: { x: 2, y: 64, z: 1 }, items: [{ id: 'minecraft:coal', meta: 0, count: 40 }] }, mode: 'replace' })
    // 模型这时可以看进度
    const status = await modelCalls(h, 'routine_status', {}, 'Alu 做到哪了')
    assert.match(status, /^Routine r1 \("整理抽屉"\) is running\. 2 tool call\(s\), 1 task\(s\), \d+ s so far\.\nNow waiting for: withdraw_items .*\(task t1\), for \d+ s\./)
    assert.match(status, /- #1 list_drawers \{"x":1,"y":64,"z":1,"below":128\} → The drawer controller at \(1,64,1\) manages 2 drawer block\(s\)/)
    assert.match(status, /Its log \(last 1 line\(s\)\):\n {2}slots below 128: 2/)
    const afterStatus = h.llm.requests.length

    // 任务一个个做完：例程自己接着走，不为每个任务叫醒模型
    h.agent.handleEvent(taskEnded('t1', 'done', { type: 'withdraw', result: { moved: 40 } }))
    await taskStarted(h, 2)
    assert.equal((h.game.callsOf('task.start')[1]!.task as { container: unknown }).container !== undefined, true)
    h.agent.handleEvent(taskEnded('t2', 'done', { type: 'withdraw', result: { moved: 7 } }))
    await taskStarted(h, 3)
    assert.deepEqual(h.game.callsOf('task.start')[2]!.task, { type: 'deposit', container: { x: 9, y: 64, z: 9 } })
    assert.equal(h.llm.requests.length, afterStatus, 'the model is not woken for the tasks of the routine')
    h.llm.enqueue(reply('', [{ name: 'say', input: { message: '搬完了，47 个。' } }]), reply(''))
    h.agent.handleEvent(taskEnded('t3', 'done', { type: 'deposit', result: { moved: 47 } }))

    // 做完：叫醒模型一次，消息里是结局、返回值、每一步和日志
    await waitFor('the model was woken with the outcome', () => h.game.said.includes('搬完了，47 个。'))
    const woken = h.llm.lastUserText(afterStatus)
    assert.match(woken, /你启动的例程有结果了/)
    assert.match(woken, /Routine r1 \("整理抽屉"\) finished: the program finished\. 4 tool call\(s\), 3 task\(s\), \d+ s in all\.\nIt returned: 47\n/)
    assert.match(woken, /- #2 withdraw_items .* → t1 withdraw \[done\] result=\{"moved":40\}/)
    assert.match(woken, /- #4 deposit_items \{"container":\{"x":9,"y":64,"z":9\}\} → t3 deposit \[done\] result=\{"moved":47\}/)
    assert.match(woken, /Its log \(last 2 line\(s\)\):\n {2}slots below 128: 2\n {2}deposited true/)
    assert.equal(turnsBefore > 0, true)

    // 面板的对话日志里看得到例程的每一步
    const log = h.log.recent(0, 200)
    assert.ok(log.some((e) => e.kind === 'info' && e.text === '例程 r1（整理抽屉）开始在后台跑。' && e.detail === TIDY))
    assert.deepEqual(log.filter((e) => e.kind === 'tool_call' && e.text.startsWith('[例程 r1]')).map((e) => e.who), ['list_drawers', 'withdraw_items', 'withdraw_items', 'deposit_items'])
    assert.ok(log.some((e) => e.kind === 'tool_result' && e.who === 'deposit_items' && /^\[例程 r1\] t3 deposit \[done\]/.test(e.text)))
    assert.ok(log.some((e) => e.kind === 'info' && e.text.startsWith('例程 r1（整理抽屉）跑完了')))
  })

  it('例程里的工具和模型自己调是同一条路：参数不对一样被拒，程序拿到的是失败的结果；例程里不能再开例程、再跑程序', async (t) => {
    const h = setup(t)
    await modelCalls(h, 'start_routine', {
      code: `
        const bad = await tool('withdraw_items', { container: { x: 1 } })
        const nested = await tool('start_routine', { code: 'return 1' })
        const unknown = await tool('fly_to_the_moon', {})
        return [bad.ok, bad.text, nested.text, unknown.ok].join(' | ')`,
    })
    await waitFor('the routine ended', () => h.agent.status().routine?.status !== 'running')
    const view = h.agent.status().routine!
    assert.equal(view.status, 'limit')
    // 连着三次失败：停下
    assert.match(view.ending!, /^3 tool calls failed in a row; the last: There is no tool named "fly_to_the_moon"/)
    assert.deepEqual(view.recent.map((c) => [c.tool, c.ok, c.result.slice(0, 40)]), [
      ['withdraw_items', false, 'Invalid arguments for withdraw_items: it'],
      ['start_routine', false, 'start_routine cannot be called from insi'],
      ['fly_to_the_moon', false, 'There is no tool named "fly_to_the_moon"'],
    ])
    assert.match(view.recent[0]!.result, /^Invalid arguments for withdraw_items:/)
    assert.equal(h.game.callsOf('task.start').length, 0)
  })

  it('上限：总时长到了、调用次数到了、程序自己算个没完，都会停下并叫醒模型，说清是哪个上限', async (t) => {
    // 总时长：给它 1 分钟的话太久，这里把上限调成 300 毫秒；它卡在等任务上
    const slow = setup(t, { wallMs: 300 })
    await modelCalls(slow, 'start_routine', { code: `await tool('go_to', { x: 5, z: 5 }); return 'done'` })
    await waitFor('stopped at the time limit', () => slow.agent.status().routine?.status === 'limit')
    assert.match(slow.agent.status().routine!.ending!, /^it ran for 0 minutes, the time it was given$/)
    // 它正等着的任务被取消了
    assert.deepEqual(slow.game.callsOf('task.cancel'), [{ bot: 'Alu', id: 't1' }])
    await waitFor('the model was woken', () => /was STOPPED at a limit: it ran for/.test(slow.llm.lastUserText(slow.llm.requests.length - 1)))

    const chatty = setup(t, { calls: 3 })
    await modelCalls(chatty, 'start_routine', { code: `for (let i = 0; i < 10; i++) await tool('get_status'); return 'never'` })
    await waitFor('stopped at the call limit', () => chatty.agent.status().routine?.status === 'limit')
    assert.deepEqual([chatty.agent.status().routine!.ending, chatty.agent.status().routine!.calls], ['it made 3 tool calls, the most a routine may make', 3])

    const busy = setup(t, { computeMs: 300 })
    await modelCalls(busy, 'start_routine', { code: `await tool('get_status'); for (;;) {}` })
    await waitFor('stopped for computing too long', () => busy.agent.status().routine?.status === 'limit', 8000)
    assert.match(busy.agent.status().routine!.ending!, /^the program itself computed for more than 0\.3 s \(waiting for tools is not counted\)/)

    const broken = setup(t)
    await modelCalls(broken, 'start_routine', { code: `const x = await tool('get_status')\nx.data.nope.deeper` })
    await waitFor('failed', () => broken.agent.status().routine?.status === 'failed')
    assert.match(broken.agent.status().routine!.ending!, /^the program failed at line 2: TypeError: /)
  })

  it('停：模型用 stop_routine、主人在面板上点停止、或者有人取消了它正在做的任务，例程都停下，它开的任务被取消', async (t) => {
    const h = setup(t)
    const WALK = `await tool('go_to', { x: 50, z: 50 }); await tool('go_to', { x: 0, z: 0 }); return 'back'`
    await modelCalls(h, 'start_routine', { code: WALK, name: '来回走' })
    await taskStarted(h, 1)
    assert.match(await modelCalls(h, 'start_routine', { code: 'return 1' }, 'Alu 再来一个'), /^routine r1 \("来回走"\) is still running: wait for it, or stop it with stop_routine$/)
    assert.equal(await modelCalls(h, 'stop_routine', {}, 'Alu 停'), 'The routine was stopped. You will be woken with its log.')
    assert.deepEqual([h.agent.status().routine!.status, h.agent.status().routine!.ending], ['stopped', 'you stopped it with stop_routine'])
    assert.deepEqual(h.game.callsOf('task.cancel'), [{ bot: 'Alu', id: 't1' }])
    // 停了以后不会再开第二个任务
    h.agent.handleEvent(taskEnded('t1', 'canceled', { type: 'goto' }))
    await h.agent.whenIdle()
    assert.equal(h.game.callsOf('task.start').length, 1)
    assert.equal(await modelCalls(h, 'stop_routine', {}, 'Alu 再停'), 'No routine is running.')

    // 主人在面板上停
    await modelCalls(h, 'start_routine', { code: WALK }, 'Alu 再走')
    await taskStarted(h, 2)
    assert.equal(h.agent.stopRoutine(), true)
    assert.deepEqual([h.agent.status().routine!.id, h.agent.status().routine!.status, h.agent.status().routine!.ending], ['r2', 'stopped', 'your owner stopped it on the control panel'])
    assert.equal(h.agent.stopRoutine(), false)

    // 它正在做的任务被别人取消了（主人在面板上取消任务、模型另开了任务）
    await h.agent.whenIdle()
    await modelCalls(h, 'start_routine', { code: WALK }, 'Alu 第三次')
    await taskStarted(h, 3)
    h.agent.handleEvent(taskEnded('t3', 'canceled', { type: 'goto' }))
    await waitFor('stopped because its task was canceled', () => h.agent.status().routine?.status === 'stopped')
    assert.equal(h.agent.status().routine!.ending, 'its task t3 (goto) was canceled by someone else')
    assert.equal(h.game.callsOf('task.start').length, 3)
  })

  it('run_program 的程序也能调工具，但只许查询的：结果当场回来；想开任务会被拒绝并指到 start_routine', async (t) => {
    const h = setup(t)
    const result = await modelCalls(h, 'run_program', {
      code: `
        const found = await tool('list_drawers', { x: 1, y: 64, z: 1 })
        const walk = await tool('go_to', { x: 1, z: 1 })
        return found.data.slots.map((s) => s.count).join('+') + ' / ' + walk.ok + ' / ' + walk.text.slice(0, 60)`,
    })
    assert.match(result, /^The program finished in [\d.]+ s\.\nReturned: 40\+7 \/ false \/ go_to cannot be called from run_program: a program there can$/)
    assert.equal(h.game.callsOf('task.start').length, 0)
    assert.equal(h.agent.status().routine, undefined)
    assert.ok(h.log.recent(0, 100).some((e) => e.kind === 'tool_call' && e.who === 'list_drawers' && e.text.startsWith('[程序] ')))
  })
})
