// 发请求前对消息列表做的、和具体接口无关的整理。
// 两家接口都要求：角色交替、工具结果紧跟对应的工具调用、没有空内容。

import type { AssistantPart, ImageAttachment, Message, OpaquePart, ToolResultPart, UserPart } from './types.ts'

export interface NormalizeOptions {
  /** 决定某个 OpaquePart 是否保留（通常是“是不是我这种适配器产生的”）。 */
  keepOpaque: (part: OpaquePart) => boolean
}

export const MISSING_RESULT_TEXT = 'No result was recorded for this tool call.'

/** 图不再附带以后留在原处的那句话。 */
export function imagePlaceholder(image: ImageAttachment): string {
  return `[picture seen earlier, no longer attached: ${image.label}. Ask for it again if you need to look at it once more.]`
}

/** 消息里一共带着几张图。 */
export function countImages(messages: readonly Message[]): number {
  let n = 0
  for (const m of messages) {
    if (m.role !== 'user') continue
    for (const p of m.content) n += p.type === 'image' ? 1 : p.type === 'tool_result' ? (p.images?.length ?? 0) : 0
  }
  return n
}

/**
 * 只留最后 keep 张图，更早的换成占位文字（放在那段内容的最前面，旧结果被截短时也留得住）。
 * 图很贵，同一张图不该每次请求都重新算钱：存进历史之前用 keep = 0 全部换掉；一轮之内只留最近的几张。
 * 不修改传入的数组和对象；没有要换的图时原样返回。
 */
export function keepLatestImages(messages: readonly Message[], keep: number): Message[] {
  let drop = countImages(messages) - Math.max(0, keep)
  if (drop <= 0) return messages as Message[]
  return messages.map((m): Message => {
    if (m.role !== 'user' || drop <= 0) return m
    let changed = false
    const content = m.content.map((p): UserPart => {
      if (drop <= 0) return p
      if (p.type === 'image') {
        drop--
        changed = true
        return { type: 'text', text: imagePlaceholder(p.image) }
      }
      if (p.type !== 'tool_result' || !p.images || p.images.length === 0) return p
      const gone = p.images.slice(0, drop)
      const left = p.images.slice(gone.length)
      drop -= gone.length
      changed = true
      const { images: _images, ...rest } = p
      const text = [...gone.map(imagePlaceholder), p.content].filter((t) => t.length > 0).join('\n')
      return left.length > 0 ? { ...rest, content: text, images: left } : { ...rest, content: text }
    })
    return changed ? { role: 'user', content } : m
  })
}

/** 把所有的图都换成占位文字。 */
export function withoutImages(messages: readonly Message[]): Message[] {
  return keepLatestImages(messages, 0)
}

function hasText(text: string): boolean {
  return text.trim().length > 0
}

/**
 * 返回一份新的消息列表，保证：
 * 1. 不该回放的 OpaquePart 已丢掉，空文本、空消息已丢掉；
 * 2. 连续的同角色消息合并成一条；
 * 3. 每个工具调用在下一条 user 消息里都有结果（缺的补一个错误结果）；
 *    找不到对应调用的工具结果改成普通文本；
 * 4. user 消息里工具结果排在文本和图片前面。
 * 不修改传入的数组和对象。
 */
export function normalizeMessages(messages: readonly Message[], opts: NormalizeOptions): Message[] {
  // 1. 过滤
  const filtered: Message[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      const content = m.content.filter((p) => {
        if (p.type === 'text') return hasText(p.text)
        if (p.type === 'opaque') return opts.keepOpaque(p)
        return true
      })
      if (content.length > 0) filtered.push({ role: 'assistant', content })
    } else {
      const content = m.content.filter((p) => (p.type === 'text' ? hasText(p.text) : true))
      if (content.length > 0) filtered.push({ role: 'user', content })
    }
  }

  // 2. 合并连续同角色
  const merged: Message[] = []
  for (const m of filtered) {
    const last = merged[merged.length - 1]
    if (last && last.role === 'user' && m.role === 'user') {
      last.content = [...last.content, ...m.content]
    } else if (last && last.role === 'assistant' && m.role === 'assistant') {
      last.content = [...last.content, ...m.content]
    } else if (m.role === 'user') {
      merged.push({ role: 'user', content: [...m.content] })
    } else {
      merged.push({ role: 'assistant', content: [...m.content] })
    }
  }

  // 3. 配对
  const out: Message[] = []
  let pendingCalls: string[] = [] // 上一条 assistant 消息里还没见到结果的调用 id
  let allowed = new Set<string>() // 上一条 assistant 消息里的全部调用 id
  const syntheticResults = (ids: string[]): ToolResultPart[] =>
    ids.map((id) => ({ type: 'tool_result', toolCallId: id, content: MISSING_RESULT_TEXT, isError: true }))

  for (const m of merged) {
    if (m.role === 'assistant') {
      if (pendingCalls.length > 0) {
        // 两条 assistant 之间没有 user（合并后不会出现），防御性处理
        out.push({ role: 'user', content: syntheticResults(pendingCalls) })
      }
      const ids = m.content.filter((p) => p.type === 'tool_call').map((p) => p.id)
      allowed = new Set(ids)
      pendingCalls = ids
      out.push(m)
      continue
    }
    const results: ToolResultPart[] = []
    const texts: UserPart[] = []
    const seen = new Set<string>()
    for (const p of m.content) {
      if (p.type === 'tool_result') {
        if (allowed.has(p.toolCallId) && !seen.has(p.toolCallId)) {
          seen.add(p.toolCallId)
          results.push(p)
        } else {
          // 对不上调用的结果只能当普通文字给；它带的图跟着放在后面
          texts.push({ type: 'text', text: `[result of an earlier tool call ${p.toolCallId}]\n${p.content}` })
          for (const image of p.images ?? []) texts.push({ type: 'image', image })
        }
      } else {
        texts.push(p)
      }
    }
    const missing = pendingCalls.filter((id) => !seen.has(id))
    // 4. 结果在前、文本在后；结果按调用顺序排
    const ordered = [...results, ...syntheticResults(missing)].sort(
      (a, b) => pendingCalls.indexOf(a.toolCallId) - pendingCalls.indexOf(b.toolCallId),
    )
    out.push({ role: 'user', content: [...ordered, ...texts] })
    pendingCalls = []
    allowed = new Set()
  }
  if (pendingCalls.length > 0) out.push({ role: 'user', content: syntheticResults(pendingCalls) })
  return out
}

export function textOf(parts: readonly (AssistantPart | UserPart)[]): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
}
