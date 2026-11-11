// 把“做一样东西要用到的整棵树”走完并算数。纯计算：只读配方册和物品表，不碰身体。
//
// 路线怎么选不归这里管：每样东西用哪条配方（或者不做、要现成的），由调用的人给的选择函数说了算（Choose）。
// 选择函数可以是“只用点了名的那几条”、可以是查一张记好的表、也可以是照一份优先的做法挑——这里都一样走。
// 这里只定和“选哪条”无关的事：
//   - 什么算同一样东西：登记在材料件矿辞名下的物品（钢锭、钢板……）按矿辞名算一样，哪个 mod 的都行；
//     配方里写“任何 xxx”的一格按那个矿辞名；别的按 id/meta；流体按注册名。见 TreeThing.key。
//     两格写法不同、定下来却是同一条配方的同一样产物时（“铜箔”和“铜箔或退火铜箔”），并成一样，数量加在一起。
//   - 环：选定的配方要用到树上在它上面的东西（锭磨成粉、粉再炼回锭），这条配方不往下走，这样东西当原料，记下是哪条配方绕回去的。
//   - 不消耗的（模具、手工工具、配方里数量是 0 的）：整棵树只要一个。做不做它也问选择函数（asked.kept）。
//   - 数量：沿树乘下去，一轮出几个就按轮数往上取整；流体按 mB。有概率才出的产物不算数。
//   - 编程电路不算原料。
//   - 库存（可选，run 的 have）：一样东西现有的先用掉，只把缺的那部分往下算；现成的够了，它下面那一截就不用做。目标自己不扣。

import { ANY_META } from '../packdata/index.ts'
import type { Recipe, RecipeBook, RecipeFluid, RecipeHandler, RecipeSlot } from '../packdata/index.ts'
import type { ItemTable } from '../packdata/items.ts'
import { circuitOf, isTool, mergedSlots, unifiedOre } from './recipe-book.ts'

/** 一样东西最多看这么多种物品（一个矿辞名下登记的）、这么多条配方。 */
const MEMBERS_MAX = 80
const REFS_MAX = 3000
const REFS_CHUNK = 250
/** 整棵树最多展开这么多样要做的东西；到了就停，剩下的当原料并记下（cut）。 */
export const TREE_MAX_THINGS = 4000

export interface TreeThing<N = unknown> {
  /**
   * 这样东西是谁，在一本配方册里是稳定的（可以拿来当表的键）：
   * ore:<矿辞名>（材料件，或者“任何 xxx”）、<id>/<meta>、<id>/*（任何 meta）、any:<id/meta,…>（列出来的任一种）、fluid:<注册名>。
   */
  key: string
  /** 物品：配方里要它的那一格（叫名字用；点名要过的话是点名的那一格）。 */
  slot?: RecipeSlot
  fluid?: { f: string; name: string }
  /** 算作“就是它”的物品。 */
  members: { id: string; meta: number }[]
  /** 离目标几层（目标是 0）；走最短的那条路数。 */
  level: number
  /** 选择函数带回来的话（这条是照什么定的、为什么不做），原样留着。 */
  note?: N
  // ── 要做的 ──
  recipe?: Recipe
  /** 一轮出多少（物品按个，流体按 mB）。 */
  yield?: number
  /** 做出来的是哪一种物品（一个矿辞名下有好几种时，配方出的那一种）。 */
  made?: { id: string; meta: number }
  /** 它的配方要的东西。kept：不消耗的（整棵树只要一个）。 */
  inputs: { thing: TreeThing<N>; n: number; kept: boolean }[]
  // ── 没做的（原料）──
  /** 选定的配方要用到上面的东西（或者它自己）：哪条配方、要的是哪样。 */
  loop?: { recipe: Recipe; needs: TreeThing<N> }
  /** 选定的配方做不出它。 */
  unfit?: Recipe
  /** 到了上限，没再问。 */
  cut?: boolean
  // ── 数量 ──
  /** 一共要多少（物品按个，流体按 mB）。 */
  needed: number
  /** 其中拿现成的顶掉多少（没给库存时是 0）。要做的东西，轮数只算剩下的；原料，还缺的是剩下的。 */
  fromStock: number
  rounds: number
  /** 只作为“不消耗的”被要过（数量是 1）。 */
  keptOnly: boolean
}

/** 一样东西有哪些配方可选：给选择函数看的。读配方（get）要读文件，所以都是用到才算。 */
export interface Options {
  /** 做得出它的配方的编号，按配方册里的先后。 */
  refs(): readonly number[]
  /** 这条配方一轮出多少这样东西（有概率才出的不算）、出的是什么；出不了是 n: 0。 */
  yield(recipe: Recipe): { n: number; product?: string }
  /** 这条配方是不是拿这样东西自己当原料（充电、修理、升级、同一种东西互换）。 */
  feedsOnItself(recipe: Recipe): boolean
  /** 按配方册里的先后，第一条做得出它、又不拿它自己当原料的配方；accept 筛加工方式（哪一页）。 */
  first(accept?: (way: RecipeHandler) => boolean): Recipe | undefined
  /** 同 first，但给前 limit 条（看它是不是“只有一条、没得选”，或者把几种做法各摆一条出来）。 */
  recipes(limit: number, accept?: (way: RecipeHandler) => boolean): Recipe[]
  /** 做得出它的各种加工方式各有几条（不读文件）。 */
  ways(): Map<RecipeHandler, number>
}

/** 这一回是怎么问到它的。 */
export interface Asked {
  /** 它就是目标。 */
  target: boolean
  /** 到现在只作为“不消耗的”被要过（模具、工具）；以后被当原料要到时会再问一次。 */
  kept: boolean
}

/** 用哪条配方；不给 recipe 就是不做、要现成的。note 原样记在那样东西上。 */
export interface Choice<N = unknown> {
  recipe?: Recipe
  note?: N
}

export type Choose<N = unknown> = (thing: TreeThing<N>, options: Options, asked: Asked) => Choice<N>

export interface TreeResult<N = unknown> {
  target: TreeThing<N>
  /** 要做的，先做的在前（后面的行要用到的排前面）。 */
  made: TreeThing<N>[]
  /** 要现成的物品（消耗的），先被要到的在前。 */
  raw: TreeThing<N>[]
  /** 不消耗、整棵树只要一个、也没做的。 */
  kept: TreeThing<N>[]
  /** 要现成的流体。 */
  fluids: TreeThing<N>[]
  /** 用了现成的那些（要做的、原料、不消耗的都可能在里面），离目标近的在前。 */
  stocked: TreeThing<N>[]
  /** 到了上限没走完。 */
  cut: boolean
}

/**
 * 配方里的一格是“哪样东西”（TreeThing.key）：登记在材料件矿辞名下的物品按矿辞名算一样（哪个 mod 的都行），
 * “任何 xxx”按矿辞名，别的按 id/meta。
 */
export function thingKeyOfSlot(slot: RecipeSlot, items: ItemTable | undefined): string {
  if (slot.kind === 'item') {
    const ore = slot.meta === ANY_META ? undefined : unifiedOre(items?.get(slot.id, slot.meta))
    if (ore !== undefined) return `ore:${ore}`
    return slot.meta === ANY_META ? `${slot.id}/*` : `${slot.id}/${slot.meta}`
  }
  return slot.kind === 'ore' ? `ore:${slot.ore}` : `any:${slot.any.map((a) => a.join('/')).join(',')}`
}

export const thingKeyOfFluid = (fluid: string): string => `fluid:${fluid}`

/** 把成品拆回材料的那几页（电弧炉回收、研磨机回收……）。 */
export const isRecycling = (way: RecipeHandler | undefined): boolean => /recycling/i.test(way?.key ?? '')

/** 这条配方出的这样东西，合不合那一格原料的要求。 */
export function serves(slot: RecipeSlot, out: { id: string; meta: number }, items: ItemTable | undefined): boolean {
  if (slot.kind === 'item') {
    if (slot.id === out.id && (slot.meta === ANY_META || slot.meta === out.meta)) return true
    // 同一个材料件矿辞名下的另一个 id（EnderIO 的玄钢锭和 GregTech 的玄钢锭）
    const a = slot.meta === ANY_META ? undefined : unifiedOre(items?.get(slot.id, slot.meta))
    return a !== undefined && a === unifiedOre(items?.get(out.id, out.meta))
  }
  if (slot.any.some(([id, meta]) => id === out.id && (meta === ANY_META || meta === out.meta))) return true
  return slot.kind === 'ore' && items?.get(out.id, out.meta)?.ores?.includes(slot.ore) === true
}

export class MaterialTree<N = unknown> {
  private readonly book: RecipeBook | undefined
  private readonly items: ItemTable | undefined
  private readonly choose: Choose<N>
  private readonly things = new Map<string, TreeThing<N>>()
  /** 一条配方的一样产物已经算在哪样东西名下；后来定到同一条配方同一样产物上的东西并过去（alias）。 */
  private readonly producers = new Map<string, TreeThing<N>>()
  private readonly alias = new Map<TreeThing<N>, TreeThing<N>>()
  /** 见过的东西；值是上一次问它时它是不是“不消耗的”。 */
  private readonly visited = new Map<TreeThing<N>, boolean>()
  private madeCount = 0
  private cut = false

  /** book 可以没有（只有凿子那种自造的“配方”时）：那样 Options 里查不到任何配方。 */
  constructor(book: RecipeBook | undefined, items: ItemTable | undefined, choose: Choose<N>) {
    this.book = book
    this.items = items
    this.choose = choose
  }

  // ── 一样东西 ──

  private keyOfSlot(slot: RecipeSlot): string {
    return thingKeyOfSlot(slot, this.items)
  }

  private thingOfSlot(slot: RecipeSlot): TreeThing<N> {
    const key = this.keyOfSlot(slot)
    let thing = this.things.get(key)
    if (!thing) {
      const members =
        slot.kind === 'item'
          ? key.startsWith('ore:')
            ? this.membersOf(key.slice(4), [[slot.id, slot.meta]])
            : [{ id: slot.id, meta: slot.meta === ANY_META ? 0 : slot.meta }]
          : slot.kind === 'ore'
            ? this.membersOf(slot.ore, slot.any)
            : slot.any.slice(0, MEMBERS_MAX).map(([id, meta]) => ({ id, meta: meta === ANY_META ? 0 : meta }))
      thing = { key, slot, members, level: 0, inputs: [], needed: 0, fromStock: 0, rounds: 0, keptOnly: false }
      this.things.set(key, thing)
    } else if (thing.slot && thing.slot.kind !== 'item' && slot.kind === 'item') {
      // 同一样东西先被“任何 xxx”要过、现在被点名要：叫名字用点了名的那一种
      thing.slot = slot
    }
    return thing
  }

  private thingOfFluid(f: { f: string; name: string }): TreeThing<N> {
    const key = thingKeyOfFluid(f.f)
    let thing = this.things.get(key)
    if (!thing) {
      thing = { key, fluid: { f: f.f, name: f.name }, members: [], level: 0, inputs: [], needed: 0, fromStock: 0, rounds: 0, keptOnly: false }
      this.things.set(key, thing)
    }
    return thing
  }

  /** 一个矿辞名下的物品：配方里列出来的，加上物品表里登记的。 */
  private membersOf(ore: string, listed: readonly [string, number][]): { id: string; meta: number }[] {
    const out = new Map<string, { id: string; meta: number }>()
    for (const [id, meta] of listed) if (meta !== ANY_META) out.set(`${id}/${meta}`, { id, meta })
    for (const item of this.items?.withOre(ore) ?? []) if (item.meta !== ANY_META) out.set(`${item.id}/${item.meta}`, { id: item.id, meta: item.meta })
    return [...out.values()].slice(0, MEMBERS_MAX)
  }

  /** 并到别的东西上的，算那一样。 */
  private canon(thing: TreeThing<N>): TreeThing<N> {
    return this.alias.get(thing) ?? thing
  }

  // ── 一样东西有哪些配方 ──

  private refsOf(thing: TreeThing<N>): number[] {
    if (!this.book) return []
    if (thing.fluid) return [...this.book.makesFluid(thing.fluid.f)]
    const lists = thing.members.map((m) => this.book!.makesOf(m.id, m.meta))
    if (lists.length === 1) return lists[0]!.length > REFS_MAX ? lists[0]!.slice(0, REFS_MAX) : [...lists[0]!]
    // 几种物品都算数时轮流各取一段：电动工具每种有几百条配方，别让它们把普通的那种挤出去
    const refs = new Set<number>()
    for (let from = 0; refs.size < REFS_MAX && lists.some((list) => list.length > from); from += REFS_CHUNK) {
      for (const list of lists) for (let n = from; n < Math.min(list.length, from + REFS_CHUNK) && refs.size < REFS_MAX; n++) refs.add(list[n]!)
    }
    return [...refs].sort((a, b) => a - b)
  }

  private yieldOf(thing: TreeThing<N>, recipe: Recipe): { n: number; product?: string; made?: { id: string; meta: number } } {
    if (thing.fluid) {
      const n = recipe.fout.filter((o) => o.f === thing.fluid!.f).reduce((sum, o) => sum + o.mb, 0)
      return n > 0 ? { n, product: `fluid:${thing.fluid.f}` } : { n: 0 }
    }
    const slot = thing.slot!
    const outs = recipe.out.filter((o) => o.chance === undefined && (serves(slot, o, this.items) || thing.members.some((m) => m.id === o.id && m.meta === o.meta)))
    if (outs.length === 0) return { n: 0 }
    const made = { id: outs[0]!.id, meta: outs[0]!.meta }
    return { n: outs.reduce((sum, o) => sum + o.n, 0), product: `${made.id}/${made.meta}`, made }
  }

  private feedsOnItself(thing: TreeThing<N>, recipe: Recipe): boolean {
    if (thing.fluid) return recipe.fin.some((f) => f.f === thing.fluid!.f)
    return recipe.in.some((s) => this.keyOfSlot(s) === thing.key || thing.members.some((m) => serves(s, m, this.items)))
  }

  private optionsOf(thing: TreeThing<N>): Options {
    let refs: number[] | undefined
    const all = (): number[] => (refs ??= this.refsOf(thing))
    const valid = (limit: number, accept?: (way: RecipeHandler) => boolean): Recipe[] => {
      const out: Recipe[] = []
      for (const ref of all()) {
        if (out.length >= limit) break
        const way = this.book?.handlerOfRecipe(ref)
        if (!way || (accept && !accept(way))) continue
        const recipe = this.book?.get(ref)
        if (recipe && this.yieldOf(thing, recipe).n > 0 && !this.feedsOnItself(thing, recipe)) out.push(recipe)
      }
      return out
    }
    return {
      refs: all,
      yield: (recipe) => {
        const y = this.yieldOf(thing, recipe)
        return y.product !== undefined ? { n: y.n, product: y.product } : { n: y.n }
      },
      feedsOnItself: (recipe) => this.feedsOnItself(thing, recipe),
      first: (accept) => valid(1, accept)[0],
      recipes: valid,
      ways: () => {
        const ways = new Map<RecipeHandler, number>()
        for (const ref of all()) {
          const way = this.book?.handlerOfRecipe(ref)
          if (way) ways.set(way, (ways.get(way) ?? 0) + 1)
        }
        return ways
      },
    }
  }

  // ── 走 ──

  private visit(thing: TreeThing<N>, path: TreeThing<N>[], asked: Asked): void {
    const before = this.visited.get(thing)
    // 见过了就不再问；只有一种情况再问一次：上回它只是“不消耗的”、没做，这回被当原料要
    if (before !== undefined && !(before && !asked.kept && thing.recipe === undefined && thing.loop === undefined && !this.alias.has(thing))) return
    this.visited.set(thing, asked.kept)
    if (this.madeCount >= TREE_MAX_THINGS) {
      this.cut = true
      thing.cut = true
      return
    }
    const choice = this.choose(thing, this.optionsOf(thing), asked)
    if (choice.note !== undefined) thing.note = choice.note
    else delete thing.note
    if (choice.recipe) this.use(thing, choice.recipe, path)
  }

  private use(thing: TreeThing<N>, recipe: Recipe, path: TreeThing<N>[]): void {
    const y = this.yieldOf(thing, recipe)
    if (y.n === 0) {
      thing.unfit = recipe
      return
    }
    // 这条配方的这样产物已经算在另一样东西名下：并过去（那样东西正在上面，就是绕回去了）
    const product = `${recipe.ref}|${y.product}`
    const same = this.producers.get(product)
    if (same && same !== thing) {
      if (path.includes(same)) thing.loop = { recipe, needs: same }
      else this.alias.set(thing, same)
      return
    }
    const slots = mergedSlots(recipe.in).filter((s) => circuitOf(s) === undefined)
    const stays = (s: RecipeSlot): boolean => s.n === 0 || isTool(s)
    // 它要用到树上在它上面的东西（或者它自己）：这条配方不往下走
    const above = new Set([...path, thing])
    for (const child of [...slots.filter((s) => !stays(s)).map((s) => this.thingOfSlot(s)), ...recipe.fin.map((f) => this.thingOfFluid(f))]) {
      if (above.has(this.canon(child))) {
        thing.loop = { recipe, needs: this.canon(child) }
        return
      }
    }
    this.producers.set(product, thing)
    thing.recipe = recipe
    thing.yield = y.n
    if (y.made) thing.made = y.made
    this.madeCount++
    path.push(thing)
    for (const s of slots) {
      const child = this.thingOfSlot(s)
      thing.inputs.push({ thing: child, n: s.n, kept: stays(s) })
      this.visit(child, path, { target: false, kept: stays(s) })
    }
    for (const f of recipe.fin) {
      const child = this.thingOfFluid(f)
      thing.inputs.push({ thing: child, n: f.mb, kept: false })
      this.visit(child, path, { target: false, kept: false })
    }
    path.pop()
  }

  /**
   * 走一遍：每样东西定下用哪条配方（问选择函数），返回目标。数量还没算（count 做这件事）；
   * 中间可以拿 all() 去查库存。一个对象只走一次。
   */
  walk(target: { slot: RecipeSlot } | { fluid: RecipeFluid | { f: string; name: string } }): TreeThing<N> {
    const top = 'slot' in target ? this.thingOfSlot(target.slot) : this.thingOfFluid(target.fluid)
    this.visit(top, [], { target: true, kept: false })
    this.top = top
    return top
  }

  /** 树上的每样东西（走完以后；并到别的东西上的不算），目标在最前。 */
  all(): TreeThing<N>[] {
    return this.order()
  }

  /** 走一遍并算数。目标是一个物品（配方里的一格的写法）或者一种流体；count 是个数或 mB。 */
  run(target: { slot: RecipeSlot } | { fluid: RecipeFluid | { f: string; name: string } }, count: number, have?: (thing: TreeThing<N>) => number): TreeResult<N> {
    this.walk(target)
    return this.count(count, have)
  }

  private top: TreeThing<N> | undefined
  private ordered: TreeThing<N>[] | undefined

  /** 用到别人的排在别人前面（目标最前）：照这个先后算数量，轮到一样东西时要它多少已经加全了。 */
  private order(): TreeThing<N>[] {
    if (this.ordered) return this.ordered
    const top = this.top
    if (!top) return []

    const order: TreeThing<N>[] = []
    const seen = new Set<TreeThing<N>>()
    const walk = (t: TreeThing<N>): void => {
      if (seen.has(t)) return
      seen.add(t)
      for (const input of t.inputs) {
        input.thing = this.canon(input.thing)
        walk(input.thing)
      }
      order.unshift(t)
    }
    walk(top)
    // 层数：从目标起走最短的路
    const level = new Map<TreeThing<N>, number>([[top, 0]])
    for (const t of order) for (const input of t.inputs) level.set(input.thing, Math.min(level.get(input.thing) ?? Infinity, (level.get(t) ?? 0) + 1))
    for (const [t, n] of level) t.level = n
    this.ordered = order
    return order
  }

  /**
   * 算数量（walk 之后）。have：这样东西现有多少（库存）——先用掉现成的，只把缺的往下算；目标自己不扣。可以用不同的 have 再算一遍。
   */
  count(count: number, have?: (thing: TreeThing<N>) => number): TreeResult<N> {
    const top = this.top
    if (!top) throw new Error('walk() first')
    const order = this.order()
    for (const t of order) {
      t.needed = 0
      t.fromStock = 0
      t.rounds = 0
      t.keptOnly = false
    }
    top.needed = count
    const keptAsked = new Set<TreeThing<N>>()
    const consumed = new Set<TreeThing<N>>([top])
    const counted = new Set<TreeThing<N>>()
    // 没做的：照被要到的先后（从目标往下、一条配方里照格子的先后）
    const leaves: TreeThing<N>[] = []
    const stocked: TreeThing<N>[] = []
    for (const t of order) {
      counted.add(t)
      if (t.needed <= 0) continue
      if (have && t !== top) {
        t.fromStock = Math.max(0, Math.min(t.needed, Math.floor(have(t))))
        if (t.fromStock > 0) stocked.push(t)
      }
      if (!t.recipe) continue
      t.rounds = Math.ceil((t.needed - t.fromStock) / (t.yield ?? 1))
      // 现成的够了：它下面那一截不用做
      if (t.rounds === 0) continue
      for (const input of t.inputs) {
        if (!input.thing.recipe && !leaves.includes(input.thing)) leaves.push(input.thing)
        if (input.kept) {
          // 不消耗的：整棵树只要一个（做它自己要用到它的——模头压出来的板再做这个模头——不再加）
          if (!keptAsked.has(input.thing) && !counted.has(input.thing)) {
            keptAsked.add(input.thing)
            input.thing.needed += 1
          }
        } else {
          consumed.add(input.thing)
          input.thing.needed += input.n * t.rounds
        }
      }
    }
    for (const t of order) t.keptOnly = keptAsked.has(t) && !consumed.has(t)
    if (!top.recipe) leaves.push(top)
    return {
      target: top,
      made: order.filter((t) => t.recipe !== undefined && t.rounds > 0).reverse(),
      raw: leaves.filter((t) => !t.fluid && !t.keptOnly),
      kept: leaves.filter((t) => !t.fluid && t.keptOnly),
      fluids: leaves.filter((t) => t.fluid !== undefined),
      stocked,
      cut: this.cut,
    }
  }
}
