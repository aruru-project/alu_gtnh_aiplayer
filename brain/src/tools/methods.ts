// “基地的做法”（store/methods.ts）的工具这一头：
//   - base_methods：看；set_base_method：记一条、改一条、删一条。两条线都有（主人在聊天里教的，对话线可以直接记）。
//   - 一条记录写得对不对在这里查：做法的名字认不认得、配方做不做得出那样东西；面板的写接口用的也是这一个（buildMethod）。
//   - 一条配方记成认得回来的特征（recipeMark），用的时候对回现在的编号（resolveMark）。
//   - 一样东西归哪条“一类零件”的记录（partMethodFor）、算不算“当现成的”（readyMethodFor）；两条配方算不算“用的料一样”（sameIngredients）。
//   - 它本来会看的地方带上相关的那一条：查做法（methodNoteForThing）、看机器（methodNoteForMachine）。
// 工具只陈述记录里写了什么，不替它判断这条记录好不好。

import type { FluidTable, Recipe, RecipeBook, RecipeHandler, RecipeSlot } from '../packdata/index.ts'
import type { ItemTable } from '../packdata/items.ts'
import { ANY_META } from '../packdata/index.ts'
import { METHOD_TEXT_MAX_CHARS, METHOD_WHY_MAX_CHARS, ORDER_KEY, machineKey, partKey, readyKey, sameKey, thingKey } from '../store/methods.ts'
import type { MachineMethod, Method, MethodBy, MethodPos, OrderMethod, PartMethod, ReadyMethod, RecipeMark, SameMethod, ThingMethod } from '../store/methods.ts'
import { serves, thingKeyOfFluid, thingKeyOfSlot } from './material-tree.ts'
import { circuitOf, fluidLabel, isTool, lookAround, mergedSlots, namer, quantity, slotName } from './recipe-book.ts'
import type { Namer } from './recipe-book.ts'
import { arr, bool, int, obj, str } from './schema.ts'
import { fail } from './types.ts'
import type { Tool, ToolContext } from './types.ts'

/** 存取“基地的做法”：MethodStore 满足。 */
export interface MethodAccess {
  list(): Method[]
  get(key: string): Method | undefined
  set(entry: Method): void
  remove(key: string): boolean
  thingFor(thing: string): ThingMethod | undefined
  order(): OrderMethod | undefined
  machineAt(p: MethodPos): MachineMethod | undefined
}

/** 这些前缀各是一种零件：plateDouble 不是 plate 的一种（“板怎么做”的记录管不到双层板）。 */
const OWN_PREFIXES = ['ingotHot', 'plateDouble', 'plateDense', 'plateTriple', 'plateQuadruple', 'plateQuintuple', 'dustSmall', 'dustTiny', 'dustImpure', 'dustPure', 'stickLong', 'gearGtSmall', 'springSmall', 'wireFine', 'gemFlawless', 'gemExquisite', 'gemFlawed', 'gemChipped']
const ORDER_MAX = 40
/** 一个位置的参数写法（和 tasks.ts 的 pos 一样；那边引过来会绕成圈）。 */
const pos = (description: string) => obj({ x: int(), y: int(), z: int() }, ['x', 'y', 'z'], description)

const formatPos = (p: MethodPos): string => `(${p.x},${p.y},${p.z})`
const dateText = (at: number): string => {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
/** 谁定的、什么时候、理由：每条记录后面都带。 */
export const methodSource = (m: Method): string => `${m.by === 'owner' ? 'your owner' : 'you'}, ${dateText(m.at)}${m.why ? `: ${m.why}` : ''}`

// ── 做法的名字 ──

/**
 * 一个做法的名字指的是哪几页：内部名或页名正好是它的（同名的页都算——“有序合成”有好几页）。
 * 没有正好的，看名字里含不含：只含在一种名字里就是它；含在几种里就说不清，把候选列出来。
 */
export function waysNamed(book: RecipeBook, text: string): { name: string; handlers: RecipeHandler[] } | { error: string } {
  const wanted = text.trim().toLowerCase()
  if (wanted.length === 0) return { error: 'a way needs a name' }
  const exact = book.handlers.filter((h) => h.key.toLowerCase() === wanted || h.name.toLowerCase() === wanted)
  const found = exact.length > 0 ? exact : book.handlers.filter((h) => h.key.toLowerCase().includes(wanted) || h.name.toLowerCase().includes(wanted))
  if (found.length === 0) return { error: `no way of making is named "${text.trim()}": use a name as find_recipes lists the ways (e.g. "卷板机", "有序合成")` }
  const names = [...new Set(found.map((h) => h.name))]
  if (names.length > 1) return { error: `"${text.trim()}" fits several ways: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}. Give the one you mean by its full name` }
  return { name: names[0]!, handlers: book.handlers.filter((h) => h.name === names[0]) }
}

/** 记录里存的做法名现在指哪几页（存的是页名；页的内部名也认）。 */
export function handlersOf(book: RecipeBook | undefined, way: string): RecipeHandler[] {
  const wanted = way.toLowerCase()
  return (book?.handlers ?? []).filter((h) => h.name.toLowerCase() === wanted || h.key.toLowerCase() === wanted)
}

// ── 一条配方的特征 ──

/** 配方里的一格在特征里怎么写：编程电路写电路号，别的写“哪样东西”。 */
const slotMark = (s: RecipeSlot, items: ItemTable | undefined): string => (circuitOf(s) !== undefined ? `circuit:${circuitOf(s)}` : thingKeyOfSlot(s, items))
const sorted = (pairs: [string, number][]): [string, number][] => [...pairs].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])

/** 一条配方给人看的一行：原料 → 产物（不带编号：编号会变）。 */
export function recipeText(recipe: Recipe, nm: Namer): string {
  const slots = mergedSlots(recipe.in)
  const ins = [
    ...slots.filter((s) => s.n > 0 && !isTool(s)).map((s) => `${quantity(s.n)}× ${slotName(s, nm, false)}`),
    ...recipe.fin.map((f) => `${quantity(f.mb)} mB ${f.name}`),
    ...slots.filter((s) => circuitOf(s) !== undefined).map((s) => `circuit ${circuitOf(s)}`),
    ...slots.filter((s) => circuitOf(s) === undefined && (s.n === 0 || isTool(s))).map((s) => `${slotName(s, nm, false)} (not used up)`),
  ]
  const outs = [...recipe.out.map((o) => `${quantity(o.n)}× ${o.name ?? nm.name(o.id, o.meta)}${o.chance !== undefined ? ` (${quantity(o.chance * 100)}%)` : ''}`), ...recipe.fout.map((f) => `${quantity(f.mb)} mB ${f.name}`)]
  return `${ins.join(' + ') || 'nothing'} → ${outs.join(' + ') || 'nothing'}`
}

/** 把一条配方记成认得回来的特征：做法 + 原料 + 产物 + 流体（电路号在原料里）。 */
export function recipeMark(recipe: Recipe, items: ItemTable | undefined): RecipeMark {
  return {
    ref: recipe.ref,
    way: recipe.handler.key,
    wayName: recipe.handler.name,
    in: sorted(mergedSlots(recipe.in).map((s) => [slotMark(s, items), s.n])),
    out: sorted(recipe.out.filter((o) => o.chance === undefined).map((o) => [`${o.id}/${o.meta}`, o.n])),
    fin: sorted(recipe.fin.map((f) => [f.f, f.mb])),
    fout: sorted(recipe.fout.map((f) => [f.f, f.mb])),
    text: recipeText(recipe, namer(items)),
  }
}

const markKey = (m: RecipeMark): string => JSON.stringify([m.way, m.in, m.out, m.fin, m.fout])

/** 特征里写着它出什么：做得出这些产物的配方就是候选。 */
function candidatesOf(mark: RecipeMark, book: RecipeBook): number[] {
  const refs = new Set<number>()
  for (const [key] of mark.out) {
    const cut = key.lastIndexOf('/')
    for (const ref of book.makesOf(key.slice(0, cut), Number(key.slice(cut + 1)))) refs.add(ref)
  }
  for (const [fluid] of mark.fout) for (const ref of book.makesFluid(fluid)) refs.add(ref)
  return [...refs]
}

/**
 * 记下来的那条配方现在是哪一条：先看原来的编号还是不是它；不是了（配方册重新导出过），在做得出同样产物的配方里
 * 找特征一样的。找不到是 undefined：这条记录失效了。
 */
export function resolveMark(mark: RecipeMark, book: RecipeBook | undefined, items: ItemTable | undefined, candidates: () => readonly number[] = () => (book ? candidatesOf(mark, book) : [])): Recipe | undefined {
  if (!book) return undefined
  const wanted = markKey(mark)
  const same = (recipe: Recipe | undefined): recipe is Recipe => recipe !== undefined && markKey(recipeMark(recipe, items)) === wanted
  const direct = book.get(mark.ref)
  if (same(direct)) return direct
  for (const ref of candidates()) {
    if (book.handlerOfRecipe(ref)?.key !== mark.way) continue
    const recipe = book.get(ref)
    if (same(recipe)) return recipe
  }
  return undefined
}

// ── 一样东西归哪条“一类零件”的记录 ──

/**
 * ores：这样东西登记在哪些矿辞名下。返回管得到它的那条记录（限定了材料的在先，其次前缀长的），和它的材料那一半（Steel）。
 * “板”的记录管不到双层板、小撮粉这些自己另算一种的零件（OWN_PREFIXES）。
 */
/** 这个前缀管不管这个矿辞名：ore 是前缀加上材料（后面是大写字母或数字），而且不是另算一种的零件（plate 管不到 plateDoubleSteel）。 */
export function prefixCovers(prefix: string, ore: string): boolean {
  if (!ore.startsWith(prefix) || !/[A-Z0-9]/.test(ore.charAt(prefix.length))) return false
  const own = OWN_PREFIXES.find((p) => ore.startsWith(p) && /[A-Z0-9]/.test(ore.charAt(p.length)))
  return own === undefined || own.length <= prefix.length
}

export function partMethodFor(methods: readonly Method[], ores: readonly string[]): { entry: PartMethod; ore: string; material: string } | undefined {
  let best: { entry: PartMethod; ore: string; material: string } | undefined
  for (const entry of methods) {
    if (entry.kind !== 'part') continue
    for (const ore of ores) {
      if (!prefixCovers(entry.prefix, ore)) continue
      const material = ore.slice(entry.prefix.length)
      if (entry.material !== undefined && entry.material !== material) continue
      const better = !best || Number(entry.material !== undefined) > Number(best.entry.material !== undefined) || (Number(entry.material !== undefined) === Number(best.entry.material !== undefined) && entry.prefix.length > best.entry.prefix.length)
      if (better) best = { entry, ore, material }
    }
  }
  return best
}

/** 这样东西是不是“当现成的”：对上的那一条（一样具体的物品 → 矿辞名 → 矿辞前缀，先对上的算）。 */
export function readyMethodFor(methods: readonly Method[], thing: { key: string; members: readonly { id: string; meta: number }[] }, items: ItemTable | undefined): ReadyMethod | undefined {
  const ready = methods.filter((m): m is ReadyMethod => m.kind === 'ready')
  if (ready.length === 0) return undefined
  const ores = oresOfThing(thing, items)
  return (
    ready.find((m) => m.match === 'item' && thing.members.some((x) => x.id === m.text && (m.meta === undefined || m.meta === x.meta))) ??
    ready.find((m) => m.match === 'ore' && ores.includes(m.text)) ??
    ready.find((m) => m.match === 'prefix' && ores.some((ore) => prefixCovers(m.text, ore)))
  )
}

/** 一格原料能放哪些物品（配方里写着的那几种）。 */
const slotItems = (s: RecipeSlot): { id: string; meta: number }[] => (s.kind === 'item' ? [{ id: s.id, meta: s.meta }] : s.any.map(([id, meta]) => ({ id, meta })))
const asItem = (x: { id: string; meta: number }): { id: string; meta: number } => ({ id: x.id, meta: x.meta === ANY_META ? 0 : x.meta })

/**
 * 两条配方用的料一样不一样：消耗的物品一格一格对得上（同样多，放得进同一种东西：钢锭和“任何 ingotSteel”算一样），
 * 流体一样多，做出来的这样东西一样多。工具、编程电路、不消耗的模具不算料。
 */
export function sameIngredients(a: Recipe, b: Recipe, yieldA: number, yieldB: number, items: ItemTable | undefined): boolean {
  if (yieldA !== yieldB) return false
  const fluids = (r: Recipe): string => JSON.stringify([...r.fin].map((f) => [f.f, f.mb]).sort())
  if (fluids(a) !== fluids(b)) return false
  const consumed = (r: Recipe): RecipeSlot[] => mergedSlots(r.in).filter((s) => s.n > 0 && !isTool(s) && circuitOf(s) === undefined)
  const left = consumed(a)
  const right = consumed(b)
  if (left.length !== right.length) return false
  const overlaps = (x: RecipeSlot, y: RecipeSlot): boolean => slotItems(y).some((m) => serves(x, asItem(m), items)) || slotItems(x).some((m) => serves(y, asItem(m), items))
  const free = [...right]
  for (const s of left) {
    const at = free.findIndex((t) => t.n === s.n && overlaps(s, t))
    if (at === -1) return false
    free.splice(at, 1)
  }
  return true
}

/** 一样东西登记在哪些矿辞名下（它的键是矿辞名的就是那个；别的看物品表）。 */
export function oresOfThing(thing: { key: string; members: readonly { id: string; meta: number }[] }, items: ItemTable | undefined): string[] {
  if (thing.key.startsWith('ore:')) return [thing.key.slice(4)]
  const first = thing.members[0]
  return first && !thing.key.startsWith('any:') ? [...(items?.get(first.id, first.meta)?.ores ?? [])] : []
}

/** “从哪种料来”对不对得上：这条配方消耗的原料里，有没有登记在 from + 同一种材料 名下的。 */
export function comesFrom(recipe: Recipe, from: string, material: string, items: ItemTable | undefined): boolean {
  const fits = (ore: string): boolean => ore.startsWith(from) && ore.length > from.length && (ore.slice(from.length) === material || material.endsWith(ore.slice(from.length)))
  return recipe.in.some((s) => {
    if (s.n === 0 || isTool(s)) return false
    if (s.kind === 'ore') return fits(s.ore)
    const listed: readonly [string, number][] = s.kind === 'item' ? [[s.id, s.meta]] : s.any
    return listed.some(([id, meta]) => (items?.get(id, meta)?.ores ?? []).some(fits))
  })
}

// ── 一条记录现在还对不对得上 ──

/**
 * 一条记录在现在这份配方册、物品表里还对不对得上（给面板判断失效用）：
 * recipeNow 是具体东西的那条配方现在的编号（对不回来是 null）；stale 是这条记录说的东西现在找不到了——
 * 配方对不回来、做法的名字（part、same、order 里的）不在配方册里了、当现成的物品或矿辞名不在物品表里了。没有配方册时不判断（都不带）。
 */
export function methodState(m: Method, env: { book?: RecipeBook | undefined; items?: ItemTable | undefined }): { recipeNow?: number | null; stale?: boolean } {
  const book = env.book
  if (!book) return {}
  const gone = (way: string): boolean => handlersOf(book, way).length === 0
  if (m.kind === 'thing') {
    const now = resolveMark(m.recipe, book, env.items)
    return { recipeNow: now?.ref ?? null, stale: now === undefined }
  }
  if (m.kind === 'part') return { stale: gone(m.way) }
  if (m.kind === 'same') return { stale: gone(m.use) || gone(m.over) }
  if (m.kind === 'order') return { stale: m.ways.some(gone) }
  if (m.kind === 'ready') {
    const items = env.items
    if (!items) return { stale: false }
    if (m.match === 'item') return { stale: items.get(m.text, m.meta ?? 0) === undefined }
    return { stale: m.match === 'ore' ? items.withOre(m.text).length === 0 : !items.hasOrePrefix(m.text) }
  }
  return { stale: false }
}

// ── 一条记录给模型看的一行 ──

/** “当现成的”管的是什么：ingot parts / ingotSteel / 钢锭 [id/meta]。 */
export const readyWhat = (m: ReadyMethod): string => (m.match === 'prefix' ? `${m.text} parts` : m.match === 'ore' ? m.text : `${m.name ?? m.text} [${m.meta !== undefined ? `${m.text}/${m.meta}` : `${m.text}, any meta`}]`)

export function methodLine(m: Method, env: { book?: RecipeBook | undefined; items?: ItemTable | undefined } = {}): string {
  const tail = ` — ${methodSource(m)} [key ${m.key}]`
  // 做法的名字、物品、矿辞名现在找不到了：照实说
  const gone = m.kind !== 'thing' && m.kind !== 'machine' && methodState(m, env).stale === true ? ` [NOT FOUND ANY MORE in this ${m.kind === 'ready' ? 'item table' : 'recipe book'}]` : ''
  if (m.kind === 'part') return `${m.prefix}${m.material ? ` of ${m.material}` : ''} ← ${m.way}${m.from ? `, from ${m.from}` : ''}${gone}${tail}`
  if (m.kind === 'order') return `${m.ways.join(' > ')}${gone}${tail}`
  if (m.kind === 'ready') return `${readyWhat(m)}: taken ready-made, not made${gone}${tail}`
  if (m.kind === 'same') return `same ingredients: ${m.use} over ${m.over}${m.noTools ? ` (only when the ${m.use} recipe needs no tools)` : ''}${gone}${tail}`
  if (m.kind === 'machine') {
    const parts = [m.does, ...(m.feed ? [`feed: ${formatPos(m.feed)}`] : []), ...(m.collect ? [`collect: ${formatPos(m.collect)}`] : []), ...(m.keep ? [`do not touch: ${m.keep}`] : [])]
    return `${m.name ?? 'machine'} at ${formatPos(m)}: ${parts.join('; ')}${tail}`
  }
  // 配方：对回现在的编号；对不回来就照实说
  const book = env.book
  const now = book ? resolveMark(m.recipe, book, env.items) : undefined
  const recipe = !book
    ? `${m.recipe.wayName}: ${m.recipe.text} (recipe #${m.recipe.ref} when it was recorded)`
    : now
      ? `#${now.ref} ${m.recipe.wayName}: ${m.recipe.text}`
      : `NO LONGER IN THE RECIPE BOOK — it was ${m.recipe.wayName}: ${m.recipe.text}`
  return `${m.name} ← ${recipe}${tail}`
}

// ── 写一条 ──

export interface MethodInput {
  ready?: string
  use?: string
  over?: string
  noTools?: boolean
  part?: string
  material?: string
  way?: string
  from?: string
  id?: string
  meta?: number
  fluid?: string
  recipe?: number
  order?: string[]
  machine?: MethodPos
  does?: string
  feed?: MethodPos
  collect?: MethodPos
  keep?: string
  why?: string
  by?: MethodBy
}

export interface MethodEnv {
  book?: RecipeBook | undefined
  items?: ItemTable | undefined
  fluids?: FluidTable | undefined
  now: number
  /** 这台机器叫什么（查得到的话）。 */
  machineName?: string
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const isPos = (v: unknown): v is MethodPos => typeof v === 'object' && v !== null && ['x', 'y', 'z'].every((k) => Number.isInteger((v as Record<string, unknown>)[k]))
const PREFIX_RE = /^[a-z][A-Za-z0-9]{1,30}$/

/**
 * 照给的内容造一条记录，顺手查对：做法的名字认不认得、配方做不做得出那样东西。
 * 给的是哪一种看带了什么：part（一类零件）、id / fluid + recipe（一样具体的东西）、order（总的先后）、machine（一台机器）。
 */
export function buildMethod(input: MethodInput, env: MethodEnv): { entry: Method } | { error: string } {
  const kinds = [input.part !== undefined, input.ready !== undefined, input.use !== undefined || input.over !== undefined, input.id !== undefined || input.fluid !== undefined, input.order !== undefined, input.machine !== undefined].filter(Boolean).length
  if (kinds !== 1) return { error: 'Give exactly one of: "part" (a kind of part and the way that makes it), "ready" (what is taken ready-made), "use" with "over" (which of two ways, when they take the same ingredients), "id" or "fluid" with "recipe" (one particular thing), "order" (ways, the first to use first), "machine" (what a machine is for).' }
  if (input.by !== 'owner' && input.by !== 'self') return { error: 'Say who decided it: by "owner" (your owner said so) or "self" (you decided).' }
  const common = { by: input.by, at: env.now, why: text(input.why, METHOD_WHY_MAX_CHARS) }
  const book = env.book

  if (input.part !== undefined) {
    const prefix = input.part.trim()
    if (!PREFIX_RE.test(prefix)) return { error: `"${prefix}" is not an ore-dictionary prefix: it is the part of an ore name before the material, such as "plate" in plateSteel, "stick", "screw", "wireGt01" (find_item shows an item's ore names).` }
    if (!book) return { error: 'There is no recipe book on this brain, so a way of making cannot be checked.' }
    if (input.way === undefined) return { error: 'A kind of part needs "way": the way that makes it, named as find_recipes lists the ways.' }
    const way = waysNamed(book, input.way)
    if ('error' in way) return way
    const material = text(input.material, 60)
    const from = text(input.from, 40)
    if (from.length > 0 && !PREFIX_RE.test(from)) return { error: `"from" is an ore-dictionary prefix too (the form it is made from, e.g. "ingot"), not "${from}".` }
    if (material.length > 0 && env.items && env.items.withOre(`${prefix}${material}`).length === 0) return { error: `No item is registered under the ore name ${prefix}${material}: "material" is the rest of the ore name after the prefix, e.g. "Steel" in plateSteel.` }
    return { entry: { ...common, kind: 'part', key: partKey(prefix, material || undefined), prefix, way: way.name, ...(material ? { material } : {}), ...(from ? { from } : {}) } }
  }

  if (input.ready !== undefined) {
    const wanted = input.ready.trim()
    // 一样物品：mod:name 或 mod:name/meta
    if (wanted.includes(':')) {
      const cut = wanted.lastIndexOf('/')
      const meta = cut > 0 && /^\d+$/.test(wanted.slice(cut + 1)) ? Number(wanted.slice(cut + 1)) : undefined
      const id = meta !== undefined ? wanted.slice(0, cut) : wanted
      const item = env.items?.get(id, meta ?? 0)
      if (env.items && !item) return { error: `No item ${meta !== undefined ? `${id}/${meta}` : id} is known: give an item id as find_item shows it, or an ore-dictionary prefix such as "ingot".` }
      return { entry: { ...common, kind: 'ready', key: readyKey(id, meta), match: 'item', text: id, ...(meta !== undefined ? { meta } : {}), ...(item ? { name: item.name } : {}) } }
    }
    if (!PREFIX_RE.test(wanted)) return { error: `"${wanted}" is neither an ore-dictionary prefix ("ingot", "dust", "gem"), an ore name ("ingotSteel"), nor an item id ("mod:name" or "mod:name/meta").` }
    // 正好是一个矿辞名就是那一个；不然是前缀，得真有以它开头的矿辞名
    if (env.items && env.items.withOre(wanted).length > 0) return { entry: { ...common, kind: 'ready', key: readyKey(wanted), match: 'ore', text: wanted } }
    if (env.items && !env.items.hasOrePrefix(wanted)) return { error: `No ore name starts with "${wanted}": a prefix is the part of an ore name before the material, such as "ingot" in ingotSteel (find_item shows an item's ore names).` }
    return { entry: { ...common, kind: 'ready', key: readyKey(wanted), match: 'prefix', text: wanted } }
  }

  if (input.use !== undefined || input.over !== undefined) {
    if (!book) return { error: 'There is no recipe book on this brain, so ways of making cannot be checked.' }
    if (input.use === undefined || input.over === undefined) return { error: '"use" and "over" go together: the way to use, and the way not to use, when both make a thing from the same ingredients.' }
    const use = waysNamed(book, input.use)
    if ('error' in use) return use
    const over = waysNamed(book, input.over)
    if ('error' in over) return over
    if (use.name === over.name) return { error: `"use" and "over" are the same way (${use.name}).` }
    return { entry: { ...common, kind: 'same', key: sameKey(use.name, over.name), use: use.name, over: over.name, ...(input.noTools === true ? { noTools: true as const } : {}) } }
  }

  if (input.order !== undefined) {
    if (!book) return { error: 'There is no recipe book on this brain, so ways of making cannot be checked.' }
    if (!Array.isArray(input.order) || input.order.length === 0) return { error: '"order" lists the ways, the one to use first in front.' }
    const ways: string[] = []
    for (const name of input.order.slice(0, ORDER_MAX)) {
      const way = waysNamed(book, String(name))
      if ('error' in way) return way
      if (!ways.includes(way.name)) ways.push(way.name)
    }
    return { entry: { ...common, kind: 'order', key: ORDER_KEY, ways } }
  }

  if (input.machine !== undefined) {
    if (!isPos(input.machine)) return { error: '"machine" is the position of the machine: {x, y, z}.' }
    const does = text(input.does, METHOD_TEXT_MAX_CHARS)
    if (does.length === 0) return { error: 'A machine needs "does": what it is for, in a sentence.' }
    for (const key of ['feed', 'collect'] as const) if (input[key] !== undefined && !isPos(input[key])) return { error: `"${key}" is the position of a container: {x, y, z}.` }
    const at = { x: input.machine.x, y: input.machine.y, z: input.machine.z }
    const keep = text(input.keep, METHOD_TEXT_MAX_CHARS)
    return {
      entry: {
        ...common,
        kind: 'machine',
        key: machineKey(at),
        ...at,
        does,
        ...(env.machineName ? { name: env.machineName } : {}),
        ...(input.feed ? { feed: { x: input.feed.x, y: input.feed.y, z: input.feed.z } } : {}),
        ...(input.collect ? { collect: { x: input.collect.x, y: input.collect.y, z: input.collect.z } } : {}),
        ...(keep ? { keep } : {}),
      },
    }
  }

  // 一样具体的东西 → 一条配方
  if (input.id !== undefined && input.fluid !== undefined) return { error: 'Give "id" (an item) or "fluid", not both.' }
  if (!book) return { error: 'There is no recipe book on this brain, so a recipe cannot be recorded.' }
  if (input.recipe === undefined) return { error: 'A particular thing needs "recipe": the # number of the recipe that makes it (from find_recipes).' }
  const recipe = book.get(input.recipe)
  if (!recipe) return { error: `There is no recipe #${input.recipe}. Take the number from find_recipes (numbers change when the recipe book is re-exported).` }
  const nm = namer(env.items)
  if (input.fluid !== undefined) {
    const wanted = input.fluid.trim()
    const found = env.fluids?.get(wanted) ? [env.fluids.get(wanted)!] : (env.fluids?.search(wanted).exact ?? [])
    if (found.length !== 1) return { error: found.length === 0 ? `No fluid is named "${wanted}": give its internal name (find_item shows it in brackets).` : `${found.length} fluids are named "${wanted}": ${found.map(fluidLabel).join(', ')}. Give the internal name in the brackets.` }
    const fluid = found[0]!
    if (!recipe.fout.some((f) => f.f === fluid.fluid)) return { error: `Recipe #${recipe.ref} (${recipe.handler.name}) does not give ${fluidLabel(fluid)}: it is ${recipeText(recipe, nm)}.` }
    return { entry: { ...common, kind: 'thing', key: thingKey(thingKeyOfFluid(fluid.fluid)), thing: thingKeyOfFluid(fluid.fluid), name: fluid.name, recipe: recipeMark(recipe, env.items) } }
  }
  const id = (input.id ?? '').trim()
  const meta = input.meta ?? 0
  const thing = thingKeyOfSlot({ kind: 'item', id, meta, n: 1 }, env.items)
  // 做得出它：产物里有它，或者有登记在同一个材料件矿辞名下的
  const makes = recipe.out.some((o) => o.chance === undefined && thingKeyOfSlot({ kind: 'item', id: o.id, meta: o.meta, n: 1 }, env.items) === thing)
  if (!makes) return { error: `Recipe #${recipe.ref} (${recipe.handler.name}) does not make ${nm.label(id, meta)}: it is ${recipeText(recipe, nm)}.` }
  return { entry: { ...common, kind: 'thing', key: thingKey(thing), thing, name: nm.name(id, meta), recipe: recipeMark(recipe, env.items) } }
}

// ── 带在别处的那一条 ──

/** 查一样东西的做法时：基地的做法里有没有定过它（这一样，或者它这一类零件）。 */
export function methodNoteForThing(methods: MethodAccess | undefined, env: { book?: RecipeBook | undefined; items?: ItemTable | undefined }, thing: { key: string; members: readonly { id: string; meta: number }[] }): string | undefined {
  if (!methods) return undefined
  const lines: string[] = []
  const own = methods.thingFor(thing.key)
  if (own) {
    const now = resolveMark(own.recipe, env.book, env.items)
    lines.push(
      now
        ? `The base's methods have a recipe for this thing: #${now.ref} (${own.recipe.wayName}) — ${methodSource(own)}.`
        : `The base's methods have a recipe for this thing, but it is no longer in the recipe book (it was ${own.recipe.wayName}: ${own.recipe.text}) — ${methodSource(own)}. [key ${own.key}]`,
    )
  }
  const ready = readyMethodFor(methods.list(), thing, env.items)
  if (ready) lines.push(`The base's methods take ${readyWhat(ready)} ready-made (total_materials does not make them) — ${methodSource(ready)}.`)
  const part = partMethodFor(methods.list(), oresOfThing(thing, env.items))
  if (part) lines.push(`The base's methods for ${part.entry.prefix} parts${part.entry.material ? ` of ${part.entry.material}` : ''}: ${part.entry.way}${part.entry.from ? `, from ${part.entry.from}` : ''} — ${methodSource(part.entry)}.${own ? ' (The recipe recorded for this thing itself comes first.)' : ''}`)
  return lines.length > 0 ? lines.join('\n') : undefined
}

/** 看一台机器时：基地的做法里记没记它是干什么的。 */
export function methodNoteForMachine(methods: MethodAccess | undefined, at: MethodPos): string | undefined {
  const m = methods?.machineAt(at)
  if (!m) return undefined
  const parts = [m.does, ...(m.feed ? [`feed: ${formatPos(m.feed)}`] : []), ...(m.collect ? [`collect: ${formatPos(m.collect)}`] : []), ...(m.keep ? [`do not touch: ${m.keep}`] : [])]
  return `in the base's methods: ${parts.join('; ')} — ${methodSource(m)}`
}

// ── 工具 ──

const NO_STORE = "The base's methods are not available on this brain."
const KINDS: Method['kind'][] = ['part', 'ready', 'same', 'order', 'thing', 'machine']
const KIND_HEAD: Record<Method['kind'], string> = {
  part: 'Kinds of parts (ore-dictionary prefix ← the way that makes it)',
  ready: 'Taken ready-made (not made)',
  same: 'Which way, when two take the same ingredients',
  order: 'Order of ways when nothing more specific applies',
  thing: 'Particular things (thing ← its recipe)',
  machine: 'Machines (what each is for)',
}

export const baseMethods: Tool = {
  name: 'base_methods',
  description:
    "The base's methods: the record of how this base makes things, what your owner taught and what you decided — the way that makes a kind of part, the recipe for a particular thing, the order of ways when nothing more specific applies, what a machine is for. total_materials follows it. Lists the entries: who decided each, when, why, and its key.",
  inputSchema: obj({
    kind: str('Only this kind.', { enum: KINDS }),
    query: str('Only entries containing this text.', { maxLength: 80 }),
  }),
  async run(ctx, i: { kind?: Method['kind']; query?: string }) {
    const methods = ctx.methods
    if (!methods) return fail(NO_STORE)
    const all = methods.list()
    const env = { book: ctx.packdata?.recipes, items: ctx.packdata?.items }
    const wanted = (i.query ?? '').trim().toLowerCase()
    const shown = all.filter((m) => (i.kind === undefined || m.kind === i.kind) && (wanted.length === 0 || methodLine(m, env).toLowerCase().includes(wanted)))
    if (all.length === 0) return { content: "The base's methods are empty: nothing has been recorded yet. set_base_method records an entry.", data: { total: 0, entries: [] } }
    const lines = [`The base's methods: ${all.length} entr${all.length === 1 ? 'y' : 'ies'}${shown.length !== all.length ? `, ${shown.length} shown` : ''} (how this base makes things: what your owner taught and what you decided; total_materials follows them).`]
    for (const kind of KINDS) {
      const of = shown.filter((m) => m.kind === kind)
      if (of.length === 0) continue
      lines.push(`${KIND_HEAD[kind]}${kind === 'order' ? '' : ` (${of.length})`}:`)
      for (const m of of) lines.push(`- ${methodLine(m, env)}`)
    }
    if (shown.length === 0) lines.push('Nothing matches.')
    return { content: lines.join('\n'), data: { total: all.length, entries: shown } }
  },
}

export const setBaseMethod: Tool = {
  name: 'set_base_method',
  description:
    'Record, change or remove one entry of the base\'s methods (kept across restarts; the same key replaces). What you give tells the kind: "part" + "way": a kind of part is made this way; "ready": taken ready-made, not made; "use" + "over": when both ways make a thing from the same ingredients (tools not counted), "use" is used; "id" or "fluid" + "recipe": this particular thing is made by that recipe; "order": ways, in the order to use them when nothing more specific applies; "machine" + "does": what the machine there is for. "remove": the key of an entry to delete.',
  inputSchema: obj({
    part: str('Ore-dictionary prefix of a kind of part: "plate", "stick", "screw", "wireGt01".'),
    material: str('With "part": only this material, e.g. "Steel".'),
    way: str('With "part": the way, as find_recipes names it, e.g. "卷板机".'),
    from: str('With "part": the form it is made from, e.g. "ingot".'),
    ready: str('Prefix ("ingot"), ore name ("ingotSteel") or item id ("mod:name/meta").'),
    use: str('A way, e.g. "有序合成".'),
    over: str('The other way, e.g. "组装机".'),
    noTools: bool('With "use": only when its recipe needs no tools.'),
    id: str('Item id of a particular thing.'),
    meta: int('Its meta (default 0).', { min: 0 }),
    fluid: str('Or a fluid, by name.'),
    recipe: int('Its recipe #.', { min: 0 }),
    order: arr('Ways, the first to use first.', str(undefined), { min: 1, max: ORDER_MAX }),
    machine: pos('A machine.'),
    does: str('What it is for.'),
    feed: pos('The container that feeds it.'),
    collect: pos('Where its products end up.'),
    keep: str('What to leave alone on it.'),
    by: str('"owner": your owner said so; "self": you decided.', { enum: ['owner', 'self'] }),
    why: str('The reason, in a sentence.'),
    remove: str('Key of an entry to delete.'),
  }),
  async run(ctx: ToolContext, i: MethodInput & { remove?: string }) {
    const methods = ctx.methods
    if (!methods) return fail(NO_STORE)
    const env = { book: ctx.packdata?.recipes, items: ctx.packdata?.items }
    if (i.remove !== undefined) {
      const gone = methods.get(i.remove.trim())
      if (!gone || !methods.remove(gone.key)) return fail(`The base's methods have no entry with the key "${i.remove.trim()}". base_methods shows the keys.`)
      return `Removed from the base's methods: ${methodLine(gone, env)}`
    }
    // 机器叫什么：身边看得到就记下（看不到不耽误记）
    let machineName: string | undefined
    if (i.machine !== undefined && Number.isInteger(i.machine.x)) {
      const around = await lookAround(ctx).catch(() => undefined)
      const seen = around?.machines.find((m) => m.x === i.machine!.x && m.y === i.machine!.y && m.z === i.machine!.z)
      const info = seen?.id !== undefined ? ctx.packdata?.items?.get(seen.id, seen.meta ?? 0) : undefined
      machineName = info?.name ?? seen?.name
    }
    const built = buildMethod(i, { ...env, fluids: ctx.packdata?.fluids, now: ctx.now(), ...(machineName ? { machineName } : {}) })
    if ('error' in built) return fail(built.error)
    const before = methods.get(built.entry.key)
    try {
      methods.set(built.entry)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
    return `${before ? 'Changed in' : 'Recorded in'} the base's methods: ${methodLine(built.entry, env)}${before ? `\nIt replaces: ${methodLine(before, env)}` : ''}`
  },
}
