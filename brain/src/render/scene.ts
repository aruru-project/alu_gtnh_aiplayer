// 三维预览要的数据：一个盒子里每一格是什么，加上每种方块怎么画（贴图在图集的第几格、没贴图时用什么颜色、透不透、多大）。
// 面板拿到它，在浏览器里用 WebGL 画成可以拖着转的立体图（panel/public/viewer3d.js）。
// 盒子本身存盘、传输时用的是 world.blocks 那个样子：最小角、各边格数、调色板、“下标, 连续几格”的序列。

import type { TextureAtlas } from '../packdata/textures.ts'
import { countKinds } from './grid.ts'
import type { VoxelGrid } from './grid.ts'
import { isAir, kindKey } from './looks.ts'
import type { BlockKind, BlockLooks, Shape } from './looks.ts'
import type { RGB } from './raster.ts'

/** 存盘用的盒子，和协议里 world.blocks 的回应一个样子（用 gridFromBlocks 读回来）。 */
export interface StoredBlocks {
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sz: number
  palette: BlockKind[]
  runs: number[]
}

function runsOf(cells: Uint16Array): number[] {
  const runs: number[] = []
  for (let i = 0; i < cells.length; ) {
    let j = i + 1
    while (j < cells.length && cells[j] === cells[i]) j++
    runs.push(cells[i]!, j - i)
    i = j
  }
  return runs
}

export function blocksOfGrid(grid: VoxelGrid): StoredBlocks {
  return { x: grid.origin.x, y: grid.origin.y, z: grid.origin.z, sx: grid.size.x, sy: grid.size.y, sz: grid.size.z, palette: grid.kinds, runs: runsOf(grid.cells) }
}

export interface SceneKind {
  /** "minecraft:wool/14"；位置记号是 "@名字"。 */
  key: string
  /** 显示名，查不到就没有。 */
  name?: string
  /** 盒子里有多少格。 */
  count: number
  /** 没有贴图时用的颜色，也是图例里的色块：侧面、顶面。 */
  side: RGB
  top: RGB
  alpha: number
  shape: Shape
  marker?: true
  /** 颜色是不是真的（false：颜色表里没有，是由名字算的，只为了区分）。 */
  known: boolean
  /** 侧面、顶面的贴图在图集的第几格。没有就按颜色画。 */
  tex?: number
  texTop?: number
  /** 贴图要再染上的颜色（草的顶面、树叶）。 */
  tint?: RGB
  tintTop?: RGB
}

export interface Scene {
  size: { x: number; y: number; z: number }
  origin: { x: number; y: number; z: number }
  /** 下标同 runs 里的调色板下标；0 号（空气）和别的空气是 null。 */
  kinds: (SceneKind | null)[]
  /** “调色板下标, 连续几格”，x 最快、其次 z、最后 y。 */
  runs: number[]
  /** 贴图的图集。没有时全部按颜色画。 */
  atlas?: { url: string; tile: number; columns: number; rows: number }
}

export interface SceneOptions {
  nameOf?: (kind: BlockKind) => string | undefined
  textures?: TextureAtlas
  /** 面板从哪取图集那张图。给了 textures 才用得上。 */
  atlasUrl?: string
}

export function sceneOf(grid: VoxelGrid, looks: BlockLooks, opts: SceneOptions = {}): Scene {
  const counts = countKinds(grid)
  const tiles = opts.textures?.tiles
  const kinds = grid.kinds.map((kind, i): SceneKind | null => {
    if (i === 0 || isAir(kind)) return null
    const look = looks.of(kind)
    const out: SceneKind = { key: kindKey(kind), count: counts[i]!, side: look.side, top: look.top, alpha: look.alpha, shape: look.shape, known: look.source !== 'hash' }
    const name = look.marker ? undefined : opts.nameOf?.(kind)
    if (name !== undefined) out.name = name
    if (look.marker) out.marker = true
    const side = look.tex !== undefined ? tiles?.get(look.tex) : undefined
    if (side !== undefined) {
      out.tex = side
      if (look.tint) out.tint = look.tint
      // 顶面的贴图：有另一张就用另一张，那张图集里没有就退回侧面的
      const top = look.texTop !== undefined ? tiles?.get(look.texTop) : undefined
      if (top !== undefined && top !== side) out.texTop = top
      if (look.tintTop && top !== undefined) out.tintTop = look.tintTop
    }
    return out
  })
  const scene: Scene = { size: { ...grid.size }, origin: { ...grid.origin }, kinds, runs: runsOf(grid.cells) }
  if (opts.textures && opts.atlasUrl !== undefined) {
    scene.atlas = { url: opts.atlasUrl, tile: opts.textures.tile, columns: opts.textures.columns, rows: opts.textures.rows }
  }
  return scene
}
