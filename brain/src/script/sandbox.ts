// 在沙箱子进程里跑模型写的 JavaScript 程序。程序是纯计算：画图纸、读图片的像素、查本地资料、算数。
// 它动不了游戏世界，也碰不到大脑的数据（配置、API key、记忆）。
//
// 三层限制（真实的边界和没有保证的地方写在 docs/SCRIPTS.md，改这里之前先看）：
//   1. 单独的子进程，带 Node 的 permission 模型：只能读这个目录（runner 和 prelude）、图片目录、本地资料目录；
//      不能写任何文件，不能起子进程、worker，不能加载原生模块。环境变量是空的。
//   2. 子进程里，程序跑在一个全新的 vm 上下文里：没有 process、require、import、fetch、定时器，
//      也不能用 eval / new Function（--disallow-code-generation-from-strings）。
//   3. 资源：时限（vm 自己的超时，加上这边的硬杀）、JS 堆上限（--max-old-space-size）、
//      常驻内存上限（这边盯着 /proc，只在 Linux 上有）、输出字节上限。
//
// 这一层只管“把程序跑完、把它交上来的东西原样拿回来”。交上来的草稿是不可信的 JSON，由 design/draft.ts 检查。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { BlockColor } from '../packdata/index.ts'

export interface SandboxLimits {
  /** 程序最多跑多久。 */
  timeoutMs: number
  /** JS 堆的上限（MiB）。 */
  heapMb: number
  /** 子进程常驻内存的上限（MiB）：大数组不在 JS 堆里，靠这个管。只在 Linux 上生效。 */
  rssMb: number
  /** 子进程标准输出的上限（字节）：草稿就是从这里回来的。 */
  outputBytes: number
  /** log 一共最多留多少字符。 */
  logChars: number
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  timeoutMs: 10_000,
  heapMb: 256,
  rssMb: 512,
  outputBytes: 16 * 1024 * 1024,
  logChars: 4000,
}

/** 程序里 blueprint()、save()、resize() 的上限：告诉它，免得它白算；真正把关的是 design/draft.ts。 */
export interface ProgramLimits {
  maxSide: number
  maxCells: number
  maxKinds: number
  maxDrafts: number
  maxPixels: number
  valueChars: number
}

export interface SandboxInput {
  /** 程序的源码：一个 async 函数的函数体。 */
  code: string
  /** 方块颜色表。 */
  palette: readonly BlockColor[]
  /** 程序能读的图片，和它们所在的目录（每张图一个 <名字>.rgba）。 */
  images: readonly { name: string; width: number; height: number }[]
  imagesDir: string
  /** 程序能查的本地资料：名字 → 文件。 */
  data: Readonly<Record<string, string>>
  program: ProgramLimits
}

export interface ProgramError {
  name: string
  message: string
  line?: number
  column?: number
  /** 语法错误时：出错的那一行源码和下面的 ^ 记号。 */
  source?: string
  /** 运行时出错：程序自己的调用栈（最里面的在前）。 */
  frames?: string[]
}

/** 程序调的一次工具，和它的结果。 */
export interface ProgramCall {
  id: number
  name: string
  input: unknown
}

export interface ProgramCallResult {
  ok: boolean
  /** 模型会看到的那段文字。 */
  text: string
  /** 同一个结果的数据形式（有些工具没有）。 */
  data?: unknown
}

/** 程序运行期间这一头能做的事。 */
export interface SandboxHooks {
  /** 程序调了一个工具：执行它，把结果给回去。没给这个钩子，程序就调不了工具。等结果的时间不算进程序的计算时限。 */
  onCall?(call: ProgramCall): Promise<ProgramCallResult>
  /** 程序 log 了一行。 */
  onLog?(text: string): void
  /** 中途把程序停掉（主人取消、总时长到了）。 */
  signal?: AbortSignal
}

export type SandboxOutcome = {
  /** 程序 log 出来的行（到被杀为止的也在）。 */
  logs: string[]
  /** 超出上限没留下的 log 条数。 */
  logDropped: number
  durationMs: number
} & (
  | { status: 'ok'; value?: string; drafts: unknown[] }
  | { status: 'error'; error: ProgramError }
  /** timeout 算得太久；memory 内存超了；output 输出太多；stopped 被这一头停掉了；crashed 子进程自己死了（detail 是它最后说的话）。 */
  | { status: 'timeout' | 'memory' | 'output' | 'stopped' | 'crashed'; detail?: string }
)

const SCRIPT_DIR = import.meta.dirname
const RUNNER = path.join(SCRIPT_DIR, 'runner.mjs')
/** vm 自己的超时没拦住（比如卡在收尾）时，过这么久由这边硬杀。 */
const KILL_GRACE_MS = 1500
const RSS_POLL_MS = 25
const PAGE_BYTES = 4096

/** 子进程现在占多少常驻内存；读不到（不是 Linux、进程刚没了）返回 undefined。 */
function residentBytes(pid: number): number | undefined {
  try {
    const pages = Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1])
    return Number.isFinite(pages) ? pages * PAGE_BYTES : undefined
  } catch {
    return undefined
  }
}

function realDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return fs.realpathSync(dir)
}

/**
 * 沙箱子进程是怎么起的：Node 的参数（不含入口文件）和进程的环境。
 * 只许读 readable 里的路径（要给真实路径，permission 模型按真实路径比对），别的权限一概没有；环境变量是空的，
 * 父进程的环境（代理设置、可能有的各种 key）一样都不带过去。
 */
export function sandboxSpawn(readable: readonly string[], heapMb: number): { args: string[]; options: { cwd: string; env: Record<string, string>; windowsHide: true } } {
  return {
    args: [
      '--permission',
      ...readable.map((p) => `--allow-fs-read=${p}`),
      '--disallow-code-generation-from-strings',
      // 让 runner 能自己接管 import()（见 runner.mjs）；这个开关会打一条“实验性功能”的警告，不要它
      '--experimental-vm-modules',
      '--no-warnings',
      `--max-old-space-size=${heapMb}`,
    ],
    options: { cwd: SCRIPT_DIR, env: {}, windowsHide: true },
  }
}

/** 跑一个程序。不管程序怎么样（死循环、吃内存、狂打日志、把自己弄崩），这个函数都会在时限后不久返回，不抛错。 */
export function runProgram(input: SandboxInput, limits: SandboxLimits = DEFAULT_SANDBOX_LIMITS, hooks: SandboxHooks = {}): Promise<SandboxOutcome> {
  const started = Date.now()
  // permission 模型按真实路径比对
  const imagesDir = realDir(input.imagesDir)
  const data: Record<string, string> = {}
  for (const [key, file] of Object.entries(input.data)) {
    try {
      data[key] = fs.realpathSync(file)
    } catch {
      /* 文件不在：这样资料就当没有 */
    }
  }
  const readable = [...new Set([fs.realpathSync(SCRIPT_DIR), imagesDir, ...Object.values(data)])]
  const how = sandboxSpawn(readable, limits.heapMb)
  const request = JSON.stringify({
    code: input.code,
    palette: input.palette,
    images: input.images,
    imagesDir,
    data,
    limits: { ...input.program, timeoutMs: limits.timeoutMs, logChars: limits.logChars, tools: hooks.onCall !== undefined },
  })

  return new Promise((resolve) => {
    const logs: string[] = []
    let logDropped = 0
    let done: Record<string, unknown> | undefined
    let killedFor: 'timeout' | 'memory' | 'output' | 'stopped' | undefined
    let received = 0
    let pending = ''
    let stderr = ''
    let settled = false

    const child = spawn(process.execPath, [...how.args, RUNNER], { ...how.options, stdio: ['pipe', 'pipe', 'pipe'] })
    const kill = (why: 'timeout' | 'memory' | 'output' | 'stopped'): void => {
      killedFor ??= why
      child.kill('SIGKILL')
    }
    // 时限管的是程序自己算了多久。它在等工具结果的时候表停着：等一个任务做完可能要几分钟
    let computeLeft = limits.timeoutMs + KILL_GRACE_MS
    let armedAt = Date.now()
    let timer: NodeJS.Timeout | undefined = setTimeout(() => kill('timeout'), computeLeft)
    let waitingCalls = 0
    const pauseClock = (): void => {
      if (timer === undefined) return
      clearTimeout(timer)
      timer = undefined
      computeLeft -= Date.now() - armedAt
    }
    const resumeClock = (): void => {
      if (timer !== undefined || settled) return
      armedAt = Date.now()
      timer = setTimeout(() => kill('timeout'), Math.max(1, computeLeft))
    }
    const onAbort = (): void => kill('stopped')
    if (hooks.signal?.aborted) onAbort()
    else hooks.signal?.addEventListener('abort', onAbort, { once: true })
    const watchdog = setInterval(() => {
      const rss = child.pid === undefined ? undefined : residentBytes(child.pid)
      if (rss !== undefined && rss > limits.rssMb * 1024 * 1024) kill('memory')
    }, RSS_POLL_MS)

    const finish = (outcome: SandboxOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(watchdog)
      hooks.signal?.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const base = () => ({ logs, logDropped, durationMs: Date.now() - started })

    const onLine = (line: string): void => {
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message === null || typeof message !== 'object') return
      const m = message as Record<string, unknown>
      if (m.t === 'log' && typeof m.text === 'string') {
        logs.push(m.text)
        hooks.onLog?.(m.text)
      } else if (m.t === 'done') {
        done = m
      } else if (m.t === 'call' && typeof m.id === 'number' && typeof m.name === 'string') {
        // 程序调了一个工具：表停下，执行完把结果写回它的标准输入，表再走
        const call: ProgramCall = { id: m.id, name: m.name, input: m.input }
        if (waitingCalls++ === 0) pauseClock()
        const run = hooks.onCall ? hooks.onCall(call) : Promise.resolve<ProgramCallResult>({ ok: false, text: 'this program cannot call tools' })
        run
          .catch((e: unknown): ProgramCallResult => ({ ok: false, text: `the tool could not be run: ${e instanceof Error ? e.message : String(e)}` }))
          .then((result) => {
            if (--waitingCalls === 0) resumeClock()
            if (settled || child.stdin.destroyed) return
            child.stdin.write(`${JSON.stringify({ t: 'result', id: call.id, ok: result.ok, text: result.text, ...(result.data !== undefined ? { data: result.data } : {}) })}\n`)
          })
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      received += chunk.length
      if (received > limits.outputBytes) {
        kill('output')
        return
      }
      pending += chunk
      let cut: number
      while ((cut = pending.indexOf('\n')) !== -1) {
        onLine(pending.slice(0, cut))
        pending = pending.slice(cut + 1)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 8000) stderr += chunk
    })
    // 子进程起不来、或者它先死了管道断了，都不能让这个进程跟着出事
    child.stdin.on('error', () => {})
    child.on('error', (e) => finish({ ...base(), status: 'crashed', detail: `the sandbox process could not be started: ${e.message}` }))
    child.on('close', (_code, signal) => {
      if (typeof done?.logDropped === 'number') logDropped = done.logDropped
      if (killedFor !== undefined) return finish({ ...base(), status: killedFor })
      if (done?.ok === true) {
        return finish({
          ...base(),
          status: 'ok',
          ...(typeof done.value === 'string' ? { value: done.value } : {}),
          drafts: Array.isArray(done.drafts) ? done.drafts : [],
        })
      }
      if (done?.timedOut === true) return finish({ ...base(), status: 'timeout' })
      if (done !== undefined) return finish({ ...base(), status: 'error', error: programError(done.error) })
      // 没来得及交结果就没了：堆撑爆时 V8 会自己中止进程
      if (/heap out of memory|Allocation failed/i.test(stderr)) return finish({ ...base(), status: 'memory' })
      const last = stderr.trim().split('\n').filter((l) => l.trim().length > 0).slice(-3).join(' / ')
      finish({ ...base(), status: 'crashed', detail: `the sandbox process ended${signal ? ` (${signal})` : ''} without a result${last ? `: ${last.slice(0, 300)}` : ''}` })
    })
    // 第一行是请求；管道留着，程序调工具时结果从这里送回去
    child.stdin.write(`${request}\n`)
    child.on('close', () => child.stdin.destroy())
  })
}

function programError(raw: unknown): ProgramError {
  const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const error: ProgramError = { name: typeof r.name === 'string' ? r.name.slice(0, 80) : 'Error', message: typeof r.message === 'string' ? r.message.slice(0, 1000) : 'unknown error' }
  if (typeof r.line === 'number') error.line = r.line
  if (typeof r.column === 'number') error.column = r.column
  if (typeof r.source === 'string') error.source = r.source.slice(0, 400)
  if (Array.isArray(r.frames)) error.frames = r.frames.filter((f): f is string => typeof f === 'string').slice(0, 6).map((f) => f.slice(0, 200))
  return error
}
