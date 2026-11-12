// 玩家的键盘：按一下 mod 加的键（press_key），按住移动的键一段时间（hold_keys）。
// 身体是服务器里的假玩家，没有客户端；mod 在客户端里为一个键、为“按住跳”做的事，身体照那个 mod 的客户端代码做（docs/PROTOCOL.md 的
// bot.key 和 hold 任务）。按了会怎样由那个 mod 决定：这里只把看得见的变化原样说出来（开了什么界面、穿着的东西的数据哪几个值变了、
// 游戏说了什么），不解释任何一个值是什么意思。

import { BridgeError } from '../bridge/protocol.ts'
import type { ClientOnlyScreen, KeyInfo, KeyPressResult } from '../bridge/protocol.ts'
import { clientOnlyText, formatScreen } from './screen.ts'
import { bool, int, num, obj, str } from './schema.ts'
import { queue, startTask } from './tasks.ts'
import { fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

/** 一个键写成一行：名字、游戏“控制”设置里叫什么、属于哪个 mod。 */
function keyLine(k: KeyInfo): string {
  return `- ${k.key}${k.name ? ` "${k.name}"` : ''}${k.category ? ` (${k.category})` : ''}`
}

async function keyList(ctx: ToolContext): Promise<ToolResult> {
  let keys: KeyInfo[]
  let clientOnly: ClientOnlyScreen[]
  try {
    const res = await ctx.bridge.botKeys()
    keys = res.keys ?? []
    clientOnly = res.clientOnly ?? []
  } catch (e) {
    if (e instanceof BridgeError && e.code === 'unknown_method') return fail('The body on the game server is older than mod keys: it has no keys to press.')
    throw e
  }
  // 只在客户端里打开一个界面的键（任务书的键）：按不了，说清楚它做的事用什么做
  const others = clientOnly.map(
    (c) => `- ${c.key ?? ''}${c.keyName ? ` "${c.keyName}"` : ''}: only opens ${c.screen} in a game client; there is nothing to press here. ${clientOnlyText(c).replace(/^.*?Instead, /, 'Instead, ')}`,
  )
  const tail = others.length > 0 ? ['Keys of a game client that only open a screen the server does not have:', ...others] : []
  if (keys.length === 0) return { content: ['No mod on this server adds a key the body can press.', ...tail].join('\n'), data: { keys, clientOnly } }
  return { content: [`The keys mods add here that you can press (press_key with "key"):`, ...keys.map(keyLine), ...tail].join('\n'), data: { keys, clientOnly } }
}

/** 按完一个键看得见的变化。 */
export function formatKeyPress(r: KeyPressResult, sneak: boolean): string {
  const lines = [`Pressed ${r.key}${sneak ? ' while sneaking' : ''}.`]
  const changed = r.changed ?? []
  if (changed.length > 0) {
    const text = (v: string | undefined, gone: string): string => (v === undefined ? gone : v)
    lines.push(`What you wear changed: ${changed.map((c) => `${c.slot}: ${c.key === '' ? 'the thing itself' : c.key} ${text(c.was, '(none)')} → ${text(c.now, '(gone)')}`).join(', ')}`)
  }
  if ((r.said ?? []).length > 0) lines.push(`The game said: ${r.said!.join(' | ')}`)
  if (r.screen) lines.push(r.screen.open === true ? formatScreen(r.screen) : 'The screen that was open is closed now.')
  if (lines.length === 1) lines.push('Nothing visible changed: no screen opened, nothing you wear changed, the game said nothing. What a key does depends on what you wear and hold, whether you sneak, and whether a screen is open.')
  return lines.join('\n')
}

export const pressKey: Tool = {
  name: 'press_key',
  description:
    'Press a key a mod adds, once, as a player does (to open what you wear on your back, to switch it on or off). Without "key": lists the keys. Shows what changed: a screen that opened, the data of what you wear, what the game said. Only while no task runs. Details: wear manual.',
  inputSchema: obj({
    key: str('As listed, e.g. keys.adventureBackpack.toggleActions.', { maxLength: 200 }),
    sneak: bool('Hold Shift with it.'),
  }),
  async run(ctx: ToolContext, i: { key?: string; sneak?: boolean }) {
    if (i.key === undefined || i.key.trim().length === 0) return keyList(ctx)
    const sneak = i.sneak === true
    try {
      const r = await ctx.bridge.botKey(ctx.botName, i.key.trim(), sneak)
      return { content: formatKeyPress(r, sneak), data: r, keepWhole: true }
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e
      if (e.code === 'busy') return fail('A task of yours is running: keys are pressed while you have no task. Wait for it to end (or cancel_task), then press it.')
      if (e.code === 'unknown_method') return fail('The body on the game server is older than mod keys: it cannot press them.')
      if (e.code === 'bad_request') {
        const quests = /\bquest\.submit\b/.test(e.message) ? ' quest_book is the tool that presses those buttons.' : ''
        return fail(`Not pressed: ${e.message}.${quests} press_key without "key" lists the keys.`)
      }
      throw e
    }
  },
}

/** hold 任务一次最多按多久（身体的上限是 1200 tick）。 */
export const HOLD_MAX_SECONDS = 60

export const holdKeys: Tool = {
  name: 'hold_keys',
  description:
    'Hold movement keys for a while, as a player does (task): jump, sneak, forward toward a point. No path finding: you go straight into whatever is there. Ends after "seconds", when your feet reach "y" or "above" the ground, or within "range" of "toward". With a flying pack on and running, jump climbs and sneak sinks. The result: where you are, height above the ground, how you move, the way, the tanks of what you wear. Details: wear manual.',
  inputSchema: obj(
    {
      seconds: num(`Up to ${HOLD_MAX_SECONDS}.`, { min: 0.05, max: HOLD_MAX_SECONDS }),
      jump: bool(),
      sneak: bool(),
      toward: obj({ x: int(), z: int() }, ['x', 'z'], 'Hold forward toward this block column.'),
      range: num('Let go this close to "toward" (default 1 block).', { min: 0.1, max: 32 }),
      y: num('Let go when your feet reach this height.', { min: -64, max: 512 }),
      above: num('Let go at this height above the ground (0: when you touch down).', { min: 0, max: 256 }),
      queue,
    },
    ['seconds'],
  ),
  run: (ctx, i: { seconds: number; jump?: boolean; sneak?: boolean; toward?: { x: number; z: number }; range?: number; y?: number; above?: number; queue?: boolean }) =>
    startTask(
      ctx,
      {
        type: 'hold',
        ticks: Math.max(1, Math.round(i.seconds * 20)),
        ...(i.jump === true ? { jump: true } : {}),
        ...(i.sneak === true ? { sneak: true } : {}),
        toward: i.toward,
        range: i.range,
        y: i.y,
        above: i.above,
      },
      i.queue,
    ),
}
