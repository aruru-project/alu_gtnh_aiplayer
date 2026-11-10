// 配置（含密钥）。落在数据目录的 config.json，权限 600。

import crypto from 'node:crypto'
import path from 'node:path'
import { isProviderKind } from '../llm/index.ts'
import type { ProviderConfig } from '../llm/index.ts'
import { isRecord, readJson, writeJsonAtomic } from './files.ts'

export interface PanelConfig {
  host: string
  port: number
  /** 面板访问口令，首次启动随机生成。 */
  password: string
  /** 给会话 cookie 签名用。 */
  sessionSecret: string
}

export interface BridgeConfig {
  host: string
  port: number
  /** 直接写口令；留空则读 tokenFile。 */
  token: string
  /** 口令文件路径；相对路径相对 brain/ 目录。和 token 都为空表示还没配置，那时不去连接。 */
  tokenFile: string
  requestTimeoutMs: number
}

export interface WakeConfig {
  /** mention：提到名字或刚对话过才触发；all：所有聊天都触发。 */
  mode: 'mention' | 'all'
  /** 玩家和 bot 对话后，多少秒内不用再叫名字。 */
  conversationWindowSec: number
}

export interface LimitsConfig {
  /** 每轮决策最多调几次模型。 */
  maxSteps: number
  /** 每日 token 上限（输入+输出），0 为不限。 */
  dailyTokenLimit: number
  /** 历史估算 token 超过这个值就压缩。 */
  historyTokenThreshold: number
  /** 记忆总长度上限（字符）。 */
  memoryMaxChars: number
  /** 单个工具结果的长度上限（字符）。 */
  toolResultMaxChars: number
}

export interface BotConfig {
  name: string
  aliases: string[]
  /** 主人名单。非空时只有名单里的玩家能指挥。 */
  owners: string[]
  /** 人设提示词；空字符串表示用默认的。 */
  systemPrompt: string
  wake: WakeConfig
  limits: LimitsConfig
  /** 面板上按了“上线”为 true，“下线”为 false。bridge 连上时据此决定要不要把 bot 叫出来。 */
  wantOnline: boolean
}

export interface BrainConfig {
  version: 1
  panel: PanelConfig
  bridge: BridgeConfig
  bot: BotConfig
  providers: ProviderConfig[]
  /** 当前使用的服务商 id；空字符串表示还没选。 */
  activeProviderId: string
}

/** 默认按正式部署来：端口 25590，口令文件没有默认值（必须显式配置）。 */
export const DEFAULT_BRIDGE_PORT = 25590

export const DEFAULT_LIMITS: LimitsConfig = {
  maxSteps: 16,
  dailyTokenLimit: 0,
  historyTokenThreshold: 24_000,
  memoryMaxChars: 4000,
  toolResultMaxChars: 6000,
}

export const DEFAULT_WAKE: WakeConfig = { mode: 'mention', conversationWindowSec: 60 }

export function defaultConfig(): BrainConfig {
  return {
    version: 1,
    panel: { host: '127.0.0.1', port: 8765, password: '', sessionSecret: '' },
    bridge: { host: '127.0.0.1', port: DEFAULT_BRIDGE_PORT, token: '', tokenFile: '', requestTimeoutMs: 10_000 },
    bot: {
      name: 'Alu',
      aliases: [],
      owners: [],
      systemPrompt: '',
      wake: { ...DEFAULT_WAKE },
      limits: { ...DEFAULT_LIMITS },
      wantOnline: false,
    },
    providers: [],
    activeProviderId: '',
  }
}

// ── 容错读取：字段类型不对就退回默认值，不让一份手改坏的配置把进程卡死 ──

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function strList(v: unknown, maxItems = 50): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  for (const item of v) {
    if (typeof item !== 'string') continue
    const s = item.trim()
    if (s.length > 0 && s.length <= 64 && !out.includes(s)) out.push(s)
    if (out.length >= maxItems) break
  }
  return out
}

function stringMap(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string' && k.trim().length > 0) out[k.trim()] = val
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Minecraft 玩家名：1–16 位字母、数字、下划线。 */
export function isValidPlayerName(name: string): boolean {
  return /^[A-Za-z0-9_]{1,16}$/.test(name)
}

/**
 * 把一份来自文件或面板的服务商配置整理成合法形状。不合法时抛 Error（消息给人看）。
 * 这里不处理“空 key 表示不修改”，那是面板接口的语义。
 */
export function sanitizeProvider(raw: unknown): ProviderConfig {
  if (!isRecord(raw)) throw new Error('服务商配置必须是对象')
  const id = str(raw.id, '').trim()
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error('服务商 id 不合法')
  if (!isProviderKind(raw.kind)) throw new Error(`不支持的接口类型：${String(raw.kind)}`)
  const baseUrl = str(raw.baseUrl, '').trim()
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('服务地址不是合法的 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('服务地址必须以 http:// 或 https:// 开头')
  const model = str(raw.model, '').trim()
  if (model.length === 0) throw new Error('模型名不能为空')

  const out: ProviderConfig = {
    id,
    label: str(raw.label, '').trim().slice(0, 60) || model,
    kind: raw.kind,
    baseUrl,
    apiKey: str(raw.apiKey, '').trim(),
    model,
  }
  if (raw.maxOutputTokens !== undefined && raw.maxOutputTokens !== null && raw.maxOutputTokens !== '') {
    out.maxOutputTokens = int(raw.maxOutputTokens, 4096, 1, 1_000_000)
  }
  if (typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)) {
    out.temperature = Math.min(2, Math.max(0, raw.temperature))
  }
  if (raw.timeoutMs !== undefined && raw.timeoutMs !== null && raw.timeoutMs !== '') {
    out.timeoutMs = int(raw.timeoutMs, 120_000, 1000, 3_600_000)
  }
  const headers = stringMap(raw.extraHeaders)
  if (headers) out.extraHeaders = headers
  if (isRecord(raw.extraBody) && Object.keys(raw.extraBody).length > 0) out.extraBody = raw.extraBody
  if (isRecord(raw.options) && Object.keys(raw.options).length > 0) out.options = raw.options
  return out
}

export function normalizeConfig(raw: unknown): BrainConfig {
  const d = defaultConfig()
  if (!isRecord(raw)) return d
  const panel = isRecord(raw.panel) ? raw.panel : {}
  const bridge = isRecord(raw.bridge) ? raw.bridge : {}
  const bot = isRecord(raw.bot) ? raw.bot : {}
  const wake = isRecord(bot.wake) ? bot.wake : {}
  const limits = isRecord(bot.limits) ? bot.limits : {}

  const providers: ProviderConfig[] = []
  if (Array.isArray(raw.providers)) {
    for (const p of raw.providers) {
      try {
        const clean = sanitizeProvider(p)
        if (!providers.some((x) => x.id === clean.id)) providers.push(clean)
      } catch (e) {
        console.error(`[config] 忽略一条不合法的服务商配置：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  const active = str(raw.activeProviderId, '')
  const name = str(bot.name, d.bot.name).trim()

  return {
    version: 1,
    panel: {
      host: str(panel.host, d.panel.host).trim() || d.panel.host,
      port: int(panel.port, d.panel.port, 0, 65535),
      password: str(panel.password, ''),
      sessionSecret: str(panel.sessionSecret, ''),
    },
    bridge: {
      host: str(bridge.host, d.bridge.host).trim() || d.bridge.host,
      port: int(bridge.port, d.bridge.port, 1, 65535),
      token: str(bridge.token, '').trim(),
      tokenFile: str(bridge.tokenFile, '').trim().slice(0, 1000),
      requestTimeoutMs: int(bridge.requestTimeoutMs, d.bridge.requestTimeoutMs, 500, 120_000),
    },
    bot: {
      name: isValidPlayerName(name) ? name : d.bot.name,
      aliases: strList(bot.aliases),
      owners: strList(bot.owners),
      systemPrompt: str(bot.systemPrompt, '').slice(0, 20_000),
      wake: {
        mode: wake.mode === 'all' ? 'all' : 'mention',
        conversationWindowSec: int(wake.conversationWindowSec, DEFAULT_WAKE.conversationWindowSec, 0, 3600),
      },
      limits: {
        maxSteps: int(limits.maxSteps, DEFAULT_LIMITS.maxSteps, 1, 64),
        dailyTokenLimit: int(limits.dailyTokenLimit, DEFAULT_LIMITS.dailyTokenLimit, 0, 1_000_000_000),
        historyTokenThreshold: int(limits.historyTokenThreshold, DEFAULT_LIMITS.historyTokenThreshold, 2000, 2_000_000),
        memoryMaxChars: int(limits.memoryMaxChars, DEFAULT_LIMITS.memoryMaxChars, 200, 100_000),
        toolResultMaxChars: int(limits.toolResultMaxChars, DEFAULT_LIMITS.toolResultMaxChars, 500, 100_000),
      },
      wantOnline: bot.wantOnline === true,
    },
    providers,
    activeProviderId: providers.some((p) => p.id === active) ? active : (providers[0]?.id ?? ''),
  }
}

/** 环境变量给的覆盖值，优先于配置文件，不写回文件。 */
export interface ConfigOverrides {
  panelHost?: string
  panelPort?: number
  bridgeHost?: string
  bridgePort?: number
  bridgeToken?: string
  bridgeTokenFile?: string
}

export function overridesFromEnv(env: NodeJS.ProcessEnv): ConfigOverrides {
  const out: ConfigOverrides = {}
  const port = (v: string | undefined): number | undefined => {
    if (v === undefined || v.trim() === '') return undefined
    const n = Number(v)
    return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined
  }
  if (env.AIPLAYER_PANEL_HOST) out.panelHost = env.AIPLAYER_PANEL_HOST
  const panelPort = port(env.AIPLAYER_PANEL_PORT)
  if (panelPort !== undefined) out.panelPort = panelPort
  if (env.AIPLAYER_BRIDGE_HOST) out.bridgeHost = env.AIPLAYER_BRIDGE_HOST
  const bridgePort = port(env.AIPLAYER_BRIDGE_PORT)
  if (bridgePort !== undefined) out.bridgePort = bridgePort
  if (env.AIPLAYER_BRIDGE_TOKEN) out.bridgeToken = env.AIPLAYER_BRIDGE_TOKEN
  if (env.AIPLAYER_BRIDGE_TOKEN_FILE) out.bridgeTokenFile = env.AIPLAYER_BRIDGE_TOKEN_FILE
  return out
}

export class ConfigStore {
  readonly file: string
  /** 这次启动是不是刚生成了面板口令（用来决定要不要打印）。 */
  readonly passwordGenerated: boolean
  private config: BrainConfig
  private readonly overrides: ConfigOverrides
  private readonly listeners = new Set<(config: BrainConfig) => void>()

  constructor(dataDir: string, overrides: ConfigOverrides = {}) {
    this.file = path.join(dataDir, 'config.json')
    this.overrides = overrides
    const raw = readJson(this.file)
    this.config = normalizeConfig(raw)
    let dirty = raw === undefined
    this.passwordGenerated = this.config.panel.password.length === 0
    if (this.passwordGenerated) {
      this.config.panel.password = crypto.randomBytes(18).toString('base64url')
      dirty = true
    }
    if (this.config.panel.sessionSecret.length === 0) {
      this.config.panel.sessionSecret = crypto.randomBytes(32).toString('base64url')
      dirty = true
    }
    if (dirty) this.save()
  }

  /** 当前配置。当作只读用；要改走 update。 */
  get(): BrainConfig {
    return this.config
  }

  /** 改配置并落盘。mutate 里抛错则什么都不变。 */
  update(mutate: (draft: BrainConfig) => void): BrainConfig {
    const draft = structuredClone(this.config)
    mutate(draft)
    const next = normalizeConfig(draft)
    // 这两项不允许被整理成空
    next.panel.password = next.panel.password || this.config.panel.password
    next.panel.sessionSecret = next.panel.sessionSecret || this.config.panel.sessionSecret
    this.config = next
    this.save()
    for (const fn of this.listeners) {
      try {
        fn(next)
      } catch (e) {
        console.error('[config] listener failed:', e)
      }
    }
    return next
  }

  onChange(fn: (config: BrainConfig) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  activeProvider(): ProviderConfig | undefined {
    return this.config.providers.find((p) => p.id === this.config.activeProviderId)
  }

  /** 面板实际监听的地址（环境变量优先）。 */
  panelAddress(): { host: string; port: number } {
    return {
      host: this.overrides.panelHost ?? this.config.panel.host,
      port: this.overrides.panelPort ?? this.config.panel.port,
    }
  }

  /** 哪些项正被环境变量覆盖着（面板上改了也不生效，要提示给人看）。 */
  overridden(): { panelHost: boolean; panelPort: boolean; bridgeHost: boolean; bridgePort: boolean; bridgeToken: boolean; bridgeTokenFile: boolean } {
    const o = this.overrides
    return {
      panelHost: o.panelHost !== undefined,
      panelPort: o.panelPort !== undefined,
      bridgeHost: o.bridgeHost !== undefined,
      bridgePort: o.bridgePort !== undefined,
      bridgeToken: o.bridgeToken !== undefined,
      bridgeTokenFile: o.bridgeTokenFile !== undefined,
    }
  }

  /** bridge 实际使用的连接参数（环境变量优先）。 */
  bridgeSettings(): BridgeConfig {
    const b = this.config.bridge
    return {
      host: this.overrides.bridgeHost ?? b.host,
      port: this.overrides.bridgePort ?? b.port,
      token: this.overrides.bridgeToken ?? b.token,
      tokenFile: this.overrides.bridgeTokenFile ?? b.tokenFile,
      requestTimeoutMs: b.requestTimeoutMs,
    }
  }

  private save(): void {
    writeJsonAtomic(this.file, this.config)
  }
}

/** 给人看的 key 掩码：只露开头几位和末 4 位。 */
export function maskSecret(secret: string): string {
  if (secret.length === 0) return ''
  if (secret.length <= 8) return '…'
  const head = /^[A-Za-z]{2,4}-/.exec(secret)?.[0] ?? ''
  return `${head}…${secret.slice(-4)}`
}
