// 它看过的图（工具结果带的简图、主人传的图片……）留一份给面板的对话日志显示：主人看得到它当时看的是什么。
// 简图还带着画它用的那个盒子（每一格是什么方块），面板据此做可以拖着转的三维预览。
// 只留最近的若干张，旧的自动删；日志里指向已经删掉的图时，面板上显示“图已清理”。

import fs from 'node:fs'
import path from 'node:path'
import { FILE_MODE, ensureDir } from './files.ts'

export const PICTURES_KEPT = 80

const ID = /^[a-z0-9]{1,24}-[a-z0-9]{1,12}$/

export class PictureStore {
  readonly dir: string
  private seq = 0

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'pictures')
    ensureDir(this.dir)
    this.prune()
  }

  /**
   * 存一张 PNG，返回它的编号（面板用 /api/pictures/file?id= 取）。
   * blocks 是画这张图用的盒子（render/scene.ts 的 StoredBlocks），有的话一起存，面板用 /api/pictures/model?id= 取。
   */
  save(png: Buffer, blocks?: unknown): string {
    // 时间在前、序号定长：按名字排就是按先后排。末尾两位随机数只为了重启后同一毫秒里不撞名
    const id = `${Date.now().toString(36).padStart(9, '0')}-${(this.seq++ % 1679616).toString(36).padStart(4, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`
    fs.writeFileSync(path.join(this.dir, `${id}.png`), png, { mode: FILE_MODE })
    if (blocks !== undefined) fs.writeFileSync(path.join(this.dir, `${id}.json`), JSON.stringify(blocks), { mode: FILE_MODE })
    this.prune()
    return id
  }

  /** 这张图的盒子（存的时候给了才有）。读不出来当没有。 */
  blocks(id: string): unknown {
    if (!ID.test(id)) return undefined
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8'))
    } catch {
      return undefined
    }
  }

  get(id: string): Buffer | undefined {
    if (!ID.test(id)) return undefined
    try {
      return fs.readFileSync(path.join(this.dir, `${id}.png`))
    } catch {
      return undefined
    }
  }

  /** 只留最新的 PICTURES_KEPT 张。编号以时间开头、定长，按名字排就是按时间排。 */
  private prune(): void {
    let files: string[]
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.png'))
    } catch {
      return
    }
    if (files.length <= PICTURES_KEPT) return
    files.sort()
    for (const f of files.slice(0, files.length - PICTURES_KEPT)) {
      fs.rmSync(path.join(this.dir, f), { force: true })
      fs.rmSync(path.join(this.dir, `${f.slice(0, -4)}.json`), { force: true })
    }
  }
}
