// 面板前端的入口：登录、整体框架（左边常驻的状态区和导航，右边是各页）、页面切换。
// 手写的原生 JS，没有框架和构建步骤；各页在各自的文件里（page-*.js）。

import { bodyAgent, startPolling, state, stopPolling } from './data.js'
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

/** 换到某一页（sub 是页内的哪一块，比如 knowledge/manuals）。 */
export function go(page, sub) {
  const hash = `#${page}${sub ? `/${sub}` : ''}`
  if (location.hash !== hash) history.pushState(null, '', hash)
  show()
}

function show() {
  const { page, sub } = parseHash()
  if (current && current !== page) PAGES[current].module.leave?.()
  for (const key of Object.keys(PAGES)) $(`#page-${key}`).hidden = key !== page
  for (const b of document.querySelectorAll('#nav button')) b.setAttribute('aria-current', b.dataset.page === page ? 'page' : 'false')
  document.title = `${PAGES[page].title} · ${state.overview?.bot?.name ?? 'AI 玩家'}`
  current = page
  PAGES[page].module.enter($(`#page-${page}`), sub)
}

// ── 登录 ──

function showLogin() {
  stopPolling()
  clearLog()
  if (current) PAGES[current].module.leave?.()
  current = null
  $('#app').hidden = true
  $('#login').hidden = false
  $('#login-password').focus()
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

for (const b of document.querySelectorAll('#nav button')) b.addEventListener('click', () => go(b.dataset.page))
window.addEventListener('hashchange', () => !$('#app').hidden && show())
window.addEventListener('popstate', () => !$('#app').hidden && show())

// ── 常驻的状态区 ──

let sideKey = ''

function paintSide() {
  const s = state.status
  const o = state.overview
  const live = state.live
  const owner = bodyAgent(s)
  // 只在看得见的东西变了的时候重画（会跳的秒数由 tickClocks 改），免得正要点的按钮被换掉
  const key = JSON.stringify([
    s?.agents?.map((a) => [a.agent, a.model?.state, a.model?.step, a.model?.since, a.model?.provider, a.model?.model, a.model?.outage, a.turn, a.pending, a.routine, a.lastRoutine?.id, a.lastRoutine?.status, a.body]),
    s?.agents?.some((a) => a.model?.state === 'thinking' && typeof a.model.since === 'number' && Date.now() + state.skew - a.model.since > SLOW_STEP_MS),
    taskStaleMs(owner?.body?.task) > STALE_TASK_MS,
    o ? [o.bridge?.state, o.bridge?.lastError, o.bot?.name, o.bot?.status?.online, o.provider, o.models, o.usage, o.server?.tps] : null,
    live ? [live.online, live.dim, live.block, live.health, live.food, live.settings] : null,
    state.error,
  ])
  if (key !== sideKey) {
    sideKey = key
    renderSide($('#side-status'), $('#side-foot'))
  }
  const unread = o?.feedback?.unread ?? 0
  const count = $('#nav-feedback-count')
  count.hidden = !(unread > 0)
  count.textContent = unread > 0 ? String(unread) : ''
}

bus.on('status', paintSide)
bus.on('overview', paintSide)
bus.on('live', paintSide)
bus.on('status-error', paintSide)
setInterval(() => !document.hidden && tickClocks(), 1000)

// ── 启动 ──

api('GET', '/session').then(
  (s) => (s.authenticated ? showApp() : showLogin()),
  () => showLogin(),
)

