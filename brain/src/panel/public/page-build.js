// “建造”页：盖东西用的资料。
//   草稿         它自己写程序设计出来的建筑，还只在大脑这边；看过觉得行再发布成游戏里的图纸
//   图纸         游戏服务器上的 .schematic 文件（要连着游戏）：查看、上传、删除、看要用的材料
//   图片         你传给它做像素画、当参考的图
//   多方块结构   一台多方块机器每个等级怎么搭（游戏里那个“投影”）
// 草稿和图纸用同一个查看器：能拖着转的三维预览（viewer3d.js）和大脑画的四种简图（它自己用 view_draft 看到的就是那种）。
// 多方块结构也有三维预览。

import { act, api, badge, button, empty, field, fileSize, fileToBase64, h, loadError, num, put, subTabs, toast, when } from './ui.js'
import { createViewer } from './viewer3d.js'

const TABS = [
  { id: 'drafts', label: '草稿' },
  { id: 'blueprints', label: '图纸' },
  { id: 'images', label: '图片' },
  { id: 'structures', label: '多方块结构' },
]

let root = null
let current = 'drafts'

const pane = (id) => root?.querySelector(`[data-tab="${id}"]`)
const sizeText = (s) => (s ? `${s.x}×${s.y}×${s.z}` : '')
const rgb = (c, shade = 1) => `rgb(${Math.round(c[0] * shade)}, ${Math.round(c[1] * shade)}, ${Math.round(c[2] * shade)})`

// ════════ 查看器：草稿和图纸共用 ════════

/**
 * 正在看的那一张：kind 是 draft（大脑这边的草稿）或 blueprint（游戏服务器上的图纸）；data 是服务器给的内容；
 * 现在怎么看（哪种图、站在哪个角或哪一面、第几层），三维预览的数据取过就留着。同时只看一张。
 */
let viewing = null
/** 三维预览（同时只有一个）。换一种看法、换一张、收起时关掉，把 WebGL 画布还回去。 */
let viewer3d = null

function closeViewer3d() {
  viewer3d?.destroy()
  viewer3d = null
}

/** 草稿的图的地址。图是大脑画的，和它（模型）用 view_draft 要到的是同一种；带上存盘时间，草稿重存以后图跟着换。 */
function draftPictureUrl(draft, params) {
  const q = new URLSearchParams({ name: draft.name, t: String(draft.savedAt ?? 0), ...params })
  return `/api/drafts/picture?${q}`
}

/** 看的是图纸的哪一块（图纸里的位置，从 0 数）：查看时服务器给的 box，之后的图、三维数据都照它要。 */
const boxParams = (box) => (box ? { x1: box.x1, x2: box.x2, y1: box.y1, y2: box.y2, z1: box.z1, z2: box.z2 } : {})

/** 图纸的图的地址：和草稿的同一种图（它用 view_draft 加 blueprint 看到的也是这种），带着这一份的版本号。 */
function blueprintPictureUrl(data, params) {
  const q = new URLSearchParams({ name: data.name, ...(data.version ? { v: data.version } : {}), ...boxParams(data.box), ...params })
  return `/api/blueprints/picture?${q}`
}

/** 两种东西在查看器里不一样的地方。 */
const KINDS = {
  draft: {
    box: '#draft-viewer',
    title: (d) => `草稿：${d.name}`,
    picture: draftPictureUrl,
    model: (d) => `/drafts/model?name=${encodeURIComponent(d.name)}`,
    layers: (d) => [0, d.size.y - 1],
  },
  blueprint: {
    box: '#bp-viewer',
    title: (d) => `图纸：${d.name}`,
    picture: blueprintPictureUrl,
    model: (d) => `/blueprints/model?${new URLSearchParams({ name: d.name, v: d.version ?? '', ...boxParams(d.box) })}`,
    layers: (d) => [d.box?.y1 ?? 0, d.box?.y2 ?? d.size.y - 1],
  },
}

function startViewing(kind, data) {
  closeViewer3d()
  // 另一边开着的查看器收起来（同时只看一张）
  if (viewing && viewing.kind !== kind) root?.querySelector(KINDS[viewing.kind].box)?.replaceChildren()
  const keep = viewing?.kind === kind && viewing.data.name === data.name ? viewing : null
  viewing = { kind, data, view: keep?.view ?? '3d', corner: keep?.corner ?? 0, side: keep?.side ?? 'south', layer: keep?.layer ?? KINDS[kind].layers(data)[0], model: null }
  renderViewer()
  root.querySelector(KINDS[kind].box)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

async function openDraft(name) {
  startViewing('draft', await api('GET', `/drafts/view?name=${encodeURIComponent(name)}`))
}

/** 打开一张图纸：大脑这时去游戏里读它（大的分几次读）。part：要看的那一块的起点（太大、一次看不完的图纸）。 */
async function openBlueprint(name, part = {}) {
  startViewing('blueprint', await api('GET', `/blueprints/view?${new URLSearchParams({ name, ...part })}`))
}

/** 图纸读不出来时的话：没连上游戏要说清楚。 */
function blueprintProblem(e) {
  return e.status === 503 ? `没连上游戏，图纸存在游戏服务器上，现在读不到。（${e.message}）` : e.status === 404 ? '这个版本的大脑还不会读图纸的格子。' : `没读到这张图纸：${e.message}`
}

/** 点了“查看”读不出来：原因留在查看器的位置上（不是一闪而过的提示），可以重试。 */
async function tryOpenBlueprint(name, btn, part = {}) {
  if (btn) btn.disabled = true
  try {
    await openBlueprint(name, part)
  } catch (e) {
    if (e.status === 401) return
    closeViewer3d()
    if (viewing?.kind === 'blueprint') viewing = null
    const box = root?.querySelector('#bp-viewer')
    if (box) {
      put(box, h('div', { class: 'card' }, h('h2', { text: `图纸：${name}` }), loadError(blueprintProblem(e), (retry) => tryOpenBlueprint(name, retry, part))))
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } else {
      toast(blueprintProblem(e), true)
    }
  } finally {
    if (btn) btn.disabled = false
  }
}

const VIEWS = { '3d': '三维（可以拖着转）', iso: '立体图', top: '俯视图', side: '立面图', layer: '一层层看' }
const ISO_CORNERS = [
  { from: 'southeast', label: '站在东南角看：左边是南面，右边是东面' },
  { from: 'southwest', label: '站在西南角看：左边是西面，右边是南面' },
  { from: 'northwest', label: '站在西北角看：左边是北面，右边是西面' },
  { from: 'northeast', label: '站在东北角看：左边是东面，右边是北面' },
]
const SIDE_VIEWS = { south: '从南面看（朝北）', west: '从西面看（朝东）', north: '从北面看（朝南）', east: '从东面看（朝西）' }

function swatch(color, title = '') {
  const dot = h('span', { class: 'swatch-dot', title })
  dot.style.backgroundColor = rgb(color)
  return dot
}

/** 一张太大、一次只看得了一块的图纸：写明看的是哪一块，能换一块。 */
function partChooser(data) {
  const { box, size, maxSide } = data
  const start = (axis) => h('input', { type: 'number', min: 0, max: size[axis] - 1, step: 1, value: box[`${axis}1`], 'aria-label': `从 ${axis} 第几格起`, class: 'narrow' })
  const x = start('x')
  const z = start('z')
  const go = button('看这一块', { class: 'small' }, (btn) => tryOpenBlueprint(data.name, btn, { x1: String(Math.max(0, Number(x.value) || 0)), z1: String(Math.max(0, Number(z.value) || 0)) }))
  return h(
    'div',
    { class: 'notice' },
    h('p', { text: `这张图纸东西向 ${size.x} 格、南北向 ${size.z} 格，一次最多看每边 ${maxSide} 格，现在看的是 x ${box.x1}–${box.x2}、y ${box.y1}–${box.y2}、z ${box.z1}–${box.z2} 这一块（从图纸最低的角 0 数起）。下面的方块和数量也只是这一块里的。` }),
    h('div', { class: 'row' }, h('span', { class: 'muted', text: '换一块：从 x' }), x, h('span', { class: 'muted', text: '、z' }), z, h('span', { class: 'muted', text: `起，各往东、往南 ${maxSide} 格` }), go),
  )
}

function renderViewer() {
  const v0 = viewing
  if (!v0) return
  const kind = KINDS[v0.kind]
  const box = root?.querySelector(kind.box)
  if (!box) return
  const { data } = v0
  const size = data.size
  const [lowest, highest] = kind.layers(data)
  v0.layer = Math.max(lowest, Math.min(highest, v0.layer))

  const materials = [...data.kinds].sort((a, b) => b.count - a.count)
  const unknown = materials.filter((k) => !k.colorKnown).length
  const byHand = materials.filter((k) => k.byHand)

  closeViewer3d()
  const stage3d = h('div')
  // 图是大脑画的：换一种看法就是换一个地址
  const picture = h('img', { class: 'draft-picture', alt: `${kind.title(data)} 的图`, hidden: v0.view === '3d' })
  const failed = h('p', { class: 'error', hidden: true })
  picture.addEventListener('error', async () => {
    // 图没出来：问一下原因（没连上游戏、图纸没了……），照实写出来
    failed.hidden = false
    failed.textContent = '这张图没画出来，换一种看法试试，或者刷新页面。'
    try {
      const res = await fetch(picture.src, { credentials: 'same-origin' })
      const why = (await res.json().catch(() => null))?.error?.message
      if (why) failed.textContent = `这张图没画出来：${why}`
    } catch {
      /* 连不上大脑：上面那句就够了 */
    }
  })
  picture.addEventListener('load', () => (failed.hidden = true))
  const controls = h('div', { class: 'row' })
  const show = async () => {
    const v = viewing
    if (v !== v0) return
    if (v.view === '3d') {
      // 方块数据取一次就够了，换别的看法再回来不用重取
      try {
        v.model ??= await api('GET', kind.model(data))
      } catch (e) {
        put(stage3d, h('p', { class: 'error', text: `三维预览的数据没取到：${v.kind === 'blueprint' ? blueprintProblem(e) : e.message}` }))
        return
      }
      if (viewing !== v || v.view !== '3d' || !stage3d.isConnected) return
      viewer3d = createViewer(stage3d, v.model)
      return
    }
    const params = { view: v.view }
    if (v.view === 'iso') params.from = ISO_CORNERS[v.corner].from
    if (v.view === 'side') params.from = v.side
    if (v.view === 'layer') params.layer = v.layer
    picture.src = kind.picture(data, params)
  }
  const viewSelect = h('select', { 'aria-label': '怎么看' }, Object.entries(VIEWS).map(([key, label]) => h('option', { value: key, text: label, selected: key === v0.view })))
  viewSelect.addEventListener('change', () => {
    v0.view = viewSelect.value
    renderViewer()
  })
  controls.append(viewSelect)
  if (v0.view === '3d') {
    controls.append(h('span', { class: 'muted', text: '用的是游戏里的贴图（有贴图的方块）。下面几种看法是大脑画的简图，它自己看到的是那种。' }))
  } else if (v0.view === 'iso') {
    const facing = h('span', { class: 'muted', text: ISO_CORNERS[v0.corner].label })
    controls.append(
      button('转一下', { class: 'small' }, () => {
        v0.corner = (v0.corner + 1) % ISO_CORNERS.length
        facing.textContent = ISO_CORNERS[v0.corner].label
        show()
      }),
      facing,
    )
  } else if (v0.view === 'side') {
    const sideSelect = h('select', { 'aria-label': '从哪一面看' }, Object.entries(SIDE_VIEWS).map(([key, label]) => h('option', { value: key, text: label, selected: key === v0.side })))
    sideSelect.addEventListener('change', () => {
      v0.side = sideSelect.value
      show()
    })
    controls.append(sideSelect, h('span', { class: 'muted', text: '远处的颜色暗一些。' }))
  } else if (v0.view === 'layer') {
    const where = h('span', { class: 'muted' })
    const slider = h('input', { type: 'range', min: lowest, max: highest, step: 1, value: v0.layer, 'aria-label': '看第几层' })
    const label = () => (where.textContent = `第 ${v0.layer - lowest + 1} / ${highest - lowest + 1} 层（从下往上数${lowest > 0 ? `，图纸里的 y=${v0.layer}` : ''}），上北下南，左西右东。`)
    // 拖的时候只改字，松手才换图（一层一张图）
    slider.addEventListener('input', () => {
      v0.layer = Number(slider.value)
      label()
    })
    slider.addEventListener('change', show)
    label()
    controls.append(slider, where)
  } else {
    controls.append(h('span', { class: 'muted', text: '从正上方看：上北下南，左西右东；高的地方亮一些。' }))
  }
  const closeBtn = button('收起', { class: 'small quiet' }, () => {
    closeViewer3d()
    viewing = null
    put(box)
    // 列表里“正在看”的那一行不再高亮
    for (const li of root.querySelectorAll('li.current')) li.classList.remove('current')
  })
  const facts = `东西向 ${size.x} 格 × 高 ${size.y} 格 × 南北向 ${size.z} 格，${num(data.blocks)} 个方块`
  const about =
    v0.kind === 'draft'
      ? `${facts}，${data.kinds.length} 种。${when(data.savedAt)} 存的。`
      : `${facts}，${(data.materials ?? data.kinds).length} 种。在游戏服务器上，打开时从游戏里读的。${data.reads > 1 ? `整张 ${num(data.cells)} 格，游戏一次最多给 ${num(data.readMax)} 格，分 ${data.reads} 次读完的。` : ''}`
  put(
    box,
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'fill', text: kind.title(data) }), v0.kind === 'blueprint' ? button('重新读', { class: 'small quiet', title: '图纸在游戏那边换过时，再读一次' }, (btn) => tryOpenBlueprint(data.name, btn, data.part ? { x1: String(data.box.x1), z1: String(data.box.z1) } : {})) : null, closeBtn),
      h('p', { class: 'muted', text: about }),
      data.part ? partChooser(data) : null,
      controls,
      stage3d,
      picture,
      failed,
      v0.view === '3d' ? null : h('p', { class: 'hint', text: '这是按方块颜色画的示意图，不是游戏里的样子：没有贴图，楼梯、栅栏这类只是画小一点。它（模型能看图时）看到的也是这种图。' }),
      h('h4', { text: data.part ? '这一块里的方块' : '要用的材料' }),
      h(
        'div',
        { class: 'items' },
        materials.map((k) =>
          h(
            'span',
            { class: `item${k.byHand ? ' by-hand' : ''}`, title: `${k.key}${k.byHand ? `\n它不放，留给人：${k.byHand}` : ''}` },
            swatch(k.color, k.colorKnown ? '' : '颜色表里没有这种方块，这个颜色只是用来区分'),
            ` ${k.name ?? k.key} × ${num(k.count)}`,
            k.byHand ? h('span', { class: 'warn', text: ' 要人手放' }) : null,
          ),
        ),
      ),
      byHand.length > 0 ? h('p', { class: 'hint', text: `有 ${byHand.length} 种它不放、留给人放（带内容或朝向的方块：箱子、楼梯、机器这类）。鼠标移上去看原因。` }) : null,
      unknown > 0 ? h('p', { class: 'hint', text: `有 ${unknown} 种方块不在颜色表里，图上给它们配的颜色只是用来区分，不是真实的颜色。` }) : null,
      data.program ? h('details', { class: 'fold' }, h('summary', { text: '生成它的程序' }), h('pre', { class: 'code', text: data.program })) : null,
    ),
  )
  // 放进页面以后再画：三维预览要量画布的大小
  show()
}

// ════════ 草稿（它自己设计的，还没发到游戏里）════════

async function loadDrafts() {
  try {
    renderDrafts(await api('GET', '/drafts'))
  } catch (e) {
    if (e.status !== 401) put(pane('drafts'), loadError(`拿不到草稿列表：${e.message}`, loadDrafts))
  }
}

function renderDrafts(data) {
  const el = pane('drafts')
  if (!el) return
  const list = data.drafts ?? []
  const row = (d) => {
    const viewBtn = button('查看', { class: 'small' }, () => act(viewBtn, () => openDraft(d.name)))
    const publishBtn = button('发布到游戏', { class: 'small' }, async () => {
      if (!confirm(`把草稿“${d.name}”发成游戏服务器上的图纸？同名的图纸会被覆盖。发了以后它就可以照着盖。`)) return
      const res = await act(publishBtn, () => api('POST', '/drafts/publish', { name: d.name }))
      if (res) toast(`已发布成图纸 ${res.saved?.name ?? d.name}`)
    })
    const delBtn = button('删除', { class: 'small danger' }, async () => {
      if (!confirm(`删除草稿“${d.name}”？已经发布到游戏里的图纸不受影响。`)) return
      const next = await act(delBtn, () => api('DELETE', '/drafts', { name: d.name }), `已删除 ${d.name}`)
      if (next) renderDrafts(next)
    })
    const thumb = h('img', { class: 'draft-thumb', src: draftPictureUrl(d, { plain: 1, size: 96 }), alt: '', loading: 'lazy' })
    thumb.addEventListener('click', () => act(viewBtn, () => openDraft(d.name)))
    return h(
      'li',
      { class: `with-thumb${viewing?.kind === 'draft' && viewing.data.name === d.name ? ' current' : ''}` },
      thumb,
      h('div', { class: 'grow' }, h('span', { class: 'mono', text: d.name })),
      h('span', { class: 'muted', title: '东西向（x）× 高（y）× 南北向（z）', text: `${sizeText(d.size)}，${num(d.blocks)} 个方块，${when(d.savedAt)}` }),
      viewBtn,
      publishBtn,
      delBtn,
    )
  }
  // 整块重画：先把开着的三维预览关掉，把 WebGL 画布还回去
  closeViewer3d()
  put(
    el,
    h(
      'div',
      { class: 'card' },
      h('h2', { text: `草稿（${list.length}）` }),
      h('p', { class: 'muted', text: '它自己写程序设计出来的建筑，现在还只在大脑这边，游戏里什么都没有。你看过觉得行，跟它说一声，或者在这里点“发布到游戏”。' }),
      list.length === 0 ? empty('还没有草稿', '可以让它“设计一个可爱的小屋”，或者传一张图片让它做像素画。') : h('ul', { class: 'plain' }, list.map(row)),
      h('p', { class: 'hint', text: `最多留 ${data.max ?? 40} 张。发布以后草稿还在，不要了再删。` }),
    ),
    h('div', { id: 'draft-viewer' }),
  )
  if (viewing?.kind !== 'draft') return
  if (list.some((d) => d.name === viewing.data.name)) renderViewer()
  else viewing = null
}

// ════════ 图纸：游戏服务器上的 ════════

async function loadBlueprints() {
  try {
    renderBlueprints(await api('GET', '/blueprints'))
  } catch (e) {
    // 图纸存在游戏服务器上，没连上游戏就看不到：把原因留在页面上，而不是一闪而过
    if (e.status !== 401) {
      closeViewer3d()
      if (viewing?.kind === 'blueprint') viewing = null
      put(pane('blueprints'), h('div', { class: 'card' }, loadError(`拿不到图纸列表：${e.message}`, loadBlueprints), h('p', { class: 'hint', text: '图纸存在游戏服务器上，要先连上游戏才能看和上传。草稿和图片在大脑这边，不用连游戏。' })))
    }
  }
}

/** 一张图纸要用的材料（/api/blueprints/read）。旧的后端没有这个接口时照实说。 */
async function showMaterials(name, box, btn) {
  if (box.childElementCount > 0) {
    put(box)
    btn.textContent = '看材料'
    return
  }
  let data
  try {
    data = await api('GET', `/blueprints/read?name=${encodeURIComponent(name)}&draft=0&cells=0`)
  } catch (e) {
    put(box, h('p', { class: 'error', text: e.status === 404 ? '这个版本的大脑还不会读图纸的内容。' : `没读到这张图纸：${e.message}` }))
    return
  }
  btn.textContent = '收起材料'
  const materials = data.materials ?? []
  const byHand = materials.filter((m) => m.byHand)
  put(
    box,
    h('p', { class: 'muted', text: `${sizeText(data.size)}，${num(data.blocks)} 个方块，${materials.length} 种。` }),
    h('div', { class: 'items' }, materials.map((m) => h('span', { class: `item${m.byHand ? ' by-hand' : ''}`, title: `${m.id}${m.meta ? `/${m.meta}` : ''}${m.byHand ? `\n它不放，留给人：${m.byHand}` : ''}` }, `${m.name ?? m.id} × ${num(m.count)}`, m.byHand ? h('span', { class: 'warn', text: ' 要人手放' }) : null))),
    byHand.length > 0 ? h('p', { class: 'hint', text: `有 ${byHand.length} 种它不放、留给人放（带内容或朝向的方块：箱子、楼梯、机器这类）。鼠标移上去看原因。` }) : null,
  )
}

function renderBlueprints(data) {
  const el = pane('blueprints')
  if (!el) return
  const list = data.blueprints ?? []
  const maxBytes = data.maxBytes ?? 2 * 1024 * 1024
  /** 一次最多看每边多少格（和草稿一样）；更宽的图纸查看时先看一块，没有小图。 */
  const maxSide = 256
  /** 游戏一次最多读多少格：读一次读不完的大图纸不画小图（读图纸占着游戏的主线程），点“查看”才读。 */
  const readMax = 262144

  // 上传
  const file = h('input', { id: 'bp-file', type: 'file', accept: '.schematic' })
  const name = h('input', { id: 'bp-name', type: 'text', maxLength: 80, placeholder: '选好文件后自动填上，可以改', spellcheck: false })
  const note = h('p', { class: 'hint', text: '还没选文件。' })
  const uploadBtn = h('button', { type: 'submit', class: 'primary', text: '上传', disabled: true })
  file.addEventListener('change', () => {
    const chosen = file.files?.[0]
    if (!chosen) {
      note.className = 'hint'
      note.textContent = '还没选文件。'
      uploadBtn.disabled = true
      return
    }
    name.value = chosen.name.replace(/\.schematic$/i, '')
    const problem = chosen.size === 0 ? '这个文件是空的。' : chosen.size > maxBytes ? `这个文件有 ${fileSize(chosen.size)}，图纸最大 ${fileSize(maxBytes)}。` : ''
    note.className = problem ? 'error' : 'hint'
    note.textContent = problem || `${chosen.name}，${fileSize(chosen.size)}。`
    uploadBtn.disabled = problem !== ''
  })
  const form = h('form', { class: 'card' })
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const chosen = file.files?.[0]
    const wanted = name.value.trim()
    if (!chosen || !wanted) {
      toast('先选一个 .schematic 文件，并给它一个名字', true)
      return
    }
    if (list.some((b) => b.name === wanted) && !confirm(`服务器上已经有一张叫“${wanted}”的图纸，用这个文件覆盖它？`)) return
    uploadBtn.disabled = true
    try {
      const next = await api('POST', '/blueprints', { name: wanted, data: await fileToBase64(chosen) })
      const saved = next.saved ?? {}
      toast(`已上传 ${saved.name ?? wanted}${saved.size ? `（${sizeText(saved.size)}，${num(saved.blocks)} 个方块）` : ''}`)
      renderBlueprints(next)
      // 正看着的那张被换掉了：重新读一遍，别留着旧的样子
      if (viewing?.kind === 'blueprint' && viewing.data.name === (saved.name ?? wanted)) tryOpenBlueprint(viewing.data.name)
    } catch (e) {
      // 文件不是能用的图纸时，原因留在表单上，而不是一闪而过的提示
      note.className = 'error'
      note.textContent = `没传上去：${e.message}`
      uploadBtn.disabled = false
    }
  })
  form.append(
    h('h2', { text: '上传图纸' }),
    h('p', { class: 'muted', text: `Schematica 导出的 .schematic 文件，最大 ${fileSize(maxBytes)}。传上去以后它就能照着盖；和已有的图纸同名会覆盖。` }),
    h('div', { class: 'fields' }, h('div', null, h('label', { for: 'bp-file', text: '文件' }), file, note), field('图纸名字', name, '它和你都用这个名字指这张图纸。')),
    h('div', { class: 'row' }, uploadBtn),
  )

  // 已有的
  const row = (b) => {
    const usable = b.error === undefined && b.size
    const materials = h('div', { class: 'field-wide' })
    const open = (btn) => tryOpenBlueprint(b.name, btn)
    const viewBtn = usable ? button('查看', { class: 'small' }, open) : null
    const materialsBtn = usable ? button('看材料', { class: 'small' }, (btn) => act(btn, () => showMaterials(b.name, materials, btn))) : null
    const delBtn = button('删除', { class: 'small danger' }, async () => {
      if (!confirm(`从游戏服务器上删除图纸“${b.name}”？`)) return
      const next = await act(delBtn, () => api('DELETE', '/blueprints', { name: b.name }), `已删除 ${b.name}`)
      if (next) renderBlueprints(next)
    })
    // 小图：大脑去游戏里读一次这张图纸画的，之后留在大脑的内存里；地址里带着尺寸和方块数，列表上这两样变了才重新读。
    // 一次读不完的大图纸、比 256 格宽的不画小图（开页面不该去读它们），写明点“查看”才读
    const big = usable && b.size.x * b.size.y * b.size.z > readMax
    const wide = usable && !big && Math.max(b.size.x, b.size.z) > maxSide
    let thumb = h('span', { class: 'draft-thumb' })
    if (usable && !big && !wide) {
      thumb = h('img', { class: 'draft-thumb', alt: '', loading: 'lazy', src: `/api/blueprints/picture?${new URLSearchParams({ name: b.name, plain: '1', size: '96', t: `${sizeText(b.size)}-${b.blocks}` })}` })
      thumb.addEventListener('click', () => open(viewBtn))
      // 小图没出来（游戏断了、图纸读不出来）：空着就好，点“查看”会说原因
      thumb.addEventListener('error', () => (thumb.style.visibility = 'hidden'))
    }
    return h(
      'li',
      { class: `wrap with-thumb${viewing?.kind === 'blueprint' && viewing.data.name === b.name ? ' current' : ''}` },
      thumb,
      h('div', { class: 'grow' }, h('span', { class: 'mono', text: b.name }), usable ? null : h('div', { class: 'error', text: `读不了：${b.error ?? '游戏那边没给出尺寸'}` })),
      big ? h('span', { class: 'hint', title: `${num(b.size.x * b.size.y * b.size.z)} 格，游戏一次最多读 ${num(readMax)} 格`, text: '大图纸，点“查看”才读' }) : null,
      wide ? h('span', { class: 'hint', text: `比 ${maxSide} 格宽，点“查看”一块块看` }) : null,
      usable ? h('span', { class: 'muted', title: '东西向（x）× 高（y）× 南北向（z）', text: `${sizeText(b.size)}，${num(b.blocks)} 个方块` }) : badge('读不了', 'bad'),
      viewBtn,
      materialsBtn,
      delBtn,
      materials,
    )
  }
  // 整块重画：先把开着的三维预览关掉，把 WebGL 画布还回去
  closeViewer3d()
  put(
    el,
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card' },
        h('h2', { text: `服务器上的图纸（${list.length}）` }),
        list.length === 0 ? empty('还没有图纸', '在下面上传一个 .schematic 文件，或者把它的草稿发布过来。') : h('ul', { class: 'plain' }, list.map(row)),
        h('p', { class: 'hint', text: `尺寸是 东西向（x）× 高（y）× 南北向（z）。点“查看”时大脑去游戏里读这张图纸，转着看三维、看它画的简图（它自己用 view_draft 看图纸也是这种图）。${data.folder ? `文件在游戏服务器的 ${data.folder} 里，直接放进去也行，不用重启。` : ''}盖的时候不旋转、不镜像。` }),
      ),
      h('div', { id: 'bp-viewer' }),
      form,
    ),
  )
  if (viewing?.kind !== 'blueprint') return
  if (list.some((b) => b.name === viewing.data.name)) renderViewer()
  else viewing = null
}

// ════════ 图片（给它做像素画、当参考）════════

async function loadImages() {
  try {
    renderImages(await api('GET', '/images'))
  } catch (e) {
    if (e.status !== 401) put(pane('images'), loadError(`拿不到图片列表：${e.message}`, loadImages))
  }
}

/** 浏览器这边把图缩到最长边不超过 maxSide，转成 PNG。本来就够小的原样画上去，不重新采样（像素图不会糊）。 */
async function shrinkToPng(file, maxSide) {
  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('这个文件浏览器认不出是图片')
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingEnabled = scale < 1
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const from = `${bitmap.width}×${bitmap.height}`
  bitmap.close?.()
  const url = canvas.toDataURL('image/png')
  return { data: url.slice(url.indexOf(',') + 1), width: canvas.width, height: canvas.height, from }
}

function renderImages(data) {
  const el = pane('images')
  if (!el) return
  const list = data.images ?? []
  const maxSide = data.maxSide ?? 256

  const file = h('input', { id: 'img-file', type: 'file', accept: 'image/*' })
  const name = h('input', { id: 'img-name', type: 'text', maxLength: 40, placeholder: '选好文件后自动填上，可以改', spellcheck: false })
  const note = h('p', { class: 'hint', text: '还没选文件。' })
  const uploadBtn = h('button', { type: 'submit', class: 'primary', text: '上传', disabled: true })
  let ready = null
  file.addEventListener('change', async () => {
    const chosen = file.files?.[0]
    ready = null
    uploadBtn.disabled = true
    if (!chosen) {
      note.className = 'hint'
      note.textContent = '还没选文件。'
      return
    }
    // 名字里只留字母、数字、汉字、下划线和连字符
    name.value = chosen.name.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^[_-]+/, '').slice(0, 40) || 'image'
    try {
      ready = await shrinkToPng(chosen, maxSide)
      note.className = 'hint'
      note.textContent = ready.from === `${ready.width}×${ready.height}` ? `${chosen.name}，${ready.width}×${ready.height} 像素。` : `${chosen.name}，原图 ${ready.from}，会缩成 ${ready.width}×${ready.height} 像素再传。`
      uploadBtn.disabled = false
    } catch (e) {
      note.className = 'error'
      note.textContent = e.message
    }
  })
  const form = h('form', { class: 'card' })
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const wanted = name.value.trim()
    if (!ready || !wanted) {
      toast('先选一张图片，并给它一个名字', true)
      return
    }
    if (list.some((i) => i.name === wanted) && !confirm(`已经有一张叫“${wanted}”的图片，用这张覆盖它？`)) return
    uploadBtn.disabled = true
    try {
      const next = await api('POST', '/images', { name: wanted, data: ready.data })
      toast(`已上传 ${next.saved?.name ?? wanted}`)
      renderImages(next)
    } catch (e) {
      note.className = 'error'
      note.textContent = `没传上去：${e.message}`
      uploadBtn.disabled = false
    }
  })
  form.append(
    h('h2', { text: '上传图片' }),
    h('p', { class: 'muted', text: `给它做像素画、或者当参考用的图。什么格式都行：浏览器会先把它缩到最长边 ${maxSide} 像素以内，再传给大脑。聊天里跟它说图片的名字就行。` }),
    h('div', { class: 'fields' }, h('div', null, h('label', { for: 'img-file', text: '文件' }), file, note), field('图片名字', name, '字母、数字、汉字、下划线和连字符。它和你都用这个名字指这张图。')),
    h('div', { class: 'row' }, uploadBtn),
  )

  const row = (i) => {
    const delBtn = button('删除', { class: 'small danger' }, async () => {
      if (!confirm(`删除图片“${i.name}”？`)) return
      const next = await act(delBtn, () => api('DELETE', '/images', { name: i.name }), `已删除 ${i.name}`)
      if (next) renderImages(next)
    })
    return h(
      'li',
      { class: 'with-thumb' },
      h('img', { class: 'thumb', alt: '', loading: 'lazy', src: `/api/images/file?name=${encodeURIComponent(i.name)}&t=${i.uploadedAt}` }),
      h('div', { class: 'grow' }, h('span', { class: 'mono', text: i.name })),
      h('span', { class: 'muted', text: `${i.width}×${i.height} 像素，${fileSize(i.bytes)}，${when(i.uploadedAt)}` }),
      delBtn,
    )
  }
  put(el, 
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'card' }, h('h2', { text: `图片（${list.length}）` }), list.length === 0 ? empty('还没有图片', '在下面传一张，然后跟它说“照 xx 这张图做个像素画”。') : h('ul', { class: 'plain' }, list.map(row)), h('p', { class: 'hint', text: `最多留 ${data.max ?? 30} 张，存在大脑的数据目录里。` })),
      form,
    ),
  )
}

// ════════ 多方块结构（游戏里那个“投影”：一台多方块机器每个等级怎么搭）════════

/** 正在看的那台机器的三维预览。 */
let structureViewer = null

async function loadStructures(query = '') {
  const el = pane('structures')
  let data
  try {
    data = await api('GET', `/structures?q=${encodeURIComponent(query)}`)
  } catch (e) {
    if (e.status !== 401) put(el, loadError(`拿不到多方块结构的名单：${e.message}`, () => loadStructures(query)))
    return
  }
  structureViewer?.destroy()
  structureViewer = null
  const search = h('input', { type: 'search', placeholder: '机器的名字，比如 蒸汽离心机', value: query, 'aria-label': '搜多方块机器' })
  const go = button('搜', {}, () => loadStructures(search.value))
  search.addEventListener('keydown', (e) => e.key === 'Enter' && loadStructures(search.value))
  const detail = h('div', { class: 'stack' })
  const list = h('div', { class: 'row machines' })
  for (const m of data.machines) {
    const b = button(`${m.name}${m.tiers.length > 1 ? `（${m.tiers.length} 级）` : ''}`, { class: 'small' }, () => {
      for (const other of list.children) other.setAttribute('aria-pressed', String(other === b))
      showStructure(detail, m, m.tiers[0])
    })
    list.append(b)
  }
  const hint = !data.available
    ? '大脑没有这份资料（packdata/structures.jsonl）。'
    : data.machines.length === 0
      ? '没有名字里含这几个字的多方块机器。'
      : `${data.total} 台多方块机器${data.total > data.machines.length ? `，这里列了前 ${data.machines.length} 台，搜名字缩小范围` : ''}。点一台看它怎么搭。`
  put(el, h('div', { class: 'card' }, h('h2', { text: '多方块结构' }), h('p', { class: 'muted', text: hint }), data.available ? h('div', { class: 'row nowrap' }, h('div', { class: 'fill' }, search), go) : null, list, detail))
}

async function showStructure(detail, machine, tier) {
  let data
  try {
    data = await api('GET', `/structures/model?id=${encodeURIComponent(machine.id)}&meta=${machine.meta}&tier=${tier}`)
  } catch (e) {
    put(detail, h('p', { class: 'error', text: `这台机器的结构没取到：${e.message}` }))
    return
  }
  structureViewer?.destroy()
  const tiers = h('div', { class: 'row' })
  for (const t of data.tiers) tiers.append(button(`${t} 级`, { class: 'small', 'aria-pressed': String(t === data.tier) }, () => showStructure(detail, machine, t)))
  const stage = h('div')
  const notes = [...data.info, ...data.structureInfo].filter((line) => !/^-{5,}$/.test(line.trim()))
  put(detail, 
    h('h3', { text: `${data.name}，${data.tier} 级（${sizeText(data.size)}，主机朝南）` }),
    data.tiers.length > 1 ? tiers : null,
    h('h4', { text: '材料' }),
    h('div', { class: 'items' }, data.blocks.map((b) => h('span', { class: 'item', title: b.id, text: `${b.name ?? b.id} × ${num(b.n)}` }))),
    stage,
    notes.length > 0 ? h('details', { class: 'fold' }, h('summary', { text: '机器自己的说明' }), h('pre', { class: 'code', text: notes.join('\n') })) : null,
  )
  structureViewer = createViewer(stage, data)
}

// ════════ 进出这一页 ════════

function show(tab) {
  current = tab
  // 头一次进这一块：数据到之前先写一句，不留白
  const target = root.querySelector(`[data-tab="${tab}"]`)
  if (target && target.childElementCount === 0) put(target, h('p', { class: 'muted loading', text: '正在取…' }))
  for (const p of root.querySelectorAll('[data-tab]')) p.hidden = p.dataset.tab !== tab
  for (const b of root.querySelectorAll('.subtabs button')) b.setAttribute('aria-selected', String(b.dataset.id === tab))
  if (tab === 'drafts') loadDrafts()
  else if (tab === 'blueprints') loadBlueprints()
  else if (tab === 'images') loadImages()
  else if (!pane('structures').querySelector('.card')) loadStructures()
}

export function enter(el, sub) {
  root = el
  if (el.childElementCount === 0) {
    el.append(h('h1', { class: 'page-title', text: '建造' }), subTabs(TABS, current, (id) => (location.hash = `#build/${id}`)), ...TABS.map((t) => h('div', { 'data-tab': t.id, hidden: true })))
  }
  show(TABS.some((t) => t.id === sub) ? sub : current)
}

export function leave() {
  // 离开这一页：把 WebGL 画布还回去（浏览器能开的有限）
  closeViewer3d()
  root?.querySelector('#draft-viewer')?.replaceChildren()
  root?.querySelector('#bp-viewer')?.replaceChildren()
  viewing = null
}
