import { LlmError } from './errors.ts'
import type { GenerateRequest, GenerateResult, LlmClient } from './types.ts'

export interface RetryOptions {
  /** 总尝试次数（含第一次），默认 4。 */
  maxAttempts?: number
  /** 第一次重试前的等待，之后每次翻倍。默认 1000。 */
  baseDelayMs?: number
  /** 单次等待的上限。默认 30000。 */
  maxDelayMs?: number
  /** 服务端要求的 Retry-After 超过这个值就不等了，直接把错误交给上层。默认 120000。 */
  maxRetryAfterMs?: number
  /** 抖动比例 0–1，默认 0.2。 */
  jitter?: number
  onRetry?: (info: { attempt: number; delayMs: number; error: LlmError }) => void
  /** 测试用。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

/** 可被 AbortSignal 打断的等待。被打断时抛 LlmError('aborted')。 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('aborted', 'aborted while waiting to retry'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new LlmError('aborted', 'aborted while waiting to retry'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function retryDelayMs(attempt: number, error: LlmError, opts: RetryOptions = {}): number {
  const base = opts.baseDelayMs ?? 1000
  const max = opts.maxDelayMs ?? 30_000
  const jitter = opts.jitter ?? 0.2
  const random = opts.random ?? Math.random
  const backoff = Math.min(max, base * 2 ** (attempt - 1)) * (1 + jitter * random())
  return Math.round(Math.max(backoff, error.retryAfterMs ?? 0))
}

/** 只对 retryable 的 LlmError 做指数退避重试；尊重 Retry-After；可被请求里的 signal 打断。 */
export function withRetry(client: LlmClient, opts: RetryOptions = {}): LlmClient {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4)
  const maxRetryAfterMs = opts.maxRetryAfterMs ?? 120_000
  const sleep = opts.sleep ?? abortableSleep

  return {
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      for (let attempt = 1; ; attempt++) {
        try {
          return await client.generate(req)
        } catch (e) {
          if (!(e instanceof LlmError) || !e.retryable || attempt >= maxAttempts) throw e
          if (e.retryAfterMs !== undefined && e.retryAfterMs > maxRetryAfterMs) throw e
          const delayMs = retryDelayMs(attempt, e, opts)
          opts.onRetry?.({ attempt, delayMs, error: e })
          await sleep(delayMs, req.signal)
          if (req.signal?.aborted) throw new LlmError('aborted', 'aborted while waiting to retry')
        }
      }
    },
  }
}
