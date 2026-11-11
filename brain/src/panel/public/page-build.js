// “建造”页：盖东西用的资料。
//   草稿         它自己写程序设计出来的建筑，还只在大脑这边；看过觉得行再发布成游戏里的图纸
//   图纸         游戏服务器上的 .schematic 文件（要连着游戏）：上传、删除、看要用的材料
//   图片         你传给它做像素画、当参考的图
//   多方块结构   一台多方块机器每个等级怎么搭（游戏里那个“投影”）
// 草稿和多方块结构有能拖着转的三维预览（viewer3d.js）。

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

// ════════ 草稿（它自己设计的，还没发到游戏里）════════

/** 正在看的那张草稿：服务器给的内容，现在怎么看（哪种图、站在哪个角或哪一面、第几层）。 */
let draftView = null
/** 草稿的三维预览（同时只有一个）。换一种看法、换一张草稿、收起时关掉，把 WebGL 画布还回去。 */
let draftViewer3d = null

function closeDraftViewer3d() {
  draftViewer3d?.destroy()
  draftViewer3d = null
}

async function loadDrafts() {
  try {
    renderDrafts(await api('GET', '/drafts'))
  } catch (e) {
    if (e.status !== 401) put(pane('drafts'), loadError(`拿不到草稿列表：${e.message}`, loadDrafts))
  }
}

/** 草稿的图的地址。图是大脑画的，和它（模型）用 view_draft 要到的是同一种；带上存盘时间，草稿重存以后图跟着换。 */
function draftPictureUrl(draft, params) {
  const q = new URLSearchParams({ name: draft.name, t: String(draft.savedAt ?? 0), ...params })
  return `/api/drafts/picture?${q}`
}

async function openDraft(name) {
  const data = await api('GET', `/drafts/view?name=${encodeURIComponent(name)}`)
  closeDraftViewer3d()
  draftView = { data, view: '3d', corner: 0, side: 'south', layer: 0, model: null }
  renderDraftViewer()
  root.querySelector('#draft-viewer')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
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
      { class: `with-thumb${draftView?.data.name === d.name ? ' current' : ''}` },
      thumb,
      h('div', { class: 'grow' }, h('span', { class: 'mono', text: d.name })),
      h('span', { class: 'muted', title: '东西向（x）× 高（y）× 南北向（z）', text: `${sizeText(d.size)}，${num(d.blocks)} 个方块，${when(d.savedAt)}` }),
      viewBtn,
      publishBtn,
      delBtn,
    )
  }
  // 整块重画：先把开着的三维预览关掉，把 WebGL 画布还回去
  closeDraftViewer3d()
  put(el, 
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
  if (draftView && list.some((d) => d.name === draftView.data.name)) renderDraftViewer()
  else draftView = null
}

const DRAFT_VIEWS = { '3d': '三维（可以拖着转）', iso: '立体图', top: '俯视图', side: '立面图', layer: '一层层看' }
const DRAFT_CORNERS = [
  { from: 'southeast', label: '站在东南角看：左边是南面，右边是东面' },
  { from: 'southwest', label: '站在西南角看：左边是西面，右边是南面' },
  { from: 'northwest', label: '站在西北角看：左边是北面，右边是西面' },
  { from: 'northeast', label: '站在东北角看：左边是东面，右边是北面' },
]
const DRAFT_SIDES = { south: '从南面看（朝北）', west: '从西面看（朝东）', north: '从北面看（朝南）', east: '从东面看（朝西）' }

function swatch(color, title = '') {
  const dot = h('span', { class: 'swatch-dot', title })
  dot.style.backgroundColor = rgb(color)
  return dot
}

function renderDraftViewer() {
  const box = root?.querySelector('#draft-viewer')
  if (!box || !draftView) return
  const { data } = draftView
  const size = data.size
  draftView.layer = Math.max(0, Math.min(size.y - 1, draftView.layer))

  const materials = [...data.kinds].sort((a, b) => b.count - a.count)
  const unknown = materials.filter((k) => !k.colorKnown).length

  closeDraftViewer3d()
  const stage3d = h('div')
  // 图是大脑画的：换一种看法就是换一个地址
  const picture = h('img', { class: 'draft-picture', alt: `草稿 ${data.name} 的图`, hidden: draftView.view === '3d' })
  const failed = h('p', { class: 'error', hidden: true, text: '这张图没画出来，换一种看法试试，或者刷新页面。' })
  picture.addEventListener('error', () => (failed.hidden = false))
  picture.addEventListener('load', () => (failed.hidden = true))
  const controls = h('div', { class: 'row' })
  const show = async () => {
    const v = draftView
    if (v.view === '3d') {
      // 方块数据取一次就够了，换别的看法再回来不用重取
      try {
        v.model ??= await api('GET', `/drafts/model?name=${encodeURIComponent(data.name)}`)
      } catch (e) {
        put(stage3d, h('p', { class: 'error', text: `三维预览的数据没取到：${e.message}` }))
        return
      }
      if (draftView !== v || v.view !== '3d' || !stage3d.isConnected) return
      draftViewer3d = createViewer(stage3d, v.model)
      return
    }
    const params = { view: v.view }
    if (v.view === 'iso') params.from = DRAFT_CORNERS[v.corner].from
    if (v.view === 'side') params.from = v.side
    if (v.view === 'layer') params.layer = v.layer
    picture.src = draftPictureUrl(data, params)
  }
  const viewSelect = h('select', { 'aria-label': '怎么看' }, Object.entries(DRAFT_VIEWS).map(([key, label]) => h('option', { value: key, text: label, selected: key === draftView.view })))
  viewSelect.addEventListener('change', () => {
    draftView.view = viewSelect.value
    renderDraftViewer()
  })
  controls.append(viewSelect)
  if (draftView.view === '3d') {
    controls.append(h('span', { class: 'muted', text: '用的是游戏里的贴图（有贴图的方块）。下面几种看法是大脑画的简图，它自己看到的是那种。' }))
  } else if (draftView.view === 'iso') {
    const facing = h('span', { class: 'muted', text: DRAFT_CORNERS[draftView.corner].label })
    controls.append(
      button('转一下', { class: 'small' }, () => {
        draftView.corner = (draftView.corner + 1) % DRAFT_CORNERS.length
        facing.textContent = DRAFT_CORNERS[draftView.corner].label
        show()
      }),
      facing,
    )
  } else if (draftView.view === 'side') {
    const sideSelect = h('select', { 'aria-label': '从哪一面看' }, Object.entries(DRAFT_SIDES).map(([key, label]) => h('option', { value: key, text: label, selected: key === draftView.side })))
    sideSelect.addEventListener('change', () => {
      draftView.side = sideSelect.value
      show()
    })
    controls.append(sideSelect, h('span', { class: 'muted', text: '远处的颜色暗一些。' }))
  } else if (draftView.view === 'layer') {
    const where = h('span', { class: 'muted' })
    const slider = h('input', { type: 'range', min: 0, max: size.y - 1, step: 1, value: draftView.layer, 'aria-label': '看第几层' })
    const label = () => (where.textContent = `第 ${draftView.layer + 1} / ${size.y} 层（从下往上数），上北下南，左西右东。`)
    // 拖的时候只改字，松手才换图（一层一张图）
    slider.addEventListener('input', () => {
      draftView.layer = Number(slider.value)
      label()
    })
    slider.addEventListener('change', show)
    label()
    controls.append(slider, where)
  } else {
    controls.append(h('span', { class: 'muted', text: '从正上方看：上北下南，左西右东；高的地方亮一些。' }))
  }
  const closeBtn = button('收起', { class: 'small quiet' }, () => {
    closeDraftViewer3d()
    draftView = null
    put(box)
  })
  put(box, 
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'fill', text: `草稿：${data.name}` }), closeBtn),
      h('p', { class: 'muted', text: `东西向 ${size.x} 格 × 高 ${size.y} 格 × 南北向 ${size.z} 格，${num(data.blocks)} 个方块，${data.kinds.length} 种。${when(data.savedAt)} 存的。` }),
      controls,
      stage3d,
      picture,
      failed,
      draftView.view === '3d' ? null : h('p', { class: 'hint', text: '这是按方块颜色画的示意图，不是游戏里的样子：没有贴图，楼梯、栅栏这类只是画小一点。它（模型能看图时）看到的也是这种图。' }),
      h('h4', { text: '要用的材料' }),
      h('div', { class: 'items' }, materials.map((k) => h('span', { class: 'item', title: k.key }, swatch(k.color, k.colorKnown ? '' : '颜色表里没有这种方块，这个颜色只是用来区分'), ` ${k.name ?? k.key} × ${num(k.count)}`))),
      unknown > 0 ? h('p', { class: 'hint', text: `有 ${unknown} 种方块不在颜色表里，图上给它们配的颜色只是用来区分，不是真实的颜色。` }) : null,
      data.program ? h('details', { class: 'fold' }, h('summary', { text: '生成它的程序' }), h('pre', { class: 'code', text: data.program })) : null,
    ),
  )
  // 放进页面以后再画：三维预览要量画布的大小
  show()
}

// ════════ 图纸：游戏服务器上的 ════════

async function loadBlueprints() {
  try {
    renderBlueprints(await api('GET', '/blueprints'))
  } catch (e) {
    // 图纸存在游戏服务器上，没连上游戏就看不到：把原因留在页面上，而不是一闪而过
    if (e.status !== 401) put(pane('blueprints'), h('div', { class: 'card' }, loadError(`拿不到图纸列表：${e.message}`, loadBlueprints), h('p', { class: 'hint', text: '图纸存在游戏服务器上，要先连上游戏才能看和上传。草稿和图片在大脑这边，不用连游戏。' })))
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
  put(box, 
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
    const materialsBtn = usable ? button('看材料', { class: 'small' }, (btn) => act(btn, () => showMaterials(b.name, materials, btn))) : null
    const delBtn = button('删除', { class: 'small danger' }, async () => {
      if (!confirm(`从游戏服务器上删除图纸“${b.name}”？`)) return
      const next = await act(delBtn, () => api('DELETE', '/blueprints', { name: b.name }), `已删除 ${b.name}`)
      if (next) renderBlueprints(next)
    })
    return h(
      'li',
      { class: 'wrap' },
      h('div', { class: 'grow' }, h('span', { class: 'mono', text: b.name }), usable ? null : h('div', { class: 'error', text: `读不了：${b.error ?? '游戏那边没给出尺寸'}` })),
      usable ? h('span', { class: 'muted', title: '东西向（x）× 高（y）× 南北向（z）', text: `${sizeText(b.size)}，${num(b.blocks)} 个方块` }) : badge('读不了', 'bad'),
      materialsBtn,
      delBtn,
      materials,
    )
  }
  put(el, 
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card' },
        h('h2', { text: `服务器上的图纸（${list.length}）` }),
        list.length === 0 ? empty('还没有图纸', '在下面上传一个 .schematic 文件，或者把它的草稿发布过来。') : h('ul', { class: 'plain' }, list.map(row)),
        h('p', { class: 'hint', text: `尺寸是 东西向（x）× 高（y）× 南北向（z）。${data.folder ? `文件在游戏服务器的 ${data.folder} 里，直接放进去也行，不用重启。` : ''}盖的时候不旋转、不镜像。` }),
      ),
      form,
    ),
  )
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
  for (const p of root.querySelectorAll('[data-tab]')) p.hidden = p.dataset.tab !== tab
  for (const b of root.querySelectorAll('.subtabs button')) b.setAttribute('aria-selected', String(b.dataset.id === tab))
  if (tab === 'drafts') loadDrafts()
  else if (tab === 'blueprints') loadBlueprints()
  else if (tab === 'images') loadImages()
  else if (pane('structures').childElementCount === 0) loadStructures()
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
  closeDraftViewer3d()
  root?.querySelector('#draft-viewer')?.replaceChildren()
  draftView = null
}
