// read_log：翻它自己的活动日志（面板“对话”页看的那一份，logs/activity-*.jsonl）。只读，库函数，两条线都有。
// 历史压缩把较早的轮换成了交接记录，原文就不在对话历史里了；主人以前说过的话、当时查到的东西，靠它翻回去。

import { DETAIL_MAX, LOG_KEEP_DAYS } from '../store/activity-log.ts'
import type { ActivityEntry, ActivityKind, LogQuery } from '../store/activity-log.ts'
import { arr, int, num, obj, str } from './schema.ts'
import { DEFAULT_RESULT_MAX_CHARS, fail } from './types.ts'
import type { Tool, ToolResult } from './types.ts'

const LOG_LIMIT_DEFAULT = 30
const LOG_LIMIT_MAX = 200
/** 一页里每条的正文、详细内容各给这么多字符；要看全用 id。 */
const TEXT_SHOWN = 400
const DETAIL_SHOWN = 300

/** 模型说的类别 → 日志里的 kind。 */
const KIND_GROUPS: Record<string, readonly ActivityKind[]> = {
  said: ['say'],
  heard: ['chat', 'whisper', 'command'],
  tools: ['tool_call', 'tool_result'],
  relay: ['relay'],
  // 两条线写的字：干活线的，和对话线的（只给主人在面板上看）
  thought: ['model_text', 'reply'],
  turns: ['turn'],
  events: ['event'],
  notes: ['info', 'error'],
  runs: ['run'],
  calls: ['model_call'],
}
/** 没说要哪几类时：除了模型调用的账以外的全部。 */
const DEFAULT_KINDS: readonly ActivityKind[] = Object.entries(KIND_GROUPS).flatMap(([group, kinds]) => (group === 'calls' ? [] : kinds))

const pad = (n: number): string => String(n).padStart(2, '0')

/** 日志里的时间写成 月-日 时:分:秒（本地时间）。 */
export function logStamp(time: number): string {
  const d = new Date(time)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 模型写的时间读成时间戳（本地时间）："2026-11-11 14:30"、"11-11 14:30"、"14:30"（今天的）、"2026-11-11"；秒可以带。
 * end：只写了日期时取这一天的最后一刻，只写到分时取这一分钟的最后一秒。读不懂返回 undefined。
 */
export function parseLogTime(text: string, now: number, end: boolean): number | undefined {
  const m = /^(?:(?:(\d{4})-)?(\d{1,2})-(\d{1,2}))?(?:[ T]?(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text.trim())
  if (!m || (m[2] === undefined && m[4] === undefined)) return undefined
  const today = new Date(now)
  const year = m[1] !== undefined ? Number(m[1]) : today.getFullYear()
  const month = m[2] !== undefined ? Number(m[2]) - 1 : today.getMonth()
  const date = m[3] !== undefined ? Number(m[3]) : today.getDate()
  const hasClock = m[4] !== undefined
  const hour = hasClock ? Number(m[4]) : end ? 23 : 0
  const minute = hasClock ? Number(m[5]) : end ? 59 : 0
  const second = m[6] !== undefined ? Number(m[6]) : end ? 59 : 0
  if (month < 0 || month > 11 || date < 1 || date > 31 || hour > 23 || minute > 59 || second > 59) return undefined
  const at = new Date(year, month, date, hour, minute, second, end ? 999 : 0).getTime()
  return Number.isNaN(at) ? undefined : at
}

const CUT_RE = /\n…（已截断，原长 (\d+) 字符）$/

/** 详细内容和它原来多长：日志落盘时超过上限的被截过，末尾留着原长。 */
function detailOf(e: ActivityEntry): { text: string; original?: number } | undefined {
  if (e.detail === undefined || e.detail.length === 0) return undefined
  const cut = CUT_RE.exec(e.detail)
  return cut ? { text: e.detail.slice(0, cut.index), original: Number(cut[1]) } : { text: e.detail }
}

function headOf(e: ActivityEntry): string {
  const where = `${e.agent !== undefined ? ` ${e.agent}` : ''}${e.turn !== undefined ? ` turn ${e.turn}` : ''}${e.step !== undefined ? ` step ${e.step}` : ''}`
  // 悄悄话发给谁另放在 to 里（text 只有原话）
  const to = e.kind === 'say' && e.channel === 'whisper' ? ` (whisper to ${e.to ?? '?'})` : ''
  return `#${e.id} [${logStamp(e.time)}]${where} · ${e.kind}${e.who !== undefined ? ` ${e.who}` : ''}${to}${e.isError ? ' (error)' : ''}:`
}

/** 一页里的一条：一行正文，有详细内容的再给个开头。 */
function entryLines(e: ActivityEntry): string {
  const text = e.text.length > TEXT_SHOWN ? `${e.text.slice(0, TEXT_SHOWN)}… (${e.text.length} chars; id: ${e.id} shows it whole)` : e.text
  const detail = detailOf(e)
  if (!detail) return `${headOf(e)} ${text}`
  const size = `${detail.text.length} chars${detail.original !== undefined ? `, the log kept that much of ${detail.original}` : ''}`
  const body = detail.text.length > DETAIL_SHOWN ? `${detail.text.slice(0, DETAIL_SHOWN)}…` : detail.text
  return `${headOf(e)} ${text}\n    detail (${size}${detail.text.length > DETAIL_SHOWN ? `; id: ${e.id} shows it whole` : ''}): ${body.replace(/\n/g, '\n    ')}`
}

/**
 * 翻活动日志。库函数：不占清单，程序里调；模型直接调这个名字也照常执行。
 * 给了起点（turn、from、after）就从头往后读，否则给最晚的那些；一页放不下时写明前后各还有多少、怎么接着读。
 */
export const readLog: Tool = {
  name: 'read_log',
  description:
    `Your activity log, read-only: every turn's opening message, what players said and what you said, each tool call and its result, your text, what passed between the talk line and the worker, events, errors. It is what the control panel shows, kept for the last ${LOG_KEEP_DAYS} days that have entries, so it still holds the turns that were replaced by a handover record in your history. ` +
    'Conditions combine. With a starting point (turn, from, after) you read forward from it; otherwise you get the latest entries that match. A page lists each entry on a line with the start of its detail; id reads one entry whole.',
  brief: '{turn?, turnTo?, from?, to?, query?, kinds?, id?, after?, before?}: your activity log, which still holds turns that left your history -> entries[{id, time, kind, turn, who, text, detail}]',
  inputSchema: obj({
    turn: int('Entries of this turn (the handover record at the top of your history says which turns it replaced).', { min: 1 }),
    turnTo: int('With turn: through this turn.', { min: 1 }),
    from: str('Not before this local time: "2026-11-11 14:30", "11-11 14:30", "14:30" (today), or a date.'),
    to: str('Not after this local time, written the same way.'),
    minutes: num('Only the last so many minutes.', { min: 0.1, max: 100_000 }),
    query: str('Words that must all appear (in the text, the detail or the name; case does not matter).', { maxLength: 200 }),
    kinds: arr(
      'Only these: said (what you said in chat), heard (players, whispers, the owner on the control panel), tools (calls and results), relay (between the talk line and the worker), thought (your text that was not said), turns (each turn\'s opening message), events, notes (info and errors), runs (programs), calls (model-call accounting; left out unless asked).',
      str(undefined, { enum: Object.keys(KIND_GROUPS) }),
      { max: 10 },
    ),
    line: str('Only the entries of one line: talk or work (plus what belongs to no line: the system, older entries). Default: both lines; each entry says whose it is.', { enum: ['talk', 'work'] }),
    id: int('One entry whole, by its # number.', { min: 1 }),
    offset: int('With id: start this many characters into its detail (when the detail did not fit in one result).', { min: 0 }),
    after: int('Continue forward: entries after this # number.', { min: 0 }),
    before: int('Continue backward: the latest entries before this # number.', { min: 1 }),
    limit: int(`Entries per page (default ${LOG_LIMIT_DEFAULT}).`, { min: 1, max: LOG_LIMIT_MAX }),
  }),
  async run(ctx, i: { turn?: number; turnTo?: number; from?: string; to?: string; minutes?: number; query?: string; kinds?: string[]; line?: string; id?: number; offset?: number; after?: number; before?: number; limit?: number }): Promise<ToolResult> {
    if (!ctx.activityLog) return fail('This brain keeps no activity log that can be read.')
    const now = ctx.now()
    const cap = ctx.maxResultChars?.() ?? DEFAULT_RESULT_MAX_CHARS

    // 一条看全
    if (i.id !== undefined) {
      const page = ctx.activityLog.search({ id: i.id, limit: 1, from: 'earliest' })
      const e = page.entries[0]
      if (!e) return fail(`There is no entry #${i.id} in the log${page.oldestTime !== undefined ? ` (it goes back to ${logStamp(page.oldestTime)}; older days are deleted)` : ''}.`)
      const detail = detailOf(e)
      const data = { entry: e }
      if (!detail) return { content: `${headOf(e)} ${e.text}\n(This entry has no detail.)`, data }
      const offset = Math.min(i.offset ?? 0, detail.text.length)
      const room = Math.max(500, cap - e.text.length - 400)
      const piece = detail.text.slice(offset, offset + room)
      const left = detail.text.length - offset - piece.length
      const kept = detail.original !== undefined ? ` The log kept only the first ${detail.text.length} of the ${detail.original} chars this had (it cuts a detail at ${DETAIL_MAX}); the rest is not stored anywhere.` : ''
      const range = offset > 0 || left > 0 ? `, chars ${offset}–${offset + piece.length} of ${detail.text.length}` : ` (${detail.text.length} chars)`
      const more = left > 0 ? `\n${left} more chars of this detail: id: ${e.id}, offset: ${offset + piece.length}.` : ''
      return { content: `${headOf(e)} ${e.text}\ndetail${range}:\n${piece}${more}${kept ? `\n${kept.trim()}` : ''}`, data }
    }

    const query: LogQuery = { limit: i.limit ?? LOG_LIMIT_DEFAULT, from: i.before === undefined && (i.after !== undefined || i.turn !== undefined || i.from !== undefined) ? 'earliest' : 'latest' }
    const scope: string[] = []
    if (i.turn !== undefined) {
      const to = i.turnTo ?? i.turn
      if (to < i.turn) return fail(`turnTo (${to}) is before turn (${i.turn})`)
      query.turnFrom = i.turn
      query.turnTo = to
      scope.push(to === i.turn ? `turn ${i.turn}` : `turns ${i.turn}–${to}`)
    } else if (i.turnTo !== undefined) {
      query.turnTo = i.turnTo
      scope.push(`turns up to ${i.turnTo}`)
    }
    if (i.from !== undefined) {
      const at = parseLogTime(i.from, now, false)
      if (at === undefined) return fail(`from: "${i.from}" is not a time I can read. Write it like "2026-11-11 14:30", "11-11 14:30" or "14:30" (local time; now is ${logStamp(now)}).`)
      query.since = at
      scope.push(`from ${logStamp(at)}`)
    }
    if (i.to !== undefined) {
      const at = parseLogTime(i.to, now, true)
      if (at === undefined) return fail(`to: "${i.to}" is not a time I can read. Write it like "2026-11-11 14:30", "11-11 14:30" or "14:30" (local time; now is ${logStamp(now)}).`)
      query.until = at
      scope.push(`to ${logStamp(at)}`)
    }
    if (i.minutes !== undefined) {
      query.since = Math.max(query.since ?? 0, now - i.minutes * 60_000)
      scope.push(`the last ${i.minutes} minute(s)`)
    }
    const words = (i.query ?? '').split(/\s+/).filter((w) => w.length > 0)
    if (words.length > 0) {
      query.words = words
      scope.push(`containing ${words.map((w) => `"${w}"`).join(' and ')}`)
    }
    const groups = [...new Set(i.kinds ?? [])]
    query.kinds = groups.length > 0 ? groups.flatMap((g) => KIND_GROUPS[g] ?? []) : DEFAULT_KINDS
    if (groups.length > 0) scope.push(`kinds ${groups.join(', ')}`)
    if (i.line !== undefined) {
      query.agent = i.line
      scope.push(`only the ${i.line === 'talk' ? 'talk line' : 'worker'}'s entries and what belongs to no line`)
    }
    if (i.after !== undefined) query.afterId = i.after
    if (i.before !== undefined) query.beforeId = i.before

    const page = ctx.activityLog.search(query)
    const what = scope.length > 0 ? scope.join(', ') : 'everything'
    const reach = page.oldestTime !== undefined ? `The log goes back to ${logStamp(page.oldestTime)}; now is ${logStamp(now)}.` : 'The log is empty.'
    if (page.entries.length === 0) {
      const none = page.matched > 0 ? `No more entries ${i.after !== undefined ? `after #${i.after}` : `before #${i.before}`}: ${page.matched} match in all` : 'No entries match'
      return { content: `${none} (asked for: ${what}). ${reach}`, data: { entries: [], matched: page.matched, earlier: page.earlier, later: page.later, shown: 0 } }
    }

    // 一页的文字不超过单个结果的上限：放得下几条给几条，从这一页读的那一头起
    const budget = Math.max(800, cap - 700)
    const texts = page.entries.map(entryLines)
    const forward = query.from === 'earliest'
    let used = 0
    let shown = 0
    for (const text of forward ? texts : [...texts].reverse()) {
      if (shown > 0 && used + text.length + 1 > budget) break
      used += text.length + 1
      shown++
    }
    const listed = forward ? page.entries.slice(0, shown) : page.entries.slice(page.entries.length - shown)
    const lines = forward ? texts.slice(0, shown) : texts.slice(texts.length - shown)
    const first = listed[0]!
    const last = listed[listed.length - 1]!
    const earlier = page.earlier + (forward ? 0 : page.entries.length - shown)
    const later = page.later + (forward ? page.entries.length - shown : 0)
    const head = `Activity log, ${what}: ${page.matched} entr${page.matched === 1 ? 'y matches' : 'ies match'}; here ${listed.length === 1 ? `is #${first.id}` : `are #${first.id}–#${last.id} (${listed.length})`}, oldest first.`
    const tail: string[] = []
    if (earlier > 0) tail.push(`${earlier} earlier one(s) match: the same input with before: ${first.id}.`)
    if (later > 0) tail.push(`${later} later one(s) match: the same input with after: ${last.id}.`)
    if (listed.some((e) => e.text.length > TEXT_SHOWN || (e.detail?.length ?? 0) > DETAIL_SHOWN)) tail.push('id: <number> reads one entry whole.')
    tail.push(reach)
    return { content: [head, ...lines, tail.join(' ')].join('\n'), data: { entries: page.entries, matched: page.matched, earlier: page.earlier, later: page.later, shown: listed.length } }
  },
}
