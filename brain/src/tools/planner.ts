// 做法规划：给一个目标物品和数量，把整棵“怎么做”的树替模型走完，返回一份可以照着一步步执行的计划。
//
// 小模型查得出一层配方，却不会自己一层层往下查；这里按 crafting 手册里那套规矩替它走：
//   - 每样东西先看库存（身上 + 附近仓库），够就取，不够的那部分才往下展开；
//   - 挑做法：只用基地里现在做得了的（机器、合成台沿用查做法那套比对）；手工工具配方只在没有机器做得了时用；
//     原料现成的优先，然后是每个成品最省料的；
//   - 数量沿树算：一轮出几个按轮数取整；模具、模头、工具这类不消耗的只要 1 个；编程电路不是原料；
//   - 做不了的叶子（没有这种机器、电压炉温不够、库存没有又没有配方）单独列出来，那才是该报给主人的“缺什么”；
//   - 要主人先点头的事（接着管道的箱子和总线、有维护问题的机器、省料的做法做不了只能用费料的）单独列出来。
//   - 机器原料格里现成的模具、模头：库存里没有时先借（从那台机器取出来，用完放回去；就在要用的那台机器里的原地用），
//     不从头做一个；那是主人机器里的东西，取之前要问。要用的机器原料格被别的模具占着放不下时，先挪出来、做完放回去。
//
// 同一样东西在树上出现几次时合成一个节点，需求加在一起，所以库存不会被重复算，也不会同一样中间件分两次做。
// 库存分两种看法：先把附近的容器扫一遍得到一张粗表（挑材质、判断“这条路走不走得通”用，不精确没关系），
// 计划里真正要取的东西再向身体精确地问一次（world.stock：真实数量和所在的容器）。

import { BridgeError } from '../bridge/protocol.ts'
import type { AttachedBlock, ContainerInfo, InventoryItem, MachineHatch, MachineInfo, StockQuery } from '../bridge/protocol.ts'
import { ANY_META, CIRCUIT_ID } from '../packdata/index.ts'
import type { Recipe, RecipeBook, RecipeFluid, RecipeSlot } from '../packdata/index.ts'
import type { ItemTable } from '../packdata/items.ts'
import { formatPos, itemKey, nameOf } from './format.ts'
import {
  circuitOf,
  fitsPocketGrid,
  isHandCraft,
  isTool,
  lookAround,
  machineProblems,
  materialOfOre,
  mergedSlots,
  namer,
  quantity,
  runsWay,
  signature,
  slotKey,
  unifiedOre,
  otherMachines,
  powerUnread,
  scanContainers,
  spread,
  wayKind,
  whereItStands,
  CONTAINERS_REACH,
  MACHINES_REACH,
  TABLES_REACH,
  UNREAD_NOTE,
} from './recipe-book.ts'
import type { Namer, OtherMachine, Spot, Surroundings } from './recipe-book.ts'
import { fail } from './types.ts'
import type { ToolContext, ToolResult } from './types.ts'

export const PLAN_STEPS_PER_PAGE = 20
/** 一份计划最多展开这么多样东西、这么多层；到了就停下并说明没展开完。 */
export const PLAN_MAX_NODES = 60
export const PLAN_MAX_DEPTH = 10
export const PLAN_MAX_COUNT = 2304
/** 一样东西最多看这么多条做法（工具每种材质一条，几百条）。 */
const CANDIDATES_MAX = 3000
const CANDIDATES_CHUNK = 250
/** “这条路走不走得通”往下看几层；展开一样东西时最多看多少条配方、整份计划一共最多看多少条；一样东西的做法里最多细看多少条。 */
const LOOKAHEAD_DEPTH = 5
const LOOKAHEAD_BUDGET = 8000
const LOOKAHEAD_TOTAL = 80_000
const LOOKAHEAD_CANDIDATES = 60
/** 一样东西有这么多条现在做得了的做法（工具：每种材质一条），而哪条的料都凑不齐时，不替主人挑材质，把它本身报成缺的。 */
const FAMILY_SIZE = 8
const STOCK_BATCH = 24
// 库存和机器一样，往四周错开几个点各查一次，合起来看（仓库和机器常常不在一处）：
// world.stock 一次最多看 64 格，四个点各错开 48 格；world.containers 一次最多看 32 格，3×3 九个点各隔 64 格。
const STOCK_QUERY_RADIUS = 64
const STOCK_QUERY_STEP = 48
export const STORAGE_REACH = CONTAINERS_REACH
/** 能做的做法比做不了的那种费料到这个倍数，就算“差别很大”，要问主人。 */
const MUCH_MORE = 1.5
/** 省料的做法现在就用不上（要先另做模具）时，这一步总共多耗的料不到这么多个，就不为它问主人。 */
const WORTH_ASKING = 4
/** 机器的一格、任务的一次：一步里一样原料最多放这么多，最多做这么多轮。 */
const STACK = 64
const ROUNDS_PER_STEP = 64
/** 估出来要等这么久以上的加工，步骤里写明 wait。 */
const DEFAULT_WAIT_SEC = 180

interface Pos {
  x: number
  y: number
  z: number
}

interface Ref {
  id: string
  meta: number
}

const posKey = (p: Pos): string => `${p.x},${p.y},${p.z}`
const refKey = (r: Ref): string => `${r.id}/${r.meta}`

/** 树上的一样东西：要什么（一种确定的物品、一个矿辞名下的任何一种、几种里的任何一种）。 */
interface Need {
  key: string
  /** 判断“绕回来了”用：同一种材料的同一种形态算同一样（EnderIO 的玄钢锭和 GregTech 的玄钢锭）。 */
  material: string
  /** 带 id 的叫法（取货、合成要用）和只有名字的叫法。 */
  label: string
  short: string
  slot: RecipeSlot
  ore?: string
  queries: StockQuery[]
  /** 做出哪些物品算是有了它（查配方用）。 */
  products: Ref[]
  tool: boolean
}

/** 一处存货：身上的（at 没有），或者某个容器里的。 */
interface Holding {
  id: string
  meta: number
  count: number
  at?: Pos
  container?: string
  automated?: AttachedBlock[]
  /** 不是库存：放在一台单方块机器原料格里的模具、模头（at 是那台机器）。借来用，取之前要问主人。 */
  lent?: boolean
}

interface Take {
  id: string
  meta: number
  count: number
  at?: Pos
  container?: string
  automated?: AttachedBlock[]
  lent?: boolean
}

/** 一台单方块机器原料格里放着的一样东西：shape 是模具、模头（这台机器的配方拿它当不消耗的原料），material 是没用完的原料。 */
interface Inside {
  id: string
  meta: number
  count: number
  role: 'shape' | 'material'
}

type Usable =
  /**
   * unread：这台机器的状态身体读不全，只能放进去试。
   *   steam   蒸汽机器（有没有蒸汽、压力够不够读不出来）；
   *   unknown 身体不认识的机器（别的 mod 的、原版熔炉）：照配方册认出来的，照玩家的办法用。
   */
  | { state: 'now'; machine?: MachineInfo; bus?: Pos; pocket?: boolean; asks: string[]; unread?: 'steam' | 'unknown' }
  /** absent：附近没有这种机器、合成台（why 是一句完整的话，lacks 是缺的那样东西）；blocked：有但现在不行；cannot：它操作不了的方式。 */
  | { state: 'absent' | 'blocked' | 'cannot'; why: string; lacks?: string }

interface Candidate {
  recipe: Recipe
  /** machine 是 GregTech 的机器配方，device 是别的机器（熔炉、别的 mod 的），见 recipe-book.ts 的 wayKind。 */
  kind: 'machine' | 'device' | 'craft' | 'other'
  /** 要电池的（电动工具）。 */
  powered: boolean
  /** 一轮出几个要的那样东西。 */
  yield: number
  /** 合并过的原料格（不含编程电路）。 */
  slots: RecipeSlot[]
  circuit?: number
  usable: Usable
  handTool: boolean
  /** 每个成品耗掉的原料个数（粗略的“省不省料”）。 */
  cost: number
  /** 粗表里不够的那几格原料（要先做出来）；其中既没有也做不出来的有几格，里面不是“基础材料或工具”的又有几格。 */
  shortSlots: RecipeSlot[]
  blocked: number
  oddBlocked: number
  /** 缺的原料里，只有靠流体没着落的配方才弄得到的有几格。 */
  unsure: number
  /** 既没有也做不出来的那几格。 */
  stuck: RecipeSlot[]
  /** 料凑不齐、也不值得顺着它往下找的：它的料一样现成的都没有（往下几层也没有）。 */
  hopeless: boolean
}

interface PlanNode {
  need: Need
  root: boolean
  depth: number
  parents: Set<string>
  /** 这一遍算出来的：被消耗掉多少、是不是还要留一个不消耗的（模具、工具）。 */
  consumed: number
  keep: boolean
  takes: Take[]
  expanded: boolean
  choice?: Candidate
  /** 挑它的理由和别的做法（英文，给模型看）。 */
  why?: string
  others?: string[]
  asks?: string[]
  children: { key: string; n: number; keep: boolean }[]
  rounds: number
  /** 做不了时：为什么做不了（“库存里没有”之外的那一半）。short 是还差多少。 */
  leaf?: string
  short: number
}

export interface PlanStep {
  n: number
  tool: 'withdraw_items' | 'craft_item' | 'process_items' | 'deposit_items'
  input: Record<string, unknown>
  /** 这一步是干什么的（英文，带中文物品名）。 */
  text: string
  /** 挑这种做法的理由和别的做法。 */
  why?: string
  /** 这一步的原料里有还缺着的东西。 */
  waitsFor?: string[]
  /** 这一步要主人先点头。 */
  ask?: boolean
  /** 这一步用的机器，身体读不全它的状态（蒸汽机器、别的 mod 的机器、熔炉）：是放进去试。 */
  untested?: boolean
}

export interface PlanData {
  target: { id: string; meta: number; name: string; count: number }
  /** 缺的东西都齐、没有碰到上限。 */
  feasible: boolean
  steps: PlanStep[]
  /** for：它是给计划里哪样东西用的（目标本身不写）——主人手里要是有那样东西，给那样也行。 */
  missing: { name: string; id?: string; meta?: number; ore?: string; fluid?: string; count: number; for?: string[]; reason: string }[]
  decisions: string[]
  /** 计划没展开完（碰到了节点数或层数的上限）。 */
  cutOff: boolean
}

// ── 材料 ──

/**
 * 一样东西是什么材料做的（钢锭、钢板、钢锯刃都是 “Steel”）：挑材质时先看库存里有的材料。
 * 材料件的矿辞名（ingotSteel、plateSteel）直接去掉前缀；别的（toolHeadSawSteel）看它是不是以某个已知的材料名结尾，取最长的那个。
 */
class Materials {
  private known: Set<string> | undefined
  private readonly items: ItemTable | undefined

  constructor(items: ItemTable | undefined) {
    this.items = items
  }

  of(ores: readonly string[] | undefined): string[] {
    const out: string[] = []
    for (const ore of ores ?? []) {
      const unified = materialOfOre(ore)
      if (unified !== undefined) {
        out.push(unified)
        continue
      }
      if (!this.known) {
        this.known = new Set()
        for (const item of this.items?.all() ?? []) {
          for (const name of item.ores ?? []) {
            const material = materialOfOre(name)
            if (material !== undefined) this.known.add(material)
          }
        }
      }
      // 从左往右找第一个“剩下的部分正好是一个材料名”的大写字母：那就是最长的
      for (let at = 1; at < ore.length; at++) {
        const ch = ore.charCodeAt(at)
        if (ch >= 65 && ch <= 90 && this.known.has(ore.slice(at))) {
          out.push(ore.slice(at))
          break
        }
      }
    }
    return out
  }
}

// ── 库存 ──

interface Flag {
  kind?: string
  attached?: AttachedBlock[]
}

class Stock {
  /** 粗表：附近容器里每种物品一共多少（加上身上的）。 */
  readonly broad = new Map<string, number>()
  private readonly broadById = new Map<string, number>()
  private broadByOre: Map<string, number> | undefined
  /** 每个容器是不是机器、接没接管道。 */
  readonly flags = new Map<string, Flag>()
  /** 机器的格子里放着什么（world.containers 看到的，原料格、产物格不分）。不算库存。 */
  readonly inMachines = new Map<string, { id: string; meta: number; count: number }[]>()
  /** 机器原料格里可以借的模具、模头（规划时定的，见 Planner.lookInsideMachines）。 */
  lendable: Holding[] = []
  scanned = 0
  scanCut = false
  private readonly exact = new Map<string, Holding[]>()
  private readonly reserved = new Map<string, number>()
  private readonly ctx: ToolContext
  private readonly items: ItemTable | undefined
  private readonly inventory: readonly InventoryItem[]
  private readonly me: Spot

  constructor(ctx: ToolContext, items: ItemTable | undefined, inventory: readonly InventoryItem[], me: Spot) {
    this.ctx = ctx
    this.items = items
    this.inventory = inventory
    this.me = me
    this.materials = new Materials(items)
  }

  /**
   * 记下扫回来的容器：粗表，和每个容器的标记。机器里的东西不算库存——
   * 身体认识的机器（含总线、仓）、身体不认识但配方册认得的机器（熔炉里的燃料和没取走的产物）都一样。
   */
  load(machines: readonly MachineInfo[], others: readonly OtherMachine[], scanned: { containers: readonly ContainerInfo[]; cut: boolean }): void {
    for (const m of machines) {
      this.flags.set(posKey(m), { kind: 'machine' })
      for (const h of [...(m.inputBuses ?? []), ...(m.outputBuses ?? []), ...(m.inputHatches ?? []), ...(m.outputHatches ?? [])]) {
        this.flags.set(posKey(h), { kind: 'machine', ...(h.attached ? { attached: h.attached } : {}) })
      }
    }
    for (const o of others) this.flags.set(posKey(o), { kind: 'machine' })
    this.scanned = scanned.containers.length
    this.scanCut = scanned.cut
    for (const c of scanned.containers) {
      const flag: Flag = { ...(c.kind ? { kind: c.kind } : {}), ...(c.attached && c.attached.length > 0 ? { attached: c.attached } : {}) }
      // 机器的主机和总线上面已经记过：留着那边记的 kind 和 attached
      const known = this.flags.get(posKey(c))
      this.flags.set(posKey(c), { ...known, ...flag, ...(known?.kind === 'machine' ? { kind: 'machine' } : {}) })
      const machine = c.kind === 'machine' || known?.kind === 'machine'
      if (machine) this.inMachines.set(posKey(c), (c.items ?? []).filter((it) => it && typeof it.id === 'string').map((it) => ({ id: it.id, meta: it.meta ?? 0, count: typeof it.count === 'number' ? it.count : 1 })))
      if (machine || c.kind === 'drawer_controller') continue
      for (const it of c.items ?? []) if (it && typeof it.id === 'string') this.addBroad(it.id, it.meta ?? 0, typeof it.count === 'number' ? it.count : 1)
    }
    for (const it of this.inventory) if (it && typeof it.id === 'string') this.addBroad(it.id, it.meta ?? 0, typeof it.count === 'number' ? it.count : 1)
  }

  private addBroad(id: string, meta: number, count: number): void {
    this.broad.set(`${id}/${meta}`, (this.broad.get(`${id}/${meta}`) ?? 0) + count)
    this.broadById.set(id, (this.broadById.get(id) ?? 0) + count)
  }

  /** 库存里以任何形态存在的材料（有钢锭就算有“Steel”）：挑材质时先看这些。 */
  private stocked: Map<string, number> | undefined
  readonly materials: Materials
  hasMaterial(material: string): boolean {
    return this.stockedMaterials().has(material)
  }

  private stockedMaterials(): Map<string, number> {
    if (!this.stocked) {
      this.stocked = new Map()
      for (const [key, count] of this.broad) {
        const cut = key.lastIndexOf('/')
        for (const material of this.materials.of(this.items?.get(key.slice(0, cut), Number(key.slice(cut + 1)))?.ores)) this.stocked.set(material, (this.stocked.get(material) ?? 0) + count)
      }
    }
    return this.stocked
  }

  /** 这种材料库存里一共有多少件（各种形态加在一起）：几种材质都做得了时，用多的那种。 */
  materialCount(material: string): number {
    return this.stockedMaterials().get(material) ?? 0
  }

  /** 流体注册名里的材料（molten.darksteel 的 darksteel）库存里有没有。 */
  private stockedLower: Set<string> | undefined
  hasMaterialNamed(lower: string): boolean {
    this.stockedLower ??= new Set([...this.stockedMaterials().keys()].map((m) => m.toLowerCase()))
    return this.stockedLower.has(lower)
  }

  /** 粗表里这样东西大概有多少（机器里可以借的模具也算）。 */
  broadCount(need: Need): number {
    return this.stored(need) + this.lendable.reduce((n, h) => (this.fits(need, h.id, h.meta) ? n + h.count : n), 0)
  }

  private stored(need: Need): number {
    const slot = need.slot
    if (need.ore !== undefined) {
      if (!this.broadByOre) {
        this.broadByOre = new Map()
        for (const [key, count] of this.broad) {
          const cut = key.lastIndexOf('/')
          for (const ore of this.items?.get(key.slice(0, cut), Number(key.slice(cut + 1)))?.ores ?? []) this.broadByOre.set(ore, (this.broadByOre.get(ore) ?? 0) + count)
        }
      }
      const known = this.broadByOre.get(need.ore) ?? 0
      // 物品表里没登记这个矿辞名的（表不全时）：按配方里列出来的那几种再数一遍，取多的
      const listed = need.products.reduce((n, p) => n + (this.broad.get(refKey(p)) ?? 0), 0)
      return Math.max(known, listed)
    }
    if (slot.kind === 'item') return slot.meta === ANY_META ? (this.broadById.get(slot.id) ?? 0) : (this.broad.get(`${slot.id}/${slot.meta}`) ?? 0)
    return need.products.reduce((n, p) => n + (this.broad.get(refKey(p)) ?? 0), 0)
  }

  /** 向身体精确地问这些东西各在哪、有多少（问过的不再问）。 */
  async ensure(needs: readonly Need[]): Promise<void> {
    const wanted: { need: Need; query: StockQuery }[] = []
    for (const need of needs) {
      if (this.exact.has(need.key)) continue
      this.exact.set(need.key, [])
      for (const query of need.queries) wanted.push({ need, query })
    }
    const points = spread(this.me, STOCK_QUERY_STEP)
    for (let from = 0; from < wanted.length; from += STOCK_BATCH) {
      const batch = wanted.slice(from, from + STOCK_BATCH)
      const answers = await Promise.all(points.map((at) => this.ctx.bridge.worldStock(at, { items: batch.map((b) => b.query), radius: STOCK_QUERY_RADIUS })))
      batch.forEach(({ need, query }, n) => {
        const holdings = this.exact.get(need.key)!
        // 四个点各自的答案里同一个容器会重：merge 按“哪个容器里的哪种东西”认，不会算两遍
        for (const place of answers.flatMap((res) => res.items?.[n]?.places ?? [])) {
          const flag = this.flags.get(posKey(place))
          // 机器、总线里的东西是正在加工的料，不是库存
          if (flag?.kind === 'machine' || flag?.kind === 'drawer_controller') continue
          const at = { x: place.x, y: place.y, z: place.z }
          const extra = { at, ...(place.container ? { container: place.container } : {}), ...(flag?.attached ? { automated: flag.attached } : {}) }
          if (place.items && place.items.length > 0) {
            for (const it of place.items) if (typeof it.id === 'string') this.merge(holdings, { id: it.id, meta: it.meta ?? 0, count: typeof it.count === 'number' ? it.count : 0, ...extra })
          } else if ('id' in query && query.meta !== undefined) {
            this.merge(holdings, { id: query.id, meta: query.meta, count: place.count, ...extra })
          }
        }
      })
    }
  }

  private merge(list: Holding[], h: Holding): void {
    if (h.count <= 0) return
    const seen = list.find((x) => x.id === h.id && x.meta === h.meta && x.at !== undefined && h.at !== undefined && posKey(x.at) === posKey(h.at))
    if (seen) seen.count = Math.max(seen.count, h.count)
    else list.push(h)
  }

  /** 这个物品合不合这样东西的要求。 */
  fits(need: Need, id: string, meta: number): boolean {
    const slot = need.slot
    if (need.ore !== undefined) return this.items?.get(id, meta)?.ores?.includes(need.ore) === true || need.products.some((p) => p.id === id && p.meta === meta)
    if (slot.kind === 'item') return slot.id === id && (slot.meta === ANY_META || slot.meta === meta)
    return need.products.some((p) => p.id === id && (p.meta === ANY_META || p.meta === meta))
  }

  /** 身上的东西里合这样东西要求的。 */
  private carried(need: Need): Holding[] {
    const out: Holding[] = []
    for (const it of this.inventory) {
      if (!it || typeof it.id !== 'string' || !this.fits(need, it.id, it.meta ?? 0)) continue
      const seen = out.find((h) => h.id === it.id && h.meta === (it.meta ?? 0))
      const count = typeof it.count === 'number' ? it.count : 1
      if (seen) seen.count += count
      else out.push({ id: it.id, meta: it.meta ?? 0, count })
    }
    return out
  }

  /** 这样东西现有的存货：身上的在前，然后是没接管道的容器，多的在前；最后才是机器里可以借的。 */
  holdings(need: Need): Holding[] {
    const stored = [...(this.exact.get(need.key) ?? [])].sort((a, b) => Number(a.automated !== undefined) - Number(b.automated !== undefined) || b.count - a.count)
    return [...this.carried(need), ...stored, ...this.lendable.filter((h) => this.fits(need, h.id, h.meta))]
  }

  private slotOf(h: Holding): string {
    return `${h.id}/${h.meta}@${h.at ? posKey(h.at) : 'carried'}`
  }

  free(h: Holding): number {
    return Math.max(0, h.count - (this.reserved.get(this.slotOf(h)) ?? 0))
  }

  reserve(h: Holding, n: number): void {
    this.reserved.set(this.slotOf(h), (this.reserved.get(this.slotOf(h)) ?? 0) + n)
  }

  release(): void {
    this.reserved.clear()
  }
}

// ── 规划 ──

class Planner {
  readonly nodes = new Map<string, PlanNode>()
  cutOff = false
  private lookahead = 0
  private lookaheadTotal = 0
  /** “往下看”因为太深、太多而中途放弃的次数。 */
  private cutShort = 0
  /** 一种机器配方（哪一页、多大电压、多高炉温）现在做不做得了：同一页的几百条配方不用每条都去比一遍机器。 */
  private readonly usableMemo = new Map<string, Usable>()
  private readonly needMemo = new Map<string, Need>()
  private readonly progressMemo = new Map<string, boolean>()
  /** 做一样东西的全部做法（读过、去过重的），按东西记着：往下看的时候同一样东西会被问很多次。 */
  private readonly recipesMemo = new Map<string, Omit<Candidate, 'usable' | 'shortSlots' | 'blocked' | 'oddBlocked' | 'unsure' | 'stuck' | 'hopeless'>[]>()
  private readonly canGetMemo = new Map<string, 0 | 1 | 2>()
  private readonly book: RecipeBook
  private readonly items: ItemTable | undefined
  private readonly nm: Namer
  private readonly around: Surroundings
  private readonly stock: Stock
  /** 每台单方块机器的原料格里现在放着什么（模具、模头、没用完的原料）。 */
  private readonly inside = new Map<string, Inside[]>()

  constructor(book: RecipeBook, items: ItemTable | undefined, around: Surroundings, stock: Stock, opts: { borrow?: boolean } = {}) {
    this.book = book
    this.items = items
    this.nm = namer(items)
    this.around = around
    this.stock = stock
    this.lookInsideMachines(opts.borrow !== false)
  }

  // 机器里现成的东西

  /**
   * 看每台单方块机器的格子里放着什么：模具、模头可以借（borrow 为 false 时不借），它们和没用完的原料都占着原料格。
   * world.containers 不分原料格和产物格，所以照配方册认：这台机器的配方拿它当原料的，是在原料格里；它自己做得出来的当成产物，不管。
   */
  private lookInsideMachines(borrow: boolean): void {
    const lendable: Holding[] = []
    for (const m of this.around.machines) {
      if (m.kind === 'multiblock') continue
      const list: Inside[] = []
      for (const it of this.stock.inMachines.get(posKey(m)) ?? []) {
        const role = this.roleIn(m, it.id, it.meta)
        if (!role) continue
        list.push({ ...it, role })
        if (role === 'shape' && borrow) lendable.push({ id: it.id, meta: it.meta, count: it.count, at: { x: m.x, y: m.y, z: m.z }, ...(m.name ? { container: m.name } : {}), lent: true })
      }
      if (list.length > 0) this.inside.set(posKey(m), list)
    }
    this.stock.lendable = lendable
  }

  private roleIn(m: MachineInfo, id: string, meta: number): Inside['role'] | undefined {
    if (id === CIRCUIT_ID) return undefined
    const onThisMachine = (ref: number): boolean => {
      const handler = this.book.handlerOfRecipe(ref)
      return handler !== undefined && runsWay(m, handler)
    }
    if (this.book.makesOf(id, meta).some(onThisMachine)) return undefined
    const uses = this.book.usesOf(id, meta, this.items?.get(id, meta)?.ores ?? []).filter(onThisMachine)
    if (uses.length === 0) return undefined
    // 读几条看看：它在这台机器的配方里是不消耗的（模具、模头），还是要消耗的原料
    for (const ref of uses.slice(0, 6)) {
      const recipe = this.book.get(ref)
      if (recipe?.in.some((slot) => slot.n === 0 && slot.kind === 'item' && slot.id === id && (slot.meta === meta || slot.meta === ANY_META))) return 'shape'
    }
    return 'material'
  }

  // 一样东西

  /** 配方的一格原料是树上的哪样东西。machine：这是机器配方（点名的材料件，同一个矿辞名下的别的物品放进去也行）。 */
  needOf(slot: RecipeSlot, machine: boolean): Need {
    const memoKey = `${machine ? 1 : 0}|${slotKey(slot)}`
    let need = this.needMemo.get(memoKey)
    if (!need) this.needMemo.set(memoKey, (need = this.makeNeed(slot, machine)))
    return need
  }

  private makeNeed(slot: RecipeSlot, machine: boolean): Need {
    const nm = this.nm
    if (slot.kind === 'item') {
      const ore = machine && slot.meta !== ANY_META ? unifiedOre(this.items?.get(slot.id, slot.meta)) : undefined
      if (ore !== undefined) {
        const members = this.members(ore, [[slot.id, slot.meta]])
        const name = slot.name ?? nm.name(slot.id, slot.meta)
        return { key: `ore:${ore}`, material: `ore:${ore}`, label: `${nm.label(slot.id, slot.meta, slot.name)} (or any ${ore})`, short: name, slot, ore, queries: [{ ore }], products: members, tool: false }
      }
      const any = slot.meta === ANY_META
      const key = any ? `${slot.id}/*` : `${slot.id}/${slot.meta}`
      const material = any ? key : (this.materialOf(slot.id, slot.meta) ?? key)
      return {
        key,
        material,
        label: nm.label(slot.id, slot.meta, slot.name),
        short: slot.name ?? nm.name(slot.id, slot.meta),
        slot,
        queries: [any ? { id: slot.id } : { id: slot.id, meta: slot.meta }],
        products: [{ id: slot.id, meta: any ? 0 : slot.meta }],
        tool: false,
      }
    }
    if (slot.kind === 'ore') {
      const members = this.members(slot.ore, slot.any)
      const first = slot.any.find(([id]) => id.startsWith('gregtech:')) ?? slot.any[0] ?? (members[0] ? [members[0].id, members[0].meta] : undefined)
      const example = first ? nm.name(first[0], first[1]) : undefined
      return {
        key: `ore:${slot.ore}`,
        material: `ore:${slot.ore}`,
        label: `any ${slot.ore}${first ? ` (e.g. ${nm.label(first[0], first[1])})` : ''}`,
        short: example ?? `any ${slot.ore}`,
        slot,
        ore: slot.ore,
        queries: [{ ore: slot.ore }],
        products: members,
        tool: isTool(slot),
      }
    }
    const listed = slot.any.slice(0, 12)
    const first = listed[0]!
    const others = slot.any.length + slot.more - 1
    return {
      key: `any:${listed.map((a) => a.join('/')).join(',')}`,
      material: `any:${listed.map((a) => a.join('/')).join(',')}`,
      label: `${nm.label(first[0], first[1])}${others > 0 ? ` or ${others} similar` : ''}`,
      short: `${nm.name(first[0], first[1])}${others > 0 ? ' or similar' : ''}`,
      slot,
      queries: listed.map(([id, meta]) => (meta === ANY_META ? { id } : { id, meta })),
      products: listed.map(([id, meta]) => ({ id, meta: meta === ANY_META ? 0 : meta })),
      tool: false,
    }
  }

  /** 一个矿辞名下的物品：物品表里登记的，加上配方里列出来的。 */
  private members(ore: string, listed: readonly [string, number][]): Ref[] {
    const out = new Map<string, Ref>()
    for (const [id, meta] of listed) if (meta !== ANY_META) out.set(`${id}/${meta}`, { id, meta })
    for (const item of this.items?.withOre(ore) ?? []) if (item.meta !== ANY_META) out.set(`${item.id}/${item.meta}`, { id: item.id, meta: item.meta })
    return [...out.values()].slice(0, 80)
  }

  private materialOf(id: string, meta: number): string | undefined {
    const ore = unifiedOre(this.items?.get(id, meta))
    return ore !== undefined ? `ore:${ore}` : undefined
  }

  // 一条做法

  /** 这条配方现在做不做得了：哪台机器、哪个总线，或者为什么不行。 */
  private usable(recipe: Recipe): Usable {
    const kind = wayKind(recipe.handler)
    if (kind === 'other') return { state: 'cannot', why: `"${recipe.handler.name}" is not something a machine or a crafting grid does` }
    if (kind === 'craft') {
      if (!isHandCraft(recipe)) return { state: 'cannot', why: `"${recipe.handler.name}" needs a bigger crafting grid than you can use` }
      if (fitsPocketGrid(recipe)) return { state: 'now', pocket: true, asks: [] }
      if (this.around.tables.length === 0) return { state: 'absent', why: `there is no crafting table within ${TABLES_REACH} blocks`, lacks: 'a crafting table' }
      return { state: 'now', asks: [] }
    }
    const memoKey = `${recipe.handler.key}|${recipe.eut ?? 0}|${recipe.special ?? 0}`
    const memo = this.usableMemo.get(memoKey)
    if (memo) return memo
    const judged = this.usableMachine(recipe)
    this.usableMemo.set(memoKey, judged)
    return judged
  }

  private usableMachine(recipe: Recipe): Usable {
    const here = this.around.machines.filter((m) => runsWay(m, recipe.handler))
    // 身体不认识、配方册认得的机器（熔炉、别的 mod 的机器）：读不到状态，但可以照玩家的办法放进去试
    const untested = (this.around.others ?? []).filter((o) => o.ways.includes(recipe.handler.key))
    const tryOn = (): Usable => {
      const o = untested[0]!
      const m: MachineInfo = { x: o.x, y: o.y, z: o.z, id: o.item.id, meta: o.item.meta, ...(o.name ? { name: o.name } : {}) }
      return { state: 'now', machine: m, asks: this.asksOf(m).asks, unread: 'unknown' }
    }
    if (here.length === 0) {
      if (untested.length > 0) return tryOn()
      // 别的 mod 的配方页，名字是“烧制”“冶炼”这样的动作：把做它的机器（熔炉）说出来
      const block = wayKind(recipe.handler) === 'device' ? recipe.handler.machines[0] : undefined
      const what = block ? `${this.nm.name(block.id, block.meta)} (for "${recipe.handler.name}" recipes)` : recipe.handler.name
      return { state: 'absent', why: `there is no ${what} within ${MACHINES_REACH} blocks`, lacks: `a ${what}` }
    }
    const judged = here.map((m, order) => {
      const problems = machineProblems(m, recipe)
      if (m.kind === 'multiblock' && m.formed !== false && (m.inputBuses ?? []).length === 0) problems.push('it has no input bus you can put things into')
      return { m, order, problems, ...this.asksOf(m) }
    })
    const ready = judged.filter((j) => j.problems.length === 0)
    if (ready.length === 0) {
      if (untested.length > 0) return tryOn()
      const best = judged[0]!
      return { state: 'blocked', why: `the ${this.machineName(best.m)} at ${formatPos(best.m)} cannot run it now: ${best.problems.join(', ')}` }
    }
    // 不用问主人的、闲着的、近的在前
    ready.sort((a, b) => a.asks.length - b.asks.length || Number(a.m.active === true) - Number(b.m.active === true) || a.order - b.order)
    const pick = ready[0]!
    return { state: 'now', machine: pick.m, ...(pick.bus ? { bus: pick.bus } : {}), asks: pick.asks, ...(powerUnread(pick.m) ? { unread: 'steam' as const } : {}) }
  }

  private machineName(m: MachineInfo): string {
    return nameOf(m) ?? 'machine'
  }

  /** 用这台机器之前要主人先点头的事，和（多方块）该往哪个输入总线放。 */
  private asksOf(m: MachineInfo): { asks: string[]; bus?: Pos } {
    const asks: string[] = []
    const where = `the ${this.machineName(m)} at ${formatPos(m)}`
    const pipes = (list: readonly AttachedBlock[]): string => list.map((a) => `${nameOf(a, { block: true }) ?? a.kind ?? 'pipe'} at ${formatPos(a)}`).join(', ')
    let bus: Pos | undefined
    if (m.kind === 'multiblock') {
      const buses: MachineHatch[] = m.inputBuses ?? []
      const own = buses.filter((b) => (b.attached ?? []).length === 0)
      if (buses.length > 0 && own.length === 0) {
        // 往里“放”和从箱子里“取”不是一回事：放进去的东西会和管道送来的混在一起
        asks.push(`PUTS your inputs INTO the input bus of ${where}, which ${pipes(buses.flatMap((b) => b.attached ?? []))} feeds automatically (your owner's automation). They can get mixed with what it brings in: the machine may use your items up on your owner's recipe, or the bus may be full`)
      } else if (own.length < buses.length || own.length > 1) {
        // 有接着管道的总线时点名用没接的那个（身体自己挑的是空格最多的，可能正好挑中自动喂料的）
        const pick = [...own].sort((a, b) => (b.slots ?? 0) - (b.usedSlots ?? 0) - ((a.slots ?? 0) - (a.usedSlots ?? 0)))[0]!
        bus = { x: pick.x, y: pick.y, z: pick.z }
      }
      const outs: MachineHatch[] = m.outputBuses ?? []
      const drained = outs.filter((b) => (b.attached ?? []).length > 0 && (b.passesTo ?? []).length === 0)
      if (outs.length > 0 && drained.length === outs.length) asks.push(`uses ${where}, whose output bus is drained by ${pipes(drained.flatMap((b) => b.attached ?? []))}: what you make may be carried away before you can take it`)
      if (/maintenance problem/i.test(m.idleReason ?? '')) asks.push(`uses ${where}, which reports "${m.idleReason}": it needs repairing by your owner`)
    } else {
      const attached = this.stock.flags.get(posKey(m))?.attached
      if (attached && attached.length > 0) asks.push(`PUTS your inputs INTO ${where}, which ${pipes(attached)} is attached to (your owner's automation). The pipe may bring in other things that get mixed with yours, or carry what you make away before you take it`)
    }
    return { asks, ...(bus ? { bus } : {}) }
  }

  /** 配方要的流体，机器的输入仓里现在够不够。单方块机器看不了：undefined。 */
  private fluidsIn(m: MachineInfo | undefined, fluids: readonly RecipeFluid[], rounds: number): { fluid: RecipeFluid; need: number; have: number | undefined }[] {
    return fluids.map((fluid) => {
      const need = fluid.mb * rounds
      if (!m || m.kind !== 'multiblock') return { fluid, need, have: undefined }
      const have = (m.inputHatches ?? []).filter((h) => h.fluid === fluid.f).reduce((n, h) => n + (h.amount ?? 0), 0)
      return { fluid, need, have }
    })
  }

  /** 做这样东西的每条做法（读一遍配方册，去掉回收的、重复的、有概率才出的）。 */
  private recipesFor(need: Need): Omit<Candidate, 'usable' | 'shortSlots' | 'blocked' | 'oddBlocked' | 'unsure' | 'stuck' | 'hopeless'>[] {
    const known = this.recipesMemo.get(need.key)
    if (known) return known
    // 几种物品都算数时（一个矿辞名下的各种工具）轮流各取一段：电动工具每种有几百条配方，别让它们把普通的那种挤出去
    const refs = new Set<number>()
    const lists = need.products.map((p) => this.book.makesOf(p.id, p.meta))
    for (let from = 0; refs.size < CANDIDATES_MAX && lists.some((list) => list.length > from); from += CANDIDATES_CHUNK) {
      for (const list of lists) {
        for (let n = from; n < Math.min(list.length, from + CANDIDATES_CHUNK) && refs.size < CANDIDATES_MAX; n++) refs.add(list[n]!)
      }
    }
    const out: Omit<Candidate, 'usable' | 'shortSlots' | 'blocked' | 'oddBlocked' | 'unsure' | 'stuck' | 'hopeless'>[] = []
    const seen = new Set<string>()
    const wanted = new Set(need.products.map(refKey))
    for (const ref of [...refs].sort((a, b) => a - b)) {
      // 回收（把成品拆回材料）不是做东西的办法：这几页有好几万条，不用读
      if (/recycling/i.test(this.book.handlerOfRecipe(ref)?.key ?? '')) continue
      const recipe = this.book.get(ref)
      if (!recipe) continue
      const sig = signature(recipe)
      if (seen.has(sig)) continue
      seen.add(sig)
      // 有概率才出的不算数
      const made = recipe.out.reduce((n, o) => (o.chance === undefined && wanted.has(`${o.id}/${o.meta}`) ? n + o.n : n), 0)
      if (made <= 0) continue
      const merged = mergedSlots(recipe.in)
      const circuit = merged.map(circuitOf).find((c) => c !== undefined)
      const slots = merged.filter((s) => circuitOf(s) === undefined)
      const kind = wayKind(recipe.handler)
      const consumed = slots.filter((s) => s.n > 0 && !isTool(s))
      out.push({ recipe, kind, powered: consumed.some((s) => this.isBattery(s)), yield: made, slots, ...(circuit !== undefined ? { circuit } : {}), handTool: kind === 'craft' && slots.some(isTool), cost: consumed.reduce((n, s) => n + s.n, 0) / made })
    }
    this.recipesMemo.set(need.key, out)
    return out
  }

  private isBattery(slot: RecipeSlot): boolean {
    const battery = (ores: readonly string[] | undefined): boolean => ores?.some((o) => /^battery[A-Z]/.test(o)) === true
    if (slot.kind === 'ore') return battery([slot.ore])
    if (slot.kind === 'item') return battery(this.items?.get(slot.id, slot.meta)?.ores)
    return slot.any.some(([id, meta]) => battery(this.items?.get(id, meta)?.ores))
  }

  /** 做这样东西的每条做法，各自现在做不做得了。ancestors：它上面的东西（用它们当原料的做法是绕圈子：锭磨成粉、粉再炼回锭）。 */
  private candidates(need: Need, ancestors: ReadonlySet<string>): Candidate[] {
    const out: Candidate[] = []
    // 已经算是“有了它”的那几种物品
    const own = new Set(need.products.map(refKey))
    for (const base of this.recipesFor(need)) {
      const machine = base.kind === 'machine'
      // 要一把工具时不做电动的（要电池的）：做最简单的那种就够用
      if (need.tool && base.powered) continue
      // 原料里就有“已经算是它”的东西（剪线钳（LV）是拿一把普通剪线钳加马达、电池做的）：那是升级，不是做法
      if (base.slots.some((s) => s.kind === 'item' && own.has(`${s.id}/${s.meta}`))) continue
      if (base.slots.some((s) => ancestors.has(this.needOf(s, machine).material))) continue
      out.push({ ...base, usable: this.usable(base.recipe), shortSlots: [], blocked: 0, oddBlocked: 0, unsure: 0, stuck: [], hopeless: false })
    }
    return out
  }

  /**
   * 料凑不齐的一条做法，值不值得顺着往下找“到底缺的是哪样”：它的料里（或者再往下几层）有现成的东西，说明这条路是对的。
   * 一样现成的都没有的，就到此为止，缺的就是它本身。工具有没有不说明问题，不算。
   */
  private progress(c: Candidate, depth: number, above: ReadonlySet<string>): boolean {
    const machine = c.kind === 'machine'
    return c.slots.some((s) => {
      if (isTool(s)) return false
      const need = this.needOf(s, machine)
      if (this.spare(need) > 0) return true
      if (depth >= LOOKAHEAD_DEPTH) return false
      // 还能往下看几层，结论就不一样：按层数分开记
      const memoKey = `${depth}|${need.key}`
      const memo = this.progressMemo.get(memoKey)
      if (memo !== undefined) return memo
      const path = new Set([...above, need.material])
      const list = this.candidates(need, path).filter((x) => x.usable.state === 'now')
      this.lookaheadTotal += list.length
      // 做法一大堆的（每种材质一条）不算：总有一条沾得上边
      const ok = list.length <= FAMILY_SIZE && list.some((x) => this.progress(x, depth + 1, path))
      this.progressMemo.set(memoKey, ok)
      return ok
    })
  }

  /**
   * 一条料凑不齐的做法，缺的那几样里有没有“卡在机器上”的：有这种机器但现在不行（没电、电压炉温不够、结构不完整），
   * 或者做它只有这里没有的机器。有就说出来，主人好知道根子在哪。
   */
  private whyStuck(c: Candidate, above: ReadonlySet<string>): string {
    const out: string[] = []
    for (const slot of c.stuck.slice(0, 3)) {
      const need = this.needOf(slot, c.kind === 'machine')
      if (need.tool) continue
      const list = this.candidates(need, new Set([...above, need.material]))
      if (list.length === 0 || list.some((x) => x.usable.state === 'now')) continue
      out.push(`${need.short}: ${this.leafReason(need, this.rank(need, 1, list, above))}`)
    }
    return out.length > 0 ? `; ${out.join('; ')}` : ''
  }

  /** 基础材料（锭、粉、宝石）和工具：缺了它们就直接报缺，不再往下猜它们该用什么做。 */
  private basic(need: Need): boolean {
    if (need.tool) return true
    const slot = need.slot
    const ore = need.ore ?? (slot.kind === 'item' ? unifiedOre(this.items?.get(slot.id, slot.meta)) : undefined)
    return ore !== undefined && /^(ingot|dust|gem)[A-Z]/.test(ore)
  }

  /**
   * 粗表里这样东西还剩多少没被计划里别的地方占用（上一遍算出来的需求）。
   * 库存里唯一的那个模头已经要被合成掉了，就不能再指望拿它当模具去压别的东西。
   */
  private spare(need: Need): number {
    const node = this.nodes.get(need.key)
    return this.stock.broadCount(need) - (node ? node.consumed + (node.keep ? 1 : 0) : 0)
  }

  /** 配方的这一格手头不够（粗表）：消耗的看够不够这几轮用；模具、工具这类不消耗的有一个就行，计划里别处也在用它不碍事。 */
  private lacks(slot: RecipeSlot, machine: boolean, rounds: number): boolean {
    const need = this.needOf(slot, machine)
    if (slot.n === 0 || isTool(slot)) return this.stock.broadCount(need) - (this.nodes.get(need.key)?.consumed ?? 0) < 1
    return this.spare(need) < slot.n * rounds
  }

  /** 这格原料是什么材料的。 */
  private materialsOf(slot: RecipeSlot, machine: boolean): string[] {
    const need = this.needOf(slot, machine)
    const ores = need.ore !== undefined ? [need.ore] : slot.kind === 'item' ? this.items?.get(slot.id, slot.meta)?.ores : need.products.flatMap((p) => this.items?.get(p.id, p.meta)?.ores ?? [])
    return this.stock.materials.of(ores)
  }

  /** 这格原料的材料库存里有没有（任何形态）：有的排在前面细看。工具一般做得出来，也算。 */
  private familiar(slot: RecipeSlot, machine: boolean): boolean {
    if (isTool(slot)) return true
    return this.materialsOf(slot, machine).some((material) => this.stock.hasMaterial(material))
  }

  /** 这条做法主要用的那种材料（耗得最多的那格），库存里有多少件：别的都一样时用料多的那种材质（钢锭一大箱、黄铜十几个，锤子就用钢做）。 */
  private plenty(c: Candidate): number {
    let least = 1e9
    const most = Math.max(0, ...c.slots.filter((slot) => slot.n > 0 && !isTool(slot)).map((slot) => slot.n))
    for (const slot of c.slots) {
      if (slot.n < most || slot.n === 0 || isTool(slot)) continue
      const materials = this.materialsOf(slot, c.kind === 'machine')
      if (materials.length > 0) least = Math.min(least, Math.max(...materials.map((m) => this.stock.materialCount(m))))
    }
    return least
  }

  /** 多方块机器的配方要的流体，输入仓里现在不够（看得见的缺口：会报成缺的）。 */
  private fluidShort(c: Candidate, rounds: number): boolean {
    if (c.recipe.fin.length === 0 || c.usable.state !== 'now' || c.usable.machine?.kind !== 'multiblock') return false
    return !this.fluidsIn(c.usable.machine, c.recipe.fin, rounds).every((f) => f.have !== undefined && f.have >= f.need)
  }

  /** 单方块机器的流体配方：罐子里有什么它看不到，也灌不了，只能问主人接没接好。 */
  private blind(c: Candidate): boolean {
    return c.kind !== 'craft' && c.recipe.fin.length > 0 && c.usable.state === 'now' && c.usable.machine?.kind !== 'multiblock'
  }

  /**
   * 看不到的那罐流体有没有可能是对的：熔融金属（molten.xxx）看基地里有没有这种材料（任何形态）。
   * 连这种材料都没有的，就别指望罐子里正好有它——流体固化器什么材质都浇得出来，不这样分就会排出“用熔融钨钢浇一块板”这种计划。
   */
  private plausible(c: Candidate): boolean {
    return c.recipe.fin.every((f) => {
      const molten = /^molten\.(.+)$/.exec(f.f) ?? /^(.+)\.molten$/.exec(f.f)
      return !molten || this.stock.hasMaterialNamed(molten[1]!.toLowerCase())
    })
  }

  /**
   * 这样东西弄不弄得到。只用来在几条做法之间挑，不精确。
   *   2：粗表里有，或者有一条现在做得了、原料也都弄得到的做法；
   *   1：弄得到，但要靠单方块机器的流体配方（罐子里有没有那种流体看不到，要主人确认）；
   *   0：弄不到（包括：要的熔融金属，基地里连这种材料都没有）。
   * 分出 1 来是因为：有了流体固化器以后，每种材质的每样零件都“做得出来”，不分的话会挑中基地里根本没有的材质。
   */
  private canGet(need: Need, depth: number, above: ReadonlySet<string>): 0 | 1 | 2 {
    if (this.spare(need) > 0) return 2
    const memo = this.canGetMemo.get(need.key)
    if (memo !== undefined) return memo
    // 看得太深、这一次看得太多：当它弄不到（这种“没看完”的结论不记，见下）
    if (depth >= LOOKAHEAD_DEPTH || this.lookahead > LOOKAHEAD_BUDGET || this.lookaheadTotal > LOOKAHEAD_TOTAL) {
      this.cutShort++
      return 0
    }
    const cutBefore = this.cutShort
    const path = new Set([...above, need.material])
    const list = this.candidates(need, path).filter((c) => c.usable.state === 'now')
    this.lookahead += list.length
    this.lookaheadTotal += list.length
    const machine = (c: Candidate): boolean => c.kind === 'machine'
    const own = (c: Candidate): 0 | 1 | 2 => (!this.blind(c) ? 2 : this.plausible(c) ? 1 : 0)
    let best: 0 | 1 | 2 = 0
    // 先看有没有原料全在粗表里的（几百条每种材质一条的工具配方靠这一步）
    for (const c of list) {
      if (own(c) <= best || !c.slots.every((s) => this.spare(this.needOf(s, machine(c))) > 0)) continue
      best = own(c)
      if (best === 2) break
    }
    if (best < 2) {
      // 再往下看一层：材料库存里有的那些先看
      const order = [...list].sort((a, b) => Number(b.slots.every((s) => this.familiar(s, machine(b)))) - Number(a.slots.every((s) => this.familiar(s, machine(a)))))
      for (const c of order.slice(0, 30)) {
        let level = own(c)
        for (const s of c.slots) {
          if (level <= best) break
          level = Math.min(level, this.canGet(this.needOf(s, machine(c)), depth + 1, path)) as 0 | 1 | 2
        }
        if (level > best) best = level
        if (best === 2) break
      }
    }
    // 底下有没看完的（太深、太多）而得出的“弄不到”“没着落”不记：从浅一点的地方再看可能就看得到
    if (best === 2 || this.cutShort === cutBefore) this.canGetMemo.set(need.key, best)
    return best
  }

  /** 按规矩排好：排在最前面的现在做得了的那条就是要用的。 */
  private rank(need: Need, count: number, list: Candidate[], ancestors: ReadonlySet<string>): Candidate[] {
    const now = list.filter((c) => c.usable.state === 'now')
    const path = new Set([...ancestors, need.material])
    for (const c of now) {
      const rounds = Math.ceil(count / c.yield)
      const machine = c.kind === 'machine'
      c.shortSlots = c.slots.filter((s) => this.lacks(s, machine, rounds))
      // 先当作缺的都弄不到；下面细看过的再改
      c.stuck = c.shortSlots
      c.unsure = 0
      c.blocked = c.shortSlots.length
      c.oddBlocked = c.shortSlots.filter((s) => !this.basic(this.needOf(s, machine))).length
    }
    // 缺的原料弄不弄得到：缺得少的、材料库存里有的先看，看够数就停（工具每种材质一条，有几百上千条）
    const familiar = (c: Candidate): number => (c.shortSlots.every((s) => this.familiar(s, c.kind === 'machine')) ? 0 : 1)
    const worth = now.filter((c) => c.shortSlots.length > 0).sort((a, b) => familiar(a) - familiar(b) || a.shortSlots.length - b.shortSlots.length || a.cost - b.cost)
    // 同一样原料（几条做法都要的那个模头）在这一次比较里只判一次：往下看有深度和数量的上限，分开判可能一条说弄得到、一条说弄不到
    const judged = new Map<string, 0 | 1 | 2>()
    const reachOf = (need: Need): 0 | 1 | 2 => {
      let level = judged.get(need.key)
      if (level === undefined) judged.set(need.key, (level = this.canGet(need, 1, path)))
      return level
    }
    for (const c of worth.slice(0, LOOKAHEAD_CANDIDATES)) {
      const reach = c.shortSlots.map((s) => reachOf(this.needOf(s, c.kind === 'machine')))
      c.stuck = c.shortSlots.filter((_, n) => reach[n] === 0)
      c.unsure = reach.filter((r) => r === 1).length
      c.blocked = c.stuck.length
      c.oddBlocked = c.stuck.filter((s) => !this.basic(this.needOf(s, c.kind === 'machine'))).length
    }
    // 料凑不齐的做法，料里有现成的（路是对的，只差其中几样）才值得顺着往下找到底缺哪样
    for (const c of now) c.hopeless = c.blocked > 0 && !this.progress(c, 1, path)
    // 还不能直接用的做法，排在不用另作准备的后面：
    //   - 机器要的模具、模头手头没有（得先另做一个）：差一个模具时，玩家会先用手边的办法，而不是为它去做一整套模具；
    //   - 单方块机器要流体的配方（罐子里有没有看不到，得主人确认）；或者缺的原料只有靠这种配方才弄得到。
    const setup = new Map(now.map((c) => [c, c.unsure > 0 || this.blind(c) || (c.kind !== 'craft' && c.slots.some((s) => s.n === 0 && this.lacks(s, c.kind === 'machine', 1))) ? 1 : 0]))
    // 身体读不到状态的机器（别的 mod 的、熔炉）：能试，但排在读得到、确实做得了的做法后面
    const untried = (c: Candidate): number => (c.usable.state === 'now' && c.usable.unread === 'unknown' ? 1 : 0)
    // 要的熔融金属，基地里连这种材料都没有：排在最后（只有它这一条路时才用，照样要问主人）
    const implausible = (c: Candidate): number => (this.blind(c) && !this.plausible(c) ? 1 : 0)
    const fluidShort = (c: Candidate): number => (this.fluidShort(c, Math.ceil(count / c.yield)) ? 1 : 0)
    // 手工工具配方只在没有机器做得了时用：机器那条路走得通（原料有，或者做得出来）、又不用另作准备，才算“机器做得了”
    const machineWorks = now.some((c) => c.kind === 'machine' && c.blocked === 0 && setup.get(c) === 0 && untried(c) === 0)
    // 目标只是一堆产物里的一样（电解、离心拆出来的）：不当正经做法
    const byproduct = (c: Candidate): number => (c.recipe.out.filter((o) => o.chance === undefined).length > 1 && !need.products.some((p) => p.id === c.recipe.out[0]!.id && p.meta === c.recipe.out[0]!.meta) ? 1 : 0)
    const asks = (c: Candidate): number => (c.usable.state === 'now' ? c.usable.asks.length : 0)
    // 只有一样原料、不用工具的手工配方是“换个形状”（大小粉互换、导线合股、两个 mod 的同一种零件互换）：料凑不齐时不顺着它往下找
    const repack = (c: Candidate): number => (c.kind === 'craft' && c.slots.length === 1 ? 1 : 0)
    const key = (c: Candidate): number[] => [
      c.usable.state === 'now' ? 0 : 1,
      implausible(c),
      // 料凑得齐的在前；都凑不齐时，缺的是基础材料和工具的在前（报给主人的该是“缺 36 个钢锭”，不是“缺 8 个钢台阶”）
      c.blocked > 0 ? 1 : 0,
      c.handTool && machineWorks ? 1 : 0,
      setup.get(c) ?? 0,
      untried(c),
      c.hopeless ? 1 : 0,
      c.blocked > 0 ? repack(c) : 0,
      c.oddBlocked,
      c.blocked,
      c.shortSlots.length,
      fluidShort(c),
      byproduct(c),
      c.cost,
      c.kind === 'machine' ? 0 : 1,
      asks(c),
      -this.plenty(c),
      c.recipe.eut ?? 0,
      c.recipe.ticks ?? 0,
      c.recipe.ref,
    ]
    const keys = new Map(list.map((c) => [c, key(c)]))
    return [...list].sort((a, b) => {
      const ka = keys.get(a)!
      const kb = keys.get(b)!
      for (let n = 0; n < ka.length; n++) if (ka[n] !== kb[n]) return ka[n]! - kb[n]!
      return 0
    })
  }

  // 一条做法怎么说

  /** 每个成品耗什么（“1 玄钢锭”“0.33 磁钢粉 + 0.33 煤粉”），和要留着不消耗的东西。 */
  private costText(c: Candidate): string {
    const machine = c.kind === 'machine'
    const consumed = c.slots.filter((s) => s.n > 0 && !isTool(s)).map((s) => `${quantity(s.n / c.yield)} ${this.needOf(s, machine).short}`)
    const fluids = c.recipe.fin.map((f) => `${quantity(f.mb / c.yield)} mB ${f.name}`)
    const kept = c.slots.filter((s) => s.n === 0 || isTool(s)).map((s) => this.needOf(s, machine).short)
    return `${[...consumed, ...fluids].join(' + ') || 'nothing'} each${kept.length > 0 ? `, keeps ${kept.join(', ')}` : ''}`
  }

  private wayText(c: Candidate): string {
    return `${c.kind === 'craft' ? 'by hand' : c.recipe.handler.name} #${c.recipe.ref}`
  }

  /** 两条做法耗的是不是同样的几种料（是的话耗多少可以直接比）。 */
  private sameStuff(a: Candidate, b: Candidate): boolean {
    const stuff = (c: Candidate): string =>
      c.slots
        .filter((s) => s.n > 0 && !isTool(s))
        .map((s) => this.needOf(s, c.kind === 'machine').material)
        .sort()
        .join('|')
    return stuff(a) === stuff(b)
  }

  // 展开

  private ancestorsOf(node: PlanNode): Set<string> {
    const out = new Set<string>([node.need.material])
    const walk = (n: PlanNode): void => {
      for (const key of n.parents) {
        const parent = this.nodes.get(key)
        if (!parent || out.has(parent.need.material)) continue
        out.add(parent.need.material)
        walk(parent)
      }
    }
    walk(node)
    return out
  }

  private expand(node: PlanNode, count: number): void {
    node.expanded = true
    if (node.depth >= PLAN_MAX_DEPTH || this.nodes.size >= PLAN_MAX_NODES) {
      this.cutOff = true
      node.leaf = 'the plan was not worked out further down here (it reached its size limit): look at this one yourself with find_recipes'
      return
    }
    const ancestors = this.ancestorsOf(node)
    this.lookahead = 0
    const all = this.candidates(node.need, ancestors)
    const ranked = this.rank(node.need, count, all, ancestors)
    const pick = ranked[0]
    if (!pick || pick.usable.state !== 'now') {
      node.leaf = this.leafReason(node.need, ranked)
      return
    }
    // 现在做得了、可它的料哪条路都凑不齐：
    //   - 工具，或者做法有一大堆（每种材质一条）的：不替主人挑材质，把它本身报成缺的；
    //   - 它的料里一样现成的都没有（往下几层也没有）：到此为止，缺的就是它；
    //   - 别的接着往下展开，好找到到底缺的是哪几样。目标本身总要展开一层。
    if (pick.blocked > 0 && !node.root) {
      const ways = ranked.filter((c) => c.usable.state === 'now').length
      const eg = `${this.wayText(pick)}, ${this.costText(pick)}`
      if (node.need.tool || ways > FAMILY_SIZE) {
        node.leaf = `there is nothing at hand to make one from (${ways} recipe(s) would do, for instance ${eg})`
        return
      }
      if (pick.hopeless) {
        node.leaf = `nothing it is made from is here either (it would be made ${eg}${this.whyStuck(pick, ancestors)})`
        return
      }
    }
    node.choice = pick
    const others = ranked.slice(1)
    // 真能用的别的做法：现在做得了、原料也弄得到的。每种方式提一条，最多两条
    const real = others.filter((c) => c.usable.state === 'now' && c.blocked === 0 && c.unsure === 0)
    // 别的 mod 的机器这里根本没有的，不算“省料的做法现在用不上”：主人没建那种机器，不值得为它去问
    const notUsable = others.filter((c) => (c.usable.state === 'absent' && c.kind !== 'device') || c.usable.state === 'blocked')
    node.why = `${this.wayText(pick)}, ${this.costText(pick)}`
    node.others = []
    const ways = new Set<string>([pick.recipe.handler.key])
    for (const c of real) {
      if (node.others.length >= 2) break
      if (ways.has(c.recipe.handler.key)) continue
      ways.add(c.recipe.handler.key)
      node.others.push(`${this.wayText(c)}, ${this.costText(c)}${c.handTool && pick.kind === 'machine' ? ' (hand tools: only when no machine can do it)' : ''}`)
    }
    // 同一种方式下别的配方：只有两三条时提一条；几十上百条的（每种材质一条）只说个数
    const sameWay = real.filter((c) => c.recipe.handler.key === pick.recipe.handler.key)
    if (sameWay.length > 0 && sameWay.length <= 3) node.others.push(`${this.wayText(sameWay[0]!)}, ${this.costText(sameWay[0]!)}`)
    else if (sameWay.length > 3) node.others.push(`${sameWay.length} more ${pick.kind === 'craft' ? 'hand' : pick.recipe.handler.name} recipes from other materials`)
    // 要主人拿主意的：机器接着管道、有维护问题；省料得多的做法现在用不上
    node.asks = [...pick.usable.asks]
    // 省料的做法要先另做东西（模具）才用得上：省下的料总共没几个时不值得为它去问主人
    const cheaperHere = real.find((c) => this.sameStuff(c, pick) && pick.cost >= c.cost * MUCH_MORE && (pick.cost - c.cost) * count >= WORTH_ASKING)
    const cheaperElsewhere = notUsable.find((c) => this.sameStuff(c, pick) && pick.cost >= c.cost * MUCH_MORE)
    if (cheaperElsewhere && cheaperElsewhere.usable.state !== 'now' && cheaperElsewhere.usable.state !== 'cannot') {
      node.asks.push(`makes the ${node.need.short} ${this.wayText(pick)} at ${this.costText(pick)}; ${this.wayText(cheaperElsewhere)} would take ${this.costText(cheaperElsewhere)}, but ${cheaperElsewhere.usable.why}. Ask your owner which they want`)
    } else if (cheaperHere) {
      node.asks.push(`makes the ${node.need.short} ${this.wayText(pick)} at ${this.costText(pick)}, with what is at hand; ${this.wayText(cheaperHere)} would take ${this.costText(cheaperHere)}, but more has to be made for it first. Ask your owner which they want`)
    }
    const machine = pick.kind === 'machine'
    for (const slot of pick.slots) {
      const need = this.needOf(slot, machine)
      let child = this.nodes.get(need.key)
      if (!child) {
        child = { need, root: false, depth: node.depth + 1, parents: new Set(), consumed: 0, keep: false, takes: [], expanded: false, children: [], rounds: 0, short: 0 }
        this.nodes.set(need.key, child)
      }
      child.parents.add(node.need.key)
      node.children.push({ key: need.key, n: slot.n, keep: slot.n === 0 || isTool(slot) })
    }
  }

  /** 这样东西做不了的原因（英文，给模型转告主人）。 */
  private leafReason(need: Need, ranked: readonly Candidate[]): string {
    if (ranked.length === 0) {
      const made = need.products.some((p) => this.book.makesOf(p.id, p.meta).length > 0)
      return made
        ? 'the only recipes for it start from things that are made out of it, or take other finished things apart'
        : 'nothing in the recipe book makes it (a raw material: it has to be mined, bought or found)'
    }
    const blocked = ranked.find((c) => c.usable.state === 'blocked')
    if (blocked && blocked.usable.state === 'blocked') return `to make it (${blocked.recipe.handler.name} #${blocked.recipe.ref}), ${blocked.usable.why}`
    const absent = ranked.filter((c) => c.usable.state === 'absent')
    if (absent.length > 0) {
      const lacks = [...new Set(absent.map((c) => (c.usable.state === 'absent' ? (c.usable.lacks ?? '') : '')))].filter(Boolean).slice(0, 3)
      return `it cannot be made here: that takes ${lacks.join(' or ')}, and there is none nearby`
    }
    const ways = [...new Set(ranked.map((c) => `"${c.recipe.handler.name}"`))].slice(0, 3)
    return `it is only made by ${ways.join(', ')}, which you cannot run yourself`
  }

  /** 不从机器里借这样东西的话，它怎么来（给主人拿主意用的一句话）。 */
  private withoutBorrowing(node: PlanNode): string {
    const ancestors = this.ancestorsOf(node)
    this.lookahead = 0
    const ranked = this.rank(node.need, 1, this.candidates(node.need, ancestors), ancestors)
    const pick = ranked[0]
    if (pick && pick.usable.state === 'now') return `it would then be made ${this.wayText(pick)}, ${this.costText(pick)}`
    return `there is no other way to get one here: ${this.leafReason(node.need, ranked)}`
  }

  // 数量

  /** 从目标往下，把每样东西要多少、取多少、做几轮算一遍。返回还没展开、又不够的东西。 */
  private propagate(root: PlanNode, count: number): PlanNode[] {
    this.stock.release()
    for (const node of this.nodes.values()) {
      node.consumed = 0
      node.keep = false
      node.takes = []
      node.rounds = 0
      node.short = 0
    }
    root.consumed = count
    const pending: PlanNode[] = []
    for (const node of this.order(root)) {
      let left = node.consumed + (node.keep && !this.keptThenUsedUp(node) ? 1 : 0)
      if (left === 0) continue
      if (!node.root) {
        for (const h of this.stock.holdings(node.need)) {
          if (left === 0) break
          const take = Math.min(left, this.stock.free(h))
          if (take <= 0) continue
          this.stock.reserve(h, take)
          node.takes.push({ id: h.id, meta: h.meta, count: take, ...(h.at ? { at: h.at } : {}), ...(h.container ? { container: h.container } : {}), ...(h.automated ? { automated: h.automated } : {}), ...(h.lent ? { lent: true } : {}) })
          left -= take
        }
      }
      if (left === 0) continue
      if (!node.expanded) {
        node.short = left
        pending.push(node)
      } else if (node.choice) {
        node.rounds = Math.ceil(left / node.choice.yield)
        for (const child of node.children) {
          const c = this.nodes.get(child.key)!
          if (child.keep) c.keep = true
          else c.consumed += child.n * node.rounds
        }
      } else {
        node.short = left
      }
    }
    return pending
  }

  /**
   * 这样东西既有人拿它当模具、工具（不消耗），又有人把它当原料消耗掉：如果当模具用的那些步骤全都排在消耗它的步骤之前
   * （它们是消耗它的那样东西的下游原料），同一个就够了，先用后耗。
   */
  private keptThenUsedUp(node: PlanNode): boolean {
    if (node.consumed === 0) return false
    const users = [...node.parents].map((key) => this.nodes.get(key)!).filter((p) => p.rounds > 0)
    const eats = users.filter((p) => p.children.some((c) => c.key === node.need.key && !c.keep))
    const keeps = users.filter((p) => p.children.some((c) => c.key === node.need.key && c.keep) && !eats.includes(p))
    if (eats.length === 0) return false
    const below = (from: PlanNode, target: PlanNode, seen = new Set<string>()): boolean => {
      if (from === target) return true
      if (seen.has(from.need.key)) return false
      seen.add(from.need.key)
      return from.rounds > 0 && from.children.some((c) => below(this.nodes.get(c.key)!, target, seen))
    }
    return keeps.every((k) => eats.every((e) => below(e, k)))
  }

  /** 用到别人的排在别人前面（目标最前）。 */
  private order(root: PlanNode): PlanNode[] {
    const done = new Set<string>()
    const out: PlanNode[] = []
    const visit = (node: PlanNode): void => {
      if (done.has(node.need.key)) return
      done.add(node.need.key)
      for (const child of node.children) visit(this.nodes.get(child.key)!)
      out.push(node)
    }
    visit(root)
    return out.reverse()
  }

  async run(target: Need, count: number): Promise<PlanNode> {
    const root: PlanNode = { need: target, root: true, depth: 0, parents: new Set(), consumed: count, keep: false, takes: [], expanded: false, children: [], rounds: 0, short: 0 }
    this.nodes.set(target.key, root)
    // 每一遍至少展开一样东西；东西的样数有上限，所以一定会停
    for (let pass = 0; pass < PLAN_MAX_NODES * 2; pass++) {
      await this.stock.ensure([...this.nodes.values()].filter((n) => !n.root).map((n) => n.need))
      const pending = this.propagate(root, count)
      if (pending.length === 0) break
      for (const node of pending) this.expand(node, node.short)
    }
    await this.stock.ensure([...this.nodes.values()].filter((n) => !n.root).map((n) => n.need))
    this.propagate(root, count)
    return root
  }

  // 排成计划

  build(root: PlanNode, count: number, freeSlots: number | undefined): { data: PlanData; carried: string[]; notes: string[] } {
    const nm = this.nm
    const steps: PlanStep[] = []
    const missing: PlanData['missing'] = []
    const decisions: string[] = []
    const carried: string[] = []
    const notes: string[] = []
    // 先用到的先取：从目标往下、原料在前的顺序走一遍
    const sequence: PlanNode[] = []
    const visited = new Set<string>()
    const walk = (node: PlanNode): void => {
      if (visited.has(node.need.key)) return
      visited.add(node.need.key)
      if (node.rounds > 0) for (const child of node.children) walk(this.nodes.get(child.key)!)
      sequence.push(node)
    }
    walk(root)

    // 取货：一个容器一步。机器里借的模具不在这里取：到要用的那一步之前再取（见下）
    const places = new Map<string, { at: Pos; container?: string; automated?: AttachedBlock[]; items: Map<string, { id: string; meta: number; count: number }> }>()
    let stacks = 0
    const fed: { n: number; what: string; where: string; by: string }[] = []
    for (const node of sequence) {
      for (const take of node.takes) {
        if (take.lent) continue
        if (!take.at) {
          carried.push(`${take.count}× ${nm.name(take.id, take.meta)}`)
          continue
        }
        let place = places.get(posKey(take.at))
        if (!place) places.set(posKey(take.at), (place = { at: take.at, ...(take.container ? { container: take.container } : {}), ...(take.automated ? { automated: take.automated } : {}), items: new Map() }))
        const key = `${take.id}/${take.meta}`
        const item = place.items.get(key)
        if (item) item.count += take.count
        else place.items.set(key, { id: take.id, meta: take.meta, count: take.count })
      }
    }
    const pipes = (list: readonly AttachedBlock[]): string => list.map((a) => `${nameOf(a, { block: true }) ?? a.kind ?? 'pipe'} at ${formatPos(a)}`).join(', ')
    for (const place of places.values()) {
      const items = [...place.items.values()]
      stacks += items.reduce((n, i) => n + Math.ceil(i.count / STACK), 0)
      const n = steps.length + 1
      const what = items.map((i) => `${i.count}× ${nm.name(i.id, i.meta)}`).join(', ')
      const box = nameOf({ name: place.container }) ?? 'container'
      const step: PlanStep = { n, tool: 'withdraw_items', input: { container: place.at, items }, text: `fetch ${what} from the ${box}` }
      if (place.automated) {
        step.ask = true
        fed.push({ n, what, where: `the ${box} at ${formatPos(place.at)}`, by: pipes(place.automated) })
      }
      steps.push(step)
    }
    // 从接着管道的容器里“取”：一处就说清是哪一步、取什么；好几处的并成一条（主人的抽屉常常整排接着管道）。
    // 取和放不是一回事：取走一些通常没事，顶多是靠这个容器供料的自动化少了这些料
    const TAKING = 'Taking things out is usually harmless: at worst the automation that draws on it runs short of them'
    if (fed.length === 1) decisions.push(`step ${fed[0]!.n} TAKES ${fed[0]!.what} OUT OF ${fed[0]!.where}, which ${fed[0]!.by} is attached to (your owner's automation). ${TAKING}`)
    else if (fed.length > 1) {
      const listed = fed.slice(0, 4).map((f) => `${f.where} (step ${f.n})`)
      decisions.push(`steps ${fed.map((f) => f.n).join(', ')} TAKE things OUT OF containers that pipes or hoppers are attached to (your owner's automation): ${listed.join(', ')}${fed.length > 4 ? `, and ${fed.length - 4} more` : ''}. ${TAKING}`)
    }

    // 机器原料格里的东西，一步步排下来会变：借出来的、挪开的就不在里面了
    const insideNow = new Map([...this.inside].map(([key, list]) => [key, list.map((x) => ({ ...x }))]))
    /** 从机器里取出来、最后要放回去的（被计划用掉的不在这里）。 */
    const toReturn: { at: Pos; machine: string; id: string; meta: number; count: number; step: number; waitsFor: string[] }[] = []
    const fetchedLent = new Set<string>()
    const BACK = (at: Pos): string => `\u0000back:${posKey(at)}\u0000`
    /** 排一步“从这台机器的原料格里取出来”，并记下机器里少了它。 */
    const takeOut = (m: MachineInfo, items: { id: string; meta: number; count: number }[], waitsFor: string[]): number => {
      const n = steps.length + 1
      const what = items.map((i) => `${i.count}× ${nm.name(i.id, i.meta)}`).join(', ')
      steps.push({ n, tool: 'withdraw_items', input: { container: { x: m.x, y: m.y, z: m.z }, items, fromInputs: true }, text: `take ${what} out of the input slots of the ${this.machineName(m)}`, ask: true, ...(waitsFor.length > 0 ? { waitsFor } : {}) })
      const left = (insideNow.get(posKey(m)) ?? []).map((x) => ({ ...x, count: x.count - (items.find((i) => i.id === x.id && i.meta === x.meta)?.count ?? 0) })).filter((x) => x.count > 0)
      insideNow.set(posKey(m), left)
      return n
    }
    /** 主人还该知道的：这台机器正在转、或者接着管道。 */
    const machineState = (m: MachineInfo): string => {
      const attached = this.stock.flags.get(posKey(m))?.attached
      return `${m.active === true ? '. The machine is running right now' : ''}${attached && attached.length > 0 ? `. ${pipes(attached)} feeds or drains that machine: its automation cannot use it while it is out` : ''}`
    }

    // 做：原料在前。顺带记下每样东西“等着哪些缺的”，缺的叶子进 missing
    const waits = new Map<string, string[]>()
    for (const node of sequence) {
      const waitsFor = node.rounds > 0 ? [...new Set(node.children.flatMap((ch) => waits.get(ch.key) ?? []))] : []
      waits.set(node.need.key, node.short > 0 ? [node.need.short] : waitsFor)
      if (node.short > 0) {
        const slot = node.need.slot
        const goesInto = [...node.parents].map((key) => this.nodes.get(key)!).filter((p) => !p.root && p.rounds > 0).map((p) => p.need.short)
        missing.push({
          name: node.need.label,
          ...(node.need.ore !== undefined ? { ore: node.need.ore } : slot.kind === 'item' ? { id: slot.id, ...(slot.meta === ANY_META ? {} : { meta: slot.meta }) } : {}),
          count: node.short,
          ...(goesInto.length > 0 ? { for: goesInto } : {}),
          reason: `not in storage here, and ${node.leaf ?? 'no way to make it was found'}`,
        })
      }
      const c = node.choice
      if (!c || node.rounds === 0 || c.usable.state !== 'now') continue
      const product = c.recipe.out.find((o) => node.need.products.some((p) => p.id === o.id && p.meta === o.meta)) ?? node.need.products[0]!
      const made = nm.name(product.id, product.meta)
      const why = [`why: ${node.why}`, ...(node.others && node.others.length > 0 ? [`other ways: ${node.others.join('; ')}`] : [])].join('. ')
      const m = c.kind !== 'craft' ? c.usable.machine! : undefined
      const single = m && m.kind !== 'multiblock' ? m : undefined

      // 这一步要用、却还在别的机器原料格里的模具：现在取出来。就在这台机器里的不用取，原地用
      const inPlace = new Set<string>()
      for (const child of node.children) {
        const part = this.nodes.get(child.key)!
        const lent = part.takes.filter((t) => t.lent && t.at)
        if (lent.length === 0 || fetchedLent.has(child.key)) continue
        if (single && child.keep && lent.every((t) => posKey(t.at!) === posKey(single))) {
          inPlace.add(child.key)
          continue
        }
        fetchedLent.add(child.key)
        // 借来的那个用完还在不在：这样东西在计划里只当模具用（不消耗）的那一个放得回去，被消耗掉的放不回去
        let comesBack = part.keep && !this.keptThenUsedUp(part) ? 1 : 0
        for (const take of lent) {
          const from = this.around.machines.find((x) => posKey(x) === posKey(take.at!))
          if (!from) continue
          const n = takeOut(from, [{ id: take.id, meta: take.meta, count: take.count }], waitsFor)
          const back = Math.min(take.count, comesBack)
          comesBack -= back
          const what = `${take.count}× ${nm.name(take.id, take.meta)}`
          const where = `the input slots of the ${this.machineName(from)} at ${formatPos(from)}`
          const otherwise = `If your owner says no, call plan_item again with "borrow": false (${this.withoutBorrowing(part)})`
          if (back > 0) toReturn.push({ at: take.at!, machine: this.machineName(from), id: take.id, meta: take.meta, count: back, step: n, waitsFor })
          if (back === take.count) decisions.push(`step ${n} BORROWS ${what} from ${where}: it is your owner's, kept there for that machine. Step ${BACK(take.at!)} puts it back${machineState(from)}. ${otherwise}`)
          else decisions.push(`step ${n} TAKES ${what} OUT OF ${where}, and this plan USES IT UP (it goes into the ${node.need.short}): it does not come back, so that machine is left without it${machineState(from)}. ${otherwise}`)
        }
      }
      // 这台机器的原料格放不放得下这一步的原料：被别的模具、没用完的料占着时，先把占位的取出来，最后放回去
      if (single && typeof single.inputSlots === 'number') {
        const here = insideNow.get(posKey(single)) ?? []
        const accepts = (slot: RecipeSlot, x: Inside): boolean => this.stock.fits(this.needOf(slot, true), x.id, x.meta)
        const putting = c.slots.filter((slot) => !inPlace.has(this.needOf(slot, true).key))
        // 和里面已有的是同一种东西的，叠在同一格里，不另占一格
        const fresh = putting.filter((slot) => !here.some((x) => accepts(slot, x))).length
        const over = here.length + fresh - single.inputSlots
        const movable = here.filter((x) => !c.slots.some((slot) => accepts(slot, x))).sort((a, b) => Number(a.role !== 'shape') - Number(b.role !== 'shape'))
        if (over > 0 && movable.length >= over) {
          const moving = movable.slice(0, over).map((x) => ({ id: x.id, meta: x.meta, count: x.count }))
          const n = takeOut(single, moving, waitsFor)
          for (const x of moving) toReturn.push({ at: { x: single.x, y: single.y, z: single.z }, machine: this.machineName(single), ...x, step: n, waitsFor })
          decisions.push(
            `step ${n} TAKES ${moving.map((x) => `${x.count}× ${nm.name(x.id, x.meta)}`).join(', ')} OUT OF the input slots of the ${this.machineName(single)} at ${formatPos(single)} to make room: it has ${single.inputSlots} input slot(s), ${here.length} taken, and step ${n + 1} puts ${fresh} more kind(s) of thing in. It is your owner's, kept there for that machine; step ${BACK(single)} puts it back${machineState(single)}`,
          )
        }
      }

      const first = steps.length + 1
      if (c.kind === 'craft') {
        const perRound = c.recipe.out[0]?.n ?? 1
        for (let left = node.rounds; left > 0; left -= ROUNDS_PER_STEP) {
          const rounds = Math.min(left, ROUNDS_PER_STEP)
          const where = c.usable.pocket ? 'in your own 2x2 grid' : 'at the nearest crafting table'
          steps.push({ n: steps.length + 1, tool: 'craft_item', input: { recipe: c.recipe.ref, count: rounds * perRound }, text: `craft ${rounds * c.yield}× ${made} by hand ${where}`, ...(waitsFor.length > 0 ? { waitsFor } : {}) })
        }
      } else {
        const m = c.usable.machine!
        const most = Math.max(1, ...c.slots.filter((s) => s.n > 0).map((s) => s.n))
        const perStep = Math.max(1, Math.min(ROUNDS_PER_STEP, Math.floor(STACK / most)))
        const usedInPlace = c.slots.filter((slot) => inPlace.has(this.needOf(slot, true).key)).map((slot) => this.needOf(slot, true).short)
        for (let left = node.rounds; left > 0; left -= perStep) {
          const rounds = Math.min(left, perStep)
          const seconds = c.recipe.ticks !== undefined ? (c.recipe.ticks * rounds) / 20 : 0
          const input: Record<string, unknown> = { machine: { x: m.x, y: m.y, z: m.z }, recipe: c.recipe.ref, rounds }
          if (c.usable.bus) input.bus = c.usable.bus
          // 模具就在这台机器里：不用带、不用放
          if (usedInPlace.length > 0) input.moldInside = true
          // 估出来比默认等的时间长：把 wait 写上（机器等级高会更快，这是上限）
          if (seconds > DEFAULT_WAIT_SEC - 30) input.wait = Math.min(3600, Math.ceil(seconds * 1.2) + 30)
          const circuit = c.circuit !== undefined ? `; programmed circuit ${c.circuit} is set for you` : ''
          const mold = usedInPlace.length > 0 ? `; the ${usedInPlace.join(', ')} already in that machine is used where it is` : ''
          // 身体读不全状态的机器：照样排进去，写明这一步是“试”
          const unread =
            c.usable.unread === 'unknown'
              ? `; UNTESTED MACHINE: ${UNREAD_NOTE}`
              : c.usable.unread === 'steam'
                ? '; steam-powered: whether it has steam, and whether the recipe is within its pressure, cannot be read — if it does not start, that is the first thing to check'
                : ''
          steps.push({ n: steps.length + 1, tool: 'process_items', input, text: `make ${rounds * c.yield}× ${made} on the ${this.machineName(m)}${circuit}${mold}${unread}`, ...(waitsFor.length > 0 ? { waitsFor } : {}), ...(c.usable.unread ? { untested: true } : {}) })
        }
        // 配方要的流体：多方块看输入仓里够不够，单方块看不了
        for (const f of this.fluidsIn(m, c.recipe.fin, node.rounds)) {
          if (f.have === undefined) {
            decisions.push(`step ${first} needs ${quantity(f.need)} mB ${f.fluid.name} inside the ${this.machineName(m)} at ${formatPos(m)}: you cannot see or fill a single-block machine's tank, so ask your owner whether it is piped in`)
            steps[first - 1]!.ask = true
          } else if (f.have < f.need) {
            const what = `${f.fluid.name} (fluid)`
            missing.push({ name: what, fluid: f.fluid.f, count: f.need - f.have, reason: `step ${first} needs ${quantity(f.need)} mB in the input hatch of the ${this.machineName(m)} at ${formatPos(m)} and it holds ${quantity(f.have)} mB: have it piped in, or carry full cells and give them with "fluids"` })
            for (let n = first; n <= steps.length; n++) steps[n - 1]!.waitsFor = [...new Set([...(steps[n - 1]!.waitsFor ?? []), what])]
            // 用到这样东西的后面几步也跟着等
            waits.set(node.need.key, [...new Set([...(waits.get(node.need.key) ?? []), what])])
          }
        }
      }
      steps[first - 1]!.why = why
      for (const ask of node.asks ?? []) {
        decisions.push(`step ${first} ${ask}`)
        steps[first - 1]!.ask = true
      }
    }

    // 从机器里取出来的，最后放回原处：一台机器一步
    const backStep = new Map<string, number>()
    for (const r of toReturn) {
      const key = posKey(r.at)
      if (backStep.has(key)) continue
      const mine = toReturn.filter((x) => posKey(x.at) === key)
      const merged = new Map<string, { id: string; meta: number; count: number }>()
      for (const x of mine) {
        const seen = merged.get(`${x.id}/${x.meta}`)
        if (seen) seen.count += x.count
        else merged.set(`${x.id}/${x.meta}`, { id: x.id, meta: x.meta, count: x.count })
      }
      const items = [...merged.values()]
      const n = steps.length + 1
      const waitsFor = [...new Set(mine.flatMap((x) => x.waitsFor))]
      backStep.set(key, n)
      steps.push({
        n,
        tool: 'deposit_items',
        input: { container: r.at, items },
        text: `put ${items.map((i) => `${i.count}× ${nm.name(i.id, i.meta)}`).join(', ')} back into the ${r.machine} (taken out at step ${[...new Set(mine.map((x) => x.step))].join(', ')})`,
        ...(waitsFor.length > 0 ? { waitsFor } : {}),
      })
    }
    // eslint-disable-next-line no-control-regex
    for (let n = 0; n < decisions.length; n++) decisions[n] = decisions[n]!.replace(/\u0000back:([^\u0000]*)\u0000/g, (_, key: string) => String(backStep.get(key) ?? '?'))

    // 多做出来的、身上已经有的、背包装不装得下
    const rootChoice = root.choice
    if (rootChoice && root.rounds * rootChoice.yield > count) notes.push(`One round makes ${quantity(rootChoice.yield)}, so you end up with ${root.rounds * rootChoice.yield}.`)
    if (freeSlots !== undefined && stacks > freeSlots) notes.push(`Fetching everything at once takes about ${stacks} inventory slots and you have ${freeSlots} free: do it a part at a time (make the sub-parts first), or empty your inventory.`)
    if (this.stock.scanCut) notes.push(`There are more than ${this.stock.scanned} containers around: not all of them were looked through when choosing materials.`)
    const target = root.need.slot.kind === 'item' ? { id: root.need.slot.id, meta: root.need.slot.meta } : { id: '?', meta: 0 }
    return {
      data: { target: { ...target, name: root.need.short, count }, feasible: missing.length === 0 && !this.cutOff, steps, missing, decisions, cutOff: this.cutOff },
      carried,
      notes,
    }
  }
}

// ── 工具入口 ──

export interface PlanInput {
  id: string
  meta?: number
  count?: number
  page?: number
  /** false：不从机器里借模具、模头，自己做。 */
  borrow?: boolean
}

function stepLine(s: PlanStep): string {
  const tags = [s.ask ? 'ASK FIRST' : '', s.waitsFor && s.waitsFor.length > 0 ? `WAITS FOR ${s.waitsFor.join(', ')}` : ''].filter(Boolean)
  const head = `${s.n}. ${s.tool} ${JSON.stringify(s.input)} — ${s.text}${tags.length > 0 ? ` [${tags.join('; ')}]` : ''}`
  return s.why ? `${head}\n   ${s.why}` : head
}

export async function planItemLocal(ctx: ToolContext, input: PlanInput): Promise<ToolResult | string> {
  const book = ctx.packdata?.recipes
  const items = ctx.packdata?.items
  if (!book) return fail('There is no recipe book on this brain, so nothing can be planned. Work it out step by step with find_recipes and find_in_storage.')
  const nm = namer(items)
  const id = input.id.trim()
  const meta = input.meta ?? 0
  const count = input.count ?? 1
  if (!nm.item(id, meta) && book.makesOf(id, meta).length === 0 && book.usesOf(id, meta).length === 0) {
    return fail(`No item ${itemKey({ id, meta })} is known. Get the exact id and meta with find_item (many GregTech items share one id and differ only in meta).`)
  }
  const label = nm.label(id, meta)

  // 现场：身上有什么、附近有哪些机器和合成台、仓库里有什么
  let inventory: InventoryItem[]
  let freeSlots: number | undefined
  let around: Surroundings
  let stock: Stock
  try {
    const status = await ctx.bridge.botStatus(ctx.botName)
    const me = await whereItStands(ctx)
    if (status.online === false || !me) return fail(`${ctx.botName} is not in the game world, so the storage and machines cannot be looked at. Nothing can be planned until it is online.`)
    inventory = status.inventory ?? []
    freeSlots = status.freeSlots
    around = await lookAround(ctx)
    if (around.error) return fail(`The machines and crafting tables around you could not be looked at (${around.error}), so nothing can be planned right now.`)
    // 把周围的容器扫一遍：库存的粗表，顺带照配方册认出身体不认识的机器（熔炉、别的 mod 的机器）
    const scanned = await scanContainers(ctx, me)
    around.others = otherMachines(scanned.containers, around.machines, book, items, me)
    stock = new Stock(ctx, items, inventory, me)
    stock.load(around.machines, around.others, scanned)
  } catch (e) {
    if (e instanceof BridgeError) return fail(`The game could not be asked what is in storage (${e.code}: ${e.message}), so nothing can be planned right now.`)
    throw e
  }

  const planner = new Planner(book, items, around, stock, { borrow: input.borrow !== false })
  // 目标：点名的那个物品；同一个材料件矿辞名下别的 id 的配方做出来的也算（高炉出的玄钢锭是另一个 id）
  const twins = nm.interchangeable(id, meta)?.others ?? []
  const target: Need = {
    ...planner.needOf({ kind: 'item', id, meta, n: 1 }, false),
    products: [{ id, meta }, ...twins.filter((t) => book.makesOf(t.id, t.meta).length > 0).map((t) => ({ id: t.id, meta: t.meta }))],
  }
  let root: PlanNode
  try {
    root = await planner.run(target, count)
  } catch (e) {
    if (e instanceof BridgeError) return fail(`The game could not be asked what is in storage (${e.code}: ${e.message}), so the plan could not be finished.`)
    throw e
  }
  const { data, carried, notes } = planner.build(root, count, freeSlots)
  data.target = { id, meta, name: nm.name(id, meta), count }
  // 目标本身库存里已经有的提一句（计划是“做”，不是“取”）
  let inStorage = ''
  try {
    await stock.ensure([target])
    const had = stock.holdings(target)
    const total = had.reduce((n, h) => n + h.count, 0)
    const first = had.find((h) => h.at !== undefined)
    if (total > 0) inStorage = `Note: ${total}× ${nm.name(id, meta)} already exist${first?.at ? ` (${first.count} in the container at ${formatPos(first.at)})` : ' in your inventory'}; this plan makes new ones.`
  } catch (e) {
    if (!(e instanceof BridgeError)) throw e
  }

  const lines: string[] = []
  const fetch = data.steps.filter((s) => s.tool === 'withdraw_items').length
  const putBack = data.steps.filter((s) => s.tool === 'deposit_items').length
  const pages = Math.max(1, Math.ceil(data.steps.length / PLAN_STEPS_PER_PAGE))
  const page = input.page ?? 1
  if (page > pages) return fail(`There is no page ${page}: the plan for ${count}× ${label} has ${data.steps.length} step(s), ${pages} page(s).`)
  const range = data.steps.length > PLAN_STEPS_PER_PAGE ? `steps ${(page - 1) * PLAN_STEPS_PER_PAGE + 1}–${Math.min(page * PLAN_STEPS_PER_PAGE, data.steps.length)} of ${data.steps.length} (page ${page} of ${pages})` : `${data.steps.length} step(s)`

  if (!root.choice) {
    // 目标自己就做不了
    lines.push(`Plan for ${count}× ${label}: it CANNOT be made here: ${root.leaf ?? 'no way to make it was found'}.`)
    if (inStorage) lines.push(inStorage)
    return { content: lines.join('\n'), data, keepWhole: true }
  }
  if (page === 1) {
    const verdict = data.feasible
      ? `everything needed is here. ${data.steps.length} step(s): ${fetch} to fetch, ${data.steps.length - fetch - putBack} to make${putBack > 0 ? `, ${putBack} to put back what was taken out of machines (do these too, even though the ${nm.name(id, meta)} is made by then)` : ''}.`
      : `it CANNOT be finished yet: ${data.missing.length} thing(s) are missing${data.cutOff ? ', and the plan was cut off at its size limit' : ''}.`
    lines.push(`Plan for ${count}× ${label}: ${verdict}${data.decisions.length > 0 ? ` ${data.decisions.length} thing(s) need your owner's word before you start.` : ''}`)
    if (data.missing.length > 0) {
      const hint = data.missing.some((m) => m.for) ? ' ("for the …" is what it goes into: being given that instead would do as well)' : ''
      lines.push(`MISSING — tell your owner exactly these (with their names as written here), not the things in between${hint}:`)
      for (const m of data.missing) lines.push(`- ${quantity(m.count)}${m.fluid !== undefined ? ' mB' : '×'} ${m.name}${m.for ? `, for the ${m.for.slice(0, 3).join(', ')}${m.for.length > 3 ? ' and more' : ''}` : ''}: ${m.reason}.`)
    }
    if (data.decisions.length > 0) {
      lines.push('ASK YOUR OWNER FIRST:')
      for (const d of data.decisions) lines.push(`- ${d}.`)
    }
    if (carried.length > 0) lines.push(`You already carry: ${carried.join(', ')}.`)
    if (inStorage) lines.push(inStorage)
    for (const note of notes) lines.push(note)
    const how = data.feasible
      ? 'Do them in this order, one tool call per step, with the arguments exactly as written; wait for each task to end before the next.'
      : 'Steps marked WAITS FOR cannot be done until the missing things are there; the others can be done now.'
    lines.push(`STEPS — ${range}. ${how}`)
  } else {
    lines.push(`Plan for ${count}× ${label} — ${range}:`)
  }
  for (const s of data.steps.slice((page - 1) * PLAN_STEPS_PER_PAGE, page * PLAN_STEPS_PER_PAGE)) lines.push(stepLine(s))
  if (page < pages) lines.push(`More steps follow: plan_item with the same arguments and page ${page + 1}.`)
  return { content: lines.join('\n'), data, keepWhole: true }
}
