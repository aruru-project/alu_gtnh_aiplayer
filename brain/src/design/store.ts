// 数据目录里和“它自己出设计”有关的两样东西：
//   drafts/<名字>.json   图纸草稿：它写程序设计出来、还没发到游戏里的建筑
//   images/<名字>.png    主人在面板上传的图片；旁边的 <名字>.rgba 是解好的像素，沙箱里的程序读的是它

import fs from 'node:fs'
import path from 'node:path'
import { FILE_MODE, ensureDir, writeFileAtomic } from '../store/files.ts'
import { blockCount, parseDraft, storeDraft } from './draft.ts'
import type { Draft, StoredDraft } from './draft.ts'
import { PngError, decodePng } from './png.ts'
import type { DecodedImage } from './png.ts'

export const DRAFTS_MAX = 40
export const IMAGES_MAX = 30
export const IMAGE_NAME_MAX_CHARS = 40
/** 图片最长的那一边。面板上传前就缩到这么大了；像素画用不着更大的。 */
export const IMAGE_MAX_SIDE = 256
export const IMAGE_MAX_BYTES = 512 * 1024
/** 草稿里留着的程序源码最多这么长。 */
export const DRAFT_PROGRAM_MAX_CHARS = 20_000

/** 存不了、名字不对、超了上限：消息给面板上的人看（中文）。 */
export class DesignStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DesignStoreError'
  }
}

export interface DraftSummary {
  name: string
  size: { x: number; y: number; z: number }
  /** 放了方块的格子数。 */
  blocks: number
  /** 用了几种方块。 */
  kinds: number
  savedAt: number
}

export interface DraftRecord {
  draft: Draft
  savedAt: number
  /** 生成它的程序。 */
  program?: string
}

interface DraftFile extends StoredDraft {
  savedAt: number
  blocks: number
  program?: string
}

export class DraftStore {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  private file(name: string): string {
    return path.join(this.dir, `${name}.json`)
  }

  private read(file: string): DraftRecord | undefined {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
      const record: DraftRecord = { draft: parseDraft(raw), savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0 }
      if (typeof raw.program === 'string') record.program = raw.program
      return record
    } catch {
      return undefined // 不在，或者坏了：当它没有
    }
  }

  /** 全部草稿，新的在前。 */
  list(): DraftSummary[] {
    let names: string[]
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return []
    }
    const out: DraftSummary[] = []
    for (const entry of names) {
      if (!entry.endsWith('.json')) continue
      const record = this.read(path.join(this.dir, entry))
      // 文件名和里面的名字对不上的不认（有人手动改过名）
      if (!record || `${record.draft.name}.json` !== entry) continue
      out.push({ name: record.draft.name, size: record.draft.size, blocks: blockCount(record.draft), kinds: record.draft.kinds.length, savedAt: record.savedAt })
    }
    return out.sort((a, b) => b.savedAt - a.savedAt || a.name.localeCompare(b.name))
  }

  get(name: string): DraftRecord | undefined {
    const record = this.read(this.file(name))
    return record && record.draft.name === name ? record : undefined
  }

  /** 存一张草稿，同名的盖掉。已经有 DRAFTS_MAX 张、这又是个新名字时抛 DesignStoreError。 */
  save(draft: Draft, extra: { now: number; program?: string }): DraftSummary {
    const existing = this.list()
    if (!existing.some((d) => d.name === draft.name) && existing.length >= DRAFTS_MAX) {
      throw new DesignStoreError(`草稿已经有 ${DRAFTS_MAX} 张了，先删掉几张不要的`)
    }
    const blocks = blockCount(draft)
    const file: DraftFile = { ...storeDraft(draft), savedAt: extra.now, blocks }
    if (extra.program !== undefined) file.program = extra.program.slice(0, DRAFT_PROGRAM_MAX_CHARS)
    ensureDir(this.dir)
    writeFileAtomic(this.file(draft.name), `${JSON.stringify(file)}\n`)
    return { name: draft.name, size: draft.size, blocks, kinds: draft.kinds.length, savedAt: extra.now }
  }

  remove(name: string): boolean {
    if (!this.get(name)) return false
    fs.rmSync(this.file(name), { force: true })
    return true
  }
}

export interface ImageInfo {
  name: string
  width: number
  height: number
  /** PNG 文件的大小。 */
  bytes: number
  uploadedAt: number
}

/**
 * 图片名就是文件名（不带后缀），程序里也用它指这张图：字母、数字、汉字、下划线和连字符，以字母、数字或汉字开头。
 * 没有点、斜杠和空白，所以拼成路径后出不了图片目录。
 */
export function isValidImageName(name: string): boolean {
  return name.length <= IMAGE_NAME_MAX_CHARS && /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(name)
}

const RAW_MAGIC = 'RGBA'

export class ImageStore {
  readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  private pngFile(name: string): string {
    return path.join(this.dir, `${name}.png`)
  }

  private rawFile(name: string): string {
    return path.join(this.dir, `${name}.rgba`)
  }

  /** 解好的像素存一份：4 字节 "RGBA"，宽、高各 4 字节（大端），然后是像素。沙箱里的程序读这个，不用再解 PNG。 */
  private writeRaw(name: string, image: DecodedImage): void {
    const head = Buffer.alloc(12)
    head.write(RAW_MAGIC, 0, 'latin1')
    head.writeUInt32BE(image.width, 4)
    head.writeUInt32BE(image.height, 8)
    const tmp = `${this.rawFile(name)}.${process.pid}.tmp`
    fs.writeFileSync(tmp, Buffer.concat([head, image.rgba]), { mode: FILE_MODE })
    fs.renameSync(tmp, this.rawFile(name))
  }

  /** 全部图片，新的在前。顺手把缺了像素文件的补上（比如有人直接把 PNG 拷进了目录）。 */
  list(): ImageInfo[] {
    let names: string[]
    try {
      names = fs.readdirSync(this.dir)
    } catch {
      return []
    }
    const out: ImageInfo[] = []
    for (const entry of names) {
      if (!entry.endsWith('.png')) continue
      const name = entry.slice(0, -'.png'.length)
      if (!isValidImageName(name)) continue
      try {
        const stat = fs.statSync(this.pngFile(name))
        if (stat.size > IMAGE_MAX_BYTES) continue
        const png = fs.readFileSync(this.pngFile(name))
        // 宽和高就在文件头里：8 字节签名、8 字节块头之后
        if (png.length < 24) continue
        let width = png.readUInt32BE(16)
        let height = png.readUInt32BE(20)
        if (width > IMAGE_MAX_SIDE || height > IMAGE_MAX_SIDE) continue
        if (!fs.existsSync(this.rawFile(name))) {
          const image = decodePng(png, { maxPixels: IMAGE_MAX_SIDE * IMAGE_MAX_SIDE })
          this.writeRaw(name, image)
          width = image.width
          height = image.height
        }
        out.push({ name, width, height, bytes: stat.size, uploadedAt: Math.round(stat.mtimeMs) })
      } catch {
        /* 读不了的图不列出来 */
      }
    }
    return out.sort((a, b) => b.uploadedAt - a.uploadedAt || a.name.localeCompare(b.name))
  }

  /** 存一张图（同名的盖掉）。不是能读的 PNG、太大、名字不对、已经存满时抛 DesignStoreError。 */
  save(name: string, png: Buffer): ImageInfo {
    if (!isValidImageName(name)) {
      throw new DesignStoreError(`图片名字只能用字母、数字、汉字、下划线和连字符，以字母、数字或汉字开头，最长 ${IMAGE_NAME_MAX_CHARS} 个字符`)
    }
    if (png.length > IMAGE_MAX_BYTES) throw new DesignStoreError(`这张图有 ${Math.ceil(png.length / 1024)} KiB，最大 ${IMAGE_MAX_BYTES / 1024} KiB`)
    let image: DecodedImage
    try {
      image = decodePng(png, { maxPixels: IMAGE_MAX_SIDE * IMAGE_MAX_SIDE })
    } catch (e) {
      throw new DesignStoreError(e instanceof PngError ? e.message : '这张图读不了')
    }
    if (image.width > IMAGE_MAX_SIDE || image.height > IMAGE_MAX_SIDE) {
      throw new DesignStoreError(`这张图是 ${image.width}×${image.height}，每一边最大 ${IMAGE_MAX_SIDE} 像素`)
    }
    const existing = this.list()
    if (!existing.some((i) => i.name === name) && existing.length >= IMAGES_MAX) throw new DesignStoreError(`图片已经有 ${IMAGES_MAX} 张了，先删掉几张不用的`)
    ensureDir(this.dir)
    const tmp = `${this.pngFile(name)}.${process.pid}.tmp`
    fs.writeFileSync(tmp, png, { mode: FILE_MODE })
    fs.renameSync(tmp, this.pngFile(name))
    this.writeRaw(name, image)
    return { name, width: image.width, height: image.height, bytes: png.length, uploadedAt: Math.round(fs.statSync(this.pngFile(name)).mtimeMs) }
  }

  /** 原图（PNG 文件的内容）。 */
  png(name: string): Buffer | undefined {
    if (!isValidImageName(name)) return undefined
    try {
      return fs.readFileSync(this.pngFile(name))
    } catch {
      return undefined
    }
  }

  remove(name: string): boolean {
    if (!isValidImageName(name) || !fs.existsSync(this.pngFile(name))) return false
    fs.rmSync(this.pngFile(name), { force: true })
    fs.rmSync(this.rawFile(name), { force: true })
    return true
  }
}
