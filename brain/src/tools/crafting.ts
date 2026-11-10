// 给它一个目标（“做一个 XX”）时用得上的工具：这是哪个物品、它怎么做、原料存在基地哪里、附近有哪些机器，
// 以及用身上的材料手工合成、用一台 GT 单方块机器加工。查的那几个只读。

import { BridgeError } from '../bridge/protocol.ts'
import type { StockQuery } from '../bridge/protocol.ts'
import { formatItemSearch, formatMachines, formatRecipes, formatStock, itemKey } from './format.ts'
import { arr, int, obj, str } from './schema.ts'
import { pos, queue, startTask } from './tasks.ts'
import { fail } from './types.ts'
import type { Tool } from './types.ts'

// 协议里的上限
export const SEARCH_MAX_LIMIT = 40
export const STOCK_MAX_ITEMS = 24
export const STOCK_MAX_RADIUS = 64
export const CRAFT_MAX_COUNT = 2304
export const MACHINES_MAX_RADIUS = 64
export const MACHINES_MAX_LIMIT = 60
export const PROCESS_MAX_INPUTS = 9
export const PROCESS_WAIT_MIN_SEC = 5
export const PROCESS_WAIT_MAX_SEC = 1800

export const findItem: Tool = {
  name: 'find_item',
  description:
    'Find items by name: returns the id, meta and name of the best matches, how many recipes each has, and its ore-dictionary names. Item names on this server are English, so translate a Chinese name first (for a helicopter backpack search "copter pack"). Use it to get the exact id and meta before find_recipes, find_in_storage or craft_item.',
  inputSchema: obj(
    {
      query: str('Words of the English name (or of the id), e.g. "electric motor lv". Every word must appear; at least two characters.', {
        maxLength: 80,
      }),
      limit: int('How many matches to return (default 12).', { min: 1, max: SEARCH_MAX_LIMIT }),
    },
    ['query'],
  ),
  async run(ctx, i: { query: string; limit?: number }) {
    const query = i.query.trim()
    const res = await ctx.bridge.itemSearch(query, i.limit)
    return formatItemSearch(query, res.items ?? [])
  },
}

export const findRecipes: Tool = {
  name: 'find_recipes',
  description:
    'How an item is made. Crafting recipes list each ingredient: how many, whether it is one exact item (id/meta) or "any <ore name>" (anything registered under that ore-dictionary name), whether it is a tool that is only worn and not used up, and how many you carry. Machine recipes give the machine, tier, power, time, inputs (marking what is not used up), fluids and outputs; run one with process_items on a matching machine from find_machines. Also says what it is smelted from.',
  inputSchema: obj(
    {
      id: str('Item id, e.g. "gregtech:gt.metaitem.01".'),
      meta: int('Item meta (default 0).', { min: 0 }),
      machine: str('Show only the recipes of machines whose name contains this, e.g. "Lathe".', { maxLength: 60 }),
    },
    ['id'],
  ),
  async run(ctx, i: { id: string; meta?: number; machine?: string }) {
    const machine = i.machine?.trim()
    try {
      // 带上 bot：原料里才有它身上现有的数量
      const res = await ctx.bridge.recipeFind({
        id: i.id,
        ...(i.meta !== undefined ? { meta: i.meta } : {}),
        ...(machine ? { machine } : {}),
        bot: ctx.botName,
      })
      return formatRecipes(res, machine ? { machineFilter: machine } : {})
    } catch (e) {
      // 身体的原话里说的是协议方法名（item.search），模型只认得工具名
      if (e instanceof BridgeError && e.code === 'not_found' && /no such item/i.test(e.message)) {
        return fail(
          `No item ${itemKey({ id: i.id, meta: i.meta ?? 0 })} is known on this server. Use find_item to get the exact id and meta (many GregTech items share one id and differ only in meta).`,
        )
      }
      throw e
    }
  },
}

export const findInStorage: Tool = {
  name: 'find_in_storage',
  description: `Where things are kept in the storage around you. For each item (by id, with or without meta) or ore-dictionary name it gives the total and the containers holding the most: position, name, whether it is drawers, how many, and for an ore name or an id without meta the exact items (id/meta) found there. Looks into every chest, drawer and other block with an inventory within the radius (at most ${STOCK_MAX_RADIUS} blocks, loaded chunks only). Ask for all the ingredients of a recipe in one call, then take them with withdraw_items.`,
  inputSchema: obj(
    {
      items: arr(
        'What to look for.',
        obj({
          id: str('Item id. Give either this or "ore".'),
          meta: int('Item meta. Omit to match every meta of that id.', { min: 0 }),
          ore: str('Ore-dictionary name, e.g. "screwSteel": use it for an ingredient written as "any <ore name>".'),
        }),
        { min: 1, max: STOCK_MAX_ITEMS },
      ),
      radius: int('Search radius in blocks (default 32).', { min: 1, max: STOCK_MAX_RADIUS }),
    },
    ['items'],
  ),
  async run(ctx, i: { items: { id?: string; meta?: number; ore?: string }[]; radius?: number }) {
    const wanted: StockQuery[] = []
    for (const [n, it] of i.items.entries()) {
      if ((it.id === undefined) === (it.ore === undefined)) return fail(`items[${n}] needs exactly one of "id" (an item) or "ore" (an ore-dictionary name)`)
      if (it.ore !== undefined) wanted.push({ ore: it.ore })
      else wanted.push(it.meta === undefined ? { id: it.id! } : { id: it.id!, meta: it.meta })
    }
    const radius = i.radius ?? 32
    const res = await ctx.bridge.worldStock({ bot: ctx.botName }, { items: wanted, radius })
    return formatStock(res, radius)
  },
}

export const craftItem: Tool = {
  name: 'craft_item',
  description: `Craft an item by hand from what you carry (task): lays the recipe out on a crafting grid and takes the result. Every ingredient and tool must already be in your inventory (withdraw them first); if not, it fails with no_material and lists what is missing. A 2x2 recipe is made on the spot. A 3x3 recipe needs a crafting table or a Tinkers' crafting station: you walk to the nearest one within 24 blocks, or to "table" if you give it. Machine recipes are not made this way: use process_items. Take id, meta and the recipe number from find_recipes.`,
  inputSchema: obj(
    {
      id: str('Id of the item to make.'),
      meta: int('Its meta (default 0).', { min: 0 }),
      count: int('How many you want (default 1). The recipe is repeated as often as that takes.', { min: 1, max: CRAFT_MAX_COUNT }),
      recipe: int('Which crafting recipe, as numbered by find_recipes (default 0).', { min: 0 }),
      table: pos('Position of the crafting table or crafting station to use. Omit to use the nearest one.'),
      queue,
    },
    ['id'],
  ),
  run: (ctx, i: { id: string; meta?: number; count?: number; recipe?: number; table?: unknown; queue?: boolean }) =>
    startTask(ctx, { type: 'craft', id: i.id, meta: i.meta, count: i.count, recipe: i.recipe, table: i.table }, i.queue),
}

export const findMachines: Tool = {
  name: 'find_machines',
  description: `The GregTech single-block machines around you (radius at most ${MACHINES_MAX_RADIUS}), nearest first: position, name, which kind of recipes each runs (the same word as the machine of a recipe in find_recipes, e.g. "Lathe"), its tier, whether it has power, and whether it is busy. Use it to pick a machine for process_items. Multiblock machines, steam machines and other mods' machines are not listed and cannot be used.`,
  inputSchema: obj({
    name: str('Only machines whose name or recipe type contains this, e.g. "Lathe".', { maxLength: 60 }),
    radius: int('Search radius in blocks (default 32).', { min: 1, max: MACHINES_MAX_RADIUS }),
    limit: int('How many to return (default 30).', { min: 1, max: MACHINES_MAX_LIMIT }),
  }),
  async run(ctx, i: { name?: string; radius?: number; limit?: number }) {
    const name = i.name?.trim() || undefined
    const radius = i.radius ?? 32
    const res = await ctx.bridge.worldMachines(
      { bot: ctx.botName },
      { radius, ...(name !== undefined ? { name } : {}), ...(i.limit !== undefined ? { limit: i.limit } : {}) },
    )
    return formatMachines(res, { radius, ...(name !== undefined ? { name } : {}) })
  },
}

export const processItems: Tool = {
  name: 'process_items',
  description: `Run one batch through a GregTech single-block machine (task): walks to it, puts the inputs into it, waits for it to finish and takes the products out. Every input must already be in your inventory. List everything the recipe needs, including what it does not use up (a programmed circuit, whose meta is its circuit number, or a mold) with count 1; those come back with the products. The machine must run that kind of recipe, be of at least the recipe's tier, have power and be idle (find_machines). It cannot supply fluids: a recipe with fluid inputs only works if the machine is already fed that fluid. If the machine does not start, the inputs are taken back and the task fails with invalid and the machine's state.`,
  inputSchema: obj(
    {
      machine: pos('Position of the machine, as find_machines gives it.'),
      inputs: arr(
        'What to put in, with counts: the recipe inputs times the number of rounds you want, plus circuit or mold (count 1).',
        obj(
          {
            id: str('Item id.'),
            meta: int('Item meta. Omit to match any.', { min: 0 }),
            count: int('How many to put in.', { min: 1 }),
          },
          ['id', 'count'],
        ),
        { min: 1, max: PROCESS_MAX_INPUTS },
      ),
      wait: int('At most how many seconds to wait for it to finish (default 180). Give more for a big batch.', {
        min: PROCESS_WAIT_MIN_SEC,
        max: PROCESS_WAIT_MAX_SEC,
      }),
      queue,
    },
    ['machine', 'inputs'],
  ),
  run: (ctx, i: { machine: unknown; inputs: unknown[]; wait?: number; queue?: boolean }) =>
    startTask(ctx, { type: 'process', machine: i.machine, inputs: i.inputs, wait: i.wait }, i.queue),
}
