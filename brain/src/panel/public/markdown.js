// 游戏内指南的正文（大脑读成字以后的 Markdown）→ 块和行内的结构。页面再照这个结构用 DOM 一个个拼出来，
// 不拼 HTML 字符串：正文来自整合包，里面的 HTML 只认几样（<br> <u> <kbd> <a title> <sup> <details>），别的原样当字显示。
// 这里不碰 DOM，测试里直接跑（test/panel-markdown.test.ts）。
//
// 块：heading { level, text, slug } · para { text } · list { ordered, start, tight, items: [{ blocks }] }
//     quote { alert?, blocks }（alert 是 > [!NOTE] 这类的 NOTE/TIP/IMPORTANT/WARNING/CAUTION）· code { lang, text }
//     table { align, head, rows }（单元格是原文）· hr · details { summary, blocks }
// 行内：text { v } · strong / em / del / u / kbd / sup / sub { c } · code { v } · br
//       link { href, c } · abbr { title, c }（<a title="译注">）· item { id }（“中文名 [id/meta]”里的那个 [id/meta]）
//       game { kind, c }（[… shown here in the game …]：游戏里这里是一张图、一个配方框、一个立体场景）

/** 页间链接 book:path（可以带 #小节），站外链接，或者同一页里的 #小节。认不出来的是 null（当普通字显示）。 */
export function linkTarget(href) {
  const raw = String(href ?? '').trim()
  if (/^https?:\/\//i.test(raw)) return { kind: 'web', url: raw }
  if (raw.startsWith('#') && raw.length > 1) return { kind: 'anchor', anchor: safeDecode(raw.slice(1)) }
  const m = /^([a-z0-9_]+):([^\s#]+)(?:#(.*))?$/i.exec(raw)
  if (m) return { kind: 'page', path: `${m[1]}:${m[2]}`, ...(m[3] ? { anchor: safeDecode(m[3]) } : {}) }
  return null
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** 小节标题 → 页内锚点（和 GitHub 的写法一样：小写、去掉标点、空白换成 -）。 */
export function slugOf(title) {
  return String(title)
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

// ── 块 ──

const FENCE = /^\s*(```|~~~)\s*([^`\s]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-*:?\s*)*\|?\s*$/
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i

const indentOf = (line) => /^\s*/.exec(line)[0].replace(/\t/g, '    ').length
const blank = (line) => line.trim().length === 0

/** 去掉一段文字共同的缩进（<details> 里面的内容常整体缩进两格）。 */
function dedent(lines) {
  const widths = lines.filter((l) => !blank(l)).map(indentOf)
  const cut = widths.length > 0 ? Math.min(...widths) : 0
  return lines.map((l) => (blank(l) ? '' : l.replace(/\t/g, '    ').slice(cut)))
}

/** 这一行会不会开一个新块（段落遇到它就断开）。 */
function startsBlock(line, next) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || /^\s*>/.test(line) || LIST_ITEM.test(line) || /^\s*<details\b/i.test(line) || (/^\s*\|/.test(line) && next !== undefined && TABLE_RULE.test(next) && next.includes('-'))
}

export function parseBlocks(text) {
  return blocksOf(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'))
}

function blocksOf(lines) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (blank(line)) {
      i++
      continue
    }
    // 代码
    const fence = FENCE.exec(line)
    if (fence) {
      const body = []
      i++
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i])) body.push(lines[i++])
      i++
      out.push({ type: 'code', lang: fence[2] ?? '', text: dedent(body).join('\n') })
      continue
    }
    // <details><summary>…</summary> … </details>
    if (/^\s*<details\b/i.test(line)) {
      const body = []
      let depth = 0
      for (; i < lines.length; i++) {
        depth += (lines[i].match(/<details\b/gi) ?? []).length
        depth -= (lines[i].match(/<\/details>/gi) ?? []).length
        body.push(lines[i])
        if (depth <= 0) {
          i++
          break
        }
      }
      let inner = body.join('\n').replace(/^\s*<details\b[^>]*>/i, '').replace(/<\/details>\s*$/i, '')
      let summary = ''
      const sm = /^\s*<summary>([\s\S]*?)<\/summary>/i.exec(inner)
      if (sm) {
        summary = sm[1].trim()
        inner = inner.slice(sm[0].length)
      }
      out.push({ type: 'details', summary, blocks: blocksOf(dedent(inner.split('\n'))) })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      out.push({ type: 'heading', level: heading[1].length, text: heading[2], slug: slugOf(heading[2]) })
      i++
      continue
    }
    if (HR.test(line)) {
      out.push({ type: 'hr' })
      i++
      continue
    }
    // 表格：表头一行、对齐一行、下面每行一条
    if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cellsOf(line)
      const align = cellsOf(lines[i + 1]).map((c) => (/^:-*:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : ''))
      const rows = []
      i += 2
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cellsOf(lines[i++]))
      out.push({ type: 'table', align, head, rows })
      continue
    }
    // 引用（> [!WARNING] 这种是提示框）
    if (/^\s*>/.test(line)) {
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*> ?/, ''))
      const alert = ALERT.exec(body[0]?.trim() ?? '')
      out.push({ type: 'quote', ...(alert ? { alert: alert[1].toUpperCase() } : {}), blocks: blocksOf(alert ? body.slice(1) : body) })
      continue
    }
    if (LIST_ITEM.test(line)) {
      const [list, next] = listAt(lines, i)
      out.push(list)
      i = next
      continue
    }
    // 段落：到空行或者下一个块为止
    const para = [line.trim()]
    i++
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines[i], lines[i + 1])) para.push(lines[i++].trim())
    out.push({ type: 'para', text: para.join('\n') })
  }
  return out
}

/** 表格的一行 → 单元格（\| 是字里的竖线）。 */
function cellsOf(line) {
  let row = line.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const cells = []
  let cell = ''
  for (let n = 0; n < row.length; n++) {
    if (row[n] === '\\' && row[n + 1] === '|') {
      cell += '|'
      n++
    } else if (row[n] === '|') {
      cells.push(cell.trim())
      cell = ''
    } else cell += row[n]
  }
  cells.push(cell.trim())
  return cells
}

/** 从第 start 行起的一个列表（同一层的各项；更深的缩进归上一项，项里面再按块读，嵌套的列表就出来了）。 */
function listAt(lines, start) {
  const first = LIST_ITEM.exec(lines[start])
  const base = indentOf(first[1])
  const ordered = /\d/.test(first[2])
  const items = []
  let tight = true
  let i = start
  let item = null
  while (i < lines.length) {
    const line = lines[i]
    const m = LIST_ITEM.exec(line)
    if (m && indentOf(m[1]) <= base + 1 && /\d/.test(m[2]) === ordered) {
      item = { lines: [m[3]], width: indentOf(m[1]) + m[2].length + 1 }
      items.push(item)
      i++
      continue
    }
    if (blank(line)) {
      // 空行后面接着的还是这个列表的（下一项，或者缩进的续行）才算里面的
      let j = i
      while (j < lines.length && blank(lines[j])) j++
      const after = lines[j]
      const am = after !== undefined ? LIST_ITEM.exec(after) : null
      const continues = after !== undefined && (indentOf(after) > base + 1 || (am && indentOf(am[1]) <= base + 1 && /\d/.test(am[2]) === ordered))
      if (!continues) break
      tight = false
      item.lines.push('')
      i++
      continue
    }
    if (indentOf(line) > base + 1) {
      item.lines.push(line.replace(/\t/g, '    ').slice(Math.min(item.width, indentOf(line))))
      i++
      continue
    }
    // 没缩进的续行（上一行不是空行、这一行又不开新块）：还是这一项的字
    if (!blank(lines[i - 1]) && !startsBlock(line, lines[i + 1])) {
      item.lines.push(line.trim())
      i++
      continue
    }
    break
  }
  return [{ type: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) : 1, tight, items: items.map((it) => ({ blocks: blocksOf(it.lines) })) }, i]
}

// ── 行内 ──

const ITEM_REF = /^[A-Za-z0-9_.\-]+:[^\s\]\[]+$/
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'" }
const PAIRED_TAGS = new Set(['u', 'kbd', 'sup', 'sub', 'b', 'strong', 'i', 'em', 's', 'del', 'a', 'span', 'code', 'font', 'small', 'big', 'center'])
const TAG_KIND = { b: 'strong', strong: 'strong', i: 'em', em: 'em', s: 'del', del: 'del', u: 'u', kbd: 'kbd', sup: 'sup', sub: 'sub' }

/** 从 open 处的 [ 起找配对的 ]（中间的 [] 成对跳过）；找不到是 -1。 */
function closeBracket(text, open, l = '[', r = ']') {
  let depth = 0
  for (let n = open; n < text.length; n++) {
    if (text[n] === '\\') {
      n++
      continue
    }
    if (text[n] === l) depth++
    else if (text[n] === r && --depth === 0) return n
  }
  return -1
}

/** 不在反斜杠后面的下一个 mark；找不到是 -1。 */
function findMark(text, mark, from) {
  for (let n = from; n <= text.length - mark.length; n++) {
    if (text[n] === '\\') {
      n++
      continue
    }
    if (text.startsWith(mark, n)) return n
  }
  return -1
}

export function parseInline(text) {
  const out = []
  const src = String(text ?? '')
  let buf = ''
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf })
    buf = ''
  }
  for (let i = 0; i < src.length; ) {
    const ch = src[i]
    // 反斜杠转义
    if (ch === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(src[i + 1])) {
      buf += src[i + 1]
      i += 2
      continue
    }
    if (ch === '\n') {
      flush()
      out.push({ t: 'br' })
      i++
      continue
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i) {
        flush()
        out.push({ t: 'code', v: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    // **粗体** __粗体__ ~~删除线~~ *斜体*
    const pair = src.startsWith('**', i) ? '**' : src.startsWith('__', i) ? '__' : src.startsWith('~~', i) ? '~~' : ch === '*' ? '*' : null
    if (pair) {
      const end = findMark(src, pair, i + pair.length)
      const inner = end > i + pair.length ? src.slice(i + pair.length, end) : ''
      if (inner && !/^\s/.test(inner) && !/\s$/.test(inner)) {
        flush()
        out.push({ t: pair === '~~' ? 'del' : pair === '*' ? 'em' : 'strong', c: parseInline(inner) })
        i = end + pair.length
        continue
      }
    }
    // ![图](地址)：大脑已经把图换成了一句话，剩下的只留说明文字
    if (ch === '!' && src[i + 1] === '[') {
      const close = closeBracket(src, i + 1)
      if (close > 0 && src[close + 1] === '(') {
        const end = closeBracket(src, close + 1, '(', ')')
        if (end > 0) {
          flush()
          out.push(...parseInline(src.slice(i + 2, close)))
          i = end + 1
          continue
        }
      }
    }
    if (ch === '[') {
      const close = closeBracket(src, i)
      if (close > 0) {
        const inner = src.slice(i + 1, close)
        // [字](链接)
        if (src[close + 1] === '(') {
          const end = closeBracket(src, close + 1, '(', ')')
          if (end > 0) {
            flush()
            const href = src.slice(close + 2, end).trim().replace(/\s+"[^"]*"$/, '')
            out.push({ t: 'link', href, c: parseInline(inner) })
            i = end + 1
            continue
          }
        }
        // 中文名 [id/meta]：物品的 id
        if (ITEM_REF.test(inner)) {
          flush()
          out.push({ t: 'item', id: inner })
          i = close + 1
          continue
        }
        // [… shown here in the game …]：游戏里这里是一张图、一个配方框……
        if (/shown here in the game/.test(inner)) {
          flush()
          out.push(gamePart(inner))
          i = close + 1
          continue
        }
      }
    }
    if (ch === '<') {
      const tag = /^<(\/?)([a-z]+)\b([^<>]*?)\/?>/i.exec(src.slice(i))
      if (tag) {
        const name = tag[2].toLowerCase()
        if (name === 'br' && !tag[1]) {
          flush()
          out.push({ t: 'br' })
          i += tag[0].length
          continue
        }
        if (!tag[1] && PAIRED_TAGS.has(name)) {
          const closeAt = src.toLowerCase().indexOf(`</${name}>`, i + tag[0].length)
          if (closeAt > 0) {
            flush()
            const c = parseInline(src.slice(i + tag[0].length, closeAt))
            const attr = (key) => {
              const m = new RegExp(`\\b${key}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag[3])
              return m ? (m[2] ?? m[3]) : undefined
            }
            if (name === 'a') {
              const href = attr('href')
              const title = attr('title')
              out.push(href ? { t: 'link', href, c } : title ? { t: 'abbr', title: decodeEntities(title), c } : { t: 'span', c })
            } else if (name === 'code') out.push({ t: 'code', v: src.slice(i + tag[0].length, closeAt) })
            else out.push(TAG_KIND[name] ? { t: TAG_KIND[name], c } : { t: 'span', c })
            i = closeAt + name.length + 3
            continue
          }
        }
      }
    }
    if (ch === '&') {
      const m = /^&(#?[a-z0-9]+);/i.exec(src.slice(i, i + 10))
      if (m && (ENTITIES[m[1].toLowerCase()] !== undefined || /^#\d+$/.test(m[1]))) {
        buf += ENTITIES[m[1].toLowerCase()] ?? String.fromCodePoint(Number(m[1].slice(1)))
        i += m[0].length
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

function decodeEntities(text) {
  return text.replace(/&(#?[a-z0-9]+);/gi, (all, name) => ENTITIES[name.toLowerCase()] ?? (/^#\d+$/.test(name) ? String.fromCodePoint(Number(name.slice(1))) : all))
}

/** 游戏里这里显示的东西：大脑写成英文的一句话，这里认出是哪一种，换成中文的说法；里面的物品照样认。 */
function gamePart(inner) {
  const forms = [
    [/^image shown here in the game(?::\s*([\s\S]*))?$/, '图片'],
    [/^3D scene shown here in the game(?::\s*([\s\S]*))?$/, '立体场景'],
    [/^graph shown here in the game(?::\s*([\s\S]*))?$/, '图表'],
    [/^picture of the block ([\s\S]*?) shown here in the game$/, '方块的样子'],
    [/^([\s\S]*?) (?:is|are) shown here in the game(?: \(([\s\S]*)\))?$/, '配方'],
  ]
  for (const [re, kind] of forms) {
    const m = re.exec(inner.trim())
    if (!m) continue
    const what = [m[1], m[2]].filter((x) => x && x.trim()).join('；')
    return { t: 'game', kind, c: parseInline(what) }
  }
  return { t: 'game', kind: '', c: parseInline(inner) }
}

/** 一段正文的纯文字（搜索结果的那一小段用）：去掉 Markdown 记号和物品的 id，链接只留字。 */
export function plainText(text) {
  const flat = (nodes) => nodes.map((n) => (n.t === 'text' ? n.v : n.t === 'code' ? n.v : n.t === 'br' ? ' ' : n.t === 'item' ? '' : n.c ? flat(n.c) : '')).join('')
  return flat(parseInline(String(text ?? '').replace(/(^|\s)(#{1,6}|>|[-*+]|\d+\.)\s+/g, '$1').replace(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gi, '')))
    .replace(/\s+/g, ' ')
    .replace(/\s*([，。；：、（）！？])\s*/g, '$1')
    .trim()
}
