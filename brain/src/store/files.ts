// 落盘的公共部分：目录 700、文件 600、写入先写临时文件再改名。

import fs from 'node:fs'
import path from 'node:path'

export const DIR_MODE = 0o700
export const FILE_MODE = 0o600

/** 建目录并把权限收紧到 700（已存在的目录也会被改）。 */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  try {
    fs.chmodSync(dir, DIR_MODE)
  } catch {
    /* 不是属主时改不了，留给使用者处理 */
  }
}

export function writeFileAtomic(file: string, content: string): void {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    fs.writeFileSync(tmp, content, { mode: FILE_MODE })
    fs.chmodSync(tmp, FILE_MODE)
    fs.renameSync(tmp, file)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

export function writeJsonAtomic(file: string, data: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`)
}

/** 读 JSON；文件不存在返回 undefined。内容损坏时把坏文件改名留底并返回 undefined，不让进程起不来。 */
export function readJson(file: string): unknown {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  try {
    return JSON.parse(text)
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`
    try {
      fs.renameSync(file, backup)
      console.error(`[store] ${file} 不是合法 JSON，已改名为 ${backup}，按空文件处理`)
    } catch {
      /* ignore */
    }
    return undefined
  }
}

export function appendLine(file: string, line: string): void {
  ensureDir(path.dirname(file))
  const existed = fs.existsSync(file)
  fs.appendFileSync(file, `${line}\n`, { mode: FILE_MODE })
  if (!existed) fs.chmodSync(file, FILE_MODE)
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
