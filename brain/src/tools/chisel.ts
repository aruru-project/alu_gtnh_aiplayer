// 凿子的组在查做法、查用途里怎么说（数据在 packdata/carving.ts）。
// 凿子不是配方：配方册里查不到“结构混凝土 /7 怎么来”，而图纸要的常常就是某个具体花纹。这里把它当作又一种做法照实列出来：
// 它在哪一组、同组有哪些、组认不认矿辞名、凿子是怎么用的。不排序、不推荐，耐久这类数据里没有的照实说没有。

import type { CarvingBook, CarvingMatch, CarvingVariant } from '../packdata/index.ts'
import type { Namer } from './recipe-book.ts'

/** find_recipes / find_uses 的 way 参数里指凿子的写法。 */
export const CHISEL_WAY = '凿子'
export const isChiselWay = (asked: string): boolean => /凿|chisel/i.test(asked)

/** 汇总里一组最多列几个方块 id（一个 id 下的各个 meta 并成一行）。 */
const IDS_SHOWN = 8

/** 凿子怎么用：它是拿在手里的工具，不是机器。 */
export const CHISEL_HOW =
  'A chisel is a hand tool, not a machine and not a recipe: held and right-clicked it opens its own screen (open_screen with "item": the chisel), the blocks go in, and the variant wanted is clicked there (screens manual). Chisels are items: find_item "凿子".'
/** 一换一、凿子不消耗；耐久数据里没有。 */
export const CHISEL_COST = 'one block gives one block, nothing else is used up; what a conversion costs the chisel in durability is not in the data'

/** 一串 meta 写成区间：0–6, 8–15。 */
function metaRanges(metas: readonly number[]): string {
  const sorted = [...new Set(metas)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(j === i ? String(sorted[i]) : `${sorted[i]}–${sorted[j]}`)
    i = j + 1
  }
  return parts.join(', ')
}

/** 一组方块压成几行：同一个 id 的各个 meta 并在一起，带上它们的名字。 */
export function variantLines(variants: readonly CarvingVariant[], nm: Namer, max = IDS_SHOWN): string[] {
  const byId = new Map<string, CarvingVariant[]>()
  for (const v of variants) {
    const list = byId.get(v.id)
    if (list) list.push(v)
    else byId.set(v.id, [v])
  }
  const lines: string[] = []
  const ids = [...byId.entries()]
  for (const [id, list] of ids.slice(0, max)) {
    const names = [...new Set(list.map((v) => v.name ?? nm.name(v.id, v.meta)))]
    const named = names.length === 1 ? `"${names[0]}"` : `"${names[0]}", "${names[1]}"${names.length > 2 ? ` and ${names.length - 2} more name(s)` : ''}`
    lines.push(`${id}/${metaRanges(list.map((v) => v.meta))} ${named}`)
  }
  if (ids.length > max) lines.push(`… and ${ids.length - max} more block id(s) with ${ids.slice(max).reduce((n, [, list]) => n + list.length, 0)} block(s)`)
  return lines
}

const isSame = (v: CarvingVariant, item: { id: string; meta: number }): boolean => v.id === item.id && v.meta === item.meta

/** 这样东西和凿子的哪几个组有关系。mode 是 made 时只要“它是组里的一种”的（才凿得出它）。 */
export function chiselMatches(carving: CarvingBook | undefined, item: { id: string; meta: number; ores?: readonly string[] }, mode: 'made' | 'uses'): CarvingMatch[] {
  if (!carving) return []
  const all = carving.groupsOf(item.id, item.meta, item.ores ?? [])
  return mode === 'made' ? all.filter((m) => m.member) : all
}

/** 给程序的数据：每个组的全部方块，不省略。 */
export function chiselData(matches: readonly CarvingMatch[], nm: Namer): Record<string, unknown>[] {
  return matches.map((m) => ({
    group: m.group.group,
    ...(m.group.ore !== undefined ? { ore: m.group.ore } : {}),
    member: m.member,
    variants: m.group.variants.map((v) => ({ id: v.id, meta: v.meta, name: v.name ?? nm.name(v.id, v.meta) })),
  }))
}

/**
 * 汇总里的那一段。made：这样东西怎么来（从同组的另一种凿出来）；uses：它能凿成什么。
 * label 是 "结构混凝土 [chisel:nucrete/7]"。
 */
export function chiselSummary(matches: readonly CarvingMatch[], item: { id: string; meta: number }, label: string, nm: Namer, mode: 'made' | 'uses'): string[] {
  const lines: string[] = []
  for (const m of matches) {
    const g = m.group
    const others = g.variants.filter((v) => !isSame(v, item))
    if (mode === 'made') {
      lines.push(`${CHISEL_WAY} (Chisel) — ${label} is one of the ${g.variants.length} blocks of chisel group "${g.group}": a chisel turns any block of the group into any other block of the same group (${CHISEL_COST}).`)
      lines.push(`   It can be chiselled from any of the other ${others.length}: ${variantLines(others, nm).join('; ')}.`)
      if (g.ore !== undefined) lines.push(`   The group also takes anything under the ore name ${g.ore}: such a block can be chiselled into ${label} too.`)
    } else if (m.member) {
      lines.push(`${CHISEL_WAY} (Chisel) — ${label} is one of the ${g.variants.length} blocks of chisel group "${g.group}": a chisel turns it into any of the other ${others.length} (${CHISEL_COST}): ${variantLines(others, nm).join('; ')}.`)
    } else {
      lines.push(`${CHISEL_WAY} (Chisel) — ${label} carries the ore name ${g.ore}, which chisel group "${g.group}" (${g.variants.length} blocks) takes: a chisel turns it into any block of that group (${CHISEL_COST}): ${variantLines(g.variants, nm).join('; ')}.`)
    }
  }
  if (lines.length > 0) lines.push(`   ${CHISEL_HOW} Every block of the group with its id and meta: way "${CHISEL_WAY}"; in a program, data.chisel of this result, or data.chiselGroupsOf(id, meta).`)
  return lines
}

/** way 给了“凿子”时：每个组的全部方块，一行一个。 */
export function chiselDetail(matches: readonly CarvingMatch[], item: { id: string; meta: number }, label: string, nm: Namer): string {
  const lines: string[] = []
  for (const m of matches) {
    const g = m.group
    const relation = m.member ? `${label} is one of them` : `${label} is not one of them but carries the ore name ${g.ore}, which the group takes`
    lines.push(`Chisel group "${g.group}": ${g.variants.length} blocks; ${relation}. A chisel turns any block of the group into any other (${CHISEL_COST}).${m.member && g.ore !== undefined ? ` The group also takes anything under the ore name ${g.ore}.` : ''}`)
    for (const v of g.variants) lines.push(`- ${v.name ?? nm.name(v.id, v.meta)} [${v.id}/${v.meta}]${isSame(v, item) ? '  ← this one' : ''}`)
  }
  lines.push(CHISEL_HOW)
  return lines.join('\n')
}
