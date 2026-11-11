// 历史压缩。历史按“轮”存，压缩只在轮的边界上切，所以工具调用和结果不会被拆开。
// 顺序：先截断旧的超长工具结果；还超就把较早的若干轮用一次不带工具的模型调用压成摘要。

import { textOf } from '../llm/index.ts'
import type { LlmClient, Message } from '../llm/index.ts'
import type { Turn } from '../store/history.ts'
import { manualInText } from '../store/manuals.ts'

/** 估算 token：字符数 / 3。 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return Math.ceil((text?.length ?? 0) / 3)
}

export function turnTokens(turn: Turn): number {
  return estimateTokens(turn.messages)
}

export function historyTokens(summary: string, turns: readonly Turn[]): number {
  return estimateTokens(summary) + turns.reduce((sum, t) => sum + turnTokens(t), 0)
}

export const OLD_RESULT_MAX_CHARS = 400
export const KEEP_RECENT_TURNS = 2

/**
 * 把最近 keepRecent 轮之前的超长工具结果截短。返回新的轮数组；没有变化时 changed 为 false。
 * 只改 content，不动调用和结果的对应关系。
 */
export function truncateOldToolResults(
  turns: readonly Turn[],
  keepRecent: number = KEEP_RECENT_TURNS,
  maxChars: number = OLD_RESULT_MAX_CHARS,
): { turns: Turn[]; changed: boolean } {
  let changed = false
  const cutoff = Math.max(0, turns.length - keepRecent)
  const out = turns.map((turn, index) => {
    if (index >= cutoff) return turn
    let turnChanged = false
    const messages = turn.messages.map((m): Message => {
      if (m.role !== 'user') return m
      let messageChanged = false
      const content = m.content.map((p) => {
        if (p.type !== 'tool_result' || p.content.length <= maxChars) return p
        messageChanged = true
        // 手册留半截没有用：整段换成一句话，要用时它会重新读（“当前状态”里也不再把这本算作看过）
        const manual = manualInText(p.content)
        if (manual) {
          return { ...p, content: `[the text of manual "${manual.name}" was dropped from the history to save space; read_manual it again when you need it]` }
        }
        return { ...p, content: `${p.content.slice(0, maxChars)} …[older result shortened, ${p.content.length} chars originally]` }
      })
      if (!messageChanged) return m
      turnChanged = true
      return { role: 'user', content }
    })
    if (!turnChanged) return turn
    changed = true
    return { ...turn, messages }
  })
  return { turns: out, changed }
}

/**
 * 决定把前多少轮压成摘要：从最新的一轮往回留，留到估算 token 超过 keepTokens 为止，
 * 至少留 minKeepTurns 轮。返回值是要压掉的轮数（0 表示没法再压）。
 */
export function chooseCut(turns: readonly Turn[], keepTokens: number, minKeepTurns = 1): number {
  let kept = 0
  let tokens = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turnTokens(turns[i]!)
    if (kept >= minKeepTurns && tokens + t > keepTokens) break
    tokens += t
    kept++
  }
  return turns.length - kept
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 把若干轮排成给“写摘要”的模型看的纯文本。不含任何工具调用结构，所以哪家接口都能用。
 * spoken：这是对话线的记录，它写的文字是它说出口的话，不是想法。
 */
export function renderTranscript(turns: readonly Turn[], maxChars = 60_000, spoken = false): string {
  const names = new Map<string, string>()
  const blocks: string[] = []
  for (const turn of turns) {
    const lines: string[] = [`=== 第 ${turn.id} 轮 ===`]
    for (const m of turn.messages) {
      if (m.role === 'assistant') {
        for (const p of m.content) {
          if (p.type === 'text') lines.push(`[${spoken ? '它说的话' : '它的想法'}] ${clipText(p.text, 600)}`)
          else if (p.type === 'tool_call') {
            names.set(p.id, p.name)
            lines.push(`[它调用工具] ${p.name} ${clipText(JSON.stringify(p.input ?? {}), 400)}`)
          }
        }
      } else {
        for (const p of m.content) {
          if (p.type === 'text') lines.push(`[它看到的] ${clipText(p.text, 1500)}`)
          else if (p.type === 'image') lines.push(`[它看到的图] ${clipText(p.image.label, 200)}`)
          else lines.push(`[工具结果 ${names.get(p.toolCallId) ?? ''}${p.isError ? ' 出错' : ''}] ${clipText(p.content, 300)}`)
        }
      }
    }
    blocks.push(lines.join('\n'))
  }
  let text = blocks.join('\n\n')
  // 还是太长就丢掉最早的部分（摘要里本来也是越早的越不重要）
  if (text.length > maxChars) text = `（更早的记录略）\n${text.slice(text.length - maxChars)}`
  return text
}

export const SUMMARY_SYSTEM = `你在替一个 Minecraft 服务器里的 AI 玩家整理记忆。下面是它之前的经历记录（它看到的事、它的想法、它调用的工具和结果）。
请用中文写一份给它自己以后看的摘要，不超过 400 字，只保留以后还用得上的内容：
- 主人交代过、现在仍然有效的要求和偏好；
- 正在做或没做完的事，包括具体的坐标、区域范围、高度、物品和任务参数；
- 重要的地点、箱子的坐标和里面放什么；
- 试过但失败的做法和原因；
- 答应过别人但还没做的事。
已经做完且没有后续的事一句带过或不写。它读过哪些手册、手册里写了什么都不要写：手册的内容不会留在摘要里，要用时它会重新读。直接写摘要正文，不要开场白。`

/** 对话线的历史怎么压：它只跟人说话、查资料，动手的事交给干活线，所以要留的是话和约定，不是坐标和任务参数。 */
export const TALK_SUMMARY_SYSTEM = `你在替一个 Minecraft 服务器里的 AI 玩家的“对话线”整理记忆：它只负责跟人说话和查资料，要动手的事交给干活线去做。下面是它之前的记录（它听到的话、它说的话、它查的东西、交给干活线的事、干活线的汇报和提问）。
请用中文写一份给它自己以后看的摘要，不超过 400 字，只保留以后还用得上的内容：
- 主人交代过、现在仍然有效的要求和偏好；
- 交给了干活线、还没有结果的事；干活线问了、还没人回答的问题；
- 答应过别人但还没做到的事，别人问了还没答上的事；
- 查到的、之后还会用到的结论（带上具体的名字、数量、坐标）。
已经了结的事一句带过或不写。它读过哪些手册、手册里写了什么都不要写。直接写摘要正文，不要开场白。`

/** 调一次不带工具的模型，把旧摘要和若干轮合并成新摘要。失败时把错误抛给调用方。 */
export async function summarize(
  llm: LlmClient,
  previousSummary: string,
  turns: readonly Turn[],
  signal?: AbortSignal,
  talk = false,
): Promise<string> {
  const transcript = renderTranscript(turns, undefined, talk)
  const text =
    (previousSummary.trim().length > 0 ? `【更早的摘要】\n${previousSummary.trim()}\n\n` : '') +
    `【之后的记录】\n${transcript}\n\n请写出合并后的新摘要。`
  const result = await llm.generate({
    system: talk ? TALK_SUMMARY_SYSTEM : SUMMARY_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    tools: [],
    ...(signal ? { signal } : {}),
  })
  const summary = textOf(result.message.content).trim()
  if (summary.length === 0) throw new Error('the model returned an empty summary')
  return summary
}

export interface CompactOptions {
  /** 估算 token 超过它才压缩。 */
  threshold: number
  llm: LlmClient
  signal?: AbortSignal
  /** 这是对话线的历史：摘要按“话和约定”来写。 */
  talk?: boolean
}

export interface CompactResult {
  summary: string
  turns: Turn[]
  /** 做了什么：nothing 没超阈值；truncated 只截断了旧工具结果；summarized 压成了摘要；dropped 摘要失败且已严重超长，直接丢弃旧轮。 */
  action: 'nothing' | 'truncated' | 'summarized' | 'dropped'
  /** summarized / dropped 时压掉的轮数。 */
  removedTurns: number
  error?: string
}

export async function compactHistory(summary: string, turns: readonly Turn[], opts: CompactOptions): Promise<CompactResult> {
  if (historyTokens(summary, turns) <= opts.threshold) {
    return { summary, turns: [...turns], action: 'nothing', removedTurns: 0 }
  }
  const truncated = truncateOldToolResults(turns)
  let current = truncated.turns
  if (historyTokens(summary, current) <= opts.threshold) {
    return { summary, turns: current, action: truncated.changed ? 'truncated' : 'nothing', removedTurns: 0 }
  }

  // 压缩后留下大约 40% 阈值的近期内容，免得刚压完又超
  const cut = chooseCut(current, Math.floor(opts.threshold * 0.4))
  if (cut === 0) {
    // 只剩一轮还超：这一轮自己太大。把它里面的工具结果也截短，别的做不了。
    const hard = truncateOldToolResults(current, 0)
    current = hard.turns
    return { summary, turns: current, action: hard.changed || truncated.changed ? 'truncated' : 'nothing', removedTurns: 0 }
  }
  try {
    const next = await summarize(opts.llm, summary, current.slice(0, cut), opts.signal, opts.talk === true)
    return { summary: next, turns: current.slice(cut), action: 'summarized', removedTurns: cut }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    // 摘要没写成。没超太多就先留着下次再试；超过两倍阈值就不能再拖了，直接丢。
    if (historyTokens(summary, current) > opts.threshold * 2) {
      const note = '（更早的一段经历因为太长被丢弃了，当时没能写成摘要。）'
      return {
        summary: summary.trim().length > 0 ? `${summary.trim()}\n${note}` : note,
        turns: current.slice(cut),
        action: 'dropped',
        removedTurns: cut,
        error,
      }
    }
    return { summary, turns: current, action: truncated.changed ? 'truncated' : 'nothing', removedTurns: 0, error }
  }
}

/** 摘要放在历史最前面的这条 user 消息里。 */
export function summaryMessage(summary: string): Message {
  return { role: 'user', content: [{ type: 'text', text: `[更早经历的摘要]\n${summary}` }] }
}

/** 把摘要和各轮拼成发给模型的消息列表。 */
export function historyMessages(summary: string, turns: readonly Turn[]): Message[] {
  const out: Message[] = []
  if (summary.trim().length > 0) out.push(summaryMessage(summary))
  for (const t of turns) out.push(...t.messages)
  return out
}
