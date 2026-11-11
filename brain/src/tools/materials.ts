// 一个纯计算的帮手（库函数，只在程序里能调）：模型自己选定了每一层用哪条配方之后，把总原料算出来。
// 数量沿树相乘，一轮出几个按轮数取整，模具、工具这类不消耗的只算一个。
// 它不替模型选任何一步：路线（哪样东西用哪条配方）全由调用的人给；没给配方的东西就算成“要现成的”。

import { ANY_META } from '../packdata/index.ts'
import type { Recipe, RecipeSlot } from '../packdata/index.ts'
import type { ItemTable } from '../packdata/items.ts'
import { itemKey } from './format.ts'
import { circuitOf, isTool, mergedSlots, namer, quantity, slotKey, slotName, unifiedOre } from './recipe-book.ts'
import { arr, int, obj, str } from './schema.ts'
import { fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const RECIPES_MAX = 60

/** 这条配方出的这样东西，合不合那一格原料的要求。 */
function serves(slot: RecipeSlot, out: { id: string; meta: number }, items: ItemTable | undefined): boolean {
  if (slot.kind === 'item') {
    if (slot.id === out.id && (slot.meta === ANY_META || slot.meta === out.meta)) return true
    // 同一个材料件矿辞名下的另一个 id（EnderIO 的玄钢锭和 GregTech 的玄钢锭）
    const a = slot.meta === ANY_META ? undefined : unifiedOre(items?.get(slot.id, slot.meta))
    return a !== undefined && a === unifiedOre(items?.get(out.id, out.meta))
  }
  if (slot.any.some(([id, meta]) => id === out.id && (meta === ANY_META || meta === out.meta))) return true
  return slot.kind === 'ore' && items?.get(out.id, out.meta)?.ores?.includes(slot.ore) === true
}

export const totalMaterials: Tool = {
  name: 'total_materials',
  description:
    'Pure arithmetic over recipes YOU chose: for a target item and count, and the # number of the recipe you decided to use for each thing that is to be made, it multiplies the amounts down the tree (rounds are rounded up; molds and tools that are not used up count once) and lists how many rounds of each recipe, what has to come from storage, what is kept, and the fluids. It chooses nothing: a thing you gave no recipe for is counted as taken ready-made.',
  inputSchema: obj(
    {
      id: str('Item id of the target.'),
      meta: int('Item meta of the target (default 0).', { min: 0 }),
      count: int('How many of the target (default 1).', { min: 1, max: 100000 }),
      recipes: arr('The # numbers of the recipes you chose: one for the target, and one for every ingredient you want made rather than taken from storage.', int('recipe #', { min: 0 }), { min: 1, max: RECIPES_MAX }),
    },
    ['id', 'recipes'],
  ),
  async run(ctx: ToolContext, i: { id: string; meta?: number; count?: number; recipes: number[] }): Promise<ToolResult | string> {
    const book = ctx.packdata?.recipes
    const items = ctx.packdata?.items
    if (!book) return fail('There is no recipe book on this brain, so nothing can be added up.')
    const nm = namer(items)
    const target = { id: i.id.trim(), meta: i.meta ?? 0 }
    const count = i.count ?? 1
    const chosen: Recipe[] = []
    for (const ref of [...new Set(i.recipes)]) {
      const recipe = book.get(ref)
      if (!recipe) return fail(`There is no recipe #${ref}. Take the numbers from find_recipes (they change when the recipe book is re-exported).`)
      chosen.push(recipe)
    }
    const targetSlot: RecipeSlot = { kind: 'item', id: target.id, meta: target.meta, n: 1 }
    const makerOf = (slot: RecipeSlot): Recipe | undefined => chosen.find((r) => r.out.some((o) => o.chance === undefined && serves(slot, o, items)))
    const top = makerOf(targetSlot)
    if (!top) return fail(`None of the recipes you gave makes ${nm.label(target.id, target.meta)}: the first thing to choose is the recipe for the target itself.`)
    const inputs = (r: Recipe): RecipeSlot[] => mergedSlots(r.in).filter((s) => circuitOf(s) === undefined)
    /** 一轮出几个“要的那样东西”。 */
    const yields = new Map<number, { n: number; id: string; meta: number }>()
    const yieldOf = (r: Recipe, slot: RecipeSlot): { n: number; id: string; meta: number } => {
      let y = yields.get(r.ref)
      if (!y) {
        const outs = r.out.filter((o) => o.chance === undefined && serves(slot, o, items))
        y = { n: outs.reduce((n, o) => n + o.n, 0), id: outs[0]!.id, meta: outs[0]!.meta }
        yields.set(r.ref, y)
      }
      return y
    }
    yieldOf(top, targetSlot)

    // 先排顺序：用到别人的排在别人前面（目标最前），这样轮到一条配方时，要它出多少已经加全了
    const order: Recipe[] = []
    const state = new Map<number, 'open' | 'done'>()
    let loop: string | undefined
    const visit = (r: Recipe): void => {
      if (state.get(r.ref) === 'done' || loop) return
      if (state.get(r.ref) === 'open') {
        loop = `recipe #${r.ref} ends up needing its own product`
        return
      }
      state.set(r.ref, 'open')
      for (const slot of inputs(r)) {
        const maker = makerOf(slot)
        if (maker) {
          yieldOf(maker, slot)
          visit(maker)
        }
      }
      state.set(r.ref, 'done')
      order.unshift(r)
    }
    visit(top)
    if (loop) return fail(`These recipes feed each other in a circle (${loop}), so the amounts cannot be added up. Leave out the recipe that turns a product back into its ingredient.`)

    const demand = new Map<number, number>([[top.ref, count]])
    const raw = new Map<string, { slot: RecipeSlot; n: number }>()
    const kept = new Map<string, RecipeSlot>()
    const keptMade = new Set<number>()
    const fluids = new Map<string, { name: string; mb: number }>()
    const steps: { recipe: number; way: string; rounds: number; makes: { id: string; meta: number; name: string; count: number }; needed: number }[] = []
    for (const r of order) {
      const y = yields.get(r.ref)!
      const needed = demand.get(r.ref) ?? 0
      const rounds = Math.ceil(needed / y.n)
      steps.push({ recipe: r.ref, way: r.handler.name, rounds, makes: { id: y.id, meta: y.meta, name: nm.name(y.id, y.meta), count: rounds * y.n }, needed })
      for (const f of r.fin) fluids.set(f.f, { name: f.name, mb: (fluids.get(f.f)?.mb ?? 0) + f.mb * rounds })
      for (const slot of inputs(r)) {
        const maker = makerOf(slot)
        const stays = slot.n === 0 || isTool(slot)
        if (stays) {
          // 不消耗的：整棵树只要一个
          if (maker && !keptMade.has(maker.ref)) {
            keptMade.add(maker.ref)
            demand.set(maker.ref, (demand.get(maker.ref) ?? 0) + 1)
          } else if (!maker) kept.set(slotKey(slot), slot)
        } else if (maker) demand.set(maker.ref, (demand.get(maker.ref) ?? 0) + slot.n * rounds)
        else raw.set(slotKey(slot), { slot, n: (raw.get(slotKey(slot))?.n ?? 0) + slot.n * rounds })
      }
    }
    const unused = chosen.filter((r) => !order.includes(r)).map((r) => r.ref)
    // 先做的在前
    const made = [...steps].reverse()
    const lines: string[] = [`For ${count}× ${nm.label(target.id, target.meta)}, with the ${order.length} recipe(s) you chose (this only adds up amounts; it checks neither the storage nor the machines):`, 'To make, things that are needed by later lines first:']
    for (const s of made) {
      const over = s.makes.count - s.needed
      lines.push(`- #${s.recipe} (${s.way}) × ${s.rounds} round(s) → ${s.makes.count}× ${s.makes.name}${over > 0 ? ` (${s.needed} needed, ${over} left over)` : ''}`)
    }
    const rawList = [...raw.values()]
    lines.push(rawList.length > 0 ? `Taken ready-made (you gave no recipe for these): ${rawList.map((x) => `${quantity(x.n)}× ${slotName(x.slot, nm, true)}`).join(', ')}` : 'Nothing has to be taken ready-made.')
    if (kept.size > 0) lines.push(`Needed but not used up, one of each (no recipe given for them): ${[...kept.values()].map((slot) => slotName(slot, nm, true)).join(', ')}`)
    if (fluids.size > 0) lines.push(`Fluids, in all: ${[...fluids.values()].map((f) => `${quantity(f.mb)} mB ${f.name}`).join(', ')}`)
    if (unused.length > 0) lines.push(`Recipes you gave that nothing here uses: ${unused.map((r) => `#${r}`).join(', ')}`)
    const slotData = (slot: RecipeSlot): Record<string, unknown> => (slot.kind === 'item' ? { id: slot.id, ...(slot.meta === ANY_META ? {} : { meta: slot.meta }) } : slot.kind === 'ore' ? { ore: slot.ore } : { any: slot.any.map(([id, meta]) => itemKey({ id, meta })) })
    return {
      content: lines.join('\n'),
      data: {
        target: { ...target, count },
        steps: made,
        raw: rawList.map((x) => ({ ...slotData(x.slot), name: slotName(x.slot, nm, false), count: x.n })),
        kept: [...kept.values()].map((slot) => ({ ...slotData(slot), name: slotName(slot, nm, false) })),
        fluids: [...fluids.entries()].map(([fluid, f]) => ({ fluid, ...f })),
        unused,
      },
      keepWhole: true,
    }
  },
}
