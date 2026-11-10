import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { truncateOldToolResults } from '../src/agent/compaction.ts'
import { manualsInContext } from '../src/agent/context.ts'
import { DEFAULT_PERSONA } from '../src/agent/prompt.ts'
import type { Message } from '../src/llm/index.ts'
import { ManualStore, manualText } from '../src/store/manuals.ts'
import { DEFAULT_MANUALS_DIR, chat, makeAgent, reply } from './agent-harness.ts'

/** 给模型看的那行“哪几本手册的内容还在这段对话里”。 */
function manualLine(userText: string): string {
  return userText.split('\n').find((l) => l.startsWith('手册：')) ?? ''
}

describe('手册：提示词只列目录，要用时才读', () => {
  it('系统提示词里有手册目录（默认的和主人写的各带一句什么时候看），各类活的细节不在提示词里', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.manuals.save({ name: '基地布局', summary: '要在基地里找仓库、机器、工作台时看。', body: '仓库在 (100,64,200) 一带。' })
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    await h.agent.whenIdle()
    const system = h.llm.requests[0]!.system ?? ''
    assert.match(system, /^# 手册$/m)
    for (const name of ['blueprint', 'crafting', 'containers', 'terrain', 'travel', 'quests']) {
      assert.match(system, new RegExp(`^- ${name}：.{8,}$`, 'm'), `the catalogue lists ${name}`)
    }
    assert.match(system, /^- 基地布局（主人写的）：要在基地里找仓库、机器、工作台时看。$/m)
    assert.match(system, /先用 read_manual 看完再动手/)
    // 手册的正文不在提示词里：只有模型去读的时候才出现
    assert.equal(system.includes('仓库在 (100,64,200)'), false)
    assert.equal(/needsClimbingBlocks|maxFillDepth|craftingTool|匠魂/.test(system), false)
    // 用户嫌原来的提示词又长又杂（拆手册之前 6900 多字）：核心加目录要明显短
    assert.ok(DEFAULT_PERSONA.length < 2000, `core prompt is ${DEFAULT_PERSONA.length} chars`)
    assert.ok(system.length < 3500, `system prompt is ${system.length} chars`)
  })

  it('主人自定义了人设提示词的：照旧用他的那份，后面同样附上手册目录', async (t) => {
    const h = makeAgent({ settings: { persona: '你是 {{name}}，只说文言文。' } })
    t.after(h.cleanup)
    h.agent.handleEvent(chat('Steve', 'Alu 在吗'))
    await h.agent.whenIdle()
    const system = h.llm.requests[0]!.system ?? ''
    assert.ok(system.startsWith('你是 Alu，只说文言文。'))
    assert.equal(system.includes('干活靠任务'), false, 'the default core prompt is not mixed in')
    assert.match(system, /^# 手册$/m)
    assert.match(system, /^- blueprint：/m)
  })

  it('读过的手册，之后每一轮的“当前状态”都写明它的内容还在对话里；主人把那本手册改了以后就不再算看过', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.llm.enqueue(reply('', [{ name: 'read_manual', input: { name: 'blueprint' } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 照图纸盖个房子'))
    await h.agent.whenIdle()
    assert.equal(manualLine(h.llm.lastUserText(0)), '手册：这段对话里现在没有任何一本手册的内容，要做某类事之前先 read_manual。')
    // 工具结果是整本手册
    assert.match(h.llm.lastUserText(1), /^Manual "blueprint": /)

    h.agent.handleEvent(chat('Steve', 'Alu 放在 100 64 200'))
    await h.agent.whenIdle()
    assert.equal(manualLine(h.llm.lastUserText(2)), '手册：blueprint 的内容还在这段对话里，不用重看；其余的要用之前先 read_manual。')

    // 主人在面板上改了这本手册：模型手里那份是旧的
    h.manuals.save({ name: 'blueprint', summary: '盖房子之前看（我们服的规矩）。', body: '一律先问我，不许自己清场。' })
    h.agent.handleEvent(chat('Steve', 'Alu 开始吧'))
    await h.agent.whenIdle()
    assert.equal(manualLine(h.llm.lastUserText(3)), '手册：这段对话里现在没有任何一本手册的内容，要做某类事之前先 read_manual。')
  })

  it('历史压缩把较早的手册原文拿掉以后，那本不再算看过，历史里留下一句“要用时重新读”', async (t) => {
    // 历史上限调低，两本大手册放不下
    const h = makeAgent({ settings: { historyTokenThreshold: 3000 } })
    t.after(h.cleanup)
    h.manuals.save({ name: '基地布局', summary: '要在基地里找东西时看。', body: `仓库在东边。${'一排排的箱子。'.repeat(770)}` })
    h.manuals.save({ name: '机器清单', summary: '要知道基地里有哪些机器时看。', body: `车床在二楼。${'一台又一台。'.repeat(900)}` })
    const say = async (text: string) => {
      h.agent.handleEvent(chat('Steve', text))
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
    h.llm.enqueue(reply('', [{ name: 'list_quest_lines' }]), reply(''))
    h.agent.handleEvent(chat('Alex', 'Alu 任务书推到哪了'))
    await h.agent.whenIdle()
    assert.deepEqual(h.game.callsOf('quest.lines'), [{ player: 'Steve' }])
  })

  it('没有主人名单时看刚才跟它说话的那个玩家的；面板上下的指令没有玩家，就不带', async (t) => {
    const h = makeAgent()
    t.after(h.cleanup)
    h.game.handlers['quest.lines'] = lines
    h.llm.enqueue(reply('', [{ name: 'list_quest_lines' }]), reply(''))
    h.agent.handleEvent({ type: 'panel_command', time: Date.now(), text: '看看任务书' })
    await h.agent.whenIdle()
    assert.deepEqual(h.game.callsOf('quest.lines'), [{}])

    h.llm.enqueue(reply('', [{ name: 'list_quest_lines' }]), reply(''))
    h.agent.handleEvent(chat('Alex', 'Alu 我任务书推到哪了'))
    await h.agent.whenIdle()
    assert.deepEqual(h.game.callsOf('quest.lines')[1], { player: 'Alex' })
  })
})
