// 流体表：流体的注册名（molten.steel，身体报罐子里有什么、配方册的 fin / fout 用的都是它）↔ 游戏里的中文名、英文名。
//
// 没有单独导出的流体表，这里是从两份现成的资料里拼出来的：
//   - 配方册里每种出现过的流体带着它的中文名（fin / fout 的 name）；
//   - 物品表里 NEI 给每种流体造了一个“流体展示”物品（NotEnoughItems:neiFluidDisplay，meta 是运行时的流体编号），
//     有中文名和英文名。它不是能拿在手里的东西，只是配方画面上代表流体的那张图。
// 两边靠中文名对上（真实的整合包里 1419 种流体对上了 1413 种）。同一个名字可以对着好几种流体
// （“熔融钢”有 GregTech 的 molten.steel 和匠魂的 steel.molten），那时候都列出来，由问的人挑。

import type { ItemTable } from './items.ts'

/** NEI 的“流体展示”物品：配方画面上代表一种流体的那张图。 */
export const FLUID_DISPLAY_ID = 'NotEnoughItems:neiFluidDisplay'

export interface FluidInfo {
  /** 注册名。 */
  fluid: string
  /** 中文名（配方册里的）。 */
  name: string
  en?: string
}

/** 两个短字符串的编辑距离，超过 max 就不再算下去（返回 max + 1）。 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
      row.push(v)
      if (v < best) best = v
    }
    if (best > max) return max + 1
    prev = row
  }
  return prev[b.length]!
}

export class FluidTable {
  private readonly byKey = new Map<string, FluidInfo>()
  private readonly byName = new Map<string, FluidInfo[]>()
  /** 流体展示物品的 meta → 它的中文名；中文名 → 这些物品的 meta。 */
  private readonly displayName = new Map<number, string>()
  private readonly displayMetas = new Map<string, number[]>()

  /** fluids：配方册里出现过的流体（注册名、中文名）。items：物品表（拿流体展示物品的英文名用），可以没有。 */
  constructor(fluids: Iterable<readonly [string, string]>, items?: ItemTable) {
    const english = new Map<string, string>()
    for (const item of items?.all() ?? []) {
      if (item.id !== FLUID_DISPLAY_ID) continue
      this.displayName.set(item.meta, item.name)
      const metas = this.displayMetas.get(item.name)
      if (metas) metas.push(item.meta)
      else this.displayMetas.set(item.name, [item.meta])
      if (item.en && !english.has(item.name)) english.set(item.name, item.en)
    }
    for (const [fluid, name] of fluids) {
      if (this.byKey.has(fluid)) continue
      const en = english.get(name)
      const info: FluidInfo = { fluid, name, ...(en !== undefined && en !== name ? { en } : {}) }
      this.byKey.set(fluid, info)
      const same = this.byName.get(name.toLowerCase())
      if (same) same.push(info)
      else this.byName.set(name.toLowerCase(), [info])
    }
  }

  get size(): number {
    return this.byKey.size
  }

  get(fluid: string): FluidInfo | undefined {
    return this.byKey.get(fluid)
  }

  /**
   * 按名字找流体。query 按空白分成几个词，每个词都要出现在注册名、中文名或英文名里（不分大小写）。
   * exact：整个 query 正好是注册名、中文名或英文名的；partial：其余对得上的，名字短的在前。
   */
  search(query: string): { exact: FluidInfo[]; partial: FluidInfo[] } {
    const whole = query.trim().toLowerCase()
    const words = whole.split(/\s+/).filter((w) => w.length > 0)
    const exact: FluidInfo[] = []
    const partial: FluidInfo[] = []
    if (words.length === 0) return { exact, partial }
    for (const info of this.byKey.values()) {
      const key = info.fluid.toLowerCase()
      const name = info.name.toLowerCase()
      const en = (info.en ?? '').toLowerCase()
      if (key === whole || name === whole || en === whole) exact.push(info)
      else if (words.every((w) => key.includes(w) || name.includes(w) || en.includes(w))) partial.push(info)
    }
    partial.sort((a, b) => a.name.length - b.name.length || a.fluid.localeCompare(b.fluid))
    return { exact, partial }
  }

  /** 名字和 query 只差一两个字的流体（记错一个字时用），最像的在前。 */
  closest(query: string, limit = 5): FluidInfo[] {
    const text = query.trim().toLowerCase()
    if (text.length < 2) return []
    const max = text.length >= 5 ? 2 : 1
    const found: { info: FluidInfo; d: number }[] = []
    for (const info of this.byKey.values()) {
      const d = Math.min(editDistance(text, info.name.toLowerCase(), max), info.en ? editDistance(text, info.en.toLowerCase(), max) : max + 1)
      if (d <= max) found.push({ info, d })
    }
    return found
      .sort((a, b) => a.d - b.d || a.info.name.localeCompare(b.info.name))
      .slice(0, limit)
      .map((f) => f.info)
  }

  /** 这件物品是不是 NEI 的流体展示物品；是的话它代表哪种流体（同名的可能不止一种；一种都对不上是空的）。 */
  ofDisplayItem(id: string, meta: number): FluidInfo[] | undefined {
    if (id !== FLUID_DISPLAY_ID) return undefined
    const name = this.displayName.get(meta)
    return name === undefined ? [] : (this.byName.get(name.toLowerCase()) ?? [])
  }

  /** 代表这种流体的流体展示物品（不是 GregTech 的配方页把流体画成物品，查配方时要把它们也算上）。 */
  displayItems(fluid: string): { id: string; meta: number }[] {
    const info = this.byKey.get(fluid)
    if (!info) return []
    return (this.displayMetas.get(info.name) ?? []).map((meta) => ({ id: FLUID_DISPLAY_ID, meta }))
  }
}
