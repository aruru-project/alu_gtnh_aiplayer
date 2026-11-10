// 把协议数据排成给模型看的紧凑文本。agent 的状态快照和工具结果共用。

import type {
  BotStatus,
  ContainerInfo,
  EntityInfo,
  InventoryItem,
  Item,
  ScanResult,
  ServerInfo,
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

export function formatItem(m: MergedItem): string {
  let s = `${m.count}× ${itemKey(m)}`
  const name = displayName(m.name)
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
  if (opts.params && task.params) s += ` params=${compactJson(task.params, 300)}`
  if (task.state === 'failed' || task.error) {
    const e = task.error
    s += ` error=${e?.code ?? 'unknown'}`
    if (e?.message) s += `: ${e.message}`
    if (e?.detail && Object.keys(e.detail).length > 0) s += ` detail=${compactJson(e.detail, 300)}`
  }
  if (task.result && Object.keys(task.result).length > 0) {
    s += ` ${task.state === 'done' ? 'result' : 'partial result'}=${compactJson(trimTaskResult(task.result), 600)}`
  }
  return s
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
  const slots = c.slots !== undefined ? ` ${c.usedSlots ?? '?'}/${c.slots} slots used` : ''
  return `${formatPos(c)} ${displayName(c.name) ?? c.id} [${c.id}]${slots}: ${formatItems(c.items ?? [], itemLimit)}`
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
      e.type === 'item' ? `dropped item ${e.item ? itemKey(e.item) : (e.name ?? '?')}` : `${e.type} ${e.name ?? '?'}`
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
