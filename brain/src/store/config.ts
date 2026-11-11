// 配置（含密钥）。落在数据目录的 config.json，权限 600。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ADAPTERS, isProviderKind } from '../llm/index.ts'
import type { Adapter, ProviderConfig, ProviderKind } from '../llm/index.ts'
import { FILE_MODE, isRecord, readJson, writeJsonAtomic } from './files.ts'

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
  /** 干活线每轮决策最多调几次模型。 */
  maxSteps: number
  /** 对话线每轮最多调几次模型。 */
  talkMaxSteps: number
  /** 每日 token 上限（输入+输出，两条线合计），0 为不限。 */
  dailyTokenLimit: number
  /** 干活线的历史估算 token 超过这个值就压缩。 */
  historyTokenThreshold: number
  /** 对话线的历史估算 token 超过这个值就压缩。它的上下文里只有对话、它查的东西和干活线的汇报，压得勤一点回话才快。 */
  talkHistoryTokenThreshold: number
  /** 记忆总长度上限（字符）。 */
  memoryMaxChars: number
  /** 单个工具结果的长度上限（字符）。 */
  toolResultMaxChars: number
  /** 例程（它写的后台程序）没说跑多久时最多跑几分钟。 */
  routineMinutes: number
  /** 例程自己要求时长时最多给到几分钟。 */
  routineMaxMinutes: number
}

export interface BotConfig {
  name: string
  aliases: string[]
  /** 主人名单。非空时只有名单里的玩家能指挥。 */
  owners: string[]
  /** 对话线的说话风格（主人在面板上改的那一段）；空字符串表示用默认的。字段名是分成两条线之前留下的。 */
  systemPrompt: string
  wake: WakeConfig
  limits: LimitsConfig
  /** 面板上按了“上线”为 true，“下线”为 false。bridge 连上时据此决定要不要把 bot 叫出来。 */
  wantOnline: boolean
}

/** 一个服务商下面的一个模型，和跟着模型走的设置。 */
export interface ModelConfig {
  /** 这个服务商里唯一。 */
  id: string
  /** 发给接口的模型名。 */
  name: string
  /** 给人看的名字；空字符串就显示模型名。同一个模型可以存两份（比如开不开思考），靠它区分。 */
  label: string
  maxOutputTokens?: number
  temperature?: number
  timeoutMs?: number
  /** 浅合并进请求体：思考相关的参数（reasoning_effort、thinking……）放这里。 */
  extraBody?: Record<string, unknown>
  /** 适配器里跟着模型走的开关（见各适配器文件）。 */
  options?: Record<string, unknown>
  /** 这个模型能看图：开着时，它要看的图（简图、主人传的图片）会真的发给它；关着（默认）时只给文字说明。 */
  vision?: boolean
}

/** 一家模型服务：接口类型、地址、key，和它下面的模型。 */
export interface StoredProvider {
  id: string
  label: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  extraHeaders?: Record<string, string>
  /** 适配器里跟着服务商走的开关（比如 key 放在哪个请求头）。 */
  options?: Record<string, unknown>
  models: ModelConfig[]
}

export interface BrainConfig {
  /**
   * 3：对话线和干活线各选一个模型（docs/TALK_WORK.md）。2 是只有一条线、只选一个模型的格式；1 是一个服务商只有一个模型的旧格式。
   * 读到旧的自动转成 3，原文件留一份底。
   */
  version: 3
  panel: PanelConfig
  bridge: BridgeConfig
  bot: BotConfig
  providers: StoredProvider[]
  /** 干活线用的服务商 id；空字符串表示还没选。（字段名是只有一条线时留下的。） */
  activeProviderId: string
  /** 干活线用的是这个服务商下面的哪个模型；空字符串表示它下面还没有模型。 */
  activeModelId: string
  /** 对话线用的服务商和模型。旧配置里没有：和干活线用同一个。 */
  talkProviderId: string
  talkModelId: string
  /** 本地资料（任务书、物品表）的目录；相对路径相对 brain/ 目录，空字符串表示用默认的 packdata。 */
  packdataDir: string
}

/** 本地资料目录的默认位置（相对 brain/）。 */
export const DEFAULT_PACKDATA_DIR = 'packdata'

/** 默认按正式部署来：端口 25590，口令文件没有默认值（必须显式配置）。 */
export const DEFAULT_BRIDGE_PORT = 25590

/** 每轮步数上限最多能设到多少。 */
export const MAX_STEPS_LIMIT = 500

export const DEFAULT_LIMITS: LimitsConfig = {
  // “给一个目标它自己去办”这类活要查物品、查配方、找库存、取料、合成，一轮里几十步是常事
  maxSteps: 60,
  // 对话线一轮就是回一句话、查几样东西、把事交出去
  talkMaxSteps: 20,
  dailyTokenLimit: 0,
  historyTokenThreshold: 24_000,
  talkHistoryTokenThreshold: 60_000,
  memoryMaxChars: 4000,
  toolResultMaxChars: 6000,
  // 例程不限调用次数（一口气搬一万多个东西的活要几千次调用），靠时长、连续失败和随时可停来管：默认两小时，最长十二小时
  routineMinutes: 120,
  routineMaxMinutes: 720,
}

/** 例程时长最多能设到多少分钟（七天）。 */
export const ROUTINE_MINUTES_LIMIT = 7 * 24 * 60

/** 对话窗口默认 5 分钟：实测 60 秒太短，隔一分钟多、话里没带名字的句子它就不理了。 */
export const DEFAULT_WAKE: WakeConfig = { mode: 'mention', conversationWindowSec: 300 }

/** 配置文件现在的版本号。 */
export const CONFIG_VERSION = 3

export function defaultConfig(): BrainConfig {
  return {
    version: CONFIG_VERSION,
    panel: { host: '127.0.0.1', port: 28765, password: '', sessionSecret: '' },
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
    activeModelId: '',
    talkProviderId: '',
    talkModelId: '',
    packdataDir: '',
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

/** 适配器的开关里，哪些是跟着服务商走的（其余的跟着模型）。 */
function providerOptionKeys(kind: ProviderKind): Set<string> {
  const adapter: Adapter = ADAPTERS[kind]
  return new Set(adapter.options.filter((o) => o.scope === 'provider').map((o) => o.key))
}

function pickOptions(raw: unknown, keep: (key: string) => boolean): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined
  const out = Object.fromEntries(Object.entries(raw).filter(([key]) => keep(key)))
  return Object.keys(out).length > 0 ? out : undefined
}

export function isValidModelId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,40}$/.test(id)
}

/** 给人看的模型名字。 */
export function modelDisplayName(model: Pick<ModelConfig, 'name' | 'label'>): string {
  return model.label.length > 0 ? model.label : model.name
}

/**
 * 把一份来自文件或面板的模型配置整理成合法形状。不合法时抛 Error（消息给人看）。
 * kind 是它所在服务商的接口类型：决定哪些开关算它的。
 */
export function sanitizeModel(raw: unknown, kind: ProviderKind): ModelConfig {
  if (!isRecord(raw)) throw new Error('模型配置必须是对象')
  const id = str(raw.id, '').trim()
  if (!isValidModelId(id)) throw new Error('模型的 id 不合法')
  const name = str(raw.name, '').trim()
  if (name.length === 0) throw new Error('模型名不能为空')
  if (name.length > 200) throw new Error('模型名太长')
  const label = str(raw.label, '').trim().slice(0, 60)
  const out: ModelConfig = { id, name, label: label === name ? '' : label }
  if (raw.maxOutputTokens !== undefined && raw.maxOutputTokens !== null && raw.maxOutputTokens !== '') {
    out.maxOutputTokens = int(raw.maxOutputTokens, 4096, 1, 1_000_000)
  }
  if (typeof raw.temperature === 'number' && Number.isFinite(raw.temperature)) {
    out.temperature = Math.min(2, Math.max(0, raw.temperature))
  }
  if (raw.timeoutMs !== undefined && raw.timeoutMs !== null && raw.timeoutMs !== '') {
    out.timeoutMs = int(raw.timeoutMs, 120_000, 1000, 3_600_000)
  }
  if (isRecord(raw.extraBody) && Object.keys(raw.extraBody).length > 0) out.extraBody = raw.extraBody
  const providerKeys = providerOptionKeys(kind)
  const options = pickOptions(raw.options, (key) => !providerKeys.has(key))
  if (options) out.options = options
  if (raw.vision === true) out.vision = true
  return out
}

/**
 * 把一份来自文件或面板的服务商配置整理成合法形状。不合法时抛 Error（消息给人看）。
 * 这里不处理“空 key 表示不修改”，那是面板接口的语义。
 *
 * 认两种写法：
 * - 现在的：models 是它下面的模型列表；
 * - 旧的（一个服务商只有一个模型）：model 是模型名，输出上限、温度、超时、额外请求参数和开关都直接挂在服务商上。
 *   这种会被转成“这个服务商下面的第一个模型”，跟着模型走的设置一起挪过去。
 * lenient：某个模型不合法时跳过它而不是整条作废（读配置文件时用，免得一处手误把整家服务商连同 key 丢掉）。
 */
export function sanitizeProvider(raw: unknown, opts: { lenient?: boolean } = {}): StoredProvider {
  if (!isRecord(raw)) throw new Error('服务商配置必须是对象')
  const id = str(raw.id, '').trim()
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new Error('服务商 id 不合法')
  if (!isProviderKind(raw.kind)) throw new Error(`不支持的接口类型：${String(raw.kind)}`)
  const kind = raw.kind
  const baseUrl = str(raw.baseUrl, '').trim()
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('服务地址不是合法的 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('服务地址必须以 http:// 或 https:// 开头')

  const models: ModelConfig[] = []
  const addModel = (rawModel: unknown): void => {
    try {
      const model = sanitizeModel(rawModel, kind)
      if (models.some((m) => m.id === model.id)) throw new Error(`有两个模型的 id 都是 ${model.id}`)
      models.push(model)
    } catch (e) {
      if (!opts.lenient) throw e
      console.error(`[config] 忽略服务商 ${id} 下面一个不合法的模型：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (Array.isArray(raw.models)) {
    for (const m of raw.models) addModel(m)
  } else if (raw.model !== undefined) {
    // 旧格式：整条就是一个模型
    addModel({ id: 'm1', name: raw.model, maxOutputTokens: raw.maxOutputTokens, temperature: raw.temperature, timeoutMs: raw.timeoutMs, extraBody: raw.extraBody, options: raw.options })
  }

  const out: StoredProvider = {
    id,
    label: str(raw.label, '').trim().slice(0, 60) || models[0]?.name || url.host,
    kind,
    baseUrl,
    apiKey: str(raw.apiKey, '').trim(),
    models,
  }
  const headers = stringMap(raw.extraHeaders)
  if (headers) out.extraHeaders = headers
  const providerKeys = providerOptionKeys(kind)
  const options = pickOptions(raw.options, (key) => providerKeys.has(key))
  if (options) out.options = options
  return out
}

/** 是不是旧格式的服务商配置（一个服务商只有一个模型）。 */
function isLegacyProvider(raw: unknown): boolean {
  return isRecord(raw) && !Array.isArray(raw.models) && raw.model !== undefined
}

/** 一个服务商加上它的一个模型 → 模型调用层要的那种“一家接口、一个模型”的配置。 */
export function resolveModel(provider: StoredProvider, model: ModelConfig): ProviderConfig {
  const out: ProviderConfig = { id: provider.id, label: provider.label, kind: provider.kind, baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: model.name }
  if (model.maxOutputTokens !== undefined) out.maxOutputTokens = model.maxOutputTokens
  if (model.temperature !== undefined) out.temperature = model.temperature
  if (model.timeoutMs !== undefined) out.timeoutMs = model.timeoutMs
  if (provider.extraHeaders) out.extraHeaders = provider.extraHeaders
  if (model.extraBody) out.extraBody = model.extraBody
  if (provider.options || model.options) out.options = { ...(provider.options ?? {}), ...(model.options ?? {}) }
  if (model.vision) out.vision = true
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

  const providers: StoredProvider[] = []
  if (Array.isArray(raw.providers)) {
    for (const p of raw.providers) {
      try {
        const clean = sanitizeProvider(p, { lenient: true })
        if (!providers.some((x) => x.id === clean.id)) providers.push(clean)
      } catch (e) {
        console.error(`[config] 忽略一条不合法的服务商配置：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  // 当前用的服务商不在了就用第一个；当前用的模型不在它下面了就用它的第一个模型（它下面没有模型就是空）。不会自己跳到别的服务商去。
  const activeProvider = providers.find((p) => p.id === str(raw.activeProviderId, '')) ?? providers[0]
  const activeModel = activeProvider?.models.find((m) => m.id === str(raw.activeModelId, '')) ?? activeProvider?.models[0]
  // 对话线的：没选过（旧配置）、或者选的那家不在了，就和干活线用同一个
  const talkPicked = providers.find((p) => p.id === str(raw.talkProviderId, ''))
  const talkProvider = talkPicked ?? activeProvider
  const talkModel = talkProvider?.models.find((m) => m.id === str(raw.talkModelId, '')) ?? (talkPicked ? talkPicked.models[0] : activeModel)
  const name = str(bot.name, d.bot.name).trim()

  return {
    version: CONFIG_VERSION,
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
        maxSteps: int(limits.maxSteps, DEFAULT_LIMITS.maxSteps, 1, MAX_STEPS_LIMIT),
        talkMaxSteps: int(limits.talkMaxSteps, DEFAULT_LIMITS.talkMaxSteps, 1, MAX_STEPS_LIMIT),
        dailyTokenLimit: int(limits.dailyTokenLimit, DEFAULT_LIMITS.dailyTokenLimit, 0, 1_000_000_000),
        historyTokenThreshold: int(limits.historyTokenThreshold, DEFAULT_LIMITS.historyTokenThreshold, 2000, 2_000_000),
        talkHistoryTokenThreshold: int(limits.talkHistoryTokenThreshold, DEFAULT_LIMITS.talkHistoryTokenThreshold, 2000, 2_000_000),
        memoryMaxChars: int(limits.memoryMaxChars, DEFAULT_LIMITS.memoryMaxChars, 200, 100_000),
        toolResultMaxChars: int(limits.toolResultMaxChars, DEFAULT_LIMITS.toolResultMaxChars, 500, 100_000),
        routineMinutes: int(limits.routineMinutes, DEFAULT_LIMITS.routineMinutes, 1, ROUTINE_MINUTES_LIMIT),
        // 最长不能比默认的还短
        routineMaxMinutes: Math.max(int(limits.routineMaxMinutes, DEFAULT_LIMITS.routineMaxMinutes, 1, ROUTINE_MINUTES_LIMIT), int(limits.routineMinutes, DEFAULT_LIMITS.routineMinutes, 1, ROUTINE_MINUTES_LIMIT)),
      },
      wantOnline: bot.wantOnline === true,
    },
    providers,
    activeProviderId: activeProvider?.id ?? '',
    activeModelId: activeModel?.id ?? '',
    talkProviderId: talkProvider?.id ?? '',
    talkModelId: talkModel?.id ?? '',
    packdataDir: str(raw.packdataDir, '').trim().slice(0, 1000),
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
  packdataDir?: string
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
  if (env.AIPLAYER_PACKDATA) out.packdataDir = env.AIPLAYER_PACKDATA
  return out
}

export class ConfigStore {
  readonly file: string
  /** 这次启动是不是刚生成了面板口令（用来决定要不要打印）。 */
  readonly passwordGenerated: boolean
  /**
   * 这次启动把旧配置升成了现在的格式时做了什么，要让主人知道的（main 记进活动日志）。
   * 目前只有一件：主人改过的旧人设被清空了（它是分成两条线之前的整段核心提示词，不能当“说话风格”用），原文在哪份备份里。
   */
  readonly upgradeNotes: string[] = []
  private config: BrainConfig
  private readonly overrides: ConfigOverrides
  private readonly listeners = new Set<(config: BrainConfig) => void>()

  constructor(dataDir: string, overrides: ConfigOverrides = {}) {
    this.file = path.join(dataDir, 'config.json')
    this.overrides = overrides
    const raw = readJson(this.file)
    this.config = normalizeConfig(raw)
    let dirty = raw === undefined
    // 旧格式：转成新的写回去。原文件先留一份底，万一要退回旧版本的大脑还用得上。
    // 1（一个服务商只有一个模型）留成 .v1.bak；2（只有一条线、只选一个模型）留成 .v2.bak。
    if (isRecord(raw) && raw.version !== CONFIG_VERSION) {
      dirty = true
      const legacy = Array.isArray(raw.providers) && raw.providers.some(isLegacyProvider)
      const backup = `${this.file}.${legacy ? 'v1' : 'v2'}.bak`
      let kept = false
      try {
        fs.copyFileSync(this.file, backup)
        fs.chmodSync(backup, FILE_MODE)
        kept = true
        console.log(
          legacy
            ? `[config] 配置里的服务商是旧格式（一个服务商一个模型），已转成新格式；原文件留在 ${backup}`
            : `[config] 配置是只有一条线时的格式，已补上对话线的模型和上限（和原来选的一样）；原文件留在 ${backup}`,
        )
      } catch (e) {
        console.error(`[config] 没能给旧配置留底：${e instanceof Error ? e.message : String(e)}`)
      }
      // 主人改过的旧人设是整段核心提示词（里面写着“用 say 说话”“干活靠任务”）：现在这个字段只是对话线的说话风格，
      // 照旧用会让对话线读到一堆不再成立的话。清空、改用默认风格；原文在备份里（没留成底就不动它）。
      const oldPersona = isRecord(raw.bot) && typeof raw.bot.systemPrompt === 'string' ? raw.bot.systemPrompt.trim() : ''
      if (oldPersona.length > 0 && kept) {
        this.config.bot.systemPrompt = ''
        this.upgradeNotes.push(
          `配置升级：原来面板上改过的人设提示词是分成对话线、干活线之前的整段核心提示词，不能当对话线的“说话风格”用，已经清空、改用默认风格。原文（${oldPersona.length} 字）留在 ${backup} 的 bot.systemPrompt 里，要用的部分可以在面板上重新填进说话风格。`,
        )
      }
    }
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

  /** 这条线现在用的是哪个服务商的哪个模型；还没配、或者选的服务商下面没有模型时是 undefined。 */
  lineSelection(line: 'talk' | 'work'): { provider: StoredProvider; model: ModelConfig } | undefined {
    const [providerId, modelId] = line === 'talk' ? [this.config.talkProviderId, this.config.talkModelId] : [this.config.activeProviderId, this.config.activeModelId]
    const provider = this.config.providers.find((p) => p.id === providerId)
    const model = provider?.models.find((m) => m.id === modelId)
    return provider && model ? { provider, model } : undefined
  }

  /** 这条线用的那个模型的调用配置（服务商的地址、key 加上这个模型自己的设置）。 */
  lineProvider(line: 'talk' | 'work'): ProviderConfig | undefined {
    const active = this.lineSelection(line)
    return active ? resolveModel(active.provider, active.model) : undefined
  }

  /** 干活线用的是哪个服务商的哪个模型（只有一条线时“当前用的”就是它）。 */
  activeSelection(): { provider: StoredProvider; model: ModelConfig } | undefined {
    return this.lineSelection('work')
  }

  /** 干活线用的那个模型的调用配置。 */
  activeProvider(): ProviderConfig | undefined {
    return this.lineProvider('work')
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

  /** 本地资料的目录（环境变量优先；都没配就是默认的）。相对路径由调用方按 brain/ 目录解析。 */
  packdataDir(): string {
    return this.overrides.packdataDir ?? (this.config.packdataDir || DEFAULT_PACKDATA_DIR)
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
