import { COMMANDS, COMMAND_MAX_CHARS, PLAYER_NAME_RE, SAY_MAX_CHARS, WHISPER_ECHO_RE, WHISPER_FAILED_RE, WHISPER_MAX_CHARS } from './commands.ts'
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

export const say: Tool = {
  name: 'say',
  description:
    'Say something in public chat. This is the only way players can hear you (besides whisper); your plain text replies are not shown to anyone. Keep it short.',
  inputSchema: obj({ message: str('What to say. One short line.') }, ['message']),
  async run(ctx, input: { message: string }) {
    const text = cleanChatText(input.message, SAY_MAX_CHARS)
    if (text.length === 0) return fail('message is empty')
    await ctx.bridge.botChat(ctx.botName, text)
    ctx.hooks.spoke?.({ kind: 'say', text })
    return 'Said in public chat.'
  },
}

export const whisper: Tool = {
  name: 'whisper',
  description: 'Send a private message to one player (only they see it).',
  inputSchema: obj({ player: str('Exact player name.'), message: str('What to tell them. One short line.') }, [
    'player',
    'message',
  ]),
  async run(ctx, input: { player: string; message: string }) {
    if (!PLAYER_NAME_RE.test(input.player)) return fail(`"${input.player}" is not a valid player name`)
    const text = cleanChatText(input.message, WHISPER_MAX_CHARS)
    if (text.length === 0) return fail('message is empty')
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
    return unusual.length > 0 ? `Whisper sent. The server replied: ${unusual.join(' | ')}` : 'Whisper sent.'
  },
}
