// 配方册的本地一条路：找物品、查做法（NEI 的 R）、查用途（NEI 的 U），以及把一条配方变成合成 / 加工任务的参数。
// 数据是本地资料里的物品表和配方册（packdata/），不问服务器；只有“基地里现在做得了哪些”要看一眼附近的机器和工作台。
//
// 同一个物品常有很多条配方：不同的加工方式耗料不同，工具类每种材质各有一条。所以先按配方页（一种加工方式）汇总，
// 算清每个成品耗多少料、要什么电压、附近有没有能做的机器，再让模型按方式、按原料筛选和翻页看具体的。
// 结果是给模型看的：说明用英文，物品名是物品表里的中文名。

import { BridgeError } from '../bridge/protocol.ts'
import type { AttachedBlock, ContainerInfo, FindMatch, InventoryItem, MachineInfo } from '../bridge/protocol.ts'
import { ANY_META, CIRCUIT_ID } from '../packdata/index.ts'
import type { CarvingBook, PackData, Recipe, RecipeBook, RecipeHandler, RecipeSlot } from '../packdata/index.ts'
import type { ItemTable, PackItemInfo } from '../packdata/items.ts'
import { CHISEL_WAY, chiselData, chiselDetail, chiselMatches, chiselSummary, isChiselWay } from './chisel.ts'
import { formatPos, itemKey, nameOf } from './format.ts'
import { fail } from './types.ts'
import type { ToolContext, ToolResult } from './types.ts'

export const RECIPES_PER_PAGE = 10
export const ITEMS_PER_PAGE = 12
/** 汇总里一种方式下最多直接列几条配方；再多的只举例，让它筛。 */
const WAY_RECIPES_SHOWN = 3
const WAYS_SHOWN = 20
const USE_WAYS_SHOWN = 30
// 基地常常比身体一次查询的范围大（仓库在这头，高炉在那头，隔着六七十格）。所以看“基地里有什么”时，
// 以它站的地方为中心、往四个方向各错开一点各查一次，合起来看：下面的 REACH 是这样合起来每个方向看得到多远。
/** 身体的 world.machines 一次最多看 64 格、world.find 一次最多看 48 格。 */
const MACHINES_QUERY_RADIUS = 64
const MACHINES_QUERY_STEP = 48
export const TABLES_RADIUS = 48
const TABLES_QUERY_STEP = 40
export const MACHINES_REACH = MACHINES_QUERY_STEP + MACHINES_QUERY_RADIUS
export const TABLES_REACH = TABLES_QUERY_STEP + TABLES_RADIUS
/** 有 3×3 合成格、身体不给 table 时会自己去找的方块（和 mod 的 CraftTask.TABLES 是同一张表）。 */
export const CRAFTING_TABLES = ['minecraft:crafting_table', 'TConstruct:CraftingStation', 'TConstruct:CraftingSlab', 'Natura:Natura.workbench']

// GregTech 的电压等级：每刻耗电不超过这个数的配方，这一级的机器做得了
const TIERS: readonly [string, number][] = [
  ['ULV', 8],
  ['LV', 32],
  ['MV', 128],
  ['HV', 512],
  ['EV', 2048],
  ['IV', 8192],
  ['LuV', 32768],
  ['ZPM', 131072],
  ['UV', 524288],
  ['UHV', 2097152],
  ['UEV', 8388608],
  ['UIV', 33554432],
  ['UMV', 134217728],
  ['UXV', 536870912],
  ['MAX', 2147483647],
]

/** 每刻耗这么多电的配方最低要哪一级的机器。 */
export function tierOf(eut: number): string {
  return (TIERS.find(([, volts]) => eut <= volts) ?? TIERS[TIERS.length - 1]!)[0]
}

function voltsOf(tier: string | undefined): number | undefined {
  return TIERS.find(([name]) => name === tier)?.[1]
}

/** 数量：整数照写，不是整数的留两位小数。 */
export function quantity(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)
}

function seconds(ticks: number): string {
  return `${quantity(Math.round(ticks / 2) / 10)} s`
}

// ── 名字 ──

export interface Namer {
  /** 中文名；物品表里没有就是 id/meta。 */
  name(id: string, meta: number): string
  /** "钢板 [gregtech:gt.metaitem.01/17305]" */
  label(id: string, meta: number, special?: string): string
  item(id: string, meta: number): PackItemInfo | undefined
  interchangeable(id: string, meta: number): { ore: string; others: PackItemInfo[] } | undefined
}

function idText(id: string, meta: number): string {
  return meta === ANY_META ? `${id} (any meta)` : itemKey({ id, meta })
}

export function namer(items: ItemTable | undefined): Namer {
  const name = (id: string, meta: number): string => items?.get(id, meta)?.name ?? idText(id, meta)
  return {
    name,
    label: (id, meta, special) => {
      const known = special ?? items?.get(id, meta)?.name
      return known ? `${known} [${idText(id, meta)}]` : idText(id, meta)
    },
    item: (id, meta) => items?.get(id, meta),
    interchangeable: (id, meta) => interchangeable(items, id, meta),
  }
}

// GregTech 把登记在同一个“材料件”矿辞名下的物品当成同一种东西（玄钢锭有 EnderIO 的和 GregTech 的两个 id，
// 机器配方写的是其中一个，放哪个都行；高炉出的也是其中一个）。只有这些前缀的矿辞名是这样。
const UNIFIED_ORE = /^(ingot|ingotHot|plate|plateDouble|plateDense|dust|dustSmall|dustTiny|gem|nugget|block|stick|stickLong|bolt|screw|ring|gear|gearGt|gearGtSmall|foil|rotor|spring|springSmall|round|wireFine|lens)[A-Z]/
const UNIFIED_PREFIXES = ['ingotHot', 'ingot', 'plateDouble', 'plateDense', 'plate', 'dustSmall', 'dustTiny', 'dust', 'gem', 'nugget', 'block', 'stickLong', 'stick', 'bolt', 'screw', 'ring', 'gearGtSmall', 'gearGt', 'gear', 'foil', 'rotor', 'springSmall', 'spring', 'round', 'wireFine', 'lens']

/** 材料件矿辞名里的材料那一半（plateSteel → Steel）；不是材料件矿辞名时是 undefined。 */
export function materialOfOre(ore: string): string | undefined {
  const m = UNIFIED_ORE.exec(ore)
  if (!m) return undefined
  // 前缀取最长的那个（plateDoubleSteel 是 plateDouble + Steel，不是 plate + DoubleSteel）
  const prefix = UNIFIED_PREFIXES.find((p) => ore.startsWith(p) && /[A-Z]/.test(ore.charAt(p.length))) ?? m[1]!
  return ore.slice(prefix.length)
}

/** 这个物品的“材料件”矿辞名（有的话）：同名下的别的物品和它可以互换。 */
export function unifiedOre(info: PackItemInfo | undefined): string | undefined {
  return info?.ores?.find((o) => UNIFIED_ORE.test(o))
}

/** 和它可以互换的别的物品（同一个材料件矿辞名下的）。 */
function interchangeable(items: ItemTable | undefined, id: string, meta: number): { ore: string; others: PackItemInfo[] } | undefined {
  const ore = unifiedOre(items?.get(id, meta))
  if (!ore || !items) return undefined
  const others = items.withOre(ore).filter((o) => !(o.id === id && o.meta === meta) && o.meta !== ANY_META)
  return others.length > 0 ? { ore, others } : undefined
}

export const isTool = (slot: RecipeSlot): boolean => slot.kind === 'ore' && slot.ore.startsWith('craftingTool')
/** 编程电路：配方里 n 为 0 的那个物品，meta 是电路号。不是这种格子时返回 undefined。 */
export const circuitOf = (slot: RecipeSlot): number | undefined => (slot.kind === 'item' && slot.id === CIRCUIT_ID && slot.n === 0 ? slot.meta : undefined)

/** 一格原料叫什么。ids：带不带 id（拿去找货、取货要用）。 */
export function slotName(slot: RecipeSlot, nm: Namer, ids: boolean): string {
  if (slot.kind === 'item') return ids ? nm.label(slot.id, slot.meta, slot.name) : (slot.name ?? nm.name(slot.id, slot.meta))
  // 举哪一种当例子：GregTech 自己的那种最常见（列在最前面的常常是别的 mod 里登记了同一个矿辞名的东西）
  const first = slot.any.find(([id]) => id.startsWith('gregtech:')) ?? slot.any[0]
  const example = first ? nm.name(first[0], first[1]) : undefined
  if (slot.kind === 'ore') return `any ${slot.ore}${example ? ` (e.g. ${ids && first ? nm.label(first[0], first[1]) : example})` : ''}`
  const others = slot.any.length + slot.more - 1
  return `${ids && first ? nm.label(first[0], first[1]) : (example ?? 'one of several items')}${others > 0 ? ` or ${others} similar` : ''}`
}

export function slotKey(slot: RecipeSlot): string {
  return slot.kind === 'item' ? `${slot.id}/${slot.meta}/${slot.name ?? ''}` : slot.kind === 'ore' ? `ore:${slot.ore}` : `any:${slot.any.map((a) => a.join('/')).join(',')}`
}

/** 同一种原料占了好几格的合成一项（合成台配方里 4 格同样的东西）。 */
export function mergedSlots(slots: readonly RecipeSlot[]): RecipeSlot[] {
  const merged = new Map<string, RecipeSlot>()
  for (const s of slots) {
    const key = `${slotKey(s)}|${s.n === 0 ? 0 : 1}`
    const seen = merged.get(key)
    if (seen) seen.n += s.n
    else merged.set(key, { ...s })
  }
  return [...merged.values()]
}

/** 两条配方是不是一模一样（导出的配方册里同一条常常重复好几遍）。 */
export function signature(r: Recipe): string {
  return JSON.stringify([r.handler.key, r.in.map((s) => [slotKey(s), s.n, s.g ?? -1]), r.out.map((o) => [o.id, o.meta, o.n, o.chance ?? 1]), r.fin.map((f) => [f.f, f.mb]), r.fout.map((f) => [f.f, f.mb]), r.eut ?? 0, r.ticks ?? 0, r.special ?? 0])
}

// ── 身上有多少 ──

export interface Carried {
  /** 这种物品身上有几个（meta 是 ANY_META 时不分 meta）。 */
  of(id: string, meta: number): number
  /** 配方的这一格身上有几个。unified：GregTech 机器的配方，同一个材料件矿辞名下的别的物品也算。 */
  ofSlot(slot: RecipeSlot, unified?: boolean): number
  /** 身上登记在这个矿辞名下的东西，多的在前。 */
  underOre(ore: string): { id: string; meta: number; count: number }[]
}

export function carried(inventory: readonly InventoryItem[], items: ItemTable | undefined): Carried {
  const exact = new Map<string, number>()
  const byId = new Map<string, number>()
  const byOre = new Map<string, { id: string; meta: number; count: number }[]>()
  for (const it of inventory) {
    if (!it || typeof it.id !== 'string') continue
    const n = typeof it.count === 'number' ? it.count : 1
    const meta = it.meta ?? 0
    const key = `${it.id}/${meta}`
    const first = !exact.has(key)
    exact.set(key, (exact.get(key) ?? 0) + n)
    byId.set(it.id, (byId.get(it.id) ?? 0) + n)
    for (const ore of items?.get(it.id, meta)?.ores ?? []) {
      let list = byOre.get(ore)
      if (!list) byOre.set(ore, (list = []))
      const seen = first ? undefined : list.find((x) => x.id === it.id && x.meta === meta)
      if (seen) seen.count += n
      else list.push({ id: it.id, meta, count: n })
    }
  }
  const of = (id: string, meta: number): number => (meta === ANY_META ? (byId.get(id) ?? 0) : (exact.get(`${id}/${meta}`) ?? 0))
  const underOre = (ore: string) => [...(byOre.get(ore) ?? [])].sort((a, b) => b.count - a.count)
  const oreCount = (ore: string): number => (byOre.get(ore) ?? []).reduce((sum, x) => sum + x.count, 0)
  return {
    of,
    underOre,
    ofSlot: (slot, unified = false) => {
      if (slot.kind === 'item') {
        const ore = unified ? unifiedOre(items?.get(slot.id, slot.meta)) : undefined
        return ore ? Math.max(of(slot.id, slot.meta), oreCount(ore)) : of(slot.id, slot.meta)
      }
      const listed = slot.any.reduce((sum, [id, meta]) => sum + of(id, meta), 0)
      // 矿辞名：列出来的只是前 12 种，身上的东西按物品表里它登记的矿辞名再认一遍，取多的
      return slot.kind === 'ore' ? Math.max(listed, oreCount(slot.ore)) : listed
    },
  }
}

// ── 附近有什么机器、工作台 ──

/**
 * 身体读不懂状态的机器：别的 mod 的机器、原版熔炉、不是“加工机器”那一类的 GregTech 方块。
 * 它在世界里是一个容器（world.containers 列得出来），而配方册里有配方页把它（作为物品的 id + meta）列为做这类配方的机器。
 * 身体照玩家的办法用它：把原料点进去，等里面不再变化，把产物格里的东西取回来。
 */
export interface OtherMachine {
  x: number
  y: number
  z: number
  /** 方块 id 和服务器给的英文名。 */
  id: string
  name?: string
  /** 它是配方册里的哪个物品（配方页的 machines 里的那一对）。 */
  item: { id: string; meta: number }
  /** 它能做哪几页的配方（handlers.json 的 key）。 */
  ways: string[]
  attached?: AttachedBlock[]
  dist?: number
}

export interface Surroundings {
  /** 身体读得懂状态的机器（GregTech 的单方块加工机器、多方块主机），由近到远（dist 是到它站的地方的距离）。 */
  machines: MachineInfo[]
  /** 身体读不懂状态、但配方册说能做某类配方的机器。没查过时是 undefined（查一次要把周围的容器扫一遍，见 findOthers）。 */
  others?: OtherMachine[]
  /** 范围里一共多少台（machines 只是每次查询里最近的那些）。 */
  machinesTotal: number
  /** 合成台，由近到远。 */
  tables: FindMatch[]
  /** 没看成（没连上游戏、bot 不在线）时的原因。 */
  error?: string
}

/** 附近的机器和工作台，记一小会儿：连着查几个物品的做法时不用每次都问身体。 */
export class SurroundingsCache {
  private at = 0
  private value: Surroundings | undefined
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(now: () => number, ttlMs = 20_000) {
    this.now = now
    this.ttlMs = ttlMs
  }

  get(): Surroundings | undefined {
    return this.value && this.now() - this.at < this.ttlMs ? this.value : undefined
  }

  set(value: Surroundings): void {
    this.value = value
    this.at = this.now()
  }

  clear(): void {
    this.value = undefined
  }
}

export interface Spot {
  x: number
  y: number
  z: number
  dim?: number
}

/** 它现在站在哪。不在线、没有位置时是 undefined。 */
export async function whereItStands(ctx: ToolContext): Promise<Spot | undefined> {
  const status = await ctx.bridge.botStatus(ctx.botName)
  const at = status.block ?? status.pos
  if (status.online === false || !at) return undefined
  return { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z), ...(status.dim !== undefined ? { dim: status.dim } : {}) }
}

/** 以 me 为中心、在水平面上排成 n×n 的一格格查询点，相邻两个点隔 step（n 为 2 时是往四个斜方向各错开 step）。 */
export function spread(me: Spot, step: number, n: 2 | 3 = 2): Spot[] {
  const offsets = n === 2 ? [-step, step] : [-step, 0, step]
  return offsets.flatMap((dx) => offsets.map((dz) => ({ ...me, x: me.x + dx, z: me.z + dz })))
}

const distance = (a: Spot, b: { x: number; y: number; z: number }): number => Math.round(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) * 10) / 10

/** 它周围（每个方向 TABLES_REACH 格以内）的合成台，由近到远。 */
export async function findTables(ctx: ToolContext, me: Spot, limit = 4): Promise<FindMatch[]> {
  const found = await Promise.all(spread(me, TABLES_QUERY_STEP).map((at) => ctx.bridge.worldFind(at, { blocks: CRAFTING_TABLES, radius: TABLES_RADIUS, limit })))
  const tables = new Map<string, FindMatch>()
  for (const t of found.flatMap((f) => f.matches ?? [])) tables.set(`${t.x},${t.y},${t.z}`, { ...t, dist: distance(me, t) })
  return [...tables.values()].sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0))
}

export async function lookAround(ctx: ToolContext): Promise<Surroundings> {
  const cached = ctx.surroundings?.get()
  if (cached) return cached
  let around: Surroundings
  try {
    const me = await whereItStands(ctx)
    if (!me) return { machines: [], machinesTotal: 0, tables: [], error: `offline: ${ctx.botName} is not in the game world` }
    const [sets, tables] = await Promise.all([
      Promise.all(spread(me, MACHINES_QUERY_STEP).map((at) => ctx.bridge.worldMachines(at, { radius: MACHINES_QUERY_RADIUS, limit: 60 }))),
      findTables(ctx, me),
    ])
    const machines = new Map<string, MachineInfo>()
    let missed = 0
    for (const set of sets) {
      const got = set.machines ?? []
      missed += Math.max(0, (set.total ?? 0) - got.length)
      for (const m of got) machines.set(`${m.x},${m.y},${m.z}`, { ...m, dist: distance(me, m) })
    }
    const sorted = [...machines.values()].sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0))
    around = { machines: sorted, machinesTotal: sorted.length + missed, tables }
    // 没看成的不记：下次再试
    ctx.surroundings?.set(around)
  } catch (e) {
    if (!(e instanceof BridgeError)) throw e
    around = { machines: [], machinesTotal: 0, tables: [], error: `${e.code}: ${e.message}` }
  }
  return around
}

// ── 身体不认识的机器：照配方册认 ──

/** 一个方块 id 下，配方册里列为“机器”的那些物品（meta、英文名）各自能做哪几页配方。 */
type Catalog = Map<string, { meta: number; en?: string; ways: string[] }[]>
const CATALOGS = new WeakMap<RecipeBook, Catalog>()

function catalogOf(book: RecipeBook, items: ItemTable | undefined): Catalog {
  let catalog = CATALOGS.get(book)
  if (catalog) return catalog
  catalog = new Map()
  for (const h of book.handlers) {
    // 合成台那一类不是“机器”；没列机器的页（信息页、图表）也不是
    if (wayKind(h) === 'craft' || wayKind(h) === 'other') continue
    for (const m of h.machines) {
      let list = catalog.get(m.id)
      if (!list) catalog.set(m.id, (list = []))
      let entry = list.find((e) => e.meta === m.meta)
      if (!entry) {
        const en = items?.get(m.id, m.meta)?.en
        list.push((entry = { meta: m.meta, ...(en ? { en } : {}), ways: [] }))
      }
      if (!entry.ways.includes(h.key)) entry.ways.push(h.key)
    }
  }
  CATALOGS.set(book, catalog)
  return catalog
}

/** 烧着的熔炉是另一个方块 id（minecraft:lit_furnace）：当成没烧着的那个。 */
const unlit = (id: string): string => id.replace(/:lit_/, ':')

/**
 * 这个容器是不是配方册里的一台机器。world.containers 只给方块 id 和名字、不给 meta，所以这样认：
 * 这个 id 下只有一种机器的（熔炉），就是它；有好几种的（IC2:blockMachine、gregtech:gt.blockmachines），按名字对。
 */
function asOtherMachine(c: ContainerInfo, catalog: Catalog): OtherMachine | undefined {
  if (typeof c.id !== 'string') return undefined
  const id = unlit(c.id)
  const listed = catalog.get(id)
  if (!listed) return undefined
  const hits = listed.length === 1 ? listed : listed.filter((e) => e.en !== undefined && e.en === c.name)
  if (hits.length === 0) return undefined
  return {
    x: c.x,
    y: c.y,
    z: c.z,
    id,
    ...(c.name ? { name: c.name } : {}),
    item: { id, meta: hits[0]!.meta },
    ways: [...new Set(hits.flatMap((e) => e.ways))],
    ...(c.attached && c.attached.length > 0 ? { attached: c.attached } : {}),
  }
}

/** 一批容器里，身体不认识、配方册认得的机器。known 是身体认识的那些（连同它们的总线和仓），不重复算。 */
export function otherMachines(containers: readonly ContainerInfo[], known: readonly MachineInfo[], book: RecipeBook, items: ItemTable | undefined, from?: Spot): OtherMachine[] {
  const catalog = catalogOf(book, items)
  const taken = new Set<string>()
  for (const m of known) {
    taken.add(`${m.x},${m.y},${m.z}`)
    for (const h of [...(m.inputBuses ?? []), ...(m.outputBuses ?? []), ...(m.inputHatches ?? []), ...(m.outputHatches ?? [])]) taken.add(`${h.x},${h.y},${h.z}`)
  }
  const out: OtherMachine[] = []
  for (const c of containers) {
    if (taken.has(`${c.x},${c.y},${c.z}`) || c.kind === 'drawers' || c.kind === 'drawer_controller') continue
    const found = asOtherMachine(c, catalog)
    if (found) out.push(from ? { ...found, dist: distance(from, found) } : found)
  }
  return out.sort((a, b) => (a.dist ?? 0) - (b.dist ?? 0))
}

const CONTAINERS_QUERY_RADIUS = 32
const CONTAINERS_QUERY_STEP = 64
const CONTAINERS_PAGE = 100
/** 把周围的容器扫一遍时最多看这么多个。 */
export const CONTAINERS_SCAN_MAX = 1200
export const CONTAINERS_REACH = CONTAINERS_QUERY_STEP + CONTAINERS_QUERY_RADIUS

/**
 * 把周围的容器扫一遍（world.containers 一次最多看 32 格：以 me 为中心 3×3 九个点各查一次，每个方向看得到 96 格）。
 * cut：容器太多、没读完。
 */
export async function scanContainers(ctx: ToolContext, me: Spot): Promise<{ containers: ContainerInfo[]; cut: boolean }> {
  const seen = new Map<string, ContainerInfo>()
  let cut = false
  const scanFrom = async (at: Spot): Promise<void> => {
    for (let offset = 0; seen.size < CONTAINERS_SCAN_MAX; ) {
      const res = await ctx.bridge.worldContainers(at, { radius: CONTAINERS_QUERY_RADIUS, offset, limit: CONTAINERS_PAGE })
      const got: ContainerInfo[] = res.containers ?? []
      const total = res.total ?? offset + got.length
      // 相邻两次查询的边上会重：一个容器只算一次
      for (const c of got) if (!seen.has(`${c.x},${c.y},${c.z}`)) seen.set(`${c.x},${c.y},${c.z}`, c)
      if (got.length === 0 || res.offset === undefined || offset + got.length >= total) break
      offset += got.length
      if (seen.size >= CONTAINERS_SCAN_MAX) cut = true
    }
  }
  await Promise.all(spread(me, CONTAINERS_QUERY_STEP, 3).map(scanFrom))
  return { containers: [...seen.values()], cut }
}

/** 周围有哪些身体不认识的机器（查过就记在 around 里；问不到游戏时当没有）。 */
export async function findOthers(ctx: ToolContext, around: Surroundings): Promise<OtherMachine[]> {
  if (around.others) return around.others
  const book = ctx.packdata?.recipes
  if (!book || around.error) return []
  try {
    const me = await whereItStands(ctx)
    if (!me) return []
    const { containers } = await scanContainers(ctx, me)
    around.others = otherMachines(containers, around.machines, book, ctx.packdata?.items, me)
  } catch (e) {
    if (!(e instanceof BridgeError)) throw e
    return []
  }
  return around.others
}

export function otherText(m: OtherMachine): string {
  return `${nameOf(m, { block: true }) ?? 'machine'} at ${formatPos(m)}`
}

/** 烧蒸汽、不烧电：存着多少电、电压够不够都无从说起。身体还没有单独的字段，先按名字认（Steam Macerator、High Pressure Steam Furnace）。 */
export function runsOnSteam(m: MachineInfo): boolean {
  return m.steam === true || /\bSteam\b/.test(m.name ?? '')
}

/** 这台机器的电力身体读不出来：蒸汽机器，或者没有能源仓却已经成型的多方块（蒸汽多方块）。 */
export function powerUnread(m: MachineInfo): boolean {
  return runsOnSteam(m) || (m.kind === 'multiblock' && m.formed !== false && (m.inputVoltage ?? 0) === 0)
}

export function runsWay(m: MachineInfo, h: RecipeHandler): boolean {
  return m.recipeKey === h.key || (m.id !== undefined && h.machines.some((x) => x.id === m.id && x.meta === m.meta))
}

export function machineText(m: MachineInfo): string {
  const tier = m.tier ? ` ${m.tier}` : ''
  return `${nameOf(m) ?? 'machine'} at ${formatPos(m)}${tier}${m.active === true ? ', busy right now' : ''}`
}

/** 这台机器现在做不了这条配方的原因；空的就是做得了。 */
export function machineProblems(m: MachineInfo, recipe: Recipe | undefined): string[] {
  const problems: string[] = []
  if (m.unreadable === true) return ['its state cannot be read']
  if (m.kind === 'multiblock' && m.formed === false) problems.push(`its structure is not complete${m.idleReason ? ` (${m.idleReason})` : ''}`)
  // 蒸汽机器不烧电：没有“没电”“电压不够”这回事（它有没有蒸汽、压力够不够，身体读不出来，只能试）
  const unread = powerUnread(m)
  if (m.kind !== 'multiblock' && m.storedEU === 0 && !unread) problems.push('NO POWER')
  if (m.switchedOff === true) problems.push('switched off')
  const volts = m.kind === 'multiblock' ? m.inputVoltage : (voltsOf(m.tier) ?? m.inputVoltage)
  if (!unread && recipe?.eut !== undefined && volts !== undefined && recipe.eut > volts) problems.push(`the recipe needs ${tierOf(recipe.eut)}, it is ${m.tier ?? `${volts} V`}`)
  if (recipe?.special !== undefined && m.heat !== undefined && recipe.special > m.heat) problems.push(`the recipe needs ${recipe.special} K, its coils reach ${m.heat} K`)
  return problems
}

/** 有序合成摆不摆得进 2×2（随身的合成格）；无序合成看是不是不超过 4 格。 */
export function fitsPocketGrid(recipe: Recipe): boolean {
  const cells = recipe.in.filter((s) => s.g !== undefined).map((s) => s.g!)
  if (cells.length === 0) return recipe.in.reduce((n, s) => n + Math.max(1, s.n), 0) <= 4
  if (cells.some((g) => g > 8)) return false
  const rows = cells.map((g) => Math.floor(g / 3))
  const columns = cells.map((g) => g % 3)
  return Math.max(...rows) - Math.min(...rows) <= 1 && Math.max(...columns) - Math.min(...columns) <= 1
}

/** 手工合成做得了的配方：合成台类的页，格子在 3×3 以内。 */
export function isHandCraft(recipe: Recipe): boolean {
  return recipe.handler.grid && recipe.in.length > 0 && recipe.in.reduce((n, s) => n + Math.max(1, s.g === undefined ? s.n : 1), 0) <= 9 && recipe.in.every((s) => s.g === undefined || s.g <= 8)
}

/**
 * 这种方式是哪一类：
 *   craft   手工合成；
 *   machine GregTech 的机器配方（身体读得懂这类机器的状态；同一个材料件矿辞名下的东西放哪个都行）；
 *   device  别的机器（原版熔炉、别的 mod 的机器）：配方页列着做它的机器，身体照玩家的办法用——把原料点进去、等、取产物；
 *   other   没有机器可言的页（信息页、图表、世界里发生的事）：它做不了。
 */
export function wayKind(h: RecipeHandler): 'machine' | 'device' | 'craft' | 'other' {
  if (h.grid) return 'craft'
  if (h.gregtech) return 'machine'
  // 列着合成台的页其实是合成（AE2、ProjectRed 自己的合成页，导出时没标成合成格）：不是“把原料点进去等着”的机器
  return h.machines.length > 0 && !h.machines.some((m) => CRAFTING_TABLES.includes(m.id)) ? 'device' : 'other'
}

/** 用机器做的（不管身体认不认识那种机器）。 */
export const isMachineWay = (h: RecipeHandler): boolean => wayKind(h) === 'machine' || wayKind(h) === 'device'

/** 身体读不懂状态的机器，开工前该知道的一句话。 */
export const UNREAD_NOTE = 'its state cannot be read (not a machine the body knows): it is used the way a player would — inputs in, wait, products out; if it needs fuel or anything else the recipe does not list, add that to "inputs"'

interface Availability {
  /** 排序用：0 现在做得了，1 手工工具配方（有机器时不用），2 有机器但现在不行，3 附近没有，4 它操作不了。 */
  rank: number
  text: string
}

function availability(h: RecipeHandler, recipes: readonly Recipe[], around: Surroundings, machineWayExists: boolean): Availability {
  const kind = wayKind(h)
  if (kind === 'other') return { rank: 4, text: 'you cannot run this yourself (no machine or crafting grid does it: it is an information page, or something that happens in the world)' }
  if (kind === 'craft') {
    const craftable = recipes.filter(isHandCraft)
    if (craftable.length === 0) return { rank: 4, text: 'needs a bigger crafting grid than you can use' }
    // 手工工具配方（锤子敲板那类）：照实说它要工具，用不用由模型定
    const tools = craftable.every((r) => r.in.some(isTool))
    const hand = tools ? 'uses hand tools (not used up, but they wear)' : ''
    if (craftable.some(fitsPocketGrid)) return { rank: tools ? 1 : 0, text: ['CAN CRAFT NOW in your own 2x2 grid (no table needed)', hand].filter(Boolean).join('; ') }
    if (around.error) return { rank: tools ? 1 : 0, text: ['by hand at a crafting table', hand].filter(Boolean).join('; ') }
    const table = around.tables[0]
    if (!table) return { rank: 3, text: [`needs a crafting table: none within ${TABLES_REACH} blocks`, hand].filter(Boolean).join('; ') }
    // 不给坐标：合成时由 craft_item 找离它那时最近的一个（它查做法和动手合成常常不在同一个地方）
    const far = typeof table.dist === 'number' ? `, the nearest ${Math.max(1, Math.round(table.dist))} block(s) from here` : ''
    return { rank: tools ? 1 : 0, text: [`CAN CRAFT NOW (needs a crafting table${far}; craft_item walks to the nearest one by itself)`, hand].filter(Boolean).join('; ') }
  }
  // 看不了附近有什么机器时：机器做法照样排在手工工具配方前面
  if (around.error) return { rank: 0, text: 'machine recipe' }
  const candidates = around.machines.filter((m) => runsWay(m, h))
  // 身体不认识、配方册认得的机器：可以试
  const untested = (around.others ?? []).filter((o) => o.ways.includes(h.key))
  const tryOn = untested.length > 0 ? `CAN TRY on ${otherText(untested[0]!)}${untested.length > 1 ? ` (and ${untested.length - 1} more)` : ''}: ${UNREAD_NOTE}` : undefined
  if (candidates.length === 0) return tryOn ? { rank: 1, text: tryOn } : { rank: 3, text: `no such machine within ${MACHINES_REACH} blocks` }
  // 拿最省电的那条配方来比：它都做不了，别的更做不了
  const easiest = [...recipes].sort((a, b) => (a.eut ?? 0) - (b.eut ?? 0) || (a.special ?? 0) - (b.special ?? 0))[0]
  const judged = candidates.map((m) => ({ m, problems: machineProblems(m, easiest) }))
  const ready = judged.filter((j) => j.problems.length === 0)
  if (ready.length > 0) {
    const idle = ready.find((j) => j.m.active !== true) ?? ready[0]!
    const steam = powerUnread(idle.m) ? ' (steam-powered: whether it has steam, and whether this recipe is within its pressure, cannot be read — try it)' : ''
    return { rank: 0, text: `CAN RUN NOW on ${machineText(idle.m)}${ready.length > 1 ? ` (and ${ready.length - 1} more)` : ''}${steam}` }
  }
  if (tryOn) return { rank: 1, text: tryOn }
  const best = judged[0]!
  return { rank: 2, text: `machine here but not usable now: ${machineText(best.m)}: ${best.problems.join(', ')}` }
}

/** 这条配方要的流体，附近做它的机器里有没有：多方块看得到输入仓，单方块的罐子看不到——照实说。 */
function fluidFact(recipe: Recipe, candidates: readonly MachineInfo[]): string {
  if (recipe.fin.length === 0 || candidates.length === 0) return ''
  const multi = candidates.find((m) => m.kind === 'multiblock')
  if (!multi) return ' [its fluid has to be inside the machine already: a single-block machine\'s tank cannot be seen or filled by you]'
  const have = recipe.fin.map((f) => `${quantity((multi.inputHatches ?? []).filter((h) => h.fluid === f.f).reduce((n, h) => n + (h.amount ?? 0), 0))} mB ${f.name}`)
  return ` [the input hatches of the ${nameOf(multi) ?? 'machine'} hold ${have.join(', ')}]`
}

// ── 一条配方写成一行 ──

interface LineOptions {
  /** 查的是哪个物品：给了就在后面算出“每个成品耗多少”。same 是和它可以互换的别的 id，出的是它们也算。 */
  target?: { id: string; meta: number; same?: readonly { id: string; meta: number }[] }
  have?: Carried
}

function outputText(recipe: Recipe, nm: Namer): string {
  const items = recipe.out.map((o) => `${quantity(o.n)}× ${o.name ?? nm.name(o.id, o.meta)}${o.chance !== undefined ? ` (${quantity(o.chance * 100)}% chance)` : ''}`)
  const fluids = recipe.fout.map((f) => `${quantity(f.mb)} mB ${f.name}`)
  return [...items, ...fluids].join(', ') || 'nothing listed'
}

/** 这条配方出几个要查的那个物品（有概率的按期望算）。 */
export function yieldOf(recipe: Recipe, target: { id: string; meta: number; same?: readonly { id: string; meta: number }[] }): number {
  const is = (o: { id: string; meta: number }): boolean => (o.id === target.id && o.meta === target.meta) || (target.same ?? []).some((t) => t.id === o.id && t.meta === o.meta)
  return recipe.out.reduce((n, o) => (is(o) ? n + o.n * (o.chance ?? 1) : n), 0)
}

export function recipeLine(recipe: Recipe, nm: Namer, opts: LineOptions = {}): string {
  const slots = mergedSlots(recipe.in)
  const consumed = slots.filter((s) => s.n > 0 && !isTool(s))
  const machine = recipe.handler.gregtech
  const have = (s: RecipeSlot): string => (opts.have ? ` (you carry ${opts.have.ofSlot(s, machine)})` : '')
  // 机器配方里点名的材料件：同一个矿辞名下的别的物品放进去也行，写明，免得它以为非这个 id 不可
  const orAny = (s: RecipeSlot): string => {
    if (!machine || s.kind !== 'item') return ''
    const same = nm.interchangeable(s.id, s.meta)
    return same ? ` (or any ${same.ore})` : ''
  }
  const parts = [...consumed.map((s) => `${quantity(s.n)}× ${slotName(s, nm, true)}${orAny(s)}${have(s)}`), ...recipe.fin.map((f) => `${quantity(f.mb)} mB ${f.name} (fluid)`)]
  const needs: string[] = []
  for (const s of slots) {
    if (circuitOf(s) !== undefined) needs.push(`programmed circuit ${circuitOf(s)}`)
    else if (isTool(s)) needs.push(`tool ${slotName(s, nm, true)}${have(s)} (worn, not used up)`)
    else if (s.n === 0) needs.push(`${slotName(s, nm, true)}${have(s)} (stays in the machine, not used up)`)
  }
  let line = `#${recipe.ref}: ${parts.join(' + ') || 'nothing consumed'}${needs.length > 0 ? `; needs ${needs.join(', ')}` : ''} → ${outputText(recipe, nm)}`
  if (opts.target) {
    const made = yieldOf(recipe, opts.target)
    if (made > 0 && made !== 1) {
      const each = [...consumed.map((s) => `${quantity(s.n / made)} ${slotName(s, nm, false)}`), ...recipe.fin.map((f) => `${quantity(f.mb / made)} mB ${f.name}`)]
      if (each.length > 0) line += ` (per ${nm.name(opts.target.id, opts.target.meta)}: ${each.join(' + ')})`
    }
  }
  const power: string[] = []
  if (recipe.eut !== undefined) power.push(`${tierOf(recipe.eut)} (${recipe.eut} EU/t)`)
  if (recipe.ticks !== undefined) power.push(seconds(recipe.ticks))
  if (recipe.special !== undefined) power.push(/blast/i.test(recipe.handler.key) ? `coil heat ${recipe.special} K` : `special value ${recipe.special}`)
  if (recipe.handler.grid) power.push(isHandCraft(recipe) ? (fitsPocketGrid(recipe) ? 'fits your 2x2 grid' : 'needs a crafting table (3x3)') : 'grid too big for you')
  return power.length > 0 ? `${line} — ${power.join(', ')}` : line
}

// ── 找物品 ──

function requireBook(ctx: ToolContext): { items: ItemTable | undefined; recipes: RecipeBook; packdata: PackData } {
  const packdata = ctx.packdata
  if (!packdata?.recipes) throw new Error('recipe book not loaded')
  return { items: packdata.items, recipes: packdata.recipes, packdata }
}

export function findItemLocal(items: ItemTable, recipes: RecipeBook | undefined, input: { query: string; page?: number; limit?: number }, carving?: CarvingBook): ToolResult | string {
  const query = input.query.trim()
  if (query.length < 1) return fail('Give a word of the name: Chinese, English, an id or an ore-dictionary name.')
  const limit = input.limit ?? ITEMS_PER_PAGE
  const page = Math.max(1, input.page ?? 1)
  const { hits, total } = items.search(query, { limit, offset: (page - 1) * limit })
  if (total === 0) return `No item matches "${query}". Try fewer or other words: part of the Chinese name, of the English name, of the id, or an ore-dictionary name such as plateSteel.`
  if (hits.length === 0) return fail(`"${query}" matches ${total} item(s): there is no page ${page} (${Math.ceil(total / limit)} page(s)).`)
  // 英文名只在帮得上忙时带：这一页里中文名重了，或者是拿英文搜的
  const names = new Map<string, number>()
  for (const h of hits) names.set(h.name, (names.get(h.name) ?? 0) + 1)
  const asked = query.toLowerCase()
  const english = /[a-z]{2}/i.test(query)
  const lines = hits.map((h) => {
    const en = h.en && (names.get(h.name)! > 1 || (english && h.en.toLowerCase().includes(asked.split(/\s+/)[0]!))) ? ` (${h.en})` : ''
    const facts: string[] = []
    if (recipes) {
      const made = recipes.makesOf(h.id, h.meta).length
      const used = recipes.usesOf(h.id, h.meta, h.ores).length
      facts.push(made > 0 ? `${made} recipe(s) make it` : 'no recipe makes it', used > 0 ? `used in ${used}` : 'used in none')
    }
    if (h.ores && h.ores.length > 0) facts.push(`ore names: ${h.ores.slice(0, 4).join(', ')}${h.ores.length > 4 ? ` +${h.ores.length - 4}` : ''}`)
    // 凿子的组：它是组里的一种时写出来（这种东西配方册里常常查不到做法）
    const groups = (carving?.groupsOf(h.id, h.meta) ?? []).map((m) => `"${m.group.group}"`)
    if (groups.length > 0) facts.push(`chisel group ${groups.join(', ')}`)
    if (h.variants) facts.push(`${h.variants} variants that differ only in their data (same id/meta)`)
    return `- ${h.name} [${itemKey(h)}]${en}${facts.length > 0 ? `: ${facts.join('; ')}` : ''}`
  })
  const first = (page - 1) * limit + 1
  const head =
    total > hits.length
      ? `"${query}" matches ${total} items; these are ${first}–${first + hits.length - 1}, most alike first (page ${page} of ${Math.ceil(total / limit)}). Add a word to narrow it, or ask for the next page.`
      : `"${query}" matches ${total} item(s), most alike first.`
  return { content: `${head}\n${lines.join('\n')}`, keepWhole: true }
}

// ── 查做法、查用途 ──

interface Way {
  handler: RecipeHandler
  /** 这种方式下的配方（查做法时去掉了一模一样的）。 */
  recipes: Recipe[]
}

interface RecipeQuery {
  id: string
  meta?: number
  way?: string
  contains?: string
  page?: number
}

/** 用模型给的词挑方式：先当页的编号，再当页名，再看编号或页名里含不含。 */
function pickWays<T extends { handler: RecipeHandler }>(ways: readonly T[], asked: string): T[] {
  const text = asked.trim().toLowerCase()
  const exact = ways.filter((w) => w.handler.key.toLowerCase() === text)
  if (exact.length > 0) return exact
  const named = ways.filter((w) => w.handler.name.toLowerCase() === text)
  if (named.length > 0) return named
  return ways.filter((w) => w.handler.key.toLowerCase().includes(text) || w.handler.name.toLowerCase().includes(text))
}

/** 模型该怎么写这种方式：页名；同名的页不止一个时用页的编号。 */
function wayLabel(h: RecipeHandler, all: readonly { handler: RecipeHandler }[]): string {
  return all.filter((w) => w.handler.name === h.name).length > 1 ? h.key : h.name
}

function slotMatches(slot: RecipeSlot, text: string, nm: Namer): boolean {
  const hit = (id: string, meta: number): boolean => {
    const item = nm.item(id, meta)
    return `${id}/${meta}`.toLowerCase().includes(text) || (item !== undefined && (item.name.toLowerCase().includes(text) || (item.en ?? '').toLowerCase().includes(text)))
  }
  if (slot.kind === 'item') return hit(slot.id, slot.meta) || (slot.name ?? '').toLowerCase().includes(text)
  if (slot.kind === 'ore' && slot.ore.toLowerCase().includes(text)) return true
  return slot.any.some(([id, meta]) => hit(id, meta))
}

function resolveItem(recipes: RecipeBook, input: { id: string; meta?: number }, nm: Namer, carving?: CarvingBook): { id: string; meta: number; info?: PackItemInfo } | ToolResult {
  const id = input.id.trim()
  const meta = input.meta ?? 0
  const info = nm.item(id, meta)
  // 物品表、配方册、凿子的组里都没见过这个 id/meta：多半是写错了
  if (!info && recipes.makesOf(id, meta).length === 0 && recipes.usesOf(id, meta).length === 0 && (carving?.groupsOf(id, meta).length ?? 0) === 0) {
    return fail(`No item ${itemKey({ id, meta })} is known. Get the exact id and meta with find_item (many GregTech items share one id and differ only in meta).`)
  }
  return info ? { id, meta, info } : { id, meta }
}

function pageOf<T>(list: readonly T[], page: number | undefined, size: number): { shown: T[]; page: number; pages: number; first: number } | undefined {
  const pages = Math.max(1, Math.ceil(list.length / size))
  const p = Math.max(1, page ?? 1)
  if (p > pages) return undefined
  return { shown: list.slice((p - 1) * size, p * size), page: p, pages, first: (p - 1) * size + 1 }
}

async function carriedNow(ctx: ToolContext, items: ItemTable | undefined): Promise<Carried | undefined> {
  try {
    const status = await ctx.bridge.botStatus(ctx.botName)
    return status.online === false ? undefined : carried(status.inventory ?? [], items)
  } catch (e) {
    if (e instanceof BridgeError) return undefined
    throw e
  }
}

export async function findRecipesLocal(ctx: ToolContext, input: RecipeQuery): Promise<ToolResult | string> {
  const { items, recipes, packdata } = requireBook(ctx)
  const nm = namer(items)
  const target = resolveItem(recipes, input, nm, packdata.carving)
  if ('content' in target) return target
  const label = nm.label(target.id, target.meta)
  // 凿子：它是某个组里的一种时，可以从同组的另一种凿出来。这不是配方，配方册里没有，照实另列
  const carve = chiselMatches(packdata.carving, { id: target.id, meta: target.meta, ores: target.info?.ores ?? [] }, 'made')
  const carveData = carve.length > 0 ? { data: { item: { id: target.id, meta: target.meta, name: nm.name(target.id, target.meta) }, chisel: chiselData(carve, nm) } } : {}
  if (input.way !== undefined && isChiselWay(input.way) && carve.length > 0) return { content: chiselDetail(carve, target, label, nm), ...carveData, keepWhole: true }
  // 同一个材料件矿辞名下的别的 id 是同一种东西：做它们的配方也算（高炉出的玄钢锭是 EnderIO 的那个 id）
  const same = nm.interchangeable(target.id, target.meta)
  const twins = (same?.others ?? []).filter((o) => recipes.makesOf(o.id, o.meta).length > 0)
  const refs = twins.length === 0 ? recipes.makesOf(target.id, target.meta) : [...new Set([...recipes.makesOf(target.id, target.meta), ...twins.flatMap((o) => recipes.makesOf(o.id, o.meta))])].sort((a, b) => a - b)
  if (refs.length === 0) {
    if (carve.length > 0) {
      return { content: [`No recipe in the recipe book makes ${label}. It is made another way:`, ...chiselSummary(carve, target, label, nm, 'made')].join('\n'), ...carveData, keepWhole: true }
    }
    return `No recipe makes ${label}: it is not crafted or processed from anything in the recipe book (a raw material, a drop, or something only found or traded). The library function find_uses shows what it is used for.`
  }
  const wanted = { id: target.id, meta: target.meta, same: twins }
  const twinNote = twins.length > 0 ? ` Recipes that make ${twins.map((o) => nm.label(o.id, o.meta)).join(', ')} are included: under the ore name ${same!.ore} it is the same thing (GregTech machines and "any ${same!.ore}" recipes take either).` : ''
  // 按方式分组，去掉一模一样的
  const ways: Way[] = []
  const seen = new Set<string>()
  let duplicates = 0
  for (const ref of refs) {
    const recipe = recipes.get(ref)
    if (!recipe) continue
    const sig = signature(recipe)
    if (seen.has(sig)) {
      duplicates++
      continue
    }
    seen.add(sig)
    let way = ways.find((w) => w.handler === recipe.handler)
    if (!way) ways.push((way = { handler: recipe.handler, recipes: [] }))
    way.recipes.push(recipe)
  }
  const total = ways.reduce((n, w) => n + w.recipes.length, 0)
  const merged = duplicates > 0 ? ` (${duplicates} exact duplicate(s) in the book are merged)` : ''

  const contains = input.contains?.trim().toLowerCase()
  if (input.way !== undefined || contains || input.page !== undefined) {
    // 具体的配方：按方式、按“原料里含某物”筛，翻页
    let chosen = ways
    if (input.way !== undefined && input.way.trim().length > 0) {
      chosen = pickWays(ways, input.way)
      if (chosen.length === 0) return fail(`${label} is not made by any way matching "${input.way.trim()}". Its ways: ${ways.map((w) => `"${wayLabel(w.handler, ways)}" (${w.recipes.length})`).join(', ')}${carve.length > 0 ? `, "${CHISEL_WAY}" (chisel group)` : ''}.`)
    }
    let list = chosen.flatMap((w) => w.recipes)
    const inWays = list.length
    if (contains) list = list.filter((r) => r.in.some((s) => slotMatches(s, contains, nm)) || r.fin.some((f) => f.name.toLowerCase().includes(contains) || f.f.toLowerCase().includes(contains)))
    const scope = `${chosen.length === ways.length ? '' : ` by ${chosen.map((w) => `"${wayLabel(w.handler, ways)}"`).join(', ')}`}${contains ? ` with an ingredient containing "${input.contains!.trim()}"` : ''}`
    if (list.length === 0) return `No recipe for ${label}${scope} (${inWays} recipe(s) before the "contains" filter; ${total} in all). Try another word: part of an ingredient's Chinese or English name, id or ore name.`
    const paged = pageOf(list, input.page, RECIPES_PER_PAGE)
    if (!paged) return fail(`There is no page ${input.page}: ${list.length} recipe(s)${scope}, ${Math.ceil(list.length / RECIPES_PER_PAGE)} page(s).`)
    const have = await carriedNow(ctx, items)
    const lines = paged.shown.map((r) => `${chosen.length > 1 ? `[${r.handler.name}] ` : ''}${recipeLine(r, nm, { target: wanted, ...(have ? { have } : {}) })}`)
    const range = list.length > paged.shown.length ? `recipes ${paged.first}–${paged.first + paged.shown.length - 1} of ${list.length} (page ${paged.page} of ${paged.pages})` : `${list.length} recipe(s)`
    return {
      content: [`${label}${scope}: ${range}${merged}.${twinNote}`, ...lines, 'Use a recipe by its # number: craft_item (hand crafting) or process_items (machine).'].join('\n'),
      keepWhole: true,
    }
  }

  // 汇总：每种方式几条、每个成品耗多少、附近做不做得了
  const around = await lookAround(ctx)
  // 有别的 mod 的机器、熔炉这类做法时，看看周围有没有这样的机器（身体不认识它们，要把容器扫一遍照配方册认）
  if (ways.some((w) => isMachineWay(w.handler))) await findOthers(ctx, around)
  const machineWayExists = ways.some((w) => isMachineWay(w.handler))
  const judged = ways
    .map((w, order) => ({ ...w, order, avail: availability(w.handler, w.recipes, around, machineWayExists) }))
    // 不排“哪种更好”：照配方册里的先后
    .sort((a, b) => a.order - b.order)
  const lines: string[] = [`${label} can be made ${ways.length} way(s), ${total} recipe(s) in all${merged}${carve.length > 0 ? ', and with a chisel (last entry)' : ''}.${twinNote} Listed by way of making, in the recipe book's order; what stands in your base for each way is stated, nothing is ranked or recommended:`]
  if (around.error) lines.push(`(Which machines and crafting tables are around you could not be checked: ${around.error}.)`)
  else if (around.machinesTotal > around.machines.length) lines.push(`(Only ${around.machines.length} of about ${around.machinesTotal} machines within ${MACHINES_REACH} blocks were checked.)`)
  judged.slice(0, WAYS_SHOWN).forEach((w, n) => {
    const count = w.recipes.length
    lines.push(`${n + 1}. ${w.handler.name}${wayLabel(w.handler, ways) === w.handler.name ? '' : ` (way "${w.handler.key}")`} — ${count} recipe(s); ${w.avail.text}`)
    const shown = count <= WAY_RECIPES_SHOWN ? w.recipes : w.recipes.slice(0, 2)
    // 这种方式附近有机器时，逐条看这条配方它做不做得了（同一台高炉，炉温够做这条不够做那条）
    const candidates = wayKind(w.handler) === 'machine' && !around.error ? around.machines.filter((m) => runsWay(m, w.handler)) : []
    for (const r of shown) {
      const blocked = candidates.length > 0 && w.avail.rank === 0 ? candidates.map((m) => machineProblems(m, r)) : []
      const cannot = blocked.length > 0 && blocked.every((p) => p.length > 0) ? ` [NOT on the machine(s) here: ${blocked[0]!.join(', ')}]` : ''
      lines.push(`   ${recipeLine(r, nm, { target: wanted })}${cannot}${fluidFact(r, candidates)}`)
    }
    if (count > shown.length) {
      lines.push(`   … ${count - shown.length} more recipe(s) of this way are not shown (often one per material). See them with way "${wayLabel(w.handler, ways)}", narrowed with "contains" (a word of an ingredient), page by page.`)
    }
  })
  if (judged.length > WAYS_SHOWN) {
    lines.push(`${judged.length - WAYS_SHOWN} more way(s) are not shown: ${judged.slice(WAYS_SHOWN).map((w) => `"${wayLabel(w.handler, ways)}" (${w.recipes.length})`).join(', ')}. Ask for one with "way".`)
  }
  if (carve.length > 0) {
    const [first, ...rest] = chiselSummary(carve, target, label, nm, 'made')
    lines.push(`${Math.min(judged.length, WAYS_SHOWN) + 1}. ${first}`, ...rest)
  }
  lines.push(
    '"CAN RUN NOW" states only this: a machine of that kind stands in the base, has power, is not switched off, and its tier (voltage, coil heat) covers the least demanding of those recipes. "CAN TRY" is a machine whose state cannot be read. Neither says anything about the ingredients (find_in_storage), about a fluid a single-block machine needs (its tank cannot be seen), or about which way is better. A recipe is used by its # number: craft_item or process_items.',
  )
  return { content: lines.join('\n'), ...carveData, keepWhole: true }
}

/** 一条配方的数据形式，给程序用（find_uses 的 data.recipes）。count 为 0 的原料是要放进去但不消耗的（编程电路、模具）。 */
export function recipeData(r: Recipe, nm: Namer): Record<string, unknown> {
  const slot = (s: RecipeSlot): Record<string, unknown> => ({
    ...(s.kind === 'item' ? { id: s.id, ...(s.meta === ANY_META ? {} : { meta: s.meta }) } : s.kind === 'ore' ? { ore: s.ore } : { any: s.any.map(([id, meta]) => itemKey({ id, meta })) }),
    name: slotName(s, nm, false),
    count: s.n,
  })
  const fluid = (f: { f: string; name: string; mb: number }): Record<string, unknown> => ({ fluid: f.f, name: f.name, mb: f.mb })
  return {
    recipe: r.ref,
    way: r.handler.name,
    in: mergedSlots(r.in).map(slot),
    out: r.out.map((o) => ({ id: o.id, meta: o.meta, name: o.name ?? nm.name(o.id, o.meta), count: o.n, ...(o.chance !== undefined ? { chance: o.chance } : {}) })),
    ...(r.fin.length > 0 ? { fluidsIn: r.fin.map(fluid) } : {}),
    ...(r.fout.length > 0 ? { fluidsOut: r.fout.map(fluid) } : {}),
    ...(r.eut !== undefined ? { eut: r.eut } : {}),
    ...(r.ticks !== undefined ? { ticks: r.ticks } : {}),
  }
}

/**
 * 查用途。data（给程序用）：item 是问的那样东西，total 是用到它的配方数；
 * 只给 id/meta 时 ways 是每种方式各有几条（全部方式，不止文字里列出来的那些）；给了 way / contains / page 时 recipes 是这一页的配方。
 */
export async function findUsesLocal(ctx: ToolContext, input: RecipeQuery): Promise<ToolResult | string> {
  const { items, recipes, packdata } = requireBook(ctx)
  const nm = namer(items)
  const target = resolveItem(recipes, input, nm, packdata.carving)
  if ('content' in target) return target
  const label = nm.label(target.id, target.meta)
  // 点名要“同一种东西的另一个 id”的机器配方也算用到它
  const same = nm.interchangeable(target.id, target.meta)
  const own = recipes.usesOf(target.id, target.meta, target.info?.ores ?? [])
  const refs = same ? [...new Set([...own, ...same.others.flatMap((o) => recipes.usesOf(o.id, o.meta))])].sort((a, b) => a - b) : own
  const item = { id: target.id, meta: target.meta, name: nm.name(target.id, target.meta) }
  // 凿子：它在某个组里（或者带着某个组认的矿辞名）时，能凿成那个组里别的方块。不是配方，照实另列
  const carve = chiselMatches(packdata.carving, { id: target.id, meta: target.meta, ores: target.info?.ores ?? [] }, 'uses')
  const carveData = carve.length > 0 ? { chisel: chiselData(carve, nm) } : {}
  if (input.way !== undefined && isChiselWay(input.way) && carve.length > 0) return { content: chiselDetail(carve, target, label, nm), data: { item, total: refs.length, ...carveData }, keepWhole: true }
  if (refs.length === 0) {
    if (carve.length > 0) return { content: [`Nothing in the recipe book uses ${label} as an ingredient. It has another use:`, ...chiselSummary(carve, target, label, nm, 'uses').map((line) => (line.startsWith(' ') ? line : `- ${line}`))].join('\n'), data: { item, total: 0, ways: [], ...carveData }, keepWhole: true }
    return { content: `Nothing in the recipe book uses ${label} as an ingredient.`, data: { item, total: 0, ways: [] } }
  }
  // 用到它的配方可以上万条：分组只看每条属于哪一页，不读配方本身
  const groups = new Map<RecipeHandler, number[]>()
  for (const ref of refs) {
    const h = recipes.handlerOfRecipe(ref)
    if (!h) continue
    const list = groups.get(h)
    if (list) list.push(ref)
    else groups.set(h, [ref])
  }
  const ways = [...groups.entries()].map(([handler, list]) => ({ handler, refs: list })).sort((a, b) => b.refs.length - a.refs.length)

  const contains = input.contains?.trim().toLowerCase()
  if (input.way !== undefined || contains || input.page !== undefined) {
    let chosen = ways
    if (input.way !== undefined && input.way.trim().length > 0) {
      chosen = pickWays(ways, input.way)
      if (chosen.length === 0) return fail(`${label} is not used by any way matching "${input.way.trim()}". Ways that use it: ${ways.slice(0, 40).map((w) => `"${wayLabel(w.handler, ways)}" (${w.refs.length})`).join(', ')}${ways.length > 40 ? `, and ${ways.length - 40} more` : ''}${carve.length > 0 ? `, "${CHISEL_WAY}" (chisel group)` : ''}.`)
    }
    let list = chosen.flatMap((w) => w.refs)
    const inWays = list.length
    const scope = `${chosen.length === ways.length ? '' : ` by ${chosen.map((w) => `"${wayLabel(w.handler, ways)}"`).join(', ')}`}${contains ? ` whose product or other ingredient contains "${input.contains!.trim()}"` : ''}`
    let loaded: Map<number, Recipe> | undefined
    if (contains) {
      // 要看内容才筛得了：这一步把候选的都读一遍（上万条也就一两百毫秒）
      loaded = new Map()
      list = list.filter((ref) => {
        const r = recipes.get(ref)
        if (!r) return false
        const hit =
          r.out.some((o) => slotMatches({ kind: 'item', id: o.id, meta: o.meta, n: o.n, ...(o.name ? { name: o.name } : {}) }, contains, nm)) ||
          r.in.some((s) => slotMatches(s, contains, nm)) ||
          [...r.fin, ...r.fout].some((f) => f.name.toLowerCase().includes(contains))
        if (hit) loaded!.set(ref, r)
        return hit
      })
    }
    if (list.length === 0) return { content: `No recipe uses ${label}${scope} (${inWays} before the "contains" filter; ${refs.length} in all).`, data: { item, total: 0, page: 1, pages: 1, recipes: [] } }
    const paged = pageOf(list, input.page, RECIPES_PER_PAGE)
    if (!paged) return fail(`There is no page ${input.page}: ${list.length} recipe(s)${scope}, ${Math.ceil(list.length / RECIPES_PER_PAGE)} page(s).`)
    const lines: string[] = []
    const shown: Record<string, unknown>[] = []
    for (const ref of paged.shown) {
      const r = loaded?.get(ref) ?? recipes.get(ref)
      if (!r) continue
      lines.push(`${chosen.length > 1 ? `[${r.handler.name}] ` : ''}${recipeLine(r, nm)}`)
      shown.push(recipeData(r, nm))
    }
    const range = list.length > paged.shown.length ? `recipes ${paged.first}–${paged.first + paged.shown.length - 1} of ${list.length} (page ${paged.page} of ${paged.pages})` : `${list.length} recipe(s)`
    return { content: [`Recipes that use ${label}${scope}: ${range}.`, ...lines].join('\n'), data: { item, total: list.length, page: paged.page, pages: paged.pages, recipes: shown }, keepWhole: true }
  }

  const lines: string[] = [`${label} is an ingredient of ${refs.length} recipe(s), in ${ways.length} way(s) (the same recipe can be listed more than once in the book):`]
  for (const w of ways.slice(0, USE_WAYS_SHOWN)) {
    // 每种方式举几个产物当例子
    const examples: string[] = []
    for (const ref of w.refs) {
      const r = recipes.get(ref)
      const first = r?.out[0]
      const name = first ? (first.name ?? nm.name(first.id, first.meta)) : undefined
      if (name && !examples.includes(name)) examples.push(name)
      if (examples.length >= 3) break
    }
    lines.push(`- ${w.handler.name}${wayLabel(w.handler, ways) === w.handler.name ? '' : ` (way "${w.handler.key}")`}: ${w.refs.length} recipe(s)${examples.length > 0 ? `, e.g. makes ${examples.join(', ')}` : ''}`)
  }
  if (ways.length > USE_WAYS_SHOWN) lines.push(`- … and ${ways.length - USE_WAYS_SHOWN} more way(s) with ${ways.slice(USE_WAYS_SHOWN).reduce((n, w) => n + w.refs.length, 0)} recipe(s): ${ways.slice(USE_WAYS_SHOWN).map((w) => `"${wayLabel(w.handler, ways)}"`).join(', ')}`)
  lines.push('See the recipes with "way" (one of the names above), narrowed with "contains" (a word of the product or of another ingredient), page by page.')
  if (carve.length > 0) lines.push('Besides the recipes:', ...chiselSummary(carve, target, label, nm, 'uses').map((line) => (line.startsWith(' ') ? line : `- ${line}`)))
  return { content: lines.join('\n'), data: { item, total: refs.length, ways: ways.map((w) => ({ way: wayLabel(w.handler, ways), name: w.handler.name, recipes: w.refs.length })), ...carveData }, keepWhole: true }
}

// ── 把一条配方变成任务的参数 ──

export type GridCell = null | { id: string; meta?: number } | { ore: string }

function cellOf(slot: RecipeSlot, have: Carried | undefined): GridCell {
  if (slot.kind === 'ore') return { ore: slot.ore }
  if (slot.kind === 'item') return slot.meta === ANY_META ? { id: slot.id } : { id: slot.id, meta: slot.meta }
  // 几种都行又没有矿辞名：身上有哪种用哪种，都没有就写第一种（任务会报缺什么）
  const pick = slot.any.find(([id, meta]) => (have?.of(id, meta) ?? 0) > 0) ?? slot.any[0]!
  return pick[1] === ANY_META ? { id: pick[0] } : { id: pick[0], meta: pick[1] }
}

/** 没有指定位置的原料按这个顺序占格子（NEI 画无序合成也是这个顺序）：前四样正好摆成 2×2，随身的合成格就做得了。 */
const FREE_CELLS = [0, 1, 3, 4, 6, 7, 2, 5, 8]

/**
 * 合成任务的摆法：3×3 的 9 格，一行一行数。配方册里带位置（g）的每格放在它自己的位置；不带位置的（无序合成）依次占空着的格子。
 */
export function craftGrid(recipe: Recipe, have?: Carried): GridCell[] {
  const grid: GridCell[] = Array.from({ length: 9 }, () => null)
  for (const slot of recipe.in) if (slot.g !== undefined && slot.g < 9) grid[slot.g] = cellOf(slot, have)
  let next = 0
  for (const slot of recipe.in) {
    if (slot.g !== undefined) continue
    for (let n = 0; n < Math.max(1, slot.n); n++) {
      while (next < 9 && grid[FREE_CELLS[next]!] !== null) next++
      if (next < 9) grid[FREE_CELLS[next]!] = cellOf(slot, have)
    }
  }
  return grid
}

export interface ProcessPlan {
  /** 要放进机器的东西：消耗的原料乘上轮数，模具模头这类不消耗的各 1 个。 */
  inputs: { id: string; meta?: number; count: number }[]
  /** 配方要的编程电路号（不当物品去找，由 circuit 参数设）。 */
  circuit?: number
  /** 预期的产物（多方块机器的输出总线不留东西时，身体靠它去箱子里取）。 */
  expect: { id: string; meta: number; count: number }[]
  /** 配方要的流体：要么机器已经接好，要么带着装了流体的单元用 fluids 给。 */
  fluids: { name: string; mb: number }[]
}

/** moldInside：配方要的模具、模头（不消耗的那格）已经在机器里了，不用带、不用放。 */
export function processPlan(recipe: Recipe, rounds: number, have?: Carried, items?: ItemTable, moldInside = false): ProcessPlan {
  const plan: ProcessPlan = { inputs: [], expect: [], fluids: recipe.fin.map((f) => ({ name: f.name, mb: f.mb * rounds })) }
  for (const slot of mergedSlots(recipe.in)) {
    const circuit = circuitOf(slot)
    if (circuit !== undefined) {
      plan.circuit = circuit
      continue
    }
    if (slot.n === 0 && moldInside) continue
    // 模具、模头这类不消耗的放 1 个；消耗的乘上轮数
    const count = slot.n === 0 ? 1 : slot.n * rounds
    if (slot.kind === 'item') {
      // 配方点名的那个 id 身上不够、而同一个材料件矿辞名下的另一种够：放那一种（机器当它们是同一种东西）
      const ore = have && slot.meta !== ANY_META && have.of(slot.id, slot.meta) < count ? unifiedOre(items?.get(slot.id, slot.meta)) : undefined
      const twin = ore ? have!.underOre(ore).find((x) => x.count >= count && !(x.id === slot.id && x.meta === slot.meta)) : undefined
      if (twin) plan.inputs.push({ id: twin.id, meta: twin.meta, count })
      else plan.inputs.push({ id: slot.id, ...(slot.meta === ANY_META ? {} : { meta: slot.meta }), count })
      continue
    }
    // 几种都行的（矿辞名或一组物品）：身上有哪种放哪种，都没有就写列出来的第一种
    const pick = slot.any.find(([id, meta]) => (have?.of(id, meta) ?? 0) > 0) ?? slot.any[0]
    if (pick) plan.inputs.push({ id: pick[0], ...(pick[1] === ANY_META ? {} : { meta: pick[1] }), count })
  }
  for (const o of recipe.out) {
    // 有概率才出的不算进“一定要取回来的”
    if (o.chance === undefined) plan.expect.push({ id: o.id, meta: o.meta, count: o.n * rounds })
  }
  return plan
}
