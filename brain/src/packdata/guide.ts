// 游戏内指南（guide.jsonl，格式见 docs/PACKDATA.md 的“游戏内指南”）：整合包带的 GuideNH 指南，玩家在游戏里按 G 看到的那本。
// 一行一页，正文是原样的 Markdown 加 GuideNH 的标签（<ItemLink …/>、<GameScene>…）。这里做三件事：
//   1. 排目录：一本书里同一个路径两种语言都有时算一页，给中文的；只有英文的照常算一页。
//   2. 把标签读成字（render）：物品换成“中文名 [id/meta]”，配方框、立体图、图片各换成一句“游戏里这里显示的是什么”，
//      只管排版的标签留里面的字，页间链接换成能直接拿去读的写法。不认识的标签原样留着。
//   3. 找：按词（标题、读成字以后的正文、讲的物品的名字）、按物品。
// 这一层不知道工具，也不碰 bridge。物品、任务的名字从别的资料来（bind）；哪样没有，就原样留 id。

import fs from 'node:fs'
import path from 'node:path'
import { FLUID_DISPLAY_ID } from './fluids.ts'
import type { FluidTable } from './fluids.ts'
import type { ItemTable } from './items.ts'
import { normalizeQuestId } from './quests.ts'
import type { QuestBook } from './quests.ts'

/** 一页讲的是哪件物品：{id, meta}、{id}（任何损害值）或 {id, metas: [516, [520, 536]]}（一串损害值和范围）。 */
export interface GuideItemRef {
  id: string
  meta?: number
  metas?: (number | [number, number])[]
}

/** guide.jsonl 的一行。 */
export interface GuidePage {
  book: string
  /** zh_cn、en_us。 */
  lang: string
  path: string
  title: string
  /** 目录里的上一级（同一本书里的 path）。 */
  parent?: string
  position?: number
  items: GuideItemRef[]
  /** 页里挂的任务（任务书的 base64 id）。 */
  quests: string[]
  categories: string[]
  author?: string
  date?: string
  /** 原样的正文。 */
  text: string
}

/** 目录里的一页：一本书里的一个路径。两种语言都有时 page 是中文的、english 是英文的；只有一种时 page 就是那一种。 */
export interface GuideEntry {
  book: string
  path: string
  /** 能直接拿去读的写法：book:path。 */
  ref: string
  page: GuidePage
  english?: GuidePage
}

export interface GuideSection {
  /** 几个 #。 */
  level: number
  title: string
  /** 这个小节的标题在读成字的正文里从第几个字符起。 */
  offset: number
}

export interface RenderedGuidePage {
  /** 读成字以后的正文。 */
  text: string
  sections: GuideSection[]
}

export interface GuideBookInfo {
  book: string
  /** 这本书顶上那一页的标题（没有就是书名）。 */
  title: string
  /** 一共几页（同一路径两种语言算一页）。 */
  pages: number
  /** 其中只有英文的几页。 */
  englishOnly: number
}

export interface GuideHit {
  entry: GuideEntry
  /** 3 标题里就有；2 是这一页讲的物品的名字里有；1 只在正文里有。 */
  score: number
  /** 正文里对上的那一处前后的一小段（标题对上的可能没有）。 */
  snippet?: string
}

/** 物品、任务的名字从哪来。哪样没有，指南里对应的地方就原样留 id。 */
export interface GuideNames {
  items?: ItemTable | undefined
  fluids?: FluidTable | undefined
  quests?: QuestBook | undefined
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function parseItemRef(v: unknown): GuideItemRef | undefined {
  if (!isRecord(v) || typeof v.id !== 'string') return undefined
  const ref: GuideItemRef = { id: v.id }
  if (whole(v.meta)) ref.meta = v.meta
  if (Array.isArray(v.metas)) {
    const metas: (number | [number, number])[] = []
    for (const m of v.metas) {
      if (whole(m)) metas.push(m)
      else if (Array.isArray(m) && m.length === 2 && whole(m[0]) && whole(m[1])) metas.push([m[0], m[1]])
    }
    if (metas.length > 0) ref.metas = metas
  }
  return ref
}

export function parseGuidePage(raw: unknown): GuidePage | undefined {
  if (!isRecord(raw) || typeof raw.book !== 'string' || typeof raw.lang !== 'string' || typeof raw.path !== 'string' || typeof raw.text !== 'string') return undefined
  const page: GuidePage = {
    book: raw.book,
    lang: raw.lang,
    path: raw.path,
    title: typeof raw.title === 'string' && raw.title.trim().length > 0 ? raw.title.trim() : raw.path,
    items: (Array.isArray(raw.items) ? raw.items : []).map(parseItemRef).filter((r): r is GuideItemRef => r !== undefined),
    quests: strings(raw.quests),
    categories: strings(raw.categories),
    text: raw.text,
  }
  if (typeof raw.parent === 'string' && raw.parent.length > 0) page.parent = raw.parent
  if (typeof raw.position === 'number') page.position = raw.position
  if (typeof raw.author === 'string') page.author = raw.author
  if (typeof raw.date === 'string') page.date = raw.date
  return page
}

/** 这一页讲的物品里有没有这一件。meta 不给：只看 id。 */
function refMatches(ref: GuideItemRef, id: string, meta: number | undefined): boolean {
  if (ref.id !== id) return false
  if (meta === undefined) return true
  if (ref.metas) return ref.metas.some((m) => (typeof m === 'number' ? m === meta : meta >= m[0] && meta <= m[1]))
  return ref.meta === undefined || ref.meta === meta
}

/** 指南里写物品的办法 mod:name、mod:name:meta、mod:name:meta:{nbt}、mod:name:{nbt}（meta 写 * 是任何损害值）。 */
export function parseGuideItem(raw: string): { id: string; meta?: number; nbt?: string } {
  const parts = raw.trim().split(':')
  if (parts.length < 2) return { id: raw.trim() }
  const id = `${parts[0]}:${parts[1]}`
  const rest = parts.slice(2)
  if (rest.length === 0) return { id }
  const tail = rest.slice(1).join(':')
  if (/^\d+$/.test(rest[0]!)) return { id, meta: Number(rest[0]), ...(tail.length > 0 ? { nbt: tail } : {}) }
  if (rest[0] === '*') return { id, ...(tail.length > 0 ? { nbt: tail } : {}) }
  return { id, nbt: rest.join(':') }
}

/** 任务的 base64 id（一个 UUID 的 16 个字节）→ 任务书里的写法；读不出来返回 undefined。 */
export function questIdFromGuide(raw: string): string | undefined {
  const bytes = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (bytes.length !== 16) return undefined
  const hex = bytes.toString('hex')
  return normalizeQuestId(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`)
}

// ── 把正文拆成：字、代码（不动）、认识的标签 ──

/** 认识的标签。不在这里面的（<br>、<u>、<details>、命令里的 <player>……）当普通的字，原样留着。 */
const KNOWN_TAGS = new Set([
  'ItemLink', 'ItemImage', 'BlockImage', 'Color', 'GameScene', 'RecipeFor', 'RecipesFor', 'Recipe', 'RecipesUsage', 'RecipeUsage',
  'BoxAnnotation', 'DiamondAnnotation', 'LineAnnotation', 'BlockAnnotation', 'TextAnnotation', 'ImageAnnotation',
  'ImportStructure', 'ImportStructureLib', 'ImportPonder', 'IsometricCamera', 'Block', 'RemoveBlocks',
  'Row', 'Column', 'Tab', 'ContentTabs', 'Tooltip', 'Latex', 'FloatingImage',
  'FunctionGraph', 'Function', 'Plot', 'LineChart', 'Series',
  'Category', 'SubPages', 'KeyBind', 'QuestLink', 'PlayerName',
]) // prettier-ignore

type Node =
  | { kind: 'text'; text: string }
  /** 代码（行内的 `…` 和 ``` 围起来的）：里面的东西不当标签、不当链接。 */
  | { kind: 'code'; text: string }
  | { kind: 'tag'; name: string; attrs: Record<string, string>; children: Node[]; closed: boolean }

/** 从 text[at]（一个 <）起读一个认识的标签的开头或结尾；不是就返回 undefined。 */
function readTag(text: string, at: number): { close: boolean; name: string; attrs: Record<string, string>; selfClosing: boolean; end: number } | undefined {
  const close = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>/.exec(text.slice(at, at + 64))
  if (close) return KNOWN_TAGS.has(close[1]!) ? { close: true, name: close[1]!, attrs: {}, selfClosing: false, end: at + close[0].length } : undefined
  const open = /^<([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/.exec(text.slice(at, at + 64))
  if (!open || !KNOWN_TAGS.has(open[1]!)) return undefined
  const attrs: Record<string, string> = {}
  let i = at + open[0].length
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++
    if (text.startsWith('/>', i)) return { close: false, name: open[1]!, attrs, selfClosing: true, end: i + 2 }
    if (text[i] === '>') return { close: false, name: open[1]!, attrs, selfClosing: false, end: i + 1 }
    const name = /^[A-Za-z_][\w.-]*/.exec(text.slice(i, i + 64))
    if (!name) return undefined
    i += name[0].length
    // 等号两边可以有空白（width ="300"）
    let eq = i
    while (eq < text.length && /\s/.test(text[eq]!)) eq++
    if (text[eq] !== '=') {
      attrs[name[0]] = 'true'
      continue
    }
    i = eq + 1
    while (i < text.length && /\s/.test(text[i]!)) i++
    const q = text[i]
    if (q === '"' || q === "'") {
      const end = text.indexOf(q, i + 1)
      if (end < 0) return undefined
      attrs[name[0]] = text.slice(i + 1, end)
      i = end + 1
    } else if (q === '{') {
      let depth = 0
      let j = i
      for (; j < text.length; j++) {
        if (text[j] === '{') depth++
        else if (text[j] === '}' && --depth === 0) break
      }
      if (j >= text.length) return undefined
      attrs[name[0]] = text.slice(i + 1, j).trim().replace(/^(["'])(.*)\1$/, '$2')
      i = j + 1
    } else {
      const bare = /^[^\s>]+/.exec(text.slice(i, i + 256))
      if (!bare) return undefined
      attrs[name[0]] = bare[0].replace(/\/$/, '')
      i += attrs[name[0]]!.length
    }
  }
}

/** 没写结尾的标签：它后面的东西不是它里面的，挪出来放在它后面。 */
function unwrap(list: Node[]): void {
  for (let i = 0; i < list.length; i++) {
    const node = list[i]!
    if (node.kind !== 'tag') continue
    unwrap(node.children)
    if (!node.closed && node.children.length > 0) {
      list.splice(i + 1, 0, ...node.children)
      node.children = []
    }
  }
}

export function parseGuideText(text: string): Node[] {
  const root: Node[] = []
  const stack: Extract<Node, { kind: 'tag' }>[] = []
  const out = (): Node[] => (stack.length > 0 ? stack[stack.length - 1]!.children : root)
  let from = 0
  const literal = (to: number): void => {
    if (to > from) {
      const list = out()
      const last = list[list.length - 1]
      if (last && last.kind === 'text') last.text += text.slice(from, to)
      else list.push({ kind: 'text', text: text.slice(from, to) })
    }
  }
  const special = /[`<]/g
  let i = 0
  for (;;) {
    special.lastIndex = i
    const m = special.exec(text)
    if (!m) break
    i = m.index
    if (text[i] === '`') {
      const fenced = text.startsWith('```', i)
      const end = fenced ? text.indexOf('```', i + 3) : text.indexOf('`', i + 1)
      const line = text.indexOf('\n', i + 1)
      // 行内代码不跨行；找不到结尾的反引号就是个普通的字
      if (end < 0 || (!fenced && line >= 0 && end > line)) {
        i++
        continue
      }
      const stop = end + (fenced ? 3 : 1)
      literal(i)
      out().push({ kind: 'code', text: text.slice(i, stop) })
      from = i = stop
      continue
    }
    const tag = readTag(text, i)
    if (!tag) {
      i++
      continue
    }
    if (tag.close) {
      let at = stack.length - 1
      while (at >= 0 && stack[at]!.name !== tag.name) at--
      // 没有对应的开头：当普通的字
      if (at < 0) {
        i = tag.end
        continue
      }
      literal(i)
      stack[at]!.closed = true
      stack.length = at
    } else {
      literal(i)
      const node: Extract<Node, { kind: 'tag' }> = { kind: 'tag', name: tag.name, attrs: tag.attrs, children: [], closed: tag.selfClosing }
      out().push(node)
      if (!tag.selfClosing) stack.push(node)
    }
    from = i = tag.end
  }
  literal(text.length)
  unwrap(root)
  return root
}

/** 标题变成链接里 # 后面那一截的写法（小写、空白变横线、去掉标点），认页内的 #节 用。 */
export function guideSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

const fileName = (src: string): string => src.split('/').pop() ?? src

/** 去掉各行共同的那一段缩进（写在标签里面的内容往往整体缩进了几格；行与行之间的相对缩进留着）。 */
function dedent(text: string): string {
  const lines = text.split('\n')
  const indents = lines.filter((line) => line.trim().length > 0).map((line) => /^[ \t]*/.exec(line)![0].length)
  const cut = indents.length > 0 ? Math.min(...indents) : 0
  return cut === 0 ? text : lines.map((line) => line.slice(Math.min(cut, /^[ \t]*/.exec(line)![0].length))).join('\n')
}

interface RenderContext {
  entry: GuideEntry
  page: GuidePage
}

export class GuideBook {
  /** 全部的行（两种语言各算各的）。 */
  readonly pages: readonly GuidePage[]
  private readonly byRef = new Map<string, GuideEntry>()
  /** 每本书的页，按目录的顺序（先上一级，再它下面的，同级按 position）。 */
  private readonly byBook = new Map<string, GuideEntry[]>()
  private readonly kids = new Map<string, GuideEntry[]>()
  private readonly byItem = new Map<string, GuideEntry[]>()
  private readonly byCategory = new Map<string, GuideEntry[]>()
  private readonly rendered = new Map<string, RenderedGuidePage>()
  private names: GuideNames = {}
  private haystacks: { entry: GuideEntry; title: string; about: string; body: string; text: string }[] | undefined

  constructor(pages: readonly GuidePage[]) {
    this.pages = pages
    const chinese = (p: GuidePage): boolean => p.lang.toLowerCase().startsWith('zh')
    for (const page of pages) {
      const ref = `${page.book}:${page.path}`
      const had = this.byRef.get(ref)
      if (!had) this.byRef.set(ref, { book: page.book, path: page.path, ref, page })
      else if (chinese(page) && !chinese(had.page)) {
        had.english = had.page
        had.page = page
      } else if (!chinese(page) && chinese(had.page)) had.english ??= page
    }
    const books = new Map<string, GuideEntry[]>()
    for (const entry of this.byRef.values()) {
      const list = books.get(entry.book) ?? []
      list.push(entry)
      books.set(entry.book, list)
      for (const ref of entry.page.items) {
        const about = this.byItem.get(ref.id) ?? []
        if (!about.includes(entry)) about.push(entry)
        this.byItem.set(ref.id, about)
      }
      for (const category of entry.page.categories) {
        const key = `${entry.book}\n${category.toLowerCase()}`
        this.byCategory.set(key, [...(this.byCategory.get(key) ?? []), entry])
      }
    }
    // 同级里的先后：有中文的在前、只有英文的在后，各自按页里写的 position，再按路径
    const order = (a: GuideEntry, b: GuideEntry): number =>
      Number(!chinese(a.page)) - Number(!chinese(b.page)) || (a.page.position ?? 1e9) - (b.page.position ?? 1e9) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    for (const [book, list] of [...books].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const roots: GuideEntry[] = []
      for (const entry of list) {
        const parent = entry.page.parent !== undefined && entry.page.parent !== entry.path ? this.byRef.get(`${book}:${entry.page.parent}`) : undefined
        if (!parent) roots.push(entry)
        else this.kids.set(parent.ref, [...(this.kids.get(parent.ref) ?? []), entry])
      }
      for (const children of this.kids.values()) children.sort(order)
      const ordered: GuideEntry[] = []
      const seen = new Set<GuideEntry>()
      const walk = (entry: GuideEntry): void => {
        if (seen.has(entry)) return
        seen.add(entry)
        ordered.push(entry)
        for (const child of this.kids.get(entry.ref) ?? []) walk(child)
      }
      // 书顶上那一页（index.md）排最前
      const top = (e: GuideEntry): number => (e.path === 'index.md' ? 0 : 1)
      for (const root of roots.sort((a, b) => top(a) - top(b) || order(a, b))) walk(root)
      // 上一级绕成了圈的（不该有）：照样列出来，不丢
      for (const entry of list) walk(entry)
      this.byBook.set(book, ordered)
    }
    for (const list of this.byCategory.values()) list.sort(order)
  }

  /** 读 guide.jsonl。文件不在返回 undefined。 */
  static load(dir: string): { guide: GuideBook; rows: number; bad: number } | undefined {
    let content: string
    try {
      content = fs.readFileSync(path.join(dir, 'guide.jsonl'), 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw e
    }
    const pages: GuidePage[] = []
    let bad = 0
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue
      let page: GuidePage | undefined
      try {
        page = parseGuidePage(JSON.parse(line))
      } catch {
        page = undefined
      }
      if (page) pages.push(page)
      else bad++
    }
    return { guide: new GuideBook(pages), rows: pages.length, bad }
  }

  /** 物品、任务的名字从哪来（别的资料读完以后接上）。接上以后以前读成字的结果作废。 */
  bind(names: GuideNames): void {
    this.names = names
    this.rendered.clear()
    this.haystacks = undefined
  }

  /** 一共几页（同一路径两种语言算一页）。 */
  get size(): number {
    return this.byRef.size
  }

  books(): GuideBookInfo[] {
    return [...this.byBook].map(([book, list]) => ({
      book,
      title: list[0]?.page.title ?? book,
      pages: list.length,
      englishOnly: list.filter((e) => !e.page.lang.toLowerCase().startsWith('zh')).length,
    }))
  }

  /** 一本书的全部页，按目录的顺序。 */
  entries(book: string): readonly GuideEntry[] {
    return this.byBook.get(book) ?? []
  }

  /** 一本书顶上的页（没有上一级的）。 */
  roots(book: string): GuideEntry[] {
    return this.entries(book).filter((e) => this.parentOf(e) === undefined)
  }

  get(ref: string): GuideEntry | undefined {
    return this.byRef.get(ref)
  }

  parentOf(entry: GuideEntry): GuideEntry | undefined {
    return entry.page.parent !== undefined && entry.page.parent !== entry.path ? this.byRef.get(`${entry.book}:${entry.page.parent}`) : undefined
  }

  childrenOf(entry: GuideEntry): readonly GuideEntry[] {
    return this.kids.get(entry.ref) ?? []
  }

  /** 讲这件物品的页（页自己写明讲的是它）。meta 不给：只看 id。中文的在前。 */
  about(id: string, meta?: number): GuideEntry[] {
    const list = (this.byItem.get(id) ?? []).filter((e) => e.page.items.some((ref) => refMatches(ref, id, meta)))
    const chinese = (e: GuideEntry): number => (e.page.lang.toLowerCase().startsWith('zh') ? 0 : 1)
    return [...list].sort((a, b) => chinese(a) - chinese(b))
  }

  // ── 名字 ──

  /** 一件物品写成“中文名 [id/meta]”；物品表里没有的只有 [id/meta]。 */
  itemText(raw: string, metaAttr?: string): string {
    const item = parseGuideItem(raw)
    const meta = item.meta ?? (metaAttr !== undefined && /^\d+$/.test(metaAttr) ? Number(metaAttr) : undefined)
    const key = `${item.id}${meta !== undefined ? `/${meta}` : ''}${item.nbt !== undefined ? ` ${item.nbt}` : ''}`
    const name = this.names.items?.get(item.id, meta)?.name
    if (item.id === FLUID_DISPLAY_ID && meta !== undefined) {
      const fluids = this.names.fluids?.ofDisplayItem(item.id, meta) ?? []
      if (fluids.length === 1) return `${fluids[0]!.name} [fluid ${fluids[0]!.fluid}]`
      return name !== undefined ? `${name} (fluid) [${key}]` : `[${key}]`
    }
    return name !== undefined ? `${name} [${key}]` : `[${key}]`
  }

  private questText(raw: string): string {
    const id = questIdFromGuide(raw)
    const quest = id !== undefined ? this.names.quests?.get(id) : undefined
    if (quest) return `“${quest.name}” [quest ${quest.id}]`
    return `[quest ${id ?? raw}]`
  }

  // ── 读成字 ──

  /** 一页读成字。english：要英文那一版（只有两种语言都有的页才有得选）。结果留着，下次直接给。 */
  render(entry: GuideEntry, english = false): RenderedGuidePage {
    const page = english && entry.english ? entry.english : entry.page
    const key = `${entry.ref}\n${page.lang}`
    const had = this.rendered.get(key)
    if (had) return had
    const text = this.renderNodes(parseGuideText(page.text), { entry, page })
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const sections: GuideSection[] = []
    let fenced = false
    let offset = 0
    for (const line of text.split('\n')) {
      if (line.startsWith('```')) fenced = !fenced
      const heading = fenced ? null : /^(#{1,6})\s+(.*?)\s*#*$/.exec(line)
      if (heading) sections.push({ level: heading[1]!.length, title: heading[2]!, offset })
      offset += line.length + 1
    }
    const out = { text, sections }
    this.rendered.set(key, out)
    return out
  }

  private renderNodes(nodes: readonly Node[], ctx: RenderContext): string {
    return nodes
      .map((node, at) => {
        if (node.kind === 'code') return node.text
        if (node.kind === 'text') return this.renderText(node.text, ctx)
        // 图标紧挨着同一件物品的链接（游戏里是“图标 + 名字”）：只说一次
        if (node.name === 'ItemImage' && node.children.length === 0) {
          const beside = (step: 1 | -1): Node | undefined => {
            let i = at + step
            while (i >= 0 && i < nodes.length && nodes[i]!.kind === 'text' && (nodes[i] as { text: string }).text.trim().length === 0) i += step
            return nodes[i]
          }
          const same = (other: Node | undefined): boolean => other !== undefined && other.kind === 'tag' && other.name === 'ItemLink' && other.attrs.id === node.attrs.id
          if (same(beside(1)) || same(beside(-1))) return ''
        }
        return this.renderTag(node, ctx)
      })
      .join('')
  }

  /** 普通的字：图片换成一句话，页间链接换成能直接拿去读的写法。 */
  private renderText(text: string, ctx: RenderContext): string {
    return text
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_all, alt: string, src: string, title: string | undefined) => {
        const what = [alt.trim(), (title ?? '').trim()].filter((x) => x.length > 0).join(' — ')
        return `[image shown here in the game: ${what.length > 0 ? `${what} (${fileName(src)})` : fileName(src)}]`
      })
      .replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (all, target: string, title: string) => {
        const ref = this.resolveLink(ctx.entry, target)
        return ref !== undefined ? `](${ref}${title})` : all
      })
  }

  /** 页里写的链接（../x.md、./a/b.md#节、/a.md、x.md）指的是哪一页：book:path#节。指不到指南里的页（网址、图片）返回 undefined。 */
  resolveLink(from: GuideEntry, target: string): string | undefined {
    const hash = target.indexOf('#')
    const file = hash >= 0 ? target.slice(0, hash) : target
    const anchor = hash >= 0 ? target.slice(hash) : ''
    if (file.length === 0) return undefined
    let book = from.book
    let rest = file
    const other = /^([A-Za-z0-9_]+):(.+)$/.exec(file)
    if (other && this.byBook.has(other[1]!)) {
      book = other[1]!
      rest = `/${other[2]}`
    }
    const parts = rest.startsWith('/') ? [] : from.path.split('/').slice(0, -1)
    for (const part of rest.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    const ref = `${book}:${parts.join('/')}`
    return this.byRef.has(ref) ? `${ref}${anchor}` : undefined
  }

  private pageList(entries: readonly GuideEntry[]): string {
    return entries.map((e) => `- ${e.page.title}${e.page.lang.toLowerCase().startsWith('zh') ? '' : ' [en]'} (${e.ref})`).join('\n')
  }

  /** 标注里的字。 */
  private noteText(node: Extract<Node, { kind: 'tag' }>, ctx: RenderContext): string {
    return [node.attrs.text ?? '', this.renderNodes(node.children, ctx)]
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  private renderTag(node: Extract<Node, { kind: 'tag' }>, ctx: RenderContext): string {
    const a = node.attrs
    const inner = (): string => this.renderNodes(node.children, ctx)
    switch (node.name) {
      case 'ItemLink':
      case 'ItemImage': {
        const item = a.id !== undefined ? this.itemText(a.id) : ''
        const label = inner().trim()
        if (label.length === 0) return item
        return item.length > 0 && !item.startsWith(`${label} [`) ? `${label} (${item})` : item || label
      }
      case 'BlockImage':
        return `[picture of the block ${a.id !== undefined ? this.itemText(a.id, a.meta) : ''} shown here in the game]`
      case 'RecipeFor':
      case 'RecipesFor':
      case 'Recipe':
      case 'RecipesUsage':
      case 'RecipeUsage': {
        const item = a.id !== undefined ? this.itemText(a.id) : '?'
        const uses = node.name === 'RecipesUsage' || node.name === 'RecipeUsage'
        const narrow = [
          a.handlerId !== undefined ? `handler ${a.handlerId}` : '',
          a.handlerName !== undefined ? `handler "${a.handlerName}"` : '',
          a.input !== undefined ? `with input ${this.itemText(a.input)}` : '',
          a.output !== undefined ? `with output ${this.itemText(a.output)}` : '',
          a.handlerBlacklist !== undefined ? `not the handlers ${a.handlerBlacklist}` : '',
          a.limit !== undefined ? `at most ${a.limit}` : '',
        ].filter((x) => x.length > 0)
        const which = uses ? `the recipes that use ${item}` : node.name === 'RecipesFor' ? `the recipes for ${item}` : `a recipe for ${item}`
        return `[${which} ${uses || node.name === 'RecipesFor' ? 'are' : 'is'} shown here in the game${narrow.length > 0 ? ` (${narrow.join('; ')})` : ''}]`
      }
      case 'GameScene':
        return this.renderScene(node, ctx)
      // 这几样本来只出现在场景里；单独出现时各自成一句
      case 'ImportStructureLib':
      case 'ImportStructure':
      case 'ImportPonder':
      case 'Block':
      case 'RemoveBlocks':
        return `[3D scene shown here in the game: ${this.sceneContent(node)}]`
      case 'IsometricCamera':
        return ''
      case 'BoxAnnotation':
      case 'DiamondAnnotation':
      case 'LineAnnotation':
      case 'BlockAnnotation':
      case 'TextAnnotation': {
        const note = this.sceneNote(node, ctx)
        return note !== undefined ? `\n${note}\n` : ''
      }
      case 'ImageAnnotation':
        return inner()
      case 'FloatingImage': {
        const what = [a.title ?? '', a.src !== undefined ? `(${fileName(a.src)})` : ''].filter((x) => x.length > 0).join(' ')
        const note = inner().replace(/\s+/g, ' ').trim()
        return `[image shown here in the game: ${what}]${note.length > 0 && note !== (a.title ?? '') ? ` ${note}` : ''}`
      }
      case 'Color':
        return inner()
      // 排版用的框：留里面的字，去掉为了排进标签里而缩进的那几格
      case 'Row':
      case 'Column':
        return dedent(inner())
      case 'ContentTabs':
        return `${a.title !== undefined ? `${a.title}\n` : ''}${dedent(inner())}`
      case 'Tab':
        return `${a.title !== undefined ? `\n**${a.title}**\n` : ''}${dedent(inner())}`
      case 'Tooltip': {
        const tip = inner().replace(/\s+/g, ' ').trim()
        return [a.label ?? '', tip.length > 0 ? `(${tip})` : ''].filter((x) => x.length > 0).join(' ')
      }
      case 'Latex': {
        const more = [a.tooltip !== undefined ? `(${a.tooltip})` : '', inner().trim()].filter((x) => x.length > 0).join('\n')
        return `${a.formula !== undefined ? `$${a.formula}$` : ''}${more.length > 0 ? `\n${more}` : ''}`
      }
      case 'FunctionGraph':
      case 'LineChart': {
        const about = [
          a.title ?? '',
          a.xLabel !== undefined || a.xAxisLabel !== undefined ? `x: ${a.xLabel ?? a.xAxisLabel}` : '',
          a.yLabel !== undefined || a.yAxisLabel !== undefined ? `y: ${a.yLabel ?? a.yAxisLabel}` : '',
          a.xRange !== undefined ? `x from ${a.xRange}` : a.xMax !== undefined ? `x up to ${a.xMax}` : '',
          a.categories !== undefined ? `x values ${a.categories}` : '',
        ].filter((x) => x.length > 0)
        const curves = node.children.map((child) => (child.kind === 'tag' ? this.renderTag(child, ctx) : '')).filter((x) => x.length > 0)
        return `[graph shown here in the game${about.length > 0 ? `: ${about.join('; ')}` : ''}]${curves.length > 0 ? `\n${curves.join('\n')}` : ''}`
      }
      case 'Function':
      case 'Plot':
        return `- curve${a.label !== undefined ? ` "${a.label}"` : ''}: ${a.expr ?? '?'}${a.domain !== undefined ? ` (x in ${a.domain})` : ''}`
      case 'Series':
        return `- series${a.name !== undefined ? ` "${a.name}"` : ''}: ${a.data ?? '?'}`
      case 'KeyBind':
        return `[key binding ${a.id ?? '?'}]`
      case 'QuestLink': {
        const quest = a.id !== undefined ? this.questText(a.id) : ''
        return a.text !== undefined && a.text.length > 0 ? `${a.text} (${quest})` : quest
      }
      case 'PlayerName':
        return ctx.page.lang.toLowerCase().startsWith('zh') ? '玩家' : 'player'
      case 'SubPages':
        return this.pageList(this.childrenOf(ctx.entry))
      case 'Category':
        return this.pageList(this.byCategory.get(`${ctx.entry.book}\n${(a.name ?? '').toLowerCase()}`) ?? [])
      default:
        return inner()
    }
  }

  /** 场景里摆的东西，一句话。 */
  private sceneContent(node: Extract<Node, { kind: 'tag' }>): string {
    const a = node.attrs
    const at = ['x', 'y', 'z'].some((k) => a[k] !== undefined) ? ` at (${a.x ?? 0},${a.y ?? 0},${a.z ?? 0})` : ''
    switch (node.name) {
      case 'ImportStructureLib':
        return `the structure of ${a.controller !== undefined ? this.itemText(a.controller) : '?'}${a.tier !== undefined ? `, tier ${a.tier}` : ''}`
      case 'ImportStructure':
        return `a built example (${a.src !== undefined ? fileName(a.src) : '?'})${at}`
      case 'ImportPonder':
        return `an animation (${a.src !== undefined ? fileName(a.src) : '?'})`
      case 'Block':
        return `the block ${a.id !== undefined ? this.itemText(a.id, a.meta) : '?'}${at}${a.facing !== undefined ? ` facing ${a.facing}` : ''}`
      case 'RemoveBlocks':
        return `without the blocks ${a.id !== undefined ? this.itemText(a.id, a.meta) : '?'}`
      default:
        return ''
    }
  }

  /** 场景里的一条标注：指着哪里、写了什么。没有字的（只画了一条线、一个框）不留。 */
  private sceneNote(node: Extract<Node, { kind: 'tag' }>, ctx: RenderContext): string | undefined {
    const text = this.noteText(node, ctx)
    if (text.length === 0) return undefined
    const a = node.attrs
    const where =
      node.name === 'BoxAnnotation'
        ? `box (${a.min ?? '?'}) to (${a.max ?? '?'})`
        : node.name === 'LineAnnotation'
          ? `line ${a.points !== undefined ? a.points : `(${a.from ?? '?'}) to (${a.to ?? '?'})`}`
          : node.name === 'BlockAnnotation'
            ? `block (${a.pos ?? '?'})`
            : node.name === 'DiamondAnnotation'
              ? `point (${a.pos ?? '?'})`
              : `label at (${a.pos ?? '?'})`
    return `- note on the scene, ${where}: ${text}`
  }

  private renderScene(node: Extract<Node, { kind: 'tag' }>, ctx: RenderContext): string {
    const content: string[] = []
    const notes: string[] = []
    const other: string[] = []
    const visit = (children: readonly Node[]): void => {
      for (const child of children) {
        if (child.kind !== 'tag') {
          const text = child.kind === 'code' ? child.text : this.renderText(child.text, ctx).trim()
          if (text.trim().length > 0) other.push(text.trim())
        } else if (['ImportStructureLib', 'ImportStructure', 'ImportPonder', 'Block', 'RemoveBlocks'].includes(child.name)) {
          content.push(this.sceneContent(child))
          visit(child.children)
        } else if (['BoxAnnotation', 'DiamondAnnotation', 'LineAnnotation', 'BlockAnnotation', 'TextAnnotation'].includes(child.name)) {
          const note = this.sceneNote(child, ctx)
          if (note !== undefined) notes.push(note)
        } else if (child.name !== 'IsometricCamera') {
          const text = this.renderTag(child, ctx).trim()
          if (text.length > 0) other.push(text)
        }
      }
    }
    visit(node.children)
    const head = `[3D scene shown here in the game${content.length > 0 ? `: ${content.join('; ')}` : ''}]`
    return [head, ...notes, ...other].join('\n')
  }

  // ── 找 ──

  private index(): NonNullable<GuideBook['haystacks']> {
    if (this.haystacks) return this.haystacks
    const rows: NonNullable<GuideBook['haystacks']> = []
    for (const list of this.byBook.values()) {
      for (const entry of list) {
        const text = this.render(entry).text
        const about = entry.page.items
          .map((ref) => {
            const info = this.names.items?.get(ref.id, ref.meta)
            return `${info?.name ?? ''} ${info?.en ?? ''} ${ref.id}${ref.meta !== undefined ? `/${ref.meta}` : ''}`
          })
          .join('\n')
        rows.push({ entry, title: `${entry.page.title}\n${entry.english?.title ?? ''}`.toLowerCase(), about: about.toLowerCase(), body: `${text}\n${entry.path}`.toLowerCase(), text })
      }
    }
    this.haystacks = rows
    return rows
  }

  /** 按词找页：每个词都要在标题、讲的物品的名字或读成字的正文里。标题对上的在前，其次是讲的物品，再是正文里出现得多的。 */
  search(query: string, opts: { book?: string } = {}): GuideHit[] {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0)
    if (words.length === 0) return []
    const hits: (GuideHit & { count: number; order: number })[] = []
    this.index().forEach((row, order) => {
      if (opts.book !== undefined && row.entry.book !== opts.book) return
      if (!words.every((w) => row.title.includes(w) || row.about.includes(w) || row.body.includes(w))) return
      const score = words.every((w) => row.title.includes(w)) ? 3 : words.every((w) => row.about.includes(w)) ? 2 : 1
      let count = 0
      for (const w of words) for (let at = row.body.indexOf(w); at >= 0 && count < 50; at = row.body.indexOf(w, at + w.length)) count++
      const at = Math.min(...words.map((w) => row.body.indexOf(w)).filter((n) => n >= 0 && n < row.text.length), Infinity)
      const hit: GuideHit & { count: number; order: number } = { entry: row.entry, score, count, order }
      if (Number.isFinite(at)) {
        const from = Math.max(0, at - 50)
        const to = Math.min(row.text.length, at + 110)
        hit.snippet = `${from > 0 ? '…' : ''}${row.text.slice(from, to).replace(/\s+/g, ' ').trim()}${to < row.text.length ? '…' : ''}`
      }
      hits.push(hit)
    })
    hits.sort((a, b) => b.score - a.score || b.count - a.count || a.order - b.order)
    return hits.map(({ entry, score, snippet }) => ({ entry, score, ...(snippet !== undefined ? { snippet } : {}) }))
  }

  /** 读成字以后正文里还留着的标签（不认识的那些），各多少处。核对用。 */
  leftoverTags(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const list of this.byBook.values()) {
      for (const entry of list) {
        for (const english of entry.english ? [false, true] : [false]) {
          const text = this.render(entry, english).text.replace(/```[\s\S]*?```|`[^`\n]*`/g, '')
          for (const m of text.matchAll(/<\/?([A-Za-z][A-Za-z0-9]*)(?=[\s/>])/g)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1)
        }
      }
    }
    return counts
  }
}
