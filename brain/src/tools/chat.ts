import { COMMANDS, COMMAND_MAX_CHARS, PLAYER_NAME_RE, SAY_LINE_CHARS, SAY_MAX_CHARS, WHISPER_ECHO_RE, WHISPER_FAILED_RE, WHISPER_MAX_CHARS } from './commands.ts'
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

export const say: Tool = {
  name: 'say',
  description: `Say something in public chat: the only way players hear you, besides whisper (your plain text replies are shown to nobody). A chat line holds at most ${SAY_LINE_CHARS} characters: longer text goes out as several lines, about one a second, at most ${SAY_MAX_CHARS} characters at a time.`,
  inputSchema: obj({ message: str('What to say.') }, ['message']),
  async run(ctx, input: { message: string }) {
    const text = chatLine(input.message)
    if (text.length === 0) return fail('message is empty')
    // 怎么分行、截没截由身体定，它的回话里有；这里照实告诉模型发出去是什么样
    const sent = await ctx.bridge.botChat(ctx.botName, text)
    ctx.hooks.spoke?.({ kind: 'say', text })
    const lines = typeof sent.lines === 'number' ? sent.lines : undefined
    const cut = typeof sent.cutChars === 'number' && sent.cutChars > 0 ? sent.cutChars : 0
    const dropped = typeof sent.droppedLines === 'number' && sent.droppedLines > 0 ? sent.droppedLines : 0
    if (lines === 0 && dropped > 0) return fail(`Nothing was said: ${dropped} line(s) could not be queued, because too many chat lines of yours are still waiting to go out. Say it again in a few seconds.`)
    const notes = [
      lines !== undefined && lines > 1 ? `Said in public chat, as ${lines} lines of at most ${SAY_LINE_CHARS} characters, going out about one a second.` : 'Said in public chat.',
      ...(cut > 0 ? [`The last ${cut} characters were cut off: one say holds at most ${SAY_MAX_CHARS}.`] : []),
      ...(dropped > 0 ? [`The last ${dropped} line(s) were not sent: too many chat lines of yours were still waiting to go out.`] : []),
    ]
    return notes.join(' ')
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
