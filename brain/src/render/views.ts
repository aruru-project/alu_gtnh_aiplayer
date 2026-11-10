// 简图：把一个盒子（grid.ts）按方块颜色画成一张 PNG。四种看法：
//   iso    从斜上方看的等轴测图（站在四个角之一），每个露在外面的方块画顶面和两个侧面，三个面明暗不同；
//   top    从正上方看，每一列画最上面那块，越高越亮；
//   side   从一个侧面平着看（立面），每个位置画最靠前的那块，越远越暗；
//   layer  只看某一层，从上往下看。
// 图上带一行说明和图例。这是按颜色画的示意图，不是游戏里的画面：没有贴图，非整块的方块只是画小一点。

import { cropGrid, countKinds } from './grid.ts'
import type { VoxelGrid } from './grid.ts'
import { MARKER_PREFIX, UNLOADED_ID, isAir, kindKey } from './looks.ts'
import type { BlockKind, BlockLook, BlockLooks } from './looks.ts'
import { encodePng } from './png.ts'
import { BLACK, GLYPH_ADVANCE, Raster, mix, shade, textWidth } from './raster.ts'
import type { RGB } from './raster.ts'

export const CORNERS = ['southeast', 'southwest', 'northwest', 'northeast'] as const
/** 等轴测图里“站在哪个角”。站在东南角就是朝西北看，看得见南面和东面。 */
export type Corner = (typeof CORNERS)[number]
export const SIDES = ['south', 'west', 'north', 'east'] as const
/** 立面图里“站在哪一边”。站在南边就是朝北看，看到的是南面。 */
export type Side = (typeof SIDES)[number]

export type ViewSpec = { view: 'iso'; from: Corner } | { view: 'top' } | { view: 'side'; from: Side } | { view: 'layer'; layer: number }

export interface RenderOptions {
  /** 整张图最长的那一边不超过这么多像素（默认 1024）。范围大时每格画小一点。 */
  maxSize?: number
  /** 只要画面本身，不带说明、坐标和图例（面板上的小缩略图用）。 */
  plain?: boolean
  /** 说明的第一行：画的是什么。只能是 ASCII。 */
  title?: string
}

export interface LegendEntry {
  kind: BlockKind
  /** 画的这个范围里有多少格。 */
  count: number
  look: BlockLook
}

export interface Picture {
  png: Buffer
  width: number
  height: number
  /** 一格方块画成多少像素（等轴测图里是菱形半宽）。 */
  cell: number
  /** 画的这个范围里的方块，多的在前。 */
  legend: LegendEntry[]
}

export const PICTURE_MAX_SIZE = 1024
/** 等轴测图三个面的明暗：顶面原色，左边的面暗一点，右边的面最暗。形状靠这个读出来。 */
export const ISO_SHADE = { top: 1, left: 0.8, right: 0.62 } as const
/** 立面图里最远的东西暗到原来的多少；俯视图里最低的地方暗到多少。 */
export const DEPTH_SHADE = { side: 0.58, top: 0.8 } as const
const BACKGROUND: RGB = [238, 242, 247]
const INK: RGB = [28, 32, 40]
const FAINT: RGB = [110, 118, 130]
const PAD = 10
const TEXT_SCALE = 2
const CHAR = GLYPH_ADVANCE * TEXT_SCALE
const LINE = 20
/** 图上的图例最多列这么多种，再多的合成一句。 */
const LEGEND_SHOWN = 12
const LEGEND_NAME_CHARS = 20
const LEGEND_COLUMN = (LEGEND_NAME_CHARS + 9) * CHAR + 22
/** 带说明的图至少这么宽：放得下两列图例，说明也不至于一行只有几个词。 */
const MIN_WIDTH = 2 * LEGEND_COLUMN + 2 * PAD
const CELL_MAX = 32

/** 画的这个范围里的方块和数量，多的在前；空气不算。 */
export function legendOf(grid: VoxelGrid, looks: BlockLooks): LegendEntry[] {
  const counts = countKinds(grid)
  const out: LegendEntry[] = []
  grid.kinds.forEach((kind, i) => {
    if (i === 0 || counts[i] === 0 || isAir(kind)) return
    out.push({ kind, count: counts[i]!, look: looks.of(kind) })
  })
  // 位置记号排最前面（图上的图例只列得下前十几种，记号不能被挤掉）
  return out.sort((a, b) => Number(b.look.marker === true) - Number(a.look.marker === true) || b.count - a.count || kindKey(a.kind).localeCompare(kindKey(b.kind)))
}

/** 图例里的名字：只有 ASCII（图上的字只会画 ASCII），原版方块省掉 "minecraft:"，太长的掐掉中间。 */
export function legendLabel(entry: LegendEntry): string {
  const { kind, look } = entry
  if (kind.id === UNLOADED_ID) return 'not loaded'
  if (kind.id.startsWith(MARKER_PREFIX)) return kind.meta === 0 ? `YOU (${kind.id.slice(1)})` : `player ${kind.id.slice(1)}`
  let name = kindKey(kind).replace(/^minecraft:/, '')
  if (name.length > LEGEND_NAME_CHARS) name = `${name.slice(0, 9)}..${name.slice(-(LEGEND_NAME_CHARS - 11))}`
  return `${name}${look.source === 'hash' ? ' ?' : look.source === 'guess' ? ' ~' : ''}`
}

interface Prepared {
  looks: BlockLook[]
  /** 不透明的整块：会把后面的东西完全挡住。 */
  solid: Uint8Array
}

function prepare(grid: VoxelGrid, looks: BlockLooks): Prepared {
  const all = grid.kinds.map((k) => looks.of(k))
  const solid = new Uint8Array(grid.kinds.length)
  grid.kinds.forEach((kind, i) => {
    if (i !== 0 && !isAir(kind) && all[i]!.shape === 'full' && all[i]!.alpha >= 1) solid[i] = 1
  })
  return { looks: all, solid }
}

// ── 等轴测图 ──

/** 画面坐标 (i, k) → 盒子坐标 (x, z)。i 往右下走，k 往左下走；离镜头最近的是 i、k 都最大的那个角。 */
function isoAxes(grid: VoxelGrid, from: Corner): { vx: number; vz: number; x: (i: number, k: number) => number; z: (i: number, k: number) => number; left: Side; right: Side } {
  const { x: sx, z: sz } = grid.size
  switch (from) {
    case 'southeast':
      return { vx: sx, vz: sz, x: (i) => i, z: (_i, k) => k, left: 'south', right: 'east' }
    case 'southwest':
      return { vx: sz, vz: sx, x: (_i, k) => sx - 1 - k, z: (i) => i, left: 'west', right: 'south' }
    case 'northwest':
      return { vx: sx, vz: sz, x: (i) => sx - 1 - i, z: (_i, k) => sz - 1 - k, left: 'north', right: 'west' }
    case 'northeast':
      return { vx: sz, vz: sx, x: (_i, k) => k, z: (i) => sz - 1 - i, left: 'east', right: 'north' }
  }
}

/** 非整块的方块在一格里占的地方：x、z 方向两边各缩进多少，从地面起多高（都是占一格的几分之几）。 */
function boxOf(shape: BlockLook['shape'], u: number): { inset: number; height: number } {
  switch (shape) {
    case 'full':
      return { inset: 0, height: 1 }
    case 'slab':
      return { inset: 0, height: 0.5 }
    case 'small':
      return { inset: 0.25, height: 0.5 }
    case 'flat':
      return { inset: 0, height: Math.max(0.125, 1 / u) }
    case 'post':
      return { inset: 0.3, height: 1 }
  }
}

/**
 * 等轴测图顶上有多少是空的（以一格的大小为单位）：盒子的后上角常常什么都没有，那一截不画，省地方。
 * 全空的盒子返回 0。
 */
function isoHeadroom(grid: VoxelGrid, from: Corner): number {
  const axes = isoAxes(grid, from)
  const { x: sx, y: sy, z: sz } = grid.size
  let top = Infinity
  for (let k = 0; k < axes.vz; k++) {
    for (let i = 0; i < axes.vx; i++) {
      // 这一列里最高的那块决定这一列最靠上画到哪
      for (let y = sy - 1; y >= 0; y--) {
        if (grid.cells[(y * sz + axes.z(i, k)) * sx + axes.x(i, k)] === 0) continue
        top = Math.min(top, sy + (i + k) / 2 - (y + 1))
        break
      }
    }
  }
  return Number.isFinite(top) ? Math.max(0, Math.floor(top)) : 0
}

function isoSize(grid: VoxelGrid, from: Corner, u: number, headroom: number): { width: number; height: number } {
  const { vx, vz } = isoAxes(grid, from)
  return { width: (vx + vz) * u, height: Math.ceil(((vx + vz) * u) / 2 + (grid.size.y - headroom) * u) }
}

function drawIso(grid: VoxelGrid, p: Prepared, from: Corner, u: number, headroom: number): Raster {
  const axes = isoAxes(grid, from)
  const { vx, vz } = axes
  const { x: sx, y: sy, z: sz } = grid.size
  const { width, height } = isoSize(grid, from, u, headroom)
  const out = new Raster(width, height, BACKGROUND)
  const cells = grid.cells
  const at = (i: number, y: number, k: number): number => {
    if (i < 0 || i >= vx || y < 0 || y >= sy || k < 0 || k >= vz) return 0
    return cells[(y * sz + axes.z(i, k)) * sx + axes.x(i, k)]!
  }
  const ox = vz * u
  const oy = (sy - headroom) * u
  // 盒子里的点 (i, y, k) 落在画面上的哪里
  const px = (i: number, k: number): number => ox + (i - k) * u
  const py = (i: number, y: number, k: number): number => oy + ((i + k) * u) / 2 - y * u
  const outline = u >= 10
  const face = (points: number[], color: RGB, alpha: number): void => {
    out.fillPolygon(points, color, alpha)
    if (!outline) return
    const edge = shade(color, 0.8)
    for (let n = 0; n < points.length; n += 2) {
      const m = (n + 2) % points.length
      out.line(points[n]!, points[n + 1]!, points[m]!, points[m + 1]!, edge, alpha * 0.7)
    }
  }
  /** 这一面要不要画：对面是空的、是非整块的，或者是另一种透明方块时才画。 */
  const shows = (self: number, other: number): boolean => {
    if (other === 0) return true
    if (p.solid[other]) return false
    return !(other === self && p.looks[self]!.shape === 'full')
  }

  // 远的先画、近的后画
  for (let k = 0; k < vz; k++) {
    for (let i = 0; i < vx; i++) {
      for (let y = 0; y < sy; y++) {
        const cell = at(i, y, k)
        if (cell === 0) continue
        const look = p.looks[cell]!
        const full = look.shape === 'full'
        const top = !full || shows(cell, at(i, y + 1, k))
        const left = !full || shows(cell, at(i, y, k + 1))
        const right = !full || shows(cell, at(i + 1, y, k))
        if (!top && !left && !right) continue
        const { inset, height: h } = boxOf(look.shape, u)
        const i0 = i + inset
        const i1 = i + 1 - inset
        const k0 = k + inset
        const k1 = k + 1 - inset
        const y1 = y + h
        if (top) face([px(i0, k0), py(i0, y1, k0), px(i1, k0), py(i1, y1, k0), px(i1, k1), py(i1, y1, k1), px(i0, k1), py(i0, y1, k1)], shade(look.top, ISO_SHADE.top), look.alpha)
        if (left) face([px(i0, k1), py(i0, y1, k1), px(i1, k1), py(i1, y1, k1), px(i1, k1), py(i1, y, k1), px(i0, k1), py(i0, y, k1)], shade(look.side, ISO_SHADE.left), look.alpha)
        if (right) face([px(i1, k1), py(i1, y1, k1), px(i1, k0), py(i1, y1, k0), px(i1, k0), py(i1, y, k0), px(i1, k1), py(i1, y, k1)], shade(look.side, ISO_SHADE.right), look.alpha)
      }
    }
  }
  return out
}

// ── 正着看：俯视、立面 ──

/** 平面图的两根轴：画面第 column 列、第 row 行、往里第 depth 层 → 盒子里的格子下标。 */
interface FlatAxes {
  columns: number
  rows: number
  depths: number
  index: (column: number, row: number, depth: number) => number
  /** 横轴、纵轴上的世界坐标（标刻度用）。 */
  across: { axis: 'x' | 'z'; value: (column: number) => number }
  down: { axis: 'y' | 'z'; value: (row: number) => number }
  /** 是不是从上往下看（决定非整块的方块怎么缩、明暗怎么算）。 */
  fromAbove: boolean
}

function topAxes(grid: VoxelGrid): FlatAxes {
  const { x: sx, y: sy, z: sz } = grid.size
  return {
    columns: sx,
    rows: sz,
    depths: sy,
    index: (c, r, d) => ((sy - 1 - d) * sz + r) * sx + c,
    across: { axis: 'x', value: (c) => grid.origin.x + c },
    down: { axis: 'z', value: (r) => grid.origin.z + r },
    fromAbove: true,
  }
}

function sideAxes(grid: VoxelGrid, from: Side): FlatAxes {
  const { x: sx, y: sy, z: sz } = grid.size
  const down = { axis: 'y' as const, value: (r: number) => grid.origin.y + sy - 1 - r }
  const cell = (x: number, r: number, z: number): number => ((sy - 1 - r) * sz + z) * sx + x
  switch (from) {
    case 'south': // 朝北看：东在右手边
      return { columns: sx, rows: sy, depths: sz, index: (c, r, d) => cell(c, r, sz - 1 - d), across: { axis: 'x', value: (c) => grid.origin.x + c }, down, fromAbove: false }
    case 'north': // 朝南看：西在右手边
      return { columns: sx, rows: sy, depths: sz, index: (c, r, d) => cell(sx - 1 - c, r, d), across: { axis: 'x', value: (c) => grid.origin.x + sx - 1 - c }, down, fromAbove: false }
    case 'east': // 朝西看：北在右手边
      return { columns: sz, rows: sy, depths: sx, index: (c, r, d) => cell(sx - 1 - d, r, sz - 1 - c), across: { axis: 'z', value: (c) => grid.origin.z + sz - 1 - c }, down, fromAbove: false }
    case 'west': // 朝东看：南在右手边
      return { columns: sz, rows: sy, depths: sx, index: (c, r, d) => cell(d, r, c), across: { axis: 'z', value: (c) => grid.origin.z + c }, down, fromAbove: false }
  }
}

/** 一条视线上最多叠这么多层（透明的、非整块的一层层叠到第一个不透明的整块为止）。 */
const RAY_LAYERS = 6

function drawFlat(grid: VoxelGrid, p: Prepared, axes: FlatAxes, c: number, gridLines: boolean): Raster {
  const { columns, rows, depths } = axes
  const out = new Raster(columns * c, rows * c, BACKGROUND)
  const cells = grid.cells

  // 每条视线最先碰到的“占满一格”的东西有多深（-1：一路都是空的）：明暗按它算
  const surface = new Int16Array(columns * rows).fill(-1)
  let near = Infinity
  let far = -Infinity
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < columns; col++) {
      for (let d = 0; d < depths; d++) {
        const cell = cells[axes.index(col, r, d)]!
        if (cell === 0) continue
        const shape = p.looks[cell]!.shape
        if (shape === 'small' || shape === 'post') continue
        surface[r * columns + col] = d
        near = Math.min(near, d)
        far = Math.max(far, d)
        break
      }
    }
  }
  const span = far - near
  /** 明暗：俯视图里高的亮、低的暗，北边比自己高的再暗一点（像有影子）；立面图里远的暗。 */
  const light = (col: number, r: number, d: number): number => {
    const t = span > 0 ? (d - near) / span : 0
    if (!axes.fromAbove) return 1 - (1 - DEPTH_SHADE.side) * t
    let f = 1 - (1 - DEPTH_SHADE.top) * t
    const mine = surface[r * columns + col]!
    const north = r > 0 ? surface[(r - 1) * columns + col]! : -1
    if (mine >= 0 && north >= 0) f *= north < mine ? 0.86 : north > mine ? 1.07 : 1
    return f
  }

  const stack: number[] = []
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < columns; col++) {
      stack.length = 0
      for (let d = 0; d < depths && stack.length < RAY_LAYERS * 2; d++) {
        const cell = cells[axes.index(col, r, d)]!
        if (cell === 0) continue
        // 同一种透明方块连着好几格（一池水）只算一层，不然越叠越深
        if (stack.length > 0 && stack[stack.length - 2] === cell && !p.solid[cell]) continue
        stack.push(cell, d)
        if (p.solid[cell]) break
      }
      // 从里往外画
      for (let n = stack.length - 2; n >= 0; n -= 2) {
        const look = p.looks[stack[n]!]!
        const color = shade(axes.fromAbove ? look.top : look.side, light(col, r, stack[n + 1]!))
        let x = col * c
        let y = r * c
        let w = c
        let h = c
        // 位置记号在俯视图里占满一格，不然太小看不见
        const narrow = look.marker && axes.fromAbove ? 0 : look.shape === 'post' ? 0.3 : look.shape === 'small' ? 0.25 : 0
        if (narrow > 0) {
          const inset = Math.min(Math.floor((c - 1) / 2), Math.round(c * narrow))
          x += inset
          w -= inset * 2
          if (axes.fromAbove) {
            y += inset
            h -= inset * 2
          }
        }
        if (!axes.fromAbove) {
          // 立面图里矮的东西贴着格子的底
          const tall = look.shape === 'slab' || look.shape === 'small' ? Math.max(1, Math.round(c / 2)) : look.shape === 'flat' ? Math.max(1, Math.round(c / 8)) : c
          y += c - tall
          h = tall
        }
        out.fillRect(x, y, w, h, color, look.alpha)
      }
    }
  }
  if (gridLines && c >= 6) {
    for (let col = 0; col <= columns; col++) out.fillRect(Math.min(col * c, columns * c - 1), 0, 1, rows * c, BLACK, 0.13)
    for (let r = 0; r <= rows; r++) out.fillRect(0, Math.min(r * c, rows * c - 1), columns * c, 1, BLACK, 0.13)
  }
  return out
}

// ── 拼成一张图：说明、坐标、图例 ──

function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line.length > 0 && line.length + 1 + word.length > maxChars) {
      lines.push(line)
      line = word
    } else {
      line = line.length > 0 ? `${line} ${word}` : word
    }
  }
  if (line.length > 0) lines.push(line)
  return lines
}

/** 刻度隔几格标一个：标签不挤在一起，并且是个整齐的数。 */
function tickStep(cell: number, needPx: number): number {
  const raw = Math.ceil(needPx / cell)
  return [1, 2, 5, 10, 20, 50, 100].find((n) => n >= raw) ?? 100
}

const SIDE_NAME: Record<Side, string> = { south: 'SOUTH', west: 'WEST', north: 'NORTH', east: 'EAST' }
const TICK_LEFT = 6 * CHAR
const TICK_TOP = LINE + 6

interface Plan {
  width: number
  height: number
  caption: string[]
  legendColumns: number
  legendRows: number
  drawing: { x: number; y: number; width: number; height: number }
}

/**
 * 把一个盒子画成一张 PNG。盒子里不能一格都没有（全是空气也行，画出来就是一片空）。
 * 每格画多大自己定：在 maxSize 里尽量大，最大 32 像素一格。
 */
export function renderView(grid: VoxelGrid, looks: BlockLooks, spec: ViewSpec, opts: RenderOptions = {}): Picture {
  const maxSize = Math.max(64, Math.min(4096, opts.maxSize ?? PICTURE_MAX_SIZE))
  const shown = spec.view === 'layer' ? cropGrid(grid, { y1: spec.layer, y2: spec.layer }) : grid
  const legend = legendOf(shown, looks)
  const flat = spec.view === 'iso' ? undefined : spec.view === 'side' ? sideAxes(shown, spec.from) : topAxes(shown)
  const headroom = spec.view === 'iso' ? isoHeadroom(shown, spec.from) : 0
  const drawingSize = (cell: number): { width: number; height: number } => (spec.view === 'iso' ? isoSize(shown, spec.from, cell, headroom) : { width: flat!.columns * cell, height: flat!.rows * cell })
  const draw = (cell: number): Raster => (spec.view === 'iso' ? drawIso(shown, prepare(shown, looks), spec.from, cell, headroom) : drawFlat(shown, prepare(shown, looks), flat!, cell, spec.view === 'layer' || cell >= 12))
  // 等轴测图的格子大小取偶数，菱形的半高才是整数
  const cellSizes: number[] = []
  for (let cell = CELL_MAX; cell >= 1; cell -= spec.view === 'iso' && cell > 2 ? 2 : 1) cellSizes.push(cell)

  if (opts.plain) {
    const cell = cellSizes.find((c) => drawingSize(c).width <= maxSize && drawingSize(c).height <= maxSize) ?? 1
    const picture = draw(cell)
    return { png: encodePng(picture), width: picture.width, height: picture.height, cell, legend }
  }

  const unknown = legend.some((e) => e.look.source === 'hash')
  const guessed = legend.some((e) => e.look.source === 'guess')
  const legendCount = Math.min(legend.length, LEGEND_SHOWN) + (legend.length > LEGEND_SHOWN ? 1 : 0)
  const o = shown.origin
  const s = shown.size
  const where = `x ${o.x}..${o.x + s.x - 1}, y ${o.y}..${o.y + s.y - 1}, z ${o.z}..${o.z + s.z - 1}`
  const isoAx = spec.view === 'iso' ? isoAxes(shown, spec.from) : undefined
  const describe = (): string => {
    switch (spec.view) {
      case 'iso':
        return `Seen from above the ${spec.from} corner (nearest corner: x=${spec.from.endsWith('east') ? o.x + s.x - 1 : o.x}, z=${spec.from.startsWith('south') ? o.z + s.z - 1 : o.z}): faces on the left look ${isoAx!.left}, faces on the right look ${isoAx!.right}.`
      case 'top':
        return 'Seen from straight above: north is up, east is right. Higher ground is brighter. Numbers: x along the top, z down the left.'
      case 'layer':
        return `The single layer y=${o.y} seen from above: north is up, east is right. Numbers: x along the top, z down the left.`
      case 'side':
        return `Seen from the ${spec.from}, looking ${SIDE_NAME[SIDES[(SIDES.indexOf(spec.from) + 2) % 4]!].toLowerCase()}: what is farther away is darker. Numbers: ${flat!.across.axis} along the top, y down the left.`
    }
  }
  const plan = (cell: number): Plan => {
    const d = drawingSize(cell)
    const left = flat ? TICK_LEFT : 0
    const width = Math.min(Math.max(MIN_WIDTH, d.width + left + 2 * PAD), Math.max(maxSize, MIN_WIDTH))
    const chars = Math.floor((width - 2 * PAD) / CHAR)
    const caption = [
      ...(opts.title ? wrap(opts.title, chars) : []),
      ...wrap(`${where}. 1 block = ${cell} px.`, chars),
      ...wrap(describe(), chars),
      ...(unknown || guessed ? wrap(`${unknown ? '"?" = not in the colour table: its colour is made up to tell it apart. ' : ''}${guessed ? '"~" = colour guessed from the name.' : ''}`.trim(), chars) : []),
    ]
    const legendColumns = Math.max(1, Math.floor((width - 2 * PAD) / LEGEND_COLUMN))
    const legendRows = Math.ceil(legendCount / legendColumns)
    const top = PAD + caption.length * LINE + 6 + (flat ? TICK_TOP : 0)
    const below = spec.view === 'iso' ? LINE + 4 : 0
    return {
      width,
      height: top + d.height + below + (legendRows > 0 ? 8 + legendRows * LINE : 0) + PAD,
      caption,
      legendColumns,
      legendRows,
      drawing: { x: PAD + left + Math.max(0, Math.floor((width - 2 * PAD - left - d.width) / 2)), y: top, width: d.width, height: d.height },
    }
  }
  const fits = (cell: number): boolean => {
    const pl = plan(cell)
    return pl.drawing.width + (flat ? TICK_LEFT : 0) + 2 * PAD <= maxSize && pl.height <= maxSize
  }
  const cell = cellSizes.find(fits) ?? 1
  const layout = plan(cell)
  const out = new Raster(layout.width, layout.height, BACKGROUND)
  layout.caption.forEach((line, n) => out.text(PAD, PAD + n * LINE, line, n < (opts.title ? 1 : 0) ? INK : FAINT, TEXT_SCALE))
  const area = layout.drawing
  out.blit(draw(cell), area.x, area.y)

  if (flat) {
    // 坐标刻度：横轴标在上面，纵轴标在左边
    const acrossStep = tickStep(cell, 7 * CHAR)
    for (let col = 0; col < flat.columns; col++) {
      const value = flat.across.value(col)
      if (((value % acrossStep) + acrossStep) % acrossStep !== 0) continue
      const label = String(value)
      const center = area.x + col * cell + cell / 2
      const x = Math.round(center - textWidth(label, TEXT_SCALE) / 2)
      if (x < PAD || x + textWidth(label, TEXT_SCALE) > layout.width - 2) continue
      out.text(x, area.y - TICK_TOP, label, INK, TEXT_SCALE)
      out.fillRect(Math.round(center), area.y - 5, 1, 5, INK)
    }
    const downStep = tickStep(cell, LINE)
    for (let r = 0; r < flat.rows; r++) {
      const value = flat.down.value(r)
      if (((value % downStep) + downStep) % downStep !== 0) continue
      const label = String(value)
      const center = area.y + r * cell + cell / 2
      out.text(area.x - 8 - textWidth(label, TEXT_SCALE), Math.round(center - 8), label, INK, TEXT_SCALE)
      out.fillRect(area.x - 5, Math.round(center), 5, 1, INK)
    }
    out.strokeRect(area.x - 1, area.y - 1, area.width + 2, area.height + 2, FAINT)
  } else {
    // 等轴测图：在靠近镜头的两条底边下面写上那两面朝哪边
    const y = area.y + area.height + 4
    const leftName = SIDE_NAME[isoAx!.left]
    const rightName = SIDE_NAME[isoAx!.right]
    const split = area.x + isoAx!.vx * cell
    const centered = (name: string, middle: number): number => Math.max(PAD, Math.min(layout.width - PAD - textWidth(name, TEXT_SCALE), Math.round(middle - textWidth(name, TEXT_SCALE) / 2)))
    // 两个名字挨得太近时（很窄的东西）往两边让开
    const gap = Math.max(0, (textWidth(leftName, TEXT_SCALE) + textWidth(rightName, TEXT_SCALE)) / 2 + CHAR - area.width / 2)
    out.text(centered(leftName, (area.x + split) / 2 - gap / 2), y, leftName, INK, TEXT_SCALE)
    out.text(centered(rightName, (split + area.x + area.width) / 2 + gap / 2), y, rightName, INK, TEXT_SCALE)
  }

  // 图例：色块（上半是顶面的颜色，下半是侧面的）、名字、数量
  const legendTop = layout.height - PAD - layout.legendRows * LINE
  const entries = legend.slice(0, LEGEND_SHOWN)
  entries.forEach((entry, n) => {
    const x = PAD + (n % layout.legendColumns) * LEGEND_COLUMN
    const y = legendTop + Math.floor(n / layout.legendColumns) * LINE
    const backing = entry.look.alpha < 1 ? mix(BACKGROUND, entry.look.top, entry.look.alpha) : entry.look.top
    out.fillRect(x, y, 16, 8, backing)
    out.fillRect(x, y + 8, 16, 8, entry.look.alpha < 1 ? mix(BACKGROUND, entry.look.side, entry.look.alpha) : shade(entry.look.side, 0.8))
    out.strokeRect(x, y, 16, 16, FAINT)
    out.text(x + 22, y, entry.look.marker ? legendLabel(entry) : `${legendLabel(entry)} x${entry.count}`, INK, TEXT_SCALE)
  })
  if (legend.length > LEGEND_SHOWN) {
    const n = entries.length
    const rest = legend.slice(LEGEND_SHOWN)
    out.text(PAD + (n % layout.legendColumns) * LEGEND_COLUMN, legendTop + Math.floor(n / layout.legendColumns) * LINE, `+ ${rest.length} more kinds (${rest.reduce((sum, e) => sum + e.count, 0)} blocks)`, FAINT, TEXT_SCALE)
  }
  return { png: encodePng(out), width: out.width, height: out.height, cell, legend }
}
