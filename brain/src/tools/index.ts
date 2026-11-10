// 模型可用的全部工具，以及执行一次工具调用的统一入口。

import { BridgeError } from '../bridge/protocol.ts'
import type { ToolSpec } from '../llm/index.ts'
import { buildBlueprint, checkBlueprint, listBlueprints } from './blueprint.ts'
import { say, whisper } from './chat.ts'
import { craftItem, findInStorage, findItem, findMachines, findRecipes, processItems } from './crafting.ts'
import { clip } from './format.ts'
import { listManuals, readManual } from './manuals.ts'
import { forget, remember, setReminder } from './memory.ts'
import {
  findBlocks,
  getPlayerPosition,
  getStatus,
  inspectBlock,
  listContainers,
  lookAround,
  probeBlock,
  scanArea,
} from './observe.ts'
import { findQuests, getQuest, listQuestLines } from './quests.ts'
import { validate } from './schema.ts'
import {
  cancelTask,
  clearArea,
  collectItems,
  depositItems,
  digBlocks,
  fillArea,
  flattenArea,
  followPlayer,
  giveItems,
  goHome,
  goTo,
  goToPlayer,
  haulItems,
  joinTeam,
  listHomes,
  placeBlocks,
  setHome,
  taskStatus,
  withdrawItems,
} from './tasks.ts'
import { ToolFailure } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

export type { ManualAccess, MemoryAccess, ReminderAccess, Tool, ToolContext, ToolHooks, ToolResult } from './types.ts'

export const ALL_TOOLS: readonly Tool[] = [
  say,
  whisper,
  getStatus,
  lookAround,
  scanArea,
  inspectBlock,
  probeBlock,
  findBlocks,
  listContainers,
  getPlayerPosition,
  goTo,
  goToPlayer,
  followPlayer,
  goHome,
  setHome,
  listHomes,
  joinTeam,
  flattenArea,
  clearArea,
  fillArea,
  digBlocks,
  placeBlocks,
  listBlueprints,
  checkBlueprint,
  buildBlueprint,
  depositItems,
  withdrawItems,
  haulItems,
  collectItems,
  giveItems,
  findItem,
  findRecipes,
  findInStorage,
  findMachines,
  craftItem,
  processItems,
  listQuestLines,
  findQuests,
  getQuest,
  taskStatus,
  cancelTask,
  remember,
  forget,
  setReminder,
  listManuals,
  readManual,
]

export function toToolSpecs(tools: readonly Tool[]): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
}

/** bridge 错误码 → 给模型的补充说明。 */
const BRIDGE_HINTS: Record<string, string> = {
  disconnected: 'The brain is not connected to the game server right now. Nothing in the game can be done until it reconnects.',
  timeout: 'The game server did not answer in time; it may be lagging. Try again later.',
  offline: 'The bot is not in the game world right now.',
  denied: 'The server refused this. Do not retry; ask a player.',
  not_found: 'Check the name or id.',
  bad_request: 'The arguments were rejected; fix them before trying again.',
  too_large: 'The request is too big; split it into smaller pieces.',
  busy: 'Nothing is wrong: the game server has just started and is still building its recipe index, which takes about 20 seconds. Make the same call again in a few seconds.',
}

/**
 * 同一个错误码下，身体的消息还分几种情况，模型该做的事不一样（消息原文是在真实 mod 上实测的）：
 * - denied + “too many chat lines and commands…”：说话和指令太密了，等几秒就好，不是不让用；
 * - denied + “not on the bot allow list”：这条指令 bot 不能用，重试没用；
 * - too_large + “tasks may wait in the queue”：任务队列满了（最多 32 个）。
 */
export function bridgeHint(code: string, message: string): string | undefined {
  if (code === 'denied' && /too many chat lines and commands/i.test(message)) {
    return 'You are talking and running commands too fast. Nothing is wrong: wait a few seconds, then do it once more, and say less at a time.'
  }
  if (code === 'denied' && /allow list/i.test(message)) {
    return 'Bots are not allowed to use this command on this server. Retrying will not help; ask a player to do it.'
  }
  if (code === 'too_large' && /queue/i.test(message)) {
    return 'Your task queue is full. Wait for queued tasks to finish, or cancel some, before adding more.'
  }
  return BRIDGE_HINTS[code]
}

/**
 * 执行一次工具调用：按名字找工具 → 校验参数 → 运行 → 截断结果。
 * 任何失败都变成 isError 的结果回给模型，不向外抛。
 */
export async function runTool(
  tools: readonly Tool[],
  ctx: ToolContext,
  name: string,
  input: unknown,
  opts: { maxResultChars?: number } = {},
): Promise<ToolResult> {
  const max = opts.maxResultChars ?? 6000
  const tool = tools.find((t) => t.name === name)
  if (!tool) {
    return { content: `There is no tool named "${name}". Available: ${tools.map((t) => t.name).join(', ')}`, isError: true }
  }
  const checked = validate(tool.inputSchema, input)
  if (!checked.ok) return { content: `Invalid arguments for ${name}: ${checked.errors.join('; ')}`, isError: true }
  try {
    const raw = await tool.run(ctx, checked.value)
    const result: ToolResult = typeof raw === 'string' ? { content: raw } : raw
    const content = result.keepWhole ? result.content : clip(result.content, max)
    return result.isError ? { content, isError: true } : { content }
  } catch (e) {
    if (e instanceof ToolFailure) return { content: e.message, isError: true }
    if (e instanceof BridgeError) {
      const hint = bridgeHint(e.code, e.message)
      return { content: `${e.code}: ${e.message}${hint ? ` (${hint})` : ''}`, isError: true }
    }
    return { content: `${name} crashed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
}
