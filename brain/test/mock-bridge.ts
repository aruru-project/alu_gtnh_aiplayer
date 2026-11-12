// 模拟 bridge：按 docs/PROTOCOL.md 实现的服务端，代替游戏里的 mod。
// 行为向真实 mod 看齐（响应的字段、事件和响应的先后顺序、指令回显、任务结果的形状都是对着测试服实测过的），
// 世界本身是假的：一小块固定地形、一个箱子、一组抽屉、一个工作台、一张图纸、一本只有十来种物品的配方书、
// 一本只有六个任务的任务书、两台 GregTech 机器（一台有电的车床、一台没电的组装机）、一个真人玩家。
// 测试里可以脚本化地推事件、让任务按设定结束、断开连接、模拟服务器重启。
// 也能独立运行，方便手动看面板：
//   npm run mock-bridge -- [--port 25600] [--token mock-token] [--auto 5000] [--bot Alu]
// 默认端口 25600。模拟服务只用 25600–25699 或临时端口；游戏服务器和真实 mod 用的端口一律拒绝（见 ports.ts）。
// 独立运行时从标准输入读指令，输入 help 看列表。

import crypto from 'node:crypto'
import net from 'node:net'
import readline from 'node:readline'
import zlib from 'node:zlib'
import { MOCK_BRIDGE_DEFAULT_PORT, checkMockPort } from './ports.ts'

type Json = Record<string, unknown>

export interface MockTask {
  id: string
  type: string
  /** 和真实 mod 一样，type 也在 params 里。 */
  params: Json
  state: 'queued' | 'running' | 'done' | 'failed' | 'canceled'
  progress: { done: number; total: number; phase: string; note: string }
  createdAt: number
  startedAt?: number
  finishedAt?: number
  result?: Json
  error?: { code: string; message: string; detail?: Json }
}

export interface MockItem {
  slot: number
  id: string
  meta: number
  count: number
  name: string
  durability?: number
}

export interface MockBot {
  name: string
  online: boolean
  dim: number
  pos: { x: number; y: number; z: number }
  health: number
  food: number
  inventory: MockItem[]
  settings: Json
  homes: string[]
  task: MockTask | null
  queue: MockTask[]
  /** 最近结束的，新的在前。 */
  recent: MockTask[]
  /** 背在背上的东西（探险背包 mod 的那一格）：测试里放上去。data 照真的身体给的原样（直升机背包的 wearableData.status 0 关、1 普通、2 悬停）。 */
  worn?: { slot: string; id: string; meta: number; count: number; name: string; tanks?: MockTank[]; data?: Json }[]
}

export interface MockContainer {
  x: number
  y: number
  z: number
  id: string
  name: string
  slots: number
  items: { id: string; meta: number; count: number; name: string }[]
  /** 抽屉（Storage Drawers）是 "drawers"：count 是真实库存，slots 是抽屉格数。"drawer_controller" 是抽屉管理器：自己不装东西，管着所有抽屉。 */
  kind?: 'drawers' | 'drawer_controller'
  /** 旁边接着的漏斗、管道（有的话这是个自动化的容器）。 */
  attached?: { x: number; y: number; z: number; name: string; kind: string }[]
  /** 它的流体罐（储罐、超级缸）。 */
  tanks?: MockTank[]
}

/** 假图纸。读得了的有尺寸和每一格是什么；读不了的只有名字和原因。 */
export interface MockBlueprint {
  name: string
  size: { x: number; y: number; z: number }
  /** kinds[0] 是“这里没有方块”。byHand：得由人来放的原因。 */
  kinds: { id: string; meta: number; name: string; byHand?: string }[]
  /** 每格是 kinds 的下标：cells[x + (y * size.z + z) * size.x]，和 .schematic 文件里的顺序一样。 */
  cells: Uint16Array
}
export type MockBlueprintFile = MockBlueprint | { name: string; error: string }

/** 假配方书里的一种物品，和它的做法。 */
export interface MockRecipeItem {
  id: string
  meta: number
  name: string
  /** 登记在哪些矿辞名下。 */
  ores?: string[]
  crafting?: MockCrafting[]
  /** 机器配方，形状就是协议里 recipe.find 的 machines 的一项。 */
  machines?: Json[]
  smeltedFrom?: { id: string; meta: number; name: string; count: number }[]
}

/** 一台 GregTech 单方块加工机器。 */
export interface MockMachine {
  x: number
  y: number
  z: number
  name: string
  /** 跑哪种配方：和配方书里机器配方的 machine 是同一个词。 */
  recipes: string
  /** 这台机器作为物品时的 id + meta，和它跑的配方在配方册里的页（和本地配方册比对用）。 */
  id?: string
  meta?: number
  recipeKey?: string
  /** 机器的等级：ULV、LV、MV…… */
  tier: string
  inputSlots: number
  /** 为 0 就是没电。 */
  storedEU: number
  inputVoltage: number
  /** 正在加工别的东西。 */
  active?: boolean
  /** 被人关掉了。 */
  switchedOff?: boolean
  /**
   * 原料格里现在放着的东西（主人留在里面的模具、模头）。给了它，这台机器就会像真的那样出现在 world.containers 里（kind:"machine"），
   * withdraw 带 fromInputs 能把它们取出来，deposit 能放回去；占着的格子连同这次要放的超过 inputSlots 时，process 一样都放不进去。
   */
  inputs?: { id: string; meta: number; count: number; name: string }[]
  /** 产物格里现在放着的东西：process 带 leave 时产物留在这里，withdraw（不带 fromInputs）从这里取。 */
  outputs?: { id: string; meta: number; count: number; name: string }[]
  /** 界面上设着的编程电路（0 或不给是没设）。process 带 leave 时设了不恢复。 */
  circuit?: number
  /**
   * world.machines 里这台机器另外带的字段，原样给出去。多方块机器的主机靠它：
   * kind:"multiblock"、formed、heat、idleReason、inputBuses / outputBuses / inputHatches（总线和仓，可以带 attached）。
   */
  more?: Json
  /** 它各个面上的覆盖板。能装东西的（槽位扩展）带 slots 和 items：这些东西不在机器自己的格子里，要蹲着点那个面才拿得到。 */
  covers?: MockCover[]
  /** 它的流体罐里现在有什么（空罐只有 capacity）。 */
  tanks?: MockTank[]
  /** 它自己知道的全部（world.block 带 detail 时给出去）：对扫描器说的话、存档里的数据。 */
  says?: string[]
  saved?: Json
  /**
   * 它界面上格子以外的东西（开关、选项、按钮……）。给了它，screen.open 对着这台机器就打开它自己的界面：
   * 原料格和一个产物格，加上这些控件、每个罐一个流体格、每块能装东西的覆盖板一个页签（cover_panel_<面>）。
   */
  controls?: MockControl[]
  /** fluidAutoOutput 这个开关打开以后，它罐里的流体进到哪台机器的罐里（真的机器是朝它的输出面推）。 */
  autoOutputTo?: { x: number; y: number; z: number }
  /**
   * 物品自动输出开着：做出来的东西从这一面推进挨着的那个容器（containers 里同一位置的那个），不留在产物格里。
   * 和真的身体一样，world.machines 里带 autoOutput，process 的结果里产物不在 outputs 里，在 elsewhere 里。
   */
  itemAutoOutput?: { side: string; to: { x: number; y: number; z: number; name: string } }
  /** 它能把哪些东西化成流体（process 放进这种东西，没有物品出来，罐里多出流体）。 */
  melts?: { id: string; meta: number; fluid: string; name: string; mb: number }[]
  /** 被按过的按钮（测试看用）。 */
  pressed?: string[]
}

/** 机器界面上的一个控件：名字（panel、key）是界面自己起的。 */
export interface MockControl {
  panel: string
  key: string
  kind: 'switch' | 'number' | 'text' | 'choice' | 'button' | 'value'
  value?: boolean | number | string
  options?: string[]
  readOnly?: boolean
}

/** 机器某个面上的一块覆盖板。 */
export interface MockCover {
  side: string
  id: string
  meta: number
  name: string
  /** 能装东西的覆盖板才有。 */
  slots?: number
  items?: { id: string; meta: number; count: number; name: string }[]
}

export interface MockTank {
  fluid?: string
  name?: string
  amount?: number
  capacity: number
}

/** 覆盖板、流体罐照协议的样子给出去（world.block、world.containers、world.machines 都带）。 */
function attachments(x: { covers?: MockCover[]; tanks?: MockTank[] }): Json {
  return {
    ...(x.covers && x.covers.length > 0
      ? {
          covers: x.covers.map((c) => ({
            side: c.side,
            id: c.id,
            meta: c.meta,
            name: c.name,
            screen: true,
            ...(c.slots !== undefined ? { slots: c.slots, usedSlots: (c.items ?? []).length, items: (c.items ?? []).map((i) => ({ ...i })), moreKinds: 0 } : {}),
          })),
        }
      : {}),
    ...(x.tanks && x.tanks.length > 0 ? { tanks: x.tanks.map((t) => ((t.amount ?? 0) > 0 ? { ...t } : { amount: 0, capacity: t.capacity })) } : {}),
  }
}

/**
 * 身体不认识的机器：一个带界面的方块（原版熔炉、别的 mod 的机器）。身体只知道它界面里有哪些格子、哪些格子放不进东西（产物格）。
 * 它自己会做什么写在 recipes 里：能放东西的格子里凑齐 inputs（要 fuel 的还得有燃料）就把它们变成 outputs，放进产物格。
 */
export interface MockDevice {
  x: number
  y: number
  z: number
  id: string
  name: string
  /** 界面里它自己的格子，编号就是下标：in 能放东西，out 只出产物（takesNothing），ghost 只显示。 */
  slots: { kind: 'in' | 'out' | 'ghost'; item?: { id: string; meta: number; count: number; name: string } }[]
  recipes: { inputs: { id: string; meta: number; count: number }[]; fuel?: { id: string; meta: number }; outputs: { id: string; meta: number; count: number; name: string }[] }[]
  /** 烧着的那份燃料还够做几轮（一份燃料烧 8 轮）。 */
  burning?: number
}

/** 假任务书里的一个任务。tasks / rewards 的形状就是协议里 quest.get 的（不带 complete，那是按玩家算的）。 */
export interface MockQuest {
  /** 任务书自己的编号：老任务是一小段十六进制数，新任务是完整的 UUID。 */
  id: string
  name: string
  /** 所在的章节。 */
  line: string
  description: string
  /** 前置任务的 id。 */
  requires: string[]
  tasks: Json[]
  rewards: Json[]
}

export interface MockCrafting {
  /** 做一次出几个。 */
  gives: number
  grid: '2x2' | '3x3'
  /** 一样原料：一种确定的物品（id，meta 缺省是任何变体），或者一个矿辞名（ore）。tool 是只磨损不消耗的工具。 */
  ingredients: { count: number; id?: string; meta?: number; ore?: string; tool?: boolean }[]
  /** 某个 mod 自己的配方类型，读不出原料。 */
  unreadable?: boolean
}

export interface RecordedRequest {
  method: string
  params: Json
  client: string
}

export interface MockBridgeOptions {
  host?: string
  port?: number
  token?: string
  /** 任务开始后过这么久自动完成；不给则要测试自己调 finishTask。 */
  autoFinishMs?: number
  /** 一开始就在线的 bot。 */
  bots?: string[]
}

interface Conn {
  socket: net.Socket
  authed: boolean
  client: string
  buffer: string
}

class RpcError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const TASK_TYPES = new Set(['goto', 'goto_player', 'follow', 'home', 'dig', 'place', 'clear', 'fill', 'flatten', 'deposit', 'withdraw', 'haul', 'collect', 'give', 'blueprint', 'craft', 'process', 'use', 'hold', 'wait'])

/** 真实 mod 在装了探险背包的服务器上报的键（bot.keys）。 */
export const MOCK_KEYS = [
  { key: 'keys.adventureBackpack.openInventory', name: 'Open Inventory', category: 'Adventure Backpack' },
  { key: 'keys.adventureBackpack.toggleActions', name: 'Toggle Actions', category: 'Adventure Backpack' },
]

/** 真实 mod 默认的 allowedCommands。一项可以是几个词：team join 只放行 team join …。 */
const ALLOWED_COMMANDS = ['home', 'sethome', 'delhome', 'homes', 'spawn', 'back', 'tell', 'msg', 'w', 'tpa', 'tpaccept', 'team join']

/** 指令连斜杠最多 100 个字符。 */
const COMMAND_MAX_CHARS = 99
/** 实测：一口气发 9 条都行，第 10 条起被拒；过 1 秒就恢复了。 */
const CHAT_BURST = 9
const CHAT_BURST_WINDOW_MS = 1000
/** 步行上限（配置 maxTravel）。 */
const MAX_TRAVEL = 256
/** 任务队列上限。 */
const MAX_QUEUE = 32

/** bot 上线时服务器发给它的欢迎语（真实服务器上有十来行）。 */
const JOIN_MESSAGES = ['A magic bubble of protection appears...', 'Welcome to GregTech: New Horizons 2.9.0', 'Visit our Discord at https://discord.gg/gtnh']

/** 这个范围以外算“区块没加载”。 */
const LOADED_RADIUS = 1000

/** 图纸文件的上限，和真实 mod 一样。 */
const BLUEPRINT_MAX_BYTES = 2 * 1024 * 1024
/** blueprint 任务一次最多处理这么宽的范围。 */
const BLUEPRINT_MAX_SIDE = 64
/** blueprint.check 的各张表最多 30 种；任务结果里最多 8 种。 */
const BLUEPRINT_LIST_LIMIT = 30
const BLUEPRINT_SUMMARY_LIMIT = 8
const BLUEPRINT_FOLDER = 'config/aiplayer/schematics'
/** GregTech 的电压等级，由低到高。 */
const TIERS = ['ULV', 'LV', 'MV', 'HV', 'EV', 'IV', 'LuV', 'ZPM', 'UV', 'UHV']
/** craft 任务找工作台的范围。 */
const CRAFT_TABLE_SEARCH = 24
/** clear 里的 "natural"：配置的天然方块。 */
const NATURAL_BLOCKS = new Set(['minecraft:dirt', 'minecraft:grass', 'minecraft:sand', 'minecraft:gravel', 'minecraft:snow_layer', 'minecraft:leaves'])
/** clear 里的 "plants"：长出来的东西。 */
const PLANT_BLOCKS = new Set(['minecraft:leaves', 'minecraft:tallgrass', 'minecraft:red_flower', 'minecraft:yellow_flower', 'minecraft:wheat'])

export class MockBridge {
  readonly token: string
  epoch = crypto.randomBytes(9).toString('hex')
  /** 已经发出的最后一个事件的序号。 */
  seq = 0
  port = 0
  /** 收到的全部请求（不含 hello），按到达顺序。 */
  readonly requests: RecordedRequest[] = []
  /** 收到的每一次 hello 的参数。 */
  readonly hellos: Json[] = []
  /** bot 在公共聊天里说过的话。 */
  readonly chatLog: { bot: string; message: string }[] = []
  /** bot 执行过的指令。 */
  readonly commandLog: { bot: string; command: string }[] = []
  readonly bots = new Map<string, MockBot>()
  players: { name: string; uuid: string; dim: number; pos: { x: number; y: number; z: number } }[] = [
    { name: 'Steve', uuid: 'uuid-steve', dim: 0, pos: { x: 12.5, y: 64, z: 3.5 } },
  ]
  /** 一个真人进了服务器（bot 在不在线，这个事件都照发）。 */
  playerJoin(name: string): void {
    if (!this.players.some((p) => p.name === name)) this.players.push({ name, uuid: `uuid-${name.toLowerCase()}`, dim: 0, pos: { x: 12.5, y: 64, z: 3.5 } })
    this.emit('player.join', { player: name, uuid: `uuid-${name.toLowerCase()}` })
  }

  /** 一个真人离开了服务器。 */
  playerLeave(name: string): void {
    this.players = this.players.filter((p) => p.name !== name)
    this.emit('player.leave', { player: name, uuid: `uuid-${name.toLowerCase()}` })
  }

  containers: MockContainer[] = [
    {
      x: 12,
      y: 64,
      z: -4,
      id: 'minecraft:chest',
      name: 'Chest',
      slots: 27,
      items: [
        { id: 'minecraft:cobblestone', meta: 0, count: 320, name: 'Cobblestone' },
        { id: 'minecraft:torch', meta: 0, count: 12, name: 'Torch' },
        // 做 Copter Blades 的料：轴、螺丝、一把螺丝刀（配方见 defaultRecipeBook）
        { id: 'IC2:itemRecipePart', meta: 12, count: 8, name: 'Shaft (Refined Iron)' },
        { id: 'gregtech:gt.metaitem.01', meta: 27305, count: 16, name: 'Steel Screw' },
        { id: 'gregtech:gt.metatool.01', meta: 22, count: 1, name: 'Screwdriver' },
        // 车床的料：钢锭车成钢杆
        { id: 'gregtech:gt.metaitem.01', meta: 11305, count: 8, name: 'Steel Ingot' },
      ],
    },
    // 一组抽屉：两格，一格装着上万的圆石，另一格还没指定物品
    {
      x: 14,
      y: 64,
      z: -4,
      id: 'StorageDrawers:fullDrawers2',
      name: 'Oak Drawers 1x2',
      slots: 2,
      kind: 'drawers',
      items: [{ id: 'minecraft:cobblestone', meta: 0, count: 12800, name: 'Cobblestone' }],
    },
  ]
  /** GregTech 单方块机器：一台有电的 MV 车床，一台没电的 LV 组装机。 */
  /** 身体不认识的机器（熔炉、别的 mod 的机器）：world.machines 里没有它们，world.containers 里有；process、存取、界面动作都能对着它们用。 */
  devices: MockDevice[] = []
  /** 每个 bot 现在开着的界面（screen.open 打开的）。 */
  private readonly screens = new Map<string, { title: string; slots: MockDevice['slots']; device?: MockDevice; cursor?: { id: string; meta: number; count: number; name: string }; machine?: MockMachine; panels?: Map<string, number> }>()
  machines: MockMachine[] = [
    { x: 16, y: 64, z: -4, name: 'Advanced Lathe', recipes: 'Lathe', tier: 'MV', inputSlots: 1, storedEU: 51200, inputVoltage: 128 },
    { x: 18, y: 64, z: -4, name: 'Basic Assembling Machine', recipes: 'Assembler', tier: 'LV', inputSlots: 6, storedEU: 0, inputVoltage: 0 },
  ]
  /**
   * 随身的包：右键会打开一个界面的物品，物品 id → 包里的东西。deposit / withdraw 的 container 写成 {item:{id}} 时存取的就是它。
   */
  readonly bags = new Map<string, { id: string; meta: number; count: number; name: string }[]>([['Backpack:backpack', []]])
  /** use 任务：这件东西右键用了会怎样。food：吃掉一个，饱食度加这么多；wear：穿到身上（从背包里消失）。包是打开界面；别的东西用了没有看得见的变化。 */
  /** use 任务对着方块点过的每一下（空手按按钮、拿着东西点方块）：谁、点的哪个方块、哪个面、几下。 */
  readonly clickLog: Json[] = []
  readonly usable = new Map<string, { food?: number; wear?: boolean }>([
    ['minecraft:bread', { food: 5 }],
    ['minecraft:iron_helmet', { wear: true }],
  ])
  /** 工作台（3x3 的配方要走到一个旁边才能做）。 */
  craftingTables: { x: number; y: number; z: number }[] = [{ x: 8, y: 64, z: -4 }]
  /** 配方书：item.search / recipe.find / craft 任务都查它。 */
  recipeBook: MockRecipeItem[] = defaultRecipeBook()
  /** 服务器刚启动时配方索引还没建好：设成 false，item.search 和 recipe.find 就返回 busy。 */
  recipesReady = true
  /** 任务书（BetterQuesting）。设成 undefined 就是服务器没装任务书。 */
  questBook: MockQuest[] | undefined = defaultQuestBook()
  /** 每个玩家的进度：玩家名（小写）→ 做完了哪些任务、其中哪些已经领了奖励。任务书只认识这里有的和在线的玩家。 */
  readonly questProgress = new Map<string, { complete: Set<string>; claimed: Set<string> }>([
    ['steve', { complete: new Set(['1', '2']), claimed: new Set(['1']) }],
  ])
  /** 服务器上的图纸（config/aiplayer/schematics 里的文件），按名字。 */
  readonly blueprints = new Map<string, MockBlueprintFile>([['hut', hutBlueprint('hut')]])
  /** blueprint 任务放下或挖掉的方块，盖在假地形上："x,y,z" → 方块；null 是挖成了空气。 */
  readonly changedBlocks = new Map<string, { id: string; meta: number; name: string } | null>()
  autoFinishMs: number | undefined

  private readonly host: string
  private readonly wantPort: number
  private server: net.Server | undefined
  private readonly conns = new Set<Conn>()
  private buffer: Json[] = []
  private nextTask = 1
  private readonly overrides = new Map<string, (params: Json) => unknown>()
  private readonly waiters: { test: (r: RecordedRequest) => boolean; resolve: (r: RecordedRequest) => void }[] = []
  private readonly timers = new Set<NodeJS.Timeout>()
  /** 每个 bot 最近说话、执行指令的时刻，用来模拟“太密了就拒绝”。 */
  private readonly chatTimes = new Map<string, number[]>()
  /** 已经邀请了某个 bot 的队伍：队伍 id → bot 名。 */
  readonly teamInvites = new Map<string, string>()

  constructor(opts: MockBridgeOptions = {}) {
    this.host = opts.host ?? '127.0.0.1'
    this.wantPort = opts.port ?? 0
    this.token = opts.token ?? crypto.randomBytes(12).toString('hex')
    this.autoFinishMs = opts.autoFinishMs
    for (const name of opts.bots ?? []) this.addBot(name, true)
  }

  // ── 生命周期 ──

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket))
      server.once('error', reject)
      server.listen(this.wantPort || this.port, this.host, () => {
        this.server = server
        this.port = (server.address() as net.AddressInfo).port
        resolve(this.port)
      })
    })
  }

  /** 停止监听并断开所有连接（端口号保留，可以再 start 回同一个端口）。 */
  stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.dropConnections()
    const server = this.server
    this.server = undefined
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()))
  }

  /** 断开所有客户端，服务端照常运行（模拟网络闪断）。 */
  dropConnections(): void {
    for (const c of this.conns) c.socket.destroy()
    this.conns.clear()
  }

  /**
   * 模拟服务器重启：新的 epoch，seq 从 1 重新数，事件缓冲清空。
   * 和真实 mod 一样：重启前在线的 bot 自动上线，没做完的任务从头重新开始（任务和队列存在世界存档里）。
   */
  restart(): void {
    // 真实 mod 关服时：先发 server.stopping，再给每个在线的 bot 发一个 reason 是 “server stopping” 的 bot.despawned
    this.emit('server.stopping', {})
    for (const bot of this.bots.values()) if (bot.online) this.emit('bot.despawned', { bot: bot.name, reason: 'server stopping' })
    this.dropConnections()
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.epoch = crypto.randomBytes(9).toString('hex')
    this.seq = 0
    this.buffer = []
    for (const bot of this.bots.values()) {
      if (!bot.online) continue
      for (const text of JOIN_MESSAGES) this.emit('bot.message', { bot: bot.name, text })
      this.emit('bot.spawned', { bot: bot.name })
      if (bot.task) {
        const task = bot.task
        task.state = 'queued'
        task.progress = { ...task.progress, done: 0 }
        delete task.result
        this.run(bot, task)
      }
    }
  }

  get connectedClients(): number {
    return [...this.conns].filter((c) => c.authed).length
  }

  // ── 脚本化 ──

  /** 换掉某个方法的实现。返回值作为 result；抛 rpcError(...) 则返回错误。 */
  on(method: string, handler: (params: Json) => unknown): void {
    this.overrides.set(method, handler)
  }

  rpcError(code: string, message: string): Error {
    return new RpcError(code, message)
  }

  /** 推一个事件：进缓冲、广播给所有已认证的客户端。 */
  emit(event: string, data: Json): number {
    const msg = { event, seq: ++this.seq, time: Date.now(), data }
    this.buffer.push(msg)
    if (this.buffer.length > 1000) this.buffer.shift()
    const line = `${JSON.stringify(msg)}\n`
    for (const c of this.conns) if (c.authed) c.socket.write(line)
    return msg.seq
  }

  chat(player: string, message: string): number {
    const speaker = this.playerView(player)
    return this.emit('chat', { player, uuid: `uuid-${player.toLowerCase()}`, message, isBot: false, ...(speaker ? { speaker } : {}) })
  }

  whisper(bot: string, from: string, message: string): number {
    const speaker = this.playerView(from)
    return this.emit('whisper', { bot, from, message, ...(speaker ? { speaker } : {}) })
  }

  /**
   * 一个在线玩家站在哪、朝哪看、指着什么（world.player 的结果，也是聊天事件里的 speaker）。
   * 假世界里他总是面朝北，准星指着离他最近的那个容器，面前是最近的几个容器。
   */
  private playerView(name: string): Json | undefined {
    const player = this.players.find((pl) => pl.name.toLowerCase() === name.toLowerCase())
    if (!player) return undefined
    const { pos } = player
    const seen = this.containers
      .map((c) => ({ x: c.x, y: c.y, z: c.z, id: c.id, meta: 3, name: c.name, kind: c.kind ?? 'container', dist: Math.round(Math.hypot(c.x - pos.x, c.y - pos.y, c.z - pos.z) * 10) / 10, ...(c.attached ? { attached: c.attached } : {}) }))
      .filter((c) => c.dist <= 12)
      .sort((a, b) => a.dist - b.dist)
    return {
      dim: player.dim,
      pos,
      block: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
      yaw: 180,
      pitch: 0,
      facing: 'north',
      ...(seen[0] ? { lookingAt: { ...seen[0], side: 'south' } } : {}),
      ahead: seen.slice(0, 6),
    }
  }

  addBot(name: string, online: boolean): MockBot {
    const bot: MockBot = {
      name,
      online,
      dim: 0,
      pos: { x: 10.5, y: 64, z: -3.5 },
      health: 20,
      food: 20,
      // GTNH 里能用的只有匠魂工具
      inventory: [
        { slot: 0, id: 'TConstruct:pickaxe', meta: 0, count: 1, name: 'Steel Pickaxe', durability: 0.85 },
        { slot: 1, id: 'TConstruct:shovel', meta: 0, count: 1, name: 'Steel Shovel', durability: 0.97 },
        { slot: 2, id: 'TConstruct:hatchet', meta: 0, count: 1, name: 'Steel Hatchet', durability: 1 },
        { slot: 9, id: 'minecraft:dirt', meta: 0, count: 64, name: 'Dirt' },
        { slot: 10, id: 'minecraft:dirt', meta: 0, count: 32, name: 'Dirt' },
        { slot: 11, id: 'minecraft:cobblestone', meta: 0, count: 64, name: 'Cobblestone' },
        { slot: 12, id: 'gregtech:gt.metaitem.01', meta: 5036, count: 3, name: 'Crushed Zinc Ore' },
      ],
      settings: { invulnerable: true, hunger: false },
      homes: ['base'],
      task: null,
      queue: [],
      recent: [],
    }
    this.bots.set(name, bot)
    return bot
  }

  /** 让某个 bot 当前的任务结束。不给 id 就是正在执行的那个。 */
  finishTask(
    botName: string,
    outcome: { state?: 'done' | 'failed' | 'canceled'; result?: Json; error?: { code: string; message: string; detail?: Json } } = {},
    id?: string,
  ): MockTask {
    const bot = this.bot(botName)
    const task = bot.task
    if (!task || (id !== undefined && task.id !== id)) throw new Error(`no running task${id ? ` ${id}` : ''} for ${botName}`)
    this.markRunning(bot, task)
    this.endTask(bot, task, outcome.state ?? (outcome.error ? 'failed' : 'done'), outcome)
    return task
  }

  /**
   * 让当前任务“自然结束”：blueprint 任务按假世界算出结果（材料不够就以 no_material 失败），
   * 其余任务给一个形状和真实 mod 一致的样例结果。自动完成和独立运行时的 done 指令用的就是它。
   */
  completeTask(botName: string): MockTask {
    const task = this.bot(botName).task
    if (!task) throw new Error(`no running task for ${botName}`)
    const bot = this.bot(botName)
    if (task.type === 'blueprint') return this.finishTask(botName, this.buildBlueprint(bot, task))
    if (task.type === 'craft') return this.finishTask(botName, this.craft(bot, task))
    if (task.type === 'process' && this.deviceAt(task.params.machine)) return this.finishTask(botName, this.processOnDevice(bot, task, this.deviceAt(task.params.machine)!, true))
    if (task.type === 'process') return this.finishTask(botName, this.process(bot, task))
    return this.finishTask(botName, { result: sampleResult(task) })
  }

  /** bot 死亡：当前任务以 interrupted 失败、队列清空，约 1.5 秒后自动重生。 */
  kill(botName: string, cause = 'Zombie'): void {
    const bot = this.onlineBot(botName)
    bot.health = 0
    this.emit('bot.message', { bot: bot.name, text: `${bot.name} was slain by ${cause}` })
    this.emit('bot.death', { bot: bot.name, cause })
    const queued = bot.queue
    bot.queue = []
    if (bot.task) {
      const task = bot.task
      bot.task = null
      this.finalize(bot, task, 'failed', { error: { code: 'interrupted', message: 'the bot died' } })
    }
    for (const t of queued) this.finalize(bot, t, 'canceled', {})
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      bot.health = 20
      this.emit('bot.spawned', { bot: bot.name })
    }, 1500)
    this.timers.add(timer)
  }

  /** bot 被踢：变为离线并保持离线。 */
  kick(botName: string, reason = 'Kicked by an operator.'): void {
    const bot = this.onlineBot(botName)
    this.interrupt(bot, 'the bot went offline')
    bot.online = false
    this.emit('bot.despawned', { bot: bot.name, reason })
  }

  /** 等一个满足条件的请求到来（已经到过的也算）。 */
  waitForRequest(method: string, test: (params: Json) => boolean = () => true, timeoutMs = 5000): Promise<RecordedRequest> {
    const match = (r: RecordedRequest) => r.method === method && test(r.params)
    const seen = this.requests.find(match)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const waiter = { test: match, resolve: (r: RecordedRequest) => (clearTimeout(timer), resolve(r)) }
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(new Error(`timed out waiting for request ${method}; got: ${this.requests.map((r) => r.method).join(', ')}`))
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  requestsOf(method: string): Json[] {
    return this.requests.filter((r) => r.method === method).map((r) => r.params)
  }

  // ── 连接 ──

  private onConnection(socket: net.Socket): void {
    const conn: Conn = { socket, authed: false, client: '', buffer: '' }
    this.conns.add(conn)
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      conn.buffer += chunk
      for (;;) {
        const nl = conn.buffer.indexOf('\n')
        if (nl === -1) break
        const line = conn.buffer.slice(0, nl)
        conn.buffer = conn.buffer.slice(nl + 1)
        if (line.trim().length > 0) this.onLine(conn, line)
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => this.conns.delete(conn))
  }

  private reply(conn: Conn, id: unknown, result: unknown): void {
    conn.socket.write(`${JSON.stringify({ id, ok: true, result })}\n`)
  }

  private replyError(conn: Conn, id: unknown, code: string, message: string): void {
    conn.socket.write(`${JSON.stringify({ id, ok: false, error: { code, message } })}\n`)
  }

  private onLine(conn: Conn, line: string): void {
    let msg: Json
    try {
      msg = JSON.parse(line) as Json
    } catch {
      this.replyError(conn, null, 'bad_request', 'not JSON')
      return
    }
    const method = String(msg.method ?? '')
    const params = (msg.params ?? {}) as Json

    if (!conn.authed) {
      if (method !== 'hello' || params.token !== this.token) {
        this.replyError(conn, msg.id, 'unauthorized', method === 'hello' ? 'bad token' : 'say hello first')
        conn.socket.end()
        return
      }
      conn.authed = true
      conn.client = String(params.client ?? '')
      this.hellos.push(params)
      this.reply(conn, msg.id, {
        protocol: 1,
        modVersion: 'v0.1.0-mock',
        mcVersion: '1.7.10',
        serverEpoch: this.epoch,
        seq: this.seq,
      })
      // 补发，紧跟在 hello 响应之后：
      //   带了 epoch 且一致 → seq > lastSeq 的；带了但不一致 → 这次启动以来缓冲里的全部；没带 → 不补发。
      if (typeof params.serverEpoch === 'string') {
        const after = params.serverEpoch === this.epoch && typeof params.lastSeq === 'number' ? params.lastSeq : 0
        for (const e of this.buffer) {
          if ((e.seq as number) > after) conn.socket.write(`${JSON.stringify(e)}\n`)
        }
      }
      return
    }

    const record: RecordedRequest = { method, params, client: conn.client }
    this.requests.push(record)
    for (const w of [...this.waiters]) {
      if (w.test(record)) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        w.resolve(record)
      }
    }
    const after: (() => void)[] = []
    try {
      const override = this.overrides.get(method)
      const result = override ? override(params) : this.handle(method, params, after)
      if (result !== NO_REPLY) this.reply(conn, msg.id, result ?? {})
    } catch (e) {
      if (e instanceof RpcError) this.replyError(conn, msg.id, e.code, e.message)
      else this.replyError(conn, msg.id, 'internal', e instanceof Error ? e.message : String(e))
    }
    // 响应写出去之后才发生的事（比如新任务的 running 事件）
    for (const fn of after) fn()
  }

  // ── 协议方法 ──

  private bot(name: unknown): MockBot {
    const bot = this.bots.get(String(name))
    if (!bot) throw new RpcError('not_found', `no such bot: ${String(name)}`)
    return bot
  }

  private onlineBot(name: unknown): MockBot {
    const bot = this.bot(name)
    if (!bot.online) throw new RpcError('offline', `bot is offline: ${bot.name}`)
    return bot
  }

  private blockOf(bot: MockBot): { x: number; y: number; z: number } {
    return { x: Math.floor(bot.pos.x), y: Math.floor(bot.pos.y), z: Math.floor(bot.pos.z) }
  }

  /** world.find / containers / entities 的中心：{x,y,z}，或者 {bot}。 */
  private center(p: Json): { x: number; y: number; z: number } {
    if (typeof p.bot === 'string') return this.blockOf(this.onlineBot(p.bot))
    for (const k of ['x', 'y', 'z']) {
      if (typeof p[k] !== 'number') throw new RpcError('bad_request', `missing or non-numeric field: ${k}`)
    }
    return { x: p.x as number, y: p.y as number, z: p.z as number }
  }

  private num(p: Json, key: string): number {
    if (typeof p[key] !== 'number') throw new RpcError('bad_request', `missing or non-numeric field: ${key}`)
    return p[key] as number
  }

  private statusOf(bot: MockBot): Json {
    const base = { name: bot.name, uuid: `uuid-${bot.name}`, online: bot.online, settings: bot.settings, task: bot.task, queue: bot.queue }
    // 离线的 bot 只有上面这几项
    if (!bot.online) return base
    return {
      ...base,
      dim: bot.dim,
      pos: bot.pos,
      block: this.blockOf(bot),
      yaw: 90,
      pitch: 0,
      onGround: true,
      inWater: false,
      health: bot.health,
      maxHealth: 20,
      food: bot.food,
      xpLevel: 0,
      heldSlot: 0,
      held: bot.inventory.find((i) => i.slot === 0) ?? null,
      inventory: bot.inventory,
      armor: [null, null, null, null],
      ...(bot.worn && bot.worn.length > 0 ? { worn: bot.worn } : {}),
      aboveGround: 0,
      motion: { x: 0, y: -0.08, z: 0 },
      freeSlots: 36 - bot.inventory.length,
    }
  }

  /**
   * 按一下 mod 的键（bot.key）：照真的身体，有任务在跑是 busy、没有这个键是 bad_request；
   * 穿着直升机背包时 toggleActions 蹲着按是开关、不蹲按是普通和悬停之间切换，结果里是数据里变了的值和游戏说的话。别的情况什么都不变。
   */
  private pressKey(bot: MockBot, p: Json): Json {
    if (bot.task) throw new RpcError('busy', 'a task is running; keys are pressed when the bot is idle')
    const key = String(p.key ?? '')
    if (!MOCK_KEYS.some((k) => k.key === key)) throw new RpcError('bad_request', `no such key: ${key}; the keys are ${JSON.stringify(MOCK_KEYS)}`)
    const copter = bot.worn?.find((w) => w.id === 'adventurebackpack:copterPack')
    const data = copter?.data?.wearableData as Json | undefined
    if (key !== 'keys.adventureBackpack.toggleActions' || !data) return { key }
    const was = Number(data.status ?? 0)
    const now = p.sneak === true ? (was === 0 ? 1 : 0) : was === 0 ? 0 : was === 1 ? 2 : 1
    if (now === was) return { key }
    data.status = now
    return { key, changed: [{ slot: copter!.slot, key: 'wearableData.status', was: String(was), now: String(now) }], said: [`CopterPack: ${['Off', 'Normal Mode', 'Hover Mode'][now]}.`] }
  }

  /** 假世界里某一格是什么：y=64 是草地，往下是石头，往上是空气；blueprint 任务动过的格子以动过的为准。 */
  private blockAt(x: number, y: number, z: number, detail = false, path?: string): Json {
    if (Math.abs(x) > LOADED_RADIUS || Math.abs(z) > LOADED_RADIUS) return { x, y, z, loaded: false }
    const chest = this.containers.find((c) => c.x === x && c.y === y && c.z === z)
    if (chest) {
      return { x, y, z, id: chest.id, meta: 3, name: chest.name, air: false, solid: true, liquid: false, replaceable: false, hardness: 2.5, tileEntity: true, inventory: true, ...attachments(chest) }
    }
    const machine = this.machines.find((m) => m.x === x && m.y === y && m.z === z)
    if (machine) {
      const block = { x, y, z, id: 'gregtech:gt.blockmachines', meta: 0, name: machine.name, air: false, solid: true, liquid: false, replaceable: false, hardness: 2, tileEntity: true, inventory: true, ...attachments(machine) }
      if (!detail) return block
      // 它自己知道的全部：照真的身体，path 只看存档数据里的一个键（这里只认顶层的键）
      const saved = (machine.saved ?? {}) as Json
      const part = path !== undefined && path.length > 0 ? saved[path] : saved
      return {
        ...block,
        class: 'gregtech.api.metatileentity.BaseMetaTileEntity',
        ...(machine.says ? { says: machine.says } : {}),
        ...(path !== undefined && path.length > 0 ? { path, ...(part === undefined ? { pathNotFound: true } : {}) } : {}),
        saved: part === undefined ? saved : part,
      }
    }

    if (this.craftingTables.some((t) => t.x === x && t.y === y && t.z === z)) {
      return { x, y, z, id: 'minecraft:crafting_table', meta: 0, name: 'Crafting Table', air: false, solid: true, liquid: false, replaceable: false, hardness: 2.5, tileEntity: false, inventory: false }
    }
    const changed = this.changedBlocks.get(`${x},${y},${z}`)
    if (changed) {
      return { x, y, z, id: changed.id, meta: changed.meta, name: changed.name, air: false, solid: true, liquid: false, replaceable: false, hardness: 2, tileEntity: false, inventory: false }
    }
    if (y > 64 || changed === null) return { x, y, z, id: 'minecraft:air', meta: 0, name: 'Air', air: true, solid: false, liquid: false, replaceable: true, hardness: 0, tileEntity: false, inventory: false }
    const grass = y === 64
    return {
      x,
      y,
      z,
      id: grass ? 'minecraft:grass' : 'minecraft:stone',
      meta: 0,
      name: grass ? 'Grass Block' : 'Stone',
      air: false,
      solid: true,
      liquid: false,
      replaceable: false,
      hardness: grass ? 0.6 : 1.5,
      tileEntity: false,
      inventory: false,
    }
  }

  private handle(method: string, p: Json, after: (() => void)[]): unknown {
    switch (method) {
      case 'server.info':
        return {
          tick: 123456,
          tps: 20,
          tickMs: 3.4,
          worldTime: 123456,
          dayTime: 3000,
          isDay: true,
          raining: false,
          difficulty: 3,
          players: [
            ...this.players.map((pl) => ({ ...pl, isBot: false })),
            ...[...this.bots.values()]
              .filter((b) => b.online)
              .map((b) => ({ name: b.name, uuid: `uuid-${b.name}`, dim: b.dim, pos: b.pos, isBot: true })),
          ],
          bots: [...this.bots.keys()],
        }
      case 'world.block': {
        const path = typeof p.path === 'string' ? p.path.trim() : undefined
        const block = this.blockAt(this.num(p, 'x'), this.num(p, 'y'), this.num(p, 'z'), p.detail === true || (path !== undefined && path.length > 0), path)
        // 没有自己数据的方块：只有原有字段，外加一句说明
        if ((p.detail === true || path) && block.loaded !== false && block.saved === undefined) return { ...block, detail: 'this block keeps no data of its own: its id and meta are all there is' }
        return block
      }
      case 'world.scan': {
        const x1 = Math.min(this.num(p, 'x1'), this.num(p, 'x2'))
        const x2 = Math.max(this.num(p, 'x1'), this.num(p, 'x2'))
        const z1 = Math.min(this.num(p, 'z1'), this.num(p, 'z2'))
        const z2 = Math.max(this.num(p, 'z1'), this.num(p, 'z2'))
        if (x2 - x1 + 1 > 64 || z2 - z1 + 1 > 64) throw new RpcError('too_large', 'at most 64x64 columns')
        const heights: number[][] = []
        const tops: number[][] = []
        for (let z = z1; z <= z2; z++) {
          const hr: number[] = []
          const tr: number[] = []
          for (let x = x1; x <= x2; x++) {
            // 一个固定的小地形：大部分是 y=64 的草地，一个小土包，角上一格水
            const hill = Math.max(0, 3 - Math.floor(Math.hypot(x - (x1 + 4), z - (z1 + 4))))
            const pond = x === x2 && z === z2
            hr.push(pond ? 63 : 64 + hill)
            tr.push(pond ? 1 : 0)
          }
          heights.push(hr)
          tops.push(tr)
        }
        const flat = heights.flat()
        return {
          x1,
          z1,
          x2,
          z2,
          heights,
          tops,
          palette: ['minecraft:grass', 'minecraft:water'],
          liquidPalette: [1],
          stats: { minY: Math.min(...flat), maxY: Math.max(...flat), modeY: 64, meanY: flat.reduce((a, b) => a + b, 0) / flat.length, columns: flat.length, unloaded: 0 },
          liquidColumns: 1,
          tileEntities: this.containers.filter((c) => c.x >= x1 && c.x <= x2 && c.z >= z1 && c.z <= z2).map((c) => ({ x: c.x, y: c.y, z: c.z, id: c.id })),
        }
      }
      case 'world.blocks': {
        // 一个盒子里的全部方块：调色板加“下标, 连续几格”，x 最快、其次 z、最后 y；没加载的格子记成 {id:"?"}
        const lo = (a: string, b: string): number => Math.min(this.num(p, a), this.num(p, b))
        const hi = (a: string, b: string): number => Math.max(this.num(p, a), this.num(p, b))
        const [x1, y1, z1, x2, y2, z2] = [lo('x1', 'x2'), lo('y1', 'y2'), lo('z1', 'z2'), hi('x1', 'x2'), hi('y1', 'y2'), hi('z1', 'z2')]
        const [sx, sy, sz] = [x2 - x1 + 1, y2 - y1 + 1, z2 - z1 + 1]
        if (sx > 64 || sy > 64 || sz > 64) throw new RpcError('too_large', 'at most 64 blocks along each side')
        const palette: { id: string; meta?: number }[] = [{ id: 'minecraft:air', meta: 0 }]
        const index = new Map<string, number>([['minecraft:air/0', 0]])
        const runs: number[] = []
        let unloaded = 0
        for (let y = y1; y <= y2; y++) {
          for (let z = z1; z <= z2; z++) {
            for (let x = x1; x <= x2; x++) {
              const block = this.blockAt(x, y, z) as { loaded?: boolean; id?: string; meta?: number }
              const entry = block.loaded === false ? { id: '?' } : { id: block.id ?? 'minecraft:air', meta: block.meta ?? 0 }
              if (block.loaded === false) unloaded++
              const key = `${entry.id}/${entry.meta ?? ''}`
              let at = index.get(key)
              if (at === undefined) {
                at = palette.push(entry) - 1
                index.set(key, at)
              }
              if (runs.length > 0 && runs[runs.length - 2] === at) runs[runs.length - 1]!++
              else runs.push(at, 1)
            }
          }
        }
        return { x: x1, y: y1, z: z1, sx, sy, sz, palette, runs, unloaded }
      }
      case 'world.find': {
        const c = this.center(p)
        const wanted = Array.isArray(p.blocks) ? (p.blocks as string[]) : []
        const matches = [
          ...this.containers.map((box) => ({ x: box.x, y: box.y, z: box.z, id: box.id, meta: 3 })),
          ...this.craftingTables.map((t) => ({ ...t, id: 'minecraft:crafting_table', meta: 0 })),
        ]
          .filter((b) => wanted.includes(b.id))
          .map((b) => ({ ...b, dist: Math.hypot(b.x - c.x, b.y - c.y, b.z - c.z) }))
          .sort((a, b) => a.dist - b.dist)
        return { matches, total: matches.length }
      }
      case 'world.containers': {
        const c = this.center(p)
        const offset = Math.max(0, typeof p.offset === 'number' ? p.offset : 0)
        const limit = Math.max(1, Math.min(100, typeof p.limit === 'number' ? p.limit : 40))
        const controller = this.containers.find((x) => x.kind === 'drawer_controller')
        const drawers = this.containers.filter((x) => x.kind === 'drawers')
        // 由近到远；抽屉带 kind:"drawers"，普通箱子没有这一项；抽屉管理器自己不装东西
        const containers = [...this.containers]
          .sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z) - Math.hypot(b.x - c.x, b.y - c.y, b.z - c.z))
          .map((box) => ({
            x: box.x,
            y: box.y,
            z: box.z,
            id: box.id,
            name: box.name,
            slots: box.kind === 'drawer_controller' ? drawers.reduce((n, d) => n + d.slots, 0) : box.slots,
            usedSlots: box.kind === 'drawer_controller' ? drawers.reduce((n, d) => n + d.items.length, 0) : box.items.length,
            items: box.kind === 'drawer_controller' ? [] : box.items,
            ...(box.kind ? { kind: box.kind } : {}),
            ...(box.kind === 'drawer_controller' ? { drawers: drawers.length } : {}),
            ...(box.kind === 'drawers' && controller ? { controller: { x: controller.x, y: controller.y, z: controller.z } } : {}),
            ...(box.attached ? { attached: box.attached } : {}),
            ...attachments(box),
          }))
        // 原料格里放着东西的机器也是容器（原料格、产物格不分，合在一起列）；带覆盖板、带罐的机器也列，覆盖板和罐照样带着
        const machines = this.machines.filter((m) => m.inputs !== undefined || m.covers !== undefined || m.tanks !== undefined).map((m) => ({ ...attachments(m), x: m.x, y: m.y, z: m.z, id: m.id ?? 'gregtech:gt.blockmachines', name: m.name, kind: 'machine', slots: m.inputSlots + 1, usedSlots: (m.inputs ?? []).length, items: m.inputs ?? [] }))
        const merge = (slots: MockDevice['slots']): { id: string; meta: number; count: number; name: string }[] => slots.filter((x) => x.item && x.kind !== 'ghost').map((x) => ({ ...x.item! }))
        const devices = this.devices.map((d) => ({ x: d.x, y: d.y, z: d.z, id: d.id, name: d.name, slots: d.slots.length, usedSlots: merge(d.slots).length, items: merge(d.slots) }))
        // 和真的身体一样：以中心为心、每个方向 radius 格的立方体里的才算（radius 0 就是中心那一格上的那个容器）
        const radius = Math.max(0, typeof p.radius === 'number' ? p.radius : 12)
        if (radius > 32) throw new RpcError('too_large', 'radius is limited to 32')
        const all = [...containers, ...machines, ...devices].filter((box) => Math.max(Math.abs(box.x - c.x), Math.abs(box.y - c.y), Math.abs(box.z - c.z)) <= radius)
        // 每个容器最多列 kinds 种（默认 60），没列的记在 moreKinds 里
        const kinds = Math.max(1, Math.min(2000, typeof p.kinds === 'number' ? p.kinds : 60))
        const listed = all.slice(offset, offset + limit).map((box) => (box.items.length > kinds ? { ...box, items: box.items.slice(0, kinds), moreKinds: box.items.length - kinds } : box))
        // total 是范围里的总数，containers 只是从 offset 起的一页
        return { containers: listed, total: all.length, offset }
      }
      case 'world.drawers': {
        // 一个抽屉管理器管着的全部抽屉，逐格列出；给的位置是普通抽屉时只有它自己
        const at = { x: this.num(p, 'x'), y: this.num(p, 'y'), z: this.num(p, 'z') }
        const here = this.containers.find((box) => box.x === at.x && box.y === at.y && box.z === at.z)
        if (!here || (here.kind !== 'drawers' && here.kind !== 'drawer_controller')) throw new RpcError('bad_request', 'there are no drawers at that position')
        const managed = here.kind === 'drawer_controller' ? this.containers.filter((box) => box.kind === 'drawers') : [here]
        const below = typeof p.below === 'number' ? p.below : undefined
        const slots: Json[] = []
        let slotsTotal = 0
        let slotsUsed = 0
        for (const box of managed) {
          slotsTotal += box.slots
          slotsUsed += box.items.length
          box.items.forEach((item, slot) => {
            // front / hit：玩家点这一格时点的面和位置（这里的抽屉都朝南，一个方块里的几格从上往下排）
            const hit = { x: 0.5, y: Math.round((1 - (slot + 0.5) / box.slots) * 100) / 100, z: 1 }
            if (below === undefined || item.count < below) slots.push({ x: box.x, y: box.y, z: box.z, slot, id: item.id, meta: item.meta, name: item.name, count: item.count, room: Math.max(0, 2048 - item.count), front: 'south', hit })
          })
          // 没指定物品的空格（只在不筛数量时列）
          if (below === undefined) for (let slot = box.items.length; slot < box.slots; slot++) slots.push({ x: box.x, y: box.y, z: box.z, slot, empty: true })
        }
        const offset = Math.max(0, typeof p.offset === 'number' ? p.offset : 0)
        const limit = Math.max(1, Math.min(500, typeof p.limit === 'number' ? p.limit : 200))
        return {
          ...(here.kind === 'drawer_controller' ? { controller: at } : {}),
          drawers: managed.length,
          slotsTotal,
          slotsUsed,
          slots: slots.slice(offset, offset + limit),
          total: slots.length,
          offset,
        }
      }
      case 'world.player': {
        const name = String(p.name ?? '')
        const view = this.playerView(name)
        if (!view) throw new RpcError('not_found', `player ${name} is not online`)
        return { name: this.players.find((pl) => pl.name.toLowerCase() === name.toLowerCase())!.name, isBot: false, ...view }
      }
      case 'item.search': {
        this.requireRecipes()
        const query = String(p.query ?? '').trim().toLowerCase()
        if (query.length < 2) throw new RpcError('bad_request', 'query needs at least two characters')
        const limit = Math.max(1, Math.min(40, typeof p.limit === 'number' ? p.limit : 12))
        const words = query.split(/\s+/)
        // 名字或 id 里包含 query 的每个词；名字完全一样的最前，其次是以它开头的，做得出来的排在做不出来的前面
        const hits = this.recipeBook
          .filter((e) => words.every((w) => e.name.toLowerCase().includes(w) || e.id.toLowerCase().includes(w)))
          .map((e) => {
            const lower = e.name.toLowerCase()
            const made = (e.crafting?.length ?? 0) + (e.machines?.length ?? 0) + (e.smeltedFrom?.length ?? 0) > 0
            return { e, score: (lower === query ? 0 : (lower.startsWith(query) ? 1000 : 2000) + lower.length) + (made ? 0 : 500) }
          })
          .sort((a, b) => a.score - b.score)
          .slice(0, limit)
        return {
          items: hits.map(({ e }) => ({
            id: e.id,
            meta: e.meta,
            name: e.name,
            recipes: { crafting: e.crafting?.length ?? 0, machine: e.machines?.length ?? 0, smelting: e.smeltedFrom?.length ?? 0 },
            ...(e.ores && e.ores.length > 0 ? { ores: e.ores } : {}),
          })),
        }
      }
      case 'recipe.find': {
        this.requireRecipes()
        const meta = typeof p.meta === 'number' ? Math.max(0, p.meta) : 0
        const entry = this.recipeEntry(p.id, meta)
        if (!entry) throw new RpcError('not_found', `no such item is known: ${String(p.id)}/${meta}; item.search finds ids`)
        // 带了 bot 时它必须在线，原料里有它身上现有的数量
        const bot = p.bot !== undefined ? this.onlineBot(p.bot) : undefined
        const craftingLimit = Math.max(0, Math.min(12, typeof p.crafting === 'number' ? p.crafting : 4))
        const machineLimit = Math.max(0, Math.min(24, typeof p.machines === 'number' ? p.machines : 8))
        const filter = typeof p.machine === 'string' && p.machine.trim().length > 0 ? p.machine.trim().toLowerCase() : undefined
        const crafting = (entry.crafting ?? []).slice(0, craftingLimit).map((r, index) =>
          r.unreadable
            ? { index, gives: r.gives, unreadable: true }
            : { index, gives: r.gives, grid: r.grid, ingredients: r.ingredients.map((ing) => this.ingredientJson(ing, ing.count, bot)) },
        )
        // 每种机器先各列两条；指定了 machine 就只列那种机器的
        const all = [...(entry.machines ?? [])].sort((a, b) => Number(a.eut) - Number(b.eut) || Number(a.seconds) - Number(b.seconds))
        const perMachine: Record<string, number> = {}
        for (const m of all) perMachine[String(m.machine)] = (perMachine[String(m.machine)] ?? 0) + 1
        const shown: Record<string, number> = {}
        const machines: Json[] = []
        for (const m of all) {
          const name = String(m.machine)
          if (machines.length >= machineLimit) break
          if (filter !== undefined && !name.toLowerCase().includes(filter)) continue
          if (filter === undefined && (shown[name] = (shown[name] ?? 0) + 1) > 2) continue
          machines.push(m)
        }
        return {
          item: { id: entry.id, meta: entry.meta, name: entry.name },
          crafting,
          machines,
          ...(all.length > 0 ? { machineRecipeCounts: perMachine } : {}),
          ...(entry.smeltedFrom && entry.smeltedFrom.length > 0 ? { smeltedFrom: entry.smeltedFrom.slice(0, 6) } : {}),
          total: { crafting: entry.crafting?.length ?? 0, machines: all.length, smelting: entry.smeltedFrom?.length ?? 0 },
        }
      }
      case 'world.machines': {
        const c = this.center(p)
        const radius = Math.max(1, typeof p.radius === 'number' ? p.radius : 32)
        if (radius > 64) throw new RpcError('too_large', 'radius is limited to 64')
        const want = typeof p.name === 'string' && p.name.trim().length > 0 ? p.name.trim().toLowerCase() : undefined
        const limit = Math.max(1, Math.min(60, typeof p.limit === 'number' ? p.limit : 30))
        // 由近到远；name 给了就只列名字或配方种类里含它的
        const found = this.machines
          .filter((m) => Math.max(Math.abs(m.x - c.x), Math.abs(m.y - c.y), Math.abs(m.z - c.z)) <= radius)
          .filter((m) => want === undefined || `${m.name} ${m.recipes}`.toLowerCase().includes(want))
          .map((m) => ({ ...describeMachine(m), dist: Math.round(Math.hypot(m.x - c.x, m.y - c.y, m.z - c.z) * 10) / 10 }))
          .sort((a, b) => a.dist - b.dist)
        return { machines: found.slice(0, limit), total: found.length }
      }
      case 'world.stock': {
        const c = this.center(p)
        const wanted = Array.isArray(p.items) ? (p.items as Json[]) : []
        if (wanted.length === 0 || wanted.length > 24) throw new RpcError('bad_request', 'items must list 1 to 24 items')
        const radius = Math.max(1, typeof p.radius === 'number' ? p.radius : 32)
        if (radius > 64) throw new RpcError('too_large', 'radius is limited to 64')
        const near = this.containers.filter((box) => Math.max(Math.abs(box.x - c.x), Math.abs(box.y - c.y), Math.abs(box.z - c.z)) <= radius)
        const items = wanted.map((want) => {
          const ore = typeof want.ore === 'string' ? want.ore : undefined
          const id = String(want.id ?? '')
          const meta = typeof want.meta === 'number' ? want.meta : undefined
          const matches = (i: { id: string; meta: number }) => (ore !== undefined ? this.hasOre(i, ore) : i.id === id && (meta === undefined || i.meta === meta))
          const places: (Json & { count: number })[] = near
            .map((box) => ({ box, found: box.items.filter((i) => matches(i) && i.count > 0) }))
            .filter((x) => x.found.length > 0)
            .map(({ box, found }) => ({
              x: box.x,
              y: box.y,
              z: box.z,
              container: box.name,
              ...(box.kind ? { kind: box.kind } : {}),
              count: found.reduce((n, i) => n + i.count, 0),
              // 按矿辞名或不带 meta 查时，说清这一处具体是哪几种
              ...(ore !== undefined || meta === undefined ? { items: found.slice(0, 4).map((i) => ({ id: i.id, meta: i.meta, count: i.count, name: i.name })) } : {}),
            }))
            .sort((a, b) => b.count - a.count)
          // 机器各个面上能装东西的覆盖板：里面的东西也算存货，那个存放点带 kind:"cover"、覆盖板的名字和哪个面
          for (const m of this.machines) {
            if (Math.max(Math.abs(m.x - c.x), Math.abs(m.y - c.y), Math.abs(m.z - c.z)) > radius) continue
            for (const cover of m.covers ?? []) {
              const found = (cover.items ?? []).filter((i) => matches(i) && i.count > 0)
              if (found.length === 0) continue
              places.push({
                x: m.x,
                y: m.y,
                z: m.z,
                container: m.name,
                kind: 'cover',
                cover: cover.name,
                side: cover.side,
                count: found.reduce((n, i) => n + i.count, 0),
                ...(ore !== undefined || meta === undefined ? { items: found.slice(0, 4).map((i) => ({ id: i.id, meta: i.meta, count: i.count, name: i.name })) } : {}),
              })
            }
          }
          places.sort((a, b) => b.count - a.count)
          return {
            ...(ore !== undefined ? { ore } : meta === undefined ? { id } : { id, meta }),
            total: places.reduce((n, pl) => n + pl.count, 0),
            places: places.slice(0, 6),
            ...(places.length > 6 ? { morePlaces: places.length - 6 } : {}),
          }
        })
        return { items, containersLookedInto: near.length }
      }
      case 'quest.progress': {
        // 谁做完了哪些任务。任务的内容大脑自己有（本地资料），所以这里只有 id。
        this.quests()
        if (typeof p.player !== 'string' || p.player.length === 0) throw new RpcError('bad_request', 'missing or non-text field: player')
        const key = p.player.toLowerCase()
        const known = this.questProgress.get(key)
        const online = this.players.some((pl) => pl.name.toLowerCase() === key) || [...this.bots.values()].some((b) => b.online && b.name.toLowerCase() === key)
        // 从没上过线的玩家不是错误：没有做完的任务，并带 known:false
        if (!known && !online) return { player: p.player, completed: [], known: false }
        const completed = [...(known?.complete ?? [])]
        // 做完了、有奖励、还没领的
        const withReward = new Set(this.quests().filter((q) => q.rewards.length > 0).map((q) => q.id))
        return { player: p.player, completed, unclaimed: completed.filter((id) => withReward.has(id) && !known?.claimed.has(id)) }
      }
      case 'quest.lines': {
        const book = this.quests()
        const who = this.questPlayer(p.player)
        const lines: Json[] = []
        for (const name of new Set(book.map((q) => q.line))) {
          const inLine = book.filter((q) => q.line === name)
          const states = inLine.map((q) => this.questState(q, who))
          lines.push({
            name,
            quests: inLine.length,
            // complete / available 只在给了 player 时有
            ...(who ? { complete: states.filter((st) => st?.startsWith('complete')).length, available: states.filter((st) => st === 'available').length } : {}),
          })
        }
        return { lines, quests: book.length }
      }
      case 'quest.search': {
        const book = this.quests()
        const state = typeof p.state === 'string' ? p.state : undefined
        if (state !== undefined && !['available', 'complete', 'locked'].includes(state)) throw new RpcError('bad_request', 'state must be available, complete or locked')
        const who = this.questPlayer(p.player)
        if (state !== undefined && !who) throw new RpcError('bad_request', 'state needs a player')
        const words = typeof p.query === 'string' && p.query.trim().length > 0 ? p.query.trim().toLowerCase().split(/\s+/) : []
        const line = typeof p.line === 'string' ? p.line.trim().toLowerCase() : undefined
        const limit = Math.max(1, Math.min(60, typeof p.limit === 'number' ? p.limit : 20))
        const hits: { q: MockQuest; st: string | undefined; score: number }[] = []
        for (const q of book) {
          if (line !== undefined && !q.line.toLowerCase().includes(line)) continue
          const st = this.questState(q, who)
          if (state !== undefined && !st?.startsWith(state)) continue
          const title = q.name.toLowerCase()
          const text = q.description.toLowerCase()
          if (!words.every((w) => title.includes(w) || text.includes(w))) continue
          // 只在说明里出现的词，比标题里出现的排得靠后
          hits.push({ q, st, score: words.filter((w) => !title.includes(w)).length * 10 + (words.length > 0 ? Math.floor(title.length / 8) : 0) })
        }
        hits.sort((a, b) => a.score - b.score)
        return {
          quests: hits.slice(0, limit).map(({ q, st }) => ({ id: q.id, name: q.name, line: q.line, ...(st !== undefined ? { state: st } : {}) })),
          total: hits.length,
        }
      }
      case 'quest.get': {
        const book = this.quests()
        const id = String(p.id ?? '').trim().toLowerCase()
        if (!/^[0-9a-f]{1,12}$/.test(id) && !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new RpcError('bad_request', `not a quest id: ${String(p.id)}`)
        const q = book.find((x) => x.id === id)
        if (!q) throw new RpcError('not_found', `there is no quest with id ${String(p.id)}`)
        const who = this.questPlayer(p.player)
        const done = who ? who.complete.has(q.id) : undefined
        const st = this.questState(q, who)
        return {
          id: q.id,
          name: q.name,
          line: q.line,
          description: q.description,
          ...(st !== undefined ? { state: st } : {}),
          requires: q.requires
            .map((r) => book.find((x) => x.id === r))
            .filter((r): r is MockQuest => r !== undefined)
            .map((r) => ({ id: r.id, name: r.name, ...(who ? { complete: who.complete.has(r.id) } : {}) })),
          // 这里简化成：任务做完了，它的每个子任务就都算完成
          tasks: q.tasks.map((t) => ({ type: t.type, ...(done !== undefined ? { complete: done } : {}), ...t })),
          rewards: q.rewards,
        }
      }
      case 'blueprint.list':
        return {
          blueprints: [...this.blueprints.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((b) => ('error' in b ? { name: b.name, error: b.error } : { name: b.name, ...describeBlueprint(b) })),
          folder: BLUEPRINT_FOLDER,
        }
      case 'blueprint.read': {
        const name = blueprintName(p.name)
        const file = this.blueprints.get(name)
        if (!file) throw new RpcError('bad_request', `there is no blueprint named "${name}"; blueprint.list shows the ones there are`)
        if ('error' in file) throw new RpcError('bad_request', `blueprint "${name}": ${file.error}`)
        return readBlueprintAnswer(file, p)
      }
      case 'blueprint.check': {
        const plan = this.blueprintPlan(p)
        // 带了 bot 时它必须在线，materials 里有它身上的数量
        const bot = p.bot !== undefined ? this.onlineBot(p.bot) : undefined
        return this.surveyBlueprint(plan, bot, p.layers !== false)
      }
      case 'blueprint.put': {
        const name = blueprintName(p.name)
        if (typeof p.data !== 'string') throw new RpcError('bad_request', 'missing or non-text field: data')
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(p.data)) throw new RpcError('bad_request', 'data must be the file in base64')
        const bytes = Buffer.from(p.data, 'base64')
        if (bytes.length > BLUEPRINT_MAX_BYTES) throw new RpcError('bad_request', `the file is larger than ${BLUEPRINT_MAX_BYTES / 1024} KiB`)
        const blueprint = readSchematic(name, bytes)
        this.blueprints.set(name, blueprint)
        return { name, ...describeBlueprint(blueprint) }
      }
      case 'blueprint.remove':
        return { removed: this.blueprints.delete(blueprintName(p.name)) }
      case 'world.entities': {
        const c = this.center(p)
        const entities = [
          ...[...this.bots.values()].filter((b) => b.online).map((b) => ({ type: 'player', name: b.name, pos: b.pos, dist: Math.hypot(b.pos.x - c.x, b.pos.z - c.z) })),
          ...this.players.map((pl) => ({ type: 'player', name: pl.name, pos: pl.pos, dist: Math.hypot(pl.pos.x - c.x, pl.pos.z - c.z) })),
          { type: 'mob', name: 'Dirt Creeper', pos: { x: 20.5, y: 64, z: 5.5 }, dist: 12 },
          { type: 'item', name: 'Dirt', pos: { x: 11, y: 64, z: -2 }, dist: 1.5, item: { id: 'minecraft:dirt', meta: 0, count: 3, name: 'Dirt' } },
        ]
        return { entities, total: entities.length }
      }
      case 'bot.list':
        return {
          bots: [...this.bots.values()].map((b) => (b.online ? { name: b.name, online: true, dim: b.dim, block: this.blockOf(b), task: b.task } : { name: b.name, online: false })),
        }
      case 'bot.spawn': {
        const name = String(p.name ?? '')
        if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new RpcError('bad_request', 'invalid bot name')
        // 和在这个服务器玩过的真人重名：离线模式下名字就是身份，会接管对方的存档
        if (this.players.some((pl) => pl.name.toLowerCase() === name.toLowerCase())) {
          throw new RpcError('denied', `${name} is the name of a real player on this server`)
        }
        const skin = p.skin as Json | undefined
        if (skin !== undefined && (typeof skin?.value !== 'string' || typeof skin?.signature !== 'string')) {
          throw new RpcError('bad_request', 'skin needs both value and signature')
        }
        const bot = this.bots.get(name) ?? this.addBot(name, false)
        // 真实 mod：已经在线的 bot 不能再 spawn
        if (bot.online) throw new RpcError('bad_request', `bot is already online: ${name}`)
        if (typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') bot.pos = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }
        bot.online = true
        bot.health = 20
        // 欢迎语在 bot.spawned 之前到
        for (const text of JOIN_MESSAGES) this.emit('bot.message', { bot: name, text })
        this.emit('bot.spawned', { bot: name })
        return this.statusOf(bot)
      }
      case 'bot.despawn': {
        const bot = this.onlineBot(p.bot)
        this.interrupt(bot, 'the bot went offline')
        bot.online = false
        this.emit('bot.despawned', { bot: bot.name, reason: 'despawned' })
        return {}
      }
      case 'bot.remove': {
        const bot = this.bot(p.bot)
        if (bot.online) throw new RpcError('bad_request', `bot is online: ${bot.name}`)
        this.bots.delete(bot.name)
        return {}
      }
      case 'screen.open':
        return this.screenOpen(this.onlineBot(p.bot), p)
      case 'screen.look':
        return this.screenLook(this.onlineBot(p.bot))
      case 'screen.click':
        return this.screenClick(this.onlineBot(p.bot), p)
      case 'screen.press':
        return this.screenPress(this.onlineBot(p.bot), p)
      case 'screen.set':
        return this.screenSet(this.onlineBot(p.bot), p)
      case 'screen.close': {
        const bot = this.onlineBot(p.bot)
        const open = this.screens.get(bot.name)
        // 鼠标上还拿着的东西放回背包
        if (open?.cursor) putInInventory(bot, open.cursor, open.cursor.count)
        this.screens.delete(bot.name)
        return {}
      }
      case 'bot.status':
        return this.statusOf(this.bot(p.bot))
      case 'bot.configure': {
        const bot = this.bot(p.bot)
        Object.assign(bot.settings, (p.settings ?? {}) as Json)
        return { settings: bot.settings }
      }
      case 'bot.chat': {
        const bot = this.onlineBot(p.bot)
        this.throttle(bot)
        // 一次最多 1000 字；每一行开头的 / 和空白都被去掉，聊天内容不会被当成指令
        const whole = String(p.message ?? '')
        const message = whole
          .slice(0, 1000)
          .split(/\r?\n/)
          .map((line) => line.replace(/^[\s/]+/, ''))
          .filter((line) => line.length > 0)
          .join(' ')
        this.chatLog.push({ bot: bot.name, message })
        this.emit('chat', { player: bot.name, uuid: `uuid-${bot.name}`, message, isBot: true })
        // 和真的身体一样回话：分成了几行（一行最多 100 字，尽量断在标点或空格后面）、超过 1000 字截掉了多少
        let lines = 0
        for (let rest = message.trim(); rest.length > 0; lines++) {
          let end = Math.min(rest.length, 100)
          if (rest.length > 100) for (let i = 100; i > 60; i--) if ('。！？；，、：）,.!?;:) '.includes(rest[i - 1]!)) { end = i; break }
          rest = rest.slice(end).trim()
        }
        return { lines, ...(whole.length > 1000 ? { cutChars: whole.length - 1000 } : {}) }
      }
      case 'bot.command':
        return { output: this.command(this.onlineBot(p.bot), String(p.command ?? '')) }
      case 'bot.look':
        this.onlineBot(p.bot)
        return {}
      case 'bot.drop':
        this.onlineBot(p.bot)
        return { dropped: 0 }
      case 'bot.keys':
        return { keys: MOCK_KEYS }
      case 'bot.key':
        return this.pressKey(this.onlineBot(p.bot), p)
      case 'bot.probe': {
        const bot = this.onlineBot(p.bot)
        const block = this.blockAt(this.num(p, 'x'), this.num(p, 'y'), this.num(p, 'z'))
        if (block.loaded === false || block.air === true) return { ...block, canDig: false, digTicks: 0, toolSlot: -1, inReach: true, candidates: [] }
        // 石头要匠魂镐；泥土草地徒手也行，有铲子更快
        const stone = block.id === 'minecraft:stone'
        const candidates = [
          { slot: -1, item: 'hand', harvest: !stone, strength: 0.05, ticks: stone ? 0 : 18 },
          ...bot.inventory
            .filter((i) => i.id.startsWith('TConstruct:'))
            .map((i) => {
              const right = stone ? i.id === 'TConstruct:pickaxe' : i.id === 'TConstruct:shovel'
              return { slot: i.slot, item: `${i.id}:0`, harvest: stone ? i.id === 'TConstruct:pickaxe' : true, strength: right ? 0.4 : 0.05, ticks: right ? (stone ? 8 : 3) : stone ? 0 : 18 }
            }),
        ]
        const usable = candidates.filter((c) => c.harvest && c.ticks > 0).sort((a, b) => a.ticks - b.ticks)
        const best = usable[0]
        return { ...block, canDig: best !== undefined, digTicks: best?.ticks ?? 0, toolSlot: best?.slot ?? -1, inReach: true, candidates }
      }
      case 'task.start':
        return this.taskStart(p, after)
      case 'task.cancel': {
        const bot = this.bot(p.bot)
        let ids: string[] = []
        if (typeof p.id === 'string') {
          const queued = bot.queue.find((t) => t.id === p.id)
          if (queued) {
            bot.queue = bot.queue.filter((t) => t !== queued)
            this.finalize(bot, queued, 'canceled', {})
            ids = [queued.id]
          } else if (bot.task?.id === p.id) {
            ids = [bot.task.id]
            this.endTask(bot, bot.task, 'canceled', {})
          }
        } else {
          ids = this.cancelAll(bot)
        }
        // “任务被取消”的事件已经在上面发出去了，响应在它们之后
        return { canceled: ids.length, ids }
      }
      case 'task.list': {
        const bot = this.bot(p.bot)
        return { active: bot.task, queue: bot.queue, recent: bot.recent.slice(0, 10) }
      }
      default:
        throw new RpcError('unknown_method', `unknown method: ${method}`)
    }
  }

  /** 以 bot 身份执行指令。回显既在 output 里，也作为 bot.message 事件发出（事件在响应之前）。 */
  /** 短时间内说话和指令太多：拒绝（真实服务器再多会把它当刷屏踢掉）。 */
  private throttle(bot: MockBot): void {
    const now = Date.now()
    const recent = (this.chatTimes.get(bot.name) ?? []).filter((t) => now - t < CHAT_BURST_WINDOW_MS)
    if (recent.length >= CHAT_BURST) {
      this.chatTimes.set(bot.name, recent)
      throw new RpcError('denied', 'too many chat lines and commands in a short time; try again in a few seconds')
    }
    recent.push(now)
    this.chatTimes.set(bot.name, recent)
  }

  private command(bot: MockBot, command: string): string[] {
    const words = command.trim().split(/\s+/)
    const [verb = '', ...args] = words
    if (command.length > COMMAND_MAX_CHARS) throw new RpcError('bad_request', 'the command is too long for a chat line')
    // 指令必须以允许列表里某一项的全部单词开头
    const allowed = ALLOWED_COMMANDS.some((entry) => {
      const parts = entry.split(' ')
      return parts.every((w, i) => words[i] === w)
    })
    if (!allowed) throw new RpcError('denied', `command is not on the bot allow list: ${words.slice(0, 2).join(' ')}`)
    this.throttle(bot)
    this.commandLog.push({ bot: bot.name, command })
    const output: string[] = []
    if (verb === 'team' && args[0] === 'join' && args[1]) {
      if (this.teamInvites.get(args[1]) === bot.name) output.push(`Joined team '${args[1]}'`)
      else output.push(`Team '${args[1]}' not found!`)
    }
    if (verb === 'sethome' && args[0]) {
      if (!bot.homes.includes(args[0])) bot.homes.push(args[0])
      output.push(`Home '${args[0]}' set!`)
    } else if (verb === 'home' && args[0] === 'list') {
      output.push(`${bot.name}: ${bot.homes.length} / 99: ${bot.homes.join(', ')}`)
    } else if (verb === 'delhome' && args[0]) {
      const had = bot.homes.includes(args[0])
      bot.homes = bot.homes.filter((h) => h !== args[0])
      output.push(had ? `Home '${args[0]}' deleted!` : `Unknown Home: '${args[0]}'!`)
    } else if ((verb === 'tell' || verb === 'msg' || verb === 'w') && args[0]) {
      const target = args[0]
      const text = args.slice(1).join(' ')
      const otherBot = [...this.bots.values()].find((b) => b.online && b.name === target)
      if (otherBot || this.players.some((pl) => pl.name === target)) {
        if (otherBot) this.emit('whisper', { bot: otherBot.name, from: bot.name, message: text })
        output.push(`You whisper to ${target}: ${text}`)
      } else {
        output.push('That player cannot be found')
      }
    } else if (verb === 'homes') {
      output.push('Unknown command at position 0: <--[HERE]')
    }
    for (const text of output) this.emit('bot.message', { bot: bot.name, text })
    return output
  }

  // ── 任务 ──

  private taskStart(p: Json, after: (() => void)[]): unknown {
    const bot = this.bot(p.bot)
    if (!bot.online) throw new RpcError('offline', `bot is offline: ${bot.name}`)
    const spec = (p.task ?? {}) as Json
    const type = String(spec.type ?? '')
    if (!TASK_TYPES.has(type)) throw new RpcError('bad_request', `unknown task type: ${type}`)
    if (type === 'goto') {
      this.num(spec, 'x')
      this.num(spec, 'z')
    }
    if (type === 'process') {
      if (positions(spec.machine).length === 0) throw new RpcError('bad_request', 'missing or non-numeric field: machine')
      const inputs = Array.isArray(spec.inputs) ? (spec.inputs as Json[]) : []
      if (inputs.length === 0 || inputs.length > 9) throw new RpcError('bad_request', 'inputs must list 1 to 9 items')
      if (inputs.some((i) => typeof i.count !== 'number' || i.count <= 0)) throw new RpcError('bad_request', 'each input needs a count')
    }
    if (type === 'use') {
      // 手里拿着 item（不给就是空手，这时必须给 on）；可以指定点哪个面、点哪一点、连点几下
      const item = spec.item as Json | undefined
      if (item !== undefined && (item === null || typeof item !== 'object' || typeof item.id !== 'string')) throw new RpcError('bad_request', 'item must be {id, meta?}')
      if (item === undefined && positions(spec.on).length === 0) throw new RpcError('bad_request', 'an empty hand needs a block to click: give on')
      if (spec.side !== undefined && !['down', 'up', 'north', 'south', 'west', 'east'].includes(String(spec.side))) throw new RpcError('bad_request', 'side must be one of down, up, north, south, west, east')
      if (spec.times !== undefined && (typeof spec.times !== 'number' || spec.times < 1 || spec.times > 64)) throw new RpcError('bad_request', 'times must be 1 to 64')
    }
    if (type === 'hold' && (typeof spec.ticks !== 'number' || spec.ticks < 1 || spec.ticks > 1200)) {
      throw new RpcError('bad_request', 'ticks is how long to hold the keys: 1 to 1200 (20 make a second)')
    }
    if ((type === 'deposit' || type === 'withdraw') && (spec.container as Json | undefined)?.item !== undefined) {
      // 随身的包当容器：{item:{id, meta?}}；往里放必须列出放什么
      const item = (spec.container as Json).item as Json | null
      if (item === null || typeof item !== 'object' || typeof item.id !== 'string') throw new RpcError('bad_request', 'container.item must be {id, meta?}')
      if (type === 'deposit' && !(Array.isArray(spec.items) && spec.items.length > 0)) throw new RpcError('bad_request', 'items must list what goes into the bag')
    }
    if (type === 'craft' && spec.grid !== undefined) {
      // 调用方把摆法说出来的写法：3×3 一行一行数的 9 格
      if (!Array.isArray(spec.grid) || spec.grid.length !== 9) throw new RpcError('bad_request', 'grid must list the 9 cells of a 3x3 grid, row by row')
      if (spec.grid.every((cell) => cell === null)) throw new RpcError('bad_request', 'the grid is empty')
    } else if (type === 'craft' && !this.recipeBook.some((e) => e.id === spec.id)) {
      throw new RpcError('bad_request', `unknown item id: ${String(spec.id)}`)
    }
    if (type === 'blueprint') {
      // 和真实 mod 一样：参数不对、没有这张图纸、范围超过 64×64 列，都在启动时就以 bad_request 拒绝
      const plan = this.blueprintPlan(spec)
      const wide = plan.x2 - plan.x1 + 1
      const deep = plan.z2 - plan.z1 + 1
      if (wide > BLUEPRINT_MAX_SIDE || deep > BLUEPRINT_MAX_SIDE) {
        throw new RpcError(
          'bad_request',
          `one task works on at most ${BLUEPRINT_MAX_SIDE}x${BLUEPRINT_MAX_SIDE} columns and this covers ${wide}x${deep}; give x1, x2, z1, z2 to take it a part at a time`,
        )
      }
    }
    if (p.mode === 'append' && bot.task && bot.queue.length >= MAX_QUEUE) {
      throw new RpcError('too_large', `at most ${MAX_QUEUE} tasks may wait in the queue`)
    }
    const task: MockTask = {
      id: `t${this.nextTask++}`,
      type,
      params: { ...spec },
      // 响应里总是 queued；真正开始时另发一个 running 的 task.update
      state: 'queued',
      progress: { done: 0, total: 100, phase: '', note: '' },
      createdAt: Date.now(),
    }
    let replaced: string[] = []
    if (p.mode === 'append') {
      if (bot.task) {
        bot.queue.push(task)
      } else {
        bot.task = task
        after.push(() => this.run(bot, task))
      }
    } else {
      // 被顶掉的任务的 canceled 事件在响应之前发出
      replaced = this.cancelAll(bot)
      bot.task = task
      after.push(() => this.run(bot, task))
    }
    return { task: { ...task }, replaced }
  }

  private markRunning(bot: MockBot, task: MockTask): void {
    if (task.state !== 'queued') return
    task.state = 'running'
    task.startedAt = Date.now()
    this.emit('task.update', { bot: bot.name, task: { ...task } })
  }

  /** 任务开始执行：发 running；有些任务像真实 mod 那样立刻就有结果。 */
  private run(bot: MockBot, task: MockTask): void {
    if (bot.task !== task || task.state !== 'queued') return
    bot.task = task
    const p = task.params

    // 一开始就注定失败的任务。真实 mod 这时会连发两次 failed 的 task.update，第一次没有 finishedAt。
    const doomed = this.failsAtOnce(bot, task)
    if (doomed) {
      task.state = 'failed'
      task.startedAt = Date.now()
      task.error = doomed.error
      task.result = doomed.result
      this.emit('task.update', { bot: bot.name, task: { ...task } })
      this.endTask(bot, task, 'failed', doomed)
      return
    }
    this.markRunning(bot, task)

    if (task.type === 'home') {
      const name = String(p.name ?? '')
      if (!bot.homes.includes(name)) {
        const message = `Unknown Home: '${name}'!`
        this.emit('bot.message', { bot: bot.name, text: message })
        this.endTask(bot, task, 'failed', { error: { code: 'invalid', message }, result: { dim: bot.dim, block: this.blockOf(bot) } })
        return
      }
    }
    if (task.type === 'withdraw' || task.type === 'deposit') {
      const at = (p.container ?? {}) as Json
      // 容器是一个位置，或者“身上这件东西右键打开的界面”（随身的包）
      const opener = at.item as { id: string; meta?: number } | undefined
      let box: { items: { id: string; meta: number; count: number; name: string }[]; kind?: string; slots?: number } | undefined
      if (opener) {
        if (!bot.inventory.some((i) => i.id === opener.id && (typeof opener.meta !== 'number' || i.meta === opener.meta))) {
          this.endTask(bot, task, 'failed', { error: { code: 'no_material', message: 'the bot carries no such item to open' } })
          return
        }
        const inside = this.bags.get(opener.id)
        if (!inside) {
          this.endTask(bot, task, 'failed', { error: { code: 'invalid', message: 'using that item opened no screen; it may be something to place or to wear instead' } })
          return
        }
        box = { items: inside }
      } else if (typeof at.side === 'string') {
        // 点那个面（蹲着）：打开的是那个面上覆盖板自己的界面，往它里面存取。没蹲、或者那个面没有能装东西的覆盖板，就没有界面可用
        const owner = this.machines.find((m) => m.x === at.x && m.y === at.y && m.z === at.z)
        const cover = at.sneak === true ? owner?.covers?.find((cv) => cv.side === at.side && cv.slots !== undefined) : undefined
        if (!cover) {
          this.endTask(bot, task, 'failed', { error: { code: 'invalid', message: `clicking the ${String(at.side)} face${at.sneak === true ? ' while sneaking' : ''} opened no screen that holds items` } })
          return
        }
        box = { items: (cover.items ??= []), kind: 'machine', slots: cover.slots! }
      } else {
        box = this.containers.find((c) => c.x === at.x && c.y === at.y && c.z === at.z)
        // GregTech 机器：放是放进原料格；取默认只从产物格取（process 不带 leave 时做完就取空了，带 leave 的产物留在里面），fromInputs 才从原料格取
        const machine = box ? undefined : this.machines.find((m) => m.x === at.x && m.y === at.y && m.z === at.z)
        if (machine) box = task.type === 'deposit' || p.fromInputs === true ? { items: (machine.inputs ??= []), kind: 'machine', slots: machine.inputSlots } : { items: (machine.outputs ??= []) }
        // 身体不认识的机器：界面里有“放不进东西的格子”的就是机器——取默认只取这些产物格，fromInputs 取其余的；放是放进能放的格子
        const device = box ? undefined : this.devices.find((d) => d.x === at.x && d.y === at.y && d.z === at.z)
        if (device) {
          this.endTask(bot, task, 'done', { result: task.type === 'deposit' ? this.deviceDeposit(bot, device, (Array.isArray(p.items) ? p.items : []) as Json[]) : this.deviceWithdraw(bot, device, (Array.isArray(p.items) ? p.items : []) as Json[], p.fromInputs === true) })
          return
        }
      }
      if (!box) {
        this.endTask(bot, task, 'failed', { error: { code: 'invalid', message: 'there is no container at that position' } })
        return
      }
      if (task.type === 'deposit') {
        // 东西真的从背包挪进容器。不给 items：除工具（带耐久的）、食物和 keep 以外的全部；包本身不会被放进它自己里面
        const keep = new Set((Array.isArray(p.keep) ? p.keep : []) as string[])
        const isBag = (i: MockItem): boolean => opener !== undefined && i.id === opener.id
        const wanted: Json[] = Array.isArray(p.items)
          ? (p.items as Json[])
          : bot.inventory.filter((i) => i.durability === undefined && this.usable.get(i.id)?.food === undefined && !keep.has(i.id)).map((i) => ({ id: i.id, meta: i.meta }))
        let moved = 0
        let full = false
        for (const want of wanted) {
          const fits = (i: MockItem): boolean => i.id === want.id && (typeof want.meta !== 'number' || i.meta === want.meta) && !isBag(i)
          const have = bot.inventory.filter(fits).reduce((n, i) => n + i.count, 0)
          for (const got of takeItems(bot.inventory, fits, typeof want.count === 'number' ? want.count : have)) {
            const stack = box.items.find((i) => i.id === got.id && i.meta === got.meta)
            // 抽屉：只收已经装着的那几种，或者放进还没指定物品的空格
            if (!stack && (box.kind === 'drawers' || box.kind === 'machine') && box.items.length >= (box.slots ?? 0)) {
              putInInventory(bot, got, got.count)
              full = true
              continue
            }
            if (stack) stack.count += got.count
            else box.items.push(got)
            moved += got.count
          }
        }
        bot.inventory = bot.inventory.filter((i) => i.count > 0)
        const result = { moved, freeSlots: 36 - bot.inventory.length }
        if (full && moved === 0) this.endTask(bot, task, 'failed', { error: { code: 'container_full', message: 'the container has no room for these items' }, result })
        else this.endTask(bot, task, 'done', { result })
        return
      }
      if (task.type === 'withdraw') {
        // 东西真的从箱子（或抽屉）挪到背包里。箱子里不够的部分记在 missing 里，任务照样是 done
        const missing: Json[] = []
        let moved = 0
        for (const want of (Array.isArray(p.items) ? p.items : []) as Json[]) {
          const fits = (i: { id: string; meta: number }) => i.id === want.id && (typeof want.meta !== 'number' || i.meta === want.meta)
          const have = box.items.filter(fits).reduce((n, i) => n + i.count, 0)
          const count = typeof want.count === 'number' ? want.count : have
          for (const got of takeItems(box.items, fits, count)) {
            putInInventory(bot, got, got.count)
            moved += got.count
          }
          if (have < count) missing.push({ id: want.id, ...(typeof want.meta === 'number' ? { meta: want.meta } : {}), count: count - have })
        }
        // 原地清掉拿空了的（包里的东西和 bags 里记的是同一个数组）
        for (let n = box.items.length - 1; n >= 0; n--) if (box.items[n]!.count <= 0) box.items.splice(n, 1)
        this.endTask(bot, task, 'done', { result: missing.length > 0 ? { moved, missing } : { moved } })
        return
      }
    }
    if (task.type === 'use') {
      // 把身上的一件东西拿到手里（或者空手）右键：结果只报看得见的变化，加上点了几下、点的哪个面
      const want = p.item as { id: string; meta?: number } | undefined
      const on = positions(p.on)[0]
      const clicks = typeof p.times === 'number' ? p.times : 1
      const clicked = on ? { clicks, side: typeof p.side === 'string' ? p.side : 'north' } : { clicks }
      if (!want) {
        this.clickLog.push({ bot: bot.name, on: on!, ...clicked, ...(p.hit !== undefined ? { hit: p.hit as Json } : {}) })
        this.endTask(bot, task, 'done', { result: { used: 'an empty hand', gained: [], lost: [], ...clicked, health: bot.health, food: bot.food, freeSlots: 36 - bot.inventory.length } })
        return
      }
      const held = bot.inventory.find((i) => i.id === want.id && (typeof want.meta !== 'number' || i.meta === want.meta))
      if (!held) {
        this.endTask(bot, task, 'failed', { error: { code: 'no_material', message: 'the bot carries no such item' } })
        return
      }
      // 对着抽屉右键：第一下把手里这一组放进去，紧接着的第二下是“双击”，身上所有同类的都放进去
      const drawer = on ? this.containers.find((box) => box.kind === 'drawers' && box.x === on.x && box.y === on.y && box.z === on.z) : undefined
      if (drawer) {
        const moved = clicks >= 2 ? held.count : Math.min(64, held.count)
        const slot = drawer.items.find((i) => i.id === held.id && i.meta === held.meta)
        if (slot) slot.count += moved
        else drawer.items.push({ id: held.id, meta: held.meta, name: held.name, count: moved })
        held.count -= moved
        bot.inventory = bot.inventory.filter((i) => i.count > 0)
        this.endTask(bot, task, 'done', { result: { used: held.name, gained: [], lost: [{ id: held.id, meta: held.meta, name: held.name, count: moved }], ...clicked, health: bot.health, food: bot.food, freeSlots: 36 - bot.inventory.length } })
        return
      }
      if (on) this.clickLog.push({ bot: bot.name, on, item: held.id, ...clicked, ...(p.hit !== undefined ? { hit: p.hit as Json } : {}) })
      const effect = this.usable.get(held.id) ?? {}
      const lost: Json[] = []
      if (effect.food !== undefined || effect.wear === true) {
        held.count -= 1
        lost.push({ id: held.id, meta: held.meta, name: held.name, count: 1 })
        if (effect.food !== undefined) bot.food = Math.min(20, bot.food + effect.food)
        bot.inventory = bot.inventory.filter((i) => i.count > 0)
      }
      this.endTask(bot, task, 'done', {
        result: { used: held.name, gained: [], lost, ...(this.bags.has(held.id) ? { openedScreen: true } : {}), ...clicked, health: bot.health, food: bot.food, freeSlots: 36 - bot.inventory.length },
      })
      return
    }
    if (task.type === 'craft') {
      // 配方读不了、材料不够、要工作台而附近没有：真实 mod 在第一刻就失败。grid 写法（调用方给摆法）走它自己的那套检查
      const plan = Array.isArray(p.grid) ? this.craftGrid(bot, task, false) : this.craftPlan(bot, task)
      if ('error' in plan && plan.error) {
        this.endTask(bot, task, 'failed', { error: plan.error, result: plan.result })
        return
      }
    }
    if (task.type === 'process' && this.deviceAt(p.machine)) {
      // 身体不认识的机器：照玩家的办法试——开工不了的（10 秒里面什么都没变）当场失败，原料还在身上
      const tried = this.processOnDevice(bot, task, this.deviceAt(p.machine)!, false)
      if (tried.error) {
        this.endTask(bot, task, 'failed', tried)
        return
      }
    } else if (task.type === 'process') {
      // 不是机器、原料没带、机器没开工（真实 mod 等 3 秒看它开不开工，这里立刻知道）
      const plan = this.processPlan(bot, task)
      if ('error' in plan) {
        this.endTask(bot, task, 'failed', plan)
        return
      }
    }
    // 和真的身体一样：给了 meta 就只认那一种
    const meta = typeof p.meta === 'number' ? p.meta : undefined
    if (task.type === 'fill' && typeof p.item === 'string' && !bot.inventory.some((i) => i.id === p.item && (meta === undefined || i.meta === meta))) {
      this.endTask(bot, task, 'failed', {
        error: { code: 'no_material', message: `out of ${p.item}${meta === undefined ? '' : `:${meta}`}; 1 more needed`, detail: { item: { id: p.item, ...(meta === undefined ? {} : { meta }) }, missing: 1 } },
        result: { removed: 0, placed: 0, freeSlots: 36 - bot.inventory.length },
      })
      return
    }

    if (this.autoFinishMs !== undefined && task.type !== 'follow') {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        if (bot.task === task) this.completeTask(bot.name)
      }, this.autoFinishMs)
      this.timers.add(timer)
    }
  }

  private failsAtOnce(bot: MockBot, task: MockTask): { error: NonNullable<MockTask['error']>; result: Json } | undefined {
    const p = task.params
    const here = this.blockOf(bot)
    if (task.type === 'goto') {
      const far = Math.round(Math.hypot(Number(p.x) - here.x, Number(p.z) - here.z))
      if (far > MAX_TRAVEL) {
        return { error: { code: 'unreachable', message: `that is ${far} blocks away and the bot walks at most ${MAX_TRAVEL}; teleport closer first` }, result: { block: here } }
      }
    }
    if (task.type === 'give') {
      const target = String(p.player ?? '')
      const present = this.players.some((pl) => pl.name === target) || [...this.bots.values()].some((b) => b.online && b.name === target && b !== bot)
      if (!present) return { error: { code: 'unreachable', message: `${target} is not here` }, result: { dropped: 0 } }
      const wanted = (Array.isArray(p.items) ? p.items : []) as Json[]
      if (!wanted.some((w) => bot.inventory.some((i) => i.id === w.id))) {
        return { error: { code: 'no_material', message: 'the bot carries none of those items' }, result: { dropped: 0 } }
      }
    }
    return undefined
  }

  private finalize(bot: MockBot, task: MockTask, state: 'done' | 'failed' | 'canceled', outcome: { result?: Json; error?: MockTask['error'] }): void {
    task.state = state
    task.finishedAt = Date.now()
    if (outcome.result) task.result = outcome.result
    if (outcome.error) task.error = outcome.error
    if (state === 'done') task.progress = { ...task.progress, done: task.progress.total }
    bot.recent.unshift(task)
    if (bot.recent.length > 10) bot.recent.pop()
    this.emit('task.update', { bot: bot.name, task: { ...task } })
  }

  private endTask(bot: MockBot, task: MockTask, state: 'done' | 'failed' | 'canceled', outcome: { result?: Json; error?: MockTask['error'] }): void {
    if (bot.task === task) bot.task = null
    this.finalize(bot, task, state, outcome)
    const next = bot.queue.shift()
    if (next && bot.online) {
      bot.task = next
      this.run(bot, next)
    }
  }

  /** 取消当前任务和整个队列，返回被取消的 id。 */
  private cancelAll(bot: MockBot): string[] {
    const ids: string[] = []
    const queued = bot.queue
    bot.queue = []
    if (bot.task) {
      const t = bot.task
      bot.task = null
      this.finalize(bot, t, 'canceled', {})
      ids.push(t.id)
    }
    for (const t of queued) {
      this.finalize(bot, t, 'canceled', {})
      ids.push(t.id)
    }
    return ids
  }

  // ── 任务书 ──

  private quests(): MockQuest[] {
    if (!this.questBook) throw new RpcError('not_found', 'this server has no quest book (BetterQuesting)')
    return this.questBook
  }

  /** 看谁的进度：在线的，或者任务书见过的。没给名字就是不看进度。 */
  private questPlayer(name: unknown): { complete: Set<string>; claimed: Set<string> } | undefined {
    if (typeof name !== 'string' || name.length === 0) return undefined
    const key = name.toLowerCase()
    const known = this.questProgress.get(key)
    if (known) return known
    const online = this.players.some((pl) => pl.name.toLowerCase() === key) || [...this.bots.values()].some((b) => b.online && b.name.toLowerCase() === key)
    if (!online) throw new RpcError('not_found', `the quest book knows no player named ${name}`)
    return { complete: new Set(), claimed: new Set() }
  }

  private questState(q: MockQuest, who: { complete: Set<string>; claimed: Set<string> } | undefined): string | undefined {
    if (!who) return undefined
    if (who.complete.has(q.id)) return who.claimed.has(q.id) ? 'complete' : 'complete, reward unclaimed'
    return q.requires.every((r) => who.complete.has(r)) ? 'available' : 'locked'
  }

  // ── 物品、配方、合成 ──

  private requireRecipes(): void {
    if (!this.recipesReady) throw new RpcError('busy', 'the recipe index is still being built; try again in a few seconds')
  }

  private recipeEntry(id: unknown, meta: number): MockRecipeItem | undefined {
    return this.recipeBook.find((e) => e.id === id && e.meta === meta)
  }

  /** 这个物品是不是登记在这个矿辞名下。 */
  private hasOre(item: { id: string; meta: number }, ore: string): boolean {
    return this.recipeEntry(item.id, item.meta)?.ores?.includes(ore) === true
  }

  /** 一件物品合不合一样原料的要求。 */
  private fitsIngredient(item: { id: string; meta: number }, ing: MockCrafting['ingredients'][number]): boolean {
    if (ing.ore !== undefined) return this.hasOre(item, ing.ore)
    return item.id === ing.id && (ing.meta === undefined || item.meta === ing.meta)
  }

  /** 配方里的一样原料，形状和真实 mod 的 ingredients / missing 一样；给了 bot 时带 have。 */
  private ingredientJson(ing: MockCrafting['ingredients'][number], count: number, bot?: MockBot): Json {
    const out: Json = { count }
    if (ing.ore !== undefined) {
      const fits = this.recipeBook.filter((e) => e.ores?.includes(ing.ore!))
      out.name = `${fits[0]?.name ?? '?'} (any ${ing.ore})`
      out.ore = ing.ore
      if (fits[0]) out.example = { id: fits[0].id, meta: fits[0].meta }
      if (fits.length > 1) out.alternatives = fits.length
    } else {
      // 没有 meta 表示任何变体都行
      const known = this.recipeBook.find((e) => e.id === ing.id && (ing.meta === undefined || e.meta === ing.meta))
      out.name = ing.meta === undefined ? `${known?.name ?? ing.id} (any variant)` : (known?.name ?? ing.id)
      out.id = ing.id
      if (ing.meta !== undefined) out.meta = ing.meta
    }
    if (ing.tool) out.tool = true
    if (bot) out.have = bot.inventory.filter((i) => this.fitsIngredient(i, ing)).reduce((n, i) => n + i.count, 0)
    return out
  }

  /**
   * craft 任务第一刻做的事：找到配方、数清材料、找到工作台。哪一步不行就是任务失败的原因（原话照真实 mod 的）。
   */
  private craftPlan(
    bot: MockBot,
    task: MockTask,
  ): { entry: MockRecipeItem; recipe: MockCrafting; rounds: number } | { error: NonNullable<MockTask['error']>; result: Json } {
    const p = task.params
    const meta = typeof p.meta === 'number' ? Math.max(0, p.meta) : 0
    const index = typeof p.recipe === 'number' ? Math.max(0, p.recipe) : 0
    const wanted = Math.max(1, Math.min(2304, typeof p.count === 'number' ? p.count : 1))
    const freeSlots = 36 - bot.inventory.length
    const entry = this.recipeEntry(p.id, meta)
    const invalid = (message: string, result: Json) => ({ error: { code: 'invalid', message }, result })
    if (!entry || !entry.crafting || entry.crafting.length === 0) {
      return invalid(`no crafting-table recipe is known for ${String(p.id)}/${meta}`, { crafted: 0, freeSlots })
    }
    const result = { crafted: 0, item: { id: entry.id, meta: entry.meta, name: entry.name }, freeSlots }
    const recipe = entry.crafting[index]
    if (!recipe) return invalid(`it has ${entry.crafting.length} crafting recipes; there is no number ${index}`, { crafted: 0, freeSlots })
    if (recipe.unreadable) return invalid('this recipe is of a kind the bot cannot lay out by itself', { crafted: 0, freeSlots })
    const rounds = Math.ceil(wanted / recipe.gives)
    // 工具每一轮都放在那一格里，只要一件；别的原料每轮用掉一份
    const missing: Json[] = []
    for (const ing of recipe.ingredients) {
      const need = ing.tool ? ing.count : ing.count * rounds
      const have = bot.inventory.filter((i) => this.fitsIngredient(i, ing)).reduce((n, i) => n + i.count, 0)
      if (have < need) missing.push(this.ingredientJson(ing, need - have))
    }
    if (missing.length > 0) {
      return { error: { code: 'no_material', message: `the inventory lacks ingredients for ${rounds} round(s) of this recipe`, detail: { missing } }, result }
    }
    if (recipe.grid === '3x3') {
      const here = this.blockOf(bot)
      const given = positions(p.table)[0]
      const table = given ?? this.craftingTables.find((t) => Math.max(Math.abs(t.x - here.x), Math.abs(t.y - here.y), Math.abs(t.z - here.z)) <= CRAFT_TABLE_SEARCH)
      if (!table) return invalid(`this recipe needs a crafting table and none is within ${CRAFT_TABLE_SEARCH} blocks; give the position of one`, result)
      if (this.blockAt(table.x, table.y, table.z).air === true) {
        return { error: { code: 'invalid', message: 'there is no crafting table at that position', detail: { x: table.x, y: table.y, z: table.z } }, result }
      }
    }
    return { entry, recipe, rounds }
  }

  /**
   * craft 任务的 grid 写法：调用方说每一格放什么（{id, meta?}、{ore} 或 null），做 rounds 轮。
   * 摆好以后出什么由“游戏”说了算：这里是看这些原料凑不凑得出 gives 那个物品的某条合成配方；凑不出就失败，材料不动。
   * apply 为 false 时只检查（任务第一刻做的事），不动背包。
   */
  private craftGrid(bot: MockBot, task: MockTask, apply = true): { result: Json; error?: NonNullable<MockTask['error']> } {
    const p = task.params
    const cells = (p.grid as (Json | null)[]).map((cell, g) => ({ cell, g })).filter((c): c is { cell: Json; g: number } => c.cell !== null)
    const rounds = Math.max(1, Math.min(64, typeof p.rounds === 'number' ? p.rounds : 1))
    const freeSlots = 36 - bot.inventory.length
    const fits = (item: { id: string; meta: number }, cell: Json): boolean =>
      typeof cell.ore === 'string' ? this.hasOre(item, cell.ore) : item.id === cell.id && (cell.meta === undefined || item.meta === cell.meta)
    const isTool = (cell: Json): boolean => typeof cell.ore === 'string' && cell.ore.startsWith('craftingTool')
    // 同一样原料占了几格就要几份；工具只要一件，不消耗
    const groups = new Map<string, { cell: Json; cells: number }>()
    for (const { cell } of cells) {
      const key = JSON.stringify(cell)
      const group = groups.get(key)
      if (group) group.cells++
      else groups.set(key, { cell, cells: 1 })
    }
    const missing: Json[] = []
    for (const { cell, cells: n } of groups.values()) {
      const need = isTool(cell) ? 1 : n * rounds
      const have = bot.inventory.filter((i) => fits(i, cell)).reduce((sum, i) => sum + i.count, 0)
      if (have < need) missing.push({ count: need - have, ...(typeof cell.ore === 'string' ? { ore: cell.ore } : { id: cell.id, ...(cell.meta !== undefined ? { meta: cell.meta } : {}) }) })
    }
    if (missing.length > 0) return { error: { code: 'no_material', message: `the inventory lacks ingredients for ${rounds} round(s) of this recipe`, detail: { missing } }, result: { crafted: 0, freeSlots } }
    // 摆不摆得进 2×2：占的行、列各不超过两排
    const rows = cells.map((c) => Math.floor(c.g / 3))
    const columns = cells.map((c) => c.g % 3)
    const pocket = Math.max(...rows) - Math.min(...rows) <= 1 && Math.max(...columns) - Math.min(...columns) <= 1
    if (!pocket) {
      const here = this.blockOf(bot)
      const table = positions(p.table)[0] ?? this.craftingTables.find((t) => Math.max(Math.abs(t.x - here.x), Math.abs(t.y - here.y), Math.abs(t.z - here.z)) <= CRAFT_TABLE_SEARCH)
      if (!table) return { error: { code: 'invalid', message: `this recipe needs a crafting table and none is within ${CRAFT_TABLE_SEARCH} blocks; give the position of one` }, result: { crafted: 0, freeSlots } }
    }
    // “游戏”出什么：配方书里 gives 那个物品的合成配方，原料的份数对得上才算
    const gives = p.gives as Json | undefined
    const entry = gives ? this.recipeEntry(gives.id, typeof gives.meta === 'number' ? gives.meta : 0) : undefined
    const recipe = entry?.crafting?.find(
      (r) => !r.unreadable && r.ingredients.length === groups.size && r.ingredients.every((ing) => [...groups.values()].some((group) => (ing.tool ? 1 : ing.count) === (isTool(group.cell) ? 1 : group.cells) && (ing.ore !== undefined ? group.cell.ore === ing.ore : group.cell.id === ing.id && (ing.meta === undefined || group.cell.meta === ing.meta)))),
    )
    if (!entry || !recipe) return { error: { code: 'invalid', message: `laid out like this the crafting grid gives ${gives ? 'something else than' : 'nothing; expected'} ${gives ? `${String(gives.id)}/${String(gives.meta ?? 0)}` : 'a product'}` }, result: { crafted: 0, freeSlots } }
    if (!apply) return { result: { crafted: 0, item: { id: entry.id, meta: entry.meta, name: entry.name }, freeSlots } }
    for (const { cell, cells: n } of groups.values()) if (!isTool(cell)) takeItems(bot.inventory, (i) => fits(i, cell), n * rounds)
    bot.inventory = bot.inventory.filter((i) => i.count > 0)
    const crafted = recipe.gives * rounds
    putInInventory(bot, entry, crafted)
    return { result: { crafted, item: { id: entry.id, meta: entry.meta, name: entry.name }, freeSlots: 36 - bot.inventory.length } }
  }

  /** craft 任务做完时的样子：原料从背包里用掉（工具留着），成品进背包。 */
  private craft(bot: MockBot, task: MockTask): { result: Json; error?: NonNullable<MockTask['error']> } {
    if (Array.isArray(task.params.grid)) return this.craftGrid(bot, task)
    const plan = this.craftPlan(bot, task)
    if ('error' in plan) return plan
    for (const ing of plan.recipe.ingredients) {
      if (!ing.tool) takeItems(bot.inventory, (i) => this.fitsIngredient(i, ing), ing.count * plan.rounds)
    }
    bot.inventory = bot.inventory.filter((i) => i.count > 0)
    const crafted = plan.recipe.gives * plan.rounds
    putInInventory(bot, plan.entry, crafted)
    return { result: { crafted, item: { id: plan.entry.id, meta: plan.entry.meta, name: plan.entry.name }, freeSlots: 36 - bot.inventory.length } }
  }

  // ── 身体不认识的机器、通用的界面 ──

  private deviceAt(at: unknown): MockDevice | undefined {
    const pos = (at ?? {}) as Json
    return this.devices.find((d) => d.x === pos.x && d.y === pos.y && d.z === pos.z)
  }

  /** 机器自己干活：能放东西的格子里凑齐一条配方的原料（要燃料的还得有燃料），就做到做不动为止。返回做了几轮。 */
  private runDevice(d: MockDevice): number {
    const ins = d.slots.filter((x) => x.kind === 'in')
    const have = (want: { id: string; meta: number }): number => ins.reduce((n, x) => (x.item && x.item.id === want.id && x.item.meta === want.meta ? n + x.item.count : n), 0)
    const take = (want: { id: string; meta: number }, count: number): void => {
      for (const x of ins) {
        if (count <= 0) break
        if (!x.item || x.item.id !== want.id || x.item.meta !== want.meta) continue
        const n = Math.min(count, x.item.count)
        x.item.count -= n
        count -= n
        if (x.item.count <= 0) delete x.item
      }
    }
    let rounds = 0
    for (;;) {
      const recipe = d.recipes.find((r) => r.inputs.every((i) => have(i) >= i.count) && (!r.fuel || (d.burning ?? 0) > 0 || have(r.fuel) >= 1))
      if (!recipe || rounds >= 256) return rounds
      // 一份燃料烧 8 轮
      if (recipe.fuel) {
        if ((d.burning ?? 0) <= 0) {
          take(recipe.fuel, 1)
          d.burning = 8
        }
        d.burning = (d.burning ?? 0) - 1
      }
      for (const i of recipe.inputs) take(i, i.count)
      for (const o of recipe.outputs) {
        const out = d.slots.find((x) => x.kind === 'out' && (!x.item || (x.item.id === o.id && x.item.meta === o.meta)))
        if (!out) return rounds
        if (out.item) out.item.count += o.count
        else out.item = { ...o }
      }
      rounds++
    }
  }

  /** 把一组东西放进机器能放东西的格子：同种的叠上去，否则占一个空格；没地方就放不进去。返回放进去几个。 */
  private putIntoDevice(d: MockDevice, item: { id: string; meta: number; name: string }, count: number): number {
    const same = d.slots.find((x) => x.kind === 'in' && x.item && x.item.id === item.id && x.item.meta === item.meta)
    const free = same ?? d.slots.find((x) => x.kind === 'in' && !x.item)
    if (!free || count <= 0) return 0
    if (free.item) free.item.count += count
    else free.item = { id: item.id, meta: item.meta, name: item.name, count }
    return count
  }

  private deviceDeposit(bot: MockBot, d: MockDevice, wanted: Json[]): Json {
    let moved = 0
    for (const want of wanted) {
      const fits = (i: MockItem): boolean => i.id === want.id && (typeof want.meta !== 'number' || i.meta === want.meta)
      const have = bot.inventory.filter(fits).reduce((n, i) => n + i.count, 0)
      for (const got of takeItems(bot.inventory, fits, typeof want.count === 'number' ? want.count : have)) {
        const put = this.putIntoDevice(d, got, got.count)
        moved += put
        if (put < got.count) putInInventory(bot, got, got.count - put)
      }
    }
    bot.inventory = bot.inventory.filter((i) => i.count > 0)
    this.runDevice(d)
    return { moved, freeSlots: 36 - bot.inventory.length }
  }

  private deviceWithdraw(bot: MockBot, d: MockDevice, wanted: Json[], fromInputs: boolean): Json {
    const from = d.slots.filter((x) => (fromInputs ? x.kind === 'in' : x.kind === 'out'))
    const missing: Json[] = []
    let moved = 0
    for (const want of wanted) {
      let left = typeof want.count === 'number' ? want.count : Infinity
      for (const x of from) {
        if (left <= 0 || !x.item || x.item.id !== want.id || (typeof want.meta === 'number' && x.item.meta !== want.meta)) continue
        const n = Math.min(left, x.item.count)
        putInInventory(bot, x.item, n)
        x.item.count -= n
        moved += n
        left -= n
        if (x.item.count <= 0) delete x.item
      }
      if (Number.isFinite(left) && left > 0) missing.push({ id: want.id, ...(typeof want.meta === 'number' ? { meta: want.meta } : {}), count: left })
    }
    return missing.length > 0 ? { moved, missing } : { moved }
  }

  /**
   * 对着身体不认识的机器 process：把原料点进去 → 等里面不再变化 → 把产物格里的东西取回来。
   * apply 为 false 只看它开不开工（不动任何东西）。10 秒里面什么都没变就是没开工：原料取回来，以 invalid 失败。
   */
  private processOnDevice(bot: MockBot, task: MockTask, d: MockDevice, apply: boolean): { result: Json; error?: NonNullable<MockTask['error']> } {
    const wanted = (Array.isArray(task.params.inputs) ? task.params.inputs : []) as Json[]
    // 在一份副本上试
    const trial: MockDevice = apply ? d : { ...d, slots: d.slots.map((x) => ({ kind: x.kind, ...(x.item ? { item: { ...x.item } } : {}) })) }
    const pack: MockBot = apply ? bot : { ...bot, inventory: bot.inventory.map((i) => ({ ...i })) }
    let put = 0
    for (const want of wanted) {
      const fits = (i: MockItem): boolean => i.id === want.id && (typeof want.meta !== 'number' || i.meta === want.meta)
      for (const got of takeItems(pack.inventory, fits, Number(want.count))) {
        const n = this.putIntoDevice(trial, got, got.count)
        put += n
        if (n < got.count) putInInventory(pack, got, got.count - n)
      }
    }
    pack.inventory = pack.inventory.filter((i) => i.count > 0)
    const rounds = put > 0 ? this.runDevice(trial) : 0
    // 放下就走：身体读不懂这种机器开没开工，东西放进去就算数；产物留在它的产物格里
    if (task.params.leave === true && put > 0) {
      if (apply) bot.inventory = pack.inventory
      return { result: { put, left: true, note: 'the things are in and the task ended without waiting; whether this machine started cannot be read. What it makes stays in it until it is taken out', freeSlots: 36 - pack.inventory.length } }
    }
    if (rounds === 0) {
      // 放进去的原样取回
      if (apply) for (const want of wanted) this.deviceWithdraw(bot, d, [want], true)
      return {
        error: { code: 'invalid', message: put > 0 ? 'the machine did not start: nothing inside it changed in 10 seconds. It may need fuel, power, or something these inputs do not include. The inputs are back in the inventory.' : 'the machine took none of the inputs', detail: { x: d.x, y: d.y, z: d.z, name: d.name } },
        result: { put, outputs: [], freeSlots: 36 - bot.inventory.length },
      }
    }
    const outputs: Json[] = []
    for (const x of trial.slots) {
      if (x.kind !== 'out' || !x.item) continue
      outputs.push({ ...x.item })
      putInInventory(pack, x.item, x.item.count)
      delete x.item
    }
    if (apply) bot.inventory = pack.inventory
    return { result: { put, outputs, freeSlots: 36 - pack.inventory.length } }
  }

  private screenOpen(bot: MockBot, p: Json): Json {
    if (bot.task) throw new RpcError('busy', 'a task is running; screens can only be used while the bot has no task')
    const opener = p.item as { id: string; meta?: number } | undefined
    if (opener) {
      if (!bot.inventory.some((i) => i.id === opener.id && (typeof opener.meta !== 'number' || i.meta === opener.meta))) throw new RpcError('no_material', 'the bot carries no such item')
      const inside = this.bags.get(opener.id)
      // 右键后没有界面打开的东西：open 是 false
      if (!inside) return { open: false }
      this.screens.set(bot.name, { title: opener.id, slots: Array.from({ length: 27 }, (_, n) => (inside[n] ? { kind: 'in' as const, item: inside[n]! } : { kind: 'in' as const })) })
      return this.screenLook(bot)
    }
    const at = { x: Number(p.x), y: Number(p.y), z: Number(p.z) }
    const me = this.blockOf(bot)
    if (Math.max(Math.abs(at.x - me.x), Math.abs(at.y - me.y), Math.abs(at.z - me.z)) > 5) throw new RpcError('out_of_reach', `the block at ${at.x},${at.y},${at.z} is too far to reach`)
    // 蹲着点机器上有覆盖板的那个面：打开的是覆盖板自己的界面（它那几格）
    if (typeof p.side === 'string' && p.sneak === true) {
      const cover = this.machines.find((m) => m.x === at.x && m.y === at.y && m.z === at.z)?.covers?.find((cv) => cv.side === p.side && cv.slots !== undefined)
      if (!cover) return { open: false }
      const items = (cover.items ??= [])
      this.screens.set(bot.name, { title: cover.name, slots: Array.from({ length: cover.slots! }, (_, n) => (items[n] ? { kind: 'in' as const, item: items[n]! } : { kind: 'in' as const })) })
      return this.screenLook(bot)
    }
    // 一台带控件的 GregTech 机器：它自己的界面——原料格、一个产物格，加上格子以外的那些东西
    const machine = this.machines.find((m) => m.x === at.x && m.y === at.y && m.z === at.z)
    if (machine?.controls) {
      const inputs = machine.inputs ?? []
      const slots: MockDevice['slots'] = [...Array.from({ length: machine.inputSlots }, (_, n) => (inputs[n] ? { kind: 'in' as const, item: inputs[n]! } : { kind: 'in' as const })), { kind: 'out' as const }]
      this.screens.set(bot.name, { title: machine.name, slots, machine, panels: new Map() })
      return this.screenLook(bot)
    }
    const device = this.deviceAt(at)
    if (!device) return { open: false }
    this.screens.set(bot.name, { title: device.name, slots: device.slots, device })
    return this.screenLook(bot)
  }

  private screenLook(bot: MockBot): Json {
    const open = this.screens.get(bot.name)
    if (!open) return { open: false }
    const own = [...bot.inventory].sort((a, b) => a.slot - b.slot)
    return {
      open: true,
      screen: open.title,
      slotCount: open.slots.length + 36,
      slots: [
        ...open.slots.map((x, slot) => ({ slot, ...(x.item ? { item: { ...x.item } } : {}), ...(x.kind === 'out' ? { takesNothing: true } : {}), ...(x.kind === 'ghost' ? { ghost: true } : {}) })),
        // 自己背包的格子排在后面；空格不列
        ...own.map((i) => ({ slot: open.slots.length + i.slot, own: true, item: { id: i.id, meta: i.meta, count: i.count, name: i.name } })),
      ],
      ...(open.cursor ? { cursor: { ...open.cursor } } : {}),
      ...(open.machine ? { controls: this.controlsOf(open.machine, open.panels ?? new Map()) } : {}),
    }
  }

  /** 一台机器界面上格子以外的东西：它自己的控件、每个罐一个流体格、每块能装东西的覆盖板一个页签。 */
  private controlsOf(machine: MockMachine, panels: Map<string, number>): Json[] {
    const main = machine.controls?.[0]?.panel ?? machine.name
    return [
      ...(machine.controls ?? []).map((c) => ({ panel: c.panel, key: c.key, kind: c.kind, ...(c.value !== undefined ? { value: c.value } : {}), ...(c.options ? { options: c.options } : {}), ...(c.readOnly ? { readOnly: true } : {}) })),
      ...(machine.covers ?? []).filter((cv) => cv.slots !== undefined).map((cv) => ({ panel: main, key: `cover_panel_${cv.side}`, kind: 'panel', open: panels.has(`cover_panel_${cv.side}`) })),
      ...(machine.tanks ?? []).map((t, n) => ({ panel: main, key: `auto_sync:tank:${n}`, kind: 'fluid', ...((t.amount ?? 0) > 0 ? { fluid: t.fluid, name: t.name, amount: t.amount } : { amount: 0 }), capacity: t.capacity, fills: false, drains: true })),
    ]
  }

  /** 按名字找一个控件：写全（fluidAutoOutput:0），或者只写冒号前的那一段（不重名时）；panel 只在重名时需要。 */
  private findControl(machine: MockMachine | undefined, panels: Map<string, number>, p: Json): Json {
    if (!machine) throw new RpcError('bad_request', 'this screen has no controls of that kind (only its slots can be clicked)')
    const key = String(p.key ?? '')
    const panel = typeof p.panel === 'string' ? p.panel : undefined
    const found = this.controlsOf(machine, panels).filter((c) => (panel === undefined || c.panel === panel) && (c.key === key || (String(c.key).includes(':') && String(c.key).slice(0, String(c.key).lastIndexOf(':')) === key)))
    if (found.length === 0) throw new RpcError('bad_request', `the screen has no control "${key}"${panel !== undefined ? ` in panel "${panel}"` : ''}; screen.look lists them`)
    if (found.length > 1) throw new RpcError('bad_request', `more than one control is called "${key}": give its full key and its panel`)
    return found[0]!
  }

  /** 按一下：开关翻过来、页签打开或关上、按钮做它的事。照真的身体的原话拒绝。 */
  private screenPress(bot: MockBot, p: Json): Json {
    const open = this.screens.get(bot.name)
    if (!open) throw new RpcError('bad_request', 'no screen is open; open one first')
    const panels = (open.panels ??= new Map())
    const control = this.findControl(open.machine, panels, p)
    const machine = open.machine!
    const own = machine.controls?.find((c) => c.key === control.key && c.panel === control.panel)
    if (control.kind === 'panel') {
      // 覆盖板的页签：打开以后它那几格接在机器自己的格子后面；再按一下收起来
      const cover = machine.covers!.find((cv) => `cover_panel_${cv.side}` === control.key)!
      const at = panels.get(String(control.key))
      if (at !== undefined) {
        open.slots = open.slots.filter((_, n) => n < at || n >= at + cover.slots!)
        panels.delete(String(control.key))
      } else {
        panels.set(String(control.key), open.slots.length)
        const items = (cover.items ??= [])
        open.slots = [...open.slots, ...Array.from({ length: cover.slots! }, (_, n) => (items[n] ? { kind: 'in' as const, item: items[n]! } : { kind: 'in' as const }))]
      }
    } else if (control.kind === 'fluid') {
      throw new RpcError('invalid', 'the screen did not take that: nothing on the cursor holds or takes a fluid')
    } else if (control.kind === 'button') {
      ;(machine.pressed ??= []).push(String(control.key))
    } else if (control.kind === 'switch' && own) {
      if (own.readOnly) throw new RpcError('denied', `the screen only shows "${String(p.key)}"; it does not take a change of it from a player`)
      own.value = own.value !== true
      this.afterSwitch(machine, own)
    } else {
      throw new RpcError('bad_request', `"${String(p.key)}" is not something a click works; set its value instead`)
    }
    return this.screenLook(bot)
  }

  /** 设成一个值：开关、数字、文字、选项。 */
  private screenSet(bot: MockBot, p: Json): Json {
    const open = this.screens.get(bot.name)
    if (!open) throw new RpcError('bad_request', 'no screen is open; open one first')
    const control = this.findControl(open.machine, (open.panels ??= new Map()), p)
    const machine = open.machine!
    const own = machine.controls?.find((c) => c.key === control.key && c.panel === control.panel)
    const value = p.value
    if (typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'string') throw new RpcError('bad_request', 'value must be true/false, a number or a text')
    if (!own || own.kind === 'button' || own.kind === 'value') throw new RpcError('bad_request', `"${String(p.key)}" is not a value that can be set; press it, or look at what kind it is`)
    if (own.readOnly) throw new RpcError('denied', `the screen only shows "${String(p.key)}"; it does not take a change of it from a player`)
    if (own.kind === 'choice') {
      const pick = (own.options ?? []).find((o) => o.toLowerCase() === String(value).toLowerCase())
      if (pick === undefined) throw new RpcError('bad_request', `"${String(p.key)}" is one of: [${(own.options ?? []).join(', ')}]`)
      own.value = pick
    } else if (own.kind === 'switch') {
      own.value = typeof value === 'boolean' ? value : typeof value === 'number' ? value !== 0 : value === 'true'
      this.afterSwitch(machine, own)
    } else if (own.kind === 'number') {
      own.value = Number(value)
    } else {
      own.value = String(value)
    }
    return this.screenLook(bot)
  }

  /** 开关变了以后机器跟着做的事：流体自动输出打开，罐里的流体进了隔壁那台的罐。 */
  private afterSwitch(machine: MockMachine, control: MockControl): void {
    if (!control.key.startsWith('fluidAutoOutput') || control.value !== true || !machine.autoOutputTo) return
    const to = machine.autoOutputTo
    const target = this.machines.find((m) => m.x === to.x && m.y === to.y && m.z === to.z)
    if (!target) return
    for (const tank of machine.tanks ?? []) {
      if (!tank.fluid || !((tank.amount ?? 0) > 0)) continue
      const into = (target.tanks ??= [{ capacity: 16000 }]).find((t) => t.fluid === tank.fluid || !((t.amount ?? 0) > 0))
      if (!into) continue
      into.fluid = tank.fluid
      if (tank.name !== undefined) into.name = tank.name
      into.amount = (into.amount ?? 0) + tank.amount!
      tank.amount = 0
      delete tank.fluid
      delete tank.name
    }
  }

  /** 点一格，和游戏自己的界面一样：Shift 点是整组挪到另一边；左键拿起或放下一整组，右键拿一半或放一个。 */
  private screenClick(bot: MockBot, p: Json): Json {
    const open = this.screens.get(bot.name)
    if (!open) throw new RpcError('invalid', 'no screen is open')
    const slot = Number(p.slot)
    const right = p.button === 1
    const theirs = open.slots[slot]
    const mine = theirs ? undefined : bot.inventory.find((i) => i.slot === slot - open.slots.length)
    if (p.shift === true) {
      if (theirs?.item && theirs.kind !== 'ghost') {
        putInInventory(bot, theirs.item, theirs.item.count)
        delete theirs.item
      } else if (mine) {
        // 进界面里“该去的地方”：能放东西的格子
        const target = open.slots.find((x) => x.kind === 'in' && x.item && x.item.id === mine.id && x.item.meta === mine.meta) ?? open.slots.find((x) => x.kind === 'in' && !x.item)
        if (target) {
          if (target.item) target.item.count += mine.count
          else target.item = { id: mine.id, meta: mine.meta, count: mine.count, name: mine.name }
          mine.count = 0
        }
      }
    } else if (theirs && theirs.kind !== 'ghost') {
      if (!open.cursor && theirs.item) {
        const n = right ? Math.ceil(theirs.item.count / 2) : theirs.item.count
        open.cursor = { ...theirs.item, count: n }
        theirs.item.count -= n
        if (theirs.item.count <= 0) delete theirs.item
      } else if (open.cursor && theirs.kind === 'in' && (!theirs.item || (theirs.item.id === open.cursor.id && theirs.item.meta === open.cursor.meta))) {
        const n = right ? 1 : open.cursor.count
        if (theirs.item) theirs.item.count += n
        else theirs.item = { ...open.cursor, count: n }
        open.cursor.count -= n
        if (open.cursor.count <= 0) delete open.cursor
      }
    } else if (mine || !theirs) {
      if (!open.cursor && mine) {
        const n = right ? Math.ceil(mine.count / 2) : mine.count
        open.cursor = { id: mine.id, meta: mine.meta, name: mine.name, count: n }
        mine.count -= n
      } else if (open.cursor) {
        const n = right ? 1 : open.cursor.count
        putInInventory(bot, open.cursor, n)
        open.cursor.count -= n
        if (open.cursor.count <= 0) delete open.cursor
      }
    }
    bot.inventory = bot.inventory.filter((i) => i.count > 0)
    if (open.device) this.runDevice(open.device)
    return this.screenLook(bot)
  }

  // ── 机器 ──

  /**
   * process 任务开头做的事：走到机器跟前把原料放进去，看它开不开工。
   * 开工的条件：有电、没被关掉、没在忙，而且放进去的东西凑得出它的一条配方（等级够、不带流体；不消耗的电路和模具也得在）。
   * 不开工时原料拿回来，以 invalid 失败，detail 是机器的状态（原话照真实 mod 的）。
   */
  private processPlan(
    bot: MockBot,
    task: MockTask,
  ): { machine: MockMachine; recipe: Json; rounds: number; given: { id: string; meta: number | undefined; count: number }[] } | { error: NonNullable<MockTask['error']>; result: Json } {
    const p = task.params
    const at = positions(p.machine)[0]!
    const freeSlots = 36 - bot.inventory.length
    const machine = this.machines.find((m) => m.x === at.x && m.y === at.y && m.z === at.z)
    if (!machine) {
      return { error: { code: 'invalid', message: 'that is not a processing machine', detail: { x: at.x, y: at.y, z: at.z } }, result: { put: 0, outputs: [], freeSlots } }
    }
    // 每样原料实际放得进去多少：以身上有的为限
    const given = ((Array.isArray(p.inputs) ? p.inputs : []) as Json[]).map((want) => {
      const meta = typeof want.meta === 'number' ? want.meta : undefined
      const have = bot.inventory.filter((i) => i.id === want.id && (meta === undefined || i.meta === meta)).reduce((n, i) => n + i.count, 0)
      return { id: String(want.id), meta, count: Math.min(Number(want.count), have) }
    })
    // 原料格被别的东西（主人留在里面的模具）占着，这次要放的几样放不下：一样都放不进去
    const inside = machine.inputs ?? []
    const fresh = given.filter((g) => g.count > 0 && !inside.some((i) => i.id === g.id && (g.meta === undefined || i.meta === g.meta))).length
    const put = inside.length + fresh > machine.inputSlots ? 0 : given.reduce((n, g) => n + g.count, 0)
    if (put <= 0) {
      return {
        error: { code: 'invalid', message: 'the machine took none of the inputs: they are not in the inventory, or its input slots are occupied', detail: describeMachine(machine) },
        result: { put: 0, outputs: [], freeSlots },
      }
    }
    // 产物是流体的加工（流体提取机把钢板化成熔融钢）：没有物品出来，罐里的东西变了
    const melted = (machine.melts ?? []).find((m) => given.some((g) => g.count > 0 && g.id === m.id && (g.meta === undefined || g.meta === m.meta)))
    if (melted && machine.storedEU > 0 && machine.switchedOff !== true && machine.active !== true) {
      const rounds = given.filter((g) => g.id === melted.id && (g.meta === undefined || g.meta === melted.meta)).reduce((n, g) => n + g.count, 0)
      return { machine, recipe: { inputs: [{ id: melted.id, meta: melted.meta, count: 1 }], outputs: [], melts: melted }, rounds, given }
    }
    // 编程电路可以不带在身上：circuit 参数像玩家点机器界面上的电路格一样直接设（做完恢复原样）
    const circuit = typeof p.circuit === 'number' ? p.circuit : undefined
    const has = (need: Json): number =>
      need.id === 'gregtech:gt.integrated_circuit' && circuit !== undefined && need.meta === circuit
        ? 1
        : given.filter((g) => g.id === need.id && (g.meta === undefined || g.meta === need.meta)).reduce((n, g) => n + g.count, 0) +
          // 模具已经在机器里的，不用再放
          (need.notConsumed === true ? inside.filter((i) => i.id === need.id && i.meta === need.meta).reduce((n, i) => n + i.count, 0) : 0)
    const recipe = this.recipeBook
      .flatMap((e) => e.machines ?? [])
      .find(
        (r) =>
          r.machine === machine.recipes &&
          TIERS.indexOf(String(r.tier)) <= TIERS.indexOf(machine.tier) &&
          !(Array.isArray(r.fluidInputs) && r.fluidInputs.length > 0) &&
          ((r.inputs ?? []) as Json[]).every((need) => has(need) >= Math.max(1, Number(need.count))),
      )
    if (machine.storedEU <= 0 || machine.switchedOff === true || machine.active === true || !recipe) {
      return {
        error: {
          code: 'invalid',
          message:
            'the machine did not start: it may lack power, a programmed circuit or a fluid, or these inputs are not a recipe it runs. The inputs are back in the inventory.',
          detail: describeMachine(machine),
        },
        result: { put, outputs: [], freeSlots },
      }
    }
    const consumed = ((recipe.inputs ?? []) as Json[]).filter((need) => need.notConsumed !== true)
    const rounds = Math.min(...consumed.map((need) => Math.floor(has(need) / Number(need.count))))
    return { machine, recipe, rounds, given }
  }

  /** process 任务做完时的样子：原料用掉，产物进背包；没被消耗的电路、模具和没用完的原料也一并“取回来”，算在 outputs 里。 */
  private process(bot: MockBot, task: MockTask): { result: Json; error?: NonNullable<MockTask['error']> } {
    const plan = this.processPlan(bot, task)
    if ('error' in plan) return plan
    const put = plan.given.reduce((n, g) => n + g.count, 0)
    if (task.params.leave === true) return { result: this.processAndLeave(bot, task, plan, put) }
    const outputs: Json[] = []
    // 机器自己记着的：做完了几轮、一共做出了什么（真的身体看着机器转时读的）
    const made: Json[] = []
    // 物品自动输出开着：产物进了输出面挨着的那个容器，一个也不留在产物格里
    const away = plan.machine.itemAutoOutput
    const into = away ? this.containers.find((c) => c.x === away.to.x && c.y === away.to.y && c.z === away.to.z) : undefined
    for (const out of (plan.recipe.outputs ?? []) as Json[]) {
      const item = { id: String(out.id), meta: Number(out.meta ?? 0), name: String(out.name ?? out.id), count: Number(out.count) * plan.rounds }
      made.push(item)
      if (away) {
        const stack = into?.items.find((i) => i.id === item.id && i.meta === item.meta)
        if (stack) stack.count += item.count
        else into?.items.push({ ...item })
        continue
      }
      putInInventory(bot, item, item.count)
      outputs.push(item)
    }
    const watched = plan.rounds > 0 && made.length > 0 ? { rounds: plan.rounds, made } : {}
    for (const need of (plan.recipe.inputs ?? []) as Json[]) {
      const fits = (i: { id: string; meta: number }) => i.id === need.id && i.meta === Number(need.meta ?? 0)
      const g = plan.given.find((x) => x.id === need.id && (x.meta === undefined || x.meta === need.meta))
      const used = need.notConsumed === true ? 0 : Number(need.count) * plan.rounds
      takeItems(bot.inventory, fits, used)
      // 放进去却没被用掉的，做完后原样取回
      const back = (g?.count ?? 0) - used
      if (back > 0) outputs.push({ id: String(need.id), meta: Number(need.meta ?? 0), name: String(need.name ?? need.id), count: back })
    }
    bot.inventory = bot.inventory.filter((i) => i.count > 0)
    const melts = plan.recipe.melts as { fluid: string; name: string; mb: number } | undefined
    if (melts && outputs.length === 0) {
      // 没有物品可取，罐里的东西变了：算做成，结果带 note 和 fluids（罐里现在有什么），和真的身体一样
      const tanks = (plan.machine.tanks ??= [{ capacity: 16000 }])
      const tank = tanks.find((t) => t.fluid === melts.fluid) ?? tanks.find((t) => !((t.amount ?? 0) > 0)) ?? tanks[0]!
      tank.fluid = melts.fluid
      tank.name = melts.name
      tank.amount = (tank.amount ?? 0) + melts.mb * plan.rounds
      return {
        result: {
          put,
          outputs,
          freeSlots: 36 - bot.inventory.length,
          note: 'the machine ran and gave no item: what it made is a fluid, which stays in its tank (fluids shows what is there now)',
          fluids: tanks.map((t) => ((t.amount ?? 0) > 0 ? { ...t } : { amount: 0, capacity: t.capacity })),
        },
      }
    }
    if (away) {
      return {
        result: {
          put,
          outputs,
          ...watched,
          ...(into ? { elsewhere: [{ ...away.to, side: away.side, items: made }] } : {}),
          autoOutput: { items: true, fluids: false, side: away.side, to: away.to },
          note: 'the machine ran and made things, but none were left in it to take out: something moved them on while it worked (its auto-output, a cover or a pipe). elsewhere lists the containers around it that gained them; what is not there went further than can be seen from the machine',
          freeSlots: 36 - bot.inventory.length,
        },
      }
    }
    return { result: { put, outputs, ...watched, freeSlots: 36 - bot.inventory.length } }
  }

  /**
   * process 带 leave：原料放进去、电路设好、机器开工，任务就结束。产物和没消耗的东西（模具、没用完的原料）留在机器里，电路不恢复。
   * 结果里的 machine 是开工那一刻的状态（第一轮刚转了 1 秒）；这里的机器不走时间，之后去取时它已经做完了。
   */
  private processAndLeave(bot: MockBot, task: MockTask, plan: { machine: MockMachine; recipe: Json; rounds: number; given: { id: string; meta: number | undefined; count: number }[] }, put: number): Json {
    const m = plan.machine
    const into = (box: { id: string; meta: number; count: number; name: string }[], item: { id: string; meta: number; name: string }, count: number): void => {
      const stack = box.find((i) => i.id === item.id && i.meta === item.meta)
      if (stack) stack.count += count
      else box.push({ id: item.id, meta: item.meta, name: item.name, count })
    }
    for (const out of (plan.recipe.outputs ?? []) as Json[]) into((m.outputs ??= []), { id: String(out.id), meta: Number(out.meta ?? 0), name: String(out.name ?? out.id) }, Number(out.count) * plan.rounds)
    for (const need of (plan.recipe.inputs ?? []) as Json[]) {
      const fits = (i: { id: string; meta: number }) => i.id === need.id && i.meta === Number(need.meta ?? 0)
      const g = plan.given.find((x) => x.id === need.id && (x.meta === undefined || x.meta === need.meta))
      const used = need.notConsumed === true ? 0 : Number(need.count) * plan.rounds
      // 放进去的都离开了背包；没被用掉的留在原料格里
      takeItems(bot.inventory, fits, g?.count ?? 0)
      const stays = (g?.count ?? 0) - used
      if (stays > 0) into((m.inputs ??= []), { id: String(need.id), meta: Number(need.meta ?? 0), name: String(need.name ?? need.id) }, stays)
    }
    bot.inventory = bot.inventory.filter((i) => i.count > 0)
    const was = m.circuit ?? 0
    const circuit = typeof task.params.circuit === 'number' ? task.params.circuit : undefined
    if (circuit !== undefined) m.circuit = circuit
    const ticks = Math.round(Number(plan.recipe.seconds ?? 0) * 20)
    return {
      put,
      left: true,
      note: 'the machine has started and the task ended without waiting for it. What it makes stays in it until it is taken out (withdraw with the machine as the container); what was put in and is not used up, such as a mould, stays in it too',
      machine: { ...describeMachine(m), active: true, ...(ticks > 0 ? { progress: Math.min(20, ticks), maxProgress: ticks } : {}) },
      ...(circuit !== undefined ? { circuit: { now: circuit, was } } : {}),
      freeSlots: 36 - bot.inventory.length,
    }
  }

  // ── 图纸 ──

  /** blueprint.check 和 blueprint 任务共用的参数：哪张图纸、放在哪、只处理哪一部分、哪些方块管不管、允许挖什么。 */
  private blueprintPlan(p: Json): BlueprintPlan {
    const name = blueprintName(p.name)
    const file = this.blueprints.get(name)
    if (!file) throw new RpcError('bad_request', `there is no blueprint named "${name}"; blueprint.list shows the ones there are`)
    if ('error' in file) throw new RpcError('bad_request', `blueprint "${name}": ${file.error}`)
    const ox = this.num(p, 'x')
    const oy = this.num(p, 'y')
    const oz = this.num(p, 'z')
    const range = (a: string, b: string, lo: number, hi: number): [number, number] => {
      if (p[a] === undefined && p[b] === undefined) return [lo, hi]
      if (p[a] === undefined || p[b] === undefined) throw new RpcError('bad_request', `${a} and ${b} go together`)
      const u = this.num(p, a)
      const v = this.num(p, b)
      return [Math.max(lo, Math.min(u, v)), Math.min(hi, Math.max(u, v))]
    }
    const [x1, x2] = range('x1', 'x2', ox, ox + file.size.x - 1)
    const [y1, y2] = range('y1', 'y2', Math.max(0, oy), Math.min(255, oy + file.size.y - 1))
    const [z1, z2] = range('z1', 'z2', oz, oz + file.size.z - 1)
    if (x1 > x2 || y1 > y2 || z1 > z2) {
      throw new RpcError(
        'bad_request',
        `the given range does not touch the blueprint, which set down there spans x ${ox}..${ox + file.size.x - 1}, y ${oy}..${oy + file.size.y - 1}, z ${oz}..${oz + file.size.z - 1}`,
      )
    }
    const ids = (key: string): string[] | undefined => {
      if (p[key] === undefined) return undefined
      if (!Array.isArray(p[key])) throw new RpcError('bad_request', `${key} must be a list of block ids`)
      return (p[key] as unknown[]).map(String)
    }
    const only = ids('only')
    const clear = ids('clear') ?? []
    return {
      blueprint: file,
      ox,
      oy,
      oz,
      x1,
      y1,
      z1,
      x2,
      y2,
      z2,
      ...(only ? { only: new Set(only) } : {}),
      skip: new Set(ids('skip') ?? []),
      clear: new Set(clear.filter((id) => id !== 'natural' && id !== 'plants')),
      clearNatural: clear.includes('natural'),
      clearPlants: clear.includes('plants'),
    }
  }

  /** 图纸在世界的这一格要什么：kinds 的下标（0 是“要空着”）；undefined 是图纸不管这一格。 */
  private blueprintWant(plan: BlueprintPlan, x: number, y: number, z: number): number | undefined {
    const b = plan.blueprint
    const index = b.cells[x - plan.ox + ((y - plan.oy) * b.size.z + (z - plan.oz)) * b.size.x]!
    if (index === 0) return plan.only ? undefined : 0
    const id = b.kinds[index]!.id
    if ((plan.only && !plan.only.has(id)) || plan.skip.has(id)) return undefined
    return index
  }

  /** 挡路的这种方块，clear 允不允许挖。 */
  private blueprintMayRemove(plan: BlueprintPlan, id: string): boolean {
    return plan.clear.has(id) || (plan.clearNatural && NATURAL_BLOCKS.has(id)) || (plan.clearPlants && PLANT_BLOCKS.has(id))
  }

  /** 把假世界和图纸逐格对比，结果的形状和真实 mod 的 blueprint.check 一样。 */
  private surveyBlueprint(plan: BlueprintPlan, bot: MockBot | undefined, layers: boolean): Json {
    const kinds = plan.blueprint.kinds
    let cells = 0
    let done = 0
    let toPlace = 0
    let byHand = 0
    let blocked = 0
    let extra = 0
    let unloaded = 0
    let willRemove = 0
    const need = new Array<number>(kinds.length).fill(0)
    const hand = new Array<number>(kinds.length).fill(0)
    type Tally = { id: string; name: string; count: number; removable: number; holdsData: number }
    const blockedBy = new Map<string, Tally>()
    const extras = new Map<string, Tally>()
    const tally = (into: Map<string, Tally>, block: Json, removable: boolean): boolean => {
      const id = String(block.id)
      const t = into.get(id) ?? { id, name: String(block.name), count: 0, removable: 0, holdsData: 0 }
      into.set(id, t)
      t.count++
      // 带数据的方块谁也不动，哪怕 clear 里写了它
      if (block.tileEntity === true) t.holdsData++
      else if (removable) t.removable++
      return removable && block.tileEntity !== true
    }
    const perLayer: number[][] = []
    for (let y = plan.y1; y <= plan.y2; y++) {
      const row = [y, 0, 0, 0, 0, 0] // [y, 图纸方块数, done, toPlace, blocked, extra]
      for (let x = plan.x1; x <= plan.x2; x++) {
        for (let z = plan.z1; z <= plan.z2; z++) {
          const want = this.blueprintWant(plan, x, y, z)
          if (want === undefined) continue
          if (want !== 0) row[1]!++
          const block = this.blockAt(x, y, z)
          if (block.loaded === false) {
            unloaded++
          } else if (want === 0) {
            if (block.air === true) continue
            row[5]!++
            if (tally(extras, block, this.blueprintMayRemove(plan, String(block.id)))) willRemove++
          } else if (block.id === kinds[want]!.id && block.meta === kinds[want]!.meta) {
            row[2]!++
          } else if (block.air === true) {
            if (kinds[want]!.byHand === undefined) {
              row[3]!++
              need[want]!++
            } else {
              byHand++
              hand[want]!++
            }
          } else {
            row[4]!++
            if (tally(blockedBy, block, this.blueprintMayRemove(plan, String(block.id)))) {
              willRemove++
              // 挖掉以后这一格也要放
              if (kinds[want]!.byHand === undefined) need[want]!++
            }
          }
        }
      }
      cells += row[1]!
      done += row[2]!
      toPlace += row[3]!
      blocked += row[4]!
      extra += row[5]!
      if (row[1]! > 0 || row[5]! > 0) perLayer.push(row)
    }

    const byCount = (counts: number[]) =>
      kinds
        .map((k, i) => ({ k, n: counts[i]! }))
        .filter((e) => e.n > 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, BLUEPRINT_LIST_LIMIT)
    const tallies = (map: Map<string, Tally>) =>
      [...map.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, BLUEPRINT_LIST_LIMIT)
        .map((t) => ({
          id: t.id,
          name: t.name,
          count: t.count,
          removable: t.removable,
          ...(t.holdsData > 0 ? { holdsData: t.holdsData } : {}),
          ...(NATURAL_BLOCKS.has(t.id) ? { natural: true } : {}),
        }))
    const byHandBlocks = byCount(hand).map(({ k, n }) => ({ id: k.id, meta: k.meta, name: k.name, count: n, why: k.byHand }))
    return {
      name: plan.blueprint.name,
      origin: { x: plan.ox, y: plan.oy, z: plan.oz },
      box: { x1: plan.x1, y1: plan.y1, z1: plan.z1, x2: plan.x2, y2: plan.y2, z2: plan.z2 },
      cells,
      done,
      toPlace,
      byHand,
      blocked,
      extra,
      willRemove,
      // 为 0 时省略
      ...(unloaded > 0 ? { unloaded } : {}),
      // have 只在给了 bot 时有
      materials: byCount(need).map(({ k, n }) => ({ id: k.id, meta: k.meta, name: k.name, need: n, ...(bot ? { have: carried(bot, k) } : {}) })),
      ...(byHandBlocks.length > 0 ? { byHandBlocks } : {}),
      ...(blockedBy.size > 0 ? { blockedBy: tallies(blockedBy) } : {}),
      ...(extras.size > 0 ? { extraBlocks: tallies(extras) } : {}),
      ...(layers ? { layers: perLayer } : {}),
    }
  }

  /**
   * blueprint 任务做完时的样子：先挖掉挡路又允许挖的，再放方块，材料从背包拿、不够时从 supply 的容器拿。
   * 哪种都拿不到的先跳过，最后以 no_material 失败，detail.missing 列出每种缺多少。
   * 结果里的 now 是做完以后再对比一次得到的。（够不着、没工具、背包满这些情况这里不模拟。）
   */
  private buildBlueprint(bot: MockBot, task: MockTask): { result: Json; error?: NonNullable<MockTask['error']> } {
    const plan = this.blueprintPlan(task.params)
    const kinds = plan.blueprint.kinds
    const supply = positions(task.params.supply)
      .map((at) => this.containers.find((c) => c.x === at.x && c.y === at.y && c.z === at.z))
      .filter((c): c is MockContainer => c !== undefined)
    let removed = 0
    let placed = 0
    const starved = new Array<number>(kinds.length).fill(0)
    for (let y = plan.y2; y >= plan.y1; y--) {
      for (let x = plan.x1; x <= plan.x2; x++) {
        for (let z = plan.z1; z <= plan.z2; z++) {
          const want = this.blueprintWant(plan, x, y, z)
          const block = this.blockAt(x, y, z)
          if (want === undefined || block.loaded === false || block.air === true || block.tileEntity === true) continue
          if (want !== 0 && block.id === kinds[want]!.id && block.meta === kinds[want]!.meta) continue
          if (!this.blueprintMayRemove(plan, String(block.id))) continue
          this.changedBlocks.set(`${x},${y},${z}`, null)
          removed++
        }
      }
    }
    for (let y = plan.y1; y <= plan.y2; y++) {
      for (let x = plan.x1; x <= plan.x2; x++) {
        for (let z = plan.z1; z <= plan.z2; z++) {
          const want = this.blueprintWant(plan, x, y, z)
          if (!want || kinds[want]!.byHand !== undefined || this.blockAt(x, y, z).air !== true) continue
          const kind = kinds[want]!
          if (takeOne(bot.inventory, kind) || supply.some((box) => takeOne(box.items, kind))) {
            this.changedBlocks.set(`${x},${y},${z}`, { id: kind.id, meta: kind.meta, name: kind.name })
            placed++
          } else {
            starved[want]!++
          }
        }
      }
    }
    bot.inventory = bot.inventory.filter((i) => i.count > 0)
    for (const box of supply) box.items = box.items.filter((i) => i.count > 0)

    const now = this.surveyBlueprint(plan, bot, false)
    const result: Json = { removed, placed, freeSlots: 36 - bot.inventory.length, now: {} }
    for (const key of ['cells', 'done', 'toPlace', 'byHand', 'blocked', 'extra', 'unloaded']) {
      if (now[key] !== undefined) (result.now as Json)[key] = now[key]
    }
    for (const key of ['materials', 'byHandBlocks', 'blockedBy', 'extraBlocks']) {
      if (Array.isArray(now[key])) result[key] = (now[key] as unknown[]).slice(0, BLUEPRINT_SUMMARY_LIMIT)
    }
    const missing = starved.map((count, i) => ({ id: kinds[i]!.id, meta: kinds[i]!.meta, name: kinds[i]!.name, count })).filter((m) => m.count > 0)
    if (missing.length === 0) return { result }
    const total = missing.reduce((n, m) => n + m.count, 0)
    return {
      result,
      error: {
        code: 'no_material',
        message: `${total} blocks were left unplaced for want of material${supply.length === 0 ? '; no supply container was given' : ''}`,
        detail: { missing },
      },
    }
  }

  /** 下线或死亡：当前任务以 interrupted 失败。（下线时任务留在存档里，这里简化成直接结束。） */
  private interrupt(bot: MockBot, message: string): void {
    if (!bot.task) return
    const task = bot.task
    bot.task = null
    this.markRunning(bot, task)
    this.finalize(bot, task, 'failed', { error: { code: 'interrupted', message } })
  }
}

/** 一个形状和真实 mod 一致的任务结果，给自动完成和手动 done 用。 */
export function sampleResult(task: MockTask): Json {
  const p = task.params
  switch (task.type) {
    case 'flatten':
      return {
        removed: 37,
        placed: 4,
        skipped: { 'hole deeper than maxFillDepth (columns)': 1 },
        skippedExamples: [{ x: Number(p.x1 ?? 0) + 1, y: Number(p.y ?? 64) - 4, z: Number(p.z1 ?? 0) + 1, reason: 'hole deeper than maxFillDepth (columns)' }],
        freeSlots: 20,
        level: Number(p.y ?? 64),
      }
    case 'clear':
      return { removed: 120, placed: 0, freeSlots: 12, clearedDownTo: Math.min(Number(p.y1 ?? 0), Number(p.y2 ?? 0)) }
    case 'fill':
      // 放下去的方块是从哪种物品放的（真的身体照放的时候手里那一组记）
      return { removed: 0, placed: 64, ...(typeof p.item === 'string' ? { placedItems: [{ id: p.item, meta: typeof p.meta === 'number' ? p.meta : 0, count: 64 }] } : {}), freeSlots: 30 }
    case 'place': {
      const kinds = new Map<string, { id: string; meta: number; count: number }>()
      for (const b of (Array.isArray(p.blocks) ? p.blocks : []) as Json[]) {
        const key = `${String(b.item)}/${typeof b.meta === 'number' ? b.meta : 0}`
        const kind = kinds.get(key) ?? { id: String(b.item), meta: typeof b.meta === 'number' ? b.meta : 0, count: 0 }
        kind.count++
        kinds.set(key, kind)
      }
      const placed = [...kinds.values()].reduce((n, k) => n + k.count, 0)
      return { removed: 0, placed, ...(placed > 0 ? { placedItems: [...kinds.values()] } : {}), freeSlots: 30 }
    }
    case 'dig':
      return { removed: Array.isArray(p.blocks) ? p.blocks.length : 0, placed: 0, freeSlots: 28 }
    case 'deposit':
      return { moved: 64, freeSlots: 30 }
    case 'haul':
      return { moved: 64, trips: 1 }
    case 'collect':
      return { pickedUpStacks: 2 }
    case 'give':
      return { dropped: (Array.isArray(p.items) ? (p.items as Json[]) : []).reduce((n, i) => n + (typeof i.count === 'number' ? i.count : 1), 0) }
    case 'goto':
      return { block: { x: Number(p.x ?? 0), y: Number(p.y ?? 64), z: Number(p.z ?? 0) } }
    case 'home':
      return { dim: 0, block: { x: 0, y: 64, z: 0 } }
    case 'hold': {
      // 假世界里按键不让它动：在原地站满时间（真的身体在这里照世界和背上的东西动）
      const here = { x: 10.5, y: 64, z: -3.5 }
      return { held: Number(p.ticks ?? 0), stopped: 'ticks', from: here, pos: here, block: { x: 10, y: 64, z: -4 }, onGround: true, aboveGround: 0, motion: { x: 0, y: 0, z: 0 }, lowest: 64, highest: 64, track: [{ ...here, t: 0, above: 0 }] }
    }
    default:
      return {}
  }
}

/** 在 on() 的处理函数里返回它，表示这条请求不回复（用来测超时）。 */
export const NO_REPLY = Symbol('no-reply')

// ── 机器 ──

/** world.machines 里一台机器的样子；process 任务失败时的 detail 也是它。 */
function describeMachine(m: MockMachine): Json {
  return {
    x: m.x,
    y: m.y,
    z: m.z,
    name: m.name,
    recipes: m.recipes,
    tier: m.tier,
    inputSlots: m.inputSlots,
    active: m.active === true,
    storedEU: m.storedEU,
    inputVoltage: m.inputVoltage,
    ...(m.switchedOff ? { switchedOff: true } : {}),
    ...(m.itemAutoOutput ? { autoOutput: { items: true, fluids: false, side: m.itemAutoOutput.side, to: m.itemAutoOutput.to } } : {}),
    ...(m.id !== undefined ? { id: m.id, meta: m.meta ?? 0 } : {}),
    ...(m.recipeKey !== undefined ? { recipeKey: m.recipeKey } : {}),
    ...(m.more ?? {}),
    ...attachments(m),
  }
}

// ── 任务书 ──

/**
 * 模拟 bridge 自带的任务书：两章六个任务，各种子任务类型都有一个。
 * 自带的进度里 Steve 做完了前两个（第二个的奖励还没领），所以他现在能做的是 43、4a 和那个 UUID 任务，47 还锁着。
 */
export function defaultQuestBook(): MockQuest[] {
  const GT = 'gregtech:gt.metaitem.01'
  return [
    {
      id: '1',
      name: 'The Beginning',
      line: 'Tier 0 - Stone Age',
      description: 'Welcome to GregTech: New Horizons! Punch a tree to get some wood.',
      requires: [],
      tasks: [{ type: 'retrieval', consumed: false, items: [{ id: 'minecraft:log', count: 4, name: 'Oak Wood', ore: 'logWood' }] }],
      rewards: [{ type: 'item', items: [{ id: 'minecraft:apple', meta: 0, count: 4, name: 'Apple' }] }],
    },
    {
      id: '2',
      name: 'Tools of the Trade',
      line: 'Tier 0 - Stone Age',
      description: 'Vanilla tools do not work here. Build a Tinkers Construct pickaxe.',
      requires: ['1'],
      tasks: [{ type: 'crafting', items: [{ id: 'TConstruct:pickaxe', count: 1, name: 'Pickaxe' }] }],
      rewards: [{ type: 'choice', items: [{ id: 'minecraft:bread', meta: 0, count: 8, name: 'Bread' }, { id: 'minecraft:torch', meta: 0, count: 16, name: 'Torch' }] }],
    },
    {
      id: '43',
      name: 'Wired, Weird?!',
      line: 'Tier 0.5 - Steam',
      description: 'Cables carry electricity. Make some tin cables to get started with LV.',
      requires: ['2'],
      tasks: [{ type: 'retrieval', consumed: true, items: [{ id: 'gregtech:gt.blockmachines', meta: 1246, count: 4, name: '1x Tin Cable' }] }],
      rewards: [{ type: 'item', items: [{ id: GT, meta: 32000, count: 5, name: 'Copper Coin' }] }],
    },
    {
      id: '47',
      name: 'Basic Crafting: Motors',
      line: 'Tier 0.5 - Steam',
      description: 'Motors are little devices that turn electricity into motion. You will need a lot of them.',
      requires: ['43'],
      tasks: [
        { type: 'crafting', items: [{ id: GT, meta: 32600, count: 2, name: 'Electric Motor (LV)' }] },
        { type: 'optional_retrieval', consumed: false, items: [{ id: GT, meta: 23032, count: 2, name: 'Magnetic Iron Rod' }] },
      ],
      rewards: [{ type: 'item', items: [{ id: GT, meta: 32000, count: 15, name: 'Copper Coin' }] }],
    },
    {
      id: '4a',
      name: 'Take to the Skies',
      line: 'Tier 0.5 - Steam',
      description: 'A Copter Pack lets you hover around your base. Build one and show it to me.',
      requires: [],
      tasks: [{ type: 'retrieval', consumed: false, items: [{ id: 'adventurebackpack:copterPack', meta: 0, count: 1, name: 'Copter Pack' }] }],
      rewards: [{ type: 'item', items: [{ id: GT, meta: 32000, count: 10, name: 'Copper Coin' }] }],
    },
    {
      id: 'a81f1f2c-3d7e-4a4c-9a55-1f2e3d4c5b6a',
      name: 'Night Watch',
      line: 'Tier 0 - Stone Age',
      description: 'The nights are dangerous. Thin out the zombies, then visit the old watchtower and bring a bucket of water.',
      requires: [],
      tasks: [
        { type: 'hunt', target: 'Zombie', count: 10 },
        { type: 'location', location: { x: 120, y: 70, z: -340, dim: 0 } },
        { type: 'fluid', fluids: [{ fluid: 'water', mb: 1000 }] },
      ],
      rewards: [],
    },
  ]
}

// ── 物品、配方、合成 ──

/** 从一组物品里拿走最多 n 个符合条件的，返回拿到的（按种类）。 */
function takeItems<T extends { id: string; meta: number; name: string; count: number }>(
  items: T[],
  fits: (item: T) => boolean,
  n: number,
): { id: string; meta: number; name: string; count: number }[] {
  const taken: { id: string; meta: number; name: string; count: number }[] = []
  for (const stack of items) {
    if (n <= 0) break
    if (!fits(stack) || stack.count <= 0) continue
    const take = Math.min(stack.count, n)
    stack.count -= take
    n -= take
    taken.push({ id: stack.id, meta: stack.meta, name: stack.name, count: take })
  }
  return taken
}

/** 往背包里放东西：同种的叠在已有的那一格上（这里不管一组 64 个的上限），否则占一个空格。 */
function putInInventory(bot: MockBot, item: { id: string; meta: number; name: string }, count: number): void {
  if (count <= 0) return
  const stack = bot.inventory.find((i) => i.id === item.id && i.meta === item.meta)
  if (stack) {
    stack.count += count
    return
  }
  let slot = 0
  while (bot.inventory.some((i) => i.slot === slot)) slot++
  bot.inventory.push({ slot, id: item.id, meta: item.meta, count, name: item.name })
}

/**
 * 模拟 bridge 自带的配方书：够走一遍“给一个目标它自己去办”——
 * Copter Pack 要 Copter Blades（手工 3x3，要螺丝和一把只磨损不消耗的螺丝刀）和 Copter Engine（只有机器配方）；
 * 螺丝只有机器配方；木板、木棍是 2x2 的；铁锭是熔炉烧的。
 */
export function defaultRecipeBook(): MockRecipeItem[] {
  const GT = 'gregtech:gt.metaitem.01'
  return [
    {
      id: 'adventurebackpack:copterPack',
      meta: 0,
      name: 'Copter Pack',
      crafting: [
        {
          gives: 1,
          grid: '3x3',
          ingredients: [
            { count: 1, id: 'adventurebackpack:backpackComponent', meta: 6 },
            { count: 1, id: 'adventurebackpack:backpackComponent', meta: 5 },
            { count: 4, ore: 'plateSteel' },
          ],
        },
      ],
    },
    {
      id: 'adventurebackpack:backpackComponent',
      meta: 6,
      name: 'Copter Blades',
      crafting: [
        {
          gives: 1,
          grid: '3x3',
          ingredients: [
            { count: 4, id: 'IC2:itemRecipePart', meta: 12 },
            { count: 3, ore: 'screwSteel' },
            { count: 1, ore: 'craftingToolScrewdriver', tool: true },
          ],
        },
      ],
    },
    {
      id: 'adventurebackpack:backpackComponent',
      meta: 5,
      name: 'Copter Engine',
      machines: [
        {
          machine: 'Assembler',
          tier: 'LV',
          eut: 30,
          seconds: 10,
          inputs: [
            { id: GT, meta: 32600, name: 'Electric Motor (LV)', count: 2 },
            { id: GT, meta: 17305, name: 'Steel Plate', count: 4 },
            { id: 'gregtech:gt.integrated_circuit', meta: 2, name: 'Programmed Circuit', count: 0, notConsumed: true },
          ],
          outputs: [{ id: 'adventurebackpack:backpackComponent', meta: 5, name: 'Copter Engine', count: 1 }],
        },
      ],
    },
    { id: 'IC2:itemRecipePart', meta: 12, name: 'Shaft (Refined Iron)' },
    {
      id: GT,
      meta: 27305,
      name: 'Steel Screw',
      ores: ['screwSteel'],
      machines: [
        { machine: 'Lathe', tier: 'LV', eut: 16, seconds: 2.5, inputs: [{ id: GT, meta: 26305, name: 'Steel Bolt', count: 1 }], outputs: [{ id: GT, meta: 27305, name: 'Steel Screw', count: 1 }] },
        ...[8, 24, 30].map((eut) => ({
          machine: 'Fluid Solidifier',
          tier: eut <= 8 ? 'ULV' : 'LV',
          eut,
          seconds: 1.6,
          inputs: [{ id: GT, meta: 32307, name: 'Mold (Screw)', count: 0, notConsumed: true }],
          fluidInputs: [{ name: 'Molten Steel', mb: 18 }],
          outputs: [{ id: GT, meta: 27305, name: 'Steel Screw', count: 1 }],
        })),
      ],
    },
    { id: GT, meta: 17305, name: 'Steel Plate', ores: ['plateSteel'] },
    { id: GT, meta: 11305, name: 'Steel Ingot', ores: ['ingotSteel'] },
    {
      // 真实基地里验证过的那条：车床把钢锭车成钢杆，带出两小堆钢粉
      id: GT,
      meta: 23305,
      name: 'Steel Rod',
      ores: ['stickSteel'],
      machines: [
        {
          machine: 'Lathe',
          tier: 'LV',
          eut: 16,
          seconds: 8,
          inputs: [{ id: GT, meta: 11305, name: 'Steel Ingot', count: 1 }],
          outputs: [
            { id: GT, meta: 23305, name: 'Steel Rod', count: 1 },
            { id: GT, meta: 1305, name: 'Small Pile of Steel Dust', count: 2 },
          ],
        },
      ],
    },
    { id: 'gregtech:gt.metatool.01', meta: 22, name: 'Screwdriver', ores: ['craftingToolScrewdriver'] },
    { id: 'minecraft:log', meta: 0, name: 'Oak Wood', ores: ['logWood'] },
    { id: 'minecraft:planks', meta: 0, name: 'Oak Wood Planks', ores: ['plankWood'], crafting: [{ gives: 4, grid: '2x2', ingredients: [{ count: 1, ore: 'logWood' }] }] },
    { id: 'minecraft:stick', meta: 0, name: 'Stick', ores: ['stickWood'], crafting: [{ gives: 4, grid: '2x2', ingredients: [{ count: 2, ore: 'plankWood' }] }] },
    { id: 'minecraft:iron_ingot', meta: 0, name: 'Iron Ingot', ores: ['ingotIron'], smeltedFrom: [{ id: 'minecraft:iron_ore', meta: 0, name: 'Iron Ore', count: 1 }] },
    { id: 'minecraft:cobblestone', meta: 0, name: 'Cobblestone', ores: ['cobblestone'] },
  ]
}

// ── 图纸 ──

interface BlueprintPlan {
  blueprint: MockBlueprint
  /** 图纸最小角落在世界里的位置。 */
  ox: number
  oy: number
  oz: number
  /** 实际处理的范围（世界坐标）。 */
  x1: number
  y1: number
  z1: number
  x2: number
  y2: number
  z2: number
  only?: Set<string>
  skip: Set<string>
  clear: Set<string>
  clearNatural: boolean
  clearPlants: boolean
}

/** 图纸名就是去掉后缀的文件名：不能带目录，不能是隐藏文件。 */
function blueprintName(raw: unknown): string {
  if (typeof raw !== 'string') throw new RpcError('bad_request', 'missing or non-text field: name')
  const name = raw.endsWith('.schematic') ? raw.slice(0, -'.schematic'.length) : raw
  if (name.length === 0 || name.length > 80 || name.startsWith('.') || name.includes('..') || /[/\\:*?"<>|\u0000-\u001f]/.test(name)) {
    throw new RpcError('bad_request', `not a usable blueprint name: ${name}`)
  }
  return name
}

function describeBlueprint(b: MockBlueprint): Json {
  return { size: { ...b.size }, blocks: b.cells.reduce((n, kind) => n + (kind === 0 ? 0 : 1), 0) }
}

/** 这种方块 bot 放不了的原因（带内容或设置、朝向取决于怎么放）；能放的返回 undefined。 */
function byHandReason(id: string): string | undefined {
  if (/chest|drawers|furnace|hopper|dispenser|blockmachines/i.test(id)) return 'it holds contents or settings'
  if (/stairs|log|torch|ladder|door|lever|button|rail|sign|piston/i.test(id)) return 'which way it faces depends on how it is placed'
  return undefined
}

/** minecraft:stone_slab → Stone Slab：给图纸里的方块编一个显示名。 */
function blockLabel(id: string): string {
  return id
    .slice(id.indexOf(':') + 1)
    .split(/[_.]/)
    .filter((w) => w.length > 0)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

/** 背包里有多少个这种方块。 */
function carried(bot: MockBot, kind: { id: string; meta: number }): number {
  return bot.inventory.filter((i) => i.id === kind.id && i.meta === kind.meta).reduce((n, i) => n + i.count, 0)
}

/** 从一组物品里拿走一个这种方块；没有就返回 false。 */
function takeOne(items: { id: string; meta: number; count: number }[], kind: { id: string; meta: number }): boolean {
  const stack = items.find((i) => i.id === kind.id && i.meta === kind.meta && i.count > 0)
  if (!stack) return false
  stack.count--
  return true
}

/** supply / dropoff：一个坐标或坐标数组。 */
function positions(v: unknown): { x: number; y: number; z: number }[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]
  return list.filter((p): p is { x: number; y: number; z: number } => p !== null && typeof p === 'object' && typeof (p as Json).x === 'number')
}

/**
 * 模拟 bridge 自带的一张图纸：5×4×5 的圆石小屋（地板、四面墙、屋顶），屋里一个箱子，南墙上留了一个两格高的门洞。
 * 圆石 bot 能放，箱子得由人放。
 */
export function hutBlueprint(name: string): MockBlueprint {
  const size = { x: 5, y: 4, z: 5 }
  const cells = new Uint16Array(size.x * size.y * size.z)
  for (let y = 0; y < size.y; y++) {
    for (let z = 0; z < size.z; z++) {
      for (let x = 0; x < size.x; x++) {
        const shell = y === 0 || y === size.y - 1 || x === 0 || x === size.x - 1 || z === 0 || z === size.z - 1
        const doorway = x === 2 && z === size.z - 1 && (y === 1 || y === 2)
        if (shell && !doorway) cells[x + (y * size.z + z) * size.x] = 1
      }
    }
  }
  cells[1 + (1 * size.z + 1) * size.x] = 2
  return {
    name,
    size,
    kinds: [
      { id: 'minecraft:air', meta: 0, name: 'Air' },
      { id: 'minecraft:cobblestone', meta: 0, name: 'Cobblestone' },
      { id: 'minecraft:chest', meta: 3, name: 'Chest', byHand: 'it holds contents or settings' },
    ],
    cells,
  }
}

/** 读未压缩的 NBT，返回根复合标签。字节数组是 Buffer，整数数组不需要所以跳过。数据不完整时抛错。 */
function readNbt(buf: Buffer): Json {
  let at = 0
  const text = (): string => {
    const n = buf.readUInt16BE(at)
    at += 2 + n
    return buf.toString('utf8', at - n, at)
  }
  const payload = (type: number): unknown => {
    switch (type) {
      case 1:
        return buf.readInt8(at++)
      case 2:
        at += 2
        return buf.readInt16BE(at - 2)
      case 3:
        at += 4
        return buf.readInt32BE(at - 4)
      case 4:
        at += 8
        return buf.readBigInt64BE(at - 8)
      case 5:
        at += 4
        return buf.readFloatBE(at - 4)
      case 6:
        at += 8
        return buf.readDoubleBE(at - 8)
      case 7: {
        const n = buf.readInt32BE(at)
        at += 4 + n
        if (n < 0 || at > buf.length) throw new Error('truncated byte array')
        return buf.subarray(at - n, at)
      }
      case 8:
        return text()
      case 9: {
        const itemType = buf.readUInt8(at)
        const n = buf.readInt32BE(at + 1)
        at += 5
        const out: unknown[] = []
        for (let i = 0; i < n; i++) out.push(payload(itemType))
        return out
      }
      case 10: {
        const out: Json = {}
        for (;;) {
          const t = buf.readUInt8(at++)
          if (t === 0) return out
          const name = text()
          out[name] = payload(t)
        }
      }
      case 11: {
        const n = buf.readInt32BE(at)
        at += 4 + n * 4
        return undefined
      }
      default:
        throw new Error(`unknown NBT tag ${type}`)
    }
  }
  if (buf.readUInt8(at++) !== 10) throw new Error('the root is not a compound tag')
  text()
  return payload(10) as Json
}

/**
 * 把一个 Schematica 的 .schematic 文件读成假图纸。和真实 mod 一样：方块按文件自带的注册名（SchematicaMapping）对应，
 * 不是能用的图纸时以 bad_request 说明原因（原话照真实 mod 的）。
 */
/**
 * blueprint.read 的回答，照真的身体：整张图纸的材料表（多的在前，得由人放的带 byHand），加上 from..to 这个盒子里的格子
 * （调色板 + “下标, 连续几格”，和 world.blocks 同一种写法）。一次最多 262144 格；cells:false 只给材料表。
 */
export function readBlueprintAnswer(b: MockBlueprint, p: Record<string, unknown>): Record<string, unknown> {
  const counts = new Array<number>(b.kinds.length).fill(0)
  for (const index of b.cells) counts[index]!++
  const kind = (k: MockBlueprint['kinds'][number]): Record<string, unknown> => ({ id: k.id, meta: k.meta, name: k.name, ...(k.byHand !== undefined ? { byHand: k.byHand } : {}) })
  const materials = b.kinds
    .map((k, index) => ({ k, n: counts[index]! }))
    .filter(({ n }, index) => index > 0 && n > 0)
    .sort((x, y) => y.n - x.n)
    .map(({ k, n }) => ({ ...kind(k), count: n }))
  const out: Record<string, unknown> = { name: b.name, size: b.size, blocks: materials.reduce((n, m) => n + (m.count as number), 0), materials }
  if (p.cells === false) return out
  const corner = (v: unknown, fallback: { x: number; y: number; z: number }) => {
    const o = v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
    return o ? { x: Number(o.x ?? fallback.x), y: Number(o.y ?? fallback.y), z: Number(o.z ?? fallback.z) } : fallback
  }
  const from = corner(p.from, { x: 0, y: 0, z: 0 })
  const far = corner(p.to, { x: b.size.x - 1, y: b.size.y - 1, z: b.size.z - 1 })
  const to = { x: Math.min(far.x, b.size.x - 1), y: Math.min(far.y, b.size.y - 1), z: Math.min(far.z, b.size.z - 1) }
  if (from.x < 0 || from.y < 0 || from.z < 0 || to.x < from.x || to.y < from.y || to.z < from.z) {
    throw new RpcError('bad_request', `from and to are positions inside the plan, counted from 0 at its lowest corner; it is ${b.size.x} x ${b.size.y} x ${b.size.z}`)
  }
  const [sx, sy, sz] = [to.x - from.x + 1, to.y - from.y + 1, to.z - from.z + 1]
  if (sx * sy * sz > 262144) {
    throw new RpcError('too_large', `that is ${sx * sy * sz} cells; one read gives at most 262144: give from and to and read the plan a part at a time (cells:false gives the materials alone)`)
  }
  const palette: Record<string, unknown>[] = [{ id: 'minecraft:air', meta: 0 }]
  const index = new Map<number, number>([[0, 0]])
  const runs: number[] = []
  for (let y = from.y; y <= to.y; y++) {
    for (let z = from.z; z <= to.z; z++) {
      for (let x = from.x; x <= to.x; x++) {
        const k = b.cells[x + (y * b.size.z + z) * b.size.x]!
        if (!index.has(k)) index.set(k, palette.push(kind(b.kinds[k]!)) - 1)
        const i = index.get(k)!
        if (runs.length > 0 && runs[runs.length - 2] === i) runs[runs.length - 1]!++
        else runs.push(i, 1)
      }
    }
  }
  return { ...out, x: from.x, y: from.y, z: from.z, sx, sy, sz, palette, runs }
}

export function readSchematic(name: string, bytes: Buffer): MockBlueprint {
  const bad = (message: string) => new RpcError('bad_request', message)
  let tag: Json
  try {
    tag = readNbt(zlib.gunzipSync(bytes))
  } catch {
    throw bad('not a .schematic file (it is not gzip-compressed NBT)')
  }
  const size = { x: Number(tag.Width ?? 0), y: Number(tag.Height ?? 0), z: Number(tag.Length ?? 0) }
  if (!(size.x > 0 && size.y > 0 && size.z > 0)) throw bad('the file gives no size')
  if (size.y > 256) throw bad(`the plan is ${size.y} high; the world is 256`)
  const volume = size.x * size.y * size.z
  const ids = tag.Blocks
  const data = tag.Data
  if (!Buffer.isBuffer(ids) || !Buffer.isBuffer(data) || ids.length !== volume || data.length !== volume) {
    throw bad('the block data does not match the size the file gives')
  }
  const names = new Map<number, string>()
  const mapping = tag.SchematicaMapping
  if (mapping !== null && typeof mapping === 'object') {
    for (const [blockId, n] of Object.entries(mapping as Json)) if (typeof n === 'number') names.set(n & 0xffff, blockId)
  }
  if (names.size === 0) throw bad('the file does not say which blocks its numbers stand for; save it with Schematica')
  // 255 以上的 id，高位存在 AddBlocks 的半字节里。哪个半字节对应哪一格有两种习惯，每个 id 都有名字的那种才对。
  const nibbles = Buffer.isBuffer(tag.AddBlocks) && tag.AddBlocks.length >= Math.floor((volume + 1) / 2) ? tag.AddBlocks : undefined
  const idAt = (i: number, schematicaOrder: boolean): number => {
    if (!nibbles) return ids[i]!
    const b = nibbles[i >> 1]!
    return ids[i]! | (((i & 1) === 0) === schematicaOrder ? b >> 4 : b & 0xf) << 8
  }
  const allKnown = (order: boolean): boolean => {
    for (let i = 0; i < volume; i++) if (!names.has(idAt(i, order))) return false
    return true
  }
  let schematicaOrder = true
  if (nibbles && !allKnown(true)) {
    if (!allKnown(false)) throw bad('the block ids do not match the block names in the file')
    schematicaOrder = false
  }

  const kinds: MockBlueprint['kinds'] = [{ id: 'minecraft:air', meta: 0, name: 'Air' }]
  const kindOf = new Map<string, number>()
  const cells = new Uint16Array(volume)
  for (let i = 0; i < volume; i++) {
    const blockId = names.get(idAt(i, schematicaOrder))
    if (blockId === undefined) throw bad('the file uses a block id it gives no name for')
    if (blockId === 'minecraft:air') continue
    const meta = data[i]! & 0xf
    const key = `${blockId}/${meta}`
    let index = kindOf.get(key)
    if (index === undefined) {
      index = kinds.length
      const why = byHandReason(blockId)
      kinds.push({ id: blockId, meta, name: blockLabel(blockId), ...(why ? { byHand: why } : {}) })
      kindOf.set(key, index)
    }
    cells[i] = index
  }
  return { name, size, kinds, cells }
}

// ── 独立运行 ──

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}

async function standalone(): Promise<void> {
  const botName = arg('bot') ?? 'Alu'
  const wantPort = Number(arg('port') ?? process.env.MOCK_BRIDGE_PORT ?? MOCK_BRIDGE_DEFAULT_PORT)
  checkMockPort(wantPort, '模拟 bridge')
  const bridge = new MockBridge({
    port: wantPort,
    token: arg('token') ?? 'mock-token',
    autoFinishMs: Number(arg('auto') ?? 5000),
    bots: [botName],
  })
  const port = await bridge.start()
  console.log(`模拟 bridge 在 127.0.0.1:${port} 监听，口令 ${bridge.token}，bot ${botName} 已在线，任务 ${bridge.autoFinishMs} ms 后自动完成。`)
  console.log(`启动大脑：AIPLAYER_BRIDGE_PORT=${port} AIPLAYER_BRIDGE_TOKEN=${bridge.token} npm start`)
  console.log('输入 help 看可用指令。')

  const help = [
    'chat <玩家> <话>        在公共聊天说一句',
    'whisper <玩家> <话>     私聊 bot',
    'done                   当前任务完成（照图纸建的任务按背包和 supply 里的材料算结果，不够就是 no_material）',
    'fail <错误码> [说明]    当前任务失败（如 fail no_tool 没有镐子）',
    'join <玩家> / leave <玩家>',
    'hurt <血量>            bot 受伤后剩余血量',
    'die                    bot 死亡（一秒多后自动重生）',
    'kick                   bot 被踢下线',
    'drop                   断开所有连接（模拟闪断）',
    'restart                模拟服务器重启（新的 epoch）',
    'status                 打印 bot 状态',
  ].join('\n')

  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const [cmd, a, ...rest] = line.trim().split(/\s+/)
    const text = rest.join(' ')
    try {
      switch (cmd) {
        case 'chat':
          bridge.chat(a ?? 'Steve', text)
          break
        case 'whisper':
          bridge.whisper(botName, a ?? 'Steve', text)
          break
        case 'done':
          bridge.completeTask(botName)
          break
        case 'fail':
          bridge.finishTask(botName, { error: { code: a ?? 'stuck', message: text || 'failed by hand' } })
          break
        case 'join':
          bridge.emit('player.join', { player: a ?? 'Alex', uuid: 'uuid-x' })
          break
        case 'leave':
          bridge.emit('player.leave', { player: a ?? 'Alex', uuid: 'uuid-x' })
          break
        case 'hurt':
          bridge.emit('bot.hurt', { bot: botName, source: 'zombie', amount: 4, health: Number(a ?? 5) })
          break
        case 'die':
          bridge.kill(botName)
          break
        case 'kick':
          bridge.kick(botName)
          break
        case 'drop':
          bridge.dropConnections()
          break
        case 'restart':
          bridge.restart()
          break
        case 'status':
          console.log(JSON.stringify(bridge.bots.get(botName), null, 2))
          break
        case 'help':
          console.log(help)
          break
        case undefined:
        case '':
          break
        default:
          console.log(`不认识的指令：${cmd}\n${help}`)
      }
    } catch (e) {
      console.log(`没办成：${e instanceof Error ? e.message : String(e)}`)
    }
  })
  // 把 bot 说的话和执行的指令打到终端上
  let printedChat = 0
  let printedCommands = 0
  setInterval(() => {
    while (printedChat < bridge.chatLog.length) {
      const c = bridge.chatLog[printedChat++]!
      console.log(`<${c.bot}> ${c.message}`)
    }
    while (printedCommands < bridge.commandLog.length) {
      const c = bridge.commandLog[printedCommands++]!
      console.log(`${c.bot} 执行指令：/${c.command}`)
    }
  }, 200)
}

if (import.meta.main) {
  standalone().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
