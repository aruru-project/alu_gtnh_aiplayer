// Static analyses only. Native English fields stay intact; no solve or world-action button here.
import { api, badge, button, dateTime, empty, h, kv, loadError, put } from './ui.js'

const STATES = {
  satisfied: '满足计算目标', 'needs-external-supply': '需持续外部供料', 'requires-forced-flow': '依赖图外补料或排料', unmet: '目标或约束未满足',
  infeasible: '不可行', unanchored: '缺少有效目标', invalid: '输入未通过检查', failed: '计算失败',
  rejected: '输入被拒绝', calculated: '已计算，需看条件',
}
const SECTIONS = [
  ['machines', '机器数量'], ['energy', '运行功率与蒸汽'], ['goals', '目标'], ['flows', '物料流'], ['shortfalls', '短缺'],
  ['externalInputs', '外部输入'], ['externalOutputs', '外部输出'], ['diagnostics', '诊断'],
  ['assumptions', '假设与边界'], ['provenance', '配方来源'], ['nodes', '原版节点'],
  ['project', '原始计划'], ['native', '完整原版报告'], ['record', '完整分析记录'],
]
const number = (value) => typeof value === 'number' && Number.isFinite(value)
  ? value.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—'
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const array = (value) => Array.isArray(value) ? value : []
const statusText = (value) => STATES[value] ?? value ?? '尚未判断'
const tone = (value) => value === 'satisfied' ? 'good' : ['failed', 'invalid', 'rejected', 'infeasible', 'unmet'].includes(value) ? 'bad' : 'warn'
let generation = 0

function json(value) { return h('pre', { class: 'production-json', text: JSON.stringify(value, null, 2) }) }
function details(value, label = '完整原始字段') {
  return h('details', {}, h('summary', { text: label }), json(value))
}
function machineRows(items) {
  if (!items.length) return empty('这一页没有机器', '计算失败、没有运行节点或分页到末尾时，这里为空。')
  return h('div', { class: 'table-scroll' }, h('table', { class: 'production-table' },
    h('thead', {}, h('tr', {}, ...['节点 / 共享组', '连续负载', '建造台数', '平均 EU/t', '完整参数'].map((text) => h('th', { text })))),
    h('tbody', {}, ...items.map((item) => {
      const row = object(item)
      return h('tr', {}, h('td', {}, h('code', { text: row.nodeId ?? '—' }), row.shared ? h('div', { class: 'muted', text: '共享机台，按合计负载取整' }) : null),
        h('td', { text: number(row.fractionalMachines) }), h('td', { text: number(row.buildMachines) }),
        h('td', { text: number(row.averageEuT ?? row.euT) }), h('td', {}, details(item, '查看运行功率、蒸汽及原版字段')))
    }))))
}
function energyRows(items) {
  const totals = items.find((item) => object(item).kind === 'totals')
  const machines = items.filter((item) => object(item).kind === 'machine')
  return h('div', {},
    totals ? h('p', { class: 'muted', text: `原版总 EU/t：${number(totals.totalEuT)}（Build 模式是名牌值）；实际平均与整数机台满速需求分别列示。` }) : null,
    machines.length ? h('div', { class: 'table-scroll' }, h('table', { class: 'production-table' },
      h('thead', {}, h('tr', {}, ...['节点', '平均 EU/t', '满速 EU/t', '平均汽 mB/s', '满速汽 mB/s', '原版参数'].map((text) => h('th', { text })))),
      h('tbody', {}, ...machines.map((item) => {
        const row = object(item), energy = object(row.energy)
        return h('tr', {}, h('td', {}, h('code', { text: row.nodeId })),
          h('td', { text: number(energy.averageEuT) }), h('td', { text: number(energy.buildPeakEuT) }),
          h('td', { text: number(energy.averageSteamMbPerSecond) }), h('td', { text: number(energy.buildPeakSteamMbPerSecond) }),
          h('td', {}, details(item, '电压、安培与机型条件')))
      })))) : empty('这一页没有机组能耗', '完整原版参数仍可在分析记录中查看。'))
}
function entries(items, section) {
  if (section === 'machines') return machineRows(items)
  if (section === 'energy') return energyRows(items)
  if (!items.length) return empty('这一页没有条目', '无条目不代表方案可行；请看上方状态、目标和诊断。')
  return h('div', { class: 'production-entries' }, ...items.map((item) => {
    const row = object(item)
    if (section === 'flows' && row.kind === 'edge') {
      const flow = object(row.data), resource = object(flow.resource)
      return h('article', { class: 'card production-entry' }, h('strong', { text: `${row.id} · ${resource.displayName ?? resource.resourceId ?? resource.key ?? '物料'}` }),
        kv([['流量', `${number(flow.transferredPerSecond)} ${resource.kind === 'fluid' ? 'mB/s' : 'item/s'}`], ['限制', flow.constraint ?? '—']]), details(item))
    }
    if ('path' in row) return h('div', { class: 'production-entry' }, h('code', { text: row.path || '/' }), json(row.value))
    return h('div', { class: 'production-entry' }, typeof item === 'string' ? h('p', { text: item }) : json(item))
  }))
}
function pagination(data, load) {
  return h('div', { class: 'production-pagination' },
    button('上一页', { class: 'small', disabled: data.offset <= 0 }, () => load(Math.max(0, data.offset - data.limit))),
    h('span', { class: 'muted', text: `第 ${data.total ? data.offset + 1 : 0}–${data.offset + data.items.length} 条 / 共 ${data.total} 条` }),
    button('下一页', { class: 'small', disabled: !data.more }, () => load(data.nextOffset)))
}

export function showProduction(el, selectedId) {
  const own = ++generation
  let listRequest = 0, detailRequest = 0
  const listing = h('div'), report = h('div', { class: 'production-report' })
  const current = () => own === generation && el.isConnected
  put(el,
    h('div', { class: 'section-head' }, h('h2', { text: '产线规划' }), button('刷新', { class: 'small' }, () => showProduction(el, selectedId))),
    h('p', { class: 'muted', text: '这里查看她自主构图、计算和修改后留下的分析，不要求你先画图。原版英文计划和结果原样保存；这些是静态预测，不是施工图，也不证明现场机器、库存、电力或管线已经满足。' }),
    h('div', { class: `production-layout${selectedId ? ' has-selected' : ''}` }, listing, report))
  if (!selectedId) put(report, empty('选择一份分析', '可让她比较不同配方、机型、产出目标和资源约束。每次计算保存新记录，不覆盖以前的方案。'))

  async function loadList(offset = 0) {
    const ticket = ++listRequest
    put(listing, h('p', { class: 'muted', text: '正在读取分析目录…' }))
    try {
      const data = await api('GET', `/production?offset=${offset}&limit=15`)
      if (!current() || ticket !== listRequest) return
      put(listing, ...data.items.map((item) => {
        const status = item.status ?? object(item.explanation).status ?? item.outcome
        return h('a', { class: `card production-link${selectedId === item.id ? ' selected' : ''}`, href: `#knowledge/production:${encodeURIComponent(item.id)}` },
          h('strong', { text: item.namePreview ?? item.id }), item.namePreviewTruncated ? h('small', { class: 'muted', text: '名称预览；完整名称见原始计划' }) : null,
          h('div', {}, badge(statusText(status), tone(status))), h('small', { class: 'muted', text: dateTime(item.createdAt) }),
          item.parentId ? h('small', { class: 'muted', text: `基于 ${item.parentId}` }) : null)
      }), data.items.length ? pagination(data, loadList) : empty('还没有产线分析', '她可以从本地配方开始直接构图和计算，不需要游戏客户端或主人先导入方案。'))
    } catch (error) {
      if (current() && ticket === listRequest && error.status !== 401) put(listing, loadError(`分析目录没读到：${error.message}`, () => loadList(offset)))
    }
  }

  async function loadReport(section = 'machines', offset = 0) {
    const ticket = ++detailRequest
    put(report, h('p', { class: 'muted', text: '正在读取分析…' }))
    try {
      const data = await api('GET', `/production/record?id=${encodeURIComponent(selectedId)}&section=${encodeURIComponent(section)}&offset=${offset}&limit=25`)
      if (!current() || ticket !== detailRequest) return
      const summary = data.summary
      const select = h('select', { 'aria-label': '分析内容', onchange: (event) => loadReport(event.target.value, 0) },
        ...SECTIONS.map(([value, text]) => h('option', { value, text, selected: value === section })))
      const incomplete = array(summary.unmetGoals).length + array(summary.shortfalls).length
      const forced = array(summary.forcedFlows).length
      put(report,
        h('div', { class: 'section-head' }, h('h3', { text: '静态分析' }), badge(statusText(summary.status), tone(summary.status))),
        h('p', { class: 'muted', text: `${summary.id} · ${dateTime(summary.createdAt)}` }),
        kv([['未满足目标 / 短缺记录', String(incomplete)], ['图外强制补料 / 排料', String(forced)],
          ['外部输入记录', String(array(summary.externalInputs).length)], ['平均 EU/t', number(summary.averageEuT)],
          ['整数设备满速 EU/t', number(summary.buildPeakEuT)],
          ['平均蒸汽 mB/s', number(summary.averageSteamMbPerSecond)], ['整数设备满速蒸汽 mB/s', number(summary.buildPeakSteamMbPerSecond)],
          ['诊断记录', String(array(summary.issues).length)], ['假设 / 边界', String(array(summary.assumptions).length)]]),
        forced ? h('p', { class: 'production-warning', text: '原版求解使用了图外补料或排料。目标数字达到不等于供料及副产物去向已经解决；请查看外部输入、短缺和诊断。' }) : null,
        summary.error ? h('p', { class: 'production-warning', text: `${summary.error.code}: ${summary.error.message}` }) : null,
        h('p', { class: 'muted', text: '物品按 item/s、流体按 mB/s（1 GT L = 1 mB）。平均耗电不是整数机台的运行供电容量；蒸汽、运行功率和机型条件请看机器完整参数。外部流的不同原版视图不可重复相加。' }),
        h('div', { class: 'production-actions' }, select,
          h('a', { class: 'button small', href: `/api/production/export?id=${encodeURIComponent(selectedId)}`, text: '下载完整分析 JSON' }),
          h('a', { class: 'button small', href: `/api/production/export?id=${encodeURIComponent(selectedId)}&format=project`, text: '下载原始计划 JSON' })),
        entries(data.items, section), pagination(data, (next) => loadReport(section, next)))
    } catch (error) {
      if (current() && ticket === detailRequest && error.status !== 401) put(report, loadError(`分析没读到：${error.message}`, () => loadReport(section, offset)))
    }
  }
  void loadList()
  if (selectedId) void loadReport()
}
