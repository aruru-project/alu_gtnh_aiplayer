// 面板的鉴权：口令登录、签名的会话 cookie、登录限速、写操作的 Origin 校验。

import crypto from 'node:crypto'
import type http from 'node:http'

export const SESSION_COOKIE = 'aiplayer_session'

/**
 * 这个面板的会话 cookie 叫什么。浏览器按主机名存 cookie，不分端口：同一台机器上开两个面板（测试服一个、正式服一个）
 * 用同一个名字的话，登录一个就把另一个的会话盖掉。所以名字里带上浏览器访问的端口。
 */
export function sessionCookieName(req: http.IncomingMessage): string {
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  const port = /:(\d{1,5})$/.exec(host)?.[1] ?? String(req.socket?.localPort ?? '')
  return port ? `${SESSION_COOKIE}_${port}` : SESSION_COOKIE
}
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

function sign(secret: string, password: string, expires: number): string {
  // 密钥里带上口令：改了口令，旧会话全部失效
  return crypto.createHmac('sha256', `${secret}\n${password}`).update(`session:${expires}`).digest('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest()
  const hb = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(ha, hb)
}

export function checkPassword(given: unknown, expected: string): boolean {
  return typeof given === 'string' && expected.length > 0 && safeEqual(given, expected)
}

/** 会话是无状态的：cookie 值 = 过期时间.签名。大脑重启不用重新登录。 */
export function createSessionValue(secret: string, password: string, now: number): string {
  const expires = now + SESSION_TTL_MS
  return `${expires}.${sign(secret, password, expires)}`
}

export function verifySessionValue(value: string | undefined, secret: string, password: string, now: number): boolean {
  if (!value) return false
  const dot = value.indexOf('.')
  if (dot <= 0) return false
  const expires = Number(value.slice(0, dot))
  if (!Number.isSafeInteger(expires) || expires <= now) return false
  return safeEqual(value.slice(dot + 1), sign(secret, password, expires))
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (name.length > 0 && !(name in out)) out[name] = part.slice(eq + 1).trim()
  }
  return out
}

export function sessionCookie(value: string, opts: { secure: boolean; clear?: boolean; name?: string }): string {
  const attrs = [
    `${opts.name ?? SESSION_COOKIE}=${opts.clear ? '' : value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${opts.clear ? 0 : Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (opts.secure) attrs.push('Secure')
  return attrs.join('; ')
}

/**
 * 写操作必须带 Origin，而且要和请求的 Host 一致（浏览器发的同源请求都满足）。
 * 别的网站的页面发来的请求 Origin 对不上；命令行脚本要自己带上这个头。
 */
export function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** 登录限速：同一个来源连续输错 5 次，锁 60 秒。 */
export class LoginLimiter {
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>()
  private readonly maxFailures: number
  private readonly lockMs: number

  constructor(maxFailures = 5, lockMs = 60_000) {
    this.maxFailures = maxFailures
    this.lockMs = lockMs
  }

  /** 还要等多少毫秒才能再试；0 表示可以。 */
  retryAfter(key: string, now: number): number {
    const f = this.failures.get(key)
    return f && f.lockedUntil > now ? f.lockedUntil - now : 0
  }

  fail(key: string, now: number): void {
    const f = this.failures.get(key) ?? { count: 0, lockedUntil: 0 }
    f.count++
    if (f.count >= this.maxFailures) {
      f.count = 0
      f.lockedUntil = now + this.lockMs
    }
    this.failures.set(key, f)
    if (this.failures.size > 1000) this.failures.delete(this.failures.keys().next().value as string)
  }

  succeed(key: string): void {
    this.failures.delete(key)
  }
}
