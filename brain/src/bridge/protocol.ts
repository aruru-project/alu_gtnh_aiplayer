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
   * - craft：crafted（多出来的个数）、item（{id,meta,name}）、freeSlots
   * - process：put（放进机器的个数）、outputs（[{id,meta,name,count}]，取回来的东西，含没被消耗的电路、模具和没用完的原料）、
   *   timedOut（等到 wait 还没做完）、freeSlots
   * - blueprint：区域任务的那几项，加上 needsClimbingBlocks；任务结束时（成功或失败）另有 now
   *   （{cells,done,toPlace,byHand,blocked,extra,unloaded?}，世界和图纸的对比）和各最多 8 项的
   *   materials（还缺的）、byHandBlocks、blockedBy、extraBlocks，形状同 BlueprintCheck 里的同名字段
   */
  result?: Record<string, unknown>
  /**
   * 失败码和 detail：unreachable（走不到，或比步行上限 256 格还远；可能有 x y z）、stuck、
   * no_tool（block、x y z）、no_material（missing，item 或 items；blueprint 任务的 missing 是
   * [{id,meta,name,count}]，每种缺多少，可能另有 supplyProblem）、inventory_full、container_full、
   * denied（领地保护等：挖不动、放不下、箱子打不开；可能有 block、x y z）、
   * invalid（参数不合法，或服务器拒绝了指令，比如不存在的 home）、
   * interrupted（下线、死亡、被带到别的维度）、internal、busy（配方索引还在建）。
   * craft 任务以 no_material 失败时 missing 是 [RecipeIngredient]（每样还差多少，没有 have）。
   * process 任务以 invalid 失败（机器没收原料、没开工）时 detail 是那台机器的状态（MachineInfo）。
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
  /** 抽屉（Storage Drawers）是 "drawers"：items 的 count 是抽屉里真实的数量，slots 是抽屉格数。普通箱子没有这一项。 */
  kind?: 'drawers' | (string & {})
}

// ── 物品、配方、库存 ──

/** item.search 的一项。recipes 是这个物品各类配方的条数；ores 是它登记在哪些矿辞名下。 */
export interface ItemSearchHit {
  id: string
  meta?: number
  name?: string
  recipes?: { crafting?: number; machine?: number; smelting?: number }
  ores?: string[]
}

/**
 * 合成配方里的一样原料：要么是一种确定的物品（id，meta 缺省表示任何变体都行），
 * 要么是一个矿辞名（ore，任何登记在这个名字下的物品都行，example 是其中一种）；
 * 个别配方是一组没有矿辞名的可替换物品，这时只有 example 和 alternatives。
 */
export interface RecipeIngredient {
  count: number
  /** 英文显示名；矿辞的写成 “Steel Screw (any screwSteel)”。 */
  name?: string
  id?: string
  meta?: number
  ore?: string
  example?: { id: string; meta?: number }
  /** 有几种物品都行（多于一种时才有）。 */
  alternatives?: number
  /** 锤子、扳手、锉刀这类：做的时候要带着，只磨损不消耗。 */
  tool?: boolean
  /** recipe.find 给了 bot 时，它身上现有的数量。 */
  have?: number
}

export interface CraftingRecipe {
  /** craft 任务的 recipe 参数。 */
  index: number
  /** 做一次出几个。 */
  gives?: number
  /** "2x2" 的不需要工作台。 */
  grid?: '2x2' | '3x3' | (string & {})
  ingredients?: RecipeIngredient[]
  /** 某些 mod 自己的配方类型读不出原料；这种配方 craft 做不了。 */
  unreadable?: boolean
}

export interface MachineRecipeItem extends Item {
  /** 要放在机器里但不消耗（编程电路、模具）。 */
  notConsumed?: boolean
}

export interface MachineRecipe {
  machine: string
  /** 按 eut 算出的最低机器等级。 */
  tier?: string
  eut?: number
  seconds?: number
  inputs?: MachineRecipeItem[]
  fluidInputs?: { name: string; mb: number }[]
  outputs?: Item[]
  fluidOutputs?: { name: string; mb: number }[]
}

export interface RecipeFindResult {
  item?: { id: string; meta?: number; name?: string }
  crafting?: CraftingRecipe[]
  machines?: MachineRecipe[]
  /** 每种机器有几条配方（列出来的只是其中几条）。 */
  machineRecipeCounts?: Record<string, number>
  smeltedFrom?: Item[]
  total?: { crafting?: number; machines?: number; smelting?: number }
}

/**
 * world.machines 的一台 GregTech 单方块加工机器。读不出状态的只有坐标、名字和 unreadable。
 * recipes 是它跑哪种配方，和 recipe.find 里机器配方的 machine 同名（如 Lathe）。
 */
export interface MachineInfo {
  x: number
  y: number
  z: number
  name?: string
  recipes?: string
  /** 机器的等级；要不低于配方的 tier。 */
  tier?: string
  inputSlots?: number
  /** 正在加工。 */
  active?: boolean
  progress?: number
  maxProgress?: number
  /** 为 0 就是没电。 */
  storedEU?: number
  inputVoltage?: number
  /** 被人关掉了（软锤敲过，或者盖板控制着）。 */
  switchedOff?: boolean
  unreadable?: boolean
  dist?: number
}

/** world.stock 要找的一样东西：一种物品（可以不限 meta），或者一个矿辞名。 */
export type StockQuery = { id: string; meta?: number } | { ore: string }

export interface StockPlace {
  x: number
  y: number
  z: number
  /** 容器的显示名。 */
  container?: string
  kind?: 'drawers' | (string & {})
  count: number
  /** 按矿辞名或不带 meta 查时：这一处具体是哪几种（可以直接拿去 withdraw）。 */
  items?: Item[]
}

export interface StockResult {
  items?: {
    id?: string
    meta?: number
    ore?: string
    total: number
    /** 数量多的在前，最多 6 处。 */
    places?: StockPlace[]
    morePlaces?: number
  }[]
  containersLookedInto?: number
}

// ── 任务书（BetterQuesting，只读）──

/** quest.lines 的一章。complete / available 只在给了 player 时有。 */
export interface QuestLine {
  name: string
  quests: number
  complete?: number
  available?: number
}

/** 任务的状态（给了 player 才有）：available 是已解锁未完成，locked 是前置没完成。 */
export type QuestState = 'available' | 'locked' | 'complete' | 'complete, reward unclaimed' | (string & {})

/** quest.search 的一项。id 是任务书自己的编号：老任务是一小段十六进制数，新任务是完整的 UUID。 */
export interface QuestHit {
  id: string
  name: string
  line?: string
  state?: QuestState
}

/** 任务要的或奖励的一样物品。任务书里存的东西不一定齐全：id、meta、名字都可能缺；ore 是可以用矿辞代替。 */
export interface QuestItem {
  id?: string
  meta?: number
  count: number
  name?: string
  ore?: string
}

export interface QuestTask {
  /** crafting、retrieval、optional_retrieval、hunt、location、fluid…… */
  type: string
  complete?: boolean
  items?: QuestItem[]
  /** 交任务时物品会不会被收走。 */
  consumed?: boolean
  fluids?: { fluid: string; mb: number }[]
  /** 猎杀类：要打的生物和个数。 */
  target?: string
  count?: number
  location?: { x: number; y: number; z: number; dim?: number }
}

export interface QuestDetail {
  id: string
  name: string
  line?: string
  /** 最多 3000 字。 */
  description?: string
  state?: QuestState
  requires?: { id: string; name: string; complete?: boolean }[]
  tasks?: QuestTask[]
  rewards?: { type: string; items?: QuestItem[] }[]
}

// ── 图纸 ──

/** blueprint.list 的一项：读得了的有 size 和 blocks，读不了的只有 error。 */
export interface BlueprintEntry {
  name: string
  size?: { x: number; y: number; z: number }
  /** 图纸里有方块的格子数。 */
  blocks?: number
  error?: string
}

/** blueprint.check 和 blueprint 任务共用的参数：图纸放在哪、只处理哪一部分、哪些方块管不管、允许挖什么。 */
export interface BlueprintPlacement {
  name: string
  x: number
  y: number
  z: number
  x1?: number
  x2?: number
  y1?: number
  y2?: number
  z1?: number
  z2?: number
  only?: string[]
  skip?: string[]
  clear?: string[]
}

/** 要放的一种方块。have 只在 blueprint.check 带了 bot 时有。 */
export interface BlueprintMaterial {
  id: string
  meta?: number
  name?: string
  need: number
  have?: number
}

/** 得由人来放的一种方块。 */
export interface BlueprintByHand {
  id: string
  meta?: number
  name?: string
  count: number
  why?: string
}

/** 世界里挡着图纸、或者多出来的一种方块。 */
export interface BlueprintObstacle {
  id: string
  name?: string
  count: number
  /** 按现在的 clear 会被挖掉的个数。 */
  removable?: number
  /** 带数据（机器、箱子）谁也不会动的个数。 */
  holdsData?: number
  natural?: boolean
}

export interface BlueprintCheck {
  name?: string
  origin?: BlockPos
  /** 实际对比的范围。 */
  box?: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }
  cells?: number
  done?: number
  toPlace?: number
  byHand?: number
  blocked?: number
  extra?: number
  willRemove?: number
  /** 所在区块没加载、看不到的格子；为 0 时省略。不为 0 时结果不完整。 */
  unloaded?: number
  materials?: BlueprintMaterial[]
  byHandBlocks?: BlueprintByHand[]
  blockedBy?: BlueprintObstacle[]
  extraBlocks?: BlueprintObstacle[]
  /** 每层 [y, 图纸方块数, done, toPlace, blocked, extra]。 */
  layers?: number[][]
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
  | 'busy' // 配方索引还在建（服务器刚启动），过几秒再试
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
