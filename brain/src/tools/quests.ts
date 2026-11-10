// 任务书（BetterQuesting）：章节、任务的说明和要求、某个玩家的进度。只查不改：替不了谁提交任务或领奖励。
//
// 任务书的内容是静态的，读大脑本地的资料（ctx.packdata.quests，中文，见 quest-book.ts）；只有“谁做完了哪些”问服务器。
// 本地没有任务书资料时，这三个工具整个退回去问服务器（quest.lines / quest.search / quest.get）：那边的文字是英文的，
// 也翻不了页。下面带 OnServer 的函数就是这条退路。

import { BridgeError } from '../bridge/protocol.ts'
import { formatQuest, formatQuestLines, formatQuestSearch } from './format.ts'
import { findQuestsLocal, getQuestLocal, listQuestLinesLocal } from './quest-book.ts'
import type { FindQuestsInput } from './quest-book.ts'
import { int, obj, str } from './schema.ts'
import { ToolFailure, fail } from './types.ts'
import type { Tool, ToolContext } from './types.ts'

export const QUEST_SEARCH_MAX_LIMIT = 60

const player = str('Whose progress to show. Omit for your owner (or whoever just talked to you).', { maxLength: 40 })

/**
 * 带着“看谁的进度”去问服务器。模型没说看谁的，就用默认的那个玩家（主人名单里的第一个，或者刚才跟它说话的人）；
 * 任务书不认识这个默认的玩家（比如他从没进过服务器）时，照样给出不带进度的结果，并说明原因。
 */
async function askQuestBook<T>(
  ctx: ToolContext,
  given: string | undefined,
  call: (player: string | undefined) => Promise<T>,
): Promise<{ res: T; player: string | undefined; note: string }> {
  const explicit = given !== undefined && given.trim().length > 0 ? given.trim() : undefined
  const who = explicit ?? ctx.defaultPlayer?.()
  try {
    return { res: await call(who), player: who, note: '' }
  } catch (e) {
    if (!(e instanceof BridgeError)) throw e
    if (e.code === 'not_found' && /no quest book/i.test(e.message)) {
      throw new ToolFailure('This server has no quest book (BetterQuesting is not installed), so there is nothing to look up.')
    }
    if (e.code === 'not_found' && /knows no player/i.test(e.message) && explicit === undefined && who !== undefined) {
      return { res: await call(undefined), player: undefined, note: `\nNote: the quest book does not know a player named ${who}, so no progress is shown. Give "player" to see someone's progress.` }
    }
    throw e
  }
}

async function findQuestsOnServer(ctx: ToolContext, i: FindQuestsInput): Promise<string> {
  if (i.state === 'unclaimed') {
    throw new ToolFailure(
      'state "unclaimed" is not available: the local quest book data is not loaded, and the game server can only filter by available, complete or locked. Use state "complete": quests whose reward is not collected show as "complete, reward unclaimed".',
    )
  }
  if ((i.page ?? 1) > 1) {
    throw new ToolFailure(
      `Pages are not available: the local quest book data is not loaded, so this search runs on the game server, which returns only the first matches (at most ${QUEST_SEARCH_MAX_LIMIT}). Narrow it down with query, line or state instead.`,
    )
  }
  const query = i.query?.trim() || undefined
  const line = i.line?.trim() || undefined
  const { res, player: who, note } = await askQuestBook(ctx, i.player, (p) => {
    // 按状态筛要知道是谁的进度
    if (i.state !== undefined && p === undefined) {
      throw new ToolFailure('Filtering by state needs a player whose progress to look at: give "player".')
    }
    return ctx.bridge.questSearch({
      ...(query !== undefined ? { query } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(i.state !== undefined ? { state: i.state } : {}),
      ...(p !== undefined ? { player: p } : {}),
      ...(i.limit !== undefined ? { limit: i.limit } : {}),
    })
  })
  return (
    formatQuestSearch(res, {
      ...(query !== undefined ? { query } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(i.state !== undefined ? { state: i.state } : {}),
      ...(who !== undefined ? { player: who } : {}),
    }) + note
  )
}

export const listQuestLines: Tool = {
  name: 'list_quest_lines',
  description:
    "The chapters of the quest book (BetterQuesting), in the book's order, with their Chinese and English names: how many quests each has, and for a player how many are done and how many can be done now. Read-only: you cannot hand in quests or claim rewards for anyone.",
  inputSchema: obj({ player }),
  async run(ctx, i: { player?: string }) {
    const book = ctx.packdata?.quests
    if (book) return listQuestLinesLocal(ctx, book, i.player)
    const { res, player: who, note } = await askQuestBook(ctx, i.player, (p) => ctx.bridge.questLines(p))
    return formatQuestLines(res, who) + note
  },
}

export const findQuests: Tool = {
  name: 'find_quests',
  description:
    'Find quests in the quest book by words (Chinese or English, in the title or description), by chapter and by state, in any mix: for example state "available" alone lists what the player can do right now. Returns id, title, chapter and state, one page at a time.',
  inputSchema: obj({
    query: str('Words that must all appear in the title or description, Chinese or English, e.g. "马达" or "electric motor".', { maxLength: 80 }),
    line: str('Part of a chapter name, Chinese or English, e.g. "蒸汽" or "Steam".', { maxLength: 80 }),
    state: str('available (unlocked and not complete), complete, locked, or unclaimed (complete, with a reward not collected yet).', {
      enum: ['available', 'complete', 'locked', 'unclaimed'],
    }),
    player,
    limit: int('How many per page (default 20).', { min: 1, max: QUEST_SEARCH_MAX_LIMIT }),
    page: int('Which page of the results (default 1).', { min: 1 }),
  }),
  async run(ctx, i: FindQuestsInput) {
    const book = ctx.packdata?.quests
    return book ? findQuestsLocal(ctx, book, i) : findQuestsOnServer(ctx, i)
  },
}

export const getQuest: Tool = {
  name: 'get_quest',
  description:
    'One quest in full: its chapter, the quests it requires (and whether they are done), what each of its tasks asks for (type, items with id/meta and count, whether the items are taken when handed in), its rewards and its description. Take the id from find_quests.',
  inputSchema: obj({ id: str('Quest id as find_quests shows it: a short hex number such as "47", or a UUID.', { maxLength: 40 }), player }, ['id']),
  async run(ctx, i: { id: string; player?: string }) {
    const book = ctx.packdata?.quests
    if (book) return getQuestLocal(ctx, book, i)
    const { res, player: who, note } = await askQuestBook(ctx, i.player, (p) => ctx.bridge.questGet(i.id.trim(), p))
    if (typeof res.name !== 'string') return fail('the quest book returned no quest for that id')
    return formatQuest(res, who) + note
  },
}
