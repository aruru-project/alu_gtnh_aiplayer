// 一个纯计算的帮手（库函数：不在发给模型的工具清单里，程序里调）：模型自己选定了每一层用哪条配方之后，把总原料算出来。
// 数量沿树相乘，一轮出几个按轮数取整，模具、工具这类不消耗的只算一个。
// 它不替模型选任何一步：路线（哪样东西用哪条配方）全由调用的人给；没给配方的东西就算成“要现成的”。
// 凿子的一步（从同组的另一种凿出来）不是配方、没有编号，用 chisel 参数给：一换一，凿子不消耗。
// 走树和算数在 material-tree.ts；这里给它的选择函数就是“只用点了名的那几条”。

import { ANY_META } from '../packdata/index.ts'
import type { FluidInfo, Recipe, RecipeHandler, RecipeSlot } from '../packdata/index.ts'
import { CHISEL_COST } from './chisel.ts'
import { itemKey } from './format.ts'
import { MaterialTree } from './material-tree.ts'
import type { Choose, TreeThing } from './material-tree.ts'
import { fluidLabel, namer, quantity, slotName } from './recipe-book.ts'
import { arr, int, obj, str } from './schema.ts'
import { fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const RECIPES_MAX = 60
const CHISEL_MAX = 30
/** 凿子的一步当成一条“配方”来算：编号是负的（真配方的编号从 0 起），一个进一个出。 */
const CHISEL_HANDLER: RecipeHandler = { key: 'chisel', name: 'chisel', machines: [], grid: false, gregtech: false }
const isChiselStep = (r: Recipe): boolean => r.ref < 0

/**
 * 选择函数：只用调用的人点了名的那几条。一样东西用给的配方里第一条做得出它的；
 * 一条配方只当一样产物的做法（它出两样东西时，先被要到的那样归它）。
 */
function namedOnly(chosen: readonly Recipe[]): Choose {
  const makes = new Map<number, string>()
  return (_thing, options) => {
    for (const recipe of chosen) {
      const y = options.yield(recipe)
      if (y.n === 0 || (makes.get(recipe.ref) ?? y.product) !== y.product) continue
      makes.set(recipe.ref, y.product!)
      return { recipe }
    }
    return {}
  }
}

export const totalMaterials: Tool = {
  name: 'total_materials',
  brief: '{id | fluid, meta?, count?, recipes?, chisel?}: adds up recipes and chisel steps you chose -> steps[], raw[], kept[], fluids[]',
  description:
    'Pure arithmetic over recipes YOU chose: for a target item and count, and the # number of the recipe you decided to use for each thing that is to be made, it multiplies the amounts down the tree (rounds are rounded up; molds and tools that are not used up count once) and lists how many rounds of each recipe, what has to come from storage, what is kept, and the fluids. A fluid a recipe takes is charged to the recipe you chose that gives it (in mB), or listed as taken ready-made. A block made with a chisel from another block of its chisel group is not a recipe and has no #: give it in "chisel" (one block gives one block). It chooses nothing: a thing you gave no recipe for is counted as taken ready-made.',
  inputSchema: obj(
    {
      id: str('Item id of the target.'),
      meta: int('Item meta of the target (default 0).', { min: 0 }),
      fluid: str('Instead of "id": a fluid as the target, by its name or internal name; "count" is then mB.', { maxLength: 80 }),
      count: int('How many of the target (default 1); for a fluid, mB.', { min: 1, max: 100_000_000 }),
      recipes: arr('The # numbers of the recipes you chose: one for the target, and one for every ingredient you want made rather than taken from storage.', int('recipe #', { min: 0 }), { max: RECIPES_MAX }),
      chisel: arr(
        'Things you chose to make with a chisel from another block of the same chisel group (find_recipes shows the group): one block gives one block.',
        obj({ id: str('The block wanted.'), meta: int('Its meta (default 0).', { min: 0 }), from: obj({ id: str('The block it is chiselled from.'), meta: int('Its meta (default 0).', { min: 0 }) }, ['id']) }, ['id', 'from']),
        { max: CHISEL_MAX },
      ),
    },
  ),
  async run(ctx: ToolContext, i: { id?: string; meta?: number; fluid?: string; count?: number; recipes?: number[]; chisel?: { id: string; meta?: number; from: { id: string; meta?: number } }[] }): Promise<ToolResult | string> {
    const book = ctx.packdata?.recipes
    const items = ctx.packdata?.items
    const carving = ctx.packdata?.carving
    const asked = i.recipes ?? []
    const carved = i.chisel ?? []
    if (asked.length === 0 && carved.length === 0) return fail('Give "recipes" (the # numbers of the recipes you chose), "chisel" (blocks chiselled from another block of their group), or both.')
    if (asked.length > 0 && !book) return fail('There is no recipe book on this brain, so nothing can be added up.')
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
    const tree = new MaterialTree(book, items, namedOnly(chosen)).run(liquid ? { fluid: { f: liquid.fluid, name: liquid.name } } : { slot: { kind: 'item', id: target.id, meta: target.meta, n: 1 } }, count)
    // 给的配方绕成了圈（一条配方要用到树上在它上面的东西）：不猜该断在哪
    const looped = [...tree.raw, ...tree.kept, ...tree.fluids].find((t) => t.loop)?.loop
    if (looped) {
      const again = looped.needs.recipe ?? looped.recipe
      const loop = isChiselStep(again) ? `the chisel step for ${nm.label(again.out[0]!.id, again.out[0]!.meta)} ends up needing its own product` : `recipe #${again.ref} ends up needing its own product`
      return fail(`These recipes feed each other in a circle (${loop}), so the amounts cannot be added up. Leave out the recipe that turns a product back into its ingredient.`)
    }
    if (!tree.target.recipe) return fail(`None of the recipes you gave ${liquid ? 'gives' : 'makes'} ${targetLabel}: the first thing to choose is the recipe for the target itself.`)

    type Made = { id: string; meta: number; name: string; count: number } | { fluid: string; name: string; count: number }
    const stepOf = (t: TreeThing): { recipe?: number; chisel?: { group: string; from: { id: string; meta: number; name: string } }; way: string; rounds: number; makes: Made; needed: number } => {
      const r = t.recipe!
      const total = t.rounds * t.yield!
      const makes: Made = t.fluid ? { fluid: t.fluid.f, name: t.fluid.name, count: total } : { id: t.made!.id, meta: t.made!.meta, name: nm.name(t.made!.id, t.made!.meta), count: total }
      if (isChiselStep(r)) {
        const from = r.in[0] as Extract<RecipeSlot, { kind: 'item' }>
        return { chisel: { group: groupOfStep.get(r.ref)!, from: { id: from.id, meta: from.meta, name: nm.name(from.id, from.meta) } }, way: 'chisel', rounds: t.rounds, makes, needed: t.needed }
      }
      return { recipe: r.ref, way: r.handler.name, rounds: t.rounds, makes, needed: t.needed }
    }
    // 先做的在前
    const made = tree.made.map(stepOf)
    const used = new Set(tree.made.map((t) => t.recipe!.ref))
    const unused = chosen.filter((r) => !used.has(r.ref) && !isChiselStep(r)).map((r) => r.ref)
    const unusedChisel = chosen.filter((r) => !used.has(r.ref) && isChiselStep(r)).map((r) => nm.label(r.out[0]!.id, r.out[0]!.meta))
    const usesChisel = tree.made.some((t) => isChiselStep(t.recipe!))
    const rawList = tree.raw.map((t) => ({ slot: t.slot!, n: t.needed }))
    const kept = tree.kept.map((t) => t.slot!)
    const fluids = tree.fluids.map((t) => ({ fluid: t.fluid!.f, name: t.fluid!.name, mb: t.needed }))
    const lines: string[] = [`For ${liquid ? `${count} mB` : `${count}×`} ${targetLabel}, with the ${made.length} ${usesChisel ? 'step(s)' : 'recipe(s)'} you chose (this only adds up amounts; it checks neither the storage nor the machines):`, 'To make, things that are needed by later lines first:']
    for (const s of made) {
      const over = s.makes.count - s.needed
      const left = over > 0 ? ` (${s.needed} needed, ${over} left over)` : ''
      if (s.chisel && 'id' in s.makes) lines.push(`- chisel (group "${s.chisel.group}") × ${s.rounds} → ${s.makes.count}× ${nm.label(s.makes.id, s.makes.meta)}, from ${s.rounds}× ${nm.label(s.chisel.from.id, s.chisel.from.meta)}`)
      else if ('fluid' in s.makes) lines.push(`- #${s.recipe} (${s.way}) × ${s.rounds} round(s) → ${s.makes.count} mB ${s.makes.name}${left}`)
      else lines.push(`- #${s.recipe} (${s.way}) × ${s.rounds} round(s) → ${s.makes.count}× ${s.makes.name}${left}`)
    }
    lines.push(rawList.length > 0 ? `Taken ready-made (you gave no recipe for these): ${rawList.map((x) => `${quantity(x.n)}× ${slotName(x.slot, nm, true)}`).join(', ')}` : 'Nothing has to be taken ready-made.')
    if (kept.length > 0) lines.push(`Needed but not used up, one of each (no recipe given for them): ${kept.map((slot) => slotName(slot, nm, true)).join(', ')}`)
    if (usesChisel) lines.push(`For the chisel steps: a chisel (an item; find_item "凿子"), which is not used up as an ingredient — ${CHISEL_COST}.`)
    if (unusedChisel.length > 0) lines.push(`Chisel steps you gave that nothing here uses: ${unusedChisel.join(', ')}`)
    if (fluids.length > 0) lines.push(`Fluids, in all: ${fluids.map((f) => `${quantity(f.mb)} mB ${f.name}`).join(', ')}`)
    if (unused.length > 0) lines.push(`Recipes you gave that nothing here uses: ${unused.map((r) => `#${r}`).join(', ')}`)
    const slotData = (slot: RecipeSlot): Record<string, unknown> => (slot.kind === 'item' ? { id: slot.id, ...(slot.meta === ANY_META ? {} : { meta: slot.meta }) } : slot.kind === 'ore' ? { ore: slot.ore } : { any: slot.any.map(([id, meta]) => itemKey({ id, meta })) })
    return {
      content: lines.join('\n'),
      data: {
        target: liquid ? { fluid: liquid.fluid, name: liquid.name, count } : { ...target, count },
        steps: made,
        raw: rawList.map((x) => ({ ...slotData(x.slot), name: slotName(x.slot, nm, false), count: x.n })),
        kept: [...kept.map((slot) => ({ ...slotData(slot), name: slotName(slot, nm, false) })), ...(usesChisel ? [{ tool: 'chisel', name: '凿子' }] : [])],
        fluids,
        unused,
      },
      keepWhole: true,
    }
  },
}
