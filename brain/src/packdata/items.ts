// 本地物品表：items.jsonl，一行一个物品（格式见 docs/PACKDATA.md）。
// 给物品配中文名（任务书、背包、箱子、配方里的东西都靠它），按中文名、英文名、id、矿辞名找物品。

import { editDistance } from './fluids.ts'

export interface PackItemInfo {
  id: string
  meta: number
  /** 中文显示名。 */
  name: string
  /** 英文名，可能没有（和中文名一样时不写）。 */
  en?: string
  ores?: string[]
  /** 同一个 id + meta 下还有几种只靠附加数据区分的变体（不同材质的 GregTech 工具）。 */
  variants?: number
}

export interface ItemSearchResult {
  /** 最像的在前，从 offset 起的一页。 */
  hits: PackItemInfo[]
  /** 一共有多少个对得上。 */
  total: number
}

/** “任何 meta 都行”：只出现在配方里引用到的条目上，找物品时不要它。 */
const ANY_META = 32767

export class ItemTable {
  private readonly byKey = new Map<string, PackItemInfo>()
  private readonly list: PackItemInfo[] = []
  /** 每个物品一段小写的文字：中文名、英文名、id/meta、矿辞名，找物品时在里面找词。 */
  private haystacks: string[] | undefined
  private ores: Map<string, PackItemInfo[]> | undefined
  private english: Map<string, PackItemInfo | null> | undefined
  private englishAnyId: Map<string, PackItemInfo | null> | undefined

  constructor(items: Iterable<PackItemInfo>) {
    for (const item of items) {
      const key = `${item.id}/${item.meta}`
      if (this.byKey.has(key)) continue
      this.byKey.set(key, item)
      this.list.push(item)
    }
  }

  get size(): number {
    return this.byKey.size
  }

  /** 全部物品（按文件里的顺序）。 */
  all(): readonly PackItemInfo[] {
    return this.list
  }

  /** meta 缺省（任何变体都行）时拿 meta 0 的那个来叫名字。 */
  get(id: string, meta?: number): PackItemInfo | undefined {
    return this.byKey.get(`${id}/${meta === undefined || meta === ANY_META ? 0 : meta}`)
  }

  /**
   * 服务器给的英文显示名 → 物品表里的那一项：同一个 id 下英文名正好是它的那个。
   * 世界里的方块（箱子、机器）只知道 id 和英文名，它的 meta 不是物品的 meta，所以靠名字对。
   * 同一个英文名对着几个中文名不一样的物品时不认（返回 undefined）；中文名也一样的（比如物品表里另有一条“任何 meta”的同名条目）照认。
   */
  byEnglishName(id: string, english: string): PackItemInfo | undefined {
    this.english ??= this.englishIndex((item) => `${item.id}\n${(item.en ?? item.name).toLowerCase()}`)
    return this.english.get(`${id}\n${english.toLowerCase()}`) ?? undefined
  }

  /**
   * 只有英文显示名、连 id 都没有的东西（身体报的“旁边接着的管道”“东西在哪个容器里”）：整张物品表里英文名正好是它的那个。
   * 几个物品英文名相同而中文名不同时不认。
   */
  byEnglishNameAlone(english: string): PackItemInfo | undefined {
    this.englishAnyId ??= this.englishIndex((item) => (item.en ?? item.name).toLowerCase())
    return this.englishAnyId.get(english.toLowerCase()) ?? undefined
  }

  private englishIndex(keyOf: (item: PackItemInfo) => string): Map<string, PackItemInfo | null> {
    const index = new Map<string, PackItemInfo | null>()
    for (const item of this.list) {
      const key = keyOf(item)
      const seen = index.get(key)
      if (seen === undefined) index.set(key, item)
      // 同一个英文名、中文名不一样：记成 null，谁也不认；“任何 meta”的条目让位给点名 meta 的
      else if (seen !== null && seen.name !== item.name) index.set(key, null)
      else if (seen !== null && seen.meta === ANY_META) index.set(key, item)
    }
    return index
  }

  /** 有没有以这个前缀开头的矿辞名（前缀后面是大写字母或数字：ingot 对上 ingotSteel）。 */
  hasOrePrefix(prefix: string): boolean {
    this.withOre('')
    for (const ore of this.ores!.keys()) if (ore.startsWith(prefix) && /[A-Z0-9]/.test(ore.charAt(prefix.length))) return true
    return false
  }

  /** 登记在这个矿辞名下的物品。 */
  withOre(ore: string): readonly PackItemInfo[] {
    if (!this.ores) {
      this.ores = new Map()
      for (const item of this.list) {
        for (const name of item.ores ?? []) {
          const list = this.ores.get(name)
          if (list) list.push(item)
          else this.ores.set(name, [item])
        }
      }
    }
    return this.ores.get(ore) ?? []
  }

  /**
   * 按名字找物品。query 按空白分成几个词，每个词都要出现在中文名、英文名、id 或矿辞名里（不分大小写）。
   * 排序：名字正好是 query 的最前，其次是以它开头的、名字里含它的、只有 id 或矿辞名对上的；同一档里名字短的在前。
   */
  search(query: string, opts: { limit?: number; offset?: number } = {}): ItemSearchResult {
    const whole = query.trim().toLowerCase()
    const words = whole.split(/\s+/).filter((w) => w.length > 0)
    if (words.length === 0) return { hits: [], total: 0 }
    this.haystacks ??= this.list.map((i) => `${i.name}\n${i.en ?? ''}\n${i.id}/${i.meta}\n${(i.ores ?? []).join(' ')}`.toLowerCase())
    const found: { item: PackItemInfo; score: number }[] = []
    for (let n = 0; n < this.list.length; n++) {
      const hay = this.haystacks[n]!
      if (!words.every((w) => hay.includes(w))) continue
      const item = this.list[n]!
      if (item.meta === ANY_META) continue
      const name = item.name.toLowerCase()
      const en = (item.en ?? '').toLowerCase()
      const rank = name === whole || en === whole ? 0 : name.startsWith(whole) || en.startsWith(whole) ? 1 : words.every((w) => name.includes(w) || en.includes(w)) ? 2 : 3
      found.push({ item, score: rank * 1000 + Math.min(999, item.name.length) })
    }
    found.sort((a, b) => a.score - b.score)
    const offset = Math.max(0, opts.offset ?? 0)
    return { hits: found.slice(offset, offset + Math.max(1, opts.limit ?? 12)).map((f) => f.item), total: found.length }
  }

  /**
   * 名字和 query 只差一两个字的物品（记错、打错一个字时用），最像的在前；同名的只留一个。
   * 只在什么都没搜到的时候才用，所以每次把整张表过一遍也无妨。
   */
  closest(query: string, limit = 5): PackItemInfo[] {
    const text = query.trim().toLowerCase()
    if (text.length < 2) return []
    const max = text.length >= 5 ? 2 : 1
    const found: { item: PackItemInfo; d: number }[] = []
    const seen = new Set<string>()
    for (const item of this.list) {
      if (item.meta === ANY_META || seen.has(item.name)) continue
      const d = Math.min(editDistance(text, item.name.toLowerCase(), max), item.en ? editDistance(text, item.en.toLowerCase(), max) : max + 1)
      if (d > max) continue
      seen.add(item.name)
      found.push({ item, d })
    }
    return found
      .sort((a, b) => a.d - b.d || a.item.name.localeCompare(b.item.name))
      .slice(0, limit)
      .map((f) => f.item)
  }
}

/** items.jsonl 的一行。认不出来（没有 id 或名字）时返回 undefined。 */
export function parseItem(raw: unknown): PackItemInfo | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0 || typeof r.name !== 'string' || r.name.length === 0) return undefined
  const item: PackItemInfo = { id: r.id, meta: typeof r.meta === 'number' ? r.meta : 0, name: r.name }
  if (typeof r.en === 'string' && r.en.length > 0) item.en = r.en
  if (Array.isArray(r.ores)) {
    const ores = r.ores.filter((o): o is string => typeof o === 'string' && o.length > 0)
    if (ores.length > 0) item.ores = ores
  }
  if (typeof r.variants === 'number' && r.variants > 0) item.variants = r.variants
  return item
}
