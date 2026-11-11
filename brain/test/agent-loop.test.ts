import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BridgeError } from '../src/bridge/protocol.ts'
import { LlmError } from '../src/llm/index.ts'
import type { GenerateResult } from '../src/llm/index.ts'
import { assertToolPairs, chat, llmDown, makeAgent, reply, taskEnded } from './agent-harness.ts'
import { sleep, waitFor } from './helpers.ts'

describe('agent 的一轮决策', () => {
  it('有人叫它干活：先 say 再启动任务，工具结果回给模型，模型不再调工具时这一轮结束', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(
      reply('', [
        { id: 'c_say', name: 'say', input: { message: '好，我来平。' } },
        { id: 'c_flat', name: 'flatten_area', input: { x1: 0, z1: 0, x2: 7, z2: 7, y: 64 } },
      ]),
      reply('等任务结束。'),
    )
    h.agent.handleEvent(chat('Steve', 'Alu 把这块地平一下'))
    await h.agent.whenIdle()

    // 游戏那边：说了话，任务按参数启动
    assert.deepEqual(h.game.said, ['好，我来平。'])
    assert.deepEqual(h.game.callsOf('task.start'), [
      { bot: 'Alu', task: { type: 'flatten', x1: 0, z1: 0, x2: 7, z2: 7, y: 64 }, mode: 'replace' },
    ])
    // 模型那边：第一次看到事件和状态；第二次看到两个工具的结果
    assert.equal(h.llm.requests.length, 2)
    assert.match(h.llm.lastUserText(0), /Steve 说：Alu 把这块地平一下/)
    assert.match(h.llm.lastUserText(0), /\[当前状态\]/)
    assert.match(h.llm.lastUserText(0), /online in overworld/)
    const second = h.llm.requests[1]!.messages
    const results = second[second.length - 1]!
    assert.deepEqual(
      results.content.map((p) => (p.type === 'tool_result' ? [p.toolCallId, p.isError ?? false] : null)),
      [
        ['c_say', false],
        ['c_flat', false],
      ],
    )
    assert.match(h.llm.lastUserText(1), /Task t1 \(flatten\) started/)
    // 已经用 say 说过话，最后那段文本不会再被说出去
    assert.equal(h.game.said.length, 1)
    assert.equal(h.history.get().turns.length, 1)
  })

  it('背包里杂物再多，状态快照里也一定列出手里的工具', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const status = h.game.handlers['bot.status']!
    h.game.handlers['bot.status'] = (p) => ({
      ...(status(p) as object),
      freeSlots: 5,
      inventory: [
        // 真实背包的样子：一堆大数量的方块和零碎的矿物，工具各只有一件、排在后面
        ...Array.from({ length: 28 }, (_, i) => ({ slot: i, id: 'gregtech:gt.metaitem.01', meta: 3000 + i, count: 30 - i, name: `Dust ${i}` })),
        { slot: 30, id: 'TConstruct:pickaxe', meta: 0, count: 1, name: 'Steel Pickaxe', durability: 0.85 },
        { slot: 31, id: 'TConstruct:shovel', meta: 0, count: 1, name: 'Steel Shovel', durability: 0.96 },
      ],
    })
    h.agent.handleEvent(chat('Steve', 'Alu 能挖石头吗'))
    await h.agent.whenIdle()
    const text = h.llm.lastUserText(0)
    assert.match(text, /^Tools: 1× TConstruct:pickaxe "Steel Pickaxe" \(85% durability\), 1× TConstruct:shovel "Steel Shovel" \(96% durability\)$/m)
    assert.match(text, /^Inventory \(5 of 36 slots free\): 30× gregtech:gt\.metaitem\.01\/3000 "Dust 0".* and 13 more kinds$/m)
  })

  it('任务结束会再次叫醒它，并且它能看到任务结果和上一轮的经过', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(reply('', [{ name: 'flatten_area', input: { x1: 0, z1: 0, x2: 7, z2: 7, y: 64 } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 平地'))
    await h.agent.whenIdle()

    h.llm.enqueue(reply('', [{ name: 'say', input: { message: '平好了。' } }]), reply(''))
    h.agent.handleEvent(taskEnded('t1', 'done', { result: { dug: 120, placed: 8 } }))
    await h.agent.whenIdle()

    assert.equal(h.llm.requests.length, 4)
    assert.match(h.llm.lastUserText(2), /任务 t1（flatten）完成了/)
    assert.match(h.llm.lastUserText(2), /"dug":120/)
    // 第三次请求带着第一轮的完整经过
    assert.ok(JSON.stringify(h.llm.requests[2]!.messages).includes('Alu 平地'))
    assertToolPairs(h.llm.requests[2]!.messages)
    assert.deepEqual(h.game.said, ['平好了。'])
  })

  it('模型一直调工具时，到每轮步数上限就停，而且每个调用都有结果', async (t) => {
    const h = makeAgent({ settings: { maxSteps: 3 } })
    t.after(h.cleanup)
    for (let i = 0; i < 10; i++) h.llm.enqueue(reply('', [{ name: 'get_status' }]))
    h.agent.handleEvent(chat('Steve', 'Alu 你在干嘛'))
    await h.agent.whenIdle()

    assert.equal(h.llm.requests.length, 3)
    const turn = h.history.get().turns[0]!
    assertToolPairs(turn.messages)
    const last = turn.messages[turn.messages.length - 1]!
    assert.equal(last.role, 'user')
    assert.ok(last.content.some((p) => p.type === 'text' && p.text.includes('步数上限')))
    assert.ok(h.log.recent().some((e) => e.kind === 'error' && e.text.includes('上限')))
  })

  it('它干活的时候主人又说了一句：这句话接在刚做完那一步的工具结果后面，这一轮里就看到；不为它另开一轮，也不会出现两次', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 它正在查状态（一步工具调用）的时候，主人说了第二句
    const status = h.game.handlers['bot.status']!
    let asked = 0
    h.game.handlers['bot.status'] = (p) => {
      // 第 1 次是开这一轮时的状态快照，第 2 次是它调的 get_status
      if (++asked === 2) h.agent.handleEvent({ ...chat('Steve', '先别平了，过来一下'), speaker: { block: { x: 12, y: 64, z: 3 }, facing: 'north' } })
      return status(p)
    }
    h.llm.enqueue(
      reply('', [{ id: 'c1', name: 'get_status' }]),
      reply('', [{ id: 'c2', name: 'say', input: { message: '来了' } }]),
      reply(''),
    )
    h.agent.handleEvent(chat('Steve', 'Alu 把那块地平了'))
    await waitFor('the turn ended', () => h.llm.requests.length === 3)
    await h.agent.whenIdle()

    // 第 2 次模型请求：上一步的工具结果后面跟着那句话，带着他站在哪
    const second = h.llm.requests[1]!.messages.at(-1)!
    assert.deepEqual(second.content.map((p) => p.type), ['tool_result', 'text'])
    const arrived = second.content[1]!
    assert.match(arrived.type === 'text' ? arrived.text : '', /^\[需要你处理的事（你做上一步的时候新到的）\]\n\[[\d:]+\] Steve 说：先别平了，过来一下\n {2}（Steve 站在 \(12,64,3\) 面朝北，没有指着什么方块）$/)
    // 一共就这一轮（三次模型调用），那句话没有再触发新的一轮
    await sleep(30)
    assert.equal(h.llm.requests.length, 3)
    assert.deepEqual(h.game.said, ['来了'])
    // 给模型的全部内容里这句话只出现一次；历史里也只有一份
    const everything = JSON.stringify(h.llm.requests[2]!.messages)
    assert.equal(everything.split('先别平了，过来一下').length - 1, 1)
    assert.equal(JSON.stringify(h.history.get().turns).split('先别平了，过来一下').length - 1, 1)
    assert.equal(h.history.get().turns.length, 1)
    // 面板的日志里说明了为什么没有另开一轮
    assert.ok(h.log.recent(0, 100).some((e) => e.kind === 'info' && e.text === '这一步期间新到的 1 件事接在工具结果后面交给模型了（算在这一轮里，不另开一轮）。'))
    assert.deepEqual(h.persisted.state?.queue, [])
  })

  it('干活时新到的话已经接进这一轮、模型还没看到，大脑就重启了：这句话不丢，重启后照常处理', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const status = h.game.handlers['bot.status']!
    let asked = 0
    h.game.handlers['bot.status'] = (p) => {
      if (++asked === 2) h.agent.handleEvent(chat('Steve', '顺便带点煤'))
      return status(p)
    }
    // 第 2 次模型调用一直没回来（大脑就在这时被停掉）
    h.llm.enqueue(reply('', [{ id: 'c1', name: 'get_status' }]), (req) => new Promise<GenerateResult>((_resolve, reject) => req.signal?.addEventListener('abort', () => reject(new LlmError('aborted', 'stopped')))))
    h.agent.handleEvent(chat('Steve', 'Alu 去仓库'))
    await waitFor('the second model call started', () => h.llm.requests.length === 2)
    assert.match(h.llm.lastUserText(1), /Steve 说：顺便带点煤/)
    // 这一刻落盘的状态里两句话就都在了：进程这时被强杀也不丢
    assert.deepEqual(h.persisted.state?.queue.map((e) => (e.type === 'chat' ? e.message : e.type)), ['Alu 去仓库', '顺便带点煤'])
    await h.agent.stop()
    // 正常停下以后，落盘的队列里两句话也都在
    assert.deepEqual(h.persisted.state?.queue.map((e) => (e.type === 'chat' ? e.message : e.type)), ['Alu 去仓库', '顺便带点煤'])

    const again = h.restart()
    t.after(() => again.agent.stop())
    await waitFor('the restarted brain asked the model', () => h.llm.requests.length === 3)
    const text = h.llm.lastUserText(2)
    assert.match(text, /大脑刚重启过/)
    assert.match(text, /Steve 说：Alu 去仓库/)
    assert.match(text, /Steve 说：顺便带点煤/)
  })

  it('干活时新到的话接进去以后模型接口出错：这句话退回队列，接口恢复后照常处理，不会无声无息地没了', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const status = h.game.handlers['bot.status']!
    let asked = 0
    h.game.handlers['bot.status'] = (p) => {
      if (++asked === 2) h.agent.handleEvent(chat('Steve', '顺便带点煤'))
      return status(p)
    }
    h.llm.enqueue(reply('', [{ id: 'c1', name: 'get_status' }]), llmDown(), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 去仓库'))
    await waitFor('the model was asked again after the failure', () => h.llm.requests.length === 3)
    await h.agent.whenIdle()
    const retry = h.llm.lastUserText(2)
    assert.match(retry, /上一轮做到一半时模型接口出错中断了/)
    assert.match(retry, /Steve 说：顺便带点煤/)
    // 存进历史的那半轮里没有这句话（模型当时没看到）：它只在重试的那一轮里出现一次
    assert.equal(JSON.stringify(h.llm.requests[2]!.messages).split('顺便带点煤').length - 1, 1)
  })

  it('一轮进行中：模型在想的时候状态是“正在想”（第几轮第几步、从什么时候开始），它要的工具在执行的时候是“在执行工具”，一轮结束回到空闲', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 第 2 次模型调用、和第 1 步的那个工具，都由测试放行
    let answer!: (r: GenerateResult) => void
    let finishTool!: () => void
    const status = h.game.handlers['bot.status']!
    let asked = 0
    h.game.handlers['bot.status'] = async (p) => {
      // 第 1 次是开头拍的状态快照，第 2 次才是模型调的 get_status
      if (++asked === 2) await new Promise<void>((resolve) => (finishTool = resolve))
      return status(p)
    }
    h.llm.enqueue(reply('', [{ id: 'c1', name: 'get_status' }]), () => new Promise<GenerateResult>((resolve) => (answer = resolve)))
    assert.deepEqual(h.agent.state(), { agent: 'main', model: { state: 'idle' }, turn: null, pending: 0, botOnline: undefined })

    const before = Date.now()
    h.agent.handleEvent(chat('Steve', 'Alu 去仓库'))
    await waitFor('the tool is running', () => finishTool !== undefined)
    const acting = h.agent.state()
    const turn = acting.turn!.id
    assert.deepEqual([acting.model.state, acting.model.turn, acting.model.step, acting.turn!.steps, acting.turn!.maxSteps], ['tools', turn, 1, 1, 16])

    finishTool()
    await waitFor('the second model call started', () => answer !== undefined)
    const thinking = h.agent.state()
    assert.deepEqual([thinking.model.state, thinking.model.turn, thinking.model.step, thinking.model.purpose, thinking.turn!.steps], ['thinking', turn, 2, 'turn', 1])
    assert.ok(thinking.model.since! >= before && thinking.model.since! <= Date.now())
    // 日志里那一条这时是“在想”
    const calls = () => h.log.recent(0, 100).filter((e) => e.kind === 'model_call')
    assert.deepEqual(calls().map((e) => [e.turn, e.step, e.call!.state, e.text.replace(/\d+\.\d 秒/, 'N 秒')]), [
      [turn, 1, 'done', '第 1 步：N 秒，输入 1000 / 输出 50 token，要调 1 个工具'],
      [turn, 2, 'thinking', '第 2 步：模型在想…'],
    ])
    const thinkingId = calls()[1]!.id

    answer(reply('好了', [], { usage: { inputTokens: 1200, outputTokens: 8, cacheReadTokens: 1100, cacheWriteTokens: 90 } }))
    await h.agent.whenIdle()
    const idle = h.agent.state()
    assert.deepEqual([idle.model.state, idle.turn, idle.model.lastCall?.inputTokens, idle.model.lastCall?.cacheReadTokens], ['idle', null, 1200, 1100])
    // 同一条（同一个 id）改成了结果：token、缓存读写、说完了
    const settled = calls()[1]!
    assert.deepEqual(
      [settled.id, settled.call!.state, settled.call!.stop, settled.call!.toolCalls, settled.call!.inputTokens, settled.call!.outputTokens, settled.call!.cacheReadTokens, settled.call!.cacheWriteTokens, settled.call!.model],
      [thinkingId, 'done', 'end', 0, 1200, 8, 1100, 90, 'scripted'],
    )
    assert.equal(calls().length, 2)
  })

  it('模型接口出错的那一次调用：日志里那一条标成失败，写着是哪种错和原话；被输出上限截断的那一次写着“被截断”', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(reply('', [{ id: 'c1', name: 'get_status' }], { stopReason: 'max_tokens' }), llmDown('auth'))
    h.agent.handleEvent(chat('Steve', 'Alu 去仓库'))
    await waitFor('the second call failed', () => h.agent.state().model.outage?.failures === 1)
    const calls = h.log.recent(0, 100).filter((e) => e.kind === 'model_call')
    assert.deepEqual(
      calls.map((e) => [e.step, e.call!.state, e.call!.stop, e.call!.toolCalls ?? null, e.call!.errorKind ?? null, e.call!.error ?? null, e.isError === true]),
      [
        [1, 'done', 'truncated', 1, null, null, false],
        [2, 'failed', 'error', null, 'auth', 'scripted auth failure', true],
      ],
    )
    assert.match(calls[0]!.text, /^第 1 步：\d+\.\d 秒，输入 1000 \/ 输出 50 token，被输出上限截断了$/)
    assert.match(calls[1]!.text, /^第 2 步：模型调用失败（auth，\d+\.\d 秒）：scripted auth failure$/)
    assert.equal(typeof calls[1]!.call!.ms, 'number')
    // 这一轮停了；状态里看得出接口有故障、原话是什么、什么时候再试
    const state = h.agent.state()
    assert.deepEqual([state.turn, state.model.outage!.failures, state.model.outage!.lastError], [null, 1, 'auth (HTTP 401): scripted auth failure'])
    assert.ok(state.model.outage!.nextRetryAt > state.model.outage!.since)
  })

  it('最后一步（模型不再调工具）进行中到达的事件排队，本轮结束后合并成一轮；同一时刻只跑一轮', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    let release: (r: GenerateResult) => void = () => {}
    h.llm.enqueue(() => new Promise<GenerateResult>((resolve) => (release = resolve)))
    h.agent.handleEvent(chat('Steve', 'Alu 第一件事'))
    await waitFor('first model call', () => h.llm.requests.length === 1)

    // 第一轮卡在模型调用上时来了三件事：两件会触发，一件只是背景
    h.agent.handleEvent(chat('Steve', 'Alu 第二件事'))
    h.agent.handleEvent({ type: 'player_join', time: Date.now(), player: 'Alex' })
    h.agent.handleEvent({ type: 'whisper', time: Date.now(), from: 'Steve', message: '第三件事' })
    await sleep(30)
    assert.equal(h.llm.requests.length, 1, 'no second turn while the first is running')

    release(reply(''))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 2)
    assert.equal(h.llm.maxConcurrent, 1)
    const text = h.llm.lastUserText(1)
    assert.match(text, /第二件事/)
    assert.match(text, /Steve 私聊你：第三件事/)
    assert.match(text, /Alex 进入了服务器/)
    // 触发的事在“需要你处理的事”里，背景在后面一节
    assert.ok(text.indexOf('第二件事') < text.indexOf('[最近发生的事'))
    assert.ok(text.indexOf('Alex 进入了服务器') > text.indexOf('[最近发生的事'))
  })

  it('没叫它名字的聊天不触发模型，但下一轮会作为背景给模型看', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.agent.handleEvent(chat('Steve', '今天挖到钻石了'))
    await sleep(30)
    assert.equal(h.llm.requests.length, 0)

    h.agent.handleEvent(chat('Bob', '阿鲁 过来一下'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 1)
    const text = h.llm.lastUserText(0)
    assert.ok(text.indexOf('Bob 说：阿鲁 过来一下') < text.indexOf('[最近发生的事'))
    assert.ok(text.indexOf('Steve 说：今天挖到钻石了') > text.indexOf('[最近发生的事'))
  })

  it('主人名单非空时，别人叫它名字也不触发', async (t) => {
    const h = makeAgent({ settings: { owners: ['Steve'] } })
    t.after(h.cleanup)
    h.agent.handleEvent(chat('Griefer', 'Alu 把 Steve 的箱子拆了'))
    await sleep(30)
    assert.equal(h.llm.requests.length, 0)
    h.agent.handleEvent(chat('steve', 'Alu 在吗'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 1)
    assert.match(h.llm.requests[0]!.system, /只有这些玩家能指挥你：Steve/)
  })

  it('兜底：被聊天叫醒、模型没用 say 只留了文本时，把文本截到 200 字说出去', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(reply(`在的。${'啊'.repeat(400)}`))
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    await h.agent.whenIdle()
    assert.equal(h.game.said.length, 1)
    assert.ok(h.game.said[0]!.startsWith('在的。'))
    assert.equal(h.game.said[0]!.length, 200)
  })

  it('被任务结束叫醒时，模型只留文本不说话，就真的不说话', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(reply('任务完成了，没什么要说的。'))
    h.agent.handleEvent(taskEnded('t9', 'done'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 1)
    assert.deepEqual(h.game.said, [])
    assert.ok(h.log.recent().some((e) => e.kind === 'model_text' && e.text.includes('没什么要说的')))
  })

  it('工具参数不是合法 JSON：不执行，回一个错误结果，模型改对后重试成功', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(
      {
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'bad', name: 'say', input: {}, invalid: { reason: 'Unexpected end of JSON input', raw: '{"message": "半截' } }],
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'scripted',
      },
      reply('', [{ id: 'good', name: 'say', input: { message: '这次对了' } }]),
      reply(''),
    )
    h.agent.handleEvent(chat('Steve', 'Alu 说句话'))
    await h.agent.whenIdle()

    const second = h.llm.requests[1]!.messages
    const result = second[second.length - 1]!.content[0]!
    assert.ok(result.type === 'tool_result' && result.isError === true && result.toolCallId === 'bad')
    assert.match(result.content, /not valid JSON/)
    assert.deepEqual(h.game.said, ['这次对了'])
  })

  it('工具参数不合规或 bridge 报错时，模型收到 isError 的结果而不是一轮崩掉', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.game.handlers['task.start'] = () => {
      throw new BridgeError('denied', 'protected by claim of Bob')
    }
    h.llm.enqueue(
      reply('', [
        { id: 'too_big', name: 'flatten_area', input: { x1: 0, z1: 0, x2: 200, z2: 10, y: 64 } },
        { id: 'missing', name: 'inspect_block', input: { x: 1, z: 2 } },
        { id: 'nope', name: 'fly_to_moon', input: {} },
        { id: 'refused', name: 'go_to', input: { x: 1, y: 64, z: 1 } },
      ]),
      reply(''),
    )
    h.agent.handleEvent(chat('Steve', 'Alu 干活'))
    await h.agent.whenIdle()
    const msgs = h.llm.requests[1]!.messages
    const results = msgs[msgs.length - 1]!.content.filter((p) => p.type === 'tool_result')
    assert.deepEqual(
      results.map((r) => r.isError),
      [true, true, true, true],
    )
    assert.match(results[0]!.content, /201×11; at most 64×64/)
    assert.match(results[1]!.content, /y is required/)
    assert.match(results[2]!.content, /no tool named "fly_to_moon"/)
    assert.match(results[3]!.content, /^denied: protected by claim of Bob/)
    // 只有参数合规的那一次真的发给了游戏
    assert.equal(h.game.callsOf('task.start').length, 1)
  })

  it('指令的回显没有跟着响应回来、而是随后作为系统消息到达时，模型在工具结果里就能看到', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.game.handlers['bot.command'] = () => {
      // 身体：指令执行当下没有消息；过一小会儿才把回显作为 bot.message 事件推过来
      setTimeout(() => h.agent.handleBridgeEvent({ event: 'bot.message', data: { bot: 'Alu', text: 'Alu: 2 / 99: base, mine' } }), 40)
      return { output: [] }
    }
    h.llm.enqueue(reply('', [{ name: 'list_homes' }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 你有哪些家'))
    await h.agent.whenIdle()
    assert.match(h.llm.lastUserText(1), /Server replied: Alu: 2 \/ 99: base, mine/)
  })

  it('自己执行指令的回显只出现在工具结果里，不会在下一轮又作为“系统消息”出现一次', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.game.handlers['bot.command'] = () => {
      // 真实 mod：回显既在 output 里，也作为 bot.message 事件发出，而且事件先于响应到达
      h.agent.handleBridgeEvent({ event: 'bot.message', data: { bot: 'Alu', text: "Home 'base2' set!" } })
      return { output: ["Home 'base2' set!"] }
    }
    h.llm.enqueue(reply('', [{ name: 'set_home', input: { name: 'base2', note: '新仓库' } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 把这里设成家'))
    await h.agent.whenIdle()
    assert.match(h.llm.lastUserText(1), /Server replied: Home 'base2' set!/)

    // 别的系统消息照常进背景
    h.agent.handleBridgeEvent({ event: 'bot.message', data: { bot: 'Alu', text: 'Steve has requested to teleport to you' } })
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    await h.agent.whenIdle()
    const next = h.llm.lastUserText(2)
    assert.match(next, /系统消息：Steve has requested to teleport to you/)
    assert.equal(next.includes("系统消息：Home 'base2' set!"), false)
  })

  it('上线时服务器刷的一串欢迎语不会塞进给模型看的背景里', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    for (const text of ['A magic bubble of protection appears...', 'Welcome to GregTech: New Horizons 2.9.0', 'Visit our Discord at https://discord.gg/gtnh']) {
      h.agent.handleBridgeEvent({ event: 'bot.message', time: Date.now(), data: { bot: 'Alu', text } })
    }
    h.agent.handleBridgeEvent({ event: 'bot.spawned', time: Date.now(), data: { bot: 'Alu' } })
    h.agent.handleEvent(chat('Steve', 'Alu 你来啦'))
    await h.agent.whenIdle()
    const text = h.llm.lastUserText(0)
    assert.match(text, /你上线了/)
    assert.equal(/Welcome to GregTech|magic bubble|Discord/.test(text), false)
  })

  it('服务器重启后补发的那串欢迎语（是几十秒前的事）同样不会塞进背景', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 大脑重连时，这些事件是一口气补发过来的，事件时间是服务器启动的时候
    const then = Date.now() - 40_000
    h.agent.handleBridgeEvent({ event: 'bot.message', time: then - 60_000, data: { bot: 'Alu', text: 'Steve has requested to teleport to you' } })
    for (const text of ['-----------------------------------------------------', 'Welcome to GregTech: New Horizons 2.9.0', 'Visit our Discord at https://discord.gg/gtnh']) {
      h.agent.handleBridgeEvent({ event: 'bot.message', time: then, data: { bot: 'Alu', text } })
    }
    h.agent.handleBridgeEvent({ event: 'bot.spawned', time: then + 20, data: { bot: 'Alu' } })
    h.agent.handleEvent({ type: 'panel_command', time: Date.now(), text: '你还好吗' })
    await h.agent.whenIdle()
    const text = h.llm.lastUserText(0)
    assert.match(text, /你上线了/)
    assert.equal(/Welcome to GregTech|Discord|-----/.test(text), false)
    // 上线之前很久的系统消息不是欢迎语，要留着
    assert.match(text, /系统消息：Steve has requested to teleport to you/)
  })

  it('区域任务的结果很长时，模型看到的是各原因的数量和前几个例子，而不是被截掉半截的 JSON', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.agent.handleEvent(
      taskEnded('t4', 'done', {
        result: {
          removed: 812,
          placed: 40,
          skipped: { tile_entity: 3, too_deep: 37 },
          skippedExamples: Array.from({ length: 40 }, (_, i) => ({ x: 100 + i, y: 61, z: 200, reason: i < 3 ? 'tile_entity' : 'too_deep' })),
          freeSlots: 9,
          level: 64,
        },
      }),
    )
    await h.agent.whenIdle()
    const text = h.llm.lastUserText(0)
    assert.match(text, /"removed":812,"placed":40,"skipped":\{"tile_entity":3,"too_deep":37\}/)
    assert.match(text, /"x":104,"y":61,"z":200,"reason":"too_deep"/)
    assert.equal(text.includes('"x":105'), false)
    assert.match(text, /"freeSlots":9,"level":64,"skippedExamplesNotShown":35/)
  })

  it('照图纸建的任务结束时，模型看到的是整理过的结果：现在和图纸差多少、还要放什么、哪些得人放、什么还挡着', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 真实 mod 的结果：区域任务的几项，加 now 和各最多 8 项的四张表。原样的 JSON 有两千多字
    const kinds = (n: number, extra: (i: number) => Record<string, unknown>) =>
      Array.from({ length: n }, (_, i) => ({ id: 'chisel:cobblestone', meta: i + 1, name: `Cobblestone Variant ${i + 1}`, ...extra(i) }))
    h.agent.handleEvent(
      taskEnded('t9', 'done', {
        type: 'blueprint',
        result: {
          removed: 4019,
          placed: 3823,
          skipped: { unreachable: 12 },
          skippedExamples: [{ x: -580, y: 88, z: 90, reason: 'unreachable' }],
          freeSlots: 12,
          needsClimbingBlocks: true,
          now: { cells: 5294, done: 3833, toPlace: 12, byHand: 2, blocked: 265, extra: 14 },
          materials: kinds(8, (i) => ({ need: 8 - i, have: 0 })),
          byHandBlocks: [{ id: 'minecraft:chest', meta: 3, name: 'Chest', count: 2, why: 'it holds contents or settings' }],
          blockedBy: [{ id: 'minecraft:stone', name: 'Stone', count: 265, removable: 0 }],
          extraBlocks: [{ id: 'gregtech:gt.blockmachines', name: 'gt.blockmachines.name', count: 14, removable: 0, holdsData: 14 }],
        },
      }),
    )
    await h.agent.whenIdle()
    const text = h.llm.lastUserText(0)
    assert.match(text, /任务 t9（blueprint）完成了/)
    assert.match(text, /removed 4019, placed 3823, freeSlots 12/)
    assert.match(text, /skipped \{"unreachable":12\}, e\.g\. \(-580,88,90\) unreachable/)
    assert.match(text, /needsClimbingBlocks: true/)
    assert.match(text, /now \(the world compared with the blueprint\): cells 5294, done 3833, toPlace 12, byHand 2, blocked 265, extra 14/)
    // 第一种和最后一种材料都在：没有被中途截断
    assert.match(text, /materials still to place: 8× chisel:cobblestone\/1 "Cobblestone Variant 1" \(you carry 0\),.* 1× chisel:cobblestone\/8 "Cobblestone Variant 8" \(you carry 0\)/)
    assert.match(text, /byHandBlocks \(a player has to place them\): 2× minecraft:chest\/3 "Chest" \(it holds contents or settings\)/)
    assert.match(text, /blockedBy \(still in the way\): 265× minecraft:stone "Stone"/)
    assert.match(text, /extraBlocks \(still where the blueprint is empty\): 14× gregtech:gt\.blockmachines \(.*14 of them hold data/)
    assert.equal(text.includes('"materials"'), false)
    assert.equal(text.includes('…'), false, 'nothing was cut off')
  })

  it('照图纸建的任务因为缺材料失败时，模型看到每种材料缺多少', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.agent.handleEvent(
      taskEnded('t10', 'failed', {
        type: 'blueprint',
        error: {
          code: 'no_material',
          message: '1890 blocks were left unplaced for want of material',
          detail: {
            missing: [
              { id: 'chisel:nucrete', meta: 7, name: 'Structural Concrete', count: 1874 },
              { id: 'minecraft:carpet', meta: 4, name: 'Yellow Carpet', count: 16 },
            ],
            supplyProblem: 'unreachable: no path to the container at -600,64,70',
          },
        },
        result: { removed: 0, placed: 1949, freeSlots: 30, now: { cells: 5294, done: 3404, toPlace: 1890, byHand: 0, blocked: 0, extra: 0 } },
      }),
    )
    await h.agent.whenIdle()
    const text = h.llm.lastUserText(0)
    assert.match(text, /任务 t10（blueprint）失败了：no_material — 1890 blocks were left unplaced for want of material/)
    assert.match(text, /missing \(left unplaced for want of material\): 1874× chisel:nucrete\/7 "Structural Concrete", 16× minecraft:carpet\/4 "Yellow Carpet"/)
    assert.match(text, /supplyProblem: unreachable: no path to the container at -600,64,70/)
    assert.match(text, /now \(the world compared with the blueprint\): cells 5294, done 3404, toPlace 1890/)
  })

  it('合成任务缺材料失败时，模型看到每样原料还差几个、是确定的物品还是“任何 xxx”、是不是工具；做成时看到做出了几个什么', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const item = { id: 'adventurebackpack:backpackComponent', meta: 6, name: 'Copter Blades' }
    h.agent.handleEvent(
      taskEnded('t11', 'failed', {
        type: 'craft',
        error: {
          code: 'no_material',
          message: 'the inventory lacks ingredients for 1 round(s) of this recipe',
          // 真实 mod 的 missing：格式同 recipe.find 的 ingredients，四样原料的 JSON 有五百多字
          detail: {
            missing: [
              { count: 4, name: 'Shaft (Refined Iron)', id: 'IC2:itemRecipePart', meta: 12 },
              { count: 1, name: 'Steel Screw (any screwSteel)', ore: 'screwSteel', example: { id: 'gregtech:gt.metaitem.01', meta: 27305 } },
              { count: 2, name: 'Wool (any variant)', id: 'minecraft:wool' },
              { count: 1, name: 'Single Use Screwdriver (any craftingToolScrewdriver)', ore: 'craftingToolScrewdriver', example: { id: 'gregtech:gt.metatool.01', meta: 22 }, alternatives: 6, tool: true },
            ],
          },
        },
        result: { crafted: 0, item, freeSlots: 20 },
      }),
    )
    await h.agent.whenIdle()
    const failed = h.llm.lastUserText(0)
    assert.match(failed, /任务 t11（craft）失败了：no_material — the inventory lacks ingredients for 1 round\(s\) of this recipe/)
    assert.match(failed, /missing \(not in your inventory, per ingredient\): 4× IC2:itemRecipePart\/12 "Shaft \(Refined Iron\)"; 1× any screwSteel \(ore name; e\.g\. gregtech:gt\.metaitem\.01\/27305 "Steel Screw"\); 2× minecraft:wool \(any meta\) "Wool \(any variant\)"; 1× any craftingToolScrewdriver \(ore name, 6 kinds fit; e\.g\. gregtech:gt\.metatool\.01\/22 "Single Use Screwdriver"\) \[tool: /)
    assert.match(failed, /已完成的部分：crafted 0× adventurebackpack:backpackComponent\/6 "Copter Blades", freeSlots 20/)

    h.agent.handleEvent(taskEnded('t12', 'done', { type: 'craft', result: { crafted: 1, item, freeSlots: 19 } }))
    await h.agent.whenIdle()
    assert.match(h.llm.lastUserText(1), /任务 t12（craft）完成了。 结果：crafted 1× adventurebackpack:backpackComponent\/6 "Copter Blades", freeSlots 19/)
  })

  it('机器加工的任务：做成时模型看到放进去多少、取回了什么；机器没开工时看到机器的状态和最可能的原因', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const GT = 'gregtech:gt.metaitem.01'
    // 真实基地里验证过的那一趟：2 个钢锭进 MV 车床，出 2 根钢杆和 4 小堆钢粉
    h.agent.handleEvent(
      taskEnded('t13', 'done', {
        type: 'process',
        result: {
          put: 2,
          outputs: [{ id: GT, meta: 23305, name: 'Steel Rod', count: 2 }, { id: GT, meta: 1305, name: 'Small Pile of Steel Dust', count: 4 }],
          freeSlots: 20,
        },
      }),
    )
    await h.agent.whenIdle()
    assert.match(
      h.llm.lastUserText(0),
      /任务 t13（process）完成了。 结果：put 2 item\(s\) into the machine; took out: 2× gregtech:gt\.metaitem\.01\/23305 "Steel Rod", 4× gregtech:gt\.metaitem\.01\/1305 "Small Pile of Steel Dust"; freeSlots 20/,
    )

    // 没开工：真实 mod 的原话，detail 是那台机器的状态
    const didNotStart = 'the machine did not start: it may lack power, a programmed circuit or a fluid, or these inputs are not a recipe it runs. The inputs are back in the inventory.'
    const assembler = { x: -38, y: 99, z: -80, name: 'Basic Assembling Machine', recipes: 'Assembler', tier: 'LV', inputSlots: 6, active: false, storedEU: 0, inputVoltage: 0 }
    h.agent.handleEvent(taskEnded('t14', 'failed', { type: 'process', error: { code: 'invalid', message: didNotStart, detail: assembler }, result: { put: 7, outputs: [], freeSlots: 20 } }))
    await h.agent.whenIdle()
    const unpowered = h.llm.lastUserText(1)
    assert.match(unpowered, /任务 t14（process）失败了：invalid — the machine did not start/)
    assert.match(unpowered, /machine "Basic Assembling Machine" at \(-38,99,-80\): runs Assembler recipes, tier LV, NO POWER \(0 EU stored\), idle\. It has no power, so it cannot run anything: tell the owner/)
    assert.match(unpowered, /已完成的部分：put 7 item\(s\) into the machine; took out: nothing; freeSlots 20/)

    // 有电又空闲却没开工：问题出在配方上（缺电路、缺流体、不是这台机器的配方……）
    h.agent.handleEvent(
      taskEnded('t15', 'failed', { type: 'process', error: { code: 'invalid', message: didNotStart, detail: { ...assembler, storedEU: 6400, inputVoltage: 32 } }, result: { put: 6, outputs: [], freeSlots: 20 } }),
    )
    await h.agent.whenIdle()
    assert.match(h.llm.lastUserText(2), /has power \(6400 EU stored\), idle\. It has power and is idle, so the cause is the recipe: a missing programmed circuit or mold, a missing fluid/)

    // 等到头还没做完：做好的取回来了，剩下的还在机器里
    h.agent.handleEvent(taskEnded('t16', 'done', { type: 'process', result: { put: 64, outputs: [{ id: GT, meta: 23305, name: 'Steel Rod', count: 20 }], timedOut: true, freeSlots: 19 } }))
    await h.agent.whenIdle()
    assert.match(h.llm.lastUserText(3), /took out: 20× gregtech:gt\.metaitem\.01\/23305 "Steel Rod"; timedOut: the wait ran out before it finished, the machine is still working on the rest; freeSlots 19/)
  })

  it('自己取消任务后收到的“任务被取消”不会再叫醒它；别人取消的照常叫醒', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 真实 mod 的顺序：先发被取消任务的事件，再回响应（响应里有 ids）
    h.game.handlers['task.cancel'] = () => {
      h.agent.handleEvent(taskEnded('t5', 'canceled'))
      return { canceled: 1, ids: ['t5'] }
    }
    h.llm.enqueue(reply('', [{ name: 'cancel_task' }, { name: 'say', input: { message: '停了。' } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 停'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 2)
    assert.match(h.llm.lastUserText(1), /Canceled 1 task\(s\): t5/)

    // 同一个取消在断线续传时又送来一次（finishedAt 不同所以不是简单的重复）：响应里说过是自己取消的，不叫醒
    h.agent.handleEvent(taskEnded('t5', 'canceled', {}, Date.now() + 5))
    await sleep(30)
    assert.equal(h.llm.requests.length, 2)

    // 不是它取消的任务（比如别的调试脚本取消的）照常叫醒它
    h.agent.handleEvent(taskEnded('t6', 'canceled'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 3)
  })

  it('启动新任务顶掉旧任务时，旧任务的“被取消”不会再叫醒它', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.game.handlers['task.start'] = (p) => {
      // 旧任务 t1 被顶掉：canceled 事件先到，响应里的 replaced 后到
      h.agent.handleEvent(taskEnded('t1', 'canceled'))
      return { task: { id: 't2', type: (p.task as { type: string }).type, state: 'queued' }, replaced: ['t1'] }
    }
    h.llm.enqueue(reply('', [{ name: 'go_to', input: { x: 5, z: 5 } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 别挖了，过来'))
    await h.agent.whenIdle()
    await sleep(30)
    assert.equal(h.llm.requests.length, 2)
    assert.match(h.llm.lastUserText(1), /Task t2 \(goto\) started\. It replaced 1 earlier task\(s\): t1\./)
    assert.deepEqual(h.agent.status().trackedTasks, ['t2'])
  })

  it('死亡后等身体重生了再决策，模型看到的是重生后的状态', async (t) => {
    const h = makeAgent({ timing: { afterDeathDelayMs: 150 } })
    t.after(h.cleanup)
    let health = 0
    const status = h.game.handlers['bot.status']!
    h.game.handlers['bot.status'] = (p) => ({ ...(status(p) as object), health })
    h.agent.handleBridgeEvent({ event: 'bot.death', time: Date.now(), data: { bot: 'Alu', cause: 'Zombie' } })
    h.agent.handleEvent(taskEnded('t1', 'failed', { error: { code: 'interrupted', message: 'the bot died' } }))
    await sleep(60)
    assert.equal(h.llm.requests.length, 0, 'does not decide while still dead')
    health = 20 // 重生了
    h.agent.handleBridgeEvent({ event: 'bot.spawned', time: Date.now(), data: { bot: 'Alu' } })
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 1)
    const text = h.llm.lastUserText(0)
    assert.match(text, /你死了（Zombie）/)
    assert.match(text, /任务 t1（flatten）失败了：interrupted/)
    assert.match(text, /health 20\/20/)
  })

  it('同一个任务结束被重复送达（续传重叠）时只处理一次', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const ev = taskEnded('t3', 'done')
    h.agent.handleEvent(ev)
    h.agent.handleEvent(structuredClone(ev))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 1)
    assert.equal((h.llm.lastUserText(0).match(/任务 t3/g) ?? []).length, 1)
  })

  it('任务一开始就失败时身体连发两次 failed（第一次没有结束时间）：模型只看到一次', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 真实 mod 上 goto 一个 5000 格外的坐标时收到的两个事件
    const task = {
      id: 'tmwalfw9s',
      type: 'goto',
      state: 'failed',
      startedAt: 1794309746322,
      error: { code: 'unreachable', message: 'that is 5000 blocks away and the bot walks at most 256; teleport closer first' },
      result: { block: { x: -13, y: 74, z: -79 } },
    }
    h.agent.handleBridgeEvent({ event: 'task.update', seq: 124, time: Date.now(), data: { bot: 'Alu', task } })
    h.agent.handleBridgeEvent({ event: 'task.update', seq: 125, time: Date.now(), data: { bot: 'Alu', task: { ...task, finishedAt: 1794309746322 } } })
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 1)
    const text = h.llm.lastUserText(0)
    assert.equal((text.match(/任务 tmwalfw9s（goto）失败了/g) ?? []).length, 1)
    assert.match(text, /unreachable — that is 5000 blocks away and the bot walks at most 256; teleport closer first/)
  })

  it('断线期间结束的任务：重连后对账发现，照样叫醒它', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(reply('', [{ name: 'go_to', input: { x: 1, y: 64, z: 1 } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 过来'))
    await h.agent.whenIdle()
    assert.deepEqual(h.agent.status().trackedTasks, ['t1'])

    // 断线期间任务失败了，事件没收到；重连后 task.list 的 recent 里有它
    h.game.handlers['task.list'] = () => ({
      active: null,
      queue: [],
      recent: [{ id: 't1', type: 'goto', state: 'failed', finishedAt: 1_700_000_000_000, error: { code: 'unreachable', message: 'no path' } }],
    })
    await h.agent.onBridgeReady({ epochChanged: false })
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 3)
    assert.match(h.llm.lastUserText(2), /任务 t1（goto）失败了：unreachable/)
    assert.deepEqual(h.agent.status().trackedTasks, [])
  })
})

describe('agent 的限制和故障处理', () => {
  it('模型接口坏了：在聊天里只说一次，过一会儿自动重试，恢复后把原来的事处理掉', async (t) => {
    const h = makeAgent({ timing: { retryDelaysMs: [30, 30, 30] } })
    t.after(h.cleanup)
    h.llm.enqueue(llmDown(), llmDown(), reply('', [{ name: 'say', input: { message: '我回来了，这就去。' } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 去挖点土'))

    await waitFor('outage visible', () => h.agent.status().outage?.failures === 2)
    assert.equal(h.game.said.length, 1, 'announces the outage once, not once per failure')
    assert.match(h.game.said[0]!, /模型接口/)

    await h.agent.whenIdle()
    assert.equal(h.agent.status().outage, undefined)
    assert.deepEqual(h.game.said.slice(1), ['我回来了，这就去。'])
    // 恢复后那一次请求里，原来的那句话还在“需要你处理的事”里
    assert.match(h.llm.lastUserText(2), /Steve 说：Alu 去挖点土/)
    assert.equal(h.history.get().turns.length, 1)
  })

  it('接口故障期间不会比退避时间更频繁地重试', async (t) => {
    const h = makeAgent({ timing: { retryDelaysMs: [10_000], humanRetryGapMs: 10_000 } })
    t.after(async () => {
      await h.agent.stop()
      h.cleanup()
    })
    h.llm.enqueue(llmDown())
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    await waitFor('first failure', () => h.agent.status().outage?.failures === 1)
    h.agent.handleEvent(chat('Steve', 'Alu ？？'))
    h.agent.handleEvent(taskEnded('t1', 'done'))
    await sleep(80)
    assert.equal(h.llm.requests.length, 1)
    assert.equal(h.agent.status().pending, 3)
  })

  it('模型配置改了以后立刻重试，不用等退避', async (t) => {
    const h = makeAgent({ timing: { retryDelaysMs: [10_000], nonRetryableDelayMs: 10_000, humanRetryGapMs: 10_000 } })
    t.after(h.cleanup)
    h.llm.enqueue(llmDown('auth'), reply('好了'))
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    await waitFor('auth failure', () => h.agent.status().outage?.failures === 1)
    assert.match(h.agent.status().lastCall?.error ?? '', /auth failure/)
    h.agent.notifyConfigChanged()
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 2)
    assert.equal(h.agent.status().lastCall?.ok, true)
  })

  it('一轮做到一半接口坏了：做过的事留在历史里，恢复后提醒它先看状态', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(reply('', [{ name: 'flatten_area', input: { x1: 0, z1: 0, x2: 3, z2: 3, y: 64 } }]), llmDown(), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 平地'))
    await h.agent.whenIdle()

    assert.equal(h.game.callsOf('task.start').length, 1)
    assert.equal(h.llm.requests.length, 3)
    const turns = h.history.get().turns
    assert.equal(turns.length, 2)
    assertToolPairs(turns.flatMap((x) => x.messages))
    assert.match(h.llm.lastUserText(2), /上一轮做到一半时模型接口出错中断了/)
    // 原来那句话已经在历史里处理过，不会再作为新的事重复出现
    assert.equal(/Steve 说：Alu 平地/.test(h.llm.lastUserText(2)), false)
  })

  it('今天的 token 用完后不再调模型，只在聊天里说一次', async (t) => {
    const h = makeAgent({ settings: { dailyTokenLimit: 5000 } })
    t.after(h.cleanup)
    h.usedTokens.value = 5000
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    await h.agent.whenIdle()
    h.agent.handleEvent(chat('Steve', 'Alu ？'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 0)
    assert.equal(h.game.said.length, 1)
    assert.match(h.game.said[0]!, /额度用完/)

    // 第二天额度回来了：之前没处理的话作为背景出现
    h.usedTokens.value = 0
    h.agent.handleEvent(chat('Steve', 'Alu 早'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 1)
    assert.match(h.llm.lastUserText(0), /Steve 说：Alu 在吗/)
  })

  it('一轮当中 token 用到上限：做完手上这一步就停', async (t) => {
    const h = makeAgent({ settings: { dailyTokenLimit: 5000 } })
    t.after(h.cleanup)
    h.llm.enqueue(() => {
      h.usedTokens.value = 6000
      return reply('', [{ name: 'get_status' }])
    }, reply('不该走到这一步'))
    h.agent.handleEvent(taskEnded('t1', 'done'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 1)
    assertToolPairs(h.history.get().turns[0]!.messages)
  })

  it('还没配置模型时，有人叫它会在聊天里说明，而不是没反应', async (t) => {
    const h = makeAgent({ noModel: true })
    t.after(h.cleanup)
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    await h.agent.whenIdle()
    assert.equal(h.game.said.length, 1)
    assert.match(h.game.said[0]!, /没接上模型/)
  })

  it('大脑重启后接着处理重启前没处理完的事', async (t) => {
    const h = makeAgent({ timing: { debounceMs: 10_000 } })
    t.after(h.cleanup)
    h.agent.handleEvent(chat('Steve', 'Alu 帮我搬东西'))
    await h.agent.stop() // 还没轮到处理就停了
    assert.equal(h.llm.requests.length, 0)

    const h2 = h.restart({ timing: { debounceMs: 0 } })
    await h2.agent.whenIdle()
    assert.equal(h.llm.requests.length, 1)
    assert.match(h.llm.lastUserText(0), /大脑刚重启过/)
    assert.match(h.llm.lastUserText(0), /Steve 说：Alu 帮我搬东西/)
  })

  it('任务接连失败超过上限后不再自动叫醒模型，并在聊天里说一声；有人说话后恢复', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    for (let i = 1; i <= 7; i++) {
      h.agent.handleEvent(taskEnded(`t${i}`, 'failed', { error: { code: 'stuck', message: 'no progress' } }))
      await h.agent.whenIdle()
    }
    assert.equal(h.llm.requests.length, 5)
    assert.equal(h.game.said.filter((s) => s.includes('连着失败')).length, 1)

    h.agent.handleEvent(chat('Steve', 'Alu 怎么了'))
    await h.agent.whenIdle()
    h.agent.handleEvent(taskEnded('t8', 'failed', { error: { code: 'stuck', message: 'no progress' } }))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 7)
  })
})
