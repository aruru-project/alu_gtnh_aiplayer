// 简图画的东西：一个盒子，每一格是一种方块（或者空气）。草稿和世界里的一块地方都先变成这个，再交给 views.ts 画。

import type { Draft } from '../design/draft.ts'
import { MARKER_PREFIX, UNLOADED_ID, isAir } from './looks.ts'
import type { BlockKind } from './looks.ts'
import { isRecord } from '../util.ts'

export interface VoxelGrid {
  /** x 是东西向（东为正），y 是高，z 是南北向（南为正）。 */
  size: { x: number; y: number; z: number }
  /** (0, 0, 0) 那一格在世界里的坐标。草稿没有位置，是 0, 0, 0。 */
  origin: { x: number; y: number; z: number }
  /** kinds[0] 永远是空气。 */
  kinds: BlockKind[]
  /** cells[(y * size.z + z) * size.x + x] 是 kinds 的下标。 */
  cells: Uint16Array
}

/** 一边最多这么多格：world.blocks 的上限。 */
export const AREA_MAX_SIDE = 64

/** 数据不对（身体回的 world.blocks 对不上约定）：消息给模型看。 */
export class GridError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GridError'
  }
}

const AIR: BlockKind = { id: 'minecraft:air', meta: 0 }

export function gridFromDraft(draft: Draft): VoxelGrid {
  // 草稿的格子里 n 指 kinds[n - 1]，0 是空：前面垫一个空气，下标就对上了
  return { size: { ...draft.size }, origin: { x: 0, y: 0, z: 0 }, kinds: [AIR, ...draft.kinds], cells: draft.cells }
}

/**
 * world.blocks 的回应 → 盒子。回应是身体给的，照约定检查一遍：
 * 尺寸是 1 到 64 的整数、调色板 0 号是空气、runs 是“下标, 连续几格”交替并且正好铺满。
 * 自己存下的盒子（render/scene.ts 的 StoredBlocks）也是这个样子，读回来时 maxSide 给大一些（草稿每边可以到 256）。
 */
export function gridFromBlocks(raw: unknown, maxSide: number = AREA_MAX_SIDE): VoxelGrid & { unloaded: number } {
  if (!isRecord(raw)) throw new GridError('the answer is not an object')
  const whole = (v: unknown, what: string): number => {
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new GridError(`${what} is not a whole number`)
    return v
  }
  const side = (v: unknown, what: string): number => {
    const n = whole(v, what)
    if (n < 1 || n > maxSide) throw new GridError(`${what} is ${n}; it must be 1 to ${maxSide}`)
    return n
  }
  const size = { x: side(raw.sx, 'sx'), y: side(raw.sy, 'sy'), z: side(raw.sz, 'sz') }
  const origin = { x: whole(raw.x, 'x'), y: whole(raw.y, 'y'), z: whole(raw.z, 'z') }
  if (!Array.isArray(raw.palette) || raw.palette.length === 0 || raw.palette.length > 65535) throw new GridError('the palette is missing')
  const kinds: BlockKind[] = raw.palette.map((entry: unknown, i: number) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) throw new GridError(`palette entry ${i} has no block id`)
    const meta = typeof entry.meta === 'number' && Number.isInteger(entry.meta) && entry.meta >= 0 && entry.meta <= 15 ? entry.meta : 0
    return { id: entry.id, meta }
  })
  if (!isAir(kinds[0]!)) throw new GridError('palette entry 0 must be air')
  if (!Array.isArray(raw.runs) || raw.runs.length % 2 !== 0) throw new GridError('the runs are missing')
  const volume = size.x * size.y * size.z
  const cells = new Uint16Array(volume)
  let at = 0
  for (let i = 0; i < raw.runs.length; i += 2) {
    const index: unknown = raw.runs[i]
    const count: unknown = raw.runs[i + 1]
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= kinds.length) throw new GridError('a run names a block that is not in the palette')
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || at + count > volume) throw new GridError('the runs do not match the size of the area')
    if (index !== 0) cells.fill(index, at, at + count)
    at += count
  }
  if (at !== volume) throw new GridError('the runs do not match the size of the area')
  const unloadedIndex = kinds.findIndex((k) => k.id === UNLOADED_ID)
  let unloaded = 0
  if (unloadedIndex > 0) for (const cell of cells) if (cell === unloadedIndex) unloaded++
  return { size, origin, kinds, cells, unloaded }
}

/** 只看这个范围（盒子里的下标，两端都含；没给的那一头到边）。 */
export interface GridBox {
  x1?: number
  x2?: number
  y1?: number
  y2?: number
  z1?: number
  z2?: number
}

/** 裁出一块。范围整个在盒子外面时抛 GridError。 */
export function cropGrid(grid: VoxelGrid, box: GridBox): VoxelGrid {
  const range = (axis: 'x' | 'y' | 'z'): [number, number] => {
    const max = grid.size[axis] - 1
    const lo = box[`${axis}1`] ?? 0
    const hi = box[`${axis}2`] ?? max
    if (lo > hi) throw new GridError(`${axis}1 (${lo}) is above ${axis}2 (${hi})`)
    if (hi < 0 || lo > max) throw new GridError(`${axis} ${lo} to ${hi} is outside, which spans ${axis} 0 to ${max}`)
    return [Math.max(0, lo), Math.min(max, hi)]
  }
  const [x1, x2] = range('x')
  const [y1, y2] = range('y')
  const [z1, z2] = range('z')
  if (x1 === 0 && y1 === 0 && z1 === 0 && x2 === grid.size.x - 1 && y2 === grid.size.y - 1 && z2 === grid.size.z - 1) return grid
  const size = { x: x2 - x1 + 1, y: y2 - y1 + 1, z: z2 - z1 + 1 }
  const cells = new Uint16Array(size.x * size.y * size.z)
  for (let y = 0; y < size.y; y++) {
    for (let z = 0; z < size.z; z++) {
      const from = ((y + y1) * grid.size.z + z + z1) * grid.size.x + x1
      cells.set(grid.cells.subarray(from, from + size.x), (y * size.z + z) * size.x)
    }
  }
  return { size, origin: { x: grid.origin.x + x1, y: grid.origin.y + y1, z: grid.origin.z + z1 }, kinds: grid.kinds, cells }
}

/** 图上标一个位置：自己（who 0）或者别的玩家（who 1）。坐标是世界坐标，脚踩的那一格。 */
export interface Marker {
  name: string
  who: 0 | 1
  x: number
  y: number
  z: number
}

/** 标记在图例里的 id："@Alu"。 */
export function markerId(name: string): string {
  return `${MARKER_PREFIX}${name}`
}

/**
 * 把位置标记放进盒子：脚和头两格，只占空气格（不盖掉方块）。在盒子外面的不放。返回放进去了的那些。
 * 不改传入的盒子。
 */
export function withMarkers(grid: VoxelGrid, markers: readonly Marker[]): { grid: VoxelGrid; placed: Marker[] } {
  const placed: Marker[] = []
  let cells = grid.cells
  let kinds = grid.kinds
  for (const marker of markers) {
    const x = Math.floor(marker.x) - grid.origin.x
    const z = Math.floor(marker.z) - grid.origin.z
    if (x < 0 || x >= grid.size.x || z < 0 || z >= grid.size.z) continue
    let put = false
    for (let dy = 0; dy < 2; dy++) {
      const y = Math.floor(marker.y) - grid.origin.y + dy
      if (y < 0 || y >= grid.size.y) continue
      const at = (y * grid.size.z + z) * grid.size.x + x
      if (cells[at] !== 0) continue
      if (!put) {
        if (cells === grid.cells) {
          cells = grid.cells.slice()
          kinds = [...grid.kinds]
        }
        kinds.push({ id: markerId(marker.name), meta: marker.who })
        put = true
      }
      cells[at] = kinds.length - 1
    }
    if (put) placed.push(marker)
  }
  return { grid: cells === grid.cells ? grid : { ...grid, kinds, cells }, placed }
}

/** 每种方块有多少格（下标同 kinds）。 */
export function countKinds(grid: VoxelGrid): Uint32Array {
  const counts = new Uint32Array(grid.kinds.length)
  for (const cell of grid.cells) counts[cell]!++
  return counts
}
