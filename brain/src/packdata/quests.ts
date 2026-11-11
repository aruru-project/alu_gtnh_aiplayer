// 本地任务书：quests.jsonl + questlines.json（格式见 docs/PACKDATA.md 的“任务书”一节）。
// 这里只有静态内容和纯计算：按 id 取任务、按词/章节/状态找任务、由“已完成的任务 id”算出每个任务是做完了、能做还是没解锁。
// 谁完成了哪些要问服务器（quest.progress），那不归这一层管。

import { isRecord } from '../util.ts'

/** 任务要的或奖励的一样物品。meta 缺省是任何变体都行；ore 是可以用登记在这个矿辞名下的任何物品代替。 */
export interface PackItem {
  id?: string
  meta?: number
  count: number
  ore?: string
  /** 物品自带的 NBT（蜜蜂的种类、附魔书的附魔……）。 */
  nbt?: unknown
}

export interface PackQuestTask {
  /** retrieval、optional_retrieval、crafting、checkbox、hunt、location、fluid、meeting…… */
  type: string
  items?: PackItem[]
  /** items 里有任意一样就够。 */
  anyOne?: boolean
  /** 比对物品时不看 NBT。 */
  ignoreNBT?: boolean
  /** 交任务时东西会不会被收走。 */
  consume?: boolean
  fluids?: { fluid: string; mb: number }[]
  /** crafting：怎么做出来的才算，craft / smelt / anvil。 */
  allow?: string[]
  /** hunt（打这么多只）、meeting（走到这么多只旁边）：生物的注册名和个数。 */
  target?: string
  count?: number
  range?: number
  /** 有 range 才有 x y z（离那个点多近）；没有就是到了那个维度就算。 */
  location?: { name?: string; dim?: number; x?: number; y?: number; z?: number; range?: number; biome?: number; structure?: string; invert?: boolean }
}

export interface PackQuestReward {
  /** item（都给）、choice（挑一样）、questcompletion（顺带把另一个任务标成完成）、xp…… */
  type: string
  items?: PackItem[]
  quest?: string
  amount?: number
  levels?: boolean
}

export interface PackQuest {
  /** 和服务器（quest.progress、quest.get）用的是同一种 id：老任务是一小段十六进制数，新任务是完整的小写 UUID。 */
  id: string
  /** 中文名；整合包没翻译的是英文原文。 */
  name: string
  /** 英文原名；和 name 一样时没有。 */
  en?: string
  desc: string
  descEn?: string
  /**
   * 所在章节的 id，按书里章节的顺序；空的是不在任何章节里（玩家在书里看不到）。
   * QuestBook 里的任务，这一项一律按 questlines.json 重新填过，和章节表不会对不上。
   */
  lines: string[]
  main: boolean
  /** 不是 NORMAL 时才有：CHAIN、UNLOCKED、SECRET、HIDDEN。 */
  visibility?: string
  /** 前置任务的 id。 */
  pre: string[]
  /** 前置之间的关系：AND（全部）、OR（任意一个）、XOR（恰好一个）…… */
  logic: string
  /** 子任务之间的关系：AND 或 OR。 */
  taskLogic: string
  /** 可以重复做：做完多少 tick 之后能再做。 */
  repeat?: number
  autoClaim?: boolean
  tasks: PackQuestTask[]
  rewards: PackQuestReward[]
}

export interface PackQuestLine {
  id: string
  name: string
  en?: string
  desc: string
  descEn?: string
  /** 这一章里的任务，按推进的先后排。 */
  quests: string[]
}

/** complete 做完了；available 前置满足、还没做完（现在能做）；locked 前置没满足。 */
export type QuestState = 'complete' | 'available' | 'locked'

const LEGACY_PREFIX = '00000000-0000-0000-0000-'

/**
 * 把模型或服务器给的任务 id 整理成资料里的写法：小写；老任务（一小段十六进制数，或者它穿着 UUID 外衣的样子）去掉前导零。
 * 和 mod 的 Quests.shortId 是同一套规矩。
 */
export function normalizeQuestId(raw: string): string {
  let id = raw.trim().toLowerCase()
  if (id.startsWith(LEGACY_PREFIX) && id.length === 36) id = id.slice(LEGACY_PREFIX.length)
  if (/^[0-9a-f]{1,12}$/.test(id)) return id.replace(/^0+(?=.)/, '')
  return id
}

/** 像不像一个任务 id（十六进制短号或 UUID）。 */
export function isQuestId(id: string): boolean {
  return /^[0-9a-f]{1,12}$/.test(id) || /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)
}

/**
 * BetterQuesting 的 EnumLogic.getResult：done 是已满足的个数，total 是总数。
 * （对着 BetterQuesting 3.8.92-GTNH 的字节码核对过；XNOR 在它那里就是“差一个全满”。）
 */
export function logicHolds(logic: string, done: number, total: number): boolean {
  switch (logic) {
    case 'OR':
      return done > 0
    case 'XOR':
      return done === 1
    case 'NAND':
      return done < total
    case 'NOR':
      return done === 0
    case 'XNOR':
      return done === total - 1
    default:
      return done >= total
  }
}

export interface QuestFilter {
  /** 空格隔开的词，每个都要出现在名称或描述里（中文、英文都算）。 */
  query?: string
  /** 章节名（中文或英文）的一部分。 */
  line?: string
  /** unclaimed：做完了、奖励还没领的（complete 里的一部分）。 */
  state?: QuestState | 'unclaimed'
  /** 这个玩家已完成的任务 id；按状态筛、或者想让结果带上状态时给。 */
  done?: ReadonlySet<string>
  /** 其中有奖励还没领的。 */
  unclaimed?: ReadonlySet<string>
}

export interface QuestMatch {
  quest: PackQuest
  /** 结果里显示的章节：按章节筛时是对得上的那一章，否则是它的第一章。 */
  line: PackQuestLine
  state?: QuestState
  /** 做完了，奖励还没领。 */
  unclaimed?: boolean
}

export interface QuestSearchResult {
  /** 全部结果，已经排好：没给词时按书里的顺序；给了词时名称里对上的在前。 */
  matches: QuestMatch[]
  /** 给了 line 时，名字对得上的章节（一个都没有说明章节名写错了）。 */
  lines?: PackQuestLine[]
  /** 也符合条件、但不在任何章节里的任务数（书里看不到的内部任务，不列出来）。 */
  outsideBook: number
}

interface Indexed {
  quest: PackQuest
  /** 在书里的先后；不在任何章节里的是 -1。 */
  order: number
  title: string
  text: string
}

export class QuestBook {
  /** 章节，按书里的顺序。 */
  readonly lines: readonly PackQuestLine[]
  private readonly byId = new Map<string, Indexed>()
  private readonly lineById = new Map<string, PackQuestLine>()
  /** 在书里的任务，按书里的顺序（一章接一章，每个任务算在它第一次出现的地方）。 */
  private readonly inBook: Indexed[] = []
  private readonly outside: Indexed[] = []

  constructor(quests: readonly PackQuest[], lines: readonly PackQuestLine[]) {
    for (const given of quests) {
      if (this.byId.has(given.id)) continue
      // 谁在哪一章以章节表为准（下面填），不看任务自己那份
      const quest: PackQuest = { ...given, lines: [] }
      this.byId.set(quest.id, {
        quest,
        order: -1,
        title: `${quest.name}\n${quest.en ?? ''}`.toLowerCase(),
        text: `${quest.desc}\n${quest.descEn ?? ''}`.toLowerCase(),
      })
    }
    // 章节里列着、但任务表里没有的任务不算数
    this.lines = lines.map((line) => ({ ...line, quests: [...new Set(line.quests)].filter((id) => this.byId.has(id)) }))
    for (const line of this.lines) {
      this.lineById.set(line.id, line)
      for (const id of line.quests) {
        const entry = this.byId.get(id)!
        if (!entry.quest.lines.includes(line.id)) entry.quest.lines.push(line.id)
        if (entry.order >= 0) continue
        entry.order = this.inBook.length
        this.inBook.push(entry)
      }
    }
    for (const entry of this.byId.values()) if (entry.order < 0) this.outside.push(entry)
  }

  /** 任务总数（包括不在任何章节里的）。 */
  get size(): number {
    return this.byId.size
  }

  get(id: string): PackQuest | undefined {
    return this.byId.get(normalizeQuestId(id))?.quest
  }

  /** 任务所在的章节，按书里的顺序。 */
  linesOf(quest: PackQuest): PackQuestLine[] {
    return quest.lines.map((id) => this.lineById.get(id)).filter((l): l is PackQuestLine => l !== undefined)
  }

  questsOf(line: PackQuestLine): PackQuest[] {
    return line.quests.map((id) => this.byId.get(id)!.quest)
  }

  /**
   * 和 BetterQuesting 算“解锁”的办法一样：没有前置就是解锁的；否则数一数前置里做完了几个，交给前置之间的关系去判。
   * 前置指向一个不存在的任务时，它算进总数，但永远不算做完。
   */
  state(quest: PackQuest, done: ReadonlySet<string>): QuestState {
    if (done.has(quest.id)) return 'complete'
    if (quest.pre.length === 0) return 'available'
    const met = quest.pre.filter((id) => this.byId.has(id) && done.has(id)).length
    return logicHolds(quest.logic, met, quest.pre.length) ? 'available' : 'locked'
  }

  /** 一章的进度：做完的、现在能做的。 */
  progressOf(line: PackQuestLine, done: ReadonlySet<string>): { complete: number; available: number } {
    let complete = 0
    let available = 0
    for (const quest of this.questsOf(line)) {
      const state = this.state(quest, done)
      if (state === 'complete') complete++
      else if (state === 'available') available++
    }
    return { complete, available }
  }

  find(filter: QuestFilter): QuestSearchResult {
    const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 0)
    const wantLine = filter.line?.trim().toLowerCase()
    const lines = wantLine === undefined || wantLine.length === 0 ? undefined : this.lines.filter((l) => `${l.name}\n${l.en ?? ''}`.toLowerCase().includes(wantLine))
    const lineIds = lines ? new Set(lines.map((l) => l.id)) : undefined

    /** 这个任务符合条件的话，给出它名称里没对上（只在描述里对上）的词数；不符合是 undefined。 */
    const fits = (entry: Indexed): { misses: number; state: QuestState | undefined; unclaimed: boolean } | undefined => {
      const state = filter.done ? this.state(entry.quest, filter.done) : undefined
      const unclaimed = state === 'complete' && filter.unclaimed?.has(entry.quest.id) === true
      if (filter.state === 'unclaimed' ? !unclaimed : filter.state !== undefined && state !== filter.state) return undefined
      let misses = 0
      for (const word of words) {
        if (entry.title.includes(word)) continue
        if (!entry.text.includes(word)) return undefined
        misses++
      }
      return { misses, state, unclaimed }
    }

    const found: { match: QuestMatch; misses: number; entry: Indexed }[] = []
    for (const entry of this.inBook) {
      const lineId = lineIds ? entry.quest.lines.find((id) => lineIds.has(id)) : entry.quest.lines[0]
      if (lineId === undefined) continue
      const fit = fits(entry)
      if (!fit) continue
      const match: QuestMatch = { quest: entry.quest, line: this.lineById.get(lineId)! }
      if (fit.state !== undefined) match.state = fit.state
      if (fit.unclaimed) match.unclaimed = true
      found.push({ match, misses: fit.misses, entry })
    }
    if (words.length > 0) {
      // 名称里对上的词越多越靠前；词全在名称里的，名称短的（更像就是要找的那个）在前；其余按书里的顺序
      const length = (f: { misses: number; match: QuestMatch }): number => (f.misses === 0 ? f.match.quest.name.length : 0)
      found.sort((a, b) => a.misses - b.misses || length(a) - length(b) || a.entry.order - b.entry.order)
    }
    // 按章节筛的时候，不在任何章节里的任务本来就不可能对上
    const outsideBook = lineIds ? 0 : this.outside.filter((entry) => fits(entry) !== undefined).length
    const result: QuestSearchResult = { matches: found.map((f) => f.match), outsideBook }
    if (lines) result.lines = lines
    return result
  }
}

// ── 读文件 ──

function text(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function optionalText(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
}

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : []
}

function parseItems(v: unknown): PackItem[] {
  return records(v).map((raw) => {
    const item: PackItem = { count: typeof raw.count === 'number' && raw.count > 0 ? raw.count : 1 }
    if (typeof raw.id === 'string' && raw.id.length > 0) item.id = raw.id
    if (typeof raw.meta === 'number') item.meta = raw.meta
    const ore = optionalText(raw.ore)
    if (ore !== undefined) item.ore = ore
    if (raw.nbt !== undefined && raw.nbt !== null) item.nbt = raw.nbt
    return item
  })
}

function parseTask(raw: Record<string, unknown>): PackQuestTask {
  const task: PackQuestTask = { type: optionalText(raw.type) ?? 'unknown' }
  const items = parseItems(raw.items)
  if (items.length > 0) task.items = items
  if (raw.anyOne === true) task.anyOne = true
  if (raw.ignoreNBT === true) task.ignoreNBT = true
  if (typeof raw.consume === 'boolean') task.consume = raw.consume
  const fluids = records(raw.fluids).flatMap((f) => (typeof f.fluid === 'string' && typeof f.mb === 'number' ? [{ fluid: f.fluid, mb: f.mb }] : []))
  if (fluids.length > 0) task.fluids = fluids
  if (Array.isArray(raw.allow)) task.allow = ids(raw.allow)
  const target = optionalText(raw.target)
  if (target !== undefined) task.target = target
  if (typeof raw.count === 'number') task.count = raw.count
  if (typeof raw.range === 'number') task.range = raw.range
  if (isRecord(raw.location)) {
    const l = raw.location
    const location: NonNullable<PackQuestTask['location']> = {}
    const name = optionalText(l.name)
    if (name !== undefined) location.name = name
    for (const key of ['dim', 'x', 'y', 'z', 'range', 'biome'] as const) {
      const n = l[key]
      if (typeof n === 'number') location[key] = n
    }
    const structure = optionalText(l.structure)
    if (structure !== undefined) location.structure = structure
    if (l.invert === true) location.invert = true
    task.location = location
  }
  return task
}

function parseReward(raw: Record<string, unknown>): PackQuestReward {
  const reward: PackQuestReward = { type: optionalText(raw.type) ?? 'unknown' }
  const items = parseItems(raw.items)
  if (items.length > 0) reward.items = items
  const quest = optionalText(raw.quest)
  if (quest !== undefined) reward.quest = quest
  if (typeof raw.amount === 'number') {
    reward.amount = raw.amount
    reward.levels = raw.levels === true
  }
  return reward
}

/** quests.jsonl 的一行。认不出来（没有 id 或名字）时返回 undefined；里面类型不对的项当它没有。 */
export function parseQuest(raw: unknown): PackQuest | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || typeof raw.name !== 'string') return undefined
  const quest: PackQuest = {
    id: raw.id,
    name: raw.name,
    desc: text(raw.desc),
    lines: ids(raw.lines),
    main: raw.main === true,
    pre: ids(raw.pre),
    logic: optionalText(raw.logic) ?? 'AND',
    taskLogic: optionalText(raw.taskLogic) ?? 'AND',
    tasks: records(raw.tasks).map(parseTask),
    rewards: records(raw.rewards).map(parseReward),
  }
  const en = optionalText(raw.en)
  if (en !== undefined) quest.en = en
  const descEn = optionalText(raw.descEn)
  if (descEn !== undefined) quest.descEn = descEn
  const visibility = optionalText(raw.visibility)
  if (visibility !== undefined) quest.visibility = visibility
  if (typeof raw.repeat === 'number' && raw.repeat >= 0) quest.repeat = raw.repeat
  if (raw.autoClaim === true) quest.autoClaim = true
  return quest
}

export function parseQuestLine(raw: unknown): PackQuestLine | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0 || typeof raw.name !== 'string') return undefined
  const line: PackQuestLine = { id: raw.id, name: raw.name, desc: text(raw.desc), quests: ids(raw.quests) }
  const en = optionalText(raw.en)
  if (en !== undefined) line.en = en
  const descEn = optionalText(raw.descEn)
  if (descEn !== undefined) line.descEn = descEn
  return line
}
