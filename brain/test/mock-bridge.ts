// 模拟 bridge：按 docs/PROTOCOL.md 实现的服务端，代替游戏里的 mod。
// 行为向真实 mod 看齐（响应的字段、事件和响应的先后顺序、指令回显、任务结果的形状都是对着测试服实测过的），
// 世界本身是假的：一小块固定地形、一个箱子、一个真人玩家。
// 测试里可以脚本化地推事件、让任务按设定结束、断开连接、模拟服务器重启。
// 也能独立运行，方便手动看面板：
//   npm run mock-bridge -- [--port 25600] [--token mock-token] [--auto 5000] [--bot Alu]
// 默认端口 25600。模拟服务只用 25600–25699 或临时端口；游戏服务器和真实 mod 用的端口一律拒绝（见 ports.ts）。
// 独立运行时从标准输入读指令，输入 help 看列表。

import crypto from 'node:crypto'
import net from 'node:net'
import readline from 'node:readline'
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
}

export interface MockContainer {
  x: number
  y: number
  z: number
  id: string
  name: string
  slots: number
  items: { id: string; meta: number; count: number; name: string }[]
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

const TASK_TYPES = new Set(['goto', 'goto_player', 'follow', 'home', 'dig', 'place', 'clear', 'fill', 'flatten', 'deposit', 'withdraw', 'haul', 'collect', 'give', 'wait'])

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
      ],
    },
  ]
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
    return this.emit('chat', { player, uuid: `uuid-${player.toLowerCase()}`, message, isBot: false })
  }

  whisper(bot: string, from: string, message: string): number {
    return this.emit('whisper', { bot, from, message })
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
      freeSlots: 36 - bot.inventory.length,
    }
  }

  /** 假世界里某一格是什么：y=64 是草地，往下是石头，往上是空气。 */
  private blockAt(x: number, y: number, z: number): Json {
    if (Math.abs(x) > LOADED_RADIUS || Math.abs(z) > LOADED_RADIUS) return { x, y, z, loaded: false }
    const chest = this.containers.find((c) => c.x === x && c.y === y && c.z === z)
    if (chest) {
      return { x, y, z, id: chest.id, meta: 3, name: chest.name, air: false, solid: true, liquid: false, replaceable: false, hardness: 2.5, tileEntity: true, inventory: true }
    }
    if (y > 64) return { x, y, z, id: 'minecraft:air', meta: 0, name: 'Air', air: true, solid: false, liquid: false, replaceable: true, hardness: 0, tileEntity: false, inventory: false }
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
      case 'world.block':
        return this.blockAt(this.num(p, 'x'), this.num(p, 'y'), this.num(p, 'z'))
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
      case 'world.find': {
        const c = this.center(p)
        const wanted = Array.isArray(p.blocks) ? (p.blocks as string[]) : []
        const matches = this.containers
          .filter((box) => wanted.includes(box.id))
          .map((box) => ({ x: box.x, y: box.y, z: box.z, id: box.id, meta: 3, dist: Math.hypot(box.x - c.x, box.y - c.y, box.z - c.z) }))
          .sort((a, b) => a.dist - b.dist)
        return { matches, total: matches.length }
      }
      case 'world.containers': {
        this.center(p)
        const containers = this.containers.map((c) => ({ x: c.x, y: c.y, z: c.z, id: c.id, name: c.name, slots: c.slots, usedSlots: c.items.length, items: c.items }))
        return { containers, total: containers.length }
      }
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
        const message = String(p.message ?? '')
          .slice(0, 1000)
          .split(/\r?\n/)
          .map((line) => line.replace(/^[\s/]+/, ''))
          .filter((line) => line.length > 0)
          .join(' ')
        this.chatLog.push({ bot: bot.name, message })
        this.emit('chat', { player: bot.name, uuid: `uuid-${bot.name}`, message, isBot: true })
        return {}
      }
      case 'bot.command':
        return { output: this.command(this.onlineBot(p.bot), String(p.command ?? '')) }
      case 'bot.look':
        this.onlineBot(p.bot)
        return {}
      case 'bot.drop':
        this.onlineBot(p.bot)
        return { dropped: 0 }
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
      const box = this.containers.find((c) => c.x === at.x && c.y === at.y && c.z === at.z)
      if (!box) {
        this.endTask(bot, task, 'failed', { error: { code: 'invalid', message: 'there is no container at that position' } })
        return
      }
      if (task.type === 'withdraw') {
        // 箱子里不够的部分记在 missing 里，任务照样是 done
        const missing: Json[] = []
        let moved = 0
        for (const want of (Array.isArray(p.items) ? p.items : []) as Json[]) {
          const have = box.items.filter((i) => i.id === want.id).reduce((n, i) => n + i.count, 0)
          const count = typeof want.count === 'number' ? want.count : have
          moved += Math.min(have, count)
          if (have < count) missing.push({ id: want.id, count: count - have })
        }
        this.endTask(bot, task, 'done', { result: missing.length > 0 ? { moved, missing } : { moved } })
        return
      }
    }
    if (task.type === 'fill' && typeof p.item === 'string' && !bot.inventory.some((i) => i.id === p.item)) {
      this.endTask(bot, task, 'failed', {
        error: { code: 'no_material', message: `out of ${p.item}; 1 more needed`, detail: { item: { id: p.item }, missing: 1 } },
        result: { removed: 0, placed: 0, freeSlots: 36 - bot.inventory.length },
      })
      return
    }

    if (this.autoFinishMs !== undefined && task.type !== 'follow') {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        if (bot.task === task) this.endTask(bot, task, 'done', { result: sampleResult(task) })
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
    case 'place':
      return { removed: 0, placed: 64, freeSlots: 30 }
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
    default:
      return {}
  }
}

/** 在 on() 的处理函数里返回它，表示这条请求不回复（用来测超时）。 */
export const NO_REPLY = Symbol('no-reply')

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
    'done                   当前任务完成',
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
        case 'done': {
          const running = bridge.bots.get(botName)?.task
          bridge.finishTask(botName, running ? { result: sampleResult(running) } : {})
          break
        }
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
