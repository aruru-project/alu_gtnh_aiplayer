// 协议方法的有类型薄封装。不含任何策略：参数原样发出去，结果原样拿回来。

import type {
  BlockInfo,
  BlockPos,
  BlueprintCheck,
  BlueprintContent,
  BlueprintEntry,
  BlueprintPlacement,
  BotListEntry,
  BotStatus,
  Center,
  ClientOnlyScreen,
  ContainerInfo,
  DrawersResult,
  EntityInfo,
  FindMatch,
  ItemFilter,
  KeyInfo,
  KeyPressResult,
  ItemSearchHit,
  MachineInfo,
  PlayerView,
  ProbeResult,
  QuestDetail,
  QuestHit,
  QuestLine,
  QuestPressResult,
  QuestProgress,
  RecipeFindResult,
  ScanResult,
  ScreenState,
  WorldBlocks,
  ServerInfo,
  StockQuery,
  StockResult,
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
  /** detail / path：连同这个方块自己知道的全部（它对扫描器说的话、存档里的全部数据；path 只看其中一部分）。 */
  worldBlock(p: Dim & BlockPos & { detail?: boolean; path?: string }): Promise<BlockInfo> {
    return this.call('world.block', p)
  }
  worldScan(p: Dim & { x1: number; z1: number; x2: number; z2: number }): Promise<ScanResult> {
    return this.call('world.scan', p)
  }
  /** 一个盒子里的全部方块（两角任意顺序，每边最多 64 格）。 */
  worldBlocks(p: Dim & { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }): Promise<WorldBlocks> {
    return this.call('world.blocks', p)
  }
  worldFind(center: Center, p: { blocks: string[]; radius?: number; limit?: number }): Promise<{ matches?: FindMatch[]; total?: number }> {
    return this.call('world.find', { ...center, ...p })
  }
  /** 一个在线玩家站在哪、朝哪看、指着什么。 */
  worldPlayer(name: string): Promise<PlayerView & { name?: string; isBot?: boolean }> {
    return this.call('world.player', { name })
  }
  /** 一个抽屉管理器管着的全部抽屉，逐格列出（给的位置是普通抽屉时只有它自己）。below：只列有货而且少于这个数的格。 */
  worldDrawers(p: Dim & BlockPos & { below?: number; offset?: number; limit?: number }): Promise<DrawersResult> {
    return this.call('world.drawers', p)
  }
  /**
   * 由近到远。total 是范围里的总数，containers 只是从 offset 起的一页。
   * kinds：每个容器最多列多少种物品（默认 60，最多 2000），没列的记在 moreKinds 里。把一个容器看全：以它为中心、radius 0、kinds 给大。
   */
  worldContainers(center: Center, p: { radius?: number; offset?: number; limit?: number; kinds?: number } = {}): Promise<{ containers?: ContainerInfo[]; total?: number; offset?: number }> {
    return this.call('world.containers', { ...center, ...p })
  }
  worldEntities(center: Center, p: { radius?: number; offset?: number; limit?: number } = {}): Promise<{ entities?: EntityInfo[]; total?: number; offset?: number; more?: number }> {
    return this.call('world.entities', { ...center, ...p })
  }
  worldEntity(p: { uuid: string; dim: number; detail?: boolean; path?: string }): Promise<EntityInfo> {
    return this.call('world.entity', p)
  }

  // 物品、配方、库存（只读）。服务器刚启动、配方索引还没建好时这几个方法返回 busy。
  /** 按英文显示名或 id 找物品，最像的排前面。 */
  itemSearch(query: string, limit?: number): Promise<{ items?: ItemSearchHit[] }> {
    return this.call('item.search', limit === undefined ? { query } : { query, limit })
  }
  /** 某个物品怎么做。带 bot 时原料里有它身上现有的数量（have）。machine 给了就只列名字里含它的机器的配方。 */
  recipeOverclock(p: { bot?: string; eut: number; ticks: number; recipeKey: string; machine?: BlockPos; tier?: string }): Promise<{ eut?: number; ticks?: number; overclocks?: number; scope?: string; source?: string; unavailable?: string }> {
    return this.call('recipe.overclock', p)
  }

  recipeFind(p: { id: string; meta?: number; bot?: string; crafting?: number; machines?: number; machine?: string }): Promise<RecipeFindResult> {
    return this.call('recipe.find', p)
  }
  /** 附近的 GregTech 单方块加工机器，由近到远。name 给了就只列名字或配方种类里含它的。 */
  worldMachines(center: Center, p: { radius?: number; name?: string; limit?: number } = {}): Promise<{ machines?: MachineInfo[]; total?: number }> {
    return this.call('world.machines', { ...center, ...p })
  }
  // ── 界面（通用）：打开、看格子、点、关。只在 bot 没有任务在跑时可用 ──
  /** 打开一个方块的界面（side / hit / sneak：点哪个面、哪一点、蹲不蹲——有的方块这样打开的是另一个界面），或者身上一件东西的界面。 */
  screenOpen(bot: string, target: { x: number; y: number; z: number; side?: string; hit?: { x: number; y: number; z: number }; sneak?: boolean } | { item: { id: string; meta?: number } }): Promise<ScreenState> {
    return this.call('screen.open', { bot, ...target })
  }
  screenLook(bot: string): Promise<ScreenState> {
    return this.call('screen.look', { bot })
  }
  screenClick(bot: string, p: { slot: number; button?: number; shift?: boolean }): Promise<ScreenState> {
    return this.call('screen.click', { bot, ...p })
  }
  /** 按一下界面上格子以外的一样东西：开关翻过来、面板打开或关上、按钮做它的事、流体格照鼠标上拿着的容器装或倒。 */
  screenPress(bot: string, p: { key: string; panel?: string; button?: number; shift?: boolean }): Promise<ScreenState> {
    return this.call('screen.press', { bot, ...p })
  }
  /** 把一个开关、数字、文字或选项设成 value。 */
  screenSet(bot: string, p: { key: string; panel?: string; value: boolean | number | string }): Promise<ScreenState> {
    return this.call('screen.set', { bot, ...p })
  }
  screenClose(bot: string): Promise<Record<string, unknown>> {
    return this.call('screen.close', { bot })
  }

  /** 这些东西存在附近哪些箱子、抽屉里，各多少。 */
  worldStock(center: Center, p: { items: StockQuery[]; radius?: number }): Promise<StockResult> {
    return this.call('world.stock', { ...center, ...p })
  }

  // 任务书（只读）。服务器没装任务书时这几个方法返回 not_found。
  /** 一个玩家做完了哪些任务。任务的内容大脑自己有（本地资料），只有进度要问服务器。 */
  questProgress(player: string): Promise<QuestProgress> {
    return this.call('quest.progress', { player })
  }
  // 下面三个连内容一起问服务器（英文），本地没有任务书资料时才用。player 给了才有进度。
  questLines(player?: string): Promise<{ lines?: QuestLine[]; quests?: number }> {
    return this.call('quest.lines', player === undefined ? {} : { player })
  }
  /** query 的每个词都要出现在标题或说明里；line 是章节名的一部分；state 需要 player。 */
  questSearch(p: { query?: string; line?: string; state?: string; player?: string; limit?: number }): Promise<{ quests?: QuestHit[]; total?: number }> {
    return this.call('quest.search', p)
  }
  questGet(id: string, player?: string): Promise<QuestDetail> {
    return this.call('quest.get', player === undefined ? { id } : { id, player })
  }
  // 任务书的按钮：bot 替自己按（身体做客户端那一半）。task、reward、choice 是 quest.get 里的第几个，从 0 数。
  // 只在没有任务在跑时可用（否则 busy）；老的身体没有这几个方法（unknown_method）。
  /** 任务界面的“检测/提交”。 */
  questSubmit(bot: string, id: string): Promise<QuestPressResult> {
    return this.call('quest.submit', { bot, id })
  }
  /** 一个勾选框子任务的框。 */
  questCheck(bot: string, id: string, task: number): Promise<QuestPressResult> {
    return this.call('quest.check', { bot, id, task })
  }
  /** 挑一样的奖励里点一样。 */
  questChoose(bot: string, id: string, reward: number, choice: number): Promise<QuestPressResult> {
    return this.call('quest.choose', { bot, id, reward, choice })
  }
  /** 任务界面的“领取”。 */
  questClaim(bot: string, id: string): Promise<QuestPressResult> {
    return this.call('quest.claim', { bot, id })
  }

  // 图纸
  blueprintList(): Promise<{ blueprints?: BlueprintEntry[]; folder?: string }> {
    return this.call('blueprint.list')
  }
  /** 把世界和图纸逐格对比，只读。带 bot 时用它所在的维度，materials 里有它身上的数量（have）。 */
  blueprintCheck(p: BlueprintPlacement & { bot?: string; dim?: number; layers?: boolean }): Promise<BlueprintCheck> {
    return this.call('blueprint.check', p)
  }
  /**
   * 图纸本身的内容（材料表、每一格），和世界无关。from / to 是图纸内部的两个角（从最低角的 0 数起，两头都含），不给就是整张；
   * 一次最多 262144 格，超了 too_large。cells:false 只要材料表。
   */
  blueprintRead(p: { name: string; from?: BlockPos; to?: BlockPos; cells?: boolean }): Promise<BlueprintContent> {
    return this.call('blueprint.read', p)
  }
  /** data 是 .schematic 文件内容的 base64（文件最大 2 MiB）。同名覆盖。 */
  blueprintPut(name: string, data: string): Promise<BlueprintEntry> {
    return this.call('blueprint.put', { name, data })
  }
  blueprintRemove(name: string): Promise<{ removed?: boolean }> {
    return this.call('blueprint.remove', { name })
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
  /**
   * 公共聊天里说话。超过 100 字身体自己分行（尽量断在标点后），约每秒一行；一次最多 1000 字，排队最多 20 行。
   * 返回排进去了几行、队列满了没排进去的行数、超长被截掉的字数（老的身体什么都不返回）。
   */
  botChat(bot: string, message: string): Promise<{ lines?: number; droppedLines?: number; cutChars?: number }> {
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
  /** 身体按得了的 mod 的键（老的身体没有这个方法：unknown_method）。 */
  botKeys(): Promise<{ keys?: KeyInfo[]; clientOnly?: ClientOnlyScreen[] }> {
    return this.call('bot.keys')
  }
  /** 像玩家那样按一下一个 mod 的键；sneak 是按着 Shift。只在没有任务在跑时可用（否则 busy）。 */
  botKey(bot: string, key: string, sneak?: boolean): Promise<KeyPressResult> {
    return this.call('bot.key', { bot, key, ...(sneak === true ? { sneak: true } : {}) })
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
