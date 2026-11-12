import type { MethodAccess } from './methods.ts'
import type { TodoAccess } from './todo.ts'
import type { BridgeApi } from '../bridge/api.ts'
import type { TaskInfo } from '../bridge/protocol.ts'
import type { DesignWorkspace } from '../design/index.ts'
import type { PackData } from '../packdata/index.ts'
import type { LogPage, LogQuery } from '../store/activity-log.ts'
import type { FeedbackInput } from '../store/feedback.ts'
import type { ChatLine } from '../store/chat-log.ts'
import type { Manual } from '../store/manuals.ts'
import type { QuestProgressCache } from './quest-progress.ts'
import type { SurroundingsCache } from './recipe-book.ts'
import type { ObjectSchema } from './schema.ts'

/** 工具结果带的一张图。任何工具都可以带（简图、主人传的图片、以后的真实截图……），上层统一决定给不给模型看。 */
export interface ToolImage {
  /** 这是什么图（英文一句话）。图不再附带以后，历史里留下的占位文字用它。 */
  label: string
  mediaType: 'image/png' | 'image/jpeg'
  data: Buffer
  /**
   * 这张图画的是哪些方块（render/scene.ts 的 StoredBlocks）。简图才有；有的话面板可以给主人做一个能拖着转的三维预览。
   * 不给模型。
   */
  blocks?: unknown
}

export interface ToolResult {
  content: string
  isError?: boolean
  /** 这段内容要整段给模型，不按“单个工具结果上限”截断（手册：截掉一半的手册比没有还糟）。 */
  keepWhole?: boolean
  /**
   * 同一个结果的数据形式，给它写的程序用（程序里 tool() 返回的 data）；不给模型。要能写成 JSON。
   */
  data?: unknown
  /**
   * 给模型看的图。现在用的模型能看图（ctx.canSeeImages）时上层才会把它放进消息；
   * 所以 content 里要有不看图也读得懂的文字（至少说清这是什么图）。
   */
  images?: ToolImage[]
}

/** 工具需要的手册接口（store/manuals.ts 的 ManualStore 满足）。 */
export interface ManualAccess {
  list(): Manual[]
  get(name: string): Manual | undefined
  /** 它自己写一本（把主人教的做法记成一篇）。不合规时抛 ManualError。 */
  saveOwn(input: { name: string; summary: string; body: string }): Manual
}

/** 工具需要的记忆接口（store/memory.ts 的 MemoryStore 满足）。 */
export interface MemoryAccess {
  set(key: string, text: string): void
  delete(key: string): boolean
  totalChars(): number
}

/** 工具需要的意见簿接口。提交时的现场（这一轮的指令、最近的工具调用……）由上层附上。 */
export interface FeedbackAccess {
  /** merged：和之前的一条是同一个问题，只加了次数。full：今天记得太多了，这条没记。 */
  submit(input: FeedbackInput): { id: string; merged: boolean; count: number } | { full: true }
}

/**
 * 例程：它写的程序在后台跑，程序里一个个调工具（agent/routine.ts）。这里是工具要的那几个口子，文字都是现成的英文。
 */
export interface RoutineAccess {
  /** 启动。已经有一个在跑、或者启动不了时给 error。 */
  start(code: string, opts: { name?: string; minutes?: number }): { started: string } | { error: string }
  /** 正在跑的（没有就是上一个跑完的）现在什么情况；一个都没跑过时是 undefined。 */
  status(): string | undefined
  /** 停掉正在跑的；没有在跑的返回 false。 */
  stop(): boolean
}

/** 程序里调一次工具的结果。 */
export interface ProgramToolResult {
  ok: boolean
  /** 模型会看到的那段文字。 */
  text: string
  /** 同一个结果的数据形式（有些工具没有）。 */
  data?: unknown
}

/** 哪条线：对话的（talk）还是干活的（work）。见 docs/TALK_WORK.md。 */
export type LineName = 'talk' | 'work'

/** 谁在调工具：两条线之一，或者对话线派出去的子思维（helper，只查不改，见 agent/helpers.ts）。 */
export type ToolLine = LineName | 'helper'

/** 对话线派子思维、看它们、停它们的口子（start_helper、helper_status）。文字都是现成的英文，事情由 agent/helpers.ts 办。 */
export interface HelperAccess {
  /** 派一个出去想这件事；马上返回（编号，或者为什么没派成）。 */
  start(task: string): string
  /** 不给 id：在想的和最近想完的；给 id：那一个的详情。stop：停掉那一个。 */
  status(id: string | undefined, stop: boolean): string
}

/** 对话线管干活线的口子（tell_worker、worker_status、stop_work）。文字都是现成的英文，事情由 agent/lines.ts 办。 */
export interface WorkerAccess {
  /** 把一件事交给干活线或带一句话；当时的人的原话由上层原样附上。马上返回。 */
  tell(text: string): string
  /** 干活线现在在干什么。 */
  status(detail: boolean): Promise<string>
  /** 让一切停下：身体的任务、例程、干活线正在想的那一步。 */
  stop(reason: string): Promise<string>
}

/** 干活线找对话线的口子（report）。 */
export interface TalkAccess {
  report(text: string, question: boolean): string
}

/** 最近的聊天记录（store/chat-log.ts 的 ChatLog 满足），只读。 */
export interface ChatLogAccess {
  recent(opts: { since?: number; limit?: number; player?: string }): { lines: ChatLine[]; matched: number; kept: number }
}

export interface ReminderAccess {
  /** 登记一个提醒，返回到点时间（epoch ms）。line 是哪条线定的：到点叫醒的是它（不给是对话线）。 */
  add(dueAt: number, note: string, line?: 'talk' | 'work'): { id: string; dueAt: number }
}

/** 工具执行时通知上层的钩子。工具自己不做任何决定。 */
export interface ToolHooks {
  /**
   * bot 在公共聊天或私聊里说了话。text 是真的说出去了的；sent 是身体回的发送结果里不寻常的（分了几行、截掉多少字、丢了几行），
   * note 是同一件事写成的一句话（记进日志）。
   */
  spoke?(info: { kind: 'say' | 'whisper'; to?: string; text: string; sent?: { lines?: number; cutChars?: number; droppedLines?: number }; note?: string }): void
  /** 成功启动（或排队）了一个任务。 */
  taskStarted?(task: TaskInfo): void
  /**
   * 马上要发一个会让身体取消任务的请求（replace 模式的 task.start，或 task.cancel）。
   * 身体是先发“任务被取消”的事件、再回响应的，所以从这一刻到 cancelEnd 之间收到的取消都是自己造成的。
   */
  cancelStart?(): void
  /** 上面那个请求结束了（成功或失败）。ids 是响应里说的被取消的任务。 */
  cancelEnd?(ids: readonly string[]): void
  /** 马上要以 bot 身份执行一条指令。期间收到的系统消息是这条指令的回显（工具结果里已经有了）。 */
  commandStart?(): void
  commandEnd?(): void
  /** run_program 开始跑一个程序 / 跑完了：上层把这个程序调的工具归到一起记日志。 */
  programStarted?(code: string): void
  programEnded?(how: { ok: boolean; note: string }): void
}

export interface ToolContext {
  botName: string
  /**
   * 哪条线在调。给了的话，另一条线的事按名字调到时不执行、如实说明归谁（对话线调会动身体的工具、干活线调 say）。
   * 上层没提供时不分线：按名字找得到的都执行。
   */
  line?: LineName
  /** 对话线才有：交事、看干活线、叫停。 */
  worker?: WorkerAccess
  /** 干活线才有：向对话线汇报、提问。 */
  talk?: TalkAccess
  /** 对话线才有：派子思维、看它们、停它们。 */
  helpers?: HelperAccess
  /**
   * 子思维的编号（h3）：给了的话，调工具的是对话线派出去的一个子思维（不看 line）。它只查不改：清单以外的、会说话动身体、
   * 会记东西的按名字调到也不执行，如实说明（tools/index.ts 的 otherLine）。
   */
  helper?: string
  /** 最近的聊天记录。上层没提供时 recent_chat 用不了。 */
  chatLog?: ChatLogAccess
  /** 活动日志（store/activity-log.ts 的 ActivityLog 满足），只读。上层没提供时 read_log 用不了。 */
  activityLog?: { search(query: LogQuery): LogPage }
  /** run_program 占哪个位子：两条线各跑各的程序，互不挡着。 */
  programSlot?: string
  bridge: BridgeApi
  memory: MemoryAccess
  reminders: ReminderAccess
  manuals: ManualAccess
  /**
   * 本地资料（任务书、物品表）。上层没提供、或者里面哪一项没加载到时，用它的工具退回去问服务器。
   */
  packdata?: PackData
  /** 任务书进度的短时缓存。上层没提供时每次都问服务器。 */
  questProgress?: QuestProgressCache
  /** 附近有哪些机器和工作台的短时缓存（查做法时用）。上层没提供时每次都问身体。 */
  surroundings?: SurroundingsCache
  /** 自己出设计用的：跑程序的沙箱、图纸草稿、主人传的图片。上层没提供时这类工具用不了。 */
  design?: DesignWorkspace
  /** “基地的做法”（store/methods.ts）。上层没提供时 base_methods、set_base_method 用不了，别处也不带它的记录。 */
  methods?: MethodAccess
  /** 工作清单（store/todo.ts）。上层没提供时 todo 用不了。 */
  todo?: TodoAccess
  /** 意见簿。上层没提供时 report_problem 用不了。 */
  feedback?: FeedbackAccess
  /** 后台例程。上层没提供时 start_routine 这几个工具用不了。 */
  routines?: RoutineAccess
  /** run_program 的程序里调工具：只许查询类的（不开任务、不改东西）。上层没提供时程序调不了工具。 */
  queryFromProgram?(name: string, input: unknown): Promise<ProgramToolResult>
  hooks: ToolHooks
  /** 现在用的模型能不能看图。上层没提供时等于不能：带图的工具只给文字说明。 */
  canSeeImages?(): boolean
  /**
   * “单个工具结果上限”（面板上的那个设置）现在是多少。run_program 的程序 return 的值也照它截（截了会写明）。
   * 上层没提供时按 DEFAULT_RESULT_MAX_CHARS。
   */
  maxResultChars?(): number
  now(): number
  /**
   * 查任务书进度时，模型没说看谁的就看这个玩家的：主人名单里的第一个；没有名单时是刚才跟它说话的那个玩家；都没有就是 undefined。
   * 上层没提供时等于 undefined。
   */
  defaultPlayer?(): string | undefined
  /**
   * bot.command 的 output 只有指令执行当下服务器回的消息；晚一步才到的走 bot.message 事件。
   * 这个函数等 waitMs，然后返回 since 之后收到的那些系统消息。上层没提供时工具就只用 output。
   */
  laterMessages?(since: number, waitMs: number): Promise<string[]>
}

export interface Tool {
  name: string
  /** 给模型看，英文，简短准确。 */
  description: string
  inputSchema: ObjectSchema
  /** input 已按 inputSchema 校验过。返回字符串等同于 { content }。 */
  run(ctx: ToolContext, input: any): Promise<ToolResult | string>
  /**
   * 库函数索引里的一行（英文，接在名字后面）：参数要点、做什么、data 里有什么。
   * 不进工具清单的（库函数；看图的工具在模型不能看图时）靠这一行让模型知道它存在，所以都要写。
   */
  brief?: string
  /**
   * 看图的工具：当前模型能看图时才进工具清单。不能看图时它照样能调（程序里、模型直接调都照常执行，给的是文字）。
   */
  picture?: boolean
  /**
   * 看图的工具在模型不能看图时留在清单里的那份说明和参数：只讲它给的文字，不提图。
   * 没有这一项的看图工具，不能看图时整个不进清单，改列在库函数的索引里。
   */
  textOnly?: { description: string; inputSchema: ObjectSchema }
}

/** 没人说“单个工具结果上限”是多少时用的数（和配置的默认值一样）。 */
export const DEFAULT_RESULT_MAX_CHARS = 20_000

export function fail(content: string): ToolResult {
  return { content, isError: true }
}

/** 工具内部用来提前退出的错误：消息会作为 isError 结果回给模型。 */
export class ToolFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolFailure'
  }
}
