// 背在身上的东西和玩家的键盘：意见簿 f22 那件事——主人做出了直升机背包（探险背包 mod 的 adventurebackpack:copterPack），
// 要它自己灌上柴油、穿上、开机、飞起来（升、悬停、往前飞、降落），像一个真玩家那样。
// 入口是干活线的模型用的工具（open_screen、click_slot、use_control、press_key、hold_keys、get_status）和任务结束时它看到的结果；
// 游戏是按方法名应答的假服务器，照测试服上真的身体做出来的样子应答（数值取自那次实测：16 个柴油单元灌满 16000 mB，
// 悬停模式下按住跳 56 tick 从 y 68 升到离地 10.08 格）。按了会怎样是那个 mod 的事，大脑只把看得见的变化原样说出来。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import { useLocalNames } from '../src/tools/format.ts'
import { makeAgent, modelCalls, taskEnded, told } from './agent-harness.ts'
import type { AgentHarness } from './agent-harness.ts'
import { tmpDir, waitFor } from './helpers.ts'
import { MockBridge } from './mock-bridge.ts'

const GT = 'gregtech:gt.metaitem.01'
const COPTER = 'adventurebackpack:copterPack'
const OPEN = 'keys.adventureBackpack.openInventory'
const ACTION = 'keys.adventureBackpack.toggleActions'
const KEYS = [
  { key: OPEN, name: 'Open Inventory', category: 'Adventure Backpack' },
  { key: ACTION, name: 'Toggle Actions', category: 'Adventure Backpack' },
]

/** 名字表：物品和流体的中文名，像本地资料给的那样。 */
const NAMES: Record<string, string> = { [`${COPTER}/0`]: '直升机背包', [`${GT}/30708`]: '柴油单元', 'IC2:itemCellEmpty/0': '空单元' }

/** 测试服上身体那时的样子：背包里一个直升机背包、16 个柴油单元；还没穿。 */
function body() {
  const state = {
    carried: [
      { slot: 1, id: COPTER, meta: 0, count: 1, name: 'Copter Pack' },
      { slot: 2, id: GT, meta: 30708, count: 16, name: 'Diesel Cell' },
    ] as { slot: number; id: string; meta: number; count: number; name: string }[],
    worn: false,
    fuel: 0,
    status: 0,
    screen: undefined as undefined | 'holding' | 'wearing',
    emptyCells: 0,
    busy: false,
    air: undefined as undefined | { aboveGround: number; motion: { x: number; y: number; z: number } },
  }
  const copterData = () => ({ wearableData: { fuelTank: state.fuel > 0 ? { Amount: state.fuel, FluidName: 'fuel' } : { Empty: '' }, inventory: [], status: state.status, tickCounter: 0 } })
  const tanks = () => [{ ...(state.fuel > 0 ? { fluid: 'fuel', name: 'Fuel', amount: state.fuel } : { amount: 0 }), capacity: 16000 }]
  // 它的界面：两个燃料格（身上的柴油单元和空单元它都收），加上只在 mod 的客户端里画出来的那个按钮
  const screen = () =>
    state.screen === undefined
      ? { open: false }
      : {
          open: true,
          screen: 'ContainerCopter',
          slotCount: 38,
          slots: [
            ...state.carried.map((i) => ({ slot: i.slot, own: true, item: { id: i.id, meta: i.meta, count: i.count, name: i.name } })),
            { slot: 36, takes: [{ id: GT, meta: 30708, name: 'Diesel Cell' }] },
            state.emptyCells > 0 ? { slot: 37, item: { id: 'IC2:itemCellEmpty', meta: 0, count: state.emptyCells, name: 'Empty Cell' } } : { slot: 37, takes: [{ id: GT, meta: 30708, name: 'Diesel Cell' }] },
          ],
          controls: [state.screen === 'holding' ? { key: 'equip', kind: 'button', label: 'Shoulder Copter Pack' } : { key: 'unequip', kind: 'button', label: 'Unshoulder Copter Pack' }],
        }
  const status = () => ({
    name: 'Alu',
    online: true,
    dim: 0,
    pos: { x: 100.5, y: state.air ? 104.04 : 94, z: -69.5 },
    block: { x: 100, y: state.air ? 104 : 94, z: -70 },
    onGround: state.air === undefined,
    ...(state.air ? state.air : { aboveGround: 0, motion: { x: 0, y: -0.08, z: 0 } }),
    health: 20,
    maxHealth: 20,
    food: 20,
    inventory: state.carried,
    freeSlots: 36 - state.carried.length,
    ...(state.worn ? { worn: [{ slot: 'back', id: COPTER, meta: 0, count: 1, name: 'Copter Pack', tanks: tanks(), data: copterData() }] } : {}),
    task: null,
    queue: [],
  })
  return { state, screen, status }
}

function setup(t: { after(fn: () => void): void }): AgentHarness & { b: ReturnType<typeof body> } {
  const tmp = tmpDir()
  useLocalNames(
    { get: (id, meta) => (NAMES[`${id}/${meta ?? 0}`] ? { name: NAMES[`${id}/${meta ?? 0}`]! } : undefined), byEnglishName: () => undefined },
    { get: (fluid) => (fluid === 'fuel' ? { name: '柴油' } : undefined) },
  )
  const h = makeAgent({ dir: tmp.dir })
  t.after(async () => {
    await h.agent.stop()
    useLocalNames(undefined)
    tmp.cleanup()
  })
  const b = body()
  const s = b.state
  const g = h.game.handlers
  g['bot.status'] = () => b.status()
  g['bot.keys'] = () => ({ keys: KEYS })
  g['screen.open'] = (p) => {
    if ((p.item as { id?: string } | undefined)?.id !== COPTER) throw new BridgeError('no_material', 'the bot carries no such item')
    s.screen = 'holding'
    return b.screen()
  }
  g['screen.look'] = () => b.screen()
  g['screen.click'] = (p) => {
    // Shift 点身上的柴油单元：整组进燃料格，一个个倒进罐里，空单元落在下面那一格；Shift 点那一格：空单元回背包
    if (p.slot === 2 && p.shift === true) {
      s.carried = s.carried.filter((i) => i.slot !== 2)
      s.fuel = 16000
      s.emptyCells = 16
    } else if (p.slot === 37 && p.shift === true) {
      s.carried.push({ slot: 2, id: 'IC2:itemCellEmpty', meta: 0, count: s.emptyCells, name: 'Empty Cell' })
      s.emptyCells = 0
    }
    return b.screen()
  }
  g['screen.press'] = (p) => {
    // 和真的身体一样：按钮做它在 mod 的客户端里做的事，然后界面关上
    if (p.key === 'equip' && s.screen === 'holding') {
      s.carried = s.carried.filter((i) => i.id !== COPTER)
      s.worn = true
    } else if (p.key === 'unequip' && s.screen === 'wearing') {
      s.worn = false
      s.carried.push({ slot: 1, id: COPTER, meta: 0, count: 1, name: 'Copter Pack' })
    } else throw new BridgeError('bad_request', `the screen has no control "${String(p.key)}"; screen.look lists them`)
    s.screen = undefined
    return b.screen()
  }
  g['bot.key'] = (p) => {
    if (s.busy) throw new BridgeError('busy', 'a task is running; keys are pressed when the bot is idle')
    if (p.key !== OPEN && p.key !== ACTION) throw new BridgeError('bad_request', `no such key: ${String(p.key)}; the keys are ${JSON.stringify(KEYS)}`)
    if (p.key === OPEN) {
      if (s.worn) s.screen = 'wearing'
      return s.worn ? { key: OPEN, screen: b.screen() } : { key: OPEN }
    }
    if (!s.worn) return { key: ACTION }
    const was = s.status
    s.status = p.sneak === true ? (was === 0 ? 1 : 0) : was === 0 ? 0 : was === 1 ? 2 : 1
    if (s.status === was) return { key: ACTION }
    return { key: ACTION, changed: [{ slot: 'back', key: 'wearableData.status', was: String(was), now: String(s.status) }], said: [`CopterPack: ${['Off', 'Normal Mode', 'Hover Mode'][s.status]}.`] }
  }
  return Object.assign(h, { b })
}

/** 那次实测里按住跳升上去的那一段（悬停模式下，hold_keys { seconds: 15, jump: true, above: 10 }）：身体在 hold 任务结束时给的结果。 */
const RISE = {
  held: 56,
  stopped: 'above',
  from: { x: 63.51, y: 68, z: -9.29 },
  pos: { x: 63.51, y: 78.08, z: -9.29 },
  block: { x: 63, y: 78, z: -10 },
  onGround: false,
  aboveGround: 10.08,
  motion: { x: 0, y: 0.18, z: 0 },
  lowest: 68,
  highest: 78.08,
  track: [
    { x: 63.51, y: 68, z: -9.29, t: 0, above: 0 },
    { x: 63.51, y: 69.8, z: -9.29, t: 10, above: 1.8 },
    { x: 63.51, y: 71.6, z: -9.29, t: 20, above: 3.6 },
    { x: 63.51, y: 78.08, z: -9.29, t: 56, above: 10.08 },
  ],
  tanks: [{ fluid: 'fuel', name: 'Fuel', amount: 15969, capacity: 16000, slot: 'back', was: 15999 }],
}

describe('背在身上的东西和玩家的键盘（直升机背包，意见簿 f22）', () => {
  it('从手里打开直升机背包的界面：两个燃料格写着收身上的柴油单元（不是“放不进东西”），按钮带着它在游戏里的说明；Shift 点柴油单元进去、空单元取回，按 equip 穿上以后说背上穿着什么、罐里多少', async (t) => {
    const h = setup(t)
    const opened = await modelCalls(h, 'open_screen', { item: { id: COPTER } })
    assert.equal(opened.isError, false, opened.content)
    assert.match(opened.content, /- slots 36–37 \(takes only some things; of what you carry: 柴油单元 \[gregtech:gt\.metaitem\.01\/30708\]\): empty \(2\)/)
    assert.doesNotMatch(opened.content, /OUTPUT/)
    assert.match(opened.content, /- equip \[button\]: "Shoulder Copter Pack"/)

    const poured = await modelCalls(h, 'click_slot', { slot: 2, shift: true })
    assert.match(poured.content, /- slot 37: 16× 空单元 \[IC2:itemCellEmpty\]/)
    await modelCalls(h, 'click_slot', { slot: 37, shift: true })

    const worn = await modelCalls(h, 'use_control', { key: 'equip' })
    assert.equal(worn.isError, false, worn.content)
    assert.deepEqual(worn.content.split('\n').slice(0, 2), [
      'Pressed; the screen closed with it. What you wear outside the armor slots now:',
      '- on your back: "直升机背包" [adventurebackpack:copterPack]; tank: 16000 of 16000 mB 柴油 [fluid fuel]; its data: wearableData.fuelTank.Amount=16000, wearableData.fuelTank.FluidName="fuel", wearableData.inventory=[0 entries], wearableData.status=0, wearableData.tickCounter=0',
    ])
    assert.deepEqual(h.game.callsOf('screen.press'), [{ bot: 'Alu', key: 'equip' }])
  })

  it('press_key 不给键：列出身体按得了的键；按一下：身体收到键名和 sneak，结果写着穿着的东西的数据哪个值变了、游戏说了什么；打开了界面就是界面的样子；什么都没变时照实说', async (t) => {
    const h = setup(t)
    const list = await modelCalls(h, 'press_key', {})
    assert.equal(list.content, ['The keys mods add here that you can press (press_key with "key"):', `- ${OPEN} "Open Inventory" (Adventure Backpack)`, `- ${ACTION} "Toggle Actions" (Adventure Backpack)`].join('\n'))

    // 没穿着东西时按：什么都没变
    const idle = await modelCalls(h, 'press_key', { key: ACTION, sneak: true })
    assert.match(idle.content, /^Pressed keys\.adventureBackpack\.toggleActions while sneaking\.\nNothing visible changed: /)

    h.b.state.worn = true
    h.b.state.fuel = 16000
    const on = await modelCalls(h, 'press_key', { key: ACTION, sneak: true })
    assert.equal(on.content, ['Pressed keys.adventureBackpack.toggleActions while sneaking.', 'What you wear changed: back: wearableData.status 0 → 1', 'The game said: CopterPack: Normal Mode.'].join('\n'))
    const hover = await modelCalls(h, 'press_key', { key: ACTION })
    assert.match(hover.content, /wearableData\.status 1 → 2\nThe game said: CopterPack: Hover Mode\.$/)
    assert.deepEqual(h.game.callsOf('bot.key'), [
      { bot: 'Alu', key: ACTION, sneak: true },
      { bot: 'Alu', key: ACTION, sneak: true },
      { bot: 'Alu', key: ACTION },
    ])

    // 背上穿着的东西的界面：卸下来的按钮在那里
    const screen = await modelCalls(h, 'press_key', { key: OPEN })
    assert.match(screen.content, /^Pressed keys\.adventureBackpack\.openInventory\.\nScreen "ContainerCopter" is open/)
    assert.match(screen.content, /- unequip \[button\]: "Unshoulder Copter Pack"/)
  })

  it('press_key 碰到身体拒绝：有任务在跑、没有这个键、身体比键旧，都照实说怎么办', async (t) => {
    const h = setup(t)
    h.b.state.busy = true
    const busy = await modelCalls(h, 'press_key', { key: ACTION })
    assert.deepEqual([busy.isError, busy.content], [true, 'A task of yours is running: keys are pressed while you have no task. Wait for it to end (or cancel_task), then press it.'])
    h.b.state.busy = false
    const wrong = await modelCalls(h, 'press_key', { key: 'key.jump' })
    assert.equal(wrong.isError, true)
    assert.match(wrong.content, /^Not pressed: no such key: key\.jump; .*press_key without "key" lists the keys\.$/)
    delete h.game.handlers['bot.keys']
    const old = await modelCalls(h, 'press_key', {})
    assert.deepEqual([old.isError, old.content], [true, 'The body on the game server is older than mod keys: it has no keys to press.'])
  })

  it('hold_keys 开一个 hold 任务：秒换成 tick，只带按着的键，toward、range、y、above 原样给；queue 是排队', async (t) => {
    const h = setup(t)
    await modelCalls(h, 'hold_keys', { seconds: 10, jump: true, y: 104 })
    await modelCalls(h, 'hold_keys', { seconds: 2.5, toward: { x: 70, z: -70 }, range: 8, sneak: false, queue: true })
    await modelCalls(h, 'hold_keys', { seconds: 20, sneak: true, above: 0 })
    assert.deepEqual(h.game.callsOf('task.start'), [
      { bot: 'Alu', task: { type: 'hold', ticks: 200, jump: true, y: 104 }, mode: 'replace' },
      { bot: 'Alu', task: { type: 'hold', ticks: 50, toward: { x: 70, z: -70 }, range: 8 }, mode: 'append' },
      { bot: 'Alu', task: { type: 'hold', ticks: 400, sneak: true, above: 0 }, mode: 'replace' },
    ])
    const tooLong = await modelCalls(h, 'hold_keys', { seconds: 61, jump: true })
    assert.deepEqual([tooLong.isError, tooLong.content], [true, 'Invalid arguments for hold_keys: seconds must be <= 60'])
    // 落地那一下：离地高度到 0 松手（那次实测的数）
    const before = h.llm.requests.length
    h.llm.enqueue({ message: { role: 'assistant', content: [] }, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'scripted' })
    h.agent.handleEvent(taskEnded('t9', 'done', { type: 'hold', params: { type: 'hold', ticks: 400, sneak: true, above: 0 }, result: { ...RISE, held: 34, stopped: 'above', pos: { x: 33.48, y: 68, z: -9.3 }, onGround: true, aboveGround: 0, motion: { x: -0.01, y: -0.18, z: 0 } } }))
    await waitFor('the work line was woken', () => h.llm.requests.length > before)
    const seen = JSON.stringify(h.llm.requests[before]!.messages.at(-1))
    assert.ok(seen.includes('held sneak for 1.7 s (34 ticks), let go because your height above the ground reached the one given'), seen)
    assert.ok(seen.includes('now at (33.48, 68, -9.3): on the ground, moving down 0.18 and 0.01 sideways (x -0.01, z 0) blocks per tick'), seen)
  })

  it('hold 任务结束：干活线被叫醒时看到按了什么、多久、为什么松手，现在在哪、离地多高、怎么在动，路上的几个点，背着的罐用了多少；get_status 在空中时写着离地多高、穿着什么', async (t) => {
    const h = setup(t)
    h.llm.enqueue({ message: { role: 'assistant', content: [] }, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'scripted' })
    h.agent.handleEvent(taskEnded('t9', 'done', { type: 'hold', params: { type: 'hold', ticks: 300, jump: true, above: 10 }, result: RISE }))
    await waitFor('the work line was woken', () => h.llm.requests.length > 0)
    const seen = JSON.stringify(h.llm.requests[0]!.messages.at(-1))
    for (const line of [
      'held jump for 2.8 s (56 ticks), let go because your height above the ground reached the one given',
      'now at (63.51, 78.08, -9.29): in the air, 10.08 blocks above the ground, moving up 0.18 blocks per tick',
      'started at (63.51, 68, -9.29); lowest y 68, highest y 78.08',
      'on the way: 0s (63.51, 68, -9.29) 0 up; 0.5s (63.51, 69.8, -9.29) 1.8 up; 1s (63.51, 71.6, -9.29) 3.6 up; 2.8s (63.51, 78.08, -9.29) 10.08 up',
      'tanks of what you wear: 15969 of 16000 mB 柴油 [fluid fuel] (was 15999)',
    ]) assert.ok(seen.includes(line), `missing: ${line}\nin: ${seen}`)
    await h.agent.whenIdle()

    h.b.state.worn = true
    h.b.state.fuel = 15969
    h.b.state.status = 2
    h.b.state.air = { aboveGround: 10.04, motion: { x: 0, y: 0, z: 0 } }
    const status = await modelCalls(h, 'get_status')
    assert.match(status.content, /at block \(100,104,-70\), health 20\/20, food 20, in the air, 10\.04 blocks above the ground, not moving\n/)
    assert.match(status.content, /\nWorn on your back: "直升机背包" \[adventurebackpack:copterPack\]; tank: 15969 of 16000 mB 柴油 \[fluid fuel\]; its data: .*wearableData\.status=2/)
  })

  it('一个干活线的一轮里照着手册做下来：打开、灌油、穿上、开机、切悬停、按住跳——每一步打到身体上的就是玩家那几个动作', async (t) => {
    const h = setup(t)
    const steps: [string, unknown][] = [
      ['open_screen', { item: { id: COPTER } }],
      ['click_slot', { slot: 2, shift: true }],
      ['click_slot', { slot: 37, shift: true }],
      ['use_control', { key: 'equip' }],
      ['press_key', { key: ACTION, sneak: true }],
      ['press_key', { key: ACTION }],
      ['hold_keys', { seconds: 15, jump: true, above: 10 }],
    ]
    h.llm.enqueue(...steps.map(([name, input], n) => ({ message: { role: 'assistant' as const, content: [{ type: 'tool_call' as const, id: `s${n}`, name, input }] }, stopReason: 'tool_use' as const, usage: { inputTokens: 1, outputTokens: 1 }, model: 'scripted' })), { message: { role: 'assistant', content: [] }, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'scripted' })
    h.agent.handleEvent(told('给直升机背包灌上柴油，穿上，飞到离地十格'))
    await h.agent.whenIdle()
    const acts = h.game.calls.filter((c) => ['screen.open', 'screen.click', 'screen.press', 'bot.key', 'task.start'].includes(c.method)).map((c) => [c.method, c.params])
    assert.deepEqual(acts, [
      ['screen.open', { bot: 'Alu', item: { id: COPTER } }],
      ['screen.click', { bot: 'Alu', slot: 2, shift: true }],
      ['screen.click', { bot: 'Alu', slot: 37, shift: true }],
      ['screen.press', { bot: 'Alu', key: 'equip' }],
      ['bot.key', { bot: 'Alu', key: ACTION, sneak: true }],
      ['bot.key', { bot: 'Alu', key: ACTION }],
      ['task.start', { bot: 'Alu', task: { type: 'hold', ticks: 300, jump: true, above: 10 }, mode: 'replace' }],
    ])
    assert.deepEqual([h.b.state.worn, h.b.state.fuel, h.b.state.status], [true, 16000, 2])
  })

  it('模拟身体（npm run mock-bridge、面板开发用的）照协议应答：列键、按键（有任务在跑时 busy、没有的键 bad_request）、背上的直升机背包开关、状态里的 worn 和离地高度、hold 任务', async (t) => {
    const bridge = new MockBridge({ bots: ['Alu'] })
    await bridge.start()
    const client = new BridgeClient({ address: () => ({ host: '127.0.0.1', port: bridge.port }), token: () => bridge.token, clientName: 'brain/test', requestTimeoutMs: 2000, reconnectMinMs: 20, reconnectMaxMs: 100, resume: { load: () => undefined, save: () => {} } })
    client.start()
    t.after(async () => {
      client.stop()
      await bridge.stop()
    })
    await waitFor('connected', () => client.isConnected())
    const api = new BridgeApi(client)
    assert.deepEqual((await api.botKeys()).keys, KEYS)
    assert.deepEqual(await api.botKey('Alu', ACTION, true), { key: ACTION })
    bridge.bots.get('Alu')!.worn = [{ slot: 'back', id: COPTER, meta: 0, count: 1, name: 'Copter Pack', tanks: [{ fluid: 'fuel', name: 'Fuel', amount: 16000, capacity: 16000 }], data: { wearableData: { status: 0 } } }]
    assert.deepEqual(await api.botKey('Alu', ACTION, true), { key: ACTION, changed: [{ slot: 'back', key: 'wearableData.status', was: '0', now: '1' }], said: ['CopterPack: Normal Mode.'] })
    const status = await api.botStatus('Alu')
    assert.deepEqual([status.worn?.[0]?.data, status.aboveGround, status.motion], [{ wearableData: { status: 1 } }, 0, { x: 0, y: -0.08, z: 0 }])
    await assert.rejects(api.botKey('Alu', 'key.jump'), (e: unknown) => e instanceof BridgeError && e.code === 'bad_request')
    await assert.rejects(api.taskStart('Alu', { type: 'hold', ticks: 0 }), (e: unknown) => e instanceof BridgeError && e.code === 'bad_request')
    const started = await api.taskStart('Alu', { type: 'hold', ticks: 40, jump: true })
    await assert.rejects(api.botKey('Alu', ACTION), (e: unknown) => e instanceof BridgeError && e.code === 'busy')
    const ended = bridge.completeTask('Alu')
    assert.deepEqual([ended.id, ended.state, (ended.result as { held?: number }).held], [started.task.id, 'done', 40])
  })
})
