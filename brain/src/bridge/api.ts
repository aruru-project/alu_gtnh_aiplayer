// 协议方法的有类型薄封装。不含任何策略：参数原样发出去，结果原样拿回来。

import type {
  BlockInfo,
  BlockPos,
  BotListEntry,
  BotStatus,
  Center,
  ContainerInfo,
  EntityInfo,
  FindMatch,
  ItemFilter,
  ProbeResult,
  ScanResult,
  ServerInfo,
  TaskInfo,
  TaskList,
  TaskSpec,
} from './protocol.ts'

/** BridgeClient 满足这个接口；测试里可以换成假的。 */
export interface Requester {
  request(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<unknown>
}

type Dim = { dim?: number }

export class BridgeApi {
  private readonly requester: Requester

  constructor(requester: Requester) {
    this.requester = requester
  }

  private call<T>(method: string, params: object = {}): Promise<T> {
    return this.requester.request(method, { ...params }) as Promise<T>
  }

  // 服务器与世界（只读）
  serverInfo(): Promise<ServerInfo> {
    return this.call('server.info')
  }
  worldBlock(p: Dim & BlockPos): Promise<BlockInfo> {
    return this.call('world.block', p)
  }
  worldScan(p: Dim & { x1: number; z1: number; x2: number; z2: number }): Promise<ScanResult> {
    return this.call('world.scan', p)
  }
  worldFind(center: Center, p: { blocks: string[]; radius?: number; limit?: number }): Promise<{ matches?: FindMatch[]; total?: number }> {
    return this.call('world.find', { ...center, ...p })
  }
  worldContainers(center: Center, p: { radius?: number } = {}): Promise<{ containers?: ContainerInfo[]; total?: number }> {
    return this.call('world.containers', { ...center, ...p })
  }
  worldEntities(center: Center, p: { radius?: number } = {}): Promise<{ entities?: EntityInfo[]; total?: number }> {
    return this.call('world.entities', { ...center, ...p })
  }

  // bot 生命周期
  botList(): Promise<{ bots?: BotListEntry[] }> {
    return this.call('bot.list')
  }
  botSpawn(p: { name: string; dim?: number; x?: number; y?: number; z?: number }): Promise<BotStatus> {
    return this.call('bot.spawn', p)
  }
  botDespawn(bot: string): Promise<Record<string, never>> {
    return this.call('bot.despawn', { bot })
  }
  /** 忘掉一个离线的 bot（玩家存档不删）。 */
  botRemove(bot: string): Promise<Record<string, never>> {
    return this.call('bot.remove', { bot })
  }
  botStatus(bot: string): Promise<BotStatus> {
    return this.call('bot.status', { bot })
  }
  botConfigure(bot: string, settings: Record<string, unknown>): Promise<{ settings?: Record<string, unknown> }> {
    return this.call('bot.configure', { bot, settings })
  }
  botChat(bot: string, message: string): Promise<Record<string, never>> {
    return this.call('bot.chat', { bot, message })
  }
  botCommand(bot: string, command: string): Promise<{ output?: string[] }> {
    return this.call('bot.command', { bot, command })
  }
  botLook(bot: string, pos: BlockPos): Promise<Record<string, never>> {
    return this.call('bot.look', { bot, ...pos })
  }
  botDrop(bot: string, what: { items: ItemFilter[] } | { all: true }): Promise<{ dropped?: number }> {
    return this.call('bot.drop', { bot, ...what })
  }
  botProbe(bot: string, pos: BlockPos): Promise<ProbeResult> {
    return this.call('bot.probe', { bot, ...pos })
  }

  // 任务
  /** replaced：replace 模式下被它取消的任务 id。 */
  taskStart(bot: string, task: TaskSpec, mode: 'replace' | 'append' = 'replace'): Promise<{ task: TaskInfo; replaced?: string[] }> {
    return this.call('task.start', { bot, task, mode })
  }
  /** ids：被取消的任务 id。 */
  taskCancel(bot: string, id?: string): Promise<{ canceled?: number; ids?: string[] }> {
    return this.call('task.cancel', id === undefined ? { bot } : { bot, id })
  }
  taskList(bot: string): Promise<TaskList> {
    return this.call('task.list', { bot })
  }
}
