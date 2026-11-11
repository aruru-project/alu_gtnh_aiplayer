// 物品图标的图集：packdata 的 icons/ 下面若干张大图（icons-000.png …），每张里一格一个物品的图标（从真客户端渲染出来的），
// 加一个说明文件 icons.json。面板的物品栏用它；大脑自己不解这些图，只把文件原样交给面板，并告诉面板一样东西的图标是第几个。
//
// icons.json：
//   { "format": 1, "generatedAt": "…", "cell": 32, "columns": 64, "rows": 64, "count": 63676,
//     "itemsSha1": "…", "files": ["icons-000.png", …], "missing": [726, 727, 941], … }
// - 第 n 个图标是 items.jsonl 第 n 行（从 0 数）的那个物品的。
// - 一张图 columns × rows 格：第 n 个在第 floor(n / (columns*rows)) 张里；张内第 i = n % (columns*rows) 格，
//   左上角 x = (i % columns) * cell，y = floor(i / columns) * cell。
// - missing：画出来是空的那几个的编号（“空气”这类本来就看不见的），面板对它们用替代的画法。
// - count 应当等于 items.jsonl 的行数，itemsSha1 是每行 "<id>/<meta>\n" 依次拼起来的 SHA-1：
//   对不上说明图集和物品表不是同一次导出的，图标会全部错位，这时当没有图标。
//
// 没有这份资料（目录不在、文件缺、对不上）时返回 undefined，面板改用替代的画法（方块贴图，或者一个色块加一个字）。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { errorText, isRecord } from '../util.ts'
import { ANY_META } from './recipes.ts'

export interface ItemIcons {
  /** icons/ 目录。 */
  dir: string
  /** 一格的边长（像素）。 */
  cell: number
  /** 一张图里一行几格、几行。 */
  columns: number
  rows: number
  /** 每张图的文件（绝对路径），按顺序。 */
  files: string[]
  /** 一共多少个图标（含画出来是空的那几个）。 */
  count: number
  /** 这份图集的版本（生成时间）。面板把它带在地址里，重新生成以后浏览器不会接着用旧的。 */
  version: string
  /** 读的时候 icons.json 的修改时刻（毫秒）。之后它变了，就是图集在大脑运行期间被重新导出了：行号对不上了，不能再用。 */
  loadedMtimeMs?: number
  /**
   * 一样东西的图标是第几个；没有就是 undefined。
   * 按 id/meta 找不到时（docs/PACKDATA.md 的“物品图标”）：用这个 id 的 meta 0 那一行（有耐久的工具和护甲，meta 是磨损掉的耐久），
   * 再没有用不限 meta（32767）的那一行，再没有用这个 id 的头一行。
   * 只靠附加数据区分的物品（匠魂工具、GregTech 工具）拿到的是这个 id 在物品表里那一种的样子，材质不同时颜色会不对。
   */
  indexOf(id: string, meta?: number): number | undefined
}

/** items.jsonl 的每一行是谁：按行号（从 0 数，空行不算）。 */
export interface ItemLines {
  /** "id/meta" → 行号（同一个 id/meta 出现两次时是头一次的）。 */
  byKey: Map<string, number>
  /** id → 它的头一行的行号。 */
  first: Map<string, number>
  count: number
  /** 每行 "<id>/<meta>\n" 依次拼起来的 SHA-1。 */
  sha1: string
}

export function itemLines(itemsJsonl: string): ItemLines {
  const byKey = new Map<string, number>()
  const first = new Map<string, number>()
  const hash = crypto.createHash('sha1')
  let n = 0
  for (const line of itemsJsonl.split('\n')) {
    if (line.trim().length === 0) continue
    const at = n++
    let id = ''
    let meta = 0
    try {
      const row: unknown = JSON.parse(line)
      if (isRecord(row)) {
        if (typeof row.id === 'string') id = row.id
        if (typeof row.meta === 'number') meta = row.meta
      }
    } catch {
      /* 坏行也占一个行号 */
    }
    hash.update(`${id}/${meta}\n`)
    if (id.length === 0) continue
    const key = `${id}/${meta}`
    if (!byKey.has(key)) byKey.set(key, at)
    if (!first.has(id)) first.set(id, at)
  }
  return { byKey, first, count: n, sha1: hash.digest('hex') }
}

function whole(v: unknown, what: string, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) throw new Error(`icons.json 的 ${what} 不对`)
  return v
}

/** icons.json 的内容 + 物品表的行 → 图集。对不上时抛 Error（消息给人看）。 */
export function parseItemIcons(raw: unknown, dir: string, lines: ItemLines): ItemIcons {
  if (!isRecord(raw)) throw new Error('icons.json 不是一个 JSON 对象')
  if (raw.format !== undefined && raw.format !== 1) throw new Error(`icons.json 是第 ${String(raw.format)} 版格式，这个大脑只认第 1 版`)
  const cell = whole(raw.cell, 'cell', 256)
  const columns = whole(raw.columns, 'columns', 1024)
  const rows = whole(raw.rows, 'rows', 1024)
  const count = whole(raw.count, 'count', 16 * 1024 * 1024)
  if (!Array.isArray(raw.files) || raw.files.length === 0) throw new Error('icons.json 里没有 files')
  const files: string[] = []
  for (const name of raw.files) {
    // 只认 icons/ 目录里的一层文件名
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+\.png$/.test(name) || name.startsWith('.')) throw new Error(`icons.json 的 files 里有不认识的文件名：${String(name).slice(0, 60)}`)
    files.push(path.join(dir, name))
  }
  if (count > files.length * columns * rows) throw new Error(`icons.json 说有 ${count} 个图标，但 ${files.length} 张图放不下`)
  if (count !== lines.count) throw new Error(`图集里有 ${count} 个图标，物品表（items.jsonl）有 ${lines.count} 行，不是同一次导出的`)
  if (typeof raw.itemsSha1 === 'string' && raw.itemsSha1.length > 0 && raw.itemsSha1.toLowerCase() !== lines.sha1) throw new Error('图集和物品表（items.jsonl）对不上（itemsSha1 不一样），不是同一次导出的')
  const missing = new Set<number>(Array.isArray(raw.missing) ? raw.missing.filter((n): n is number => typeof n === 'number') : [])
  // 超时没画完时：这个编号以后的都没画
  const cutShort = typeof raw.cutShort === 'number' && Number.isInteger(raw.cutShort) && raw.cutShort >= 0 ? raw.cutShort : count
  const drawn = (n: number | undefined): number | undefined => (n === undefined || n >= count || n >= cutShort || missing.has(n) ? undefined : n)

  return {
    dir,
    cell,
    columns,
    rows,
    files,
    count,
    version: typeof raw.generatedAt === 'string' ? raw.generatedAt : String(count),
    indexOf(id, meta) {
      const exact = drawn(lines.byKey.get(`${id}/${meta === undefined ? 0 : meta}`))
      if (exact !== undefined) return exact
      // 有耐久的工具和护甲，meta 是磨损掉的耐久，表里只有 meta 0 的那一行
      return drawn(lines.byKey.get(`${id}/0`)) ?? drawn(lines.byKey.get(`${id}/${ANY_META}`)) ?? drawn(lines.first.get(id))
    },
  }
}

/** 读 packdata 目录下的 icons/。没有、读不了、和物品表对不上时返回 undefined，原因交给 log。图本身不读，只看文件在不在。 */
export function loadItemIcons(packdataDir: string, log: (message: string) => void = () => {}): ItemIcons | undefined {
  const fallback = '面板的物品栏用替代的画法（方块贴图，或者色块加一个字）'
  const dir = path.join(packdataDir, 'icons')
  const read = (file: string): string | undefined => {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined
      throw e
    }
  }
  try {
    const manifest = read(path.join(dir, 'icons.json'))
    if (manifest === undefined) {
      log(`没有物品图标（icons/icons.json），${fallback}。`)
      return undefined
    }
    const items = read(path.join(packdataDir, 'items.jsonl'))
    if (items === undefined) {
      log(`有物品图标但没有物品表（items.jsonl），不知道哪个图标是哪样东西，${fallback}。`)
      return undefined
    }
    const icons = parseItemIcons(JSON.parse(manifest), dir, itemLines(items))
    icons.loadedMtimeMs = fs.statSync(path.join(dir, 'icons.json')).mtimeMs
    const gone = icons.files.filter((file) => !fs.existsSync(file))
    if (gone.length > 0) {
      log(`物品图标少了 ${gone.length} 张图（头一张是 ${path.basename(gone[0]!)}），${fallback}。`)
      return undefined
    }
    log(`物品图标：${icons.count} 个（每个 ${icons.cell} 像素，${icons.files.length} 张图）。`)
    return icons
  } catch (e) {
    log(`物品图标用不了（${errorText(e)}），${fallback}。`)
    return undefined
  }
}

/**
 * 这份图集还是不是读的时候那一份：icons.json 没被换过。图集是整套重新导出的，物品表的行数和顺序每次都会变一点，
 * 换过以后内存里的“哪样东西是第几个”就对不上磁盘上的图了——宁可没图也不能错位。只看文件的修改时刻，不重读。
 */
export function itemIconsStillValid(icons: ItemIcons): boolean {
  if (icons.loadedMtimeMs === undefined) return true
  try {
    return fs.statSync(path.join(icons.dir, 'icons.json')).mtimeMs === icons.loadedMtimeMs
  } catch {
    return false
  }
}
