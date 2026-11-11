import { COMMANDS, COMMAND_MAX_CHARS, PLAYER_NAME_RE, SAY_LINE_CHARS, SAY_MAX_CHARS, WHISPER_ECHO_RE, WHISPER_FAILED_RE, WHISPER_MAX_CHARS } from './commands.ts'
import type { BridgeApi } from '../bridge/api.ts'
import { obj, str } from './schema.ts'
import { fail } from './types.ts'
import type { Tool } from './types.ts'

/**
 * 聊天是单行的：换行压成空格。开头的 / 去掉——身体如果是按“玩家发了一条聊天”来实现 bot.chat，
 * 以 / 开头的内容会被当成指令执行，绕过指令允许列表。
 */
export function cleanChatText(text: string, max: number): string {
  const oneLine = text
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/[\u0000-\u001f\u007f\u00a7]/g, '')
    .trim()
    .replace(/^\/+\s*/, '')
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

/** 把文字拆成每段不超过 size 个字符（按 UTF-16 长度算，和身体那边数的一样），不把一个字拆成两半。 */
export function chunks(text: string, size: number): string[] {
  const out: string[] = []
  let current = ''
  for (const ch of text) {
    if (current.length + ch.length > size && current.length > 0) {
      out.push(current)
      current = ''
    }
    current += ch
  }
  if (current.length > 0) out.push(current)
  return out
}

/** 聊天用的文字：单行（换行压成空格）、去掉控制字符和开头的 /。不截短。 */
function chatLine(text: string): string {
  return cleanChatText(text, Number.POSITIVE_INFINITY)
}

/**
 * 聊天里显示不了 markdown：粗体、斜体、行内代码、代码块的围栏、标题、引用、列表符号这些记号去掉，字留下；链接留下文字和地址。
 * 只去成对的强调记号，算式里的星号（2*3*4）和物品 id 里的下划线不动。
 */
export function plainChat(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, '')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+•][ \t]+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(?<![*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '$1 $2')
}

/** 一次在公共聊天里说话的结果：发出去的是什么、身体说发成了几行、截没截、丢没丢。 */
export interface Spoken {
  /** 清理过、真正交给身体的那段文字。 */
  text: string
  /** empty：清理完什么都不剩，没有发；sent：发了（可能截了尾、丢了后面几行）；unsent：一行都没排进去。 */
  outcome: 'empty' | 'sent' | 'unsent'
  /** 身体说发成了几行（老的身体不说）。 */
  lines?: number
  cutChars: number
  droppedLines: number
}

/**
 * 在公共聊天里说一段话（对话线的 say、程序替它说的话都走这里）：去掉 markdown 记号，压成一行，交给身体。
 * 怎么分行、截没截由身体定，它的回话里有，照实带回去。身体不在线、bridge 断了时抛 BridgeError。
 */
export async function speakInChat(bridge: BridgeApi, botName: string, text: string): Promise<Spoken> {
  const line = chatLine(plainChat(text))
  if (line.length === 0) return { text: '', outcome: 'empty', cutChars: 0, droppedLines: 0 }
  const sent = await bridge.botChat(botName, line)
  const lines = typeof sent.lines === 'number' ? sent.lines : undefined
  const cutChars = typeof sent.cutChars === 'number' && sent.cutChars > 0 ? sent.cutChars : 0
  const droppedLines = typeof sent.droppedLines === 'number' && sent.droppedLines > 0 ? sent.droppedLines : 0
  return { text: line, outcome: lines === 0 && droppedLines > 0 ? 'unsent' : 'sent', ...(lines !== undefined ? { lines } : {}), cutChars, droppedLines }
}

/** 这次说话有什么不寻常（没发出去、截了尾、丢了几行），写成一句话（给模型看，也记进日志）；一切正常是 undefined。 */
export function spokenTrouble(s: Spoken): string | undefined {
  if (s.outcome === 'unsent') return `这段话一行都没说出去：你还有太多行聊天排着没发完，这 ${s.droppedLines} 行排不进去。过几秒再说。`
  const notes = [
    ...(s.cutChars > 0 ? [`最后 ${s.cutChars} 个字被截掉了（一次最多说 ${SAY_MAX_CHARS} 字，每 ${SAY_LINE_CHARS} 字一行${s.lines !== undefined ? `，这次发成了 ${s.lines} 行` : ''}）`] : []),
    ...(s.droppedLines > 0 ? [`最后 ${s.droppedLines} 行没发出去（你还有太多行聊天排着没发完）`] : []),
  ]
  return notes.length > 0 ? `这段话没有全部说出去：${notes.join('；')}。没说出去的可以之后再说。` : undefined
}

/**
 * 对话线在公共聊天里说话：服务器里所有人都看得到。它不调工具写的字只给主人在面板上看，游戏里没人看到。
 * 怎么分行、截没截、丢没丢由身体定，它的回话里有，照实写进结果。
 */
export const say: Tool = {
  name: 'say',
  description: `Say something in public chat: everyone on the server sees it. (Text you write without a tool is seen only by your owner on the control panel.) A chat line holds at most ${SAY_LINE_CHARS} characters: longer text goes out as several lines, about one a second, at most ${SAY_MAX_CHARS} characters at a time. Markdown marks are removed.`,
  inputSchema: obj({ text: str('What to say.') }, ['text']),
  async run(ctx, input: { text: string }) {
    const spoken = await speakInChat(ctx.bridge, ctx.botName, input.text)
    if (spoken.outcome === 'empty') return fail('Nothing was said: the text is empty once markdown marks are removed.')
    if (spoken.outcome === 'unsent') {
      return fail(`Nothing was said: its ${spoken.droppedLines} line(s) could not be queued, because too many chat lines of yours are still waiting to go out. Say it again in a few seconds.`)
    }
    const said = spoken.cutChars > 0 ? spoken.text.slice(0, Math.max(0, spoken.text.length - spoken.cutChars)) : spoken.text
    const odd = spoken.cutChars > 0 || spoken.droppedLines > 0
    const note = spokenTrouble(spoken)
    ctx.hooks.spoke?.({
      kind: 'say',
      text: said,
      ...(odd ? { sent: { ...(spoken.lines !== undefined ? { lines: spoken.lines } : {}), ...(spoken.cutChars > 0 ? { cutChars: spoken.cutChars } : {}), ...(spoken.droppedLines > 0 ? { droppedLines: spoken.droppedLines } : {}) } } : {}),
      ...(note !== undefined ? { note } : {}),
    })
    return [
      spoken.lines !== undefined && spoken.lines > 1 ? `Said in public chat, as ${spoken.lines} lines of at most ${SAY_LINE_CHARS} characters, going out about one a second.` : 'Said in public chat.',
      ...(spoken.cutChars > 0 ? [`The last ${spoken.cutChars} characters were cut off: one say holds at most ${SAY_MAX_CHARS}. Say the rest in another say.`] : []),
      ...(spoken.droppedLines > 0 ? [`The last ${spoken.droppedLines} line(s) were not sent: too many chat lines of yours were still waiting to go out.`] : []),
    ].join(' ')
  },
}

export const whisper: Tool = {
  name: 'whisper',
  description: `Send a private message to one player (only they see it). At most ${WHISPER_MAX_CHARS} characters.`,
  inputSchema: obj({ player: str('Exact player name.'), message: str('What to tell them.') }, ['player', 'message']),
  async run(ctx, input: { player: string; message: string }) {
    if (!PLAYER_NAME_RE.test(input.player)) return fail(`"${input.player}" is not a valid player name`)
    const whole = chatLine(input.message)
    if (whole.length === 0) return fail('message is empty')
    // 太长的只发开头那一段，并在结果里写明（不悄悄截掉）
    const text = whole.length > WHISPER_MAX_CHARS ? whole.slice(0, WHISPER_MAX_CHARS) : whole
    const output: string[] = []
    // 每条 tell 指令连同玩家名不能超过身体允许的长度
    const room = COMMAND_MAX_CHARS - COMMANDS.whisper(input.player, '').length
    ctx.hooks.commandStart?.()
    try {
      for (const part of chunks(text, room)) {
        const res = await ctx.bridge.botCommand(ctx.botName, COMMANDS.whisper(input.player, part))
        output.push(...(res.output ?? []))
      }
    } finally {
      ctx.hooks.commandEnd?.()
    }
    // 实测的回显：送到了是 “You whisper to <玩家>: <内容>”，对方不在线是 “That player cannot be found”。
    const reply = output.join(' | ')
    if (WHISPER_FAILED_RE.test(reply)) return fail(`${input.player} did not get it. The server replied: ${reply}`)
    ctx.hooks.spoke?.({ kind: 'whisper', to: input.player, text })
    const unusual = output.filter((line) => !WHISPER_ECHO_RE.test(line))
    const cut = whole.length > text.length ? ` Only the first ${text.length} of ${whole.length} characters were sent: a whisper holds at most ${WHISPER_MAX_CHARS}. Send the rest in another whisper.` : ''
    return `${unusual.length > 0 ? `Whisper sent. The server replied: ${unusual.join(' | ')}` : 'Whisper sent.'}${cut}`
  },
}
