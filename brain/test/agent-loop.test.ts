import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BridgeError } from '../src/bridge/protocol.ts'
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

  it('一轮进行中到达的事件排队，本轮结束后合并成一轮；同一时刻只跑一轮', async (t) => {
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
