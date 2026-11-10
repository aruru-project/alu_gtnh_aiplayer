export type LlmErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'bad_request'
  | 'context_length'
  | 'network'
  | 'timeout'
  | 'server'
  | 'aborted'

const RETRYABLE: Record<LlmErrorKind, boolean> = {
  auth: false,
  rate_limit: true,
  overloaded: true,
  bad_request: false,
  context_length: false,
  network: true,
  timeout: true,
  server: true,
  aborted: false,
}

export class LlmError extends Error {
  kind: LlmErrorKind
  status?: number
  retryable: boolean
  /** 服务端通过 Retry-After 要求的最短等待，毫秒。 */
  retryAfterMs?: number

  constructor(
    kind: LlmErrorKind,
    message: string,
    opts: { status?: number; retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'LlmError'
    this.kind = kind
    this.retryable = opts.retryable ?? RETRYABLE[kind]
    if (opts.status !== undefined) this.status = opts.status
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
  }
}

export function isLlmError(e: unknown): e is LlmError {
  return e instanceof LlmError
}

const CONTEXT_LENGTH_RE =
  /context[_ ]length|maximum context|context window|prompt is too long|too many tokens|input is too long|reduce the length|exceeds? the (model'?s? )?(maximum|max) (context|input|token)/i

const QUOTA_RE = /insufficient_quota|quota exceeded|billing|credit balance/i

/**
 * 按 HTTP 状态码和错误正文分类。errorType 是正文里各家自己的错误类型字段
 * （OpenAI 的 error.code / error.type，Anthropic 的 error.type）。
 */
export function classifyHttpError(
  status: number,
  message: string,
  errorType: string | undefined,
  retryAfterMs: number | undefined,
): LlmError {
  const type = errorType ?? ''
  const text = `${type} ${message}`
  const opts: { status: number; retryAfterMs?: number; retryable?: boolean } = { status }
  if (retryAfterMs !== undefined) opts.retryAfterMs = retryAfterMs
  const msg = message || `HTTP ${status}`

  if (status === 401 || status === 403 || /authentication_error|permission_error|invalid_api_key/.test(type)) {
    return new LlmError('auth', msg, opts)
  }
  if (status === 429 || /rate_limit/.test(type)) {
    // 余额或配额用完也常常是 429，但重试没有意义。
    if (QUOTA_RE.test(text)) opts.retryable = false
    return new LlmError('rate_limit', msg, opts)
  }
  if (status === 413 || /request_too_large/.test(type) || CONTEXT_LENGTH_RE.test(text)) {
    return new LlmError('context_length', msg, opts)
  }
  if (status === 529 || status === 503 || /overloaded/.test(type)) {
    return new LlmError('overloaded', msg, opts)
  }
  if (status === 408) return new LlmError('timeout', msg, opts)
  if (status >= 500) return new LlmError('server', msg, opts)
  if (status >= 400) return new LlmError('bad_request', msg, opts)
  return new LlmError('server', msg, opts)
}

/** 解析 Retry-After（秒数或 HTTP 日期）和非标准的 retry-after-ms。 */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms')
  if (ms !== null) {
    const n = Number(ms)
    if (Number.isFinite(n) && n >= 0) return n
  }
  const raw = headers.get('retry-after')
  if (raw === null) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(raw)
  if (!Number.isNaN(date)) return Math.max(0, date - now)
  return undefined
}
