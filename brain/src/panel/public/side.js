// 常驻的状态区：一张玩家卡（名字、在不在线、血量位置这些身体的事），下面每条线一张状态卡。
// 现在后端只有一条线（main）；设计上是“对话”“干活”两条，各用各的模型、各有各的状态。例程和身体的任务挂在管身体的那条线下面。
// 三种“在干活”分开写：模型（空闲 / 正在想第几步 / 在执行工具 / 接口故障）、例程（它写的后台脚本）、身体（游戏里的任务）。

import { actions, agentHint, agentLabel, bodyAgent, refresh, serverNow, state } from './data.js'
import { foodIcon, heartIcon, playerHead } from './items.js'
import { act, button, clock, compact, dimName, duration, h, num, pos, progressBar, taskName, toast } from './ui.js'

/** 模型一步想了这么久算“比平时久”（默认的接口超时是 120 秒）。 */
export const SLOW_STEP_MS = 90_000
/** 身体的任务这么久进度没动算“可能卡住了”。 */
export const STALE_TASK_MS = 120_000

/** 任务 id → 上一次看到的进度和时刻：用来看出“进度很久没动”。 */
const progressSeen = new Map()

/** 这个任务的进度多久没动了（毫秒）；没有进度可看的返回 0。 */
export function taskStaleMs(task) {
  if (!task || task.state !== 'running') return 0
  const now = serverNow()
  const mark = `${task.progress?.done ?? ''}/${task.progress?.total ?? ''}/${task.progress?.phase ?? ''}`
  const seen = progressSeen.get(task.id)
  if (!seen || seen.mark !== mark) {
    progressSeen.set(task.id, { mark, at: now })
    if (progressSeen.size > 50) progressSeen.delete(progressSeen.keys().next().value)
    return 0
  }
  return now - seen.at
}

export function taskProgress(task) {
  const p = task?.progress
  if (!p || typeof p.done !== 'number' || typeof p.total !== 'number' || p.total <= 0) return null
  return Math.min(1, p.done / p.total)
}

/** 模型那一行的状态：{ tone, text, since?, slow? }。 */
export function modelState(agent) {
  const m = agent.model ?? {}
  const now = serverNow()
  if (m.state === 'outage') return { tone: 'bad', text: '接口故障' }
  if (m.state === 'thinking') {
    const since = m.since
    const slow = typeof since === 'number' && now - since > SLOW_STEP_MS
    return { tone: slow ? 'warn' : 'think', text: m.step !== undefined ? `正在想第 ${m.step} 步` : '正在想', since, slow }
  }
  if (m.state === 'tools') return { tone: 'tools', text: m.step !== undefined ? `在执行第 ${m.step} 步的工具` : '在执行工具' }
  if (!m.provider && !m.model && state.overview && !state.overview.provider) return { tone: 'bad', text: '没配模型' }
  return { tone: 'idle', text: '空闲' }
}

function stateChip(s) {
  const attrs = { class: `state ${s.tone}` }
  if (s.since !== undefined) {
    attrs['data-since'] = s.since
    attrs['data-label'] = s.text
  }
  return h('span', attrs, s.since !== undefined ? `${s.text} ${duration(Math.max(0, serverNow() - s.since))}` : s.text)
}

// ── 玩家卡 ──

function playerCard() {
  const o = state.overview
  const live = state.live
  const name = o?.bot?.name ?? live?.name ?? '…'
  const connected = o?.bridge?.state === 'connected'
  const online = live?.online === true || o?.bot?.status?.online === true
  const st = o?.bot?.status
  const where = online ? `${dimName(live?.dim ?? st?.dim)} · ${pos(live?.block ?? st?.block ?? st?.pos)}` : ''
  const toggle = !connected
    ? null
    : online
      ? button('下线', { class: 'small quiet', title: '让它离开游戏（背包和位置存进存档）' }, (btn) => {
          if (!confirm(`让 ${name} 下线？它正在做的任务会中断。`)) return
          act(btn, actions.despawn, '已让它下线').then(refresh)
        })
      : button('上线', { class: 'small primary', title: '让它进入游戏' }, (btn) => act(btn, actions.spawn, '已让它上线').then(refresh))
  return h(
    'div',
    { class: 'pcard' },
    playerHead(name, 5),
    h(
      'div',
      { class: 'pcard-info' },
      h('div', { class: 'pcard-name' }, h('span', { text: name }), toggle),
      h(
        'div',
        { class: 'pcard-state' },
        !o
          ? h('span', { class: 'muted', text: state.error ? '连不上大脑' : '…' })
          : !connected
            ? h('span', { class: 'state bad', text: o.bridge?.state === 'unconfigured' ? '游戏还没配置' : o.bridge?.state === 'connecting' ? '正在连游戏' : '游戏没连上' })
            : online
              ? [h('span', { class: 'state ok', text: '在线' }), h('span', { class: 'muted', text: where })]
              : h('span', { class: 'state warn', text: '不在线' }),
      ),
      online && live?.online
        ? h(
            'div',
            { class: 'pcard-vitals', title: `血量 ${live.health ?? '?'} / ${live.maxHealth ?? 20}，饱食度 ${live.food ?? '?'} / 20` },
            heartIcon(1),
            h('span', { class: live.health !== null && live.health <= 6 ? 'bad' : '', text: live.health === null ? '?' : String(Math.ceil(live.health)) }),
            foodIcon(1),
            h('span', { class: live.food !== null && live.food <= 6 ? 'bad' : '', text: live.food === null ? '?' : String(live.food) }),
            live.settings?.invulnerable ? h('span', { class: 'chip', title: '不受伤害，怪物也不把它当目标', text: '无敌' }) : null,
          )
        : null,
    ),
  )
}

// ── 每条线的状态卡 ──

function modelPicker(agent) {
  const o = state.overview
  const choices = o?.models ?? []
  const m = agent.model ?? {}
  // 这条线现在用的：后端给了就用它的（没给 id 的按显示名对），否则是全局的那个“当前模型”
  const byLabel = choices.find((c) => c.providerLabel === m.provider && c.label === m.model)
  const current = m.providerId && m.modelId ? `${m.providerId}/${m.modelId}` : byLabel ? `${byLabel.providerId}/${byLabel.modelId}` : o?.provider ? `${o.provider.id}/${o.provider.modelId}` : ''
  const select = h('select', { class: 'model-pick', 'aria-label': `${agentLabel(agent)}用的模型`, title: '换了以后下一轮起生效，不用重启', disabled: choices.length === 0 })
  if (current === '') select.append(h('option', { value: '', text: choices.length === 0 ? '还没配模型' : '还没选模型', selected: true }))
  for (const c of choices) select.append(h('option', { value: `${c.providerId}/${c.modelId}`, text: `${c.providerLabel} / ${c.label}`, selected: `${c.providerId}/${c.modelId}` === current }))
  select.addEventListener('change', async () => {
    const [providerId, modelId] = select.value.split('/')
    if (!providerId || !modelId) return
    const chosen = select.selectedOptions[0]?.textContent ?? ''
    await act(select, () => actions.useModel(agent.agent, providerId, modelId), `${agentLabel(agent)}换成了 ${chosen}，下一轮起生效`)
    select.blur()
    refresh()
  })
  return select
}

function routineRow(agent) {
  const r = agent.routine
  if (!r) {
    const last = agent.lastRoutine
    return h('div', { class: 'lane-row' }, h('span', { class: 'lane-name', text: '例程' }), h('span', { class: 'lane-main muted', text: last ? `没有在跑的（上一个 ${last.id} ${{ done: '跑完了', failed: '出错停了', stopped: '被停掉了', limit: '到上限停了' }[last.status] ?? last.status}）` : '没有在跑的' }))
  }
  const now = serverNow()
  const over = typeof r.limitMs === 'number' && now - r.startedAt > r.limitMs * 0.9
  return h(
    'div',
    { class: 'lane-row active' },
    h('span', { class: 'lane-name', text: '例程' }),
    h(
      'div',
      { class: 'lane-main' },
      h('div', { class: 'lane-line' }, h('span', { class: 'mono', text: r.id }), h('span', { class: 'lane-title', title: r.name, text: r.name || '（没有名字）' })),
      h(
        'div',
        { class: 'lane-sub' },
        h('span', { class: `state ${over ? 'warn' : 'routine'}`, 'data-since': r.startedAt, 'data-label': '在跑', text: `在跑 ${duration(Math.max(0, now - r.startedAt))}` }),
        h('span', { class: 'muted', text: `${num(r.calls)} 次调用${r.errors > 0 ? ` · ${r.errors} 次出错` : ''}` }),
      ),
    ),
    button('停', { class: 'small danger', title: '停掉这个例程；它正在做的任务也取消，模型会被叫醒看结果' }, (btn) => act(btn, actions.stopRoutine, '已停止例程').then(refresh)),
  )
}

function bodyRow(agent) {
  const body = agent.body ?? {}
  const task = body.task
  const queue = body.queue ?? []
  if (!task) {
    return h(
      'div',
      { class: 'lane-row' },
      h('span', { class: 'lane-name', text: '身体' }),
      h('span', { class: 'lane-main muted', text: body.error ? `看不到（${body.error}）` : queue.length > 0 ? `排着 ${queue.length} 个任务` : '没有任务' }),
      queue.length > 0 ? button('取消', { class: 'small danger' }, (btn) => act(btn, () => actions.cancelTask(), '已取消').then(refresh)) : null,
    )
  }
  const ratio = taskProgress(task)
  const stale = taskStaleMs(task)
  const p = task.progress
  return h(
    'div',
    { class: 'lane-row active' },
    h('span', { class: 'lane-name', text: '身体' }),
    h(
      'div',
      { class: 'lane-main' },
      h('div', { class: 'lane-line' }, h('span', { class: 'lane-title', text: taskName(task.type) }), p && typeof p.done === 'number' && typeof p.total === 'number' && p.total > 0 ? h('span', { class: 'mono muted', text: `${p.done}/${p.total}` }) : null),
      progressBar(ratio, stale > STALE_TASK_MS ? 'warn' : 'body'),
      h(
        'div',
        { class: 'lane-sub' },
        stale > STALE_TASK_MS ? h('span', { class: 'state warn', text: `进度 ${duration(stale)}没动` }) : p?.phase ? h('span', { class: 'muted', text: p.phase }) : null,
        queue.length > 0 ? h('span', { class: 'muted', text: `后面排着 ${queue.length} 个` }) : null,
      ),
    ),
    button('取消', { class: 'small danger', title: '取消这个任务（排着队的不动）' }, (btn) => act(btn, () => actions.cancelTask(task.id), '已取消').then(refresh)),
  )
}

/** 干活线提了问、还没人带话回答：整件事就停在这里，要显眼。 */
function waitingRow(agent) {
  const w = agent.waitingAnswer
  if (!w) return null
  return h(
    'div',
    { class: 'waiting', role: 'status' },
    h('div', { class: 'waiting-head' }, h('span', { class: 'state warn', 'data-since': w.since, 'data-label': '在等回答', text: `在等回答 ${duration(Math.max(0, serverNow() - w.since))}` })),
    h('div', { class: 'waiting-text', text: w.text }),
    h('div', { class: 'hint' }, '在', h('a', { href: '#chat', text: '对话页' }), '回它一句，对话线会带话过去。'),
  )
}

function lineCard(agent, ownsBody, alone) {
  const s = modelState(agent)
  const m = agent.model ?? {}
  const turn = agent.turn
  const extra = []
  if (m.state === 'outage' && m.outage) {
    extra.push(h('div', { class: 'lane-note bad', text: `连着失败 ${m.outage.failures} 次，${clock(m.outage.nextRetryAt)} 再试` }))
  } else if (turn) {
    extra.push(h('div', { class: 'lane-note muted', title: turn.about ?? '', text: `第 ${turn.id} 轮${turn.maxSteps ? ` · 已 ${turn.steps ?? 0}/${turn.maxSteps} 步` : ''}${turn.about ? ` · ${turn.about}` : ''}` }))
  }
  if (agent.pending > 0) extra.push(h('div', { class: 'lane-note muted', text: `还有 ${agent.pending} 件事排着等它` }))
  return h(
    'section',
    { class: `line-card agent-${agent.agent}`, 'aria-label': agentLabel(agent) },
    h('div', { class: 'line-head' }, h('span', { class: 'line-name', title: agentHint(agent), text: alone ? '模型' : agentLabel(agent) }), stateChip(s)),
    modelPicker(agent),
    extra,
    waitingRow(agent),
    ownsBody ? [routineRow(agent), bodyRow(agent)] : null,
  )
}

function stopAll() {
  const agents = state.status?.agents ?? []
  // 有总停止接口的后端连“正在想的那一步”也打断得了；没有的只停得了例程和任务
  const working = agents.filter((a) => a.agent !== 'talk')
  const busy = working.some((a) => a.routine || a.body?.task || (a.body?.queue ?? []).length > 0 || (state.status?.source === 'status' && (a.model?.state === 'thinking' || a.model?.state === 'tools')))
  return button(
    '全部停下',
    {
      class: 'stop-all danger',
      disabled: !busy,
      title: busy ? '让一切停下：打断干活的那条线正在想的那一步，停掉例程，取消身体正在做的和排着队的全部任务' : '现在没有在干的活',
    },
    (btn) =>
      act(btn, actions.stopAll).then((res) => {
        if (!res) return
        const did = [res.turn ? '打断了正在想的那一步' : '', res.routine ? `停了例程${typeof res.routine === 'string' && res.routine !== '例程' ? ` ${res.routine}` : ''}` : '', res.tasks > 0 ? `取消了 ${res.tasks} 个任务` : ''].filter(Boolean)
        toast(did.length > 0 ? `已停下：${did.join('，')}` : '没有要停的')
        refresh()
      }),
  )
}

function foot() {
  const o = state.overview
  if (!o) return h('div', { class: 'side-foot muted', text: state.error ?? '' })
  const b = o.bridge ?? {}
  const u = o.usage?.today
  const limit = o.usage?.dailyTokenLimit ?? 0
  const used = u ? u.inputTokens + u.outputTokens : 0
  const bridgeText = b.state === 'connected' ? '已连接' : b.state === 'connecting' ? '连接中' : b.state === 'unconfigured' ? '还没配置' : '未连接'
  return h(
    'div',
    { class: 'side-foot' },
    h('div', { class: 'foot-row', title: b.lastError && b.state !== 'connected' ? b.lastError : (b.address ?? '') }, h('span', { class: 'muted', text: '游戏' }), h('span', { class: `state ${b.state === 'connected' ? 'ok' : b.state === 'connecting' ? 'warn' : 'bad'}`, text: bridgeText }), o.server?.tps !== undefined && o.server?.tps !== null ? h('span', { class: 'muted', text: `TPS ${o.server.tps}` }) : null),
    u
      ? h(
          'div',
          { class: 'foot-row', title: `今天调了 ${num(u.calls)} 次模型，输入 ${num(u.inputTokens)}（其中缓存 ${num(u.cacheReadTokens ?? 0)}）、输出 ${num(u.outputTokens)} token${limit > 0 ? `；每日上限 ${num(limit)}` : ''}` },
          h('span', { class: 'muted', text: '今日' }),
          h('span', { text: `${num(u.calls)} 次调用 · ${compact(used)} token` }),
          limit > 0 ? h('span', { class: used > limit * 0.9 ? 'bad' : 'muted', text: `/ ${compact(limit)}` }) : null,
        )
      : null,
  )
}

/** 重画状态区。root 是放玩家卡和各条线的那个容器；footRoot 是侧栏最下面那块。 */
export function renderSide(root, footRoot) {
  const agents = state.status?.agents ?? []
  const owner = bodyAgent(state.status)
  // 正在挑模型的时候不重画，免得下拉被换掉
  if (root.contains(document.activeElement) && document.activeElement?.tagName === 'SELECT') return
  root.replaceChildren(
    playerCard(),
    h('div', { class: 'lines-head' }, h('span', { class: 'side-label', text: agents.length > 1 ? '两条线' : '它在干什么' }), stopAll()),
    ...(agents.length === 0 ? [h('p', { class: 'muted pad', text: state.error ? `连不上大脑进程：${state.error}` : '正在问大脑…' })] : agents.map((a) => lineCard(a, a === owner, agents.length === 1))),
  )
  footRoot.replaceChildren(foot())
}
