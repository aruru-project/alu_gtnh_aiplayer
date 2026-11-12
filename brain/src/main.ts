// 组装并启动大脑服务。
//   node src/main.ts
// 环境变量：AIPLAYER_DATA_DIR、AIPLAYER_PANEL_HOST、AIPLAYER_PANEL_PORT、
//          AIPLAYER_BRIDGE_HOST、AIPLAYER_BRIDGE_PORT、AIPLAYER_BRIDGE_TOKEN、AIPLAYER_BRIDGE_TOKEN_FILE、AIPLAYER_PACKDATA

import fs from 'node:fs'
import path from 'node:path'
import type { AgentSettings, PersistedAgentState } from './agent/agent.ts'
import type { AgentEvent } from './agent/events.ts'
import { Lines } from './agent/lines.ts'
import { Presence } from './agent/presence.ts'
import type { LinkState } from './agent/lines.ts'
import { ReminderScheduler, reminderEvent } from './agent/reminders.ts'
import { BridgeApi } from './bridge/api.ts'
import { BridgeClient } from './bridge/client.ts'
import { readBridgeToken } from './bridge/token.ts'
import type { ResumeState } from './bridge/client.ts'
import { DesignWorkspace } from './design/index.ts'
import { createClient, listRemoteModels, testConnection } from './llm/index.ts'
import type { LlmClient } from './llm/index.ts'
import { loadItemIcons } from './packdata/icons.ts'
import { loadPackData } from './packdata/index.ts'
import { useLocalNames } from './tools/format.ts'
import { PanelServer } from './panel/server.ts'
import { ActivityLog } from './store/activity-log.ts'
import { ChatLog } from './store/chat-log.ts'
import { RunLogStore } from './agent/run-log.ts'
import { ConfigStore, modelDisplayName, overridesFromEnv } from './store/config.ts'
import { FeedbackStore } from './store/feedback.ts'
import { MethodStore } from './store/methods.ts'
import { TodoStore } from './store/todo.ts'
import { PictureStore } from './store/pictures.ts'
import type { BrainConfig } from './store/config.ts'
import { ensureDir } from './store/files.ts'
import { HistoryStore, TurnIds } from './store/history.ts'
import { JsonFile } from './store/json-file.ts'
import { ManualStore } from './store/manuals.ts'
import { MemoryStore } from './store/memory.ts'
import { ReminderStore } from './store/reminders.ts'
import { UsageStore } from './store/usage.ts'
import type { LineName } from './tools/index.ts'
import { errorText, isRecord, stringsOf } from './util.ts'

const VERSION = '0.1.0'
/** 隔多久看一次该不该自动下线。 */
const PRESENCE_TICK_MS = 1000
const BRAIN_ROOT = path.resolve(import.meta.dirname, '..')

function info(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`)
}

/** 一条线的设置：名字、主人这些两条线一样；每轮步数上限和历史压缩阈值各是各的。 */
function toAgentSettings(c: BrainConfig, line: LineName): AgentSettings {
  return {
    botName: c.bot.name,
    aliases: c.bot.aliases,
    owners: c.bot.owners,
    persona: c.bot.systemPrompt,
    environment: c.bot.environment,
    lineSteps: { talk: c.bot.limits.talkMaxSteps, work: c.bot.limits.maxSteps },
    wakeMode: c.bot.wake.mode,
    conversationWindowSec: c.bot.wake.conversationWindowSec,
    maxSteps: line === 'talk' ? c.bot.limits.talkMaxSteps : c.bot.limits.maxSteps,
    dailyTokenLimit: c.bot.limits.dailyTokenLimit,
    historyTokenThreshold: line === 'talk' ? c.bot.limits.talkHistoryTokenThreshold : c.bot.limits.historyTokenThreshold,
    backgroundCompaction: c.bot.limits.backgroundCompaction,
    toolResultMaxChars: c.bot.limits.toolResultMaxChars,
    routineMinutes: c.bot.limits.routineMinutes,
    routineMaxMinutes: c.bot.limits.routineMaxMinutes,
  }
}

function parseResume(raw: unknown): ResumeState | undefined {
  if (isRecord(raw) && typeof raw.serverEpoch === 'string' && typeof raw.lastSeq === 'number') {
    return { serverEpoch: raw.serverEpoch, lastSeq: raw.lastSeq }
  }
  return undefined
}

function parseAgentState(raw: unknown): PersistedAgentState {
  if (!isRecord(raw)) return { tracked: [], endedSeen: [], queue: [] }
  const queue = Array.isArray(raw.queue)
    ? raw.queue.filter((e): e is AgentEvent => isRecord(e) && typeof e.type === 'string' && typeof e.time === 'number')
    : []
  return {
    tracked: stringsOf(raw.tracked),
    endedSeen: stringsOf(raw.endedSeen),
    queue,
    // 对话线：从什么时候起写的字不再说进游戏，这件事告诉过它没有
    ...(typeof raw.textNotSaidSince === 'number' ? { textNotSaidSince: raw.textNotSaidSince } : {}),
    ...(typeof raw.textNotSaidTold === 'boolean' ? { textNotSaidTold: raw.textNotSaidTold } : {}),
  }
}

function parseLinkState(raw: unknown): LinkState {
  if (!isRecord(raw)) return {}
  const out: LinkState = {}
  if (isRecord(raw.waiting) && typeof raw.waiting.text === 'string' && typeof raw.waiting.since === 'number') out.waiting = { text: raw.waiting.text, since: raw.waiting.since }
  const r = raw.lastReport
  if (isRecord(r) && typeof r.text === 'string' && typeof r.time === 'number' && (r.type === 'report' || r.type === 'question' || r.type === 'result' || r.type === 'progress' || r.type === 'trouble')) {
    out.lastReport = { type: r.type, text: r.text, time: r.time }
  }
  if (typeof raw.haltedAt === 'number') out.haltedAt = raw.haltedAt
  return out
}

async function main(): Promise<void> {
  // 相对路径相对 brain/ 目录（和口令文件路径的规矩一样），不看当前目录在哪
  const dataDir = path.resolve(BRAIN_ROOT, process.env.AIPLAYER_DATA_DIR ?? 'data')
  ensureDir(dataDir)

  // ── store ──
  const config = new ConfigStore(dataDir, overridesFromEnv(process.env))
  const log = new ActivityLog(dataDir)
  // 它写的程序（例程、run_program）每次运行的全量记录：logs/runs/
  const runLogs = new RunLogStore(dataDir)
  const memory = new MemoryStore(dataDir, () => config.get().bot.limits.memoryMaxChars)
  // 手册：默认的随代码发布（brain/manuals），主人写的和改过的在数据目录里；同名时主人的盖住默认的
  const manuals = new ManualStore(path.join(BRAIN_ROOT, 'manuals'), path.join(dataDir, 'manuals'))
  // 两条线各有一份历史和状态（docs/TALK_WORK.md）。干活线沿用原来的文件名（history.json、agent-state.json）：
  // 只有一条线时留下的历史里大多是干活的记录，原样归它，不用搬；对话线从空的开始（talk-history.json、talk-state.json）。
  // 轮的编号两条线共用一个计数器，日志里不重号。
  const talkStateFile = path.join(dataDir, 'talk-state.json')
  // 头一回带着老数据启动：有干活的历史，却还没有对话线的任何文件
  const migrated = fs.existsSync(path.join(dataDir, 'history.json')) && !fs.existsSync(talkStateFile) && !fs.existsSync(path.join(dataDir, 'talk-history.json'))
  const turnIds = new TurnIds()
  const history = new HistoryStore(dataDir, { ids: turnIds })
  const talkHistory = new HistoryStore(dataDir, { file: 'talk-history.json', ids: turnIds })
  const chatLog = new ChatLog(dataDir)
  const usage = new UsageStore(dataDir)
  const reminderStore = new ReminderStore(dataDir)
  // 基地的做法：主人教的、它自己定过的，怎么做东西的记录
  const methods = new MethodStore(dataDir)
  // 工作清单：一串交代下来的事还剩哪些没做（两条线和主人共用一份）
  const todo = new TodoStore(dataDir)
  // 意见簿：存之前把这台大脑上真正的密钥从附带的现场里抹掉（正常不会出现在里面，这是兜底）
  const feedback = new FeedbackStore(dataDir, {
    secrets: () => {
      const c = config.get()
      const bridgeSettings = config.bridgeSettings()
      let bridgeToken = bridgeSettings.token
      try {
        bridgeToken ||= readBridgeToken(bridgeSettings, BRAIN_ROOT) ?? ''
      } catch {
        /* 口令文件读不到：那就没有可抹的 */
      }
      return [c.panel.password, c.panel.sessionSecret, bridgeToken, ...c.providers.flatMap((p) => [p.apiKey, ...Object.values(p.extraHeaders ?? {})])]
    },
  })
  const resumeFile = new JsonFile<ResumeState | undefined>(path.join(dataDir, 'bridge-state.json'), parseResume, { throttleMs: 250 })
  const agentStateFile = new JsonFile<PersistedAgentState>(path.join(dataDir, 'agent-state.json'), parseAgentState)
  const talkState = new JsonFile<PersistedAgentState>(talkStateFile, parseAgentState)
  const linkStateFile = new JsonFile<LinkState>(path.join(dataDir, 'lines-state.json'), parseLinkState)
  // 对话线的状态文件头一次启动就写下：以后凭它知道“已经是两条线了”，不会把后来才出现的 history.json 当成老数据
  if (!fs.existsSync(talkStateFile)) talkState.set(talkState.get())
  if (migrated) {
    log.add({ kind: 'info', text: '大脑升级：从这次启动起分成对话线和干活线。原来的对话历史和没处理完的事归干活线（里面排着的“有人说话”归对话线），对话线从空历史开始；记忆和手册两条线共用，照常在。' })
  }
  for (const note of config.upgradeNotes) log.add({ kind: 'info', text: note })

  // ── 本地资料（任务书、物品表）：启动时读一次；没有的部分，相关工具改问服务器 ──
  const packdata = loadPackData(path.resolve(BRAIN_ROOT, config.packdataDir()), (message) => info(`[packdata] ${message}`))
  // 物品图标的图集（面板的物品栏用）：启动时核对一次它和物品表是不是同一次导出的，对不上就当没有
  const itemIcons = loadItemIcons(packdata.dir, (message) => info(`[packdata] ${message}`))
  // ── 自己出设计：跑程序的沙箱、图纸草稿（drafts/）、主人传的图片（images/）──
  // 服务器回来的东西（背包、箱子、任务结果、事件）给模型看时，名字都用本地物品表里的中文名
  // 物品和流体都用游戏里的中文名（身体给的是英文）
  useLocalNames(packdata.items, packdata.fluids)
  const design = new DesignWorkspace({ dataDir, packdata })
  const pictures = new PictureStore(dataDir)

  // ── bridge ──
  const bridgeClient = new BridgeClient({
    address: () => {
      const b = config.bridgeSettings()
      return { host: b.host, port: b.port }
    },
    token: () => readBridgeToken(config.bridgeSettings(), BRAIN_ROOT),
    clientName: `brain/${VERSION}`,
    requestTimeoutMs: config.bridgeSettings().requestTimeoutMs,
    resume: {
      load: () => resumeFile.get(),
      save: (state) => {
        // 续传位置落盘必须是 lastSeq 之后的事件都已经交给 agent；这里是同步分发，所以成立
        if (state !== undefined) resumeFile.set(state)
      },
    },
    log: (message) => info(`[bridge] ${message}`),
  })
  const bridge = new BridgeApi(bridgeClient)

  // ── 模型：两条线各用各的。哪条线选的服务商或模型变了就重建它的客户端，agent 那边不用知道 ──
  const llms: Record<LineName, { client: LlmClient | undefined; fingerprint: string }> = { talk: { client: undefined, fingerprint: '' }, work: { client: undefined, fingerprint: '' } }
  const refreshLlm = (line: LineName): boolean => {
    const provider = config.lineProvider(line)
    const fingerprint = JSON.stringify(provider ?? null)
    if (fingerprint === llms[line].fingerprint) return false
    llms[line].fingerprint = fingerprint
    try {
      // 用量记在同一本账上：每日 token 上限是两条线合计的
      llms[line].client = provider ? createClient(provider, { onUsage: (record) => usage.add(record.usage) }) : undefined
    } catch (e) {
      llms[line].client = undefined
      info(`[llm] ${line === 'talk' ? '对话线' : '干活线'}选的服务商配置用不了：${errorText(e)}`)
    }
    return true
  }
  refreshLlm('talk')
  refreshLlm('work')
  const lineModel = (line: LineName) => ({
    llm: () => llms[line].client,
    name: () => {
      const active = config.lineSelection(line)
      return active ? `${active.provider.label} / ${modelDisplayName(active.model)}` : undefined
    },
    canSee: () => config.lineSelection(line)?.model.vision === true,
  })

  // ── agent：对话线和干活线 ──
  let agent: Lines
  let presence: Presence | undefined
  const reminders = new ReminderScheduler(reminderStore, (r) => {
    // 它是自动下线的话先让它上来，提醒照常叫醒
    void (presence?.comeBack('它定的提醒到点了') ?? Promise.resolve()).finally(() => agent.handleEvent(reminderEvent(r, Date.now())))
  })
  agent = new Lines({
    settings: (line) => toAgentSettings(config.get(), line),
    models: { talk: lineModel('talk'), work: lineModel('work') },
    pictures,
    bridge,
    memory,
    manuals,
    packdata,
    design,
    feedback,
    methods,
    todo,
    versions: () => {
      const mod = bridgeClient.status().hello?.modVersion
      return { brain: VERSION, ...(mod !== undefined ? { mod } : {}) }
    },
    reminders,
    histories: { talk: talkHistory, work: history },
    log,
    chatLog,
    todayTokens: () => usage.todayTokens(),
    persist: {
      talk: { load: () => talkState.get(), save: (state) => talkState.set(state) },
      work: { load: () => agentStateFile.get(), save: (state) => agentStateFile.set(state) },
      links: { load: () => linkStateFile.get(), save: (state) => linkStateFile.set(state) },
    },
    runLogs,
    migrated,
  })

  // 自动上下线（默认关）：没有真人、没有事，过一阵自己下线；有真人进服、面板上发指令、提醒到点再上来
  presence = new Presence({
    settings: () => {
      const { bot } = config.get()
      return { botName: bot.name, wantOnline: bot.wantOnline, enabled: bot.presence.idleOffline, idleMinutes: bot.presence.idleMinutes, away: bot.awayIdle }
    },
    setAway: (away) => {
      if (config.get().bot.awayIdle !== away) config.update((c) => void (c.bot.awayIdle = away))
    },
    bridge,
    connected: () => bridgeClient.status().state === 'connected',
    online: () => agent.status().botOnline,
    busy: () => agent.busy(),
    log: (entry) => log.add(entry),
  })
  const presenceTimer = setInterval(() => void presence?.tick(), PRESENCE_TICK_MS)
  presenceTimer.unref()

  /** 面板上按过“上线”的 bot，连上游戏后要确保它在。它是自动下线的就不叫：等真人进服、指令或提醒。 */
  const ensureBotOnline = async (): Promise<void> => {
    const { name } = config.get().bot
    if (!config.get().bot.wantOnline || config.get().bot.awayIdle) return
    try {
      const list = await bridge.botList()
      const online = (list.bots ?? []).some((b) => b.name.toLowerCase() === name.toLowerCase() && b.online)
      if (online) return
      // 握手后补发的事件里可能有“它被踢了”，那会把选择改成下线：以查完之后的为准
      if (!config.get().bot.wantOnline) return
      await bridge.botSpawn({ name })
      log.add({ kind: 'info', text: `连上游戏后发现 ${name} 不在线，已经让它上线。` })
    } catch (e) {
      log.add({ kind: 'error', text: `想让 ${name} 上线但没成功：${errorText(e)}` })
    }
  }

  // bot 下线的三种情况：面板上点了“下线”（那时已经把选择记成下线）、服务器在关（重启后它会自己回来，选择不变）、
  // 被踢或被别的客户端弄下线。最后一种要把选择改成“下线”：否则大脑下次重连时会把它再叫出来，和踢它的人对着干。
  let serverStopping = false
  bridgeClient.onEvent((event) => {
    if (event.event === 'server.stopping') serverStopping = true
    if (event.event === 'bot.despawned') {
      const { name, wantOnline, awayIdle } = config.get().bot
      const mine = typeof event.data.bot === 'string' && event.data.bot.toLowerCase() === name.toLowerCase()
      const reason = typeof event.data.reason === 'string' ? event.data.reason : ''
      // 它自己自动下线的不算“被弄下线”
      if (mine && wantOnline && !awayIdle && !serverStopping && reason !== 'server stopping') {
        config.update((c) => {
          c.bot.wantOnline = false
        })
        log.add({ kind: 'error', text: `${name} 被弄下线了（${reason || '原因不明'}）。它会一直保持下线，直到有人在面板上点“上线”。` })
      }
    }
    presence?.onEvent(event)
    agent.handleBridgeEvent(event)
  })
  bridgeClient.onReady((ready) => {
    serverStopping = false
    log.add({ kind: 'info', text: `已连上游戏服务器（mod ${ready.hello.modVersion ?? '?'}）。` })
    void ensureBotOnline()
      .then(() => agent.onBridgeReady(ready))
      .then(() => presence?.onReady())
  })
  let wasConnected = false
  bridgeClient.onStatus((status) => {
    if (status.state === 'connected') {
      wasConnected = true
      return
    }
    agent.onBridgeDisconnected()
    presence?.onDisconnected()
    if (wasConnected) {
      wasConnected = false
      log.add({ kind: 'error', text: `和游戏服务器的连接断了${status.lastError ? `（${status.lastError}）` : ''}，正在重连。` })
    }
  })
  let bridgeFingerprint = JSON.stringify(config.bridgeSettings())
  config.onChange(() => {
    const talkChanged = refreshLlm('talk')
    if (refreshLlm('work') || talkChanged) agent.notifyConfigChanged()
    // 面板上改了 bridge 的端口或口令：断开，按新的参数重连
    const next = JSON.stringify(config.bridgeSettings())
    if (next !== bridgeFingerprint) {
      bridgeFingerprint = next
      log.add({ kind: 'info', text: 'bridge 的连接设置改了，正在按新的设置重连。' })
      bridgeClient.restart()
    }
  })

  // ── 面板 ──
  const panel = new PanelServer({
    comeBack: (reason) => presence?.comeBack(reason) ?? Promise.resolve(),
    config,
    memory,
    usage,
    log,
    history,
    talkHistory,
    manuals,
    design,
    feedback,
    pictures,
    ...(packdata.textures ? { textures: packdata.textures } : {}),
    ...(packdata.structures ? { structures: packdata.structures } : {}),
    ...(packdata.guide ? { guide: packdata.guide } : {}),
    ...(packdata.tooltips ? { tooltips: packdata.tooltips } : {}),
    methods,
    methodsEnv: () => ({ book: packdata.recipes, items: packdata.items, fluids: packdata.fluids }),
    todo,
    icons: itemIcons ?? false,
    bridge,
    bridgeStatus: () => bridgeClient.status(),
    agent,
    reminders,
    runs: runLogs,
    // 测试连接也花 token，一样记账
    testConnection: (provider) => testConnection(provider, { onUsage: (record) => usage.add(record.usage) }),
    listModels: (provider) => listRemoteModels(provider),
  })
  const want = config.panelAddress()
  const bound = await panel.listen(want.host, want.port)
  const shownHost = bound.host.includes(':') ? `[${bound.host}]` : bound.host
  info(`[panel] 面板地址：http://${shownHost}:${bound.port}/`)
  if (config.passwordGenerated) {
    info(`[panel] 首次启动，已生成面板访问口令：${config.get().panel.password}`)
    info(`[panel] 口令保存在 ${config.file}（panel.password），可以直接改这个文件换口令`)
  } else {
    info(`[panel] 访问口令在 ${config.file} 的 panel.password`)
  }
  info(`[store] 数据目录：${dataDir}`)
  if (!config.lineProvider('work') || !config.lineProvider('talk')) info('[llm] 还没有配置模型服务，请到面板“设置”里的“模型”页添加')
  const b = config.bridgeSettings()
  if (b.token.length === 0 && b.tokenFile.length === 0) {
    info('[bridge] 还没配置 bridge 口令文件，暂时不连游戏。在面板的“设置”页填，或用环境变量 AIPLAYER_BRIDGE_TOKEN_FILE 指定')
  }

  bridgeClient.start()
  reminders.start()
  agent.start()

  // ── 退出 ──
  let stopping = false
  const shutdown = (signal: string): void => {
    if (stopping) return
    stopping = true
    info(`收到 ${signal}，正在退出`)
    const force = setTimeout(() => process.exit(1), 8000)
    force.unref()
    void (async () => {
      reminders.stop()
      await agent.stop()
      bridgeClient.stop()
      await panel.close()
      resumeFile.flush()
      chatLog.flush()
      process.exit(0)
    })()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandled rejection:', reason)
  })
}

main().catch((e) => {
  console.error('[main] 启动失败：', e instanceof Error ? (e.stack ?? e.message) : e)
  process.exit(1)
})
