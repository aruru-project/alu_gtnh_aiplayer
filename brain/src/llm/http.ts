// 两个适配器共用的 HTTP 部分：超时、打断、把各种失败归成 LlmError。

import { LlmError, classifyHttpError, parseRetryAfter } from './errors.ts'
import { errorText, isRecord } from '../util.ts'

export const DEFAULT_TIMEOUT_MS = 120_000
/** 拉模型列表不该等很久：这只是填表时的一个方便。 */
export const LIST_MODELS_TIMEOUT_MS = 15_000

/** 这次调用实际等多久：模型配置的超时（没配是默认的两分钟）；这次调用自己要求至少等更久的，用更久的那个。 */
export function requestTimeoutMs(configured: number | undefined, atLeast: number | undefined): number {
  const base = configured !== undefined && configured > 0 ? configured : DEFAULT_TIMEOUT_MS
  return atLeast !== undefined ? Math.max(base, atLeast) : base
}

/** Node 自带的 fetch 等响应头、等下一段正文各只等这么久，到点就断（报成网络错误），不管我们自己的超时设了多长。 */
const FETCH_OWN_WAIT_MS = 300_000

let patient: object | null | undefined

/**
 * 一个不设“等响应头、等正文”上限的连接器：我们的超时比 fetch 自己那五分钟长的时候用它（写交接记录的那种调用，
 * 模型写一两万字要好几分钟才回响应头），超时只由我们自己的计时管。
 * 零依赖，不能 import undici：连接器的类拿的是 Node 全局那个的（全局的是带代理的那种时，新建的也带代理）。拿不到就不换，照旧。
 */
export function patientDispatcher(): object | undefined {
  if (patient === undefined) {
    patient = null
    try {
      const key = Symbol.for('undici.globalDispatcher.1')
      const globals = globalThis as unknown as Record<symbol, { constructor?: new (opts: Record<string, unknown>) => object } | undefined>
      // 进程里还没用过 fetch 时全局的连接器还没建：发一个不出门的请求让它建出来
      if (globals[key] === undefined) void fetch('data:,').catch(() => {})
      const Agent = globals[key]?.constructor
      if (typeof Agent === 'function') patient = new Agent({ headersTimeout: 0, bodyTimeout: 0 })
    } catch {
      patient = null
    }
  }
  return patient ?? undefined
}

export interface PostJsonOptions {
  fetch?: typeof fetch | undefined
  url: string
  headers: Record<string, string>
  body: unknown
  timeoutMs?: number | undefined
  signal?: AbortSignal | undefined
}

export interface PostJsonResult {
  json: unknown
  headers: Headers
}

/** 从错误响应正文里取出消息和类型。两家的形状都是 {error:{message,type,code}}，网关偶尔给 {error:"…"} 或 {message}。 */
export function extractErrorInfo(json: unknown, text: string): { message: string; type?: string } {
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>
    const err = obj.error
    if (typeof err === 'string') return { message: err }
    if (err && typeof err === 'object') {
      const e = err as Record<string, unknown>
      const message = typeof e.message === 'string' ? e.message : JSON.stringify(e)
      const parts = [e.type, e.code].filter((v): v is string => typeof v === 'string')
      return parts.length > 0 ? { message, type: parts.join(' ') } : { message }
    }
    if (typeof obj.message === 'string') return { message: obj.message }
  }
  return { message: text.trim().slice(0, 500) }
}

function describeNetworkError(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause
    if (cause && typeof cause === 'object') {
      const c = cause as { code?: unknown; message?: unknown }
      const code = typeof c.code === 'string' ? c.code : ''
      const msg = typeof c.message === 'string' ? c.message : ''
      const detail = [code, msg].filter(Boolean).join(' ')
      if (detail) return `${e.message}: ${detail}`
    }
    return e.message
  }
  return String(e)
}

export function postJson(opts: PostJsonOptions): Promise<PostJsonResult> {
  return sendJson('POST', opts)
}

/** GET 一个 JSON（拉模型列表用）。出错的归类和 postJson 一样。 */
export function getJson(opts: Omit<PostJsonOptions, 'body'>): Promise<PostJsonResult> {
  return sendJson('GET', { ...opts, body: undefined })
}

async function sendJson(method: 'GET' | 'POST', opts: PostJsonOptions): Promise<PostJsonResult> {
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS

  if (opts.signal?.aborted) throw new LlmError('aborted', 'request aborted')

  // 地址、请求头（比如 key 里混进了中文或换行）不合法时 fetch 会抛 TypeError，
  // 和网络故障长得一样。提前构造一次，把它归成不可重试的 bad_request。
  let url: URL
  let headers: Headers
  let payload: string | undefined
  try {
    url = new URL(opts.url)
    headers = new Headers(opts.headers)
    payload = method === 'POST' ? JSON.stringify(opts.body) : undefined
  } catch (e) {
    throw new LlmError('bad_request', `invalid request: ${errorText(e)}`, { cause: e })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LlmError('bad_request', `invalid request: unsupported URL scheme ${url.protocol}`)
  }

  const timeoutCtl = new AbortController()
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutCtl.signal]) : timeoutCtl.signal

  const failure = (e: unknown): LlmError => {
    if (e instanceof LlmError) return e
    if (opts.signal?.aborted) return new LlmError('aborted', 'request aborted', { cause: e })
    if (timeoutCtl.signal.aborted) return new LlmError('timeout', `no response within ${timeoutMs} ms`, { cause: e })
    return new LlmError('network', describeNetworkError(e), { cause: e })
  }

  try {
    let res: Response
    let text: string
    try {
      const dispatcher = timeoutMs > FETCH_OWN_WAIT_MS ? patientDispatcher() : undefined
      res = await doFetch(url, { method, headers, ...(payload !== undefined ? { body: payload } : {}), signal, redirect: 'manual', ...(dispatcher ? { dispatcher } : {}) } as RequestInit)
      text = await res.text()
    } catch (e) {
      throw failure(e)
    }

    let json: unknown
    let parsed = false
    try {
      json = JSON.parse(text)
      parsed = true
    } catch {
      /* 留给下面按状态码处理 */
    }

    if (res.status >= 300 && res.status < 400) {
      // 跟随重定向会把 POST 变成 GET 或丢掉鉴权头，不如直接告诉用户改地址。（GET 也一样处理：鉴权头不该跟着跳到别的主机。）
      const location = res.headers.get('location') ?? '(unknown)'
      throw new LlmError('bad_request', `server redirected to ${location}; set baseUrl to the final address`, {
        status: res.status,
      })
    }
    if (!res.ok) {
      const info = extractErrorInfo(parsed ? json : undefined, text)
      throw classifyHttpError(res.status, info.message, info.type, parseRetryAfter(res.headers))
    }
    if (!parsed || json === null || typeof json !== 'object') {
      throw new LlmError('server', `response is not JSON: ${text.trim().slice(0, 200)}`, { status: res.status })
    }
    return { json, headers: res.headers }
  } finally {
    clearTimeout(timer)
  }
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined
}

export function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
