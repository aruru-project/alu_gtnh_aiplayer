// 沙箱子进程的入口。sandbox.ts 用受限的参数把它起起来（--permission 只许读几个目录、不许写、不许起进程；
// --disallow-code-generation-from-strings；限堆大小），从标准输入给它一个 JSON 请求，它把模型写的程序放进一个全新的
// vm 上下文里跑，结果一行一个 JSON 写到标准输出。边界在哪、保证什么不保证什么，见 docs/SCRIPTS.md。
//
// 这是纯 JavaScript 的 ES 模块：不用等 TypeScript 去类型，启动快；ES 模块一律是严格模式，栈上没有能被
// Error.prepareStackTrace 摸到的宽松函数。

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

/**
 * 从标准输入读一行（阻塞着等）。第一行是请求；程序调了工具以后，后面每一行是一个工具结果。
 * 那一头关了返回 null。直接读文件描述符：这个进程除了等这一行没有别的事要做。
 */
let stdinRest = Buffer.alloc(0)
const stdinChunk = Buffer.allocUnsafe(1 << 16)
const napArray = new Int32Array(new SharedArrayBuffer(4))
function readLine() {
  for (;;) {
    const end = stdinRest.indexOf(10)
    if (end !== -1) {
      const line = stdinRest.toString('utf8', 0, end)
      stdinRest = stdinRest.subarray(end + 1)
      return line
    }
    let got
    try {
      got = fs.readSync(0, stdinChunk, 0, stdinChunk.length, null)
    } catch (e) {
      if (e?.code === 'EAGAIN') {
        Atomics.wait(napArray, 0, 0, 5) // 管道是非阻塞的：歇一下再读
        continue
      }
      if (e?.code === 'EOF') return null
      throw e
    }
    if (got === 0) return stdinRest.length > 0 ? stdinRest.toString('utf8') : null
    stdinRest = Buffer.concat([stdinRest, stdinChunk.subarray(0, got)])
  }
}

const request = JSON.parse(readLine() ?? 'null')
const preludeSource = fs.readFileSync(path.join(import.meta.dirname, 'prelude.js'), 'utf8')

/** 往标准输出写一行。直接写文件描述符：同步、不经过 process.stdout，进程随后立刻退出也不会丢。 */
function send(message) {
  const bytes = Buffer.from(`${JSON.stringify(message)}\n`)
  let written = 0
  while (written < bytes.length) {
    try {
      written += fs.writeSync(1, bytes, written)
    } catch (e) {
      if (e?.code !== 'EAGAIN') throw e // 管道满了：那一头读走了再写
    }
  }
}

// ── 宿主这一侧先收紧：就算程序设法摸到了这个进程本身的全局，能联网、能再加载模块的入口也不在了 ──
// （这不是硬保证：Node 24 的 permission 模型不管网络。见 docs/SCRIPTS.md“不保证什么”。）
for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'Request', 'Response', 'Headers', 'BroadcastChannel', 'MessageChannel', 'MessagePort', 'Worker', 'navigator']) {
  try {
    delete globalThis[name]
  } catch {
    /* 删不掉的就留着 */
  }
}
// process 上能加载模块、给别的进程发信号、让别的 Node 进程打开调试口（_debugProcess）、换掉进程映像的那些，一并摘掉。
for (const name of ['binding', '_linkedBinding', 'dlopen', 'getBuiltinModule', 'kill', '_kill', '_debugProcess', '_debugEnd', 'execve', 'loadEnvFile', 'chdir', 'abort']) {
  try {
    Object.defineProperty(process, name, { value: undefined, writable: false, configurable: false })
  } catch {
    /* 同上 */
  }
}

// ── 程序和宿主之间唯一的通道：op 和 arg 都是字符串，回的也是字符串（"V…" 成功，"E…" 失败）──

const images = new Map(request.images.map((i) => [i.name, i]))
const dataFiles = new Map(Object.entries(request.data))
let logged = 0
let logDropped = 0
/** 日志第一次放不下时告诉那一头一声（只说一次）：例程跑得久，模型中途看进度时要知道后面的日志没留下。 */
function logOverflowed() {
  if (logDropped++ === 0) send({ t: 'logFull' })
}

function hostCall(op, arg) {
  try {
    if (op === 'log') {
      const text = String(arg)
      const room = request.limits.logChars - logged
      if (room <= 0) {
        logOverflowed()
        return 'V'
      }
      const kept = text.length > room ? text.slice(0, room) : text
      logged += kept.length + 1
      send({ t: 'log', text: kept })
      if (kept.length < text.length) logOverflowed()
      return 'V'
    }
    if (op === 'image') {
      const info = images.get(arg)
      if (!info) return `Ethere is no image named ${JSON.stringify(arg)}; images() lists the ones there are`
      const raw = fs.readFileSync(path.join(request.imagesDir, `${info.name}.rgba`))
      const width = raw.readUInt32BE(4)
      const height = raw.readUInt32BE(8)
      if (raw.toString('latin1', 0, 4) !== 'RGBA' || raw.length !== 12 + width * height * 4) return 'Ethat image cannot be read'
      return `V${width},${height};${raw.toString('latin1', 12)}`
    }
    if (op === 'call') {
      // 调工具：把请求原样交给大脑（它那边校验、执行、记日志），结果以后从标准输入回来
      if (request.limits.tools !== true) return 'Ethis program cannot call tools'
      const call = JSON.parse(arg)
      send({ t: 'call', id: call.id, name: String(call.name), input: call.input })
      return 'V'
    }
    if (op === 'wait') {
      // 等一会儿：大脑计时，到了（或者不让等）结果从标准输入回来，和工具结果一样
      if (request.limits.waits !== true) return 'Ethis program cannot wait'
      const w = JSON.parse(arg)
      send({ t: 'wait', id: Number(w.id), ms: Number(w.ms) })
      return 'V'
    }
    if (op === 'data') {
      const file = dataFiles.get(arg)
      if (!file) return `Ethe ${arg} data is not loaded on this brain; data.available() says what is`
      return `V${fs.readFileSync(file, 'utf8')}`
    }
    return 'Eno such operation'
  } catch {
    return 'Ethe sandbox could not do that'
  }
}

// ── 一个全新的上下文：只有 JavaScript 语言本身的内置对象，没有 process、require、fetch、定时器 ──

const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
  name: 'program',
  codeGeneration: { strings: false, wasm: false },
  // 程序里的 await 在同一次求值里跑完，一起算进时限
  microtaskMode: 'afterEvaluate',
})
vm.runInContext('delete globalThis.console; delete globalThis.WebAssembly; delete globalThis.SharedArrayBuffer; delete globalThis.Atomics', context)

const finishName = `__finish_${Math.random().toString(36).slice(2)}`
const boot = vm.runInContext(preludeSource, context, { filename: 'prelude.js' })
const collect = boot(
  hostCall,
  JSON.stringify({
    limits: request.limits,
    palette: request.palette,
    images: request.images,
    data: [...dataFiles.keys()],
    finishName,
  }),
)

/** 报错里程序自己的行号、列号（program.js:行:列）。 */
function position(stack) {
  const m = /program\.js:(\d+)(?::(\d+))?/.exec(stack)
  return m ? { line: Number(m[1]), ...(m[2] ? { column: Number(m[2]) } : {}) } : {}
}

function finishWith(message) {
  if (logDropped > 0) message.logDropped = logDropped
  send({ t: 'done', ...message })
  process.exit(0)
}

let script
try {
  // 程序是一个 async 函数的函数体：可以 return 一个值，可以 await。包的那一行不占行号（lineOffset）。
  script = new vm.Script(`${finishName}((async () => {"use strict";\n${request.code}\n})())`, {
    filename: 'program.js',
    lineOffset: -1,
    // import() 没有地方可去。抛一个字符串：不给这个回调的话，Node 会拿宿主这边的一个 Error 对象去拒绝那个 promise，
    // 等于把宿主的对象递进了上下文。（这个选项要 --experimental-vm-modules 才生效，sandbox.ts 带了。）
    importModuleDynamically: () => {
      throw 'import is not available in programs'
    },
  })
} catch (e) {
  // 语法错误：V8 的报错开头是 "program.js:行号"，下面两行是那一行源码和 ^ 记号
  const stack = String(e?.stack ?? e)
  const lines = stack.split('\n')
  const marked = /^\s*\^+\s*$/.test(lines[2] ?? '') ? `${lines[1]}\n${lines[2]}` : undefined
  finishWith({ ok: false, error: { name: String(e?.name ?? 'SyntaxError'), message: String(e?.message ?? e), ...position(stack), ...(marked ? { source: marked } : {}) } })
}

// 时限管的是程序自己算了多久：等工具结果的时候进程是停着的，不算
let computeLeft = request.limits.timeoutMs
/** 在上下文里求值（顺带把它排着的 await 续上），算进同一个时限。 */
function evaluate(run) {
  const started = Date.now()
  try {
    if (computeLeft <= 0) throw Object.assign(new Error('out of time'), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' })
    run({ timeout: Math.max(1, computeLeft) })
    computeLeft -= Date.now() - started
  } catch (e) {
    if (e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') finishWith({ ok: false, timedOut: true })
    // 包的那一行自己不会抛别的；程序里抛的都进了 promise。走到这里是意料之外
    finishWith({ ok: false, error: { name: 'Error', message: 'the program could not be run' } })
  }
}
// 从这里往下，上下文里跑的是不可信的代码。它抛出来、拒绝掉的值一律不看、不打印（打印会去读那个对象，
// 等于在宿主这边替它跑代码）：出了意料之外的事，只报一句“跑不了”。
process.on('unhandledRejection', () => {})
process.on('uncaughtException', () => finishWith({ ok: false, error: { name: 'Error', message: 'the program could not be run' } }))

evaluate((options) => script.runInContext(context, options))

let outcome
try {
  outcome = JSON.parse(collect())
  // 在等工具结果：读一行、送进上下文、让它把后续跑完，直到程序结束或者不再等什么
  while (outcome.state === 'pending' && outcome.waiting > 0) {
    const line = readLine()
    if (line === null) finishWith({ ok: false, error: { name: 'Error', message: 'the program was stopped while it waited for a tool' } })
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message?.t !== 'result') continue
    collect(JSON.stringify({ id: message.id, ok: message.ok === true, text: String(message.text ?? ''), data: message.data }))
    evaluate((options) => vm.runInContext('0', context, options))
    outcome = JSON.parse(collect())
  }
  // 还没完：只可能是在等 import()——它的拒绝要过宿主这边一轮事件循环才到。等几轮，每轮让上下文把后续跑完。
  for (let i = 0; i < 50 && outcome.state === 'pending'; i++) {
    await new Promise((resolve) => setImmediate(resolve))
    evaluate((options) => vm.runInContext('0', context, options))
    outcome = JSON.parse(collect())
  }
} catch {
  finishWith({ ok: false, error: { name: 'Error', message: 'the program could not be run' } })
}
const codeLines = request.code.split('\n').length
if (outcome.state === 'done') {
  finishWith({ ok: true, ...(outcome.value !== undefined ? { value: outcome.value } : {}), ...(typeof outcome.valueLength === 'number' ? { valueLength: outcome.valueLength } : {}), drafts: outcome.drafts })
} else if (outcome.state === 'failed') {
  const { name, message, stack } = outcome.error
  // 栈里只留程序自己的那几帧
  const frames = String(stack)
    .split('\n')
    // 最外面那一帧是包程序的那一行（行号在程序之外），不算
    .filter((l) => Number(/program\.js:(\d+)/.exec(l)?.[1] ?? Infinity) <= codeLines)
    .map((l) => l.trim().replace(/\(?program\.js:(\d+):(\d+)\)?/, 'line $1, column $2').replace(/^at (async )?/, 'at '))
    .slice(0, 6)
  finishWith({ ok: false, error: { name: String(name), message: String(message), ...position(String(stack)), ...(frames.length > 0 ? { frames } : {}) } })
} else {
  finishWith({ ok: false, error: { name: 'Error', message: 'the program never finished: it awaits something that never happens (there are no timers or network here)' } })
}
