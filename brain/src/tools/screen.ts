// 通用的界面动作：打开一个方块（或身上一件东西）的界面、看里面的格子、点一格、关掉。
// 存取（deposit_items / withdraw_items）、加工（process_items）、合成（craft_item）是走某一类界面的现成办法；
// 这三个是它们底下那一层，给没有现成办法的界面用：没见过的机器、要点按钮才开工的机器、别的 mod 的工作台。
// 身体不认界面是哪个 mod 的，点了会怎样由界面自己决定。只在没有任务在跑时可用。

import { BridgeError } from '../bridge/protocol.ts'
import type { Item, ScreenSlot, ScreenState } from '../bridge/protocol.ts'
import { itemKey, nameOf } from './format.ts'
import { bool, int, obj, str } from './schema.ts'
import { pos } from './tasks.ts'
import { fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const SLOTS_SHOWN = 80

function stack(item: Item): string {
  const name = nameOf(item)
  return `${item.count ?? 1}× ${name ? `${name} ` : ''}[${itemKey({ id: item.id, meta: item.meta ?? 0 })}]`
}

/** 相邻的空格并成一段（“slots 3–8: empty”），有东西的一格一行。 */
function slotLines(slots: readonly ScreenSlot[], note: (s: ScreenSlot) => string): string[] {
  const lines: string[] = []
  let empty: number[] = []
  const flush = (): void => {
    if (empty.length === 0) return
    lines.push(empty.length === 1 ? `- slot ${empty[0]}: empty` : `- slots ${empty[0]}–${empty.at(-1)}: empty (${empty.length})`)
    empty = []
  }
  for (const s of slots) {
    const tag = note(s)
    if (!s.item && !tag) {
      // 连着的编号才并
      if (empty.length > 0 && s.slot !== empty.at(-1)! + 1) flush()
      empty.push(s.slot)
      continue
    }
    flush()
    lines.push(`- slot ${s.slot}${tag}: ${s.item ? stack(s.item) : 'empty'}`)
  }
  flush()
  return lines
}

/** 界面现在的样子：它自己的格子（原料格、产物格、只显示的）和你背包里的格子分开列，物品用中文名。 */
export function formatScreen(state: ScreenState): string {
  if (state.open !== true) {
    return 'No screen is open right now. A screen can take a moment to appear after opening: look again with open_screen without arguments; if it stays closed, that block (or item) opens no screen.'
  }
  const slots = [...(state.slots ?? [])].sort((a, b) => a.slot - b.slot)
  const theirs = slots.filter((s) => s.own !== true)
  const mine = slots.filter((s) => s.own === true)
  const lines: string[] = [`Screen "${state.screen ?? 'unknown'}" is open${typeof state.slotCount === 'number' ? ` (${state.slotCount} slots in all)` : ''}.`]
  const tag = (s: ScreenSlot): string => (s.ghost === true ? ' (display only: nothing real in it, e.g. a programmed-circuit setting)' : s.takesNothing === true ? ' (OUTPUT: products appear here, nothing can be put in)' : '')
  if (theirs.length === 0) lines.push('It has no slots of its own (it may work with buttons only, which you cannot press).')
  else {
    lines.push(`Its slots (${theirs.length}):`)
    lines.push(...slotLines(theirs.slice(0, SLOTS_SHOWN), tag))
    if (theirs.length > SLOTS_SHOWN) lines.push(`- … and ${theirs.length - SLOTS_SHOWN} more slots not shown`)
  }
  lines.push(mine.length > 0 ? `Your own inventory (only the slots holding something):` : 'Your own inventory is empty.')
  lines.push(...mine.map((s) => `- slot ${s.slot}: ${s.item ? stack(s.item) : 'empty'}`))
  lines.push(state.cursor ? `On your cursor (picked up, not put down yet): ${stack(state.cursor)}. Clicking a slot puts it down; closing the screen sends it back to your inventory.` : 'Nothing on your cursor.')
  return lines.join('\n')
}

/** 身体对界面动作的拒绝，说成模型知道下一步该干什么的话。 */
function refusal(e: unknown): ToolResult | undefined {
  if (!(e instanceof BridgeError)) return undefined
  if (e.code === 'busy') return fail('A task of yours is still running: screens can only be used while you have no task. Wait for it to end (or cancel_task), then try again.')
  if (e.code === 'out_of_reach') return fail(`That block is out of reach (${e.message}). Walk next to it first (go_to), then open it.`)
  if (e.code === 'no_material') return fail('You do not carry that item, so its screen cannot be opened.')
  return undefined
}

async function act(run: () => Promise<ScreenState>): Promise<ToolResult | string> {
  try {
    const state = await run()
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
    'Open the screen of a block next to you (any block with a screen, of any mod: a machine you have not seen before, a furnace, a workbench) or of an item you carry, and see its slots. Without arguments: the screen you already have open, as it is now. For screens the ready-made tools do not cover: try deposit_items / withdraw_items / process_items first. Only while you have no task running; walk there first. Details: screens manual.',
  inputSchema: obj({
    at: pos('The block to open (you must stand within reach of it).'),
    item: obj({ id: str('Item id.'), meta: int('Item meta. Omit to match any.', { min: 0 }) }, ['id'], 'Instead of "at": an item you carry whose screen to open (a bag, a portable tool).'),
  }),
  async run(ctx: ToolContext, i: { at?: { x: number; y: number; z: number }; item?: { id: string; meta?: number } }) {
    if (i.at !== undefined && i.item !== undefined) return fail('Give "at" (a block) or "item" (something you carry), not both; neither to look at the screen that is already open.')
    // 什么都不给：看一眼已经开着的界面（界面点开后过一小会儿才出现的、机器做了一会儿之后）
    if (i.at === undefined && i.item === undefined) return act(() => ctx.bridge.screenLook(ctx.botName))
    return act(() => ctx.bridge.screenOpen(ctx.botName, i.at ?? { item: i.item!.meta === undefined ? { id: i.item!.id } : { id: i.item!.id, meta: i.item!.meta } }))
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

export const closeScreen: Tool = {
  name: 'close_screen',
  description: 'Close the screen you have open. Whatever is still on your cursor goes back to your inventory. Always close a screen when you are done with it.',
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
