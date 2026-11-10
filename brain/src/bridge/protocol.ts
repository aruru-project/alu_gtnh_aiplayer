// docs/PROTOCOL.md（版本 1）里的数据形状。
// 协议要求双方忽略不认识的字段，而且身体那边还在开发，所以这里的字段大多按“可能缺”来用。

export const PROTOCOL_VERSION = 1
export const MAX_LINE_BYTES = 4 * 1024 * 1024

export interface BlockPos {
  x: number
  y: number
  z: number
}

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface Item {
  id: string
  meta?: number
  count: number
  /** 服务器语言下的显示名，只给人和模型看，不用于匹配。 */
  name?: string
}

export interface InventoryItem extends Item {
  slot: number
  /** 剩余耐久比例，仅工具有。 */
  durability?: number
}

export interface ItemFilter {
  id: string
  meta?: number
  count?: number
}

export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'canceled'

export interface TaskInfo {
  id: string
  type: string
  /** 启动时给的参数（真实 mod 会把 type 也放在里面）。 */
  params?: Record<string, unknown>
  /** task.start 的响应里总是 queued，即使它马上就开始；真正开始时另有一个 running 的 task.update。 */
  state: TaskState
  progress?: { done?: number; total?: number; phase?: string; note?: string }
  createdAt?: number
  startedAt?: number
  finishedAt?: number
  /**
   * 已经做成的部分；运行中、失败、取消时也有。已知的字段：
   * - 区域任务（dig / place / clear / fill / flatten）：removed、placed、skipped（{原因: 数量}）、
   *   skippedExamples（[{x,y,z,reason}]）、freeSlots；flatten 另有 level，clear 另有 clearedDownTo；
   *   climbingBlocksLeftStanding 是为了够到高处垫的、结束时没能拆掉的方块数
   * - deposit：moved、freeSlots；withdraw：moved、missing（[{id,meta?,count}]，箱子里不够的部分。
   *   注意东西不够时任务照样是 done）；haul：moved、trips；collect：pickedUpStacks；give：dropped
   * - 移动类：block（{x,y,z}），home 另有 dim
   */
  result?: Record<string, unknown>
  /**
   * 失败码和 detail：unreachable（走不到，或比步行上限 256 格还远；可能有 x y z）、stuck、
   * no_tool（block、x y z）、no_material（missing，item 或 items）、inventory_full、container_full、
   * denied（领地保护等：挖不动、放不下、箱子打不开；可能有 block、x y z）、
   * invalid（参数不合法，或服务器拒绝了指令，比如不存在的 home）、
   * interrupted（下线、死亡、被带到别的维度）、internal。
   *
   * 实测的一个现象：任务在开始的那一刻就失败时（比如目标太远），身体会连发两次 failed 的 task.update，
   * 第一次没有 finishedAt。
   */
  error?: { code: string; message?: string; detail?: Record<string, unknown> }
}

export interface BotStatus {
  name: string
  uuid?: string
  online: boolean
  dim?: number
  pos?: Vec3
  block?: BlockPos
  yaw?: number
  pitch?: number
  onGround?: boolean
  inWater?: boolean
  health?: number
  maxHealth?: number
  food?: number
  xpLevel?: number
  heldSlot?: number
  held?: Item | null
  inventory?: InventoryItem[]
  armor?: (Item | null)[]
  freeSlots?: number
  task?: TaskInfo | null
  queue?: TaskInfo[]
  settings?: Record<string, unknown>
}

export interface PlayerInfo {
  name: string
  uuid?: string
  dim?: number
  pos?: Vec3
  isBot?: boolean
}

export interface ServerInfo {
  tick?: number
  tps?: number
  tickMs?: number
  worldTime?: number
  dayTime?: number
  isDay?: boolean
  raining?: boolean
  difficulty?: string | number
  players?: PlayerInfo[]
  bots?: string[]
}

export interface BlockInfo {
  /** 区块没加载时只有 loaded:false（和坐标），其余字段都没有。 */
  loaded?: boolean
  id?: string
  meta?: number
  name?: string
  air?: boolean
  solid?: boolean
  liquid?: boolean
  replaceable?: boolean
  hardness?: number
  tileEntity?: boolean
  inventory?: boolean
}

export interface ScanResult {
  x1: number
  z1: number
  x2: number
  z2: number
  /** heights[z-z1][x-x1]：该列最高的非空气、非植物方块的 y；没有则 -1 */
  heights: number[][]
  /** 同形状，值是 palette 下标 */
  tops?: number[][]
  palette?: string[]
  /** palette 里哪些下标是液体。 */
  liquidPalette?: number[]
  stats?: { minY?: number; maxY?: number; modeY?: number; meanY?: number; columns?: number; unloaded?: number }
  liquidColumns?: number
  tileEntities?: { x: number; y: number; z: number; id: string }[]
}

export interface FindMatch {
  x: number
  y: number
  z: number
  id: string
  meta?: number
  dist?: number
}

export interface ContainerInfo {
  x: number
  y: number
  z: number
  id: string
  name?: string
  slots?: number
  usedSlots?: number
  items?: Item[]
}

export interface EntityInfo {
  type: 'player' | 'mob' | 'animal' | 'item' | 'other' | (string & {})
  name?: string
  pos?: Vec3
  dist?: number
  item?: Item
}

export interface BotListEntry {
  name: string
  online: boolean
  dim?: number
  block?: BlockPos
  task?: TaskInfo | null
}

export interface TaskList {
  active?: TaskInfo | null
  queue?: TaskInfo[]
  /** 最近结束的 10 个，新的在前。 */
  recent?: TaskInfo[]
}

/** world.find / world.containers / world.entities 的中心：一个坐标，或者“某个 bot 站的位置”。 */
export type Center = (BlockPos & { dim?: number }) | { bot: string }

/** bot.probe：world.block 的内容，加上“它现在能不能挖、用哪件工具、要多久”。 */
export interface ProbeResult extends BlockInfo {
  canDig?: boolean
  digTicks?: number
  /** 会用的那件工具所在的格子；-1 是空手。 */
  toolSlot?: number
  inReach?: boolean
  /** excluded：一次挖多格的工具（配置 excludedTools），身体不会用。 */
  candidates?: { slot: number; item: string; harvest?: boolean; strength?: number; ticks?: number; excluded?: boolean }[]
}

/** task.start 的 task 字段：type 加上该类型自己的参数。 */
export type TaskSpec = { type: string } & Record<string, unknown>

export interface HelloResult {
  protocol: number
  modVersion?: string
  mcVersion?: string
  serverEpoch: string
  seq: number
}

export interface BridgeEvent {
  event: string
  /** 一个 serverEpoch 内单调递增；个别事件可能没有。 */
  seq?: number
  /** epoch ms */
  time?: number
  data: Record<string, unknown>
}

/** 协议里的错误码，加上客户端自己产生的两个。 */
export type BridgeErrorCode =
  | 'unauthorized'
  | 'bad_request'
  | 'unknown_method'
  | 'not_found'
  | 'offline'
  | 'denied'
  | 'too_large'
  | 'internal'
  | 'timeout' // 客户端：等响应超时
  | 'disconnected' // 客户端：没连上，或等响应时断了
  | (string & {})

export class BridgeError extends Error {
  code: BridgeErrorCode

  constructor(code: BridgeErrorCode, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}
