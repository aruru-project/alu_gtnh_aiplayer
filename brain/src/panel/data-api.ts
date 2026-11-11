// 面板要的“数据那一半”：日志翻页、程序运行的明细、状态（模型 / 例程 / 身体三样分开）、图纸里有什么。
// 界面在 panel/public/（另一个 Work 在做）；这里只出数据，形状写在 docs/BRAIN_SPEC.md 的“面板的数据接口”。
// 和 server.ts 分开放，是为了两边并行改的时候少撞：server.ts 里只有几行路由指到这里。

import type { AgentState, AgentStatus } from '../agent/agent.ts'
import type { RoutineView } from '../agent/routine.ts'
import type { RunLogStore } from '../agent/run-log.ts'
import type { BridgeApi } from '../bridge/api.ts'
import type { TaskInfo } from '../bridge/protocol.ts'
import type { DesignWorkspace } from '../design/index.ts'
import { blueprintData } from '../tools/blueprint.ts'
import { dataWithLocalNames } from '../tools/format.ts'
import type { ActivityLog, ActivityRun } from '../store/activity-log.ts'

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

export interface StatusDeps {
  agent: { status(): AgentStatus; state?(): AgentState }
  bridge: BridgeApi
  /** 身体连着没有。 */
  connected(): boolean
  botName(): string
  /** 现在配置用的是哪家的哪个模型。 */
  model(): { provider: string; model: string } | undefined
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

/**
 * GET /api/status：三样分开给——模型（空闲 / 正在想 / 在执行工具 / 接口故障）、例程（哪个在跑）、身体（在做的任务和排队的）。
 * agents 是数组：现在只有 main 一项，以后每个帮手一项，各有自己的模型、自己的一轮、自己的例程。
 */
export async function panelStatus(deps: StatusDeps, now: number): Promise<unknown> {
  const status = deps.agent.status()
  const state: AgentState = deps.agent.state?.() ?? { agent: 'main', model: { state: status.busy ? 'tools' : 'idle' }, turn: null, pending: status.pending, botOnline: status.botOnline }
  const model = deps.model()
  const routine = status.routine
  const body: { online: boolean | null; task: unknown; queue: unknown[]; error?: string } = { online: state.botOnline ?? null, task: null, queue: [] }
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
  return {
    time: now,
    agents: [
      {
        agent: state.agent,
        name: deps.botName(),
        model: { ...state.model, ...(model ?? {}) },
        turn: state.turn,
        pending: state.pending,
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
