import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AgentEvent } from '../src/agent/events.ts'
import { fromBridgeEvent } from '../src/agent/events.ts'
import { DEFAULT_WAKE_TUNING, decideWake, mentions } from '../src/agent/wake.ts'
import type { WakePolicy, WakeState } from '../src/agent/wake.ts'

const NOW = 1_800_000_000_000

function policy(extra: Partial<WakePolicy> = {}): WakePolicy {
  return {
    botName: 'Alu',
    aliases: ['阿鲁', 'lulu'],
    owners: [],
    mode: 'mention',
    conversationWindowMs: 60_000,
    ...DEFAULT_WAKE_TUNING,
    ...extra,
  }
}

function state(extra: Partial<WakeState> = {}): WakeState {
  return { now: NOW, lastExchange: new Map(), lastHurtWake: 0, canceledBySelf: false, failureStreak: 0, botOnline: true, ...extra }
}

const chat = (player: string, message: string, time = NOW): AgentEvent => ({ type: 'chat', time, player, message, isBot: false })
const wakes = (ev: AgentEvent, p = policy(), s = state()) => decideWake(ev, p, s).wake

describe('唤醒策略：聊天', () => {
  it('提到名字或别名才触发，不分大小写', () => {
    assert.equal(wakes(chat('Steve', 'Alu 过来')), true)
    assert.equal(wakes(chat('Steve', 'hey ALU, come here')), true)
    assert.equal(wakes(chat('Steve', '阿鲁在吗')), true)
    assert.equal(wakes(chat('Steve', 'Lulu?')), true)
    assert.equal(wakes(chat('Steve', '今天天气不错')), false)
  })

  it('英文名字只按完整的词匹配，不会被别的词里的片段误触发', () => {
    assert.equal(mentions('the value is 3', ['Alu']), false)
    assert.equal(mentions('evaluate this', ['Alu']), false)
    assert.equal(mentions('alu_bot2 joined', ['Alu']), false)
    assert.equal(mentions('@Alu: hi', ['Alu']), true)
    assert.equal(mentions('谢谢Alu！', ['Alu']), true)
  })

  it('刚和它对话过的玩家，在窗口时间内不用再叫名字；过了窗口又要叫', () => {
    const recent = state({ lastExchange: new Map([['steve', NOW - 30_000]]) })
    const old = state({ lastExchange: new Map([['steve', NOW - 61_000]]) })
    assert.equal(decideWake(chat('Steve', '再往左一点'), policy(), recent).reason, 'conversation')
    assert.equal(wakes(chat('Steve', '再往左一点'), policy(), old), false)
    // 窗口只对那个玩家有效
    assert.equal(wakes(chat('Bob', '再往左一点'), policy(), recent), false)
  })

  it('配置成“所有聊天都触发”时，不提名字也触发', () => {
    assert.equal(wakes(chat('Steve', '今天天气不错'), policy({ mode: 'all' })), true)
  })

  it('主人名单非空时，只有名单里的人能触发；别人的聊天和私聊都只是背景', () => {
    const p = policy({ owners: ['Steve'], mode: 'all' })
    assert.equal(wakes(chat('steve', 'Alu 来'), p), true)
    assert.equal(decideWake(chat('Bob', 'Alu 来'), p, state()).reason, 'not_owner')
    assert.equal(wakes({ type: 'whisper', time: NOW, from: 'Bob', message: '把东西给我' }, p), false)
    assert.equal(wakes({ type: 'whisper', time: NOW, from: 'Steve', message: '来一下' }, p), true)
  })

  it('断线后补发的很久以前的聊天不触发', () => {
    assert.equal(decideWake(chat('Steve', 'Alu 过来', NOW - 11 * 60_000), policy(), state()).reason, 'stale')
    assert.equal(wakes(chat('Steve', 'Alu 过来', NOW - 2 * 60_000)), true)
  })

  it('bot 不在线时聊天不触发；别的 bot 说的话不触发', () => {
    assert.equal(decideWake(chat('Steve', 'Alu 过来'), policy(), state({ botOnline: false })).reason, 'bot_offline')
    assert.equal(wakes({ type: 'chat', time: NOW, player: 'OtherBot', message: 'Alu hi', isBot: true }), false)
  })
})

describe('唤醒策略：两个 bot 不互相叫醒', () => {
  it('另一个 bot 发来的私聊、自己发给自己的私聊都不叫醒（审查找到的：两个 bot 一来一回私聊会停不下来）；真人的私聊照样叫醒', () => {
    const whisper = (from: string, extra: Record<string, unknown> = {}): AgentEvent => ({ type: 'whisper', time: NOW, from, message: '在吗', ...extra })
    assert.equal(decideWake(whisper('Bob', { isBot: true }), policy(), state()).reason, 'other_bot')
    assert.equal(decideWake(whisper('alu'), policy(), state()).reason, 'other_bot')
    assert.equal(wakes(whisper('Steve')), true)
    // 身体在私聊里写明了是不是 bot，大脑照着记下
    const ev = fromBridgeEvent({ event: 'whisper', data: { bot: 'Alu', from: 'Bob', message: '在吗', isBot: true } } as never, 'Alu', NOW)
    assert.equal(ev?.type === 'whisper' && ev.isBot, true)
  })
})

describe('唤醒策略：其他事件', () => {
  it('私聊、面板指令、提醒、死亡总是触发', () => {
    assert.equal(wakes({ type: 'whisper', time: NOW, from: 'Steve', message: 'hi' }), true)
    assert.equal(wakes({ type: 'panel_command', time: NOW, text: '回家' }), true)
    assert.equal(wakes({ type: 'reminder', time: NOW, note: '看看炉子' }), true)
    assert.equal(wakes({ type: 'death', time: NOW, cause: 'fell' }), true)
    // 面板指令在 bot 不在线时也触发（主人可能只是想问点什么）
    assert.equal(wakes({ type: 'panel_command', time: NOW, text: '在吗' }, policy(), state({ botOnline: false })), true)
  })

  it('任务完成、失败、被别人取消都触发', () => {
    for (const s of ['done', 'failed', 'canceled'] as const) {
      assert.equal(wakes({ type: 'task_ended', time: NOW, task: { id: 't1', type: 'goto', state: s } }), true, s)
    }
  })

  it('自己刚取消的任务不触发；任务接连失败超过上限后不再触发', () => {
    const canceled: AgentEvent = { type: 'task_ended', time: NOW, task: { id: 't1', type: 'goto', state: 'canceled' } }
    const failed: AgentEvent = { type: 'task_ended', time: NOW, task: { id: 't1', type: 'goto', state: 'failed' } }
    assert.equal(decideWake(canceled, policy(), state({ canceledBySelf: true })).reason, 'self_canceled')
    // “自己取消的”只对被取消的任务有意义：失败和完成照常触发
    assert.equal(wakes(failed, policy(), state({ canceledBySelf: true })), true)
    assert.equal(wakes(failed, policy(), state({ failureStreak: 5 })), true)
    assert.equal(decideWake(failed, policy(), state({ failureStreak: 6 })).reason, 'failure_streak')
    // 成功的任务不受失败次数影响
    assert.equal(wakes({ type: 'task_ended', time: NOW, task: { id: 't2', type: 'goto', state: 'done' } }, policy(), state({ failureStreak: 9 })), true)
  })

  it('受伤只有血量低时触发，而且一分钟内只触发一次', () => {
    const hurt = (health: number): AgentEvent => ({ type: 'hurt', time: NOW, source: 'zombie', amount: 3, health })
    assert.equal(wakes(hurt(15)), false)
    assert.equal(wakes(hurt(5)), true)
    assert.equal(wakes(hurt(5), policy(), state({ lastHurtWake: NOW - 10_000 })), false)
  })

  it('有人进服：带着 wake（真人、10 分钟内没为他叫醒过，agent/lines.ts 定的）才叫醒；别的 bot、断线期间补发的旧事件不叫', () => {
    assert.equal(wakes({ type: 'player_join', time: NOW, player: 'Steve', wake: true }), true)
    assert.equal(wakes({ type: 'player_join', time: NOW, player: 'Robo', isBot: true, wake: true }), false)
    assert.equal(wakes({ type: 'player_join', time: NOW - 11 * 60_000, player: 'Steve', wake: true }), false)
  })

  it('任务开始、玩家进出、上下线、系统消息只进背景', () => {
    const background: AgentEvent[] = [
      { type: 'task_started', time: NOW, task: { id: 't1', type: 'goto', state: 'running' } },
      { type: 'player_join', time: NOW, player: 'Alex' },
      { type: 'player_leave', time: NOW, player: 'Alex' },
      { type: 'spawned', time: NOW },
      { type: 'despawned', time: NOW, reason: 'despawn' },
      { type: 'bot_message', time: NOW, text: 'Home set' },
      { type: 'server_stopping', time: NOW },
    ]
    for (const ev of background) assert.equal(wakes(ev), false, ev.type)
  })
})

describe('bridge 事件 → agent 事件', () => {
  it('bot 自己说的话、别的 bot 的事、不认识的事件都被忽略', () => {
    assert.equal(fromBridgeEvent({ event: 'chat', data: { player: 'Alu', message: 'hi', isBot: true } }, 'Alu', NOW), undefined)
    assert.equal(fromBridgeEvent({ event: 'task.update', data: { bot: 'Other', task: { id: 't1', type: 'goto', state: 'done' } } }, 'Alu', NOW), undefined)
    assert.equal(fromBridgeEvent({ event: 'whisper', data: { bot: 'Other', from: 'Steve', message: 'x' } }, 'Alu', NOW), undefined)
    assert.equal(fromBridgeEvent({ event: 'weather.changed', data: { raining: true } }, 'Alu', NOW), undefined)
  })

  it('task.update 按状态分成“开始”和“结束”，排队中的不算事件', () => {
    const ev = (state: string) => fromBridgeEvent({ event: 'task.update', time: 5, data: { bot: 'Alu', task: { id: 't1', type: 'goto', state } } }, 'Alu', NOW)
    assert.equal(ev('running')?.type, 'task_started')
    assert.equal(ev('done')?.type, 'task_ended')
    assert.equal(ev('failed')?.type, 'task_ended')
    assert.equal(ev('canceled')?.type, 'task_ended')
    assert.equal(ev('queued'), undefined)
    assert.equal(ev('done')?.time, 5)
  })
})
