// 模型能用的全部东西，分三层，以及执行一次调用的统一入口（runTool）：
//
//   1. 工具：连说明和参数 schema 每一轮都发给模型，模型直接调。两条线各有一份清单（docs/TALK_WORK.md）：
//      对话线的 TALK_TOOLS（说悄悄话、查、记、交事和管干活线；没有任何会动身体的），干活线的 WORK_TOOLS（操作身体的全部，
//      加上查、记和向对话线汇报；没有对玩家说话的）。看图的那几个（Tool.picture）只在当前模型能看图时才发，见 modelToolSpecs。
//   2. 库函数（LIBRARY_TOOLS）：不发给模型，不占每一轮的工具清单。模型从 run_program 的说明里那份索引知道它们存在
//      （每个一行：名字、参数要点、data 里有什么），在它写的程序里 await tool(名字, 参数) 调。
//   3. 旧名字（LEGACY_TOOLS）：合并掉的工具原来的名字。不发、不列在索引里，只为已经存着的例程、笔记、它自己写的手册还能用。
//
// 不在清单里不等于调不到：runTool 按名字找的时候三层都找，所以模型直接调了一个库函数或旧名字，和调工具一样照常执行
// （同样的参数校验、同样的结果）。旧习惯、旧笔记、小模型的误调都不该变成一次失败。
// 例外是“另一条线的事”：对话线按名字调到会动身体的、干活线调到对玩家说话的，不执行，如实告诉它这归谁、它自己该怎么办
// （otherLine）。这不是限制它的能力：身体只有一个，结构上就只有干活线在操作。
//
// 往清单里加一个工具之前先想：通用能力（走、挖放、用物品、开界面点格子、存取、写程序）加上模型自己的脑子做得到的事，
// 不做成专用工具；“查一查、算一算”的做成库函数。test/tool-list.test.ts 里有一条按字符数防回涨的测试。

import { BridgeError } from '../bridge/protocol.ts'
import type { ToolSpec } from '../llm/index.ts'
import { buildBlueprint, checkBlueprint, listBlueprints, readBlueprint } from './blueprint.ts'
import { say, whisper } from './chat.ts'
import { craftItem, findInStorage, findItem, findMachines, findRecipes, findUses, processItems } from './crafting.ts'
import { totalMaterials } from './materials.ts'
import { deleteDraft, listDesigns, listDrafts, listImages, publishDraft, routineStatus, runProgramTool, startRoutine, stopRoutine, viewDraft } from './design.ts'
import { reportProblem } from './feedback.ts'
import { clip, dataWithLocalNames } from './format.ts'
import { recentChat, report, stopWork, tellWorker, workerStatus } from './lines.ts'
import { readGuide } from './guide.ts'
import { readLog } from './log.ts'
import { listManuals, readManual, writeManual } from './manuals.ts'
import { forget, remember, setReminder } from './memory.ts'
import { baseMethods, setBaseMethod } from './methods.ts'
import { todo } from './todo.ts'
import {
  findBlocks,
  getPlayerPosition,
  getStatus,
  inspectBlock,
  lookAround,
  probeBlock,
  scanArea,
} from './observe.ts'
import { viewArea, viewImage } from './pictures.ts'
import { findQuests, getQuest, listQuestLines } from './quests.ts'
import { validate } from './schema.ts'
import type { Schema } from './schema.ts'
import { listContainers, listDrawers, listStock } from './storage.ts'
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
  runCommand,
  setHome,
  taskStatus,
  useItem,
  withdrawItems,
} from './tasks.ts'
import { clickSlot, closeScreen, openScreen, useControl } from './screen.ts'
import { checkStructure, findStructure, readBlocks } from './structures.ts'
import { DEFAULT_RESULT_MAX_CHARS, ToolFailure } from './types.ts'
import type { LineName, Tool, ToolContext, ToolResult } from './types.ts'

export type { ChatLogAccess, FeedbackAccess, LineName, TalkAccess, WorkerAccess, ManualAccess, MemoryAccess, ProgramToolResult, ReminderAccess, RoutineAccess, Tool, ToolContext, ToolHooks, ToolImage, ToolResult } from './types.ts'
export { DEFAULT_RESULT_MAX_CHARS } from './types.ts'
export { QuestProgressCache } from './quest-progress.ts'
export { SurroundingsCache } from './recipe-book.ts'

/**
 * 干活线的工具：操作身体的全部（任务、界面、例程、指令、存取合成加工），加上查、记忆、手册、意见簿，和向对话线汇报的 report。
 * 没有对玩家说话的（跟人说话的是对话线）和提醒（提醒到点叫醒的是对话线）。
 * 带 picture 的三个按模型给（modelToolSpecs）：view_area、view_image 只发给能看图的模型，view_draft 在模型不能看图时换成只出文字的那份说明。
 */
export const WORK_TOOLS: readonly Tool[] = [
  report,
  getStatus,
  lookAround,
  scanArea,
  viewArea,
  inspectBlock,
  findBlocks,
  listContainers,
  getPlayerPosition,
  goTo,
  goToPlayer,
  followPlayer,
  goHome,
  runCommand,
  flattenArea,
  clearArea,
  fillArea,
  digBlocks,
  placeBlocks,
  listDesigns,
  buildBlueprint,
  runProgramTool,
  startRoutine,
  routineStatus,
  stopRoutine,
  viewImage,
  viewDraft,
  publishDraft,
  deleteDraft,
  depositItems,
  withdrawItems,
  collectItems,
  giveItems,
  useItem,
  openScreen,
  clickSlot,
  useControl,
  closeScreen,
  findItem,
  findRecipes,
  findInStorage,
  findMachines,
  craftItem,
  processItems,
  findQuests,
  getQuest,
  readGuide,
  taskStatus,
  cancelTask,
  remember,
  forget,
  setReminder,
  baseMethods,
  setBaseMethod,
  todo,
  listManuals,
  readManual,
  writeManual,
  reportProblem,
]

/**
 * 对话线的工具：在游戏里说话的两个（say 公共聊天、whisper 悄悄话；它不调工具写的字只给主人在面板上看）、交事和管干活线的三个、所有只查不动的、
 * run_program（程序里也只能查）、记忆、提醒、手册、意见簿。没有任何会动身体的：那些事它用 tell_worker 交给干活线。
 */
export const TALK_TOOLS: readonly Tool[] = [
  say,
  whisper,
  tellWorker,
  workerStatus,
  stopWork,
  getStatus,
  lookAround,
  scanArea,
  viewArea,
  inspectBlock,
  findBlocks,
  listContainers,
  getPlayerPosition,
  listDesigns,
  runProgramTool,
  viewImage,
  viewDraft,
  findItem,
  findRecipes,
  findInStorage,
  findMachines,
  findQuests,
  getQuest,
  readGuide,
  taskStatus,
  remember,
  forget,
  setReminder,
  baseMethods,
  setBaseMethod,
  todo,
  listManuals,
  readManual,
  writeManual,
  reportProblem,
]

/** 每条线发给模型的清单。 */
export const LINE_TOOLS: Record<LineName, readonly Tool[]> = { talk: TALK_TOOLS, work: WORK_TOOLS }

/** 两条线的工具合在一起（每个只出现一次）。不分线的地方用：测试、工具自己的单元测试。 */
export const ALL_TOOLS: readonly Tool[] = [...TALK_TOOLS, ...WORK_TOOLS.filter((t) => !TALK_TOOLS.includes(t))]

/**
 * 库函数：不发给模型，不占每一轮的工具清单；在它写的程序里 await tool(名字, 参数) 调，返回 { ok, text, data }。
 * “查一查、把结果算一算”这类事放在这里。每个都要有 brief（索引里的那一行）和结构化的 data。
 * 只查不动手的进下面的 QUERY_TOOLS（run_program 里也能调）；会开任务的（haul_items）只能在例程里调。
 */
export const LIBRARY_TOOLS: readonly Tool[] = [
  recentChat,
  readLog,
  listStock,
  listDrawers,
  findUses,
  listQuestLines,
  probeBlock,
  checkBlueprint,
  readBlueprint,
  haulItems,
  readBlocks,
  findStructure,
  checkStructure,
  totalMaterials,
]

/**
 * 旧名字：合并掉的工具（列图纸 / 草稿 / 图片并成了 list_designs，设家 / 列家 / 加入队伍并成了 run_command）。
 * 不发给模型，也不列在库函数的索引里；程序里、模型直接调都照常执行，免得已经存着的例程和笔记用不了。
 */
export const LEGACY_TOOLS: readonly Tool[] = [listBlueprints, listDrafts, listImages, setHome, listHomes, joinTeam]

/** 按名字调得到的全部：模型的工具，加上库函数和旧名字。程序里 tool() 和模型直接调，找的都是这一张表。 */
export function programTools(tools: readonly Tool[]): Tool[] {
  return [...tools, ...[...LIBRARY_TOOLS, ...LEGACY_TOOLS].filter((hidden) => !tools.some((t) => t.name === hidden.name))]
}

/** 库函数里会开任务的：不是“只看不动”，run_program 里调不了，只能在例程里调。 */
const LIBRARY_TASKS: readonly string[] = [haulItems.name]

/**
 * 只看不动的：run_program 的程序里可以调（它在模型的这一轮里跑完，不能去开任务）。
 * 会开任务、说话、发指令、改记忆的不在里面：那些要用 start_routine（后台例程）。
 */
export const QUERY_TOOLS: readonly string[] = [
  'get_status',
  'look_around',
  'scan_area',
  'view_area',
  'inspect_block',
  'find_blocks',
  'list_containers',
  'get_player_position',
  'list_designs',
  'view_image',
  'view_draft',
  'find_item',
  'find_recipes',
  'find_in_storage',
  'find_machines',
  'find_quests',
  'get_quest',
  'read_guide',
  'task_status',
  'base_methods',
  ...LIBRARY_TOOLS.map((t) => t.name).filter((name) => !LIBRARY_TASKS.includes(name)),
  // 旧名字里只查不动的
  'list_blueprints',
  'list_drafts',
  'list_images',
  'list_homes',
]

export function toToolSpecs(tools: readonly Tool[]): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
}

/** 发给模型的清单随什么变：当前模型能不能看图；是哪条线（对话线的库函数索引里只有只查不动的）。 */
export interface ModelView {
  canSee: boolean
  line?: LineName
}

/** 这个工具对这个模型来说在不在清单里。看图的工具在模型不能看图时不在（除非它有一份只讲文字的说明）。 */
function listedFor(tool: Tool, view: ModelView): boolean {
  return view.canSee || tool.picture !== true || tool.textOnly !== undefined
}

/**
 * 库函数的索引里有哪些：LIBRARY_TOOLS，加上因为模型不能看图而没进清单的看图工具（它们给的文字和 data 照样拿得到）。
 */
export function libraryFor(tools: readonly Tool[], view: ModelView): Tool[] {
  const library = LIBRARY_TOOLS.filter((lib) => !tools.some((t) => t.name === lib.name)).filter((lib) => view.line !== 'talk' || QUERY_TOOLS.includes(lib.name))
  return [...library, ...tools.filter((t) => !listedFor(t, view))]
}

/** 只归对话线的：在游戏里说话、管干活线。 */
const TALK_ONLY: readonly string[] = [say.name, whisper.name, tellWorker.name, workerStatus.name, stopWork.name]

/**
 * 这个名字是不是另一条线的事。是的话返回给模型的那句话（不执行）；不是返回 undefined（照常找、照常执行）。
 * - 对话线：清单里的和只查不动的都能调；会动身体、会改游戏里东西的（任务、界面、例程、指令、发布图纸……）归干活线。
 * - 干活线：对玩家说话的、提醒、管它自己的那三个归对话线。
 */
export function otherLine(line: LineName, name: string): string | undefined {
  if (line === 'talk') {
    if (TALK_TOOLS.some((t) => t.name === name) || QUERY_TOOLS.includes(name)) return undefined
    if ([...WORK_TOOLS, ...LIBRARY_TOOLS, ...LEGACY_TOOLS].some((t) => t.name === name)) {
      return `Not done: "${name}" acts with the body or changes something in the game, and only the worker line does that; the talk line has no tool that does. To have it done, hand it over with tell_worker (say what you want done; the worker has ${name}).`
    }
    return undefined
  }
  if (!TALK_ONLY.includes(name)) return undefined
  if (name === say.name || name === whisper.name) return `Not done: "${name}" is not yours. The worker line does not speak to players; the talk line does. Tell it in the text that ends your turn, or with report (a plain report waits until the talk line is next woken; question: true wakes it), and it decides what to say to whom.`
  return `Not done: "${name}" is the talk line's tool for handing you work and stopping you; you are the worker. To tell the talk line something, use report.`
}

export const LIBRARY_INDEX_HEAD =
  'Library functions are not in your tool list; a program calls them like tools. To read one: return (await tool(name, input)).text; to compute with one, use .data. Below: name {input}: what -> data'

/**
 * 库函数的索引：run_program 的说明后面带着它，模型靠它知道这些函数存在（start_routine 的说明指到这里，不重复）。
 * 每个一行（Tool.brief）。整份不超过 2200 字符（test/tool-list.test.ts 看着；真正的闸是清单总大小那条测试）：它每一轮都发，
 * 写长了就把挪走工具省下的又花回去了；各自的参数和 data 的细节在 routines 手册的“库函数”一节。
 */
export function libraryIndex(tools: readonly Tool[], view: ModelView): string {
  return [LIBRARY_INDEX_HEAD, ...libraryFor(tools, view).map((t) => `- ${t.name} ${t.brief ?? ''}`.trimEnd())].join('\n')
}

/**
 * 发给模型的那份参数 schema：去掉对“调对这个工具”没有用的键——additionalProperties:false（多给的字段本来就被忽略）、
 * 字符串的 minLength:1（空串照样被校验拦下并说明）、空的 required。这三样在整份清单里有三千多字符，每一轮都发。
 * 校验用的还是工具自己那份完整的 schema（runTool），行为不变。
 */
export function schemaForModel(schema: Schema): Record<string, unknown> {
  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = { type: 'object' }
      if (schema.description) out.description = schema.description
      out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, sub]) => [key, schemaForModel(sub)]))
      if (schema.required && schema.required.length > 0) out.required = schema.required
      return out
    }
    case 'array':
      return { ...schema, items: schemaForModel(schema.items) }
    case 'string': {
      const { minLength, ...rest } = schema
      return minLength === 1 ? rest : { ...schema }
    }
    default:
      return { ...schema }
  }
}

/**
 * 发给模型的工具清单。和 toToolSpecs 的差别：
 *   - 看图的工具（view_area、view_image）只给能看图的模型；view_draft 的文字那一半谁都用得上，不能看图时换成不提图的说明；
 *   - run_program 的说明后面带上库函数的索引；
 *   - 参数 schema 是瘦过的那份（schemaForModel）。
 */
export function modelToolSpecs(tools: readonly Tool[], view: ModelView): ToolSpec[] {
  const specs: ToolSpec[] = []
  for (const t of tools) {
    if (!listedFor(t, view)) continue
    const shown = !view.canSee && t.picture === true && t.textOnly ? t.textOnly : t
    const description = t.name === runProgramTool.name ? `${shown.description}\n${libraryIndex(tools, view)}` : shown.description
    specs.push({ name: t.name, description, inputSchema: schemaForModel(shown.inputSchema) })
  }
  return specs
}

/** bridge 错误码 → 给模型的补充说明。 */
const BRIDGE_HINTS: Record<string, string> = {
  disconnected: 'The brain is not connected to the game server right now. Nothing in the game can be done until it reconnects.',
  timeout: 'The game server did not answer in time; it may be lagging. Try again later.',
  offline: 'The bot is not in the game world right now.',
  denied: 'The server refused this; asking again gives the same answer. A player can do it, or can allow you to.',
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
  // 身体的原话里说的是协议方法名（blueprint.list），模型认得的是工具名
  if (/no blueprint named/i.test(message)) {
    return 'list_designs shows the blueprints on the server; a name is the file name without ".schematic".'
  }
  if (code === 'too_large' && /queue/i.test(message)) {
    return 'Your task queue is full. Wait for queued tasks to finish, or cancel some, before adding more.'
  }
  return BRIDGE_HINTS[code]
}

/**
 * 执行一次工具调用：按名字找工具 → 校验参数 → 运行 → 截断结果。
 * 任何失败都变成 isError 的结果回给模型，不向外抛。
 * tools 是发给模型的那些；库函数和旧名字不用另外传，按名字一样找得到（见文件开头）。
 */
export async function runTool(
  tools: readonly Tool[],
  ctx: ToolContext,
  name: string,
  input: unknown,
  opts: { maxResultChars?: number } = {},
): Promise<ToolResult> {
  const max = opts.maxResultChars ?? DEFAULT_RESULT_MAX_CHARS
  // 另一条线的事：不执行，如实说归谁
  const notMine = ctx.line !== undefined ? otherLine(ctx.line, name) : undefined
  if (notMine !== undefined) return { content: notMine, isError: true }
  // 三层都找：模型直接调了一个库函数或旧名字，照常执行
  const tool = programTools(tools).find((t) => t.name === name)
  if (!tool) {
    const view: ModelView = { canSee: ctx.canSeeImages?.() === true, ...(ctx.line !== undefined ? { line: ctx.line } : {}) }
    const direct = modelToolSpecs(tools, view).map((t) => t.name)
    const library = libraryFor(tools, view).map((t) => t.name)
    return { content: `There is no tool named "${name}". Your tools: ${direct.join(', ')}. Library functions (in a program: await tool(name, input)): ${library.join(', ')}.`, isError: true }
  }
  const checked = validate(tool.inputSchema, input)
  if (!checked.ok) return { content: `Invalid arguments for ${name}: ${checked.errors.join('; ')}`, isError: true }
  try {
    const raw = await tool.run(ctx, checked.value)
    const result: ToolResult = typeof raw === 'string' ? { content: raw } : raw
    const content = result.keepWhole ? result.content : clip(result.content, max)
    const out: ToolResult = result.isError ? { content, isError: true } : { content }
    if (result.images && result.images.length > 0) out.images = result.images
    // data 里的名字和文字结果里一样用游戏里的中文名（英文原名留在 en 里）
    if (result.data !== undefined) out.data = dataWithLocalNames(result.data)
    return out
  } catch (e) {
    if (e instanceof ToolFailure) return { content: e.message, isError: true }
    if (e instanceof BridgeError) {
      const hint = bridgeHint(e.code, e.message)
      return { content: `${e.code}: ${e.message}${hint ? ` (${hint})` : ''}`, isError: true }
    }
    return { content: `${name} crashed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
  }
}
