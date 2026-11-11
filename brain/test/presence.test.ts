// 自动上下线（src/agent/presence.ts）：服务器上没有真人、它手上也没事，过几分钟自己下线；有真人进服、面板上发指令、提醒到点再上来。
// 这里用一个假的身体（记着谁在线、它在不在线、有没有任务）和一只自己拨的钟，直接驱动这个模块对外的几个入口：
// 身体推来的事件（onEvent）、隔一会儿的检查（tick）、连上游戏（onReady）、“有事要它回来”（comeBack）。
// 它和大脑别处怎么接（面板指令、提醒、重启、被踢）在 e2e.test.ts 的“自动上下线”那条里走真的进程。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Presence } from '../src/agent/presence.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import type { PresenceSettings } from '../src/agent/presence.ts'

const MIN = 60_000

function setup(init: Partial<PresenceSettings> = {}) {
  const settings: PresenceSettings = { botName: 'Alu', wantOnline: true, enabled: true, idleMinutes: 5, away: false, ...init }
  const world = {
    now: 1_000_000,
    connected: true,
    online: !settings.away && settings.wantOnline,
    busy: false,
    players: [] as { name: string; isBot?: boolean }[],
    task: null as { id: string } | null,
    queue: [] as { id: string }[],
    /** 身体这一回不答应上线、下线。 */
    refuse: false,
    /** 上线、下线的请求发出去了、身体也照办了，可答复没回来（连接断了）。 */
    lost: false,
  }
  const calls: string[] = []
  const log: string[] = []
  const presence = new Presence({
    settings: () => ({ ...settings }),
    setAway: (away) => {
      settings.away = away
    },
    bridge: {
      serverInfo: async () => ({ players: [...world.players, ...(world.online ? [{ name: 'Alu', isBot: true }] : [])] }),
      taskList: async () => ({ active: world.task as never, queue: world.queue as never }),
      botStatus: async () => ({ online: world.online }),
      botSpawn: async () => {
        calls.push('spawn')
        if (world.refuse) throw new BridgeError('bad_request', 'the server is full')
        world.online = true
        return {}
      },
      botDespawn: async () => {
        calls.push('despawn')
        if (world.refuse) throw new BridgeError('bad_request', 'the bot is in a fight')
        world.online = false
        if (world.lost) throw new BridgeError('disconnected', 'connection to the game server was lost')
        return {}
      },
    },
    connected: () => world.connected,
    online: () => world.online,
    busy: () => world.busy,
    log: (entry) => log.push(`${entry.kind}: ${entry.text}`),
    now: () => world.now,
  })
  const event = (name: 'player.join' | 'player.leave', player: string, extra: Record<string, unknown> = {}) => {
    if (name === 'player.join') world.players.push({ name: player, ...(extra.isBot === true ? { isBot: true } : {}) })
    else world.players = world.players.filter((p) => p.name !== player)
    presence.onEvent({ seq: 1, time: world.now, event: name, data: { player, uuid: 'u', ...extra } })
  }
  /** 钟往前拨这么多分钟，然后查一次。 */
  const after = async (minutes: number) => {
    world.now += minutes * MIN
    await presence.tick()
  }
  return { settings, world, calls, log, presence, event, after }
}

describe('自动上下线', () => {
  it('开着的时候：服务器上没有真人、它手上也没事，满 5 分钟自己下线，日志里写明为什么下、什么时候会回来；不到 5 分钟不下', async () => {
    const s = setup()
    await s.presence.onReady()
    await s.after(0)
    await s.after(4.9)
    assert.deepEqual([s.calls, s.settings.away], [[], false])
    await s.after(0.1)
    assert.deepEqual([s.calls, s.world.online, s.settings.away], [['despawn'], false, true])
    assert.deepEqual(s.log, ['info: Alu 自动下线了：服务器上没有真人，它手上也没有事，已经 5 分钟。有真人进服、主人在面板上发指令、或者它定的提醒到点，它会自己再上来。'])
    // 下线以后不会再下一次
    await s.after(30)
    assert.deepEqual(s.calls, ['despawn'])
  })

  it('有真人在、它手上有事、身体还排着任务：都不下线，5 分钟从这些都没了以后重新数；别的 bot 在不算有人', async () => {
    const s = setup()
    s.world.players = [{ name: 'Steve' }, { name: 'Robo', isBot: true }]
    await s.presence.onReady()
    await s.after(0)
    await s.after(60)
    assert.deepEqual(s.calls, [], '有真人在')
    // 真人走了，只剩另一个 bot：5 分钟从他走了以后数（他在的时候查过多少次都不算）
    await s.after(1)
    await s.after(3)
    s.event('player.leave', 'Steve')
    await s.after(0)
    await s.after(2)
    assert.deepEqual(s.calls, [], '人走了才 2 分钟')
    await s.after(2)
    // 它忙起来了（哪条线在跑一轮、盯着任务、例程在跑）
    s.world.busy = true
    await s.after(10)
    assert.deepEqual(s.calls, [], '手上有事')
    // 忙完以后也是从头数（忙着的时候查过多少次都不算）
    await s.after(3)
    await s.after(2)
    s.world.busy = false
    await s.after(0)
    await s.after(3)
    assert.deepEqual(s.calls, [], '忙完才 3 分钟')
    await s.after(1.9)
    assert.deepEqual(s.calls, [], '忙完才 4.9 分钟')
    await s.after(0.1)
    assert.deepEqual(s.calls, ['despawn'])
    s.event('player.join', 'Steve')
    await s.presence.tick()
    s.event('player.leave', 'Steve')
    await s.after(0)
    await s.after(4)
    // 大脑没盯着、身体自己排着的任务（面板上点出来的）也算有事：到点时问身体才知道
    s.world.task = { id: 't9' }
    await s.after(1)
    assert.deepEqual(s.calls, ['despawn', 'spawn'], '身体有任务：没有再下线')
    s.world.task = null
    await s.after(0)
    await s.after(5)
    assert.deepEqual(s.calls, ['despawn', 'spawn', 'despawn'])
  })

  it('进服的事件漏了一个（大脑以为服务器上没人）：下线前再问一遍身体，其实有人，就不下线', async () => {
    const s = setup()
    await s.presence.onReady()
    await s.after(0)
    // Alex 进来了，可是这条事件没到大脑
    s.world.players.push({ name: 'Alex' })
    await s.after(5)
    await s.after(5)
    assert.deepEqual([s.calls, s.settings.away], [[], false])
  })

  it('自动下线以后：有真人进服就上来，日志写明是谁；别的 bot 进服不算', async () => {
    const s = setup()
    await s.presence.onReady()
    await s.after(0)
    await s.after(5)
    assert.equal(s.world.online, false)
    s.event('player.join', 'Robo', { isBot: true })
    await s.presence.tick()
    assert.deepEqual([s.world.online, s.settings.away], [false, true])
    s.event('player.join', 'Steve')
    await s.presence.tick()
    assert.deepEqual([s.calls, s.world.online, s.settings.away], [['despawn', 'spawn'], true, false])
    assert.equal(s.log.at(-1), 'info: Alu 自动上线了：Steve 进了服务器。')
    // 人在，就一直在
    await s.after(60)
    assert.deepEqual(s.calls, ['despawn', 'spawn'])
  })

  it('自动下线以后：主人从面板发指令、它定的提醒到点，先让它上来（日志写明原因）；它本来就在线时这一步什么都不做', async () => {
    const s = setup()
    await s.presence.onReady()
    await s.presence.comeBack('主人在面板上发了指令')
    assert.deepEqual([s.calls, s.log], [[], []])
    await s.after(0)
    await s.after(5)
    await s.presence.comeBack('它定的提醒到点了')
    assert.deepEqual([s.calls, s.world.online, s.settings.away], [['despawn', 'spawn'], true, false])
    assert.equal(s.log.at(-1), 'info: Alu 自动上线了：它定的提醒到点了。')
    // 事办完、还是没人：再过 5 分钟又下
    await s.after(0)
    await s.after(5)
    assert.deepEqual(s.calls, ['despawn', 'spawn', 'despawn'])
  })

  it('主人手动点的下线不算自动下线：有真人进服、发指令、提醒到点都不会把它叫上来', async () => {
    // 面板上点了“下线”：不要它在线，也不是自动下线中
    const s = setup({ wantOnline: false, away: false })
    await s.presence.onReady()
    s.event('player.join', 'Steve')
    await s.presence.comeBack('主人在面板上发了指令')
    await s.after(60)
    assert.deepEqual([s.calls, s.world.online, s.log], [[], false, []])
    // 自动下线中，主人又点了“下线”（面板把两样都改了）：之后有人进服也不上来
    const t = setup()
    await t.presence.onReady()
    await t.after(0)
    await t.after(5)
    t.settings.wantOnline = false
    t.settings.away = false
    t.event('player.join', 'Steve')
    await t.presence.tick()
    assert.deepEqual([t.calls, t.world.online], [['despawn'], false])
  })

  it('默认是关的：没人没事多久都不下线。开着时自动下线了、主人把开关关掉：它上来', async () => {
    const off = setup({ enabled: false })
    await off.presence.onReady()
    await off.after(0)
    await off.after(600)
    assert.deepEqual(off.calls, [])
    const s = setup()
    await s.presence.onReady()
    await s.after(0)
    await s.after(5)
    s.settings.enabled = false
    await s.presence.tick()
    assert.deepEqual([s.calls, s.world.online, s.settings.away], [['despawn', 'spawn'], true, false])
    assert.equal(s.log.at(-1), 'info: Alu 自动上线了：自动上下线关掉了。')
  })

  it('大脑重启时它正自动下线：连上游戏后服务器上没有真人就还是下线；有真人就上来', async () => {
    const empty = setup({ away: true })
    await empty.presence.onReady()
    await empty.after(60)
    assert.deepEqual([empty.calls, empty.world.online, empty.settings.away], [[], false, true])
    const someone = setup({ away: true })
    someone.world.players = [{ name: 'Steve' }, { name: 'Alex' }]
    await someone.presence.onReady()
    assert.deepEqual([someone.calls, someone.world.online, someone.settings.away], [['spawn'], true, false])
    assert.equal(someone.log.at(-1), 'info: Alu 自动上线了：服务器上有真人（steve、alex）。')
  })

  it('和游戏断着的时候不数时间；上线、下线身体没答应：状态不乱，日志记下没成功，下一次有事再试', async () => {
    const s = setup()
    await s.presence.onReady()
    s.world.connected = false
    await s.after(0)
    await s.after(60)
    assert.deepEqual(s.calls, [], '断着不数')
    s.world.connected = true
    // 下线没成功：不算自动下线中
    s.world.refuse = true
    await s.after(0)
    await s.after(5)
    assert.deepEqual([s.calls, s.world.online, s.settings.away], [['despawn'], true, false])
    assert.equal(s.log.at(-1), 'error: 想让 Alu 自动下线但没成功：the bot is in a fight')
    s.world.refuse = false
    await s.after(0)
    await s.after(5)
    assert.deepEqual([s.world.online, s.settings.away], [false, true])
    // 上线没成功：还算自动下线中，下一次有人进服再试
    s.world.refuse = true
    s.event('player.join', 'Steve')
    await s.presence.tick()
    assert.deepEqual([s.world.online, s.settings.away], [false, true])
    assert.equal(s.log.at(-1), 'error: 想让 Alu 自动上线（Steve 进了服务器）但没成功：the server is full')
    s.world.refuse = false
    await s.presence.comeBack('主人在面板上发了指令')
    assert.deepEqual([s.world.online, s.settings.away], [true, false])
  })

  it('下线的请求发出去了、答复没回来（连接正好断了，或者大脑正好在停）：它其实下线了，就仍然算自动下线中；它其实还在线，下一次检查问过身体就不算了', async () => {
    // 身体照办了，答复丢了
    const s = setup()
    await s.presence.onReady()
    await s.after(0)
    s.world.lost = true
    await s.after(5)
    assert.deepEqual([s.world.online, s.settings.away], [false, true])
    await s.after(60)
    assert.deepEqual([s.calls, s.settings.away], [['despawn'], true])
    // 记着“自动下线中”，可它在线（有人从别处把它叫上来了）：问过身体，不再算自动下线中，没人没事时从头数 5 分钟
    s.world.lost = false
    s.world.online = true
    await s.after(0)
    assert.equal(s.settings.away, false)
    await s.after(0)
    await s.after(5)
    assert.deepEqual(s.calls, ['despawn', 'despawn'])
  })
})
