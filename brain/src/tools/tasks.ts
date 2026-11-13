// 启动任务的工具。任务是异步的：这里只负责启动，结果以后通过事件回来。
// 还有以它的身份发服务器指令的 run_command（设家、列家、加入队伍都是它；旧的 set_home、list_homes、join_team
// 不在清单里了，调到照常执行）。haul_items 是库函数：不在清单里，例程里调，模型直接调也照常开任务。

import { BridgeError } from '../bridge/protocol.ts'
import type { TaskSpec } from '../bridge/protocol.ts'
import { COMMANDS, COMMAND_MAX_CHARS, COMMAND_REPLY_WAIT_MS, DEFAULT_ALLOWED_COMMANDS, HOME_NAME_RE, PLAYER_NAME_RE, TEAM_ID_RE, WHISPER_COMMAND_RE, WHISPER_FAILED_RE } from './commands.ts'
import { formatPos, formatTask } from './format.ts'
import { botBlock } from './observe.ts'
import { arr, bool, int, num, obj, pos, str } from './schema.ts'
import type { Schema } from './schema.ts'
import { fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'
import { errorText } from '../util.ts'

// 协议里的上限
export const BLOCK_LIST_MAX = 256
export const BOX_MAX_VOLUME = 32768
export const FLATTEN_MAX_SIDE = 64

// ── 好几个工具共用的参数：同一种参数只有一套措辞，写短（这些说明每一轮都发给模型）──
// 参数名自己说得清的（x、y、z、id、meta、count）不再各写一句，怎么写由上一层那个参数的说明讲。

/** 任务排不排队。“默认顶掉当前任务和整个队列”核心提示词里也讲。 */
export const queue = bool('true: queue it after your other tasks. Default: start now, replacing them.')


/** 方块的六个面（use_item 的 side、存取和开界面时点哪个面）。 */
export const USE_SIDES = ['down', 'up', 'north', 'south', 'west', 'east']

/**
 * 存取用的容器位置。带 side / sneak 时不是普通地右键它，而是点那个面（蹲着或不蹲），打开什么界面就往什么界面里存取：
 * 机器某个面上的覆盖板（槽位扩展）有它自己的界面，里面的东西这样才拿得到。
 */
const containerAt = obj(
  { x: int(), y: int(), z: int(), side: str(undefined, { enum: USE_SIDES }), sneak: bool() },
  ['x', 'y', 'z'],
  'Position of the container. "side" (a face) and "sneak": that face is clicked, sneaking or not, and the screen that opens is used (a cover on a machine\'s face has its own).',
)

/** 一个盒子的两个对角。说明写在工具自己的说明里（BOX_WORDS），六个坐标不各写一句。 */
export const boxProps = { x1: int(), y1: int(undefined, { min: 0, max: 255 }), z1: int(), x2: int(), y2: int(undefined, { min: 0, max: 255 }), z2: int() }
export const boxRequired = ['x1', 'y1', 'z1', 'x2', 'y2', 'z2']
export const BOX_WORDS = 'The box: any two opposite corners (x1, y1, z1) and (x2, y2, z2).'

/** 物品清单里的一项。怎么写由清单那个参数的说明讲（EACH_ITEM）。 */
const itemFilter = obj({ id: str(), meta: int(undefined, { min: 0 }), count: int(undefined, { min: 1 }) }, ['id'])
export const EACH_ITEM = 'each {id, meta?, count?}; no meta: any meta, no count: all of it'

/** 随身的包当容器（协议里 deposit / withdraw 的 container 写成 {item:{id,meta?}}）：身上这件东西右键打开的那个界面。 */
const bag = obj({ id: str(), meta: int(undefined, { min: 0 }) }, ['id'], 'Instead of "container": a bag you carry, as {id, meta?} of the bag item.')

/** container 和 bag 只能给一个；返回任务参数里的 container，或者给模型的一句错误。 */
function containerOrBag(i: { container?: unknown; bag?: { id: string; meta?: number } }): { container: unknown } | { error: string } {
  if ((i.container === undefined) === (i.bag === undefined)) return { error: 'give exactly one of "container" (a position) or "bag" (a bag you carry)' }
  return { container: i.bag ? { item: i.bag.meta === undefined ? { id: i.bag.id } : { id: i.bag.id, meta: i.bag.meta } } : i.container }
}

/** supply / dropoff：容器坐标的列表。箱子这类有界面的储物方块和抽屉（Storage Drawers）都行。 */
export const containerList = (description: string): Schema => arr(description, pos(), { min: 1, max: 8 })
/** 材料用完时去哪取。what：取的是什么（“fill material”“the block”）。 */
export const supply = (what: string): Schema => containerList(`Containers (chests, drawers) to fetch ${what} from when you run out.`)
/** 背包满了往哪卸。 */
export const dropoff = containerList('Containers (chests, drawers) to unload into when your inventory fills up.')

export const overflow = str('Inventory full and no dropoff: "fail" (default) ends the task with inventory_full; "leave" digs on and leaves the drops on the ground.', { enum: ['fail', 'leave'] })

/**
 * 以 bot 身份执行一条指令并拿到服务器的回显。
 * 回显通常在 output 里；当下什么都没有时，再等一小会儿看有没有晚到的系统消息。
 */
async function sendCommand(ctx: ToolContext, command: string): Promise<string[]> {
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
    return `Task ${t.id} (${t.type}) added to the end of your queue. It runs after the tasks before it (right away if there are none). The outcome of each task comes to you by itself when it ends.`
  }
  const dropped = replaced.length > 0 ? ` It replaced ${replaced.length} earlier task(s): ${replaced.join(', ')}.` : ''
  return `Task ${t.id} (${t.type}) started.${dropped} It runs in the game on its own: when it ends, the outcome comes to you by itself (waking you if your turn has ended), so there is nothing to wait or poll for; a look at its progress is one model call each time.`
}

/**
 * 放方块时 meta 的说法（fill_area、place_blocks 共用）。同一个 id 的不同 meta 是不同的方块（钢机械方块和钢管道方块），
 * 所以不给就是 0，只放这一种；身上和 supply 里没有这一种了，任务以 no_material 停下，不拿别的变体顶。
 */
const META_WORDS = 'default 0; only blocks of that meta are placed'

function boxVolume(b: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }): number {
  return (Math.abs(b.x2 - b.x1) + 1) * (Math.abs(b.y2 - b.y1) + 1) * (Math.abs(b.z2 - b.z1) + 1)
}


// ── 移动 ──

/** 走路时能不能垫方块往上爬（go_to、go_to_player、follow_player 共用）。默认不垫：在世界里留下方块该是模型自己选的。 */
const climb = bool('true: may stack blocks (dirt, cobblestone) under you to climb. Default false.')

/**
 * 走路。给了 y 时高度也按 range 核对（身体的 yRange，不给它时身体按老规矩差 2 格也算到）；站不住的目标一开始就失败。
 * 默认不垫方块（身体的 climb 默认是垫，这里总是写明）：在世界里留下方块该是模型自己选的。
 */
export const goTo: Tool = {
  name: 'go_to',
  description:
    'Walk to a position (task). x and z alone: the ground at that spot; y too when the height matters (where your feet end up). A walk covers at most about 256 blocks; farther places are reached by teleporting near first (go_home).',
  inputSchema: obj(
    {
      x: int(),
      y: int(undefined, { min: 0, max: 255 }),
      z: int(),
      range: int('Stop when within this many blocks (default 1); with y, of that height too.', { min: 0, max: 32 }),
      climb,
      takeBack: bool('With climb: on arrival, dig out the blocks you stacked that are within reach.'),
      queue,
    },
    ['x', 'z'],
  ),
  run: (ctx, i: { x: number; y?: number; z: number; range?: number; climb?: boolean; takeBack?: boolean; queue?: boolean }) =>
    startTask(
      ctx,
      {
        type: 'goto',
        x: i.x,
        y: i.y,
        z: i.z,
        range: i.range,
        yRange: i.y === undefined ? undefined : (i.range ?? 1),
        climb: i.climb === true,
        takeBack: i.takeBack === true ? true : undefined,
      },
      i.queue,
    ),
}

export const goToPlayer: Tool = {
  name: 'go_to_player',
  description: 'Walk to a player and stop next to them (task). Fails with "stuck" if you cannot catch up within 5 minutes.',
  inputSchema: obj(
    { player: str('Player name.'), range: int('Stop when within this many blocks (default 2).', { min: 1, max: 32 }), climb, queue },
    ['player'],
  ),
  async run(ctx, i: { player: string; range?: number; climb?: boolean; queue?: boolean }) {
    if (!PLAYER_NAME_RE.test(i.player)) return fail(`"${i.player}" is not a valid player name`)
    return startTask(ctx, { type: 'goto_player', player: i.player, range: i.range, climb: i.climb === true }, i.queue)
  },
}

export const followPlayer: Tool = {
  name: 'follow_player',
  description: 'Keep following a player until you cancel it or start another task (task that never ends by itself).',
  inputSchema: obj(
    { player: str('Player name.'), distance: int('Distance to keep (default 3).', { min: 1, max: 32 }), climb, queue },
    ['player'],
  ),
  async run(ctx, i: { player: string; distance?: number; climb?: boolean; queue?: boolean }) {
    if (!PLAYER_NAME_RE.test(i.player)) return fail(`"${i.player}" is not a valid player name`)
    return startTask(ctx, { type: 'follow', player: i.player, distance: i.distance, climb: i.climb === true }, i.queue)
  },
}

export const goHome: Tool = {
  name: 'go_home',
  description:
    'Teleport to one of your homes with /home (task). The fastest way to travel far. Homes are set with run_command ("sethome <name>"). Fails with "invalid" if there is no home of that name.',
  inputSchema: obj({ name: str('Home name.'), queue }, ['name']),
  async run(ctx, i: { name: string; queue?: boolean }) {
    if (!HOME_NAME_RE.test(i.name)) return fail('home names may only contain letters, digits, _ and -')
    return startTask(ctx, { type: 'home', name: i.name }, i.queue)
  },
}

/**
 * 以它的身份发一条服务器指令，把服务器的回显原样给它。能发哪些由身体的允许列表定（mod 配置的 allowedCommands）：
 * 协议里没有读这份列表的接口，所以说明里只说“不在列表里的会被拒绝、结果会说明”，被拒绝时把默认的列表写给它参考。
 * 指令成没成只有回显知道，这里不替它判断。
 */
export const runCommand: Tool = {
  name: 'run_command',
  description:
    'Run one server command as yourself and get what the server replies. Which commands a bot may run is set by an allow list on the game server; you cannot read that list, and a command that is not on it is refused with a result that says so. Examples: "sethome base" saves where you stand as a home that go_home teleports to; "home list" lists your homes; "team join <team>" joins a ServerUtilities team whose owner invited you (being on their team lets you dig, build and open chests in their claim).',
  inputSchema: obj({ command: str('The command line, without the leading "/", e.g. "sethome base".', { maxLength: COMMAND_MAX_CHARS + 1 }) }, ['command']),
  async run(ctx, i: { command: string }): Promise<ToolResult> {
    const command = i.command.trim().replace(/^\/+\s*/, '')
    if (command.length === 0) return fail('The command is empty.')
    if (/[\u0000-\u001f\u007f\u00a7]/.test(command)) return fail('A command is one line of plain text: no line breaks, control characters or colour codes.')
    if (command.length > COMMAND_MAX_CHARS) return fail(`The command is ${command.length} characters; the game server takes at most ${COMMAND_MAX_CHARS}.`)
    let output: string[]
    try {
      output = await sendCommand(ctx, command)
    } catch (e) {
      // 不在允许列表里：照实说，并把默认的列表给它参考（现在的列表身体不告诉我们）
      if (e instanceof BridgeError && e.code === 'denied' && /allow list/i.test(e.message)) {
        return fail(
          `The game server refused "/${command}": it is not on its allow list of commands for bots. Asking again gives the same answer. ` +
            `The list is in the mod's config (allowedCommands) and cannot be read from here; unless your owner changed it, it holds: ${DEFAULT_ALLOWED_COMMANDS.join(', ')}. A player can run the command, or your owner can add it to the list.`,
        )
      }
      throw e
    }
    // 用它发的悄悄话（tell / msg / w）也算“已经对人说过话”：不然它这一轮最后留的那段文字会被兜底再公开说一遍。
    // 对方不在线、没送到的不算（和 whisper 一样看回显）。
    const told = WHISPER_COMMAND_RE.exec(command)
    if (told && !WHISPER_FAILED_RE.test(output.join(' | '))) ctx.hooks.spoke?.({ kind: 'whisper', to: told[1]!, text: told[2]! })
    return {
      content: output.length > 0 ? `Ran /${command}. The server replied: ${output.join(' | ')}` : `Ran /${command}. The server printed nothing (a late reply would show up as a system message).`,
      data: { command, output },
    }
  },
}

/** 旧名字：不在发给模型的清单里（并进了 run_command），程序里、旧笔记里调到它照常执行（它还顺手把地点记进记忆）。 */
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
    const output = (await sendCommand(ctx, COMMANDS.setHome(i.name))).join(' | ')
    let remembered = ''
    try {
      ctx.memory.set(`home:${i.name}`, `${formatPos(me)} dim ${me.dim ?? '?'}${i.note ? ` — ${i.note}` : ''}`)
      remembered = ` Recorded in memory as "home:${i.name}".`
    } catch (e) {
      remembered = ` Could not record it in memory: ${errorText(e)}.`
    }
    // 指令成没成只有服务器的回显知道，原样给模型判断
    return `Ran /sethome ${i.name} at ${formatPos(me)}. Server replied: ${output || '(nothing yet; a late reply would show up as a system message)'}.${remembered}`
  },
}

/** 旧名字，同上。 */
export const joinTeam: Tool = {
  name: 'join_team',
  description:
    'Join a ServerUtilities team that has invited you (/team join). Being on your owner\'s team is what lets you dig, build and open chests inside their protected claim. The team owner must invite you first with "/team status <your name> invited".',
  inputSchema: obj({ team: str('Team id, as the owner tells you.', { maxLength: 35 }) }, ['team']),
  async run(ctx, i: { team: string }) {
    if (!TEAM_ID_RE.test(i.team)) return fail('team ids may only contain letters, digits, _ and -')
    const output = (await sendCommand(ctx, COMMANDS.joinTeam(i.team))).join(' | ')
    // 成没成只有服务器的回显知道。实测：队伍不存在时回 Team '名字' not found!
    if (/not found|not invited|can(?:'|no)t|denied|permission/i.test(output)) return fail(`Could not join. The server replied: ${output}`)
    return `Ran /team join ${i.team}. The server replied: ${output || '(nothing)'}`
  },
}

/** 旧名字，同上。 */
export const listHomes: Tool = {
  name: 'list_homes',
  description: 'List the homes you have set on the server.',
  inputSchema: obj({}),
  async run(ctx) {
    const output = await sendCommand(ctx, COMMANDS.listHomes())
    return output.length > 0
      ? `Server replied: ${output.join(' | ')}`
      : 'The server printed nothing (maybe no homes are set; a late reply would show up as a system message).'
  },
}

// ── 干活 ──

export const flattenArea: Tool = {
  name: 'flatten_area',
  description: `Level a rectangle so the ground surface is at height y (task, at most ${FLATTEN_MAX_SIDE}×${FLATTEN_MAX_SIDE}): digs away what is above y, then fills the holes at y and below. The rectangle: any two opposite corners (x1, z1) and (x2, z2).`,
  inputSchema: obj(
    {
      x1: int(),
      z1: int(),
      x2: int(),
      z2: int(),
      y: int('y of the top ground layer afterwards.', { min: 0, max: 255 }),
      fill: bool('Fill holes at y and below (default true).'),
      fillItems: arr('Block ids to fill with. Default: the usual fillers (dirt, cobblestone and the like).', str(), { min: 1, max: 16 }),
      maxFillDepth: int('Deepest hole to fill, in layers (default 3); deeper ones are skipped and reported.', { min: 1, max: 64 }),
      dropoff,
      supply: supply('fill material'),
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
  description: `Dig out every block in a box, from the top down (task, volume at most ${BOX_MAX_VOLUME}). Chests, drawers, machines, liquids and bedrock are left alone. ${BOX_WORDS}`,
  inputSchema: obj({ ...boxProps, dropoff, overflow, queue }, boxRequired),
  async run(ctx, i) {
    const volume = boxVolume(i)
    if (volume > BOX_MAX_VOLUME) return fail(`box volume is ${volume}; at most ${BOX_MAX_VOLUME} per task. Split it and queue the pieces.`)
    const { queue: q, ...params } = i
    return startTask(ctx, { type: 'clear', ...params }, q)
  },
}

export const fillArea: Tool = {
  name: 'fill_area',
  description: `Place a block in every empty spot of a box, bottom up (task, volume at most ${BOX_MAX_VOLUME}). The blocks come from your inventory and "supply". ${BOX_WORDS}`,
  inputSchema: obj(
    {
      ...boxProps,
      item: str('Item id of the block to place.'),
      meta: int(`Its meta (${META_WORDS}).`, { min: 0 }),
      blockMeta: int('The meta every block must end up with, as in place_blocks.', { min: 0, max: 15 }),
      shape: str('solid (default), hollow (only the six faces) or walls (only the four sides).', { enum: ['solid', 'hollow', 'walls'] }),
      supply: supply('the block'),
      queue,
    },
    [...boxRequired, 'item'],
  ),
  async run(ctx, i) {
    const volume = boxVolume(i)
    if (volume > BOX_MAX_VOLUME) return fail(`box volume is ${volume}; at most ${BOX_MAX_VOLUME} per task. Split it and queue the pieces.`)
    const { queue: q, ...params } = i
    // 身体收到不带 meta 的是“哪种都行”，会把同一个 id 的几种方块混着放；说明里写的默认 0 要真的交给它。
    // 给了 blockMeta 不给 meta：用哪种物品由身体挑（能放出这个朝向的那种），同 place_blocks
    return startTask(ctx, { type: 'fill', ...params, ...(i.meta === undefined && i.blockMeta !== undefined ? {} : { meta: i.meta ?? 0 }) }, q)
  },
}

export const digBlocks: Tool = {
  name: 'dig_blocks',
  description: `Dig specific blocks, nearest first (task, at most ${BLOCK_LIST_MAX}). A chest, drawer or machine listed here is dug as a player digs it: what is inside drops on the ground. clear_area does whole boxes.`,
  inputSchema: obj({ blocks: arr('Positions to dig.', pos(), { min: 1, max: BLOCK_LIST_MAX }), queue }, ['blocks']),
  run: (ctx, i: { blocks: unknown[]; queue?: boolean }) => startTask(ctx, { type: 'dig', blocks: i.blocks }, i.queue),
}

export const placeBlocks: Tool = {
  name: 'place_blocks',
  description: `Place specific blocks, lowest first (task, at most ${BLOCK_LIST_MAX}). Each needs an existing block next to it to attach to. fill_area does whole boxes.`,
  inputSchema: obj(
    {
      blocks: arr(
        `Each {x, y, z, item, meta?, blockMeta?}: item is the block's item id, meta its meta (${META_WORDS}). blockMeta: the meta it must end up with (as inspect_block shows: how stairs, logs, slabs face).`,
        obj(
          { x: int(), y: int(undefined, { min: 0, max: 255 }), z: int(), item: str(), meta: int(undefined, { min: 0 }), blockMeta: int(undefined, { min: 0, max: 15 }) },
          ['x', 'y', 'z', 'item'],
        ),
        { min: 1, max: BLOCK_LIST_MAX },
      ),
      supply: supply('blocks'),
      queue,
    },
    ['blocks'],
  ),
  run: (ctx, i: { blocks: { meta?: number; blockMeta?: number }[]; supply?: unknown[]; queue?: boolean }) =>
    startTask(
      ctx,
      {
        type: 'place',
        // 给了 blockMeta 不给 meta：用哪种物品放由身体挑（能放出这个朝向的那种，比如云杉原木横放 /5 用的是物品 log:1）；否则默认 0
        blocks: i.blocks.map((b) => (b.meta === undefined && b.blockMeta !== undefined ? b : { ...b, meta: b.meta ?? 0 })),
        supply: i.supply,
      },
      i.queue,
    ),
}

// ── 搬运 ──

export const depositItems: Tool = {
  name: 'deposit_items',
  description:
    'Walk to a container (a chest or similar, Storage Drawers, a machine) and put items into it (task). Without "items": everything except tools, food and the ids in "keep". Fails with container_full if it does not fit. Give "container" or "bag".',
  inputSchema: obj({
    container: containerAt,
    bag,
    items: arr(`What to put in, ${EACH_ITEM}. A bag needs this list.`, itemFilter, { min: 1, max: 36 }),
    keep: arr('Item ids to keep in your inventory.', str(), { min: 1, max: 36 }),
    queue,
  }),
  async run(ctx, i: { container?: unknown; bag?: { id: string; meta?: number }; items?: unknown[]; keep?: string[]; queue?: boolean }) {
    const where = containerOrBag(i)
    if ('error' in where) return fail(where.error)
    // 身体的规矩：往包里放必须说清放什么（不然“除工具和食物以外的全部”会把整个背包倒进去）
    if (i.bag && i.items === undefined) return fail('Putting things into a bag needs "items": list what goes in.')
    return startTask(ctx, { type: 'deposit', container: where.container, items: i.items, keep: i.keep }, i.queue)
  },
}

export const withdrawItems: Tool = {
  name: 'withdraw_items',
  description:
    'Walk to a container (a chest or similar, Storage Drawers, a machine) and take items out (task); counts are exact. It ends as done even when there was not enough: "missing" in the result says what. Give "container" or "bag".',
  inputSchema: obj(
    {
      container: containerAt,
      bag,
      items: arr(`What to take, ${EACH_ITEM}.`, itemFilter, { min: 1, max: 36 }),
      fromInputs: bool('For a machine: true takes from its other slots (a mold or shape left there, unused inputs, fuel) instead of its products.'),
      queue,
    },
    ['items'],
  ),
  async run(ctx, i: { container?: unknown; bag?: { id: string; meta?: number }; items: unknown[]; fromInputs?: boolean; queue?: boolean }) {
    const where = containerOrBag(i)
    if ('error' in where) return fail(where.error)
    if (i.fromInputs === true && i.bag) return fail('"fromInputs" is for a machine: give its position as "container", not a bag.')
    return startTask(ctx, { type: 'withdraw', container: where.container, items: i.items, ...(i.fromInputs === true ? { fromInputs: true } : {}) }, i.queue)
  },
}

export const haulItems: Tool = {
  name: 'haul_items',
  brief: '{from, to, items?}: a task, so in routines only: carry items between two containers -> task, state, result',
  description:
    'Carry items from one container to another (chests or similar, or Storage Drawers), in as many trips as it takes (task). Without "items": everything in the source. Your own inventory is not touched.',
  inputSchema: obj(
    {
      from: pos('Source container (chest or drawers).'),
      to: pos('Destination container (chest or drawers).'),
      items: arr(`What to move, ${EACH_ITEM}. Omit for everything.`, itemFilter, { min: 1, max: 36 }),
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
      items: arr(`What to give, ${EACH_ITEM}.`, itemFilter, { min: 1, max: 36 }),
      queue,
    },
    ['player', 'items'],
  ),
  async run(ctx, i: { player: string; items: unknown[]; queue?: boolean }) {
    if (!PLAYER_NAME_RE.test(i.player)) return fail(`"${i.player}" is not a valid player name`)
    return startTask(ctx, { type: 'give', player: i.player, items: i.items }, i.queue)
  },
}


/**
 * 像玩家那样右键：手里拿着一件东西（或者空手），对着空中或者对着一个方块；可以指定点哪个面、点面上的哪一点、连点几下。
 * 这是通用的那只手：没有现成工具的事（吃、穿戴、按按钮、拉拉杆、对着抽屉连点两下把同类的全放进去）都是它。
 */
export const useItem: Tool = {
  name: 'use_item',
  description:
    'Right-click as a player does (task): holding an item you carry, in the air (eat, drink, wear it, open it) or on a block ("on"; you walk there first); without "id", with an empty hand on a block (a button, a lever). left: true makes it a left click on the block instead (a chisel carves the block in place). The result tells what changed: the block clicked before and now, items gained and lost, health, food, and the clicks made. Details: inventory manual.',
  inputSchema: obj({
    id: str('Item to hold. Omit for an empty hand (then "on" is needed).'),
    meta: int('Its meta. Omit to match any.', { min: 0 }),
    on: pos('Block to right-click. Omit to use the item in the air.'),
    side: str('Which face of the block to click (default: the one facing you). For a horizontal face you first walk in front of it.', { enum: USE_SIDES }),
    hit: obj({ x: num(undefined, { min: 0, max: 1 }), y: num(undefined, { min: 0, max: 1 }), z: num(undefined, { min: 0, max: 1 }) }, ['x', 'y', 'z'], 'The point of the block to click, each 0 to 1 from its lowest corner (default: the middle of the face).'),
    times: int('How many clicks in a row (default 1), like holding the button down.', { min: 1, max: 64 }),
    every: int('Ticks between the clicks (default 4).', { min: 1, max: 40 }),
    sneak: bool('true: sneak while using it; some items then do something else.'),
    left: bool('true: a left click on the block "on" (pressed and let go; nothing that takes digging is dug).'),
    queue,
  }),
  async run(ctx, i: { id?: string; meta?: number; on?: unknown; side?: string; hit?: unknown; times?: number; every?: number; sneak?: boolean; left?: boolean; queue?: boolean }) {
    if (i.left === true && i.on === undefined) return fail('A left click is on a block: give the block as "on".')
    if (i.id === undefined && i.on === undefined) return fail('Give "id" (an item you carry) to use it, or "on" (a block) to right-click that block with an empty hand, or both.')
    if (i.on === undefined && (i.side !== undefined || i.hit !== undefined)) return fail('"side" and "hit" say where on a block to click: give the block as "on".')
    const item = i.id === undefined ? undefined : i.meta === undefined ? { id: i.id } : { id: i.id, meta: i.meta }
    return startTask(ctx, { type: 'use', item, on: i.on, side: i.side, hit: i.hit, times: i.times, every: i.every, sneak: i.sneak, ...(i.left === true ? { left: true } : {}) }, i.queue)
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
