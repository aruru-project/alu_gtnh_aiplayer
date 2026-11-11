// 网页面板：静态页面 + HTTP API。只用 node:http。
// 鉴权规则：除登录和会话查询外，所有 /api/ 都要会话；所有写操作（非 GET）校验 Origin。
// API key 只写不读：任何接口都不返回完整 key。

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AgentState, AgentStatus, CompactNowResult } from '../agent/agent.ts'
import type { LinkState, StopResult } from '../agent/lines.ts'
import type { LineName } from '../tools/index.ts'
import type { RunLogStore } from '../agent/run-log.ts'
import { historyTokens } from '../agent/compaction.ts'
import type { AgentEvent } from '../agent/events.ts'
import { DEFAULT_PERSONA } from '../agent/prompt.ts'
import type { BridgeApi } from '../bridge/api.ts'
import type { BridgeStatus } from '../bridge/client.ts'
import { BridgeError } from '../bridge/protocol.ts'
import { DRAFTS_MAX, DRAFT_MAX_SIDE, DesignStoreError, IMAGES_MAX, IMAGE_MAX_BYTES, IMAGE_MAX_SIDE, SCHEMATIC_MAX_BYTES, blockCount, kindKey, materialsOf, storeDraft, toSchematic } from '../design/index.ts'
import type { DesignWorkspace } from '../design/index.ts'
import { listAdapters } from '../llm/index.ts'
import type { ProviderConfig, RemoteModelsResult, TestConnectionResult } from '../llm/index.ts'
import { StructureBook } from '../packdata/index.ts'
import type { GuideBook, TextureAtlas, TooltipTable } from '../packdata/index.ts'
import { BlockLooks, CORNERS, GridError, PICTURE_MAX_SIZE, SIDES, gridFromBlocks, gridFromDraft, renderView, sceneOf } from '../render/index.ts'
import type { Corner, Scene, Side, ViewSpec, VoxelGrid } from '../render/index.ts'
import type { ActivityEntry, ActivityLog } from '../store/activity-log.ts'
import { isValidPlayerName, maskSecret, modelDisplayName, resolveModel, sanitizeModel, sanitizeProvider } from '../store/config.ts'
import type { ConfigStore, ModelConfig, StoredProvider } from '../store/config.ts'
import { FEEDBACK_CATEGORIES } from '../store/feedback.ts'
import type { FeedbackCategory, FeedbackReport, FeedbackStatus, FeedbackStore } from '../store/feedback.ts'
import { isRecord } from '../store/files.ts'
import type { HistoryStore } from '../store/history.ts'
import { MANUAL_BODY_MAX_CHARS, MANUAL_NAME_MAX_CHARS, MANUAL_SUMMARY_MAX_CHARS, ManualError, USER_MANUALS_MAX } from '../store/manuals.ts'
import type { ManualStore } from '../store/manuals.ts'
import type { MemoryStore } from '../store/memory.ts'
import type { Reminder } from '../store/reminders.ts'
import type { UsageStore } from '../store/usage.ts'
import type { ItemIcons } from '../packdata/icons.ts'
import { PanelLive } from './live.ts'
import {
  LoginLimiter,
  sessionCookieName,
  checkPassword,
  createSessionValue,
  originAllowed,
  parseCookies,
  sessionCookie,
  verifySessionValue,
} from './auth.ts'
import type { MethodsEnv } from './data-api.ts'
import type { MethodAccess } from '../tools/methods.ts'
import { blueprintRead, guideBooks, guidePage, guideSearch, historyCompact, itemTooltips, logPage, methodsDelete, methodsList, methodsPut, panelStatus, runList, runRecords } from './data-api.ts'
import type { HistorySize } from './data-api.ts'

export interface PanelDeps {
  config: ConfigStore
  memory: MemoryStore
  usage: UsageStore
  log: ActivityLog
  /** 干活线的历史（只有一条线时就是“对话历史”）。 */
  history: HistoryStore
  /** 对话线的历史。没提供时（老的装配、测试）面板只管干活线那一份。 */
  talkHistory?: HistoryStore
  manuals: ManualStore
  /** 它自己出设计用的：图纸草稿和主人传的图片。 */
  design: DesignWorkspace
  /** 意见簿：它自己记下的反馈。 */
  feedback: FeedbackStore
  /** 它看过的图（对话日志里显示），和画那张图用的盒子（三维预览用）。没提供时日志里就没有图。 */
  pictures?: { get(id: string): Buffer | undefined; blocks(id: string): unknown }
  /** 方块贴图的图集（本地资料里的 textures/）。没提供时三维预览按方块颜色画。 */
  textures?: TextureAtlas
  /** 多方块机器怎么搭（本地资料里的 structures.jsonl）。没提供时“多方块结构”一块说明没有这份资料。 */
  structures?: StructureBook
  /** 游戏内指南（本地资料里的 guide.jsonl）。没提供时 /api/guide 说没有这份资料。 */
  guide?: GuideBook
  /** 基地的做法（store/methods.ts），和查对一条记录用的本地资料。 */
  methods?: MethodAccess
  methodsEnv?(): MethodsEnv
  /** 物品的提示文字（本地资料里的 tooltips.jsonl）。没提供时 /api/items/tooltips 说没有这份资料。 */
  tooltips?: TooltipTable
  /** 物品图标的图集（本地资料里的 icons/）。false：没有；不给：面板自己到配置的 packdata 目录里找一次。没有时物品栏用替代的画法。 */
  icons?: ItemIcons | false
  bridge: BridgeApi
  bridgeStatus(): BridgeStatus
  /** 它是自动下线的话让它上来（agent/presence.ts）；不是的话什么都不做。 */
  comeBack?(reason: string): Promise<void>
  agent: {
    handleEvent(ev: AgentEvent): void
    /** 干活线的状态（例程、盯着的任务在它那里）。 */
    status(): AgentStatus
    /** 一条线的状态。 */
    statusOf?(line: LineName): AgentStatus
    /** 一条线的模型和这一轮现在的样子（GET /api/status 用）。 */
    state?(line: LineName): AgentState
    /** 两条线之间留着的事：干活线在等的回答、它最近一次送来的话。 */
    linkState?(): LinkState
    /** 总停止：取消身体的全部任务、停掉例程、打断干活线正在想的那一步。 */
    stopWork?(reason: string, by: 'panel'): Promise<StopResult>
    /** 执行一个会取消任务的请求；期间和之后收到的对应“任务被取消”不叫醒模型。 */
    ownCancel<T extends { ids?: string[]; replaced?: string[] }>(fn: () => Promise<T>): Promise<T>
    /** 停掉正在跑的例程；没有在跑的返回 false。 */
    stopRoutine?(): boolean
    /** 一条线下一次调模型时上下文大概多大（token）：和它的压缩阈值比的那个数。没提供时按历史的字符数估。 */
    contextTokens?(line: LineName): number
    /** 现在就把一条线的历史写成交接记录（dryRun：只写不存）。 */
    compactNow?(line: LineName, opts: { dryRun?: boolean }): Promise<CompactNowResult>
  }
  reminders: { list(): Reminder[]; remove(id: string): boolean }
  /** 它写的程序（例程、run_program）每次运行的明细。没提供时 /api/runs 是空的。 */
  runs?: RunLogStore
  testConnection(config: ProviderConfig): Promise<TestConnectionResult>
  /** 问一家接口它有哪些模型（config.model 用不上）。 */
  listModels(config: ProviderConfig): Promise<RemoteModelsResult>
  /** 静态文件目录，默认 panel/public。 */
  publicDir?: string
  now?(): number
}

const MAX_BODY_BYTES = 1024 * 1024
/** 图纸文件的上限，协议定的（blueprint.put 最大 2 MiB）。 */
export const BLUEPRINT_MAX_BYTES = 2 * 1024 * 1024
/** 上传图纸的请求体：文件的 base64（长 4/3）加上名字和 JSON 的壳。只有这一个接口放宽到这么大。 */
const BLUEPRINT_BODY_MAX_BYTES = Math.ceil(BLUEPRINT_MAX_BYTES / 3) * 4 + 4096
const BLUEPRINT_NAME_MAX_CHARS = 80
const COMMAND_MAX_CHARS = 2000
const MODELS_PER_PROVIDER_MAX = 40
/** 意见簿的列表一次最多给这么多条（新的在前）；更早的在导出的文件里。 */
const FEEDBACK_LIST_MAX = 300
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

/** data-api.ts 里的接口出错时用它回。 */
const panelReject = (status: number, code: string, message: string): never => {
  throw new HttpError(status, code, message)
}

const SENSITIVE_HEADER_RE = /key|token|secret|auth|cookie|password/i

/** 面板能看到的服务商配置：没有 apiKey，只有掩码和“已设置”标记；敏感的自定义请求头同样打码。它下面的模型原样给。 */
export function maskProvider(p: StoredProvider): Record<string, unknown> {
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
 * 把面板提交的内容和已保存的配置合成一份完整的服务商配置。
 * - apiKey 留空 = 不修改；
 * - 打过码的请求头原样交回来 = 不修改；
 * - 服务地址换了主机却没重填 key：拒绝。否则谁登上面板都能把地址指到自己的机器上把 key 套走；
 * - 没带 models 的：已有的服务商，下面的模型原样留着（模型有自己的接口来增删改）；新建的可以用 model 顺手带上第一个模型。
 */
export function mergeProvider(input: unknown, existing: StoredProvider | undefined, id: string): StoredProvider {
  if (!isRecord(input)) throw new HttpError(400, 'bad_request', '请求内容不对')
  const raw: Record<string, unknown> = { ...input, id }
  if (existing && !Array.isArray(raw.models)) {
    raw.models = existing.models
    delete raw.model
  }
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

  let clean: StoredProvider
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

/** 草稿的图画好了留着：同一张草稿换着角度看，不用每次重画。存着这么多张。 */
const DRAFT_PICTURES_CACHED = 48

export class PanelServer {
  private readonly deps: PanelDeps
  private readonly publicDir: string
  private readonly limiter = new LoginLimiter()
  private readonly server: http.Server
  private readonly streams = new Set<http.ServerResponse>()
  /** 画好的草稿图：键是“草稿名、存盘时间、怎么看、多大”。 */
  private readonly draftPictures = new Map<string, Buffer>()
  private looks: { table: object; looks: BlockLooks } | undefined
  private unsubscribeLog: (() => void) | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private overviewCache: { at: number; data: unknown } | undefined
  /** “现在”页的数据：身上的东西、开着的界面、附近的人、脚下的俯视图（live.ts）。 */
  private readonly live: PanelLive
  /** 实时日志推过的最大的条目 id（比它小的再推来，是同一条的新样子）。 */
  private lastBroadcastId = 0

  constructor(deps: PanelDeps) {
    this.deps = deps
    this.live = new PanelLive({ ...deps, now: () => this.now() })
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
    return verifySessionValue(parseCookies(req.headers.cookie)[sessionCookieName(req)], panel.sessionSecret, panel.password, this.now())
  }

  private async readBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES, tooLarge = '提交的内容太大'): Promise<Record<string, unknown>> {
    const type = String(req.headers['content-type'] ?? '')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buf = chunk as Buffer
      size += buf.length
      if (size > maxBytes) throw new HttpError(413, 'too_large', tooLarge)
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

    // 不需要会话的两个接口。服务器的名字没登录也给：登录页上就分得清是哪个服务器的面板（规矩不给）
    if (route === '/session' && method === 'GET') {
      const server = this.deps.config.get().bot.environment?.name ?? ''
      this.json(res, 200, { authenticated: this.hasSession(req), ...(server ? { server } : {}) })
      return
    }
    if (route === '/login' && method === 'POST') {
      await this.login(req, res)
      return
    }

    if (!this.hasSession(req)) throw new HttpError(401, 'unauthorized', '请先登录')

    if (route === '/logout' && method === 'POST') {
      res.setHeader('Set-Cookie', sessionCookie('', { secure: this.isSecure(req), clear: true, name: sessionCookieName(req) }))
      this.json(res, 200, { ok: true })
      return
    }
    if (route === '/events' && method === 'GET') {
      this.openStream(req, res, url)
      return
    }
    if (route === '/images/file' && method === 'GET') {
      this.imageFile(res, url)
      return
    }
    if (route === '/drafts/picture' && method === 'GET') {
      this.draftPicture(res, url)
      return
    }
    if (route === '/pictures/file' && method === 'GET') {
      this.pictureFile(res, url)
      return
    }
    if (route === '/textures/atlas.png' && method === 'GET') {
      this.textureAtlas(res)
      return
    }
    if (route === '/feedback/export' && method === 'GET') {
      this.feedbackExport(res, url)
      return
    }
    if (route === '/icons/sheet' && method === 'GET') {
      this.iconSheet(res, url)
      return
    }

    // 到这里会话和 Origin 都已经验过了，才开始读请求体；上传图纸的请求体比别的接口大
    const uploadsBlueprint = route === '/blueprints' && method === 'POST'
    const body = !isWrite
      ? {}
      : uploadsBlueprint
        ? await this.readBody(req, BLUEPRINT_BODY_MAX_BYTES, `文件太大，图纸最大 ${BLUEPRINT_MAX_BYTES / 1024 / 1024} MiB`)
        : await this.readBody(req)
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
      sessionCookie(createSessionValue(panel.sessionSecret, panel.password, now), { secure: this.isSecure(req), name: sessionCookieName(req) }),
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
    // 原地改过的条目（model_call、run）再推一次时不带 SSE 的 id 行：浏览器断线重连用的 Last-Event-ID 还是最新那条的，
    // 不会因为收到一条旧 id 的更新就把后面的全部重发一遍。条目自己的 id 在 data 里。
    const update = entry.id <= this.lastBroadcastId
    if (!update) this.lastBroadcastId = entry.id
    const frame = update ? `data: ${JSON.stringify(entry)}\n\n` : this.frame(entry)
    for (const res of this.streams) res.write(frame)
  }

  // ── 路由 ──

  private async dispatch(method: string, route: string, body: Record<string, unknown>, url: URL): Promise<unknown> {
    const key = `${method} ${route}`
    switch (key) {
      case 'GET /overview':
        return this.overview()
      case 'GET /live':
        return this.live.live()
      case 'GET /minimap':
        return this.live.minimap(url.searchParams.get('radius'))
      case 'GET /items/names':
        return this.live.itemNames(url.searchParams.get('q') ?? '')
      case 'GET /items/tooltips':
        return itemTooltips(this.deps.tooltips, url.searchParams)
      // 下面五个是面板要的数据（形状见 docs/BRAIN_SPEC.md 的“面板的数据接口”），实现在 data-api.ts
      case 'GET /log':
        return logPage(this.deps.log, url.searchParams)
      case 'GET /status':
        return panelStatus(
          {
            agent: this.deps.agent,
            bridge: this.deps.bridge,
            connected: () => this.deps.bridgeStatus().state === 'connected',
            botName: () => this.deps.config.get().bot.name,
            model: (line) => {
              const active = this.deps.config.lineSelection(line)
              return active ? { provider: active.provider.label, model: active.model.name, providerId: active.provider.id, modelId: active.model.id } : undefined
            },
            history: (line) => this.historySize(line),
            awayIdle: () => this.deps.config.get().bot.awayIdle,
            environment: () => this.deps.config.get().bot.environment,
          },
          this.now(),
        )
      case 'GET /runs':
        return runList(this.deps.runs, url.searchParams)
      case 'GET /runs/records':
        return runRecords(this.deps.runs, url.searchParams, panelReject)
      case 'GET /blueprints/read':
        return blueprintRead(this.deps, url.searchParams, panelReject)
      case 'GET /guide':
        return guideBooks(this.deps.guide, url.searchParams, panelReject)
      case 'GET /guide/search':
        return guideSearch(this.deps.guide, url.searchParams, panelReject)
      case 'GET /guide/page':
        return guidePage(this.deps.guide, url.searchParams, panelReject)
      case 'GET /methods':
        return methodsList(this.deps.methods, this.deps.methodsEnv?.() ?? {})
      case 'PUT /methods':
        return methodsPut(this.deps.methods, body, this.deps.methodsEnv?.() ?? {}, this.now(), panelReject)
      case 'DELETE /methods':
        return methodsDelete(this.deps.methods, body, panelReject)
      case 'POST /command':
        return this.command(body)
      case 'GET /providers':
        return this.providers()
      case 'POST /providers':
        return this.createProvider(body)
      case 'POST /providers/test':
        return this.testProvider(body)
      case 'POST /providers/remote-models':
        return this.remoteModels(body)
      case 'POST /models/use':
        return this.useModel(body)
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
      case 'POST /routine/stop': {
        // 例程：它写的程序在后台一步步调工具。停掉以后它正在做的任务也取消，模型会被叫醒看结果
        const stopped = this.deps.agent.stopRoutine?.() ?? false
        if (stopped) this.deps.log.add({ kind: 'info', text: '在面板上停掉了正在跑的例程。' })
        this.overviewCache = undefined
        return { stopped }
      }
      case 'POST /work/stop':
        return this.stopWork(body)
      case 'GET /memory':
        return this.memoryList()
      case 'PUT /memory':
        return this.memorySet(body)
      case 'DELETE /memory':
        return this.memoryDelete(body)
      case 'GET /manuals':
        return this.manualList()
      case 'PUT /manuals':
        return this.manualSave(body)
      case 'DELETE /manuals':
        return this.manualDelete(body)
      case 'GET /blueprints':
        return this.blueprints()
      case 'POST /blueprints':
        return this.uploadBlueprint(body)
      case 'DELETE /blueprints':
        return this.deleteBlueprint(body)
      case 'GET /drafts':
        return this.draftList()
      case 'GET /drafts/model':
        return this.draftModel(url.searchParams.get('name') ?? '')
      case 'GET /pictures/model':
        return this.pictureModel(url.searchParams.get('id') ?? '')
      case 'GET /structures':
        return this.structureList(url.searchParams.get('q') ?? '')
      case 'GET /structures/model':
        return this.structureModel(url.searchParams.get('id') ?? '', Number(url.searchParams.get('meta') ?? 0), url.searchParams.get('tier'))
      case 'GET /drafts/view':
        return this.draftView(url.searchParams.get('name') ?? '')
      case 'DELETE /drafts':
        return this.draftDelete(body)
      case 'POST /drafts/publish':
        return this.draftPublish(body)
      case 'GET /feedback':
        return this.feedbackList(url)
      case 'GET /feedback/view':
        return this.feedbackGet(url.searchParams.get('id') ?? '')
      case 'POST /feedback/status':
        return this.feedbackStatus(body)
      case 'GET /images':
        return this.imageList()
      case 'POST /images':
        return this.imageUpload(body)
      case 'DELETE /images':
        return this.imageDelete(body)
      case 'POST /history/clear': {
        // 两条线各有一份历史：line 说清哪一份，不带就是两份都清
        const line = body.line
        if (line !== undefined && line !== 'talk' && line !== 'work') throw new HttpError(400, 'bad_request', 'line 只能是 talk 或 work')
        if (line !== 'talk') this.deps.history.clear()
        if (line !== 'work') this.deps.talkHistory?.clear()
        this.overviewCache = undefined
        this.deps.log.add({ kind: 'info', text: `${line === 'talk' ? '对话线的' : line === 'work' ? '干活线的' : '两条线的'}对话历史已在面板上清空（记忆不受影响）。` })
        return { ok: true }
      }
      case 'POST /history/compact':
        return historyCompact(this.deps.agent, body, (status, code, message) => {
          throw new HttpError(status, code, message)
        }).finally(() => {
          this.overviewCache = undefined
        })
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
    const mm = /^\/providers\/([A-Za-z0-9_-]{1,40})\/models(?:\/([A-Za-z0-9_-]{1,40}))?$/.exec(route)
    if (mm) {
      const [, providerId, modelId] = mm
      if (modelId === undefined && method === 'POST') return this.addModel(providerId!, body)
      if (modelId !== undefined && method === 'PUT') return this.updateModel(providerId!, modelId, body)
      if (modelId !== undefined && method === 'DELETE') return this.deleteModel(providerId!, modelId)
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

    const active = this.deps.config.activeSelection()
    const h = this.deps.history.get()
    const lineModel = (line: LineName) => {
      const picked = this.deps.config.lineSelection(line)
      return picked
        ? { id: picked.provider.id, label: picked.provider.label, kind: picked.provider.kind, baseUrl: picked.provider.baseUrl, model: picked.model.name, modelId: picked.model.id, modelLabel: modelDisplayName(picked.model) }
        : null
    }
    const data = {
      time: now,
      bridge,
      bot: { name, wantOnline: cfg.bot.wantOnline, status, ...(statusError ? { error: statusError } : {}) },
      tasks,
      server,
      // 干活线的状态（原来唯一的那个）；对话线的在 talk
      agent: this.deps.agent.status(),
      talk: this.deps.agent.statusOf?.('talk') ?? null,
      // 两条线各用哪个服务商的哪个模型（provider 是干活线的，留着给还没改的界面）
      lineModels: { talk: lineModel('talk'), work: lineModel('work') },
      provider: active
        ? {
            id: active.provider.id,
            label: active.provider.label,
            kind: active.provider.kind,
            baseUrl: active.provider.baseUrl,
            model: active.model.name,
            modelId: active.model.id,
            modelLabel: modelDisplayName(active.model),
          }
        : null,
      // 能切过去的全部模型（页头那个切换用）
      models: cfg.providers.flatMap((p) => p.models.map((m) => ({ providerId: p.id, providerLabel: p.label, modelId: m.id, label: modelDisplayName(m) }))),
      usage: { today: this.deps.usage.today(now), dailyTokenLimit: cfg.bot.limits.dailyTokenLimit },
      // 意见簿里主人还没看过的条数：导航上的那个数字
      feedback: { unread: this.deps.feedback.unread() },
      reminders: this.deps.reminders.list(),
      history: { turns: h.turns.length, hasSummary: h.summary.length > 0, estimatedTokens: this.deps.agent.contextTokens?.('work') ?? historyTokens(h.summary, h.turns) },
      histories: { talk: this.historySize('talk') ?? null, work: this.historySize('work') ?? null },
    }
    this.overviewCache = { at: now, data }
    return data
  }

  /** 一条线的历史有多长、离压缩还有多远。 */
  private historySize(line: LineName): HistorySize | undefined {
    const store = line === 'talk' ? this.deps.talkHistory : this.deps.history
    if (!store) return undefined
    const h = store.get()
    const limits = this.deps.config.get().bot.limits
    return {
      turns: h.turns.length,
      hasSummary: h.summary.length > 0,
      // 和阈值比的那个数：这条线下一次调模型时上下文大概多大（见 agent 的 contextTokens）
      estimatedTokens: this.deps.agent.contextTokens?.(line) ?? historyTokens(h.summary, h.turns),
      threshold: line === 'talk' ? limits.talkHistoryTokenThreshold : limits.historyTokenThreshold,
      ...(h.summaryOf ? { summaryOf: h.summaryOf } : {}),
    }
  }

  /** 总停止（和对话线的 stop_work 是同一件事）：取消身体的全部任务、停掉例程、打断干活线正在想的那一步。 */
  private async stopWork(body: Record<string, unknown>): Promise<unknown> {
    if (!this.deps.agent.stopWork) throw new HttpError(501, 'not_supported', '这个大脑没有总停止')
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : ''
    const res = await this.deps.agent.stopWork(reason, 'panel')
    this.overviewCache = undefined
    return { ok: res.error === undefined, turn: res.turn !== undefined, routine: res.routine ?? null, tasks: res.tasks.length, dropped: res.dropped, ...(res.error !== undefined ? { error: res.error } : {}) }
  }

  // ── 对话 ──

  private async command(body: Record<string, unknown>): Promise<unknown> {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text.length === 0) throw new HttpError(400, 'bad_request', '指令不能为空')
    if (text.length > COMMAND_MAX_CHARS) throw new HttpError(400, 'bad_request', `指令太长（最多 ${COMMAND_MAX_CHARS} 字）`)
    // 它是自动下线的话先让它上来，指令照常交给它
    await this.deps.comeBack?.('主人在面板上发了指令')
    this.deps.agent.handleEvent({ type: 'panel_command', time: this.now(), text })
    return { ok: true }
  }

  // ── 模型：服务商（接口地址、类型、key）和它下面的模型分开管 ──

  private providers(): unknown {
    const cfg = this.deps.config.get()
    return {
      providers: cfg.providers.map(maskProvider),
      // 干活线用的（只有一条线时“当前用的”就是它）；两条线各用哪个在 lines 里
      activeProviderId: cfg.activeProviderId,
      activeModelId: cfg.activeModelId,
      lines: { talk: { providerId: cfg.talkProviderId, modelId: cfg.talkModelId }, work: { providerId: cfg.activeProviderId, modelId: cfg.activeModelId } },
      adapters: listAdapters(),
    }
  }

  private findProvider(id: string): StoredProvider {
    const p = this.deps.config.get().providers.find((x) => x.id === id)
    if (!p) throw new HttpError(404, 'not_found', '没有这个服务商')
    return p
  }

  private findModel(provider: StoredProvider, modelId: string): ModelConfig {
    const m = provider.models.find((x) => x.id === modelId)
    if (!m) throw new HttpError(404, 'not_found', '这个服务商下面没有这个模型')
    return m
  }

  /** 新建服务商。可以用 model（和输出上限这些）顺手带上它的第一个模型。 */
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

  /** 改用这个服务商（用它下面的第一个模型）。要指定模型用 useModel。 */
  private activateProvider(id: string): unknown {
    const provider = this.findProvider(id)
    return this.switchTo(provider, provider.models[0])
  }

  /**
   * 页头和“模型”页的切换：哪条线改用哪个服务商的哪个模型。line 是 talk 或 work；不带就是两条线一起换。
   * 那条线的下一轮起生效，不用重启。
   */
  private useModel(body: Record<string, unknown>): unknown {
    if (typeof body.providerId !== 'string' || typeof body.modelId !== 'string') throw new HttpError(400, 'bad_request', '需要 providerId 和 modelId')
    if (body.line !== undefined && body.line !== 'talk' && body.line !== 'work') throw new HttpError(400, 'bad_request', 'line 只能是 talk 或 work')
    const provider = this.findProvider(body.providerId)
    return this.switchTo(provider, this.findModel(provider, body.modelId), body.line)
  }

  private switchTo(provider: StoredProvider, model: ModelConfig | undefined, line?: LineName): unknown {
    const before = this.deps.config.get()
    const modelId = model?.id ?? ''
    const workChanged = line !== 'talk' && (before.activeProviderId !== provider.id || before.activeModelId !== modelId)
    const talkChanged = line !== 'work' && (before.talkProviderId !== provider.id || before.talkModelId !== modelId)
    this.deps.config.update((c) => {
      if (line !== 'talk') {
        c.activeProviderId = provider.id
        c.activeModelId = modelId
      }
      if (line !== 'work') {
        c.talkProviderId = provider.id
        c.talkModelId = modelId
      }
    })
    this.overviewCache = undefined
    if ((workChanged || talkChanged) && model) {
      const which = workChanged && talkChanged ? '两条线的模型都' : workChanged ? '干活线的模型' : '对话线的模型'
      this.deps.log.add({ kind: 'info', text: `在面板上把${which}换成了 ${provider.label} / ${modelDisplayName(model)}，下一轮起生效。` })
    }
    return this.providers()
  }

  /** 面板提交的模型设置 → 一个合法的模型配置。 */
  private modelFrom(body: Record<string, unknown>, provider: StoredProvider, id: string): ModelConfig {
    try {
      // 模型名可以叫 name，也可以叫 model（和测试连接、旧接口的写法一致）
      return sanitizeModel({ ...body, id, name: body.name ?? body.model }, provider.kind)
    } catch (e) {
      throw new HttpError(400, 'bad_request', e instanceof Error ? e.message : String(e))
    }
  }

  private saveModels(provider: StoredProvider, models: ModelConfig[]): void {
    this.deps.config.update((c) => {
      c.providers = c.providers.map((p) => (p.id === provider.id ? { ...p, models } : p))
    })
    this.overviewCache = undefined
  }

  private addModel(providerId: string, body: Record<string, unknown>): unknown {
    const provider = this.findProvider(providerId)
    if (provider.models.length >= MODELS_PER_PROVIDER_MAX) throw new HttpError(400, 'bad_request', `一个服务商下面最多 ${MODELS_PER_PROVIDER_MAX} 个模型`)
    const model = this.modelFrom(body, provider, `m_${crypto.randomBytes(4).toString('hex')}`)
    this.saveModels(provider, [...provider.models, model])
    return { model, ...(this.providers() as object) }
  }

  private updateModel(providerId: string, modelId: string, body: Record<string, unknown>): unknown {
    const provider = this.findProvider(providerId)
    this.findModel(provider, modelId)
    const model = this.modelFrom(body, provider, modelId)
    this.saveModels(provider, provider.models.map((m) => (m.id === modelId ? model : m)))
    return { model, ...(this.providers() as object) }
  }

  /** 删掉正在用的那个模型时，改用这个服务商下面剩下的第一个；一个都不剩就是“没配模型”，不会自己跳到别的服务商去。 */
  private deleteModel(providerId: string, modelId: string): unknown {
    const provider = this.findProvider(providerId)
    this.findModel(provider, modelId)
    this.saveModels(provider, provider.models.filter((m) => m.id !== modelId))
    return this.providers()
  }

  /**
   * 测试连接、拉模型列表时用哪个服务商：带了 baseUrl 的是表单里正在填的草稿（key 留空且带了 id 时用已保存的 key）；
   * 只带 id 的就是已经保存的那一个。
   */
  private providerFor(body: Record<string, unknown>): StoredProvider {
    const id = typeof body.id === 'string' ? body.id : ''
    const existing = id.length > 0 ? this.deps.config.get().providers.find((p) => p.id === id) : undefined
    if (existing && body.baseUrl === undefined) return existing
    return mergeProvider({ ...body, models: [] }, existing, existing?.id ?? 'draft')
  }

  /** 测试连接：可以测还没保存的草稿。测哪个模型：modelId 指已保存的一个，否则就是请求里带的模型名和设置。 */
  private async testProvider(body: Record<string, unknown>): Promise<unknown> {
    const provider = this.providerFor(body)
    const model = typeof body.modelId === 'string' ? this.findModel(provider, body.modelId) : this.modelFrom(body, provider, 'draft')
    return this.deps.testConnection(resolveModel(provider, model))
  }

  /** 问接口它有哪些模型，给填模型名时挑。拉不到（接口没有这个功能、key 不对、网络不通）不是错误：结果里说明原因，照样可以手填。 */
  private async remoteModels(body: Record<string, unknown>): Promise<unknown> {
    const provider = this.providerFor(body)
    return this.deps.listModels({ ...resolveModel(provider, { id: 'draft', name: '', label: '' }) })
  }

  // ── AI 玩家 ──

  private botInfo(): unknown {
    const bot = this.deps.config.get().bot
    return { bot, defaultPersona: DEFAULT_PERSONA }
  }

  private updateBot(body: Record<string, unknown>): unknown {
    if (body.name !== undefined && (typeof body.name !== 'string' || !isValidPlayerName(body.name.trim()))) {
      throw new HttpError(400, 'bad_request', '名字是 1–16 个字符，不能有空格、斜杠和 §（不开正版验证的服务器上可以是中文）')
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
      if (isRecord(body.presence)) Object.assign(c.bot.presence, body.presence)
      if (isRecord(body.environment)) Object.assign(c.bot.environment, body.environment)
    })
    return { bot: next.bot, defaultPersona: DEFAULT_PERSONA }
  }

  private async spawn(): Promise<unknown> {
    const name = this.deps.config.get().bot.name
    // 主人手动点的上线：不再算“自动下线中”
    this.deps.config.update((c) => {
      c.bot.wantOnline = true
      c.bot.awayIdle = false
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
    // 主人手动点的下线：一直不上来，直到他手动上线。“自动下线中”跟着就没了（它只在主人要它在线时才算数，见 config 的 awayIdle）
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

  // ── 手册：默认的随代码发布，主人写的（和改过的）在数据目录里 ──

  private manualList(): unknown {
    const defaults = new Map(this.deps.manuals.defaults().map((m) => [m.name, m]))
    return {
      manuals: this.deps.manuals.list().map((m) => {
        // 主人改过的默认手册：把默认的原文也带上，面板上可以对照、可以恢复
        const original = m.overridesDefault ? defaults.get(m.name) : undefined
        return original ? { ...m, default: { summary: original.summary, body: original.body } } : m
      }),
      limits: { nameMaxChars: MANUAL_NAME_MAX_CHARS, summaryMaxChars: MANUAL_SUMMARY_MAX_CHARS, bodyMaxChars: MANUAL_BODY_MAX_CHARS, maxUserManuals: USER_MANUALS_MAX },
    }
  }

  /** 新建或改写一本主人的手册。名字和默认手册一样就是盖住那本默认的。名字的校验在 ManualStore 里（出不了手册目录）。 */
  private manualSave(body: Record<string, unknown>): unknown {
    if (typeof body.name !== 'string' || typeof body.summary !== 'string' || typeof body.body !== 'string') {
      throw new HttpError(400, 'bad_request', '需要 name、summary 和 body')
    }
    const previous = typeof body.previousName === 'string' ? body.previousName.trim() : ''
    try {
      const saved = this.deps.manuals.save({ name: body.name, summary: body.summary, body: body.body })
      // 改名：新名字存好后删掉旧的那本（旧的是默认手册的话删不到，默认的还在）
      if (previous.length > 0 && previous !== saved.name) this.deps.manuals.remove(previous)
      this.deps.log.add({
        kind: 'info',
        text: saved.overridesDefault ? `在面板上改了手册 ${saved.name}（现在用的是改过的这份，不是默认的）。` : `在面板上保存了手册 ${saved.name}。`,
      })
      return { saved, ...(this.manualList() as object) }
    } catch (e) {
      if (e instanceof ManualError) throw new HttpError(400, 'bad_request', e.message)
      throw e
    }
  }

  /** 删掉主人的那本。它盖着一本默认手册时，这就是“恢复默认”。默认手册本身删不掉。 */
  private manualDelete(body: Record<string, unknown>): unknown {
    if (typeof body.name !== 'string') throw new HttpError(400, 'bad_request', '需要 name')
    const name = body.name.trim()
    let removed: boolean
    try {
      removed = this.deps.manuals.remove(name)
    } catch (e) {
      if (e instanceof ManualError) throw new HttpError(400, 'bad_request', e.message)
      throw e
    }
    const restoredDefault = removed && this.deps.manuals.defaults().some((m) => m.name === name)
    if (removed) this.deps.log.add({ kind: 'info', text: restoredDefault ? `在面板上把手册 ${name} 恢复成了默认的。` : `在面板上删除了手册 ${name}。` })
    return { removed, restoredDefault, ...(this.manualList() as object) }
  }

  // ── 图纸：身体上的 .schematic 文件，这里只是转手 ──

  private async blueprints(): Promise<unknown> {
    const res = await this.deps.bridge.blueprintList()
    return { blueprints: res.blueprints ?? [], folder: res.folder ?? '', maxBytes: BLUEPRINT_MAX_BYTES }
  }

  /** 图纸名就是身体那边的文件名（不带后缀）。身体自己也会查；这里先把带路径的挡掉，不让它出这个进程。 */
  private blueprintName(raw: unknown): string {
    const name = typeof raw === 'string' ? raw.trim().replace(/\.schematic$/i, '') : ''
    if (name.length === 0) throw new HttpError(400, 'bad_request', '需要图纸的名字')
    if (name.length > BLUEPRINT_NAME_MAX_CHARS || name.startsWith('.') || name.includes('..') || /[/\\:*?"<>|\u0000-\u001f]/.test(name)) {
      throw new HttpError(400, 'bad_request', `图纸名字不能带路径或 / \\ : * ? " < > | 这些字符，不能以 . 开头，最长 ${BLUEPRINT_NAME_MAX_CHARS} 个字符`)
    }
    return name
  }

  /** 浏览器把文件读成 base64 交上来，原样转给身体的 blueprint.put（同名覆盖）。文件是不是能用的图纸由身体判断。 */
  private async uploadBlueprint(body: Record<string, unknown>): Promise<unknown> {
    const name = this.blueprintName(body.name)
    const data = typeof body.data === 'string' ? body.data : ''
    if (data.length === 0) throw new HttpError(400, 'bad_request', '没有收到文件内容')
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new HttpError(400, 'bad_request', '文件内容必须是 base64')
    const bytes = (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)
    if (bytes > BLUEPRINT_MAX_BYTES) {
      throw new HttpError(413, 'too_large', `这个文件有 ${(bytes / 1024 / 1024).toFixed(1)} MiB，图纸最大 ${BLUEPRINT_MAX_BYTES / 1024 / 1024} MiB`)
    }
    let saved: Awaited<ReturnType<BridgeApi['blueprintPut']>>
    try {
      saved = await this.deps.bridge.blueprintPut(name, data)
    } catch (e) {
      // 不是能用的图纸：身体会说明原因，原话给人看
      if (e instanceof BridgeError && e.code === 'bad_request') throw new HttpError(400, 'bad_blueprint', `游戏那边没收下这张图纸：${e.message}`)
      throw e
    }
    const size = saved.size ? `${saved.size.x}×${saved.size.y}×${saved.size.z}，` : ''
    this.deps.log.add({ kind: 'info', text: `在面板上传了图纸 ${saved.name ?? name}（${size}${saved.blocks ?? '?'} 个方块）。` })
    return { saved, ...((await this.blueprints()) as object) }
  }

  private async deleteBlueprint(body: Record<string, unknown>): Promise<unknown> {
    const name = this.blueprintName(body.name)
    const res = await this.deps.bridge.blueprintRemove(name)
    const removed = res.removed === true
    if (removed) this.deps.log.add({ kind: 'info', text: `在面板上删除了图纸 ${name}。` })
    return { removed, ...((await this.blueprints()) as object) }
  }

  // ── 草稿：它自己写程序设计出来的建筑，存在大脑这边，还没发到游戏里 ──

  private draftList(): unknown {
    return { drafts: this.deps.design.drafts.list(), max: DRAFTS_MAX }
  }

  /** 一张草稿的全部内容，给面板画预览：每种方块的颜色和数量，格子是“下标, 连续几格”的序列（顺序同 .schematic）。 */
  private draftView(name: string): unknown {
    const record = this.deps.design.drafts.get(name)
    if (!record) throw new HttpError(404, 'not_found', '没有这张草稿')
    const { draft } = record
    const design = this.deps.design
    const looks = this.blockLooks()
    const counts = new Map(materialsOf(draft).map((m) => [kindKey(m), m.count]))
    return {
      name: draft.name,
      size: draft.size,
      savedAt: record.savedAt,
      blocks: blockCount(draft),
      kinds: draft.kinds.map((kind) => {
        const key = kindKey(kind)
        const look = looks.of(kind)
        // 颜色和图上的一致。颜色表里没有的方块给的是由名字定的颜色：看得出是不同的方块，但不是它真实的颜色
        return { key, name: design.nameOf(kind) ?? null, count: counts.get(key) ?? 0, color: look.top, colorKnown: look.source !== 'hash' }
      }),
      runs: storeDraft(draft).runs,
      program: record.program ?? null,
    }
  }

  /** 方块在简图上长什么样：和它（模型）看到的图用同一张表。颜色表换了（重新加载资料）就重建。 */
  private blockLooks(): BlockLooks {
    const table = this.deps.design.colors()
    if (this.looks?.table !== table) this.looks = { table, looks: new BlockLooks(table) }
    return this.looks.looks
  }

  /**
   * 草稿的图（PNG）：和它用 view_draft 要到的是同一种图。
   * view：iso（默认）/ top / side / layer；from：iso 是四个角之一，side 是四边之一；layer：第几层；
   * size：最长边（64–1024）；plain=1 只要画面，不带说明和图例（列表里的小图）。
   */
  private draftPicture(res: http.ServerResponse, url: URL): void {
    const q = url.searchParams
    const record = this.deps.design.drafts.get(q.get('name') ?? '')
    if (!record) throw new HttpError(404, 'not_found', '没有这张草稿')
    const { draft } = record
    const view = q.get('view') ?? 'iso'
    const from = q.get('from')
    let spec: ViewSpec
    if (view === 'iso') {
      if (from !== null && !(CORNERS as readonly string[]).includes(from)) throw new HttpError(400, 'bad_request', `立体图的 from 是四个角之一：${CORNERS.join('、')}`)
      spec = { view, from: (from as Corner | null) ?? 'southeast' }
    } else if (view === 'side') {
      if (from !== null && !(SIDES as readonly string[]).includes(from)) throw new HttpError(400, 'bad_request', `立面图的 from 是四边之一：${SIDES.join('、')}`)
      spec = { view, from: (from as Side | null) ?? 'south' }
    } else if (view === 'layer') {
      const layer = Number(q.get('layer') ?? '0')
      if (!Number.isInteger(layer) || layer < 0 || layer >= draft.size.y) throw new HttpError(400, 'bad_request', `这张草稿的层是 0 到 ${draft.size.y - 1}`)
      spec = { view, layer }
    } else if (view === 'top') {
      spec = { view }
    } else {
      throw new HttpError(400, 'bad_request', 'view 是 iso、top、side、layer 之一')
    }
    const wanted = Number(q.get('size') ?? PICTURE_MAX_SIZE)
    const size = Number.isFinite(wanted) ? Math.max(64, Math.min(PICTURE_MAX_SIZE, Math.round(wanted))) : PICTURE_MAX_SIZE
    const plain = q.get('plain') === '1'
    const key = JSON.stringify([draft.name, record.savedAt, spec, size, plain])
    let png = this.draftPictures.get(key)
    if (!png) {
      try {
        png = renderView(gridFromDraft(draft), this.blockLooks(), spec, { maxSize: size, plain, title: /^[\x20-\x7e]+$/.test(draft.name) ? `Draft "${draft.name}"` : 'Draft' }).png
      } catch (e) {
        if (e instanceof GridError) throw new HttpError(400, 'bad_request', e.message)
        throw e
      }
      this.draftPictures.set(key, png)
      // 存满了丢最早放进去的
      if (this.draftPictures.size > DRAFT_PICTURES_CACHED) this.draftPictures.delete(this.draftPictures.keys().next().value!)
    }
    // 草稿重新存过以后地址里的时间会变（面板带着 savedAt），所以同一个地址的图可以放心缓存一会儿
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'private, max-age=60' })
    res.end(png)
  }

  /** 三维预览要的数据：盒子里每一格是什么，每种方块怎么画（贴图在图集第几格，或者什么颜色）。 */
  private model(grid: VoxelGrid): Scene {
    const textures = this.deps.textures
    return sceneOf(grid, this.blockLooks(), {
      nameOf: (kind) => this.deps.design.nameOf(kind),
      ...(textures ? { textures, atlasUrl: `/api/textures/atlas.png?v=${encodeURIComponent(textures.version)}` } : {}),
    })
  }

  /** 多方块机器的名单（按名字搜）。 */
  private structureList(query: string): unknown {
    const book = this.deps.structures
    if (!book) return { available: false, total: 0, machines: [] }
    const hits = query.trim().length > 0 ? book.search(query) : book.machines
    return { available: true, total: hits.length, machines: hits.slice(0, 60).map((m) => ({ id: m.id, meta: m.meta, name: m.name, tiers: StructureBook.tiersOf(m) })) }
  }

  /** 一台多方块机器某个等级的结构：材料清单、说明文字，和三维预览要的数据（和草稿的预览同一种）。 */
  private structureModel(id: string, meta: number, tierText: string | null): unknown {
    const machine = this.deps.structures?.get(id, meta)
    if (!machine) throw new HttpError(404, 'not_found', '没有这台多方块机器的结构')
    const tiers = StructureBook.tiersOf(machine)
    const tier = tierText === null || tierText === '' ? tiers[0]! : Number(tierText)
    const row = StructureBook.rowOf(machine, tier)
    if (!row) throw new HttpError(404, 'not_found', `这台机器没有 ${tierText} 级，它有：${tiers.join('、')}`)
    let grid: VoxelGrid
    try {
      grid = gridFromBlocks({ x: 0, y: 0, z: 0, sx: row.size[0], sy: row.size[1], sz: row.size[2], palette: row.palette, runs: Array.from(row.runs) })
    } catch (e) {
      if (e instanceof GridError) throw new HttpError(400, 'bad_request', e.message)
      throw e
    }
    return { id: machine.id, meta: machine.meta, name: machine.name, tier, tiers, sameAs: row.tiers, controller: row.controller, blocks: row.blocks, info: machine.info, structureInfo: machine.structureInfo, ...this.model(grid) }
  }

  private draftModel(name: string): unknown {
    const record = this.deps.design.drafts.get(name)
    if (!record) throw new HttpError(404, 'not_found', '没有这张草稿')
    return { name: record.draft.name, ...this.model(gridFromDraft(record.draft)) }
  }

  /** 对话日志里一张简图的三维预览：画那张图时存下的盒子。主人传的图片这类没有盒子的是 404。 */
  private pictureModel(id: string): unknown {
    const blocks = this.deps.pictures?.blocks(id)
    if (blocks === undefined) throw new HttpError(404, 'not_found', '这张图没有三维预览（可能已经清理掉了）')
    try {
      return this.model(gridFromBlocks(blocks, DRAFT_MAX_SIDE))
    } catch (e) {
      if (e instanceof GridError) throw new HttpError(404, 'not_found', '这张图存下的方块数据读不出来')
      throw e
    }
  }

  /** 贴图图集那张图，原样给。地址里带着版本，所以可以让浏览器一直留着。 */
  private textureAtlas(res: http.ServerResponse): void {
    const file = this.deps.textures?.file
    let png: Buffer | undefined
    try {
      if (file !== undefined) png = fs.readFileSync(file)
    } catch {
      /* 文件没了：当没有 */
    }
    if (!png) throw new HttpError(404, 'not_found', '没有方块贴图')
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'private, max-age=604800, immutable' })
    res.end(png)
  }

  /** 物品图标图集的一张图，原样给。地址里带着版本，所以可以让浏览器一直留着。 */
  private iconSheet(res: http.ServerResponse, url: URL): void {
    const png = this.live.iconSheet(Number(url.searchParams.get('n') ?? 0))
    if (!png) throw new HttpError(404, 'not_found', '没有这张物品图标')
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'private, max-age=604800, immutable' })
    res.end(png)
  }

  /** 它看过的一张图（对话日志里的）。 */
  private pictureFile(res: http.ServerResponse, url: URL): void {
    const png = this.deps.pictures?.get(url.searchParams.get('id') ?? '')
    if (!png) throw new HttpError(404, 'not_found', '这张图已经清理掉了')
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'private, max-age=3600' })
    res.end(png)
  }

  private draftName(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length === 0) throw new HttpError(400, 'bad_request', '需要草稿的名字')
    return raw
  }

  private draftDelete(body: Record<string, unknown>): unknown {
    const name = this.draftName(body.name)
    const removed = this.deps.design.drafts.remove(name)
    if (removed) this.deps.log.add({ kind: 'info', text: `在面板上删除了草稿 ${name}。` })
    return { removed, ...(this.draftList() as object) }
  }

  /** 主人看过觉得行，直接在面板上把草稿发成游戏里的图纸（和它自己用 publish_draft 是一回事）。 */
  private async draftPublish(body: Record<string, unknown>): Promise<unknown> {
    const name = this.draftName(body.name)
    const record = this.deps.design.drafts.get(name)
    if (!record) throw new HttpError(404, 'not_found', '没有这张草稿')
    const file = toSchematic(record.draft)
    if (file.length > SCHEMATIC_MAX_BYTES) throw new HttpError(413, 'too_large', `这张草稿转成图纸有 ${(file.length / 1024 / 1024).toFixed(1)} MiB，图纸最大 ${SCHEMATIC_MAX_BYTES / 1024 / 1024} MiB`)
    let saved: Awaited<ReturnType<BridgeApi['blueprintPut']>>
    try {
      saved = await this.deps.bridge.blueprintPut(this.blueprintName(name), file.toString('base64'))
    } catch (e) {
      if (e instanceof BridgeError && e.code === 'bad_request') throw new HttpError(400, 'bad_blueprint', `游戏那边没收下这张图纸：${e.message}`)
      throw e
    }
    this.deps.log.add({ kind: 'info', text: `在面板上把草稿 ${name} 发布成了图纸（${saved.blocks ?? '?'} 个方块）。` })
    return { saved }
  }

  // ── 图片：主人传给它做像素画、当参考的。浏览器已经缩小并转成了 PNG ──

  private imageList(): unknown {
    return { images: this.deps.design.images.list(), max: IMAGES_MAX, maxSide: IMAGE_MAX_SIDE, maxBytes: IMAGE_MAX_BYTES }
  }

  private imageUpload(body: Record<string, unknown>): unknown {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const data = typeof body.data === 'string' ? body.data : ''
    if (data.length === 0) throw new HttpError(400, 'bad_request', '没有收到图片内容')
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new HttpError(400, 'bad_request', '图片内容必须是 base64')
    try {
      const saved = this.deps.design.images.save(name, Buffer.from(data, 'base64'))
      this.deps.log.add({ kind: 'info', text: `在面板上传了图片 ${saved.name}（${saved.width}×${saved.height}）。` })
      return { saved, ...(this.imageList() as object) }
    } catch (e) {
      if (e instanceof DesignStoreError) throw new HttpError(400, 'bad_image', e.message)
      throw e
    }
  }

  private imageDelete(body: Record<string, unknown>): unknown {
    const name = typeof body.name === 'string' ? body.name : ''
    const removed = this.deps.design.images.remove(name)
    if (removed) this.deps.log.add({ kind: 'info', text: `在面板上删除了图片 ${name}。` })
    return { removed, ...(this.imageList() as object) }
  }

  /** 图片本身（给页面上的 <img> 用）。名字由 ImageStore 校验，出不了图片目录。 */
  private imageFile(res: http.ServerResponse, url: URL): void {
    const png = this.deps.design.images.png(url.searchParams.get('name') ?? '')
    if (!png) throw new HttpError(404, 'not_found', '没有这张图片')
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length })
    res.end(png)
  }

  // ── 意见簿：它干活时自己记下的反馈 ──

  /** 地址里的筛选条件：category 是五个类别之一，status 是 new / seen / handled，或者 open（还没处理的）。不认识的当没给。 */
  private feedbackFilter(url: URL): { category?: FeedbackCategory; status?: FeedbackStatus | 'open' } {
    const category = url.searchParams.get('category')
    const status = url.searchParams.get('status')
    const filter: { category?: FeedbackCategory; status?: FeedbackStatus | 'open' } = {}
    if (category !== null && (FEEDBACK_CATEGORIES as readonly string[]).includes(category)) filter.category = category as FeedbackCategory
    if (status === 'new' || status === 'seen' || status === 'handled' || status === 'open') filter.status = status
    return filter
  }

  /** 列表：新的在前，只带标题这些；附带的现场在详情里。 */
  private feedbackList(url: URL): unknown {
    const all = this.deps.feedback.list(this.feedbackFilter(url))
    const shown = all.slice(0, FEEDBACK_LIST_MAX)
    return {
      reports: shown.map((r) => ({ id: r.id, time: r.time, lastTime: r.lastTime, count: r.count, status: r.status, title: r.title, category: r.category })),
      more: all.length - shown.length,
      total: this.deps.feedback.list().length,
      unread: this.deps.feedback.unread(),
    }
  }

  private feedbackGet(id: string): FeedbackReport {
    const report = this.deps.feedback.get(id)
    if (!report) throw new HttpError(404, 'not_found', '意见簿里没有这一条')
    return report
  }

  private feedbackStatus(body: Record<string, unknown>): unknown {
    const status = body.status
    if (typeof body.id !== 'string' || (status !== 'new' && status !== 'seen' && status !== 'handled')) {
      throw new HttpError(400, 'bad_request', '需要 id 和 status（new、seen 或 handled）')
    }
    const report = this.deps.feedback.setStatus(body.id, status)
    if (!report) throw new HttpError(404, 'not_found', '意见簿里没有这一条')
    this.overviewCache = undefined
    return { report, unread: this.deps.feedback.unread() }
  }

  /** 导出成一个 JSON 文件：筛出来的每一条，连同附带的现场。主人整包拿去给人看。 */
  private feedbackExport(res: http.ServerResponse, url: URL): void {
    const filter = this.feedbackFilter(url)
    const reports = this.deps.feedback.list(filter)
    const now = new Date(this.now())
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
    const text = `${JSON.stringify({ exportedAt: now.toISOString(), bot: this.deps.config.get().bot.name, filter, count: reports.length, reports }, null, 2)}\n`
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="aiplayer-feedback-${stamp}.json"`,
      'Content-Length': Buffer.byteLength(text),
    })
    res.end(text)
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
    res.setHeader('Set-Cookie', sessionCookie(createSessionValue(updated.sessionSecret, updated.password, now), { secure: this.isSecure(req), name: sessionCookieName(req) }))
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
