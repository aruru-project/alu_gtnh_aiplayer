// 一个玩家，两条线（docs/TALK_WORK.md）：对话线听人说话、回话、查资料，它写的文字就是它说的话；干活线操作身体。
// 入口是整个 agent（h.agent）：事件像真实运行时那样进来，两条线各有一个按脚本回应的假模型（h.talk、h.llm），
// 游戏是按方法名应答的假服务器。设计稿最后“实现时要验证的”每一条在这里都有一条对应的测试。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VOLLEY_MAX, lineOf } from '../src/agent/lines.ts'
import { TEXT_NOT_SAID_NOTE } from '../src/agent/agent.ts'
import { DesignWorkspace } from '../src/design/index.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import { LlmError } from '../src/llm/index.ts'
import type { GenerateRequest, GenerateResult } from '../src/llm/index.ts'
import { assertToolPairs, chat, lineCalls, llmDown, makeAgent, relays, reply, says, sentToTalk, taskEnded, told } from './agent-harness.ts'
import type { AgentHarness } from './agent-harness.ts'
import { sleep, tmpDir, waitFor } from './helpers.ts'

/** 一次不回来的模型调用：测试放行（answer），或者被打断（signal）时以 aborted 失败，和真的模型客户端一样。 */
function held(): { script: (req: GenerateRequest) => Promise<GenerateResult>; started: () => boolean; aborted: () => boolean; answer: (r: GenerateResult) => void } {
  let resolve: ((r: GenerateResult) => void) | undefined
  let aborted = false
  return {
    script: (req) =>
      new Promise<GenerateResult>((res, rej) => {
        resolve = res
        req.signal?.addEventListener('abort', () => {
          aborted = true
          rej(new LlmError('aborted', 'stopped'))
        })
      }),
    started: () => resolve !== undefined,
    aborted: () => aborted,
    answer: (r) => resolve?.(r),
  }
}

/** 主人站在 (12,64,3) 面朝北，准星指着 (13,64,2) 的箱子。 */
const POINTING = { block: { x: 12, y: 64, z: 3 }, facing: 'north', lookingAt: { x: 13, y: 64, z: 2, id: 'minecraft:chest', name: 'Chest', kind: 'container' } }

/** 干活线第 n 次请求里“需要你处理的事”那一节（到下一节为止）。 */
function todo(text: string): string {
  return text.split('\n\n[')[0] ?? ''
}

describe('对话线说话：写的字只给主人在面板上看，在游戏里说话用 say、whisper', () => {
  /** 一轮开头那条消息的最后一句（[谁在跟你说话]）。 */
  const closing = (text: string): string => text.split('\n\n').at(-1)!

  it('被面板叫醒：它写的字就是回主人，日志里是一条 reply（不是 say），游戏里一个字都没说；最后一句写着这是主人在面板上说的', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.talk.enqueue(reply('我看一下', [{ name: 'get_status' }]), reply('身上有 64 个泥土'))
    h.agent.handleEvent({ type: 'panel_command', time: Date.now(), text: '你身上有什么' })
    await h.agent.whenIdle()
    assert.deepEqual(h.game.said, [])
    assert.deepEqual(h.game.callsOf('bot.command'), [])
    const log = h.log.recent(0, 200)
    assert.deepEqual(log.filter((e) => e.kind === 'reply').map((e) => [e.agent, e.step, e.who, e.text]), [['talk', 1, 'Alu', '我看一下'], ['talk', 2, 'Alu', '身上有 64 个泥土']])
    assert.deepEqual(log.filter((e) => e.kind === 'say' || e.kind === 'model_text'), [])
    assert.equal(closing(h.talk.lastUserText(0)), '[谁在跟你说话] 这是主人在面板上说的，你写的字他看得到。')
    // 写了字又调工具的那一步，工具结果后面没有别的话（不再有“已经说出去了”）
    assert.deepEqual(h.talk.requests[1]!.messages.at(-1)!.content.map((p) => p.type), ['tool_result'])
    // 聊天记录里：主人在面板上那句，和它在面板上回的（不是在游戏里说的）。干活线翻得到
    assert.deepEqual(h.chatLog.recent().lines.map((l) => [l.kind, l.who, l.text]), [
      ['panel', 'owner (panel)', '你身上有什么'],
      ['replied', 'Alu', '我看一下'],
      ['replied', 'Alu', '身上有 64 个泥土'],
    ])
    assert.match(
      (await lineCalls(h, 'work', 'recent_chat', {})).content,
      /^3 chat line\(s\), oldest first:\n\[[\d:]+\] your owner \(control panel\): 你身上有什么\n\[[\d:]+\] you replied on the panel: 我看一下\n\[[\d:]+\] you replied on the panel: 身上有 64 个泥土$/,
    )
    // 存在 chat-log.json 里，重启以后还在
    h.chatLog.flush()
    await h.agent.stop()
    const again = h.restart()
    t.after(() => again.agent.stop())
    assert.deepEqual(again.chatLog.recent().lines.map((l) => l.kind), ['panel', 'replied', 'replied'])
  })

  it('被游戏聊天叫醒、用 say 回：在公共聊天里说了（先说，再调同一步的别的工具），日志里是 say、channel public，进了聊天记录；最后一句写着要用 say 或 whisper 回', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.talk.enqueue(says('我看一下', [{ name: 'get_status' }]), says('身上有 64 个泥土'))
    h.agent.handleEvent(chat('Steve', 'Alu 你身上有什么'))
    await h.agent.whenIdle()
    assert.deepEqual(h.game.said, ['我看一下', '身上有 64 个泥土'])
    const order = h.game.calls.map((c) => c.method)
    assert.ok(order.indexOf('bot.chat') < order.lastIndexOf('bot.status'), `said before the other tool of the same step ran: ${order.join(' ')}`)
    const said = h.log.recent(0, 200).filter((e) => e.kind === 'say')
    assert.deepEqual(said.map((e) => [e.agent, e.step, e.who, e.channel, e.to, e.text]), [['talk', 1, 'Alu', 'public', undefined, '我看一下'], ['talk', 2, 'Alu', 'public', undefined, '身上有 64 个泥土']])
    assert.equal(h.talk.requests[1]!.messages.at(-1)!.content.find((p) => p.type === 'tool_result' && p.content.startsWith('Said'))?.type, 'tool_result')
    assert.equal(closing(h.talk.lastUserText(0)), '[谁在跟你说话] Steve 是在游戏聊天里对你说的；要回他得用 say（所有人都看到）或 whisper（只有那个人看到），只写字他看不到。')
    assert.deepEqual(h.chatLog.recent().lines.map((l) => [l.kind, l.who, l.text]), [
      ['chat', 'Steve', 'Alu 你身上有什么'],
      ['said', 'Alu', '我看一下'],
      ['said', 'Alu', '身上有 64 个泥土'],
    ])
  })

  it('被游戏聊天叫醒却只写了字：游戏里没说；日志里看得出它只写了字（一条 reply，没有 say）', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.talk.enqueue(reply('身上有 64 个泥土'))
    h.agent.handleEvent(chat('Steve', 'Alu 你身上有什么'))
    await h.agent.whenIdle()
    assert.deepEqual(h.game.said, [])
    assert.deepEqual(h.log.recent(0, 200).filter((e) => e.kind === 'reply' || e.kind === 'say').map((e) => [e.kind, e.text]), [['reply', '身上有 64 个泥土']])
    // 聊天记录里那句是“在面板上回的”，不是“说的”
    assert.deepEqual(h.chatLog.recent().lines.map((l) => [l.kind, l.text]), [['chat', 'Alu 你身上有什么'], ['replied', '身上有 64 个泥土']])
  })

  it('几个人一起叫醒它：游戏里说的、悄悄说的、面板上说的各写一句；没有人说话的一轮（干活线停下来了）写着游戏里的人看不到它写的字', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.talk.enqueue(reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    h.agent.handleEvent(chat('Bob', 'Alu 也帮我看看'))
    h.agent.handleEvent({ type: 'whisper', time: Date.now(), from: 'Eve', message: '偷偷问一句' })
    h.agent.handleEvent({ type: 'panel_command', time: Date.now(), text: '先别理他们' })
    await h.agent.whenIdle()
    assert.equal(
      closing(h.talk.lastUserText(0)),
      '[谁在跟你说话] Steve、Bob 是在游戏聊天里对你说的；要回他们得用 say（所有人都看到）或 whisper（只有那个人看到），只写字他们看不到。 Eve 是在游戏里悄悄对你说的；要回他得用 whisper 或 say，只写字他看不到。 面板上那句是主人说的，你写的字他看得到。',
    )
    h.llm.enqueue(reply('挖完了'))
    h.agent.handleEvent(told('挖个坑', []))
    await h.agent.whenIdle()
    assert.equal(closing(h.talk.lastUserText(h.talk.requests.length - 1)), '[谁在跟你说话] 这一轮没有人跟你说话。你写的字只有主人在面板上看得到，游戏里的人看不到；要在游戏里说话用 say 或 whisper。')
  })

  it('它查东西的时候游戏里有人说了一句：接在工具结果后面的那段也以“谁在跟你说话”结尾', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const status = h.game.handlers['bot.status']!
    let asked = 0
    h.game.handlers['bot.status'] = (p) => {
      // 第 1 次是开这一轮时的状态快照，第 2 次是它调的 get_status：这时 Steve 说了一句
      if (++asked === 2) h.agent.handleEvent(chat('Steve', 'Alu 顺便看看铁'))
      return status(p)
    }
    h.talk.enqueue(reply('', [{ name: 'get_status' }]), reply(''))
    h.agent.handleEvent({ type: 'panel_command', time: Date.now(), text: '看看背包' })
    await h.agent.whenIdle()
    assert.match(h.talk.lastUserText(1), /Steve 说：Alu 顺便看看铁\n\n\[谁在跟你说话\] Steve 是在游戏聊天里对你说的；要回他得用 say（所有人都看到）或 whisper（只有那个人看到），只写字他看不到。$/)
  })

  it('say 的结果照实：分成几行、截了尾、丢了几行、一行都没排进去（不算说过）、身体不在线；markdown 记号去掉，开头的 / 不会被当成指令', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const replies: unknown[] = [{ lines: 10, cutChars: 250 }, { lines: 1, droppedLines: 2 }, { lines: 0, droppedLines: 3 }, { lines: 1 }, { lines: 1 }]
    h.game.handlers['bot.chat'] = () => replies.shift() ?? {}
    assert.deepEqual(await lineCalls(h, 'talk', 'say', { text: '长'.repeat(1250) }), {
      content: 'Said in public chat, as 10 lines of at most 100 characters, going out about one a second. The last 250 characters were cut off: one say holds at most 1000. Say the rest in another say.',
      isError: false,
    })
    assert.deepEqual(await lineCalls(h, 'talk', 'say', { text: '第二段' }), { content: 'Said in public chat. The last 2 line(s) were not sent: too many chat lines of yours were still waiting to go out.', isError: false })
    assert.deepEqual(await lineCalls(h, 'talk', 'say', { text: '第三段' }), {
      content: 'Nothing was said: its 3 line(s) could not be queued, because too many chat lines of yours are still waiting to go out. Say it again in a few seconds.',
      isError: true,
    })
    const said = h.log.recent(0, 200).filter((e) => e.kind === 'say')
    assert.deepEqual(said.map((e) => [e.text.length, e.sent]), [[1000, { lines: 10, cutChars: 250 }], [3, { lines: 1, droppedLines: 2 }]])
    assert.match(said[0]!.detail ?? '', /最后 250 个字被截掉了/)
    // 截掉的那 250 个字不算说过：日志和聊天记录里都是真的说出去的 1000 个
    assert.deepEqual(h.chatLog.recent().lines.filter((l) => l.kind === 'said').map((l) => l.text.length), [1000, 3])
    await lineCalls(h, 'talk', 'say', { text: '**铁锭**够了：\n- `minecraft:iron_ingot` 3 个\n- 2*3*4 = 24\n### 就这些' })
    await lineCalls(h, 'talk', 'say', { text: '/op Steve' })
    assert.deepEqual(h.game.said.slice(-2), ['铁锭够了： minecraft:iron_ingot 3 个 2*3*4 = 24 就这些', 'op Steve'])
    assert.deepEqual(h.game.callsOf('bot.command'), [])
    h.game.handlers['bot.chat'] = () => {
      throw new BridgeError('offline', 'bot Alu is not online')
    }
    const offline = await lineCalls(h, 'talk', 'say', { text: '我在' })
    assert.equal(offline.isError, true)
    assert.match(offline.content, /offline: bot Alu is not online/)
    assert.equal(h.log.recent(0, 200).filter((e) => e.kind === 'say').length, 4)
  })

  it('悄悄话用 whisper：日志里是 say、channel whisper，text 只有原话，发给谁在 to 里；干活线调 say、whisper 都不归它', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.game.handlers['bot.command'] = () => ({ output: ['You whisper to Steve: 箱子在 30 64 30'] })
    assert.deepEqual(await lineCalls(h, 'talk', 'whisper', { player: 'Steve', message: '箱子在 30 64 30' }), { content: 'Whisper sent.', isError: false })
    assert.deepEqual(h.game.callsOf('bot.command'), [{ bot: 'Alu', command: 'tell Steve 箱子在 30 64 30' }])
    const said = h.log.recent(0, 200).filter((e) => e.kind === 'say')
    assert.deepEqual(said.map((e) => [e.channel, e.to, e.text]), [['whisper', 'Steve', '箱子在 30 64 30']])
    assert.ok(h.chatLog.recent().lines.some((l) => l.kind === 'whispered' && l.to === 'Steve' && l.text === '箱子在 30 64 30'))
    assert.deepEqual(h.game.said, [])
    // 翻自己的日志时看得出是悄悄话、发给谁
    assert.match((await lineCalls(h, 'talk', 'read_log', { kinds: ['said'] })).content, /· say Alu \(whisper to Steve\): 箱子在 30 64 30/)
    const notMine = 'Not done: "say" is not yours. The worker line does not speak to players; the talk line does. Tell it in the text that ends your turn, or with report (a plain report waits until the talk line is next woken; question: true wakes it), and it decides what to say to whom.'
    assert.deepEqual(await lineCalls(h, 'work', 'say', { text: '石砖不够' }), { content: notMine, isError: true })
    assert.deepEqual(h.game.said, [])
  })

  it('不会自己叫醒自己、两个 bot 不会互相套娃：它 say 出去的话回到大脑不叫醒它；另一个 bot 叫它的名字不叫醒它；有人进服、离开只作背景', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.talk.enqueue(says('在的'))
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    await h.agent.whenIdle()
    const calls = h.talk.requests.length
    // 身体把它自己说的那句当成聊天推回来
    h.agent.handleBridgeEvent({ seq: 1, time: Date.now(), event: 'chat', data: { player: 'Alu', message: '在的' } })
    // 另一个 bot 在公共聊天里叫它
    h.agent.handleBridgeEvent({ seq: 2, time: Date.now(), event: 'chat', data: { player: 'Robo', message: 'Alu 你好呀', isBot: true } })
    h.agent.handleBridgeEvent({ seq: 3, time: Date.now(), event: 'player.join', data: { player: 'Bob' } })
    h.agent.handleBridgeEvent({ seq: 4, time: Date.now(), event: 'player.leave', data: { player: 'Bob' } })
    await sleep(100)
    await h.agent.whenIdle()
    assert.equal(h.talk.requests.length, calls)
    assert.equal(h.llm.requests.length, 0)
    // 下一轮它在背景里看到这几件（自己说的那句不重复出现）
    h.agent.handleEvent(chat('Steve', 'Alu 刚才谁来了'))
    await h.agent.whenIdle()
    const background = h.talk.lastUserText(h.talk.requests.length - 1).split('[最近发生的事')[1]?.split('[当前状态]')[0] ?? ''
    assert.match(background, /Robo（另一个 bot） 说：Alu 你好呀/)
    assert.match(background, /Bob 进入了服务器[\s\S]*Bob 离开了服务器/)
    assert.equal(background.includes('在的'), false)
  })

  it('程序替它说的那句（模型接口出错）：这一轮是面板上叫醒的只写在面板上（reply），游戏里的人叫醒的才在游戏里说（say、channel public）；两处各自限频', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.talk.enqueue(llmDown())
    h.agent.handleEvent({ type: 'panel_command', time: Date.now(), text: '你在吗' })
    await waitFor('the outage was noted', () => h.log.recent(0, 200).some((e) => e.kind === 'reply'))
    await h.agent.whenIdle()
    assert.deepEqual(h.game.said, [])
    const written = h.log.recent(0, 200).find((e) => e.kind === 'reply')!
    assert.deepEqual([written.agent, written.text, written.detail], ['talk', '我这边模型接口连不上了，先歇一会儿，好了再继续。', '这句话是程序替它说的，不是模型说的。这一轮不是游戏里的人叫醒的，所以只写在面板上、没在游戏里说'])
    assert.deepEqual(h.chatLog.recent().lines.filter((l) => l.kind === 'replied').map((l) => l.text), ['我这边模型接口连不上了，先歇一会儿，好了再继续。'])
    // 接口好了一会儿又坏了，这回是游戏里的人叫醒的：面板上那句不挡着它在游戏里说（限频各算各的）
    h.talk.enqueue(llmDown())
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    await waitFor('said in the game', () => h.game.said.length === 1)
    await h.agent.whenIdle()
    assert.deepEqual(h.game.said, ['我这边模型接口连不上了，先歇一会儿，好了再继续。'])
    const said = h.log.recent(0, 200).filter((e) => e.kind === 'say')
    assert.deepEqual(said.map((e) => [e.agent, e.channel, e.detail]), [['talk', 'public', '这句话是程序替它说的，不是模型说的']])
    assert.deepEqual(h.chatLog.recent().lines.filter((l) => l.kind === 'said').map((l) => l.text), ['我这边模型接口连不上了，先歇一会儿，好了再继续。'])
  })

  it('大脑升级以后头一回：历史里有以前的轮（那时写的字就是说出去的话），对话线下一轮在背景里被告知一次；之后、重启以后都不再说；写交接记录时以前那些字标成说出去的话', async (t) => {
    const h = makeAgent({ talkSettings: { historyTokenThreshold: 3000 } })
    t.after(h.cleanup)
    await h.agent.stop()
    // 以前的数据：对话线的历史里有一轮，那时它写的字是在公共聊天里说的；状态里没有“从什么时候起写的字不说进游戏”
    h.talkHistory.appendTurn({
      id: h.talkHistory.newTurnId(),
      startedAt: Date.now() - 3_600_000,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '[需要你处理的事]\n[10:00:00] Steve 说：Alu 在吗' }] },
        { role: 'assistant', content: [{ type: 'text', text: `在的在的${'。'.repeat(4000)}` }] },
      ],
    })
    h.talkPersisted.state = { tracked: [], endedSeen: [], queue: [] }
    const again = h.restart()
    t.after(() => again.agent.stop())
    assert.ok(again.log.recent(0, 50).some((e) => e.kind === 'info' && e.text.startsWith('大脑升级：从这次启动起，对话线写的字不再说进游戏聊天')))
    const summaries: string[] = []
    again.talk.auto = (_seen, req) => {
      if (req.tools.length > 0) return reply(`写给主人看的：${'字'.repeat(4000)}`)
      summaries.push(req.messages.map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')).join('\n'))
      return reply('记录')
    }
    again.agent.handleEvent({ type: 'panel_command', time: Date.now(), text: '在吗' })
    await again.agent.whenIdle()
    const background = (n: number) => again.talk.lastUserText(n).split('[最近发生的事')[1]?.split('[当前状态]')[0] ?? ''
    assert.ok(background(0).includes(TEXT_NOT_SAID_NOTE))
    assert.equal(again.talkPersisted.state?.textNotSaidTold, true)
    again.agent.handleEvent({ type: 'panel_command', time: Date.now(), text: '还在吗' })
    await again.agent.whenIdle()
    assert.equal(background(again.talk.requests.filter((r) => r.tools.length > 0).length - 1).includes('大脑升级了'), false)
    // 写交接记录时：以前那一轮的字是“在公共聊天里说的话”，升级以后的是“写的字”
    for (const words of ['再说一句', '又一句', '最后一句']) {
      again.agent.handleEvent({ type: 'panel_command', time: Date.now(), text: words })
      await again.agent.whenIdle()
    }
    assert.ok(summaries.length >= 2, 'the talk history was summarised')
    assert.match(summaries.join('\n'), /\[它在公共聊天里说的话\] 在的在的/)
    assert.match(summaries.join('\n'), /\[它写的字（只有主人在面板上看得到）\] 写给主人看的/)
    assert.equal(/\[它在公共聊天里说的话\] 写给主人看的/.test(summaries.join('\n')), false)
    // 再重启：不再告诉它，也不再记那条日志
    await again.agent.stop()
    const third = h.restart()
    t.after(() => third.agent.stop())
    assert.equal(third.log.recent(0, 50).some((e) => e.text.startsWith('大脑升级：从这次启动起，对话线写的字')), false)
    const before = third.talk.requests.length
    third.talk.auto = undefined
    third.agent.handleEvent({ type: 'panel_command', time: Date.now(), text: '在吗' })
    await third.agent.whenIdle()
    assert.equal(third.talk.lastUserText(before).includes('大脑升级了'), false)
  })

  it('没有以前的数据（头一回启动）：不说大脑升级了', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.agent.handleEvent({ type: 'panel_command', time: Date.now(), text: '在吗' })
    await h.agent.whenIdle()
    assert.equal(h.talk.lastUserText(0).includes('大脑升级了'), false)
    assert.equal(h.log.recent(0, 50).some((e) => e.text.startsWith('大脑升级：从这次启动起，对话线写的字')), false)
  })
})

describe('对话线把事交给干活线', () => {
  it('主人指着一个箱子说“把这个拆了”：对话线同一步里应一声并交出去；干活线拿到的是主人的原话和他指着的坐标，不是对话线的转述', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 对话线的转述故意不带坐标、说得含糊：干活线要靠原样附上的那句话知道是哪个
    h.talk.enqueue(says('好，我去拆。', [{ id: 'tell', name: 'tell_worker', input: { text: '把主人指的那个东西拆掉' } }]), reply(''))
    const at = Date.now()
    h.agent.handleEvent({ ...chat('Steve', 'Alu 把这个拆了', at), speaker: POINTING })
    await h.agent.whenIdle()

    // 回话只用了对话线的一次模型调用，而且先于交事说出去
    assert.deepEqual(h.game.said, ['好，我去拆。'])
    assert.equal(h.talk.requests.length, 2)
    // 干活线被叫醒，看到的那件事：对话线写的一句 + 程序原样附上的原话、站位和指向
    assert.equal(h.llm.requests.length, 1)
    const clock = new Date(at).toTimeString().slice(0, 8)
    assert.equal(
      todo(h.llm.lastUserText(0)).split('\n').slice(1).join('\n'),
      [
        `[${clock}] 对话线交给你的（这一句是它写的）：把主人指的那个东西拆掉`.replace(clock, todo(h.llm.lastUserText(0)).slice(11, 19)),
        '  当时的原话（程序原样附上的，不是转述；括号里是说话的人站在哪、指着什么）：',
        `    [${clock}] Steve 说：Alu 把这个拆了`,
        '      （Steve 站在 (12,64,3) 面朝北，指着 Chest (13,64,2)［容器］）',
      ].join('\n'),
    )
    // 对话线从工具结果里知道交出去了、附了什么
    const result = h.talk.requests[1]!.messages.at(-1)!.content.find((p) => p.type === 'tool_result' && p.toolCallId === 'tell')!
    assert.equal(
      result.type === 'tool_result' ? result.content : '',
      'Handed to the worker. The worker was idle and starts on it now. Attached as they were said: 1 line(s) from the people who woke you this turn, with where they stood and what they pointed at. When a task or routine it started ends, the worker is woken by itself and carries on; nothing has to remind it. What it reports or asks, and what it leaves when it has stopped, come to you as events.',
    )
    // 面板的日志里这次往来是一条 relay：谁交给谁、附了几句原话，详情里是交过去的全文
    const relay = relays(h, 'tell')
    assert.equal(relay.length, 1)
    assert.deepEqual([relay[0]!.agent, relay[0]!.step, relay[0]!.relay, relay[0]!.text], ['talk', 1, { type: 'tell', from: 'talk', to: 'work', quotes: 1 }, '对话线 → 干活线：把主人指的那个东西拆掉'])
    assert.match(relay[0]!.detail ?? '', /Steve 说：Alu 把这个拆了\n {6}（Steve 站在 \(12,64,3\) 面朝北，指着 Chest \(13,64,2\)［容器］）/)
    // 玩家说的话只到对话线：干活线没有另外收到那句聊天
    assert.equal(h.llm.lastUserText(0).split('Alu 把这个拆了').length - 1, 1)
  })

  it('同一轮里再交一件事：原话不重复附；中途主人又说了一句，下一次交事附的是新的那句；没有人说话的那一轮（它自己的决定）写明没有附', async (t) => {
    const h = makeAgent({ timing: { debounceMs: 30 } })
    t.after(h.cleanup)
    const status = h.game.handlers['bot.status']!
    let asked = 0
    h.game.handlers['bot.status'] = (p) => {
      // 对话线第 2 步查状态的时候，主人补了一句
      if (++asked === 2) h.agent.handleEvent(chat('Steve', '顺便带点煤'))
      return status(p)
    }
    h.talk.enqueue(
      reply('好', [{ name: 'tell_worker', input: { text: '去仓库拿铁' } }, { name: 'tell_worker', input: { text: '拿完放进箱子' } }]),
      reply('', [{ name: 'get_status' }]),
      reply('', [{ name: 'tell_worker', input: { text: '再带点煤' } }]),
      reply(''),
    )
    h.agent.handleEvent(chat('Steve', 'Alu 去仓库拿点铁放箱子里'))
    await waitFor('the worker got all three', () => relays(h, 'tell').length === 3)
    await h.agent.whenIdle()
    assert.deepEqual(relays(h, 'tell').map((e) => e.relay!.quotes), [1, 0, 1])
    const seen = h.llm.requests.map((_, n) => h.llm.lastUserText(n)).join('\n')
    assert.match(seen, /拿完放进箱子\n {2}（这一轮里的人的原话已经随上一条附过，这里不重复。）/)
    assert.match(seen, /对话线交给你的（这一句是它写的）：再带点煤\n {2}当时的原话（[^\n]*\n {4}\[[\d:]+\] Steve 说：顺便带点煤/)
    assert.equal(seen.split('Steve 说：Alu 去仓库拿点铁放箱子里').length - 1, 1)

    // 提醒到点叫醒对话线（没有人说话），它自己决定交一件事
    h.talk.enqueue(reply('', [{ name: 'tell_worker', input: { text: '去看看作物熟了没' } }]), reply(''))
    const before = h.llm.requests.length
    h.agent.handleEvent({ type: 'reminder', time: Date.now(), note: '看作物' })
    await h.agent.whenIdle()
    assert.match(h.llm.lastUserText(before), /对话线交给你的（这一句是它写的）：去看看作物熟了没\n {2}（这次没有附原话：对话线这一轮不是被谁说的话叫醒的，是它自己的决定。）/)
    assert.match(h.talk.lastUserText(h.talk.requests.length - 1), /Nothing was attached: no one spoke to you this turn\./)
  })

  it('干活线把料放进机器就走，给自己定了个提醒：到点叫醒的是干活线，带着它写的那句话，对话线不知道这回事；对话线定的照旧叫醒对话线；各自的状态里只列自己定的', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 干活线定一个 4 分钟的；对话线定一个 30 分钟的
    h.llm.enqueue(reply('', [{ name: 'set_reminder', input: { minutes: 4, note: '去压模机取 4 根柄和模头' } }]), reply(''))
    h.agent.handleEvent(told('压 4 根柄'))
    await h.agent.whenIdle()
    h.talk.enqueue(reply('', [{ name: 'set_reminder', input: { minutes: 30, note: '问问 Steve 柄够不够' } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 半小时后问我一声'))
    await h.agent.whenIdle()
    assert.deepEqual(h.reminders.map((r) => [r.note, r.line, Math.round((r.dueAt - Date.now()) / 60_000)]), [['去压模机取 4 根柄和模头', 'work', 4], ['问问 Steve 柄够不够', 'talk', 30]])

    // 干活线定的到点了
    const [workBefore, talkBefore] = [h.llm.requests.length, h.talk.requests.length]
    h.llm.enqueue(reply(''))
    h.agent.handleEvent({ type: 'reminder', time: Date.now(), note: '去压模机取 4 根柄和模头', line: 'work' })
    await h.agent.whenIdle()
    assert.deepEqual([h.llm.requests.length - workBefore, h.talk.requests.length - talkBefore], [1, 0])
    const woken = h.llm.lastUserText(workBefore)
    assert.match(woken, /你给自己定的提醒到点了：去压模机取 4 根柄和模头/)
    // 它的状态里列着它自己定的那一个，没有对话线的
    assert.match(woken, /Pending reminders: \d 分钟后「去压模机取 4 根柄和模头」\n/)
    assert.doesNotMatch(woken, /问问 Steve/)

    // 对话线定的到点了：叫醒的是对话线，状态里列的是它自己的
    h.talk.enqueue(reply(''))
    h.agent.handleEvent({ type: 'reminder', time: Date.now(), note: '问问 Steve 柄够不够', line: 'talk' })
    await h.agent.whenIdle()
    assert.deepEqual([h.llm.requests.length - workBefore, h.talk.requests.length - talkBefore], [1, 1])
    const talkWoken = h.talk.lastUserText(h.talk.requests.length - 1)
    assert.match(talkWoken, /你给自己定的提醒到点了：问问 Steve 柄够不够/)
    assert.match(talkWoken, /Pending reminders: \d+ 分钟后「问问 Steve 柄够不够」\n/)
    assert.doesNotMatch(talkWoken, /去压模机取/)
  })

  it('干活线正连着做一串事时主人说话：对话线只用一次模型调用就回了话，干活线那一轮不受影响，那句话也没有进它的上下文', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 干活线：第 1 步查状态，第 2 步的模型调用一直没回来（它正在想）
    const thinking = held()
    h.llm.enqueue(reply('', [{ name: 'get_status' }]), thinking.script, reply('', [{ name: 'go_to', input: { x: 5, y: 64, z: 5 } }]), reply(''), reply('搬完了'))
    h.agent.handleEvent(told('把圆石搬到箱子里'))
    await waitFor('the worker is thinking about step 2', thinking.started)
    const turn = h.agent.state('work').turn!.id

    h.talk.enqueue(says('35 个空格'))
    const asked = Date.now()
    h.agent.handleEvent(chat('Steve', 'Alu 你身上还有几个空格'))
    await waitFor('the talk line answered', () => h.game.said.length === 1)
    // 回话的这一刻干活线还在想同一步：它没有被打断，也没有东西排到它那里。话是对话线第一次模型调用里说的
    assert.deepEqual(h.game.said, ['35 个空格'])
    assert.deepEqual(h.log.recent(0, 200).filter((e) => e.kind === 'say').map((e) => [e.agent, e.step]), [['talk', 1]])
    assert.ok(Date.now() - asked < 1000)
    const work = h.agent.state('work')
    assert.deepEqual([work.model.state, work.turn!.id, work.model.step, work.pending], ['thinking', turn, 2, 0])
    assert.equal(thinking.aborted(), false)

    // 干活线接着把活做完；主人那句闲话从头到尾没有出现在它看到的任何内容里
    thinking.answer(reply('', [{ name: 'get_status' }]))
    await h.agent.whenIdle()
    assert.equal(h.game.callsOf('task.start').length, 1)
    h.agent.handleEvent(taskEnded('t1', 'done', { type: 'goto' }))
    await h.agent.whenIdle()
    assert.deepEqual(sentToTalk(h), ['搬完了'])
    assert.equal(JSON.stringify(h.llm.requests).includes('几个空格'), false)
    assert.equal(h.history.get().turns.length, 2)
  })

  it('对话线带的话在干活线的下一步就看到（接在工具结果后面），不用等它这一轮结束', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const status = h.game.handlers['bot.status']!
    let asked = 0
    h.game.handlers['bot.status'] = (p) => {
      // 第 1 次是干活线开这一轮时的状态快照，第 2 次是它调的 get_status：这时对话线带了一句话
      if (++asked === 2) h.agent.handleEvent(told('改成放到左边的箱子', [chat('Steve', 'Alu 放左边那个箱子')]))
      return status(p)
    }
    h.llm.enqueue(reply('', [{ name: 'get_status' }]), reply('知道了，放左边'))
    h.agent.handleEvent(told('把圆石搬到箱子里'))
    await h.agent.whenIdle()
    const second = h.llm.requests[1]!.messages.at(-1)!
    assert.deepEqual(second.content.map((p) => p.type), ['tool_result', 'text'])
    assert.match(h.llm.lastUserText(1), /\[需要你处理的事（你做上一步的时候新到的）\]\n\[[\d:]+\] 对话线交给你的（这一句是它写的）：改成放到左边的箱子\n[^\n]*\n {4}\[[\d:]+\] Steve 说：Alu 放左边那个箱子/)
    assert.equal(h.llm.requests.length, 2)
    assert.equal(h.history.get().turns.length, 1)
  })
})

describe('叫停', () => {
  function withRoutines(t: { after(fn: () => void): void }): AgentHarness {
    const tmp = tmpDir()
    const h = makeAgent({ dir: tmp.dir, design: new DesignWorkspace({ dataDir: tmp.dir }) })
    t.after(async () => {
      await h.agent.stop()
      tmp.cleanup()
    })
    // 和真实的身体一样：取消时先发“任务被取消”的事件，再回响应（里面有被取消的 id）
    const live = new Set<string>()
    const start = h.game.handlers['task.start']!
    h.game.handlers['task.start'] = (p) => {
      const res = start(p) as { task: { id: string } }
      live.add(res.task.id)
      return res
    }
    h.game.handlers['task.cancel'] = (p) => {
      const ids = [...live].filter((id) => p.id === undefined || p.id === id)
      for (const id of ids) {
        live.delete(id)
        h.agent.handleEvent(taskEnded(id, 'canceled', { type: 'goto' }))
      }
      return { canceled: ids.length, ids }
    }
    return h
  }

  it('主人说“停”：stop_work 一次调用，身体的任务和例程都取消，干活线正在想的那一步被打断；之后它不会自己接着干，直到有新的交代，那时它看得到自己是被叫停的、原话是什么', async (t) => {
    const h = withRoutines(t)
    // 干活线：开了一个来回走的例程（例程开了任务 t1），接着又领了一件事，正想到第 2 步
    h.llm.enqueue(reply('', [{ name: 'start_routine', input: { code: `await tool('go_to', { x: 50, z: 50 }); await tool('go_to', { x: 0, z: 0 }); return 'back'`, name: '来回走' } }]), reply(''))
    h.agent.handleEvent(told('来回走一趟'))
    await waitFor('the routine started its first task', () => h.game.callsOf('task.start').length === 1)
    await h.agent.whenIdle()
    const thinking = held()
    h.llm.enqueue(reply('', [{ id: 'look', name: 'get_status' }]), thinking.script)
    // 它查状态的那一步期间又来了一句带话：这句已经接进它正在想的第 2 步里了（它还没看到）
    const status = h.game.handlers['bot.status']!
    let asked = 0
    h.game.handlers['bot.status'] = (p) => {
      if (++asked === 2) h.agent.handleEvent(told('箱子看完顺手关上'))
      return status(p)
    }
    h.agent.handleEvent(told('顺便看看箱子里有什么'))
    await waitFor('the worker is thinking about step 2', thinking.started)
    assert.match(h.llm.lastUserText(h.llm.requests.length - 1), /你做上一步的时候新到的[\s\S]*箱子看完顺手关上/)
    // 还有一件事刚到，排着没处理
    h.agent.handleEvent(told('再去挖点土'))
    const turn = h.agent.state('work').turn!.id
    const workCalls = h.llm.requests.length

    h.talk.enqueue(reply('停了', [{ id: 'stop', name: 'stop_work', input: { reason: '主人让停' } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 停！别走了'))
    await h.agent.whenIdle()

    // 身体：任务全部取消（一次不带 id 的取消），例程停了，没有再开第二个任务
    assert.ok(h.game.callsOf('task.cancel').some((p) => p.id === undefined), 'one cancel for everything')
    assert.deepEqual([h.agent.status().routine!.status, h.agent.status().routine!.ending], ['stopped', 'everything was stopped (stop_work)'])
    assert.equal(h.game.callsOf('task.start').length, 1)
    // 干活线：正在进行的那次模型调用被打断，这一轮结束了，排着的那件事也没有开始
    assert.equal(thinking.aborted(), true)
    // 日志里那一步照实写成被叫停，不算出错（“大脑在停”说的是进程要停，不是这回事）
    const interrupted = h.log.recent(0, 500).filter((e) => e.kind === 'model_call' && e.agent === 'work' && e.turn === turn).at(-1)!
    assert.deepEqual([interrupted.step, interrupted.call!.state, interrupted.call!.stop, interrupted.call!.errorKind, interrupted.call!.error, interrupted.isError === true], [2, 'halted', 'halted', undefined, undefined, false])
    assert.match(interrupted.text, /^第 2 步：想到一半被叫停了（\d+\.\d 秒）$/)
    assert.deepEqual([h.agent.state('work').turn, h.agent.state('work').pending], [null, 0])
    assert.equal(h.llm.requests.length, workCalls)
    // 它不会因为“被叫停了”、例程的结局、任务被取消这几件事自己再想一轮
    await sleep(80)
    assert.equal(h.llm.requests.length, workCalls)
    // 对话线知道停下了什么
    const result = h.talk.requests[1]!.messages.at(-1)!.content.find((p) => p.type === 'tool_result')!
    assert.equal(
      result.type === 'tool_result' ? result.content : '',
      `Stopped. The worker was interrupted in turn ${turn} at step 2; the tool calls it had not yet made were not made. Routine r1 was stopped. 1 task(s) of the body were canceled (t1); what they had already done stays done. 2 event(s) the worker had not handled yet were set aside (it can still see them as background). The worker has been told it was stopped, with your reason and what was said to you this turn. It does nothing more until something new reaches it, such as a tell_worker.`,
    )
    const relay = relays(h, 'stop')
    assert.deepEqual([relay.length, relay[0]!.agent, relay[0]!.relay], [1, 'talk', { type: 'stop', from: 'talk', to: 'work', quotes: 1 }])
    assert.match(relay[0]!.text, new RegExp(`^对话线 → 干活线：停（主人让停）。打断了干活线的第 ${turn} 轮（第 2 步），停掉例程 r1，取消了 1 个身体任务，放下了 2 件它还没处理的事。$`))
    // 被打断的那一轮做过的一步留在它的历史里，写明停在这里；工具调用和结果仍然成对
    const turns = h.history.get().turns
    assertToolPairs(turns.flatMap((x) => x.messages))
    assert.match(JSON.stringify(turns.at(-1)!.messages.at(-1)), /这一轮在这里被叫停了：身体的任务和例程都已经取消/)

    // 有了新的交代它才接着干：这时它看到自己被叫停过（原因、主人的原话）、例程停在哪、当时还有哪件事没看
    h.llm.enqueue(reply(''))
    h.agent.handleEvent(told('现在去仓库'))
    await h.agent.whenIdle()
    const next = h.llm.lastUserText(workCalls)
    assert.match(todo(next), /对话线交给你的（这一句是它写的）：现在去仓库/)
    const background = next.slice(next.indexOf('[最近发生的事'))
    assert.match(background, /你被叫停了（对话线叫的）：主人让停\n {2}身体的任务队列和例程都已经取消，你当时正在想的那一步被打断，还没处理的事也放下了。这条只是告诉你发生了什么，不需要为它做任何事；之后要做什么等新的交代。\n {2}当时的原话（[^\n]*\n {4}\[[\d:]+\] Steve 说：Alu 停！别走了/)
    assert.match(background, /被叫停时你的例程还在跑，已经一起停下/)
    assert.match(background, /对话线交给你的（这一句是它写的）：再去挖点土/)
    // 接进了被打断的那一步、它没来得及看到的那句也在背景里，没有被当成新的事重做
    assert.match(background, /对话线交给你的（这一句是它写的）：箱子看完顺手关上/)
    assert.equal(/再去挖点土|箱子看完顺手关上/.test(todo(next)), false)
    assert.equal(JSON.stringify(h.history.get().turns.at(-2)).includes('箱子看完顺手关上'), false)
  })

  it('它一步都还没想完就被叫停：那件事不重做，留作背景；被叫停时它这一步里还没执行的工具不再执行', async (t) => {
    const h = withRoutines(t)
    const first = held()
    h.llm.enqueue(first.script)
    h.agent.handleEvent(told('去挖 100 个圆石'))
    await waitFor('the worker is thinking', first.started)
    await h.agent.stopWork('', 'panel')
    await h.agent.whenIdle()
    assert.equal(first.aborted(), true)
    assert.equal(h.history.get().turns.length, 0)
    await sleep(50)
    assert.equal(h.llm.requests.length, 1, 'the stopped job is not started again')

    // 一步里要调两个工具，第一个执行到一半时被叫停：第二个不执行，结果里写明为什么
    let stopping: Promise<unknown> | undefined
    const status = h.game.handlers['bot.status']!
    let asked = 0
    h.game.handlers['bot.status'] = (p) => {
      // 第 1 次是开这一轮时的状态快照，第 2 次是它调的 get_status
      if (++asked === 2) stopping = h.agent.stopWork('', 'panel')
      return status(p)
    }
    h.llm.enqueue(reply('', [{ id: 'a', name: 'get_status' }, { id: 'b', name: 'go_to', input: { x: 9, y: 64, z: 9 } }]), reply('不该走到这一步'))
    h.agent.handleEvent(told('先看看再过去'))
    await waitFor('stop was requested', () => stopping !== undefined)
    await stopping
    await h.agent.whenIdle()
    assert.equal(h.game.callsOf('task.start').length, 0)
    const saved = JSON.stringify(h.history.get().turns.at(-1)!.messages)
    assert.match(saved, /Not executed: you were stopped \(stop_work\) before this call ran\./)
    assert.equal(h.llm.requests.length, 2)
    // 背景里，没做成的那件事排在“你被叫停了”前面
    h.llm.enqueue(reply(''))
    h.agent.handleEvent(told('现在呢'))
    await h.agent.whenIdle()
    assert.match(h.llm.lastUserText(2).slice(h.llm.lastUserText(2).indexOf('[最近发生的事')), /你被叫停了（主人在控制面板上按的停止）。/)
    // 一步都没想成的那件事：它在下一轮（上面“先看看再过去”那一轮）的背景里，排在“你被叫停了”前面
    const background = h.llm.lastUserText(1).slice(h.llm.lastUserText(1).indexOf('[最近发生的事'))
    assert.ok(background.indexOf('去挖 100 个圆石') >= 0 && background.indexOf('去挖 100 个圆石') < background.indexOf('你被叫停了（主人在控制面板上按的停止）'))
  })

  it('面板上的总停止和 stop_work 是同一件事；身体没连上、任务取消不了时照实说没取消成', async (t) => {
    const h = withRoutines(t)
    h.llm.enqueue(reply('', [{ name: 'go_to', input: { x: 9, y: 64, z: 9 } }]), reply(''))
    h.agent.handleEvent(told('过去'))
    await h.agent.whenIdle()
    const res = await h.agent.stopWork('手滑了', 'panel')
    assert.deepEqual(res, { tasks: ['t1'], dropped: 0, helpers: [] })
    const relay = relays(h, 'stop')[0]!
    assert.deepEqual([relay.agent, relay.relay, relay.text], [undefined, { type: 'stop', from: 'panel', to: 'work', quotes: 0 }, '面板 → 干活线：停（手滑了）。干活线当时空闲，取消了 1 个身体任务。'])
    await sleep(40)
    assert.equal(h.llm.requests.length, 2, 'being stopped does not wake the worker')

    h.game.connected = false
    const failed = await h.agent.stopWork('', 'panel')
    assert.equal(failed.error, 'disconnected: bridge is not connected to the game server')
    assert.equal(relays(h, 'stop')[1]!.isError, true)
    h.game.connected = true
    // 对话线拿到的那句话里同样写着没取消成
    h.game.handlers['task.cancel'] = () => {
      throw new BridgeError('offline', 'bot Alu is not online')
    }
    const told2 = await lineCalls(h, 'talk', 'stop_work', {}, 'Alu 停')
    assert.match(told2.content, /^Stopped in part\. The worker was idle \(no turn was running\)\. No routine was running\. The body's tasks could NOT be canceled: offline: bot Alu is not online\. They may still be running\./)
  })
})

describe('干活线汇报和提问', () => {
  it('干活线提问 → 对话线答不了就问主人 → 主人回答 → 对话线带话 → 干活线接着干；它自己答得了的直接带话答', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 两条线来回好几趟，谁先谁后不写死：两个假模型都按“这一步看到了什么”来回。
    // 对话线：主人的话 → 应一声并交出去；“放哪个箱子”它自己知道，直接带话答；“用不用车床”它答不了，问主人；主人答了再带话。
    h.talk.auto = (seen) => {
      if (/Steve 说：Alu 行，用车床/.test(seen)) return says('好', [{ name: 'tell_worker', input: { text: '主人同意用车床' } }])
      if (/干活线提问[^\n]*模头/.test(seen)) return says('模头（杆）没库存也没配方，改用车床做钢杆行吗？')
      if (/干活线提问[^\n]*放哪个箱子/.test(seen)) return reply('', [{ name: 'tell_worker', input: { text: '放 (30,64,30) 的箱子，记忆里写着那是成品箱' } }])
      if (/Steve 说：Alu 做一个直升机桨叶/.test(seen)) return says('好，我去做。', [{ name: 'tell_worker', input: { text: '做一个直升机桨叶' } }])
      return undefined
    }
    // 干活线：领了事先问放哪；知道放哪以后查到模头没有，再问；主人同意用车床以后动身
    h.llm.auto = (seen) => {
      if (/主人同意用车床/.test(seen)) return reply('', [{ name: 'go_to', input: { x: 30, y: 64, z: 30 } }])
      if (/放 \(30,64,30\) 的箱子/.test(seen)) return reply('', [{ name: 'report', input: { text: '模头（杆）没有库存也没有配方。查到的链：桨叶 ← 钢杆 ← 压模机(模头（杆）)。要不要改用车床做钢杆？', question: true } }])
      if (/对话线交给你的[^\n]*做一个直升机桨叶/.test(seen)) return reply('', [{ name: 'report', input: { text: '做好的桨叶放哪个箱子？', question: true } }])
      return undefined
    }
    h.agent.handleEvent(chat('Steve', 'Alu 做一个直升机桨叶'))
    await waitFor('the worker asked both questions', () => relays(h, 'question').length === 2)
    await h.agent.whenIdle()

    const workSaw = h.llm.requests.map((_, n) => h.llm.lastUserText(n))
    const talkSaw = h.talk.requests.map((_, n) => h.talk.lastUserText(n))
    // 干活线从工具结果里知道问题送出去了、回答会怎么回来
    assert.ok(workSaw.some((text) => /^Sent to the talk line as a question\. The answer comes back as a message from the talk line: at your next step if you are still working, or by waking you if your turn has ended\./.test(text)))
    // 第一个问题对话线自己答了：带话里写明这次没有附原话（不是主人说的，是它自己的决定）
    assert.ok(talkSaw.some((text) => /干活线提问（它在等回答，用 tell_worker 带话给它）：做好的桨叶放哪个箱子？/.test(text)))
    assert.ok(workSaw.some((text) => /对话线交给你的（这一句是它写的）：放 \(30,64,30\) 的箱子，记忆里写着那是成品箱\n {2}（这次没有附原话：对话线这一轮不是被谁说的话叫醒的，是它自己的决定。）/.test(text)))
    // 第二个问题它答不了：在游戏里问了主人（say），干活线这时在等回答、没有动身
    assert.deepEqual(h.game.said.slice(0, 2), ['好，我去做。', '模头（杆）没库存也没配方，改用车床做钢杆行吗？'])
    assert.equal(h.agent.linkState().waiting?.text.startsWith('模头（杆）没有库存也没有配方。'), true)
    assert.equal(h.game.callsOf('task.start').length, 0)
    assert.equal(h.agent.state('work').turn, null)

    // 主人回答 → 对话线带话 → 干活线接着干
    const before = h.llm.requests.length
    const talkBefore = h.talk.requests.length
    h.agent.handleEvent(chat('Steve', 'Alu 行，用车床'))
    await h.agent.whenIdle()
    // 对话线被主人这句话叫醒的那一轮，状态里写着干活线在等什么
    assert.match(h.talk.lastUserText(talkBefore), /干活线：空闲，没有在想（上一轮（第 \d+ 轮）\d+ 秒前结束）；身体上没有它开的任务，也没有例程在跑。\n {2}它在等你回答（\d+ 秒前问的）：模头（杆）没有库存也没有配方。/)
    assert.match(h.llm.lastUserText(before), /对话线交给你的（这一句是它写的）：主人同意用车床\n[^\n]*\n {4}\[[\d:]+\] Steve 说：Alu 行，用车床/)
    assert.equal(h.game.callsOf('task.start').length, 1)
    assert.equal(h.agent.linkState().waiting, undefined)
    // 干活线的上下文是连着的：接着干的这一轮里看得到它自己当初问的问题
    assert.ok(JSON.stringify(h.llm.requests[before]!.messages).includes('要不要改用车床做钢杆'))
    // 往来在日志里按先后：交事、提问、带话（它自己答的）、提问、带话（主人的回答）
    assert.deepEqual(relays(h).map((e) => `${e.relay!.from}:${e.relay!.type}:${e.relay!.quotes ?? ''}`), ['talk:tell:1', 'work:question:', 'talk:tell:0', 'work:question:', 'talk:tell:1'])
  })

  // 正式服上的事（2026-11-12 夜里）：干活线每铺一片地板就 report 两次，每次都把对话线叫醒，它就在公共聊天里回一句“好，继续。”“累计 1153 格。”，
  // 五分钟里每半分钟说一句。普通汇报不等谁回话，只作背景；要回话的带 question
  it('中途的普通汇报不结束干活线这一轮，也不叫醒对话线（它下次醒来在背景里看到）；一轮结束留下的文字才叫醒它；干活线直接调 say 会被告知这不归它', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(
      reply('', [{ id: 'r', name: 'report', input: { text: '箱子里只有 25 块石砖，还差 15 块，我先去挖。' } }, { id: 's', name: 'say', input: { message: '石砖不够' } }]),
      reply('', [{ name: 'get_status' }]),
      reply('挖够了，40 块石砖都在箱子里。'),
    )
    h.agent.handleEvent(told('盖小屋'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 3)
    assert.deepEqual(sentToTalk(h), ['箱子里只有 25 块石砖，还差 15 块，我先去挖。', '挖够了，40 块石砖都在箱子里。'])
    assert.deepEqual(relays(h).map((e) => [e.agent, e.relay!.type, e.step, e.text]), [
      ['work', 'report', 1, '干活线 → 对话线（汇报，只作背景，没有叫醒它）：箱子里只有 25 块石砖，还差 15 块，我先去挖。'],
      ['work', 'result', 3, '干活线 → 对话线（停下来了，留下的话）：挖够了，40 块石砖都在箱子里。'],
    ])
    const results = h.llm.requests[1]!.messages.at(-1)!.content.filter((p) => p.type === 'tool_result')
    assert.deepEqual(results.map((r) => [r.content, r.isError ?? false]), [
      ['Sent. It does not wake the talk line: it reads this the next time it is woken (someone speaks to it, you ask a question, you stop and leave a note). When you need an answer, send a question.', false],
      ['Not done: "say" is not yours. The worker line does not speak to players; the talk line does. Tell it in the text that ends your turn, or with report (a plain report waits until the talk line is next woken; question: true wakes it), and it decides what to say to whom.', true],
    ])
    assert.deepEqual(h.game.said, [])
    // 对话线只醒了一次（干活线停下来了）：汇报在背景里，留下的话在“需要你处理的事”里
    assert.equal(h.talk.requests.length, 1)
    const opening = h.talk.lastUserText(0)
    assert.match(todo(opening), /干活线停下来了（身体上没有它开的任务，也没有例程在跑），它留下的话：挖够了，40 块石砖都在箱子里。/)
    assert.equal(todo(opening).includes('还差 15 块'), false)
    assert.match(opening.split('[最近发生的事')[1] ?? '', /干活线汇报：箱子里只有 25 块石砖，还差 15 块，我先去挖。/)
  })

  it('干活线能读最近的聊天记录（只读）：更早那句带着指向的话它自己查得到', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.talk.enqueue(says('哪个？是你指着的那个箱子吗'))
    h.agent.handleEvent({ ...chat('Steve', 'Alu 把这个拆了', Date.now() - 60_000), speaker: POINTING })
    await h.agent.whenIdle()
    h.agent.handleEvent(chat('Bob', '今天挖到钻石了'))
    const seen = await lineCalls(h, 'work', 'recent_chat', { minutes: 5 })
    assert.equal(seen.isError, false)
    assert.match(seen.content, /^3 chat line\(s\) in the last 5 minute\(s\), oldest first:\n\[[\d:]+\] Steve: Alu 把这个拆了\n {4}\(Steve 站在 \(12,64,3\) 面朝北，指着 Chest \(13,64,2\)［容器］\)\n\[[\d:]+\] you said: 哪个？是你指着的那个箱子吗\n\[[\d:]+\] Bob: 今天挖到钻石了$/)
    assert.match((await lineCalls(h, 'work', 'recent_chat', { limit: 1 })).content, /^The latest 1 of 3 chat line\(s\), oldest first \(the earlier 2 are not shown: ask with a larger limit, up to 100, or with player\):\n\[[\d:]+\] Bob: 今天挖到钻石了$/)
    assert.match((await lineCalls(h, 'work', 'recent_chat', { player: 'Steve' })).content, /^1 chat line\(s\) by Steve, oldest first:/)
  })
})

describe('干活线还在干的时候留下的话', () => {
  /** 假的游戏照实报任务列表：开了的任务在跑或排着，finish 让它结束并把“任务结束”送回大脑（和真实的身体一样）。 */
  function withTasks(h: AgentHarness): { finish(id: string, result?: Record<string, unknown>): void } {
    const live: { id: string; type: string; state: 'running' | 'queued'; startedAt: number; progress?: { done: number; total: number } }[] = []
    const start = h.game.handlers['task.start']!
    h.game.handlers['task.start'] = (p) => {
      const res = start(p) as { task: { id: string; type: string } }
      live.push({ id: res.task.id, type: res.task.type, state: live.length === 0 ? 'running' : 'queued', startedAt: Date.now() - 12_000, progress: { done: 3, total: 8 } })
      return res
    }
    h.game.handlers['task.list'] = () => ({ active: live[0] ?? null, queue: live.slice(1), recent: [] })
    return {
      finish: (id, result = {}) => {
        const at = live.findIndex((task) => task.id === id)
        const [task] = live.splice(at, 1)
        if (live[0]) live[0].state = 'running'
        h.agent.handleEvent(taskEnded(id, 'done', { type: task!.type, result }))
      },
    }
  }

  // 真实模型上发生过的事（2026-11-11）：主人让它“拿 8 个铁粉再放回 3 个”。干活线开了取料任务，这一轮结束时留了一句
  // “正在取……取到后会放回 3 个”。这句话把对话线叫醒了，对话线以为它停在半路，带话去催；干活线又留一句，对话线又催……
  // 一件两步的小事，对话线带了 4 次话，干活线多跑了三四轮（每次带着 21 万 token 的上下文）。
  it('主人让它“拿 8 个铁粉再放回 3 个”：干活线开了取料任务后留的话只作背景，对话线没有被叫醒；任务结束干活线自己接着放回；全做完了留的话才叫醒对话线，由它说给主人', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    const body = withTasks(h)
    const CHEST = { x: 5, y: 64, z: 5 }
    const DUST = { id: 'gregtech:gt.metaitem.01', meta: 2032 }

    // 1. 主人交代 → 对话线应一声并交出去 → 干活线开了取料任务，留一句话，这一轮结束
    h.talk.enqueue(says('好，我去拿。', [{ id: 'tell', name: 'tell_worker', input: { text: '从箱子里拿 8 个铁粉，再放回去 3 个' } }]), reply(''))
    h.llm.enqueue(reply('', [{ name: 'withdraw_items', input: { container: CHEST, items: [{ ...DUST, count: 8 }] } }]), reply('正在从箱子取 8 个铁粉；取到后会放回 3 个'))
    h.agent.handleEvent(chat('Steve', 'Alu 拿 8 个铁粉再放回 3 个'))
    await h.agent.whenIdle()
    await sleep(40)
    // 这句话到了对话线，但只是背景：它没有为这句话再想一轮，也就没有机会去催
    assert.deepEqual(relays(h).map((e) => [e.relay!.type, e.relay!.waiting ?? null]), [['tell', null], ['progress', '在等它开的任务结束：t1（withdraw）']])
    assert.equal(h.talk.requests.length, 2, 'the talk line is not woken by what the worker leaves while its task runs')
    assert.equal(h.llm.requests.length, 2)
    // 交事的结果里写着这个事实：干活线的任务结束时它自己会接着做
    const told1 = h.talk.requests[1]!.messages.at(-1)!.content.find((p) => p.type === 'tool_result' && p.toolCallId === 'tell')!
    assert.match(told1.type === 'tool_result' ? told1.content : '', / When a task or routine it started ends, the worker is woken by itself and carries on; nothing has to remind it\. What it reports or asks, and what it leaves when it has stopped, come to you as events\.$/)

    // 2. 这时主人问到哪了：对话线从状态里就看得出干活线在等哪个任务、跑了多久、到哪了、任务结束后它自己会接着做
    h.talk.enqueue(says('在取铁粉，取了 3/8'), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 到哪一步了'))
    await h.agent.whenIdle()
    const asked = h.talk.lastUserText(2)
    assert.match(
      asked,
      /\n干活线：还在干，这会儿没有在想——在等它自己开的任务结束。任务一结束（做完、失败或被取消）它自己会被叫醒接着做，不需要提醒。\n {2}它开的任务 t1（withdraw）：在跑，进度 3\/8，已经跑了 1[23] 秒。\n {2}它最近一次送来的（还在干，中途留下的话，\d+ 秒前）：正在从箱子取 8 个铁粉；取到后会放回 3 个\n\n\[谁在跟你说话\] /,
    )
    assert.match(asked.slice(asked.indexOf('[最近发生的事')), /干活线还在干（在等它开的任务结束：t1（withdraw）），这是它中途留下的话：正在从箱子取 8 个铁粉；取到后会放回 3 个/)
    assert.equal(todo(asked).includes('干活线'), false)

    // 3. 取料任务结束：干活线自己被叫醒接着做（没有人带话），开了放回的任务，又留一句——还是背景
    h.llm.enqueue(reply('', [{ name: 'deposit_items', input: { container: CHEST, items: [{ ...DUST, count: 3 }] } }]), reply('取到了，正在放回 3 个'))
    body.finish('t1', { moved: 8 })
    await h.agent.whenIdle()
    await sleep(40)
    assert.deepEqual(h.game.callsOf('task.start').map((p) => (p.task as { type: string }).type), ['withdraw', 'deposit'])
    assert.equal(h.talk.requests.length, 4)

    // 4. 放回的任务也结束：这回它停下来了，留下的话叫醒对话线，对话线说给主人
    h.llm.enqueue(reply('拿了 8 个铁粉，放回 3 个，身上留 5 个。'))
    h.talk.enqueue(says('弄好啦，身上留了 5 个铁粉'), reply(''))
    body.finish('t2', { moved: 3 })
    await h.agent.whenIdle()
    assert.deepEqual(h.game.said, ['好，我去拿。', '在取铁粉，取了 3/8', '弄好啦，身上留了 5 个铁粉'])
    const done = h.talk.lastUserText(4)
    assert.match(todo(done), /干活线停下来了（身体上没有它开的任务，也没有例程在跑），它留下的话：拿了 8 个铁粉，放回 3 个，身上留 5 个。/)
    assert.match(done.slice(done.indexOf('[最近发生的事')), /干活线还在干（在等它开的任务结束：t2（deposit）），这是它中途留下的话：取到了，正在放回 3 个/)
    assert.match(done, /\n干活线：空闲，没有在想（上一轮（第 \d+ 轮）\d+ 秒前结束）；身体上没有它开的任务，也没有例程在跑。\n/)
    // 整件事：对话线只带了一次话；干活线三轮（领事、取完、放完），没有一轮是被催出来的
    assert.deepEqual(relays(h).map((e) => e.relay!.type), ['tell', 'progress', 'progress', 'result'])
    assert.deepEqual([h.talk.requests.length, h.llm.requests.length, h.history.get().turns.length], [6, 5, 3])
    // 面板的状态里，最近一次送来的话是哪一种看得出来
    assert.deepEqual([h.agent.linkState().lastReport?.type, h.agent.linkState().lastReport?.text], ['result', '拿了 8 个铁粉，放回 3 个，身上留 5 个。'])
  })

  it('它的任务还在跑时：普通汇报不叫醒对话线，提问叫醒；worker_status 写明它在等自己开的哪个任务', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    withTasks(h)
    h.llm.enqueue(reply('', [{ name: 'go_to', input: { x: 30, y: 64, z: 30 } }, { name: 'report', input: { text: '路上有岩浆，我绕着走' } }]), reply(''))
    h.agent.handleEvent(told('去 30 64 30'))
    await h.agent.whenIdle()
    assert.deepEqual(relays(h).map((e) => e.relay!.type), ['report'])
    assert.equal(h.talk.requests.length, 0)

    h.talk.enqueue(reply('', [{ id: 'ws', name: 'worker_status' }]), says('还在路上'))
    h.agent.handleEvent(chat('Steve', 'Alu 走到哪了'))
    await h.agent.whenIdle()
    // 它醒来时那句汇报在背景里
    assert.match(h.talk.lastUserText(0).split('[最近发生的事')[1] ?? '', /干活线汇报：路上有岩浆，我绕着走/)
    const status = h.talk.requests[1]!.messages.at(-1)!.content.find((p) => p.type === 'tool_result')!
    assert.match(
      status.type === 'tool_result' ? status.content : '',
      /^Worker: still at work, not thinking right now: it is waiting for the task\(s\) it started to end\. Its last turn \(\d+\) ended \d+ s ago after 2 step\(s\)\. When a task or routine it started ends, the worker is woken by itself and carries on; nothing has to remind it\.\nStarted by the worker and not ended yet:\n- its task t1 \(goto\): running, 3\/8, for 1[23] s\nBody: on task t1 goto \[running\] 3\/8\./,
    )
    // 任务还在跑，它提了个问：叫醒对话线
    const before = h.talk.requests.length
    h.llm.enqueue(reply('', [{ name: 'report', input: { text: '岩浆那边要不要垫石头？', question: true } }]), reply(''))
    h.agent.handleEvent(told('绕不过去就说一声', []))
    await waitFor('the question woke the talk line', () => h.talk.requests.length > before)
    await h.agent.whenIdle()
    assert.match(todo(h.talk.lastUserText(before)), /干活线提问（它在等回答，用 tell_worker 带话给它）：岩浆那边要不要垫石头？/)
  })

  it('它的例程还在后台跑、或者还有刚到的事等它处理时留的话，同样只作背景，写明它在等什么', async (t) => {
    const tmp = tmpDir()
    const h = makeAgent({ dir: tmp.dir, design: new DesignWorkspace({ dataDir: tmp.dir }) })
    t.after(async () => {
      await h.agent.stop()
      tmp.cleanup()
    })
    // 例程在跑
    h.llm.enqueue(reply('', [{ name: 'start_routine', input: { code: `await tool('go_to', { x: 50, z: 50 }); return 'there'`, name: '走过去' } }]), reply('例程开了，在走'))
    h.agent.handleEvent(told('写个例程走过去'))
    await waitFor('the routine started its task', () => h.game.callsOf('task.start').length === 1)
    await h.agent.whenIdle()
    assert.deepEqual(relays(h).map((e) => [e.relay!.type, e.relay!.waiting]), [['progress', '它的例程 r1（走过去）在后台跑']])
    assert.equal(h.talk.requests.length, 0)
    // 对话线的状态里写着例程在跑、结束时干活线自己会被叫醒
    h.talk.enqueue(reply('在走'))
    h.agent.handleEvent(chat('Steve', 'Alu 在干嘛'))
    await h.agent.whenIdle()
    assert.match(h.talk.lastUserText(0), /\n干活线：还在干，这会儿没有在想——在等它自己开的例程结束。例程一结束（做完、失败或被取消）它自己会被叫醒接着做，不需要提醒。\n {2}例程 r1（走过去）在后台跑：已调 1 次工具，开了 1 个任务，\d+ 秒前开始。\n/)

    // 例程跑完，干活线被叫醒；它最后一步还没回来的时候又来了一件事——这一轮留的话仍然只是中途的话
    const last = held()
    h.llm.enqueue(last.script, reply('都办完了'))
    h.agent.handleEvent(taskEnded('t1', 'done', { type: 'goto' }))
    await waitFor('the worker is thinking', last.started)
    h.agent.handleEvent(told('再去仓库看一眼', []))
    last.answer(reply('走到了'))
    await h.agent.whenIdle()
    assert.deepEqual(relays(h).map((e) => [e.relay!.type, e.relay!.waiting ?? null]), [['progress', '它的例程 r1（走过去）在后台跑'], ['progress', '还有 1 件刚到的事等它处理'], ['result', null]])
    // 对话线只为最后那句“停下来了”的话醒了一次
    assert.equal(h.talk.requests.length, 2)
    assert.match(todo(h.talk.lastUserText(1)), /干活线停下来了（身体上没有它开的任务，也没有例程在跑），它留下的话：都办完了/)
  })
})

describe('两条线互相叫醒', () => {
  it('两个模型客气个没完（带话 → “好的” → 再带话……），中间没人说话、游戏里也没事：话头倒够 12 次以后照常送到但不再互相叫醒，两边都被如实告知；有人说话后恢复', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 对话线：干活线说什么它都再带一句话过去；干活线：带来什么都回一句
    h.talk.auto = (seen) => (/干活线停下来了|Steve 说/.test(seen) && !/Handed to the worker|Delivered, but/.test(seen) ? reply('', [{ name: 'tell_worker', input: { text: '收到，辛苦了' } }]) : undefined)
    h.llm.auto = (seen) => (/对话线交给你的/.test(seen.split('\n\n[')[0]!) ? reply('不客气') : undefined)
    h.agent.handleEvent(chat('Steve', 'Alu 你们俩聊聊'))
    await h.agent.whenIdle()

    // 停下来了：话头倒了 12 次（6 个来回）以后，第 13 条送到了但没有叫醒对方
    const passed = relays(h)
    assert.equal(passed.length, VOLLEY_MAX + 1)
    assert.deepEqual(passed.slice(-2).map((e) => e.text), ['干活线 → 对话线（停下来了，留下的话）：不客气', '对话线 → 干活线（只作背景，没有叫醒它）：收到，辛苦了'])
    assert.equal(h.llm.requests.length, 6)
    // 发的那一方从工具结果里知道这一条没有叫醒对方、为什么、什么时候恢复
    assert.match(h.talk.lastUserText(h.talk.requests.length - 1), /^Delivered, but it does not wake the worker\. The two lines have now woken each other 12 times in a row with no one speaking and nothing happening in the game \(no task or routine ending\), so the program has stopped waking them for each other\./)
    assert.ok(h.log.recent(0, 300).some((e) => e.kind === 'error' && e.text.startsWith('两条线已经连着互相叫醒了 12 次，中间没有人说话、游戏里也没有事发生')))
    await sleep(40)
    assert.equal(h.llm.requests.length, 6)

    // 主人说话：恢复正常，没叫醒它的那一条它在背景里看得到
    h.talk.auto = undefined
    h.llm.auto = undefined
    h.talk.enqueue(reply('好', [{ name: 'tell_worker', input: { text: '去仓库' } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 去仓库'))
    await h.agent.whenIdle()
    assert.equal(h.llm.requests.length, 7)
    assert.match(todo(h.llm.lastUserText(6)), /对话线交给你的（这一句是它写的）：去仓库/)
    assert.match(h.llm.lastUserText(6).slice(h.llm.lastUserText(6).indexOf('[最近发生的事')), /对话线交给你的（这一句是它写的）：收到，辛苦了/)
  })

  it('正常的你来我往不算空转：中间有任务结束就从头数；干活线一轮里的普通汇报不叫醒对话线，也不算往来', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 干活线每领一件事就开一个任务；任务结束后留一句话停下；对话线每次都再交一件
    let n = 0
    h.llm.auto = (seen) => {
      if (/Task t\d+ \(goto\) started/.test(seen)) return undefined
      if (/任务 t\d+（goto）完成了/.test(seen)) return reply('到了，路上没事')
      return /对话线交给你的/.test(seen) ? reply('', [{ name: 'go_to', input: { x: ++n, y: 64, z: 0 } }]) : undefined
    }
    h.talk.auto = (seen) => (/干活线停下来了[^\n]*到了，路上没事/.test(seen) && n < 10 ? reply('', [{ name: 'tell_worker', input: { text: `去下一个点 ${n + 1}` } }]) : undefined)
    h.agent.handleEvent(told('去第一个点', []))
    for (let i = 1; i <= 10; i++) {
      await waitFor(`task ${i} started`, () => h.game.callsOf('task.start').length === i)
      await h.agent.whenIdle()
      h.agent.handleEvent(taskEnded(`t${i}`, 'done', { type: 'goto' }))
    }
    await h.agent.whenIdle()
    // 十个来回都走完了，没有一条被降成背景，日志里没有“空转”的那条
    assert.equal(h.game.callsOf('task.start').length, 10)
    assert.equal(relays(h).some((e) => e.text.includes('只作背景')), false)
    assert.equal(h.log.recent(0, 500).some((e) => e.kind === 'error'), false)

    // 干活线一轮里一口气汇报了十五次（中间没有外面的事）：每一条都送到、只作背景，对话线一次都没被叫醒，也不算两条线的往来
    h.llm.auto = undefined
    h.talk.auto = undefined
    const talkBefore = h.talk.requests.length
    h.llm.enqueue(reply('', Array.from({ length: 15 }, (_, i) => ({ name: 'report', input: { text: `第 ${i + 1} 箱看完了` } }))), reply(''))
    h.agent.handleEvent(told('把十五个箱子挨个看一遍', []))
    await h.agent.whenIdle()
    const reports = relays(h, 'report').filter((e) => e.text.includes('箱看完了'))
    assert.equal(reports.length, 15)
    assert.ok(reports.every((e) => e.text.startsWith('干活线 → 对话线（汇报，只作背景，没有叫醒它）')))
    assert.equal(h.talk.requests.length, talkBefore)
    assert.equal(h.log.recent(0, 500).some((e) => e.kind === 'error'), false)
    // 对话线下次醒来，在背景里看得到
    h.agent.handleEvent(chat('Steve', 'Alu 箱子看得怎么样'))
    await h.agent.whenIdle()
    assert.match(h.talk.lastUserText(talkBefore), /干活线汇报：第 15 箱看完了/)
  })
})

describe('对话窗口', () => {
  it('它在游戏里说了话（干活线做完了，它 say 告诉人）以后，最近跟它说过话的人接一句不用再叫名字；只写了字（只在面板上）不算', async (t) => {
    const h = makeAgent({ settings: { conversationWindowSec: 0.25 } })
    t.after(h.cleanup)
    h.talk.enqueue(says('好'), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 去拿点铁'))
    await h.agent.whenIdle()
    // 过了对话窗口：不带名字的话不再叫醒它
    await sleep(320)
    h.agent.handleEvent(chat('Steve', '今天天气不错'))
    await sleep(30)
    assert.equal(h.talk.requests.length, 2)

    // 干活线做完了，对话线说“拿到了”；Steve 紧接着回一句，不带名字
    h.talk.enqueue(says('铁拿到了，放哪？'), reply(''), reply(''))
    h.agent.handleEvent({ type: 'worker', time: Date.now(), kind: 'result', text: '拿到 3 个铁锭' })
    await h.agent.whenIdle()
    assert.deepEqual(h.game.said, ['好', '铁拿到了，放哪？'])
    h.agent.handleEvent(chat('Steve', '放箱子里'))
    await h.agent.whenIdle()
    assert.equal(h.talk.requests.length, 5)
    assert.match(todo(h.talk.lastUserText(4)), /Steve 说：放箱子里/)
    // 别人接话不算：没跟它说过话的人照旧要叫名字
    await sleep(320)
    h.talk.enqueue(says('都放好了'), reply(''))
    h.agent.handleEvent({ type: 'worker', time: Date.now(), kind: 'result', text: '放好了' })
    await h.agent.whenIdle()
    h.agent.handleEvent(chat('Bob', '放哪了'))
    await sleep(30)
    assert.equal(h.talk.requests.length, 7)
    // 干活线又做完一件，对话线只写了字（游戏里没人看到）：Steve 不带名字的话不叫醒它
    await sleep(320)
    h.talk.enqueue(reply('又放好了一箱'))
    h.agent.handleEvent({ type: 'worker', time: Date.now(), kind: 'result', text: '又放好了' })
    await h.agent.whenIdle()
    h.agent.handleEvent(chat('Steve', '辛苦了'))
    await sleep(30)
    assert.equal(h.talk.requests.length, 8)
  })
})

describe('主人问“你在干嘛”', () => {
  it('对话线每一轮的状态里写着干活线的现状，不调工具就答得出大概；要细节时 worker_status 给出它这一轮最近几步、身体的任务和例程', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    // 干活线空闲时
    h.talk.enqueue(says('闲着呢'), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 你在干嘛'))
    await h.agent.whenIdle()
    assert.match(h.talk.lastUserText(0), /\[当前状态\]\n[\s\S]*\n干活线：空闲，没有在想（大脑启动以后它还没有做过事）；身体上没有它开的任务，也没有例程在跑。/)

    // 干活线在忙：领了事，查过一次状态，正在想第 2 步；身体正在做一个任务
    h.game.handlers['task.list'] = () => ({ active: { id: 't7', type: 'haul', state: 'running', progress: { done: 3, total: 8 } }, queue: [{ id: 't8', type: 'craft', state: 'queued' }], recent: [] })
    const thinking = held()
    h.llm.enqueue(reply('', [{ name: 'get_status' }]), thinking.script)
    h.agent.handleEvent(told('把圆石搬到箱子里'))
    await waitFor('the worker is thinking about step 2', thinking.started)
    const turn = h.agent.state('work').turn!.id

    h.talk.enqueue(reply('', [{ id: 'ws', name: 'worker_status', input: { detail: true } }]), says('在搬圆石，搬了 3/8'), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 现在呢'))
    await waitFor('the talk line answered', () => h.game.said.length === 2)
    // 不调工具就看得到的那一行
    assert.match(h.talk.lastUserText(2), new RegExp(`干活线：在忙。第 ${turn} 轮（\\d+ 秒前开始，起因：对话线交给你的（这一句是它写的）：把圆石搬到箱子里），已经想完 1 步，正在想第 2 步。`))
    // 细节
    const detail = h.talk.requests[3]!.messages.at(-1)!.content.find((p) => p.type === 'tool_result')!
    const text = detail.type === 'tool_result' ? detail.content : ''
    assert.match(text, new RegExp(`^Worker: busy\\. Turn ${turn}, started \\d+ s ago; 1 of at most 16 steps done, now thinking about step 2 for \\d+ s\\.\\nWhat started the turn: 对话线交给你的（这一句是它写的）：把圆石搬到箱子里\\nIts last 1 tool call\\(s\\) this turn:\\n- step 1: get_status \\{\\} → Alu: online in overworld`))
    assert.match(text, /\nBody: on task t7 haul \[running\] 3\/8\.\nQueued: t8 craft\.\nRoutine: none\.$/)
    assert.deepEqual(h.game.said, ['闲着呢', '在搬圆石，搬了 3/8'])
    thinking.answer(reply(''))
    await h.agent.whenIdle()
  })
})

describe('事件分给哪条线', () => {
  it('玩家说的话、面板指令、提醒到对话线；任务、受伤、系统消息到干活线；死亡和上线下线两条线都知道', () => {
    const now = Date.now()
    const task = { id: 't1', type: 'goto', state: 'done' as const }
    assert.deepEqual(
      [
        lineOf(chat('Steve', 'x')),
        lineOf({ type: 'whisper', time: now, from: 'Steve', message: 'x' }),
        lineOf({ type: 'panel_command', time: now, text: 'x' }),
        lineOf({ type: 'reminder', time: now, note: 'x' }),
        lineOf({ type: 'player_join', time: now, player: 'Bob' }),
        lineOf({ type: 'worker', time: now, kind: 'report', text: 'x' }),
        // 提醒是哪条线定的就到哪条线
        lineOf({ type: 'reminder', time: now, note: 'x', line: 'work' }),
      ],
      ['talk', 'talk', 'talk', 'talk', 'talk', 'talk', 'work'],
    )
    assert.deepEqual(
      [
        lineOf({ type: 'task_ended', time: now, task }),
        lineOf({ type: 'task_started', time: now, task }),
        lineOf({ type: 'hurt', time: now, source: 'Zombie', amount: 3, health: 4 }),
        lineOf({ type: 'bot_message', time: now, text: 'x' }),
        lineOf(told('x')),
      ],
      ['work', 'work', 'work', 'work', 'work'],
    )
    assert.deepEqual([lineOf({ type: 'death', time: now, cause: 'Zombie' }), lineOf({ type: 'spawned', time: now }), lineOf({ type: 'despawned', time: now, reason: 'kicked' })], ['both', 'both', 'both'])
  })

  it('身体任务结束只叫醒干活线，玩家说话只叫醒对话线；死了两条线都被叫醒（对话线得的是一句简报）；上线下线对对话线只是背景', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.agent.handleEvent(taskEnded('t1', 'failed', { error: { code: 'stuck', message: 'no progress' } }))
    await h.agent.whenIdle()
    assert.deepEqual([h.llm.requests.length, h.talk.requests.length], [1, 0])
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    await h.agent.whenIdle()
    assert.deepEqual([h.llm.requests.length, h.talk.requests.length], [1, 1])
    assert.equal(/任务 t1/.test(h.talk.lastUserText(0)), false)

    h.agent.handleBridgeEvent({ event: 'bot.despawned', time: Date.now(), data: { bot: 'Alu', reason: 'Kicked by an operator.' } })
    h.agent.handleBridgeEvent({ event: 'bot.spawned', time: Date.now(), data: { bot: 'Alu' } })
    await sleep(40)
    assert.deepEqual([h.llm.requests.length, h.talk.requests.length], [1, 1], 'going offline and online wakes neither line')
    h.agent.handleBridgeEvent({ event: 'bot.death', time: Date.now(), data: { bot: 'Alu', cause: 'Zombie' } })
    await h.agent.whenIdle()
    assert.deepEqual([h.llm.requests.length, h.talk.requests.length], [2, 2])
    assert.match(todo(h.talk.lastUserText(1)), /你死了（Zombie）/)
    assert.match(h.talk.lastUserText(1), /你下线了（Kicked by an operator\.）\n[^\n]*你上线了/)
    assert.match(todo(h.llm.lastUserText(1)), /你死了（Zombie）/)
    // 日志里这几件身体的事各只有一条
    assert.equal(h.log.recent(0, 200).filter((e) => e.kind === 'event' && e.text.startsWith('你死了')).length, 1)
  })
})

describe('两条线各有各的上下文', () => {
  it('重启后两条线各自接上：各自的历史只有自己的那一份；干活线在等的回答、盯着的任务都还在', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.talk.enqueue(reply('好，我去拿。', [{ name: 'tell_worker', input: { text: '去拿 3 个铁锭' } }]), reply(''), reply('它问放哪'))
    h.llm.enqueue(reply('', [{ name: 'go_to', input: { x: 30, y: 64, z: 30 } }, { name: 'report', input: { text: '拿到以后放哪？', question: true } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 拿 3 个铁锭'))
    await h.agent.whenIdle()
    await h.agent.stop()
    // 两份历史各落各的；轮的编号不重
    const talkTurns = h.talkHistory.get().turns
    const workTurns = h.history.get().turns
    assert.deepEqual([talkTurns.length, workTurns.length], [2, 1])
    assert.equal(new Set([...talkTurns, ...workTurns].map((x) => x.id)).size, 3)

    const again = h.restart()
    t.after(() => again.agent.stop())
    assert.deepEqual(again.agent.status().trackedTasks, ['t1'])
    assert.equal(again.agent.linkState().waiting?.text, '拿到以后放哪？')
    h.talk.enqueue(reply('成品箱', [{ name: 'tell_worker', input: { text: '放成品箱' } }]), reply(''))
    h.llm.enqueue(reply(''))
    const talkBefore = h.talk.requests.length
    const workBefore = h.llm.requests.length
    again.agent.handleEvent(chat('Steve', 'Alu 放成品箱'))
    await again.agent.whenIdle()
    // 对话线的上下文：它自己之前说的话、交的事、干活线的提问都在；干活线调的工具不在
    const talkSaw = JSON.stringify(again.talk.requests[talkBefore]!.messages)
    assert.ok(talkSaw.includes('好，我去拿。') && talkSaw.includes('干活线提问') && !talkSaw.includes('go_to'))
    assert.match(again.talk.lastUserText(talkBefore), /它在等你回答（\d+ 秒前问的）：拿到以后放哪？/)
    // 干活线的上下文：它自己那一轮（开的任务、问的问题）在；对话线说的“好，我去拿。”不在
    const workSaw = JSON.stringify(again.llm.requests[workBefore]!.messages)
    assert.ok(workSaw.includes('go_to') && workSaw.includes('拿到以后放哪') && !workSaw.includes('好，我去拿。'))
    assertToolPairs(again.llm.requests[workBefore]!.messages)
  })

  it('两条线各压各的历史：对话线的阈值是它自己的，压成的摘要写的是话和约定；干活线的历史不受影响', async (t) => {
    const h = makeAgent({ settings: { historyTokenThreshold: 1_000_000 }, talkSettings: { historyTokenThreshold: 2000 } })
    t.after(h.cleanup)
    const summaries: GenerateRequest[] = []
    for (let i = 0; i < 12; i++) {
      h.talk.enqueue((req) => {
        if (req.tools.length === 0) {
          summaries.push(req)
          return reply('主人要 3 个铁锭，已经交给干活线，还没结果。')
        }
        // 话说得长：光把旧轮里的状态快照拿掉还不够，得压成摘要
        return reply(`第 ${i} 句：${'啊'.repeat(2500)}`)
      })
    }
    for (let i = 0; i < 6; i++) {
      h.agent.handleEvent(chat('Steve', `Alu 说第 ${i} 件事`))
      await h.agent.whenIdle()
    }
    assert.ok(summaries.length >= 1, 'the talk history was summarised')
    // 对话线有它自己的写法：小节是话和约定（谁交代了什么、交给干活线的事、答应过的事），上限按它自己的阈值算
    assert.match(summaries[0]!.system, /^你在替一个 Minecraft（GTNH 整合包）服务器里的 AI 玩家的“对话线”写“交接记录”。/)
    assert.match(summaries[0]!.system, /上限 900 字，/)
    for (const section of ['## 主人和别人交代的事、提的要求', '## 这一段结束时在聊的', '## 交给干活线的事', '## 干活线问过的、主人答过的', '## 答应过的事', '## 查到的结论', '## 人']) assert.ok(summaries[0]!.system.includes(`\n${section}\n`), section)
    // 它写的字标明只有主人在面板上看得到（游戏里说的话是 say、whisper 的调用）
    assert.match(summaries[0]!.messages[0]!.content.map((p) => (p.type === 'text' ? p.text : '')).join(''), /\[它写的字（只有主人在面板上看得到）\] 第 0 句/)
    assert.equal(h.talkHistory.get().summary, '主人要 3 个铁锭，已经交给干活线，还没结果。')
    assert.equal(h.history.get().summary, '')
  })
})

describe('从只有一条线的老数据升上来', () => {
  it('老的对话历史和没处理完的事归干活线，其中“有人说话”那一类挪给对话线；对话线从空历史开始；干活线被告知那段历史是怎么来的', async (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    // 升级前留下的：一轮带 say 的历史（history.json），和排着没处理的两件事——一句聊天、一个结束了的任务
    const old = makeAgent({ dir: tmp.dir })
    old.history.appendTurn({
      id: old.history.newTurnId(),
      startedAt: Date.now() - 3_600_000,
      messages: [
        { role: 'user', content: [{ type: 'text', text: '[需要你处理的事]\nSteve 说：Alu 把土放进箱子' }] },
        { role: 'assistant', content: [{ type: 'tool_call', id: 'old1', name: 'say', input: { message: '好' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: 'old1', content: 'Said in public chat.' }] },
      ],
    })
    await old.agent.stop()
    const state = { tracked: ['t9'], endedSeen: ['t7'], queue: [chat('Steve', 'Alu 圆石也放进去'), taskEnded('t7', 'done', { type: 'deposit', result: { moved: 64 } })] }

    const h = makeAgent({ dir: tmp.dir, persisted: { state }, migrated: true })
    t.after(() => h.agent.stop())
    h.talk.enqueue(reply('收到'))
    await waitFor('both lines took up their part', () => h.talk.requests.length >= 1 && h.llm.requests.length >= 1)
    await h.agent.whenIdle()

    // 对话线：拿到了那句聊天，历史是空的
    assert.match(todo(h.talk.lastUserText(0)), /大脑刚重启过[\s\S]*Steve 说：Alu 圆石也放进去/)
    assert.equal(h.talk.requests[0]!.messages.length, 1)
    assert.equal(/任务 t7/.test(h.talk.lastUserText(0)), false)
    // 干活线：老历史原样是它的；任务结束归它；聊天没有留在它那里；背景里说明了历史的来历
    const first = h.llm.requests[0]!.messages
    assert.ok(JSON.stringify(first).includes('Alu 把土放进箱子') && JSON.stringify(first).includes('"name":"say"'))
    assertToolPairs(first)
    assert.match(todo(h.llm.lastUserText(0)), /任务 t7（deposit）完成了/)
    assert.equal(todo(h.llm.lastUserText(0)).includes('圆石也放进去'), false)
    assert.match(h.llm.lastUserText(0), /大脑升级过：从现在起“跟人说话”和“操作身体干活”分成了两条线，你是干活线。/)
    // 它盯着的任务照旧盯着
    assert.deepEqual(h.agent.status().trackedTasks, ['t9'])
    // 落盘：两条线各有各的队列，都清空了
    assert.deepEqual([h.persisted.state?.queue, h.talkPersisted.state?.queue], [[], []])
  })
})
