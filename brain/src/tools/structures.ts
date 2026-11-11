// 多方块机器的结构（玩家说的“投影”）：一台多方块有哪些等级、每个等级怎么搭、要哪些方块，两个等级之间差什么；
// 以及对着世界里现成的那台比——哪些位置现在是什么、要换成什么，材料还差多少。
// 数据是本地的 structures.jsonl（packdata/structures.ts）；世界里的方块用 world.blocks 读。
//
// 这里的三个都是**库函数**（见 tools/index.ts 的 LIBRARY_TOOLS）：不在每一轮发给模型的工具清单里，在它写的程序里调
// （await tool('find_structure', …)）；模型直接调了也照常执行。结构数据本身在程序里也能直接拿（data.structure），
// 模型想自己算等级差异、自己对世界时用得上。
//
// 对着世界比的规矩：
//   - 结构数据里主机一律朝南；世界里那台朝哪不知道，四个水平朝向各对一遍，挑对得最上的。
//   - 各种仓、总线、主机在世界里是同一个方块（gregtech:gt.blockmachines），分不出是哪一种：
//     预览里是机器零件的位置，世界里是任何机器零件都算对；预览里是机械方块、世界里是机器零件（主人在那里放了仓）也算对，不算要换。

import { BridgeError } from '../bridge/protocol.ts'
import type { InventoryItem } from '../bridge/protocol.ts'
import { StructureBook, structureCells } from '../packdata/index.ts'
import type { ItemTable, Structure, StructurePart, StructureRow } from '../packdata/index.ts'
import { formatPos, itemKey, nameOf } from './format.ts'
import { guideNote } from './guide.ts'
import { spread, whereItStands } from './recipe-book.ts'
import { int, obj, str } from './schema.ts'
import { pos } from './tasks.ts'
import { fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const GT_MACHINES = 'gregtech:gt.blockmachines'
const TIERS_IN_FULL = 4
const TIERS_LISTED = 20
const NOTES_SHOWN = 24
const EXAMPLES = 5
const MATCHES_LISTED = 12
const NO_DATA = 'There is no multiblock structure data on this brain (packdata/structures.jsonl), so structures cannot be looked up. Say so to your owner; the machine\'s tooltip in the game (hold Shift) has its structure notes.'

const partName = (p: StructurePart): string => nameOf({ id: p.id, meta: p.meta }) ?? p.name ?? itemKey(p)
const partLabel = (p: StructurePart): string => `${partName(p)} [${itemKey(p)}]`
const sameItem = (a: StructurePart, b: StructurePart): boolean => a.id === b.id && a.meta === b.meta
const tiersText = (tiers: readonly number[]): string => (tiers.length === 1 ? `tier ${tiers[0]}` : `tiers ${tiers[0]}–${tiers.at(-1)}`)
const materials = (blocks: readonly (StructurePart & { n: number })[]): string => blocks.map((b) => `${b.n}× ${partLabel(b)}`).join(', ') || 'nothing'
const sameShape = (a: StructureRow, b: StructureRow): boolean => a.size.every((n, i) => n === b.size[i]) && a.controller.every((n, i) => n === b.controller[i])

/** 说明文字里对搭建没用的几行（分隔线、“按住 Shift”、每台机器都有的那几句）。 */
const noise = (line: string): boolean => /^-{5,}$/.test(line.trim()) || /LSHIFT|全息投影仪来查看|可共享其侧面方块|以节省方块/.test(line) || line.trim() === '结构:'

/** 两个等级之间差什么：同样大小时一格一格比（“69× 镀铜砖块 → 脱氧钢机械方块”），大小不一样时只能比材料清单。 */
export function tierDifference(from: StructureRow, to: StructureRow): string[] {
  if (sameShape(from, to)) {
    const a = structureCells(from)
    const b = structureCells(to)
    const moves = new Map<string, { from: StructurePart | undefined; to: StructurePart | undefined; n: number }>()
    for (let i = 0; i < a.length; i++) {
      const was = a[i] === 0 ? undefined : from.palette[a[i]!]
      const now = b[i] === 0 ? undefined : to.palette[b[i]!]
      if ((was === undefined && now === undefined) || (was && now && sameItem(was, now))) continue
      const key = `${was ? itemKey(was) : ''}>${now ? itemKey(now) : ''}`
      const seen = moves.get(key)
      if (seen) seen.n++
      else moves.set(key, { from: was, to: now, n: 1 })
    }
    return [...moves.values()]
      .sort((x, y) => y.n - x.n)
      .map((m) => (m.from && m.to ? `${m.n}× ${partName(m.from)} → ${partLabel(m.to)}` : m.to ? `${m.n}× more ${partLabel(m.to)} (where there was nothing)` : `${m.n}× ${partName(m.from!)} removed`))
  }
  const count = (row: StructureRow): Map<string, StructurePart & { n: number }> => new Map(row.blocks.map((b) => [itemKey(b), b]))
  const a = count(from)
  const b = count(to)
  const out: string[] = [`the shape changes: ${from.size.join('×')} → ${to.size.join('×')}`]
  for (const [key, now] of b) {
    const was = a.get(key)?.n ?? 0
    if (now.n > was) out.push(`${now.n - was}× more ${partLabel(now)}`)
  }
  for (const [key, was] of a) {
    const now = b.get(key)?.n ?? 0
    if (was.n > now) out.push(`${was.n - now}× fewer ${partName(was)}`)
  }
  return out
}

interface StructureQuery {
  name?: string
  id?: string
  meta?: number
}

/**
 * 按名字找机器：中文名（结构数据里的）和英文名（物品表里这台主机的 en）都认，问的每个词都要在其中一个名字里。
 * 名字正好是它的排前面。
 */
function searchMachines(book: StructureBook, items: ItemTable | undefined, name: string): { hits: Structure[]; exact: Structure[] } {
  const whole = name.trim().toLowerCase()
  const words = whole.split(/\s+/).filter((w) => w.length > 0)
  const names = (m: Structure): string[] => [m.name.toLowerCase(), (items?.get(m.id, m.meta)?.en ?? '').toLowerCase()].filter((n) => n.length > 0)
  const exact = book.machines.filter((m) => names(m).includes(whole))
  const partial = book.machines.filter((m) => !exact.includes(m) && names(m).some((n) => words.every((w) => n.includes(w))))
  return { hits: [...exact, ...partial], exact }
}

/** 找到问的是哪台机器；找不到、有好几台重名时返回给模型的一段话。 */
function resolve(book: StructureBook, q: StructureQuery, items?: ItemTable): Structure | ToolResult | string {
  if (q.id !== undefined) {
    const machine = book.get(q.id.trim(), q.meta ?? 0)
    return machine ?? fail(`No multiblock structure is known for ${itemKey({ id: q.id.trim(), meta: q.meta ?? 0 })}. It has to be the controller of a multiblock machine: search by "name" instead, or get the id and meta with find_item.`)
  }
  if (q.name === undefined || q.name.trim().length === 0) return fail('Give "name" (the machine\'s name, or part of it) or "id" and "meta" of its controller.')
  const { hits, exact } = searchMachines(book, items, q.name)
  if (hits.length === 0) return fail(`No multiblock machine whose Chinese or English name contains "${q.name.trim()}" is in the structure data. Try a shorter part of the name, or find the controller with find_item and give its id and meta.`)
  if (exact.length === 1) return exact[0]!
  if (hits.length === 1) return hits[0]!
  const lines = hits.slice(0, MATCHES_LISTED).map((m) => `- ${m.name} [${itemKey(m)}], ${StructureBook.tiersOf(m).length} tier(s)`)
  return `${hits.length} multiblock machines match "${q.name.trim()}"${exact.length > 1 ? ' (several machines share that very name)' : ''}. Ask again with the id and meta of the one you mean:\n${lines.join('\n')}${hits.length > MATCHES_LISTED ? `\n- … and ${hits.length - MATCHES_LISTED} more: narrow the name` : ''}`
}

function rowLine(row: StructureRow): string {
  return `${tiersText(row.tiers)[0]!.toUpperCase()}${tiersText(row.tiers).slice(1)} — ${row.size.join('×')} blocks (x×y×z): ${materials(row.blocks)}`
}

export const findStructure: Tool = {
  name: 'find_structure',
  brief: '{name | id, meta, tier?, from?}: how a multiblock is built -> tiers, rows[{size, blocks}]',
  description:
    'How a multiblock machine is built (what players see as its hologram projection): its tiers, the size and the list of blocks of each tier, the machine\'s own structure notes, and what changes from one tier to another. Give the machine by name or by the id and meta of its controller; "tier" for one tier in full, "from" and "tier" for the difference between two. To compare with a machine that already stands in the world use check_structure.',
  inputSchema: obj({
    name: str('The machine\'s name or part of it, Chinese or English, e.g. "大型蒸汽离心机".', { maxLength: 80 }),
    id: str('Instead of "name": the item id of its controller.'),
    meta: int('With "id": the controller\'s meta.', { min: 0 }),
    tier: int('One tier in full; with "from", the tier to change to.', { min: 1 }),
    from: int('With "tier": the tier it has now. Returns what changes between the two.', { min: 1 }),
  }),
  async run(ctx: ToolContext, i: StructureQuery & { tier?: number; from?: number }): Promise<ToolResult | string> {
    const book = ctx.packdata?.structures
    if (!book) return fail(NO_DATA)
    const machine = resolve(book, i, ctx.packdata?.items)
    if (typeof machine === 'string' || 'content' in machine) return machine
    const tiers = StructureBook.tiersOf(machine)
    const head = `${machine.name} [${itemKey(machine)}]`
    const rowOf = (tier: number): StructureRow | ToolResult => StructureBook.rowOf(machine, tier) ?? fail(`${head} has no tier ${tier}: its tiers are ${tiers.join(', ')}.`)
    const data = { id: machine.id, meta: machine.meta, name: machine.name, tiers, rows: machine.rows.map((r) => ({ tiers: r.tiers, size: r.size, blocks: r.blocks })) }

    if (i.from !== undefined && i.tier === undefined) return fail('"from" goes with "tier": the tier it has now, and the tier to change to.')
    if (i.tier !== undefined) {
      const to = rowOf(i.tier)
      if ('content' in to) return to
      if (i.from === undefined) return { content: `${head}, ${rowLine(to)}`, data, keepWhole: true }
      const from = rowOf(i.from)
      if ('content' in from) return from
      if (from === to) return { content: `${head}: tiers ${i.from} and ${i.tier} are built the same way; nothing changes.`, data, keepWhole: true }
      return { content: [`${head}, tier ${i.from} → tier ${i.tier}:`, ...tierDifference(from, to).map((d) => `- ${d}`), `Tier ${i.tier} in all: ${materials(to.blocks)}`].join('\n'), data, keepWhole: true }
    }

    const lines: string[] = [`${head}: a multiblock machine with ${tiers.length} tier(s)${tiers.length > 1 ? ` (${tiers[0]}–${tiers.at(-1)}; the tier is how many Multiblock Structure Hologram Projectors are stacked when it is built)` : ''}.`]
    const about = machine.info.filter((l) => !noise(l))
    if (about.length > 0) lines.push(`About it: ${about.slice(0, 8).join(' | ')}`)
    // 游戏内指南里有讲这台机器的页：带一行页名和怎么读
    const page = guideNote(ctx.packdata?.guide, machine.id, machine.meta)
    if (page !== undefined) lines.push(`I${page.slice(1)}`)
    const notes = machine.structureInfo.filter((l) => !noise(l))
    if (notes.length > 0) {
      lines.push('How it is built (the machine\'s own notes; "任意机械方块" means that part may replace any casing):')
      lines.push(...notes.slice(0, NOTES_SHOWN).map((l) => `- ${l}`))
      if (notes.length > NOTES_SHOWN) lines.push(`- … ${notes.length - NOTES_SHOWN} more line(s)`)
    }
    if (machine.rows.length <= TIERS_IN_FULL) {
      for (const row of machine.rows) lines.push(rowLine(row))
      for (let n = 1; n < machine.rows.length; n++) {
        const from = machine.rows[n - 1]!
        const to = machine.rows[n]!
        lines.push(`From tier ${from.tiers.at(-1)} to tier ${to.tiers[0]}: ${tierDifference(from, to).join('; ')}`)
      }
    } else {
      // 等级很多（高炉每种线圈一级）：把每级都一样的和随等级变的分开说
      const first = machine.rows[0]!
      const common = first.blocks.filter((b) => machine.rows.every((r) => r.blocks.some((x) => sameItem(x, b) && x.n === b.n)))
      const shapes = new Set(machine.rows.map((r) => r.size.join('×')))
      lines.push(`${machine.rows.length} different builds. ${shapes.size === 1 ? `Every tier is ${first.size.join('×')} blocks (x×y×z)` : 'The size grows with the tier'}. The same in every tier: ${materials(common)}.`)
      lines.push('What changes with the tier:')
      for (const row of machine.rows.slice(0, TIERS_LISTED)) {
        const own = row.blocks.filter((b) => !common.some((c) => sameItem(c, b)))
        lines.push(`- ${tiersText(row.tiers)}${shapes.size === 1 ? '' : ` (${row.size.join('×')})`}: ${materials(own)}`)
      }
      if (machine.rows.length > TIERS_LISTED) lines.push(`- … ${machine.rows.length - TIERS_LISTED} more: ask for one with "tier"`)
    }
    lines.push('Give "tier" for one tier in full, "from" and "tier" for what changes between two. check_structure compares a machine standing in the world with a tier.')
    return { content: lines.join('\n'), data, keepWhole: true }
  },
}

// ── 对着世界里现成的那台比 ──

export type Facing = 'south' | 'west' | 'north' | 'east'
const FACINGS: readonly Facing[] = ['south', 'west', 'north', 'east']

interface At {
  x: number
  y: number
  z: number
}

export interface StructureChange extends At {
  /** 现在是什么；null 是空的。 */
  from: { id: string; meta: number } | null
  to: StructurePart
}

export interface StructureComparison {
  machine: Structure
  tier: number
  row: StructureRow
  /** 世界里那台主机的正面朝哪。 */
  facing: Facing
  /** 这个等级一共多少格有方块、其中多少格已经对了。 */
  total: number
  right: number
  /** 其中预览是机械方块、世界里是机器零件（仓、总线）的。 */
  hatches: number
  changes: StructureChange[]
  /** 它现在最像哪个等级（同样大小的等级里对得最上的）。 */
  looksLike: { tiers: number[]; right: number; total: number }
  unloaded: number
}

/** 结构数据里的一格（主机朝南）在世界里的位置：绕主机转 k 个直角（南 → 西 → 北 → 东）。 */
function place(row: StructureRow, at: At, k: number, x: number, y: number, z: number): At {
  const dx = x - row.controller[0]
  const dz = z - row.controller[2]
  const [wx, wz] = k === 0 ? [dx, dz] : k === 1 ? [-dz, dx] : k === 2 ? [-dx, -dz] : [dz, -dx]
  return { x: at.x + wx, y: at.y + (y - row.controller[1]), z: at.z + wz }
}

interface WorldBox {
  min: At
  size: At
  palette: { id: string; meta: number }[]
  cells: Uint16Array
  unloaded: number
}

/** 读世界里一个盒子的方块（world.blocks），展开成每格一个调色板下标。 */
async function readBox(ctx: ToolContext, a: At, b: At, dim: number | undefined): Promise<WorldBox> {
  const min = { x: Math.min(a.x, b.x), y: Math.max(0, Math.min(a.y, b.y)), z: Math.min(a.z, b.z) }
  const max = { x: Math.max(a.x, b.x), y: Math.min(255, Math.max(a.y, b.y)), z: Math.max(a.z, b.z) }
  const raw = (await ctx.bridge.worldBlocks({ x1: min.x, y1: min.y, z1: min.z, x2: max.x, y2: max.y, z2: max.z, ...(dim !== undefined ? { dim } : {}) })) as unknown as {
    palette?: { id?: string; meta?: number }[]
    runs?: number[]
    unloaded?: number
  }
  const size = { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 }
  const cells = new Uint16Array(size.x * size.y * size.z)
  const runs = raw.runs ?? []
  let at = 0
  for (let i = 0; i + 1 < runs.length && at < cells.length; i += 2) {
    const count = Math.min(runs[i + 1]!, cells.length - at)
    if (runs[i] !== 0) cells.fill(runs[i]!, at, at + count)
    at += count
  }
  return { min, size, palette: (raw.palette ?? []).map((p) => ({ id: typeof p.id === 'string' ? p.id : '?', meta: typeof p.meta === 'number' ? p.meta : 0 })), cells, unloaded: raw.unloaded ?? 0 }
}

function blockAt(box: WorldBox, p: At): { id: string; meta: number } | null {
  const x = p.x - box.min.x
  const y = p.y - box.min.y
  const z = p.z - box.min.z
  if (x < 0 || y < 0 || z < 0 || x >= box.size.x || y >= box.size.y || z >= box.size.z) return null
  const index = box.cells[(y * box.size.z + z) * box.size.x + x]!
  return index === 0 ? null : (box.palette[index] ?? null)
}

/** 流着的水和岩浆是另一个方块 id。 */
const still = (id: string): string => id.replace(':flowing_', ':')

/** 世界里这一格算不算对：same 是同一种方块，hatch 是机器零件占着机械方块的位置。 */
function fits(want: StructurePart, got: { id: string; meta: number } | null): 'same' | 'hatch' | undefined {
  if (!got) return undefined
  if (still(got.id) === still(want.id)) return want.id === GT_MACHINES || got.meta === want.meta ? 'same' : undefined
  return got.id === GT_MACHINES ? 'hatch' : undefined
}

function compare(row: StructureRow, at: At, k: number, box: WorldBox): { total: number; right: number; hatches: number; changes: StructureChange[] } {
  const cells = structureCells(row)
  const [sx, sy, sz] = row.size
  const out = { total: 0, right: 0, hatches: 0, changes: [] as StructureChange[] }
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const index = cells[(y * sz + z) * sx + x]!
        if (index === 0) continue
        const want = row.palette[index]!
        const where = place(row, at, k, x, y, z)
        const got = blockAt(box, where)
        const fit = fits(want, got)
        out.total++
        if (fit) {
          out.right++
          if (fit === 'hatch') out.hatches++
        } else out.changes.push({ ...where, from: got, to: want })
      }
    }
  }
  return out
}

/** 把世界里 at 那台主机周围的方块，和这台机器 tier 等级的结构对一遍。 */
export async function compareStructure(ctx: ToolContext, at: At, machine: Structure, tier: number): Promise<StructureComparison> {
  const row = StructureBook.rowOf(machine, tier)!
  const status = await ctx.bridge.botStatus(ctx.botName)
  const dim = status.online === false ? undefined : status.dim
  // 同样大小的几个等级一起比：既挑朝向，也看它现在最像哪一级
  const rows = machine.rows.filter((r) => sameShape(r, row))
  const corners = (k: number): [At, At] => [place(row, at, k, 0, 0, 0), place(row, at, k, row.size[0] - 1, row.size[1] - 1, row.size[2] - 1)]
  const boxes = await Promise.all([0, 1, 2, 3].map((k) => readBox(ctx, ...corners(k), dim)))
  let best = { k: 0, score: -1, row }
  for (let k = 0; k < 4; k++) {
    for (const r of rows) {
      const got = compare(r, at, k, boxes[k]!)
      const score = got.total > 0 ? got.right / got.total : 0
      if (score > best.score) best = { k, score, row: r }
    }
  }
  const target = compare(row, at, best.k, boxes[best.k]!)
  const now = compare(best.row, at, best.k, boxes[best.k]!)
  return { machine, tier, row, facing: FACINGS[best.k]!, ...target, looksLike: { tiers: best.row.tiers, right: now.right, total: now.total }, unloaded: boxes[best.k]!.unloaded }
}

/** 这些方块身上有多少、周围的箱子和抽屉里有多少（和 plan_item 看库存一样，往四周错开几个点各查一次）。 */
async function onHand(ctx: ToolContext, parts: readonly StructurePart[]): Promise<Map<string, { carried: number; stored: number }>> {
  const out = new Map<string, { carried: number; stored: number }>(parts.map((p) => [itemKey(p), { carried: 0, stored: 0 }]))
  if (parts.length === 0) return out
  const status = await ctx.bridge.botStatus(ctx.botName)
  for (const it of (status.inventory ?? []) as InventoryItem[]) {
    const have = out.get(itemKey({ id: it.id, meta: it.meta ?? 0 }))
    if (have) have.carried += it.count ?? 1
  }
  const me = await whereItStands(ctx)
  if (!me) return out
  const answers = await Promise.all(spread(me, 48).map((c) => ctx.bridge.worldStock(c, { items: parts.map((p) => ({ id: p.id, meta: p.meta })), radius: 64 })))
  parts.forEach((p, n) => {
    // 四个点各自的答案里同一个容器会重：按位置只算一次
    const places = new Map<string, number>()
    for (const res of answers) for (const place of res.items?.[n]?.places ?? []) places.set(`${place.x},${place.y},${place.z}`, place.count)
    out.get(itemKey(p))!.stored = [...places.values()].reduce((a, b) => a + b, 0)
  })
  return out
}

/** check_structure / plan_item 要用的那台机器：给了 id 就是它；没给就问身体 at 那里是哪台多方块主机。 */
export async function structureAt(ctx: ToolContext, book: StructureBook, at: At, given: { id?: string; meta?: number }): Promise<Structure | ToolResult> {
  if (given.id !== undefined) {
    return book.get(given.id.trim(), given.meta ?? 0) ?? fail(`No multiblock structure is known for ${itemKey({ id: given.id.trim(), meta: given.meta ?? 0 })}. Find the machine with find_structure first.`)
  }
  const status = await ctx.bridge.botStatus(ctx.botName)
  const near = await ctx.bridge.worldMachines({ ...at, ...(status.online !== false && status.dim !== undefined ? { dim: status.dim } : {}) }, { radius: 1, limit: 20 })
  const here = (near.machines ?? []).find((m) => m.x === at.x && m.y === at.y && m.z === at.z)
  if (!here || here.id === undefined) {
    return fail(`There is no multiblock controller the body recognises at ${formatPos(at)}. Give the position of the controller block itself (find_machines lists it), or say which machine it is with "id" and "meta" (find_structure).`)
  }
  return book.get(here.id, here.meta ?? 0) ?? fail(`The ${nameOf(here) ?? 'machine'} at ${formatPos(at)} [${itemKey({ id: here.id, meta: here.meta ?? 0 })}] is not in the structure data.`)
}

export const checkStructure: Tool = {
  name: 'check_structure',
  brief: '{at, tier}: a standing multiblock against a tier -> facing, changes[], need[]',
  description:
    'Compare a multiblock machine that stands in the world with how one of its tiers is built: which positions hold what now and what they have to become, and how many of each block that takes against what you carry and what is in storage. Give the position of its controller and the tier you want (for an upgrade: the new tier). Buses and hatches standing where the projection shows a casing count as right.',
  inputSchema: obj(
    {
      at: pos('Position of the controller block of the machine.'),
      tier: int('The tier to compare with.', { min: 1 }),
      id: str('Which machine it is (item id of the controller). Only needed when the body does not recognise the controller.'),
      meta: int('With "id": the controller\'s meta.', { min: 0 }),
    },
    ['at', 'tier'],
  ),
  async run(ctx: ToolContext, i: { at: At; tier: number; id?: string; meta?: number }): Promise<ToolResult | string> {
    const book = ctx.packdata?.structures
    if (!book) return fail(NO_DATA)
    const machine = await structureAt(ctx, book, i.at, i)
    if ('content' in machine) return machine
    if (!StructureBook.rowOf(machine, i.tier)) return fail(`${machine.name} has no tier ${i.tier}: its tiers are ${StructureBook.tiersOf(machine).join(', ')}.`)
    const c = await compareStructure(ctx, i.at, machine, i.tier)
    const lines: string[] = [
      `${machine.name} at ${formatPos(i.at)}: its front faces ${c.facing}. Right now it looks like ${tiersText(c.looksLike.tiers)} (${c.looksLike.right} of ${c.looksLike.total} blocks of that build are in place).`,
      c.changes.length === 0
        ? `It already is a complete tier ${i.tier}: all ${c.total} blocks are in place.`
        : `Against tier ${i.tier}: ${c.right} of ${c.total} positions are already right, ${c.changes.length} have to change.`,
    ]
    if (c.hatches > 0) lines.push(`(${c.hatches} position(s) hold a machine part — a bus, a hatch — where the projection shows a casing: they count as right and stay.)`)
    if (c.unloaded > 0) lines.push(`(${c.unloaded} block(s) are in chunks that are not loaded and were read as unknown: go closer and check again.)`)
    // 世界里的方块没有名字：是这台机器别的等级用的方块时，用结构数据里的名字
    const known = new Map(machine.rows.flatMap((r) => r.palette).map((p) => [itemKey(p), p]))
    const worldName = (b: { id: string; meta: number }): string => nameOf(b, { block: true }) ?? known.get(itemKey(b))?.name ?? itemKey(b)
    // 按“现在是什么 → 要换成什么”归组
    const groups = new Map<string, { from: StructureChange['from']; to: StructurePart; at: At[] }>()
    for (const ch of c.changes) {
      const key = `${ch.from ? itemKey(ch.from) : ''}>${itemKey(ch.to)}`
      const g = groups.get(key)
      if (g) g.at.push(ch)
      else groups.set(key, { from: ch.from, to: ch.to, at: [ch] })
    }
    if (groups.size > 0) lines.push('To change:')
    for (const g of [...groups.values()].sort((a, b) => b.at.length - a.at.length)) {
      const was = g.from ? `${worldName(g.from)} [${itemKey(g.from)}]` : 'nothing (empty)'
      const where = g.at.slice(0, EXAMPLES).map(formatPos).join(' ')
      lines.push(`- ${g.at.length}× ${was} → ${partLabel(g.to)}, at ${where}${g.at.length > EXAMPLES ? ` … (${g.at.length - EXAMPLES} more)` : ''}`)
    }
    // 材料：要几个、身上几个、仓库里几个、还差几个
    const need = new Map<string, StructurePart & { count: number }>()
    for (const ch of c.changes) {
      const n = need.get(itemKey(ch.to))
      if (n) n.count++
      else need.set(itemKey(ch.to), { ...ch.to, count: 1 })
    }
    const have = await onHand(ctx, [...need.values()]).catch((e: unknown) => {
      if (e instanceof BridgeError) return undefined
      throw e
    })
    const needs = [...need.values()].map((n) => {
      const h = have?.get(itemKey(n))
      return { id: n.id, meta: n.meta, name: partName(n), count: n.count, ...(h ? { carried: h.carried, stored: h.stored, short: Math.max(0, n.count - h.carried - h.stored) } : {}) }
    })
    if (needs.length > 0) {
      lines.push('Blocks that takes:')
      for (const n of needs) {
        lines.push(`- ${n.count}× ${n.name} [${itemKey(n)}]${n.short === undefined ? '' : `: you carry ${n.carried}, storage has ${n.stored} — ${n.short > 0 ? `${n.short} SHORT` : 'enough'}`}`)
      }
      const freed = new Map<string, { name: string; n: number }>()
      for (const ch of c.changes) {
        if (!ch.from) continue
        const f = freed.get(itemKey(ch.from))
        if (f) f.n++
        else freed.set(itemKey(ch.from), { name: worldName(ch.from), n: 1 })
      }
      if (freed.size > 0) lines.push(`Taken out in exchange: ${[...freed.values()].map((f) => `${f.n}× ${f.name}`).join(', ')}.`)
      lines.push('Every position is in the result data (data.changes: x, y, z, from, to; data.need: the blocks). How to get a missing block made: crafting manual; how to put them in place: multiblocks manual.')
    }
    return {
      content: lines.join('\n'),
      data: { machine: { id: machine.id, meta: machine.meta, name: machine.name }, tier: i.tier, facing: c.facing, looksLike: c.looksLike.tiers, total: c.total, right: c.right, changes: c.changes, need: needs },
      keepWhole: true,
    }
  },
}

/** 读世界里一个盒子的全部方块（world.blocks）：程序自己对结构、数方块时用。 */
export const readBlocks: Tool = {
  name: 'read_blocks',
  brief: '{x1, y1, z1, x2, y2, z2}: every block of a box -> palette[], cells[]',
  description: 'Every block of a box of the world (two opposite corners, each side at most 64). In a program: data is { x, y, z, sx, sy, sz, palette: [{ id, meta, name }], cells } where the box starts at (x, y, z), cells[(dy * sz + dz) * sx + dx] is an index into palette, and palette[0] is air.',
  inputSchema: obj(
    { x1: int('x of one corner'), y1: int('y of one corner', { min: 0, max: 255 }), z1: int('z of one corner'), x2: int('x of the opposite corner'), y2: int('y of the opposite corner', { min: 0, max: 255 }), z2: int('z of the opposite corner') },
    ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'],
  ),
  async run(ctx: ToolContext, i: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }): Promise<ToolResult | string> {
    const sides = [Math.abs(i.x2 - i.x1) + 1, Math.abs(i.y2 - i.y1) + 1, Math.abs(i.z2 - i.z1) + 1]
    if (sides.some((n) => n > 64)) return fail(`The box is ${sides.join('×')} (x × y × z); each side can be at most 64. Read it in several pieces.`)
    const status = await ctx.bridge.botStatus(ctx.botName)
    const box = await readBox(ctx, { x: i.x1, y: i.y1, z: i.z1 }, { x: i.x2, y: i.y2, z: i.z2 }, status.online === false ? undefined : status.dim)
    const palette = box.palette.map((p, n) => (n === 0 ? { id: 'minecraft:air', meta: 0 } : { ...p, ...(nameOf(p, { block: true }) ? { name: nameOf(p, { block: true })! } : {}) }))
    const counts = new Map<number, number>()
    for (const index of box.cells) if (index !== 0) counts.set(index, (counts.get(index) ?? 0) + 1)
    const kinds = [...counts].sort((a, b) => b[1] - a[1])
    const listed = kinds.slice(0, 12).map(([index, n]) => `${n}× ${palette[index]?.name ?? ''} [${itemKey(palette[index] ?? { id: '?', meta: 0 })}]`.replace('×  [', '× ['))
    return {
      content: `${box.size.x}×${box.size.y}×${box.size.z} blocks (x×y×z) from ${formatPos(box.min)}: ${kinds.length === 0 ? 'all air' : listed.join(', ')}${kinds.length > 12 ? `, and ${kinds.length - 12} more kinds` : ''}.${box.unloaded > 0 ? ` ${box.unloaded} block(s) are in chunks that are not loaded.` : ''} Every block is in the result data, for a program.`,
      data: { x: box.min.x, y: box.min.y, z: box.min.z, sx: box.size.x, sy: box.size.y, sz: box.size.z, palette, cells: Array.from(box.cells), unloaded: box.unloaded },
      keepWhole: true,
    }
  },
}
