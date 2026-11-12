import { boxPieces, pieceCount } from './reach.ts'
import { BridgeError } from '../bridge/protocol.ts'
import type { BlockInfo, BlockPos } from '../bridge/protocol.ts'
import {
  compactJson,
  COVER_NOTE,
  coverText,
  dimName,
  formatContainer,
  formatEntities,
  formatPlayerView,
  formatPos,
  formatScan,
  formatStatus,
  formatTerrainSummary,
  holdsCoverItems,
  itemKey,
  mergeItems,
  nameOf,
  protectionText,
  tanksText,
} from './format.ts'
import { guideNote, itemOfBlock } from './guide.ts'
import { methodNoteForMachine } from './methods.ts'
import { arr, bool, int, obj, str } from './schema.ts'
import { DEFAULT_RESULT_MAX_CHARS, ToolFailure, fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'
import { AT, lookFrom } from './where.ts'
import type { At } from './where.ts'
import { errorText } from '../util.ts'

// 协议里各方法的上限
export const SCAN_MAX_SIDE = 64
export const FIND_MAX_RADIUS = 48
/** 身体一次看容器每个方向最多看这么远；list_containers、list_stock 给得更大时（一个基地，BASE_RADIUS）切成这么大的几块各看一次。 */
export const CONTAINERS_MAX_RADIUS = 32
export const ENTITIES_MAX_RADIUS = 64
/** look_around 里每个容器列几种东西（只是概要）。 */
const LOOK_KINDS = 3

/** bot 脚下的方块坐标。不在线时以 ToolFailure 结束。 */
export async function botBlock(ctx: ToolContext): Promise<BlockPos & { dim?: number }> {
  const status = await ctx.bridge.botStatus(ctx.botName)
  if (!status.online) throw new ToolFailure(`${ctx.botName} is offline; it must be brought online first`)
  const p = status.block ?? status.pos
  if (!p) throw new ToolFailure('the bot status has no position')
  const out: BlockPos & { dim?: number } = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  if (status.dim !== undefined) out.dim = status.dim
  return out
}

/** world.block / bot.probe 共用的一行描述。 */
function describeBlock(pos: BlockPos, b: BlockInfo): string {
  if (b.loaded === false || typeof b.id !== 'string') {
    return `${formatPos(pos)}: unknown: that chunk is not loaded (nobody is near it), so it can only be read from nearer.`
  }
  const flags = (['air', 'solid', 'liquid', 'replaceable', 'tileEntity', 'inventory'] as const).filter((k) => b[k] === true)
  let s = `${formatPos(pos)}: ${b.id}${b.meta ? `/${b.meta}` : ''}`
  const name = nameOf(b, { block: true })
  if (name) s += ` "${name}"`
  if (flags.length > 0) s += ` [${flags.join(', ')}]`
  if (typeof b.hardness === 'number') s += ` hardness ${b.hardness}${b.hardness < 0 ? ' (unbreakable)' : ''}`
  // 它的流体罐里现在有什么、各个面上的覆盖板（能装东西的写出装着什么）
  const tanks = tanksText(b.tanks)
  if (tanks) s += `\n${tanks}`
  for (const cover of b.covers ?? []) s += `\n${coverText(cover, 40)}`
  if (holdsCoverItems(b)) s += `\n${COVER_NOTE}`
  return s
}

export const getStatus: Tool = {
  name: 'get_status',
  description:
    'Your current state: position, health, food, held item, inventory (merged per item, written as count× id or id/meta), current task and queue.',
  inputSchema: obj({}),
  async run(ctx) {
    const status = await ctx.bridge.botStatus(ctx.botName)
    // data：给程序用的原样状态（位置、背包每一格……）
    return { content: formatStatus(status), data: status }
  },
}

export const lookAround: Tool = {
  name: 'look_around',
  description:
    'Summary of what is near you, or near a place you give ("at"): players, mobs and dropped items, containers (chests, Storage Drawers and the like; drawers are marked [drawers]) with their main contents, and the lay of the land. scan_area gives exact terrain heights, list_containers the full contents.',
  inputSchema: obj({ radius: int('Search radius in blocks (default 16).', { min: 1, max: ENTITIES_MAX_RADIUS }), at: AT }),
  async run(ctx, input: { radius?: number; at?: At }) {
    const radius = input.radius ?? 16
    const me = await botBlock(ctx)
    // 给了 at：看的是那个地方（和它自己在同一个维度），不是它身边
    const mid = input.at ?? me
    const center = input.at ? { ...input.at, ...(me.dim !== undefined ? { dim: me.dim } : {}) } : { bot: ctx.botName }
    const terrainR = Math.min(radius, 16)
    const [entities, containers, scan] = await Promise.allSettled([
      ctx.bridge.worldEntities(center, { radius }),
      ctx.bridge.worldContainers(center, { radius: Math.min(radius, CONTAINERS_MAX_RADIUS) }),
      ctx.bridge.worldScan({ x1: mid.x - terrainR, z1: mid.z - terrainR, x2: mid.x + terrainR, z2: mid.z + terrainR, ...(input.at && me.dim !== undefined ? { dim: me.dim } : {}) }),
    ])
    const lines: string[] = [`You are at ${formatPos(me)} in ${dimName(me.dim)}. Within ${radius} blocks${input.at ? ` of ${formatPos(input.at)}` : ''}:`]

    if (entities.status === 'fulfilled') {
      const list = (entities.value.entities ?? []).filter((e) => !(e.type === 'player' && e.name === ctx.botName))
      lines.push(`Entities: ${formatEntities(list)}`)
    } else {
      lines.push(`Entities: unavailable (${errorText(entities.reason)})`)
    }

    if (containers.status === 'fulfilled') {
      const list = containers.value.containers ?? []
      const total = containers.value.total ?? list.length
      if (list.length === 0) {
        lines.push(`Containers: none${input.at ? '' : ' near you (to look around another place, give "at")'}`)
      } else {
        // 这里每个容器只列主要的几种：有没列的就写明怎么看全
        const shown = list.slice(0, 12)
        const cut = shown.some((c) => mergeItems(c.items ?? []).length > LOOK_KINDS || (c.moreKinds ?? 0) > 0)
        lines.push(`Containers (${total})${cut ? `, the ${LOOK_KINDS} main kinds of each (everything in one: list_containers with "at" it and radius 0)` : ''}:`)
        for (const c of shown) lines.push(`- ${formatContainer(c, LOOK_KINDS)}`)
        if (total > 12) lines.push(`- … ${total - 12} more (use list_containers with a smaller radius)`)
        if (shown.some(holdsCoverItems)) lines.push(COVER_NOTE)
      }
    } else {
      lines.push(`Containers: unavailable (${errorText(containers.reason)})`)
    }

    if (scan.status === 'fulfilled') {
      lines.push(`Terrain within ${terrainR} blocks: ${formatTerrainSummary(scan.value)}`)
    } else {
      lines.push(`Terrain: unavailable (${errorText(scan.reason)})`)
    }
    return lines.join('\n')
  },
}

export const scanArea: Tool = {
  name: 'scan_area',
  description: `Surface heights of a rectangle (any two opposite corners, at most ${SCAN_MAX_SIDE}×${SCAN_MAX_SIDE} columns). Up to 24×24 you get the exact height of every column; larger areas give a histogram and a downsampled grid. It shows which y level to flatten or build at.`,
  inputSchema: obj({ x1: int(), z1: int(), x2: int(), z2: int() }, ['x1', 'z1', 'x2', 'z2']),
  async run(ctx, input: { x1: number; z1: number; x2: number; z2: number }) {
    const width = Math.abs(input.x2 - input.x1) + 1
    const depth = Math.abs(input.z2 - input.z1) + 1
    if (width > SCAN_MAX_SIDE || depth > SCAN_MAX_SIDE) {
      // 照实说要分几块，每块的两个角写出来
      const whole = { x1: input.x1, z1: input.z1, x2: input.x2, z2: input.z2, y1: 0, y2: 0 }
      const parts = { length: pieceCount(whole, SCAN_MAX_SIDE), shown: boxPieces(whole, SCAN_MAX_SIDE, 16) }
      return fail(`The area is ${width}×${depth}; one scan covers at most ${SCAN_MAX_SIDE}×${SCAN_MAX_SIDE}, so this area is ${parts.length} scans: ${parts.shown.map((p) => `(${p.x1}, ${p.z1})–(${p.x2}, ${p.z2})`).join('; ')}${parts.length > 16 ? `; … ${parts.length - 16} more in the same pattern` : ''}.`)
    }
    const scan = await ctx.bridge.worldScan(input)
    if (!Array.isArray(scan.heights)) return fail(`unexpected scan result: ${compactJson(scan)}`)
    return formatScan(scan)
  },
}

/** 一个值写成一行紧凑的 JSON（键一个不丢）。 */
const oneLine = (v: unknown): string => JSON.stringify(v) ?? 'null'

/** 存档数据的顶层一项一行（列表是一个元素一行）：比一整行 JSON 好找，又不比它长多少。 */
function savedLines(saved: unknown): string[] {
  if (Array.isArray(saved)) return saved.map((v, n) => `  [${n}]: ${oneLine(v)}`)
  if (saved !== null && typeof saved === 'object') return Object.entries(saved).map(([k, v]) => `  ${k}: ${oneLine(v)}`)
  return [`  ${oneLine(saved)}`]
}

const GLOSSARY_MAX = 24

/**
 * 方块自己的话和存档数据里出现的内部名字，本地资料里查得到中文名的，列一个小对照表（原文不动）：
 * 流体的注册名（gas_gas、molten.steel，或者写成 fluid.gas_gas）、流体的英文名、物品（item + meta）。
 */
function glossary(ctx: ToolContext, block: BlockInfo): string[] {
  const fluids = ctx.packdata?.fluids
  const out = new Map<string, string>()
  const asFluid = (text: string): void => {
    if (!fluids || out.size >= GLOSSARY_MAX || text.length === 0 || text.length > 80 || out.has(text)) return
    const info = fluids.get(text) ?? (text.startsWith('fluid.') ? fluids.get(text.slice(6)) : undefined)
    if (info) out.set(text, info.name)
  }
  const walk = (v: unknown, depth: number): void => {
    if (depth > 14 || out.size >= GLOSSARY_MAX) return
    if (typeof v === 'string') asFluid(v)
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1)
    else if (v !== null && typeof v === 'object') {
      const o = v as { item?: unknown; meta?: unknown; name?: unknown }
      // 物品：存档里换好的 {item, meta, count, name}
      if (typeof o.item === 'string' && o.item.includes(':')) {
        const key = itemKey({ id: o.item, meta: typeof o.meta === 'number' ? o.meta : 0 })
        const local = ctx.packdata?.items?.get(o.item, typeof o.meta === 'number' ? o.meta : 0)?.name
        if (local !== undefined && local !== o.name && !out.has(key)) out.set(key, local)
      }
      for (const x of Object.values(v)) walk(x, depth + 1)
    }
  }
  for (const line of block.says ?? []) {
    for (const word of line.split(/[\s,;:()]+/)) asFluid(word)
    // 整行就是一种流体的英文名（"Chlorine"）
    const named = fluids?.search(line).exact ?? []
    if (named.length === 1 && named[0]!.name !== line && !out.has(line) && out.size < GLOSSARY_MAX) out.set(line, named[0]!.name)
  }
  walk(block.saved, 0)
  return [...out.entries()].map(([key, name]) => `${key} = ${name}`)
}

/** 这个方块自己知道的全部（world.block 的 detail）：它对扫描器说的话、存档里的全部数据。不超过 room 个字符。 */
function describeDetail(ctx: ToolContext, block: BlockInfo, room: number): string[] {
  const lines: string[] = []
  if (typeof block.detail === 'string') return [`It keeps no data of its own (${block.detail}).`]
  if (block.says && block.says.length > 0) lines.push('What it says of itself (as to a scanner):', ...block.says.map((line) => `  ${line}`))
  if (block.savedError !== undefined) return [...lines, `Its saved data could not be read: ${block.savedError}`]
  if (block.saved === undefined) return lines.length > 0 ? lines : ['Nothing more is known of it.']
  const names = glossary(ctx, block)
  const tail = names.length > 0 ? [`Names in the above, as the game shows them: ${names.join('; ')}`] : []
  const where = block.pathNotFound ? `There is nothing at "${block.path}" in its saved data. Its top level:` : block.path !== undefined ? `Its saved data under "${block.path}":` : `Its own saved data, whole${block.class ? ` (class ${block.class})` : ''}; the keys are its internal names, the values raw:`
  lines.push(where)
  const body = savedLines(block.saved)
  const cutNote = block.savedCut === true ? ['Where an entry says "ask for this path" or "more entr(ies)", that part was left out: give it as "path" (written like gt.covers or Inventory[3].tag).'] : []
  const used = (list: readonly string[]): number => list.reduce((n, line) => n + line.length + 1, 0)
  const total = used(body)
  const budget = room - used(lines) - used(cutNote) - used(tail)
  if (total <= budget) return [...lines, ...body, ...cutNote, ...tail]
  // 放不下：能放几项放几项，写明一共多长、每一项多长（照着大小挑一项用 path 往里看）
  const under = block.path !== undefined && !block.pathNotFound ? block.path : ''
  const sizes = body
    .map((line) => {
      const key = line.slice(2, line.indexOf(': '))
      return { path: under === '' ? key : key.startsWith('[') ? `${under}${key}` : `${under}.${key}`, chars: line.length }
    })
    .sort((a, b) => b.chars - a.chars)
  const index = `It is ${total} characters, more than fits here. One part of it whole: give one of these as "path" (path: characters) — ${sizes.slice(0, 40).map((s) => `${s.path}: ${s.chars}`).join(', ')}${sizes.length > 40 ? `, and ${sizes.length - 40} smaller ones` : ''}.`
  let left = budget - index.length - 1
  const shown: string[] = []
  for (const line of body) {
    if (line.length + 1 > left) {
      // 一项就放不下的，给个开头（至少看得出它是什么）
      if (left > 200) shown.push(`${line.slice(0, left - 60)}… (cut: ${line.length} characters)`)
      break
    }
    shown.push(line)
    left -= line.length + 1
  }
  return [...lines, index, ...shown, ...(shown.length < body.length ? [`… ${body.length - shown.length} more key(s) not shown.`] : []), ...cutNote, ...tail]
}

export const inspectBlock: Tool = {
  name: 'inspect_block',
  description:
    'What block is at a position: id, meta, air/solid/liquid, hardness, whether it holds data or an inventory, what its tanks hold, the covers on its faces and what they hold. "detail": also what it reports to a scanner and its own saved data, whole (internal key names, raw values).',
  inputSchema: obj(
    {
      x: int('x'),
      y: int('y', { min: 0, max: 255 }),
      z: int('z'),
      detail: bool(),
      path: str('One part of the saved data, in full, e.g. "gt.covers", "Inventory[3].tag".', { maxLength: 200 }),
    },
    ['x', 'y', 'z'],
  ),
  async run(ctx, input: BlockPos & { detail?: boolean; path?: string }): Promise<ToolResult> {
    const at = { x: input.x, y: input.y, z: input.z }
    const path = input.path?.trim()
    const deep = input.detail === true || (path !== undefined && path.length > 0)
    const block = await ctx.bridge.worldBlock(deep ? { ...at, detail: true, ...(path ? { path } : {}) } : at)
    // 游戏内指南里有讲这种方块的页：带一行页名和怎么读
    const item = itemOfBlock(ctx.packdata?.items, block)
    const page = item ? guideNote(ctx.packdata?.guide, item.id, item.meta) : undefined
    // 基地的做法里给这台机器记了用途的：带上那一条
    const method = methodNoteForMachine(ctx.methods, at)
    const head = `${describeBlock(at, block)}${page !== undefined ? `\nI${page.slice(1)}` : ''}${method !== undefined ? `\nI${method.slice(1)}` : ''}`
    // data：身体的原样回答（tanks、covers 在里面；要了 detail 时还有 says 和 saved，一个键不少）
    const data = { ...at, ...block }
    if (!deep || block.loaded === false || typeof block.id !== 'string') return { content: head, data }
    // 存档数据可以上万字符：自己按“单个工具结果上限”收，放不下的写明每一项多长、怎么用 path 往里看
    const room = (ctx.maxResultChars?.() ?? DEFAULT_RESULT_MAX_CHARS) - head.length - 1
    return { content: [head, ...describeDetail(ctx, block, room)].join('\n'), data, keepWhole: true }
  },
}

/** 库函数（不在发给模型的清单里）。data 是身体的原样回答（bot.probe）。 */
export const probeBlock: Tool = {
  name: 'probe_block',
  brief: '{x, y, z}: can you dig it, with what, how long -> canDig, digTicks, candidates[]',
  description:
    'Check whether you could dig a block right now: which of your tools would be used, how long it takes, and whether it is within reach. Use it before a digging task when you are unsure your tools can break that kind of block.',
  inputSchema: obj({ x: int('x'), y: int('y', { min: 0, max: 255 }), z: int('z') }, ['x', 'y', 'z']),
  async run(ctx, input: BlockPos): Promise<ToolResult | string> {
    const p = await ctx.bridge.botProbe(ctx.botName, input)
    const lines = [describeBlock(input, p)]
    if (p.loaded === false || typeof p.id !== 'string') return { content: lines[0]!, data: p }
    if (p.air) return { content: `${lines[0]!}\nNothing to dig there.`, data: p }
    // 工具挖得动也没用：服务器自己的保护不让你动这一格
    if (p.protection) return { content: `${lines[0]!}\nThe server refuses your hand on this block: ${protectionText(p.protection)}. Digging it, clicking it or placing against it ends in denied.`, data: p }
    const candidates = p.candidates ?? []
    // excluded：一次挖多格的工具（匠魂锤、挖掘铲、伐木斧等），身体不会用它们
    const usable = candidates.filter((c) => !c.excluded && c.harvest !== false && typeof c.ticks === 'number' && c.ticks > 0)
    if (p.canDig) {
      const tool = candidates.find((c) => c.slot === p.toolSlot)
      const seconds = typeof p.digTicks === 'number' ? ` in about ${(p.digTicks / 20).toFixed(2)} s (${p.digTicks} ticks)` : ''
      lines.push(`You can dig it${seconds} using ${tool ? (tool.slot < 0 ? 'your bare hand' : `${tool.item} (slot ${tool.slot})`) : 'what you carry'}.`)
    } else {
      lines.push(
        usable.length === 0
          ? 'You cannot dig it: nothing you carry can break this block. A digging task here would fail with no_tool.'
          : 'You cannot dig it right now.',
      )
    }
    if (p.inReach === false) lines.push('It is out of reach from where you stand (a task walks there by itself).')
    const others = candidates.filter((c) => c.slot !== p.toolSlot && typeof c.ticks === 'number')
    if (others.length > 0) {
      lines.push(
        `Other options: ${others
          .slice(0, 6)
          .map((c) => {
            const what = c.slot < 0 ? 'hand' : c.item
            if (c.excluded) return `${what} is never used (it breaks several blocks at once)`
            return `${what} ${c.harvest === false ? 'cannot harvest it' : `${c.ticks} ticks`}`
          })
          .join('; ')}`,
      )
    }
    return { content: lines.join('\n'), data: p }
  },
}

export const findBlocks: Tool = {
  name: 'find_blocks',
  description: `Find the nearest blocks of the given ids around you, or around a place you give ("at") (radius at most ${FIND_MAX_RADIUS}). Returns positions from nearest to farthest.`,
  inputSchema: obj(
    {
      ids: arr('Block ids, e.g. ["minecraft:chest", "minecraft:log"].', str('block id'), { min: 1, max: 16 }),
      radius: int('Search radius in blocks (default 24).', { min: 1, max: FIND_MAX_RADIUS }),
      at: AT,
    },
    ['ids'],
  ),
  async run(ctx, input: { ids: string[]; radius?: number; at?: At }) {
    const radius = input.radius ?? 24
    const from = await lookFrom(ctx, input.at)
    const res = await ctx.bridge.worldFind(from.center, { blocks: input.ids, radius, limit: 32 })
    const matches = res.matches ?? []
    if (matches.length === 0) return `No ${input.ids.join(' / ')} within ${radius} blocks of ${from.of}.${from.hint}`
    const total = res.total ?? matches.length
    const lines = matches.map(
      (m) => `${formatPos(m)} ${m.id}${m.meta ? `/${m.meta}` : ''}${typeof m.dist === 'number' ? ` — ${m.dist.toFixed(0)} away` : ''}`,
    )
    const more = total > matches.length ? ` (${total} in range, showing the nearest ${matches.length})` : ''
    return `Found ${matches.length}${more}, nearest ${input.at ? `to ${from.of} ` : ''}first:\n${lines.join('\n')}`
  },
}

export const getPlayerPosition: Tool = {
  name: 'get_player_position',
  description:
    'Where an online player stands right now, which way they face, what block their crosshair is on, and the containers in front of them: what "this", "that chest", "in front of me" point at. A chat message already carries the same for the moment it was sent.',
  inputSchema: obj({ player: str('Player name.') }, ['player']),
  async run(ctx, input: { player: string }): Promise<ToolResult | string> {
    try {
      const view = await ctx.bridge.worldPlayer(input.player)
      return { content: formatPlayerView(view.name ?? input.player, view), data: view }
    } catch (e) {
      // 老的身体没有 world.player：退回去只说位置
      if (!(e instanceof BridgeError) || (e.code !== 'unknown_method' && e.code !== 'not_found')) throw e
      const info = await ctx.bridge.serverInfo()
      const players = info.players ?? []
      const wanted = input.player.toLowerCase()
      const p = players.find((x) => x.name.toLowerCase() === wanted)
      if (!p) {
        const names = players.map((x) => x.name).join(', ')
        return fail(`${input.player} is not online. Online now: ${names || 'nobody'}`)
      }
      return `${p.name} is in ${dimName(p.dim)} at ${formatPos(p.pos)}.`
    }
  },
}
