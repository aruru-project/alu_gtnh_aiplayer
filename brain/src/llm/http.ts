// 两个适配器共用的 HTTP 部分：超时、打断、把各种失败归成 LlmError。

import { LlmError, classifyHttpError, parseRetryAfter } from './errors.ts'

export const DEFAULT_TIMEOUT_MS = 120_000

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

export async function postJson(opts: PostJsonOptions): Promise<PostJsonResult> {
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS

  if (opts.signal?.aborted) throw new LlmError('aborted', 'request aborted')

  // 地址、请求头（比如 key 里混进了中文或换行）不合法时 fetch 会抛 TypeError，
  // 和网络故障长得一样。提前构造一次，把它归成不可重试的 bad_request。
  let url: URL
  let headers: Headers
  let payload: string
  try {
    url = new URL(opts.url)
    headers = new Headers(opts.headers)
    payload = JSON.stringify(opts.body)
  } catch (e) {
    throw new LlmError('bad_request', `invalid request: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
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
      res = await doFetch(url, { method: 'POST', headers, body: payload, signal, redirect: 'manual' })
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
      // 跟随重定向会把 POST 变成 GET 或丢掉鉴权头，不如直接告诉用户改地址。
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
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

export function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
