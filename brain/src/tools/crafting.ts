// 给它一个目标（“做一个 XX”）时用得上的工具：这是哪个物品、它怎么做、能拿来做什么、原料存在基地哪里、附近有哪些机器，
// 以及用身上的材料手工合成、用一台 GregTech 机器加工。查的那几个只读。
//
// 找物品、查做法、查用途读本地的物品表和配方册（packdata，中文名、全部配方）；没有本地资料时退回去问服务器（英文、不全）。
// 怎么挑配方写在 crafting 手册里，这里的说明只讲每个工具给什么、要什么。

import { BridgeError } from '../bridge/protocol.ts'
import type { StockQuery, StockResult } from '../bridge/protocol.ts'
import { formatItemSearch, formatMachines, formatRecipes, formatStock, itemKey, nameOf, tankText } from './format.ts'
import type { OtherMachineLine } from './format.ts'
import { carried, craftGrid, findItemLocal, findRecipesLocal, findTables, findUsesLocal, fitsPocketGrid, fluidInside, isHandCraft, isMachineWay, otherMachines, processPlan, quantity, whereItStands } from './recipe-book.ts'
import type { Carried } from './recipe-book.ts'
import { guideNote, itemOfBlock } from './guide.ts'
import { thingKeyOfFluid, thingKeyOfSlot } from './material-tree.ts'
import { methodNoteForMachine, methodNoteForThing } from './methods.ts'
import { arr, bool, int, obj, pos, str } from './schema.ts'
import { queue, startTask } from './tasks.ts'
import { fail } from './types.ts'
import { BASE_RADIUS, eachPiece, pieces, piecesText, spotOf } from './reach.ts'
import { AT, lookFrom } from './where.ts'
import type { At } from './where.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

// 协议里的上限
export const SEARCH_MAX_LIMIT = 40
export const STOCK_MAX_ITEMS = 24
export const STOCK_MAX_RADIUS = 64
export const CRAFT_MAX_COUNT = 2304
export const CRAFT_MAX_ROUNDS = 64
export const MACHINES_MAX_RADIUS = 64
/** find_in_storage 看整个基地时，四个查询点各往斜方向错开这么多格。 */
/** 看一大片时，文字里每样东西列最多的这么几处（data 里是全的）。 */
const STOCK_PLACES_SHOWN = 6
/** 身体不认识的机器是从容器里认出来的，容器一次最多看 32 格。 */
const OTHER_MACHINES_RADIUS = 32
export const MACHINES_MAX_LIMIT = 60
const MACHINES_DEFAULT_LIMIT = 30
export const PROCESS_MAX_INPUTS = 9
export const PROCESS_MAX_ROUNDS = 64
export const PROCESS_WAIT_MIN_SEC = 5
export const PROCESS_WAIT_MAX_SEC = 3600

export const findItem: Tool = {
  name: 'find_item',
  description:
    'Find items, and fluids, by name: words of the Chinese or English name, the id, or an ore-dictionary name (every word must match). Gives the name, id/meta, how many recipes make and use each, its ore names, and its chisel group if it is in one; a fluid with its internal name. Names are the Chinese ones shown in the game, the ones your owner says. ' +
    'With 5 or fewer items listed, each also has its tooltip (what a player reads hovering over it) and its page in the in-game guide; an id/meta as query is that one item.',
  inputSchema: obj({
    query: str('Words to look for, e.g. "钢板", "electric motor", "plateSteel".', { maxLength: 80 }),
    tip: str('Words that must be in its tooltip, e.g. "覆盖板"; alone or with query.', { maxLength: 80 }),
    page: int('Page of the matches (default 1).', { min: 1 }),
    limit: int('Matches per page (default 12).', { min: 1, max: SEARCH_MAX_LIMIT }),
  }),
  async run(ctx, i: { query?: string; tip?: string; page?: number; limit?: number }) {
    const items = ctx.packdata?.items
    if (items) return findItemLocal(items, ctx.packdata?.recipes, i, { carving: ctx.packdata?.carving, fluids: ctx.packdata?.fluids, guide: ctx.packdata?.guide, tooltips: ctx.packdata?.tooltips })
    // 没有本地物品表：问服务器（它只认英文名）
    const query = (i.query ?? '').trim()
    if (query.length === 0) return fail('Give "query": without the local item table only names can be searched, on the game server.')
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

/**
 * 查一样东西的做法时：基地的做法里定过它（这一样，或者它这一类零件）的话，在结果的第一行后面说一句。
 * 只陈述记录里写了什么；列出来的做法照旧是全的、照配方册的先后。
 */
function withMethodNote(ctx: ToolContext, i: { id?: string; meta?: number; fluid?: string }, res: ToolResult | string): ToolResult | string {
  const methods = ctx.methods
  if (!methods || (typeof res !== 'string' && res.isError)) return res
  const env = { book: ctx.packdata?.recipes, items: ctx.packdata?.items }
  let thing: { key: string; members: { id: string; meta: number }[] } | undefined
  if (typeof i.id === 'string' && i.id.trim().length > 0) {
    const item = { id: i.id.trim(), meta: i.meta ?? 0 }
    thing = { key: thingKeyOfSlot({ kind: 'item', ...item, n: 1 }, env.items), members: [item] }
  } else if (typeof i.fluid === 'string') {
    const table = ctx.packdata?.fluids
    const wanted = i.fluid.trim()
    const found = table?.get(wanted) ? [table.get(wanted)!] : (table?.search(wanted).exact ?? [])
    if (found.length === 1) thing = { key: thingKeyOfFluid(found[0]!.fluid), members: [] }
  }
  const note = thing ? methodNoteForThing(methods, env, thing) : undefined
  if (note === undefined) return res
  const content = typeof res === 'string' ? res : res.content
  const cut = content.indexOf('\n')
  const noted = cut === -1 ? `${content}\n${note}` : `${content.slice(0, cut)}\n${note}${content.slice(cut)}`
  return typeof res === 'string' ? noted : { ...res, content: noted }
}

export const findRecipes: Tool = {
  name: 'find_recipes',
  description:
    'How an item or a fluid is made (NEI\'s "R"). With only id/meta or "fluid": every way to make it (a way is one kind of machine, or hand crafting), what each costs, the power tier, and whether a machine or crafting table near you can do it now. With "way", "contains", "circuit" or "page": the exact recipes with everything they take and give, and how many of each ingredient you carry. Every recipe has a # number for craft_item / process_items. How to choose: crafting manual.',
  inputSchema: obj(recipeQuery),
  async run(ctx, i: { id?: string; meta?: number; fluid?: string; way?: string; contains?: string; circuit?: number; page?: number }) {
    if (ctx.packdata?.recipes) return withMethodNote(ctx, i, await findRecipesLocal(ctx, i))
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
      radius: int(`Search radius in blocks, up to ${BASE_RADIUS}. Without it: 32 around "at"; without both, the whole base (${BASE_RADIUS} each way).`, { min: 1, max: BASE_RADIUS }),
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
    // 没说看多远：给了 at 看它周围 32 格；也没给 at 是看整个基地（它周围 BASE_RADIUS 格）
    const radius = i.radius ?? (i.at === undefined ? BASE_RADIUS : 32)
    // 比身体一次看得了的远：切成每个方向 64 格的几块，各查一次再合起来（块挨着不重叠，同一个容器只会在一块里）
    if (radius > STOCK_MAX_RADIUS) {
      const where = await spotOf(ctx, i.at)
      if (!where) return fail(`${ctx.botName} is not in the game world, so there is no "around you" to look at: give "at".`)
      const started = Date.now()
      const cut = pieces(where.spot, radius, STOCK_MAX_RADIUS)
      const answers = await eachPiece(cut.centers, (center) => ctx.bridge.worldStock(center, { items: wanted, radius: STOCK_MAX_RADIUS }))
      const merged: StockResult = {
        containersLookedInto: answers.reduce((n, a) => n + (a.containersLookedInto ?? 0), 0),
        items: wanted.map((q, n) => {
          // 同一个方块自己的格子和它各个面上的覆盖板是不同的存放点
          const places = new Map<string, NonNullable<NonNullable<StockResult['items']>[number]['places']>[number]>()
          for (const a of answers) for (const place of a.items?.[n]?.places ?? []) places.set(`${place.x},${place.y},${place.z},${place.kind === 'cover' ? (place.side ?? '') : ''}`, place)
          const listed = [...places.values()].sort((x, y) => y.count - x.count)
          const total = answers.reduce((sum, a) => sum + (a.items?.[n]?.total ?? 0), 0)
          // 每一块最多列几处：没列出来的照实带上
          const more = answers.reduce((sum, a) => sum + (a.items?.[n]?.morePlaces ?? 0), 0)
          return { ...q, total: Math.max(total, listed.reduce((sum, p) => sum + p.count, 0)), places: listed, ...(more > 0 ? { morePlaces: more } : {}) }
        }),
      }
      // 文字里每样东西列最多的几处（data 里是全的）
      const shown: StockResult = { ...merged, items: merged.items!.map((it) => ({ ...it, places: (it.places ?? []).slice(0, STOCK_PLACES_SHOWN), ...((it.places ?? []).length > STOCK_PLACES_SHOWN || it.morePlaces ? { morePlaces: (it.morePlaces ?? 0) + Math.max(0, (it.places ?? []).length - STOCK_PLACES_SHOWN) } : {}) })) }
      return { content: formatStock(shown, radius, { of: where.of, hint: '', looked: `looked ${piecesText(cut, Date.now() - started)}` }), data: merged }
    }
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
    name: str('Only machines whose name or recipe type contains this, Chinese or English, e.g. "车床", "Lathe".', { maxLength: 60 }),
    radius: int('Search radius in blocks (default 32).', { min: 1, max: MACHINES_MAX_RADIUS }),
    limit: int('How many to return (default 30).', { min: 1, max: MACHINES_MAX_LIMIT }),
    at: AT,
  }),
  async run(ctx, i: { name?: string; radius?: number; limit?: number; at?: At }) {
    const name = i.name?.trim() || undefined
    const radius = i.radius ?? 32
    const from = await lookFrom(ctx, i.at)
    const book = ctx.packdata?.recipes
    const handlers = book?.handlers
    const wayName = (key: string): string | undefined => handlers?.find((h) => h.key === key)?.name
    // 身体按名字筛只认它自己的英文名。名字写的是中文（结果里写的就是中文名）：把范围里的都要来，在这边照中文名和配方页的中文名筛
    const chinese = name !== undefined && /[^\x00-\x7f]/.test(name)
    const asked = await ctx.bridge.worldMachines(
      from.center,
      { radius, ...(name !== undefined && !chinese ? { name } : {}), ...(chinese ? { limit: MACHINES_MAX_LIMIT } : i.limit !== undefined ? { limit: i.limit } : {}) },
    )
    let res = asked
    // 范围里的机器比一次要得来的多时，没要来的那些这边筛不到：照实说
    let unseen = ''
    if (chinese) {
      const word = name!.toLowerCase()
      const all = asked.machines ?? []
      const kept = all.filter((m) => `${nameOf(m) ?? ''}\n${typeof m.recipeKey === 'string' ? (wayName(m.recipeKey) ?? '') : ''}`.toLowerCase().includes(word))
      res = { ...asked, machines: kept.slice(0, i.limit ?? MACHINES_DEFAULT_LIMIT), total: kept.length }
      const inRange = asked.total ?? all.length
      if (inRange > all.length) unseen = `\nOnly the nearest ${all.length} of the ${inRange} machines in range were looked at for that Chinese name: a smaller radius, or the English name, covers the others.`
    }
    // 身体不认识的机器（别的 mod 的、熔炉）：把同一片地方的容器看一遍，照配方册认
    let others: OtherMachineLine[] = []
    if (book) {
      try {
        const seen = await ctx.bridge.worldContainers(from.center, { radius: Math.min(radius, OTHER_MACHINES_RADIUS), limit: 100 })
        const word = name?.toLowerCase()
        others = otherMachines(seen.containers ?? [], asked.machines ?? [], book, ctx.packdata?.items)
          .map((o) => ({ ...o, wayNames: o.ways.map((key) => wayName(key) ?? key) }))
          .filter((o) => word === undefined || `${o.name ?? ''}\n${nameOf(o.item) ?? ''}\n${o.wayNames.join('\n')}`.toLowerCase().includes(word))
      } catch (e) {
        // 容器看不了时，身体认识的那些机器照样给
        if (!(e instanceof BridgeError)) throw e
      }
    }
    // 游戏内指南里讲这种机器的页：每一页只在头一台那里说一次
    const guide = ctx.packdata?.guide
    const told = new Set<string>()
    const guideOf = (item: { id: string; meta?: number } | undefined): string | undefined => {
      const note = item ? guideNote(guide, item.id, item.meta) : undefined
      if (note === undefined || told.has(note)) return undefined
      told.add(note)
      return note
    }
    // 身体给机器的 id + meta 就是它作为物品的那一对（和配方页的 machines 一样）；没给全的拿它的英文名到物品表里对
    const guideLine = guide
      ? (m: { id?: string; meta?: number; name?: string; item?: { id: string; meta: number } }) =>
          guideOf(m.item ?? (typeof m.id === 'string' && typeof m.meta === 'number' ? { id: m.id, meta: m.meta } : itemOfBlock(ctx.packdata?.items, { ...m, tileEntity: true })))
      : undefined
    // 基地的做法里给这台机器记了用途的：也带在它下面
    const methods = ctx.methods
    const noteLine =
      guideLine || methods
        ? (m: { x?: number; y?: number; z?: number; id?: string; meta?: number; name?: string; item?: { id: string; meta: number } }) => {
            const method = typeof m.x === 'number' && typeof m.y === 'number' && typeof m.z === 'number' ? methodNoteForMachine(methods, { x: m.x, y: m.y, z: m.z }) : undefined
            const lines = [guideLine?.(m), method].filter((x): x is string => x !== undefined)
            return lines.length > 0 ? lines.join('\n    ') : undefined
          }
        : undefined
    // data：身体的原样回答（每台机器的状态、总线和仓、覆盖板、流体罐），加上照配方册认出来的别的机器
    return { content: formatMachines(res, { radius, of: from.of, hint: from.hint, others, ...(name !== undefined ? { name } : {}), ...(handlers ? { wayName } : {}), ...(noteLine ? { guide: noteLine } : {}) }) + unseen, data: { machines: res.machines ?? [], total: res.total ?? res.machines?.length ?? 0, others } }
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
  leave?: boolean
  queue?: boolean
}

export const processItems: Tool = {
  name: 'process_items',
  description:
    'Run one batch through a machine (task): walks to it, puts the inputs in, waits for it to finish and takes the products out — the task holds you at the machine for as long as it runs. With leave: true it ends once the machine has started: the products stay inside, to be taken out later with withdraw_items. Any block with a screen that takes items works (a multiblock: give its controller). Give "recipe" and "rounds", or "inputs" yourself. Everything it consumes, and a mold or shape, must be in your inventory; the programmed circuit is set on the machine, not carried. Details: crafting manual.',
  inputSchema: obj(
    {
      machine: pos('Position of the machine (a multiblock: its controller).'),
      recipe: int('Recipe # from find_recipes: the inputs, the circuit and the products to expect are taken from it.', { min: 0 }),
      rounds: int('Times to run the recipe (default 1).', { min: 1, max: PROCESS_MAX_ROUNDS }),
      inputs: stackList('Instead of "recipe": exactly what to put in, each {id, meta?, count}; what is not used up (a mold) with count 1.', PROCESS_MAX_INPUTS),
      moldInside: bool('true: the mold or shape the recipe needs already sits in the machine; none is put in.'),
      circuit: int('Programmed circuit number to set (0 clears it). Default: the recipe\'s, 0 when it has none.', { min: 0, max: 24 }),
      fluids: stackList('Multiblock only: full fluid cells you carry, each {id, meta?, count}, to pour into its input hatch.', 6),
      expect: stackList('Multiblock only: products to fetch from the chest its output bus pushes into, each {id, meta?, count}. Default: the recipe\'s.', 9),
      bus: pos('Multiblock only: the input bus to use. Default: the emptiest.'),
      wait: int('Seconds to wait for it to finish, at most (default 180).', { min: PROCESS_WAIT_MIN_SEC, max: PROCESS_WAIT_MAX_SEC }),
      leave: bool('true: end the task once the machine has started; the circuit then stays as set.'),
      queue,
    },
    ['machine'],
  ),
  async run(ctx, i: ProcessInput) {
    let inputs = i.inputs
    let circuit = i.circuit
    let expect = i.expect
    let fluidNote = ''
    // 这一批是哪条配方的几轮、配方册上一轮多久：身体不认识这一项、原样带回（TaskInfo.params），放下就走时拿它算全部还要多久
    let batch: { ref: number; rounds: number; ticks?: number } | undefined
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
      // 自己另给了 inputs 的，放进去的是几轮就说不准了
      if (i.inputs === undefined) batch = { ref: recipe.ref, rounds: i.rounds ?? 1, ...(recipe.ticks !== undefined ? { ticks: recipe.ticks } : {}) }
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
    const leave = i.leave === true
    const started = await startTask(ctx, { type: 'process', machine: i.machine, inputs, circuit, fluids: i.fluids, expect, bus: i.bus, wait: i.wait, ...(leave ? { leave: true, ...(batch ? { recipe: batch } : {}) } : {}) }, i.queue)
    return typeof started === 'string' ? `${started}${fluidNote}` : started
  },
}
