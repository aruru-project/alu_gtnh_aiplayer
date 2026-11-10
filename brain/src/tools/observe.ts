import { BridgeError } from '../bridge/protocol.ts'
import type { BlockInfo, BlockPos } from '../bridge/protocol.ts'
import {
  compactJson,
  dimName,
  nameOf,
  formatContainer,
  formatEntities,
  formatPlayerView,
  formatPos,
  formatScan,
  formatStatus,
  formatTerrainSummary,
} from './format.ts'
import { arr, int, obj, str } from './schema.ts'
import { ToolFailure, fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'
import { AT, lookFrom } from './where.ts'
import type { At } from './where.ts'

// 协议里各方法的上限
export const SCAN_MAX_SIDE = 64
export const FIND_MAX_RADIUS = 48
export const FIND_MAX_LIMIT = 64
export const CONTAINERS_MAX_RADIUS = 32
export const ENTITIES_MAX_RADIUS = 64

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

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** world.block / bot.probe 共用的一行描述。 */
function describeBlock(pos: BlockPos, b: BlockInfo): string {
  if (b.loaded === false || typeof b.id !== 'string') {
    return `${formatPos(pos)}: unknown, that chunk is not loaded (nobody is near it). Go closer and look again.`
  }
  const flags = (['air', 'solid', 'liquid', 'replaceable', 'tileEntity', 'inventory'] as const).filter((k) => b[k] === true)
  let s = `${formatPos(pos)}: ${b.id}${b.meta ? `/${b.meta}` : ''}`
  const name = nameOf(b, { block: true })
  if (name) s += ` "${name}"`
  if (flags.length > 0) s += ` [${flags.join(', ')}]`
  if (typeof b.hardness === 'number') s += ` hardness ${b.hardness}${b.hardness < 0 ? ' (unbreakable)' : ''}`
  return s
}

export const getStatus: Tool = {
  name: 'get_status',
  description:
    'Your current state: position, health, food, held item, inventory (merged per item, written as count× id or id/meta), current task and queue.',
  inputSchema: obj({}),
  async run(ctx) {
    return formatStatus(await ctx.bridge.botStatus(ctx.botName))
  },
}

export const lookAround: Tool = {
  name: 'look_around',
  description:
    'Summary of what is near you, or near a place you give ("at"): players, mobs and dropped items, containers (chests, Storage Drawers and the like; drawers are marked [drawers]) with their main contents, and the lay of the land. Use scan_area for exact terrain heights and list_containers for full contents.',
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
      lines.push(`Entities: unavailable (${reason(entities.reason)})`)
    }

    if (containers.status === 'fulfilled') {
      const list = containers.value.containers ?? []
      const total = containers.value.total ?? list.length
      if (list.length === 0) {
        lines.push(`Containers: none${input.at ? '' : ' near you (to look around another place, give "at")'}`)
      } else {
        lines.push(`Containers (${total}):`)
        for (const c of list.slice(0, 12)) lines.push(`- ${formatContainer(c, 3)}`)
        if (total > 12) lines.push(`- … ${total - 12} more (use list_containers with a smaller radius)`)
      }
    } else {
      lines.push(`Containers: unavailable (${reason(containers.reason)})`)
    }

    if (scan.status === 'fulfilled') {
      lines.push(`Terrain within ${terrainR} blocks: ${formatTerrainSummary(scan.value)}`)
    } else {
      lines.push(`Terrain: unavailable (${reason(scan.reason)})`)
    }
    return lines.join('\n')
  },
}

export const scanArea: Tool = {
  name: 'scan_area',
  description: `Surface heights of a rectangle (any two opposite corners, at most ${SCAN_MAX_SIDE}×${SCAN_MAX_SIDE} columns). Up to 24×24 you get the exact height of every column; larger areas give a histogram and a downsampled grid. Use this before flattening or building to pick the right y level.`,
  inputSchema: obj(
    {
      x1: int('x of one corner'),
      z1: int('z of one corner'),
      x2: int('x of the opposite corner'),
      z2: int('z of the opposite corner'),
    },
    ['x1', 'z1', 'x2', 'z2'],
  ),
  async run(ctx, input: { x1: number; z1: number; x2: number; z2: number }) {
    const width = Math.abs(input.x2 - input.x1) + 1
    const depth = Math.abs(input.z2 - input.z1) + 1
    if (width > SCAN_MAX_SIDE || depth > SCAN_MAX_SIDE) {
      return fail(`area is ${width}×${depth}; at most ${SCAN_MAX_SIDE}×${SCAN_MAX_SIDE} per scan. Scan it in several pieces.`)
    }
    const scan = await ctx.bridge.worldScan(input)
    if (!Array.isArray(scan.heights)) return fail(`unexpected scan result: ${compactJson(scan)}`)
    return formatScan(scan)
  },
}

export const inspectBlock: Tool = {
  name: 'inspect_block',
  description: 'What block is at a position: id, meta, whether it is air/solid/liquid, hardness, and whether it holds data or an inventory.',
  inputSchema: obj({ x: int('x'), y: int('y', { min: 0, max: 255 }), z: int('z') }, ['x', 'y', 'z']),
  async run(ctx, input: BlockPos) {
    return describeBlock(input, await ctx.bridge.worldBlock(input))
  },
}

export const probeBlock: Tool = {
  name: 'probe_block',
  description:
    'Check whether you could dig a block right now: which of your tools would be used, how long it takes, and whether it is within reach. Use it before a digging task when you are unsure your tools can break that kind of block.',
  inputSchema: obj({ x: int('x'), y: int('y', { min: 0, max: 255 }), z: int('z') }, ['x', 'y', 'z']),
  async run(ctx, input: BlockPos) {
    const p = await ctx.bridge.botProbe(ctx.botName, input)
    const lines = [describeBlock(input, p)]
    if (p.loaded === false || typeof p.id !== 'string') return lines[0]!
    if (p.air) return `${lines[0]!}\nNothing to dig there.`
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
    return lines.join('\n')
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
    'Where an online player stands, which way they face, what block their crosshair is on, and the containers in front of them. Use it when your owner says "this", "that chest", "in front of me" and the message did not already say what they were pointing at.',
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
