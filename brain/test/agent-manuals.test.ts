import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { truncateOldToolResults } from '../src/agent/compaction.ts'
import { manualsInContext } from '../src/agent/context.ts'
import { COMMON_PROMPT, DEFAULT_PERSONA, corePrompt } from '../src/agent/prompt.ts'
import type { Message } from '../src/llm/index.ts'
import { ManualStore, manualText } from '../src/store/manuals.ts'
import { DEFAULT_MANUALS_DIR, chat, makeAgent, reply, told } from './agent-harness.ts'

/** 给模型看的那行“哪几本手册的内容还在这段对话里”。 */
function manualLine(userText: string): string {
  return userText.split('\n').find((l) => l.startsWith('手册：')) ?? ''
}

describe('手册：提示词只列目录，要用时才读', () => {
  it('两条线的系统提示词里都有手册目录（默认的和主人写的各带一句什么时候看），各类活的细节不在提示词里；干活线的那份写着动手前先看，对话线的只说它也能读', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.manuals.save({ name: '基地布局', summary: '要在基地里找仓库、机器、工作台时看。', body: '仓库在 (100,64,200) 一带。' })
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    h.agent.handleEvent(told('去仓库'))
    await h.agent.whenIdle()
    const work = h.llm.requests[0]!.system ?? ''
    const talk = h.talk.requests[0]!.system ?? ''
    for (const system of [work, talk]) {
      assert.match(system, /^# 手册$/m)
      for (const name of ['blueprint', 'crafting', 'containers', 'terrain', 'travel', 'quests']) {
        assert.match(system, new RegExp(`^- ${name}：.{8,}$`, 'm'), `the catalogue lists ${name}`)
      }
      assert.match(system, /^- 基地布局（主人写的）：要在基地里找仓库、机器、工作台时看。$/m)
      // 手册的正文不在提示词里：只有模型去读的时候才出现
      assert.equal(system.includes('仓库在 (100,64,200)'), false)
      assert.equal(/needsClimbingBlocks|maxFillDepth|craftingTool|匠魂/.test(system), false)
    }
    assert.match(work, /先用 read_manual 看完再动手/)
    assert.match(talk, /干活线动手之前会自己看。你要回答这类问题、或者想把事交代得更清楚时，可以用 read_manual 读。/)
    assert.equal(talk.includes('先用 read_manual 看完再动手'), false)
    // 用户要求注入背包准备、失败自查和游戏单位常识；干活线核心现在2,450字，细节仍在手册，不把整本塞进每轮。
    for (const line of ['talk', 'work'] as const) assert.ok(corePrompt(line, 'Alu').length <= (line === 'work' ? 2500 : 2400), `the ${line} core prompt is ${corePrompt(line, 'Alu').length} chars`)
    // 上限各加了 300：多了“基地的做法”那一节（空的时候三行，约 130 字），对话线另多两句事实（只写字不调工具这一轮就结束；要查很多步可以交给干活线，约 130 字）
    // 干活线 3,600 → 3,700：手册目录多了 wear 那一行（穿脱背上的东西、加油、按 mod 的键、飞，约 55 字），现在 3,640；对话线也多这一行，3,340
    // 通用自查常识后干活线当前3,848；没有增加每个事故的单独提示。
    assert.ok(work.length < 3900, `the work system prompt is ${work.length} chars`)
    // 对话线 3,200 → 3,300：多了“写的字只有主人在面板上看得到”“在游戏里说话用 say、whisper”“干活线也看不到你写的字”这几句事实（约 80 字），现在约 3,210
    // 3,300 → 3,400：多了一句“也可以派子思维去查、去设计草稿……它交回的话会叫醒你”（约 70 字）
    assert.ok(talk.length < 3400, `the talk system prompt is ${talk.length} chars`)
  })

  it('对话线的提示词里有两句事实：只写了字没调工具这一轮就到此为止；要查很多步的事可以交给干活线，两条线每轮各能走几步用的是设置里的数。干活线的提示词里没有这两句', async (t) => {
    const h = makeAgent({ settings: { lineSteps: { talk: 12, work: 80 } } })
    t.after(h.cleanup)
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    h.agent.handleEvent(told('去仓库'))
    await h.agent.whenIdle()
    const talk = h.talk.requests[0]!.system ?? ''
    const facts =
      '- 这一步只写了字、没有调工具，这一轮就到此为止。说了“我去查”，而这一步里没调工具、也没交给干活线，之后没有人会接着做。\n' +
      '- 要查很多步的事两条线都查得了：你一轮最多 12 步（到了上限再给你一步收尾，只能说话），干活线一轮最多 80 步。交给它查，它查完会带话回来。也可以派子思维（start_helper）去查、去设计草稿：它另起一份上下文，你这一轮照常结束，它交回的话会叫醒你。\n'
    assert.ok(talk.includes(facts), talk.slice(0, 1800))
    assert.equal((h.llm.requests[0]!.system ?? '').includes('这一轮就到此为止'), false)
    // 没人说这两个数时用默认的：20 和 60
    assert.match(corePrompt('talk', 'Alu'), /你一轮最多 20 步（到了上限再给你一步收尾，只能说话），干活线一轮最多 60 步。/)
  })

  it('主人在设置里写了这个服务器叫什么、这里的规矩：两条线每一轮的系统提示词里都有这一节，原话照给，并写明这是这个服务器的设置、不是它的记忆；主人改了下一轮就是新的；两样都没写就没有这一节', async (t) => {
    const h = makeAgent({ settings: { environment: { name: '测试服', rules: '材料随便用，不必逐项问我。\n别动 (100,64,200) 那排箱子。' } } })
    t.after(h.cleanup)
    h.memory.set('note', '钢锭在主仓库')
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    h.agent.handleEvent(told('去仓库'))
    await h.agent.whenIdle()
    const section = '# 这个服务器\n你现在在的这个服务器，主人叫它「测试服」。这一节是主人给这个服务器写的设置，不是你记下来的：换一个服务器会是另一份。\n主人给这里写的规矩（他的原话）：\n材料随便用，不必逐项问我。\n别动 (100,64,200) 那排箱子。\n\n# 基地的做法\n'
    for (const system of [h.llm.requests[0]!.system ?? '', h.talk.requests[0]!.system ?? '']) assert.ok(system.includes(section), system.slice(-600))

    // 搬到正式服：主人只写了名字、没写规矩
    h.settings.environment = { name: '正式服', rules: '' }
    h.agent.handleEvent(told('再去一趟'))
    await h.agent.whenIdle()
    const moved = h.llm.requests.at(-1)!.system ?? ''
    assert.ok(moved.includes('# 这个服务器\n你现在在的这个服务器，主人叫它「正式服」。这一节是主人给这个服务器写的设置，不是你记下来的：换一个服务器会是另一份。\n\n# 基地的做法\n'), moved.slice(-400))
    assert.equal(moved.includes('材料随便用'), false)
    // 只写了规矩、没起名字
    h.settings.environment = { name: '', rules: '挖矿去矿世界。' }
    h.agent.handleEvent(told('再去一趟'))
    await h.agent.whenIdle()
    assert.ok((h.llm.requests.at(-1)!.system ?? '').includes('# 这个服务器\n这一节是主人给这个服务器写的设置，不是你记下来的：换一个服务器会是另一份。\n主人给这里写的规矩（他的原话）：\n挖矿去矿世界。\n\n# 基地的做法\n'))
    // 两样都空：没有这一节
    h.settings.environment = { name: ' ', rules: '' }
    h.agent.handleEvent(told('再去一趟'))
    await h.agent.whenIdle()
    assert.equal((h.llm.requests.at(-1)!.system ?? '').includes('# 这个服务器'), false)
  })

  it('两条线的提示词：公共部分一样；对话线的最前面写着它写的字谁看得到、在游戏里说话用什么，干活线的写着它操作身体、怎么汇报；谁也没有对方那一段', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    h.agent.handleEvent(told('去仓库'))
    await h.agent.whenIdle()
    const work = h.llm.requests[0]!.system ?? ''
    const talk = h.talk.requests[0]!.system ?? ''
    const common = COMMON_PROMPT.replaceAll('{{name}}', 'Alu')
    assert.ok(work.startsWith(common) && talk.startsWith(common))
    assert.match(common, /对话线：听人说话、回话、查资料。它不操作身体。\n- 干活线：操作身体的只有它。它不对玩家说话。/)
    // 对话线自己的部分第一条就是这个事实
    assert.ok(
      talk.slice(common.length).startsWith(
        '\n\n# 你是对话线\n- **你写的字只有主人在面板上看得到**，游戏里没人看到。主人从面板跟你说话时，写字就是回他。\n' +
          '- 在游戏里说话用 say（公共聊天，所有人都看到）或 whisper（只有那个人看到）。\n' +
          '- 干活线也看不到你写的字：回它、交事给它、答它的问题，都用 tell_worker。\n',
      ),
    )
    // “写的字就是说的话”这类说法一句都不剩
    assert.equal(/写出来的文字就是|写的字就是|什么都不写就是不说/.test(talk), false)
    assert.match(talk, /你没有任何让身体动的工具/)
    assert.match(talk, /stop_work 一次让一切停下/)
    assert.equal(talk.includes('# 干活靠任务'), false)
    assert.ok(work.slice(common.length).startsWith('\n\n# 你是干活线\n- 你用工具操纵身体。跟玩家说话的是对话线'))
    assert.match(work, /一轮结束时留下的文字自动送给对话线/)
    // 两条线都被告知同一个事实（不是命令）：干活线开的任务、例程结束时它自己会接着做；它还在干时留的话只是背景，停下来了留的才叫醒对话线
    assert.match(talk, /干活线开的任务、例程一结束，它自己会被叫醒接着做，不需要谁提醒；它还在干的时候留的话、中途的汇报只作为背景给你。它停下来了、或者提问，才会出现在“需要你处理的事”里。/)
    assert.match(work, /你开的任务或例程还没结束时留的话，只作为背景给它，不叫醒它；你停下来了（身体上没有你开的任务，也没有例程在跑）留的话才叫醒它。/)
    assert.match(work, /# 干活靠任务/)
    assert.equal(work.includes('# 说话风格'), false)
    // 提示词里没有另一条线才有的工具名字当成“你的”：干活线不提 tell_worker，对话线不教它启动任务
    assert.equal(work.includes('tell_worker'), false)
    assert.equal(/queue: true/.test(talk), false)
  })

  it('主人在面板上改的那一段是对话线的说话风格：换成他的那份，别的部分照旧；干活线的提示词里没有它', async (t) => {
    const h = makeAgent({ settings: { persona: '- 只说文言文，自称{{name}}。' } })
    t.after(h.cleanup)
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    h.agent.handleEvent(told('去仓库'))
    await h.agent.whenIdle()
    const talk = h.talk.requests[0]!.system ?? ''
    assert.match(talk, /# 说话风格\n- 只说文言文，自称Alu。\n\n# 记/)
    assert.equal(talk.includes(DEFAULT_PERSONA.split('\n')[0]!), false, 'the default style is not mixed in')
    assert.match(talk, /\*\*你写的字只有主人在面板上看得到\*\*/)
    assert.match(talk, /^# 手册$/m)
    assert.equal((h.llm.requests[0]!.system ?? '').includes('文言文'), false)
  })

  it('读过的手册，之后每一轮的“当前状态”都写明它的内容还在对话里；主人把那本手册改了以后就不再算看过', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(reply('', [{ name: 'read_manual', input: { name: 'blueprint' } }]), reply(''))
    h.agent.handleEvent(told('照图纸盖个房子'))
    await h.agent.whenIdle()
    assert.equal(manualLine(h.llm.lastUserText(0)), '手册：这段对话里现在没有任何一本手册的内容，要做某类事之前先 read_manual。')
    // 工具结果是整本手册
    assert.match(h.llm.lastUserText(1), /^Manual "blueprint": /)

    h.agent.handleEvent(told('放在 100 64 200'))
    await h.agent.whenIdle()
    assert.equal(manualLine(h.llm.lastUserText(2)), '手册：blueprint 的内容还在这段对话里，不用重看；其余的要用之前先 read_manual。')

    // 主人在面板上改了这本手册：模型手里那份是旧的
    h.manuals.save({ name: 'blueprint', summary: '盖房子之前看（我们服的规矩）。', body: '一律先问我，不许自己清场。' })
    h.agent.handleEvent(told('开始吧'))
    await h.agent.whenIdle()
    assert.equal(manualLine(h.llm.lastUserText(3)), '手册：这段对话里现在没有任何一本手册的内容，要做某类事之前先 read_manual。')
  })

  it('对话线也能读手册；它不动手，状态里没有“做事之前先看”那句，只在它读过的还留着时说一声', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.talk.enqueue(reply('', [{ name: 'read_manual', input: { name: 'crafting' } }]), reply('要先查配方再找库存'))
    h.agent.handleEvent(chat('Steve', 'Alu 你平时怎么做东西的'))
    await h.agent.whenIdle()
    assert.equal(manualLine(h.talk.lastUserText(0)), '')
    assert.match(h.talk.lastUserText(1), /^Manual "crafting": /)
    h.agent.handleEvent(chat('Steve', 'Alu 再说细点'))
    await h.agent.whenIdle()
    assert.equal(manualLine(h.talk.lastUserText(2)), '手册：crafting 的内容还在这段对话里。')
    // 两条线各有各的上下文：对话线读过，不等于干活线读过
    h.agent.handleEvent(told('做一个桨叶'))
    await h.agent.whenIdle()
    assert.equal(manualLine(h.llm.lastUserText(0)), '手册：这段对话里现在没有任何一本手册的内容，要做某类事之前先 read_manual。')
  })

  it('历史压缩把较早的手册原文拿掉以后，那本不再算看过，历史里留下一句“要用时重新读”', async (t) => {
    // 历史上限调低，两本大手册放不下
    const h = makeAgent({ settings: { historyTokenThreshold: 3000 } })
    t.after(h.cleanup)
    h.manuals.save({ name: '基地布局', summary: '要在基地里找东西时看。', body: `仓库在东边。${'一排排的箱子。'.repeat(770)}` })
    h.manuals.save({ name: '机器清单', summary: '要知道基地里有哪些机器时看。', body: `车床在二楼。${'一台又一台。'.repeat(900)}` })
    const say = async (text: string) => {
      h.agent.handleEvent(told(text))
      await h.agent.whenIdle()
    }
    h.llm.enqueue(reply('', [{ name: 'read_manual', input: { name: '基地布局' } }]), reply(''))
    await say('Alu 仓库在哪')
    await say('Alu 知道了吗')
    assert.match(manualLine(h.llm.lastUserText(2)), /^手册：基地布局 的内容还在这段对话里/)
    h.llm.enqueue(reply('', [{ name: 'read_manual', input: { name: '机器清单' } }]), reply(''))
    await say('Alu 车床在哪')

    // 这时历史超了：最近两轮之前的那本（基地布局）被拿掉，刚读的机器清单还在
    await say('Alu 再说一遍仓库在哪')
    const last = h.llm.requests.length - 1
    assert.equal(manualLine(h.llm.lastUserText(last)), '手册：机器清单 的内容还在这段对话里，不用重看；其余的要用之前先 read_manual。')
    const sent = JSON.stringify(h.llm.requests[last]!.messages)
    assert.equal(sent.includes('一排排的箱子'), false, 'the old manual text is gone from what the model sees')
    assert.match(sent, /the text of manual \\"基地布局\\" was dropped from the history to save space; read_manual it again when you need it/)
    assert.ok(sent.includes('车床在二楼'))
  })

  it('旧的工具结果被截短时，手册不留半截：整段换成一句话，也不再算作“内容还在”', () => {
    // 只有随代码发布的默认手册，没有主人写的
    const manuals = new ManualStore(DEFAULT_MANUALS_DIR, path.join(DEFAULT_MANUALS_DIR, 'no-user-manuals-here'))
    const blueprint = manuals.get('blueprint')!
    const turn = (id: number, text: string): { id: number; startedAt: number; messages: Message[] } => ({
      id,
      startedAt: id,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `第 ${id} 轮` }] },
        { role: 'assistant', content: [{ type: 'tool_call', id: `c${id}`, name: 'read_manual', input: { name: 'blueprint' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolCallId: `c${id}`, content: text }] },
      ],
    })
    const turns = [turn(1, manualText(blueprint)), turn(2, 'ok'), turn(3, 'ok')]
    const flat = (ts: typeof turns) => ts.flatMap((x) => x.messages)
    assert.deepEqual(manualsInContext(flat(turns), manuals.list()), ['blueprint'])

    const { turns: shortened, changed } = truncateOldToolResults(turns)
    assert.equal(changed, true)
    const result = shortened[0]!.messages[2]!.content[0]!
    assert.equal(result.type === 'tool_result' && result.content, '[the text of manual "blueprint" was dropped from the history to save space; read_manual it again when you need it]')
    assert.deepEqual(manualsInContext(flat(shortened), manuals.list()), [])
  })
})

describe('任务书：默认看谁的进度', () => {
  const lines = () => ({ lines: [{ name: 'Tier 0 - Stone Age', quests: 52, complete: 1, available: 2 }], quests: 3814 })

  it('有主人名单时看名单里第一个人的，哪怕这句话是名单里另一个人说的', async (t) => {
    const h = makeAgent({ settings: { owners: ['Steve', 'Alex'] } })
    t.after(h.cleanup)
    h.game.handlers['quest.lines'] = lines
    h.talk.enqueue(reply('', [{ name: 'list_quest_lines' }]), reply(''))
    h.agent.handleEvent(chat('Alex', 'Alu 任务书推到哪了'))
    await h.agent.whenIdle()
    assert.deepEqual(h.game.callsOf('quest.lines'), [{ player: 'Steve' }])
  })

  it('没有主人名单时看刚才跟它说话的那个玩家的（两条线看的是同一个人）；面板上下的指令没有玩家，就不带', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.game.handlers['quest.lines'] = lines
    h.talk.enqueue(reply('', [{ name: 'list_quest_lines' }]), reply(''))
    h.agent.handleEvent({ type: 'panel_command', time: Date.now(), text: '看看任务书' })
    await h.agent.whenIdle()
    assert.deepEqual(h.game.callsOf('quest.lines'), [{}])

    h.talk.enqueue(reply('', [{ name: 'list_quest_lines' }]), reply(''))
    h.agent.handleEvent(chat('Alex', 'Alu 我任务书推到哪了'))
    await h.agent.whenIdle()
    assert.deepEqual(h.game.callsOf('quest.lines')[1], { player: 'Alex' })

    // 干活线没有直接听到 Alex 说话，但“刚才跟它说话的人”是同一个玩家的事，它查的也是 Alex 的进度
    h.llm.enqueue(reply('', [{ name: 'list_quest_lines' }]), reply(''))
    h.agent.handleEvent(told('看看任务书推到哪了', []))
    await h.agent.whenIdle()
    assert.deepEqual(h.game.callsOf('quest.lines')[2], { player: 'Alex' })
  })
})
