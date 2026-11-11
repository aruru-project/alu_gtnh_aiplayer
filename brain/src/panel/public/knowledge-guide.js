// “知识 → 指南”：整合包带的游戏内指南（玩家在游戏里按 G 看到的那本），只读。
// 左边是一本书的目录（按 parent 搭成树）或者搜到的页，右边读一页。读到的是大脑读成字以后的正文，
// 和它用 read_guide 读到的是同一份：物品是“中文名 [id/meta]”，配方框、立体图、图片各是一句“游戏里这里是什么”。
// 页间链接（book:path）点了就跳；地址里带着这一页（#knowledge/guide:<页>），浏览器的后退能回到上一页。

import { linkTarget, parseBlocks, parseInline, plainText, slugOf } from './markdown.js'
import { api, badge, empty, h, loadError, put } from './ui.js'

/** 这一块的状态：几本书、看的哪本书和它的目录、正在读的页、搜的词和结果、目录里展开了哪些。 */
const view = { books: null, book: null, list: null, path: null, page: null, english: false, query: '', hits: null, scope: 'book', open: new Set(), error: null }
let el = null
/** 这次要跳到的小节（链接里 # 后面的）。 */
let pendingAnchor = null

const ALERTS = { NOTE: ['说明', 'note'], TIP: ['提示', 'tip'], IMPORTANT: ['重要', 'important'], WARNING: ['警告', 'warning'], CAUTION: ['小心', 'caution'] }
const LANGS = { zh_cn: '中文', en_us: '英文' }

/** 一页在地址里的写法。 */
export const guideHash = (path, anchor) => `#knowledge/guide:${encodeURIComponent(anchor ? `${path}#${anchor}` : path)}`

/** 进这一块。arg 是地址里 guide: 后面的（一页，可以带 #小节）；没有就停在上次看的地方。 */
export async function showGuide(pane, arg) {
  el = pane
  if (arg) {
    const at = arg.indexOf('#')
    const path = at >= 0 ? arg.slice(0, at) : arg
    pendingAnchor = at >= 0 ? arg.slice(at + 1) : null
    if (path !== view.path || !view.page) await openPage(path)
    else scrollToAnchor()
  }
  if (!view.books) await loadBooks()
  else render()
}

async function loadBooks() {
  try {
    const data = await api('GET', '/guide')
    view.books = data
    if (data.available && !view.book) await chooseBook(view.page?.book ?? data.books.find((b) => b.book === 'gregtech')?.book ?? data.books[0]?.book)
    else render()
  } catch (e) {
    if (e.status !== 401) put(el, loadError(`指南没取到：${e.message}`, loadBooks))
  }
}

async function chooseBook(book) {
  if (!book) return render()
  try {
    const data = await api('GET', `/guide?book=${encodeURIComponent(book)}`)
    view.book = book
    view.list = data.list ?? []
    // 顶上的那几页先展开
    for (const p of view.list) if (!p.parent) view.open.add(p.path)
    if (!view.path || !view.list.some((p) => p.path === view.path)) {
      const first = view.list.find((p) => !p.parent) ?? view.list[0]
      if (first && !view.page) return void (location.hash = guideHash(first.path))
    }
    render()
  } catch (e) {
    if (e.status !== 401) put(el, loadError(`这本书的目录没取到：${e.message}`, () => chooseBook(book)))
  }
}

async function openPage(path, english = false) {
  try {
    const page = await api('GET', `/guide/page?path=${encodeURIComponent(path)}${english ? '&english=1' : ''}`)
    view.path = path
    view.page = page
    view.english = english
    view.error = null
    // 目录换到这一页的书，展开它上面的几层
    if (view.book !== page.book) {
      view.book = page.book
      const data = await api('GET', `/guide?book=${encodeURIComponent(page.book)}`)
      view.list = data.list ?? []
      for (const p of view.list) if (!p.parent) view.open.add(p.path)
    }
    for (const p of ancestors(path)) view.open.add(p.path)
    loadItemNames(page)
  } catch (e) {
    if (e.status === 401) return
    view.path = path
    view.page = null
    view.error = e.status === 404 ? `指南里没有这一页（${path}）` : `这一页没取到：${e.message}`
  }
  render()
  // 换了一页：跳到要的小节；没有的话，正文的开头已经滚出去了才滚回来
  if (!scrollToAnchor()) {
    const article = el?.querySelector('.guide-page')
    if (article && article.getBoundingClientRect().top < 0) article.scrollIntoView({ block: 'start' })
  }
}

/** 一页上面的几层（从顶上往下）。 */
function ancestors(path) {
  const byPath = new Map((view.list ?? []).map((p) => [p.path, p]))
  const out = []
  let p = byPath.get(byPath.get(path)?.parent)
  while (p && out.length < 20) {
    out.unshift(p)
    p = byPath.get(p.parent)
  }
  return out
}

/** 这一页讲的物品的名字（页上列着）：一次问完。 */
const itemNames = new Map()
async function loadItemNames(page) {
  const keys = (page.items ?? []).map((it) => `${it.id}/${it.meta ?? firstMeta(it.metas)}`).filter((k) => !itemNames.has(k))
  if (keys.length === 0) return
  try {
    const names = (await api('GET', `/items/names?q=${encodeURIComponent(keys.slice(0, 100).join(','))}`)).names ?? {}
    for (const k of keys) itemNames.set(k, names[k] ?? null)
    if (view.page === page) render()
  } catch {
    /* 名字没问到就写 id */
  }
}
const firstMeta = (metas) => {
  const m = metas?.[0]
  return Array.isArray(m) ? m[0] : (m ?? 0)
}

async function search(q) {
  view.query = q
  if (!q.trim()) {
    view.hits = null
    return render()
  }
  try {
    const params = new URLSearchParams({ q, limit: '60' })
    if (view.scope === 'book' && view.book) params.set('book', view.book)
    view.hits = await api('GET', `/guide/search?${params}`)
  } catch (e) {
    if (e.status !== 401) view.hits = { q, matched: 0, hits: [], error: e.message }
  }
  render()
}

// ── 画 ──

function render() {
  if (!el) return
  const data = view.books
  if (!data) return put(el, h('p', { class: 'muted loading', text: '正在取…' }))
  if (!data.available) return put(el, empty('这个大脑没有游戏内指南的资料', '本地资料里的 guide.jsonl 没导出（见 docs/PACKDATA.md 的“游戏内指南”）。'))
  // 保住搜索框的焦点和光标
  const active = document.activeElement?.id === 'guide-q' ? document.activeElement.selectionStart : null
  put(
    el,
    h('p', { class: 'muted', text: `整合包带的游戏内指南（玩家在游戏里按 G 看到的那本）：${data.books.length} 本书、${data.pages} 页。这里给的是大脑读成字以后的样子，和它用 read_guide 读到的一样：物品写成“名字 [id]”，图、配方框、立体场景各是一句说明。` }),
    h('div', { class: 'split guide' }, sideColumn(), pageColumn()),
  )
  if (active !== null) {
    const q = el.querySelector('#guide-q')
    q?.focus()
    q?.setSelectionRange(active, active)
  }
}

function sideColumn() {
  const books = view.books.books
  const pick = h('select', { 'aria-label': '哪一本书' }, books.map((b) => h('option', { value: b.book, selected: b.book === view.book, text: `${b.title}（${b.pages} 页${b.englishOnly > 0 ? `，${b.englishOnly} 页只有英文` : ''}）` })))
  pick.addEventListener('change', () => {
    view.path = null
    view.page = null
    chooseBook(pick.value).then(() => view.hits && search(view.query))
  })
  const q = h('input', { id: 'guide-q', type: 'search', value: view.query, placeholder: '找：几个词用空格隔开', 'aria-label': '在指南里找', autocomplete: 'off' })
  let timer
  q.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => search(q.value), 300)
  })
  const scope = h('select', { 'aria-label': '在哪里找' }, h('option', { value: 'book', text: '这本书', selected: view.scope === 'book' }), h('option', { value: 'all', text: '全部书', selected: view.scope === 'all' }))
  scope.addEventListener('change', () => {
    view.scope = scope.value
    if (view.query.trim()) search(view.query)
  })
  return h('div', { class: 'guide-side' }, pick, h('div', { class: 'row guide-search' }, q, scope), view.hits ? hitList() : tree())
}

function hitList() {
  const r = view.hits
  if (r.error) return h('p', { class: 'error', text: r.error })
  if (r.hits.length === 0) return empty('没找到', '换个词，或者在“全部书”里找。')
  const WHY = { 3: '标题', 2: '讲的物品', 1: '正文' }
  return h(
    'div',
    null,
    h('p', { class: 'hint', text: `找到 ${r.matched} 页${r.matched > r.hits.length ? `，列了前 ${r.hits.length} 页` : ''}。` }),
    h(
      'ul',
      { class: 'picks guide-hits', 'aria-label': '找到的页' },
      r.hits.map((hit) =>
        h(
          'li',
          null,
          h(
            'a',
            { class: 'pick', href: guideHash(hit.path), 'aria-current': String(hit.path === view.path) },
            h('span', { class: 'pick-title' }, h('span', { text: hit.title }), hit.lang === 'en_us' ? badge('英文') : null, h('span', { class: 'muted small', text: `对上的是${WHY[hit.score] ?? '正文'}` })),
            hit.snippet ? h('span', { class: 'pick-sub', text: plainText(hit.snippet) }) : null,
            view.scope === 'all' ? h('span', { class: 'pick-sub mono', text: hit.book }) : null,
          ),
        ),
      ),
    ),
  )
}

/** 目录：一本书的页按 parent 搭成树；有下一级的能展开收起。 */
function tree() {
  const list = view.list ?? []
  if (list.length === 0) return empty('这本书是空的')
  const children = new Map()
  for (const p of list) {
    const key = p.parent && list.some((x) => x.path === p.parent) ? p.parent : ''
    if (!children.has(key)) children.set(key, [])
    children.get(key).push(p)
  }
  const branch = (key, depth) =>
    h(
      'ul',
      { class: depth === 0 ? 'gtree' : 'gtree-sub', role: depth === 0 ? 'tree' : 'group', 'aria-label': depth === 0 ? '目录' : undefined },
      (children.get(key) ?? []).map((p) => {
        const kids = children.get(p.path) ?? []
        const open = view.open.has(p.path)
        const toggle = kids.length > 0 ? h('button', { type: 'button', class: 'gtoggle', 'aria-label': open ? '收起' : '展开', 'aria-expanded': String(open), text: open ? '▾' : '▸' }) : h('span', { class: 'gtoggle', 'aria-hidden': 'true' })
        toggle.addEventListener?.('click', () => {
          if (open) view.open.delete(p.path)
          else view.open.add(p.path)
          render()
        })
        return h(
          'li',
          { role: 'treeitem', 'aria-expanded': kids.length > 0 ? String(open) : undefined },
          h('div', { class: 'gnode' }, toggle, h('a', { href: guideHash(p.path), 'aria-current': p.path === view.path ? 'page' : undefined, text: p.title }), p.lang === 'en_us' ? h('span', { class: 'glang', title: '这一页只有英文', text: '英' }) : null, kids.length > 0 ? h('span', { class: 'gcount', text: String(kids.length) }) : null),
          kids.length > 0 && open ? branch(p.path, depth + 1) : null,
        )
      }),
    )
  return h('nav', { class: 'gtree-wrap', 'aria-label': `${view.books.books.find((b) => b.book === view.book)?.title ?? ''}的目录` }, branch('', 0))
}

function pageColumn() {
  if (view.error) return h('div', { class: 'card detail guide-page' }, empty(view.error, '点左边目录里的一页。'))
  const page = view.page
  if (!page) return h('div', { class: 'card detail guide-page' }, empty('点左边目录里的一页', ''))
  const blocks = parseBlocks(page.text)
  // 正文开头常常就是标题本身：不重复
  if (blocks[0]?.type === 'heading' && blocks[0].text.trim() === page.title.trim()) blocks.shift()
  const crumbs = ancestors(page.path)
  const langSwitch = page.english
    ? h('a', { class: 'small', href: '#', text: view.english ? '看中文' : '看英文原文' })
    : null
  langSwitch?.addEventListener('click', (ev) => {
    ev.preventDefault()
    openPage(page.path, !view.english)
  })
  const sections = (page.sections ?? []).filter((s) => s.level <= 2 && s.title.trim() !== page.title.trim())
  const items = page.items ?? []
  return h(
    'article',
    { class: 'card detail guide-page', 'aria-label': page.title },
    crumbs.length > 0 ? h('nav', { class: 'gcrumbs', 'aria-label': '在目录里的位置' }, crumbs.map((c) => [h('a', { href: guideHash(c.path), text: c.title }), h('span', { class: 'faint', text: ' › ' })])) : null,
    h('div', { class: 'row gtitle' }, h('h2', { class: 'fill', text: page.title }), page.lang === 'en_us' ? badge(view.english ? '英文原文' : '只有英文', 'warn') : null, langSwitch),
    h('p', { class: 'hint mono', text: [page.path, page.author ? `作者 ${page.author}` : '', page.date ?? ''].filter(Boolean).join(' · ') }),
    items.length > 0
      ? h(
          'p',
          { class: 'gitems' },
          h('span', { class: 'muted', text: '这一页讲的：' }),
          items.slice(0, 24).map((it) => {
            const key = `${it.id}/${it.meta ?? firstMeta(it.metas)}`
            return h('span', { class: 'chip', title: `${it.id}${it.meta !== undefined ? `/${it.meta}` : it.metas ? ` ${JSON.stringify(it.metas)}` : ''}`, text: itemNames.get(key) ?? it.id.split(':').pop() })
          }),
          items.length > 24 ? h('span', { class: 'muted', text: ` 等 ${items.length} 样` }) : null,
        )
      : null,
    sections.length >= 3 ? h('nav', { class: 'gtoc', 'aria-label': '这一页的小节' }, sections.map((s) => h('a', { href: guideHash(page.path, slugOf(s.title)), class: s.level > 1 ? 'sub' : '', text: s.title }))) : null,
    h('div', { class: 'gbody' }, renderBlocks(blocks, page)),
    (page.children ?? []).length > 0
      ? h('div', { class: 'gkids' }, h('h3', { text: '下一级' }), h('ul', { class: 'plain' }, page.children.map((c) => h('li', null, h('a', { href: guideHash(c.path), text: c.title }), c.lang === 'en_us' ? h('span', { class: 'glang', text: '英' }) : null))))
      : null,
  )
}

/** 跳到地址里写的那一小节（按锚点对，对不上再按标题字对）。跳到了返回 true。 */
function scrollToAnchor() {
  if (!pendingAnchor || !el) return false
  const want = pendingAnchor
  pendingAnchor = null
  const heads = [...el.querySelectorAll('.gbody [data-slug]')]
  const target = heads.find((x) => x.dataset.slug === want) ?? heads.find((x) => x.dataset.slug === slugOf(want)) ?? heads.find((x) => x.textContent.trim() === want.trim())
  if (!target) return false
  target.scrollIntoView({ block: 'start' })
  target.classList.add('flash')
  setTimeout(() => target.classList.remove('flash'), 1600)
  return true
}

// ── 正文：块和行内的结构 → DOM ──

function renderBlocks(blocks, page) {
  return blocks.map((b) => renderBlock(b, page))
}

function renderBlock(b, page) {
  switch (b.type) {
    case 'heading':
      return h(`h${Math.min(6, b.level + 2)}`, { class: 'ghead', 'data-slug': b.slug }, renderInline(parseInline(b.text), page))
    case 'para':
      return h('p', null, renderInline(parseInline(b.text), page))
    case 'hr':
      return h('hr')
    case 'code':
      return h('pre', { class: 'code' }, h('code', { text: b.text }))
    case 'list':
      return h(b.ordered ? 'ol' : 'ul', { class: b.tight ? 'tight' : '', start: b.ordered && b.start !== 1 ? b.start : undefined }, b.items.map((it) => h('li', null, renderBlocks(it.blocks, page))))
    case 'quote': {
      const [label, tone] = ALERTS[b.alert] ?? []
      return h('blockquote', { class: tone ? `galert ${tone}` : '' }, label ? h('p', { class: 'galert-title', text: label }) : null, renderBlocks(b.blocks, page))
    }
    case 'table':
      return h(
        'div',
        { class: 'gtable' },
        h(
          'table',
          null,
          h('thead', null, h('tr', null, b.head.map((c, n) => h('th', { style: b.align[n] ? `text-align:${b.align[n]}` : undefined }, renderInline(parseInline(c), page))))),
          h('tbody', null, b.rows.map((row) => h('tr', null, row.map((c, n) => h('td', { style: b.align[n] ? `text-align:${b.align[n]}` : undefined }, renderInline(parseInline(c), page)))))),
        ),
      )
    case 'details':
      return h('details', { class: 'fold gdetails' }, h('summary', null, renderInline(parseInline(b.summary || '展开'), page)), renderBlocks(b.blocks, page))
    default:
      return null
  }
}

const SIMPLE = { strong: 'strong', em: 'em', del: 'del', u: 'u', kbd: 'kbd', sup: 'sup', sub: 'sub', span: 'span' }

function renderInline(nodes, page) {
  return nodes.map((n) => {
    if (n.t === 'text') return n.v
    if (n.t === 'br') return h('br')
    if (n.t === 'code') return h('code', { text: n.v })
    if (SIMPLE[n.t]) return h(SIMPLE[n.t], null, renderInline(n.c, page))
    if (n.t === 'abbr') return h('abbr', { title: n.title }, renderInline(n.c, page))
    if (n.t === 'item') return h('span', { class: 'gid', title: `物品 id：${n.id}`, text: n.id })
    if (n.t === 'game') return h('span', { class: 'ggame' }, h('span', { class: 'ggame-kind', text: n.kind ? `游戏里这里是${n.kind}` : '游戏里这里有' }), renderInline(n.c, page))
    if (n.t === 'link') {
      const target = linkTarget(n.href)
      const inner = renderInline(n.c, page)
      if (!target) return h('span', null, inner)
      if (target.kind === 'web') return h('a', { href: target.url, target: '_blank', rel: 'noopener noreferrer', title: `${target.url}（在新标签页打开，是站外的网页）` }, inner, h('span', { class: 'faint', text: ' ↗' }))
      if (target.kind === 'anchor') return h('a', { href: guideHash(page.path, target.anchor) }, inner)
      return h('a', { href: guideHash(target.path, target.anchor), title: target.path }, inner)
    }
    return null
  })
}
