// 给它一个目标（“做一个 XX”）时用得上的工具：这是哪个物品、它怎么做、能拿来做什么、原料存在基地哪里、附近有哪些机器，
// 以及用身上的材料手工合成、用一台 GregTech 机器加工。查的那几个只读。
//
// 找物品、查做法、查用途读本地的物品表和配方册（packdata，中文名、全部配方）；没有本地资料时退回去问服务器（英文、不全）。
// 怎么挑配方写在 crafting 手册里，这里的说明只讲每个工具给什么、要什么。

import { BridgeError } from '../bridge/protocol.ts'
import type { StockQuery, StockResult } from '../bridge/protocol.ts'
import { formatItemSearch, formatMachines, formatRecipes, formatStock, itemKey, nameOf, tankText } from './format.ts'
import type { OtherMachineLine } from './format.ts'
import { PLAN_MAX_COUNT, planItemLocal } from './planner.ts'
import { carried, craftGrid, findItemLocal, findRecipesLocal, findTables, findUsesLocal, fitsPocketGrid, fluidInside, isHandCraft, isMachineWay, otherMachines, processPlan, quantity, spread, whereItStands } from './recipe-book.ts'
import type { Carried } from './recipe-book.ts'
import { arr, bool, int, obj, str } from './schema.ts'
import { pos, queue, startTask } from './tasks.ts'
import { fail } from './types.ts'
import { AT, lookFrom } from './where.ts'
import type { At } from './where.ts'
import type { Tool, ToolContext } from './types.ts'

// 协议里的上限
export const SEARCH_MAX_LIMIT = 40
export const STOCK_MAX_ITEMS = 24
export const STOCK_MAX_RADIUS = 64
export const CRAFT_MAX_COUNT = 2304
export const CRAFT_MAX_ROUNDS = 64
export const MACHINES_MAX_RADIUS = 64
/** find_in_storage 看整个基地时，四个查询点各往斜方向错开这么多格。 */
const WIDE_STOCK_STEP = 48
/** 身体不认识的机器是从容器里认出来的，容器一次最多看 32 格。 */
const OTHER_MACHINES_RADIUS = 32
export const MACHINES_MAX_LIMIT = 60
export const PROCESS_MAX_INPUTS = 9
export const PROCESS_MAX_ROUNDS = 64
export const PROCESS_WAIT_MIN_SEC = 5
export const PROCESS_WAIT_MAX_SEC = 3600

export const findItem: Tool = {
  name: 'find_item',
  description:
    'Find items, and fluids, by name: words of the Chinese or English name, the id, or an ore-dictionary name (every word must match). Gives the name, id/meta, how many recipes make and use each, its ore names, and its chisel group if it is in one; a fluid with its internal name. Names are the Chinese ones shown in the game, the ones your owner says.',
  inputSchema: obj(
    {
      query: str('Words to look for, e.g. "钢板", "electric motor", "plateSteel".', { maxLength: 80 }),
      page: int('Page of the matches (default 1).', { min: 1 }),
      limit: int('Matches per page (default 12).', { min: 1, max: SEARCH_MAX_LIMIT }),
    },
    ['query'],
  ),
  async run(ctx, i: { query: string; page?: number; limit?: number }) {
    const items = ctx.packdata?.items
    if (items) return findItemLocal(items, ctx.packdata?.recipes, i, ctx.packdata?.carving, ctx.packdata?.fluids)
    // 没有本地物品表：问服务器（它只认英文名）
    const query = i.query.trim()
    const res = await ctx.bridge.itemSearch(query, i.limit)
    return formatItemSearch(query, res.items ?? [])
  },
}

const recipeQuery = {
  id: str('Item id, e.g. "gregtech:gt.metaitem.01".'),
  meta: int('Item meta (default 0).', { min: 0 }),
  fluid: str('Instead of "id": a fluid, by name or internal name, e.g. "熔融钢", "molten.steel".', { maxLength: 80 }),
  way: str('Only this way: a name from the summary, e.g. "卷板机".', { maxLength: 120 }),
  contains: str('Only recipes with an ingredient whose name, id or ore name contains this, e.g. "钢".', { maxLength: 60 }),
  circuit: int('Only recipes with this programmed circuit.', { min: 0, max: 24 }),
  page: int('Page of the recipes (10 per page).', { min: 1 }),
}

export const findRecipes: Tool = {
  name: 'find_recipes',
  description:
    'How an item or a fluid is made (NEI\'s "R"). With only id/meta or "fluid": every way to make it (a way is one kind of machine, or hand crafting), what each costs, the power tier, and whether a machine or crafting table near you can do it now. With "way", "contains", "circuit" or "page": the exact recipes with everything they take and give, and how many of each ingredient you carry. Every recipe has a # number for craft_item / process_items. How to choose: crafting manual.',
  inputSchema: obj(recipeQuery),
  async run(ctx, i: { id?: string; meta?: number; fluid?: string; way?: string; contains?: string; circuit?: number; page?: number }) {
    if (ctx.packdata?.recipes) return findRecipesLocal(ctx, i)
    // 没有本地配方册：问服务器（英文，每种机器只给前几条；只能按物品问）
    if (i.id === undefined) return fail('There is no recipe book on this brain: only an item ("id") can be asked about, from the game server.')
    const id = i.id
    const machine = i.way?.trim()
    try {
      const res = await ctx.bridge.recipeFind({ id, ...(i.meta !== undefined ? { meta: i.meta } : {}), ...(machine ? { machine } : {}), bot: ctx.botName })
      return formatRecipes(res, machine ? { machineFilter: machine } : {})
    } catch (e) {
      // 身体的原话里说的是协议方法名（item.search），模型只认得工具名
      if (e instanceof BridgeError && e.code === 'not_found' && /no such item/i.test(e.message)) {
        return fail(`No item ${itemKey({ id, meta: i.meta ?? 0 })} is known on this server. Use find_item to get the exact id and meta (many GregTech items share one id and differ only in meta).`)
      }
      throw e
    }
  },
}

export const planItem: Tool = {
  name: 'plan_item',
  description:
    'Work out how to make an item, all the way down to what is in storage: looks through the storage and machines of the whole base around you (about 100 blocks each way), picks for every part the way that wastes least, counts the amounts, and returns the steps to do in order (ready-made tool calls), what is missing, and what to ask your owner first. When asked to make something, call this first and follow its steps.',
  inputSchema: obj(
    {
      id: str('Item id, e.g. "gregtech:gt.metaitem.01" (from find_item).'),
      meta: int('Item meta (default 0).', { min: 0 }),
      count: int('How many you want (default 1).', { min: 1, max: PLAN_MAX_COUNT }),
      page: int('Page of the steps (default 1).', { min: 1 }),
      borrow: bool('false: do not take molds or shapes out of machines (your owner said no); have them made instead.'),
    },
    ['id'],
  ),
  run: (ctx, i: { id: string; meta?: number; count?: number; page?: number; borrow?: boolean }) => planItemLocal(ctx, i),
}

/** 库函数（不在发给模型的清单里：程序里调，模型直接调也照常执行）。 */
export const findUses: Tool = {
  name: 'find_uses',
  brief: '{id | fluid, meta?, way?, contains?, circuit?, page?}: recipes that use an item or fluid -> ways[{way, recipes}]; with way/contains/circuit/page: recipes[{recipe, in, out, fluidsIn, fluidsOut}]',
  description:
    'What an item or a fluid is used for (NEI\'s "U"): the ways that take it as an ingredient and how many recipes each has. With "way", "contains", "circuit" or "page": the exact recipes, with everything they take and give.',
  inputSchema: obj({ ...recipeQuery, contains: str('Only recipes with a product or another ingredient whose name, id or ore name contains this, e.g. "钢".', { maxLength: 60 }) }),
  async run(ctx, i: { id?: string; meta?: number; fluid?: string; way?: string; contains?: string; circuit?: number; page?: number }) {
    if (!ctx.packdata?.recipes) return fail('There is no recipe book on this brain, so uses cannot be looked up. find_recipes still works (it asks the game server).')
    return findUsesLocal(ctx, i)
  },
}

export const findInStorage: Tool = {
  name: 'find_in_storage',
  description: `Where things are kept around you or around "at": for each item or ore-dictionary name, the total and the containers holding the most, with the exact items found there. Looks into every chest, drawer and other inventory within the radius, and into the covers on machines that hold items (loaded chunks only).`,
  inputSchema: obj(
    {
      items: arr(
        'What to look for, each {id, meta?} (no meta: every meta of that id) or {ore}: an ore-dictionary name such as "screwSteel", for an ingredient written "any <ore name>".',
        obj({ id: str(), meta: int(undefined, { min: 0 }), ore: str() }),
        { min: 1, max: STOCK_MAX_ITEMS },
      ),
      radius: int('Search radius in blocks. Without it and without "at": the whole base, about 110 blocks each way.', { min: 1, max: STOCK_MAX_RADIUS }),
      at: AT,
    },
    ['items'],
  ),
  async run(ctx, i: { items: { id?: string; meta?: number; ore?: string }[]; radius?: number; at?: At }) {
    const wanted: StockQuery[] = []
    for (const [n, it] of i.items.entries()) {
      if ((it.id === undefined) === (it.ore === undefined)) return fail(`items[${n}] needs exactly one of "id" (an item) or "ore" (an ore-dictionary name)`)
      if (it.ore !== undefined) wanted.push({ ore: it.ore })
      else wanted.push(it.meta === undefined ? { id: it.id! } : { id: it.id!, meta: it.meta })
    }
    // 没说看哪、看多远：看整个基地——身体一次最多看 64 格，往四周错开四个点各查一次再合起来（每个方向一百来格）
    const me = i.radius === undefined && i.at === undefined ? await whereItStands(ctx) : undefined
    if (me) {
      const answers = await Promise.all(spread(me, WIDE_STOCK_STEP).map((c) => ctx.bridge.worldStock(c, { items: wanted, radius: STOCK_MAX_RADIUS })))
      const merged: StockResult = {
        containersLookedInto: Math.max(0, ...answers.map((a) => a.containersLookedInto ?? 0)),
        items: wanted.map((q, n) => {
          // 四次查询的范围有重叠：同一个容器只算一次
          const places = new Map<string, NonNullable<NonNullable<StockResult['items']>[number]['places']>[number]>()
          // 同一个方块自己的格子和它各个面上的覆盖板是不同的存放点
          for (const a of answers) for (const place of a.items?.[n]?.places ?? []) places.set(`${place.x},${place.y},${place.z},${place.kind === 'cover' ? (place.side ?? '') : ''}`, place)
          const listed = [...places.values()].sort((x, y) => y.count - x.count)
          const total = Math.max(listed.reduce((sum, place) => sum + place.count, 0), ...answers.map((a) => a.items?.[n]?.total ?? 0))
          // 身体每样最多列几处：还有没列出来的照实带上
          const more = Math.max(0, ...answers.map((a) => a.items?.[n]?.morePlaces ?? 0))
          return { ...q, total, places: listed, ...(more > 0 ? { morePlaces: more } : {}) }
        }),
      }
      return { content: formatStock(merged, WIDE_STOCK_STEP + STOCK_MAX_RADIUS, { of: 'you (the whole base, as far as chunks are loaded)', hint: '' }), data: merged }
    }
    const radius = i.radius ?? 32
    const from = await lookFrom(ctx, i.at)
    const res = await ctx.bridge.worldStock(from.center, { items: wanted, radius })
    // data：给程序用的原样结果（每样东西的 total 和 places）
    return { content: formatStock(res, radius, from), data: res }
  },
}

/** 离它现在站的地方最近的合成台（身体认的那几种）；附近没有、或者问不到，就是 undefined。 */
async function nearestTable(ctx: ToolContext): Promise<{ x: number; y: number; z: number } | undefined> {
  try {
    const me = await whereItStands(ctx)
    const nearest = me ? (await findTables(ctx, me, 1))[0] : undefined
    return nearest ? { x: nearest.x, y: nearest.y, z: nearest.z } : undefined
  } catch (e) {
    if (e instanceof BridgeError) return undefined
    throw e
  }
}

/** 身上现在有什么；问不到（没连上、不在线）就当不知道。 */
async function carriedOrNone(ctx: ToolContext): Promise<Carried | undefined> {
  try {
    const status = await ctx.bridge.botStatus(ctx.botName)
    return carried(status.inventory ?? [], ctx.packdata?.items)
  } catch (e) {
    if (e instanceof BridgeError) return undefined
    throw e
  }
}

export const craftItem: Tool = {
  name: 'craft_item',
  description:
    'Craft by hand from what you carry (task), by the # number of a hand-crafting recipe from find_recipes. Ingredients and tools must be in your inventory; if not, it fails with no_material and lists what is missing. A recipe that needs a crafting table is made at the one nearest to you.',
  inputSchema: obj({
    recipe: int('Recipe # from find_recipes.', { min: 0 }),
    count: int('How many of the product (default: one round of the recipe).', { min: 1, max: CRAFT_MAX_COUNT }),
    table: pos('A particular crafting table to use instead of the nearest.'),
    id: str('Only on a brain without a recipe book: id of the item to make.'),
    meta: int('With "id": its meta.', { min: 0 }),
    queue,
  }),
  async run(ctx, i: { recipe?: number; count?: number; table?: unknown; id?: string; meta?: number; queue?: boolean }) {
    const book = ctx.packdata?.recipes
    if (!book) {
      // 没有本地配方册：按服务器自己知道的配方做
      if (i.id === undefined) return fail('There is no recipe book on this brain: give "id" (and "meta") of the item, with "recipe" as numbered by find_recipes.')
      return startTask(ctx, { type: 'craft', id: i.id, meta: i.meta, count: i.count, recipe: i.recipe, table: i.table }, i.queue)
    }
    if (i.recipe === undefined) return fail('Give "recipe": the # number of a hand-crafting recipe from find_recipes.')
    const recipe = book.get(i.recipe)
    if (!recipe) return fail(`There is no recipe #${i.recipe}. Take the number from find_recipes (numbers change when the recipe book is re-exported).`)
    if (!isHandCraft(recipe)) {
      return fail(`Recipe #${i.recipe} is a "${recipe.handler.name}" recipe, not hand crafting${isMachineWay(recipe.handler) ? ': run it on a machine with process_items' : ''}.`)
    }
    const product = recipe.out[0]
    if (!product) return fail(`Recipe #${i.recipe} lists no product.`)
    const rounds = Math.ceil((i.count ?? product.n) / product.n)
    if (rounds > CRAFT_MAX_ROUNDS) {
      return fail(`${i.count} would take ${rounds} rounds of this recipe (${quantity(product.n)} per round); one task does at most ${CRAFT_MAX_ROUNDS} rounds (${CRAFT_MAX_ROUNDS * product.n}). Split it into several tasks.`)
    }
    const grid = craftGrid(recipe, await carriedOrNone(ctx))
    // 要工作台又没指定：现在就动手的，找离它此刻最近的一个交给身体（它查做法和动手合成常常不在同一个地方）；
    // 排队的不知道轮到时它在哪，留给身体到时自己找
    const table = i.table ?? (i.queue || fitsPocketGrid(recipe) ? undefined : await nearestTable(ctx))
    return startTask(ctx, { type: 'craft', grid, gives: { id: product.id, meta: product.meta }, rounds, table }, i.queue)
  },
}

export const findMachines: Tool = {
  name: 'find_machines',
  description: `The machines around you or around "at", nearest first. GregTech machines and multiblock controllers: what recipes each runs, its tier, power, whether it is busy; for a multiblock also whether it is formed, its buses and hatches. Then other mods' machines and furnaces, whose state cannot be read.`,
  inputSchema: obj({
    name: str('Only machines whose name or recipe type contains this (English), e.g. "Lathe".', { maxLength: 60 }),
    radius: int('Search radius in blocks (default 32).', { min: 1, max: MACHINES_MAX_RADIUS }),
    limit: int('How many to return (default 30).', { min: 1, max: MACHINES_MAX_LIMIT }),
    at: AT,
  }),
  async run(ctx, i: { name?: string; radius?: number; limit?: number; at?: At }) {
    const name = i.name?.trim() || undefined
    const radius = i.radius ?? 32
    const from = await lookFrom(ctx, i.at)
    const res = await ctx.bridge.worldMachines(
      from.center,
      { radius, ...(name !== undefined ? { name } : {}), ...(i.limit !== undefined ? { limit: i.limit } : {}) },
    )
    const book = ctx.packdata?.recipes
    const handlers = book?.handlers
    const wayName = (key: string): string | undefined => handlers?.find((h) => h.key === key)?.name
    // 身体不认识的机器（别的 mod 的、熔炉）：把同一片地方的容器看一遍，照配方册认
    let others: OtherMachineLine[] = []
    if (book) {
      try {
        const seen = await ctx.bridge.worldContainers(from.center, { radius: Math.min(radius, OTHER_MACHINES_RADIUS), limit: 100 })
        const word = name?.toLowerCase()
        others = otherMachines(seen.containers ?? [], res.machines ?? [], book, ctx.packdata?.items)
          .map((o) => ({ ...o, wayNames: o.ways.map((key) => wayName(key) ?? key) }))
          .filter((o) => word === undefined || `${o.name ?? ''}\n${nameOf(o.item) ?? ''}\n${o.wayNames.join('\n')}`.toLowerCase().includes(word))
      } catch (e) {
        // 容器看不了时，身体认识的那些机器照样给
        if (!(e instanceof BridgeError)) throw e
      }
    }
    // data：身体的原样回答（每台机器的状态、总线和仓、覆盖板、流体罐），加上照配方册认出来的别的机器
    return { content: formatMachines(res, { radius, of: from.of, hint: from.hint, others, ...(name !== undefined ? { name } : {}), ...(handlers ? { wayName } : {}) }), data: { machines: res.machines ?? [], total: res.total ?? res.machines?.length ?? 0, others } }
  },
}

/** 一台机器的罐里现在有没有配方要的那几种流体：读得到就说有多少，读不到就说读不到。 */
async function tankNote(ctx: ToolContext, machine: unknown, fluids: readonly { f: string; name: string; mb: number }[]): Promise<string> {
  const at = machine as { x?: unknown; y?: unknown; z?: unknown }
  if (typeof at.x !== 'number' || typeof at.y !== 'number' || typeof at.z !== 'number') return ''
  const pos = { x: at.x, y: at.y, z: at.z }
  try {
    // 身体认识的机器：多方块看输入仓，单方块看它自己的罐
    const near = await ctx.bridge.worldMachines(pos, { radius: 2 })
    const m = (near.machines ?? []).find((x) => x.x === pos.x && x.y === pos.y && x.z === pos.z)
    if (m && (m.kind === 'multiblock' || m.tanks !== undefined)) {
      const have = fluids.map((f) => `${quantity(fluidInside(m, f.f) ?? 0)} mB ${f.name}`)
      return `${m.kind === 'multiblock' ? 'Its input hatches' : 'Its tanks'} now hold ${have.join(', ')}.`
    }
    // 别的方块：它自己报的罐
    const block = await ctx.bridge.worldBlock(pos)
    if (block.tanks !== undefined) {
      const have = fluids.map((f) => `${quantity(block.tanks!.filter((t) => t.fluid === f.f).reduce((n, t) => n + (t.amount ?? 0), 0))} mB ${f.name}`)
      return `Its tanks now hold ${have.join(', ')} (${block.tanks.map(tankText).join('; ')}).`
    }
    return 'What its tanks hold is not reported; inspect_block with "detail" shows everything the machine keeps.'
  } catch (e) {
    if (!(e instanceof BridgeError)) throw e
    return 'What its tanks hold could not be read just now.'
  }
}

/** 一组“什么东西、几个”。每一项怎么写由那个参数的说明讲（“each {id, meta?, count}”），不在每一格里重复。 */
const stackList = (description: string, max: number) => arr(description, obj({ id: str(), meta: int(undefined, { min: 0 }), count: int(undefined, { min: 1 }) }, ['id', 'count']), { min: 1, max })

interface ProcessInput {
  machine: unknown
  recipe?: number
  rounds?: number
  inputs?: unknown[]
  moldInside?: boolean
  circuit?: number
  fluids?: unknown[]
  expect?: unknown[]
  bus?: unknown
  wait?: number
  queue?: boolean
}

export const processItems: Tool = {
  name: 'process_items',
  description:
    'Run one batch through a machine (task): walks to it, puts the inputs in, waits, and takes the products out. Any block with a screen that takes items works (a multiblock: give its controller). Give "recipe" and "rounds", or "inputs" yourself. Everything it consumes, and a mold or shape, must be in your inventory; the programmed circuit is set on the machine, not carried. Details: crafting manual.',
  inputSchema: obj(
    {
      machine: pos('Position of the machine (a multiblock: its controller).'),
      recipe: int('Recipe # from find_recipes: the inputs, the circuit and the products to expect are taken from it.', { min: 0 }),
      rounds: int('Times to run the recipe (default 1).', { min: 1, max: PROCESS_MAX_ROUNDS }),
      inputs: stackList('Instead of "recipe": exactly what to put in, each {id, meta?, count}; what is not used up (a mold) with count 1.', PROCESS_MAX_INPUTS),
      moldInside: bool('true: the mold or shape the recipe needs already sits in the machine; none is put in.'),
      circuit: int('Programmed circuit number to set (0 clears it). Default: the recipe\'s.', { min: 0, max: 24 }),
      fluids: stackList('Multiblock only: full fluid cells you carry, each {id, meta?, count}, to pour into its input hatch.', 6),
      expect: stackList('Multiblock only: products to fetch from the chest its output bus pushes into, each {id, meta?, count}. Default: the recipe\'s.', 9),
      bus: pos('Multiblock only: the input bus to use. Default: the emptiest.'),
      wait: int('Seconds to wait for it to finish, at most (default 180).', { min: PROCESS_WAIT_MIN_SEC, max: PROCESS_WAIT_MAX_SEC }),
      queue,
    },
    ['machine'],
  ),
  async run(ctx, i: ProcessInput) {
    let inputs = i.inputs
    let circuit = i.circuit
    let expect = i.expect
    let fluidNote = ''
    if (i.recipe !== undefined) {
      const book = ctx.packdata?.recipes
      if (!book) return fail('There is no recipe book on this brain: give "inputs" (and "circuit") yourself.')
      const recipe = book.get(i.recipe)
      if (!recipe) return fail(`There is no recipe #${i.recipe}. Take the number from find_recipes (numbers change when the recipe book is re-exported).`)
      // 哪个 mod 的机器都行：身体认识的（GregTech）读得懂状态，别的照玩家的办法把原料点进去、等、取产物
      if (!isMachineWay(recipe.handler)) {
        return fail(`Recipe #${i.recipe} is a "${recipe.handler.name}" recipe, not a machine recipe${recipe.handler.grid ? ': make it with craft_item' : ': no machine does it'}.`)
      }
      const plan = processPlan(recipe, i.rounds ?? 1, await carriedOrNone(ctx), ctx.packdata?.items, i.moldInside === true)
      inputs ??= plan.inputs
      circuit ??= plan.circuit
      expect ??= plan.expect.length > 0 ? plan.expect : undefined
      if (inputs.length === 0 && plan.fluids.length === 0) return fail(`Recipe #${i.recipe} lists nothing to put in.`)
      // 配方要的流体不替它准备：没给装满的单元时，照实说这台机器的罐里现在有什么（读得到的话），免得不开工时它不知道差在哪
      if (plan.fluids.length > 0 && i.fluids === undefined) {
        const need = plan.fluids.map((f) => `${quantity(f.mb)} mB ${f.name}`).join(' and ')
        fluidNote = ` This recipe also takes ${need} in all, from inside the machine (its tank, or a multiblock's input hatch). ${await tankNote(ctx, i.machine, plan.fluids)}`
      }
    }
    if (inputs === undefined) return fail('Give "recipe" (the # number from find_recipes) or "inputs".')
    if (inputs.length > PROCESS_MAX_INPUTS) return fail(`That is ${inputs.length} different inputs; a machine takes at most ${PROCESS_MAX_INPUTS}.`)
    const started = await startTask(ctx, { type: 'process', machine: i.machine, inputs, circuit, fluids: i.fluids, expect, bus: i.bus, wait: i.wait }, i.queue)
    return typeof started === 'string' ? `${started}${fluidNote}` : started
  },
}
