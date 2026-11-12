// 任务书的按钮（意见簿 f23）：bot 替自己按“检测/提交”、勾选框、“领取”，挑一样的奖励先点选项。
//
// 任务书的界面只在游戏客户端里画，服务器上没有，所以打不开；它的每个按钮在客户端里是给服务器发一条任务书自己的消息。
// 身体替 bot 做客户端那一半（docs/PROTOCOL.md 的“任务书的按钮”）：quest.submit / quest.check / quest.choose / quest.claim，
// 只动 bot 自己的进度。这里把模型给的编号（get_quest 里的 task N、option N，从 1 数）换成身体要的“第几个”（从 0 数，
// 和 quest.get 的顺序一样，也就是本地资料里的顺序），按完把看得见的变化原样说出来：交掉了什么、拿到了什么、每个子任务、
// 任务现在的状态；按钮在客户端里是灰的就说为什么。

import { BridgeError } from '../bridge/protocol.ts'
import type { QuestPressItem, QuestPressResult } from '../bridge/protocol.ts'
import { normalizeQuestId } from '../packdata/index.ts'
import { formatItem } from './format.ts'
import { partyText } from './quest-book.ts'
import { int, obj, str } from './schema.ts'
import { ToolFailure, fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

/**
 * 交完、打完勾，子任务都满足了以后，任务书要到它下一次查这个玩家时（每 3 秒一次）才把任务标成完成。
 * 最多等这么久，等到了就报最后的状态，没等到就照实说。测试里可以改小。
 */
export const questSettle = { ms: 4000, pollMs: 500 }

type Action = 'submit' | 'tick' | 'claim'

interface QuestBookInput {
  id: string
  action: Action
  task?: number
  choice?: number
}

/** 一个任务的子任务和奖励的样子（只要类型和要几个），本地资料有就用本地的，没有问服务器。 */
interface Shape {
  tasks: { type: string; wanted: number[] | number | undefined }[]
  rewards: { type: string; options: number }[]
}

async function shapeOf(ctx: ToolContext, id: string): Promise<Shape> {
  const local = ctx.packdata?.quests?.get(id)
  if (local) {
    return {
      tasks: local.tasks.map((t) => ({
        type: t.type,
        wanted: (t.items ?? []).length > 0 ? t.items!.map((i) => i.count) : (t.fluids ?? []).length > 0 ? t.fluids!.map((f) => f.mb) : t.count,
      })),
      rewards: local.rewards.map((r) => ({ type: r.type, options: (r.items ?? []).length })),
    }
  }
  const q = await ctx.bridge.questGet(id)
  return {
    tasks: (q.tasks ?? []).map((t) => ({
      type: t.type,
      wanted: (t.items ?? []).length > 0 ? t.items!.map((i) => i.count) : (t.fluids ?? []).length > 0 ? t.fluids!.map((f) => f.mb) : t.count,
    })),
    rewards: (q.rewards ?? []).map((r) => ({ type: r.type, options: (r.items ?? []).length })),
  }
}

function itemsText(items: readonly QuestPressItem[]): string {
  return items.map((i) => formatItem({ id: i.id, meta: i.meta ?? 0, count: i.count, ...(i.name !== undefined ? { name: i.name } : {}) })).join(', ')
}

/** 记着的数对着要的数：9/9, 5/5。 */
function countedText(progress: number[] | number | undefined, wanted: number[] | number | undefined): string {
  if (progress === undefined) return ''
  if (Array.isArray(progress)) {
    return Array.isArray(wanted) && wanted.length === progress.length ? progress.map((n, k) => `${n}/${wanted[k]}`).join(', ') : progress.join(', ')
  }
  return typeof wanted === 'number' ? `${progress}/${wanted}` : String(progress)
}

function taskLines(r: QuestPressResult, shape: Shape | undefined): string[] {
  const tasks = r.tasks ?? []
  if (tasks.length === 0) return []
  const out = ['Its tasks now:']
  for (const t of tasks) {
    const wanted = shape?.tasks[t.task]?.wanted
    const parts = [t.complete ? 'done' : 'not done']
    if (t.was !== undefined) parts[0] += ` (was ${t.was ? 'done' : 'not done'})`
    if (t.optional === true) parts.push('optional')
    const now = countedText(t.progress, wanted)
    if (now) parts.push(t.progressWas !== undefined ? `${now} (was ${countedText(t.progressWas, wanted)})` : now)
    out.push(`- task ${t.task + 1} (${t.type}): ${parts.join('; ')}`)
  }
  return out
}

/** 等任务书把子任务都满足了的任务标成完成。返回等到的状态和用了多久；没等到返回 undefined。 */
async function settle(ctx: ToolContext, id: string): Promise<{ state: string; ms: number } | undefined> {
  const started = Date.now()
  while (Date.now() - started < questSettle.ms) {
    await new Promise((resolve) => setTimeout(resolve, questSettle.pollMs))
    try {
      const q = await ctx.bridge.questGet(id, ctx.botName)
      if (typeof q.state === 'string' && q.state.startsWith('complete')) return { state: q.state, ms: Date.now() - started }
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e
      return undefined
    }
  }
  return undefined
}

function pressedText(ctx: ToolContext, r: QuestPressResult, what: string, shape: Shape | undefined, settled: { state: string; ms: number } | undefined | 'not waited'): string {
  // 任务名用本地资料里的（中文，和 get_quest、find_quests 一样）；没有就是服务器给的英文
  const q = { ...r.quest, name: ctx.packdata?.quests?.get(r.quest.id)?.name ?? r.quest.name }
  const lines: string[] = []
  if (!r.pressed) {
    lines.push(`Not pressed: the ${r.button ?? ''} button of quest ${q.id} "${q.name}" is greyed out in your quest book: ${r.why ?? 'no reason given'}. Its state for you: ${q.state}.`)
    for (const c of r.choices ?? []) {
      lines.push(`Reward ${c.reward + 1} is one to pick: ${c.items.map((i, k) => `option ${k + 1}: ${itemsText([i])}`).join(', ')}. quest_book claim with "choice" picks one and claims.`)
    }
    if (r.party) lines.push(partyText(ctx.botName, r.party))
    return lines.join('\n')
  }
  lines.push(`${what} on quest ${q.id} "${q.name}", for yourself.`)
  if ((r.lost ?? []).length > 0) lines.push(`Handed in (taken from your inventory): ${itemsText(r.lost!)}.`)
  if ((r.gained ?? []).length > 0) lines.push(`Received: ${itemsText(r.gained!)}.`)
  if ((r.dropped ?? []).length > 0) lines.push(`Dropped at your feet (it did not fit in your inventory): ${itemsText(r.dropped!)}.`)
  if (r.xp) lines.push(`Experience: level ${r.xp.levelWas} → ${r.xp.level} (points ${r.xp.pointsWas} → ${r.xp.points}).`)
  if ((r.alsoComplete ?? []).length > 0) lines.push(`The reward also completed: ${r.alsoComplete!.map((o) => `quest ${o.id} "${o.name}"`).join(', ')}.`)
  lines.push(...taskLines(r, shape))
  let state = `Its state for you: ${q.state}${q.was !== undefined ? ` (was ${q.was})` : ''}.`
  if (r.tasksDone === true && settled !== 'not waited') {
    state =
      settled !== undefined
        ? `Its tasks are all done; the quest book marked the quest ${settled.state} ${(settled.ms / 1000).toFixed(1)} s later.`
        : `Its tasks are all done, but the quest book had not marked the quest complete within ${questSettle.ms / 1000} s (it checks each player every 3 s): state for you still ${q.state}. get_quest shows it once it has.`
  }
  lines.push(state)
  const changed = (r.lost ?? []).length + (r.gained ?? []).length + (r.dropped ?? []).length > 0 || (r.tasks ?? []).some((t) => t.was !== undefined || t.progressWas !== undefined) || q.was !== undefined
  if (!changed && r.note === undefined && r.chosen === undefined) {
    lines.push('Nothing changed: nothing was taken from or given to you, and no task moved. get_quest with your own name as "player" shows what each task still needs.')
  }
  if ((r.said ?? []).length > 0) lines.push(`The game said: ${r.said!.join(' | ')}`)
  if (r.note !== undefined) lines.push(`Note: ${r.note}.`)
  if (r.party) lines.push(partyText(ctx.botName, r.party))
  return lines.join('\n')
}

function refusal(e: unknown): ToolResult | undefined {
  if (!(e instanceof BridgeError)) return undefined
  if (e.code === 'busy') return fail('A task of yours is running: the quest book is used while you have no task. Wait for it to end (or cancel_task), then press it.')
  if (e.code === 'unknown_method') return fail("The body on the game server is older than the quest book's buttons: it cannot press them.")
  if (e.code === 'not_found' && /no quest book/i.test(e.message)) return fail('This server has no quest book (BetterQuesting is not installed).')
  if (e.code === 'not_found' || e.code === 'bad_request') return fail(`Not pressed: ${e.message}. find_quests gives the ids; get_quest numbers the tasks and the options.`)
  return undefined
}

export const questBook: Tool = {
  name: 'quest_book',
  description:
    'Press buttons of your own quest book (BetterQuesting), for your own progress only: "submit" (Detect/Submit: hands in from your inventory what its tasks ask for), "tick" (a checkbox task), "claim" (the rewards; for a reward where one is picked, give "choice"). Numbers as get_quest shows them. Says what was handed in and received, each task, the quest state, or why the button is greyed out. Only while no task runs. Details: quests manual.',
  inputSchema: obj(
    {
      id: str('Quest id, as find_quests shows it.', { maxLength: 40 }),
      action: str(undefined, { enum: ['submit', 'tick', 'claim'] }),
      task: int('tick: the task number (default: its only checkbox).', { min: 1 }),
      choice: int('claim: the option to pick.', { min: 1 }),
    },
    ['id', 'action'],
  ),
  async run(ctx: ToolContext, i: QuestBookInput): Promise<ToolResult> {
    const id = normalizeQuestId(i.id)
    const bot = ctx.botName
    try {
      let shape: Shape | undefined
      let r: QuestPressResult
      let what: string
      let chosen: QuestPressResult | undefined
      if (i.action === 'submit') {
        // 子任务要几个只用来把数写成 3/9；问不到不耽误按
        shape = await shapeOf(ctx, id).catch((e: unknown) => {
          if (e instanceof BridgeError) return undefined
          throw e
        })
        r = await ctx.bridge.questSubmit(bot, id)
        what = 'Pressed Detect/Submit'
      } else if (i.action === 'tick') {
        shape = await shapeOf(ctx, id)
        const boxes = shape.tasks.flatMap((t, k) => (t.type === 'checkbox' ? [k] : []))
        let task: number
        if (i.task !== undefined) {
          task = i.task - 1
          if (task >= shape.tasks.length) throw new ToolFailure(`Quest ${id} has ${shape.tasks.length} task(s); there is no task ${i.task}.`)
          if (shape.tasks[task]!.type !== 'checkbox') {
            throw new ToolFailure(`Task ${i.task} of quest ${id} is a ${shape.tasks[task]!.type} task, not a checkbox${boxes.length > 0 ? `; its checkbox is task ${boxes.map((k) => k + 1).join(', ')}` : ''}.`)
          }
        } else {
          if (boxes.length === 0) throw new ToolFailure(`Quest ${id} has no checkbox task (its tasks: ${shape.tasks.map((t, k) => `${k + 1} ${t.type}`).join(', ')}).`)
          if (boxes.length > 1) throw new ToolFailure(`Quest ${id} has several checkboxes (tasks ${boxes.map((k) => k + 1).join(', ')}): give "task".`)
          task = boxes[0]!
        }
        r = await ctx.bridge.questCheck(bot, id, task)
        what = `Ticked task ${task + 1}`
      } else {
        if (i.choice !== undefined) {
          shape = await shapeOf(ctx, id)
          const picks = shape.rewards.flatMap((rw, k) => (rw.type === 'choice' ? [k] : []))
          if (picks.length === 0) throw new ToolFailure(`Quest ${id} has no reward to pick from; claim it without "choice".`)
          if (picks.length > 1) throw new ToolFailure(`Quest ${id} has several rewards to pick from (rewards ${picks.map((k) => k + 1).join(', ')}); this tool picks in one only.`)
          const reward = picks[0]!
          const options = shape.rewards[reward]!.options
          if (i.choice > options) throw new ToolFailure(`Reward ${reward + 1} of quest ${id} has ${options} option(s); there is no option ${i.choice}.`)
          chosen = await ctx.bridge.questChoose(bot, id, reward, i.choice - 1)
        }
        r = await ctx.bridge.questClaim(bot, id)
        what = 'Pressed Claim'
      }
      ctx.questProgress?.forget(bot)
      const waited = r.pressed && r.tasksDone === true && !r.quest.state.startsWith('complete') ? await settle(ctx, id) : 'not waited'
      if (waited !== 'not waited') ctx.questProgress?.forget(bot)
      const lines: string[] = []
      if (chosen?.chosen) {
        const c = chosen.chosen
        const note = chosen.note !== undefined ? ` ${chosen.note.charAt(0).toUpperCase()}${chosen.note.slice(1)}.` : ''
        lines.push(`Picked option ${c.choice + 1} of reward ${c.reward + 1}${c.item ? ` (${itemsText([c.item])})` : ''}.${note}`)
      }
      lines.push(pressedText(ctx, r, what, shape, waited))
      const data = { ...r, ...(chosen ? { chosen: chosen.chosen } : {}), ...(waited !== 'not waited' ? { settled: waited ?? null } : {}) }
      return { content: lines.join('\n'), data }
    } catch (e) {
      if (e instanceof ToolFailure) return fail(e.message)
      const told = refusal(e)
      if (told) return told
      throw e
    }
  },
}
