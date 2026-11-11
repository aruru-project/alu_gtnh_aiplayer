// “知识 → 基地的做法”：这个基地怎么做东西的记录（GET/PUT/DELETE /api/methods）。主人在这里教它：
// 一类零件用哪种做法、什么当现成的不往下做、两种做法用料一样时用哪种、一样东西用哪条配方、
// 没有更具体的规矩时几种做法谁先谁后、哪台机器专门干什么。
// 它自己定过的也在这里，标着“它自己定的”。几种分开列；后端以后再加的种类，这里认不得也照样列出来（用后端给的那一行）。
// 写错的（做法名认不出、配方做不出那样东西）后端会拒，原话照实显示在表单下面。

import { act, api, badge, button, dateTime, empty, h, loadError, put, segmented, when } from './ui.js'

/** 矿辞前缀给人看的名字（GregTech 物品的中文名里去掉材料那一半）。 */
const PREFIX_NAMES = {
  ingot: '锭', ingotHot: '热锭', plate: '板', plateDouble: '双重板', plateTriple: '三重板', plateDense: '致密板', plateSuperdense: '超致密板',
  stick: '杆', stickLong: '长杆', screw: '螺丝', bolt: '螺栓', ring: '环', round: '滚珠', rotor: '转子', gearGt: '齿轮', gearGtSmall: '小型齿轮',
  spring: '弹簧', springSmall: '小型弹簧', foil: '箔', wireFine: '细导线', wireGt01: '1x导线', wireGt02: '2x导线', cableGt01: '1x线缆',
  dust: '粉', dustSmall: '小堆粉', dustTiny: '小撮粉', nugget: '粒', block: '块', gem: '宝石', lens: '透镜', frameGt: '框架',
  pipeTiny: '微型管道', pipeSmall: '小型管道', pipeMedium: '管道', pipeLarge: '大型管道', itemCasing: '外壳', turbineBlade: '涡轮扇叶',
}
const prefixLabel = (prefix) => PREFIX_NAMES[prefix] ?? prefix

/** 认得的几种：标题、说明、怎么画、怎么改。 */
const KINDS = [
  { kind: 'part', title: '一类零件', hint: '按矿辞前缀：这一类零件用哪种做法、从哪种料来。只管某种材料的比管一整类的优先。' },
  { kind: 'ready', title: '当现成的', hint: '这些东西拿现成的用，不往下做：算材料时到它就停，不再展开它的原料。可以是一类零件（矿辞前缀，比如 ingot 是所有的锭）、一个矿辞名（ingotSteel），或者一样物品。' },
  { kind: 'same', title: '同料时用哪种', hint: '两种做法都做得出一样东西、用的料也一样（工具不算料）时，用哪一种。可以限定只在用的那种不需要工具时才这样。' },
  { kind: 'order', title: '总的先后', hint: '没有更具体的规矩时，几种做法谁先谁后。只有一条。' },
  { kind: 'thing', title: '具体的东西', hint: '一样东西用哪一条配方。配方册重新导出以后编号会变，它记的是配方的样子，用的时候再对回现在的编号；对不回来的标成失效。' },
  { kind: 'machine', title: '机器的用途', hint: '某台机器专门干什么、进料和收货的箱子在哪、别动它的什么。' },
]
const KNOWN = new Set(KINDS.map((k) => k.kind))

/** 这一块的状态：后端给的、筛的条件、正在改哪一条（key；'new:<kind>' 是新加一条）、表单上的错。 */
const view = { data: null, who: '', query: '', editing: null, error: '' }
let el = null

export async function showMethods(pane) {
  el = pane
  await load()
}

async function load() {
  try {
    view.data = await api('GET', '/methods')
    render()
  } catch (e) {
    if (e.status !== 401) put(el, loadError(`基地的做法没取到：${e.message}`, load))
  }
}

/**
 * 这一条说的东西现在还找不找得到（配方册、物品表重新导出以后）：后端判断好了给 stale；
 * 没有配方册时后端不判断，这时看那一行里的英文说明（具体东西写 NO LONGER IN THE RECIPE BOOK，别的写 [NOT FOUND ANY MORE …]）。
 */
function staleOf(m) {
  if (typeof m.stale === 'boolean') return m.stale
  if (m.kind === 'thing' && m.recipeNow === null) return true
  return /NO LONGER IN THE RECIPE BOOK|\[NOT FOUND ANY MORE/.test(m.line ?? '')
}

/** 失效的那一条，找不到的是什么。 */
const STALE_WHAT = {
  thing: '配方册里找不到这条配方了',
  part: '这个做法现在的配方册里没有了',
  same: '其中一种做法现在的配方册里没有了',
  order: '有的做法现在的配方册里没有了',
  ready: '物品表里找不到它了',
}
const staleBadge = (m) => badge(`失效：${STALE_WHAT[m.kind] ?? '现在的资料里找不到了'}`, 'bad')

/** 矿辞名拆成前缀和材料：ingotSteel → [ingot, Steel]。 */
function splitOre(ore) {
  const m = /^([a-z][a-zA-Z]*?)([A-Z0-9].*)$/.exec(ore)
  if (!m) return [ore, '']
  // 前缀表里最长的那个（plateDense 不是 plate + DenseSteel）
  const known = Object.keys(PREFIX_NAMES).filter((p) => ore.startsWith(p) && /[A-Z0-9]/.test(ore.charAt(p.length))).sort((a, b) => b.length - a.length)[0]
  return known ? [known, ore.slice(known.length)] : [m[1], m[2]]
}
/** 现在对回的编号（不知道时用记下那时的）。 */
const recipeRefOf = (m) => (typeof m.recipeNow === 'number' ? m.recipeNow : m.recipe?.ref)

const posText = (p) => (p ? `(${p.x}, ${p.y}, ${p.z})` : '')

// ── 画 ──

function render() {
  if (!el || !view.data) return
  const data = view.data
  if (!data.available) return put(el, empty('这个大脑上没有“基地的做法”', '后端没提供这份存储。'))
  const all = data.entries ?? []
  const q = view.query.trim().toLowerCase()
  const shown = all.filter((m) => (!view.who || m.by === view.who) && (!q || textOf(m).toLowerCase().includes(q)))
  const stale = all.filter(staleOf)
  const who = segmented(
    [
      { value: '', label: '全部' },
      { value: 'owner', label: '你定的' },
      { value: 'self', label: '它自己定的' },
    ],
    view.who,
    (v) => {
      view.who = v
      render()
    },
    '谁定的',
  )
  const search = h('input', { id: 'methods-q', type: 'search', value: view.query, placeholder: '找：做法、零件、东西、坐标、理由……', 'aria-label': '在基地的做法里找' })
  search.addEventListener('input', () => {
    view.query = search.value
    const at = search.selectionStart
    render()
    const again = el.querySelector('#methods-q')
    again?.focus()
    again?.setSelectionRange(at, at)
  })
  const kinds = [...KINDS, ...[...new Set(all.map((m) => m.kind))].filter((k) => !KNOWN.has(k)).map((k) => ({ kind: k, title: k, hint: '这一种面板还不认得：照大脑给的那一行列出来，只能删。', unknown: true }))]
  put(
    el,
    h('p', { class: 'muted', text: `这个基地怎么做东西的记录：你教它的，和它自己定过的，一共 ${all.length} 条。它算一样东西要多少材料时照这些走（板用什么做、什么拿现成的不往下做、钢杆用哪条配方、哪台机器专门干什么），查做法、看机器时也会看到相关的那一条。在这里加的、改过的都算你定的，下一次用就是新的。` }),
    stale.length > 0 ? h('div', { class: 'notice warn', role: 'note' }, h('strong', { text: `有 ${stale.length} 条对不上了` }), h('span', { text: '：它们说的配方、做法或者物品，在现在这份配方册、物品表里找不到了（多半是重新导出过）。它用的时候会照实说这条失效了；你可以改一改，或者删掉。下面标红的就是。' })) : null,
    h('div', { class: 'row filters' }, who.el, search),
    kinds.map((k) => section(k, shown.filter((m) => m.kind === k.kind), all.filter((m) => m.kind === k.kind).length)),
  )
}

/** 一条里能拿来搜的字。 */
function textOf(m) {
  return [m.line, m.why, m.prefix && prefixLabel(m.prefix), m.prefix, m.material, m.way, m.from && prefixLabel(m.from), m.name, m.thing, m.text, m.use, m.over, m.kind === 'ready' && m.match !== 'item' ? prefixLabel(splitOre(m.text)[0]) : '', m.recipe?.wayName, m.recipe?.text, m.does, m.keep, ...(m.ways ?? []), m.x !== undefined ? `${m.x},${m.y},${m.z}` : ''].filter(Boolean).join(' ')
}

function section(k, list, total) {
  const adding = view.editing === `new:${k.kind}`
  const canAdd = !k.unknown && !(k.kind === 'order' && total > 0)
  const addBtn = canAdd && !adding ? button(k.kind === 'order' ? '写一条' : '加一条', { class: 'small' }, () => edit(`new:${k.kind}`)) : null
  return h(
    'section',
    { class: 'card methods', 'aria-label': k.title },
    h('div', { class: 'card-head' }, h('h2', null, k.title, h('span', { class: 'muted count-note', text: ` ${total}` })), addBtn),
    h('p', { class: 'hint', text: k.hint }),
    adding ? form(k.kind, null) : null,
    list.length === 0
      ? h('p', { class: 'muted', text: total === 0 ? (k.kind === 'order' ? '还没定。' : '还没有。') : '筛掉了。' })
      : h('ul', { class: 'mlist' }, list.map((m) => h('li', { class: `method${staleOf(m) ? ' stale' : ''}` }, view.editing === m.key ? form(k.kind, m) : entryView(m, k)))),
  )
}

async function edit(key) {
  const m = view.data?.entries?.find((x) => x.key === key)
  // 记的是一类东西（ore:plateSteel）的：在配方的产物里找名字对得上的那一样，表单里先填上它的 id
  if (m?.kind === 'thing' && /^(ore|any):/.test(m.thing) && !m.pickedItem) {
    const outs = (m.recipe?.out ?? []).map(([k]) => k)
    try {
      const names = (await api('GET', `/items/names?q=${encodeURIComponent(outs.join(','))}`)).names ?? {}
      m.pickedItem = outs.find((k) => names[k] === m.name) ?? outs[0]
    } catch {
      m.pickedItem = outs[0]
    }
  }
  view.editing = key
  view.error = ''
  render()
  el.querySelector('.method-form input, .method-form textarea')?.focus()
}

function entryView(m, k) {
  const views = { part: partView, ready: readyView, same: sameView, order: orderView, thing: thingView, machine: machineView }
  const main = views[m.kind]?.(m) ?? h('div', { class: 'm-main mono', text: m.line ?? m.key })
  const editBtn = k.unknown ? null : button('改', { class: 'small', disabled: view.editing !== null }, () => edit(m.key))
  const delBtn = button('删', { class: 'small danger', disabled: view.editing !== null }, async (btn) => {
    if (!confirm(`从基地的做法里删掉这一条？\n${summaryOf(m)}`)) return
    const res = await act(btn, () => api('DELETE', '/methods', { key: m.key }), '已删掉')
    if (res) load()
  })
  return [
    main,
    h(
      'div',
      { class: 'm-meta' },
      m.by === 'owner' ? badge('你定的', 'ok') : h('span', { class: 'badge self', text: '它自己定的' }),
      h('span', { class: 'muted', title: dateTime(m.at), text: m.at ? when(m.at) : '' }),
      m.why ? h('span', { class: 'm-why' }, h('span', { class: 'muted', text: '理由：' }), m.why) : h('span', { class: 'faint', text: '没写理由' }),
    ),
    h('div', { class: 'm-actions' }, editBtn, delBtn),
  ]
}

function partView(m) {
  return h(
    'div',
    { class: 'm-main' },
    h('strong', { text: prefixLabel(m.prefix) }),
    h('span', { class: 'mono faint', text: ` ${m.prefix}` }),
    m.material ? [h('span', { class: 'muted', text: '，只管 ' }), h('span', { class: 'mono', text: m.material })] : h('span', { class: 'muted', text: '（所有材料）' }),
    h('span', { class: 'arrow', text: ' ← ' }),
    h('span', { class: 'm-way', text: m.way }),
    m.from ? [h('span', { class: 'muted', text: '，从' }), h('strong', { text: prefixLabel(m.from) }), h('span', { class: 'mono faint', text: ` ${m.from}` }), h('span', { class: 'muted', text: ' 来' })] : null,
    staleOf(m) ? [' ', staleBadge(m)] : null,
  )
}

function orderView(m) {
  return h('div', { class: 'm-main m-order' }, m.ways.map((w, n) => [n > 0 ? h('span', { class: 'faint', text: ' › ' }) : null, h('span', { class: 'm-way', text: w })]), staleOf(m) ? staleBadge(m) : null)
}

/** 当现成的：一类零件（前缀）、一个矿辞名、一样物品。 */
function readyView(m) {
  let what
  if (m.match === 'prefix') what = [h('strong', { text: `${prefixLabel(m.text)}` }), h('span', { class: 'mono faint', text: ` ${m.text}` }), h('span', { class: 'muted', text: '（这一类全部）' })]
  else if (m.match === 'ore') {
    const [prefix, material] = splitOre(m.text)
    what = [h('strong', { class: 'mono', text: m.text }), h('span', { class: 'muted', text: `（${prefixLabel(prefix)}${material ? `，材料 ${material}` : ''}；一个矿辞名）` })]
  } else what = [h('strong', { text: m.name ?? m.text }), h('span', { class: 'mono faint', text: ` ${m.text}${m.meta !== undefined ? `/${m.meta}` : '（任何 meta）'}` })]
  return h('div', { class: 'm-main' }, what, h('span', { class: 'arrow', text: ' → ' }), h('span', { class: 'm-ready', text: '当现成的，不往下做' }), staleOf(m) ? [' ', staleBadge(m)] : null)
}

/** 同料时用哪种：用 use，不用 over。 */
function sameView(m) {
  return h(
    'div',
    { class: 'm-main' },
    h('span', { class: 'muted', text: '用料一样时用 ' }),
    h('span', { class: 'm-way', text: m.use }),
    h('span', { class: 'muted', text: '，不用 ' }),
    h('span', { class: 'm-way over', text: m.over }),
    m.noTools ? h('span', { class: 'chip', title: `${m.use}那条配方要用工具时（锤子、锉刀这类）不算，照别的规矩走`, text: `只在${m.use}不用工具时` }) : null,
    staleOf(m) ? [' ', staleBadge(m)] : null,
  )
}

function thingView(m) {
  const stale = staleOf(m)
  const r = m.recipe ?? {}
  return h(
    'div',
    { class: 'm-main' },
    h('strong', { text: m.name || m.thing }),
    h('span', { class: 'mono faint', title: '这样东西在记录里的写法', text: ` ${m.thing}` }),
    h('span', { class: 'arrow', text: ' ← ' }),
    h('span', { class: 'm-way', text: r.wayName ?? r.way }),
    stale ? staleBadge(m) : h('span', { class: 'mono muted', title: typeof m.recipeNow === 'number' && m.recipeNow !== r.ref ? `记下时是 #${r.ref}` : '配方编号', text: ` #${recipeRefOf(m)}` }),
    h('div', { class: 'm-recipe' }, stale ? h('span', { class: 'muted', text: `记下时是 #${r.ref}：` }) : null, r.text),
  )
}

function machineView(m) {
  const rows = [
    m.feed ? ['进料', posText(m.feed)] : null,
    m.collect ? ['收货', posText(m.collect)] : null,
    m.keep ? ['别动', m.keep] : null,
  ].filter(Boolean)
  return h(
    'div',
    { class: 'm-main' },
    h('strong', { text: m.name ?? '机器' }),
    h('span', { class: 'mono muted', text: ` ${posText(m)}${m.dim !== undefined && m.dim !== 0 ? ` 维度 ${m.dim}` : ''}` }),
    h('div', { class: 'm-does', text: m.does }),
    rows.length > 0 ? h('div', { class: 'm-sub' }, rows.map(([k, v]) => h('span', null, h('span', { class: 'muted', text: `${k} ` }), v))) : null,
  )
}

/** 删之前问的那一句里写的。 */
function summaryOf(m) {
  if (m.kind === 'part') return `${prefixLabel(m.prefix)}${m.material ? `（${m.material}）` : ''} ← ${m.way}`
  if (m.kind === 'ready') return `${m.match === 'item' ? (m.name ?? m.text) : m.text} 当现成的`
  if (m.kind === 'same') return `用料一样时用${m.use}，不用${m.over}${m.noTools ? `（只在${m.use}不用工具时）` : ''}`
  if (m.kind === 'order') return m.ways.join(' › ')
  if (m.kind === 'thing') return `${m.name} ← ${m.recipe?.wayName ?? ''} ${m.recipe?.text ?? ''}`
  if (m.kind === 'machine') return `${m.name ?? '机器'} ${posText(m)}：${m.does}`
  return m.line ?? m.key
}

// ── 改一条、加一条 ──

const input = (id, value, attrs = {}) => h('input', { id, type: 'text', value: value ?? '', autocomplete: 'off', spellcheck: false, ...attrs })
const fieldOf = (label, control, hint, wide) => h('div', { class: wide ? 'field-wide' : 'field' }, h('label', { for: control.id, text: label }), control, hint ? h('p', { class: 'hint', text: hint }) : null)

/** "x y z" 或 "x, y, z" → {x,y,z}；空的是 undefined；写错是 null。 */
function parsePos(text) {
  const t = text.trim()
  if (!t) return undefined
  const nums = t.replace(/[()（）]/g, '').split(/[\s,，]+/).filter(Boolean).map(Number)
  return nums.length === 3 && nums.every(Number.isInteger) ? { x: nums[0], y: nums[1], z: nums[2] } : null
}

function form(kind, m) {
  const isNew = m === null
  const why = h('textarea', { id: 'mf-why', rows: 2, maxLength: 200, value: m?.why ?? '', placeholder: '为什么这么定（一句话；它看得到）' })
  let fields
  let body
  if (kind === 'part') {
    const prefix = input('mf-prefix', m?.prefix, { required: true, placeholder: 'plate' })
    const material = input('mf-material', m?.material, { placeholder: '不填 = 所有材料' })
    const way = input('mf-way', m?.way, { required: true, placeholder: '卷板机' })
    const from = input('mf-from', m?.from, { placeholder: 'ingot' })
    const named = h('span', { class: 'muted' })
    const paint = () => (named.textContent = prefix.value.trim() ? `= ${prefixLabel(prefix.value.trim())}` : '')
    prefix.addEventListener('input', paint)
    paint()
    fields = [
      h('div', { class: 'field' }, h('label', { for: 'mf-prefix' }, '哪一类零件（矿辞前缀） ', named), prefix, h('p', { class: 'hint', text: '物品矿辞名里材料前面那一段：plateSteel 的 plate、stick、screw、wireGt01。' })),
      fieldOf('只管哪种材料', material, '矿辞名后面那一半，比如 Steel。不填就管这一类全部。'),
      fieldOf('用哪种做法', way, '配方页的名字，和 NEI 里一样：卷板机、车床、有序合成……'),
      fieldOf('从哪种料来', from, '另一个矿辞前缀，比如 ingot。不填就用这种做法里列在最前的那条。'),
    ]
    body = () => ({ part: prefix.value.trim(), way: way.value.trim(), ...(material.value.trim() ? { material: material.value.trim() } : {}), ...(from.value.trim() ? { from: from.value.trim() } : {}) })
  } else if (kind === 'ready') {
    const text = input('mf-ready', m ? `${m.text}${m.meta !== undefined ? `/${m.meta}` : ''}` : '', { required: true, placeholder: 'ingot、ingotSteel 或 minecraft:stone/0' })
    fields = [fieldOf('什么当现成的', text, '写一个矿辞前缀（ingot：所有的锭）、一个矿辞名（ingotSteel：钢锭）或者一样物品的 id（minecraft:stone/0；不写 /meta 是任何 meta）。物品栏里点一格能看到 id。', true)]
    body = () => ({ ready: text.value.trim() })
  } else if (kind === 'same') {
    const use = input('mf-use', m?.use, { required: true, placeholder: '有序合成' })
    const over = input('mf-over', m?.over, { required: true, placeholder: '组装机' })
    const noTools = h('input', { id: 'mf-notools', type: 'checkbox', checked: m?.noTools === true })
    const label = h('span')
    const paint = () => (label.textContent = ` 只在${use.value.trim() || '用的那种'}的配方不用工具时才这样`)
    use.addEventListener('input', paint)
    paint()
    fields = [
      fieldOf('用这一种', use, '配方页的名字，和 NEI 里一样。'),
      fieldOf('不用这一种', over, '另一种做法的名字。'),
      h('div', { class: 'field-wide' }, h('label', { class: 'check' }, noTools, label), h('p', { class: 'hint', text: '工具指锤子、锉刀、扳手这类不会用掉的。勾上以后，用的那种要工具时这条不算。' })),
    ]
    body = () => ({ use: use.value.trim(), over: over.value.trim(), ...(noTools.checked ? { noTools: true } : {}) })
  } else if (kind === 'order') {
    const ways = h('textarea', { id: 'mf-ways', rows: 4, required: true, value: (m?.ways ?? []).join('\n'), placeholder: '卷板机\n车床\n有序合成' })
    fields = [fieldOf('做法，先用的在前', ways, '一行一个，写配方页的名字。', true)]
    body = () => ({ order: ways.value.split(/[\n›>]+/).map((w) => w.trim()).filter(Boolean) })
  } else if (kind === 'thing') {
    // 记录里的东西可能是一类（ore:plateSteel）：改的时候拿配方的第一样产物当它
    const [id0, meta0] = thingItem(m)
    const isFluid = m?.thing?.startsWith('fluid:')
    const what = h('select', { id: 'mf-what' }, h('option', { value: 'item', text: '物品', selected: !isFluid }), h('option', { value: 'fluid', text: '流体', selected: isFluid }))
    const id = input('mf-id', isFluid ? '' : id0, { placeholder: 'gregtech:gt.metaitem.01' })
    const meta = h('input', { id: 'mf-meta', type: 'number', min: 0, value: isFluid ? '' : (meta0 ?? ''), placeholder: '0' })
    const fluid = input('mf-fluid', isFluid ? m.thing.slice(6) : '', { placeholder: 'molten.steel' })
    const recipe = h('input', { id: 'mf-recipe', type: 'number', min: 0, required: true, value: m && !staleOf(m) ? (recipeRefOf(m) ?? '') : '', placeholder: '配方编号' })
    const itemBox = h('div', { class: 'fields' }, fieldOf('物品 id', id, '物品栏里点那一格能看到 id。'), fieldOf('损害值（meta）', meta, '不填是 0。'))
    const fluidBox = fieldOf('流体', fluid, '流体的注册名（括号里那个），或者名字。')
    const swap = () => {
      itemBox.hidden = what.value !== 'item'
      fluidBox.hidden = what.value !== 'fluid'
    }
    what.addEventListener('change', swap)
    swap()
    fields = [
      fieldOf('是物品还是流体', what),
      h('div', { class: 'field-wide' }, itemBox, fluidBox),
      fieldOf('用哪条配方（编号）', recipe, m && staleOf(m) ? `原来那条（#${m.recipe.ref}）现在找不到了：${m.recipe.text}。换成现在的编号。` : '它查做法时每条配方前面的 #编号（find_recipes 给的）。配方册重新导出以后编号会变，记下的是配方的样子。'),
    ]
    body = () => (what.value === 'fluid' ? { fluid: fluid.value.trim(), recipe: Number(recipe.value) } : { id: id.value.trim(), ...(meta.value !== '' ? { meta: Number(meta.value) } : {}), recipe: Number(recipe.value) })
  } else {
    const at = input('mf-at', m ? `${m.x} ${m.y} ${m.z}` : '', { required: true, placeholder: '-510 70 84' })
    const does = input('mf-does', m?.does, { required: true, maxLength: 300, placeholder: '只做钢板' })
    const feed = input('mf-feed', m?.feed ? `${m.feed.x} ${m.feed.y} ${m.feed.z}` : '', { placeholder: '进料的箱子' })
    const collect = input('mf-collect', m?.collect ? `${m.collect.x} ${m.collect.y} ${m.collect.z}` : '', { placeholder: '收货的箱子' })
    const keep = input('mf-keep', m?.keep, { maxLength: 300, placeholder: '别拆侧面的覆盖板' })
    fields = [
      fieldOf('机器在哪（x y z）', at),
      fieldOf('它专门干什么', does, undefined),
      fieldOf('进料的容器（x y z）', feed, '可以不填。'),
      fieldOf('收货的容器（x y z）', collect, '可以不填。'),
      fieldOf('别动它的什么', keep, '可以不填。', true),
    ]
    body = () => {
      const machine = parsePos(at.value)
      const f = parsePos(feed.value)
      const c = parsePos(collect.value)
      if (!machine || f === null || c === null) throw new Error('坐标写三个整数，比如 -510 70 84')
      return { machine, does: does.value.trim(), ...(f ? { feed: f } : {}), ...(c ? { collect: c } : {}), ...(keep.value.trim() ? { keep: keep.value.trim() } : {}) }
    }
  }
  const save = h('button', { type: 'submit', class: 'primary', text: isNew ? '记下' : '保存' })
  const cancel = button('取消', {}, () => {
    view.editing = null
    view.error = ''
    render()
  })
  const error = h('p', { class: 'error', role: 'alert', hidden: !view.error, text: view.error })
  const f = h('form', { class: 'method-form' }, h('div', { class: 'fields' }, fields, fieldOf('理由', why, m && m.by === 'self' ? '这一条原来是它自己定的；你保存以后算你定的。' : '', true)), error, h('div', { class: 'row' }, save, cancel))
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    let payload
    try {
      payload = { ...body(), why: why.value.trim() }
    } catch (e) {
      error.textContent = e.message
      error.hidden = false
      return
    }
    save.disabled = true
    try {
      const res = await api('PUT', '/methods', payload)
      // 改了它的键（换了前缀、材料、坐标、东西）：新的记下了，旧的那条删掉
      if (m && res.entry?.key && res.entry.key !== m.key) await api('DELETE', '/methods', { key: m.key })
      view.editing = null
      view.error = ''
      await load()
    } catch (e) {
      if (e.status === 401) return
      // 后端的原话（和它用工具时看到的是同一句，英文）
      view.error = `没记上：${e.message}`
      error.textContent = view.error
      error.hidden = false
    } finally {
      save.disabled = false
    }
  })
  return f
}

/** 一条“具体的东西”记的是哪样物品：键是 id/meta 的就是它；是一类（ore:…）的，拿配方的第一样产物。 */
function thingItem(m) {
  if (!m?.thing) return ['', '']
  const key = m.thing.startsWith('ore:') || m.thing.startsWith('any:') ? (m.pickedItem ?? m.recipe?.out?.[0]?.[0] ?? '') : m.thing
  const cut = key.lastIndexOf('/')
  return cut > 0 ? [key.slice(0, cut), key.slice(cut + 1)] : [key, '']
}
