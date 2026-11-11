// total_materials（库函数：不在发给模型的工具清单里，程序里调，模型直接调也照常执行）：做一样东西，整棵树要什么、先干哪些。
//
// 每样要做的东西用哪条配方，按这个先后定——都是别人定好的，这里不替它选：
//   1. 这一次调用里点了名的（recipes、chisel）；
//   2. “基地的做法”里给这样东西记的那条配方；
//   3. “基地的做法”里它这一类零件的做法（plate ← 卷板机，从 ingot）；
//   4. “基地的做法”里总的先后：排在最前、做得出它的那种做法；
//   5. 只有一种做法、只有一条配方：没得选；
//   6. 都不是：不展开，列进“没定过做法的”，把它的几种做法摆出来。它定了（记进基地的做法，或者这一次点名）再算一次，就接着往下走。
// 流体只有点了名或者记了配方的才往下做，别的记成要现成的流体（“没得选”“总的先后”对流体不作数：副产物出它的配方到处都是）。
//
// 库存（默认看）：现成的先用掉，只把缺的往下算，用了哪里的列出来；接着管道、漏斗的容器里的另算一栏、不计入（那是主人的自动化）；
// 机器里的不算。stock: false 是从零算。
// 走树和算数在 material-tree.ts；这里是选择函数、查库存、和把结果排出来。

import { ANY_META } from '../packdata/index.ts'
import type { FluidInfo, Recipe, RecipeHandler, RecipeSlot } from '../packdata/index.ts'
import type { ItemTable } from '../packdata/items.ts'
import { BridgeError } from '../bridge/protocol.ts'
import type { AttachedBlock, MachineInfo, StockQuery } from '../bridge/protocol.ts'
import type { MachineMethod, Method, PartMethod, ThingMethod } from '../store/methods.ts'
import { CHISEL_COST } from './chisel.ts'
import { formatPos, itemKey } from './format.ts'
import { MaterialTree, TREE_MAX_THINGS, isRecycling } from './material-tree.ts'
import type { Choose, Options, TreeResult, TreeThing } from './material-tree.ts'
import { comesFrom, handlersOf, methodSource, oresOfThing, partMethodFor, recipeText, resolveMark } from './methods.ts'
import type { MethodAccess } from './methods.ts'
import {
  MACHINES_REACH,
  availability,
  carried,
  fluidInside,
  fluidLabel,
  lookAround,
  machineText,
  namer,
  otherMachines,
  quantity,
  runsWay,
  scanContainers,
  signature,
  slotName,
  spread,
  wayKind,
  whereItStands,
} from './recipe-book.ts'
import type { Namer, Surroundings } from './recipe-book.ts'
import { arr, bool, int, obj, str } from './schema.ts'
import { DEFAULT_RESULT_MAX_CHARS, fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const RECIPES_MAX = 2000
const CHISEL_MAX = 200
/** 看一样东西是不是“只有一条配方”时最多读这么多条；照“一类零件”的做法找配方时最多看这么多条。 */
const ONLY_SCAN = 12
const PART_SCAN = 40
/** “没定过做法的”在文字里细摆这么多样（每样最多这么几种做法），再多的只列名字；data 里是全的。 */
const UNDECIDED_SHOWN = 20
const UNDECIDED_WAYS = 5
/** 一张单子在文字里最多列这么多样（data 里是全的）。 */
const LISTED_MAX = 60
/** 活儿清单以外的部分最多占一个结果的这么大一份；超了就每张单子少列几样。 */
const TOTALS_SHARE = 0.7
/** 查库存：身体一次最多问这么多样、看这么远；往四周错开四个点各问一次（和 find_in_storage 看整个基地时一样）。 */
const STOCK_BATCH = 24
const STOCK_RADIUS = 64
const STOCK_STEP = 48
const ANY_QUERIES_MAX = 6
/** 凿子的一步当成一条“配方”来算：编号是负的（真配方的编号从 0 起），一个进一个出。 */
const CHISEL_HANDLER: RecipeHandler = { key: 'chisel', name: 'chisel', machines: [], grid: false, gregtech: false }
const isChiselStep = (r: Recipe): boolean => r.ref < 0

// ── 每样东西用哪条配方 ──

type Rule = 'named' | 'thing' | 'part' | 'order' | 'only'

interface Note {
  /** 照哪一条定的。 */
  rule?: Rule
  /** 照的是基地的做法里哪一条。 */
  method?: Method
  /** 照“总的先后”时：对上的是哪种做法。 */
  orderWay?: string
  /** 没定：有不止一条配方，没有哪条规矩管得到它。留着它的选项，摆做法时用。 */
  undecided?: Options
  /** 基地的做法里给它记的那条配方，在配方册里认不回来了。 */
  stale?: ThingMethod
  /** 它这一类零件的做法用不上：那种做法没有做它的配方（或者不是从那种料来）。 */
  partMiss?: PartMethod
  /** 只有它操作不了的页做得出它（在世界里发生的事、信息页）。 */
  onlyOther?: string[]
}

/** 它自己操作得了的做法（合成格、机器），回收的页不算。 */
const runnable = (way: RecipeHandler): boolean => !isRecycling(way) && wayKind(way) !== 'other'

function chooseByMethods(chosen: readonly Recipe[], methods: MethodAccess | undefined, env: { book: NonNullable<ToolContext['packdata']>['recipes']; items: ItemTable | undefined }): Choose<Note> {
  const makes = new Map<number, string>()
  const all = methods?.list() ?? []
  const order = methods?.order()
  return (thing, options) => {
    // 1. 这一次点了名的：一条配方只当一样产物的做法
    for (const recipe of chosen) {
      const y = options.yield(recipe)
      if (y.n === 0 || (makes.get(recipe.ref) ?? y.product) !== y.product) continue
      makes.set(recipe.ref, y.product!)
      return { recipe, note: { rule: 'named' } }
    }
    const note: Note = {}
    // 2. 基地的做法里给这样东西记的配方
    const own = methods?.thingFor(thing.key)
    if (own) {
      const recipe = resolveMark(own.recipe, env.book, env.items, options.refs)
      if (recipe && options.yield(recipe).n > 0) return { recipe, note: { rule: 'thing', method: own } }
      note.stale = own
    }
    // 流体到此为止：没点名、没记配方的，是要现成的
    if (thing.fluid) return { note }
    // 3. 它这一类零件的做法
    const part = partMethodFor(all, oresOfThing(thing, env.items))
    if (part) {
      const ways = new Set(handlersOf(env.book, part.entry.way))
      const recipe = options.recipes(PART_SCAN, (way) => ways.has(way)).find((r) => part.entry.from === undefined || comesFrom(r, part.entry.from, part.material, env.items))
      if (recipe) return { recipe, note: { ...note, rule: 'part', method: part.entry } }
      note.partMiss = part.entry
    }
    // 4. 总的先后
    for (const way of order?.ways ?? []) {
      const ways = new Set(handlersOf(env.book, way))
      const recipe = options.first((w) => ways.has(w))
      if (recipe) return { recipe, note: { ...note, rule: 'order', method: order!, orderWay: way } }
    }
    // 5. 没得选：一种做法、一条配方（配方册里一模一样的重复只算一条）
    const distinct = new Map<string, Recipe>()
    for (const recipe of options.recipes(ONLY_SCAN, runnable)) if (!distinct.has(signature(recipe))) distinct.set(signature(recipe), recipe)
    if (distinct.size === 1) return { recipe: [...distinct.values()][0]!, note: { ...note, rule: 'only' } }
    if (distinct.size === 0) {
      const other = [...new Set([...options.ways().keys()].filter((way) => !isRecycling(way) && wayKind(way) === 'other').map((way) => way.name))]
      return { note: { ...note, ...(other.length > 0 ? { onlyOther: other } : {}) } }
    }
    // 6. 没定
    return { note: { ...note, undecided: options } }
  }
}

// ── 库存 ──

interface Place {
  x: number
  y: number
  z: number
  container?: string
  count: number
}

interface Held {
  /** 拿得到的：箱子、抽屉里的（接着管道的、机器里的不算），加上身上的。 */
  free: number
  places: Place[]
  carried: number
  /** 接着管道、漏斗的容器里的：不计入。 */
  automated: number
  automatedPlaces: (Place & { by: string })[]
}

interface Storage {
  held: Map<TreeThing<Note>, Held>
  /** 看了多少个容器。 */
  containers: number
  /** 容器太多、没扫完（哪些接着管道可能认不全）。 */
  cut: boolean
}

const posKey = (p: { x: number; y: number; z: number }): string => `${p.x},${p.y},${p.z}`
const attachedText = (attached: readonly AttachedBlock[]): string => attached.map((a) => a.name ?? a.kind ?? 'a pipe').join(', ')

/** 一样东西怎么问身体：矿辞名、id/meta、不分 meta；“几种里任一种”的一种一种问（最多 ANY_QUERIES_MAX 种）。流体不问。 */
function queriesOf(thing: TreeThing<Note>): StockQuery[] {
  if (thing.fluid) return []
  if (thing.key.startsWith('ore:')) return [{ ore: thing.key.slice(4) }]
  const slot = thing.slot!
  if (slot.kind === 'item') return [slot.meta === ANY_META ? { id: slot.id } : { id: slot.id, meta: slot.meta }]
  return slot.any.slice(0, ANY_QUERIES_MAX).map(([id, meta]) => (meta === ANY_META ? { id } : { id, meta }))
}

/**
 * 看整个基地的库存里这些东西各有多少、在哪。机器（和它的总线、仓）里的不算库存；接着管道、漏斗的容器里的另记。
 * 问不到（没连上、不在线）时返回原因。
 */
async function lookIntoStorage(ctx: ToolContext, things: readonly TreeThing<Note>[], around: Surroundings): Promise<Storage | { error: string }> {
  try {
    const me = await whereItStands(ctx)
    if (!me) return { error: `offline: ${ctx.botName} is not in the game world` }
    const [scan, status] = await Promise.all([scanContainers(ctx, me), ctx.bridge.botStatus(ctx.botName)])
    // 每个容器是不是机器、接没接管道
    const flags = new Map<string, { machine?: true; attached?: AttachedBlock[] }>()
    for (const m of around.machines) {
      flags.set(posKey(m), { machine: true })
      for (const h of [...(m.inputBuses ?? []), ...(m.outputBuses ?? []), ...(m.inputHatches ?? []), ...(m.outputHatches ?? [])]) flags.set(posKey(h), { machine: true })
    }
    // 身体读不懂、配方册认得的机器（熔炉里的燃料和没取走的产物也不是库存）
    around.others ??= ctx.packdata?.recipes ? otherMachines(scan.containers, around.machines, ctx.packdata.recipes, ctx.packdata.items, me) : []
    for (const o of around.others) flags.set(posKey(o), { machine: true })
    for (const c of scan.containers) {
      const known = flags.get(posKey(c))
      const machine = known?.machine === true || c.kind === 'machine' || c.kind === 'drawer_controller'
      flags.set(posKey(c), { ...(machine ? { machine: true as const } : {}), ...(c.attached && c.attached.length > 0 ? { attached: c.attached } : {}) })
    }
    const have = carried(status.inventory ?? [], ctx.packdata?.items)
    const held = new Map<TreeThing<Note>, Held>()
    const wanted: { thing: TreeThing<Note>; query: StockQuery }[] = []
    for (const thing of things) {
      if (thing.fluid) continue
      held.set(thing, { free: 0, places: [], carried: thing.slot ? have.ofSlot(thing.slot, true) : 0, automated: 0, automatedPlaces: [] })
      for (const query of queriesOf(thing)) wanted.push({ thing, query })
    }
    const points = spread(me, STOCK_STEP)
    for (let from = 0; from < wanted.length; from += STOCK_BATCH) {
      const batch = wanted.slice(from, from + STOCK_BATCH)
      const answers = await Promise.all(points.map((at) => ctx.bridge.worldStock(at, { items: batch.map((b) => b.query), radius: STOCK_RADIUS })))
      batch.forEach(({ thing }, n) => {
        const h = held.get(thing)!
        // 四次查询的范围有重叠：同一个存放点只算一次（同一个方块自己的格子和它各个面上的覆盖板是不同的存放点）
        const places = new Map<string, NonNullable<NonNullable<(typeof answers)[number]['items']>[number]['places']>[number]>()
        for (const a of answers) for (const place of a.items?.[n]?.places ?? []) places.set(`${posKey(place)},${place.kind === 'cover' ? (place.side ?? '') : ''}`, place)
        for (const place of places.values()) {
          const flag = flags.get(posKey(place))
          if (flag?.machine && place.kind !== 'cover') continue
          const at: Place = { x: place.x, y: place.y, z: place.z, count: place.count, ...(place.container ? { container: place.container } : {}) }
          if (flag?.attached) {
            h.automated += place.count
            h.automatedPlaces.push({ ...at, by: attachedText(flag.attached) })
          } else {
            h.free += place.count
            h.places.push(at)
          }
        }
      })
    }
    for (const h of held.values()) {
      h.places.sort((a, b) => b.count - a.count)
      h.free += h.carried
    }
    return { held, containers: scan.containers.length, cut: scan.cut }
  } catch (e) {
    if (e instanceof BridgeError) return { error: e.message }
    throw e
  }
}

// ── 工具 ──

interface Input {
  id?: string
  meta?: number
  fluid?: string
  count?: number
  recipes?: number[]
  chisel?: { id: string; meta?: number; from: { id: string; meta?: number } }[]
  stock?: boolean
  from?: number
}

/** 一样东西叫什么：做出来的是哪一种就叫哪一种（“任何钢板”做出来的是 GregTech 的钢板）。 */
function thingName(t: TreeThing<Note>, nm: Namer, ids: boolean): string {
  if (t.fluid) return t.fluid.name
  if (t.made) return ids ? nm.label(t.made.id, t.made.meta) : nm.name(t.made.id, t.made.meta)
  return slotName(t.slot!, nm, ids)
}

function thingData(t: TreeThing<Note>, nm: Namer): Record<string, unknown> {
  if (t.fluid) return { fluid: t.fluid.f, name: t.fluid.name }
  if (t.made) return { id: t.made.id, meta: t.made.meta, name: nm.name(t.made.id, t.made.meta) }
  const slot = t.slot!
  const which = slot.kind === 'item' ? { id: slot.id, ...(slot.meta === ANY_META ? {} : { meta: slot.meta }) } : slot.kind === 'ore' ? { ore: slot.ore } : { any: slot.any.map(([id, meta]) => itemKey({ id, meta })) }
  return { ...which, name: slotName(slot, nm, false) }
}

/** 这条配方是照哪一条定的，写成方括号里的一句。 */
function ruleText(note: Note | undefined): string {
  if (note?.rule === 'named') return 'named by you'
  if (note?.rule === 'thing') return `base method for it (${note.method!.by === 'owner' ? 'owner' : 'you'})`
  if (note?.rule === 'part') return `base method ${note.method!.key}`
  if (note?.rule === 'order') return `base order: ${note.orderWay}`
  return 'only recipe'
}

export const totalMaterials: Tool = {
  name: 'total_materials',
  brief: "{id | fluid, meta?, count?, recipes?, chisel?, stock?, from?}: what making it takes down the whole tree, by the base's methods, storage deducted -> undecided[{ways}], missing[], jobs[{wave, way, recipe, rounds, makes, rule}], raw[], fluids[], kept[]",
  description:
    "What making a thing takes, down its whole tree, and what to do first. For each thing to make the recipe is: one you name in \"recipes\" (or a \"chisel\" step); else the one the base's methods record for it; else the way they record for its kind of part; else the first way of their order that makes it; else its only recipe, when it has just one. Otherwise it is NOT DECIDED: the tree stops there and its ways are laid out — nothing is chosen for you; record a choice with set_base_method (or name a recipe) and run it again. " +
    'Storage is looked into first: what is there is used, only what is short is expanded, and where it was taken from is listed; what sits in containers with pipes or hoppers attached is listed apart and not counted; stock: false counts everything from nothing. ' +
    'The result: the things not decided; the raw materials still missing; missing capability (ways with no usable machine here, fluids to supply and what the tanks hold); and the jobs, grouped by way and by when they can start. Amounts are multiplied down the tree, rounds rounded up, molds and tools counted once.',
  inputSchema: obj({
    id: str('Item id of the target.'),
    meta: int('Item meta of the target (default 0).', { min: 0 }),
    fluid: str('Instead of "id": a fluid as the target, by its name or internal name; "count" is then mB.', { maxLength: 80 }),
    count: int('How many of the target to make (default 1); for a fluid, mB.', { min: 1, max: 100_000_000 }),
    recipes: arr('Recipe # numbers to use this time: each for the thing it makes, before anything the base\'s methods say.', int('recipe #', { min: 0 }), { max: RECIPES_MAX }),
    chisel: arr(
      'Things to make with a chisel from another block of the same chisel group (find_recipes shows the group): one block gives one block.',
      obj({ id: str('The block wanted.'), meta: int('Its meta (default 0).', { min: 0 }), from: obj({ id: str('The block it is chiselled from.'), meta: int('Its meta (default 0).', { min: 0 }) }, ['id']) }, ['id', 'from']),
      { max: CHISEL_MAX },
    ),
    stock: bool('false: do not look into storage; count everything from nothing.'),
    from: int('Which job to list from (default 1), when the list of jobs did not fit.', { min: 1 }),
  }),
  async run(ctx: ToolContext, i: Input): Promise<ToolResult | string> {
    const book = ctx.packdata?.recipes
    const items = ctx.packdata?.items
    const carving = ctx.packdata?.carving
    const methods = ctx.methods
    const asked = i.recipes ?? []
    const carved = i.chisel ?? []
    if (!book) return fail('There is no recipe book on this brain, so nothing can be added up.')
    const nm = namer(items)
    // 目标是一个物品，或者一种流体（数量按 mB）
    const wantsItem = typeof i.id === 'string' && i.id.trim().length > 0
    const wantsFluid = typeof i.fluid === 'string' && i.fluid.trim().length > 0
    if (wantsItem === wantsFluid) return fail('Give exactly one target: "id" (an item) or "fluid" (a fluid; "count" is then mB).')
    let liquid: FluidInfo | undefined
    if (wantsFluid) {
      const table = ctx.packdata?.fluids
      const text = i.fluid!.trim()
      const found = table?.get(text) ? [table.get(text)!] : (table?.search(text).exact ?? [])
      if (found.length !== 1) return fail(found.length === 0 ? `No fluid is named "${text}": give its internal name (find_item shows it in brackets).` : `${found.length} fluids are named "${text}": ${found.map(fluidLabel).join(', ')}. Give the internal name in the brackets.`)
      liquid = found[0]!
    }
    const target = { id: (i.id ?? '').trim(), meta: i.meta ?? 0 }
    const targetLabel = liquid ? fluidLabel(liquid) : nm.label(target.id, target.meta)
    const count = i.count ?? 1
    const chosen: Recipe[] = []
    for (const ref of [...new Set(asked)]) {
      const recipe = book.get(ref)
      if (!recipe) return fail(`There is no recipe #${ref}. Take the numbers from find_recipes (they change when the recipe book is re-exported).`)
      chosen.push(recipe)
    }
    // 凿子的一步：两样东西得在同一个组里（或者原料带着那个组认的矿辞名）
    const groupOfStep = new Map<number, string>()
    for (const [n, c] of carved.entries()) {
      const to = { id: c.id.trim(), meta: c.meta ?? 0 }
      const from = { id: c.from.id.trim(), meta: c.from.meta ?? 0 }
      if (!carving) return fail('There is no chisel data on this brain (carving.jsonl), so a chisel step cannot be checked.')
      const group = carving.between({ ...from, ores: items?.get(from.id, from.meta)?.ores ?? [] }, to)
      if (!group) {
        const groupsOf = (x: { id: string; meta: number }): string => {
          const names = carving.groupsOf(x.id, x.meta, items?.get(x.id, x.meta)?.ores ?? []).map((m) => `"${m.group.group}"`)
          return names.length > 0 ? names.join(', ') : 'no chisel group'
        }
        return fail(`${nm.label(to.id, to.meta)} cannot be chiselled from ${nm.label(from.id, from.meta)}: a chisel only turns a block into another block of the same group. ${nm.label(to.id, to.meta)} is in ${groupsOf(to)}; ${nm.label(from.id, from.meta)} is in ${groupsOf(from)}.`)
      }
      const ref = -1 - n
      groupOfStep.set(ref, group.group)
      chosen.push({ ref, handler: CHISEL_HANDLER, in: [{ kind: 'item', id: from.id, meta: from.meta, n: 1 }], out: [{ id: to.id, meta: to.meta, n: 1 }], fin: [], fout: [] })
    }

    // ── 走树：每样东西定配方 ──
    const walker = new MaterialTree<Note>(book, items, chooseByMethods(chosen, methods, { book, items }))
    const top = walker.walk(liquid ? { fluid: { f: liquid.fluid, name: liquid.name } } : { slot: { kind: 'item', id: target.id, meta: target.meta, n: 1 } })
    const everything = walker.all()
    // 点了名的配方绕成了圈：不猜该断在哪
    const looped = everything.find((t) => t.loop && chosen.includes(t.loop.recipe))?.loop
    if (looped) {
      const again = looped.needs.recipe ?? looped.recipe
      const loop = isChiselStep(again) ? `the chisel step for ${nm.label(again.out[0]!.id, again.out[0]!.meta)} ends up needing its own product` : `recipe #${again.ref} ends up needing its own product`
      return fail(`These recipes feed each other in a circle (${loop}), so the amounts cannot be added up. Leave out the recipe that turns a product back into its ingredient.`)
    }

    // ── 基地里有什么：机器、合成台、库存 ──
    const around = await lookAround(ctx)
    const wantStock = i.stock !== false
    const storage = wantStock && !around.error ? await lookIntoStorage(ctx, everything, around) : undefined
    const stockError = !wantStock ? undefined : around.error ? around.error : storage && 'error' in storage ? storage.error : undefined
    const held = storage && !('error' in storage) ? storage.held : undefined
    const tree: TreeResult<Note> = walker.count(count, held ? (t) => held.get(t)?.free ?? 0 : undefined)

    const jobs = tree.made
    const leaves = [...tree.raw, ...tree.kept]
    const short = (t: TreeThing<Note>): number => t.needed - t.fromStock
    const undecided = leaves.filter((t) => t.note?.undecided && short(t) > 0)
    const missing = tree.raw.filter((t) => !t.note?.undecided && short(t) > 0)
    const keptMissing = tree.kept.filter((t) => !t.note?.undecided && short(t) > 0)
    const fluids = tree.fluids.filter((t) => short(t) > 0)
    const stale = everything.filter((t) => t.note?.stale && t.needed > 0)
    const used = new Set(jobs.map((t) => t.recipe!.ref))
    const unused = chosen.filter((r) => !used.has(r.ref) && !isChiselStep(r)).map((r) => r.ref)
    const unusedChisel = chosen.filter((r) => !used.has(r.ref) && isChiselStep(r)).map((r) => nm.label(r.out[0]!.id, r.out[0]!.meta))
    const usesChisel = jobs.some((t) => isChiselStep(t.recipe!))
    const byRule = (rule: Rule): number => jobs.filter((t) => t.note?.rule === rule).length
    const byMethod = byRule('thing') + byRule('part') + byRule('order')

    // 先后：一样东西的原料都是现成的（原料、库存）就是第 1 批；要等别的做出来的，排在它们后面一批
    const wave = new Map<TreeThing<Note>, number>()
    for (const t of jobs) wave.set(t, 1 + Math.max(0, ...t.inputs.map((input) => wave.get(input.thing) ?? 0)))
    const waves = Math.max(0, ...wave.values())

    // 每种做法基地里现在怎样：一条条看（电压、炉温不一样），说法一样的并成一句
    const stateOf = (handler: RecipeHandler, things: readonly TreeThing<Note>[]): { text: string; refs: number[]; rank: number }[] => {
      const groups = new Map<string, { text: string; refs: number[]; rank: number }>()
      for (const t of things) {
        const a = availability(handler, [t.recipe!], around, true)
        const g = groups.get(a.text) ?? { text: a.text, refs: [], rank: a.rank }
        g.refs.push(t.recipe!.ref)
        groups.set(a.text, g)
      }
      return [...groups.values()]
    }
    const machineNote = (m: MachineInfo): string | undefined => {
      const entry: MachineMethod | undefined = methods?.machineAt(m)
      if (!entry) return undefined
      const parts = [entry.does, ...(entry.feed ? [`feed: ${formatPos(entry.feed)}`] : []), ...(entry.collect ? [`collect: ${formatPos(entry.collect)}`] : []), ...(entry.keep ? [`do not touch: ${entry.keep}`] : [])]
      return `${machineText(m)} — base's methods: ${parts.join('; ')} (${methodSource(entry)})`
    }

    // ── 文字 ──
    // 流体带着注册名：不同的流体会重名（两种“熔融钢”）
    const fluidText = (t: TreeThing<Note>): string => `${t.fluid!.name} [fluid ${t.fluid!.f}]`
    const amount = (t: TreeThing<Note>, n: number): string => (t.fluid ? `${quantity(n)} mB ${fluidText(t)}` : `${quantity(n)}× ${thingName(t, nm, true)}`)
    const haveText = (t: TreeThing<Note>): string => {
      if (!held || t.fluid) return ''
      const h = held.get(t)
      if (!h) return ''
      return ` (need ${quantity(t.needed)}, ${h.free > 0 ? `${quantity(h.free)} in storage` : 'none in storage'}${h.automated > 0 ? `; ${quantity(h.automated)} more in automated containers, not counted` : ''})`
    }
    const forWhat = `For ${liquid ? `${count} mB` : `${count}×`} ${targetLabel}`
    const head: string[] = []
    const parts = [
      byMethod > 0 ? `${byMethod} by the base's methods` : '',
      byRule('named') > 0 ? `${byRule('named')} named by you` : '',
      byRule('only') > 0 ? `${byRule('only')} with only one recipe` : '',
    ].filter(Boolean)
    head.push(
      `${forWhat}: ${jobs.length} thing(s) to make${jobs.length > 0 ? ` in ${waves} wave(s) (${parts.join(', ')})` : ''}; ${undecided.length} thing(s) NOT DECIDED${undecided.length > 0 ? ' — the tree stops at them' : ''}. This adds up amounts by the base\'s methods (${(methods?.list() ?? []).length} entr${(methods?.list() ?? []).length === 1 ? 'y' : 'ies'}); it chooses no recipe.`,
    )
    if (!wantStock) head.push('Storage was not looked into (stock: false): everything is counted from nothing.')
    else if (stockError !== undefined) head.push(`Storage could not be looked into (${stockError}): nothing is deducted${around.error ? ', and which machines stand in the base is not known' : ''}.`)
    else if (storage && !('error' in storage)) head.push(`Storage was looked into (${storage.containers} container(s)${storage.cut ? '; there are more, not all were read' : ''}; what you carry counts too): what is there is used first, only what is short is expanded. Things inside machines do not count.`)
    if (!top.recipe) {
      const why = top.loop
        ? `recipe #${top.loop.recipe.ref} (${top.loop.recipe.handler.name}) for it needs ${top.loop.needs === top ? 'itself' : thingName(top.loop.needs, nm, false)}`
        : top.note?.undecided
          ? 'it has more than one recipe and none is chosen (below)'
          : top.note?.onlyOther
            ? `only ${top.note.onlyOther.join(', ')} gives it, which is nothing you can run`
            : 'nothing in the recipe book makes it'
      head.push(`Nothing is expanded: no recipe is settled for the target itself — ${why}.`)
    }
    if (tree.cut) head.push(`The tree was cut off at ${TREE_MAX_THINGS} things to make: what lies below that is counted as raw.`)
    if (stale.length > 0) head.push(`Recorded in the base's methods but no longer in the recipe book (set_base_method records it anew, or removes it): ${stale.map((t) => `${thingName(t, nm, false)} — it was ${t.note!.stale!.recipe.wayName}: ${t.note!.stale!.recipe.text} [key ${t.note!.stale!.key}]`).join('; ')}`)

    /** 没定的一样东西：它的几种做法各摆一条。 */
    const waysOf = (t: TreeThing<Note>): { way: RecipeHandler; recipe: Recipe; more: number; state: string }[] => {
      const options = t.note!.undecided!
      const counts = options.ways()
      const out: { way: RecipeHandler; recipe: Recipe; more: number; state: string }[] = []
      for (const [way, n] of counts) {
        if (isRecycling(way)) continue
        const recipe = options.first((w) => w === way)
        if (recipe) out.push({ way, recipe, more: n - 1, state: availability(way, [recipe], around, true).text })
      }
      return out
    }
    const undecidedWays = new Map(undecided.map((t) => [t, waysOf(t)]))

    const totalsWith = (listMax: number): string[] => {
      const listed = <T>(things: readonly T[], each: (t: T) => string, sep = ', '): string => `${things.slice(0, listMax).map(each).join(sep)}${things.length > listMax ? `${sep}… and ${things.length - listMax} more (all of them are in data)` : ''}`
      const out: string[] = []
      // 2. 没定过做法的
      if (undecided.length > 0) {
        out.push(`NOT DECIDED, ${undecided.length} (each has more than one recipe and nothing says which: no recipe named, no base method for it or its kind of part, no way of the base's order makes it). Nothing below them is expanded. To decide one: set_base_method (it is then followed every time), or name a recipe # in "recipes" for this once; then run this again.`)
        for (const [n, t] of undecided.slice(0, Math.min(UNDECIDED_SHOWN, listMax)).entries()) {
          out.push(`${n + 1}. ${amount(t, short(t))}${haveText(t)}${t.keptOnly ? ' — not used up, one is enough' : ''}${t.note?.partMiss ? ` — the base's method ${t.note.partMiss.key} (${t.note.partMiss.way}${t.note.partMiss.from ? `, from ${t.note.partMiss.from}` : ''}) has no recipe for it` : ''}`)
          const ways = undecidedWays.get(t)!
          for (const w of ways.slice(0, UNDECIDED_WAYS)) out.push(`   - ${w.way.name} #${w.recipe.ref}: ${recipeText(w.recipe, nm)}${w.more > 0 ? ` (+${w.more} more of this way)` : ''} — ${w.state}`)
          if (ways.length > UNDECIDED_WAYS) out.push(`   - … and ${ways.length - UNDECIDED_WAYS} more way(s): ${ways.slice(UNDECIDED_WAYS).map((w) => w.way.name).join(', ')} (find_recipes shows them)`)
        }
        const rest = undecided.slice(Math.min(UNDECIDED_SHOWN, listMax))
        if (rest.length > 0) out.push(`… and ${rest.length} more not decided: ${listed(rest, (t) => amount(t, short(t)))}`)
      }
      // 3. 还缺的原料
      if (missing.length > 0) {
        out.push(`${held ? 'Raw materials still missing after storage' : 'Raw materials needed'} (${missing.length}):`)
        const groups: [string, (t: TreeThing<Note>) => boolean, (t: TreeThing<Note>) => string][] = [
          ['nothing in the recipe book makes it', (t) => !t.loop && !t.unfit && !t.cut && !t.note?.onlyOther, () => ''],
          ['only made by something you cannot run', (t) => t.note?.onlyOther !== undefined, (t) => ` (${t.note!.onlyOther!.join(', ')})`],
          ['its recipe needs something above it in the tree (loop)', (t) => t.loop !== undefined, (t) => ` (#${t.loop!.recipe.ref} ${t.loop!.recipe.handler.name} needs ${t.loop!.needs === t ? 'itself' : thingName(t.loop!.needs, nm, false)})`],
          ['the recipe given for it does not make it', (t) => t.unfit !== undefined, (t) => ` (#${t.unfit!.ref})`],
          ['below the cut-off', (t) => t.cut === true, () => ''],
        ]
        for (const [label, is, more] of groups) {
          const group = missing.filter(is)
          if (group.length > 0) out.push(`- ${label} (${group.length}): ${listed(group, (t) => `${amount(t, short(t))}${haveText(t)}${more(t)}`)}`)
        }
      } else if (jobs.length > 0) out.push(held ? 'No raw material is missing: storage covers them.' : 'No raw material is needed.')
      // 4. 缺的能力
      const lacking: string[] = []
      const byWay = new Map<RecipeHandler, TreeThing<Note>[]>()
      for (const t of jobs) if (!isChiselStep(t.recipe!)) byWay.set(t.recipe!.handler, [...(byWay.get(t.recipe!.handler) ?? []), t])
      if (!around.error) {
        for (const [way, things] of byWay) {
          for (const g of stateOf(way, things)) if (g.rank >= 2) lacking.push(`- ${way.name}, ${g.refs.length} of its ${things.length} job(s) (${g.refs.slice(0, 8).map((r) => `#${r}`).join(', ')}${g.refs.length > 8 ? ', …' : ''}): ${g.text}`)
        }
      }
      if (fluids.length > 0) {
        const tank = (t: TreeThing<Note>): string => {
          if (around.error) return ''
          const holding = around.machines.map((m) => ({ m, mb: fluidInside(m, t.fluid!.f) ?? 0 })).filter((x) => x.mb > 0)
          return holding.length > 0 ? ` (tanks here hold ${listed(holding, (x) => `${quantity(x.mb)} mB in ${machineText(x.m)}`)})` : ' (no machine tank here holds any that can be read)'
        }
        lacking.push(`- fluids to supply (a fluid is made only by a recipe you name or one the base's methods record for it): ${listed(fluids, (t) => `${amount(t, short(t))}${tank(t)}`, '; ')}`)
      }
      if (keptMissing.length > 0) lacking.push(`- needed at hand but not used up, one of each${held ? ', none in storage' : ''}: ${listed(keptMissing, (t) => thingName(t, nm, true))}`)
      if (usesChisel) lacking.push(`- for the chisel steps: a chisel (an item; find_item "凿子"), which is not used up as an ingredient — ${CHISEL_COST}.`)
      if (lacking.length > 0) out.push('Missing capability:', ...lacking)
      if (around.error && jobs.length > 0) out.push(`Which machines and crafting tables stand in the base could not be checked (${around.error}).`)
      else if (around.machinesTotal > around.machines.length) out.push(`(Only ${around.machines.length} of about ${around.machinesTotal} machines within ${MACHINES_REACH} blocks were checked.)`)
      // 用了哪里的库存；接着管道的另算
      if (held) {
        if (tree.stocked.length > 0) {
          out.push(`Used from storage (${tree.stocked.length}): ${listed(tree.stocked, (t) => {
            const h = held.get(t)
            // 那里一共有多少、在哪（拿几个是上面那个数）
            const where = [...(h && h.carried > 0 ? [`${quantity(h.carried)} on you`] : []), ...(h?.places ?? []).slice(0, 2).map((p) => `${quantity(p.count)} at ${formatPos(p)}`)]
            return `${amount(t, t.fromStock)}${where.length > 0 ? ` (there are ${where.join(', ')}${(h?.places.length ?? 0) > 2 ? ', …' : ''})` : ''}`
          }, '; ')}`)
        }
        const automated = [...held.entries()].filter(([t, h]) => h.automated > 0 && t.needed > 0)
        if (automated.length > 0) out.push(`In containers with pipes or hoppers attached (your owner's automation: not counted, not used): ${listed(automated, ([t, h]) => `${amount(t, h.automated)} (${h.automatedPlaces.slice(0, 2).map((p) => `${formatPos(p)}, ${p.by}`).join('; ')})`, '; ')}`)
      }
      if (unusedChisel.length > 0) out.push(`Chisel steps you gave that nothing here uses: ${unusedChisel.join(', ')}`)
      if (unused.length > 0) out.push(`Recipes you gave that nothing here uses: ${unused.map((r) => `#${r}`).join(', ')}`)
      return out
    }

    // 5. 活儿清单：一批一批，每批里按做法分组
    const waitsOn = (t: TreeThing<Note>): TreeThing<Note>[] => t.inputs.map((input) => input.thing).filter((x) => undecided.includes(x))
    const jobLine = (t: TreeThing<Note>): string => {
      const r = t.recipe!
      const makes = t.rounds * (t.yield ?? 1)
      const toMake = short(t)
      const over = makes - toMake
      const left = over > 0 ? `; ${quantity(over)} left over` : ''
      const stock = t.fromStock > 0 ? `; ${quantity(t.fromStock)} more come from storage` : ''
      // 它要的东西里有还没定做法的：定了、做出来之前这一条开不了工
      const open = waitsOn(t)
      const waits = open.length > 0 ? ` — takes NOT DECIDED: ${open.map((x) => thingName(x, nm, false)).join(', ')}` : ''
      if (isChiselStep(r)) {
        const from = r.in[0] as Extract<RecipeSlot, { kind: 'item' }>
        return `  - chisel (group "${groupOfStep.get(r.ref)}") × ${t.rounds} → ${makes}× ${thingName(t, nm, true)}, from ${t.rounds}× ${nm.label(from.id, from.meta)} [${ruleText(t.note)}]${waits}`
      }
      return `  - #${r.ref} × ${t.rounds} → ${t.fluid ? `${quantity(makes)} mB ${fluidText(t)}` : `${quantity(makes)}× ${thingName(t, nm, true)}`}${left}${stock} [${ruleText(t.note)}]${waits}`
    }
    // 排好的活儿：批次在前，同一批里同一种做法挨着
    const ordered = [...jobs].sort((a, b) => wave.get(a)! - wave.get(b)! || jobs.indexOf(a) - jobs.indexOf(b))
    const grouped: TreeThing<Note>[] = []
    for (let w = 1; w <= waves; w++) {
      const inWave = ordered.filter((t) => wave.get(t) === w)
      const ways = [...new Set(inWave.map((t) => t.recipe!.handler))]
      for (const way of ways) grouped.push(...inWave.filter((t) => t.recipe!.handler === way))
    }
    const cap = ctx.maxResultChars?.() ?? DEFAULT_RESULT_MAX_CHARS
    const from = Math.min(Math.max(1, i.from ?? 1), Math.max(1, grouped.length))
    const cont = from > 1
    let totals = totalsWith(LISTED_MAX)
    for (const listMax of [25, 10, 4]) {
      if (cont || [...head, ...totals].join('\n').length <= cap * TOTALS_SHARE) break
      totals = totalsWith(listMax)
    }
    const before = cont ? [`${forWhat}, the jobs from ${from} on (what is not decided, what is missing and the rest are in the first part).`] : [...head, ...totals]
    const fixed = before.join('\n').length + 200
    const jobLines: string[] = []
    let usedChars = 0
    let shown = 0
    let lastWave = 0
    let lastWay: RecipeHandler | undefined
    for (const t of grouped.slice(from - 1)) {
      const lines: string[] = []
      const w = wave.get(t)!
      if (w !== lastWave) {
        lines.push(w === 1 ? 'Wave 1 — these take only raw materials and what is in storage:' : `Wave ${w} — these take things made in wave ${w - 1} (or earlier):`)
        lastWay = undefined
      }
      const way = t.recipe!.handler
      if (way !== lastWay) {
        if (isChiselStep(t.recipe!)) lines.push('- chisel:')
        else {
          const here = grouped.filter((x) => wave.get(x) === w && x.recipe!.handler === way)
          const states = around.error ? [] : stateOf(way, here)
          const noted = around.error ? [] : around.machines.filter((m) => runsWay(m, way)).map(machineNote).filter((x): x is string => x !== undefined)
          lines.push(`- ${way.name} (${here.length} job(s))${states.length === 1 ? ` — ${states[0]!.text}` : states.length > 1 ? ` — ${states.map((g) => `${g.refs.length}: ${g.text}`).join('; ')}` : ''}${noted.length > 0 ? `\n  ${noted.join('\n  ')}` : ''}`)
        }
      }
      lines.push(jobLine(t))
      const size = lines.join('\n').length + 1
      if (shown > 0 && fixed + usedChars + size > cap) break
      jobLines.push(...lines)
      usedChars += size
      shown++
      lastWave = w
      lastWay = way
    }
    const to = from - 1 + shown
    const range = cont || to < grouped.length ? ` (jobs ${from}–${to} of ${grouped.length}${to < grouped.length ? `; the rest: the same call with from: ${to + 1}` : ''}; data has all of them)` : ''
    const lines = grouped.length > 0 ? [...before, `Jobs, ${grouped.length}, by when they can start and by way${range}:`, ...jobLines] : before

    // ── data：全的 ──
    const heldData = (t: TreeThing<Note>): Record<string, unknown> => {
      const h = held?.get(t)
      return h ? { inStorage: h.free, ...(h.places.length > 0 ? { places: h.places } : {}), ...(h.carried > 0 ? { carried: h.carried } : {}), ...(h.automated > 0 ? { automated: h.automated, automatedPlaces: h.automatedPlaces } : {}) } : {}
    }
    const jobData = (t: TreeThing<Note>): Record<string, unknown> => {
      const r = t.recipe!
      const makes = { ...thingData(t, nm), count: t.rounds * (t.yield ?? 1) }
      const open = waitsOn(t)
      const rule = { rule: t.note?.rule, ...(t.note?.method ? { method: t.note.method.key } : {}), wave: wave.get(t), level: t.level, ...(t.fromStock > 0 ? { fromStock: t.fromStock } : {}), ...(open.length > 0 ? { waitsOn: open.map((x) => thingName(x, nm, false)) } : {}) }
      if (isChiselStep(r)) {
        const src = r.in[0] as Extract<RecipeSlot, { kind: 'item' }>
        return { chisel: { group: groupOfStep.get(r.ref)!, from: { id: src.id, meta: src.meta, name: nm.name(src.id, src.meta) } }, way: 'chisel', rounds: t.rounds, makes, needed: t.needed, ...rule }
      }
      return { recipe: r.ref, way: r.handler.name, rounds: t.rounds, makes, needed: t.needed, ...rule }
    }
    const why = (t: TreeThing<Note>): string => (t.note?.undecided ? 'undecided' : t.loop ? 'loop' : t.unfit ? 'unfit' : t.cut ? 'limit' : t.note?.onlyOther ? 'cannot run' : 'none')
    const steps = jobs.map(jobData)
    return {
      content: lines.join('\n'),
      data: {
        target: liquid ? { fluid: liquid.fluid, name: liquid.name, count } : { ...target, count },
        summary: { toMake: jobs.length, waves, byMethods: byMethod, named: byRule('named'), onlyRecipe: byRule('only'), undecided: undecided.length, missing: missing.length, stock: !wantStock ? 'off' : stockError !== undefined ? 'unknown' : 'used' },
        undecided: undecided.map((t) => ({
          ...thingData(t, nm),
          count: short(t),
          needed: t.needed,
          ...heldData(t),
          ...(t.keptOnly ? { notUsedUp: true } : {}),
          ways: undecidedWays.get(t)!.map((w) => ({ way: w.way.name, recipe: w.recipe.ref, text: recipeText(w.recipe, nm), more: w.more, state: w.state })),
        })),
        missing: missing.map((t) => ({ ...thingData(t, nm), count: short(t), needed: t.needed, why: why(t), ...heldData(t) })),
        // 先做的在前；jobs 是同一批活儿照“哪一批、哪种做法”排的
        steps,
        jobs: grouped.map(jobData),
        raw: tree.raw.map((t) => ({ ...thingData(t, nm), count: t.needed, why: why(t), ...(t.fromStock > 0 ? { fromStock: t.fromStock } : {}) })),
        kept: [...tree.kept.map((t) => ({ ...thingData(t, nm), ...(held ? { inStorage: held.get(t)?.free ?? 0 } : {}) })), ...(usesChisel ? [{ tool: 'chisel', name: '凿子' }] : [])],
        fluids: tree.fluids.map((t) => ({ fluid: t.fluid!.f, name: t.fluid!.name, mb: t.needed })),
        stocked: tree.stocked.map((t) => ({ ...thingData(t, nm), count: t.fromStock, ...heldData(t) })),
        ...(stale.length > 0 ? { stale: stale.map((t) => ({ ...thingData(t, nm), key: t.note!.stale!.key, was: t.note!.stale!.recipe.text })) } : {}),
        unused,
        ...(tree.cut ? { cut: true } : {}),
      },
      keepWhole: true,
    }
  },
}
