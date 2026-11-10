// 简图的文字说明：图例（哪种颜色是哪种方块）和一层一层的概要。
// 模型能看图时图例帮它把颜色和方块对上；看不了图时就靠这些文字。都是给模型看的，英文。

import type { VoxelGrid } from './grid.ts'
import { UNLOADED_ID, colorName, kindKey } from './looks.ts'
import type { BlockKind } from './looks.ts'
import type { LegendEntry } from './views.ts'

export type NameOf = (kind: BlockKind) => string | undefined

/** 图例，一种方块一行，多的在前；列不下的合成一句。 */
export function legendLines(legend: readonly LegendEntry[], nameOf?: NameOf, limit = 24): string[] {
  const lines: string[] = []
  const blocks = legend.filter((e) => !e.look.marker && e.kind.id !== UNLOADED_ID)
  for (const e of legend) {
    if (e.look.marker) lines.push(`- the ${colorName(e.look.top)} marker is ${e.kind.meta === 0 ? `you (${e.kind.id.slice(1)})` : `the player ${e.kind.id.slice(1)}`}`)
  }
  for (const e of blocks.slice(0, limit)) {
    const name = nameOf?.(e.kind)
    const top = colorName(e.look.top)
    const side = colorName(e.look.side)
    const color = top === side ? top : `${top} top, ${side} sides`
    const note = e.look.source === 'hash' ? '; colour made up, not its real colour' : e.look.source === 'guess' ? '; colour guessed from its name' : ''
    lines.push(`- ${e.count}× ${kindKey(e.kind)}${name ? ` "${name}"` : ''} (${color}${e.look.alpha < 1 ? ', see-through' : ''}${note})`)
  }
  if (blocks.length > limit) {
    const rest = blocks.slice(limit)
    lines.push(`- … and ${rest.length} more kinds (${rest.reduce((n, e) => n + e.count, 0)} blocks)`)
  }
  const unloaded = legend.find((e) => e.kind.id === UNLOADED_ID)
  if (unloaded) lines.push(`- ${unloaded.count} cells are in chunks that are not loaded (drawn dark): nothing is known about them`)
  return lines
}

/**
 * 一层一层说里面有什么（从下往上），一样的相邻层合成一行。给看不了图的模型用，行数有上限。
 */
export function layerLines(grid: VoxelGrid, nameOf?: NameOf, maxLines = 24): string[] {
  const { x: sx, y: sy, z: sz } = grid.size
  const perLayer = sx * sz
  const label = (kind: BlockKind): string => (kind.id === UNLOADED_ID ? 'not loaded' : (nameOf?.(kind) ?? kindKey(kind).replace(/^minecraft:/, '')))
  const groups: { from: number; to: number; text: string }[] = []
  const counts = new Uint32Array(grid.kinds.length)
  for (let y = 0; y < sy; y++) {
    counts.fill(0)
    for (let at = y * perLayer; at < (y + 1) * perLayer; at++) counts[grid.cells[at]!]!++
    const kinds = [...counts.entries()].filter(([i, n]) => i !== 0 && n > 0 && !grid.kinds[i]!.id.startsWith('@')).sort((a, b) => b[1] - a[1])
    const filled = kinds.reduce((n, [, c]) => n + c, 0)
    let text = 'empty'
    if (filled > 0) {
      const shown = kinds.slice(0, 4).map(([i, n]) => `${n} ${label(grid.kinds[i]!)}`)
      const others = kinds.slice(4).reduce((n, [, c]) => n + c, 0)
      text = `${filled} of ${perLayer} cells filled: ${shown.join(', ')}${others > 0 ? `, ${others} other` : ''}`
    }
    const last = groups[groups.length - 1]
    if (last && last.text === text) last.to = y
    else groups.push({ from: y, to: y, text })
  }
  const lines = groups.slice(0, maxLines).map((g) => `y=${grid.origin.y + g.from}${g.to > g.from ? `..${grid.origin.y + g.to}` : ''}: ${g.text}`)
  if (groups.length > maxLines) lines.push(`… (layers above y=${grid.origin.y + groups[maxLines - 1]!.to} are left out: ask for a smaller range)`)
  return lines
}
