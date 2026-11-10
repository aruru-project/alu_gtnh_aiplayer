// 图纸草稿：它自己写程序设计出来、还没发到游戏里的建筑。就是一个盒子，每一格要么空着、要么是一种方块（注册名 + meta）。
// 草稿存在大脑的数据目录里；主人看过同意了，才转成 .schematic 发给身体（见 schematic.ts）。
//
// 程序跑在沙箱里，它交上来的东西不可信：parseDraft 把它当成任意 JSON 逐项检查，过了这一关的才是 Draft。

/** 一种方块。 */
export interface DraftKind {
  id: string
  /** 0–15。 */
  meta: number
}

export interface Draft {
  name: string
  /** x 是东西向（东为正），y 是高，z 是南北向（南为正）。和 Schematica 的 Width / Height / Length 一一对应。 */
  size: { x: number; y: number; z: number }
  /** 格子里的数 n（n ≥ 1）指的是 kinds[n - 1]。 */
  kinds: DraftKind[]
  /** 每格一个数：cells[x + (y * size.z + z) * size.x]；0 是空的。顺序和 .schematic 文件里的一样。 */
  cells: Uint16Array
}

/** 存盘和传输用的样子：格子压成“下标, 连续几格, 下标, 连续几格……”。 */
export interface StoredDraft {
  name: string
  size: { x: number; y: number; z: number }
  /** "注册名" 或 "注册名/meta"。 */
  kinds: string[]
  runs: number[]
}

export const DRAFT_NAME_MAX_CHARS = 60
/** 世界只有 256 高；x、z 给到 256 已经是四个 64×64 的图纸任务那么宽。 */
export const DRAFT_MAX_SIDE = 256
export const DRAFT_MAX_CELLS = 2_000_000
/** .schematic 里一种方块（不分 meta）占一个 12 位的数字 id，0 留给空气。 */
export const DRAFT_MAX_BLOCK_IDS = 4095
export const DRAFT_MAX_KINDS = 8000

/** 草稿不合规：消息是给写程序的模型看的（英文），告诉它哪里不对。 */
export class DraftError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DraftError'
  }
}

/**
 * 草稿名也是发布以后图纸的名字、存盘的文件名：不能带路径和 Windows 文件名不许有的字符，不能以点开头。
 * 和面板、身体对图纸名的规矩一致。
 */
export function isValidDraftName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= DRAFT_NAME_MAX_CHARS &&
    name === name.trim() &&
    !name.startsWith('.') &&
    !name.includes('..') &&
    !/[/\\:*?"<>|\u0000-\u001f]/.test(name)
  )
}

/** "minecraft:wool/14" → { id, meta }。写得不对时返回 undefined。 */
export function parseKind(text: string): DraftKind | undefined {
  const m = /^([^/\s][^/]*:[^/]*[^/\s])(?:\/(\d{1,2}))?$/.exec(text)
  if (!m || m[1]!.length > 200 || /[\u0000-\u001f]/.test(m[1]!)) return undefined
  const meta = m[2] === undefined ? 0 : Number(m[2])
  return meta <= 15 ? { id: m[1]!, meta } : undefined
}

/** { id, meta } → "minecraft:wool/14"；meta 0 不写。 */
export function kindKey(kind: DraftKind): string {
  return kind.meta ? `${kind.id}/${kind.meta}` : kind.id
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function side(v: unknown, axis: string, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new DraftError(`the ${axis} size must be a whole number of at least 1`)
  if (v > max) throw new DraftError(`the ${axis} size is ${v}; the most a blueprint can be is ${max}`)
  return v
}

/** 把一份不可信的草稿（沙箱里的程序交上来的，或者盘上读回来的）检查一遍。不合规就抛 DraftError。 */
export function parseDraft(raw: unknown): Draft {
  if (!isRecord(raw)) throw new DraftError('the draft is not an object')
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (!isValidDraftName(name)) {
    throw new DraftError(
      `"${name.slice(0, 80)}" cannot be a draft name: 1 to ${DRAFT_NAME_MAX_CHARS} characters, not starting with a dot, without / \\ : * ? " < > | or line breaks`,
    )
  }
  const s = isRecord(raw.size) ? raw.size : {}
  const size = { x: side(s.x, 'x', DRAFT_MAX_SIDE), y: side(s.y, 'y', DRAFT_MAX_SIDE), z: side(s.z, 'z', DRAFT_MAX_SIDE) }
  const volume = size.x * size.y * size.z
  if (volume > DRAFT_MAX_CELLS) throw new DraftError(`the blueprint has ${volume} cells; the most is ${DRAFT_MAX_CELLS}`)

  if (!Array.isArray(raw.kinds) || raw.kinds.length > DRAFT_MAX_KINDS) throw new DraftError(`the draft uses too many kinds of block (at most ${DRAFT_MAX_KINDS})`)
  const kinds: DraftKind[] = []
  const seen = new Set<string>()
  for (const text of raw.kinds) {
    const kind = typeof text === 'string' ? parseKind(text) : undefined
    if (!kind) throw new DraftError(`${JSON.stringify(text).slice(0, 80)} is not a block: write a registry name such as "minecraft:planks", or "minecraft:wool/14" for meta 14 (meta is 0 to 15)`)
    if (seen.has(kindKey(kind))) throw new DraftError(`the draft lists the block ${kindKey(kind)} twice`)
    seen.add(kindKey(kind))
    kinds.push(kind)
  }
  if (new Set(kinds.map((k) => k.id)).size > DRAFT_MAX_BLOCK_IDS) throw new DraftError(`the draft uses more than ${DRAFT_MAX_BLOCK_IDS} different blocks`)

  if (!Array.isArray(raw.runs) || raw.runs.length % 2 !== 0) throw new DraftError('the cells of the draft are missing')
  const cells = new Uint16Array(volume)
  let at = 0
  for (let i = 0; i < raw.runs.length; i += 2) {
    const index: unknown = raw.runs[i]
    const count: unknown = raw.runs[i + 1]
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > kinds.length) throw new DraftError('a cell of the draft names a block the draft does not list')
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || at + count > volume) throw new DraftError('the cells of the draft do not match its size')
    if (index !== 0) cells.fill(index, at, at + count)
    at += count
  }
  if (at !== volume) throw new DraftError('the cells of the draft do not match its size')
  return compact({ name, size, kinds, cells })
}

/** 去掉一格都没用上的方块种类（程序可能先放了又全部盖掉），空气当成空。下标随之重排。 */
function compact(draft: Draft): Draft {
  const used = new Uint32Array(draft.kinds.length + 1)
  for (const cell of draft.cells) used[cell]!++
  const remap = new Uint16Array(draft.kinds.length + 1)
  const kinds: DraftKind[] = []
  draft.kinds.forEach((kind, i) => {
    if (used[i + 1] === 0 || kind.id === 'minecraft:air') return
    kinds.push(kind)
    remap[i + 1] = kinds.length
  })
  if (kinds.length === draft.kinds.length) return draft
  const cells = new Uint16Array(draft.cells.length)
  for (let i = 0; i < cells.length; i++) cells[i] = remap[draft.cells[i]!]!
  return { ...draft, kinds, cells }
}

export function storeDraft(draft: Draft): StoredDraft {
  const runs: number[] = []
  const cells = draft.cells
  for (let i = 0; i < cells.length; ) {
    let j = i + 1
    while (j < cells.length && cells[j] === cells[i]) j++
    runs.push(cells[i]!, j - i)
    i = j
  }
  return { name: draft.name, size: { ...draft.size }, kinds: draft.kinds.map(kindKey), runs }
}

/** 草稿里有多少格放了方块。 */
export function blockCount(draft: Draft): number {
  let n = 0
  for (const cell of draft.cells) if (cell !== 0) n++
  return n
}

export interface Material extends DraftKind {
  count: number
}

/** 材料表：每种方块要多少个，多的在前。 */
export function materialsOf(draft: Draft): Material[] {
  const counts = new Uint32Array(draft.kinds.length + 1)
  for (const cell of draft.cells) counts[cell]!++
  return draft.kinds
    .map((kind, i) => ({ ...kind, count: counts[i + 1]! }))
    .filter((m) => m.count > 0)
    .sort((a, b) => b.count - a.count || kindKey(a).localeCompare(kindKey(b)))
}

/** 草稿里 (x, y, z) 那一格的下标（0 是空）。 */
export function cellAt(draft: Draft, x: number, y: number, z: number): number {
  return draft.cells[x + (y * draft.size.z + z) * draft.size.x]!
}
