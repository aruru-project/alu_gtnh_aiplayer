// 物品的提示文字（tooltips.jsonl，格式见 docs/PACKDATA.md 的“物品的提示文字”）：玩家在物品栏里把鼠标放到一个物品上看到的那几行。
// 一行一个有提示的物品：{id, meta, tip: […], shift?: […], ctrl?: […]}。tip 是什么键都不按时的；shift、ctrl 是按住那个键时
// **换成**的另一版，不是接在后面——三个是三个画面，给模型时分开给。
//
// 读进来时去掉几行只是界面提示、不是这件物品的信息的（见 UI_ONLY_LINES）；去掉以后三个画面都空了的物品算没有提示。
// 按 id + meta 认，所以和物品表不是同一次导出的也能用。

import fs from 'node:fs'
import path from 'node:path'

export interface ItemTooltip {
  /** 什么键都不按时名字下面的行。可以是空的（按住键才有字）。 */
  tip: string[]
  /** 按住 Shift 时换成的那一版；和 tip 一样时没有。 */
  shift?: string[]
  /** 按住 Ctrl 时换成的那一版。 */
  ctrl?: string[]
}

/**
 * 只是界面提示、不给模型的行（整行正好是它）：
 * - “长按 [G] 打开指南”：这件物品在游戏内指南里有页——find_item 等会自己带一行“指南里有这一页”，这一句是给人看的按键提示；
 * - Spice of Life 的两行：对导出用的那个还没吃过东西的新号说的（吃过以后这里是这种食物吃了几次），所有食物都一样；
 * - Ztones 的两行：按住 Alt/Ctrl 滚轮切换方块样式的按键提示。
 */
export const UI_ONLY_LINES: ReadonlySet<string> = new Set(['长按 [G] 打开指南', '食物恢复的饥饿值递减开始在', '食用任何食物超过 10次 之后', 'Alt/Ctrl+Scroll to', 'Cycle Between Blocks'])

/** 一个画面的行：去掉只是界面提示的；去掉以后开头、结尾多出来的空行和连着的空行也收掉。 */
function cleanLines(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const line of raw) {
    if (typeof line !== 'string' || UI_ONLY_LINES.has(line.trim())) continue
    if (line.trim().length === 0 && (out.length === 0 || out[out.length - 1]!.trim().length === 0)) continue
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1]!.trim().length === 0) out.pop()
  return out
}

const sameLines = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((line, n) => line === b[n])

export interface TooltipHit {
  id: string
  meta: number
  /** 对上的那一行在哪个画面里，和那一行（几个词不在同一行时是第一个词所在的那一行）。 */
  screen: 'tip' | 'shift' | 'ctrl'
  line: string
}

export class TooltipTable {
  private readonly byKey = new Map<string, ItemTooltip>()
  /** 文件里的顺序（和物品表的顺序一样）。 */
  private readonly order: { id: string; meta: number }[] = []
  private haystacks: string[] | undefined

  constructor(rows: Iterable<{ id: string; meta: number; tip?: unknown; shift?: unknown; ctrl?: unknown }>) {
    for (const row of rows) {
      const tip = cleanLines(row.tip)
      const shift = cleanLines(row.shift)
      const ctrl = cleanLines(row.ctrl)
      // 去掉界面提示以后和不按键时一样的那一版，就不算另一版
      const tooltip: ItemTooltip = { tip, ...(shift.length > 0 && !sameLines(shift, tip) ? { shift } : {}), ...(ctrl.length > 0 && !sameLines(ctrl, tip) ? { ctrl } : {}) }
      if (tip.length === 0 && !tooltip.shift && !tooltip.ctrl) continue
      const key = `${row.id}/${row.meta}`
      if (this.byKey.has(key)) continue
      this.byKey.set(key, tooltip)
      this.order.push({ id: row.id, meta: row.meta })
    }
  }

  /** 读 tooltips.jsonl。文件不在返回 undefined。rows 是文件里认得出来的行数（去掉界面提示以前有提示的物品数）。 */
  static load(dir: string): { table: TooltipTable; rows: number; bad: number } | undefined {
    let content: string
    try {
      content = fs.readFileSync(path.join(dir, 'tooltips.jsonl'), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw e
    }
    const rows: { id: string; meta: number; tip?: unknown; shift?: unknown; ctrl?: unknown }[] = []
    let bad = 0
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const raw = JSON.parse(line) as Record<string, unknown>
        if (typeof raw.id === 'string' && typeof raw.meta === 'number') rows.push(raw as { id: string; meta: number })
        else bad++
      } catch {
        bad++
      }
    }
    return { table: new TooltipTable(rows), rows: rows.length, bad }
  }

  /** 有提示的物品数（去掉只是界面提示的行以后）。 */
  get size(): number {
    return this.byKey.size
  }

  /** 其中另有 Shift 版、Ctrl 版的各多少。 */
  counts(): { shift: number; ctrl: number } {
    let shift = 0
    let ctrl = 0
    for (const t of this.byKey.values()) {
      if (t.shift) shift++
      if (t.ctrl) ctrl++
    }
    return { shift, ctrl }
  }

  get(id: string, meta: number): ItemTooltip | undefined {
    return this.byKey.get(`${id}/${meta}`)
  }

  /**
   * 按提示里的字找物品：每个词都要出现在这件物品的提示里（三个画面合起来算，不分大小写）。按文件里的顺序（和物品表一样）。
   * 不看物品的名字：名字用 ItemTable.search 找。
   */
  search(query: string): TooltipHit[] {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0)
    if (words.length === 0) return []
    this.haystacks ??= this.order.map((o) => {
      const t = this.byKey.get(`${o.id}/${o.meta}`)!
      return [...t.tip, ...(t.shift ?? []), ...(t.ctrl ?? [])].join('\n').toLowerCase()
    })
    const hits: TooltipHit[] = []
    for (let n = 0; n < this.order.length; n++) {
      const hay = this.haystacks[n]!
      if (!words.every((w) => hay.includes(w))) continue
      const o = this.order[n]!
      const t = this.byKey.get(`${o.id}/${o.meta}`)!
      // 给出对上的那一行：先在不按键的那一版里找，再 Shift、Ctrl
      let found: Pick<TooltipHit, 'screen' | 'line'> | undefined
      for (const [screen, lines] of [['tip', t.tip], ['shift', t.shift ?? []], ['ctrl', t.ctrl ?? []]] as const) {
        const line = lines.find((l) => l.toLowerCase().includes(words[0]!))
        if (line !== undefined) {
          found = { screen, line }
          break
        }
      }
      hits.push({ id: o.id, meta: o.meta, ...(found ?? { screen: 'tip' as const, line: '' }) })
    }
    return hits
  }
}
