// “设置”页：偶尔才来的地方。分几块：
//   模型       每条线用哪个模型；模型服务商（接口类型、地址、key）和它下面的模型的增删改测
//   玩家       这个服务器（名字、这里的规矩）；游戏里的它（上线下线、无敌、会饿）；自动上下线；名字、别名、主人名单、什么时候回应；人设提示词
//   上限       每轮步数、每日 token、历史压缩、记忆、工具结果、例程时长
//   游戏连接   bridge 的端口和口令文件
//   面板口令
//   历史和提醒 它记得的对话历史（可以清空）、今日用量、定时提醒

import { actions, agentLabel, envTone, presenceOf, refresh, state } from './data.js'
import { act, api, badge, bus, button, dateTime, dimName, empty, field, h, kv, num, pos, put, subTabs, toast, when } from './ui.js'

const TABS = [
  { id: 'models', label: '模型' },
  { id: 'player', label: '玩家' },
  { id: 'limits', label: '上限' },
  { id: 'game', label: '游戏连接' },
  { id: 'panel', label: '面板口令' },
  { id: 'records', label: '历史和提醒' },
]

let root = null
let current = 'models'
let unsubscribe = []

// ════════ 模型 ════════
// 服务商（接口类型、地址、key）和它下面的模型分开：一个服务商可以有好几个模型，各有各的设置；哪条线用哪一个随时能换。

let providerState = { providers: [], activeProviderId: '', activeModelId: '', adapters: [] }
/** 正在填的表单：null 没在填；{ provider: 'new' | id } 在填服务商；{ provider: id, model: 'new' | id, from? } 在填它下面的一个模型。 */
let editingModels = null
const testResults = new Map()

function parseJsonField(text, label) {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  let value
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new Error(`${label} 不是合法的 JSON`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象，例如 {"a": 1}`)
  return value
}

const modelLabel = (m) => m.label || m.name

/** 哪几条线各用哪个模型：[{ agent, label, providerId, modelId }]。只有一条线的后端就是一项。 */
function lineChoices() {
  const agents = state.status?.agents ?? []
  const lines = providerState.lines
  if (agents.length > 1 || lines) {
    const ids = agents.length > 1 ? agents.map((a) => a.agent) : Object.keys(lines ?? {})
    return ids.map((id) => {
      const a = agents.find((x) => x.agent === id)
      // 这条线现在用的：后端的清单里写着就用它；状态里带着 id 的用状态里的；只有显示名的按显示名对；都没有就是那个“当前模型”
      const byLabel = () => {
        const provider = providerState.providers.find((p) => p.label === a?.model?.provider)
        const model = provider?.models.find((m) => modelLabel(m) === a?.model?.model)
        return provider && model ? { providerId: provider.id, modelId: model.id } : undefined
      }
      const picked = lines?.[id] ?? (a?.model?.providerId ? { providerId: a.model.providerId, modelId: a.model.modelId } : (byLabel() ?? { providerId: providerState.activeProviderId, modelId: providerState.activeModelId }))
      return { agent: id, label: agentLabel(a ?? id), ...picked }
    })
  }
  return [{ agent: agents[0]?.agent ?? 'main', label: '它', providerId: providerState.activeProviderId, modelId: providerState.activeModelId }]
}

function applyProviderState(next) {
  providerState = next
  editingModels = null
  renderModels()
  refresh()
}

async function useModel(line, providerId, modelId, control, what) {
  const next = await act(control, () => actions.useModel(line.agent, providerId, modelId), `${line.label === '它' ? '' : line.label}换成了 ${what}，下一轮起生效`)
  if (next) applyProviderState(next)
}

/** 适配器的开关画成表单项。scope 是 provider 或 model：只画跟着它走的那些。返回一个读出当前值的函数。 */
function optionFields(box, kind, scope, currentOptions) {
  const adapter = providerState.adapters.find((a) => a.kind === kind)
  const readers = new Map()
  put(box, 
    ...(adapter?.options ?? [])
      .filter((opt) => (opt.scope ?? 'model') === scope)
      .map((opt) => {
        const value = currentOptions && opt.key in currentOptions ? currentOptions[opt.key] : opt.default
        if (opt.type === 'boolean') {
          const input = h('input', { type: 'checkbox', checked: value === true })
          readers.set(opt.key, () => input.checked)
          return h('div', null, h('label', { class: 'check' }, input, ` ${opt.key}`), h('p', { class: 'hint', text: opt.description }))
        }
        const input = h('select', null, (opt.values ?? []).map((v) => h('option', { value: v, text: v, selected: v === value })))
        readers.set(opt.key, () => input.value)
        return h('div', null, h('label', { text: opt.key }), input, h('p', { class: 'hint', text: opt.description }))
      }),
  )
  return () => Object.fromEntries([...readers.entries()].map(([key, read]) => [key, read()]))
}

/**
 * 模型名的输入框，带一个“从接口拉取”：拉到了就能在输入框里挑，拉不到写明原因，照样可以手填。
 * providerDraft() 给出问哪一家：已保存的给 { id }，正在填的给整份草稿。
 */
function modelNameField(id, value, providerDraft) {
  const list = h('datalist', { id: `${id}-list` })
  const input = h('input', { id, type: 'text', value: value ?? '', placeholder: '模型名，照服务商文档填，或者从接口拉取', spellcheck: false, autocomplete: 'off', list: list.id })
  const note = h('p', { class: 'hint', text: '发给接口的模型名。' })
  const fetchBtn = button('从接口拉取', { class: 'small' }, async () => {
    note.className = 'hint'
    note.textContent = '正在问接口有哪些模型…'
    let draft
    try {
      draft = providerDraft()
    } catch (e) {
      note.className = 'error'
      note.textContent = e.message
      return
    }
    const res = await act(fetchBtn, () => api('POST', '/providers/remote-models', draft))
    if (!res) {
      note.textContent = '发给接口的模型名。'
    } else if (res.ok) {
      put(list, ...res.models.map((m) => h('option', { value: m.id, label: m.label ?? '' })))
      note.textContent = res.models.length > 0 ? `接口说有 ${res.models.length} 个模型：点输入框挑一个，或者打几个字筛。` : '接口回了一个空的列表，手填吧。'
    } else {
      note.className = 'error'
      note.textContent = `没拉到（${res.error.kind}${res.error.status ? `，HTTP ${res.error.status}` : ''}）：${res.error.message}。手填模型名也行。`
    }
  })
  return { input, node: h('div', null, h('label', { for: id, text: '模型名' }), h('div', { class: 'row nowrap' }, h('div', { class: 'fill' }, input), fetchBtn), list, note) }
}

function testResultBox(res) {
  return res.ok
    ? h('div', { class: 'test-result ok', text: `连接正常：${(res.durationMs / 1000).toFixed(1)} 秒，模型 ${res.model}，回复“${res.reply}”${res.withPicture ? '。请求里带了一张小图，接口收下了' : ''}` })
    : h('div', { class: 'test-result bad', text: `连接失败（${res.error.kind}${res.error.status ? `，HTTP ${res.error.status}` : ''}）：${res.error.message}${res.withPicture ? '。这次请求里带了一张小图（这个模型标着“能看图”）：如果它其实不收图，把“能看图”关掉再试' : ''}` })
}

/** 服务商的表单：接口类型、地址、key 这些一家只有一份的东西。新建时可以顺手填上第一个模型。 */
function providerForm(provider) {
  const isNew = !provider
  const adapters = providerState.adapters
  const p = provider ?? { kind: adapters[0]?.kind, label: '', baseUrl: '', options: {} }
  const form = h('form', { class: 'stack' })
  const kind = h('select', { id: 'pf-kind' }, adapters.map((a) => h('option', { value: a.kind, text: a.label, selected: a.kind === p.kind })))
  const label = h('input', { id: 'pf-label', type: 'text', value: p.label ?? '', placeholder: '给自己看的名字，例如“官方接口”' })
  const baseUrl = h('input', { id: 'pf-url', type: 'url', value: p.baseUrl ?? '', required: true })
  const apiKey = h('input', { id: 'pf-key', type: 'password', autocomplete: 'off', placeholder: p.apiKeySet ? `已设置（${p.apiKeyMasked}），留空表示不修改` : '还没设置' })
  const headers = h('textarea', { id: 'pf-headers', class: 'mono', rows: 2, placeholder: '{"anthropic-beta": "…"}', value: p.extraHeaders ? JSON.stringify(p.extraHeaders, null, 2) : '' })
  const optionsBox = h('div', { class: 'fields field-wide' })
  let readOptions = () => ({})
  const renderOptions = () => {
    const adapter = adapters.find((a) => a.kind === kind.value)
    baseUrl.placeholder = adapter ? `例如 ${adapter.baseUrlExample}` : ''
    readOptions = optionFields(optionsBox, kind.value, 'provider', kind.value === p.kind ? p.options : undefined)
  }
  kind.addEventListener('change', renderOptions)
  renderOptions()

  const collect = () => {
    const out = { kind: kind.value, label: label.value.trim(), baseUrl: baseUrl.value.trim(), apiKey: apiKey.value, options: readOptions() } // key 留空 = 不修改
    const eh = parseJsonField(headers.value, '额外请求头')
    if (eh) out.extraHeaders = eh
    return out
  }
  // 新建时顺手填第一个模型（可以空着，之后再加）
  const first = isNew ? modelNameField('pf-model', '', collect) : null

  const saveBtn = h('button', { type: 'submit', class: 'primary', text: isNew ? '添加' : '保存' })
  const cancelBtn = button('取消', {}, () => {
    editingModels = null
    renderModels()
  })
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const saved = await act(
      saveBtn,
      () => {
        const body = collect()
        if (first && first.input.value.trim()) body.model = first.input.value.trim()
        return isNew ? api('POST', '/providers', body) : api('PUT', `/providers/${provider.id}`, body)
      },
      '已保存',
    )
    if (saved) applyProviderState(saved)
  })

  form.append(
    h(
      'div',
      { class: 'fields' },
      field('接口类型', kind),
      field('显示名', label),
      h('div', { class: 'field-wide' }, h('label', { for: 'pf-url', text: '服务地址' }), baseUrl),
      field('API key', apiKey, '只写不读：保存后这里只显示掩码。'),
      first ? first.node : null,
      optionsBox,
      h('div', { class: 'field-wide' }, h('label', { for: 'pf-headers', text: '额外请求头（JSON 对象，可留空）' }), headers),
    ),
    ...(isNew ? [h('p', { class: 'hint', text: '输出上限、温度、思考相关的参数是跟着模型走的：添加以后在模型上设。' })] : []),
    h('div', { class: 'row' }, saveBtn, cancelBtn),
  )
  return form
}

/** 一个模型的表单：模型名，和跟着这个模型走的设置。 */
function modelForm(provider, model, isNew) {
  const m = model ?? { name: '', label: '', options: {} }
  const form = h('form', { class: 'stack' })
  const name = modelNameField('mf2-name', m.name, () => ({ id: provider.id }))
  name.input.required = true
  const label = h('input', { id: 'mf2-label', type: 'text', value: m.label ?? '', maxLength: 60, placeholder: '可以空着，空着就显示模型名' })
  const maxOut = h('input', { id: 'mf2-max', type: 'number', min: 1, value: m.maxOutputTokens ?? '', placeholder: '留空用接口默认值' })
  const temp = h('input', { id: 'mf2-temp', type: 'number', min: 0, max: 2, step: 0.1, value: m.temperature ?? '', placeholder: '留空用接口默认值' })
  const timeout = h('input', { id: 'mf2-timeout', type: 'number', min: 1, value: m.timeoutMs ? Math.round(m.timeoutMs / 1000) : '', placeholder: '默认 120' })
  const extraBody = h('textarea', { id: 'mf2-body', class: 'mono', rows: 3, placeholder: '{"reasoning_effort": "low"}', value: m.extraBody ? JSON.stringify(m.extraBody, null, 2) : '' })
  const optionsBox = h('div', { class: 'fields field-wide' })
  const readOptions = optionFields(optionsBox, provider.kind, 'model', m.options)
  const vision = h('input', { id: 'mf2-vision', type: 'checkbox', checked: m.vision === true })

  const collect = () => {
    const out = { name: name.input.value.trim(), label: label.value.trim(), options: readOptions(), vision: vision.checked }
    if (maxOut.value !== '') out.maxOutputTokens = Number(maxOut.value)
    if (temp.value !== '') out.temperature = Number(temp.value)
    if (timeout.value !== '') out.timeoutMs = Number(timeout.value) * 1000
    const eb = parseJsonField(extraBody.value, '额外请求参数')
    if (eb) out.extraBody = eb
    return out
  }

  const result = h('div')
  const testBtn = button('测试连接', {}, async () => {
    put(result, h('p', { class: 'muted', text: '正在测试…' }))
    const res = await act(testBtn, () => api('POST', '/providers/test', { id: provider.id, ...collect() }))
    put(result, res ? testResultBox(res) : '')
  })
  const saveBtn = h('button', { type: 'submit', class: 'primary', text: isNew ? '添加' : '保存' })
  const cancelBtn = button('取消', {}, () => {
    editingModels = null
    renderModels()
  })
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const saved = await act(saveBtn, () => (isNew ? api('POST', `/providers/${provider.id}/models`, collect()) : api('PUT', `/providers/${provider.id}/models/${model.id}`, collect())), '已保存')
    if (saved) applyProviderState(saved)
  })
  form.append(
    h(
      'div',
      { class: 'fields' },
      name.node,
      field('显示名', label, '同一个模型想存两份不同的设置（比如开不开思考）来对比，就靠它区分。'),
      field('输出上限（token）', maxOut),
      field('温度', temp),
      field('超时（秒）', timeout, '想得久的模型给长一点。'),
      h(
        'div',
        null,
        h('label', { class: 'check' }, vision, ' 这个模型能看图'),
        h('p', { class: 'hint', text: '开着：它要看的图（世界和草稿的简图、你传的图片）会真的发给它。关着：只给它文字说明。图比文字费得多；模型其实不收图的话，“测试连接”会报出来。' }),
      ),
      optionsBox,
      h(
        'div',
        { class: 'field-wide' },
        h('label', { for: 'mf2-body', text: '额外请求参数（JSON 对象，浅合并进请求体，可留空）' }),
        extraBody,
        h('p', { class: 'hint', text: '思考相关的参数放这里，照服务商的文档写，例如 {"reasoning_effort": "high"} 或 {"thinking": {"type": "enabled", "budget_tokens": 2048}}。' }),
      ),
    ),
    h('div', { class: 'row' }, saveBtn, testBtn, cancelBtn),
    result,
  )
  return form
}

/** 一句话说明一个模型的设置。 */
function modelSummary(m) {
  const parts = []
  if (m.label && m.label !== m.name) parts.push(m.name)
  if (m.vision) parts.push('能看图')
  if (m.maxOutputTokens) parts.push(`输出上限 ${num(m.maxOutputTokens)}`)
  if (m.temperature !== undefined) parts.push(`温度 ${m.temperature}`)
  if (m.extraBody) parts.push(`额外参数 ${Object.keys(m.extraBody).join('、')}`)
  return parts.join(' · ')
}

/** 最上面那块：每条线现在用哪个模型，直接换。 */
function linesCard(lines) {
  const options = providerState.providers.flatMap((p) => p.models.map((m) => ({ value: `${p.id}/${m.id}`, text: `${p.label} / ${modelLabel(m)}` })))
  const many = lines.length > 1
  return h(
    'div',
    { class: 'card' },
    h('h2', { text: many ? '两条线各用哪个模型' : '它用哪个模型' }),
    h('p', { class: 'muted', text: many ? '对话线回话要快，干活线要想得深，可以各选各的，也可以选同一个。换了以后下一轮起生效，不用重启。左边状态区的卡片上也能换。' : '换了以后下一轮起生效，不用重启。左边状态区的卡片上也能换。' }),
    options.length === 0
      ? h('p', { class: 'error', text: '还没有可选的模型：先在下面添加一个服务商和它的模型。它现在没法思考。' })
      : h(
          'div',
          { class: 'fields' },
          lines.map((line) => {
            const value = `${line.providerId}/${line.modelId}`
            const select = h('select', { id: `line-model-${line.agent}` }, options.some((o) => o.value === value) ? null : h('option', { value: '', text: '还没选', selected: true }), options.map((o) => h('option', { value: o.value, text: o.text, selected: o.value === value })))
            select.addEventListener('change', () => {
              const [providerId, modelId] = select.value.split('/')
              if (providerId && modelId) useModel(line, providerId, modelId, select, select.selectedOptions[0]?.textContent ?? '')
            })
            return field(many ? line.label : '现在用的', select)
          }),
        ),
  )
}

function renderModels() {
  const el = root?.querySelector('[data-tab="models"]')
  if (!el) return
  const { providers, adapters } = providerState
  const lines = lineChoices()
  const kindLabel = (kind) => adapters.find((a) => a.kind === kind)?.label ?? kind
  const busy = editingModels !== null
  const addBtn = button('添加服务商', { class: 'primary', disabled: busy }, () => {
    editingModels = { provider: 'new' }
    renderModels()
  })

  const modelRow = (p, m) => {
    const key = `${p.id}/${m.id}`
    if (editingModels?.provider === p.id && editingModels.model === m.id) return h('li', { class: 'block' }, h('h3', { text: `编辑模型：${modelLabel(m)}` }), modelForm(p, m, false))
    const users = lines.filter((line) => line.providerId === p.id && line.modelId === m.id)
    const result = h('div', { class: 'field-wide' })
    if (testResults.has(key)) result.append(testResultBox(testResults.get(key)))
    const what = `${p.label} / ${modelLabel(m)}`
    const useBtns = lines.map((line) => button(lines.length > 1 ? `${line.label}用这个` : '用这个', { class: 'small', disabled: users.includes(line) }, (btn) => useModel(line, p.id, m.id, btn, what)))
    const testBtn = button('测试', { class: 'small' }, async () => {
      put(result, h('p', { class: 'muted', text: '正在测试…' }))
      const res = await act(testBtn, () => api('POST', '/providers/test', { id: p.id, modelId: m.id }))
      if (res) testResults.set(key, res)
      put(result, res ? testResultBox(res) : '')
    })
    const editBtn = button('编辑', { class: 'small', disabled: busy }, () => {
      editingModels = { provider: p.id, model: m.id }
      renderModels()
    })
    // 复制一份：同一个模型换一组设置来对比
    const copyBtn = button('复制', { class: 'small', disabled: busy }, () => {
      editingModels = { provider: p.id, model: 'new', from: { ...m, label: `${modelLabel(m)}（副本）` } }
      renderModels()
    })
    const delBtn = button('删除', { class: 'small danger' }, async () => {
      if (!confirm(`从“${p.label}”下面删掉模型“${modelLabel(m)}”？`)) return
      const next = await act(delBtn, () => api('DELETE', `/providers/${p.id}/models/${m.id}`, {}), '已删除')
      if (next) {
        testResults.delete(key)
        applyProviderState(next)
      }
    })
    return h(
      'li',
      { class: 'wrap' },
      users.map((line) => badge(lines.length > 1 ? `${line.label}在用` : '当前使用', 'ok')),
      h('div', { class: 'grow' }, h('span', { class: 'mono', text: modelLabel(m) }), modelSummary(m) ? h('span', { class: 'muted', text: `  ${modelSummary(m)}` }) : null),
      useBtns,
      testBtn,
      editBtn,
      copyBtn,
      delBtn,
      result,
    )
  }

  const cards = providers.map((p) => {
    if (editingModels?.provider === p.id && editingModels.model === undefined) return h('div', { class: 'card' }, h('h2', { text: `编辑服务商：${p.label}` }), providerForm(p))
    const editBtn = button('编辑', { class: 'small', disabled: busy }, () => {
      editingModels = { provider: p.id }
      renderModels()
    })
    const delBtn = button('删除', { class: 'small danger' }, async () => {
      if (!confirm(`删除服务商“${p.label}”？它的 API key 和下面的 ${p.models.length} 个模型也会一起删掉。`)) return
      const next = await act(delBtn, () => api('DELETE', `/providers/${p.id}`, {}), '已删除')
      if (next) applyProviderState(next)
    })
    const addModelBtn = button('添加模型', { class: 'small', disabled: busy }, () => {
      editingModels = { provider: p.id, model: 'new' }
      renderModels()
    })
    const adding = editingModels?.provider === p.id && editingModels.model === 'new'
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'provider-head' }, h('span', { class: 'name', text: p.label }), badge(kindLabel(p.kind)), h('span', { class: 'spacer' }), editBtn, delBtn),
      kv([
        ['服务地址', h('span', { class: 'mono', text: p.baseUrl })],
        ['API key', p.apiKeySet ? h('span', { class: 'mono', text: `已设置 ${p.apiKeyMasked}` }) : h('span', { class: 'error', text: '没设置' })],
      ]),
      h('div', { class: 'row models-head' }, h('h3', { class: 'spacer', text: `模型（${p.models.length}）` }), addModelBtn),
      p.models.length === 0 && !adding ? h('p', { class: 'muted', text: '这个服务商下面还没有模型。' }) : h('ul', { class: 'plain' }, p.models.map((m) => modelRow(p, m))),
      adding ? h('div', null, h('h3', { text: '添加模型' }), modelForm(p, editingModels.from ?? null, true)) : null,
    )
  })

  put(el, 
    h(
      'div',
      { class: 'stack' },
      linesCard(lines),
      h('div', { class: 'row' }, h('div', { class: 'fill' }, h('h2', { text: '模型服务商' }), h('p', { class: 'muted', text: '一个服务商（接口地址和 key）下面可以放好几个模型。key 只写不读：保存以后任何地方都只显示掩码。' })), addBtn),
      editingModels?.provider === 'new' ? h('div', { class: 'card' }, h('h2', { text: '添加服务商' }), providerForm(null)) : null,
      providers.length === 0 && editingModels?.provider !== 'new' ? h('div', { class: 'card' }, empty('还没有模型服务', '点“添加服务商”，填上接口地址和 key。没有它就没法思考。')) : null,
      cards,
    ),
  )
}

async function loadModels() {
  if (editingModels !== null) return // 正在填表，别把表单冲掉
  const data = await act(null, () => api('GET', '/providers'))
  if (data) {
    providerState = data
    renderModels()
  }
}

// ════════ 玩家、上限 ════════

let botData = null
let playerDirty = false
let limitsDirty = false

async function loadBot(force = false) {
  if (!force && (playerDirty || limitsDirty) && botData) return
  const data = await act(null, () => api('GET', '/bot'))
  if (data) {
    botData = data
    renderPlayer()
    renderLimits()
  }
}

/** 上线、下线、无敌、会饿：直接作用于游戏里的它。 */
function liveCard() {
  const o = state.overview
  const bot = botData.bot
  const st = o?.bot?.status
  const connected = o?.bridge?.state === 'connected'
  const spawnBtn = button('上线', { disabled: !connected || st?.online === true }, (btn) => act(btn, actions.spawn, '已让它上线').then(refresh))
  const despawnBtn = button('下线', { disabled: !connected || !st?.online }, (btn) => act(btn, actions.despawn, '已让它下线').then(refresh))
  const toggle = (key, text) => {
    const input = h('input', { type: 'checkbox', checked: st?.settings?.[key] === true, disabled: !st?.online })
    input.addEventListener('change', async () => {
      const ok = await act(input, () => api('POST', '/bot/configure', { [key]: input.checked }), '已设置')
      if (!ok) input.checked = !input.checked
      refresh()
    })
    return h('label', { class: 'check' }, input, ` ${text}`)
  }
  const why = presenceOf().why
  const offline = why === 'idle' ? '不在线：没人在，它自己下线了（“自动上下线”开着）。有人进服、你发指令、提醒到点时它会回来。' : why === 'owner' ? '不在线：你点的下线。有人进服它也不会自己上来。' : '不在线'
  return h(
    'div',
    { class: 'card', 'data-live': '' },
    h('h2', { text: `游戏里的 ${bot.name}` }),
    h('p', { class: connected ? '' : 'error', text: !connected ? '没连上游戏，下面的按钮暂时用不了。' : st?.online ? `在线，位置 ${pos(st.block ?? st.pos)}（${dimName(st.dim)}）` : offline }),
    h('div', { class: 'row' }, spawnBtn, despawnBtn, toggle('invulnerable', '无敌'), toggle('hunger', '会饿')),
    h('p', { class: 'error', text: '“会饿”打开后要小心：它能吃身上的食物了，但只在被叫醒、看到饱食度低的时候才会去吃；没人叫它、身上又没有食物时，饱食度掉光还是会饿死。没有特别的理由就关着。' }),
    h('p', { class: 'hint', text: '你点的上线、下线会被记住：大脑重连游戏时，会按最后一次的选择把它叫出来或不叫。它被踢下线也要在这里点“上线”才回来。下面“自动上下线”的下线不一样，有人来它会自己回来。默认无敌、不掉饱食度；关掉无敌后它会受伤、会死，按服务器规则掉落物品并自动重生。' }),
  )
}

/** 这个服务器：名字（状态区最上面那条、浏览器标签页上都显示）和主人给这里写的规矩（每一轮都给两条线看）。 */
function environmentForm(dirty) {
  const env = botData.bot.environment ?? { name: '', rules: '' }
  const name = h('input', { id: 'bf-env-name', type: 'text', value: env.name, maxLength: 40, placeholder: '例如：测试服、正式服' })
  const rules = h('textarea', { id: 'bf-env-rules', rows: 4, value: env.rules, maxLength: 4000, placeholder: '例如：这是测试服，材料随便用，可以拆东西试。' })
  const preview = h('span', { class: 'env-preview' })
  const paint = () => {
    const tone = envTone(name.value.trim())
    preview.className = `env-band ${tone}`
    preview.textContent = tone === 'none' ? '还没起名字' : name.value.trim()
  }
  name.addEventListener('input', paint)
  paint()
  const save = h('button', { type: 'submit', class: 'primary', text: '保存' })
  const form = h('form', { class: 'card' })
  form.addEventListener('input', dirty)
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const saved = await act(save, () => api('PUT', '/bot', { environment: { name: name.value, rules: rules.value } }), '已保存，下一轮起它看到的就是新的')
    if (saved) {
      playerDirty = false
      botData = saved
      await refresh()
      renderPlayer()
    }
  })
  form.append(
    h('h2', { text: '这个服务器' }),
    h('p', { class: 'muted', text: '这个大脑接的是哪个服务器。同时开着两个面板（比如测试服一个、正式服一个）时靠它认：名字在左上角和浏览器标签页上；名字里有“正式”的是红色，有“测试”的是绿色。' }),
    h(
      'div',
      { class: 'fields' },
      h('div', { class: 'field' }, h('label', { for: 'bf-env-name', text: '名字' }), name, h('p', { class: 'hint' }, '左上角会是这样：', preview)),
      h('div', { class: 'field-wide' }, h('label', { for: 'bf-env-rules', text: '这里的规矩' }), rules, h('p', { class: 'hint', text: '写给它看的，原话放进两条线每一轮的提示词（在“你的记忆”前面），标明是你给这个服务器写的设置、不是它记下来的。它是这个服务器的设置，不跟着记忆走：换到别的服务器不带过去。最多 4000 字。' })),
    ),
    h('div', { class: 'row' }, save),
  )
  return form
}

/** 自动上下线：没人在、它手上没事，过一阵自己下线；有人来再上来。 */
function presenceForm(dirty) {
  const p = botData.bot.presence ?? { idleOffline: false, idleMinutes: 5 }
  const on = h('input', { id: 'bf-idle-on', type: 'checkbox', checked: p.idleOffline === true })
  const minutes = h('input', { id: 'bf-idle-minutes', class: 'narrow', type: 'number', min: 0.05, max: 1440, step: 'any', value: p.idleMinutes, disabled: p.idleOffline !== true, 'aria-label': '过多久下线（分钟）', title: '可以写小数，0.05 到 1440' })
  on.addEventListener('change', () => (minutes.disabled = !on.checked))
  const save = h('button', { type: 'submit', class: 'primary', text: '保存' })
  const form = h('form', { class: 'card' })
  form.addEventListener('input', dirty)
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const saved = await act(save, () => api('PUT', '/bot', { presence: { idleOffline: on.checked, idleMinutes: Number(minutes.value) } }), '已保存，立刻生效')
    if (saved) {
      playerDirty = false
      botData = saved
      await refresh()
      renderPlayer()
    }
  })
  const away = presenceOf().why === 'idle'
  form.append(
    h('h2', { text: '自动上下线' }),
    h('div', { class: 'row' }, h('label', { class: 'check' }, on, ' 没人在、它也没事时，自己下线'), h('span', { class: 'muted', text: '过' }), minutes, h('span', { class: 'muted', text: '分钟（可以写小数）' })),
    h('p', { class: 'hint', text: '开着时：服务器上没有真人（别的 bot 不算）、它手上也没事（两条线都没在想、没有排着的事、没有任务和例程），满这么多分钟它自己下线。有真人进服、你在面板上发指令、它定的提醒到点时，它自己上来，那件事照常处理。你手动点的“下线”不一样：有人来它也不上来，要你点“上线”。' }),
    ...(away ? [h('p', { class: 'ok', text: '现在：没人在，它自己下线了。' })] : []),
    h('div', { class: 'row' }, save),
  )
  return form
}

function renderPlayer() {
  const el = root?.querySelector('[data-tab="player"]')
  if (!el || !botData) return
  const bot = botData.bot
  const two = (state.status?.agents?.length ?? 0) > 1
  const dirty = () => (playerDirty = true)

  const name = h('input', { id: 'bf-name', type: 'text', value: bot.name, maxLength: 16, required: true })
  const aliases = h('input', { id: 'bf-aliases', type: 'text', value: bot.aliases.join(' '), placeholder: '用空格隔开，例如：阿鲁 小鲁' })
  const owners = h('input', { id: 'bf-owners', type: 'text', value: bot.owners.join(' '), placeholder: '留空 = 谁都可以叫它干活' })
  const mode = h('select', { id: 'bf-mode' }, h('option', { value: 'mention', text: '叫到名字，或刚和它说过话', selected: bot.wake.mode === 'mention' }), h('option', { value: 'all', text: '所有聊天都触发（费 token）', selected: bot.wake.mode === 'all' }))
  const windowSec = h('input', { id: 'bf-window', type: 'number', min: 0, max: 3600, value: bot.wake.conversationWindowSec })
  const saveId = h('button', { type: 'submit', class: 'primary', text: '保存' })
  const idForm = h('form', { class: 'card' })
  idForm.addEventListener('input', dirty)
  idForm.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const saved = await act(saveId, () => api('PUT', '/bot', { name: name.value.trim(), aliases: aliases.value, owners: owners.value, wake: { mode: mode.value, conversationWindowSec: Number(windowSec.value) } }), '已保存，立刻生效')
    if (saved) {
      playerDirty = false
      botData = saved
      await refresh()
      renderPlayer()
    }
  })
  idForm.append(
    h('h2', { text: '身份和听谁的' }),
    h(
      'div',
      { class: 'fields' },
      field('名字（游戏里的玩家名）', name, '改名等于换一个玩家：旧名字的那个还留在游戏里，要先让它下线。'),
      field('别名', aliases, '聊天里提到这些词也算在叫它。'),
      field('主人名单', owners, '非空时只有名单里的玩家能指挥它，其他人的话它只当背景。'),
      field('什么时候回应聊天', mode),
      field('对话窗口（秒）', windowSec, '和它说过话之后，这段时间内不用再叫名字。'),
    ),
    h('div', { class: 'row' }, saveId),
  )

  const usingDefault = bot.systemPrompt.trim() === ''
  const persona = h('textarea', { id: 'bf-persona', class: 'tall', value: usingDefault ? botData.defaultPersona : bot.systemPrompt, 'aria-label': '人设提示词' })
  const personaState = h('span', { class: 'muted', text: usingDefault ? '现在用的是默认提示词' : '现在用的是自定义提示词' })
  const resetBtn = button('恢复默认', { class: 'small' }, () => {
    persona.value = botData.defaultPersona
    personaState.textContent = '已填回默认提示词，保存后生效'
    dirty()
  })
  const savePersona = h('button', { type: 'submit', class: 'primary', text: '保存' })
  const personaForm = h('form', { class: 'card' })
  personaForm.addEventListener('input', dirty)
  personaForm.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const saved = await act(savePersona, () => api('PUT', '/bot', { systemPrompt: persona.value }), '已保存，下一轮起生效')
    if (saved) {
      playerDirty = false
      botData = saved
      renderPlayer()
    }
  })
  personaForm.append(
    h('h2', { text: two ? '对话线的说话风格' : '人设提示词' }),
    h('div', { class: 'row' }, personaState, h('span', { class: 'spacer' }), resetBtn),
    persona,
    h('p', {
      class: 'hint',
      text: two
        ? '它是谁、怎么说话、底线。干活线不对玩家说话，用不着这一段。各类活具体怎么做写在“知识 → 手册”里。提示词里的 {{name}} 会换成它的名字。'
        : '这里只写任何时候都用得上的东西：它是谁、怎么说话、底线。各类活具体怎么做写在“知识 → 手册”里，它要干那类事时才去翻。提示词里的 {{name}} 会换成它的名字；手册目录、名字、别名、主人名单和记忆由程序自动附在后面，不用写在这里。',
    }),
    h('div', { class: 'row' }, savePersona),
  )

  put(el, h('div', { class: 'stack' }, environmentForm(dirty), liveCard(), presenceForm(dirty), idForm, personaForm))
}

function renderLimits() {
  const el = root?.querySelector('[data-tab="limits"]')
  if (!el || !botData) return
  const L = botData.bot.limits
  const input = (id, key, attrs) => h('input', { id, type: 'number', value: L[key], ...attrs })
  const two = L.talkMaxSteps !== undefined
  const fieldsOf = [
    ['maxSteps', field(two ? '干活线每轮最多调几次模型' : '每轮最多调几次模型', input('lf-steps', 'maxSteps', { min: 1, max: 500 }), '它被叫醒一次算一轮，到了这个次数这一轮就被截断。查配方、找材料这类多步的目标常要几十次；它干活时新到的话也接在这一轮里。默认 60，最多 500。')],
    two ? ['talkMaxSteps', field('对话线每轮最多调几次模型', input('lf-talk-steps', 'talkMaxSteps', { min: 1, max: 500 }), '对话线只说话和查资料，一轮本来就短。默认 20。')] : null,
    ['dailyTokenLimit', field('每日 token 上限', input('lf-daily', 'dailyTokenLimit', { min: 0 }), two ? '输入加输出，两条线合计。0 表示不限。' : '输入加输出。0 表示不限。')],
    ['historyTokenThreshold', field(two ? '干活线的历史超过多少 token 就压缩' : '历史超过多少 token 就压缩', input('lf-history', 'historyTokenThreshold', { min: 2000 }), '默认 240000。怎么算、怎么压见下面。')],
    two ? ['talkHistoryTokenThreshold', field('对话线的历史超过多少 token 就压缩', input('lf-talk-history', 'talkHistoryTokenThreshold', { min: 2000 }), '默认 120000。对话线的历史本来就短，调低一些回话更快。')] : null,
    ['memoryMaxChars', field('记忆总长度上限（字符）', input('lf-memory', 'memoryMaxChars', { min: 200 }))],
    ['toolResultMaxChars', field('单个工具结果上限（字符）', input('lf-result', 'toolResultMaxChars', { min: 500 }), '它写的程序 return 的值也照这个数截。')],
    L.routineMinutes !== undefined ? ['routineMinutes', field('例程默认最多跑多久（分钟）', input('lf-routine', 'routineMinutes', { min: 1, max: 10080 }), '例程是它写的、在后台一步步调工具的程序。不限它调多少次工具，靠时长、连着出错就停、随时可以点停止来管。默认 120。')] : null,
    L.routineMaxMinutes !== undefined ? ['routineMaxMinutes', field('例程最长能要到多久（分钟）', input('lf-routine-max', 'routineMaxMinutes', { min: 1, max: 10080 }), '它启动例程时可以自己要更长的时间，最多给到这个数。默认 720（12 小时）。')] : null,
  ].filter(Boolean)
  const save = h('button', { type: 'submit', class: 'primary', text: '保存' })
  const form = h('form', { class: 'card' })
  form.addEventListener('input', () => (limitsDirty = true))
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const limits = Object.fromEntries(fieldsOf.map(([key, node]) => [key, Number(node.querySelector('input').value)]))
    const saved = await act(save, () => api('PUT', '/bot', { limits }), '已保存，立刻生效')
    if (saved) {
      limitsDirty = false
      botData = saved
      renderLimits()
      refresh()
    }
  })
  form.append(
    h('h2', { text: '上限' }),
    h('p', { class: 'muted', text: '防它跑飞、防花太多的几道闸。改了立刻生效，不用重启。' }),
    h('div', { class: 'fields' }, fieldsOf.map(([, node]) => node)),
    h('p', { class: 'hint', text: '历史压缩：比的是这条线下一次调模型时整份请求大概多少 token（现在的数在“历史和提醒”里）。每轮结束时看一次，超了先把较早几轮里过长的工具结果截短、过时的状态拿掉，这一步不调模型；还超过七成，就调一次模型把较早的经历写成一份交接记录，最近的四分之一原样留着。写记录要一两分钟、花几万 token，所以阈值别定得太低。' }),
    h('div', { class: 'row' }, save),
  )
  put(el, form)
}

// ════════ 游戏连接、面板口令 ════════

let gameDirty = false

async function loadGame(force = false) {
  if (gameDirty && !force) return
  const data = await act(null, () => api('GET', '/settings'))
  if (data) renderGame(data)
}

function renderGame(data) {
  const el = root?.querySelector('[data-tab="game"]')
  if (!el) return
  const ov = data.overridden
  const eff = data.effective
  const st = data.status
  const o = state.overview
  const connected = st.state === 'connected'
  const stateText = connected ? '已连接' : st.state === 'unconfigured' ? '还没配置口令文件，没有去连' : st.state === 'connecting' ? '正在连接' : '没连上，自动重试中'
  const statusCard = h(
    'div',
    { class: 'card' },
    h('h2', { text: '现在的连接' }),
    kv([
      ['状态', h('span', { class: `state ${connected ? 'ok' : st.state === 'connecting' ? 'warn' : 'bad'}`, text: stateText })],
      ['地址', h('span', { class: 'mono', text: st.address || '–' })],
      connected && st.hello ? ['身体版本', `mod ${st.hello.modVersion ?? '?'} / MC ${st.hello.mcVersion ?? '?'} / 协议 ${st.hello.protocol}`] : null,
      connected && st.connectedAt ? ['连上于', when(st.connectedAt)] : null,
      !connected && st.lastError ? ['原因', h('span', { class: 'error', text: st.lastError })] : null,
      o?.server ? ['服务器', `TPS ${o.server.tps ?? '?'}，${o.server.isDay === false ? '夜晚' : '白天'}${o.server.raining ? '，下雨' : ''}`] : null,
      o?.server ? ['在线玩家', (o.server.players ?? []).map((p) => (p.isBot ? `${p.name}（bot）` : p.name)).join('、') || '没有人'] : null,
    ]),
  )

  const port = h('input', { id: 'sf-port', type: 'number', min: 1, max: 65535, value: data.bridge.port, required: true })
  const tokenFile = h('input', { id: 'sf-token-file', type: 'text', value: data.bridge.tokenFile, placeholder: '例如 /srv/gtnh/config/aiplayer/bridge-token.txt', spellcheck: false })
  const saveBridge = h('button', { type: 'submit', class: 'primary', text: '保存并重连' })
  const form = h('form', { class: 'card' })
  form.addEventListener('input', () => (gameDirty = true))
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const saved = await act(saveBridge, () => api('PUT', '/settings/bridge', { port: Number(port.value), tokenFile: tokenFile.value }), '已保存，正在按新的设置连接')
    if (saved) {
      gameDirty = false
      // 给它一点时间去连，再把结果显示出来
      setTimeout(async () => {
        await refresh()
        if (!gameDirty) loadGame(true)
      }, 1200)
    }
  })
  const overrideNote = (on, envName, value) => (on ? h('p', { class: 'error', text: `现在实际用的是环境变量 ${envName} 给的值：${value}。这里改的值要等去掉那个环境变量后才生效。` }) : null)
  form.append(
    h('h2', { text: '怎么连游戏（bridge）' }),
    h(
      'div',
      { class: 'fields' },
      h('div', null, h('label', { for: 'sf-port', text: '端口' }), port, h('p', { class: 'hint', text: '身体（mod）监听的端口，在游戏服务器的 config/aiplayer/aiplayer.json 里（bridgePort）。正式服默认 25590。' }), overrideNote(ov.bridgePort, 'AIPLAYER_BRIDGE_PORT', eff.port)),
      h(
        'div',
        { class: 'field-wide' },
        h('label', { for: 'sf-token-file', text: '口令文件路径' }),
        tokenFile,
        h('p', { class: 'hint', text: '游戏服务器目录下的 config/aiplayer/bridge-token.txt，mod 首次启动时生成。写绝对路径；相对路径相对 brain/ 目录。留空就不连游戏。' }),
        overrideNote(ov.bridgeTokenFile, 'AIPLAYER_BRIDGE_TOKEN_FILE', eff.tokenFile),
        ov.bridgeToken ? h('p', { class: 'error', text: '现在口令是环境变量 AIPLAYER_BRIDGE_TOKEN 直接给的，口令文件没有被用到。' }) : null,
      ),
    ),
    h('p', { class: 'hint', text: `连接的主机是 ${eff.host}，只能在 config.json 或环境变量里改。` }),
    h('div', { class: 'row' }, saveBridge),
  )
  put(el, h('div', { class: 'stack' }, statusCard, form))
}

function renderPassword() {
  const el = root?.querySelector('[data-tab="panel"]')
  if (!el || el.querySelector('form')) return
  const currentPw = h('input', { id: 'sf-pw-current', type: 'password', autocomplete: 'current-password', required: true })
  const next = h('input', { id: 'sf-pw-next', type: 'password', autocomplete: 'new-password', required: true, minLength: 8 })
  const repeat = h('input', { id: 'sf-pw-repeat', type: 'password', autocomplete: 'new-password', required: true, minLength: 8 })
  const savePw = h('button', { type: 'submit', class: 'primary', text: '修改口令' })
  const form = h('form', { class: 'card' })
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    if (next.value !== repeat.value) {
      toast('两次输入的新口令不一样', true)
      return
    }
    const ok = await act(savePw, () => api('PUT', '/settings/password', { current: currentPw.value, next: next.value }), '口令已修改，别处的登录都已失效')
    if (ok) form.reset()
  })
  form.append(
    h('h2', { text: '面板口令' }),
    h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'owner', hidden: true }),
    h('div', { class: 'fields' }, field('当前口令', currentPw), field('新口令（至少 8 个字符）', next), field('再输一遍新口令', repeat)),
    h('p', { class: 'hint', text: '口令保存在数据目录的 config.json 里。忘了可以直接改那个文件的 panel.password 再重启大脑。改完以后别的浏览器上的登录全部失效，这个浏览器接着能用。' }),
    h('p', { class: 'hint', text: '面板是明文 HTTP：在家里的局域网可以接受；要经过不信任的网络访问，用 SSH 隧道或带 HTTPS 的反向代理，不要把这个端口映射到公网。' }),
    h('div', { class: 'row' }, savePw),
  )
  put(el, form)
}

// ════════ 历史和提醒 ════════

let recordsKey = ''

function renderRecords(force = false) {
  const el = root?.querySelector('[data-tab="records"]')
  const o = state.overview
  if (!el || !o) return
  const key = JSON.stringify([o.history, o.histories, o.reminders, o.usage])
  if (!force && key === recordsKey) return
  recordsKey = key
  const histories = o.histories ? Object.entries(o.histories).map(([line, h0]) => ({ line, label: agentLabel(state.status?.agents?.find((a) => a.agent === line) ?? line), ...h0 })) : [{ line: undefined, label: '', ...o.history }]
  const clear = (line, label) =>
    button(label, { class: 'small danger' }, (btn) => {
      if (!confirm(`${label}？记忆不受影响。清空后它不记得之前聊过什么、做到哪一步。`)) return
      act(btn, () => api('POST', '/history/clear', line ? { line } : {}), '已清空').then(refresh)
    })
  const historyCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: '它记得的对话历史' }), clear(undefined, histories.length > 1 ? '两条线都清空' : '清空对话历史')),
    h('p', { class: 'muted', text: '每一轮给模型看的、它调了什么工具、结果是什么，都记在历史里，下一轮接着用。太长了会自动把较早的写成一份交接记录（原始记录还在“对话”页的日志里）。换了服务商以后接口一直报错，可以清空试试。' }),
    h(
      'ul',
      { class: 'plain' },
      histories.map((x) =>
        h('li', null, h('span', { class: 'grow' }, x.label ? h('strong', { text: `${x.label}　` }) : null, `${x.turns} 轮，上下文约 ${num(x.estimatedTokens)} token${x.threshold ? `（到 ${num(x.threshold)} 就压缩）` : ''}${x.summaryOf ? `；第 ${x.summaryOf.from}–${x.summaryOf.to} 轮（${x.summaryOf.turns} 轮）已写成交接记录` : x.hasSummary ? '；更早的已写成交接记录' : ''}`), x.line ? clear(x.line, `清空${x.label}的`) : null),
      ),
    ),
  )
  const u = o.usage.today
  const limit = o.usage.dailyTokenLimit
  const usageCard = h(
    'div',
    { class: 'card' },
    h('h2', { text: '今日用量' }),
    kv([
      ['调用次数', num(u.calls)],
      ['输入 token', `${num(u.inputTokens)}${u.cacheReadTokens > 0 ? `（其中 ${num(u.cacheReadTokens)} 走缓存）` : ''}`],
      ['输出 token', num(u.outputTokens)],
      ['每日上限', limit > 0 ? `${num(u.inputTokens + u.outputTokens)} / ${num(limit)}` : '不限（在“上限”里设）'],
    ]),
  )
  const reminders = o.reminders ?? []
  const two = (state.status?.agents?.length ?? 0) > 1
  const remindersCard = h(
    'div',
    { class: 'card' },
    h('h2', { text: `定时提醒（${reminders.length}）` }),
    h('p', { class: 'muted', text: two ? '它自己定的闹钟：到点叫醒定它的那条线，带着当时记下的那句话。大脑重启不丢。' : '它自己定的闹钟：到点会叫醒它，带着当时记下的那句话。大脑重启不丢。' }),
    reminders.length === 0
      ? h('p', { class: 'muted', text: '现在没有提醒。' })
      : h(
          'ul',
          { class: 'plain' },
          reminders.map((r) =>
            h(
              'li',
              null,
              h('span', { class: 'muted', text: dateTime(r.dueAt) }),
              two ? h('span', { class: 'badge', title: r.line === 'work' ? '到点叫醒干活线' : '到点叫醒对话线', text: r.line === 'work' ? '干活线定的' : '对话线定的' }) : null,
              h('span', { class: 'grow', text: r.note }),
              button('删掉', { class: 'small danger' }, (btn) => {
                if (!confirm(`删掉这条提醒？\n${r.note}`)) return
                act(btn, () => api('DELETE', '/reminders', { id: r.id }), '已删掉').then(refresh)
              }),
            ),
          ),
        ),
  )
  put(el, h('div', { class: 'stack' }, historyCard, usageCard, remindersCard))
}

// ════════ 进出这一页 ════════

function show(tab) {
  current = tab
  // 头一次进这一块：数据到之前先写一句，不留白
  const target = root.querySelector(`[data-tab="${tab}"]`)
  if (target && target.childElementCount === 0) put(target, h('p', { class: 'muted loading', text: '正在取…' }))
  for (const pane of root.querySelectorAll('[data-tab]')) pane.hidden = pane.dataset.tab !== tab
  for (const b of root.querySelectorAll('.subtabs button')) b.setAttribute('aria-selected', String(b.dataset.id === tab))
  if (tab === 'models') loadModels()
  else if (tab === 'player' || tab === 'limits') loadBot()
  else if (tab === 'game') loadGame()
  else if (tab === 'panel') renderPassword()
  else if (tab === 'records') renderRecords(true)
}

export function enter(el, sub) {
  root = el
  // 同一页里换一块也会再进来一次：先把上一次接的通知退掉
  for (const off of unsubscribe) off()
  unsubscribe = []
  if (el.childElementCount === 0) {
    el.append(
      h('h1', { class: 'page-title', text: '设置' }),
      subTabs(TABS, current, (id) => (location.hash = `#settings/${id}`)),
      ...TABS.map((t) => h('div', { 'data-tab': t.id, hidden: true })),
    )
  }
  show(TABS.some((t) => t.id === sub) ? sub : current)
  unsubscribe = [
    bus.on('overview', () => {
      if (current === 'records') renderRecords()
      // “游戏里的它”那张卡跟着在线状态变；表单不动
      if (current === 'player' && botData && !playerDirty) {
        const old = root.querySelector('[data-live]')
        if (old) old.replaceWith(liveCard())
      }
    }),
    bus.on('status', () => {
      // 线从一条变两条（或者反过来）时，模型那块的选项要跟着变
      if (current === 'models' && editingModels === null && !root.contains(document.activeElement?.closest?.('select') ?? null)) {
        const n = state.status?.agents?.length ?? 0
        if (n !== renderModels.lines) {
          renderModels.lines = n
          renderModels()
        }
      }
    }),
  ]
}

export function leave() {
  for (const off of unsubscribe) off()
  unsubscribe = []
}
