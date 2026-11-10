// 网页面板：静态页面 + HTTP API。只用 node:http。
// 鉴权规则：除登录和会话查询外，所有 /api/ 都要会话；所有写操作（非 GET）校验 Origin。
// API key 只写不读：任何接口都不返回完整 key。

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AgentStatus } from '../agent/agent.ts'
import { historyTokens } from '../agent/compaction.ts'
import type { AgentEvent } from '../agent/events.ts'
import { DEFAULT_PERSONA } from '../agent/prompt.ts'
import type { BridgeApi } from '../bridge/api.ts'
import type { BridgeStatus } from '../bridge/client.ts'
import { BridgeError } from '../bridge/protocol.ts'
import { listAdapters } from '../llm/index.ts'
import type { ProviderConfig, TestConnectionResult } from '../llm/index.ts'
import type { ActivityEntry, ActivityLog } from '../store/activity-log.ts'
import { isValidPlayerName, maskSecret, sanitizeProvider } from '../store/config.ts'
import type { ConfigStore } from '../store/config.ts'
import { isRecord } from '../store/files.ts'
import type { HistoryStore } from '../store/history.ts'
import type { MemoryStore } from '../store/memory.ts'
import type { Reminder } from '../store/reminders.ts'
import type { UsageStore } from '../store/usage.ts'
import {
  LoginLimiter,
  SESSION_COOKIE,
  checkPassword,
  createSessionValue,
  originAllowed,
  parseCookies,
  sessionCookie,
  verifySessionValue,
} from './auth.ts'

export interface PanelDeps {
  config: ConfigStore
  memory: MemoryStore
  usage: UsageStore
  log: ActivityLog
  history: HistoryStore
  bridge: BridgeApi
  bridgeStatus(): BridgeStatus
  agent: {
    handleEvent(ev: AgentEvent): void
    status(): AgentStatus
    /** 执行一个会取消任务的请求；期间和之后收到的对应“任务被取消”不叫醒模型。 */
    ownCancel<T extends { ids?: string[]; replaced?: string[] }>(fn: () => Promise<T>): Promise<T>
  }
  reminders: { list(): Reminder[]; remove(id: string): boolean }
  testConnection(config: ProviderConfig): Promise<TestConnectionResult>
  /** 静态文件目录，默认 panel/public。 */
  publicDir?: string
  now?(): number
}

const MAX_BODY_BYTES = 1024 * 1024
const COMMAND_MAX_CHARS = 2000
const PASSWORD_MIN_CHARS = 8

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}

/** 给人看的错误：带 HTTP 状态码，消息直接显示在面板上。 */
class HttpError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const SENSITIVE_HEADER_RE = /key|token|secret|auth|cookie|password/i

/** 面板能看到的服务商配置：没有 apiKey，只有掩码和“已设置”标记；敏感的自定义请求头同样打码。 */
export function maskProvider(p: ProviderConfig): Record<string, unknown> {
  const { apiKey, extraHeaders, ...rest } = p
  const out: Record<string, unknown> = { ...rest, apiKeySet: apiKey.length > 0, apiKeyMasked: maskSecret(apiKey) }
  if (extraHeaders) {
    out.extraHeaders = Object.fromEntries(
      Object.entries(extraHeaders).map(([name, value]) => [name, SENSITIVE_HEADER_RE.test(name) ? maskSecret(value) : value]),
    )
  }
  return out
}

function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase()
  } catch {
    return false
  }
}

/**
 * 把面板提交的内容和已保存的配置合成一份完整配置。
 * - apiKey 留空 = 不修改；
 * - 打过码的请求头原样交回来 = 不修改；
 * - 服务地址换了主机却没重填 key：拒绝。否则谁登上面板都能把地址指到自己的机器上把 key 套走。
 */
export function mergeProvider(input: unknown, existing: ProviderConfig | undefined, id: string): ProviderConfig {
  if (!isRecord(input)) throw new HttpError(400, 'bad_request', '请求内容不对')
  const raw: Record<string, unknown> = { ...input, id }
  const newKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
  const keepsSecret = newKey.length === 0 && existing !== undefined && existing.apiKey.length > 0
  raw.apiKey = newKey.length > 0 ? newKey : (existing?.apiKey ?? '')

  let keepsHeaderSecret = false
  if (isRecord(raw.extraHeaders) && existing?.extraHeaders) {
    const headers: Record<string, unknown> = { ...raw.extraHeaders }
    for (const [name, value] of Object.entries(headers)) {
      const old = existing.extraHeaders[name]
      if (old !== undefined && SENSITIVE_HEADER_RE.test(name) && value === maskSecret(old)) {
        headers[name] = old
        keepsHeaderSecret = true
      }
    }
    raw.extraHeaders = headers
  }

  let clean: ProviderConfig
  try {
    clean = sanitizeProvider(raw)
  } catch (e) {
    throw new HttpError(400, 'bad_request', e instanceof Error ? e.message : String(e))
  }
  if (existing && (keepsSecret || keepsHeaderSecret) && !sameHost(existing.baseUrl, clean.baseUrl)) {
    throw new HttpError(400, 'key_required', '服务地址换了主机，请重新填写 API key（和打了码的请求头）')
  }
  return clean
}

export class PanelServer {
  private readonly deps: PanelDeps
  private readonly publicDir: string
  private readonly limiter = new LoginLimiter()
  private readonly server: http.Server
  private readonly streams = new Set<http.ServerResponse>()
  private unsubscribeLog: (() => void) | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private overviewCache: { at: number; data: unknown } | undefined

  constructor(deps: PanelDeps) {
    this.deps = deps
    this.publicDir = deps.publicDir ?? path.join(import.meta.dirname, 'public')
    this.server = http.createServer((req, res) => {
      void this.handle(req, res)
    })
  }

  listen(host: string, port: number): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, () => {
        this.server.off('error', reject)
        const addr = this.server.address()
        this.unsubscribeLog = this.deps.log.subscribe((entry) => this.broadcast(entry))
        this.heartbeat = setInterval(() => {
          for (const res of this.streams) res.write(': ping\n\n')
        }, 25_000)
        this.heartbeat.unref()
        resolve({ host, port: typeof addr === 'object' && addr ? addr.port : port })
      })
    })
  }

  close(): Promise<void> {
    this.unsubscribeLog?.()
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const res of this.streams) res.end()
    this.streams.clear()
    return new Promise((resolve) => {
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  // ── 请求入口 ──

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)
    try {
      const url = new URL(req.url ?? '/', 'http://panel.local')
      if (url.pathname.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store')
        await this.handleApi(req, res, url)
      } else {
        this.serveStatic(req, res, url.pathname)
      }
    } catch (e) {
      if (res.headersSent) {
        res.end()
        return
      }
      if (e instanceof HttpError) {
        this.json(res, e.status, { error: { code: e.code, message: e.message } })
      } else if (e instanceof BridgeError) {
        const status = e.code === 'disconnected' || e.code === 'timeout' ? 503 : 502
        this.json(res, status, { error: { code: e.code, message: `游戏那边没办成：${e.message}（${e.code}）` } })
      } else {
        console.error('[panel] request failed:', e)
        this.json(res, 500, { error: { code: 'internal', message: '面板内部出错，详情见大脑进程的输出' } })
      }
    }
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
    res.end(text)
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', '不支持的方法')
    const name = pathname === '/' ? 'index.html' : pathname.slice(1)
    // 只允许 public 目录下的一层文件名，杜绝路径穿越
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) throw new HttpError(404, 'not_found', '没有这个页面')
    const type = STATIC_TYPES[path.extname(name)]
    const file = path.join(this.publicDir, name)
    if (!type || !fs.existsSync(file)) throw new HttpError(404, 'not_found', '没有这个页面')
    const body = fs.readFileSync(file)
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-cache' })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  private hasSession(req: http.IncomingMessage): boolean {
    const panel = this.deps.config.get().panel
    return verifySessionValue(parseCookies(req.headers.cookie)[SESSION_COOKIE], panel.sessionSecret, panel.password, this.now())
  }

  private async readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const type = String(req.headers['content-type'] ?? '')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buf = chunk as Buffer
      size += buf.length
      if (size > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', '提交的内容太大')
      chunks.push(buf)
    }
    if (size === 0) return {}
    if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'bad_request', '请求体必须是 JSON')
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!isRecord(parsed)) throw new Error('not an object')
      return parsed
    } catch {
      throw new HttpError(400, 'bad_request', '请求体不是合法的 JSON 对象')
    }
  }

  private async handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET'
    const route = url.pathname.slice('/api'.length)
    const isWrite = method !== 'GET' && method !== 'HEAD'
    if (isWrite && !originAllowed(req)) {
      throw new HttpError(403, 'bad_origin', '写操作必须来自面板页面本身（Origin 不匹配）')
    }

    // 不需要会话的两个接口
    if (route === '/session' && method === 'GET') {
      this.json(res, 200, { authenticated: this.hasSession(req) })
      return
    }
    if (route === '/login' && method === 'POST') {
      await this.login(req, res)
      return
    }

    if (!this.hasSession(req)) throw new HttpError(401, 'unauthorized', '请先登录')

    if (route === '/logout' && method === 'POST') {
      res.setHeader('Set-Cookie', sessionCookie('', { secure: this.isSecure(req), clear: true }))
      this.json(res, 200, { ok: true })
      return
    }
    if (route === '/events' && method === 'GET') {
      this.openStream(req, res, url)
      return
    }

    const body = isWrite ? await this.readBody(req) : {}
    if (route === '/settings/password' && method === 'PUT') {
      this.changePassword(req, res, body)
      return
    }
    const result = await this.dispatch(method, route, body, url)
    this.json(res, 200, result)
  }

  private isSecure(req: http.IncomingMessage): boolean {
    return req.headers['x-forwarded-proto'] === 'https'
  }

  private async login(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const key = req.socket.remoteAddress ?? 'unknown'
    const now = this.now()
    const wait = this.limiter.retryAfter(key, now)
    if (wait > 0) {
      res.setHeader('Retry-After', String(Math.ceil(wait / 1000)))
      throw new HttpError(429, 'too_many_attempts', `口令输错太多次，请 ${Math.ceil(wait / 1000)} 秒后再试`)
    }
    const body = await this.readBody(req)
    const panel = this.deps.config.get().panel
    if (!checkPassword(body.password, panel.password)) {
      this.limiter.fail(key, now)
      throw new HttpError(401, 'wrong_password', '口令不对')
    }
    this.limiter.succeed(key)
    res.setHeader(
      'Set-Cookie',
      sessionCookie(createSessionValue(panel.sessionSecret, panel.password, now), { secure: this.isSecure(req) }),
    )
    this.json(res, 200, { ok: true })
  }

  // ── 实时日志（SSE） ──

  private openStream(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0) || 0
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write('retry: 3000\n\n')
    for (const entry of this.deps.log.recent(after, 300)) res.write(this.frame(entry))
    this.streams.add(res)
    req.on('close', () => this.streams.delete(res))
  }

  private frame(entry: ActivityEntry): string {
    return `id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`
  }

  private broadcast(entry: ActivityEntry): void {
    const frame = this.frame(entry)
    for (const res of this.streams) res.write(frame)
  }

  // ── 路由 ──

  private async dispatch(method: string, route: string, body: Record<string, unknown>, url: URL): Promise<unknown> {
    const key = `${method} ${route}`
    switch (key) {
      case 'GET /overview':
        return this.overview()
      case 'GET /log':
        return { entries: this.deps.log.recent(Number(url.searchParams.get('after') ?? 0) || 0, 300) }
      case 'POST /command':
        return this.command(body)
      case 'GET /providers':
        return this.providers()
      case 'POST /providers':
        return this.createProvider(body)
      case 'POST /providers/test':
        return this.testProvider(body)
      case 'GET /bot':
        return this.botInfo()
      case 'PUT /bot':
        return this.updateBot(body)
      case 'POST /bot/spawn':
        return this.spawn()
      case 'POST /bot/despawn':
        return this.despawn()
      case 'POST /bot/configure':
        return this.configureBot(body)
      case 'POST /tasks/cancel':
        return this.cancelTask(body)
      case 'GET /memory':
        return this.memoryList()
      case 'PUT /memory':
        return this.memorySet(body)
      case 'DELETE /memory':
        return this.memoryDelete(body)
      case 'POST /history/clear':
        this.deps.history.clear()
        this.deps.log.add({ kind: 'info', text: '对话历史已在面板上清空（记忆不受影响）。' })
        return { ok: true }
      case 'DELETE /reminders':
        return { removed: typeof body.id === 'string' && this.deps.reminders.remove(body.id) }
      case 'GET /settings':
        return this.settings()
      case 'PUT /settings/bridge':
        return this.updateBridge(body)
    }

    const m = /^\/providers\/([A-Za-z0-9_-]{1,40})(\/activate)?$/.exec(route)
    if (m) {
      const id = m[1]!
      if (m[2] && method === 'POST') return this.activateProvider(id)
      if (!m[2] && method === 'PUT') return this.updateProvider(id, body)
      if (!m[2] && method === 'DELETE') return this.deleteProvider(id)
    }
    throw new HttpError(404, 'not_found', '没有这个接口')
  }

  // ── 概览 ──

  private async overview(): Promise<unknown> {
    const now = this.now()
    if (this.overviewCache && now - this.overviewCache.at < 1000) return this.overviewCache.data
    const cfg = this.deps.config.get()
    const bridge = this.deps.bridgeStatus()
    const name = cfg.bot.name

    let status: unknown = null
    let statusError: string | undefined
    let tasks: unknown = null
    let server: unknown = null
    if (bridge.state === 'connected') {
      const [st, tl, si] = await Promise.allSettled([
        this.deps.bridge.botStatus(name),
        this.deps.bridge.taskList(name),
        this.deps.bridge.serverInfo(),
      ])
      if (st.status === 'fulfilled') status = st.value
      else statusError = st.reason instanceof BridgeError ? `${st.reason.code}: ${st.reason.message}` : String(st.reason)
      if (tl.status === 'fulfilled') tasks = tl.value
      if (si.status === 'fulfilled') {
        const { tps, dayTime, isDay, raining, players } = si.value
        server = { tps, dayTime, isDay, raining, players: (players ?? []).map((p) => ({ name: p.name, isBot: p.isBot === true })) }
      }
    }

    const active = this.deps.config.activeProvider()
    const h = this.deps.history.get()
    const data = {
      time: now,
      bridge,
      bot: { name, wantOnline: cfg.bot.wantOnline, status, ...(statusError ? { error: statusError } : {}) },
      tasks,
      server,
      agent: this.deps.agent.status(),
      provider: active ? { id: active.id, label: active.label, kind: active.kind, model: active.model, baseUrl: active.baseUrl } : null,
      usage: { today: this.deps.usage.today(now), dailyTokenLimit: cfg.bot.limits.dailyTokenLimit },
      reminders: this.deps.reminders.list(),
      history: { turns: h.turns.length, hasSummary: h.summary.length > 0, estimatedTokens: historyTokens(h.summary, h.turns) },
    }
    this.overviewCache = { at: now, data }
    return data
  }

  // ── 对话 ──

  private command(body: Record<string, unknown>): unknown {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text.length === 0) throw new HttpError(400, 'bad_request', '指令不能为空')
    if (text.length > COMMAND_MAX_CHARS) throw new HttpError(400, 'bad_request', `指令太长（最多 ${COMMAND_MAX_CHARS} 字）`)
    this.deps.agent.handleEvent({ type: 'panel_command', time: this.now(), text })
    return { ok: true }
  }

  // ── 模型 ──

  private providers(): unknown {
    const cfg = this.deps.config.get()
    return { providers: cfg.providers.map(maskProvider), activeProviderId: cfg.activeProviderId, adapters: listAdapters() }
  }

  private findProvider(id: string): ProviderConfig {
    const p = this.deps.config.get().providers.find((x) => x.id === id)
    if (!p) throw new HttpError(404, 'not_found', '没有这个服务商')
    return p
  }

  private createProvider(body: Record<string, unknown>): unknown {
    const id = `p_${crypto.randomBytes(5).toString('hex')}`
    const provider = mergeProvider(body, undefined, id)
    this.deps.config.update((c) => {
      c.providers.push(provider)
      if (c.activeProviderId === '') c.activeProviderId = id
    })
    return { provider: maskProvider(provider), ...(this.providers() as object) }
  }

  private updateProvider(id: string, body: Record<string, unknown>): unknown {
    const provider = mergeProvider(body, this.findProvider(id), id)
    this.deps.config.update((c) => {
      c.providers = c.providers.map((p) => (p.id === id ? provider : p))
    })
    return { provider: maskProvider(provider), ...(this.providers() as object) }
  }

  private deleteProvider(id: string): unknown {
    this.findProvider(id)
    this.deps.config.update((c) => {
      c.providers = c.providers.filter((p) => p.id !== id)
      if (c.activeProviderId === id) c.activeProviderId = c.providers[0]?.id ?? ''
    })
    return this.providers()
  }

  private activateProvider(id: string): unknown {
    this.findProvider(id)
    this.deps.config.update((c) => {
      c.activeProviderId = id
    })
    return this.providers()
  }

  /** 测试连接：可以测还没保存的草稿；key 留空且带了 id 时用已保存的 key。 */
  private async testProvider(body: Record<string, unknown>): Promise<unknown> {
    const id = typeof body.id === 'string' ? body.id : ''
    const existing = id.length > 0 ? this.deps.config.get().providers.find((p) => p.id === id) : undefined
    const provider = mergeProvider(body, existing, existing?.id ?? 'draft')
    return this.deps.testConnection(provider)
  }

  // ── AI 玩家 ──

  private botInfo(): unknown {
    const bot = this.deps.config.get().bot
    return { bot, defaultPersona: DEFAULT_PERSONA }
  }

  private updateBot(body: Record<string, unknown>): unknown {
    if (body.name !== undefined && (typeof body.name !== 'string' || !isValidPlayerName(body.name.trim()))) {
      throw new HttpError(400, 'bad_request', '名字必须是 1–16 位的字母、数字或下划线（Minecraft 玩家名的规则）')
    }
    if (body.systemPrompt !== undefined && typeof body.systemPrompt !== 'string') {
      throw new HttpError(400, 'bad_request', '人设提示词必须是文本')
    }
    const list = (v: unknown): string[] | undefined => {
      if (v === undefined) return undefined
      if (typeof v === 'string') return v.split(/[\s,，、]+/).filter((x) => x.length > 0)
      if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
      throw new HttpError(400, 'bad_request', '名单格式不对')
    }
    const aliases = list(body.aliases)
    const owners = list(body.owners)
    const next = this.deps.config.update((c) => {
      if (typeof body.name === 'string') c.bot.name = body.name.trim()
      if (aliases) c.bot.aliases = aliases
      if (owners) c.bot.owners = owners
      if (typeof body.systemPrompt === 'string') {
        // 和默认的一模一样就存成空，以后默认提示词更新了能跟着变
        c.bot.systemPrompt = body.systemPrompt.trim() === DEFAULT_PERSONA.trim() ? '' : body.systemPrompt
      }
      if (isRecord(body.wake)) Object.assign(c.bot.wake, body.wake)
      if (isRecord(body.limits)) Object.assign(c.bot.limits, body.limits)
    })
    return { bot: next.bot, defaultPersona: DEFAULT_PERSONA }
  }

  private async spawn(): Promise<unknown> {
    const name = this.deps.config.get().bot.name
    this.deps.config.update((c) => {
      c.bot.wantOnline = true
    })
    // 已经在线时身体会拒绝再 spawn（bad_request: bot is already online），所以先看一眼
    let status = await this.deps.bridge.botStatus(name).catch(() => undefined)
    if (!status?.online) {
      status = await this.deps.bridge.botSpawn({ name })
      this.deps.log.add({ kind: 'info', text: `在面板上让 ${name} 上线了。` })
    }
    this.overviewCache = undefined
    return { status }
  }

  private async despawn(): Promise<unknown> {
    const name = this.deps.config.get().bot.name
    this.deps.config.update((c) => {
      c.bot.wantOnline = false
    })
    await this.deps.bridge.botDespawn(name)
    this.overviewCache = undefined
    this.deps.log.add({ kind: 'info', text: `在面板上让 ${name} 下线了。` })
    return { ok: true }
  }

  private async configureBot(body: Record<string, unknown>): Promise<unknown> {
    const settings: Record<string, unknown> = {}
    for (const key of ['invulnerable', 'hunger'] as const) {
      if (typeof body[key] === 'boolean') settings[key] = body[key]
    }
    if (Object.keys(settings).length === 0) throw new HttpError(400, 'bad_request', '没有要改的设置')
    const res = await this.deps.bridge.botConfigure(this.deps.config.get().bot.name, settings)
    this.overviewCache = undefined
    return { settings: res.settings ?? settings }
  }

  private async cancelTask(body: Record<string, unknown>): Promise<unknown> {
    const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : undefined
    // 主人自己在面板上取消的，不用为这个再叫醒模型
    const name = this.deps.config.get().bot.name
    const res = await this.deps.agent.ownCancel(() => this.deps.bridge.taskCancel(name, id))
    this.overviewCache = undefined
    this.deps.log.add({ kind: 'info', text: id ? `在面板上取消了任务 ${id}。` : '在面板上取消了当前任务和队列。' })
    return { canceled: res.canceled ?? 0 }
  }

  // ── 设置：bridge 的端口和口令文件、面板口令 ──

  private settings(): unknown {
    const cfg = this.deps.config.get()
    const effective = this.deps.config.bridgeSettings()
    return {
      // 存在 config.json 里的值（面板上改的就是这些）
      bridge: { port: cfg.bridge.port, tokenFile: cfg.bridge.tokenFile },
      // 实际在用的值（环境变量优先）
      effective: {
        host: effective.host,
        port: effective.port,
        tokenFile: effective.tokenFile,
        // 口令本身只说有没有，不显示
        tokenInline: effective.token.length > 0,
        configured: effective.token.length > 0 || effective.tokenFile.length > 0,
      },
      overridden: this.deps.config.overridden(),
      status: this.deps.bridgeStatus(),
    }
  }

  /**
   * 只开放端口和口令文件路径。bridge 的主机不在面板上改：
   * 主机固定是本机时，就算有人把口令文件路径指向别的文件，内容也只会发给本机的端口。
   */
  private updateBridge(body: Record<string, unknown>): unknown {
    const port = typeof body.port === 'string' && body.port.trim() !== '' ? Number(body.port) : body.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new HttpError(400, 'bad_request', '端口必须是 1–65535 的整数')
    }
    if (typeof body.tokenFile !== 'string') throw new HttpError(400, 'bad_request', '需要口令文件路径（可以留空）')
    const tokenFile = body.tokenFile.trim()
    if (tokenFile.length > 1000 || /[\0\r\n]/.test(tokenFile)) throw new HttpError(400, 'bad_request', '口令文件路径不合法')
    this.deps.config.update((c) => {
      c.bridge.port = port
      c.bridge.tokenFile = tokenFile
    })
    this.overviewCache = undefined
    this.deps.log.add({ kind: 'info', text: `在面板上改了 bridge 设置：端口 ${port}，口令文件 ${tokenFile || '（未配置）'}。` })
    return this.settings()
  }

  /** 改面板口令：要先给出当前口令。改完旧的登录全部失效，这个浏览器换一个新的会话接着用。 */
  private changePassword(req: http.IncomingMessage, res: http.ServerResponse, body: Record<string, unknown>): void {
    const key = req.socket.remoteAddress ?? 'unknown'
    const now = this.now()
    const wait = this.limiter.retryAfter(key, now)
    if (wait > 0) throw new HttpError(429, 'too_many_attempts', `口令输错太多次，请 ${Math.ceil(wait / 1000)} 秒后再试`)
    const panel = this.deps.config.get().panel
    if (!checkPassword(body.current, panel.password)) {
      this.limiter.fail(key, now)
      throw new HttpError(403, 'wrong_password', '当前口令不对')
    }
    const next = typeof body.next === 'string' ? body.next : ''
    if (next.length < PASSWORD_MIN_CHARS) throw new HttpError(400, 'bad_request', `新口令至少 ${PASSWORD_MIN_CHARS} 个字符`)
    if (next.length > 200 || next !== next.trim() || /[\0\r\n]/.test(next)) {
      throw new HttpError(400, 'bad_request', '新口令不能以空格开头或结尾，不能换行，最长 200 个字符')
    }
    const updated = this.deps.config.update((c) => {
      c.panel.password = next
    }).panel
    this.deps.log.add({ kind: 'info', text: '面板口令已在面板上修改，其他地方的登录都已失效。' })
    res.setHeader('Set-Cookie', sessionCookie(createSessionValue(updated.sessionSecret, updated.password, now), { secure: this.isSecure(req) }))
    this.json(res, 200, { ok: true })
  }

  // ── 记忆 ──

  private memoryList(): unknown {
    return {
      notes: this.deps.memory.list(),
      totalChars: this.deps.memory.totalChars(),
      maxChars: this.deps.config.get().bot.limits.memoryMaxChars,
    }
  }

  private memorySet(body: Record<string, unknown>): unknown {
    if (typeof body.key !== 'string' || typeof body.text !== 'string') {
      throw new HttpError(400, 'bad_request', '需要 key 和 text')
    }
    try {
      this.deps.memory.set(body.key, body.text, this.now())
    } catch (e) {
      throw new HttpError(400, 'bad_request', `没存上：${e instanceof Error ? e.message : String(e)}`)
    }
    // 改名：新键存好后删掉旧键
    if (typeof body.previousKey === 'string' && body.previousKey.trim() !== body.key.trim()) {
      this.deps.memory.delete(body.previousKey)
    }
    return this.memoryList()
  }

  private memoryDelete(body: Record<string, unknown>): unknown {
    if (typeof body.key !== 'string') throw new HttpError(400, 'bad_request', '需要 key')
    this.deps.memory.delete(body.key)
    return this.memoryList()
  }
}
