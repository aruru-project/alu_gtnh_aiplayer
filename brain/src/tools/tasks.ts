// 启动任务的工具。任务是异步的：这里只负责启动，结果以后通过事件回来。

import type { TaskSpec } from '../bridge/protocol.ts'
import { COMMANDS, COMMAND_REPLY_WAIT_MS, HOME_NAME_RE, PLAYER_NAME_RE, TEAM_ID_RE } from './commands.ts'
import { formatPos, formatTask } from './format.ts'
import { botBlock } from './observe.ts'
import { arr, bool, int, obj, str } from './schema.ts'
import type { Schema } from './schema.ts'
import { fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

// 协议里的上限
export const BLOCK_LIST_MAX = 256
export const BOX_MAX_VOLUME = 32768
export const FLATTEN_MAX_SIDE = 64

export const queue = bool('true: add it to the end of your task queue. Default: start it now, replacing what you are doing.')

export const pos = (description: string): Schema => obj({ x: int('x'), y: int('y'), z: int('z') }, ['x', 'y', 'z'], description)

const itemFilter = obj(
  {
    id: str('Item id, e.g. "minecraft:cobblestone".'),
    meta: int('Item meta/damage value. Omit to match any.', { min: 0 }),
    count: int('How many. Omit for all of them.', { min: 1 }),
  },
  ['id'],
)

/** supply / dropoff：容器坐标的列表。箱子这类有界面的储物方块和抽屉（Storage Drawers）都行。 */
export const containerList = (description: string): Schema =>
  arr(description, pos('A chest or drawers.'), { min: 1, max: 8 })

export const overflow = str('When your inventory is full and there is no dropoff: "fail" (default) stops with inventory_full; "leave" keeps digging and leaves the drops on the ground.', { enum: ['fail', 'leave'] })

/**
 * 以 bot 身份执行一条指令并拿到服务器的回显。
 * 回显通常在 output 里；当下什么都没有时，再等一小会儿看有没有晚到的系统消息。
 */
async function runCommand(ctx: ToolContext, command: string): Promise<string[]> {
  const since = ctx.now()
  ctx.hooks.commandStart?.()
  try {
    const res = await ctx.bridge.botCommand(ctx.botName, command)
    const output = res.output ?? []
    if (output.length > 0 || !ctx.laterMessages) return output
    return await ctx.laterMessages(since, COMMAND_REPLY_WAIT_MS)
  } finally {
    ctx.hooks.commandEnd?.()
  }
}

function withoutUndefined(task: Record<string, unknown>): TaskSpec {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(task)) if (v !== undefined) out[k] = v
  return out as TaskSpec
}

/** 启动或排队一个任务，并把结果说成模型下一步该怎么做。 */
export async function startTask(
  ctx: ToolContext,
  task: Record<string, unknown>,
  queued: boolean | undefined,
): Promise<ToolResult | string> {
  const mode = queued ? 'append' : 'replace'
  let replaced: readonly string[] = []
  let res: Awaited<ReturnType<ToolContext['bridge']['taskStart']>>
  if (mode === 'replace') ctx.hooks.cancelStart?.()
  try {
    res = await ctx.bridge.taskStart(ctx.botName, withoutUndefined(task), mode)
    replaced = res.replaced ?? []
  } finally {
    if (mode === 'replace') ctx.hooks.cancelEnd?.(replaced)
  }
  const t = res.task
  if (!t || typeof t.id !== 'string') return fail('the game accepted the request but returned no task info; check task_status')
  if (t.state === 'failed') return fail(`Task could not start: ${formatTask(t)}`)
  ctx.hooks.taskStarted?.(t)
  if (t.state === 'done') return `Task ${t.id} (${t.type}) finished immediately: ${formatTask(t)}`
  // 身体在响应里总是报 queued，哪怕它马上就开始；所以按“怎么启动的”来说，不按响应里的状态说。
  if (mode === 'append') {
    return `Task ${t.id} (${t.type}) added to the end of your queue. It runs after the tasks before it (right away if there are none). You will be woken each time a task ends.`
  }
  const dropped = replaced.length > 0 ? ` It replaced ${replaced.length} earlier task(s): ${replaced.join(', ')}.` : ''
  return `Task ${t.id} (${t.type}) started.${dropped} It runs in the game on its own. End your turn now; you will be woken with the outcome when it ends.`
}

function boxVolume(b: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }): number {
  return (Math.abs(b.x2 - b.x1) + 1) * (Math.abs(b.y2 - b.y1) + 1) * (Math.abs(b.z2 - b.z1) + 1)
}

const boxProps = {
  x1: int('x of one corner'),
  y1: int('y of one corner', { min: 0, max: 255 }),
  z1: int('z of one corner'),
  x2: int('x of the opposite corner'),
  y2: int('y of the opposite corner', { min: 0, max: 255 }),
  z2: int('z of the opposite corner'),
}
const boxRequired = ['x1', 'y1', 'z1', 'x2', 'y2', 'z2']

// ── 移动 ──

export const goTo: Tool = {
  name: 'go_to',
  description:
    'Walk to a position (task). Give only x and z for the ground at that spot; give y too when the height matters. You walk at most about 256 blocks: for anything farther, go_home near it first.',
  inputSchema: obj(
    {
      x: int('x'),
      y: int('y. Omit to use the ground level at x, z.', { min: 0, max: 255 }),
      z: int('z'),
      range: int('Stop when within this many blocks horizontally (default 1).', { min: 0, max: 32 }),
      queue,
    },
    ['x', 'z'],
  ),
  run: (ctx, i: { x: number; y?: number; z: number; range?: number; queue?: boolean }) =>
    startTask(ctx, { type: 'goto', x: i.x, y: i.y, z: i.z, range: i.range }, i.queue),
}

export const goToPlayer: Tool = {
  name: 'go_to_player',
  description: 'Walk to a player and stop next to them (task). Fails with "stuck" if you cannot catch up within 5 minutes.',
  inputSchema: obj(
    { player: str('Player name.'), range: int('Stop when within this many blocks (default 2).', { min: 1, max: 32 }), queue },
    ['player'],
  ),
  async run(ctx, i: { player: string; range?: number; queue?: boolean }) {
    if (!PLAYER_NAME_RE.test(i.player)) return fail(`"${i.player}" is not a valid player name`)
    return startTask(ctx, { type: 'goto_player', player: i.player, range: i.range }, i.queue)
  },
}

export const followPlayer: Tool = {
  name: 'follow_player',
  description: 'Keep following a player until you cancel it or start another task (task that never ends by itself).',
  inputSchema: obj(
    { player: str('Player name.'), distance: int('Distance to keep (default 3).', { min: 1, max: 32 }), queue },
    ['player'],
  ),
  async run(ctx, i: { player: string; distance?: number; queue?: boolean }) {
    if (!PLAYER_NAME_RE.test(i.player)) return fail(`"${i.player}" is not a valid player name`)
    return startTask(ctx, { type: 'follow', player: i.player, distance: i.distance }, i.queue)
  },
}

export const goHome: Tool = {
  name: 'go_home',
  description:
    'Teleport to one of your homes with /home (task). The fastest way to travel far. Homes are set with set_home. Fails with "invalid" if there is no home of that name.',
  inputSchema: obj({ name: str('Home name.'), queue }, ['name']),
  async run(ctx, i: { name: string; queue?: boolean }) {
    if (!HOME_NAME_RE.test(i.name)) return fail('home names may only contain letters, digits, _ and -')
    return startTask(ctx, { type: 'home', name: i.name }, i.queue)
  },
}

export const setHome: Tool = {
  name: 'set_home',
  description:
    'Save your current position as a home (/sethome) so you can teleport back with go_home. Give a note saying what the place is; it is stored in your memory as "home:<name>".',
  inputSchema: obj(
    {
      name: str('Home name: letters, digits, _ and - only.', { maxLength: 32 }),
      note: str('What this place is, e.g. "main storage room".', { maxLength: 200 }),
    },
    ['name'],
  ),
  async run(ctx, i: { name: string; note?: string }) {
    if (!HOME_NAME_RE.test(i.name)) return fail('home names may only contain letters, digits, _ and -')
    const me = await botBlock(ctx)
    const output = (await runCommand(ctx, COMMANDS.setHome(i.name))).join(' | ')
    let remembered = ''
    try {
      ctx.memory.set(`home:${i.name}`, `${formatPos(me)} dim ${me.dim ?? '?'}${i.note ? ` — ${i.note}` : ''}`)
      remembered = ` Recorded in memory as "home:${i.name}".`
    } catch (e) {
      remembered = ` Could not record it in memory: ${e instanceof Error ? e.message : String(e)}.`
    }
    // 指令成没成只有服务器的回显知道，原样给模型判断
    return `Ran /sethome ${i.name} at ${formatPos(me)}. Server replied: ${output || '(nothing yet; a late reply would show up as a system message)'}.${remembered}`
  },
}

export const joinTeam: Tool = {
  name: 'join_team',
  description:
    'Join a ServerUtilities team that has invited you (/team join). Being on your owner\'s team is what lets you dig, build and open chests inside their protected claim. The team owner must invite you first with "/team status <your name> invited".',
  inputSchema: obj({ team: str('Team id, as the owner tells you.', { maxLength: 35 }) }, ['team']),
  async run(ctx, i: { team: string }) {
    if (!TEAM_ID_RE.test(i.team)) return fail('team ids may only contain letters, digits, _ and -')
    const output = (await runCommand(ctx, COMMANDS.joinTeam(i.team))).join(' | ')
    // 成没成只有服务器的回显知道。实测：队伍不存在时回 Team '名字' not found!
    if (/not found|not invited|can(?:'|no)t|denied|permission/i.test(output)) return fail(`Could not join. The server replied: ${output}`)
    return `Ran /team join ${i.team}. The server replied: ${output || '(nothing)'}`
  },
}

export const listHomes: Tool = {
  name: 'list_homes',
  description: 'List the homes you have set on the server.',
  inputSchema: obj({}),
  async run(ctx) {
    const output = await runCommand(ctx, COMMANDS.listHomes())
    return output.length > 0
      ? `Server replied: ${output.join(' | ')}`
      : 'The server printed nothing (maybe no homes are set; a late reply would show up as a system message).'
  },
}

// ── 干活 ──

export const flattenArea: Tool = {
  name: 'flatten_area',
  description: `Level a rectangle so the ground surface is at height y (task, at most ${FLATTEN_MAX_SIDE}×${FLATTEN_MAX_SIDE}): digs away what is above y, then fills the holes at y and below. Scan the area first to choose y.`,
  inputSchema: obj(
    {
      x1: int('x of one corner'),
      z1: int('z of one corner'),
      x2: int('x of the opposite corner'),
      z2: int('z of the opposite corner'),
      y: int('y of the top ground layer after flattening.', { min: 0, max: 255 }),
      fill: bool('Fill holes at y and below (default true).'),
      fillItems: arr('Block ids allowed as fill material, e.g. ["minecraft:dirt"]. Omit to use the usual filler blocks (dirt, cobblestone and the like).', str('block id'), {
        min: 1,
        max: 16,
      }),
      maxFillDepth: int('Deepest hole to fill, in layers (default 3). Deeper holes are skipped and reported.', { min: 1, max: 64 }),
      dropoff: containerList('Containers (chests or drawers) to unload into when the inventory fills up.'),
      supply: containerList('Containers (chests or drawers) to fetch fill material from when it runs out.'),
      overflow,
      queue,
    },
    ['x1', 'z1', 'x2', 'z2', 'y'],
  ),
  async run(ctx, i) {
    const width = Math.abs(i.x2 - i.x1) + 1
    const depth = Math.abs(i.z2 - i.z1) + 1
    if (width > FLATTEN_MAX_SIDE || depth > FLATTEN_MAX_SIDE) {
      return fail(`area is ${width}×${depth}; at most ${FLATTEN_MAX_SIDE}×${FLATTEN_MAX_SIDE} per task. Split it and queue the pieces.`)
    }
    const { queue: q, ...params } = i
    return startTask(ctx, { type: 'flatten', ...params }, q)
  },
}

export const clearArea: Tool = {
  name: 'clear_area',
  description: `Dig out every block in a box, from the top down (task, volume at most ${BOX_MAX_VOLUME}). Chests, drawers, machines, liquids and bedrock are left alone.`,
  inputSchema: obj(
    { ...boxProps, dropoff: containerList('Containers (chests or drawers) to unload into when the inventory fills up.'), overflow, queue },
    boxRequired,
  ),
  async run(ctx, i) {
    const volume = boxVolume(i)
    if (volume > BOX_MAX_VOLUME) return fail(`box volume is ${volume}; at most ${BOX_MAX_VOLUME} per task. Split it and queue the pieces.`)
    const { queue: q, ...params } = i
    return startTask(ctx, { type: 'clear', ...params }, q)
  },
}

export const fillArea: Tool = {
  name: 'fill_area',
  description: `Place a block in every empty spot of a box, bottom up (task, volume at most ${BOX_MAX_VOLUME}). shape "hollow" builds only the six faces, "walls" only the four sides. Blocks come from your inventory and the supply containers.`,
  inputSchema: obj(
    {
      ...boxProps,
      item: str('Block item id to place, e.g. "minecraft:cobblestone".'),
      meta: int('Item meta (default 0).', { min: 0 }),
      shape: str('solid (default), hollow or walls.', { enum: ['solid', 'hollow', 'walls'] }),
      supply: containerList('Containers (chests or drawers) to fetch more of the block from when you run out.'),
      queue,
    },
    [...boxRequired, 'item'],
  ),
  async run(ctx, i) {
    const volume = boxVolume(i)
    if (volume > BOX_MAX_VOLUME) return fail(`box volume is ${volume}; at most ${BOX_MAX_VOLUME} per task. Split it and queue the pieces.`)
    const { queue: q, ...params } = i
    return startTask(ctx, { type: 'fill', ...params }, q)
  },
}

export const digBlocks: Tool = {
  name: 'dig_blocks',
  description: `Dig specific blocks, nearest first (task, at most ${BLOCK_LIST_MAX}). Use clear_area for whole boxes.`,
  inputSchema: obj({ blocks: arr('Positions to dig.', pos('A block position.'), { min: 1, max: BLOCK_LIST_MAX }), queue }, ['blocks']),
  run: (ctx, i: { blocks: unknown[]; queue?: boolean }) => startTask(ctx, { type: 'dig', blocks: i.blocks }, i.queue),
}

export const placeBlocks: Tool = {
  name: 'place_blocks',
  description: `Place specific blocks, lowest first (task, at most ${BLOCK_LIST_MAX}). Each needs an existing block next to it to attach to. Use fill_area for whole boxes.`,
  inputSchema: obj(
    {
      blocks: arr(
        'Blocks to place.',
        obj(
          { x: int('x'), y: int('y', { min: 0, max: 255 }), z: int('z'), item: str('Block item id.'), meta: int('Item meta (default 0).', { min: 0 }) },
          ['x', 'y', 'z', 'item'],
        ),
        { min: 1, max: BLOCK_LIST_MAX },
      ),
      supply: containerList('Containers (chests or drawers) to fetch more blocks from when you run out.'),
      queue,
    },
    ['blocks'],
  ),
  run: (ctx, i: { blocks: unknown[]; supply?: unknown[]; queue?: boolean }) =>
    startTask(ctx, { type: 'place', blocks: i.blocks, supply: i.supply }, i.queue),
}

// ── 搬运 ──

export const depositItems: Tool = {
  name: 'deposit_items',
  description:
    'Walk to a container (a chest or similar, or Storage Drawers) and put items into it (task). Without "items": everything except tools, food and the ids in "keep". Fails with container_full if it does not fit.',
  inputSchema: obj(
    {
      container: pos('Position of the chest or drawers.'),
      items: arr('What to deposit. Omit for everything except tools and food.', itemFilter, { min: 1, max: 36 }),
      keep: arr('Item ids to keep in your inventory.', str('item id'), { min: 1, max: 36 }),
      queue,
    },
    ['container'],
  ),
  run: (ctx, i: { container: unknown; items?: unknown[]; keep?: string[]; queue?: boolean }) =>
    startTask(ctx, { type: 'deposit', container: i.container, items: i.items, keep: i.keep }, i.queue),
}

export const withdrawItems: Tool = {
  name: 'withdraw_items',
  description:
    'Walk to a container (a chest or similar, or Storage Drawers) and take items out (task); counts are exact. It ends as done even when there was not enough: check "missing" in the result.',
  inputSchema: obj(
    { container: pos('Position of the chest or drawers.'), items: arr('What to take.', itemFilter, { min: 1, max: 36 }), queue },
    ['container', 'items'],
  ),
  run: (ctx, i: { container: unknown; items: unknown[]; queue?: boolean }) =>
    startTask(ctx, { type: 'withdraw', container: i.container, items: i.items }, i.queue),
}

export const haulItems: Tool = {
  name: 'haul_items',
  description:
    'Carry items from one container to another (chests or similar, or Storage Drawers), in as many trips as it takes (task). Without "items": everything in the source. Your own inventory is not touched.',
  inputSchema: obj(
    {
      from: pos('Source container (chest or drawers).'),
      to: pos('Destination container (chest or drawers).'),
      items: arr('What to move (with optional counts). Omit for everything.', itemFilter, { min: 1, max: 36 }),
      queue,
    },
    ['from', 'to'],
  ),
  run: (ctx, i: { from: unknown; to: unknown; items?: unknown[]; queue?: boolean }) =>
    startTask(ctx, { type: 'haul', from: i.from, to: i.to, items: i.items }, i.queue),
}

export const collectItems: Tool = {
  name: 'collect_items',
  description: 'Pick up items lying on the ground around a position (task). Defaults to around where you stand.',
  inputSchema: obj({
    x: int('x of the center (default: your position).'),
    y: int('y of the center.', { min: 0, max: 255 }),
    z: int('z of the center.'),
    radius: int('Radius in blocks (default 8).', { min: 1, max: 32 }),
    queue,
  }),
  async run(ctx, i: { x?: number; y?: number; z?: number; radius?: number; queue?: boolean }) {
    let center: { x: number; y: number; z: number }
    if (i.x !== undefined && i.y !== undefined && i.z !== undefined) {
      center = { x: i.x, y: i.y, z: i.z }
    } else if (i.x === undefined && i.y === undefined && i.z === undefined) {
      const me = await botBlock(ctx)
      center = { x: me.x, y: me.y, z: me.z }
    } else {
      return fail('give all of x, y, z or none of them')
    }
    return startTask(ctx, { type: 'collect', ...center, radius: i.radius }, i.queue)
  },
}

export const giveItems: Tool = {
  name: 'give_items',
  description:
    'Walk up to a player and toss items from your inventory to them (task). Fails with "unreachable" if the player is not around and "no_material" if you carry none of the items.',
  inputSchema: obj(
    {
      player: str('Player name.'),
      items: arr('What to give (with optional counts).', itemFilter, { min: 1, max: 36 }),
      queue,
    },
    ['player', 'items'],
  ),
  async run(ctx, i: { player: string; items: unknown[]; queue?: boolean }) {
    if (!PLAYER_NAME_RE.test(i.player)) return fail(`"${i.player}" is not a valid player name`)
    return startTask(ctx, { type: 'give', player: i.player, items: i.items }, i.queue)
  },
}

// ── 任务管理 ──

export const taskStatus: Tool = {
  name: 'task_status',
  description: 'Your running task with its progress, the queue, and the tasks that ended recently with their results or errors.',
  inputSchema: obj({}),
  async run(ctx) {
    const list = await ctx.bridge.taskList(ctx.botName)
    const lines: string[] = []
    lines.push(`Running: ${list.active ? formatTask(list.active, { params: true }) : 'nothing'}`)
    const queued = list.queue ?? []
    lines.push(queued.length > 0 ? `Queue (${queued.length}):` : 'Queue: empty')
    for (const t of queued.slice(0, 20)) lines.push(`- ${formatTask(t, { params: true })}`)
    const recent = list.recent ?? []
    if (recent.length > 0) {
      lines.push('Recently ended (newest first):')
      const sorted = [...recent].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      for (const t of sorted.slice(0, 10)) lines.push(`- ${formatTask(t)}`)
    }
    return lines.join('\n')
  },
}

export const cancelTask: Tool = {
  name: 'cancel_task',
  description: 'Cancel one task by id, or (without id) the running task and the whole queue.',
  inputSchema: obj({ id: str('Task id, e.g. "t42". Omit to cancel everything.') }),
  async run(ctx, i: { id?: string }) {
    let ids: readonly string[] = []
    let n = 0
    ctx.hooks.cancelStart?.()
    try {
      const res = await ctx.bridge.taskCancel(ctx.botName, i.id)
      ids = res.ids ?? []
      n = res.canceled ?? ids.length
    } finally {
      ctx.hooks.cancelEnd?.(ids)
    }
    if (n === 0) return i.id ? `No running or queued task has id ${i.id}.` : 'Nothing was running or queued.'
    return `Canceled ${n} task(s)${ids.length > 0 ? `: ${ids.join(', ')}` : ''}.`
  },
}
