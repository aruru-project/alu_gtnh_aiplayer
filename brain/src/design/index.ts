// “自己出设计”这件事在大脑这边的全部家当：跑程序的沙箱、图纸草稿、主人传的图片。
// 流程：模型写一段程序 → 在沙箱里跑（script/sandbox.ts）→ 程序存下的草稿在这里检查、落盘 → 主人在面板上看过同意 →
// 转成 .schematic 发给身体（schematic.ts + blueprint.put）→ 之后就是普通的图纸，照现有的办法盖。

import path from 'node:path'
import { blockColors } from '../packdata/index.ts'
import type { PackData } from '../packdata/index.ts'
import { DEFAULT_SANDBOX_LIMITS, runProgram } from '../script/sandbox.ts'
import type { SandboxHooks, SandboxLimits, SandboxOutcome } from '../script/sandbox.ts'
import { DEFAULT_RESULT_MAX_CHARS } from '../tools/types.ts'
import { DRAFT_MAX_CELLS, DRAFT_MAX_KINDS, DRAFT_MAX_SIDE, DraftError, blockCount, parseDraft } from './draft.ts'
import type { DraftKind } from './draft.ts'
import { DesignStoreError, DraftStore, IMAGE_MAX_SIDE, ImageStore } from './store.ts'
import type { DraftSummary } from './store.ts'

export { DRAFT_MAX_CELLS, DRAFT_MAX_SIDE, DraftError, blockCount, cellAt, isValidDraftName, kindKey, materialsOf, parseDraft, parseKind, storeDraft } from './draft.ts'
export type { Draft, DraftKind, Material, StoredDraft } from './draft.ts'
export { PngError, decodePng } from './png.ts'
export type { DecodedImage } from './png.ts'
export { PreviewError, renderPreview, symbolsOf } from './preview.ts'
export type { Axis, Box } from './preview.ts'
export { SCHEMATIC_MAX_BYTES, toSchematic } from './schematic.ts'
export { DRAFTS_MAX, DesignStoreError, DraftStore, IMAGES_MAX, IMAGE_MAX_BYTES, IMAGE_MAX_SIDE, IMAGE_NAME_MAX_CHARS, ImageStore, isValidImageName } from './store.ts'
export type { DraftRecord, DraftSummary, ImageInfo } from './store.ts'

/** 一个程序一次最多存这么多张草稿。 */
export const PROGRAM_MAX_DRAFTS = 8
export const PROGRAM_TIMEOUT_MAX_MS = 30_000

export interface ProgramRun {
  outcome: SandboxOutcome
  /** 这次存下来的草稿。 */
  saved: DraftSummary[]
  /** 程序想存、但没存成的草稿，和原因（给模型看，英文）。 */
  rejected: { name: string; reason: string }[]
}

/** 上一个程序还没跑完。 */
export class DesignBusyError extends Error {
  constructor() {
    super('another program is still running')
    this.name = 'DesignBusyError'
  }
}

export interface DesignOptions {
  /** 大脑的数据目录；草稿在它下面的 drafts/，图片在 images/。 */
  dataDir: string
  /** 本地资料（物品表、任务书、方块颜色表）。没有时颜色表用内置的，程序里查不到资料。 */
  packdata?: PackData
  limits?: Partial<SandboxLimits>
  now?: () => number
}

export class DesignWorkspace {
  readonly drafts: DraftStore
  readonly images: ImageStore
  private readonly packdata: PackData | undefined
  private readonly limits: SandboxLimits
  private readonly now: () => number
  private running = false

  constructor(opts: DesignOptions) {
    this.drafts = new DraftStore(path.join(opts.dataDir, 'drafts'))
    this.images = new ImageStore(path.join(opts.dataDir, 'images'))
    this.packdata = opts.packdata
    this.limits = { ...DEFAULT_SANDBOX_LIMITS, ...(opts.limits ?? {}) }
    this.now = opts.now ?? Date.now
  }

  /** 方块的显示名：物品表里有就用它的，否则看方块颜色表里有没有。 */
  nameOf(kind: DraftKind): string | undefined {
    return this.packdata?.items?.get(kind.id, kind.meta)?.name ?? blockColors(this.packdata).find((b) => b.id === kind.id && b.meta === kind.meta)?.name
  }

  /** 程序的日志一共留多少字符（写“日志满了”的说明时用）。 */
  get logChars(): number {
    return this.limits.logChars
  }

  /** 方块颜色表（面板画预览也用它）。 */
  colors(): ReturnType<typeof blockColors> {
    return blockColors(this.packdata)
  }

  /** 程序能查的本地资料：名字 → 文件。文件在不在由沙箱那边再看一次。 */
  private dataFiles(): Record<string, string> {
    const dir = this.packdata?.dir
    if (dir === undefined) return {}
    const files: Record<string, string> = {}
    if (this.packdata?.items) files.items = path.join(dir, 'items.jsonl')
    if (this.packdata?.quests) {
      files.quests = path.join(dir, 'quests.jsonl')
      files.questLines = path.join(dir, 'questlines.json')
    }
    if (this.packdata?.structures) files.structures = path.join(dir, 'structures.jsonl')
    if (this.packdata?.carving) files.carving = path.join(dir, 'carving.jsonl')
    return files
  }

  /**
   * 在沙箱里跑一个程序，把它存下的草稿检查过后落盘。程序本身出了什么事（报错、超时、吃光内存）都在 outcome 里，不抛错；
   * 只有上一个程序还没跑完时抛 DesignBusyError。
   * hooks：程序调工具时怎么办、中途怎么停（见 script/sandbox.ts）。background：这是后台的例程，不占“同时只跑一个程序”的位子
   * （例程要跑很久，不能让它挡着模型临时算点东西；例程自己同时只有一个，由 agent/routine.ts 管）。
   * valueChars：程序 return 的值最多交回来多少字符。调用的人给的是“单个工具结果上限”那个设置现在的值，不另设一个数。
   */
  async run(code: string, opts: { timeoutMs?: number; hooks?: SandboxHooks; background?: boolean; valueChars?: number } = {}): Promise<ProgramRun> {
    if (!opts.background && this.running) throw new DesignBusyError()
    if (!opts.background) this.running = true
    try {
      const timeoutMs = Math.min(PROGRAM_TIMEOUT_MAX_MS, Math.max(100, opts.timeoutMs ?? this.limits.timeoutMs))
      const outcome = await runProgram(
        {
          code,
          palette: this.colors(),
          images: this.images.list().map((i) => ({ name: i.name, width: i.width, height: i.height })),
          imagesDir: this.images.dir,
          data: this.dataFiles(),
          program: {
            maxSide: DRAFT_MAX_SIDE,
            maxCells: DRAFT_MAX_CELLS,
            maxKinds: DRAFT_MAX_KINDS,
            maxDrafts: PROGRAM_MAX_DRAFTS,
            maxPixels: IMAGE_MAX_SIDE * IMAGE_MAX_SIDE * 4,
            valueChars: Math.max(1, Math.floor(opts.valueChars ?? DEFAULT_RESULT_MAX_CHARS)),
          },
        },
        { ...this.limits, timeoutMs },
        opts.hooks,
      )
      const saved: DraftSummary[] = []
      const rejected: ProgramRun['rejected'] = []
      if (outcome.status === 'ok') {
        // 程序交上来的草稿不可信：逐张检查，过关的才存
        for (const raw of outcome.drafts.slice(0, PROGRAM_MAX_DRAFTS)) {
          const name = raw !== null && typeof raw === 'object' && typeof (raw as { name?: unknown }).name === 'string' ? (raw as { name: string }).name : '?'
          try {
            const draft = parseDraft(raw)
            if (blockCount(draft) === 0) throw new DraftError('it is empty: no block was placed in it')
            saved.push(this.drafts.save(draft, { now: this.now(), program: code }))
          } catch (e) {
            if (e instanceof DraftError) rejected.push({ name, reason: e.message })
            else if (e instanceof DesignStoreError) rejected.push({ name, reason: `there are already too many drafts: delete some with delete_draft first` })
            else throw e
          }
        }
      }
      return { outcome, saved, rejected }
    } finally {
      if (!opts.background) this.running = false
    }
  }
}
