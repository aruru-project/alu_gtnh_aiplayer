// “基地的做法”：这个基地怎么做东西的记录——主人教的，和它自己定过的。结构化、落盘（methods.json）、会越记越多，
// 重启和压缩历史都不丢。total_materials 展开材料时按它走；它本来会看的地方（查做法、看机器）也带上相关的那一条。
//
// 六种条目：
//   part     一类零件怎么做：按矿辞前缀（plate、stick……，可以再限定材料）→ 用哪种做法、从哪种料来（plate ← 卷板机，从 ingot）。
//   ready    当现成的、不往下做：矿辞前缀（ingot）、矿辞名（ingotSteel）或者一样具体的物品。从零算“整条线要多少资源”时停在锭、粉。
//   same     有条件的先后：两种做法做同一样东西、用的料一样（工具不算料）时用哪一种；可以加“只在那一种不用工具时”。
//            （“马达在组装机和工作台上材料一样，组装机还要耗电，手工做就行”）
//   thing    一样具体的东西用哪条配方。配方册重新导出以后编号会变，所以存的是认得回来的特征（做法 + 原料 + 产物 + 流体），
//            用的时候对回现在的编号；对不回来的照实说失效了。
//   order    没有更具体的规矩时，几种做法谁先谁后（只有一条）。
//   machine  某台机器（坐标）是专门干什么的、进料和收货的容器在哪、别动它的什么。
// 每条都带：谁定的（主人说的 / 它自己定的）、什么时候、理由（一句）。
//
// 这里只管存和按键查；一条记录写得对不对（做法认不认得、配方做不做得出那样东西）由写它的人先查好（tools/methods.ts）。

import path from 'node:path'
import { isRecord, readJson, writeJsonAtomic } from './files.ts'

export type MethodBy = 'owner' | 'self'
export const METHODS_MAX = 600
export const METHOD_WHY_MAX_CHARS = 200
export const METHOD_TEXT_MAX_CHARS = 300

interface Common {
  /** 这一条的键：part:plate、part:plate:Steel、thing:<东西的键>、order、machine:x,y,z。写同一个键就是改。 */
  key: string
  by: MethodBy
  /** 什么时候定的（epoch ms）。 */
  at: number
  why: string
}

export interface PartMethod extends Common {
  kind: 'part'
  /** 矿辞前缀：plate、stick、screw…… */
  prefix: string
  /** 只管这一种材料（矿辞名里前缀后面的那一半，如 Steel）；不给是这一类全部。 */
  material?: string
  /** 用哪种做法：配方页的名字（卷板机）。同名的页都算。 */
  way: string
  /** 从哪种料来：另一个矿辞前缀（ingot）。不给就是这种做法里列在最前的那条。 */
  from?: string
}

/** 当现成的、不往下做的东西。 */
export interface ReadyMethod extends Common {
  kind: 'ready'
  /** 怎么认：prefix 矿辞前缀（ingot 管 ingotSteel、ingotCopper……）；ore 一个矿辞名；item 一样物品（meta 不给是任何 meta）。 */
  match: 'prefix' | 'ore' | 'item'
  /** 前缀、矿辞名，或者物品的 id。 */
  text: string
  meta?: number
  /** 物品叫什么（写下来那时候的中文名）。 */
  name?: string
}

/** 两种做法用的料一样时用哪一种。 */
export interface SameMethod extends Common {
  kind: 'same'
  /** 用这一种（配方页的名字）。 */
  use: string
  /** 不用这一种。 */
  over: string
  /** 只在 use 那一种的配方不用工具时才算。 */
  noTools?: true
}

/** 一条配方的特征：编号变了还认得出它。 */
export interface RecipeMark {
  /** 写下来那时候的编号（先试它）。 */
  ref: number
  /** 配方页的内部名和名字。 */
  way: string
  wayName: string
  /** 原料、产物：[东西的写法, 数量]，排过序。流体是 [注册名, mB]。 */
  in: [string, number][]
  out: [string, number][]
  fin: [string, number][]
  fout: [string, number][]
  /** 写下来那时候它长什么样（给人看的一行；失效以后只剩这句话可看）。 */
  text: string
}

export interface ThingMethod extends Common {
  kind: 'thing'
  /** 哪样东西（material-tree.ts 的 TreeThing.key）：ore:plateSteel、id/meta、fluid:注册名。 */
  thing: string
  /** 它叫什么（写下来那时候的中文名）。 */
  name: string
  recipe: RecipeMark
}

export interface OrderMethod extends Common {
  kind: 'order'
  /** 做法的名字，先用的在前。 */
  ways: string[]
}

export interface MethodPos {
  x: number
  y: number
  z: number
}

export interface MachineMethod extends Common, MethodPos {
  kind: 'machine'
  dim?: number
  /** 这台机器叫什么（写下来那时候看到的）。 */
  name?: string
  /** 它是专门干什么的。 */
  does: string
  /** 进料的容器、收货的容器。 */
  feed?: MethodPos
  collect?: MethodPos
  /** 别动它的什么。 */
  keep?: string
}

export type Method = PartMethod | ReadyMethod | SameMethod | ThingMethod | OrderMethod | MachineMethod

export const partKey = (prefix: string, material?: string): string => (material ? `part:${prefix}:${material}` : `part:${prefix}`)
export const thingKey = (thing: string): string => `thing:${thing}`
export const ORDER_KEY = 'order'
export const machineKey = (p: MethodPos): string => `machine:${p.x},${p.y},${p.z}`
export const readyKey = (text: string, meta?: number): string => `ready:${text}${meta !== undefined ? `/${meta}` : ''}`
export const sameKey = (use: string, over: string): string => `same:${use}>${over}`

const KIND_ORDER: Record<Method['kind'], number> = { part: 0, ready: 1, same: 2, order: 3, thing: 4, machine: 5 }

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const pos = (v: unknown): MethodPos | undefined => (isRecord(v) && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number' ? { x: v.x, y: v.y, z: v.z } : undefined)
const pairs = (v: unknown): [string, number][] => (Array.isArray(v) ? v.filter((p): p is [string, number] => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'number').map((p) => [p[0], p[1]]) : [])

/** 文件里的一条读回来；认不出来的丢掉（手改坏的文件不让进程起不来）。 */
function parse(raw: unknown): Method | undefined {
  if (!isRecord(raw) || typeof raw.key !== 'string') return undefined
  const common: Common = { key: raw.key, by: raw.by === 'owner' ? 'owner' : 'self', at: typeof raw.at === 'number' ? raw.at : 0, why: str(raw.why, METHOD_WHY_MAX_CHARS) }
  if (raw.kind === 'part' && typeof raw.prefix === 'string' && typeof raw.way === 'string') {
    return { ...common, kind: 'part', prefix: raw.prefix, way: raw.way, ...(typeof raw.material === 'string' && raw.material ? { material: raw.material } : {}), ...(typeof raw.from === 'string' && raw.from ? { from: raw.from } : {}) }
  }
  if (raw.kind === 'thing' && typeof raw.thing === 'string' && isRecord(raw.recipe) && typeof raw.recipe.ref === 'number' && typeof raw.recipe.way === 'string') {
    const r = raw.recipe
    return {
      ...common,
      kind: 'thing',
      thing: raw.thing,
      name: str(raw.name, 200),
      recipe: { ref: r.ref as number, way: r.way as string, wayName: str(r.wayName, 200), in: pairs(r.in), out: pairs(r.out), fin: pairs(r.fin), fout: pairs(r.fout), text: str(r.text, 2000) },
    }
  }
  if (raw.kind === 'ready' && typeof raw.text === 'string' && (raw.match === 'prefix' || raw.match === 'ore' || raw.match === 'item')) {
    return { ...common, kind: 'ready', match: raw.match, text: raw.text, ...(typeof raw.meta === 'number' ? { meta: raw.meta } : {}), ...(typeof raw.name === 'string' && raw.name ? { name: str(raw.name, 200) } : {}) }
  }
  if (raw.kind === 'same' && typeof raw.use === 'string' && typeof raw.over === 'string') return { ...common, kind: 'same', use: raw.use, over: raw.over, ...(raw.noTools === true ? { noTools: true as const } : {}) }
  if (raw.kind === 'order' && Array.isArray(raw.ways)) return { ...common, kind: 'order', key: ORDER_KEY, ways: raw.ways.filter((w): w is string => typeof w === 'string' && w.trim().length > 0) }
  const at = pos(raw)
  if (raw.kind === 'machine' && at && typeof raw.does === 'string') {
    const feed = pos(raw.feed)
    const collect = pos(raw.collect)
    return {
      ...common,
      kind: 'machine',
      ...at,
      does: str(raw.does, METHOD_TEXT_MAX_CHARS),
      ...(typeof raw.dim === 'number' ? { dim: raw.dim } : {}),
      ...(typeof raw.name === 'string' && raw.name ? { name: str(raw.name, 200) } : {}),
      ...(feed ? { feed } : {}),
      ...(collect ? { collect } : {}),
      ...(str(raw.keep, METHOD_TEXT_MAX_CHARS) ? { keep: str(raw.keep, METHOD_TEXT_MAX_CHARS) } : {}),
    }
  }
  return undefined
}

export class MethodStore {
  private readonly file: string
  private readonly entries = new Map<string, Method>()

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'methods.json')
    const raw = readJson(this.file)
    if (isRecord(raw) && Array.isArray(raw.entries)) {
      for (const item of raw.entries) {
        const entry = parse(item)
        if (entry) this.entries.set(entry.key, entry)
      }
    }
  }

  /** 全部条目：一类零件、当现成的、同料时的先后、总的先后、具体的东西、机器；每种里先记的在前。 */
  list(): Method[] {
    return [...this.entries.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.at - b.at || a.key.localeCompare(b.key))
  }

  get(key: string): Method | undefined {
    return this.entries.get(key)
  }

  /** 记一条；同一个键的旧记录被换掉。满了（METHODS_MAX）又不是改旧的，抛错。 */
  set(entry: Method): void {
    if (!this.entries.has(entry.key) && this.entries.size >= METHODS_MAX) throw new Error(`the base's methods are full (${METHODS_MAX} entries): remove one that is no longer true first`)
    this.entries.set(entry.key, entry)
    this.save()
  }

  remove(key: string): boolean {
    if (!this.entries.delete(key)) return false
    this.save()
    return true
  }

  thingFor(thing: string): ThingMethod | undefined {
    const entry = this.entries.get(thingKey(thing))
    return entry?.kind === 'thing' ? entry : undefined
  }

  order(): OrderMethod | undefined {
    const entry = this.entries.get(ORDER_KEY)
    return entry?.kind === 'order' ? entry : undefined
  }

  machineAt(p: MethodPos): MachineMethod | undefined {
    const entry = this.entries.get(machineKey(p))
    return entry?.kind === 'machine' ? entry : undefined
  }

  private save(): void {
    writeJsonAtomic(this.file, { version: 1, entries: this.list() })
  }
}
