// 给面板截图用的小工具：自己起一个无头 Chrome（临时的用户目录，经管道说 CDP，不占端口），照着一份步骤单去点、去截。
// 配合 test/panel-dev.ts 起的那套假环境用。
//
//   node test/panel-shots.ts --base http://127.0.0.1:28771 --out ../.shots --plan '<JSON>'
//   node test/panel-shots.ts --base … --out … --plan-file plan.json
//
// 步骤单是一个数组，每一步是一个对象，里面这些键按这个顺序生效（都可以不写）：
//   size: [宽, 高]        改窗口大小
//   goto: "#chat"         换到这个地址（# 开头的只换 hash，不重新加载）
//   reload: true          重新加载页面
//   dev: { scene: "routine" } 或 { bot: {…} }   先改假环境（POST /__dev/scene、/__dev/bot）
//   eval: "…"             在页面里跑一段 JS（可以是返回 Promise 的表达式）；结果打印出来
//   type: ["选择器", "文字"] 往输入框里填字（触发 input 事件）
//   click: "选择器"        点第一个匹配的元素（找不到就报错）
//   hover: "选择器"        把鼠标移到元素中间
//   wait: 毫秒            等一会儿
//   waitFor: "选择器"      等到有这个元素（最多 10 秒）
//   shot: "名字.png"       截图存到 --out 目录
//   full: true            和 shot 一起用：截整页而不是窗口
// 页面里的报错（console.error、没接住的异常、失败的请求）会打印出来，最后一行写一共几条。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type Json = Record<string, any>

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : undefined
}
const BASE = arg('base') ?? 'http://127.0.0.1:28771'
const OUT = path.resolve(arg('out') ?? '../.shots')
const planText = arg('plan') ?? (arg('plan-file') ? fs.readFileSync(arg('plan-file')!, 'utf8') : '[]')
const plan = JSON.parse(planText) as Json[]

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-shots-'))
const chrome = spawn(
  arg('chrome') ?? 'google-chrome',
  ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', '--enable-unsafe-swiftshader', '--window-size=1360,900', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
)
const toChrome = chrome.stdio[3] as NodeJS.WritableStream
const fromChrome = chrome.stdio[4] as NodeJS.ReadableStream

let nextId = 1
const waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>()
const problems: string[] = []
let buffer = ''
fromChrome.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const end = buffer.indexOf('\0')
    if (end < 0) break
    const msg = JSON.parse(buffer.slice(0, end)) as Json
    buffer = buffer.slice(end + 1)
    if (typeof msg.id === 'number') {
      const w = waiting.get(msg.id)
      waiting.delete(msg.id)
      if (msg.error) w?.reject(new Error(`${msg.error.message}`))
      else w?.resolve(msg.result ?? {})
    } else if (msg.method === 'Runtime.exceptionThrown') {
      problems.push(`没接住的异常：${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text}`)
    } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      problems.push(`console.${msg.params.type}：${(msg.params.args ?? []).map((a: Json) => a.value ?? a.description ?? '').join(' ')}`)
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      problems.push(`页面报错：${msg.params.entry.text} ${msg.params.entry.url ?? ''}`)
    }
  }
})

function send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const page = (method: string, params: Json = {}): Promise<Json> => send(method, params, sessionId)
  await page('Page.enable')
  await page('Runtime.enable')
  await page('Log.enable')
  const evaluate = async (expression: string): Promise<unknown> => {
    const res = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (res.exceptionDetails) throw new Error(`页面里的脚本出错：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`)
    return res.result?.value
  }
  let size: [number, number] = [1360, 900]
  const setSize = (w: number, h: number): Promise<Json> => page('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await setSize(...size)

  // 登录：口令从假环境要（GET /__dev），页面里发登录请求拿到会话 cookie
  await page('Page.navigate', { url: `${BASE}/` })
  await sleep(600)
  const dev = (await (await fetch(`${BASE}/__dev`)).json().catch(() => ({}))) as Json
  const password = arg('password') ?? dev.password
  if (password) {
    const ok = await evaluate(`fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:${JSON.stringify(password)}})}).then(r=>r.status)`)
    if (ok !== 200) console.log(`登录没成：HTTP ${String(ok)}`)
    await page('Page.navigate', { url: `${BASE}/` })
    await sleep(1200)
  }

  for (const step of plan) {
    if (step.size) {
      size = step.size
      await setSize(size[0], size[1])
    }
    if (step.dev?.scene) await fetch(`${BASE}/__dev/scene`, { method: 'POST', body: JSON.stringify({ name: step.dev.scene }) })
    if (step.dev?.bot) await fetch(`${BASE}/__dev/bot`, { method: 'POST', body: JSON.stringify(step.dev.bot) })
    if (typeof step.goto === 'string') {
      if (step.goto.startsWith('#')) await evaluate(`location.hash = ${JSON.stringify(step.goto)}`)
      else await page('Page.navigate', { url: step.goto.startsWith('http') ? step.goto : `${BASE}${step.goto}` })
    }
    if (step.reload) await page('Page.reload')
    if (typeof step.waitFor === 'string') {
      const deadline = Date.now() + 10_000
      while (!(await evaluate(`!!document.querySelector(${JSON.stringify(step.waitFor)})`))) {
        if (Date.now() > deadline) throw new Error(`等不到 ${step.waitFor}`)
        await sleep(100)
      }
    }
    if (typeof step.eval === 'string') console.log(`eval → ${JSON.stringify(await evaluate(step.eval))}`)
    if (Array.isArray(step.type)) {
      const found = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(step.type[0])}); if (!el) return false; el.focus(); el.value = ${JSON.stringify(step.type[1])}; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true })()`)
      if (!found) throw new Error(`没有可填的 ${step.type[0]}`)
    }
    if (typeof step.click === 'string') {
      const found = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(step.click)}); if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true })()`)
      if (!found) throw new Error(`没有可点的 ${step.click}`)
    }
    if (typeof step.hover === 'string') {
      const box = (await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(step.hover)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`)) as [number, number] | null
      if (!box) throw new Error(`没有可指的 ${step.hover}`)
      await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box[0], y: box[1] })
    }
    if (typeof step.wait === 'number') await sleep(step.wait)
    if (typeof step.shot === 'string') {
      let params: Json = { format: 'png' }
      if (step.full) {
        const metrics = (await evaluate('[document.documentElement.scrollWidth, Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll(".main, .side")].map((e) => e.scrollHeight))]')) as [number, number]
        await setSize(size[0], Math.min(6000, metrics[1]))
        await sleep(300)
        params = { format: 'png' }
      }
      const { data } = await page('Page.captureScreenshot', params)
      const file = path.join(OUT, step.shot)
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
      console.log(`截图 → ${file}`)
      if (step.full) await setSize(size[0], size[1])
    }
  }
  for (const p of problems) console.log(p)
  console.log(`页面报错 ${problems.length} 条`)
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    for (const p of problems) console.log(p)
    process.exitCode = 1
  })
  .finally(() => {
    chrome.kill('SIGKILL')
    setTimeout(() => {
      fs.rmSync(profile, { recursive: true, force: true })
      process.exit()
    }, 300)
  })
