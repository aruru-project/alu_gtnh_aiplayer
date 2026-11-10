// 手册：某一类活具体怎么做。模型要干那类事时才去读（read_manual），不是每一轮都塞进提示词。
// 两处来源：随代码发布的默认手册（brain/manuals/*.md），和数据目录里主人自己写的（<数据目录>/manuals/*.md）。
// 同名时主人的那本盖住默认的；删掉主人的那本就恢复默认。
// 文件格式：第一行是一句“什么时候看这本”，会出现在提示词的手册目录里；后面是正文（Markdown）。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, writeFileAtomic } from './files.ts'

export const MANUAL_NAME_MAX_CHARS = 40
export const MANUAL_SUMMARY_MAX_CHARS = 150
/** 一本手册是整本给模型看的（不受“单个工具结果上限”截断），所以正文自己要有上限。 */
export const MANUAL_BODY_MAX_CHARS = 8000
export const USER_MANUALS_MAX = 50

const SUFFIX = '.md'

export interface Manual {
  name: string
  /** 一句话：什么时候看这本。 */
  summary: string
  body: string
  /** default：随代码发布的；user：主人在面板上写的，或者改过的默认手册。 */
  source: 'default' | 'user'
  /** 主人的这本盖住了一本同名的默认手册。 */
  overridesDefault: boolean
}

/** 名字不合规、内容太长这类问题：消息是给面板上的人看的。 */
export class ManualError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManualError'
  }
}

/**
 * 手册名就是文件名（不带后缀）：字母、数字、汉字、下划线和连字符，以字母、数字或汉字开头。
 * 没有点、斜杠和空白，所以拼成路径后出不了手册目录。
 */
export function isValidManualName(name: string): boolean {
  return name.length <= MANUAL_NAME_MAX_CHARS && /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(name)
}

function parse(text: string): { summary: string; body: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift()
  const summary = (lines.shift() ?? '').trim()
  return { summary, body: lines.join('\n').trim() }
}

/** 内容的指纹：手册被改过以后，模型手里那份旧的就不算“看过”了。 */
export function manualVersion(m: Pick<Manual, 'summary' | 'body'>): string {
  return crypto.createHash('sha256').update(`${m.summary}\n${m.body}`).digest('hex').slice(0, 8)
}

function endMarker(name: string, version: string): string {
  return `[end of manual "${name}", version ${version}]`
}

/** read_manual 给模型看的整本手册。结尾的那一行用来认出“这段工具结果是某本手册完整的原文”。 */
export function manualText(m: Manual): string {
  const by = m.source === 'user' ? ' (written by your owner)' : ''
  return `Manual "${m.name}"${by}: ${m.summary}\n\n${m.body}\n\n${endMarker(m.name, manualVersion(m))}`
}

/** 一段工具结果如果是一本手册完整的原文（没被截断），返回是哪一本、哪个版本。 */
export function manualInText(content: string): { name: string; version: string } | undefined {
  const m = /\[end of manual "([^"\n]+)", version ([0-9a-f]{8})\]\s*$/.exec(content)
  return m ? { name: m[1]!, version: m[2]! } : undefined
}

function readDir(dir: string, source: Manual['source']): Manual[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return [] // 目录还不存在：没有手册
  }
  const out: Manual[] = []
  for (const file of names.sort()) {
    if (!file.endsWith(SUFFIX)) continue
    const name = file.slice(0, -SUFFIX.length)
    if (!isValidManualName(name)) continue
    try {
      const { summary, body } = parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      if (summary.length === 0) continue
      out.push({ name, summary, body, source, overridesDefault: false })
    } catch {
      /* 读不了的文件当它不存在 */
    }
  }
  return out
}

export class ManualStore {
  private readonly defaultDir: string
  private readonly userDir: string

  constructor(defaultDir: string, userDir: string) {
    this.defaultDir = defaultDir
    this.userDir = userDir
  }

  /** 随代码发布的默认手册。 */
  defaults(): Manual[] {
    return readDir(this.defaultDir, 'default')
  }

  /** 模型能看到的全部手册：默认的在前（被主人改过的换成主人的那本），主人自己新写的在后。 */
  list(): Manual[] {
    const user = new Map(readDir(this.userDir, 'user').map((m) => [m.name, m]))
    const out: Manual[] = []
    for (const d of this.defaults()) {
      const mine = user.get(d.name)
      user.delete(d.name)
      out.push(mine ? { ...mine, overridesDefault: true } : d)
    }
    out.push(...[...user.values()].sort((a, b) => a.name.localeCompare(b.name)))
    return out
  }

  /** 按名字找一本；名字的大小写、多写的 .md 后缀都不计较。 */
  get(name: string): Manual | undefined {
    const wanted = name.trim().replace(/\.md$/i, '')
    const all = this.list()
    return all.find((m) => m.name === wanted) ?? all.find((m) => m.name.toLowerCase() === wanted.toLowerCase())
  }

  /** 新建或改写主人的手册。名字和默认手册一样时就是盖住那本默认的。不合规时抛 ManualError。 */
  save(input: { name: string; summary: string; body: string }): Manual {
    const name = input.name.trim()
    if (!isValidManualName(name)) {
      throw new ManualError(`手册名只能用字母、数字、汉字、下划线和连字符（不能有空格、点和斜杠），最长 ${MANUAL_NAME_MAX_CHARS} 个字符`)
    }
    const summary = input.summary.replace(/\s+/g, ' ').trim()
    const body = input.body.replace(/\r\n/g, '\n').trim()
    if (summary.length === 0) throw new ManualError('要写一句“什么时候看这本”，它会出现在给模型的手册目录里')
    if (summary.length > MANUAL_SUMMARY_MAX_CHARS) throw new ManualError(`“什么时候看这本”最长 ${MANUAL_SUMMARY_MAX_CHARS} 个字符`)
    if (body.length === 0) throw new ManualError('手册正文不能是空的')
    if (body.length > MANUAL_BODY_MAX_CHARS) {
      throw new ManualError(`手册正文有 ${body.length} 个字符，最长 ${MANUAL_BODY_MAX_CHARS}。太长就拆成几本`)
    }
    const existing = this.list()
    // 名字不分大小写：免得出现 Base 和 base 两本，模型和人都分不清
    const clash = existing.find((m) => m.name !== name && m.name.toLowerCase() === name.toLowerCase())
    if (clash) throw new ManualError(`已经有一本叫“${clash.name}”的手册（名字不分大小写）`)
    const mine = existing.filter((m) => m.source === 'user')
    if (!mine.some((m) => m.name === name) && mine.length >= USER_MANUALS_MAX) {
      throw new ManualError(`自己写的手册最多 ${USER_MANUALS_MAX} 本`)
    }
    writeFileAtomic(this.userFile(name), `${summary}\n\n${body}\n`)
    return { name, summary, body, source: 'user', overridesDefault: this.defaults().some((d) => d.name === name) }
  }

  /** 删掉主人的那本。它盖着一本默认手册的话，默认的就回来了。返回有没有删到东西。 */
  remove(name: string): boolean {
    if (!isValidManualName(name)) throw new ManualError('手册名不合法')
    const file = this.userFile(name)
    if (!fs.existsSync(file)) return false
    fs.rmSync(file)
    return true
  }

  private userFile(name: string): string {
    ensureDir(this.userDir)
    const file = path.join(this.userDir, `${name}${SUFFIX}`)
    // 名字已经校验过；这里再确认一次拼出来的路径就在手册目录里
    if (path.dirname(path.resolve(file)) !== path.resolve(this.userDir)) throw new ManualError('手册名不合法')
    return file
  }
}
