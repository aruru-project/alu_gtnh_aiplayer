import type { BridgeApi } from '../bridge/api.ts'
import type { TaskInfo } from '../bridge/protocol.ts'
import type { Manual } from '../store/manuals.ts'
import type { ObjectSchema } from './schema.ts'

export interface ToolResult {
  content: string
  isError?: boolean
  /** 这段内容要整段给模型，不按“单个工具结果上限”截断（手册：截掉一半的手册比没有还糟）。 */
  keepWhole?: boolean
}

/** 工具需要的手册接口（store/manuals.ts 的 ManualStore 满足）。 */
export interface ManualAccess {
  list(): Manual[]
  get(name: string): Manual | undefined
}

/** 工具需要的记忆接口（store/memory.ts 的 MemoryStore 满足）。 */
export interface MemoryAccess {
  set(key: string, text: string): void
  delete(key: string): boolean
  totalChars(): number
}

export interface ReminderAccess {
  /** 登记一个提醒，返回到点时间（epoch ms）。 */
  add(dueAt: number, note: string): { id: string; dueAt: number }
}

/** 工具执行时通知上层的钩子。工具自己不做任何决定。 */
export interface ToolHooks {
  /** bot 在公共聊天或私聊里说了话。 */
  spoke?(info: { kind: 'say' | 'whisper'; to?: string; text: string }): void
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
}

export interface ToolContext {
  botName: string
  bridge: BridgeApi
  memory: MemoryAccess
  reminders: ReminderAccess
  manuals: ManualAccess
  hooks: ToolHooks
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
}

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
