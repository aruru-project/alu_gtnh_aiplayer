// 面板前端的入口：登录、整体框架（左边常驻的状态区和导航，右边是各页）、页面切换。
// 手写的原生 JS，没有框架和构建步骤；各页在各自的文件里（page-*.js）。

import { bodyAgent, envTone, environmentOf, startPolling, state, stopPolling } from './data.js'
import { clearLog, startLog } from './logstore.js'
import { tickClocks } from './logview.js'
import { SLOW_STEP_MS, STALE_TASK_MS, renderSide, taskStaleMs } from './side.js'
import { $, act, api, bus } from './ui.js'
import * as pageNow from './page-now.js'
import * as pageChat from './page-chat.js'
import * as pageKnowledge from './page-knowledge.js'
import * as pageBuild from './page-build.js'
import * as pageSettings from './page-settings.js'

const PAGES = {
  now: { title: '现在', module: pageNow },
  chat: { title: '对话', module: pageChat },
  knowledge: { title: '知识', module: pageKnowledge },
  build: { title: '建造', module: pageBuild },
  settings: { title: '设置', module: pageSettings },
}
/** 旧版面板的地址（#models 这类）落到现在的哪一页。 */
const OLD_HASHES = {
  overview: 'now',
  models: 'settings/models',
  bot: 'settings/player',
  memory: 'knowledge/memory',
  manuals: 'knowledge/manuals',
  feedback: 'knowledge/feedback',
  blueprints: 'build',
}

let current = null

function parseHash() {
  let hash = location.hash.slice(1)
  if (hash in OLD_HASHES) hash = OLD_HASHES[hash]
  const [page, sub] = hash.split('/')
  return page in PAGES ? { page, sub } : { page: 'now', sub: undefined }
}

function show() {
  const { page, sub } = parseHash()
  if (current && current !== page) PAGES[current].module.leave?.()
  for (const key of Object.keys(PAGES)) $(`#page-${key}`).hidden = key !== page
  for (const b of document.querySelectorAll('#nav button')) b.setAttribute('aria-current', b.dataset.page === page ? 'page' : 'false')
  current = page
  setTitle()
  PAGES[page].module.enter($(`#page-${page}`), sub)
}

// ── 浏览器标签页：服务器的名字在最前面，小图标也按服务器上色（同时开着测试服、正式服两个面板时一眼分得开） ──

const ENV_COLORS = { prod: '#e5484d', test: '#2fa38a', other: '#6aa5ff', none: '#626b73' }
let iconKey = ''
/** 没登录时 /api/session 给的服务器名字（登录页用；没起名字时是空的）。 */
let loginServer = ''

/** 这个面板接的是哪个服务器：登录以后看状态里的，登录页上看 /api/session 给的。 */
function currentEnv() {
  if (state.status) return environmentOf()
  return { name: loginServer, rules: '', tone: envTone(loginServer) }
}

function setTitle() {
  const env = currentEnv()
  const loggedIn = !$('#app').hidden
  const page = !loggedIn ? '登录' : current ? PAGES[current].title : ''
  document.title = [env.name, page, state.overview?.bot?.name ?? 'AI 玩家'].filter(Boolean).join(' · ')
  $('#app').dataset.env = env.tone
  $('#login').dataset.env = env.tone
  // 登录页上那一条：和状态区最上面那条同样的颜色
  const band = $('#login-env')
  band.hidden = env.tone === 'none'
  band.className = `env-band ${env.tone}`
  band.textContent = env.name
  const key = `${env.tone}|${env.name}`
  if (key === iconKey) return
  iconKey = key
  // 一个色块，上面是名字的头一个字；用 SVG 拼，不加载任何东西
  const letter = [...(env.name || '?')][0].replace(/[<>&"']/g, '')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${ENV_COLORS[env.tone]}"/><text x="16" y="23" font-size="20" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`
  document.querySelector('link[rel="icon"]')?.setAttribute('href', `data:image/svg+xml,${encodeURIComponent(svg)}`)
}

// ── 登录 ──

function showLogin() {
  stopPolling()
  clearLog()
  if (current) PAGES[current].module.leave?.()
  current = null
  $('#app').hidden = true
  $('#toast').hidden = true
  $('#login').hidden = false
  $('#login-password').focus()
  setTitle()
}

function showApp() {
  $('#login').hidden = true
  $('#app').hidden = false
  startPolling()
  startLog()
  show()
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const error = $('#login-error')
  const submit = $('#login-form button[type="submit"]')
  error.hidden = true
  submit.disabled = true
  try {
    await api('POST', '/login', { password: $('#login-password').value })
    $('#login-password').value = ''
    showApp()
  } catch (e) {
    error.textContent = e.message
    error.hidden = false
    $('#login-password').select()
  } finally {
    submit.disabled = false
  }
})

$('#logout').addEventListener('click', async () => {
  await act(null, () => api('POST', '/logout', {}))
  showLogin()
})

bus.on('auth-lost', () => {
  if (!$('#app').hidden) showLogin()
})

// ── 导航 ──

for (const b of document.querySelectorAll('#nav button')) b.addEventListener('click', () => (location.hash = `#${b.dataset.page}`))
window.addEventListener('hashchange', () => !$('#app').hidden && show())

// ── 常驻的状态区 ──

let sideKey = ''

function paintSide() {
  const s = state.status
  const o = state.overview
  const live = state.live
  const owner = bodyAgent(s)
  // 只在看得见的东西变了的时候重画（会跳的秒数由 tickClocks 改），免得正要点的按钮被换掉
  const key = JSON.stringify([
    s?.agents?.map((a) => [a.agent, a.model?.state, a.model?.step, a.model?.since, a.model?.provider, a.model?.model, a.model?.outage, a.turn, a.pending, a.routine, a.lastRoutine?.id, a.lastRoutine?.status, a.body, a.waitingAnswer, a.ownTasks, a.title, a.model?.providerId, a.model?.modelId]),
    s?.agents?.some((a) => a.model?.state === 'thinking' && typeof a.model.since === 'number' && Date.now() + state.skew - a.model.since > SLOW_STEP_MS),
    taskStaleMs(owner?.body?.task) > STALE_TASK_MS,
    o ? [o.bridge?.state, o.bridge?.lastError, o.bot?.name, o.bot?.status?.online, o.provider, o.models, o.usage, o.server?.tps] : null,
    live ? [live.online, live.dim, live.block, live.health, live.food, live.settings] : null,
    state.error,
    state.lostAt,
    s?.environment,
    o?.bot?.wantOnline,
  ])
  if (key !== sideKey) {
    sideKey = key
    renderSide($('#side-status'), $('#side-foot'))
    // 问不到大脑时，页面上留着的旧样子调暗
    $('#app').classList.toggle('stale', state.lostAt !== null)
  }
  const unread = o?.feedback?.unread ?? 0
  const count = $('#nav-feedback-count')
  count.hidden = !(unread > 0)
  count.textContent = unread > 0 ? String(unread) : ''
}

bus.on('status', paintSide)
bus.on('status', setTitle)
bus.on('overview', setTitle)
bus.on('overview', paintSide)
bus.on('live', paintSide)
bus.on('status-error', paintSide)
setInterval(() => !document.hidden && tickClocks(), 1000)

// ── 启动 ──

api('GET', '/session').then(
  (s) => {
    loginServer = typeof s.server === 'string' ? s.server.trim() : ''
    return s.authenticated ? showApp() : showLogin()
  },
  () => showLogin(),
)

