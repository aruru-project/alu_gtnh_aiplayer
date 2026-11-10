// 组装并启动大脑服务。
//   node src/main.ts
// 环境变量：AIPLAYER_DATA_DIR、AIPLAYER_PANEL_HOST、AIPLAYER_PANEL_PORT、
//          AIPLAYER_BRIDGE_HOST、AIPLAYER_BRIDGE_PORT、AIPLAYER_BRIDGE_TOKEN、AIPLAYER_BRIDGE_TOKEN_FILE

import path from 'node:path'
import { Agent } from './agent/agent.ts'
import type { AgentSettings, PersistedAgentState } from './agent/agent.ts'
import type { AgentEvent } from './agent/events.ts'
import { ReminderScheduler } from './agent/reminders.ts'
import { BridgeApi } from './bridge/api.ts'
import { BridgeClient } from './bridge/client.ts'
import { readBridgeToken } from './bridge/token.ts'
import type { ResumeState } from './bridge/client.ts'
import { createClient, testConnection } from './llm/index.ts'
import type { LlmClient } from './llm/index.ts'
import { PanelServer } from './panel/server.ts'
import { ActivityLog } from './store/activity-log.ts'
import { ConfigStore, overridesFromEnv } from './store/config.ts'
import type { BrainConfig } from './store/config.ts'
import { ensureDir, isRecord } from './store/files.ts'
import { HistoryStore } from './store/history.ts'
import { JsonFile } from './store/json-file.ts'
import { ManualStore } from './store/manuals.ts'
import { MemoryStore } from './store/memory.ts'
import { ReminderStore } from './store/reminders.ts'
import { UsageStore } from './store/usage.ts'
import { ALL_TOOLS } from './tools/index.ts'

const VERSION = '0.1.0'
const BRAIN_ROOT = path.resolve(import.meta.dirname, '..')

function info(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`)
}

function toAgentSettings(c: BrainConfig): AgentSettings {
  return {
    botName: c.bot.name,
    aliases: c.bot.aliases,
    owners: c.bot.owners,
    persona: c.bot.systemPrompt,
    wakeMode: c.bot.wake.mode,
    conversationWindowSec: c.bot.wake.conversationWindowSec,
    maxSteps: c.bot.limits.maxSteps,
    dailyTokenLimit: c.bot.limits.dailyTokenLimit,
    historyTokenThreshold: c.bot.limits.historyTokenThreshold,
    toolResultMaxChars: c.bot.limits.toolResultMaxChars,
  }
}

function parseResume(raw: unknown): ResumeState | undefined {
  if (isRecord(raw) && typeof raw.serverEpoch === 'string' && typeof raw.lastSeq === 'number') {
    return { serverEpoch: raw.serverEpoch, lastSeq: raw.lastSeq }
  }
  return undefined
}

function parseAgentState(raw: unknown): PersistedAgentState {
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  if (!isRecord(raw)) return { tracked: [], endedSeen: [], queue: [] }
  const queue = Array.isArray(raw.queue)
    ? raw.queue.filter((e): e is AgentEvent => isRecord(e) && typeof e.type === 'string' && typeof e.time === 'number')
    : []
  return { tracked: strings(raw.tracked), endedSeen: strings(raw.endedSeen), queue }
}

async function main(): Promise<void> {
  // 相对路径相对 brain/ 目录（和口令文件路径的规矩一样），不看当前目录在哪
  const dataDir = path.resolve(BRAIN_ROOT, process.env.AIPLAYER_DATA_DIR ?? 'data')
  ensureDir(dataDir)

  // ── store ──
  const config = new ConfigStore(dataDir, overridesFromEnv(process.env))
  const log = new ActivityLog(dataDir)
  const memory = new MemoryStore(dataDir, () => config.get().bot.limits.memoryMaxChars)
  // 手册：默认的随代码发布（brain/manuals），主人写的和改过的在数据目录里；同名时主人的盖住默认的
  const manuals = new ManualStore(path.join(BRAIN_ROOT, 'manuals'), path.join(dataDir, 'manuals'))
  const history = new HistoryStore(dataDir)
  const usage = new UsageStore(dataDir)
  const reminderStore = new ReminderStore(dataDir)
  const resumeFile = new JsonFile<ResumeState | undefined>(path.join(dataDir, 'bridge-state.json'), parseResume, { throttleMs: 250 })
  const agentStateFile = new JsonFile<PersistedAgentState>(path.join(dataDir, 'agent-state.json'), parseAgentState)

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

  // ── 模型：当前服务商的配置变了就重建客户端，agent 那边不用知道 ──
  let llm: LlmClient | undefined
  let llmFingerprint = ''
  const refreshLlm = (): boolean => {
    const provider = config.activeProvider()
    const fingerprint = JSON.stringify(provider ?? null)
    if (fingerprint === llmFingerprint) return false
    llmFingerprint = fingerprint
    try {
      llm = provider ? createClient(provider, { onUsage: (record) => usage.add(record.usage) }) : undefined
    } catch (e) {
      llm = undefined
      info(`[llm] 当前服务商的配置用不了：${e instanceof Error ? e.message : String(e)}`)
    }
    return true
  }
  refreshLlm()

  // ── agent ──
  let agent: Agent
  const reminders = new ReminderScheduler(reminderStore, (r) => {
    agent.handleEvent({ type: 'reminder', time: Date.now(), note: r.note })
  })
  agent = new Agent({
    settings: () => toAgentSettings(config.get()),
    llm: () => llm,
    bridge,
    tools: ALL_TOOLS,
    memory,
    manuals,
    reminders,
    history,
    log,
    todayTokens: () => usage.todayTokens(),
    persist: { load: () => agentStateFile.get(), save: (state) => agentStateFile.set(state) },
  })

  /** 面板上按过“上线”的 bot，连上游戏后要确保它在。 */
  const ensureBotOnline = async (): Promise<void> => {
    const { name } = config.get().bot
    if (!config.get().bot.wantOnline) return
    try {
      const list = await bridge.botList()
      const online = (list.bots ?? []).some((b) => b.name.toLowerCase() === name.toLowerCase() && b.online)
      if (online) return
      // 握手后补发的事件里可能有“它被踢了”，那会把选择改成下线：以查完之后的为准
      if (!config.get().bot.wantOnline) return
      await bridge.botSpawn({ name })
      log.add({ kind: 'info', text: `连上游戏后发现 ${name} 不在线，已经让它上线。` })
    } catch (e) {
      log.add({ kind: 'error', text: `想让 ${name} 上线但没成功：${e instanceof Error ? e.message : String(e)}` })
    }
  }

  // bot 下线的三种情况：面板上点了“下线”（那时已经把选择记成下线）、服务器在关（重启后它会自己回来，选择不变）、
  // 被踢或被别的客户端弄下线。最后一种要把选择改成“下线”：否则大脑下次重连时会把它再叫出来，和踢它的人对着干。
  let serverStopping = false
  bridgeClient.onEvent((event) => {
    if (event.event === 'server.stopping') serverStopping = true
    if (event.event === 'bot.despawned') {
      const { name, wantOnline } = config.get().bot
      const mine = typeof event.data.bot === 'string' && event.data.bot.toLowerCase() === name.toLowerCase()
      const reason = typeof event.data.reason === 'string' ? event.data.reason : ''
      if (mine && wantOnline && !serverStopping && reason !== 'server stopping') {
        config.update((c) => {
          c.bot.wantOnline = false
        })
        log.add({ kind: 'error', text: `${name} 被弄下线了（${reason || '原因不明'}）。它会一直保持下线，直到有人在面板上点“上线”。` })
      }
    }
    agent.handleBridgeEvent(event)
  })
  bridgeClient.onReady((ready) => {
    serverStopping = false
    log.add({ kind: 'info', text: `已连上游戏服务器（mod ${ready.hello.modVersion ?? '?'}）。` })
    void ensureBotOnline().then(() => agent.onBridgeReady(ready))
  })
  let wasConnected = false
  bridgeClient.onStatus((status) => {
    if (status.state === 'connected') {
      wasConnected = true
      return
    }
    agent.onBridgeDisconnected()
    if (wasConnected) {
      wasConnected = false
      log.add({ kind: 'error', text: `和游戏服务器的连接断了${status.lastError ? `（${status.lastError}）` : ''}，正在重连。` })
    }
  })
  let bridgeFingerprint = JSON.stringify(config.bridgeSettings())
  config.onChange(() => {
    if (refreshLlm()) agent.notifyConfigChanged()
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
    config,
    memory,
    usage,
    log,
    history,
    manuals,
    bridge,
    bridgeStatus: () => bridgeClient.status(),
    agent,
    reminders,
    // 测试连接也花 token，一样记账
    testConnection: (provider) => testConnection(provider, { onUsage: (record) => usage.add(record.usage) }),
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
  if (!config.activeProvider()) info('[llm] 还没有配置模型服务，请到面板的“模型”页添加')
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
