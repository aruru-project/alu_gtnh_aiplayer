// 面板要的“数据那一半”：日志翻页、程序运行的明细、状态（两条线各一项：模型、这一轮；例程和身体挂在干活线下面）、图纸里有什么。
// 界面在 panel/public/（另一个 Work 在做）；这里只出数据，形状写在 docs/BRAIN_SPEC.md 的“面板的数据接口”。
// 和 server.ts 分开放，是为了两边并行改的时候少撞：server.ts 里只有几行路由指到这里。

import type { AgentState, AgentStatus, CompactNowResult } from '../agent/agent.ts'
import type { LinkState } from '../agent/lines.ts'
import type { RoutineView } from '../agent/routine.ts'
import type { RunLogStore } from '../agent/run-log.ts'
import type { BridgeApi } from '../bridge/api.ts'
import type { TaskInfo } from '../bridge/protocol.ts'
import type { DesignWorkspace } from '../design/index.ts'
import { blueprintData } from '../tools/blueprint.ts'
import { dataWithLocalNames } from '../tools/format.ts'
import type { ActivityLog, ActivityRun } from '../store/activity-log.ts'
import type { LineName } from '../tools/index.ts'

/** 出错时怎么回（server.ts 给的是抛它自己的 HttpError）。 */
export type Reject = (status: number, code: string, message: string) => never

export const LOG_PAGE_DEFAULT = 300
export const LOG_PAGE_MAX = 500
export const RUN_RECORDS_DEFAULT = 200
export const RUN_RECORDS_MAX = 1000
export const RUNS_LIST_MAX = 300

function whole(text: string | null, fallback: number, min: number, max: number): number {
  const n = Number(text ?? '')
  return text !== null && text !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback
}

/**
 * GET /api/log
 * - ?after=<id>&limit=：id 大于 after 的里面最新的 limit 条，按时间顺序；more 是 after 和这一页第一条之间还有没给的。
 * - ?before=<id>&limit=：紧挨在 id 之前的 limit 条，按时间顺序（内存里不够就读按天存的文件）；more 是更早的还有没有。
 * 不带参数就是最新的 300 条。id 跨重启单调递增，可以当游标。
 */
export function logPage(log: ActivityLog, params: URLSearchParams): { entries: unknown[]; more: boolean } {
  const limit = whole(params.get('limit'), LOG_PAGE_DEFAULT, 1, LOG_PAGE_MAX)
  const before = params.get('before')
  if (before !== null && before !== '') return log.before(whole(before, 0, 0, Number.MAX_SAFE_INTEGER), limit)
  const after = whole(params.get('after'), 0, 0, Number.MAX_SAFE_INTEGER)
  const entries = log.recent(after, limit)
  return { entries, more: log.countAfter(after) > entries.length }
}

/** GET /api/runs?limit=：最近的程序运行（例程、run_program 的程序），新的在前。 */
export function runList(runs: RunLogStore | undefined, params: URLSearchParams): { runs: ActivityRun[] } {
  return { runs: runs ? runs.list(whole(params.get('limit'), 50, 1, RUNS_LIST_MAX)) : [] }
}

/**
 * GET /api/runs/records?file=<run.file>&after=<行号>&limit=：一次运行的明细，一行一条（start / call / log / end）。
 * 也可以给 id=r3（取这个编号最近的一次：编号每次大脑重启从 1 重新数，file 才是唯一的）。
 * next 是下一页的 after；还在跑的运行，文件在长，拿 next 接着读就是新追加的。
 */
export function runRecords(runs: RunLogStore | undefined, params: URLSearchParams, reject: Reject): { file: string; total: number; next: number; records: unknown[] } {
  if (!runs) return reject(404, 'not_found', '这个大脑没有存程序运行的明细')
  const id = params.get('id') ?? ''
  const file = params.get('file') ?? (/^[a-z]\d+$/.test(id) ? runs.find(id) : undefined)
  if (!file) return reject(404, 'not_found', id ? `没有编号是 ${id} 的运行记录` : '需要 file（日志条目里的 run.file）或者 id（r3、p12）')
  const after = whole(params.get('after'), 0, 0, Number.MAX_SAFE_INTEGER)
  const { records, total } = runs.read(file, after, whole(params.get('limit'), RUN_RECORDS_DEFAULT, 1, RUN_RECORDS_MAX))
  if (total === 0) return reject(404, 'not_found', '没有这份运行记录（只留最近 300 次）')
  return { file, total, next: after + records.length, records }
}

/** 一条线的历史有多长（面板上显示它离压缩还有多远）。 */
export interface HistorySize {
  turns: number
  hasSummary: boolean
  /**
   * 这条线下一次调模型时上下文大概多大（token），和 threshold 比的就是它：最近一次模型调用接口报的输入 token
   * （含提示词和工具清单）加上那之后历史的增减；大脑刚启动、这条线还没调过模型时是历史的“字符 ÷ 3”。
   */
  estimatedTokens: number
  /** 超过它就压缩（这条线的设置）。 */
  threshold: number
  /** 历史最前面那份交接记录是哪几轮换成的；没有记录、或者老数据没记，就没有这一项。 */
  summaryOf?: { from: number; to: number; turns: number; unknownBefore?: boolean }
}

/**
 * POST /api/history/compact {line, dryRun?}：现在就把一条线的历史写成交接记录——不看阈值，最近那一段以外的全部换掉。
 * dryRun: true 只写不存（历史不动），看它会写成什么；这条线正在跑一轮时也能试。不带 dryRun 的要等这条线停下来，
 * 它正在跑一轮时回 409。用的是这条线自己的模型，要等模型写完才回（记录长的时候一两分钟）。
 */
export async function historyCompact(
  agent: { compactNow?(line: LineName, opts: { dryRun?: boolean }): Promise<CompactNowResult> },
  body: Record<string, unknown>,
  reject: Reject,
): Promise<unknown> {
  const line = body.line
  if (line !== 'talk' && line !== 'work') return reject(400, 'bad_request', 'line 要写 talk 或 work')
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return reject(400, 'bad_request', 'dryRun 要写 true 或 false')
  if (!agent.compactNow) return reject(404, 'not_found', '这个大脑不支持在面板上压缩历史')
  const res = await agent.compactNow(line, { dryRun: body.dryRun === true })
  if (!res.ok) return reject(res.reason === 'busy' ? 409 : 503, res.reason, res.message)
  const { ok: _ok, ...rest } = res
  return { line, dryRun: body.dryRun === true, ...rest }
}

export interface StatusDeps {
  agent: {
    /** 干活线的状态（例程在它那里）。 */
    status(): AgentStatus
    /** 一条线的模型和这一轮现在的样子。 */
    state?(line: LineName): AgentState
    /** 两条线之间留着的事：干活线在等的回答、它最近一次送来的话。 */
    linkState?(): LinkState
  }
  bridge: BridgeApi
  /** 身体连着没有。 */
  connected(): boolean
  botName(): string
  /** 这条线现在配置用的是哪家的哪个模型。 */
  model(line: LineName): { provider: string; model: string; providerId: string; modelId: string } | undefined
  /** 这条线的历史有多长。 */
  history?(line: LineName): HistorySize | undefined
}

/** 例程在状态里的样子：结构化的那几项，不带最近的调用和日志（那些在明细接口里）。 */
function routineState(view: RoutineView): Record<string, unknown> {
  const run = view.run
  return {
    id: view.id,
    name: view.name,
    status: view.status,
    startedAt: view.startedAt,
    ...(view.endedAt !== undefined ? { endedAt: view.endedAt } : {}),
    calls: view.calls,
    tasks: view.actions,
    errors: run?.errors ?? 0,
    ...(view.current ? { waiting: `${view.current.tool} ${view.current.input}`, waitingSince: view.current.since, ...(view.current.taskId ? { waitingTask: view.current.taskId } : {}) } : {}),
    ...(view.limitMs !== undefined ? { limitMs: view.limitMs } : {}),
    ...(view.ending !== undefined ? { ending: view.ending } : {}),
    ...(view.endingText !== undefined ? { endingText: view.endingText } : {}),
    ...(run?.file !== undefined ? { file: run.file } : {}),
  }
}

function taskState(task: TaskInfo): Record<string, unknown> {
  return {
    id: task.id,
    type: task.type,
    state: task.state,
    ...(task.progress ? { progress: task.progress } : {}),
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.createdAt !== undefined ? { createdAt: task.createdAt } : {}),
  }
}

const LINE_TITLE: Record<LineName, string> = { talk: '对话线', work: '干活线' }

/**
 * GET /api/status：两条线各一项，固定顺序 talk、work。每项有自己的模型（空闲 / 正在想 / 在执行工具 / 接口故障）、
 * 正在跑的一轮、排着的事、历史有多长。例程和身体（在做的任务和排队的）只有一份，挂在干活线下面；对话线那一项没有这几个键。
 */
export async function panelStatus(deps: StatusDeps, now: number): Promise<unknown> {
  const status = deps.agent.status()
  const stateOf = (line: LineName): AgentState =>
    deps.agent.state?.(line) ?? { agent: line, model: { state: line === 'work' && status.busy ? 'tools' : 'idle' }, turn: null, pending: line === 'work' ? status.pending : 0, botOnline: status.botOnline }
  const work = stateOf('work')
  const routine = status.routine
  const body: { online: boolean | null; task: unknown; queue: unknown[]; error?: string } = { online: work.botOnline ?? null, task: null, queue: [] }
  if (!deps.connected()) {
    body.online = false
    body.error = '没连上游戏里的身体'
  } else {
    try {
      const tasks = await deps.bridge.taskList(deps.botName())
      body.task = tasks.active ? taskState(tasks.active) : null
      body.queue = (tasks.queue ?? []).map(taskState)
    } catch (e) {
      body.error = e instanceof Error ? e.message : String(e)
    }
  }
  const line = (name: LineName, state: AgentState): Record<string, unknown> => {
    const history = deps.history?.(name)
    return {
      agent: name,
      name: deps.botName(),
      title: LINE_TITLE[name],
      model: { ...state.model, ...(deps.model(name) ?? {}) },
      turn: state.turn,
      pending: state.pending,
      ...(history ? { history } : {}),
    }
  }
  const links = deps.agent.linkState?.() ?? {}
  return {
    time: now,
    agents: [
      line('talk', stateOf('talk')),
      {
        ...line('work', work),
        // 它提了问、还没人带话回答；它最近一次送给对话线的话
        waitingAnswer: links.waiting ?? null,
        lastReport: links.lastReport ?? null,
        // 它开的、还没看到结束的任务（例程开的也在里面）。没有在跑的一轮、这里却不空（或者例程在跑），就是“还在干，在等自己的任务”：
        // 任务一结束它自己会被叫醒接着做
        ownTasks: status.trackedTasks,
        routine: routine && routine.status === 'running' ? routineState(routine) : null,
        lastRoutine: routine && routine.status !== 'running' ? routineState(routine) : null,
        body,
      },
    ],
  }
}

/**
 * GET /api/blueprints/read?name=&draft=1&cells=1：一张图纸（或草稿）里有什么，和库函数 read_blueprint 的 data 同一个形状。
 * 默认只给尺寸和材料表；cells=1 才带格子。
 */
export async function blueprintRead(deps: { bridge: BridgeApi; design: DesignWorkspace }, params: URLSearchParams, reject: Reject): Promise<unknown> {
  const name = (params.get('name') ?? '').trim()
  if (name.length === 0 || name.length > 80 || name.includes('..') || /[/\\]/.test(name)) return reject(400, 'bad_request', '需要图纸的名字（不带路径）')
  const data = await blueprintData(deps, { name, draft: params.get('draft') === '1', cells: params.get('cells') === '1' })
  if ('content' in data) return reject(404, 'not_found', data.content)
  return dataWithLocalNames(data)
}
