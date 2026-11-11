// 工作清单（store/todo.ts、tools/todo.ts、agent/lines.ts 里叫醒干活线的那一段）：主人一次交代了一串事，
// “还要做什么”记在一张两条线都能看、都能改的清单上，不只留在对话历史里。
// 入口是整个 agent（h.agent）：模型调工具 todo、每一轮的“当前状态”、干活线停下来以后被叫醒；自动下线用真的 Presence 接上 h.agent.busy()。
// 面板接口（/api/todo）在 panel.test.ts。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Presence } from '../src/agent/presence.ts'
import { TODO_NUDGE_MAX } from '../src/agent/lines.ts'
import { LlmError } from '../src/llm/index.ts'
import { TODO_DONE_KEPT } from '../src/store/todo.ts'
import { chat, lineCalls, makeAgent, reply, told } from './agent-harness.ts'
import type { AgentHarness, MakeAgentOptions } from './agent-harness.ts'
import { sleep, waitFor } from './helpers.ts'

/** 大脑的钟：2025-01-15 22:30（本地时间）起，测试自己往前拨。 */
const T0 = new Date(2025, 0, 15, 22, 30).getTime()
const MIN = 60_000

function setup(t: { after(fn: () => void | Promise<void>): void }, opts: MakeAgentOptions = {}) {
  const clock = { t: T0 }
  const h = makeAgent({ now: () => clock.t, ...opts })
  t.after(async () => {
    await h.agent.stop()
    h.cleanup()
  })
  return { h, clock }
}

/** 一次请求的“当前状态”里，工作清单那几行（到 Real time 为止）；没有就是 undefined。 */
function listInState(text: string): string[] | undefined {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('To-do list (todo;'))
  if (start < 0) return undefined
  const end = lines.findIndex((l, i) => i > start && l.startsWith('Real time:'))
  return lines.slice(start, end)
}

/** 干活线因为清单被叫醒的那几次：每次那一轮开头看到的那句话。 */
function nudges(h: AgentHarness): string[] {
  return h.llm.requests.map((_, i) => h.llm.lastUserText(i)).flatMap((text) => text.split('\n').filter((l) => l.includes('[系统] 你停下来了')).map((l) => l.replace(/^\[[\d:]+\] /, '')))
}

describe('工作清单：两条线写、看', () => {
  it('对话线加的、干活线改的是同一张；结果是整张清单，写明这次改了什么、谁什么时候写的；两条线每一轮的“当前状态”里都列着没做完的、在等人的和最近做完的', async (t) => {
    // 叫醒干活线的那一段这里不看：等得够久，测试期间不会发生
    const { h, clock } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    const added = await lineCalls(h, 'talk', 'todo', {
      add: [{ text: '把东边箱子里的钢锭搬进仓库' }, { text: '修二号高炉', note: '主人说不急' }, { text: '挖完北边的矿洞' }],
    })
    assert.deepEqual(added.content.split('\n'), [
      'Changed: added #1, #2, #3.',
      'To-do list: 3 not done, 0 waiting, 0 done.',
      '- #1 not done: 把东边箱子里的钢锭搬进仓库 (the talk line, 22:30)',
      '- #2 not done: 修二号高炉 (the talk line, 22:30) — note: 主人说不急',
      '- #3 not done: 挖完北边的矿洞 (the talk line, 22:30)',
    ])
    clock.t += 2 * MIN
    const changed = await lineCalls(h, 'work', 'todo', { change: [{ id: 1, state: 'done' }, { id: 2, waitingFor: 'Steve 把高炉的钥匙给我' }, { id: 3, note: '矿洞口有岩浆' }] })
    assert.deepEqual(changed.content.split('\n'), [
      'Changed: #1 marked done; #2 marked waiting; #3 changed.',
      'To-do list: 1 not done, 1 waiting, 1 done.',
      '- #2 waiting for Steve 把高炉的钥匙给我: 修二号高炉 (the talk line, 22:30) — note: 主人说不急',
      '- #3 not done: 挖完北边的矿洞 (the talk line, 22:30) — note: 矿洞口有岩浆',
      'Done (latest first):',
      '- #1 done 22:32: 把东边箱子里的钢锭搬进仓库',
    ])
    // 存下的是谁写的、谁改的
    assert.deepEqual(
      h.todo.list().map((i) => [i.id, i.state, i.by, i.changedBy ?? null]),
      [
        [1, 'done', 'talk', 'work'],
        [2, 'waiting', 'talk', 'work'],
        [3, 'open', 'talk', 'work'],
      ],
    )
    // 不带参数：就是看
    clock.t += MIN
    const looked = await lineCalls(h, 'talk', 'todo', {})
    assert.equal(looked.content, changed.content.split('\n').slice(1).join('\n'))
    // 两条线下一轮开头的“当前状态”里都列着
    const expected = [
      'To-do list (todo; the same list for both lines and your owner): 1 not done, 1 waiting, 1 done',
      '- #2 waiting for Steve 把高炉的钥匙给我: 修二号高炉 (the talk line, 22:30) — note: 主人说不急',
      '- #3 not done: 挖完北边的矿洞 (the talk line, 22:30) — note: 矿洞口有岩浆',
      'Latest done:',
      '- #1 done 22:32: 把东边箱子里的钢锭搬进仓库',
    ]
    assert.deepEqual(listInState(h.talk.lastUserText(h.talk.requests.length - 2)), expected)
    h.agent.handleEvent(told('高炉的事先放着'))
    await h.agent.whenIdle()
    assert.deepEqual(listInState(h.llm.lastUserText(h.llm.requests.length - 1)), expected)
  })

  it('一次改动里有一处不对，整次不做，说清哪几处；做完的只留最近 20 条，清掉的照实列出', async (t) => {
    const { h, clock } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    await lineCalls(h, 'work', 'todo', { add: [{ text: '搬钢锭' }, { text: '修高炉' }] })
    const refused = await lineCalls(h, 'work', 'todo', { change: [{ id: 1, state: 'done' }, { id: 2, state: 'waiting' }, { id: 9, text: '别的' }] })
    assert.equal(refused.isError, true)
    assert.equal(refused.content, 'Nothing was changed: #2: "waiting" needs waitingFor: who or what it waits for. #9 is not on the list.')
    assert.deepEqual(h.todo.list().map((i) => i.state), ['open', 'open'])
    // 一条一条做完：做完的第 21 条进来时，最早做完的那条清掉
    const many = Array.from({ length: TODO_DONE_KEPT }, (_, i) => ({ text: `第 ${i + 3} 件` }))
    await lineCalls(h, 'work', 'todo', { add: many })
    for (let id = 1; id <= TODO_DONE_KEPT; id++) {
      clock.t += MIN
      h.todo.apply({ change: [{ id, state: 'done' }] }, 'work', clock.t)
    }
    clock.t += MIN
    const res = await lineCalls(h, 'work', 'todo', { change: [{ id: 21, state: 'done' }] })
    assert.equal(res.content.split('\n')[0], 'Changed: #21 marked done; cleared #1 (only the latest done ones are kept).')
    assert.deepEqual(
      h.todo.list().filter((i) => i.state === 'done').map((i) => i.id),
      Array.from({ length: TODO_DONE_KEPT }, (_, i) => i + 2),
    )
    // 做完的重新打开
    const reopened = await lineCalls(h, 'talk', 'todo', { change: [{ id: 21, state: 'open' }] })
    assert.equal(reopened.content.split('\n')[0], 'Changed: #21 reopened.')
    assert.equal(h.todo.list().find((i) => i.id === 21)?.doneAt, undefined)
  })

  it('重启以后清单还在：状态里照样列着，编号接着往下排', async (t) => {
    const { h } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    await lineCalls(h, 'talk', 'todo', { add: [{ text: '把东边箱子里的钢锭搬进仓库' }, { text: '修二号高炉' }] })
    await h.agent.stop()
    const again = h.restart({ timing: { todoNudgeMs: 600_000 }, now: () => T0 })
    t.after(() => again.agent.stop())
    again.agent.handleEvent(told('接着干'))
    await again.agent.whenIdle()
    assert.deepEqual(listInState(again.llm.lastUserText(again.llm.requests.length - 1)), [
      'To-do list (todo; the same list for both lines and your owner): 2 not done, 0 waiting, 0 done',
      '- #1 not done: 把东边箱子里的钢锭搬进仓库 (the talk line, 22:30)',
      '- #2 not done: 修二号高炉 (the talk line, 22:30)',
    ])
    const added = await lineCalls(again, 'work', 'todo', { add: [{ text: '挖矿洞' }] })
    assert.equal(added.content.split('\n')[0], 'Changed: added #3.')
  })
})

describe('工作清单：提示词', () => {
  it('两条线的提示词里写着有这张清单（只写事实）：两条线和主人共用、每一轮都看得到、有没做的不自动下线、干活线停下来时会被叫醒', async (t) => {
    const { h } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    await lineCalls(h, 'talk', 'todo', {})
    await lineCalls(h, 'work', 'todo', {})
    const common = '- 工作清单（todo）：两条线和主人共用一张，不随历史压缩丢，没做完的每一轮都列在“当前状态”里。一次交代了好几件、一轮做不完的事可以记在上面。清单上有没做的（在等人的不算）就不会自动下线；'
    assert.ok((h.talk.requests[0]!.system ?? '').includes(`${common}干活线停下来时，还有没做的会叫醒它一次。\n`))
    assert.ok((h.llm.requests[0]!.system ?? '').includes(`${common}你停下来时（没有任务、例程、在等的回答），还有没做的会叫醒你一次。\n`))
  })
})

describe('工作清单：自动下线', () => {
  /** 一个只有它自己在线、什么任务都没有的服务器上的 Presence，“手上有没有事”问的是真的两条线。 */
  function presenceOf(h: AgentHarness) {
    const world = { now: 0, away: false, calls: [] as string[], onInfo: undefined as (() => void) | undefined }
    const presence = new Presence({
      settings: () => ({ botName: 'Alu', wantOnline: true, enabled: true, idleMinutes: 5, away: world.away }),
      setAway: (away) => (world.away = away),
      bridge: {
        serverInfo: async () => {
          world.onInfo?.()
          return { players: [{ name: 'Alu', isBot: true }] }
        },
        taskList: async () => ({ active: null, queue: [] }),
        botStatus: async () => ({ online: !world.away }),
        botSpawn: async () => {
          world.calls.push('spawn')
          return {}
        },
        botDespawn: async () => {
          world.calls.push('despawn')
          return {}
        },
      },
      connected: () => true,
      online: () => !world.away,
      busy: () => h.agent.busy(),
      log: () => {},
      now: () => world.now,
    })
    const after = async (minutes: number) => {
      world.now += minutes * MIN
      await presence.tick()
    }
    return { world, presence, after }
  }

  it('清单上有没做的就不下线；剩下的都标成在等人了，照样过 5 分钟下线', async (t) => {
    const { h } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    const p = presenceOf(h)
    await p.presence.onReady()
    h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'owner', T0)
    await p.after(0)
    await p.after(10)
    assert.deepEqual(p.world.calls, [])
    h.todo.apply({ change: [{ id: 1, waitingFor: 'Steve 把钥匙给我' }] }, 'talk', T0)
    await p.after(0)
    await p.after(5)
    assert.deepEqual(p.world.calls, ['despawn'])
  })

  it('下线前再看一遍：就在那一会儿清单上多了一件没做的，不下线', async (t) => {
    const { h } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    const p = presenceOf(h)
    await p.presence.onReady()
    await p.after(0)
    // 满 5 分钟要下线了，下线前问服务器上有谁的那一刻，主人在面板上加了一件
    p.world.onInfo = () => h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'owner', T0)
    await p.after(5)
    assert.deepEqual([p.world.calls, p.world.away], [[], false])
  })
})

describe('工作清单：干活线停下来以后被叫醒', () => {
  const NUDGE_2 = '[系统] 你停下来了（身体上没有在跑或排着的任务、没有例程、也没有在等的回答），工作清单上还有 2 件没做完、也没标成在等人：#1 把东边箱子里的钢锭搬进仓库、#2 挖完北边的矿洞'

  it('它记下两件就停了：过一小会儿叫醒它一次，列出没做的；它什么都没改又停了，不再叫。主人勾掉一件不叫（收拾清单不该把它叫起来）；多了一件没做的、或者它为别的事走了一轮，再叫', async (t) => {
    const { h } = setup(t)
    h.llm.enqueue(reply('', [{ name: 'todo', input: { add: [{ text: '把东边箱子里的钢锭搬进仓库' }, { text: '挖完北边的矿洞' }] } }]), reply('先记在清单上了'))
    h.agent.handleEvent(told('先把这两件记下'))
    await waitFor('the worker was woken by the list', () => h.llm.requests.length >= 3)
    assert.deepEqual(nudges(h), [NUDGE_2])
    // 被叫醒的这一轮它什么都没做（假模型回空）：之后不再叫
    await sleep(200)
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 3)
    // 主人在面板上把 #1 勾掉、给 #2 加个备注：清单上没多出没做的，不叫
    h.todo.apply({ change: [{ id: 1, state: 'done' }, { id: 2, note: '不急' }] }, 'owner', T0)
    await sleep(200)
    assert.equal(h.llm.requests.length, 3)
    // 叫醒时就在的 #2 被标成在等人、后来又重新打开：算新多出来的，再叫
    h.todo.apply({ change: [{ id: 2, waitingFor: 'Steve 让路' }] }, 'owner', T0)
    await sleep(200)
    assert.equal(h.llm.requests.length, 3)
    h.todo.apply({ change: [{ id: 2, state: 'open' }] }, 'owner', T0)
    await waitFor('woken again after #2 was reopened', () => h.llm.requests.length >= 4)
    assert.equal(nudges(h)[1], '[系统] 你停下来了（身体上没有在跑或排着的任务、没有例程、也没有在等的回答），工作清单上还有 1 件没做完、也没标成在等人：#2 挖完北边的矿洞')
    await sleep(200)
    assert.equal(h.llm.requests.length, 4)
    // 主人加了一件没做的：再叫，列出现在还没做的
    h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'owner', T0)
    await waitFor('woken again after a new item', () => h.llm.requests.length >= 5)
    assert.equal(nudges(h)[2], '[系统] 你停下来了（身体上没有在跑或排着的任务、没有例程、也没有在等的回答），工作清单上还有 2 件没做完、也没标成在等人：#2 挖完北边的矿洞、#3 修二号高炉')
    await sleep(200)
    assert.equal(h.llm.requests.length, 5)
    // 清单没变，可它为别的事（对话线交来的）走了一轮：走完再叫
    h.agent.handleEvent(told('仓库门口的火把补一下'))
    await waitFor('woken again after another turn', () => h.llm.requests.length >= 7)
    assert.equal(nudges(h).length, 4)
    await sleep(200)
    assert.equal(h.llm.requests.length, 7)
  })

  it('对话线正在想的时候清单变了：先不叫，等它想完（它可能正要把事交过来）', async (t) => {
    const { h } = setup(t)
    let answer: ((r: ReturnType<typeof reply>) => void) | undefined
    // 一次不回来的模型调用：测试放行；测试失败收尾（stop）时被打断，和真的模型客户端一样以 aborted 失败
    h.talk.enqueue(
      (req) =>
        new Promise((resolve, reject) => {
          answer = resolve
          req.signal?.addEventListener('abort', () => reject(new LlmError('aborted', 'stopped')))
        }),
    )
    h.agent.handleEvent(chat('Steve', 'Alu 记一下：修二号高炉'))
    await waitFor('the talk line is thinking', () => answer !== undefined)
    h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'talk', T0)
    await sleep(200)
    assert.equal(h.llm.requests.length, 0)
    answer!(reply(''))
    await waitFor('woken by the list after the talk line was done', () => nudges(h).length === 1)
  })

  it('大脑重启：清单上有没做的、干活线又没有别的事接着做，起来过一小会儿叫醒它；它不在线（身体说它不在游戏里）就不叫', async (t) => {
    const { h } = setup(t, { timing: { todoNudgeMs: 600_000 } })
    h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'owner', T0)
    await h.agent.stop()
    const again = h.restart({ now: () => T0, timing: {} })
    t.after(() => again.agent.stop())
    await waitFor('woken by the list after the restart', () => nudges(again).length === 1)
    assert.equal(nudges(again)[0], '[系统] 你停下来了（身体上没有在跑或排着的任务、没有例程、也没有在等的回答），工作清单上还有 1 件没做完、也没标成在等人：#1 修二号高炉')
    await again.agent.whenIdle()
    // 它下线了：被叫醒那一轮看到自己不在线，之后清单再变也不叫
    again.game.online = false
    again.agent.handleEvent(told('看看还在不在'))
    await waitFor('the turn after going offline', () => again.llm.requests.length >= 2)
    await again.agent.whenIdle()
    again.todo.apply({ add: [{ text: '挖矿洞' }] }, 'owner', T0)
    await sleep(200)
    assert.deepEqual([again.llm.requests.length, nudges(again).length], [2, 1])
  })

  it('每次被叫醒它都只往清单上再加一件、不开任务也不提问：中间没有外面的事，连着叫到上限就不再叫，日志里记一条', async (t) => {
    const { h } = setup(t)
    let n = 0
    h.llm.auto = (seen) => (seen.includes('[系统] 你停下来了') ? reply('', [{ name: 'todo', input: { add: [{ text: `再看一次（第 ${++n} 次）` }] } }]) : undefined)
    h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'owner', T0)
    await waitFor('the cap was reached', () => h.log.recent(0, 500).some((e) => e.kind === 'error' && e.text.includes('工作清单')))
    await sleep(200)
    assert.equal(nudges(h).length, TODO_NUDGE_MAX)
    assert.equal(n, TODO_NUDGE_MAX)
    // 外面有了事（有人说话）：从头数，清单再变就又叫
    h.llm.auto = undefined
    h.agent.handleEvent(chat('Steve', 'Alu 高炉修好了吗'))
    await h.agent.whenIdle()
    h.todo.apply({ add: [{ text: '挖矿洞' }] }, 'owner', T0)
    await waitFor('woken again after something happened outside', () => nudges(h).length === TODO_NUDGE_MAX + 1)
  })

  it('不叫醒的时候：只剩在等人的；身体上还有任务在跑；它提了问在等回答；被叫停了（等有新的事交给它为止）', async (t) => {
    const { h } = setup(t)
    // 只剩在等人的
    h.todo.apply({ add: [{ text: '修二号高炉' }] }, 'owner', T0)
    h.todo.apply({ change: [{ id: 1, waitingFor: 'Steve 把钥匙给我' }] }, 'owner', T0)
    await sleep(200)
    assert.equal(h.llm.requests.length, 0)
    // 身体上有任务在跑（不是它这一轮开的，大脑没盯着）
    h.game.handlers['task.list'] = () => ({ active: { id: 't7', type: 'goto', state: 'running' }, queue: [], recent: [] })
    h.todo.apply({ add: [{ text: '挖完北边的矿洞' }] }, 'owner', T0)
    await sleep(200)
    assert.equal(h.llm.requests.length, 0)
    h.game.handlers['task.list'] = () => ({ active: null, queue: [], recent: [] })
    // 它提了问、在等对话线的回答
    h.llm.enqueue(reply('', [{ name: 'report', input: { text: '矿洞从哪边挖？', question: true } }]), reply(''))
    h.agent.handleEvent(told('看看矿洞'))
    await waitFor('the question reached the talk line', () => h.talk.requests.length >= 1)
    await h.agent.whenIdle()
    await sleep(200)
    assert.deepEqual([h.llm.requests.length, nudges(h)], [2, []])
    // 回答到了（对话线带话过去）：它走完这一轮停下，清单上还有没做的，叫醒它
    await lineCalls(h, 'talk', 'tell_worker', { text: '从西边挖' })
    await waitFor('woken by the list after the answer', () => nudges(h).length === 1)
    await h.agent.whenIdle()
    // 被叫停：之后清单再变也不叫，等有新的事交给它
    await h.agent.stopWork('先别干了', 'panel')
    const before = h.llm.requests.length
    h.todo.apply({ add: [{ text: '补火把' }] }, 'owner', T0)
    await sleep(200)
    assert.equal(h.llm.requests.length, before)
    h.agent.handleEvent(told('接着干吧'))
    await waitFor('woken by the list after new work', () => nudges(h).length === 2)
    assert.match(nudges(h)[1]!, /工作清单上还有 2 件没做完、也没标成在等人：#2 挖完北边的矿洞、#3 补火把$/)
  })
})
