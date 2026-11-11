// read_guide：读整合包带的游戏内指南（玩家按 G 看到的那本）。只看，两条线都有。
// 四种问法：有哪些书和页（目录）、按词找、按物品找讲它的页、读一页（标签已经读成字，见 packdata/guide.ts）。
// 别的工具（find_item、inspect_block、find_machines、find_structure）在说到一件物品时带一行“指南里有这一页”（guideNote）。

import { guideSlug } from '../packdata/guide.ts'
import type { GuideBook, GuideEntry } from '../packdata/guide.ts'
import type { ItemTable } from '../packdata/items.ts'
import { displayName, itemKey } from './format.ts'
import { bool, int, obj, str } from './schema.ts'
import { DEFAULT_RESULT_MAX_CHARS, fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

const NO_GUIDE = 'This brain has no in-game guide: that data (guide.jsonl) was not exported for it.'
const HITS_PER_PAGE = 10
/** 读一页时，页头和结尾那几行留的余地。 */
const READ_OVERHEAD = 700

const isEnglish = (e: GuideEntry): boolean => !e.page.lang.toLowerCase().startsWith('zh')
const mark = (e: GuideEntry): string => (isEnglish(e) ? ' [en]' : '')

/**
 * 说到一件物品时带的那一行：指南里讲它的页叫什么、怎么读。没有讲它的页（或者没有指南）返回 undefined。
 * 讲它的不止一页时写第一页，并说还有几页、怎么列出来。
 */
export function guideNote(guide: GuideBook | undefined, id: string | undefined, meta?: number): string | undefined {
  if (!guide || id === undefined) return undefined
  const pages = guide.about(id, meta)
  const first = pages[0]
  if (!first) return undefined
  const more = pages.length > 1 ? ` (+${pages.length - 1} more: read_guide {id: "${id}"${meta !== undefined ? `, meta: ${meta}` : ''}})` : ''
  return `in the guide: "${first.page.title}"${mark(first)} — read_guide {path: "${first.ref}"}${more}`
}

/**
 * 世界里的一个方块是物品表里的哪件物品。身体给的 meta 是世界里的（朝向之类），机器的不是它作为物品的 meta：
 * 先拿身体给的英文名在同一个 id 下对；对不上、而它又没有方块实体（普通方块的 meta 就是物品的）时才用 id + meta。
 */
export function itemOfBlock(items: ItemTable | undefined, block: { id?: string | undefined; meta?: number | undefined; name?: string | undefined; tileEntity?: boolean | undefined }): { id: string; meta?: number } | undefined {
  if (typeof block.id !== 'string') return undefined
  const english = typeof block.name === 'string' ? displayName(block.name) : undefined
  const named = english !== undefined ? items?.byEnglishName(block.id, english) : undefined
  if (named) return { id: named.id, meta: named.meta }
  if (block.tileEntity === true) return undefined
  return { id: block.id, ...(typeof block.meta === 'number' ? { meta: block.meta } : {}) }
}

function entryData(guide: GuideBook, e: GuideEntry): Record<string, unknown> {
  const parent = guide.parentOf(e)
  return {
    path: e.ref,
    book: e.book,
    title: e.page.title,
    lang: e.page.lang,
    ...(e.english ? { english: true } : {}),
    ...(parent ? { parent: parent.ref } : {}),
    ...(e.page.items.length > 0 ? { items: e.page.items } : {}),
  }
}

/** 没有任何参数：有哪几本书，各多少页，顶上有哪几章。 */
function listBooks(guide: GuideBook): ToolResult {
  const books = guide.books()
  const lines = books.map((b) => {
    const roots = guide.roots(b.book)
    // 顶上那一页（index.md）下面的几章，加上别的没有上一级的页
    const top = roots.flatMap((r) => (r.path === 'index.md' && guide.childrenOf(r).length > 0 ? guide.childrenOf(r) : [r]))
    const english = b.englishOnly > 0 ? `, ${b.englishOnly} of them in English only` : ''
    if (b.pages === 1) return `- ${b.book} "${b.title}": 1 page (${roots[0]?.ref ?? b.book})`
    return `- ${b.book} "${b.title}": ${b.pages} pages${english}. Top: ${top
      .slice(0, 10)
      .map((e) => e.page.title)
      .join(', ')}${top.length > 10 ? `, … (${top.length})` : ''}`
  })
  const total = books.reduce((n, b) => n + b.pages, 0)
  const english = books.reduce((n, b) => n + b.englishOnly, 0)
  return {
    content: [
      `The in-game guide of this pack (the book players open with G): ${books.length} book(s), ${total} pages. A page that exists in Chinese is given in Chinese${english > 0 ? `; ${english} exist in English only` : ''}.`,
      ...lines,
      'book: a book\'s pages. query: search. id (+meta): the pages about an item. path: read a page.',
    ].join('\n'),
    data: { books },
  }
}

/** 一本书的目录（或者其中一页下面的那一截）：一页一行，缩进表示上下级。放不下时把深的那几层收起来，写明下面还有几页。 */
function listPages(guide: GuideBook, book: string, under: string | undefined, cap: number): ToolResult {
  const all = guide.entries(book)
  if (all.length === 0) return fail(`There is no book "${book}" in the guide. Its books: ${guide.books().map((b) => b.book).join(', ')}.`)
  let roots = guide.roots(book)
  let scope = ''
  if (under !== undefined) {
    const at = guide.get(under.includes(':') ? under : `${book}:${under}`)
    if (!at || at.book !== book) return fail(`There is no page "${under}" in the book ${book}. read_guide {book: "${book}"} lists its pages.`)
    roots = [at]
    scope = ` under "${at.page.title}"`
  }
  const below = (e: GuideEntry): number => guide.childrenOf(e).reduce((n, c) => n + 1 + below(c), 0)
  const count = roots.reduce((n, r) => n + 1 + below(r), 0)
  const data = { book, pages: (under !== undefined ? roots.flatMap((r) => [r, ...descendants(guide, r)]) : [...all]).map((e) => entryData(guide, e)) }
  const head = `Pages of the guide book ${book}${scope}: ${count}. Each line is title — path; read one with path: "${book}:<path>".${all.some(isEnglish) ? ' [en]: in English only.' : ''}`
  const budget = Math.max(200, cap - head.length - 200)
  // 先整棵给；放不下就一层层收，收起来的那一页后面写着它下面还有几页
  for (let depth = 12; depth >= 1; depth--) {
    const lines: string[] = []
    const walk = (e: GuideEntry, level: number): void => {
      const kids = guide.childrenOf(e)
      const folded = level >= depth && kids.length > 0
      lines.push(`${'  '.repeat(level)}- ${e.page.title}${mark(e)} — ${e.path}${folded ? ` (+${below(e)} below: under: "${e.path}")` : ''}`)
      if (!folded) for (const kid of kids) walk(kid, level + 1)
    }
    for (const root of roots) walk(root, 0)
    const text = lines.join('\n')
    if (text.length <= budget || depth === 1) {
      if (text.length <= budget) return { content: `${head}\n${text}`, data, keepWhole: true }
      // 收到只剩一层还放不下：给到放得下为止，写明还有几行
      let used = 0
      const shown = lines.filter((line) => (used += line.length + 1) <= budget)
      return { content: `${head}\n${shown.join('\n')}\n… ${lines.length - shown.length} more line(s) did not fit: ask under one of the pages above, or search with query.`, data, keepWhole: true }
    }
  }
  return { content: head, data }
}

function descendants(guide: GuideBook, e: GuideEntry): GuideEntry[] {
  return guide.childrenOf(e).flatMap((c) => [c, ...descendants(guide, c)])
}

function searchPages(guide: GuideBook, query: string, book: string | undefined, page: number): ToolResult {
  if (book !== undefined && guide.entries(book).length === 0) return fail(`There is no book "${book}" in the guide. Its books: ${guide.books().map((b) => b.book).join(', ')}.`)
  const hits = guide.search(query, book !== undefined ? { book } : {})
  const where = book !== undefined ? ` in the book ${book}` : ''
  const data = { matched: hits.length, hits: hits.map((h) => ({ ...entryData(guide, h.entry), score: h.score, ...(h.snippet !== undefined ? { snippet: h.snippet } : {}) })) }
  if (hits.length === 0) return { content: `No guide page${where} has all the words of "${query}" in its title, its text or the name of the item it is about. The guide is searched in the language of each page (Chinese where there is one).`, data }
  const pages = Math.ceil(hits.length / HITS_PER_PAGE)
  if (page > pages) return fail(`"${query}" matches ${hits.length} guide page(s): there is no page ${page} of the results (${pages} page(s)).`)
  const shown = hits.slice((page - 1) * HITS_PER_PAGE, page * HITS_PER_PAGE)
  const lines = shown.map((h) => `- ${h.entry.page.title}${mark(h.entry)} — ${h.entry.ref}${h.snippet !== undefined ? `\n    ${h.snippet}` : ''}`)
  const first = (page - 1) * HITS_PER_PAGE + 1
  const head =
    hits.length > shown.length
      ? `${hits.length} guide pages${where} match "${query}"; these are ${first}–${first + shown.length - 1} (page ${page} of ${pages}), title matches first. Read one with path.`
      : `${hits.length} guide page(s)${where} match "${query}", title matches first. Read one with path.`
  return { content: [head, ...lines].join('\n'), data, keepWhole: true }
}

function pagesAbout(ctx: ToolContext, guide: GuideBook, id: string, meta: number | undefined): ToolResult {
  const pages = guide.about(id, meta)
  const item = guide.itemText(meta !== undefined ? `${id}:${meta}` : id)
  const data = { pages: pages.map((e) => entryData(guide, e)) }
  if (pages.length === 0) {
    const known = ctx.packdata?.items?.get(id, meta)
    return {
      content: `No guide page names ${known ? item : itemKey({ id, ...(meta !== undefined ? { meta } : {}) })} as its subject${meta !== undefined && guide.about(id).length > 0 ? ` (other metas of ${id} have pages: leave out meta to see them)` : ''}. A page can still mention it in its text: query searches the text.`,
      data,
    }
  }
  return { content: [`${pages.length} guide page(s) about ${item}. Read one with path.`, ...pages.map((e) => `- ${e.page.title}${mark(e)} — ${e.ref}`)].join('\n'), data }
}

/** path 里写的页：book:path，可以带 #节；没写 .md 的补上。 */
function findPage(guide: GuideBook, raw: string, book: string | undefined): { entry: GuideEntry; anchor?: string } | undefined {
  const hash = raw.indexOf('#')
  const anchor = hash >= 0 ? raw.slice(hash + 1) : undefined
  const file = (hash >= 0 ? raw.slice(0, hash) : raw).trim().replace(/^\.?\//, '')
  const refs = [file, `${file}.md`, ...(book !== undefined ? [`${book}:${file}`, `${book}:${file}.md`] : [])]
  for (const ref of refs) {
    const entry = guide.get(ref)
    if (entry) return { entry, ...(anchor !== undefined && anchor.length > 0 ? { anchor } : {}) }
  }
  return undefined
}

function readPage(guide: GuideBook, i: { path: string; book?: string; offset?: number; english?: boolean }, cap: number): ToolResult {
  const found = findPage(guide, i.path, i.book)
  if (!found) {
    // 文件名一样的页（路径记岔了）列出来
    const name = (i.path.split('#')[0] ?? '').split(/[:/]/).pop()?.replace(/\.md$/, '') ?? ''
    const near = name.length > 1 ? guide.books().flatMap((b) => guide.entries(b.book).filter((e) => e.path.split('/').pop()?.replace(/\.md$/, '') === name)) : []
    return fail(
      `There is no guide page "${i.path}". A page is written book:path, e.g. "gregtech:index.md".${near.length > 0 ? ` Pages with that file name: ${near.slice(0, 6).map((e) => `${e.ref} "${e.page.title}"`).join(', ')}.` : ''} read_guide {book} lists a book's pages; {query} searches.`,
    )
  }
  const { entry } = found
  const english = i.english === true && entry.english !== undefined
  const page = english ? entry.english! : entry.page
  const rendered = guide.render(entry, english)
  const text = rendered.text
  const parent = guide.parentOf(entry)
  const kids = guide.childrenOf(entry)

  // 从哪里读起：offset，或者 path 里 # 后面的那个小节
  let offset = Math.min(Math.max(0, i.offset ?? 0), text.length)
  let anchorNote = ''
  if (found.anchor !== undefined && i.offset === undefined) {
    const want = found.anchor.toLowerCase()
    const section = rendered.sections.find((s) => s.title.toLowerCase() === want || guideSlug(s.title) === want)
    if (section) offset = section.offset
    else anchorNote = ` No heading of this page matches "#${found.anchor}": this is from the top.`
  }

  const about = page.items.map((ref) => guide.itemText(ref.meta !== undefined ? `${ref.id}:${ref.meta}` : ref.id) + (ref.metas ? ` (metas ${ref.metas.map((m) => (typeof m === 'number' ? m : `${m[0]}–${m[1]}`)).join(', ')})` : ''))
  const others = page.items.flatMap((ref) => guide.about(ref.id, ref.meta)).filter((e, n, all) => e !== entry && all.indexOf(e) === n)
  const lang = isEnglish(entry) ? 'English (there is no Chinese version)' : english ? 'the English version' : `Chinese${entry.english ? '; english: true gives the English version' : ''}`
  const head = [
    `Guide page "${page.title}" — ${entry.ref}, ${lang}.${page.date !== undefined || page.author !== undefined ? ` Written${page.date !== undefined ? ` ${page.date}` : ''}${page.author !== undefined ? ` by ${page.author}` : ''}.` : ''}${anchorNote}`,
    about.length > 0 ? `About: ${about.slice(0, 8).join(', ')}${about.length > 8 ? `, … (${about.length})` : ''}.` : '',
    parent ? `Under: "${parent.page.title}" (${parent.ref}).` : '',
    kids.length > 0 ? `Sub-pages: ${kids.length}${kids.length <= 6 ? ` — ${kids.map((k) => `"${k.page.title}" (${k.ref})`).join(', ')}` : ` (read_guide {book: "${entry.book}", under: "${entry.path}"})`}.` : '',
    others.length > 0 ? `Other pages about the same item: ${others.slice(0, 4).map((e) => `"${e.page.title}"${mark(e)} (${e.ref})`).join(', ')}.` : '',
  ].filter((line) => line.length > 0)

  const data = {
    ...entryData(guide, entry),
    lang: page.lang,
    ...(page.author !== undefined ? { author: page.author } : {}),
    ...(page.date !== undefined ? { date: page.date } : {}),
    ...(page.quests.length > 0 ? { quests: page.quests } : {}),
    children: kids.map((k) => k.ref),
    sections: rendered.sections,
    text,
  }

  const headText = head.join('\n')
  const budget = Math.max(1000, cap - headText.length - READ_OVERHEAD)
  let end = text.length
  if (end - offset > budget) {
    // 尽量在一段的末尾断
    const hard = offset + budget
    const blank = text.lastIndexOf('\n\n', hard)
    const line = text.lastIndexOf('\n', hard)
    end = blank > offset + budget * 0.6 ? blank : line > offset + budget * 0.3 ? line : hard
  }
  const body = text.slice(offset, end).trim()
  const partial = offset > 0 || end < text.length
  const tail: string[] = []
  if (partial) {
    tail.push(`[chars ${offset}–${end} of ${text.length} of this page.${end < text.length ? ` The rest: the same path with offset: ${end}.` : ' This is the end of the page.'}]`)
    // 小节和各自从哪里起：从头读、或者跳到某一节读的时候给，接着往下读的时候不重复
    if ((i.offset === undefined || i.offset === 0) && rendered.sections.length > 1) {
      const outline = rendered.sections.filter((s) => rendered.sections.length <= 40 || s.level <= 2)
      tail.push(`Its sections (offset: heading): ${outline.map((s) => `${s.offset}: ${'#'.repeat(s.level)} ${s.title}`).join(' · ')}`)
    }
  }
  return { content: [headText, '---', body, ...(tail.length > 0 ? ['---', ...tail] : [])].join('\n'), data, keepWhole: true }
}

export const readGuide: Tool = {
  name: 'read_guide',
  description:
    'The in-game guide of this pack (GuideNH: the book players open with G; your owner reads the same pages): what machines are for, how multiblocks are built and run, power, AE2, Thaumcraft, what a version changed. People wrote it; recipes and structures as exported from the game are in find_recipes and find_structure. ' +
    'No arguments: its books. book: its pages. query: search titles, text and item names. id: the pages about an item. path: read a page.',
  inputSchema: obj({
    path: str('A page, "book:path" as listed; "#heading" starts at that section.', { maxLength: 300 }),
    offset: int('With path: start at this character (a long page says where its rest starts).', { min: 0 }),
    english: bool('With path: the English version, where a page has both.'),
    query: str('Words to search for.', { maxLength: 200 }),
    id: str('An item id.'),
    meta: int(undefined, { min: 0 }),
    book: str('A book of the guide.', { maxLength: 60 }),
    under: str('With book: only below this page (its path).', { maxLength: 300 }),
    page: int('With query: page of the results.', { min: 1 }),
  }),
  async run(ctx, i: { path?: string; offset?: number; english?: boolean; query?: string; id?: string; meta?: number; book?: string; under?: string; page?: number }): Promise<ToolResult> {
    const guide = ctx.packdata?.guide
    if (!guide) return fail(NO_GUIDE)
    const cap = ctx.maxResultChars?.() ?? DEFAULT_RESULT_MAX_CHARS
    const book = i.book?.trim()
    if (i.path !== undefined && i.path.trim().length > 0) return readPage(guide, { path: i.path.trim(), ...(book !== undefined ? { book } : {}), ...(i.offset !== undefined ? { offset: i.offset } : {}), ...(i.english !== undefined ? { english: i.english } : {}) }, cap)
    if (i.query !== undefined && i.query.trim().length > 0) return searchPages(guide, i.query.trim(), book, i.page ?? 1)
    if (i.id !== undefined) return pagesAbout(ctx, guide, i.id.trim(), i.meta)
    if (book !== undefined && book.length > 0) return listPages(guide, book, i.under?.trim() || undefined, cap)
    return listBooks(guide)
  },
}
