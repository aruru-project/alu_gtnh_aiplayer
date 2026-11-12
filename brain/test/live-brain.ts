// 对着测试服联调的脚本（live-testserver.ts、live-wear.ts）共用的几样：测试服的 bridge 在哪、等一件事发生、发 rcon、
// 起一个真的大脑进程（数据目录是临时的，面板端口由系统分配）并登录它的面板、从模型请求里读出它最后看到的内容。
// 都不属于 npm test：它们要真的游戏服务器。只连测试服：正式服的端口写死在 ports.ts 里，一律拒绝。

import { execFile, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { MockReply, RecordedLlmRequest } from './mock-llm.ts'
import { RESERVED_PORTS } from './ports.ts'

export const BRAIN_ROOT = path.resolve(import.meta.dirname, '..')
export const REPO_ROOT = path.resolve(BRAIN_ROOT, '..')

/**
 * 测试服的 bridge 端口：环境变量 AIPLAYER_TEST_BRIDGE_PORT，或者 tools/local.env 里的同名一行（另一份检出、git worktree
 * 有自己的测试服，见 tools/testserver），都没有就是 25591。
 */
function testserverBridgePort(): number {
  let value = process.env.AIPLAYER_TEST_BRIDGE_PORT
  if (!value) {
    try {
      const line = fs.readFileSync(path.join(REPO_ROOT, 'tools', 'local.env'), 'utf8').split('\n').find((l) => l.startsWith('AIPLAYER_TEST_BRIDGE_PORT='))
      value = line?.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '')
    } catch {
      // 没有 local.env：用默认的
    }
  }
  const port = Number(value || 25591)
  if (!Number.isInteger(port) || (RESERVED_PORTS.includes(port) && port !== 25591)) throw new Error(`不是测试服的 bridge 端口：${String(value)}`)
  return port
}

export const TESTSERVER_BRIDGE_PORT = testserverBridgePort()
export const TOKEN_FILE = path.join(REPO_ROOT, 'testserver', 'config', 'aiplayer', 'bridge-token.txt')

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
export const stamp = () => new Date().toTimeString().slice(0, 8)
export const say = (line: string) => console.log(`${stamp()} ${line}`)

export async function until<T>(what: string, probe: () => T | undefined | false | null | Promise<T | undefined | false | null>, timeoutMs: number, intervalMs = 150): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒也没等到：${what}`)
    await sleep(intervalMs)
  }
}

export function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, cwd: REPO_ROOT }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}`.trim() })
    })
  })
}

/** tools/testserver rcon：它自己从 tools/local.env 读这一份检出的测试服的端口。 */
export const rcon = (command: string) => run(path.join(REPO_ROOT, 'tools', 'testserver'), ['rcon', command], 15_000)

// ── 模拟模型：从请求里取出“最后给模型看的内容”，两种线格式都认 ──

export function lastTurnText(req: RecordedLlmRequest): string {
  const messages: any[] = Array.isArray(req.body?.messages) ? req.body.messages : []
  if (req.api === 'openai') {
    const tail: string[] = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== 'tool' && m.role !== 'user') break
      tail.unshift(typeof m.content === 'string' ? m.content : '')
    }
    return tail.join('\n')
  }
  const last = messages[messages.length - 1]
  const blocks: any[] = Array.isArray(last?.content) ? last.content : []
  return blocks.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? String(b.content) : '')).join('\n')
}

export type Step = MockReply | ((text: string, req: RecordedLlmRequest) => MockReply)

// ── 大脑进程 ──

export interface Brain {
  child: ChildProcess
  output: () => string
  exited: Promise<number | null>
  origin: string
  call: (method: string, route: string, body?: unknown) => Promise<any>
}

/** panelPort 不给就由系统分配（只听 127.0.0.1）。 */
export async function startBrain(dataDir: string, password?: string, panelPort = 0): Promise<Brain> {
  const env = { ...process.env }
  delete env.NODE_USE_ENV_PROXY
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: BRAIN_ROOT,
    env: {
      ...env,
      AIPLAYER_DATA_DIR: dataDir,
      AIPLAYER_PANEL_HOST: '127.0.0.1',
      AIPLAYER_PANEL_PORT: String(panelPort),
      AIPLAYER_BRIDGE_HOST: '127.0.0.1',
      AIPLAYER_BRIDGE_PORT: String(TESTSERVER_BRIDGE_PORT),
      AIPLAYER_BRIDGE_TOKEN_FILE: TOKEN_FILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
  child.stderr!.on('data', (d: Buffer) => (out += d.toString()))
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  const origin = await until('大脑打印面板地址', () => /面板地址：(http:\/\/127\.0\.0\.1:\d+)\//.exec(out)?.[1], 15_000)
  const pw = password ?? (await until('大脑打印面板口令', () => /已生成面板访问口令：(\S+)/.exec(out)?.[1], 5000))
  let cookie = ''
  const call = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(`${origin}/api${route}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const json: any = await res.json().catch(() => undefined)
    if (!res.ok) throw new Error(`面板 ${method} ${route} → ${res.status} ${JSON.stringify(json)}`)
    const set = res.headers.getSetCookie()[0]
    if (set) cookie = set.split(';')[0]!
    return json
  }
  await call('POST', '/login', { password: pw })
  return { child, output: () => out, exited, origin, call }
}
