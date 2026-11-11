// 界面上格子以外的东西（开关、选项、页签、流体格、按钮）和“产物是流体”的加工。
// 主人的那个用例：钢板在流体提取机里化成了熔融钢，流体留在提取机的罐里；固化器是空的，因为提取机的“流体自动输出”关着——
// 它得能打开机器的界面、看到这个开关、把它按开。
// 入口是干活线的模型用的工具和它写的例程；游戏是按方法名应答的假服务器。控件的名字照真的界面起的那样（界面自己的名字，身体和大脑都不解释）。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { BridgeError } from '../src/bridge/protocol.ts'
import { DesignWorkspace } from '../src/design/index.ts'
import { loadPackData } from '../src/packdata/index.ts'
import { useLocalNames } from '../src/tools/format.ts'
import { lineCalls, makeAgent, modelCalls, reply, taskEnded, told } from './agent-harness.ts'
import type { AgentHarness } from './agent-harness.ts'
import { tmpDir, waitFor } from './helpers.ts'

const GT = 'gregtech:gt.metaitem.01'
const EXTRACTOR = { x: -527, y: 70, z: 41 }
const PANEL = 'basicmachine.fluidextractor.tier.02'
const PLATE = { id: GT, meta: 17305, count: 2, name: 'Steel Plate' }
const MOLD = { id: GT, meta: 32322, count: 1, name: 'Mold (Ring)' }

/** 流体提取机的界面：一个原料格、一个产物格，加上它自己的那些控件。state 是测试里会变的那几样。 */
function screen(state: { autoOutput: boolean; coverOpen: boolean; mode: string; limit: number; label: string }) {
  return {
    open: true,
    screen: 'Basic Fluid Extractor',
    slotCount: (state.coverOpen ? 11 : 2) + 36,
    slots: [
      { slot: 0, item: PLATE },
      { slot: 1, takesNothing: true },
      // 覆盖板的页签开着时，它那 9 格接在机器自己的格子后面
      ...(state.coverOpen ? [{ slot: 2, item: MOLD }, ...Array.from({ length: 8 }, (_, n) => ({ slot: 3 + n }))] : []),
    ],
    controls: [
      { panel: PANEL, key: 'fluidAutoOutput:0', kind: 'switch', value: state.autoOutput },
      { panel: PANEL, key: 'itemAutoOutput:0', kind: 'switch', value: false },
      { panel: PANEL, key: 'powerfail:0', kind: 'switch', value: false, readOnly: true },
      { panel: PANEL, key: 'cover_panel_west', kind: 'panel', open: state.coverOpen },
      { panel: PANEL, key: 'auto_sync:tank:3', kind: 'fluid', fluid: 'molten.steel', name: 'Molten Steel', amount: 288, capacity: 32000, fills: false, drains: true },
      { panel: PANEL, key: 'auto_sync:tank:4', kind: 'fluid', amount: 0, capacity: 16000, fills: true, drains: true },
      { panel: PANEL, key: 'outputMode:0', kind: 'choice', value: state.mode, options: ['NONE', 'ITEMS', 'FLUIDS'] },
      { panel: PANEL, key: 'limit:0', kind: 'number', value: state.limit },
      { panel: PANEL, key: 'label:0', kind: 'text', value: state.label },
      { panel: PANEL, key: 'progress:0', kind: 'value', value: '0/24', type: 'ProgressSH' },
      // 另一个面板上有个重名的开关
      { panel: 'sideSelection_fluid', key: 'fluidAutoOutput:0', kind: 'switch', value: true },
      { panel: 'sideSelection_fluid', key: 'reset', kind: 'button' },
    ],
  }
}

function setup(t: { after(fn: () => void): void }): AgentHarness & { state: Parameters<typeof screen>[0] } {
  const tmp = tmpDir()
  // 一小份本地资料：只为了流体有中文名（熔融钢）
  const dir = path.join(tmp.dir, 'packdata')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'items.jsonl'), `${JSON.stringify({ id: GT, meta: 17305, name: '钢板', en: 'Steel Plate' })}\n${JSON.stringify({ id: GT, meta: 32322, name: '模具（环）', en: 'Mold (Ring)' })}\n`)
  fs.writeFileSync(path.join(dir, 'handlers.json'), JSON.stringify([{ key: 'gt.recipe.fluidextractor', name: '流体提取机', mod: 'GregTech', machines: [], read: 'gregtech' }]))
  fs.writeFileSync(path.join(dir, 'recipes.jsonl'), `${JSON.stringify({ h: 'gt.recipe.fluidextractor', in: [{ id: GT, meta: 17305, n: 1 }], out: [], fout: [{ f: 'molten.steel', name: '熔融钢', mb: 144 }], eut: 30, ticks: 24 })}\n`)
  const packdata = loadPackData(dir)
  useLocalNames(packdata.items, packdata.fluids)
  const h = makeAgent({ dir: tmp.dir, design: new DesignWorkspace({ dataDir: tmp.dir, packdata }), packdata })
  t.after(async () => {
    await h.agent.stop()
    useLocalNames(undefined)
    packdata.recipes?.close()
    tmp.cleanup()
  })
  const state = { autoOutput: false, coverOpen: false, mode: 'NONE', limit: 0, label: '' }
  const g = h.game.handlers
  g['screen.open'] = () => screen(state)
  g['screen.look'] = () => screen(state)
  // 和真的身体一样：按名字找控件（写全，或者只写冒号前的那一段；重名时要给面板），做完给界面的新样子
  const find = (p: Record<string, unknown>) => {
    const found = screen(state).controls.filter((c) => (p.panel === undefined || c.panel === p.panel) && (c.key === p.key || c.key.slice(0, c.key.lastIndexOf(':')) === p.key))
    if (found.length === 0) throw new BridgeError('bad_request', `the screen has no control "${String(p.key)}"; screen.look lists them`)
    if (found.length > 1) throw new BridgeError('bad_request', `more than one control is called "${String(p.key)}": give its full key and its panel`)
    return found[0]!
  }
  g['screen.press'] = (p) => {
    const c = find(p)
    if (c.readOnly) throw new BridgeError('denied', `the screen only shows "${String(p.key)}"; it does not take a change of it from a player`)
    if (c.key === 'fluidAutoOutput:0' && c.panel === PANEL) state.autoOutput = !state.autoOutput
    else if (c.key === 'cover_panel_west') state.coverOpen = !state.coverOpen
    else if (c.kind === 'choice' || c.kind === 'number' || c.kind === 'text' || c.kind === 'value') throw new BridgeError('bad_request', `"${String(p.key)}" is not something a click works; set its value instead`)
    return screen(state)
  }
  g['screen.set'] = (p) => {
    const c = find(p)
    if (c.readOnly) throw new BridgeError('denied', `the screen only shows "${String(p.key)}"; it does not take a change of it from a player`)
    if (c.key === 'outputMode:0') {
      if (!['NONE', 'ITEMS', 'FLUIDS'].includes(String(p.value))) throw new BridgeError('bad_request', '"outputMode" is one of: [NONE, ITEMS, FLUIDS]')
      state.mode = String(p.value)
    } else if (c.key === 'limit:0') state.limit = Number(p.value)
    else if (c.key === 'label:0') state.label = String(p.value)
    else if (c.key === 'fluidAutoOutput:0') state.autoOutput = p.value === true
    else throw new BridgeError('bad_request', `"${String(p.key)}" is not a value that can be set; press it, or look at what kind it is`)
    return screen(state)
  }
  return Object.assign(h, { state })
}

const CONTROLS_HEAD = "Its controls besides slots (12; the names are the screen's own, use_control works them):"

describe('界面上格子以外的控件', () => {
  it('打开一台机器的界面：开关、只是显示的、页签、流体格、选项、数字、文字、按钮都照实列出来——名字是界面自己起的原样，种类和现在的值写明，流体叫游戏里的中文名；程序拿到的数据里一个不少', async (t) => {
    const h = setup(t)
    const opened = await modelCalls(h, 'open_screen', { at: EXTRACTOR })
    assert.deepEqual(opened.content.split('\n'), [
      'Screen "Basic Fluid Extractor" is open (38 slots in all).',
      'Its slots (2):',
      '- slot 0: 2× 钢板 [gregtech:gt.metaitem.01/17305]',
      '- slot 1 (OUTPUT: products appear here, nothing can be put in): empty',
      CONTROLS_HEAD,
      'on panel "basicmachine.fluidextractor.tier.02":',
      '- fluidAutoOutput:0 [switch]: off',
      '- itemAutoOutput:0 [switch]: off',
      '- powerfail:0 [switch, display only]: off',
      '- cover_panel_west [panel]: closed',
      '- auto_sync:tank:3 [fluid slot]: 288 of 32000 mB 熔融钢 [fluid molten.steel]; gives to a fluid container on your cursor',
      '- auto_sync:tank:4 [fluid slot]: empty (holds up to 16000 mB); gives to and takes from a fluid container on your cursor',
      '- outputMode:0 [choice]: "NONE" of NONE, ITEMS, FLUIDS',
      '- limit:0 [number]: 0',
      '- label:0 [text]: ""',
      '- progress:0 [shown value, ProgressSH]: "0/24"',
      'on panel "sideSelection_fluid":',
      '- fluidAutoOutput:0 [switch]: on',
      '- reset [button]',
      'Your own inventory is empty.',
      'Nothing on your cursor.',
    ])
    // 例程里（会动手的程序）拿到的是同一份，控件一个不少
    h.llm.enqueue(reply('', [{ name: 'start_routine', input: { code: `const r = await tool('open_screen', { at: ${JSON.stringify(EXTRACTOR)} }); return r.data.controls.map((c) => [c.key, c.kind, c.value ?? c.open ?? c.amount ?? null])` } }]), reply(''))
    h.agent.handleEvent(told('看看那台机器的界面'))
    await waitFor('the routine finished', () => h.agent.status().routine?.status === 'done')
    assert.deepEqual(JSON.parse(h.agent.status().routine!.value!), [
      ['fluidAutoOutput:0', 'switch', false], ['itemAutoOutput:0', 'switch', false], ['powerfail:0', 'switch', false], ['cover_panel_west', 'panel', false],
      ['auto_sync:tank:3', 'fluid', 288], ['auto_sync:tank:4', 'fluid', 0], ['outputMode:0', 'choice', 'NONE'], ['limit:0', 'number', 0], ['label:0', 'text', ''], ['progress:0', 'value', '0/24'],
      ['fluidAutoOutput:0', 'switch', true], ['reset', 'button', null],
    ])
  })

  it('按：把“流体自动输出”按开、点开覆盖板的页签——身体收到的是按哪个控件，回来的是界面的新样子（开关变成 on；页签开了，覆盖板里那几格出现在格子里）；右键、按着 Shift 也带得到', async (t) => {
    const h = setup(t)
    await modelCalls(h, 'open_screen', { at: EXTRACTOR })
    // 重名的开关：另一个面板上也有一个 fluidAutoOutput，所以要说是哪个面板的
    const pressed = (await modelCalls(h, 'use_control', { key: 'fluidAutoOutput', panel: PANEL })).content.split('\n')
    assert.equal(pressed[6], '- fluidAutoOutput:0 [switch]: on')
    const tab = (await modelCalls(h, 'use_control', { key: 'cover_panel_west' })).content.split('\n')
    assert.deepEqual(tab.slice(0, 7), [
      'Screen "Basic Fluid Extractor" is open (47 slots in all).',
      'Its slots (11):',
      '- slot 0: 2× 钢板 [gregtech:gt.metaitem.01/17305]',
      '- slot 1 (OUTPUT: products appear here, nothing can be put in): empty',
      '- slot 2: 1× 模具（环） [gregtech:gt.metaitem.01/32322]',
      '- slots 3–10: empty (8)',
      CONTROLS_HEAD,
    ])
    assert.ok(tab.includes('- cover_panel_west [panel]: open (its slots are among the slots above)'))
    // 流体格：鼠标上拿着容器去点，右键、Shift 原样带给身体
    await modelCalls(h, 'use_control', { key: 'auto_sync:tank:3', right: true, shift: true })
    await modelCalls(h, 'use_control', { key: 'reset' })
    assert.deepEqual(h.game.callsOf('screen.press'), [
      { bot: 'Alu', key: 'fluidAutoOutput', panel: PANEL },
      { bot: 'Alu', key: 'cover_panel_west' },
      { bot: 'Alu', key: 'auto_sync:tank:3', button: 1, shift: true },
      { bot: 'Alu', key: 'reset' },
    ])
    assert.equal(h.game.callsOf('screen.set').length, 0)
  })

  it('设：选项选一个、数字、文字、开关设成真假——身体收到的值是它本来的类型（真假就是真假，数就是数）；回来的界面上是新值', async (t) => {
    const h = setup(t)
    await modelCalls(h, 'open_screen', { at: EXTRACTOR })
    const mode = (await modelCalls(h, 'use_control', { key: 'outputMode', value: 'FLUIDS' })).content
    assert.match(mode, /\n- outputMode:0 \[choice\]: "FLUIDS" of NONE, ITEMS, FLUIDS\n/)
    await modelCalls(h, 'use_control', { key: 'limit', value: 64 })
    await modelCalls(h, 'use_control', { key: 'label', value: '钢水' })
    const sw = (await modelCalls(h, 'use_control', { key: 'fluidAutoOutput:0', panel: PANEL, value: true })).content
    assert.match(sw, /\n- fluidAutoOutput:0 \[switch\]: on\n/)
    assert.match(sw, /\n- limit:0 \[number\]: 64\n- label:0 \[text\]: "钢水"\n/)
    assert.deepEqual(h.game.callsOf('screen.set'), [
      { bot: 'Alu', key: 'outputMode', value: 'FLUIDS' },
      { bot: 'Alu', key: 'limit', value: 64 },
      { bot: 'Alu', key: 'label', value: '钢水' },
      { bot: 'Alu', key: 'fluidAutoOutput:0', panel: PANEL, value: true },
    ])
    assert.equal(h.game.callsOf('screen.press').length, 0)
  })

  it('按不了、设不了的照实说：只是显示用的不收改动；没有这个名字、重名、给的不是它的选项——用的是界面的原话，并指到怎么把控件再列一遍；什么都没改', async (t) => {
    const h = setup(t)
    await modelCalls(h, 'open_screen', { at: EXTRACTOR })
    const cases: [Record<string, unknown>, string][] = [
      [{ key: 'powerfail' }, 'Not changed: the screen only shows "powerfail"; it does not take a change of it from a player. A control marked "display only" shows a state and takes no change.'],
      [{ key: 'powerfail', value: true }, 'Not changed: the screen only shows "powerfail"; it does not take a change of it from a player. A control marked "display only" shows a state and takes no change.'],
      [{ key: 'autoOutput' }, 'Not done: the screen has no control "autoOutput"; screen.look lists them. open_screen without arguments lists the controls of the open screen with their kinds and values.'],
      [{ key: 'fluidAutoOutput' }, 'Not done: more than one control is called "fluidAutoOutput": give its full key and its panel. open_screen without arguments lists the controls of the open screen with their kinds and values.'],
      [{ key: 'outputMode', value: 'BOTH' }, 'Not done: "outputMode" is one of: [NONE, ITEMS, FLUIDS]. open_screen without arguments lists the controls of the open screen with their kinds and values.'],
      [{ key: 'limit' }, 'Not done: "limit" is not something a click works; set its value instead. open_screen without arguments lists the controls of the open screen with their kinds and values.'],
      [{ key: 'limit', value: 5, right: true }, '"right" and "shift" are for pressing; with "value" the control is set, not pressed.'],
    ]
    for (const [input, expected] of cases) {
      const res = await modelCalls(h, 'use_control', input)
      assert.deepEqual([res.isError, res.content], [true, expected], JSON.stringify(input))
    }
    assert.deepEqual(h.state, { autoOutput: false, coverOpen: false, mode: 'NONE', limit: 0, label: '' })
  })

  it('编程电路设置（主人那次：process 带 leave 走开后组装机留着电路 1，想改回没有）：列成一个电路控件，现在是几号；设 0 是不要电路，身体收到的就是 0', async (t) => {
    const h = setup(t)
    let circuit = 1
    const assembler = () => ({
      open: true,
      screen: 'ModularContainer',
      slotCount: 48,
      slots: [{ slot: 0 }, { slot: 1, takesNothing: true }],
      controls: [
        { panel: 'basicmachine.assembler.tier.03', key: 'powerSwitch:0', kind: 'switch', value: true },
        { panel: 'basicmachine.assembler.tier.03', key: 'ghostCircuitIndex:0', kind: 'text', value: String(circuit), readOnly: true },
        { panel: 'basicmachine.assembler.tier.03', key: 'item_slot:ghost_circuit:0', kind: 'circuit', value: circuit, range: '0 (none) or 1-24' },
      ],
    })
    h.game.handlers['screen.open'] = assembler
    h.game.handlers['screen.set'] = (p) => {
      circuit = Number(p.value)
      return assembler()
    }
    const opened = (await modelCalls(h, 'open_screen', { at: EXTRACTOR })).content.split('\n')
    assert.ok(opened.includes('- item_slot:ghost_circuit:0 [programmed circuit]: 1; use_control with value 0 (none) or 1–24 picks one, as clicking a number in its window does'), opened.join('\n'))
    const set = (await modelCalls(h, 'use_control', { key: 'item_slot:ghost_circuit:0', value: 0 })).content.split('\n')
    assert.ok(set.includes('- item_slot:ghost_circuit:0 [programmed circuit]: none; use_control with value 0 (none) or 1–24 picks one, as clicking a number in its window does'), set.join('\n'))
    assert.deepEqual(h.game.callsOf('screen.set'), [{ bot: 'Alu', key: 'item_slot:ghost_circuit:0', value: 0 }])
  })

  it('没有界面开着就去按：告诉它先打开界面', async (t) => {
    const h = setup(t)
    h.game.handlers['screen.press'] = () => {
      throw new BridgeError('bad_request', 'no screen is open; open one first')
    }
    const res = await modelCalls(h, 'use_control', { key: 'fluidAutoOutput' })
    assert.deepEqual([res.isError, res.content], [true, 'No screen is open: open_screen opens one and lists its controls.'])
  })

  it('没有任何控件的界面（不是那种做法的界面）：只列格子，不凭空写一段；没有格子也没有控件的照实说', async (t) => {
    const h = setup(t)
    h.game.handlers['screen.open'] = () => ({ open: true, screen: 'Chest', slotCount: 63, slots: [{ slot: 0, item: PLATE }] })
    const chest = (await modelCalls(h, 'open_screen', { at: EXTRACTOR })).content
    assert.equal(/controls/i.test(chest), false)
    h.game.handlers['screen.open'] = () => ({ open: true, screen: 'Odd', slotCount: 36, slots: [] })
    assert.equal((await modelCalls(h, 'open_screen', { at: EXTRACTOR })).content.split('\n')[1], 'It has no slots of its own, and lists no other controls (a screen whose buttons are not listed cannot be pressed from here).')
  })

  it('按和设是动手的事：只有干活线有这个工具；对话线调了不执行，如实告诉它交给干活线；例程里一样能调', async (t) => {
    const h = setup(t)
    const talk = await lineCalls(h, 'talk', 'use_control', { key: 'fluidAutoOutput' })
    assert.deepEqual([talk.isError, talk.content], [true, 'Not done: "use_control" acts with the body or changes something in the game, and only the worker line does that; the talk line has no tool that does. To have it done, hand it over with tell_worker (say what you want done; the worker has use_control).'])
    assert.equal(h.game.callsOf('screen.press').length, 0)
    // 例程：打开界面、看开关是不是关着、关着就按开
    h.llm.enqueue(
      reply('', [{ name: 'start_routine', input: { code: `const s = await tool('open_screen', { at: ${JSON.stringify(EXTRACTOR)} })
const sw = s.data.controls.find((c) => c.key === 'fluidAutoOutput:0' && c.panel === '${PANEL}')
if (sw.value === false) await tool('use_control', { key: sw.key, panel: sw.panel })
const after = await tool('close_screen')
return [sw.value, after.ok]` } }]),
      reply(''),
    )
    h.agent.handleEvent(told('把提取机的流体自动输出打开'))
    await waitFor('the routine finished', () => h.agent.status().routine?.status !== 'running' && h.agent.status().routine !== undefined)
    assert.deepEqual([h.agent.status().routine!.status, h.state.autoOutput, h.game.callsOf('screen.press')], ['done', true, [{ bot: 'Alu', key: 'fluidAutoOutput:0', panel: PANEL }]])
  })
})

describe('产物是流体的加工', () => {
  it('流体提取机化钢板：任务算做成，结果里说清没有物品出来、做出来的是流体、现在在机器的罐里有多少（中文名），以及流体不会自己到别处去', async (t) => {
    const h = setup(t)
    h.llm.enqueue(reply('', [{ name: 'process_items', input: { machine: EXTRACTOR, inputs: [{ id: GT, meta: 17305, count: 2 }] } }]), reply(''))
    h.agent.handleEvent(told('把两个钢板化了'))
    await h.agent.whenIdle()
    const before = h.llm.requests.length
    h.llm.enqueue(reply(''))
    h.agent.handleEvent(
      taskEnded('t1', 'done', {
        type: 'process',
        result: {
          put: 2,
          outputs: [],
          freeSlots: 35,
          note: 'the machine ran and gave no item: what it made is a fluid, which stays in its tank (fluids shows what is there now)',
          fluids: [{ fluid: 'molten.steel', name: 'Molten Steel', amount: 288, capacity: 32000 }, { amount: 0, capacity: 16000 }],
        },
      }),
    )
    await h.agent.whenIdle()
    const woken = h.llm.lastUserText(before)
    assert.match(
      woken,
      /任务 t1（process）完成了。 结果：put 2 item\(s\) into the machine; took out: nothing; it ran, and what it made is a fluid, not an item: it is in the machine's tank, which now holds 288 of 32000 mB 熔融钢 \[fluid molten\.steel\]; empty \(holds up to 16000 mB\)\. A fluid stays where it is until the machine's own auto-output, a pipe or a fluid container moves it; freeSlots 35$/m,
    )
    // 身体那句英文说明讲的是同一件事，没有再原样贴一遍
    assert.equal(woken.includes('fluids shows what is there now'), false)
  })

  it('多方块（蒸馏塔）做出来的流体在输出仓：结果里一个仓一句，在哪、多少；例程里等这个任务拿到的数据里流体名是中文、英文留着', async (t) => {
    const h = setup(t)
    const HATCHES = [
      { x: -518, y: 70, z: 58, name: 'Output Hatch (HV)', kind: 'output hatch', capacity: 16000, fluid: 'molten.steel', fluidName: 'Molten Steel', amount: 1000 },
      { x: -518, y: 71, z: 58, name: 'Output Hatch (HV)', kind: 'output hatch', capacity: 16000 },
    ]
    h.llm.enqueue(reply('', [{ name: 'start_routine', input: { code: `const r = await tool('process_items', { machine: { x: -518, y: 69, z: 56 }, inputs: [{ id: '${GT}', meta: 17305, count: 1 }] }); return { ok: r.ok, text: r.text, fluids: r.data.result.fluids }` } }]), reply(''))
    h.agent.handleEvent(told('开一炉'))
    await waitFor('the routine started its task', () => h.game.callsOf('task.start').length === 1)
    h.agent.handleEvent(taskEnded('t1', 'done', { type: 'process', result: { put: 1, outputs: [], note: 'the machine ran and gave no item: what it made is a fluid, which stays in its output hatches (fluids shows what is there now)', fluids: HATCHES } }))
    await waitFor('the routine finished', () => h.agent.status().routine?.status === 'done')
    const got = JSON.parse(h.agent.status().routine!.value!)
    assert.equal(got.ok, true)
    assert.match(got.text, /; it ran, and what it made is a fluid, not an item: it is in the machine's output hatches, which now hold output hatch \(-518,70,58\): 1000 of 16000 mB 熔融钢 \[fluid molten\.steel\]; output hatch \(-518,71,58\): empty \(holds up to 16000 mB\)\. A fluid stays where it is /)
    assert.deepEqual(got.fluids, [{ ...HATCHES[0], fluidName: '熔融钢', fluidEn: 'Molten Steel' }, HATCHES[1]])
  })

  it('有物品出来的加工照旧：结果里不提流体', async (t) => {
    const h = setup(t)
    h.llm.enqueue(reply('', [{ name: 'process_items', input: { machine: EXTRACTOR, inputs: [{ id: GT, meta: 17305, count: 2 }] } }]), reply(''))
    h.agent.handleEvent(told('加工'))
    await h.agent.whenIdle()
    const before = h.llm.requests.length
    h.llm.enqueue(reply(''))
    h.agent.handleEvent(taskEnded('t1', 'done', { type: 'process', result: { put: 2, outputs: [{ id: GT, meta: 32322, name: 'Mold (Ring)', count: 1 }], freeSlots: 34 } }))
    await h.agent.whenIdle()
    assert.match(h.llm.lastUserText(before), /任务 t1（process）完成了。 结果：put 2 item\(s\) into the machine; took out: 1× gregtech:gt\.metaitem\.01\/32322 "模具（环）"; freeSlots 34$/m)
  })
})
