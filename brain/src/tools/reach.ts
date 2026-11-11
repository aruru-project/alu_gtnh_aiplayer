// 看一大片（一个基地）：身体一次只看得了那么远（world.stock 每个方向 64 格，world.containers 32 格），
// 要看的比这大时，这里把它切成身体看得了的几块，各问一次再合起来。
// 身体看的是一个立方体（水平方向和上下都按 radius 算），所以块也是立方体：一块挨一块、不重叠，同一个容器只会落在一块里。
// 上下只切到 0–255（世界就这么高）。结果里照实写切成了几块、合起来盖住的是哪一片、花了多久。

import type { BlockPos } from '../bridge/protocol.ts'
import { formatPos } from './format.ts'
import { whereItStands } from './recipe-book.ts'
import type { ToolContext } from './types.ts'
import type { At } from './where.ts'

/** 查容器、查库存时最远能看到每个方向多少格：够盖住一个基地。 */
export const BASE_RADIUS = 160
/** 同时向身体问几块。 */
const PARALLEL = 6
/** 花的时间超过这么久就在结果里写出来。 */
const SLOW_MS = 5000

export interface Spot3 extends BlockPos {
  dim?: number
}

export interface Box3 {
  x1: number
  y1: number
  z1: number
  x2: number
  y2: number
  z2: number
}

export interface Pieces {
  /** 每一块的中心；每块是以它为中心、每个方向 radius 格的立方体。 */
  centers: Spot3[]
  radius: number
  /** 这些块合起来盖住的那一片。 */
  box: Box3
}

/** 一条轴上从 lo 到 hi 切成每段 2r+1 格：各段的中心。段数凑不整时，多出来的那点两头各分一半。 */
function axis(lo: number, hi: number, r: number): number[] {
  const side = 2 * r + 1
  const n = Math.ceil((hi - lo + 1) / side)
  const start = lo - Math.floor((n * side - (hi - lo + 1)) / 2)
  return Array.from({ length: n }, (_, k) => start + k * side + r)
}

/** 以 center 为中心、每个方向 radius 格的一片，切成每个方向 piece 格的立方体（上下只到 0–255）。 */
export function pieces(center: Spot3, radius: number, piece: number): Pieces {
  const ylo = Math.max(0, center.y - radius)
  const yhi = Math.min(255, center.y + radius)
  const xs = axis(center.x - radius, center.x + radius, piece)
  const ys = axis(ylo, yhi, piece)
  const zs = axis(center.z - radius, center.z + radius, piece)
  const centers: Spot3[] = []
  for (const y of ys) for (const x of xs) for (const z of zs) centers.push({ x, y, z, ...(center.dim !== undefined ? { dim: center.dim } : {}) })
  return {
    centers,
    radius: piece,
    box: { x1: xs[0]! - piece, x2: xs.at(-1)! + piece, y1: Math.max(0, ys[0]! - piece), y2: Math.min(255, ys.at(-1)! + piece), z1: zs[0]! - piece, z2: zs.at(-1)! + piece },
  }
}

/**
 * 一个盒子每边最多 side 格（画图、扫地面的上限）时，大的盒子要分成几块：每块的两个角，照 x、z、y 的先后。
 * 给模型看的一句话：分成几块、每块的坐标，照着一块块调就行，不用一次次试。
 */
export function boxPieces(box: Box3, side: number, limit = Number.POSITIVE_INFINITY): Box3[] {
  // 按编号算出第几块，不把整条轴先排出来：坐标大得离谱时（上亿格，或者大到加 side 都不变），排一条轴就会把进程堵死
  const axis = (a: number, b: number) => ({ lo: Math.min(a, b), hi: Math.max(a, b), n: Math.ceil((Math.abs(b - a) + 1) / side) })
  const ax = axis(box.x1, box.x2)
  const ay = axis(box.y1, box.y2)
  const az = axis(box.z1, box.z2)
  const total = ax.n * ay.n * az.n
  const piece = (a: { lo: number; hi: number }, k: number): [number, number] => {
    const start = a.lo + k * side
    return [start, Math.min(a.hi, start + side - 1)]
  }
  const out: Box3[] = []
  for (let i = 0; i < total && out.length < limit; i++) {
    const [x1, x2] = piece(ax, i % ax.n)
    const [z1, z2] = piece(az, Math.floor(i / ax.n) % az.n)
    const [y1, y2] = piece(ay, Math.floor(i / (ax.n * az.n)))
    out.push({ x1, y1, z1, x2, y2, z2 })
  }
  return out
}

/** 一个盒子按每边 side 格分，一共几块（算出来，不一块块排）。 */
export function pieceCount(box: Box3, side: number): number {
  const n = (a: number, b: number): number => Math.ceil((Math.abs(b - a) + 1) / side)
  return n(box.x1, box.x2) * n(box.y1, box.y2) * n(box.z1, box.z2)
}

/** “查了哪几块”：几块、每块多大、合起来是哪一片；慢的时候带上花了多久。 */
export function piecesText(p: Pieces, ms: number): string {
  const side = 2 * p.radius + 1
  const b = p.box
  return `in ${p.centers.length} piece(s) of ${side}×${side}×${side} blocks covering x ${b.x1}..${b.x2}, y ${b.y1}..${b.y2}, z ${b.z1}..${b.z2}${ms >= SLOW_MS ? `; looking took ${Math.round(ms / 100) / 10} s` : ''}`
}

/** 一次至多问 PARALLEL 块，结果照块的先后排。 */
export async function eachPiece<T>(centers: readonly Spot3[], ask: (center: Spot3) => Promise<T>): Promise<T[]> {
  const out: T[] = new Array(centers.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const n = next++
      if (n >= centers.length) return
      out[n] = await ask(centers[n]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, centers.length) }, worker))
  return out
}

/** 切块要一个真的坐标：给了 at 就是它（在它现在所在的维度里），不然是它站的地方；它不在游戏里时返回 undefined。 */
export async function spotOf(ctx: ToolContext, at: At | undefined): Promise<{ spot: Spot3; of: string } | undefined> {
  if (at) {
    const status = await ctx.bridge.botStatus(ctx.botName)
    return { spot: { x: at.x, y: at.y, z: at.z, ...(status.dim !== undefined ? { dim: status.dim } : {}) }, of: formatPos(at) }
  }
  const me = await whereItStands(ctx)
  return me ? { spot: me, of: 'you' } : undefined
}
