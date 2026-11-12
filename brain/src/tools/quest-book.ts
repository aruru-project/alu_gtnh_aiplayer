// 任务书工具读本地资料的那一半：内容（中文）来自 ctx.packdata.quests，谁做完了哪些问服务器（quest.progress），
// 做完了 / 现在能做 / 没解锁由前置关系在这里算。

import { BridgeError } from '../bridge/protocol.ts'
import type { QuestDetail, QuestParty } from '../bridge/protocol.ts'
import type { PackItem, PackQuest, PackQuestReward, PackQuestTask, QuestBook, QuestState } from '../packdata/index.ts'
import { isQuestId, normalizeQuestId } from '../packdata/index.ts'
import { compactJson, dimName, formatPos, questItemText } from './format.ts'
import { QuestProgressCache } from './quest-progress.ts'
import { ToolFailure, fail } from './types.ts'
import type { ToolContext, ToolResult } from './types.ts'

export const QUEST_SEARCH_DEFAULT_LIMIT = 20
/** 描述超过这么长就截断并写明（中文描述最长的也就两千多字，英文原文有五千多的）。 */
export const QUEST_DESCRIPTION_MAX_CHARS = 4000
const NBT_SHOWN_CHARS = 120

interface Progress {
  /** 看的是谁的进度；没有进度可看时是 undefined。 */
  player?: string
  done?: ReadonlySet<string>
  /** 做完了、有奖励还没领的。 */
  unclaimed?: ReadonlySet<string>
  /** 有人可看、却没看成的原因。 */
  why?: string
  /** 附在结果后面的说明（没看成进度时）。 */
  note: string
}

/**
 * 看谁的进度：模型点名的；没点名就是默认的那个玩家（主人名单里的第一个，或者刚才跟它说话的人）。
 * 问不到进度（服务器没见过这个人、连不上游戏、mod 太旧）不算失败：任务的内容照样给，只是不带进度，并说明原因。
 */
async function progressFor(ctx: ToolContext, given: string | undefined): Promise<Progress> {
  const who = given !== undefined && given.trim().length > 0 ? given.trim() : ctx.defaultPlayer?.()
  if (who === undefined) return { note: '' }
  const source = ctx.questProgress ?? new QuestProgressCache(ctx.bridge, () => ctx.now(), 0)
  try {
    const progress = await source.get(who)
    if (progress.known) return { player: who, done: progress.done, unclaimed: progress.unclaimed, note: '' }
    const why = `the game server has never seen a player named ${who}`
    return { why, note: `\nNote: ${why}, so no progress is shown. Give "player" to see someone's progress.` }
  } catch (e) {
    if (!(e instanceof BridgeError)) throw e
    const why =
      e.code === 'unknown_method'
        ? "the game server's mod is too old to report quest progress"
        : e.code === 'not_found' && /no quest book/i.test(e.message)
          ? 'this server has no quest book (BetterQuesting is not installed)'
          : `the game server could not be asked who completed what (${e.code}: ${e.message})`
    return { why, note: `\nNote: ${why}, so no progress is shown. What the quests say is still right.` }
  }
}

/** list_quest_lines 给程序的 data：每章一项；complete / available 只在看得到某个玩家的进度时有。 */
export interface QuestLinesData {
  /** 任务书一共多少个任务。 */
  quests?: number
  /** 看的是谁的进度；没有进度可看时没有这一项。 */
  player?: string
  lines: { name: string; en?: string; quests: number; complete?: number; available?: number }[]
  /** 做完了、奖励还没领的任务有几个（有进度时）。 */
  unclaimed?: number
}

export async function listQuestLinesLocal(ctx: ToolContext, book: QuestBook, given: string | undefined): Promise<ToolResult> {
  const progress = await progressFor(ctx, given)
  const { done } = progress
  const data: QuestLinesData = { quests: book.size, ...(done && progress.player !== undefined ? { player: progress.player } : {}), lines: [] }
  const head =
    `The quest book has ${book.size} quests in ${book.lines.length} chapters, in the book's order. ` +
    (done
      ? `Progress of ${progress.player} per chapter: done / can be done now / total.`
      : `Quests per chapter${progress.why === undefined ? ' (no player given, so no progress)' : ''}:`)
  const rows = book.lines.map((line) => {
    const name = line.en ? `${line.name} (${line.en})` : line.name
    const entry: QuestLinesData['lines'][number] = { name: line.name, ...(line.en ? { en: line.en } : {}), quests: line.quests.length }
    data.lines.push(entry)
    if (!done) return `- ${name}: ${line.quests.length}`
    const { complete, available } = book.progressOf(line, done)
    entry.complete = complete
    entry.available = available
    return `- ${name}: ${complete} / ${available} / ${line.quests.length}`
  })
  // 奖励没领的：提醒主人去领
  const waiting = done ? book.find({ state: 'unclaimed', done, ...(progress.unclaimed ? { unclaimed: progress.unclaimed } : {}) }).matches.length : 0
  const rewards = waiting > 0 ? `\n${waiting} finished quest(s) still have a reward ${progress.player} has not collected: find_quests with state "unclaimed" lists them.` : ''
  if (done) data.unclaimed = waiting
  return { content: `${head}\n${rows.join('\n')}${rewards}${progress.note}`, data }
}

export interface FindQuestsInput {
  query?: string
  line?: string
  state?: string
  player?: string
  limit?: number
  page?: number
}

export async function findQuestsLocal(ctx: ToolContext, book: QuestBook, i: FindQuestsInput): Promise<ToolResult | string> {
  const query = i.query?.trim() || undefined
  const line = i.line?.trim() || undefined
  const state = i.state as QuestState | 'unclaimed' | undefined
  const progress = await progressFor(ctx, i.player)
  if (state !== undefined && !progress.done) {
    // 按状态筛要知道是谁的进度
    throw new ToolFailure(
      progress.why === undefined ? 'Filtering by state needs a player whose progress to look at: give "player".' : `Cannot filter by state: ${progress.why}.`,
    )
  }
  const found = book.find({
    ...(query !== undefined ? { query } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(progress.done ? { done: progress.done } : {}),
    ...(progress.unclaimed ? { unclaimed: progress.unclaimed } : {}),
  })
  if (found.lines && found.lines.length === 0) {
    return fail(`No chapter of the quest book has "${line}" in its name (Chinese or English). The library function list_quest_lines shows the chapters.`)
  }

  const filters: string[] = []
  if (state) filters.push(`state ${state}`)
  if (line) filters.push(`chapter contains "${line}"`)
  if (query) filters.push(`words "${query}"`)
  const what = `${filters.length > 0 ? ` (${filters.join('; ')})` : ''}${progress.player ? ` for ${progress.player}` : ''}`
  const left =
    found.outsideBook > 0 ? `\n${found.outsideBook} more fit but are left out: internal quests that are in no chapter, which the book never shows.` : ''
  const total = found.matches.length
  if (total === 0) return `No quest matches${what}.${left}${progress.note}`

  const limit = i.limit ?? QUEST_SEARCH_DEFAULT_LIMIT
  const pages = Math.ceil(total / limit)
  const page = i.page ?? 1
  if (page > pages) return fail(`There is no page ${page}: ${total} quest(s) match${what}, which is ${pages} page(s) of ${limit}.`)
  const start = (page - 1) * limit
  const shown = found.matches.slice(start, start + limit)
  const head =
    pages === 1
      ? `${total} quest(s) match${what}:`
      : `${total} quests match${what}. This is page ${page} of ${pages} (quests ${start + 1}-${start + shown.length})${
          page < pages ? `; pass page ${page + 1} for the next ones, or narrow it down with query, line or state` : ''
        }.`
  const rows = shown.map((m) => {
    const marks = bookMarks(m.quest, m.state, m.unclaimed === true)
    return `- ${m.quest.id} "${m.quest.name}" [${m.line.name}]${m.quest.main ? ' (main)' : ''}${m.state ? `: ${m.state}${m.unclaimed ? UNCLAIMED : ''}` : ''}${marks.length > 0 ? ` {${marks.join(', ')}}` : ''}`
  })
  const marked = rows.some((r) => r.endsWith('}'))
  const legend = marked ? `; {…}: what is done by hand in the quest book: "hand in" (Detect/Submit takes items), "tick" (a checkbox), "pick one" (a reward to choose)` : ''
  return `${head} (id "title" [chapter]: state; "(main)" marks the main line${legend})\n${rows.join('\n')}${left}${progress.note}`
}

/**
 * 这个任务在书里有哪些要玩家亲手按的：交东西会被收走的子任务（只有按“检测/提交”才交）、勾选框、挑一样的奖励。
 * 做完了的不再说交和勾；奖励领过了的不再说挑。没有进度时（不知道状态）全说。
 */
export function bookMarks(quest: PackQuest, state: QuestState | undefined, unclaimed: boolean): string[] {
  const marks: string[] = []
  const open = state !== 'complete'
  if (open && quest.tasks.some((t) => t.consume === true)) marks.push('hand in')
  if (open && quest.tasks.some((t) => t.type === 'checkbox')) marks.push('tick')
  if ((open || unclaimed) && quest.rewards.some((r) => r.type === 'choice')) marks.push('pick one')
  return marks
}

/** 任务要的或奖励的一样物品；物品表在的话配上中文名。 */
function itemText(ctx: ToolContext, item: PackItem, withNbt: boolean): string {
  const name = item.id !== undefined ? ctx.packdata?.items?.get(item.id, item.meta)?.name : undefined
  let s = questItemText({
    count: item.count,
    ...(item.id !== undefined ? { id: item.id } : {}),
    ...(item.meta !== undefined ? { meta: item.meta } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(item.ore !== undefined ? { ore: item.ore } : {}),
  })
  if (withNbt && item.nbt !== undefined) s += ` with NBT ${compactJson(item.nbt, NBT_SHOWN_CHARS)}`
  return s
}

function locationText(l: NonNullable<PackQuestTask['location']>): string {
  const where = `${dimName(l.dim)}${l.name ? ` "${l.name}"` : ''}`
  let s =
    l.range !== undefined && l.x !== undefined && l.y !== undefined && l.z !== undefined
      ? `be within ${l.range} block(s) of ${formatPos({ x: l.x, y: l.y, z: l.z })} in ${where}`
      : `be in ${where}`
  if (l.biome !== undefined) s += `, in biome ${l.biome}`
  if (l.structure) s += `, inside a "${l.structure}" structure`
  return l.invert ? `NOT ${s}` : s
}

/** 服务器那边一个子任务对这个玩家的样子（quest.get 带 player）：做完没、记着的数。 */
type TaskStatus = NonNullable<QuestDetail['tasks']>[number]

/** 记着的数对着要的数：每样物品（或流体）一个，猎杀这类是一个数。 */
function progressText(t: PackQuestTask, status: TaskStatus): string {
  const p = status.progress
  if (Array.isArray(p)) {
    const wanted = (t.items ?? []).length > 0 ? (t.items ?? []).map((i) => i.count) : (t.fluids ?? []).map((f) => f.mb)
    if (wanted.length !== p.length) return `counted ${p.join(', ')}`
    return p.map((n, k) => `${n}/${wanted[k]}`).join(', ')
  }
  if (typeof p === 'number') return t.count !== undefined ? `${p}/${t.count}` : `counted ${p}`
  return ''
}

function statusText(t: PackQuestTask, status: TaskStatus | undefined): string {
  if (!status || typeof status.complete !== 'boolean') return ''
  const counted = progressText(t, status)
  return status.complete ? ` [done${counted ? `: ${counted}` : ''}]` : ` [not done${counted ? `; so far ${counted}` : ''}]`
}

function taskLine(ctx: ToolContext, t: PackQuestTask, n: number, status?: TaskStatus): string {
  const notes: string[] = []
  if (t.type.startsWith('optional')) notes.push('optional')
  const items = t.items ?? []
  const fluids = t.fluids ?? []
  if (t.consume !== undefined && items.length + fluids.length > 0) {
    const what = items.length > 0 ? 'the items are' : 'the fluid is'
    notes.push(t.consume ? `${what} taken when handed in` : `${what} kept`)
  }
  if (t.anyOne && items.length > 1) notes.push('any one of these is enough')
  if (t.allow) notes.push(`the player has to make it (${t.allow.join(' or ') || 'no way is allowed'})`)
  const wants: string[] = [
    // 不看 NBT 的子任务，NBT 只是任务书里摆的那个样品的，说了反而误导
    ...items.map((i) => itemText(ctx, i, t.ignoreNBT !== true)),
    ...fluids.map((f) => `${f.mb} mB ${f.fluid}`),
  ]
  if (typeof t.target === 'string') {
    const n = `${t.count ?? 1}× ${t.target}`
    wants.push(t.type === 'hunt' ? `kill ${n}` : `be ${t.range !== undefined ? `within ${t.range} block(s) of` : 'near'} ${n}`)
  }
  if (t.location) wants.push(locationText(t.location))
  if (wants.length === 0) wants.push(t.type === 'checkbox' ? 'nothing to bring: the player ticks it in the quest book' : '(nothing more is recorded about it)')
  return `- task ${n}: ${[t.type, ...notes].join(', ')}: ${wants.join(', ')}${statusText(t, status)}`
}

/** chosen：挑一样的奖励里这个玩家现在选的是第几样（从 0 数，服务器给的）。 */
function rewardLine(ctx: ToolContext, book: QuestBook, r: PackQuestReward, n: number, chosen?: number): string {
  const head = `- reward ${n}: ${r.type}`
  const items = (r.items ?? []).map((i) => itemText(ctx, i, true))
  if (r.quest !== undefined) {
    const other = book.get(r.quest)
    return `${head}: also completes quest ${r.quest}${other ? ` "${other.name}"` : ''}`
  }
  if (items.length === 0 && r.amount !== undefined) return `${head}: ${r.amount} ${r.levels ? 'level(s)' : 'point(s)'}`
  if (items.length === 0) return head
  if (r.type !== 'choice') return `${head}: ${items.join(', ')}`
  const picked = chosen !== undefined && chosen >= 0 && chosen < items.length ? `; chosen now: option ${chosen + 1}` : ''
  return `${head} (the player picks one): ${items.map((text, k) => `option ${k + 1}: ${text}`).join(', ')}${picked}`
}

/** 游戏刻 → 给人看的时长（20 刻一秒）。 */
function ticksText(ticks: number): string {
  const minutes = ticks / 1200
  if (minutes >= 60) return `${+(minutes / 60).toFixed(1)} h`
  if (minutes >= 1) return `${+minutes.toFixed(1)} min`
  return `${+(ticks / 20).toFixed(1)} s`
}

/** 和问服务器那条路上的写法一样：complete, reward unclaimed。 */
const UNCLAIMED = ', reward unclaimed'

const STATE_NOTES: Record<QuestState, string> = {
  complete: '',
  available: ' (unlocked, not complete yet)',
  locked: ' (its requirements are not met yet)',
}

function requiresHead(quest: PackQuest): string {
  if (quest.pre.length === 1 || quest.logic === 'AND') return 'Requires these quests to be complete first:'
  if (quest.logic === 'OR') return 'Requires any one of these quests to be complete first:'
  if (quest.logic === 'XOR') return 'Requires exactly one of these quests to be complete (no more than one):'
  return `Unlocks by the rule ${quest.logic} over these quests:`
}

/** 一个玩家的任务书队伍：打勾、交东西算全队；领奖算不算全队看服务器的设置。 */
export function partyText(player: string, party: QuestParty): string {
  const others = (party.members ?? []).filter((m) => m.toLowerCase() !== player.toLowerCase())
  return (
    `${player} is in the quest book party "${party.name ?? ''}"${others.length > 0 ? ` with ${others.join(', ')}` : ''}: a tick or a hand-in counts for the whole party; ` +
    (party.claimForAll === true ? 'a claim marks the reward claimed for every member.' : 'each member claims rewards for themselves.')
  )
}

function formatLocalQuest(ctx: ToolContext, book: QuestBook, quest: PackQuest, progress: Progress, detail?: QuestDetail): string {
  const out: string[] = []
  const chapters = book.linesOf(quest).map((l) => `"${l.name}"`)
  let head = `Quest ${quest.id} "${quest.name}"${quest.en ? ` (${quest.en})` : ''}, `
  head += chapters.length === 0 ? 'in no chapter (an internal quest the book never shows).' : `chapter${chapters.length > 1 ? 's' : ''} ${chapters.join(', ')}.`
  if (quest.main) head += ' On the main line.'
  if (quest.visibility === 'SECRET') head += ' Secret: the book hides it until it is unlocked.'
  if (quest.repeat !== undefined) head += quest.repeat > 0 ? ` Repeatable: can be done again ${ticksText(quest.repeat)} after it was completed.` : ' Repeatable.'
  if (progress.done) {
    const state = book.state(quest, progress.done)
    const unclaimed = state === 'complete' && progress.unclaimed?.has(quest.id) === true
    head += ` State for ${progress.player}: ${state}${unclaimed ? `${UNCLAIMED} (done; the reward has not been collected)` : STATE_NOTES[state]}.`
  }
  out.push(head)
  if (detail?.buttons && progress.player !== undefined) {
    const b = detail.buttons
    const yours = progress.player.toLowerCase() === ctx.botName.toLowerCase() ? ' (quest_book presses them for you)' : ''
    out.push(
      `The quest's buttons in ${progress.player}'s quest book now: Detect/Submit ${b.submit === true ? 'can be pressed' : 'is greyed out'}, Claim ${b.claim === true ? 'can be pressed' : 'is greyed out'}${yours}.`,
    )
  }
  if (detail?.party && progress.player !== undefined) out.push(partyText(progress.player, detail.party))

  if (quest.pre.length > 0) {
    out.push(requiresHead(quest))
    for (const id of quest.pre) {
      const other = book.get(id)
      if (!other) out.push(`- ${id} (not in the quest book, so it can never be complete)`)
      else out.push(`- ${id} "${other.name}"${progress.done ? (progress.done.has(id) ? ': done' : ': NOT done') : ''}`)
    }
  }

  if (quest.tasks.length === 0) out.push('Tasks: none listed.')
  else out.push(quest.taskLogic === 'OR' && quest.tasks.length > 1 ? 'Tasks (any one of them completes the quest):' : 'Tasks (what the quest asks for):')
  // 服务器那边的子任务、奖励和本地资料是同一个顺序（都是任务书自己的顺序），按位置对；对不上数的不用
  const tasks = detail?.tasks?.length === quest.tasks.length ? detail.tasks : undefined
  const rewards = detail?.rewards?.length === quest.rewards.length ? detail.rewards : undefined
  quest.tasks.forEach((t, k) => out.push(taskLine(ctx, t, k + 1, tasks?.[k])))

  if (quest.rewards.length > 0) {
    out.push('Rewards:')
    quest.rewards.forEach((r, k) => out.push(rewardLine(ctx, book, r, k + 1, rewards?.[k]?.chosen)))
  }

  // 描述放最后：前面那些是办事要用的硬信息，描述长
  if (quest.desc.length > 0) {
    const cut = quest.desc.length > QUEST_DESCRIPTION_MAX_CHARS
    out.push('Description:')
    out.push(cut ? `${quest.desc.slice(0, QUEST_DESCRIPTION_MAX_CHARS)}\n…[the description goes on for ${quest.desc.length - QUEST_DESCRIPTION_MAX_CHARS} more characters]` : quest.desc)
  }
  return out.join('\n')
}

export async function getQuestLocal(ctx: ToolContext, book: QuestBook, i: { id: string; player?: string }): Promise<ToolResult | string> {
  const id = normalizeQuestId(i.id)
  const quest = book.get(id)
  if (!quest) {
    return fail(
      isQuestId(id)
        ? `There is no quest with id ${id} in the quest book. Take the id from find_quests.`
        : `"${i.id.trim()}" is not a quest id (a short hex number such as "47", or a UUID). Find the quest with find_quests first.`,
    )
  }
  const progress = await progressFor(ctx, i.player)
  const detail = progress.player !== undefined ? await playerDetail(ctx, quest.id, progress.player) : undefined
  return formatLocalQuest(ctx, book, quest, progress, detail) + progress.note
}

/**
 * 这个任务对这个玩家的样子要问服务器（quest.get 带 player）：每个子任务做完没、记着的数，挑一样的奖励选了哪个，
 * 两个按钮能不能按，在不在队伍里。问不到（老的身体、连不上）就不带，任务的内容照样给。
 */
async function playerDetail(ctx: ToolContext, id: string, player: string): Promise<QuestDetail | undefined> {
  try {
    return await ctx.bridge.questGet(id, player)
  } catch (e) {
    if (e instanceof BridgeError) return undefined
    throw e
  }
}
