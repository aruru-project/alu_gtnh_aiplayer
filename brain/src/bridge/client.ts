// bridge 协议客户端：连接、hello、断线退避重连、带 serverEpoch + lastSeq 续传、请求超时、事件分发。

import net from 'node:net'
import { BridgeError, MAX_LINE_BYTES, PROTOCOL_VERSION } from './protocol.ts'
import type { BridgeEvent, HelloResult } from './protocol.ts'

/** unconfigured：没有配置口令，所以根本不去连，也不重试；配置改了以后由上层调 restart()。 */
export type BridgeConnState = 'stopped' | 'unconfigured' | 'connecting' | 'connected' | 'waiting'

export interface ResumeState {
  serverEpoch: string
  lastSeq: number
}

export interface BridgeStatus {
  state: BridgeConnState
  address: string
  hello?: HelloResult
  connectedAt?: number
  /** 最近一次连接失败或断开的原因（给面板看）。 */
  lastError?: string
}

export interface ReadyInfo {
  hello: HelloResult
  /** 服务器重启过（或第一次连接）：之前的 seq 作废，上层应重新拉取状态。 */
  epochChanged: boolean
  /** 这个客户端第一次和服务器握手（之前没有落盘的续传位置）。 */
  firstContact: boolean
}

export interface BridgeClientOptions {
  /** 每次连接前调用，所以改了配置不用重建客户端。 */
  address: () => { host: string; port: number }
  /**
   * 每次连接前调用。返回 undefined 表示还没配置口令：不连接、不重试。
   * 配置了但读不到（文件不存在等）时抛 Error（消息给人看），之后会按退避重试。
   */
  token: () => string | undefined
  clientName: string
  requestTimeoutMs?: number
  connectTimeoutMs?: number
  reconnectMinMs?: number
  reconnectMaxMs?: number
  /** 续传位置的落盘。不给则只在内存里记。 */
  resume?: { load(): ResumeState | undefined; save(state: ResumeState): void }
  log?: (message: string) => void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  method: string
}

export class BridgeClient {
  private readonly opts: BridgeClientOptions
  private readonly requestTimeoutMs: number
  private readonly connectTimeoutMs: number
  private readonly reconnectMinMs: number
  private readonly reconnectMaxMs: number

  private state: BridgeConnState = 'stopped'
  /** start() 之后、stop() 之前为真。要不要重连看它，不看 state（第一次连接之前 state 也是 stopped）。 */
  private started = false
  private socket: net.Socket | undefined
  private ready = false
  private nextId = 1
  private pending = new Map<number, Pending>()
  private chunks: Buffer[] = []
  private chunkBytes = 0
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | undefined
  private resumeState: ResumeState | undefined
  private hello: HelloResult | undefined
  private connectedAt: number | undefined
  private lastError: string | undefined
  private addressText = ''

  private readonly eventListeners = new Set<(event: BridgeEvent) => void>()
  private readonly statusListeners = new Set<(status: BridgeStatus) => void>()
  private readonly readyListeners = new Set<(info: ReadyInfo) => void>()

  constructor(opts: BridgeClientOptions) {
    this.opts = opts
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 10_000
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000
    this.reconnectMinMs = opts.reconnectMinMs ?? 500
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 15_000
    this.resumeState = opts.resume?.load()
  }

  // ── 对外 ──

  start(): void {
    if (this.started) return
    this.started = true
    this.attempt = 0
    this.connect()
  }

  stop(): void {
    this.started = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    const socket = this.socket
    this.socket = undefined
    this.ready = false
    this.setState('stopped')
    if (socket) {
      socket.removeAllListeners()
      socket.on('error', () => {})
      socket.destroy()
    }
    this.failPending(new BridgeError('disconnected', 'bridge client stopped'))
  }

  /** 连接参数（地址、口令）改了以后调用：断开现有连接，按新的参数重新来。 */
  restart(): void {
    this.stop()
    this.lastError = undefined
    this.start()
  }

  status(): BridgeStatus {
    const s: BridgeStatus = { state: this.state, address: this.addressText }
    if (this.state === 'connected' && this.hello) s.hello = this.hello
    if (this.state === 'connected' && this.connectedAt !== undefined) s.connectedAt = this.connectedAt
    if (this.lastError !== undefined && this.state !== 'connected') s.lastError = this.lastError
    return s
  }

  isConnected(): boolean {
    return this.state === 'connected' && this.ready
  }

  /** 发一个请求。没连上、超时、对方返回错误时都以 BridgeError 拒绝。 */
  request(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    if (!this.isConnected()) {
      return Promise.reject(new BridgeError('disconnected', 'bridge is not connected to the game server'))
    }
    return this.send(method, params, opts.timeoutMs ?? this.requestTimeoutMs)
  }

  onEvent(fn: (event: BridgeEvent) => void): () => void {
    this.eventListeners.add(fn)
    return () => this.eventListeners.delete(fn)
  }

  onStatus(fn: (status: BridgeStatus) => void): () => void {
    this.statusListeners.add(fn)
    return () => this.statusListeners.delete(fn)
  }

  /** 每次握手成功后调用（包括重连）。 */
  onReady(fn: (info: ReadyInfo) => void): () => void {
    this.readyListeners.add(fn)
    return () => this.readyListeners.delete(fn)
  }

  // ── 连接 ──

  private log(message: string): void {
    this.opts.log?.(message)
  }

  private setState(state: BridgeConnState): void {
    if (this.state === state) return
    this.state = state
    const status = this.status()
    for (const fn of this.statusListeners) {
      try {
        fn(status)
      } catch (e) {
        this.log(`status listener failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  private connect(): void {
    this.reconnectTimer = undefined
    let token: string | undefined
    let address: { host: string; port: number }
    try {
      address = this.opts.address()
      this.addressText = `${address.host}:${address.port}`
      token = this.opts.token()
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      this.scheduleReconnect(false)
      return
    }
    if (token === undefined) {
      this.lastError = undefined
      this.setState('unconfigured')
      return
    }

    this.setState('connecting')
    this.chunks = []
    this.chunkBytes = 0
    this.ready = false
    const socket = net.connect({ host: address.host, port: address.port })
    this.socket = socket
    socket.setNoDelay(true)
    socket.setKeepAlive(true, 30_000)

    const connectTimer = setTimeout(() => {
      socket.destroy(new Error(`connect timed out after ${this.connectTimeoutMs} ms`))
    }, this.connectTimeoutMs)

    socket.once('connect', () => {
      clearTimeout(connectTimer)
      this.handshake(socket, token)
    })
    socket.on('data', (chunk: Buffer) => {
      if (this.socket === socket) this.onData(socket, chunk)
    })
    socket.on('error', (e: Error) => {
      if (this.socket === socket) this.lastError = e.message
    })
    socket.on('close', () => {
      clearTimeout(connectTimer)
      if (this.socket !== socket) return
      this.socket = undefined
      const wasReady = this.ready
      this.ready = false
      this.failPending(new BridgeError('disconnected', 'connection to the game server was lost'))
      if (wasReady) {
        this.lastError = this.lastError ?? 'connection closed'
        this.log(`disconnected from ${this.addressText}`)
      }
      if (this.started) this.scheduleReconnect(wasReady)
    })
  }

  private handshake(socket: net.Socket, token: string): void {
    const params: Record<string, unknown> = { token, client: this.opts.clientName }
    const resume = this.resumeState
    if (resume) {
      params.serverEpoch = resume.serverEpoch
      params.lastSeq = resume.lastSeq
    }
    // 补发的事件可能和 hello 响应在同一个 TCP 包里到达。这里用同步回调而不是 await，
    // 保证先把握手结果（epoch、续传位置、ready 通知）处理完，再处理后面的事件行。
    this.sendRaw(
      'hello',
      params,
      this.requestTimeoutMs,
      (result) => this.onHello(socket, resume, result),
      (error) => this.onHelloFailed(socket, error),
    )
  }

  private onHello(socket: net.Socket, resume: ResumeState | undefined, raw: unknown): void {
    if (this.socket !== socket) return
    try {
      const result = raw as Partial<HelloResult> | null
      if (!result || typeof result.serverEpoch !== 'string') {
        throw new BridgeError('internal', 'hello response has no serverEpoch')
      }
      const hello: HelloResult = {
        protocol: typeof result.protocol === 'number' ? result.protocol : 0,
        serverEpoch: result.serverEpoch,
        seq: typeof result.seq === 'number' ? result.seq : 0,
      }
      if (typeof result.modVersion === 'string') hello.modVersion = result.modVersion
      if (typeof result.mcVersion === 'string') hello.mcVersion = result.mcVersion

      // 身体在这条响应之后立刻补发（见协议“握手”一节）：
      // - epoch 一致：补发 seq > lastSeq 的事件，位置保持不动；
      // - epoch 不一致（服务器重启过）：补发这次启动以来的全部事件，所以把 lastSeq 归零；
      // - 没带 epoch（全新的客户端）：不补发，从 hello.seq（已发出的最后一个事件）之后开始听。
      const epochChanged = !resume || resume.serverEpoch !== hello.serverEpoch
      if (epochChanged) this.saveResume({ serverEpoch: hello.serverEpoch, lastSeq: resume ? 0 : hello.seq })
      if (hello.protocol !== PROTOCOL_VERSION) {
        this.log(`warning: mod speaks protocol ${hello.protocol}, this client was written for ${PROTOCOL_VERSION}`)
      }

      this.hello = hello
      this.connectedAt = Date.now()
      this.lastError = undefined
      this.attempt = 0
      this.ready = true
      this.setState('connected')
      this.log(
        `connected to ${this.addressText} (mod ${hello.modVersion ?? '?'}, epoch ${hello.serverEpoch}` +
          `${!resume ? `, first contact, listening after seq ${hello.seq}` : epochChanged ? ', server restarted, replaying its events' : `, resuming after seq ${resume.lastSeq}`})`,
      )
      for (const fn of this.readyListeners) {
        try {
          fn({ hello, epochChanged, firstContact: !resume })
        } catch (e) {
          this.log(`ready listener failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    } catch (e) {
      this.onHelloFailed(socket, e instanceof Error ? e : new Error(String(e)))
    }
  }

  private onHelloFailed(socket: net.Socket, e: Error): void {
    if (this.socket !== socket) return
    const code = e instanceof BridgeError ? e.code : 'internal'
    // 连接断开导致的失败由 close 处理，这里不覆盖它记下的原因
    if (code === 'disconnected') return
    this.lastError = code === 'unauthorized' ? `口令被拒绝（unauthorized）：${e.message}` : `握手失败：${e.message}`
    this.log(this.lastError)
    // 口令不对时快速重试没有意义，直接用最长的间隔
    if (code === 'unauthorized') this.attempt = 30
    socket.destroy()
  }

  private scheduleReconnect(wasConnected: boolean): void {
    if (!this.started) return
    this.setState('waiting')
    if (wasConnected) this.attempt = 0
    const backoff = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** Math.min(this.attempt, 20))
    const delay = Math.round(backoff * (0.8 + Math.random() * 0.4))
    this.attempt++
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  // ── 收发 ──

  private send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => this.sendRaw(method, params, timeoutMs, resolve, reject))
  }

  /** resolve / reject 在收到响应行时同步调用。 */
  private sendRaw(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void,
  ): void {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      reject(new BridgeError('disconnected', 'bridge is not connected to the game server'))
      return
    }
    const id = this.nextId++
    const line = `${JSON.stringify({ id, method, params })}\n`
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      reject(new BridgeError('too_large', `request ${method} exceeds the 4 MiB line limit`))
      return
    }
    const timer = setTimeout(() => {
      this.pending.delete(id)
      reject(new BridgeError('timeout', `no response to ${method} within ${timeoutMs} ms`))
    }, timeoutMs)
    this.pending.set(id, { resolve, reject, timer, method })
    socket.write(line)
  }

  private failPending(error: BridgeError): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const p of pending) {
      clearTimeout(p.timer)
      p.reject(error)
    }
  }

  private onData(socket: net.Socket, chunk: Buffer): void {
    let rest = chunk
    for (;;) {
      const nl = rest.indexOf(0x0a)
      if (nl === -1) break
      const head = rest.subarray(0, nl)
      const line = this.chunks.length > 0 ? Buffer.concat([...this.chunks, head]) : head
      this.chunks = []
      this.chunkBytes = 0
      rest = rest.subarray(nl + 1)
      if (line.length > 0) this.onLine(line.toString('utf8'))
      if (this.socket !== socket) return
    }
    if (rest.length > 0) {
      this.chunks.push(rest)
      this.chunkBytes += rest.length
      if (this.chunkBytes > MAX_LINE_BYTES) {
        this.lastError = 'received a line longer than 4 MiB'
        socket.destroy(new Error(this.lastError))
      }
    }
  }

  private onLine(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      this.log(`ignored a line that is not JSON: ${line.slice(0, 120)}`)
      return
    }
    if (msg === null || typeof msg !== 'object') return
    const m = msg as Record<string, unknown>

    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id)
      if (!p) return // 超时之后才到的响应
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.ok === true) {
        p.resolve(m.result ?? {})
      } else {
        const err = (m.error ?? {}) as Record<string, unknown>
        const code = typeof err.code === 'string' ? err.code : 'internal'
        const message = typeof err.message === 'string' ? err.message : `${p.method} failed`
        p.reject(new BridgeError(code, message))
      }
      return
    }

    if (typeof m.event === 'string') {
      const event: BridgeEvent = {
        event: m.event,
        data: m.data !== null && typeof m.data === 'object' ? (m.data as Record<string, unknown>) : {},
      }
      if (typeof m.time === 'number') event.time = m.time
      if (typeof m.seq === 'number') {
        event.seq = m.seq
        const resume = this.resumeState
        // 续传和实时流有可能重叠，按 seq 去重
        if (resume && m.seq <= resume.lastSeq) return
        if (resume) this.saveResume({ serverEpoch: resume.serverEpoch, lastSeq: m.seq })
      }
      for (const fn of this.eventListeners) {
        try {
          fn(event)
        } catch (e) {
          this.log(`event listener failed on ${event.event}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }

  private saveResume(state: ResumeState): void {
    this.resumeState = state
    try {
      this.opts.resume?.save(state)
    } catch (e) {
      this.log(`failed to save resume state: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
