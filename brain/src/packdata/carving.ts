// 凿子（Chisel）的组（carving.jsonl，格式见 docs/PACKDATA.md）：一行一组，组里的任何一种方块都能用凿子变成同组的另一种，
// 一换一，不耗别的材料。配方册里没有这些（凿子不是配方），而图纸要的常常是某个具体花纹（chisel:nucrete/7）。
// 有的组还认一个矿辞名：这个矿辞名下的东西也能凿成这一组，哪怕它自己不在组里。

import fs from 'node:fs'
import path from 'node:path'
import { isRecord } from '../util.ts'

export interface CarvingVariant {
  id: string
  meta: number
  name?: string
}

export interface CarvingGroup {
  group: string
  /** 这一组认的矿辞名：这个名下的东西也能凿成这一组。 */
  ore?: string
  variants: CarvingVariant[]
}

/** 一样东西和一个组的关系：member 是它就是组里的一种；不是的话，它只是带着这组认的矿辞名（能凿成这组里的任何一种）。 */
export interface CarvingMatch {
  group: CarvingGroup
  member: boolean
}

function parseGroup(raw: unknown): CarvingGroup | undefined {
  if (!isRecord(raw) || typeof raw.group !== 'string' || raw.group.length === 0 || !Array.isArray(raw.variants)) return undefined
  const variants: CarvingVariant[] = []
  for (const v of raw.variants) {
    if (!isRecord(v) || typeof v.id !== 'string' || v.id.length === 0) continue
    variants.push({ id: v.id, meta: typeof v.meta === 'number' && Number.isInteger(v.meta) ? v.meta : 0, ...(typeof v.name === 'string' && v.name.length > 0 ? { name: v.name } : {}) })
  }
  if (variants.length === 0) return undefined
  return { group: raw.group, ...(typeof raw.ore === 'string' && raw.ore.length > 0 ? { ore: raw.ore } : {}), variants }
}

const keyOf = (id: string, meta: number): string => `${id}/${meta}`

export class CarvingBook {
  readonly groups: readonly CarvingGroup[]
  private readonly byItem = new Map<string, CarvingGroup[]>()
  private readonly byOre = new Map<string, CarvingGroup[]>()

  constructor(groups: readonly CarvingGroup[]) {
    this.groups = groups
    for (const g of groups) {
      for (const v of g.variants) {
        const list = this.byItem.get(keyOf(v.id, v.meta))
        if (!list) this.byItem.set(keyOf(v.id, v.meta), [g])
        else if (!list.includes(g)) list.push(g)
      }
      if (g.ore !== undefined) {
        const list = this.byOre.get(g.ore)
        if (list) list.push(g)
        else this.byOre.set(g.ore, [g])
      }
    }
  }

  /** 读 carving.jsonl。文件不在时返回 undefined。 */
  static load(dir: string): { book: CarvingBook; bad: number } | undefined {
    let content: string
    try {
      content = fs.readFileSync(path.join(dir, 'carving.jsonl'), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw e
    }
    const groups: CarvingGroup[] = []
    let bad = 0
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue
      let group: CarvingGroup | undefined
      try {
        group = parseGroup(JSON.parse(line))
      } catch {
        group = undefined
      }
      if (group) groups.push(group)
      else bad++
    }
    return groups.length > 0 ? { book: new CarvingBook(groups), bad } : undefined
  }

  /** 一共多少种方块（同一种在两个组里算两次）。 */
  get variants(): number {
    return this.groups.reduce((n, g) => n + g.variants.length, 0)
  }

  /**
   * 这样东西和哪几个组有关系：它是组里的一种，或者它带着某个组认的矿辞名（ores 是它的矿辞名）。
   * 一样东西可以在不止一个组里。
   */
  groupsOf(id: string, meta: number, ores: readonly string[] = []): CarvingMatch[] {
    const out: CarvingMatch[] = (this.byItem.get(keyOf(id, meta)) ?? []).map((group) => ({ group, member: true }))
    for (const ore of ores) {
      for (const group of this.byOre.get(ore) ?? []) if (!out.some((m) => m.group === group)) out.push({ group, member: false })
    }
    return out
  }

  /** 这两样东西能不能用凿子从 from 变成 to：to 是某个组里的一种，from 也在那个组里，或者带着那个组认的矿辞名。 */
  between(from: { id: string; meta: number; ores?: readonly string[] }, to: { id: string; meta: number }): CarvingGroup | undefined {
    const targets = this.byItem.get(keyOf(to.id, to.meta)) ?? []
    return this.groupsOf(from.id, from.meta, from.ores ?? []).find((m) => targets.includes(m.group))?.group
  }
}
