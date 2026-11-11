// 自动上下线：服务器上没有真人、它手上也没事，过一阵自己下线；有真人进服、主人从面板发指令、它定的提醒到点时再上来。
// 默认关（设置里的 bot.presence.idleOffline）。
//
// 只接自动下线：主人手动点的“下线”不归这里管（那时 wantOnline 是 false，这里什么都不做），手动下线后不会被这里叫上来。
// “它现在是自动下线的”记在配置里（bot.awayIdle），所以大脑重启以后还是：连上游戏不把它叫出来，等上面那三件事。
// 别的 bot 不算真人。它下线以后，谁进了服、谁走了，身体照样会告诉大脑（bridge 连着的是服务器，不是它这个人）。

import { BridgeError } from '../bridge/protocol.ts'
import type { BridgeEvent, ServerInfo, TaskList } from '../bridge/protocol.ts'

export interface PresenceSettings {
  botName: string
  /** 主人要不要它在线（面板上的上线 / 下线）。 */
  wantOnline: boolean
  /** 开没开自动上下线。 */
  enabled: boolean
  /** 没有真人、没有事，过多少分钟下线。 */
  idleMinutes: number
  /** 现在是不是自动下线的。 */
  away: boolean
}

export interface PresenceDeps {
  settings(): PresenceSettings
  /** 把“现在是自动下线的”记下来（落盘）。 */
  setAway(away: boolean): void
  bridge: {
    serverInfo(): Promise<ServerInfo>
    taskList(bot: string): Promise<TaskList>
    botStatus(bot: string): Promise<{ online?: boolean }>
    botSpawn(p: { name: string }): Promise<unknown>
    botDespawn(bot: string): Promise<unknown>
  }
  /** 和游戏连着没有。 */
  connected(): boolean
  /** 它在不在线（不知道是 undefined）。 */
  online(): boolean | undefined
  /** 大脑这边有没有事：哪条线在跑一轮或排着事、盯着任务、例程在跑、工作清单上有没做的（Lines.busy）。平时的检查和下线前的复查都看它。 */
  busy(): boolean
  log(entry: { kind: 'info' | 'error'; text: string }): void
  now?(): number
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
/** 身体明确说了不行（不是断线、超时那种“不知道它做没做”）。 */
const refused = (e: unknown): boolean => e instanceof BridgeError && e.code !== 'disconnected' && e.code !== 'timeout'

export class Presence {
  private readonly deps: PresenceDeps
  /** 服务器上的真人（名字小写）；还没查过是 undefined。 */
  private humans: Set<string> | undefined
  /** 从什么时候起“没有真人、也没有事”。 */
  private idleSince: number | undefined
  /** 上线、下线一件一件做，不交叉。 */
  private chain: Promise<void> = Promise.resolve()

  constructor(deps: PresenceDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  private humansIn(info: ServerInfo): Set<string> {
    const me = this.deps.settings().botName.toLowerCase()
    return new Set((info.players ?? []).filter((p) => p.isBot !== true && p.name.toLowerCase() !== me).map((p) => p.name.toLowerCase()))
  }

  /** 连上游戏以后：查一遍服务器上有谁。它是自动下线的、而服务器上有真人，就上来。 */
  onReady(): Promise<void> {
    return this.serial(async () => {
      this.idleSince = undefined
      try {
        this.humans = this.humansIn(await this.deps.bridge.serverInfo())
      } catch {
        this.humans = undefined
        return
      }
      if (this.deps.settings().away && this.humans.size > 0) await this.back(`服务器上有真人（${[...this.humans].join('、')}）`)
    })
  }

  onDisconnected(): void {
    this.humans = undefined
    this.idleSince = undefined
  }

  /** 身体推来的事件：只看真人进服、离开。 */
  onEvent(e: BridgeEvent): void {
    if (e.event !== 'player.join' && e.event !== 'player.leave') return
    const name = typeof e.data.player === 'string' ? e.data.player : ''
    if (name.length === 0 || e.data.isBot === true || name.toLowerCase() === this.deps.settings().botName.toLowerCase()) return
    if (e.event === 'player.leave') {
      this.humans?.delete(name.toLowerCase())
      return
    }
    this.humans?.add(name.toLowerCase())
    if (this.deps.settings().away) void this.comeBack(`${name} 进了服务器`)
  }

  /** 隔一会儿调一次：该下线了没有。 */
  tick(): Promise<void> {
    return this.serial(async () => {
      const s = this.deps.settings()
      if (!this.deps.connected()) {
        this.idleSince = undefined
        return
      }
      if (s.away) {
        // 记着“自动下线中”、它却在线（那次下线没收到答复其实没下成，或者别人把它叫上来了）：问身体一句，真在线就不算了
        if (this.deps.online() === true) {
          const status = await this.deps.bridge.botStatus(s.botName).catch(() => undefined)
          if (status?.online === true) this.deps.setAway(false)
          return
        }
        // 开关关掉了：不再是“自动下线中”，照主人原来的意思上线
        if (!s.enabled) await this.back('自动上下线关掉了')
        return
      }
      if (!s.enabled || !s.wantOnline || this.deps.online() !== true || this.humans === undefined || this.humans.size > 0 || this.deps.busy()) {
        this.idleSince = undefined
        return
      }
      this.idleSince ??= this.now()
      if (this.now() - this.idleSince < s.idleMinutes * 60_000) return
      await this.leave(s)
    })
  }

  /**
   * 它是自动下线的话，让它上来（reason 写进日志：为什么上来）。不是自动下线的什么都不做。
   * 主人从面板发指令、它定的提醒到点时先调这个，等它回来再把那件事交给它。
   */
  comeBack(reason: string): Promise<void> {
    return this.serial(() => this.back(reason))
  }

  private async back(reason: string): Promise<void> {
    const s = this.deps.settings()
    if (!s.away) return
    // “自动下线中”只在主人要它在线时才记得住（面板上点下线会把它清掉），所以走到这里主人是要它在线的
    this.deps.setAway(false)
    this.idleSince = undefined
    try {
      const status = await this.deps.bridge.botStatus(s.botName).catch(() => undefined)
      if (status?.online !== true) await this.deps.bridge.botSpawn({ name: s.botName })
      this.deps.log({ kind: 'info', text: `${s.botName} 自动上线了：${reason}。` })
    } catch (e) {
      // 没上成（多半是和游戏断着）：还算自动下线中，下一次有事再试
      this.deps.setAway(true)
      this.deps.log({ kind: 'error', text: `想让 ${s.botName} 自动上线（${reason}）但没成功：${message(e)}` })
    }
  }

  private async leave(s: PresenceSettings): Promise<void> {
    // 下线前再问一遍身体：进出的事件万一漏了一个，以它现在说的为准；身体自己排着的任务大脑不一定都盯着
    let tasks: TaskList
    try {
      this.humans = this.humansIn(await this.deps.bridge.serverInfo())
      tasks = await this.deps.bridge.taskList(s.botName)
    } catch {
      this.idleSince = undefined
      return
    }
    if (this.humans.size > 0 || tasks.active || (tasks.queue ?? []).length > 0 || this.deps.busy()) {
      this.idleSince = undefined
      return
    }
    // 先记下再下线：身体紧接着发来的“它下线了”才不会被当成“被人弄下线”
    this.deps.setAway(true)
    this.idleSince = undefined
    try {
      await this.deps.bridge.botDespawn(s.botName)
      this.deps.log({ kind: 'info', text: `${s.botName} 自动下线了：服务器上没有真人，它手上也没有事，已经 ${+s.idleMinutes.toFixed(2)} 分钟。有真人进服、主人在面板上发指令、或者它定的提醒到点，它会自己再上来。` })
    } catch (e) {
      // 身体说不行：没下成。断线、超时：不知道它下没下——先当它下了（记着的不动），它其实还在线的话下一次检查会改回来
      if (refused(e)) this.deps.setAway(false)
      this.deps.log({ kind: 'error', text: `想让 ${s.botName} 自动下线但没成功：${message(e)}` })
    }
  }
}
