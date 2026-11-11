// 本地配方册：handlers.json（配方页：一种加工方式）和 recipes.jsonl（一行一条配方），格式见 docs/PACKDATA.md。
//
// recipes.jsonl 有一百来兆、三十万条。启动时从头到尾读一遍，只在内存里留索引：每条配方在文件里的位置、属于哪一页，
// 以及“哪些配方产出这个物品”“哪些配方用到这个物品（或这个矿辞名）”两张倒排表。配方本身用到时才从文件里读那一行。
// 流体也有同样的两张表（哪些配方产出、用到这种流体），外加流体的注册名 → 中文名：GregTech 的页把流体写在 fin / fout 里。
// 真实的整合包：读一遍不到一秒，索引占四十兆左右。fake:true 的示意配方不进倒排表，哪里都查不到。
//
// 一条配方的编号（ref）就是它在 recipes.jsonl 里是第几行（从 0 数）。文件重新导出以后编号会变，所以编号只在这次运行里用。

import fs from 'node:fs'
import path from 'node:path'

export interface RecipeHandler {
  /** 配方页的编号，recipes.jsonl 用它指回来。 */
  key: string
  /** NEI 里这个标签页的名字（中文）。 */
  name: string
  mod?: string
  /** 能做这类配方的机器（物品的 id + meta，和 world.machines 给的那一对一样）。 */
  machines: { id: string; meta: number }[]
  /** 合成台类的页（有序或无序合成）。 */
  grid: boolean
  /** 直接从 GregTech 的配方表里读出来的页：有电压、时长，原料数量是准的。 */
  gregtech: boolean
}

/** 配方的一格原料。meta 是 ANY_META 表示任何 meta 都行。n 为 0：要放进去但不消耗（编程电路、模具、模头）。 */
export type RecipeSlot =
  | { kind: 'item'; id: string; meta: number; n: number; g?: number; name?: string }
  | { kind: 'ore'; ore: string; n: number; g?: number; any: [string, number][]; more: number }
  | { kind: 'any'; n: number; g?: number; any: [string, number][]; more: number }

export interface RecipeStack {
  id: string
  meta: number
  n: number
  /** 有这个概率才出（0–1）。 */
  chance?: number
  /** 带附加数据、显示名和物品表里不一样时的名字。 */
  name?: string
}

export interface RecipeFluid {
  f: string
  name: string
  mb: number
}

export interface Recipe {
  /** 编号：recipes.jsonl 里的第几行。 */
  ref: number
  handler: RecipeHandler
  in: RecipeSlot[]
  out: RecipeStack[]
  fin: RecipeFluid[]
  fout: RecipeFluid[]
  /** 每刻耗电、时长（刻）：只有 GregTech 的页有。 */
  eut?: number
  ticks?: number
  /** 配方页自己的附加数值（高炉是炉温）。 */
  special?: number
}

export const ANY_META = 32767
/** 编程电路：配方里 n 为 0 的这个物品，meta 就是电路号。 */
export const CIRCUIT_ID = 'gregtech:gt.integrated_circuit'

const READ_CHUNK = 8 << 20
const EMPTY: readonly number[] = []

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 1
}

function pairs(v: unknown): [string, number][] {
  if (!Array.isArray(v)) return []
  const out: [string, number][] = []
  for (const p of v) if (Array.isArray(p) && typeof p[0] === 'string') out.push([p[0], typeof p[1] === 'number' ? p[1] : 0])
  return out
}

function slot(raw: unknown): RecipeSlot | undefined {
  if (!isRecord(raw)) return undefined
  const g = typeof raw.g === 'number' && Number.isInteger(raw.g) && raw.g >= 0 ? { g: raw.g } : {}
  const n = count(raw.n)
  if (typeof raw.ore === 'string' && raw.ore.length > 0) return { kind: 'ore', ore: raw.ore, n, ...g, any: pairs(raw.any), more: typeof raw.more === 'number' ? raw.more : 0 }
  if (typeof raw.id === 'string' && raw.id.length > 0) {
    return { kind: 'item', id: raw.id, meta: typeof raw.meta === 'number' ? raw.meta : 0, n, ...g, ...(typeof raw.name === 'string' ? { name: raw.name } : {}) }
  }
  const any = pairs(raw.any)
  return any.length > 0 ? { kind: 'any', n, ...g, any, more: typeof raw.more === 'number' ? raw.more : 0 } : undefined
}

function stack(raw: unknown): RecipeStack | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) return undefined
  const out: RecipeStack = { id: raw.id, meta: typeof raw.meta === 'number' ? raw.meta : 0, n: count(raw.n) }
  if (typeof raw.chance === 'number' && raw.chance > 0 && raw.chance < 1) out.chance = raw.chance
  if (typeof raw.name === 'string') out.name = raw.name
  return out
}

function fluids(raw: unknown): RecipeFluid[] {
  if (!Array.isArray(raw)) return []
  const out: RecipeFluid[] = []
  for (const f of raw) {
    if (isRecord(f) && typeof f.f === 'string') out.push({ f: f.f, name: typeof f.name === 'string' && f.name.length > 0 ? f.name : f.f, mb: count(f.mb) })
  }
  return out
}

function list<T>(raw: unknown, read: (v: unknown) => T | undefined): T[] {
  const out: T[] = []
  if (Array.isArray(raw)) {
    for (const v of raw) {
      const item = read(v)
      if (item !== undefined) out.push(item)
    }
  }
  return out
}

/** handlers.json 的一项。没有 key 的不要。 */
export function parseHandler(raw: unknown): RecipeHandler | undefined {
  if (!isRecord(raw) || typeof raw.key !== 'string' || raw.key.length === 0) return undefined
  const handler: RecipeHandler = {
    key: raw.key,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : raw.key,
    machines: list(raw.machines, (m) => (isRecord(m) && typeof m.id === 'string' ? { id: m.id, meta: typeof m.meta === 'number' ? m.meta : 0 } : undefined)),
    grid: raw.grid === true,
    gregtech: raw.read === 'gregtech',
  }
  if (typeof raw.mod === 'string' && raw.mod.length > 0) handler.mod = raw.mod
  return handler
}

/** 倒排表的键。 */
export const itemPosting = (id: string, meta: number): string => (meta === ANY_META ? `${id}/*` : `${id}/${meta}`)
const orePosting = (ore: string): string => `ore:${ore}`

function add(map: Map<string, number[]>, key: string, ref: number): void {
  const refs = map.get(key)
  if (refs === undefined) map.set(key, [ref])
  else if (refs[refs.length - 1] !== ref) refs.push(ref)
}

export class RecipeBook {
  readonly handlers: readonly RecipeHandler[]
  /** recipes.jsonl 里一共多少条（含 fake 的）。 */
  readonly size: number
  /** 其中 fake:true、不列出来的条数。 */
  readonly fake: number
  private readonly fd: number
  private readonly offsets: Uint32Array
  private readonly lengths: Uint32Array
  private readonly handlerOf: Uint16Array
  private readonly makes: Map<string, number[]>
  private readonly used: Map<string, number[]>
  /** 流体（注册名）→ 产出它的配方、用到它的配方。 */
  private readonly fluidMakes: Map<string, number[]>
  private readonly fluidUsed: Map<string, number[]>
  /** 流体的注册名 → 配方册里的名字（中文）。 */
  private readonly fluidNames: Map<string, string>
  private readonly byKey: Map<string, RecipeHandler>
  private buffer = Buffer.allocUnsafe(64 * 1024)

  /**
   * 读 dir 里的 handlers.json 和 recipes.jsonl，建好索引。recipes.jsonl 不在时返回 undefined；读不了时抛错。
   * 读不出来的行（不是 JSON、没有 h）跳过，条数在 bad 里。
   */
  static load(dir: string): { book: RecipeBook; bad: number; ms: number } | undefined {
    const file = path.join(dir, 'recipes.jsonl')
    if (!fs.existsSync(file)) return undefined
    const started = performance.now()
    const handlers: RecipeHandler[] = []
    const index = new Map<string, number>()
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'handlers.json'), 'utf8'))
      for (const h of list(raw, parseHandler)) {
        if (index.has(h.key)) continue
        index.set(h.key, handlers.length)
        handlers.push(h)
      }
    } catch (e) {
      // 没有配方页的说明也能用：页名就用它的编号，只是不知道哪些机器能做
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`handlers.json: ${e instanceof Error ? e.message : String(e)}`)
    }
    const offsets: number[] = []
    const lengths: number[] = []
    const handlerOf: number[] = []
    const makes = new Map<string, number[]>()
    const used = new Map<string, number[]>()
    const fluidMakes = new Map<string, number[]>()
    const fluidUsed = new Map<string, number[]>()
    const fluidNames = new Map<string, string>()
    const fluidsOf = (raw: unknown, into: Map<string, number[]>, ref: number): void => {
      if (!Array.isArray(raw)) return
      for (const f of raw) {
        if (!isRecord(f) || typeof f.f !== 'string') continue
        add(into, f.f, ref)
        if (typeof f.name === 'string' && f.name.length > 0 && !fluidNames.has(f.f)) fluidNames.set(f.f, f.name)
      }
    }
    let bad = 0
    let fake = 0
    const onLine = (text: string, offset: number, length: number): void => {
      // 每一行都占一个编号（坏行也占）：编号就是行号
      const ref = offsets.length
      offsets.push(offset)
      lengths.push(length)
      let r: unknown
      try {
        r = JSON.parse(text)
      } catch {
        r = undefined
      }
      if (!isRecord(r) || typeof r.h !== 'string') {
        bad++
        handlerOf.push(0xffff)
        return
      }
      let h = index.get(r.h)
      if (h === undefined) {
        h = handlers.length
        index.set(r.h, h)
        handlers.push({ key: r.h, name: r.h, machines: [], grid: false, gregtech: false })
      }
      handlerOf.push(h)
      if (r.fake === true) {
        fake++
        return
      }
      if (Array.isArray(r.out)) for (const o of r.out) if (isRecord(o) && typeof o.id === 'string') add(makes, itemPosting(o.id, typeof o.meta === 'number' ? o.meta : 0), ref)
      if (Array.isArray(r.in)) {
        for (const i of r.in) {
          if (!isRecord(i)) continue
          if (typeof i.ore === 'string') add(used, orePosting(i.ore), ref)
          else if (typeof i.id === 'string') add(used, itemPosting(i.id, typeof i.meta === 'number' ? i.meta : 0), ref)
          else for (const [id, meta] of pairs(i.any)) add(used, itemPosting(id, meta), ref)
        }
      }
      fluidsOf(r.fout, fluidMakes, ref)
      fluidsOf(r.fin, fluidUsed, ref)
    }

    const fd = fs.openSync(file, 'r')
    try {
      const chunk = Buffer.allocUnsafe(READ_CHUNK)
      let carry: Buffer | undefined
      let position = 0
      let lineStart = 0
      for (;;) {
        const got = fs.readSync(fd, chunk, 0, READ_CHUNK, position)
        if (got <= 0) break
        position += got
        let start = 0
        for (;;) {
          const end = chunk.indexOf(10, start)
          if (end === -1 || end >= got) break
          const piece = chunk.subarray(start, end)
          const line = carry ? Buffer.concat([carry, piece]) : piece
          carry = undefined
          if (line.length > 0) onLine(line.toString('utf8'), lineStart, line.length)
          lineStart += line.length + 1
          start = end + 1
        }
        if (start < got) carry = carry ? Buffer.concat([carry, chunk.subarray(start, got)]) : Buffer.from(chunk.subarray(start, got))
      }
      if (carry && carry.length > 0) onLine(carry.toString('utf8'), lineStart, carry.length)
    } catch (e) {
      fs.closeSync(fd)
      throw e
    }
    const book = new RecipeBook(fd, handlers, Uint32Array.from(offsets), Uint32Array.from(lengths), Uint16Array.from(handlerOf), makes, used, fake, { makes: fluidMakes, used: fluidUsed, names: fluidNames })
    return { book, bad, ms: Math.round(performance.now() - started) }
  }

  private constructor(
    fd: number,
    handlers: RecipeHandler[],
    offsets: Uint32Array,
    lengths: Uint32Array,
    handlerOf: Uint16Array,
    makes: Map<string, number[]>,
    used: Map<string, number[]>,
    fake: number,
    fluids: { makes: Map<string, number[]>; used: Map<string, number[]>; names: Map<string, string> },
  ) {
    this.fd = fd
    this.handlers = handlers
    this.offsets = offsets
    this.lengths = lengths
    this.handlerOf = handlerOf
    this.makes = makes
    this.used = used
    this.fluidMakes = fluids.makes
    this.fluidUsed = fluids.used
    this.fluidNames = fluids.names
    this.fake = fake
    this.size = offsets.length
    this.byKey = new Map(handlers.map((h) => [h.key, h]))
  }

  handler(key: string): RecipeHandler | undefined {
    return this.byKey.get(key)
  }

  /** 这条配方属于哪一页（不用读文件）。 */
  handlerOfRecipe(ref: number): RecipeHandler | undefined {
    return this.handlers[this.handlerOf[ref] ?? 0xffff]
  }

  /** 产出这个物品的配方的编号，按文件里的顺序。 */
  makesOf(id: string, meta: number): readonly number[] {
    return this.makes.get(itemPosting(id, meta)) ?? EMPTY
  }

  /**
   * 用到这个物品的配方的编号：点名要它的、要这个 id 的任何 meta 的、要它所在的某个矿辞名的。
   * ores 是这个物品登记在哪些矿辞名下（物品表里有）。
   */
  usesOf(id: string, meta: number, ores: readonly string[] = []): number[] {
    const lists = [this.used.get(itemPosting(id, meta)), this.used.get(itemPosting(id, ANY_META)), ...ores.map((o) => this.used.get(orePosting(o)))].filter((l) => l !== undefined)
    if (lists.length === 0) return []
    if (lists.length === 1) return [...lists[0]!]
    return [...new Set(lists.flat())].sort((a, b) => a - b)
  }

  /** 产出这种流体（注册名，如 molten.steel）的配方的编号，按文件里的顺序。 */
  makesFluid(fluid: string): readonly number[] {
    return this.fluidMakes.get(fluid) ?? EMPTY
  }

  /** 用到这种流体的配方的编号。 */
  usesFluid(fluid: string): readonly number[] {
    return this.fluidUsed.get(fluid) ?? EMPTY
  }

  /** 流体的名字（配方册里的中文名）；配方册里没出现过这种流体就是 undefined。 */
  fluidName(fluid: string): string | undefined {
    return this.fluidNames.get(fluid)
  }

  /** 配方册里出现过的全部流体：注册名和名字。 */
  fluidEntries(): IterableIterator<[string, string]> {
    return this.fluidNames.entries()
  }

  /** 做得出多少种物品、多少种物品（和矿辞名）被用作原料。 */
  get counts(): { products: number; ingredients: number } {
    return { products: this.makes.size, ingredients: this.used.size }
  }

  /** 读一条配方。编号不对、那一行读不出来、是 fake 的，都返回 undefined。 */
  get(ref: number): Recipe | undefined {
    if (!Number.isInteger(ref) || ref < 0 || ref >= this.size) return undefined
    const handler = this.handlerOfRecipe(ref)
    if (!handler) return undefined
    const length = this.lengths[ref]!
    if (this.buffer.length < length) this.buffer = Buffer.allocUnsafe(length * 2)
    let r: unknown
    try {
      fs.readSync(this.fd, this.buffer, 0, length, this.offsets[ref]!)
      r = JSON.parse(this.buffer.toString('utf8', 0, length))
    } catch {
      return undefined
    }
    if (!isRecord(r) || r.fake === true) return undefined
    const recipe: Recipe = { ref, handler, in: list(r.in, slot), out: list(r.out, stack), fin: fluids(r.fin), fout: fluids(r.fout) }
    if (typeof r.eut === 'number') recipe.eut = r.eut
    if (typeof r.ticks === 'number') recipe.ticks = r.ticks
    if (typeof r.special === 'number' && r.special !== 0) recipe.special = r.special
    return recipe
  }

  close(): void {
    try {
      fs.closeSync(this.fd)
    } catch {
      /* 已经关了 */
    }
  }
}
