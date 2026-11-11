// 给它一个目标（“做一个 XX”）时用得上的工具：这是哪个物品、它怎么做、能拿来做什么、原料存在基地哪里、附近有哪些机器，
// 以及用身上的材料手工合成、用一台 GregTech 机器加工。查的那几个只读。
//
// 找物品、查做法、查用途读本地的物品表和配方册（packdata，中文名、全部配方）；没有本地资料时退回去问服务器（英文、不全）。
// 怎么挑配方写在 crafting 手册里，这里的说明只讲每个工具给什么、要什么。

import { BridgeError } from '../bridge/protocol.ts'
import type { StockQuery } from '../bridge/protocol.ts'
import { formatItemSearch, formatMachines, formatRecipes, formatStock, itemKey } from './format.ts'
import { PLAN_MAX_COUNT, planItemLocal } from './planner.ts'
import { carried, craftGrid, findItemLocal, findRecipesLocal, findTables, findUsesLocal, fitsPocketGrid, isHandCraft, processPlan, quantity, whereItStands } from './recipe-book.ts'
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
export const MACHINES_MAX_LIMIT = 60
export const PROCESS_MAX_INPUTS = 9
export const PROCESS_MAX_ROUNDS = 64
export const PROCESS_WAIT_MIN_SEC = 5
export const PROCESS_WAIT_MAX_SEC = 3600

export const findItem: Tool = {
  name: 'find_item',
  description:
    'Find items by name: words of the Chinese or English name, the id, or an ore-dictionary name (every word must match). Gives the name, id/meta, how many recipes make and use each, and its ore names. Item names are Chinese: search with the words your owner used.',
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
    if (items) return findItemLocal(items, ctx.packdata?.recipes, i)
    // 没有本地物品表：问服务器（它只认英文名）
    const query = i.query.trim()
    const res = await ctx.bridge.itemSearch(query, i.limit)
    return formatItemSearch(query, res.items ?? [])
  },
}

const recipeQuery = {
  id: str('Item id, e.g. "gregtech:gt.metaitem.01".'),
  meta: int('Item meta (default 0).', { min: 0 }),
  way: str('Only this way: a name from the summary, e.g. "卷板机".', { maxLength: 120 }),
  contains: str('Only recipes with an ingredient (for find_uses: or a product) whose name, id or ore name contains this, e.g. "钢".', { maxLength: 60 }),
  page: int('Page of the recipes (10 per page).', { min: 1 }),
}

export const findRecipes: Tool = {
  name: 'find_recipes',
  description:
    'How an item is made (NEI\'s "R"). With only id/meta: every way to make it (a way is one kind of machine, or hand crafting), what each costs, the power tier, and whether a machine or crafting table near you can do it now. With "way", "contains" or "page": the exact recipes, with how many of each ingredient you carry. Every recipe has a # number for craft_item / process_items. How to choose: crafting manual.',
  inputSchema: obj(recipeQuery, ['id']),
  async run(ctx, i: { id: string; meta?: number; way?: string; contains?: string; page?: number }) {
    if (ctx.packdata?.recipes) return findRecipesLocal(ctx, i)
    // 没有本地配方册：问服务器（英文，每种机器只给前几条）
    const machine = i.way?.trim()
    try {
      const res = await ctx.bridge.recipeFind({ id: i.id, ...(i.meta !== undefined ? { meta: i.meta } : {}), ...(machine ? { machine } : {}), bot: ctx.botName })
      return formatRecipes(res, machine ? { machineFilter: machine } : {})
    } catch (e) {
      // 身体的原话里说的是协议方法名（item.search），模型只认得工具名
      if (e instanceof BridgeError && e.code === 'not_found' && /no such item/i.test(e.message)) {
        return fail(`No item ${itemKey({ id: i.id, meta: i.meta ?? 0 })} is known on this server. Use find_item to get the exact id and meta (many GregTech items share one id and differ only in meta).`)
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

export const findUses: Tool = {
  name: 'find_uses',
  description:
    'What an item is used for (NEI\'s "U"): the ways that take it as an ingredient and how many recipes each has. With "way", "contains" or "page": the exact recipes.',
  inputSchema: obj(recipeQuery, ['id']),
  async run(ctx, i: { id: string; meta?: number; way?: string; contains?: string; page?: number }) {
    if (!ctx.packdata?.recipes) return fail('There is no recipe book on this brain, so uses cannot be looked up. find_recipes still works (it asks the game server).')
    return findUsesLocal(ctx, i)
  },
}

export const findInStorage: Tool = {
  name: 'find_in_storage',
  description: `Where things are kept around you, or around a place you give ("at"): for each item (id, with or without meta) or ore-dictionary name, the total and the containers holding the most, with the exact items found there. Looks into every chest, drawer and other inventory within the radius (loaded chunks only). Ask for all the ingredients of a recipe in one call.`,
  inputSchema: obj(
    {
      items: arr(
        'What to look for.',
        obj({
          id: str('Item id. Give either this or "ore".'),
          meta: int('Item meta. Omit to match every meta of that id.', { min: 0 }),
          ore: str('Ore-dictionary name, e.g. "screwSteel": for an ingredient written as "any <ore name>".'),
        }),
        { min: 1, max: STOCK_MAX_ITEMS },
      ),
      radius: int('Search radius in blocks (default 32).', { min: 1, max: STOCK_MAX_RADIUS }),
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
    const radius = i.radius ?? 32
    const from = await lookFrom(ctx, i.at)
    const res = await ctx.bridge.worldStock(from.center, { items: wanted, radius })
    return formatStock(res, radius, from)
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
    'Craft by hand from what you carry (task): give the # number of a hand-crafting recipe from find_recipes or plan_item. Ingredients and tools must be in your inventory; if not, it fails with no_material and lists what is missing. A recipe that needs a crafting table is made at the one nearest to you; leave "table" out unless your owner names one.',
  inputSchema: obj({
    recipe: int('The # number of the recipe, from find_recipes.', { min: 0 }),
    count: int('How many of the product you want (default: one round of the recipe).', { min: 1, max: CRAFT_MAX_COUNT }),
    table: pos('Only when your owner names a crafting table: its position. Omit for the nearest.'),
    id: str('Only without a recipe book: id of the item to make (then "recipe" is the number find_recipes gave).'),
    meta: int('Only without a recipe book: its meta.', { min: 0 }),
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
      return fail(`Recipe #${i.recipe} is a "${recipe.handler.name}" recipe, not hand crafting${recipe.handler.gregtech ? ': run it on a machine with process_items' : ''}.`)
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
  description: `The GregTech machines around you, or around a place you give ("at"), nearest first: single-block machines and the controllers of multiblocks, with what recipes each runs, its tier, power, and whether it is busy; for a multiblock also whether it is formed, its buses and hatches. Steam machines and other mods' machines are not listed.`,
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
    const handlers = ctx.packdata?.recipes?.handlers
    return formatMachines(res, { radius, of: from.of, hint: from.hint, ...(name !== undefined ? { name } : {}), ...(handlers ? { wayName: (key: string) => handlers.find((h) => h.key === key)?.name } : {}) })
  },
}

const stackList = (description: string, max: number) =>
  arr(
    description,
    obj(
      {
        id: str('Item id.'),
        meta: int('Item meta. Omit to match any.', { min: 0 }),
        count: int('How many.', { min: 1 }),
      },
      ['id', 'count'],
    ),
    { min: 1, max },
  )

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
    'Run one batch through a GregTech machine (task): walks to it, puts the inputs in, waits, and takes the products out. Give the machine (for a multiblock: its controller) and the # number of a recipe from find_recipes with "rounds": the inputs, the programmed circuit and the expected products are worked out from it. Everything it consumes, and molds or shapes, must be in your inventory; the programmed circuit is set on the machine, not carried. Details and multiblocks: crafting manual.',
  inputSchema: obj(
    {
      machine: pos('Position of the machine (a multiblock: its controller), as find_machines or find_recipes gives it.'),
      recipe: int('The # number of the recipe, from find_recipes.', { min: 0 }),
      rounds: int('How many times to run the recipe (default 1).', { min: 1, max: PROCESS_MAX_ROUNDS }),
      inputs: stackList('Instead of "recipe": exactly what to put in (things not used up, like a mold, with count 1).', PROCESS_MAX_INPUTS),
      moldInside: bool('true: the mold or shape this recipe needs already sits in the machine, so none is carried or put in.'),
      circuit: int('Programmed circuit number to set (0 clears it). Taken from the recipe when you give one.', { min: 0, max: 24 }),
      fluids: stackList('Multiblock only: cells full of fluid that you carry, to pour into its input hatch. Not needed when the fluid is piped in.', 6),
      expect: stackList('Multiblock only: the products to fetch from the chest its output bus pushes into. Taken from the recipe when you give one.', 9),
      bus: pos('Multiblock only: which input bus to use. Omit to let it pick the emptiest.'),
      wait: int('At most how many seconds to wait for it to finish (default 180). Give more for a big batch.', { min: PROCESS_WAIT_MIN_SEC, max: PROCESS_WAIT_MAX_SEC }),
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
      if (!recipe.handler.gregtech) {
        return fail(`Recipe #${i.recipe} is a "${recipe.handler.name}" recipe, not a GregTech machine recipe${recipe.handler.grid ? ': make it with craft_item' : ', and you cannot run it'}.`)
      }
      const plan = processPlan(recipe, i.rounds ?? 1, await carriedOrNone(ctx), ctx.packdata?.items, i.moldInside === true)
      inputs ??= plan.inputs
      circuit ??= plan.circuit
      expect ??= plan.expect.length > 0 ? plan.expect : undefined
      if (inputs.length === 0 && plan.fluids.length === 0) return fail(`Recipe #${i.recipe} lists nothing to put in.`)
      // 配方要的流体不替它准备：没给装满的单元时提醒一句，免得机器不开工时它不知道差在哪
      if (plan.fluids.length > 0 && i.fluids === undefined) {
        fluidNote = ` This recipe also needs ${plan.fluids.map((f) => `${quantity(f.mb)} mB ${f.name}`).join(' and ')} in all: it has to be in the machine already (piped in, or in its input hatch); if it is not, the machine will not start.`
      }
    }
    if (inputs === undefined) return fail('Give "recipe" (the # number from find_recipes) or "inputs".')
    if (inputs.length > PROCESS_MAX_INPUTS) return fail(`That is ${inputs.length} different inputs; a machine takes at most ${PROCESS_MAX_INPUTS}.`)
    const started = await startTask(ctx, { type: 'process', machine: i.machine, inputs, circuit, fluids: i.fluids, expect, bus: i.bus, wait: i.wait }, i.queue)
    return typeof started === 'string' ? `${started}${fluidNote}` : started
  },
}
