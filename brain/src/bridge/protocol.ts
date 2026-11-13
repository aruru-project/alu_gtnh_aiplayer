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
   * - use：used（拿在手里用的那件东西的名字）、gained / lost（[{id,meta,name,count}]，背包里多了、少了什么）、
   *   openedScreen（右键打开了界面，已经关掉）、health、food、freeSlots
   * - blueprint：区域任务的那几项，加上 needsClimbingBlocks；任务结束时（成功或失败）另有 now
   *   （{cells,done,toPlace,byHand,blocked,extra,unloaded?}，世界和图纸的对比）和各最多 8 项的
   *   materials（还缺的）、byHandBlocks、blockedBy、extraBlocks，形状同 BlueprintCheck 里的同名字段
   */
  result?: Record<string, unknown>
  /**
   * 失败码和 detail：unreachable（走不到，或比步行上限 256 格还远；可能有 x y z）、stuck、
   * no_tool（block、x y z）、no_material（missing，item 或 items；blueprint 任务的 missing 是
   * [{id,meta,name,count}]，每种缺多少，可能另有 supplyProblem）、inventory_full、container_full、
   * denied（服务器的出生点保护、领地或别的 mod 拒绝了：挖不动、放不下、箱子打不开；可能有 block、x y z，
   * 是服务器自己的保护时有 protection，见 Protection）、
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
  /** 穿在盔甲格以外的地方的东西（探险背包 mod 的背上那一格），没有就不带。 */
  worn?: WornItem[]
  /** 脚离下面第一个挡得住人的方块（或液面）多高；站在地上是 0，下面 256 格内什么都没有、或者没加载时不带。 */
  aboveGround?: number
  /** 上一个 tick 实际移动了多少（格，一秒 20 tick）：站着、悬停时是 0。 */
  motion?: Vec3
  freeSlots?: number
  task?: TaskInfo | null
  queue?: TaskInfo[]
  settings?: Record<string, unknown>
}

/** 穿在盔甲格以外的一件东西：在哪（slot，如 "back"）、是什么、它给玩家看的罐（油量这类）、它自己存的数据（原样）。 */
export interface WornItem extends Item {
  slot: string
  tanks?: Tank[]
  /** 这件东西自己存的数据（NBT），键是那个 mod 起的名字，值原样；太长的地方截了时带 dataCut。 */
  data?: unknown
  dataCut?: boolean
}

/** bot.keys 的一项：一个 mod 加的、按下去会传到服务器的键。key 是游戏自己给这个键起的名字。 */
export interface KeyInfo {
  key: string
  /** 游戏的“控制”设置里它叫什么（英文）。 */
  name?: string
  /** 它在“控制”设置里属于哪一组（哪个 mod）。 */
  category?: string
}

/**
 * 只在 mod 的客户端里画的界面，身体不替它画（服务器上没有这个界面，打不开）：它是什么、客户端里用哪件物品右键 / 哪个键打开、
 * 它的按钮做的事由哪些协议方法做。bot.keys 的 clientOnly 列出有键的；screen.open 拿着那件物品时在结果里带上。
 */
export interface ClientOnlyScreen {
  screen: string
  item?: { id: string }
  key?: string
  keyName?: string
  /** 做它的按钮做的事的协议方法（quest.submit……）。 */
  instead?: string[]
  /** screen.open 带的：身体说的那句话（英文）。 */
  text?: string
}

/**
 * bot.key 的结果：按下以后看得出的变化。screen：按完之后开着的界面（或者按之前开着、按完关了的那个），
 * changed：穿着的东西自己存的数据里变了的值（key 是 slot 之下的路径；key 为空串是那件东西本身换了），
 * said：这一下让游戏对它说的话（那个 mod 在客户端打印的也算）。什么都没变时只有 key。
 */
export interface KeyPressResult {
  key: string
  screen?: ScreenState
  changed?: { slot: string; key: string; was?: string; now?: string }[]
  said?: string[]
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
  covers?: Cover[]
  tanks?: Tank[]
  // ── 下面是 world.block 带 detail:true（或 path）时才有的：这个方块自己知道的全部，不按种类做任何假设 ──
  /** 没有自己数据的方块（普通方块）：一句说明。 */
  detail?: string
  /** 它的方块实体是哪个类。 */
  class?: string
  /** 它对扫描器自报的那几行话（GregTech 的机器有）。 */
  says?: string[]
  /** 它存档里的全部数据：键是它自己起的内部名字，值是原样的；物品换成了 {item, meta, count, name, …}。 */
  saved?: unknown
  /** saved 里有被省略的部分（太深、列表太长、总量太大），省略处写着怎么要。 */
  savedCut?: boolean
  /** 只看了 saved 的这一部分。 */
  path?: string
  /** 那个路径不存在：saved 是顶层的样子。 */
  pathNotFound?: boolean
  savedError?: string
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

/**
 * world.blocks：一个盒子里每一格是什么方块（给简图用）。每边最多 64 格。
 * 格子的顺序是 x 最快，其次 z，最后 y：第 (x, y, z) 格（相对最小角）的下标是 (y * sz + z) * sx + x。
 */
export interface WorldBlocks {
  /** 盒子的最小角。 */
  x: number
  y: number
  z: number
  /** 各边的格数。 */
  sx: number
  sy: number
  sz: number
  /** 0 号永远是空气。没加载的区块里的格子记成 id 为 "?" 的一项。 */
  palette: { id: string; meta?: number }[]
  /** 调色板下标和连续个数交替：[下标, 几格, 下标, 几格, ……]。 */
  runs: number[]
  /** 没加载的区块里的格数。 */
  unloaded?: number
}

export interface FindMatch {
  x: number
  y: number
  z: number
  id: string
  meta?: number
  dist?: number
}

/** 紧挨着一个容器、会自己往里送或往外抽东西的方块（漏斗、管道）。 */
export interface AttachedBlock {
  x: number
  y: number
  z: number
  name?: string
  /** hopper、item pipe、fluid pipe、pipe（其他 mod 的管道类）。 */
  kind?: string
}

/**
 * 机器、管道某个面上的一块覆盖板（GregTech）。能装东西的（槽位扩展）带 slots / items：这些东西不在机器自己的格子里，
 * 要蹲着右键那个面、打开覆盖板自己的界面才拿得到。
 */
export interface Cover {
  /** 在哪个面：down / up / north / south / west / east。 */
  side: string
  id?: string
  meta?: number
  name?: string
  /** 蹲着右键这个面会打开它自己的界面。 */
  screen?: boolean
  slots?: number
  usedSlots?: number
  items?: Item[]
  moreKinds?: number
}

/** 一个流体罐里现在有什么。空的罐只有容量。有的机器有的罐不对外报，那就不在列表里。 */
export interface Tank {
  /** 流体的注册名（molten.steel），和配方册里的写法一样。 */
  fluid?: string
  name?: string
  amount?: number
  capacity?: number
}

export interface ContainerInfo {
  x: number
  y: number
  z: number
  id: string
  name?: string
  /**
   * GregTech 单方块机器、总线自己的格子：原料格（inputs）、产物格（outputs）各几个、用了几个；总线只有 slots。
   * 编程电路是设置，不占格子（circuit 是现在的号，0 是没有）。slots 是它整个物品栏的大小，还算上了玩家不放东西的格子。
   */
  machineSlots?: { inputs?: number; inputsUsed?: number; outputs?: number; outputsUsed?: number; slots?: number; slotsUsed?: number; circuit?: number }
  slots?: number
  usedSlots?: number
  /** 按物品合并，最多列 world.containers 的 kinds 种（默认 60）；还有没列的时带 moreKinds。 */
  items?: Item[]
  moreKinds?: number
  /**
   * 没有：普通容器。"drawers"：抽屉（Storage Drawers），items 的 count 是抽屉里真实的数量，slots 是抽屉格数。
   * "drawer_controller"：抽屉管理器，自己不装东西，drawers 是它管着几个抽屉方块。"machine"：GregTech 机器。
   */
  kind?: 'drawers' | 'drawer_controller' | 'machine' | (string & {})
  drawers?: number
  /** 有这一项的容器多半是自动化的一环：往里放的东西可能马上被抽走。 */
  attached?: AttachedBlock[]
  /** 抽屉：管着它的抽屉管理器。 */
  controller?: BlockPos
  /** 它各个面上的覆盖板，和能装东西的覆盖板里装着什么。 */
  covers?: Cover[]
  /** 它的流体罐里现在有什么。 */
  tanks?: Tank[]
}

/** world.drawers 里的一格。 */
export interface DrawerSlot {
  x: number
  y: number
  z: number
  slot: number
  /** 没指定物品的空格。 */
  empty?: boolean
  id?: string
  meta?: number
  name?: string
  count?: number
  /** 还放得下多少。 */
  room?: number
  /** 这个抽屉的正面朝哪（down/up/north/south/west/east）：玩家点这一格时点的面，可以原样交给 use 任务的 side。 */
  front?: string
  /** 点这一格时点在方块里的哪一点（各 0–1），可以原样交给 use 任务的 hit。 */
  hit?: { x: number; y: number; z: number }
}

export interface DrawersResult {
  controller?: BlockPos
  /** 抽屉方块数。 */
  drawers?: number
  slotsTotal?: number
  slotsUsed?: number
  slots?: DrawerSlot[]
  /** 符合条件的格数；slots 是其中从 offset 起的一页。 */
  total?: number
  offset?: number
}

/** 一个玩家站在哪、朝哪看、指着什么（world.player 的结果，也是 chat / whisper 事件里的 speaker）。 */
export interface PlayerView {
  dim?: number
  pos?: Vec3
  block?: BlockPos
  yaw?: number
  pitch?: number
  /** north / south / east / west；抬头或低头超过 60 度时是 up / down。 */
  facing?: string
  /** 准星指着的方块，48 格内。 */
  lookingAt?: SeenBlock & { side?: string }
  /** 面前 12 格内、视野中央的容器，最正对、最近的在前，最多 6 个。 */
  ahead?: SeenBlock[]
}

export interface SeenBlock {
  x: number
  y: number
  z: number
  id?: string
  meta?: number
  name?: string
  /** container、drawers、drawer_controller、machine；都不是就不带。 */
  kind?: string
  dist?: number
  attached?: AttachedBlock[]
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
  /** 矿辞登记的合成工具提示，不保证不消耗或耐久够做完整批。 */
  tool?: boolean
  /** 身上某个匹配物声明有合成返还；可能磨损、变成别的物品或损坏消失。 */
  containerItem?: boolean
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

/** 多方块机器的一个总线或仓。 */
export interface MachineHatch {
  x: number
  y: number
  z: number
  name?: string
  kind?: string
  slots?: number
  usedSlots?: number
  /** 输入总线上设的编程电路。 */
  circuit?: number
  attached?: AttachedBlock[]
  /** 输出总线不留东西时，东西会到这些箱子里。 */
  passesTo?: { x: number; y: number; z: number; name?: string }[]
  capacity?: number
  fluid?: string
  fluidName?: string
  amount?: number
}

/**
 * world.machines 的一台 GregTech 加工机器：单方块的，或者多方块机器的主机（kind 为 "multiblock"）。
 * 读不出状态的只有坐标、名字和 unreadable。
 * id + meta 是这台机器作为物品时的那一对，和配方册里配方页的 machines 可以直接比对；recipeKey 是它跑的配方在配方册里的页。
 */
/** 打开着的界面里的一格（screen.look）。 */
export interface ScreenSlot {
  /** 点击用的编号。 */
  slot: number
  /** bot 自己背包里的格子（自己的空格不列）。 */
  own?: boolean
  item?: Item
  /** 界面把它画在哪（从界面左上角数的像素）：玩家靠位置读一个界面（一行里的模具格、材料格、产物格）。自己摆格子的界面（GregTech 的）没有。 */
  x?: number
  y?: number
  /** 这一格在代码里是哪一种格子（类名，如 SlotPattern、SlotOnlyTake）；普通的格子不带。 */
  class?: string
  /** 放不进东西的格子：机器出产物的地方。 */
  takesNothing?: boolean
  /** 只收某些东西的空格子（燃料格、装流体的格子、工具格、模具格）：bot 身上的东西里它收的那几种（可能一种都没有）。 */
  takes?: { id: string; meta?: number; name?: string }[]
  /** takes 是空的时候：游戏的物品表里它收的几样（最多 4 样，各取 meta 0），说明它收的是哪一类东西。 */
  accepts?: { id: string; meta?: number; name?: string }[]
  /** 只显示、里面没有真东西的格子（编程电路的设置）。 */
  ghost?: boolean
  /** GregTech 机器、总线的界面：这一格在机器自己的格子里是第几个。 */
  index?: number
  /** 这一格是干什么的：input 原料格、output 产物格、special 特殊格（模具、数据棒）、battery 电池格、circuit 编程电路；别的不带。 */
  role?: 'input' | 'output' | 'special' | 'battery' | 'circuit' | (string & {})
}

/**
 * 界面上格子以外的一样东西（screen.look 的 controls）：开关、数字、文字、选项、能再打开的面板（页签）、流体格、按钮。
 * 名字（panel、key）是界面自己起的，身体不知道任何一个是干什么的。readOnly 的只是显示，不收玩家的改动。
 */
export interface ScreenControl {
  /** 它在哪个面板上（界面自己的名字）。只在 key 重名时才需要用它区分。 */
  panel?: string
  /** 它的名字，如 fluidAutoOutput:0；冒号前的那一段不重名时可以单独用。 */
  key: string
  /** switch / number / text / choice / panel / fluid / button / circuit（GregTech 的编程电路设置，value 0 是没有）/ value（只是显示）/ other。 */
  kind: 'switch' | 'number' | 'text' | 'choice' | 'panel' | 'fluid' | 'button' | 'circuit' | 'value' | 'other' | (string & {})
  /** 开关、数字、文字、选项现在的值。 */
  value?: unknown
  /** 选项：能选的那几个。 */
  options?: string[]
  /** 面板：现在开着没有。打开以后它的格子出现在 slots 里。 */
  open?: boolean
  readOnly?: boolean
  /** 流体格：里面是什么、多少、能装多少；玩家拿着容器点它时能不能往里倒（fills）、能不能从里面取（drains）；phantom 是只做设置用的假格子。 */
  fluid?: string
  name?: string
  amount?: number
  capacity?: number
  fills?: boolean
  drains?: boolean
  phantom?: boolean
  /** value / other：它在界面里是哪一类东西。 */
  type?: string
  unreadable?: boolean
  /** 只在 mod 的客户端里画出来的按钮：鼠标移上去时它写着什么（英文）。 */
  label?: string
}

/** screen.open / look / click / press / set 的结果：做完之后界面的样子。有的界面点开后过一小会儿才出现，那时 open 是 false。 */
export interface ScreenState {
  open?: boolean
  screen?: string
  slotCount?: number
  slots?: ScreenSlot[]
  /** 鼠标上拿着的东西。 */
  cursor?: Item
  /** 界面上格子以外的东西；这个界面没有（不是 ModularUI 2 做的）就不带。 */
  controls?: ScreenControl[]
  /** screen.open 拿着的那件东西的界面只在客户端里画（任务书）：永远不会出现，不用再等。 */
  clientOnly?: ClientOnlyScreen
}

export interface MachineInfo {
  x: number
  y: number
  z: number
  name?: string
  /** 烧蒸汽、不烧电的机器。身体现在还不给这一项（大脑先按名字认）；给了以它为准。 */
  steam?: boolean
  id?: string
  meta?: number
  /** 它跑哪种配方（英文，如 Lathe）。 */
  recipes?: string
  recipeKey?: string
  /** 现在设的编程电路。 */
  circuit?: number
  kind?: 'multiblock' | (string & {})
  /** 多方块：结构完整。false 时用不了。 */
  formed?: boolean
  /** 高炉一类：线圈给的炉温，配方的 special 不能超过它。 */
  heat?: number
  /** 多方块没在干活时，机器界面上说的原因（英文）。 */
  idleReason?: string
  inputBuses?: MachineHatch[]
  outputBuses?: MachineHatch[]
  inputHatches?: MachineHatch[]
  outputHatches?: MachineHatch[]
  /** 机器的等级；要不低于配方的 tier。 */
  tier?: string
  /** 单方块机器的原料格、产物格各几个（编程电路是设置，不占原料格）。 */
  inputSlots?: number
  outputSlots?: number
  /** 正在加工。 */
  active?: boolean
  progress?: number
  maxProgress?: number
  /** 为 0 就是没电。 */
  storedEU?: number
  inputVoltage?: number
  /** 被人关掉了（软锤敲过，或者盖板控制着）。 */
  switchedOff?: boolean
  /** 单方块机器界面上的自动输出开着时：物品、流体各开没开，从哪个面推出去、那一面挨着什么。 */
  autoOutput?: AutoOutput
  unreadable?: boolean
  dist?: number
  /** 它各个面上的覆盖板（模具常放在“槽位扩展”这种覆盖板里）。 */
  covers?: Cover[]
  /** 它的流体罐里现在有什么（单方块机器的输入罐、输出罐）。没有这一项：这台机器的罐读不到。 */
  tanks?: Tank[]
}

/**
 * 单方块机器自己的自动输出（界面上那两个开关）：开着的那几样，做出来就从输出面推给挨着的方块。
 * side 是输出面；outputFaceIsFront 时输出面就是它的正面，什么都推不出去。
 */
export interface AutoOutput {
  items?: boolean
  fluids?: boolean
  side?: string
  outputFaceIsFront?: boolean
  to?: { x: number; y: number; z: number; name?: string }
}

/** world.stock 要找的一样东西：一种物品（可以不限 meta），或者一个矿辞名。 */
export type StockQuery = { id: string; meta?: number } | { ore: string }

export interface StockPlace {
  x: number
  y: number
  z: number
  /** 容器的显示名。 */
  container?: string
  /** "cover"：东西在这个方块某个面的覆盖板里（cover 是覆盖板的名字，side 是哪个面），不在它自己的格子里。 */
  kind?: 'drawers' | 'cover' | (string & {})
  cover?: string
  side?: string
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
  /** 给了 player 才有：这个子任务记着的数（每样物品 / 流体交了或数到几个；猎杀、经验是一个数）；不计数的子任务没有。 */
  progress?: number[] | number
  /** 给了 player 才有：可做可不做，不影响任务完成。 */
  optional?: boolean
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
  /** chosen：给了 player 时，挑一样的奖励他现在选的是第几样（从 0 数；没选不带）。 */
  rewards?: { type: string; items?: QuestItem[]; chosen?: number }[]
  /** 给了 player、而且他在线时：任务界面上两个按钮在他的客户端里能不能按（检测/提交、领取）。 */
  buttons?: { submit?: boolean; claim?: boolean }
  /** 给了 player、而且他在队伍里时。 */
  party?: QuestParty
}

/** 一个玩家的任务书队伍：队名、队员。队伍里打勾、交东西算全队；claimForAll 时领一次奖励全队都算领过。 */
export interface QuestParty {
  name?: string
  members?: string[]
  claimForAll?: boolean
}

/** 任务书上一样东西的变化：数量是变了多少。 */
export interface QuestPressItem {
  id: string
  meta?: number
  name?: string
  count: number
}

/**
 * quest.submit / quest.check / quest.choose / quest.claim 的结果：bot 替自己按了任务书上的一个按钮，看得见的变化。
 * pressed:false 是这个按钮在客户端里是灰的（why 是原因），什么都没发。
 */
export interface QuestPressResult {
  pressed: boolean
  button?: string
  why?: string
  quest: { id: string; name: string; state: QuestState; was?: QuestState }
  /** submit、check：每个子任务现在的样子（task 从 0 数，和 quest.get 的顺序一样）；was、progressWas 只在变了时有。 */
  tasks?: { task: number; type: string; complete: boolean; was?: boolean; optional?: boolean; progress?: number[] | number; progressWas?: number[] | number }[]
  /** 子任务都满足了、任务还没标完成：任务书下一次查这个玩家时（每 3 秒）标。 */
  tasksDone?: boolean
  lost?: QuestPressItem[]
  gained?: QuestPressItem[]
  /** 背包放不下、掉在脚边的。 */
  dropped?: QuestPressItem[]
  xp?: { levelWas: number; level: number; pointsWas: number; points: number }
  /** claim：奖励顺带让这些任务也完成了。 */
  alsoComplete?: { id: string; name: string }[]
  /** choose：现在选的是哪个奖励的第几样。 */
  chosen?: { reward: number; choice: number; item?: QuestPressItem }
  /** claim 按不了时：还没选的挑一样的奖励和它的选项。 */
  choices?: { reward: number; items: QuestPressItem[] }[]
  said?: string[]
  party?: QuestParty
  note?: string
  freeSlots?: number
}

/**
 * quest.progress：一个玩家做完了哪些任务，其中哪些有奖励还没领。id 和上面是同一种写法。
 * 玩家从没上过线时 completed 是空的，并带 known:false。
 */
export interface QuestProgress {
  player: string
  completed?: string[]
  /** 已完成、有奖励、还没领的任务（completed 的子集）。 */
  unclaimed?: string[]
  known?: boolean
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

/** blueprint.read 的材料表里的一行：图纸里的一种方块和它的个数。 */
export interface BlueprintKind {
  id: string
  meta?: number
  name?: string
  count?: number
  /** 放它用的物品和方块不同名时才有。 */
  item?: { id: string; meta?: number }
  /** 身体不放、留给人的：原因。 */
  byHand?: string
}

/** blueprint.read：图纸本身的内容，和世界无关。palette + runs 和 world.blocks 同一种写法，是 from..to 这个盒子里的格子。 */
export interface BlueprintContent {
  name?: string
  size?: BlockPos
  blocks?: number
  /** 永远是整张图纸的材料，多的在前。 */
  materials?: BlueprintKind[]
  x?: number
  y?: number
  z?: number
  sx?: number
  sy?: number
  sz?: number
  palette?: BlueprintKind[]
  runs?: number[]
}

/** 要放的一种方块。have 只在 blueprint.check 带了 bot 时有。 */
export interface BlueprintMaterial {
  id: string
  meta?: number
  name?: string
  need: number
  /** 放它用的物品和方块的 meta 不同时（楼梯、台阶、原木按朝向放）：要取、要数的是这一种。 */
  item?: { id: string; meta?: number }
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
  /** Stable identity. Runtime entityId is diagnostic only and must not be used as a persistent target. */
  uuid?: string
  entityId?: number
  dim?: number
  kind?: string
  motion?: Vec3
  state?: Record<string, unknown>
  saved?: unknown
  savedCut?: boolean
  savedError?: string
  savedUnavailable?: string
  pathNotFound?: boolean
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
  /**
   * 这个方块要什么工具（Forge 的 getHarvestTool(meta) / getHarvestLevel(meta)）：tool 是工具类别（pickaxe、axe、shovel，
   * GregTech 的 wrench……），level 是最低等级；方块没说类别时没有这两项。toolRequired 为 false 是空手也能挖下来。
   */
  needs?: ProbeNeeds
  /**
   * excluded：一次挖多格的工具（配置 excludedTools），身体不会用。level：这件工具对 needs.tool 那一类自报的等级
   * （getHarvestLevel(stack, 类别)，-1 是不算这一类；GregTech 的工具对任何类别都报自己的等级，挖不挖得动看 harvest）。
   * classes：它自认是哪几类工具、各几级。strength 为 0 是挖它一点进度都没有。
   */
  candidates?: ProbeCandidate[]
  /** Forge IShearable 对原版剪刀的回答；未声明此能力时省略，不是掉落预测。 */
  shearing?: { item: string; shearable?: boolean; unreadable?: boolean }
  /** 服务器自己的保护不让 bot 动这一格（点、挖、对着它放都会被拒绝）：工具挖得动也一样。 */
  protection?: Protection
}

export interface ProbeNeeds {
  tool?: string
  level?: number
  toolRequired?: boolean
  /** 方块回答这些时出了错。 */
  unreadable?: boolean
}

export interface ProbeCandidate {
  slot: number
  item: string
  harvest?: boolean
  strength?: number
  ticks?: number
  excluded?: boolean
  level?: number
  classes?: Record<string, number>
}

/**
 * 服务器自己的保护：原版的出生点保护是主世界里离出生点 range 格以内（x、z 两个方向里大的那个）、所有高度的方块，
 * 服务器有 op 时，不是 op 的玩家点不了、挖不了、也不能对着它放方块。x1..x2、z1..z2 是那一块的范围。
 * by 是 "the server" 时服务器拒绝了，但不在出生点那一块里（别的 mod 改了规则）。
 * 任务以 denied 失败时 detail.protection 也是它，另带被拒绝的那一格的 x、y、z。
 */
export interface Protection {
  by: 'spawn protection' | 'the server' | (string & {})
  spawn?: { x: number; z: number }
  range?: number
  x1?: number
  z1?: number
  x2?: number
  z2?: number
  x?: number
  y?: number
  z?: number
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
