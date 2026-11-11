// 把协议数据排成给模型看的紧凑文本。agent 的状态快照和工具结果共用。

import type {
  AttachedBlock,
  BlueprintByHand,
  BlueprintCheck,
  BlueprintEntry,
  BlueprintMaterial,
  BlueprintObstacle,
  BotStatus,
  ContainerInfo,
  EntityInfo,
  InventoryItem,
  Item,
  ItemSearchHit,
  MachineHatch,
  MachineInfo,
  MachineRecipe,
  PlayerView,
  QuestDetail,
  QuestHit,
  QuestItem,
  QuestLine,
  RecipeFindResult,
  RecipeIngredient,
  ScanResult,
  ServerInfo,
  StockResult,
  TaskInfo,
} from '../bridge/protocol.ts'

/** 超长截断，并说明截掉了多少。 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…[truncated: ${text.length - max} more characters]`
}

export function compactJson(value: unknown, max = 400): string {
  let s: string
  try {
    s = JSON.stringify(value) ?? 'null'
  } catch {
    s = String(value)
  }
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function dimName(dim: number | undefined): string {
  if (dim === undefined) return 'unknown dimension'
  if (dim === 0) return 'overworld (dim 0)'
  if (dim === -1) return 'nether (dim -1)'
  if (dim === 1) return 'the end (dim 1)'
  return `dim ${dim}`
}

export function formatPos(p: { x: number; y: number; z: number } | undefined): string {
  if (!p) return '(?)'
  return `(${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)})`
}

/** 物品的写法：id，meta 不为 0 时写成 id/meta。 */
export function itemKey(item: { id: string; meta?: number }): string {
  return item.meta ? `${item.id}/${item.meta}` : item.id
}

export interface MergedItem {
  id: string
  meta: number
  count: number
  name?: string
  /** 同种物品里最低的剩余耐久（仅工具）。 */
  minDurability?: number
}

/** 按物品（id + meta）合并数量。 */
export function mergeItems(items: readonly (Item | InventoryItem)[]): MergedItem[] {
  const map = new Map<string, MergedItem>()
  for (const it of items) {
    if (!it || typeof it.id !== 'string') continue
    const key = itemKey(it)
    const count = typeof it.count === 'number' ? it.count : 1
    let m = map.get(key)
    if (!m) {
      m = { id: it.id, meta: it.meta ?? 0, count: 0 }
      if (it.name) m.name = it.name
      map.set(key, m)
    }
    m.count += count
    const durability = (it as InventoryItem).durability
    if (typeof durability === 'number') m.minDurability = Math.min(m.minDurability ?? 1, durability)
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
}

/**
 * 显示名是不是一个没翻译的语言键（GregTech 的物品在服务器端常常这样，如 gt.metaitem.01.32764.name）。
 * 这种名字对模型没用，还会让它误以为那就是物品的名字。
 */
export function isUntranslatedName(name: string): boolean {
  return /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(name)
}

/** 给人和模型看的显示名；没有或没翻译时返回 undefined。 */
export function displayName(name: string | undefined): string | undefined {
  return name && name.length > 0 && !isUntranslatedName(name) ? name : undefined
}

/** 物品表里查名字用的接口（packdata 的 ItemTable 满足）。 */
export interface LocalNames {
  get(id: string, meta?: number): { name: string; en?: string; variants?: number } | undefined
  byEnglishName(id: string, english: string): { name: string } | undefined
  /** 只有英文名、没有 id 的东西（接着的管道、东西所在的容器）：整张表里英文名正好是它的那个。 */
  byEnglishNameAlone?(english: string): { name: string } | undefined
}

/**
 * 本地物品表（中文名）。大脑启动时设一次（main.ts）；没设（没有本地资料）时，名字就用服务器给的英文名。
 * 放在模块里而不是一层层传：服务器回来的东西到处都在排版（背包、箱子、任务结果、事件），每一处都该用同一份名字。
 */
let localNames: LocalNames | undefined

export function useLocalNames(names: LocalNames | undefined): void {
  localNames = names
}

/**
 * 一样东西给模型看的名字：有本地物品表就用中文名，否则是服务器给的英文名。
 * - 先拿服务器给的英文名在同一个 id 下对（世界里的方块、带附加数据的物品只有这个办法对得准）；
 * - 再按 id + meta 查（block 为 true 时不查：方块的 meta 是朝向之类，不是物品的 meta）。
 *   同一个 id + meta 下有好几种只靠附加数据区分的变体（匠魂工具每种材质一个）时，表里的名字只是其中一种的：
 *   服务器给了名字又和表里的对不上，说明手里这件是另一种变体，用服务器给的（英文但是准的）；
 * - 还对不上、或者压根没有 id（身体只报了名字：接着的管道、东西所在的容器），拿英文名在整张表里对；
 * - 都没有就是服务器给的名字（没翻译的语言键不算名字）。
 */
export function nameOf(x: { id?: unknown; meta?: unknown; name?: unknown }, opts: { block?: boolean } = {}): string | undefined {
  const server = typeof x.name === 'string' ? displayName(x.name) : undefined
  if (localNames && typeof x.id === 'string') {
    const byName = server !== undefined ? localNames.byEnglishName(x.id, server) : undefined
    if (byName) return byName.name
    if (!opts.block) {
      const exact = localNames.get(x.id, typeof x.meta === 'number' ? x.meta : undefined)
      if (exact && !(exact.variants && server !== undefined)) return exact.name
    }
  }
  if (localNames && server !== undefined) {
    const alone = localNames.byEnglishNameAlone?.(server)
    if (alone) return alone.name
  }
  return server
}

/**
 * 任务结果、错误详情这类原样给模型看的 JSON：里面带 id 的东西补上（或换成）本地物品表的名字。
 * 没有本地物品表时原样返回。
 */
export function withLocalNames(value: unknown, depth = 0): unknown {
  if (!localNames || depth > 6 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => withLocalNames(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) out[k] = withLocalNames(v, depth + 1)
  const thing = value as { id?: unknown; meta?: unknown; name?: unknown }
  if (typeof thing.id === 'string' && thing.id.includes(':')) {
    const name = nameOf(thing)
    if (name !== undefined) out.name = name
  }
  return out
}

export function formatItem(m: MergedItem): string {
  let s = `${m.count}× ${itemKey(m)}`
  const name = nameOf(m)
  if (name) s += ` "${name}"`
  if (m.minDurability !== undefined) s += ` (${Math.round(m.minDurability * 100)}% durability)`
  return s
}

export function formatItems(items: readonly (Item | InventoryItem)[], limit: number): string {
  const merged = mergeItems(items)
  if (merged.length === 0) return 'empty'
  const shown = merged.slice(0, limit).map(formatItem).join(', ')
  return merged.length > limit ? `${shown}, … and ${merged.length - limit} more kinds` : shown
}

export const SKIPPED_EXAMPLES_SHOWN = 5

/**
 * 任务结果给模型看之前先收一收：区域任务的 skippedExamples 是一串坐标，只留前几个并说明还有多少。
 * 其余字段（removed、placed、skipped、freeSlots、level、clearedDownTo、moved、missing……）原样保留。
 */
export function trimTaskResult(result: Record<string, unknown>): Record<string, unknown> {
  const examples = result.skippedExamples
  if (!Array.isArray(examples) || examples.length <= SKIPPED_EXAMPLES_SHOWN) return result
  return {
    ...result,
    skippedExamples: examples.slice(0, SKIPPED_EXAMPLES_SHOWN),
    skippedExamplesNotShown: examples.length - SKIPPED_EXAMPLES_SHOWN,
  }
}

export function formatTask(task: TaskInfo, opts: { params?: boolean } = {}): string {
  let s = `${task.id} ${task.type} [${task.state}]`
  const p = task.progress
  if (p && (task.state === 'running' || task.state === 'queued')) {
    if (typeof p.done === 'number' && typeof p.total === 'number') s += ` ${p.done}/${p.total}`
    if (p.phase) s += ` ${p.phase}`
    if (p.note) s += ` (${p.note})`
  }
  if (opts.params && task.params) s += ` params=${compactJson(withLocalNames(task.params), 300)}`
  const lines = taskLines(task)
  if (task.state === 'failed' || task.error) {
    const e = task.error
    s += ` error=${e?.code ?? 'unknown'}`
    if (e?.message) s += `: ${e.message}`
    if (e?.detail && Object.keys(e.detail).length > 0) {
      s += lines.error ? lines.error.map((l) => `; ${l}`).join('') : ` detail=${compactJson(withLocalNames(e.detail), 300)}`
    }
  }
  if (task.result && Object.keys(task.result).length > 0) {
    const label = task.state === 'done' ? 'result' : 'partial result'
    s += lines.result ? `; ${label}: ${lines.result.join('; ')}` : ` ${label}=${compactJson(withLocalNames(trimTaskResult(task.result)), 600)}`
  }
  return s
}

/**
 * 有些任务的错误详情和结果是几张表（照图纸建的结果、合成时缺的原料）：原样的 JSON 很长，截断了模型就看不到后半截。
 * 这类任务在这里排成几行短文本（字段名照协议）。返回里没有的那一项，调用方照旧给紧凑 JSON。
 */
export function taskLines(task: TaskInfo): { error?: string[]; result?: string[] } {
  const out: { error?: string[]; result?: string[] } = {}
  const detail = task.error?.detail
  const result = task.result
  if (task.type === 'blueprint') {
    if (detail && Object.keys(detail).length > 0) out.error = blueprintErrorLines(detail)
    if (result && Object.keys(result).length > 0) out.result = blueprintResultLines(result)
  } else if (task.type === 'craft') {
    if (detail && Array.isArray(detail.missing)) out.error = craftErrorLines(detail)
    if (result && isObject(result.item)) out.result = craftResultLines(result)
  } else if (task.type === 'process') {
    // 机器没收原料、没开工时，detail 是那台机器的状态
    if (detail && (typeof detail.storedEU === 'number' || typeof detail.recipes === 'string')) out.error = processErrorLines(detail)
    if (result && Array.isArray(result.outputs)) out.result = processResultLines(result)
  } else if (task.type === 'use') {
    if (result && (typeof result.used === 'string' || Array.isArray(result.gained))) out.result = useResultLines(result, task.params)
  }
  return out
}

/** Minecraft 的 dayTime（0–23999，0 是早上 6 点）换成钟点。 */
export function formatDayTime(dayTime: number): string {
  const t = ((dayTime % 24000) + 24000) % 24000
  const hour = Math.floor(t / 1000 + 6) % 24
  const minute = Math.floor(((t % 1000) * 60) / 1000)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function formatStatus(status: BotStatus, opts: { itemLimit?: number } = {}): string {
  if (!status.online) return `${status.name}: OFFLINE (not in the game world; nothing can be done until it is brought online)`
  const lines: string[] = []
  const flags: string[] = []
  if (status.inWater) flags.push('in water')
  if (status.onGround === false) flags.push('not on ground')
  lines.push(
    `${status.name}: online in ${dimName(status.dim)} at block ${formatPos(status.block ?? status.pos)}` +
      `, health ${status.health ?? '?'}/${status.maxHealth ?? '?'}, food ${status.food ?? '?'}` +
      (flags.length > 0 ? `, ${flags.join(', ')}` : ''),
  )
  if (status.held) lines.push(`Holding: ${formatItem(mergeItems([status.held])[0]!)}`)
  // 工具单独一行、全部列出：干活前模型最需要知道的就是手里有什么工具，不能被一长串杂物挤掉。
  const inv = status.inventory ?? []
  const tools = inv.filter((i) => typeof i.durability === 'number')
  const others = inv.filter((i) => typeof i.durability !== 'number')
  lines.push(`Tools: ${tools.length > 0 ? formatItems(tools, 12) : 'none'}`)
  lines.push(`Inventory (${status.freeSlots ?? '?'} of 36 slots free): ${formatItems(others, opts.itemLimit ?? 40)}`)
  const armor = (status.armor ?? []).filter((a): a is Item => a !== null && a !== undefined)
  if (armor.length > 0) lines.push(`Armor: ${formatItems(armor, 4)}`)
  lines.push(`Current task: ${status.task ? formatTask(status.task) : 'none'}`)
  const queue = status.queue ?? []
  if (queue.length > 0) lines.push(`Queued tasks: ${queue.map((t) => `${t.id} ${t.type}`).join(', ')}`)
  if (status.settings && Object.keys(status.settings).length > 0) {
    lines.push(
      `Settings: ${Object.entries(status.settings)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ')}`,
    )
  }
  return lines.join('\n')
}

export function formatServerInfo(info: ServerInfo, botName: string, botDim: number | undefined): string {
  const lines: string[] = []
  const time: string[] = []
  if (typeof info.dayTime === 'number') time.push(`${formatDayTime(info.dayTime)} (${info.isDay === false ? 'night' : 'day'})`)
  if (info.raining !== undefined) time.push(info.raining ? 'raining' : 'clear')
  if (typeof info.tps === 'number' && info.tps < 15) time.push(`server is lagging (TPS ${info.tps.toFixed(1)})`)
  if (time.length > 0) lines.push(`Game time: ${time.join(', ')}`)
  const others = (info.players ?? []).filter((p) => p.name !== botName)
  if (others.length === 0) {
    lines.push('Players online: none')
  } else {
    const shown = others.slice(0, 20).map((p) => {
      const where = p.dim !== undefined && botDim !== undefined && p.dim !== botDim ? `in ${dimName(p.dim)} ` : ''
      return `${p.name}${p.isBot ? ' (bot)' : ''} ${where}at ${formatPos(p.pos)}`
    })
    lines.push(`Players online: ${shown.join('; ')}${others.length > 20 ? `; … ${others.length - 20} more` : ''}`)
  }
  return lines.join('\n')
}

export function formatContainer(c: ContainerInfo, itemLimit: number): string {
  // 抽屉（Storage Drawers）标出来：它的“格”是抽屉格，数量是真实库存，一格可以上万
  const drawers = c.kind === 'drawers' || c.kind === 'drawer_controller'
  const kind = c.kind === 'drawers' ? ' [drawers]' : c.kind === 'drawer_controller' ? ' [drawer controller]' : c.kind ? ` [${c.kind}]` : ''
  const slots = c.slots !== undefined ? ` ${c.usedSlots ?? '?'}/${c.slots} ${drawers ? 'drawer slots' : 'slots'} used` : ''
  const head = `${formatPos(c)} ${nameOf(c, { block: true }) ?? c.id} [${c.id}]${kind}${slots}`
  const notes: string[] = []
  // 抽屉管理器自己不装东西：它管的东西用 list_drawers 看
  if (c.kind === 'drawer_controller') notes.push(`manages ${c.drawers ?? '?'} drawer block(s); the library function list_drawers lists what they hold, given this position`)
  if (c.controller) notes.push(`managed by the drawer controller at ${formatPos(c.controller)}`)
  const auto = attachedText(c.attached)
  if (auto) notes.push(auto)
  const note = notes.length > 0 ? ` (${notes.join('; ')})` : ''
  if (c.kind === 'drawer_controller') return `${head}${note}`
  // 没列出来的种数算在一起：这里只列前 itemLimit 种的，加上身体自己没给的（moreKinds）。怎么看全由调用的工具在结果里说
  const merged = mergeItems(c.items ?? [])
  const hidden = Math.max(0, merged.length - itemLimit) + count(c.moreKinds)
  const listed = merged.slice(0, itemLimit).map(formatItem).join(', ')
  return `${head}${note}: ${merged.length === 0 && hidden === 0 ? 'empty' : `${listed}${hidden > 0 ? `${listed ? ', ' : ''}… and ${hidden} more kinds` : ''}`}`
}

const SEEN_KINDS: Record<string, string> = { container: 'container', drawers: 'drawers', drawer_controller: 'drawer controller', machine: 'machine' }

/** 一个玩家站在哪、朝哪看、准星指着什么、面前有哪些容器（world.player）。给模型看的英文。 */
export function formatPlayerView(name: string, view: PlayerView): string {
  const lines = [`${name} is in ${dimName(view.dim)} at ${formatPos(view.block ?? view.pos)}${view.facing ? `, facing ${view.facing}` : ''}.`]
  const seen = (b: NonNullable<PlayerView['lookingAt']>): string => {
    const kind = b.kind ? ` (${SEEN_KINDS[b.kind] ?? b.kind})` : ''
    const auto = attachedText(b.attached)
    return `${nameOf(b, { block: true }) ?? b.id ?? 'a block'} at ${formatPos(b)}${kind}${typeof b.dist === 'number' ? `, ${b.dist.toFixed(0)} blocks from them` : ''}${auto ? `; ${auto}` : ''}`
  }
  lines.push(view.lookingAt ? `Crosshair on: ${seen(view.lookingAt)}.` : 'Crosshair on nothing within reach of sight.')
  const ahead = (view.ahead ?? []).filter((b) => !(view.lookingAt && b.x === view.lookingAt.x && b.y === view.lookingAt.y && b.z === view.lookingAt.z))
  if (ahead.length > 0) lines.push(`Containers in front of them, most directly ahead first:\n${ahead.map((b) => `- ${seen(b)}`).join('\n')}`)
  return lines.join('\n')
}

export function formatEntities(entities: readonly EntityInfo[]): string {
  if (entities.length === 0) return 'none'
  const players: string[] = []
  const groups = new Map<string, { count: number; nearest: number }>()
  for (const e of entities) {
    const dist = typeof e.dist === 'number' ? e.dist : Number.NaN
    if (e.type === 'player') {
      players.push(`player ${e.name ?? '?'} at ${formatPos(e.pos)}${Number.isNaN(dist) ? '' : ` (${dist.toFixed(0)} blocks away)`}`)
      continue
    }
    const label =
      e.type === 'item' ? `dropped item ${e.item ? `${itemKey(e.item)}${quoted(e.item)}` : (e.name ?? '?')}` : `${e.type} ${e.name ?? '?'}`
    const amount = e.type === 'item' && e.item && typeof e.item.count === 'number' ? e.item.count : 1
    const g = groups.get(label) ?? { count: 0, nearest: Number.POSITIVE_INFINITY }
    g.count += amount
    if (!Number.isNaN(dist)) g.nearest = Math.min(g.nearest, dist)
    groups.set(label, g)
  }
  const rest = [...groups.entries()]
    .sort((a, b) => a[1].nearest - b[1].nearest)
    .slice(0, 20)
    .map(([label, g]) => `${g.count}× ${label}${Number.isFinite(g.nearest) ? ` (nearest ${g.nearest.toFixed(0)} away)` : ''}`)
  const extra = groups.size > 20 ? [`… ${groups.size - 20} more kinds`] : []
  return [...players, ...rest, ...extra].join('; ')
}

// ── 地形扫描 ──

export const FULL_GRID_MAX = 24

interface ScanSummary {
  width: number
  depth: number
  histogram: [number, number][] // [y, 列数]，按 y 升序
  topBlocks: [string, number][] // [方块 id, 列数]，按列数降序
  liquidIds: Set<string> // topBlocks 里哪些是液体
  minY: number
  maxY: number
  modeY: number
  meanY: number
  empty: number
}

export function summarizeScan(scan: ScanResult): ScanSummary {
  const hist = new Map<number, number>()
  const tops = new Map<string, number>()
  let sum = 0
  let n = 0
  let empty = 0
  scan.heights.forEach((row, zi) => {
    row.forEach((y, xi) => {
      if (typeof y !== 'number' || y < 0) {
        empty++
        return
      }
      hist.set(y, (hist.get(y) ?? 0) + 1)
      sum += y
      n++
      const idx = scan.tops?.[zi]?.[xi]
      const id = typeof idx === 'number' ? scan.palette?.[idx] : undefined
      if (id) tops.set(id, (tops.get(id) ?? 0) + 1)
    })
  })
  const histogram = [...hist.entries()].sort((a, b) => a[0] - b[0])
  let modeY = -1
  let modeCount = -1
  for (const [y, c] of histogram) {
    if (c > modeCount) {
      modeY = y
      modeCount = c
    }
  }
  const liquidIds = new Set<string>()
  for (const idx of scan.liquidPalette ?? []) {
    const id = scan.palette?.[idx]
    if (id) liquidIds.add(id)
  }
  return {
    width: scan.x2 - scan.x1 + 1,
    depth: scan.z2 - scan.z1 + 1,
    histogram,
    liquidIds,
    topBlocks: [...tops.entries()].sort((a, b) => b[1] - a[1]),
    minY: histogram.length > 0 ? histogram[0]![0] : -1,
    maxY: histogram.length > 0 ? histogram[histogram.length - 1]![0] : -1,
    modeY,
    meanY: n > 0 ? sum / n : -1,
    empty,
  }
}

function scanHeader(scan: ScanResult, s: ScanSummary): string[] {
  const lines: string[] = []
  lines.push(
    `Area x ${scan.x1}..${scan.x2}, z ${scan.z1}..${scan.z2} (${s.width}×${s.depth} = ${s.width * s.depth} columns). ` +
      `Height = y of the surface: the highest block or liquid that blocks a player. Leaves, plants and thin snow do not count; tree trunks do, so a tree shows up as one very tall column.`,
  )
  if (s.histogram.length === 0) {
    lines.push('No blocks found in this area (empty or not loaded).')
  } else {
    lines.push(`Heights: min ${s.minY}, max ${s.maxY}, most common ${s.modeY}, mean ${s.meanY.toFixed(1)}.`)
    lines.push(`Height histogram (y:columns): ${s.histogram.map(([y, c]) => `${y}:${c}`).join(' ')}`)
  }
  if (s.topBlocks.length > 0) {
    const shown = s.topBlocks.slice(0, 8).map(([id, c]) => `${id}${s.liquidIds.has(id) ? ' (liquid)' : ''} ${c}`)
    lines.push(`Surface blocks (columns): ${shown.join(', ')}${s.topBlocks.length > 8 ? ', …' : ''}`)
  }
  const notes: string[] = []
  if (scan.liquidColumns) notes.push(`${scan.liquidColumns} columns have liquid on top${scan.liquidPalette ? ' (marked ~ in the grid)' : ''}`)
  if (scan.stats?.unloaded) notes.push(`${scan.stats.unloaded} columns are in unloaded chunks (go closer and scan again)`)
  if (s.empty > 0) notes.push(`${s.empty} columns have no block`)
  if (notes.length > 0) lines.push(`Note: ${notes.join('; ')}.`)
  return lines
}

function cell(y: number): string {
  return y < 0 ? '--' : String(y)
}

/** 这一列的顶上是不是液体（要有 liquidPalette 才知道）。 */
function isLiquidColumn(scan: ScanResult, zi: number, xi: number): boolean {
  const idx = scan.tops?.[zi]?.[xi]
  return typeof idx === 'number' && (scan.liquidPalette ?? []).includes(idx)
}

/**
 * 区域 ≤ 24×24 时给完整高度网格；更大时给降采样网格（每格是若干列的平均高度）。
 * 两种情况都带高度直方图。
 */
export function formatScan(scan: ScanResult): string {
  const s = summarizeScan(scan)
  const lines = scanHeader(scan, s)

  if (s.histogram.length > 0) {
    if (s.width <= FULL_GRID_MAX && s.depth <= FULL_GRID_MAX) {
      lines.push(
        `Height grid. Rows are z from ${scan.z1} (north) to ${scan.z2} (south); in each row x runs from ${scan.x1} (west) to ${scan.x2} (east):`,
      )
      scan.heights.forEach((row, zi) => {
        lines.push(`z=${scan.z1 + zi}: ${row.map((y, xi) => cell(y) + (isLiquidColumn(scan, zi, xi) ? '~' : '')).join(' ')}`)
      })
    } else {
      const step = Math.ceil(Math.max(s.width, s.depth) / FULL_GRID_MAX)
      lines.push(
        `Downsampled height grid: each cell is the rounded mean height of a ${step}×${step} block of columns. ` +
          `Rows start at the given z (north to south); cells start at x ${scan.x1} and advance ${step} per cell (west to east). ` +
          `Scan a smaller area (at most ${FULL_GRID_MAX}×${FULL_GRID_MAX}) for exact heights:`,
      )
      for (let zi = 0; zi < s.depth; zi += step) {
        const cells: string[] = []
        for (let xi = 0; xi < s.width; xi += step) {
          let sum = 0
          let n = 0
          for (let dz = 0; dz < step && zi + dz < s.depth; dz++) {
            for (let dx = 0; dx < step && xi + dx < s.width; dx++) {
              const y = scan.heights[zi + dz]?.[xi + dx]
              if (typeof y === 'number' && y >= 0) {
                sum += y
                n++
              }
            }
          }
          cells.push(n > 0 ? String(Math.round(sum / n)) : '--')
        }
        lines.push(`z=${scan.z1 + zi}: ${cells.join(' ')}`)
      }
    }
  }

  // 身体只给近地表的带数据方块（最低地表以下 6 格以内），矿洞深处的不在里面
  const tiles = scan.tileEntities ?? []
  if (tiles.length > 0) {
    const shown = tiles.slice(0, 24).map((t) => `${t.id} ${formatPos(t)}`)
    lines.push(
      `Blocks with data near the surface (chests, machines and the like; area tasks leave them alone): ${shown.join(', ')}` +
        (tiles.length > 24 ? `, … ${tiles.length - 24} more` : ''),
    )
  }
  return lines.join('\n')
}

/** look_around 用的一行地形摘要。 */
export function formatTerrainSummary(scan: ScanResult): string {
  const s = summarizeScan(scan)
  if (s.histogram.length === 0) return 'no terrain data'
  const parts = [`ground height ${s.minY}..${s.maxY} (most common ${s.modeY})`]
  if (s.topBlocks.length > 0) {
    parts.push(
      `surface: ${s.topBlocks
        .slice(0, 5)
        .map(([id, c]) => `${id}${s.liquidIds.has(id) ? ' (liquid)' : ''} ${Math.round((c * 100) / (s.width * s.depth))}%`)
        .join(', ')}`,
    )
  }
  if (scan.liquidColumns) parts.push(`${scan.liquidColumns} liquid columns`)
  const tiles = scan.tileEntities?.length ?? 0
  if (tiles > 0) parts.push(`${tiles} blocks with data near the surface (chests/machines)`)
  return parts.join('; ')
}

// ── 图纸 ──

/** blueprint.check 的结果里每张表最多给模型看这么多种（身体最多给 30 种）。 */
export const BLUEPRINT_MATERIALS_SHOWN = 30
export const BLUEPRINT_KINDS_SHOWN = 15
/** 层的概况最多列这么多行（相邻且数字相同的层合成一行）。 */
export const BLUEPRINT_LAYER_ROWS_SHOWN = 24
/** 任务失败时的缺料清单身体不设上限，这里最多列这么多种。 */
export const BLUEPRINT_MISSING_SHOWN = 12

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 任务结果、错误详情里的一张表：只留带 id 的对象。 */
function kindList(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => isObject(x) && typeof x.id === 'string') : []
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** 一种方块：数量× id 或 id/meta，带显示名。 */
function kindText(n: unknown, b: { id?: unknown; meta?: unknown; name?: unknown }): string {
  const m: MergedItem = { id: String(b.id), meta: count(b.meta), count: count(n) }
  if (typeof b.name === 'string') m.name = b.name
  return formatItem(m)
}

/** 一张表最多列 limit 项，多出来的说明还有几种、共多少个。 */
function capKinds<T>(items: readonly T[], limit: number, line: (item: T) => string, amount: (item: T) => number): string[] {
  const out = items.slice(0, limit).map(line)
  if (items.length > limit) {
    const rest = items.slice(limit)
    out.push(`… and ${rest.length} more kinds (${rest.reduce((n, x) => n + amount(x), 0)} blocks)`)
  }
  return out
}

function materialText(m: BlueprintMaterial | Record<string, unknown>): string {
  return `${kindText(m.need, m)}${typeof m.have === 'number' ? ` (you carry ${m.have})` : ''}`
}

function byHandText(b: BlueprintByHand | Record<string, unknown>): string {
  return `${kindText(b.count, b)}${typeof b.why === 'string' && b.why.length > 0 ? ` (${b.why})` : ''}`
}

/** 挡路或多出来的一种方块：是不是天然地形、按现在的 clear 会挖掉多少、多少个带数据谁也不动。 */
function obstacleText(o: BlueprintObstacle | Record<string, unknown>): string {
  const notes: string[] = [o.natural === true ? 'natural terrain' : 'not natural terrain']
  if (typeof o.removable === 'number') notes.push(`clear digs ${o.removable}`)
  if (count(o.holdsData) > 0) notes.push(`${count(o.holdsData)} of them hold data and are never dug`)
  return `${kindText(o.count, o)} (${notes.join(', ')})`
}

export function formatBlueprintList(list: readonly BlueprintEntry[], folder: string | undefined): string {
  if (list.length === 0) {
    return (
      'There are no blueprints on the server yet. The owner can upload .schematic files on the blueprints page of the control panel' +
      `${folder ? `, or put them into ${folder} on the game server` : ''}.`
    )
  }
  const lines = list.slice(0, 60).map((b) => {
    if (b.error !== undefined || !b.size) return `- ${b.name}: cannot be used (${b.error ?? 'the server gave no size'})`
    return `- ${b.name}: ${b.size.x}×${b.size.y}×${b.size.z}, ${b.blocks ?? '?'} blocks`
  })
  if (list.length > 60) lines.push(`- … ${list.length - 60} more`)
  return `${list.length} blueprint(s) on the server. Sizes are x × y (height) × z, counted from the lowest corner:\n${lines.join('\n')}`
}

/** 层的概况：只列还有活要干的层，相邻且数字相同的合成一行。 */
function layerLines(layers: readonly number[][]): string[] {
  const rows = layers.filter((r) => Array.isArray(r) && r.length >= 6)
  const open = rows.filter((r) => r[1]! - r[2]! > 0 || r[5]! > 0)
  if (rows.length === 0) return []
  if (open.length === 0) return [`All ${rows.length} layers already match the blueprint.`]
  const runs: { from: number; to: number; row: number[] }[] = []
  for (const row of open) {
    const last = runs[runs.length - 1]
    if (last && row[0] === last.to + 1 && row.slice(1, 6).join() === last.row.slice(1, 6).join()) last.to = row[0]!
    else runs.push({ from: row[0]!, to: row[0]!, row })
  }
  const out = ["Layers with work left (done is out of that layer's blueprint blocks; layers not listed already match):"]
  for (const run of runs.slice(0, BLUEPRINT_LAYER_ROWS_SHOWN)) {
    const [, cells, done, toPlace, blocked, extra] = run.row
    const y = run.to === run.from ? `y ${run.from}` : `y ${run.from}..${run.to} (each layer)`
    out.push(`- ${y}: done ${done}/${cells}, toPlace ${toPlace}, blocked ${blocked}, extra ${extra}`)
  }
  if (runs.length > BLUEPRINT_LAYER_ROWS_SHOWN) out.push(`- … ${runs.length - BLUEPRINT_LAYER_ROWS_SHOWN} more rows`)
  return out
}

/**
 * blueprint.check 的结果排成短文本：各项计数、要放的材料、得由人放的、挡路的和多出来的、还有活要干的层。
 * clearGiven：这次检查有没有给 clear（不给就一块都不挖，要说清楚）。
 */
export function formatBlueprintCheck(c: BlueprintCheck, opts: { clearGiven: boolean }): string {
  const lines: string[] = []
  const box = c.box
  let head = `Blueprint "${c.name ?? '?'}" with its lowest corner at ${formatPos(c.origin)}.`
  if (box) {
    head +=
      ` Compared x ${box.x1}..${box.x2}, y ${box.y1}..${box.y2}, z ${box.z1}..${box.z2}` +
      ` (${box.x2 - box.x1 + 1}×${box.y2 - box.y1 + 1}×${box.z2 - box.z1 + 1}, x × y × z). Nothing was changed.`
  }
  lines.push(head)
  if (count(c.unloaded) > 0) {
    lines.push(
      `INCOMPLETE: ${c.unloaded} cells are in chunks that are not loaded and could not be compared. Those can only be compared from near enough for the chunks to be loaded, so these numbers are not the whole picture.`,
    )
  }

  const blocked = count(c.blocked)
  const extra = count(c.extra)
  lines.push(`Blueprint blocks in this range (cells): ${count(c.cells)}`)
  lines.push(`- done: ${count(c.done)} already in place`)
  lines.push(`- toPlace: ${count(c.toPlace)} empty spots you can fill`)
  lines.push(`- byHand: ${count(c.byHand)} empty spots a player has to fill`)
  lines.push(`- blocked: ${blocked} spots taken by some other block`)
  lines.push(`- extra: ${extra} blocks standing where the blueprint is empty`)
  if (blocked + extra > 0) {
    lines.push(
      opts.clearGiven
        ? `With this clear list ${count(c.willRemove)} of those ${blocked + extra} blocked/extra blocks would be dug out; the rest stay where they are.`
        : `No clear list was given, so nothing would be dug out: blocked spots are skipped and extra blocks stay.`,
    )
  }

  const materials = c.materials ?? []
  if (materials.length > 0) {
    lines.push('Materials to place (taken from your inventory, then from the supply containers):')
    for (const l of capKinds(materials, BLUEPRINT_MATERIALS_SHOWN, materialText, (m) => count(m.need))) lines.push(`- ${l}`)
    if (materials.every((m) => typeof m.have === 'number')) {
      const short = materials.reduce((n, m) => n + Math.max(0, count(m.need) - count(m.have)), 0)
      lines.push(
        short > 0
          ? `You are ${short} blocks short in total; they have to come from supply containers or the owner.`
          : 'You carry enough of all of them.',
      )
    }
  } else {
    lines.push('Materials to place: none.')
  }

  const byHand = c.byHandBlocks ?? []
  if (byHand.length > 0) {
    lines.push('A player has to place these (you cannot place them):')
    for (const l of capKinds(byHand, BLUEPRINT_KINDS_SHOWN, byHandText, (b) => count(b.count))) lines.push(`- ${l}`)
  }

  const blockedBy = c.blockedBy ?? []
  if (blockedBy.length > 0) {
    lines.push('In the way of blueprint blocks (blockedBy):')
    for (const l of capKinds(blockedBy, BLUEPRINT_KINDS_SHOWN, obstacleText, (o) => count(o.count))) lines.push(`- ${l}`)
  }
  const extraBlocks = c.extraBlocks ?? []
  if (extraBlocks.length > 0) {
    lines.push('Standing where the blueprint is empty (extraBlocks):')
    for (const l of capKinds(extraBlocks, BLUEPRINT_KINDS_SHOWN, obstacleText, (o) => count(o.count))) lines.push(`- ${l}`)
  }
  // 会被挖掉、又不是天然地形的：可能是别人盖的东西，单独点出来
  const built = [...blockedBy, ...extraBlocks].filter((o) => o.natural !== true && count(o.removable) > 0)
  if (built.length > 0) {
    lines.push(
      `Note: this clear list would dig out blocks that are not natural terrain (${built
        .slice(0, 8)
        .map((o) => kindText(o.removable, o))
        .join(', ')}${built.length > 8 ? ', …' : ''}). Someone may have built them.`,
    )
  }

  lines.push(...layerLines(c.layers ?? []))
  return lines.join('\n')
}

const BLUEPRINT_NOW_KEYS = ['cells', 'done', 'toPlace', 'byHand', 'blocked', 'extra', 'unloaded'] as const
const BLUEPRINT_RESULT_KEYS = new Set([
  'removed',
  'placed',
  'freeSlots',
  'skipped',
  'skippedExamples',
  'needsClimbingBlocks',
  'climbingBlocksLeftStanding',
  'now',
  'materials',
  'byHandBlocks',
  'blockedBy',
  'extraBlocks',
])

/**
 * blueprint 任务的结果排成几行短文本（字段名照协议）：挖了放了多少、跳过了什么、
 * now（此刻世界和图纸的对比）、还缺的材料、得由人放的、还挡着的。
 */
export function blueprintResultLines(result: Record<string, unknown>): string[] {
  const lines: string[] = []
  const head: string[] = []
  for (const key of ['removed', 'placed', 'freeSlots'] as const) {
    if (typeof result[key] === 'number') head.push(`${key} ${result[key]}`)
  }
  if (head.length > 0) lines.push(head.join(', '))
  if (isObject(result.skipped) && Object.keys(result.skipped).length > 0) {
    let s = `skipped ${compactJson(result.skipped, 300)}`
    const examples = Array.isArray(result.skippedExamples) ? result.skippedExamples.filter(isObject) : []
    if (examples.length > 0) {
      s += `, e.g. ${examples
        .slice(0, SKIPPED_EXAMPLES_SHOWN)
        .map((e) => `(${String(e.x)},${String(e.y)},${String(e.z)}) ${String(e.reason ?? '')}`.trim())
        .join('; ')}`
      if (examples.length > SKIPPED_EXAMPLES_SHOWN) s += `; ${examples.length - SKIPPED_EXAMPLES_SHOWN} more examples not shown`
    }
    lines.push(s)
  }
  if (result.needsClimbingBlocks === true) {
    lines.push('needsClimbingBlocks: true (some spots were too high to reach and you carry no dirt or cobblestone to climb on)')
  }
  if (count(result.climbingBlocksLeftStanding) > 0) lines.push(`climbingBlocksLeftStanding ${count(result.climbingBlocksLeftStanding)}`)
  if (isObject(result.now)) {
    const now = result.now
    const parts = BLUEPRINT_NOW_KEYS.filter((k) => typeof now[k] === 'number').map((k) => `${k} ${String(now[k])}`)
    lines.push(`now (the world compared with the blueprint): ${parts.join(', ')}`)
  }
  const materials = kindList(result.materials)
  if (materials.length > 0) lines.push(`materials still to place: ${materials.map(materialText).join(', ')}`)
  const byHand = kindList(result.byHandBlocks)
  if (byHand.length > 0) lines.push(`byHandBlocks (a player has to place them): ${byHand.map(byHandText).join(', ')}`)
  const blockedBy = kindList(result.blockedBy)
  if (blockedBy.length > 0) lines.push(`blockedBy (still in the way): ${blockedBy.map(obstacleText).join(', ')}`)
  const extraBlocks = kindList(result.extraBlocks)
  if (extraBlocks.length > 0) lines.push(`extraBlocks (still where the blueprint is empty): ${extraBlocks.map(obstacleText).join(', ')}`)
  // 协议以后加的字段不能悄悄丢掉
  const rest = Object.fromEntries(Object.entries(result).filter(([k]) => !BLUEPRINT_RESULT_KEYS.has(k)))
  if (Object.keys(rest).length > 0) lines.push(`other: ${compactJson(rest, 300)}`)
  return lines
}

/** blueprint 任务失败时的 detail：missing 是每种材料缺多少。 */
export function blueprintErrorLines(detail: Record<string, unknown>): string[] {
  const lines: string[] = []
  const { missing, supplyProblem, ...rest } = detail
  const kinds = kindList(missing)
  if (kinds.length > 0) {
    lines.push(
      `missing (left unplaced for want of material): ${capKinds(kinds, BLUEPRINT_MISSING_SHOWN, (m) => kindText(m.count, m), (m) => count(m.count)).join(', ')}`,
    )
  } else if (missing !== undefined) {
    rest.missing = missing
  }
  if (typeof supplyProblem === 'string') lines.push(`supplyProblem: ${supplyProblem}`)
  else if (supplyProblem !== undefined) rest.supplyProblem = supplyProblem
  if (Object.keys(rest).length > 0) lines.push(`detail: ${compactJson(rest, 300)}`)
  return lines
}

// ── 物品、配方、库存 ──

/** id/meta 的写法；meta 缺省（任何变体都行）时写明 any meta，免得和 meta 0 混在一起。 */
function idText(x: { id?: unknown; meta?: unknown }): string {
  return typeof x.meta === 'number' ? itemKey({ id: String(x.id), meta: x.meta }) : `${String(x.id)} (any meta)`
}

/** 名字加引号（前面带一个空格）；没有名字就是空的。给的是带 id 的东西时用 nameOf（有中文名用中文名），只给了名字就用它。 */
function quoted(x: unknown, opts: { block?: boolean } = {}): string {
  const shown = typeof x === 'string' ? displayName(x) : isObject(x) ? nameOf(x, opts) : undefined
  return shown ? ` "${shown}"` : ''
}

export function formatItemSearch(query: string, hits: readonly ItemSearchHit[]): string {
  if (hits.length === 0) {
    // 服务器上的显示名是英文的：中文名搜不到，要模型自己译成英文
    const english = /^[\x20-\x7e]*$/.test(query) ? '' : ' Item names on this server are in English: translate the name and search for that.'
    return `No item has all the words of "${query}" in its name or id.${english} Try fewer or other words (one distinctive word often works).`
  }
  const lines = hits.map((h) => {
    const r = h.recipes ?? {}
    const made: string[] = []
    if (count(r.crafting) > 0) made.push(`${r.crafting} crafting`)
    if (count(r.machine) > 0) made.push(`${r.machine} machine`)
    if (count(r.smelting) > 0) made.push(`${r.smelting} smelting`)
    const ores = (h.ores ?? []).length > 0 ? `; ore names: ${h.ores!.slice(0, 6).join(', ')}${h.ores!.length > 6 ? ', …' : ''}` : ''
    return `- ${itemKey({ id: h.id, meta: count(h.meta) })}${quoted(h)}: ${made.length > 0 ? `recipes: ${made.join(', ')}` : 'no known recipe'}${ores}`
  })
  return `${hits.length} item(s) match "${query}", best match first (written as id or id/meta):\n${lines.join('\n')}`
}

/** 配方里的一样原料：要几个、是确定的物品还是“任何 xxx”（矿辞名）、是不是只磨损不消耗的工具、身上已有几个。 */
export function ingredientText(ing: RecipeIngredient | Record<string, unknown>): string {
  const n = count(ing.count)
  let s: string
  if (typeof ing.id === 'string') {
    s = `${n}× ${idText(ing)}${quoted(ing)}`
  } else {
    // 矿辞（或一组可以互相替换的物品）：name 是 “Steel Screw (any screwSteel)” 这样的，去掉后缀就是 example 的名字
    const example = isObject(ing.example) ? ing.example : undefined
    const exampleName = typeof ing.name === 'string' ? ing.name.replace(/ \((any [^()]*)\)$| or similar$/, '') : undefined
    const eg = example ? `${idText(example)}${quoted(exampleName)}` : quoted(exampleName).trim()
    const kinds = count(ing.alternatives) > 1 ? `${count(ing.alternatives)} kinds fit` : ''
    if (typeof ing.ore === 'string') {
      s = `${n}× any ${ing.ore} (ore name${kinds ? `, ${kinds}` : ''}${eg ? `; e.g. ${eg}` : ''})`
    } else {
      s = `${n}× ${eg || 'an item'} or a similar item${kinds ? ` (${kinds})` : ''}`
    }
  }
  if (ing.tool === true) s += ' [tool: must be in your inventory, wears but is not used up]'
  if (typeof ing.have === 'number') s += `, you carry ${ing.have}`
  return s
}

function machineRecipeText(r: MachineRecipe): string {
  const power = r.tier && typeof r.eut === 'number' ? `${r.tier} (${r.eut} EU/t)` : (r.tier ?? (typeof r.eut === 'number' ? `${r.eut} EU/t` : ''))
  const head = [r.machine, power, typeof r.seconds === 'number' ? `${r.seconds} s` : ''].filter((x) => x.length > 0).join(', ')
  const fluid = (f: { name: string; mb: number }) => `${f.mb} mB ${f.name}`
  const inputs = [
    ...(r.inputs ?? []).map((i) => (i.notConsumed === true ? `${itemKey(i)}${quoted(i)} (stays in the machine, not used up)` : kindText(i.count, i))),
    ...(r.fluidInputs ?? []).map(fluid),
  ]
  const outputs = [...(r.outputs ?? []).map((o) => kindText(o.count, o)), ...(r.fluidOutputs ?? []).map(fluid)]
  return `${head}: ${inputs.join(' + ') || 'nothing'} -> ${outputs.join(' + ') || 'nothing'}`
}

/**
 * recipe.find 的结果排成短文本：合成台配方（每样原料一行）、机器配方（一条一行）、每种机器有几条（一行）、熔炉。
 * machineFilter：这次查询有没有指定只看某种机器。
 */
export function formatRecipes(r: RecipeFindResult, opts: { machineFilter?: string } = {}): string {
  const item = r.item ?? { id: '?' }
  const total = r.total ?? {}
  const crafting = r.crafting ?? []
  const machines = r.machines ?? []
  const smelted = r.smeltedFrom ?? []
  const what = `${itemKey({ id: item.id, meta: count(item.meta) })}${quoted(item)}`
  const totalCrafting = Math.max(count(total.crafting), crafting.length)
  const totalMachines = Math.max(count(total.machines), machines.length)
  const totalSmelting = Math.max(count(total.smelting), smelted.length)
  if (totalCrafting + totalMachines + totalSmelting === 0) {
    return `No recipe is known for ${what}: it is not crafted, made in a machine or smelted (it may be mined, dropped or traded). Look for it in storage or ask the owner.`
  }
  const lines: string[] = [`Recipes for ${what}: ${totalCrafting} crafting, ${totalMachines} machine, ${totalSmelting} smelting.`]

  if (crafting.length > 0) {
    lines.push('Crafting by hand (craft_item; "recipe" is the number to pass):')
    for (const c of crafting) {
      if (c.unreadable === true) {
        lines.push(`- recipe ${c.index}: its ingredients cannot be read (a mod's own kind of recipe), so craft_item cannot make it`)
        continue
      }
      const grid = c.grid === '2x2' ? '2x2 grid (no crafting table needed)' : `${c.grid ?? '3x3'} grid (needs a crafting table or crafting station)`
      lines.push(`- recipe ${c.index}: gives ${c.gives ?? 1}, ${grid}. Ingredients for one round:`)
      for (const ing of c.ingredients ?? []) lines.push(`  - ${ingredientText(ing)}`)
    }
    if (totalCrafting > crafting.length) lines.push(`(${crafting.length} of ${totalCrafting} crafting recipes shown)`)
  } else if (totalCrafting === 0) {
    lines.push('Crafting by hand: no recipe. craft_item cannot make it.')
  }

  if (machines.length > 0) {
    lines.push(
      'Machine recipes (run one with process_items on a single-block machine that find_machines lists with this recipe type and at least this tier; you cannot supply fluids):',
    )
    for (const m of machines) lines.push(`- ${machineRecipeText(m)}`)
  }
  const perMachine = Object.entries(r.machineRecipeCounts ?? {})
  if (perMachine.length > 0) {
    let line = `Machine recipes per machine: ${perMachine.map(([name, n]) => `${name} ${n}`).join(', ')}.`
    if (totalMachines > machines.length) {
      line += opts.machineFilter
        ? ` ${machines.length} shown for "${opts.machineFilter}".`
        : ` ${machines.length} of ${totalMachines} shown; give "way" (a machine name) to see the recipes of one machine.`
    }
    lines.push(line)
  }

  if (smelted.length > 0) lines.push(`Furnace: smelted from ${smelted.map((x) => kindText(x.count, x)).join(' or ')}.`)
  return lines.join('\n')
}

/** world.stock 的结果：每样东西一共多少、在哪几处（坐标、容器名、是不是抽屉、数量、具体是哪种物品）。 */
export function formatStock(res: StockResult, radius: number, from: { of: string; hint: string } = { of: 'you', hint: '' }): string {
  const looked = count(res.containersLookedInto)
  const items = res.items ?? []
  if (looked === 0) {
    return `There is no container within ${radius} blocks of ${from.of} (only loaded chunks are searched). ${from.of === 'you' ? 'Look around where the storage is instead: give "at" (the position of a chest or drawer controller there, or where your owner stands), or go there.' : 'Check the position with your owner.'}`
  }
  const lines: string[] = [
    `Looked into ${looked} container(s) within ${radius} blocks of ${from.of}. withdraw_items takes things out (container = the position, items = the exact id/meta).`,
  ]
  for (const it of items) {
    // 点名了 meta 的带上名字（不限 meta 的不带：那会是 meta 0 的名字，具体是哪几种下面每一处都写着）
    const what = typeof it.ore === 'string' ? `any ${it.ore} (ore name)` : `${idText(it)}${typeof it.meta === 'number' ? quoted(it) : ''}`
    if (count(it.total) === 0) {
      lines.push(`- ${what}: none in storage here`)
      continue
    }
    lines.push(`- ${what}: ${it.total} in total`)
    for (const p of it.places ?? []) {
      const exact = (p.items ?? []).map((x) => kindText(x.count, x)).join(', ')
      lines.push(`  - ${formatPos(p)} ${nameOf({ name: p.container }) ?? 'container'}${p.kind ? ` [${p.kind}]` : ''}: ${p.count}${exact ? ` (${exact})` : ''}`)
    }
    if (count(it.morePlaces) > 0) lines.push(`  - … and ${it.morePlaces} more place(s) holding less`)
  }
  return lines.join('\n')
}

/** craft 任务以 no_material 失败时的 detail：missing 是每样原料还差多少（格式同配方里的原料）。 */
export function craftErrorLines(detail: Record<string, unknown>): string[] {
  const lines: string[] = []
  const { missing, ...rest } = detail
  const list = Array.isArray(missing) ? missing.filter(isObject) : []
  if (list.length > 0) lines.push(`missing (not in your inventory, per ingredient): ${list.map(ingredientText).join('; ')}`)
  else if (missing !== undefined) rest.missing = missing
  if (Object.keys(rest).length > 0) lines.push(`detail: ${compactJson(rest, 300)}`)
  return lines
}

/** craft 任务的结果：多出来几个什么、背包还剩几格。 */
export function craftResultLines(result: Record<string, unknown>): string[] {
  const { crafted, item, freeSlots, ...rest } = result
  let line = `crafted ${isObject(item) ? kindText(crafted, item) : String(crafted)}`
  if (typeof freeSlots === 'number') line += `, freeSlots ${freeSlots}`
  if (Object.keys(rest).length > 0) line += `, other: ${compactJson(rest, 200)}`
  return [line]
}

/**
 * use 任务的结果：右键用了一件东西以后看得见的变化（背包里多了少了什么、是否打开了界面、血量和饱食度）。
 * 做了什么由那件物品自己决定，身体只报这些痕迹；什么都没变时明说，免得模型以为用成了。
 */
export function useResultLines(result: Record<string, unknown>, params?: Record<string, unknown>): string[] {
  const { used, gained, lost, openedScreen, health, food, freeSlots, ...rest } = result
  const item = isObject(params?.item) ? params.item : undefined
  // 没指定 meta 时不按 id + meta 查名字（那会拿到 meta 0 的名字）：只拿服务器给的名字在这个 id 下对
  const what = nameOf({ id: item?.id, meta: item?.meta, name: used }, { block: typeof item?.meta !== 'number' }) ?? (typeof item?.id === 'string' ? idText(item) : 'the item')
  const got = kindList(gained)
  const gone = kindList(lost)
  const list = (items: Record<string, unknown>[]): string => (items.length > 0 ? items.map((x) => kindText(x.count, x)).join(', ') : 'nothing')
  const parts = [`used "${what}"`, `gained: ${list(got)}`, `lost: ${list(gone)}`]
  if (openedScreen === true) parts.push('it opened a screen, which was closed again: to put things in or take them out, use deposit_items / withdraw_items with "bag"')
  else if (got.length === 0 && gone.length === 0) parts.push('nothing visible changed in your inventory')
  if (typeof health === 'number') parts.push(`health ${health}`)
  if (typeof food === 'number') parts.push(`food ${food}`)
  if (typeof freeSlots === 'number') parts.push(`freeSlots ${freeSlots}`)
  if (Object.keys(rest).length > 0) parts.push(`other: ${compactJson(rest, 200)}`)
  return [parts.join('; ')]
}

// ── 任务书 ──

export const QUEST_LINES_SHOWN = 120

/** 任务要的或奖励的一样物品。任务书里存的不一定齐全：id、meta、名字都可能缺。 */
export function questItemText(i: QuestItem): string {
  const n = count(i.count) || 1
  const what = typeof i.id === 'string' ? `${idText(i)}${quoted(i)}` : quoted(i.name).trim() || 'an unknown item'
  return `${n}× ${what}${typeof i.ore === 'string' && i.ore.length > 0 ? ` (or any ${i.ore})` : ''}`
}

/** 章节列表：每章总数；给了玩家时还有已完成的和现在能做的。 */
export function formatQuestLines(res: { lines?: QuestLine[]; quests?: number }, player: string | undefined): string {
  const lines = res.lines ?? []
  if (lines.length === 0) return 'The quest book has no chapters.'
  const withProgress = lines.some((l) => typeof l.complete === 'number')
  const head =
    `The quest book has ${res.quests ?? '?'} quests in ${lines.length} chapters, in the book's order. ` +
    (withProgress ? `Progress of ${player ?? 'the player'} per chapter: done / can be done now / total.` : 'Quests per chapter (no player given, so no progress):')
  const rows = lines.slice(0, QUEST_LINES_SHOWN).map((l) =>
    withProgress ? `- ${l.name}: ${l.complete ?? 0} / ${l.available ?? 0} / ${l.quests}` : `- ${l.name}: ${l.quests}`,
  )
  if (lines.length > QUEST_LINES_SHOWN) rows.push(`- … ${lines.length - QUEST_LINES_SHOWN} more chapters`)
  return `${head}\n${rows.join('\n')}`
}

/** 搜索结果：id、标题、章节、状态。 */
export function formatQuestSearch(
  res: { quests?: QuestHit[]; total?: number },
  asked: { query?: string; line?: string; state?: string; player?: string },
): string {
  const quests = res.quests ?? []
  const filters: string[] = []
  if (asked.state) filters.push(`state ${asked.state}`)
  if (asked.line) filters.push(`chapter contains "${asked.line}"`)
  if (asked.query) filters.push(`words "${asked.query}"`)
  const what = `${filters.length > 0 ? ` (${filters.join('; ')})` : ''}${asked.player ? ` for ${asked.player}` : ''}`
  if (quests.length === 0) {
    // 这个函数只在本地没有任务书资料、搜索落到服务器上时用：服务器那本是英文的
    const english = /^[\x20-\x7e]*$/.test(`${asked.query ?? ''}${asked.line ?? ''}`)
      ? ''
      : " The local quest book data is not loaded, so this search ran on the game server, whose quest book is in English: search with English words."
    return `No quest matches${what}.${english}`
  }
  const total = Math.max(count(res.total), quests.length)
  const head =
    total > quests.length
      ? `${total} quests match${what}; the first ${quests.length} are shown. Narrow it down with query or line, or raise limit.`
      : `${total} quest(s) match${what}:`
  const rows = quests.map((q) => `- ${q.id} "${q.name}"${q.line ? ` [${q.line}]` : ''}${q.state ? `: ${q.state}` : ''}`)
  return `${head} (id "title" [chapter]: state)\n${rows.join('\n')}`
}

/** 一个任务的详情：说明、前置（完成没）、每个子任务要什么（完成没、物品是否被收走）、奖励。 */
export function formatQuest(q: QuestDetail, player: string | undefined): string {
  const lines: string[] = []
  let head = `Quest ${q.id} "${q.name}"${q.line ? `, chapter "${q.line}"` : ''}.`
  if (q.state) {
    head += ` State${player ? ` for ${player}` : ''}: ${q.state}`
    if (q.state === 'locked') head += ' (a required quest is not complete yet)'
    else if (q.state === 'available') head += ' (unlocked, not complete yet)'
    else if (/unclaimed/.test(q.state)) head += ' (done; the reward has not been collected)'
    head += '.'
  }
  lines.push(head)
  const description = (q.description ?? '').replace(/\s+/g, ' ').trim()
  if (description.length > 0) lines.push(`Description: ${description}`)

  const requires = q.requires ?? []
  if (requires.length > 0) {
    lines.push('Requires these quests to be complete first:')
    for (const r of requires) lines.push(`- ${r.id} "${r.name}"${r.complete === undefined ? '' : r.complete ? ': done' : ': NOT done'}`)
  }

  const tasks = q.tasks ?? []
  lines.push(tasks.length > 0 ? 'Tasks (what the quest asks for):' : 'Tasks: none listed.')
  for (const t of tasks) {
    const notes: string[] = []
    if (t.complete !== undefined) notes.push(t.complete ? 'done' : 'not done')
    if (t.consumed !== undefined) notes.push(t.consumed ? 'the items are taken when handed in' : 'the items are kept')
    const wants: string[] = [
      ...(t.items ?? []).map(questItemText),
      ...(t.fluids ?? []).map((f) => `${f.mb} mB ${f.fluid}`),
    ]
    if (typeof t.target === 'string') wants.push(`kill ${t.count ?? 1}× ${t.target}`)
    if (t.location) wants.push(`be at ${formatPos(t.location)}${t.location.dim !== undefined ? ` in ${dimName(t.location.dim)}` : ''}`)
    lines.push(`- ${[t.type, ...notes].join(', ')}: ${wants.join(', ') || '(nothing more is recorded about it)'}`)
  }

  const rewards = q.rewards ?? []
  if (rewards.length > 0) {
    lines.push('Rewards:')
    for (const r of rewards) lines.push(`- ${r.type}${(r.items ?? []).length > 0 ? `: ${r.items!.map(questItemText).join(', ')}` : ''}`)
  }
  return lines.join('\n')
}

// ── 机器 ──

/** 配方页的编号 → 页名（配方册里的中文名）。 */
export type WayName = (key: string) => string | undefined

/** 一台机器现在的状态：等级、有没有电、是不是正在忙、是不是被关掉了；多方块还有结构完不完整、炉温。 */
function machineStateText(m: MachineInfo | Record<string, unknown>, wayName?: WayName): string {
  if (m.unreadable === true) return 'its state cannot be read'
  const parts: string[] = []
  if (m.kind === 'multiblock') parts.push(m.formed === false ? 'multiblock, STRUCTURE NOT COMPLETE (cannot be used)' : 'multiblock, formed')
  // 跑哪种配方：配方册里那一页的名字（find_recipes 里的 way 就是它），没有配方册时是身体给的英文
  const way = typeof m.recipeKey === 'string' ? wayName?.(m.recipeKey) : undefined
  if (way !== undefined) parts.push(`runs "${way}" recipes`)
  else if (typeof m.recipes === 'string') parts.push(`runs ${m.recipes} recipes`)
  if (typeof m.tier === 'string') parts.push(`tier ${m.tier}${m.kind === 'multiblock' && typeof m.inputVoltage === 'number' ? ` (${m.inputVoltage} V)` : ''}`)
  if (typeof m.heat === 'number') parts.push(`coil heat ${m.heat} K`)
  if (typeof m.circuit === 'number') parts.push(`programmed circuit ${m.circuit} set`)
  // 蒸汽机器不烧电：0 EU 不是“没电”（它有没有蒸汽身体读不出来）
  const steam = m.steam === true || /\bSteam\b/.test(typeof m.name === 'string' ? m.name : '')
  if (steam) parts.push('steam-powered (whether it has steam cannot be read)')
  else if (typeof m.storedEU === 'number') parts.push(m.storedEU > 0 ? `has power (${m.storedEU} EU stored)` : 'NO POWER (0 EU stored)')
  if (m.switchedOff === true) parts.push('SWITCHED OFF')
  if (m.active === true) {
    const done = count(m.maxProgress) > 0 ? ` (${Math.round((count(m.progress) * 100) / count(m.maxProgress))}% of the current item done)` : ''
    parts.push(`BUSY${done}`)
  } else if (m.active === false) {
    parts.push(typeof m.idleReason === 'string' && m.idleReason.length > 0 ? `idle (it says: ${m.idleReason})` : 'idle')
  }
  return parts.join(', ')
}

/** 紧挨着一个容器、会自己送料抽料的方块：写出来提醒这是自动化的一环。 */
export function attachedText(attached: readonly AttachedBlock[] | undefined): string {
  if (!attached || attached.length === 0) return ''
  return `AUTOMATED: ${attached.map((a) => `${nameOf(a, { block: true }) ?? a.kind ?? 'pipe'} at ${formatPos(a)}`).join(', ')} feeds or drains it`
}

/** 多方块机器的一个总线或仓。 */
function hatchLine(h: MachineHatch): string {
  const parts: string[] = [`${h.kind ?? 'hatch'} ${formatPos(h)}`]
  if (h.slots !== undefined) parts.push(`${h.usedSlots ?? '?'}/${h.slots} slots used`)
  if (typeof h.circuit === 'number') parts.push(`circuit ${h.circuit}`)
  if (h.capacity !== undefined) parts.push(h.fluid ? `${h.amount ?? 0}/${h.capacity} mB ${h.fluidName ?? h.fluid}` : `empty (${h.capacity} mB)`)
  const passes = (h.passesTo ?? []).map((p) => `${nameOf(p, { block: true }) ?? 'container'} at ${formatPos(p)}`)
  if (passes.length > 0) parts.push(`keeps nothing: pushes into ${passes.join(', ')}`)
  const auto = attachedText(h.attached)
  if (auto) parts.push(auto)
  return `    ${parts.join(', ')}`
}

/** world.machines 的结果：每台机器的坐标、名字、跑哪种配方、等级、有没有电、是不是正在忙。 */
/** 身体读不懂状态的机器（照配方册认出来的）：find_machines 里的一行。 */
export interface OtherMachineLine {
  x: number
  y: number
  z: number
  id: string
  name?: string
  item: { id: string; meta: number }
  /** 它能做哪几页配方（页的名字）。 */
  wayNames: string[]
  attached?: readonly AttachedBlock[]
}

function otherMachineLines(others: readonly OtherMachineLine[], radius: number): string[] {
  if (others.length === 0) return []
  const lines = [
    `${others.length} other machine(s) within ${Math.min(radius, 32)} blocks (other mods' machines, furnaces: recognised from the recipe book; their state cannot be read, but process_items works on them the way a player would — inputs in, wait, products out):`,
  ]
  for (const o of others.slice(0, 30)) {
    const auto = attachedText(o.attached)
    lines.push(`- ${formatPos(o)} "${nameOf(o.item) ?? nameOf(o, { block: true }) ?? o.name ?? o.id}": runs ${o.wayNames.slice(0, 4).map((w) => `"${w}"`).join(', ')}${o.wayNames.length > 4 ? ` and ${o.wayNames.length - 4} more kinds of` : ''} recipes${auto ? `; ${auto}` : ''}`)
  }
  if (others.length > 30) lines.push(`- … and ${others.length - 30} more`)
  return lines
}

export function formatMachines(
  res: { machines?: MachineInfo[]; total?: number },
  asked: { radius: number; name?: string; wayName?: WayName; of?: string; hint?: string; others?: readonly OtherMachineLine[] },
): string {
  const of = asked.of ?? 'you'
  const machines = res.machines ?? []
  const filter = asked.name ? ` whose name or recipe type contains "${asked.name}"` : ''
  const others = otherMachineLines(asked.others ?? [], asked.radius)
  if (machines.length === 0) {
    const none =
      `No GregTech machine${filter} within ${asked.radius} blocks of ${of} (only loaded chunks are searched). ` +
      (asked.name ? 'Look again without "name" to see every machine here. ' : '')
    if (others.length > 0) return `${none.trim()}\n${others.join('\n')}`
    return `${none}Any block with a screen can still be used as a machine: give its position to process_items, or open it with open_screen.${asked.hint ?? ''}`
  }
  const total = Math.max(count(res.total), machines.length)
  const lines: string[] = []
  for (const m of machines) {
    const far = typeof m.dist === 'number' ? `, ${Math.round(m.dist)} blocks away` : ''
    lines.push(`- ${formatPos(m)}${quoted(m) || ' machine'}: ${machineStateText(m, asked.wayName)}${far}`)
    for (const h of [...(m.inputBuses ?? []), ...(m.inputHatches ?? []), ...(m.outputBuses ?? []), ...(m.outputHatches ?? [])]) lines.push(hatchLine(h))
  }
  const more = total > machines.length ? ` (${total} in range, the nearest ${machines.length} shown: give "name" or a smaller radius to see the others)` : ''
  return (
    `${machines.length} GregTech machine(s)${filter} within ${asked.radius} blocks of ${of}${more}, nearest first. ` +
    `A machine can run a recipe when it runs that kind of recipe, its tier is at least the recipe's, it has power and is idle:\n${lines.join('\n')}` +
    (others.length > 0 ? `\n${others.join('\n')}` : '')
  )
}

/** process 任务失败时的 detail：那台机器的状态，加上据此最可能的原因。 */
export function processErrorLines(detail: Record<string, unknown>): string[] {
  const where = typeof detail.x === 'number' ? ` at ${formatPos(detail as { x: number; y: number; z: number })}` : ''
  let line = `machine${quoted(detail)}${where}: ${machineStateText(detail)}`
  if (detail.storedEU === 0) line += '. It has no power, so it cannot run anything: tell the owner'
  else if (detail.switchedOff === true) line += '. Someone switched it off: tell the owner'
  else if (detail.active === true) line += '. It is busy with something else: wait, or use another machine'
  else line += '. It has power and is idle, so the cause is the recipe: a missing programmed circuit or mold, a missing fluid, inputs that are not a recipe of this machine or need a higher tier, or full output slots'
  return [line]
}

/** process 任务的结果：放进去多少、取回了什么（产物，以及没被消耗的电路、模具和没用完的原料）。 */
export function processResultLines(result: Record<string, unknown>): string[] {
  const { put, outputs, timedOut, freeSlots, ...rest } = result
  const got = kindList(outputs)
  let line = `put ${count(put)} item(s) into the machine; took out: ${got.length > 0 ? got.map((o) => kindText(o.count, o)).join(', ') : 'nothing'}`
  if (timedOut === true) line += '; timedOut: the wait ran out before it finished, the machine is still working on the rest'
  if (typeof freeSlots === 'number') line += `; freeSlots ${freeSlots}`
  if (Object.keys(rest).length > 0) line += `; other: ${compactJson(rest, 200)}`
  return [line]
}
