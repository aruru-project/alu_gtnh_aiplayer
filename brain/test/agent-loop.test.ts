import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BridgeError } from '../src/bridge/protocol.ts'
import { LlmError } from '../src/llm/index.ts'
import type { GenerateResult, Message } from '../src/llm/index.ts'
import { assertToolPairs, chat, llmDown, makeAgent, relays, reply, says, sentToTalk, taskEnded, told } from './agent-harness.ts'
import type { AgentHarness } from './agent-harness.ts'
import { sleep, waitFor } from './helpers.ts'

// 这里测的是一条线自己的一轮怎么走（收事件、调模型、执行工具、落历史、出故障怎么办），大多用干活线：
// 事情是对话线交来的（told），它操作身体。两条线之间怎么往来、对话线怎么说话在 lines.test.ts。

describe('agent 的一轮决策', () => {
  it('对话线交来一件事：干活线启动任务，工具结果回给模型，模型不再调工具时这一轮结束；它留下的文字不说出口——任务还在跑时留的只作背景送给对话线、不叫醒它，停下来了留的才叫醒', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(
      reply('', [
        { id: 'c_look', name: 'get_status' },
        { id: 'c_flat', name: 'flatten_area', input: { x1: 0, z1: 0, x2: 7, z2: 7, y: 64 } },
      ]),
      reply('开始平了，等任务结束。'),
    )
    h.agent.handleEvent(told('把这块地平一下', [chat('Steve', 'Alu 把这块地平一下')]))
    await h.agent.whenIdle()

    // 游戏那边：任务按参数启动；干活线没有在聊天里说任何话
    assert.deepEqual(h.game.callsOf('task.start'), [
      { bot: 'Alu', task: { type: 'flatten', x1: 0, z1: 0, x2: 7, z2: 7, y: 64, dig: false, climb: false, maxDrop: 3 }, mode: 'replace' },
    ])
    assert.deepEqual(h.game.said, [])
    // 模型那边：第一次看到交来的事（连同主人的原话）和状态；第二次看到两个工具的结果
    assert.equal(h.llm.requests.length, 2)
    assert.match(h.llm.lastUserText(0), /对话线交给你的（这一句是它写的）：把这块地平一下/)
    assert.match(h.llm.lastUserText(0), /Steve 说：Alu 把这块地平一下/)
    assert.match(h.llm.lastUserText(0), /\[当前状态\]/)
    assert.match(h.llm.lastUserText(0), /online in overworld/)
    const second = h.llm.requests[1]!.messages
    const results = second[second.length - 1]!
    assert.deepEqual(
      results.content.map((p) => (p.type === 'tool_result' ? [p.toolCallId, p.isError ?? false] : null)),
      [
        ['c_look', false],
        ['c_flat', false],
      ],
    )
    assert.match(h.llm.lastUserText(1), /Task t1 \(flatten\) started/)
    assert.equal(h.history.get().turns.length, 1)
    // 它一轮结束时留下的文字送给了对话线。它开的任务还在跑（任务一结束它自己会被叫醒）：这句话只作背景，对话线没有为它醒
    assert.deepEqual(relays(h).map((e) => [e.relay, e.text]), [[{ type: 'progress', from: 'work', to: 'talk', waiting: '在等它开的任务结束：t1（flatten）' }, '干活线 → 对话线（还在干，中途留下的话，只作背景，没有叫醒它）：开始平了，等任务结束。']])
    await sleep(30)
    assert.equal(h.talk.requests.length, 0)

    // 任务做完，它自己被叫醒，这回它停下来了：留下的话叫醒对话线；之前那句在对话线的背景里
    h.llm.enqueue(reply('平好了。'))
    h.agent.handleEvent(taskEnded('t1', 'done', { result: { dug: 37 } }))
    await h.agent.whenIdle()
    assert.deepEqual(relays(h).map((e) => e.relay!.type), ['progress', 'result'])
    assert.equal(h.talk.requests.length, 1)
    const seen = h.talk.lastUserText(0)
    assert.match(seen.split('\n\n[')[0]!, /干活线停下来了（身体上没有它开的任务，也没有例程在跑），它留下的话：平好了。/)
    assert.match(seen.slice(seen.indexOf('[最近发生的事')), /干活线还在干（在等它开的任务结束：t1（flatten）），这是它中途留下的话：开始平了，等任务结束。/)
    assert.deepEqual(sentToTalk(h).at(-1), '平好了。')
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
    h.agent.handleEvent(told('看看能不能挖石头'))
    await h.agent.whenIdle()
    const text = h.llm.lastUserText(0)
    assert.match(text, /^Tools: 1× TConstruct:pickaxe "Steel Pickaxe" \(85% durability\), 1× TConstruct:shovel "Steel Shovel" \(96% durability\)$/m)
    assert.match(text, /^Inventory \(5 of 36 slots free\): 30× gregtech:gt\.metaitem\.01\/3000 "Dust 0".* and 13 more kinds$/m)
  })

  it('任务结束会再次叫醒它，并且它能看到任务结果和上一轮的经过', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(reply('', [{ name: 'flatten_area', input: { x1: 0, z1: 0, x2: 7, z2: 7, y: 64 } }]), reply(''))
    h.agent.handleEvent(told('Alu 平地'))
    await h.agent.whenIdle()

    h.llm.enqueue(reply('平好了，挖了 120 格。'))
    h.agent.handleEvent(taskEnded('t1', 'done', { result: { dug: 120, placed: 8 } }))
    await h.agent.whenIdle()

    assert.equal(h.llm.requests.length, 3)
    assert.match(h.llm.lastUserText(2), /任务 t1（flatten）完成了/)
    assert.match(h.llm.lastUserText(2), /"dug":120/)
    // 第三次请求带着第一轮的完整经过
    assert.ok(JSON.stringify(h.llm.requests[2]!.messages).includes('Alu 平地'))
    assertToolPairs(h.llm.requests[2]!.messages)
    // 任务结束的事只到了干活线：对话线是被它留下的那句话叫醒的，没有直接收到任务事件
    assert.deepEqual(sentToTalk(h), ['平好了，挖了 120 格。'])
    assert.equal(h.talk.requests.length, 1)
    assert.equal(/任务 t1/.test(h.talk.lastUserText(0)), false)
  })

  it('对话线有它自己的步数上限（到了再给一步收尾，然后这一轮结束）', async (t) => {
    const h = makeAgent({ settings: { maxSteps: 9 }, talkSettings: { maxSteps: 2 } })
    t.after(h.cleanup)
    for (let i = 0; i < 5; i++) h.talk.enqueue(reply('', [{ name: 'get_status' }]))
    h.agent.handleEvent(chat('Steve', 'Alu 你在干嘛'))
    await h.agent.whenIdle()
    assert.equal(h.talk.requests.length, 3)
    assert.equal(h.agent.state('talk').turn, null)
  })

  it('对话线查东西的时候主人又说了一句：这句话接在刚做完那一步的工具结果后面，这一轮里就看到；不为它另开一轮，也不会出现两次', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 它正在查状态（一步工具调用）的时候，主人说了第二句
    const status = h.game.handlers['bot.status']!
    let asked = 0
    h.game.handlers['bot.status'] = (p) => {
      // 第 1 次是开这一轮时的状态快照，第 2 次是它调的 get_status
      if (++asked === 2) h.agent.handleEvent({ ...chat('Steve', '等等，先说铁有多少'), speaker: { block: { x: 12, y: 64, z: 3 }, facing: 'north' } })
      return status(p)
    }
    h.talk.enqueue(reply('', [{ id: 'c1', name: 'get_status' }]), says('来了'), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 你身上有多少土'))
    await waitFor('the turn ended', () => h.talk.requests.length === 3)
    await h.agent.whenIdle()

    // 第 2 次模型请求：上一步的工具结果后面跟着那句话，带着他站在哪
    const second = h.talk.requests[1]!.messages.at(-1)!
    assert.deepEqual(second.content.map((p) => p.type), ['tool_result', 'text'])
    const arrived = second.content[1]!
    assert.match(arrived.type === 'text' ? arrived.text : '', /^\[需要你处理的事（你做上一步的时候新到的）\]\n\[[\d:]+\] Steve 说：等等，先说铁有多少\n {2}（Steve 站在 \(12,64,3\) 面朝北，没有指着什么方块）\n\n\[谁在跟你说话\] Steve 是在游戏聊天里对你说的；/)
    // 一共就这一轮（三次模型调用），那句话没有再触发新的一轮
    await sleep(30)
    assert.equal(h.talk.requests.length, 3)
    assert.deepEqual(h.game.said, ['来了'])
    // 给模型的全部内容里这句话只出现一次；历史里也只有一份
    const everything = JSON.stringify(h.talk.requests[1]!.messages)
    assert.equal(everything.split('等等，先说铁有多少').length - 1, 1)
    assert.equal(JSON.stringify(h.talkHistory.get().turns).split('等等，先说铁有多少').length - 1, 1)
    assert.equal(h.talkHistory.get().turns.length, 1)
    // 面板的日志里说明了为什么没有另开一轮
    assert.ok(h.log.recent(0, 100).some((e) => e.kind === 'info' && e.text === '这一步期间新到的 1 件事接在工具结果后面交给模型了（算在这一轮里，不另开一轮）。'))
    assert.deepEqual(h.talkPersisted.state?.queue, [])
  })

  it('查东西时新到的话已经接进这一轮、模型还没看到，大脑就重启了：这句话不丢，重启后照常处理', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const status = h.game.handlers['bot.status']!
    let asked = 0
    h.game.handlers['bot.status'] = (p) => {
      if (++asked === 2) h.agent.handleEvent(chat('Steve', '顺便带点煤'))
      return status(p)
    }
    // 第 2 次模型调用一直没回来（大脑就在这时被停掉）
    h.talk.enqueue(reply('', [{ id: 'c1', name: 'get_status' }]), (req) => new Promise<GenerateResult>((_resolve, reject) => req.signal?.addEventListener('abort', () => reject(new LlmError('aborted', 'stopped')))))
    h.agent.handleEvent(chat('Steve', 'Alu 去仓库'))
    await waitFor('the second model call started', () => h.talk.requests.length === 2)
    assert.match(h.talk.lastUserText(1), /Steve 说：顺便带点煤/)
    // 这一刻落盘的状态里两句话就都在了：进程这时被强杀也不丢
    assert.deepEqual(h.talkPersisted.state?.queue.map((e) => (e.type === 'chat' ? e.message : e.type)), ['Alu 去仓库', '顺便带点煤'])
    await h.agent.stop()
    // 大脑进程停下时中止的那次调用，日志里记的是“大脑在停”（和被叫停不是一回事）
    const cut = h.log.recent(0, 100).filter((e) => e.kind === 'model_call' && e.agent === 'talk').at(-1)!
    assert.deepEqual([cut.call!.state, cut.call!.errorKind, cut.call!.error, cut.isError], ['failed', 'aborted', '大脑在停，这次调用被中止了', true])
    // 正常停下以后，落盘的队列里两句话也都在
    assert.deepEqual(h.talkPersisted.state?.queue.map((e) => (e.type === 'chat' ? e.message : e.type)), ['Alu 去仓库', '顺便带点煤'])

    const again = h.restart()
    t.after(() => again.agent.stop())
    await waitFor('the restarted brain asked the model', () => h.talk.requests.length === 3)
    const text = h.talk.lastUserText(2)
    assert.match(text, /大脑刚重启过/)
    assert.match(text, /Steve 说：Alu 去仓库/)
    assert.match(text, /Steve 说：顺便带点煤/)
  })

  it('查东西时新到的话接进去以后模型接口出错：这句话退回队列，接口恢复后照常处理，不会无声无息地没了', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const status = h.game.handlers['bot.status']!
    let asked = 0
    h.game.handlers['bot.status'] = (p) => {
      if (++asked === 2) h.agent.handleEvent(chat('Steve', '顺便带点煤'))
      return status(p)
    }
    h.talk.enqueue(reply('', [{ id: 'c1', name: 'get_status' }]), llmDown(), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 去仓库'))
    await waitFor('the model was asked again after the failure', () => h.talk.requests.length === 3)
    await h.agent.whenIdle()
    const retry = h.talk.lastUserText(2)
    assert.match(retry, /上一轮做到一半时模型接口出错中断了/)
    assert.match(retry, /Steve 说：顺便带点煤/)
    // 存进历史的那半轮里没有这句话（模型当时没看到）：它只在重试的那一轮里出现一次
    assert.equal(JSON.stringify(h.talk.requests[2]!.messages).split('顺便带点煤').length - 1, 1)
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
    assert.deepEqual(h.agent.state('work'), { agent: 'work', model: { state: 'idle' }, turn: null, pending: 0, botOnline: undefined })
    assert.deepEqual(h.agent.state('talk'), { agent: 'talk', model: { state: 'idle' }, turn: null, pending: 0, botOnline: undefined })

    const before = Date.now()
    h.agent.handleEvent(told('去仓库'))
    await waitFor('the tool is running', () => finishTool !== undefined)
    const acting = h.agent.state()
    const turn = acting.turn!.id
    assert.deepEqual([acting.model.state, acting.model.turn, acting.model.step, acting.turn!.steps, acting.turn!.maxSteps, acting.turn!.about], ['tools', turn, 1, 1, 16, '对话线交给你的（这一句是它写的）：去仓库'])
    // 干活线在忙，对话线照样空闲：两条线各有各的状态
    assert.equal(h.agent.state('talk').model.state, 'idle')

    finishTool()
    await waitFor('the second model call started', () => answer !== undefined)
    const thinking = h.agent.state()
    assert.deepEqual([thinking.model.state, thinking.model.turn, thinking.model.step, thinking.model.purpose, thinking.turn!.steps], ['thinking', turn, 2, 'turn', 1])
    assert.ok(thinking.model.since! >= before && thinking.model.since! <= Date.now())
    // 日志里那一条这时是“在想”
    const calls = () => h.log.recent(0, 100).filter((e) => e.kind === 'model_call' && e.agent === 'work')
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
    h.agent.handleEvent(told('去仓库'))
    await waitFor('the second call failed', () => h.agent.state().model.outage?.failures === 1)
    const calls = h.log.recent(0, 100).filter((e) => e.kind === 'model_call' && e.agent === 'work')
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
    h.talk.enqueue(() => new Promise<GenerateResult>((resolve) => (release = resolve)))
    h.agent.handleEvent(chat('Steve', 'Alu 第一件事'))
    await waitFor('first model call', () => h.talk.requests.length === 1)

    // 第一轮卡在模型调用上时来了三件事：两件会触发，一件只是背景
    h.agent.handleEvent(chat('Steve', 'Alu 第二件事'))
    h.agent.handleEvent({ type: 'player_leave', time: Date.now(), player: 'Alex' })
    h.agent.handleEvent({ type: 'whisper', time: Date.now(), from: 'Steve', message: '第三件事' })
    await sleep(30)
    assert.equal(h.talk.requests.length, 1, 'no second turn while the first is running')

    release(reply(''))
    await h.agent.whenIdle()
    assert.equal(h.talk.requests.length, 2)
    assert.equal(h.talk.maxConcurrent, 1)
    const text = h.talk.lastUserText(1)
    assert.match(text, /第二件事/)
    assert.match(text, /Steve 私聊你：第三件事/)
    assert.match(text, /Alex 离开了服务器/)
    // 触发的事在“需要你处理的事”里，背景在后面一节
    assert.ok(text.indexOf('第二件事') < text.indexOf('[最近发生的事'))
    assert.ok(text.indexOf('Alex 离开了服务器') > text.indexOf('[最近发生的事'))
  })

  it('没叫它名字的聊天不触发模型，但下一轮会作为背景给模型看', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.agent.handleEvent(chat('Steve', '今天挖到钻石了'))
    await sleep(30)
    assert.equal(h.talk.requests.length, 0)

    h.agent.handleEvent(chat('Bob', '阿鲁 过来一下'))
    await h.agent.whenIdle()
    assert.equal(h.talk.requests.length, 1)
    const text = h.talk.lastUserText(0)
    assert.ok(text.indexOf('Bob 说：阿鲁 过来一下') < text.indexOf('[最近发生的事'))
    assert.ok(text.indexOf('Steve 说：今天挖到钻石了') > text.indexOf('[最近发生的事'))
  })

  it('主人名单非空时，别人叫它名字也不触发', async (t) => {
    const h = makeAgent({ settings: { owners: ['Steve'] } })
    t.after(h.cleanup)
    h.agent.handleEvent(chat('Griefer', 'Alu 把 Steve 的箱子拆了'))
    await sleep(30)
    assert.equal(h.talk.requests.length, 0)
    h.agent.handleEvent(chat('steve', 'Alu 在吗'))
    await h.agent.whenIdle()
    assert.equal(h.talk.requests.length, 1)
    assert.match(h.talk.requests[0]!.system, /只有这些玩家能指挥你：Steve/)
  })

  it('被任务结束叫醒时，干活线留的文字不进聊天：送给对话线，说不说由对话线定', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(reply('任务完成了，没什么要说的。'))
    h.agent.handleEvent(taskEnded('t9', 'done'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 1)
    // 对话线看到了这句（它这次没有脚本，什么都没写），聊天里没有任何话
    assert.equal(h.talk.requests.length, 1)
    assert.deepEqual(h.game.said, [])
    assert.ok(h.log.recent().some((e) => e.kind === 'model_text' && e.agent === 'work' && e.text.includes('没什么要说的')))
  })

  it('工具参数不是合法 JSON：不执行，回一个错误结果，模型改对后重试成功', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(
      {
        message: {
          role: 'assistant',
          content: [{ type: 'tool_call', id: 'bad', name: 'remember', input: {}, invalid: { reason: 'Unexpected end of JSON input', raw: '{"key": "仓库", "text": "半截' } }],
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'scripted',
      },
      reply('', [{ id: 'good', name: 'remember', input: { key: '仓库', text: '这次对了' } }]),
      reply(''),
    )
    h.agent.handleEvent(told('记一下仓库在哪'))
    await h.agent.whenIdle()

    const second = h.llm.requests[1]!.messages
    const result = second[second.length - 1]!.content[0]!
    assert.ok(result.type === 'tool_result' && result.isError === true && result.toolCallId === 'bad')
    assert.match(result.content, /not valid JSON/)
    assert.match(h.memory.render(), /仓库: 这次对了/)
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
    h.agent.handleEvent(told('干活'))
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
    h.agent.handleEvent(told('看看有哪些家'))
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
    h.agent.handleEvent(told('把这里设成家'))
    await h.agent.whenIdle()
    assert.match(h.llm.lastUserText(1), /Server replied: Home 'base2' set!/)

    // 别的系统消息照常进背景
    h.agent.handleBridgeEvent({ event: 'bot.message', data: { bot: 'Alu', text: 'Steve has requested to teleport to you' } })
    h.agent.handleEvent(told('接受一下 Steve 的传送请求'))
    await h.agent.whenIdle()
    const next = h.llm.lastUserText(2)
    assert.match(next, /系统消息：Steve has requested to teleport to you/)
    assert.equal(next.includes("系统消息：Home 'base2' set!"), false)
  })

  it('放下就走的那一批做完、身体把编程电路改回原值（意见簿 f3：用完别人的机器要照原样还回去）：不叫醒她，下一轮的背景里写着改回去了；改不回去的写着为什么', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const turns = h.llm.requests.length
    h.agent.handleBridgeEvent({ event: 'machine.circuit', time: Date.now(), data: { bot: 'Alu', task: 't7', machine: { x: -538, y: 69, z: 40 }, dim: 0, set: 9, was: 1, now: 1, restored: true } })
    h.agent.handleBridgeEvent({ event: 'machine.circuit', time: Date.now(), data: { bot: 'Alu', task: 't8', machine: { x: -536, y: 69, z: 40 }, dim: 0, set: 0, was: 1, now: 24, restored: false, reason: 'it was set to 24 meanwhile, not by this task, so it is left as it is' } })
    // 别的 bot 的不算
    h.agent.handleBridgeEvent({ event: 'machine.circuit', time: Date.now(), data: { bot: 'Other', task: 't9', machine: { x: 0, y: 64, z: 0 }, set: 2, was: 0, restored: true } })
    await sleep(50)
    assert.equal(h.llm.requests.length, turns, 'she is not woken for it')
    h.agent.handleEvent(told('看看卷板机'))
    await h.agent.whenIdle()
    const text = h.llm.lastUserText(turns)
    assert.match(text, /任务 t7 放下就走的那一批做完了：\(-538,69,40\) 的编程电路已经改回原来的 1（这一批用的是 9）/)
    assert.match(text, /任务 t8 放下就走的那一批之后，\(-536,69,40\) 的编程电路没有改回原来的 1（现在是 24）：it was set to 24 meanwhile, not by this task, so it is left as it is/)
    assert.equal(text.includes('t9'), false)
  })

  it('上线时服务器刷的一串欢迎语不会塞进给模型看的背景里', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    for (const text of ['A magic bubble of protection appears...', 'Welcome to GregTech: New Horizons 2.9.0', 'Visit our Discord at https://discord.gg/gtnh']) {
      h.agent.handleBridgeEvent({ event: 'bot.message', time: Date.now(), data: { bot: 'Alu', text } })
    }
    h.agent.handleBridgeEvent({ event: 'bot.spawned', time: Date.now(), data: { bot: 'Alu' } })
    h.agent.handleEvent(told('去仓库'))
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
    h.agent.handleEvent(told('看看你还好吗', []))
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
    assert.match(text, /skipped 12 cell\(s\), by reason:\s+- 12× unreachable \(at \(-580,88,90\); 11 more not listed\)/)
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
    assert.match(unpowered, /machine "Basic Assembling Machine" at \(-38,99,-80\): runs Assembler recipes, tier LV, 6 input slot\(s\), NO POWER \(0 EU stored\), idle/)
    assert.match(unpowered, /已完成的部分：put 7 item\(s\) into the machine; took out: nothing; freeSlots 20/)

    // 有电又空闲只是此刻状态，也可能刚完成高速加工；不再据此断言配方有误。
    h.agent.handleEvent(
      taskEnded('t15', 'failed', { type: 'process', error: { code: 'invalid', message: didNotStart, detail: { ...assembler, storedEU: 6400, inputVoltage: 32 } }, result: { put: 6, outputs: [], freeSlots: 20 } }),
    )
    await h.agent.whenIdle()
    assert.match(h.llm.lastUserText(2), /has power \(6400 EU stored\), idle/)
    assert.doesNotMatch(h.llm.lastUserText(2), /so the cause is the recipe/)

    // 等到头还没做完：做好的取回来了，还没开始做的原料也取回来了（测试服上实测：54 个钢锭等 5 秒，取回 36 个），机器只把手上那一轮做完
    h.agent.handleEvent(taskEnded('t16', 'done', { type: 'process', result: { put: 64, outputs: [{ id: GT, meta: 23305, name: 'Steel Rod', count: 20 }, { id: GT, meta: 11305, name: 'Steel Ingot', count: 43 }], timedOut: true, freeSlots: 19 } }))
    await h.agent.whenIdle()
    assert.match(h.llm.lastUserText(3), /took out: 20× gregtech:gt\.metaitem\.01\/23305 "Steel Rod", 43× gregtech:gt\.metaitem\.01\/11305 "Steel Ingot"; timedOut: the wait ran out before the machine was done\. What was in its output slots and the inputs it had not started on were taken out \(above\); the recipe it is still on finishes in the machine, and what that makes stays in it; freeSlots 19/)
  })

  it('放方块的任务（意见簿：fill_area 报放了 18 个，实际先放了 10 个钢管道方块）：模型看到这些方块是从哪几种物品放的；只放要的那种、不够就停时，缺的是哪个 meta', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const CASING = 'gregtech:gt.blockcasings2'
    // 测试服上身体给的原样：不带 meta 时两种都放了；带 meta 0 时只放 meta 0，放完 8 个以 no_material 停下
    h.agent.handleEvent(
      taskEnded('t40', 'done', {
        type: 'fill',
        result: { removed: 0, placed: 18, placedItems: [{ id: CASING, meta: 13, count: 10, name: 'Steel Pipe Casing' }, { id: CASING, meta: 0, count: 8, name: 'Solid Steel Machine Casing' }], freeSlots: 35 },
      }),
    )
    await h.agent.whenIdle()
    assert.match(h.llm.lastUserText(0), /任务 t40（fill）完成了。 结果：\n {2}\{"removed":0,"placed":18,"freeSlots":35\}\n {2}placed from: 10× gregtech:gt\.blockcasings2\/13 "Steel Pipe Casing", 8× gregtech:gt\.blockcasings2 "Solid Steel Machine Casing"\n/)

    h.agent.handleEvent(
      taskEnded('t41', 'failed', {
        type: 'fill',
        error: { code: 'no_material', message: 'out of gregtech:gt.blockcasings2:0; 10 more needed', detail: { item: { id: CASING, meta: 0 }, missing: 10 } },
        result: { removed: 0, placed: 8, placedItems: [{ id: CASING, meta: 0, count: 8, name: 'Solid Steel Machine Casing' }], freeSlots: 35 },
      }),
    )
    await h.agent.whenIdle()
    const stopped = h.llm.lastUserText(1)
    assert.match(stopped, /任务 t41（fill）失败了：no_material — out of gregtech:gt\.blockcasings2:0; 10 more needed/)
    assert.match(stopped, /已完成的部分：\n {2}\{"removed":0,"placed":8,"freeSlots":35\}\n {2}placed from: 8× gregtech:gt\.blockcasings2 "Solid Steel Machine Casing"\n/)
  })

  it('产物被机器自己的自动输出送走了（意见簿：压缩机把 6 个钢块推进了下面的输入总线，以前报“没法取出”的失败）：模型看到任务做成了、跑了几轮、做了什么、取回零个、东西现在在哪个容器挨着哪一面、机器的自动输出朝哪', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const BLOCK = { id: 'gregtech:gt.blockmetal6', meta: 13, name: 'Block of Steel' }
    const bus = { x: -532, y: 71, z: 58, name: 'Input Bus (LV)' }
    // 测试服上这一趟身体给的原样（坐标换成了意见簿里那台）：54 个钢锭进 LV 压缩机，输出面朝下、物品自动输出开着
    h.agent.handleEvent(
      taskEnded('t30', 'done', {
        type: 'process',
        params: { machine: { x: -532, y: 72, z: 58 }, inputs: [{ id: 'gregtech:gt.metaitem.01', meta: 11305, count: 54 }] },
        result: {
          put: 54,
          outputs: [],
          making: [{ ...BLOCK, count: 1 }],
          rounds: 6,
          made: [{ ...BLOCK, count: 6 }],
          elsewhere: [{ ...bus, side: 'down', items: [{ ...BLOCK, count: 6 }] }],
          autoOutput: { items: true, fluids: false, side: 'down', to: bus },
          note: 'the machine ran and made things, but none were left in it to take out: something moved them on while it worked (its auto-output, a cover or a pipe). elsewhere lists the containers around it that gained them; what is not there went further than can be seen from the machine',
          freeSlots: 36,
        },
      }),
    )
    await h.agent.whenIdle()
    assert.equal(
      h.llm.lastUserText(0).match(/任务 t30（process）.*/)?.[0],
      '任务 t30（process）完成了。 结果：put 54 item(s) into the machine; it finished 6 round(s) of a recipe, making 6× gregtech:gt.blockmetal6/13 "Block of Steel" in all; took out: nothing; when it started it set out to make 1× gregtech:gt.blockmetal6/13 "Block of Steel"; what it made was moved on out of the machine while it worked, and is now in: 6× gregtech:gt.blockmetal6/13 "Block of Steel" in "Input Bus (LV)" at (-532,71,58), against the down face of the machine; AUTO-OUTPUT of items on: what it makes leaves by its down face, into Input Bus (LV) at (-532,71,58); freeSlots 36',
    )

    // 输出面接的是管道：做出来了，周围哪个容器都没多出来。照实说去了看不到的地方，接在它身上的管道写出来
    const pipe = { x: -532, y: 71, z: 58, name: 'Steel Item Pipe', kind: 'item pipe' }
    h.agent.handleEvent(
      taskEnded('t31', 'done', {
        type: 'process',
        result: { put: 9, outputs: [], rounds: 1, made: [{ ...BLOCK, count: 1 }], autoOutput: { items: true, fluids: false, side: 'down', to: pipe }, attached: [pipe], note: 'the machine ran and made things, but none were left in it', freeSlots: 36 },
      }),
    )
    await h.agent.whenIdle()
    const piped = h.llm.lastUserText(1)
    assert.match(piped, /任务 t31（process）完成了。 结果：put 9 item\(s\) into the machine; it finished 1 round\(s\) of a recipe, making 1× gregtech:gt\.blockmetal6\/13 "Block of Steel" in all; took out: nothing; nothing of what it made was left in the machine, and no container around it gained any: it went further than can be seen from the machine; AUTO-OUTPUT of items on: what it makes leaves by its down face, into Steel Item Pipe at \(-532,71,58\); AUTOMATED: Steel Item Pipe at \(-532,71,58\) feeds or drains it; freeSlots 36/)
  })

  it('放下就走的加工任务（leave）：结束时模型看到料放进去了、机器开工了，这一轮和全部几轮大概还要多久，产物和模具留在机器里怎么取，电路现在是几原来是几', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const GT = 'gregtech:gt.metaitem.01'
    const lathe = { x: 16, y: 64, z: -4, name: 'Advanced Lathe', recipes: 'Lathe', tier: 'MV', inputSlots: 2, active: true, storedEU: 51200, inputVoltage: 128 }
    const note = 'the machine has started and the task ended without waiting for it. What it makes stays in it until it is taken out (withdraw with the machine as the container); what was put in and is not used up, such as a mould, stays in it too'
    const howToTake = 'Nothing reports when it finishes: find_machines or inspect_block shows whether it is still busy, and set_reminder wakes you after the minutes you give. What it makes stays in the machine, and so does what was put in and is not used up (a mold): withdraw_items with container (16,64,-4) takes the products (a multiblock: from its output bus), and with fromInputs: true what sits in its input slots'
    // 测试服上实测过的那一趟：8 个钢锭进车床，任务 1.2 秒就结束。这台车床一轮 80 tick（4 秒），那一刻第一轮转了 24 tick：
    // 这一轮还剩 56 tick = 2.8 秒；8 轮一共 640 tick，还剩 616 tick ≈ 31 秒
    h.agent.handleEvent(
      taskEnded('t20', 'done', {
        type: 'process',
        params: { machine: { x: 16, y: 64, z: -4 }, inputs: [{ id: GT, meta: 11305, count: 8 }], leave: true, recipe: { ref: 198685, rounds: 8, ticks: 160 } },
        result: { put: 8, left: true, note, machine: { ...lathe, progress: 24, maxProgress: 80 }, freeSlots: 30 },
      }),
    )
    await h.agent.whenIdle()
    const first = h.llm.lastUserText(0)
    assert.ok(
      first.includes(`任务 t20（process）完成了。 结果：put 8 item(s) into the machine; it started, and the task ended there without waiting for it. On this machine a round takes 4 s; the one running has about 2.8 s left, all 8 rounds about 31 s from now. ${howToTake}; freeSlots 30`),
      first,
    )

    // 自己写的 inputs（几轮说不准），设了编程电路：一轮 1280 tick = 1 分 4 秒，刚开工；电路现在 2、原来 24，不恢复
    h.agent.handleEvent(
      taskEnded('t21', 'done', {
        type: 'process',
        params: { machine: { x: 16, y: 64, z: -4 }, inputs: [{ id: GT, meta: 11305, count: 36 }], circuit: 2, leave: true },
        result: { put: 36, left: true, note, machine: { ...lathe, progress: 0, maxProgress: 1280 }, circuit: { now: 2, was: 24 }, freeSlots: 29 },
      }),
    )
    await h.agent.whenIdle()
    assert.match(
      h.llm.lastUserText(1),
      /put 36 item\(s\) into the machine; it started, and the task ended there without waiting for it\. On this machine a round takes 1 min 4 s; the one running has about 1 min 4 s left \(how many rounds these inputs make is not known here\)\. Nothing reports when it finishes: .* what sits in its input slots\. Programmed circuit: now 2, it was 24; it stays 2 until someone sets it again; freeSlots 29/,
    )

    // 身体读不懂的机器（别的 mod 的）：没有机器状态，开没开工读不出来；一轮多久只有配方册上的数（200 tick = 10 秒，4 轮 40 秒）
    h.agent.handleEvent(
      taskEnded('t22', 'done', {
        type: 'process',
        params: { machine: { x: 14, y: 64, z: -2 }, inputs: [{ id: GT, meta: 2032, count: 4 }], leave: true, recipe: { ref: 24, rounds: 4, ticks: 200 } },
        result: { put: 4, left: true, note: 'the things are in and the task ended without waiting; whether this machine started cannot be read. What it makes stays in it until it is taken out', freeSlots: 31 },
      }),
    )
    await h.agent.whenIdle()
    assert.match(
      h.llm.lastUserText(2),
      /put 4 item\(s\) into the machine; the task ended there without waiting, and whether this machine started cannot be read \(it is not a machine the body knows\)\. By the recipe book a round takes 10 s, 4 rounds 40 s\. Nothing reports when it finishes: .* withdraw_items with container \(14,64,-2\) takes the products/,
    )
    // 身体那句英文说明讲的是同一件事，不再重复一遍
    assert.doesNotMatch(h.llm.lastUserText(2), /other:/)
  })

  it('自己取消任务后收到的“任务被取消”不会再叫醒它；别人取消的照常叫醒', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 真实 mod 的顺序：先发被取消任务的事件，再回响应（响应里有 ids）
    h.game.handlers['task.cancel'] = () => {
      h.agent.handleEvent(taskEnded('t5', 'canceled'))
      return { canceled: 1, ids: ['t5'] }
    }
    h.llm.enqueue(reply('', [{ name: 'cancel_task' }]), reply(''))
    h.agent.handleEvent(told('把手上的任务取消'))
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
    h.agent.handleEvent(told('别挖了，过来'))
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
    h.agent.handleEvent(told('过来'))
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
  it('对话线的模型接口坏了（游戏里有人叫它）：程序替它在聊天里只说一次，过一会儿自动重试，恢复后把原来的话处理掉', async (t) => {
    const h = makeAgent({ timing: { retryDelaysMs: [30, 30, 30] } })
    t.after(h.cleanup)
    h.talk.enqueue(llmDown(), llmDown(), says('我回来了，这就去。'), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 去挖点土'))

    await waitFor('outage visible', () => h.agent.statusOf('talk').outage?.failures === 2)
    assert.equal(h.game.said.length, 1, 'announces the outage once, not once per failure')
    assert.match(h.game.said[0]!, /模型接口/)

    await h.agent.whenIdle()
    assert.equal(h.agent.statusOf('talk').outage, undefined)
    assert.deepEqual(h.game.said.slice(1), ['我回来了，这就去。'])
    // 恢复后那一次请求里，原来的那句话还在“需要你处理的事”里
    assert.match(h.talk.lastUserText(2), /Steve 说：Alu 去挖点土/)
    assert.equal(h.talkHistory.get().turns.length, 1)
    // 干活线没受影响：它的状态里没有故障
    assert.equal(h.agent.status().outage, undefined)
  })

  it('干活线的模型接口坏了：它不在聊天里说话，对话线被告知一次（哪种错、什么时候再试）；恢复后把交来的事处理掉', async (t) => {
    const h = makeAgent({ timing: { retryDelaysMs: [30, 30, 30] } })
    t.after(h.cleanup)
    h.llm.enqueue(llmDown(), llmDown(), reply('', [{ name: 'go_to', input: { x: 1, y: 64, z: 1 } }]), reply(''))
    h.agent.handleEvent(told('去挖点土'))
    await waitFor('outage visible', () => h.agent.status().outage?.failures === 2)
    await h.agent.whenIdle()

    assert.equal(h.agent.status().outage, undefined)
    assert.equal(h.game.callsOf('task.start').length, 1)
    // 对话线只被告知了一次，不是每失败一次告诉一次；聊天里程序没有替谁说话
    assert.equal(relays(h, 'trouble').length, 1)
    assert.match(h.talk.lastUserText(0), /干活线出了状况（这句是程序替它报的）：干活线的模型接口出错了（server \(HTTP 500\): scripted server failure），它手上的事停在半路。0 秒后自动再试/)
    assert.deepEqual(h.game.said, [])
    assert.match(h.llm.lastUserText(2), /Steve 说：去挖点土/)
  })

  it('接口故障期间不会比退避时间更频繁地重试', async (t) => {
    const h = makeAgent({ timing: { retryDelaysMs: [10_000], humanRetryGapMs: 10_000 } })
    t.after(async () => {
      await h.agent.stop()
      h.cleanup()
    })
    h.llm.enqueue(llmDown())
    h.agent.handleEvent(told('在吗'))
    await waitFor('first failure', () => h.agent.status().outage?.failures === 1)
    h.agent.handleEvent(told('？？'))
    h.agent.handleEvent(taskEnded('t1', 'done'))
    await sleep(80)
    assert.equal(h.llm.requests.length, 1)
    assert.equal(h.agent.status().pending, 3)
  })

  it('模型配置改了以后立刻重试，不用等退避', async (t) => {
    const h = makeAgent({ timing: { retryDelaysMs: [10_000], nonRetryableDelayMs: 10_000, humanRetryGapMs: 10_000 } })
    t.after(h.cleanup)
    h.llm.enqueue(llmDown('auth'), reply('好了'))
    h.agent.handleEvent(told('在吗'))
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
    h.agent.handleEvent(told('Alu 平地'))
    await h.agent.whenIdle()

    assert.equal(h.game.callsOf('task.start').length, 1)
    assert.equal(h.llm.requests.length, 3)
    const turns = h.history.get().turns
    assert.equal(turns.length, 2)
    assertToolPairs(turns.flatMap((x) => x.messages))
    assert.match(h.llm.lastUserText(2), /上一轮做到一半时模型接口出错中断了/)
    // 原来那件事已经在历史里处理过，不会再作为新的事重复出现
    assert.equal(/Steve 说：Alu 平地/.test(h.llm.lastUserText(2)), false)
  })

  it('每日 token 上限是两条线合计的：用完以后两条线都不再调模型，只在聊天里说一次；额度回来后没处理的话作为背景出现', async (t) => {
    const h = makeAgent({ settings: { dailyTokenLimit: 5000 } })
    t.after(h.cleanup)
    // 额度是干活线一个人用掉的（它的两次调用各记 2500），对话线一次都还没调过
    h.llm.enqueue(
      () => {
        h.usedTokens.value += 2500
        return reply('', [{ name: 'get_status' }])
      },
      () => {
        h.usedTokens.value += 2500
        return reply('', [{ name: 'get_status' }])
      },
      reply('不该走到这一步'),
    )
    h.agent.handleEvent(told('看看状态'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 2, 'the worker stops in the middle of its turn when the shared limit is reached')

    // 对话线也想不了了：有人说话，程序替它说一次
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    await h.agent.whenIdle()
    h.agent.handleEvent(chat('Steve', 'Alu ？'))
    await h.agent.whenIdle()
    assert.equal(h.talk.requests.length, 0)
    assert.equal(h.game.said.length, 1)
    assert.match(h.game.said[0]!, /额度用完/)
    // 交给干活线的事同样没有处理
    h.agent.handleEvent(told('去仓库'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 2)

    // 第二天额度回来了：之前没处理的话作为背景出现
    h.usedTokens.value = 0
    h.agent.handleEvent(chat('Steve', 'Alu 早'))
    await h.agent.whenIdle()
    assert.equal(h.talk.requests.length, 1)
    assert.match(h.talk.lastUserText(0), /Steve 说：Alu 在吗/)
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

  it('只有干活线没配模型：交给它的事没法处理，对话线被告知“身体不会动”，由它跟主人说', async (t) => {
    const h = makeAgent({ noModel: 'work' })
    t.after(h.cleanup)
    h.talk.enqueue(says('好', [{ name: 'tell_worker', input: { text: '去仓库' } }]), reply(''), says('我干活的那一半还没接上模型，去面板给它选一个。'), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 去仓库'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 0)
    assert.match(h.talk.lastUserText(2), /干活线出了状况（这句是程序替它报的）：干活线还没有可用的模型（面板“设置”里的“模型”页里没有给它选上），交给它的事没有处理，身体不会动。/)
    assert.deepEqual(h.game.said, ['好', '我干活的那一半还没接上模型，去面板给它选一个。'])
  })

  it('大脑重启后两条线各自接着处理重启前没处理完的事', async (t) => {
    const h = makeAgent({ timing: { debounceMs: 10_000 } })
    t.after(h.cleanup)
    h.agent.handleEvent(chat('Steve', 'Alu 帮我搬东西'))
    h.agent.handleEvent(told('把圆石搬到箱子里'))
    await h.agent.stop() // 还没轮到处理就停了
    assert.equal(h.llm.requests.length + h.talk.requests.length, 0)
    // 两条线各自落盘了自己排着的事
    assert.deepEqual(h.talkPersisted.state?.queue.map((e) => e.type), ['chat'])
    assert.deepEqual(h.persisted.state?.queue.map((e) => e.type), ['told'])

    const h2 = h.restart({ timing: { debounceMs: 0 } })
    await h2.agent.whenIdle()
    assert.equal(h.talk.requests.length, 1)
    assert.match(h.talk.lastUserText(0), /大脑刚重启过/)
    assert.match(h.talk.lastUserText(0), /Steve 说：Alu 帮我搬东西/)
    assert.equal(/把圆石搬到箱子里/.test(h.talk.lastUserText(0)), false)
    assert.equal(h.llm.requests.length, 1)
    assert.match(h.llm.lastUserText(0), /大脑刚重启过/)
    assert.match(h.llm.lastUserText(0), /对话线交给你的（这一句是它写的）：把圆石搬到箱子里/)
    assert.equal(/帮我搬东西/.test(h.llm.lastUserText(0)), false)
  })

  it('任务接连失败超过上限后干活线不再自动醒来，对话线被告知一次；对话线带话以后恢复', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    for (let i = 1; i <= 7; i++) {
      h.agent.handleEvent(taskEnded(`t${i}`, 'failed', { error: { code: 'stuck', message: 'no progress' } }))
      await h.agent.whenIdle()
    }
    assert.equal(h.llm.requests.length, 5)
    assert.deepEqual(relays(h, 'trouble').map((e) => /身体的任务已经接连失败 6 次，干活线不再为任务失败自动醒来/.test(e.detail ?? e.text)), [true])
    assert.deepEqual(h.game.said, [], 'the worker never speaks in chat')

    h.agent.handleEvent(told('怎么了，再试一次'))
    await h.agent.whenIdle()
    h.agent.handleEvent(taskEnded('t8', 'failed', { error: { code: 'stuck', message: 'no progress' } }))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 7)
  })
})

describe('一轮到了步数上限：再给一步收尾', () => {
  /** 这条线的模型调用：第几步、是不是收尾的那一步、日志里那一行开头写的是什么。 */
  const modelCalls = (h: AgentHarness, agent: string): [number | undefined, boolean, string][] =>
    h.log
      .recent(0, 500)
      .filter((e) => e.kind === 'model_call' && e.agent === agent)
      .map((e) => [e.step, e.call?.final === true, e.text.split('：')[0]!])
  /** 这条线最后一轮结束的那一句。 */
  const turnEnd = (h: AgentHarness, agent: string): string => h.log.recent(0, 500).filter((e) => e.kind === 'turn' && e.agent === agent).at(-1)!.text
  /** 一份历史里最后那条消息里某个调用的结果。 */
  const resultIn = (messages: readonly Message[], id: string): { isError: boolean; content: string } => {
    const part = messages.at(-1)!.content.find((p) => p.type === 'tool_result' && p.toolCallId === id)
    assert.ok(part && part.type === 'tool_result', `no result for ${id}`)
    return { isError: part.isError === true, content: part.content }
  }

  it('对话线（主人请它设计一间小屋，它查到第 3 步就到了上限）：再给它一步收尾——say、whisper 照常说进游戏，写的字照常给主人看，别的工具不执行；之后这一轮结束，记录里写着是截断后收尾的', async (t) => {
    const h = makeAgent({ talkSettings: { maxSteps: 3 } })
    t.after(h.cleanup)
    h.talk.enqueue(
      reply('', [{ name: 'get_status' }]),
      reply('先看看周围', [{ name: 'get_status' }]),
      reply('', [{ name: 'get_status' }]),
      // 收尾那一步：在游戏里回他一句，写一句给主人看，顺手还想再查一次（不会执行）
      reply('草稿 hut2 画好了，还没盖。', [
        { id: 'c_say', name: 'say', input: { text: '小屋的草稿画好了，叫 hut2，面板上能看，要盖跟我说' } },
        { id: 'c_more', name: 'get_status' },
      ]),
    )
    h.agent.handleEvent(chat('Steve', 'Alu 帮我设计一间小屋'))
    await h.agent.whenIdle()

    // 3 步加 1 步收尾。收尾那一步照旧发整份工具清单、不强制它调什么：说不说、跟谁说由它定，哪些会执行写在消息末尾
    assert.equal(h.talk.requests.length, 4)
    assert.deepEqual(h.talk.requests.map((r) => r.toolChoice), [undefined, undefined, undefined, undefined])
    assert.deepEqual(h.talk.requests[3]!.tools.map((x) => x.name), h.talk.requests[0]!.tools.map((x) => x.name))
    const seen = h.talk.lastUserText(3)
    assert.ok(
      seen.endsWith(
        '[系统] 这一轮到了每轮 3 步的上限。再给你一步收尾，这一步之后这一轮就结束了，没做完的要等下次被叫醒才能接着做。这一步里只有 say、whisper 会执行（照常说进游戏），写的字照常只给主人在面板上看；调别的工具不会执行。\n' +
          '[谁在跟你说话] Steve 是在游戏聊天里对你说的；要回他得用 say（所有人都看到）或 whisper（只有那个人看到），只写字他看不到。',
      ),
      seen,
    )
    // 游戏里的人收到了回话；那一步要的别的工具没执行，结果里照实写了
    assert.deepEqual(h.game.said, ['小屋的草稿画好了，叫 hut2，面板上能看，要盖跟我说'])
    const turn = h.talkHistory.get().turns[0]!
    assertToolPairs(turn.messages)
    assert.equal(resultIn(turn.messages, 'c_say').isError, false)
    assert.deepEqual(resultIn(turn.messages, 'c_more'), { isError: true, content: 'Not executed: this was the one closing step given at the step limit, and in it only say and whisper run. The turn ended after that step.' })
    assert.equal(h.agent.state('talk').turn, null)

    // 记录：截断是一条错误；收尾的那次模型调用标着收尾；这一轮结束那一句写着到了上限、哪一步是收尾
    assert.deepEqual(
      h.log.recent(0, 500).filter((e) => e.kind === 'error' && e.agent === 'talk').map((e) => e.text),
      ['到了每轮 3 步的上限，这一轮被截断。再给它一步收尾（只有 say、whisper 会执行，写的字给主人在面板上看），之后这一轮结束。'],
    )
    assert.deepEqual(modelCalls(h, 'talk'), [[1, false, '第 1 步'], [2, false, '第 2 步'], [3, false, '第 3 步'], [4, true, '第 4 步（收尾）']])
    assert.match(turnEnd(h, 'talk'), /^第 \d+ 轮结束（调了 4 次模型）：到了每轮 3 步的上限，第 4 步是收尾$/)
    // 写的字照常只在面板上（reply），说的话是 say
    assert.deepEqual(
      h.log.recent(0, 500).filter((e) => e.kind === 'reply' || e.kind === 'say').map((e) => [e.kind, e.text]),
      [['reply', '先看看周围'], ['reply', '草稿 hut2 画好了，还没盖。'], ['say', '小屋的草稿画好了，叫 hut2，面板上能看，要盖跟我说']],
    )
  })

  it('到上限那一步期间新到的话不接进收尾（那一步只能说话，接进来就算这一轮办过了）：这一轮结束后为它另开一轮', async (t) => {
    const h = makeAgent({ talkSettings: { maxSteps: 2 } })
    t.after(h.cleanup)
    h.talk.enqueue(
      reply('', [{ name: 'get_status' }]),
      // 它想第 2 步的时候 Steve 又说了一句
      () => {
        h.agent.handleEvent(chat('Steve', '再加个烟囱'))
        return reply('', [{ name: 'get_status' }])
      },
      says('草稿画好了，叫 hut2'),
      // 新的一轮：看到了那句话，手里是全套工具
      says('好，给 hut2 加个烟囱'),
      reply(''),
    )
    h.agent.handleEvent(chat('Steve', 'Alu 帮我设计一间小屋'))
    await waitFor('the next turn ended', () => h.talk.requests.length === 5)
    await h.agent.whenIdle()
    assert.match(h.talk.lastUserText(2), /\[系统\] 这一轮到了每轮 2 步的上限。/)
    assert.equal(h.talk.lastUserText(2).includes('再加个烟囱'), false)
    assert.match(h.talk.lastUserText(3), /^\[需要你处理的事\]\n\[[\d:]+\] Steve 说：再加个烟囱\n/)
    assert.equal(h.talk.lastUserText(3).includes('步的上限'), false)
    assert.deepEqual(h.game.said, ['草稿画好了，叫 hut2', '好，给 hut2 加个烟囱'])
    assert.deepEqual(modelCalls(h, 'talk').map(([step, final]) => [step, final]), [[1, false], [2, false], [3, true], [1, false], [2, false]])
  })

  it('干活线（开了个任务、又查了两步就到了上限）：收尾那一步不能调工具（toolChoice none）；它写的话连同“被截断了”“还在等任务”由程序报给对话线；它收尾的时候对话线的状态里写着这是收尾的一步', async (t) => {
    const h = makeAgent({ settings: { maxSteps: 3 } })
    t.after(h.cleanup)
    h.llm.enqueue(
      reply('', [{ name: 'flatten_area', input: { x1: 0, z1: 0, x2: 7, z2: 7, y: 64 } }]),
      reply('', [{ name: 'get_status' }]),
      reply('', [{ name: 'get_status' }]),
      // 收尾那一步：它想的时候主人问“你在干嘛”
      async () => {
        h.agent.handleEvent(chat('Steve', 'Alu 你在干嘛'))
        await waitFor('the talk line looked at the worker', () => h.talk.requests.length === 1)
        return reply('平地任务 t1 开了，在等它做完；东边那排还没看。', [{ id: 'c_more', name: 'get_status' }])
      },
    )
    h.agent.handleEvent(told('把这块地平一下'))
    await waitFor('the talk line heard about the cut', () => h.talk.requests.length === 2)
    await h.agent.whenIdle()

    assert.equal(h.llm.requests.length, 4)
    assert.deepEqual(h.llm.requests.map((r) => r.toolChoice), [undefined, undefined, undefined, 'none'])
    assert.ok(
      h.llm.lastUserText(3).endsWith('[系统] 这一轮到了每轮 3 步的上限。再给你一步收尾，这一步之后这一轮就结束了，没做完的要等下次被叫醒才能接着做。这一步调不了工具（调了也不会执行）；写的字和一轮结束时留下的话一样，送给对话线。'),
      h.llm.lastUserText(3),
    )
    // 它收尾的时候，对话线看到的干活线的现状
    assert.match(h.talk.lastUserText(0), /\n干活线：在忙。第 \d+ 轮（.*），已经想完 3 步，正在想第 4 步（到了每轮 3 步的上限，这是收尾的一步：不能调工具，写完这一轮就结束）。\n/)
    // 收尾那一步要的工具没执行
    const turn = h.history.get().turns[0]!
    assertToolPairs(turn.messages)
    assert.deepEqual(resultIn(turn.messages, 'c_more'), { isError: true, content: 'Not executed: this was the one closing step given at the step limit, and in it no tools run. The turn ended after that step.' })
    // 程序替它报给对话线（叫醒对话线）：被截断了、它收尾时写的话原样、它还在等自己开的任务。没有另外的“还在干”那一条
    const report = '干活线这一轮到了每轮 3 步的上限，被截断了。收尾的那一步（不能再调工具）它写的话：平地任务 t1 开了，在等它做完；东边那排还没看。\n它还在干（在等它开的任务结束：t1（flatten）），这些结束时它自己会被叫醒接着做。'
    assert.deepEqual(sentToTalk(h), [report])
    assert.deepEqual(relays(h).map((e) => [e.relay?.type, e.isError]), [['trouble', true]])
    assert.ok(h.talk.lastUserText(1).includes(`干活线出了状况（这句是程序替它报的）：${report}`), h.talk.lastUserText(1))
    assert.deepEqual(modelCalls(h, 'work'), [[1, false, '第 1 步'], [2, false, '第 2 步'], [3, false, '第 3 步'], [4, true, '第 4 步（收尾）']])
    assert.match(turnEnd(h, 'work'), /^第 \d+ 轮结束（调了 4 次模型）：到了每轮 3 步的上限，第 4 步是收尾$/)
    assert.deepEqual(h.game.said, [])
  })

  it('到了上限时今天的模型用量也到了上限：不再调模型收尾，照实写没有收尾；对话线拿到的是它这一轮最后写的话', async (t) => {
    const h = makeAgent({ settings: { maxSteps: 2, dailyTokenLimit: 10_000 } })
    t.after(h.cleanup)
    h.llm.enqueue(reply('', [{ name: 'get_status' }]), () => {
      h.usedTokens.value = 10_000
      return reply('看了两次状态，都正常', [{ name: 'get_status' }])
    })
    h.agent.handleEvent(told('看看你现在什么情况'))
    await waitFor('the talk line was told', () => relays(h, 'trouble').length === 1)
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 2)
    assert.match(turnEnd(h, 'work'), /^第 \d+ 轮结束（调了 2 次模型）：到了每轮 2 步的上限，没有收尾$/)
    assert.deepEqual(sentToTalk(h), ['干活线这一轮到了每轮 2 步的上限，被截断了。没有给它收尾的那一步（今天的模型用量到了上限）；它这一轮最后写的是：看了两次状态，都正常\n它停下来了（身体上没有它开的任务，也没有例程在跑）；要它接着做，带话给它（tell_worker）。'])
  })
})
