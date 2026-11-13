// 通用的界面动作：打开一个方块（或身上一件东西）的界面、看里面的格子、点一格、按或设界面上格子以外的东西、关掉。
// 存取（deposit_items / withdraw_items）、加工（process_items）、合成（craft_item）是走某一类界面的现成办法；
// 这几个是它们底下那一层，给没有现成办法的界面用：没见过的机器、要点按钮才开工的机器、别的 mod 的工作台，
// 以及机器的设置（自动输出的开关、覆盖板的页签……）。
// 身体不认界面是哪个 mod 的，点了会怎样由界面自己决定：控件的名字是界面自己起的，这里原样给模型，不替它解释。只在没有任务在跑时可用。

import { BridgeError } from '../bridge/protocol.ts'
import type { ClientOnlyScreen, Item, ScreenControl, ScreenSlot, ScreenState } from '../bridge/protocol.ts'
import { compactJson, fluidName, itemKey, nameOf, tankText, wornText } from './format.ts'
import { bool, int, num, obj, pos, str } from './schema.ts'
import { USE_SIDES } from './tasks.ts'
import { fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const SLOTS_SHOWN = 80
/** 文字里最多列这么多个控件（data 里是全的；身体自己最多给 200 个）。 */
const CONTROLS_SHOWN = 80

/** 一个控件现在的样子：种类、当前值，只是显示用的标明。名字是界面自己起的，原样给。 */
function controlLine(c: ScreenControl): string {
  const shown = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : compactJson(v, 120))
  const fixed = c.readOnly === true ? ', display only' : ''
  switch (c.kind) {
    case 'switch':
      return `- ${c.key} [switch${fixed}]: ${c.value === true ? 'on' : c.value === false ? 'off' : shown(c.value)}`
    case 'panel':
      return `- ${c.key} [panel]: ${c.open === true ? 'open (its slots are among the slots above)' : 'closed'}`
    case 'fluid': {
      const holds = c.fluid !== undefined && (c.amount ?? 0) > 0 ? `${c.amount}${typeof c.capacity === 'number' ? ` of ${c.capacity}` : ''} mB ${fluidName(c.fluid, c.name)} [fluid ${c.fluid}]` : `empty${typeof c.capacity === 'number' ? ` (holds up to ${c.capacity} mB)` : ''}`
      // 拿着容器点它时：能不能从里面取、能不能往里倒
      const ways = [c.drains === true ? 'gives to' : '', c.fills === true ? 'takes from' : ''].filter(Boolean)
      const hand = c.phantom === true ? 'a setting, holds no real fluid' : ways.length > 0 ? `${ways.join(' and ')} a fluid container on your cursor` : 'not worked with a container'
      return `- ${c.key} [fluid slot]: ${holds}; ${hand}${c.cursorFillableMb !== undefined ? `; one cursor container can accept ${c.cursorFillableMb} mB of this fluid now (native simulation)` : ''}`
    }
    case 'choice':
      return `- ${c.key} [choice${fixed}]: ${shown(c.value)}${c.options && c.options.length > 0 ? ` of ${c.options.join(', ')}` : ''}`
    case 'number':
    case 'text':
      return `- ${c.key} [${c.kind}${fixed}]: ${shown(c.value)}`
    case 'button':
      return `- ${c.key} [button]${c.label ? `: "${c.label}"` : ''}`
    case 'circuit':
      return `- ${c.key} [programmed circuit]: ${c.value === 0 ? 'none' : shown(c.value)}; use_control with value 0 (none) or 1–24 picks one, as clicking a number in its window does`
    case 'value':
      return `- ${c.key} [shown value${c.type ? `, ${c.type}` : ''}]: ${shown(c.value)}`
    default:
      return `- ${c.key} [${c.kind}${c.type ? `, ${c.type}` : ''}${c.unreadable === true ? ', unreadable' : ''}]`
  }
}

/** 界面上格子以外的东西，按它们所在的面板分开列。 */
function controlLines(controls: readonly ScreenControl[]): string[] {
  const lines: string[] = [`Its controls besides slots (${controls.length}; the names are the screen's own, use_control works them):`]
  let panel: string | undefined
  for (const c of controls.slice(0, CONTROLS_SHOWN)) {
    if (c.panel !== panel) {
      panel = c.panel
      if (panel !== undefined) lines.push(`on panel "${panel}":`)
    }
    lines.push(controlLine(c))
  }
  if (controls.length > CONTROLS_SHOWN) lines.push(`- … and ${controls.length - CONTROLS_SHOWN} more controls not shown`)
  return lines
}
/**
 * 打开以后界面常常晚一拍才出现（用物品打开的界面尤其是）：没出现就隔一会儿再看一眼，最多看这么多次。
 * 这样一次 open_screen 就把界面带回来，不用模型为“再看一次”多调一回。
 */
export const SCREEN_SETTLE_TRIES = 8
export const SCREEN_SETTLE_MS = 200

function stack(item: Item): string {
  const name = nameOf(item)
  return `${item.count ?? 1}× ${name ? `${name} ` : ''}[${itemKey({ id: item.id, meta: item.meta ?? 0 })}]${item.fluidContainer ? ` {container: ${tankText(item.fluidContainer)}}` : ''}`
}

/** 相邻的空格并成一段（“slots 3–8: empty”），有东西的一格一行。 */
function slotLines(slots: readonly ScreenSlot[], note: (s: ScreenSlot) => string): string[] {
  const lines: string[] = []
  // 连着的、同一种（说明一样）的空格并成一行
  let empty: number[] = []
  let emptyTag = ''
  const flush = (): void => {
    if (empty.length === 0) return
    lines.push(empty.length === 1 ? `- slot ${empty[0]}${emptyTag}: empty` : `- slots ${empty[0]}–${empty.at(-1)}${emptyTag}: empty (${empty.length})`)
    empty = []
  }
  for (const s of slots) {
    const tag = note(s)
    if (!s.item && !(tag && s.takesNothing === true && s.role === undefined)) {
      if (empty.length > 0 && (s.slot !== empty.at(-1)! + 1 || tag !== emptyTag)) flush()
      emptyTag = tag
      empty.push(s.slot)
      continue
    }
    flush()
    lines.push(`- slot ${s.slot}${tag}: ${s.item ? stack(s.item) : 'empty'}`)
  }
  flush()
  return lines
}

/** GregTech 机器的格子是干什么的（身体按它在机器里的位置认的）。 */
const ROLE_TAGS: Record<string, string> = {
  input: ' (INPUT)',
  output: ' (OUTPUT: products appear here)',
  special: ' (SPECIAL: the one extra item some recipes read, such as a mold or a data stick; not an input slot)',
  battery: ' (BATTERY: a battery that powers the machine or that it charges; not an input slot)',
  circuit: ' (the programmed-circuit setting)',
}

/** 格子按用途数一遍：几个原料格、几个产物格……（编号连着的写成一段）。 */
function roleSummary(slots: readonly ScreenSlot[], circuitControl: boolean): string | undefined {
  const by = new Map<string, number[]>()
  for (const s of slots) if (s.role) by.set(s.role, [...(by.get(s.role) ?? []), s.slot])
  if (by.size === 0) return undefined
  const span = (n: number[]): string => (n.length === 1 ? `slot ${n[0]}` : n.at(-1)! - n[0]! === n.length - 1 ? `slots ${n[0]}–${n.at(-1)}` : `slots ${n.join(', ')}`)
  const order = ['input', 'output', 'special', 'battery', 'circuit']
  const parts = [...by.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([role, n]) => `${n.length} ${role} (${span(n)})`)
  return `Of these, by what the machine uses them for: ${parts.join(', ')}.${circuitControl && !by.has('circuit') ? ' The programmed circuit is not one of them: it is a setting of its own (the [programmed circuit] control below), so it takes no input slot.' : ''}`
}

/** 一件东西的名字和 id（格子收什么的那几句）。 */
function kindName(t: { id: string; meta?: number; name?: string }): string {
  return `${nameOf(t) ?? t.id} [${itemKey(t)}]`
}

/**
 * 界面把它自己的格子画在哪：按行（y）从上到下，每行从左到右，编号连着、隔 18 像素挨着的并成一段。
 * 玩家靠位置认格子：部件加工台一行里是模具格、材料格、两个产物格，放不对行就什么都不出。
 * 自己摆格子的界面（GregTech 的）没有位置，不写。
 */
function layoutLine(slots: readonly ScreenSlot[]): string | undefined {
  const placed = slots.filter((s): s is ScreenSlot & { x: number; y: number } => typeof s.x === 'number' && typeof s.y === 'number')
  if (placed.length < 2) return undefined
  const rows = new Map<number, (ScreenSlot & { x: number; y: number })[]>()
  for (const s of placed) rows.set(s.y, [...(rows.get(s.y) ?? []), s])
  const parts = [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, row]) => {
      row.sort((a, b) => a.x - b.x)
      const runs: string[] = []
      for (let i = 0; i < row.length; ) {
        let j = i
        while (j + 1 < row.length && row[j + 1]!.slot === row[j]!.slot + 1 && row[j + 1]!.x - row[j]!.x === 18) j++
        runs.push(j > i ? `${row[i]!.slot}–${row[j]!.slot} (x ${row[i]!.x}–${row[j]!.x})` : `${row[i]!.slot} (x ${row[i]!.x})`)
        i = j + 1
      }
      return `y ${y}: ${runs.join(', ')}`
    })
  return `Where the screen draws them (pixels from its top left; rows top to bottom, each left to right, slot numbers): ${parts.join('; ')}`
}

/** 界面现在的样子：它自己的格子（原料格、产物格、只显示的）和你背包里的格子分开列，物品用中文名。 */
export function formatScreen(state: ScreenState): string {
  if (state.open !== true) return 'No screen is open right now.'
  const slots = [...(state.slots ?? [])].sort((a, b) => a.slot - b.slot)
  const theirs = slots.filter((s) => s.own !== true)
  const mine = slots.filter((s) => s.own === true)
  const lines: string[] = [`Screen "${state.screen ?? 'unknown'}" is open${typeof state.slotCount === 'number' ? ` (${state.slotCount} slots in all)` : ''}.`]
  // 格子在代码里的种类（类名）原样写在前面：它常常就说了这格是干什么的（SlotPattern、SlotOnlyTake）
  const tag = (s: ScreenSlot): string =>
    (s.class !== undefined ? ` [${s.class}]` : '') +
    (s.role !== undefined && ROLE_TAGS[s.role] !== undefined
      ? ROLE_TAGS[s.role]!
      : s.ghost === true
        ? ' (display only: nothing real in it, e.g. a programmed-circuit setting)'
        : s.takesNothing === true
          ? ' (OUTPUT: products appear here, nothing can be put in)'
          : s.takes !== undefined
            ? ` (takes only some things; of what you carry: ${s.takes.length > 0 ? s.takes.map(kindName).join(', ') : 'none'}${(s.accepts ?? []).length > 0 ? `; it takes e.g. ${s.accepts!.map(kindName).join(', ')}` : ''})`
            : '')
  const controls = state.controls ?? []
  if (theirs.length === 0) lines.push(controls.length > 0 ? 'It has no slots of its own.' : 'It has no slots of its own, and lists no other controls (a screen whose buttons are not listed cannot be pressed from here).')
  else {
    lines.push(`Its slots (${theirs.length}):`)
    const roles = roleSummary(theirs, controls.some((c) => c.kind === 'circuit'))
    if (roles) lines.push(roles)
    lines.push(...slotLines(theirs.slice(0, SLOTS_SHOWN), tag))
    if (theirs.length > SLOTS_SHOWN) lines.push(`- … and ${theirs.length - SLOTS_SHOWN} more slots not shown`)
    const layout = layoutLine(theirs.slice(0, SLOTS_SHOWN))
    if (layout) lines.push(layout)
  }
  if (controls.length > 0) lines.push(...controlLines(controls))
  lines.push(mine.length > 0 ? `Your own inventory (only the slots holding something):` : 'Your own inventory is empty.')
  lines.push(...mine.map((s) => `- slot ${s.slot}: ${s.item ? stack(s.item) : 'empty'}`))
  lines.push(state.cursor ? `On your cursor (picked up, not put down yet): ${stack(state.cursor)}. Clicking a slot puts it down; closing the screen sends it back to your inventory.` : 'Nothing on your cursor.')
  return lines.join('\n')
}

/**
 * 只在 mod 的客户端里画的界面（任务书）：服务器上没有，打不开。说清楚它是什么，它的按钮做的事用哪个工具做。
 * 身体给的是协议方法名（quest.submit……），这里换成做这些事的工具。
 */
export function clientOnlyText(c: ClientOnlyScreen): string {
  const methods = c.instead ?? []
  const tools = methods.some((m) => m.startsWith('quest.'))
    ? 'quest_book does what its buttons do (submit: Detect/Submit, tick: a checkbox, claim: Claim, with "choice" for a reward to pick); get_quest and find_quests show what is in it and your progress (give your own name as "player")'
    : methods.length > 0
      ? `what its buttons do is done by the body's ${methods.join(', ')}`
      : 'nothing else does what its buttons do'
  return `No screen opened, and none will: ${c.screen} is a screen drawn only by the game client, and the game server has no such screen to open. Instead, ${tools}.`
}

/** 身体对界面动作的拒绝，说成模型知道下一步该干什么的话。 */
function refusal(e: unknown): ToolResult | undefined {
  if (!(e instanceof BridgeError)) return undefined
  if (e.code === 'busy') return fail('A task of yours is still running: screens can only be used while you have no task. Wait for it to end (or cancel_task), then try again.')
  if (e.code === 'out_of_reach') return fail(`That block is out of reach (${e.message}). Walk next to it first (go_to), then open it.`)
  if (e.code === 'no_material') return fail('You do not carry that item, so its screen cannot be opened.')
  return undefined
}

/** 身体对“按、设一个控件”的拒绝：它的原话已经说清是哪一样（没有这个控件、重名、只是显示、不是能设的值），补上怎么再看一眼。 */
function controlRefusal(e: unknown): ToolResult | undefined {
  if (!(e instanceof BridgeError)) return undefined
  if (e.code === 'denied') return fail(`Not changed: ${e.message}. A control marked "display only" shows a state and takes no change.`)
  // 根本没有界面开着：先 open_screen
  if (/no screen is open/i.test(e.message)) return fail('No screen is open: open_screen opens one and lists its controls.')
  if (e.code === 'bad_request' || e.code === 'invalid') return fail(`Not done: ${e.message}. open_screen without arguments lists the controls of the open screen with their kinds and values.`)
  return undefined
}

async function act(run: () => Promise<ScreenState>, opened?: { look(): Promise<ScreenState>; wait?: number }): Promise<ToolResult | string> {
  try {
    let state = await run()
    if (opened) {
      // 刚发出“打开”：界面还没出现就等一等再看，出现了就是它
      const pause = opened.wait ?? SCREEN_SETTLE_MS
      for (let n = 0; n < SCREEN_SETTLE_TRIES && state.open !== true && !state.clientOnly; n++) {
        await new Promise((resolve) => setTimeout(resolve, pause))
        state = await opened.look()
      }
      if (state.open !== true) {
        if (state.clientOnly) return { content: clientOnlyText(state.clientOnly), data: state }
        return { content: `No screen opened: after asking for it, it was looked for ${SCREEN_SETTLE_TRIES} more times over ${(SCREEN_SETTLE_TRIES * pause) / 1000} s and none appeared. That block (or item) opens no screen this way.`, data: state }
      }
    }
    return { content: formatScreen(state), data: state, keepWhole: true }
  } catch (e) {
    const told = refusal(e)
    if (told) return told
    throw e
  }
}

export const openScreen: Tool = {
  name: 'open_screen',
  description:
    'Open the screen of a block within your reach (any block with a screen, of any mod) or of an item you carry, and see its slots and its other controls. Which face is clicked, and whether sneaking, can change which screen opens (a cover on a machine\'s face has its own). Without arguments: the screen you already have open, as it is now. Works only while you have no task running, and does not walk. Details: screens manual.',
  inputSchema: obj({
    at: pos('The block to open.'),
    item: obj({ id: str(), meta: int(undefined, { min: 0 }) }, ['id'], 'Instead of "at": an item you carry whose screen to open, as {id, meta?}.'),
    side: str('With "at": the face to click; you must already stand in front of it.', { enum: USE_SIDES }),
    hit: obj({ x: num(undefined, { min: 0, max: 1 }), y: num(undefined, { min: 0, max: 1 }), z: num(undefined, { min: 0, max: 1 }) }, ['x', 'y', 'z'], 'With "at": the point to click, each 0 to 1 from the block\'s lowest corner.'),
    sneak: bool('With "at": click while sneaking.'),
  }),
  async run(ctx: ToolContext, i: { at?: { x: number; y: number; z: number }; item?: { id: string; meta?: number }; side?: string; hit?: { x: number; y: number; z: number }; sneak?: boolean }) {
    if (i.at !== undefined && i.item !== undefined) return fail('Give "at" (a block) or "item" (something you carry), not both; neither to look at the screen that is already open.')
    // 什么都不给：看一眼已经开着的界面（界面点开后过一小会儿才出现的、机器做了一会儿之后）
    const how = { ...(i.side !== undefined ? { side: i.side } : {}), ...(i.hit !== undefined ? { hit: i.hit } : {}), ...(i.sneak === true ? { sneak: true } : {}) }
    if (i.at === undefined && Object.keys(how).length > 0) return fail('"side", "hit" and "sneak" say how to click a block: give the block as "at".')
    if (i.at === undefined && i.item === undefined) return act(() => ctx.bridge.screenLook(ctx.botName))
    const target = i.at ? { ...i.at, ...how } : { item: i.item!.meta === undefined ? { id: i.item!.id } : { id: i.item!.id, meta: i.item!.meta } }
    return act(() => ctx.bridge.screenOpen(ctx.botName, target), { look: () => ctx.bridge.screenLook(ctx.botName) })
  },
}

export const clickSlot: Tool = {
  name: 'click_slot',
  description:
    'Click one slot of the open screen, exactly as a player would, and see the screen afterwards. Shift-click one of your own slots: the stack goes where the screen wants it (a machine\'s input, a furnace\'s fuel slot). Shift-click one of its slots: the stack comes to your inventory. Plain left click picks up or puts down a whole stack, right click half a stack or a single item.',
  inputSchema: obj(
    {
      slot: int('The slot number, as open_screen lists it.', { min: 0 }),
      right: bool('true: right click (pick up half, or put down one). Default: left click.'),
      shift: bool('true: hold Shift (move the whole stack to the other side).'),
    },
    ['slot'],
  ),
  run: (ctx: ToolContext, i: { slot: number; right?: boolean; shift?: boolean }) =>
    act(() => ctx.bridge.screenClick(ctx.botName, { slot: i.slot, ...(i.right === true ? { button: 1 } : {}), ...(i.shift === true ? { shift: true } : {}) })),
}

export const useControl: Tool = {
  name: 'use_control',
  description:
    'Work a control of the open screen that is not a slot, by the name open_screen lists it under (the screen\'s own). Without "value" it is pressed, as a player\'s click does: a switch flips, a panel opens or closes, a button acts, a fluid slot fills or empties the fluid container on your cursor. With "value" it is set: a switch (true/false), a number, a text, a choice. This changes the machine\'s settings, and they stay. Shows the screen afterwards.',
  inputSchema: obj(
    {
      key: str('Its name as listed; the part before ":" alone works when unique.', { maxLength: 200 }),
      panel: str('Its panel, when two controls share a name.', { maxLength: 200 }),
      value: str('Set it to this instead of pressing.', { maxLength: 200 }),
      right: bool('Press with a right click.'),
      shift: bool('Press holding Shift.'),
    },
    ['key'],
  ),
  async run(ctx: ToolContext, i: { key: string; panel?: string; value?: string; right?: boolean; shift?: boolean }) {
    const which = { key: i.key.trim(), ...(i.panel !== undefined && i.panel.trim().length > 0 ? { panel: i.panel.trim() } : {}) }
    try {
      if (i.value !== undefined) {
        if (i.right === true || i.shift === true) return fail('"right" and "shift" are for pressing; with "value" the control is set, not pressed.')
        // 参数校验把 true、5 这样的值都收成了字符串：照它本来的样子交给身体（开关要真假，数字要数，文字和选项要字）
        const text = i.value
        const value = text === 'true' ? true : text === 'false' ? false : /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text
        return await act(() => ctx.bridge.screenSet(ctx.botName, { ...which, value }))
      }
      const pressed = await act(() => ctx.bridge.screenPress(ctx.botName, { ...which, ...(i.right === true ? { button: 1 } : {}), ...(i.shift === true ? { shift: true } : {}) }))
      return typeof pressed !== 'string' && pressed.isError !== true && (pressed.data as ScreenState | undefined)?.open !== true ? closedBy(ctx, pressed) : pressed
    } catch (e) {
      const told = controlRefusal(e)
      if (told) return told
      throw e
    }
  },
}

/** 有的按钮一按就关上界面（把拿着的背包穿到背上、从背上卸下来）。等那个 mod 做完（卸背包它自己要等 0.2 秒），说身上现在穿着什么。 */
export const AFTER_CLOSE_MS = 500

async function closedBy(ctx: ToolContext, pressed: ToolResult): Promise<ToolResult> {
  await new Promise((resolve) => setTimeout(resolve, AFTER_CLOSE_MS))
  const status = await ctx.bridge.botStatus(ctx.botName)
  const worn = (status.worn ?? []).map((w) => `- ${wornText(w)}`)
  return {
    ...pressed,
    content: [`Pressed; the screen closed with it. What you wear outside the armor slots now:`, ...(worn.length > 0 ? worn : ['- nothing']), `Your inventory has ${status.freeSlots ?? '?'} free slots (get_status lists it).`].join('\n'),
  }
}

export const closeScreen: Tool = {
  name: 'close_screen',
  description: 'Close the screen you have open. Whatever is still on your cursor goes back to your inventory (dropped at your feet if it does not fit). A screen stays open until it is closed.',
  inputSchema: obj({}),
  async run(ctx: ToolContext) {
    try {
      await ctx.bridge.screenClose(ctx.botName)
      return 'The screen is closed.'
    } catch (e) {
      const told = refusal(e)
      if (told) return told
      throw e
    }
  },
}
