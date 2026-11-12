// 草稿的文字预览：一层一层（或一个竖切面一个竖切面）画成字符，带图例。给模型检查自己的设计用。
// 大草稿不会一次全倒出来：按字符预算能放几片放几片，放不下的写明没显示哪些、怎么要。

import { kindKey, materialsOf } from './draft.ts'
import type { Draft, DraftKind } from './draft.ts'

/** 沿哪根轴切片：y 是水平的一层层（俯视），z、x 是竖着的切面（立面）。 */
export type Axis = 'x' | 'y' | 'z'

/** 只看这个范围（两端都含）；没给的那一头就是到边。 */
export interface Box {
  x1?: number
  x2?: number
  y1?: number
  y2?: number
  z1?: number
  z2?: number
}

export interface PreviewOptions {
  along: Axis
  box?: Box
  /** 画出来的格子大约不超过这么多字符。 */
  budget: number
  /** 给方块配显示名（物品表里有的话）。 */
  nameOf?: (kind: DraftKind) => string | undefined
  /**
   * 字符按这个次序发（方块的 kindKey，用得多的在前）。不给就按这张草稿里的用量。
   * 服务器上的图纸只读了一块时给整张的材料表：分几次看不同的部分，同一个字符还是同一种方块。
   */
  order?: readonly string[]
}

/** 一片最多画这么宽，再宽的行读起来对不齐。 */
export const PREVIEW_MAX_COLUMNS = 128
const SYMBOLS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#%&*+=@$'
const EMPTY = '.'
const OTHER = '?'

/** 请求的范围不对：消息给模型看。 */
export class PreviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreviewError'
  }
}

function range(draft: Draft, box: Box, axis: Axis): [number, number] {
  const max = draft.size[axis] - 1
  const lo = box[`${axis}1`] ?? 0
  const hi = box[`${axis}2`] ?? max
  if (lo > hi) throw new PreviewError(`${axis}1 (${lo}) is above ${axis}2 (${hi})`)
  if (hi < 0 || lo > max) throw new PreviewError(`${axis} ${lo} to ${hi} is outside the draft, which spans ${axis} 0 to ${max}`)
  return [Math.max(0, lo), Math.min(max, hi)]
}

/**
 * 每种方块用哪个字符：按用量从多到少发，发完了的都用 “?”。
 * 整张草稿统一发一次，所以分几次看不同的层，同一个字符始终是同一种方块。
 */
export function symbolsOf(draft: Draft, given?: readonly string[]): string[] {
  const order = given ?? materialsOf(draft).map(kindKey)
  const symbol = new Map(order.map((key, i) => [key, SYMBOLS[i] ?? OTHER]))
  return draft.kinds.map((kind) => symbol.get(kindKey(kind)) ?? OTHER)
}

const VIEWS: Record<Axis, { rows: Axis; columns: Axis; intro: (r: [number, number], c: [number, number]) => string }> = {
  y: {
    rows: 'z',
    columns: 'x',
    intro: (r, c) => `Horizontal layers seen from above, from the bottom layer up. Rows run north to south (z ${r[0]} to ${r[1]}), columns west to east (x ${c[0]} to ${c[1]}).`,
  },
  z: {
    rows: 'y',
    columns: 'x',
    intro: (r, c) => `Upright slices seen from the south, from the northmost slice on. Rows run from the top down (y ${r[1]} to ${r[0]}), columns west to east (x ${c[0]} to ${c[1]}).`,
  },
  x: {
    rows: 'y',
    columns: 'z',
    intro: (r, c) => `Upright slices seen from the west, from the westmost slice on. Rows run from the top down (y ${r[1]} to ${r[0]}), columns north to south (z ${c[0]} to ${c[1]}).`,
  },
}

/** 草稿的图例加上切片。 */
export function renderPreview(draft: Draft, opts: PreviewOptions): string {
  const box = opts.box ?? {}
  const view = VIEWS[opts.along]
  const slices = range(draft, box, opts.along)
  const rows = range(draft, box, view.rows)
  const columns = range(draft, box, view.columns)
  const notes: string[] = []

  // 一片放不下时先裁：太宽裁列，太多裁行
  const asked = { rows: [...rows] as [number, number], columns: [...columns] as [number, number] }
  if (columns[1] - columns[0] + 1 > PREVIEW_MAX_COLUMNS) columns[1] = columns[0] + PREVIEW_MAX_COLUMNS - 1
  const width = columns[1] - columns[0] + 1
  const fit = Math.max(1, Math.floor(opts.budget / (width + 1)))
  // 竖切面的行是从上往下画的，裁的时候留上面的
  if (rows[1] - rows[0] + 1 > fit) {
    if (view.rows === 'y') rows[0] = rows[1] - fit + 1
    else rows[1] = rows[0] + fit - 1
  }
  if (columns[1] !== asked.columns[1]) {
    notes.push(`Only ${view.columns} ${columns[0]} to ${columns[1]} is drawn of ${view.columns} ${asked.columns[0]} to ${asked.columns[1]}: give ${view.columns}1 and ${view.columns}2 for the rest.`)
  }
  if (rows[0] !== asked.rows[0] || rows[1] !== asked.rows[1]) {
    notes.push(`Only ${view.rows} ${rows[0]} to ${rows[1]} is drawn of ${view.rows} ${asked.rows[0]} to ${asked.rows[1]}: give ${view.rows}1 and ${view.rows}2 for the rest.`)
  }

  const symbols = symbolsOf(draft, opts.order)
  const used = new Set<number>()
  const { x: sx, z: sz } = draft.size
  const at = (pos: Record<Axis, number>): number => draft.cells[pos.x + (pos.y * sz + pos.z) * sx]!
  const drawSlice = (n: number): string => {
    const lines: string[] = []
    const pos = { x: 0, y: 0, z: 0 }
    pos[opts.along] = n
    const down = view.rows === 'y'
    for (let i = 0; i <= rows[1] - rows[0]; i++) {
      pos[view.rows] = down ? rows[1] - i : rows[0] + i
      let line = ''
      for (let c = columns[0]; c <= columns[1]; c++) {
        pos[view.columns] = c
        const cell = at(pos)
        if (cell !== 0) used.add(cell)
        line += cell === 0 ? EMPTY : symbols[cell - 1]!
      }
      lines.push(line)
    }
    return lines.join('\n')
  }

  // 一样的相邻切片合在一起说（墙那几层通常一模一样）；按预算能放几组放几组
  const groups: { from: number; to: number; text: string }[] = []
  let spent = 0
  let next = slices[0]
  for (; next <= slices[1]; next++) {
    const text = drawSlice(next)
    const last = groups[groups.length - 1]
    if (last && last.text === text) {
      last.to = next
      continue
    }
    if (groups.length > 0 && spent + text.length > opts.budget) break
    groups.push({ from: next, to: next, text })
    spent += text.length + 20
  }
  if (next <= slices[1]) {
    notes.push(`Not drawn: ${opts.along} ${next} to ${slices[1]}. Ask again with ${opts.along}1 and ${opts.along}2 to see them.`)
  }

  const legend = [`${EMPTY} empty`]
  let others = 0
  materialsOf(draft).forEach((m) => {
    const index = draft.kinds.findIndex((k) => k.id === m.id && k.meta === m.meta)
    if (!used.has(index + 1)) return
    if (symbols[index] === OTHER) {
      others++
      return
    }
    const name = opts.nameOf?.(m)
    legend.push(`${symbols[index]} ${kindKey(m)}${name ? ` "${name}"` : ''}`)
  })
  if (others > 0) legend.push(`${OTHER} one of ${others} other kinds of block (too many kinds for one letter each)`)

  const out = [`Legend: ${legend.join('; ')}`, view.intro(rows, columns)]
  for (const g of groups) {
    const isEmpty = !/[^.\n]/.test(g.text)
    const label = g.from === g.to ? `${opts.along}=${g.from}` : `${opts.along}=${g.from} to ${opts.along}=${g.to} (${g.to - g.from + 1} alike)`
    out.push(isEmpty ? `${label}: empty` : `${label}:\n${g.text}`)
  }
  out.push(...notes)
  return out.join('\n')
}
