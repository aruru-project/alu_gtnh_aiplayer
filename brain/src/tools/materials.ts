// 一个纯计算的帮手（库函数：不在发给模型的工具清单里，程序里调）：模型自己选定了每一层用哪条配方之后，把总原料算出来。
// 数量沿树相乘，一轮出几个按轮数取整，模具、工具这类不消耗的只算一个。
// 它不替模型选任何一步：路线（哪样东西用哪条配方）全由调用的人给；没给配方的东西就算成“要现成的”。
// 凿子的一步（从同组的另一种凿出来）不是配方、没有编号，用 chisel 参数给：一换一，凿子不消耗。

import { ANY_META } from '../packdata/index.ts'
import type { Recipe, RecipeHandler, RecipeSlot } from '../packdata/index.ts'
import type { ItemTable } from '../packdata/items.ts'
import { CHISEL_COST } from './chisel.ts'
import { itemKey } from './format.ts'
import { circuitOf, isTool, mergedSlots, namer, quantity, slotKey, slotName, unifiedOre } from './recipe-book.ts'
import { arr, int, obj, str } from './schema.ts'
import { fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const RECIPES_MAX = 60
const CHISEL_MAX = 30
/** 凿子的一步当成一条“配方”来算：编号是负的（真配方的编号从 0 起），一个进一个出。 */
const CHISEL_HANDLER: RecipeHandler = { key: 'chisel', name: 'chisel', machines: [], grid: false, gregtech: false }
const isChiselStep = (r: Recipe): boolean => r.ref < 0

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
  brief: '{id, meta?, count?, recipes?, chisel?}: adds up recipes and chisel steps you chose -> steps[], raw[], kept[]',
  description:
    'Pure arithmetic over recipes YOU chose: for a target item and count, and the # number of the recipe you decided to use for each thing that is to be made, it multiplies the amounts down the tree (rounds are rounded up; molds and tools that are not used up count once) and lists how many rounds of each recipe, what has to come from storage, what is kept, and the fluids. A block made with a chisel from another block of its chisel group is not a recipe and has no #: give it in "chisel" (one block gives one block). It chooses nothing: a thing you gave no recipe for is counted as taken ready-made.',
  inputSchema: obj(
    {
      id: str('Item id of the target.'),
      meta: int('Item meta of the target (default 0).', { min: 0 }),
      count: int('How many of the target (default 1).', { min: 1, max: 100000 }),
      recipes: arr('The # numbers of the recipes you chose: one for the target, and one for every ingredient you want made rather than taken from storage.', int('recipe #', { min: 0 }), { max: RECIPES_MAX }),
      chisel: arr(
        'Things you chose to make with a chisel from another block of the same chisel group (find_recipes shows the group): one block gives one block.',
        obj({ id: str('The block wanted.'), meta: int('Its meta (default 0).', { min: 0 }), from: obj({ id: str('The block it is chiselled from.'), meta: int('Its meta (default 0).', { min: 0 }) }, ['id']) }, ['id', 'from']),
        { max: CHISEL_MAX },
      ),
    },
    ['id'],
  ),
  async run(ctx: ToolContext, i: { id: string; meta?: number; count?: number; recipes?: number[]; chisel?: { id: string; meta?: number; from: { id: string; meta?: number } }[] }): Promise<ToolResult | string> {
    const book = ctx.packdata?.recipes
    const items = ctx.packdata?.items
    const carving = ctx.packdata?.carving
    const asked = i.recipes ?? []
    const carved = i.chisel ?? []
    if (asked.length === 0 && carved.length === 0) return fail('Give "recipes" (the # numbers of the recipes you chose), "chisel" (blocks chiselled from another block of their group), or both.')
    if (asked.length > 0 && !book) return fail('There is no recipe book on this brain, so nothing can be added up.')
    const nm = namer(items)
    const target = { id: i.id.trim(), meta: i.meta ?? 0 }
    const count = i.count ?? 1
    const chosen: Recipe[] = []
    for (const ref of [...new Set(asked)]) {
      const recipe = book!.get(ref)
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
        loop = isChiselStep(r) ? `the chisel step for ${nm.label(r.out[0]!.id, r.out[0]!.meta)} ends up needing its own product` : `recipe #${r.ref} ends up needing its own product`
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
    const steps: { recipe?: number; chisel?: { group: string; from: { id: string; meta: number; name: string } }; way: string; rounds: number; makes: { id: string; meta: number; name: string; count: number }; needed: number }[] = []
    for (const r of order) {
      const y = yields.get(r.ref)!
      const needed = demand.get(r.ref) ?? 0
      const rounds = Math.ceil(needed / y.n)
      const makes = { id: y.id, meta: y.meta, name: nm.name(y.id, y.meta), count: rounds * y.n }
      if (isChiselStep(r)) {
        const from = r.in[0] as Extract<RecipeSlot, { kind: 'item' }>
        steps.push({ chisel: { group: groupOfStep.get(r.ref)!, from: { id: from.id, meta: from.meta, name: nm.name(from.id, from.meta) } }, way: 'chisel', rounds, makes, needed })
      } else steps.push({ recipe: r.ref, way: r.handler.name, rounds, makes, needed })
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
    const unused = chosen.filter((r) => !order.includes(r) && !isChiselStep(r)).map((r) => r.ref)
    const unusedChisel = chosen.filter((r) => !order.includes(r) && isChiselStep(r)).map((r) => nm.label(r.out[0]!.id, r.out[0]!.meta))
    const usesChisel = order.some(isChiselStep)
    // 先做的在前
    const made = [...steps].reverse()
    const lines: string[] = [`For ${count}× ${nm.label(target.id, target.meta)}, with the ${order.length} ${usesChisel ? 'step(s)' : 'recipe(s)'} you chose (this only adds up amounts; it checks neither the storage nor the machines):`, 'To make, things that are needed by later lines first:']
    for (const s of made) {
      const over = s.makes.count - s.needed
      if (s.chisel) lines.push(`- chisel (group "${s.chisel.group}") × ${s.rounds} → ${s.makes.count}× ${nm.label(s.makes.id, s.makes.meta)}, from ${s.rounds}× ${nm.label(s.chisel.from.id, s.chisel.from.meta)}`)
      else lines.push(`- #${s.recipe} (${s.way}) × ${s.rounds} round(s) → ${s.makes.count}× ${s.makes.name}${over > 0 ? ` (${s.needed} needed, ${over} left over)` : ''}`)
    }
    const rawList = [...raw.values()]
    lines.push(rawList.length > 0 ? `Taken ready-made (you gave no recipe for these): ${rawList.map((x) => `${quantity(x.n)}× ${slotName(x.slot, nm, true)}`).join(', ')}` : 'Nothing has to be taken ready-made.')
    if (kept.size > 0) lines.push(`Needed but not used up, one of each (no recipe given for them): ${[...kept.values()].map((slot) => slotName(slot, nm, true)).join(', ')}`)
    if (usesChisel) lines.push(`For the chisel steps: a chisel (an item; find_item "凿子"), which is not used up as an ingredient — ${CHISEL_COST}.`)
    if (unusedChisel.length > 0) lines.push(`Chisel steps you gave that nothing here uses: ${unusedChisel.join(', ')}`)
    if (fluids.size > 0) lines.push(`Fluids, in all: ${[...fluids.values()].map((f) => `${quantity(f.mb)} mB ${f.name}`).join(', ')}`)
    if (unused.length > 0) lines.push(`Recipes you gave that nothing here uses: ${unused.map((r) => `#${r}`).join(', ')}`)
    const slotData = (slot: RecipeSlot): Record<string, unknown> => (slot.kind === 'item' ? { id: slot.id, ...(slot.meta === ANY_META ? {} : { meta: slot.meta }) } : slot.kind === 'ore' ? { ore: slot.ore } : { any: slot.any.map(([id, meta]) => itemKey({ id, meta })) })
    return {
      content: lines.join('\n'),
      data: {
        target: { ...target, count },
        steps: made,
        raw: rawList.map((x) => ({ ...slotData(x.slot), name: slotName(x.slot, nm, false), count: x.n })),
        kept: [...[...kept.values()].map((slot) => ({ ...slotData(slot), name: slotName(slot, nm, false) })), ...(usesChisel ? [{ tool: 'chisel', name: '凿子' }] : [])],
        fluids: [...fluids.entries()].map(([fluid, f]) => ({ fluid, ...f })),
        unused,
      },
      keepWhole: true,
    }
  },
}
