// 给面板截图用的小工具：自己起一个无头 Chrome（临时的用户目录，经管道说 CDP，不占端口），照着一份步骤单去点、去截。
// 配合 test/panel-dev.ts 起的那套假环境用。
//
//   node test/panel-shots.ts --base http://127.0.0.1:28771 --out ../.shots --plan '<JSON>'
//   node test/panel-shots.ts --base … --out … --plan-file plan.json
//
// 步骤单是一个数组，每一步是一个对象；一步里的几件事照写的顺序做：
//   size: [宽, 高]            改窗口大小
//   goto: "#chat"             换到这个地址（# 开头的只换 hash，不重新加载）
//   reload: true              重新加载页面
//   dev: { scene: "routine" } 或 { bot: {…} }   改假环境（POST /__dev/scene、/__dev/bot）
//   waitFor: "选择器"          等到有这个元素（最多 10 秒）
//   eval: "…"                 在页面里跑一段 JS（可以是返回 Promise 的表达式）；结果打印出来
//   type: ["选择器", "文字"]    往输入框里填字（触发 input、change 事件）
//   files: ["选择器", "路径"]   给文件输入框选文件
//   click: "选择器"            点第一个匹配的元素（直接调它的 click()）
//   press: "文字" 或 ["文字", "范围的选择器"]   点写着这几个字的按钮
//   mouse: "选择器" / hover: "选择器"          真的用鼠标点 / 把鼠标移上去
//   key: "Tab"                按一个键
//   wait: 毫秒                等一会儿
//   shot: "名字.png"           截图存到 --out 目录；同一步里写 full: true 是截整页
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
  // 无头的窗口没有焦点：让页面当自己有焦点，Tab 键才会走
  await page('Emulation.setFocusEmulationEnabled', { enabled: true })
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

  const find = (selector: string, what: string): Promise<[number, number]> =>
    evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()`).then((box) => {
      if (!box) throw new Error(`没有可${what}的 ${selector}`)
      return box as [number, number]
    })
  const actions: Record<string, (value: any, step: Json) => Promise<void>> = {
    size: async (v) => {
      size = v
      await setSize(size[0], size[1])
    },
    dev: async (v) => {
      if (v.scene) await fetch(`${BASE}/__dev/scene`, { method: 'POST', body: JSON.stringify({ name: v.scene }) })
      if (v.bot) await fetch(`${BASE}/__dev/bot`, { method: 'POST', body: JSON.stringify(v.bot) })
    },
    goto: async (v) => {
      if (v.startsWith('#')) await evaluate(`location.hash = ${JSON.stringify(v)}`)
      else await page('Page.navigate', { url: v.startsWith('http') ? v : `${BASE}${v}` })
    },
    reload: async () => void (await page('Page.reload')),
    waitFor: async (v) => {
      const deadline = Date.now() + 10_000
      while (!(await evaluate(`!!document.querySelector(${JSON.stringify(v)})`))) {
        if (Date.now() > deadline) throw new Error(`等不到 ${v}`)
        await sleep(100)
      }
    },
    eval: async (v) => console.log(`eval → ${JSON.stringify(await evaluate(v))}`),
    files: async (v) => {
      const doc = await page('DOM.getDocument')
      const node = await page('DOM.querySelector', { nodeId: doc.root.nodeId, selector: v[0] })
      if (!node.nodeId) throw new Error(`没有可选文件的 ${v[0]}`)
      await page('DOM.setFileInputFiles', { nodeId: node.nodeId, files: v.slice(1) })
    },
    type: async (v) => {
      const found = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(v[0])}); if (!el) return false; el.focus(); el.value = ${JSON.stringify(v[1])}; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true })()`)
      if (!found) throw new Error(`没有可填的 ${v[0]}`)
    },
    click: async (v) => {
      const found = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(v)}); if (!el) return false; el.scrollIntoView({block:'center'}); el.click(); return true })()`)
      if (!found) throw new Error(`没有可点的 ${v}`)
    },
    // 点一个按钮：在 within（选择器，可以不给）里找文字正好是 text 的按钮
    press: async (v) => {
      const [text, within] = Array.isArray(v) ? v : [v, 'body']
      const found = await evaluate(`(() => { const root = [...document.querySelectorAll(${JSON.stringify(within)})].filter((r) => r.offsetParent !== null || r === document.body); for (const r of root) { const b = [...r.querySelectorAll('button, a.button, summary')].find((x) => x.textContent.trim() === ${JSON.stringify(text)} && x.offsetParent !== null); if (b) { b.scrollIntoView({block:'center'}); b.click(); return true } } return false })()`)
      if (!found) throw new Error(`没有写着“${text}”的按钮（在 ${within} 里）`)
    },
    hover: async (v) => {
      const box = await find(v, '指')
      await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box[0], y: box[1] })
    },
    // 真的用鼠标点（会触发 hover、focus 这些），click 是直接调元素的 click()
    mouse: async (v) => {
      const box = await find(v, '点')
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await page('Input.dispatchMouseEvent', { type, x: box[0], y: box[1], button: 'left', clickCount: 1 })
    },
    key: async (v) => {
      // 可以写成 "Tab×5"：连按几次
      const [name, times] = String(v).split('×')
      const code = name === 'Tab' ? 9 : name === 'Enter' ? 13 : name === ' ' ? 32 : name === 'Escape' ? 27 : 0
      for (let n = 0; n < Number(times ?? 1); n++) {
        await page('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
        if (name === 'Enter' || name === ' ') await page('Input.dispatchKeyEvent', { type: 'char', text: name === 'Enter' ? '\r' : ' ' })
        await page('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name === ' ' ? 'Space' : name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
      }
    },
    wait: (v) => sleep(v),
    shot: async (v, step) => {
      if (step.full) {
        const height = (await evaluate('Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll(".main, .side, .page:not([hidden])")].map((e) => e.scrollHeight + 40))')) as number
        await setSize(size[0], Math.min(6000, height))
        await sleep(300)
      }
      const { data } = await page('Page.captureScreenshot', { format: 'png' })
      const file = path.join(OUT, v)
      fs.writeFileSync(file, Buffer.from(data, 'base64'))
      console.log(`截图 → ${file}`)
      if (step.full) await setSize(size[0], size[1])
    },
    full: async () => {},
  }
  for (const step of plan) {
    // 一步里的几件事照写的顺序做
    for (const [name, value] of Object.entries(step)) {
      const action = actions[name]
      if (!action) throw new Error(`步骤单里有不认识的动作：${name}`)
      await action(value, step)
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
