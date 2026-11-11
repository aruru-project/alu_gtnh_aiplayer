// 两条线之间的工具（docs/TALK_WORK.md）：对话线把事交给干活线、看它在干什么、让一切停下；干活线向对话线汇报和提问；
// 还有两条线都能用的“最近的聊天记录”。这里只做参数和措辞，事情本身由 agent/lines.ts 办。

import { clockTime, speakerLine } from '../agent/events.ts'
import type { ChatLine } from '../store/chat-log.ts'
import { PLAYER_NAME_RE } from './commands.ts'
import { bool, int, num, obj, str } from './schema.ts'
import { fail } from './types.ts'
import type { Tool, ToolResult } from './types.ts'

export const TELL_MAX_CHARS = 2000
export const REPORT_MAX_CHARS = 2000

export const tellWorker: Tool = {
  name: 'tell_worker',
  description:
    'Hand something to the worker (the line of you that operates the body), or pass it a message: a job, one more requirement, the answer to its question, a change of plan. It returns at once: an idle worker starts right away, a busy one sees it at its next step. What the people who woke you this turn said is attached by the program as it was said (their words, where they stood, what they pointed at), so write what you want done and what you decided, not a retelling of them.',
  inputSchema: obj({ text: str('What the worker should do or know.', { maxLength: TELL_MAX_CHARS }) }, ['text']),
  async run(ctx, i: { text: string }) {
    if (!ctx.worker) return fail('There is no worker line on this brain.')
    const text = i.text.trim()
    if (text.length === 0) return fail('text is empty')
    return ctx.worker.tell(text)
  },
}

export const workerStatus: Tool = {
  name: 'worker_status',
  description:
    'What the worker is doing now: its turn and its last steps, the task the body is on and the queue, its routine, its last report, whether it is waiting for an answer from you. A short version of this is in the state you are shown every turn.',
  inputSchema: obj({ detail: bool('true: also the results of its last steps and the log of its routine.') }),
  async run(ctx, i: { detail?: boolean }) {
    if (!ctx.worker) return fail('There is no worker line on this brain.')
    return ctx.worker.status(i.detail === true)
  },
}

export const stopWork: Tool = {
  name: 'stop_work',
  description:
    'Stop everything the body is doing, in one call: all of its tasks and the routine are canceled, the worker is interrupted in the middle of its thinking, and what it had not handled yet is set aside. This does not need the worker to cooperate. The worker is then told that it was stopped and why (your reason, and what the people who woke you said); it does not carry on by itself. Changing its direction without stopping the body is tell_worker.',
  inputSchema: obj({ reason: str('Why (one sentence, for the worker).', { maxLength: 300 }) }),
  async run(ctx, i: { reason?: string }) {
    if (!ctx.worker) return fail('There is no worker line on this brain.')
    return ctx.worker.stop((i.reason ?? '').trim())
  },
}

export const report: Tool = {
  name: 'report',
  description:
    'Leave the talk line (the line of you that speaks with players) a note now, without ending your turn: progress, a finding. A plain note does not wake it: it reads it the next time it is woken, and when someone asks how things go. question: true wakes it at once, and says you are waiting for the answer; it comes back as a message from the talk line, which asks your owner when it cannot answer itself. What you leave when your turn ends wakes it too, once you have stopped.',
  inputSchema: obj(
    {
      text: str('What to tell it. It does not see your tool calls or their results: put in the names, numbers and places it needs.', { maxLength: REPORT_MAX_CHARS }),
      question: bool('true: a question you are waiting for the answer to; this wakes the talk line at once.'),
    },
    ['text'],
  ),
  async run(ctx, i: { text: string; question?: boolean }) {
    if (!ctx.talk) return fail('There is no talk line on this brain.')
    const text = i.text.trim()
    if (text.length === 0) return fail('text is empty')
    return ctx.talk.report(text, i.question === true)
  },
}

const RECENT_CHAT_DEFAULT = 30
const RECENT_CHAT_MAX = 100

const SAID_HOW: Record<ChatLine['kind'], (l: ChatLine) => string> = {
  chat: (l) => `${l.who}:`,
  whisper: (l) => `${l.who} (whisper to you):`,
  panel: () => 'your owner (control panel):',
  said: () => 'you said:',
  whispered: (l) => `you whispered to ${l.to ?? '?'}:`,
}

/** 聊天记录里的一句写成一两行：时间、谁、原话；别人说的带着他当时站在哪、指着什么。 */
export function chatLineText(l: ChatLine): string {
  const view = l.speaker ? `\n    (${speakerLine(l.who, l.speaker)})` : ''
  return `[${clockTime(l.time)}] ${SAID_HOW[l.kind](l)} ${l.text}${view}`
}

/**
 * 最近的聊天记录，只读。库函数：不占清单，程序里调；模型直接调这个名字也照常执行。
 * 干活线拿到的事附着当时的原话，但更早的几句（主人先说了指着哪个、后来才说“对，就那个”）要靠它自己查。
 */
export const recentChat: Tool = {
  name: 'recent_chat',
  description:
    'The latest chat lines, oldest first: public chat, whispers to you, what your owner typed on the control panel, and what you said. Each line of another player carries where they stood and what they pointed at when they said it.',
  brief: '{minutes?, limit?, player?}: chat as said, where each speaker stood and pointed -> lines[{time, kind, who, text, speaker}]',
  inputSchema: obj({
    minutes: num('Only lines from the last so many minutes (default: any age the log still holds).', { min: 0.1, max: 100_000 }),
    limit: int(`At most this many lines, the latest ones (default ${RECENT_CHAT_DEFAULT}).`, { min: 1, max: RECENT_CHAT_MAX }),
    player: str('Only lines said by this player.'),
  }),
  async run(ctx, i: { minutes?: number; limit?: number; player?: string }): Promise<ToolResult> {
    if (!ctx.chatLog) return fail('This brain keeps no chat log.')
    if (i.player !== undefined && !PLAYER_NAME_RE.test(i.player)) return fail(`"${i.player}" is not a valid player name`)
    const limit = i.limit ?? RECENT_CHAT_DEFAULT
    const res = ctx.chatLog.recent({ limit, ...(i.minutes !== undefined ? { since: ctx.now() - i.minutes * 60_000 } : {}), ...(i.player !== undefined ? { player: i.player } : {}) })
    const scope = `${i.player !== undefined ? ` by ${i.player}` : ''}${i.minutes !== undefined ? ` in the last ${i.minutes} minute(s)` : ''}`
    const data = { lines: res.lines, matched: res.matched }
    if (res.lines.length === 0) return { content: `No chat lines${scope}. The log holds the latest ${res.kept} line(s) of all chat.`, data }
    const head =
      res.matched > res.lines.length
        ? `The latest ${res.lines.length} of ${res.matched} chat line(s)${scope}, oldest first (the earlier ${res.matched - res.lines.length} are not shown: ask with a larger limit, up to ${RECENT_CHAT_MAX}, or with player):`
        : `${res.lines.length} chat line(s)${scope}, oldest first:`
    return { content: [head, ...res.lines.map(chatLineText)].join('\n'), data }
  },
}
