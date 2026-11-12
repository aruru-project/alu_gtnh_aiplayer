// 它写的程序（后台的例程、run_program 当场跑的程序）调工具的记录。
//
// 一个例程可以调几千次工具。每一次都往活动日志里记两条的话，面板的对话日志一下就被刷没了（实测一个下午 700 条工具调用里
// 574 条是例程的），主人也分不清哪些是模型自己调的。所以分两处记：
//   - 每一次调用的全量（参数、结果全文、用时、开的任务）写进这次运行自己的文件：数据目录 logs/runs/<种类>-<时间>-<编号>.jsonl，
//     主人事后查得到它每一步干了什么（面板上点开那条汇总就是读这个文件）；
//   - 活动日志里一次运行只有一条滚动更新的汇总（“例程 r3：已调 312 次工具，64 秒，3 次出错”），外加每一次出错的调用各一条。

import fs from 'node:fs'
import path from 'node:path'
import type { ActivityEntry, ActivityLog, ActivityRun } from '../store/activity-log.ts'
import { appendLine, ensureDir } from '../store/files.ts'
import { clip, compactJson } from '../tools/format.ts'

export type RunKind = ActivityRun['kind']
export type RunStatus = ActivityRun['status']

/** 一次运行现在的样子：活动日志里那条汇总带着它，面板据此显示和更新。 */
export type RunInfo = ActivityRun

/** 运行记录文件里的一行。 */
export type RunRecord =
  | { t: 'start'; time: number; id: string; kind: RunKind; name: string; code: string }
  /** textLength：结果原来多长；只在 text 被裁短了（这次运行的记录已经很大）时有。 */
  | { t: 'call'; time: number; n: number; tool: string; input: unknown; ok: boolean; text: string; ms: number; task?: string; textLength?: number }
  | { t: 'log'; time: number; text: string }
  /** 例程自己等了一次（wait、setTimeout）：ms 是它要等多久，ok 是等完了；没让等、等到一半被停的带 text（为什么）。 */
  | { t: 'wait'; time: number; ms: number; ok: boolean; text?: string }
  | { t: 'end'; time: number; status: RunStatus; ending: string; calls: number; tasks: number; errors: number; value?: string; waits?: number; waitedMs?: number }

const KEEP_FILES = 300
/** 一次调用的结果在记录文件里最多留这么长（整段给的大结果，比如一万字的清单，再长就截并写明）。 */
const RECORD_TEXT_MAX = 20_000
/**
 * 一次运行的记录写到这么大以后，后面每一步的结果只留开头（出错的照样留全）：例程能跑十二小时、调几万次工具，
 * 每次都是上万字的清单的话会把磁盘写满。参数、成没成、用时、开的任务照记，所以“每一步干了什么”还是查得到。
 */
export const RUN_FULL_TEXT_BYTES = 20 * 1024 * 1024
const RECORD_TEXT_AFTER = 400
const FILE_RE = /^(routine|program)-\d{8}-\d{6}-[a-z]\d+\.jsonl$/

function stamp(time: number): string {
  const d = new Date(time)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

/** 运行记录的落盘：一次运行一个文件。 */
export class RunLogStore {
  private readonly dir: string
  /** 一次运行的记录写到多大以后，结果只留开头。 */
  readonly fullTextBytes: number

  constructor(dataDir: string, opts: { fullTextBytes?: number } = {}) {
    this.dir = path.join(dataDir, 'logs', 'runs')
    this.fullTextBytes = opts.fullTextBytes ?? RUN_FULL_TEXT_BYTES
    ensureDir(this.dir)
    this.prune()
  }

  /** 给一次新的运行起一个文件名（文件在写第一行时才出现）。 */
  create(kind: RunKind, id: string, startedAt: number): string {
    return `${kind}-${stamp(startedAt)}-${id}.jsonl`
  }

  /** 追加一行，返回写了多少字符（没写成是 0）。 */
  append(file: string, record: RunRecord): number {
    if (!FILE_RE.test(file)) return 0
    try {
      const line = JSON.stringify(record)
      appendLine(path.join(this.dir, file), line)
      return line.length + 1
    } catch (e) {
      console.error('[run-log] 写运行记录失败：', e instanceof Error ? e.message : e)
      return 0
    }
  }

  /** 读一次运行的记录：从第 after 行之后起最多 limit 行，和一共多少行。文件名不合规或文件不在时是空的。 */
  read(file: string, after = 0, limit = 500): { records: RunRecord[]; total: number } {
    if (!FILE_RE.test(file)) return { records: [], total: 0 }
    let lines: string[]
    try {
      lines = fs.readFileSync(path.join(this.dir, file), 'utf8').split('\n').filter((line) => line.length > 0)
    } catch {
      return { records: [], total: 0 }
    }
    const records: RunRecord[] = []
    for (const line of lines.slice(Math.max(0, after), Math.max(0, after) + limit)) {
      try {
        records.push(JSON.parse(line) as RunRecord)
      } catch {
        /* 坏行跳过 */
      }
    }
    return { records, total: lines.length }
  }

  /** 记录文件，按开始的时间从早到晚（文件名里的时间在种类后面）。 */
  private files(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => FILE_RE.test(f))
        .sort((a, b) => a.slice(a.indexOf('-')).localeCompare(b.slice(b.indexOf('-'))))
    } catch {
      return []
    }
  }

  /** 这个编号（r3、p12）最近的一次运行的记录文件。编号每次大脑重启从 1 重新数，所以同一个编号可以有好几个文件。 */
  find(id: string): string | undefined {
    return this.files()
      .reverse()
      .find((f) => f.endsWith(`-${id}.jsonl`))
  }

  /** 最近的若干次运行，新的在前：每次的头（start）和尾（end；还在跑、或者大脑中途重启了的没有）。 */
  list(limit = 50): ActivityRun[] {
    const out: ActivityRun[] = []
    for (const file of this.files().reverse().slice(0, Math.max(1, limit))) {
      const { records } = this.read(file, 0, 1)
      const start = records[0]
      if (!start || start.t !== 'start') continue
      const run: ActivityRun = { id: start.id, kind: start.kind, name: start.name, status: 'running', startedAt: start.time, calls: 0, tasks: 0, errors: 0, file }
      const end = this.last(file)
      if (end && end.t === 'end') Object.assign(run, { status: end.status, endedAt: end.time, calls: end.calls, tasks: end.tasks, errors: end.errors }, end.waits !== undefined ? { waits: end.waits, waitedMs: end.waitedMs ?? 0 } : {})
      out.push(run)
    }
    return out
  }

  /** 文件的最后一行。 */
  private last(file: string): RunRecord | undefined {
    try {
      const lines = fs.readFileSync(path.join(this.dir, file), 'utf8').trimEnd().split('\n')
      return JSON.parse(lines[lines.length - 1] ?? '') as RunRecord
    } catch {
      return undefined
    }
  }

  private prune(): void {
    try {
      const files = this.files()
      for (const f of files.slice(0, Math.max(0, files.length - KEEP_FILES))) fs.rmSync(path.join(this.dir, f), { force: true })
    } catch {
      /* 清理不了不影响干活 */
    }
  }
}

const KIND_WORD: Record<RunKind, string> = { routine: '例程', program: '程序' }
const STATUS_WORD: Record<RunStatus, string> = { running: '在跑', done: '跑完了', failed: '出错停了', stopped: '被停掉了', limit: '到上限停了' }

/** 汇总那一行字。 */
export function runSummaryText(run: RunInfo, now: number): string {
  const seconds = Math.max(0, Math.round(((run.endedAt ?? now) - run.startedAt) / 1000))
  const who = `${KIND_WORD[run.kind]} ${run.id}${run.name && run.name !== run.id ? `（${run.name}）` : ''}`
  const waited = run.waits !== undefined && run.waits > 0 ? `，等了 ${run.waits} 次共 ${Math.round((run.waitedMs ?? 0) / 100) / 10} 秒` : ''
  const counts = `${run.status === 'running' ? '已调' : '调了'} ${run.calls} 次工具${run.tasks > 0 ? `，开了 ${run.tasks} 个任务` : ''}，${run.errors} 次出错${waited}，${seconds} 秒`
  return `${who}：${STATUS_WORD[run.status]}，${counts}${run.status === 'running' && run.waiting ? `；正在等 ${run.waiting}` : ''}`
}

export interface RunRecorderDeps {
  /** 活动日志（哪条线的程序，由调用的人给的这个口子带上 agent 字段）。 */
  log: Pick<ActivityLog, 'add' | 'update'>
  /** 不给就不落盘（测试、没有数据目录时）：汇总和出错的那几条照样记在活动日志里。 */
  store?: RunLogStore
  now(): number
}

/** 活动日志里的汇总最快多久更新一次。 */
const SUMMARY_EVERY_MS = 1000

/** 一次运行的记录员：全量写文件，活动日志里维护一条汇总，出错的调用另记。 */
export class RunRecorder {
  private readonly deps: RunRecorderDeps
  private readonly info: RunInfo
  private entry: ActivityEntry | undefined
  private lastUpdate = 0
  private ended = false
  /** 这次运行的记录已经写了多少（字符数，当字节数的下限用）。 */
  private written = 0

  constructor(deps: RunRecorderDeps, run: { id: string; kind: RunKind; name: string; code: string }) {
    this.deps = deps
    const startedAt = deps.now()
    this.info = { id: run.id, kind: run.kind, name: run.name, status: 'running', startedAt, calls: 0, tasks: 0, errors: 0 }
    if (deps.store) {
      this.info.file = deps.store.create(run.kind, run.id, startedAt)
      deps.store.append(this.info.file, { t: 'start', time: startedAt, id: run.id, kind: run.kind, name: run.name, code: run.code })
    }
  }

  view(): RunInfo {
    return { ...this.info }
  }

  /** 开始等一步（工具名和参数）；这一步回来以后用 call 记结果。 */
  waiting(tool: string, input: unknown): void {
    this.info.waiting = `${tool} ${compactJson(input, 120)}`
    this.refresh(false)
  }

  /** 一次调用结束了。 */
  call(call: { n: number; tool: string; input: unknown; ok: boolean; text: string; ms: number; task?: string }): void {
    const time = this.deps.now()
    this.info.calls = Math.max(this.info.calls, call.n)
    if (call.task !== undefined) this.info.tasks++
    if (!call.ok) this.info.errors++
    delete this.info.waiting
    if (this.info.file && this.deps.store) {
      // 记录已经很大了：这以后成功的结果只留开头，并写明原来多长
      const brief = call.ok && this.written > this.deps.store.fullTextBytes && call.text.length > RECORD_TEXT_AFTER
      const text = brief ? `${call.text.slice(0, RECORD_TEXT_AFTER)}…` : clip(call.text, RECORD_TEXT_MAX)
      this.written += this.deps.store.append(this.info.file, { t: 'call', time, n: call.n, tool: call.tool, input: call.input, ok: call.ok, text, ms: call.ms, ...(call.task !== undefined ? { task: call.task } : {}), ...(brief ? { textLength: call.text.length } : {}) })
    }
    if (!call.ok) {
      // 出错的调用单独记一条：汇总折着的时候也看得到
      const line = call.text.split('\n')[0] ?? ''
      this.deps.log.add({
        kind: 'tool_result',
        who: call.tool,
        text: `[${KIND_WORD[this.info.kind]} ${this.info.id} #${call.n}] ${clip(line, 300)}`,
        detail: `参数：${compactJson(call.input, 2000)}\n\n${call.text}`,
        isError: true,
        source: this.info.kind,
        runId: this.info.id,
      })
    }
    this.refresh(false)
  }

  /** 例程自己等完了一次（或者没让等、等到一半被停了）。等不算工具调用，也不算出错。 */
  waited(wait: { ms: number; ok: boolean; text?: string }): void {
    delete this.info.waiting
    if (wait.ok) {
      this.info.waits = (this.info.waits ?? 0) + 1
      this.info.waitedMs = (this.info.waitedMs ?? 0) + wait.ms
    }
    if (this.info.file) this.written += this.deps.store?.append(this.info.file, { t: 'wait', time: this.deps.now(), ms: wait.ms, ok: wait.ok, ...(wait.text !== undefined ? { text: wait.text } : {}) }) ?? 0
    this.refresh(false)
  }

  /** 程序 log 的一行（只进记录文件）。 */
  logLine(text: string): void {
    if (this.info.file) this.deps.store?.append(this.info.file, { t: 'log', time: this.deps.now(), text })
  }

  /** 这次运行结束了。 */
  end(status: Exclude<RunStatus, 'running'>, ending: string, value?: string): void {
    if (this.ended) return
    this.ended = true
    this.info.status = status
    this.info.endedAt = this.deps.now()
    delete this.info.waiting
    if (this.info.file) {
      this.deps.store?.append(this.info.file, { t: 'end', time: this.info.endedAt, status, ending, calls: this.info.calls, tasks: this.info.tasks, errors: this.info.errors, ...(value !== undefined ? { value: clip(value, RECORD_TEXT_MAX) } : {}), ...(this.info.waits !== undefined ? { waits: this.info.waits, waitedMs: this.info.waitedMs ?? 0 } : {}) })
    }
    this.refresh(true)
  }

  /** 活动日志里的那条汇总：第一次有调用时才出现；之后原地更新（跑着的时候最快一秒一次，结束时一定更新并落盘）。 */
  private refresh(final: boolean): void {
    const now = this.deps.now()
    if (!this.entry) {
      // 一次工具都没调的程序（纯计算、画图纸）不占一行
      if (this.info.calls === 0 && this.info.waiting === undefined) return
      this.entry = this.deps.log.add({ kind: 'run', text: runSummaryText(this.info, now), source: this.info.kind, runId: this.info.id, run: this.view() })
      this.lastUpdate = now
      return
    }
    if (!final && now - this.lastUpdate < SUMMARY_EVERY_MS) return
    this.lastUpdate = now
    const patch = { text: runSummaryText(this.info, now), run: this.view() }
    // 跑了很久、那一条已经滚出内存了：改不了原来那条，就另记一条（结束时的定稿不能丢）
    this.entry = this.deps.log.update(this.entry.id, patch, { persist: final }) ?? (final ? this.deps.log.add({ kind: 'run', source: this.info.kind, runId: this.info.id, ...patch }) : this.entry)
  }
}
