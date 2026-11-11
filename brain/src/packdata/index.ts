// 本地资料：从客户端整合包导出的、不随游戏进行变化的内容（任务书的名称、描述、前置、要求、奖励；物品的中英文名和矿辞名；
// 配方册；方块颜色和贴图）。静态的在这里查，实时的（谁完成了哪些任务、箱子里有什么、附近有哪些机器）才问服务器。
// 文件由 tools/make-packdata.py 和 tools/export-packdata 生成，放在 brain/packdata/（不进 git），格式见 docs/PACKDATA.md。
//
// 这一层只读文件、建索引、回答查询，不碰 bridge。启动时读一次；目录或某个文件不在、读不了时，对应的那一项是 undefined，
// 用它的工具自己退回去问服务器。

import { CarvingBook } from './carving.ts'
import { StructureBook } from './structures.ts'
import fs from 'node:fs'
import path from 'node:path'
import { BUILTIN_BLOCK_COLORS, parseBlockColor } from './blocks.ts'
import type { BlockColor } from './blocks.ts'
import { RecipeBook } from './recipes.ts'
import { parseAtlas } from './textures.ts'
import type { TextureAtlas } from './textures.ts'
import { ItemTable, parseItem } from './items.ts'
import type { PackItemInfo } from './items.ts'
import { QuestBook, parseQuest, parseQuestLine } from './quests.ts'
import type { PackQuest, PackQuestLine } from './quests.ts'

export { BUILTIN_BLOCK_COLORS } from './blocks.ts'
export type { BlockColor } from './blocks.ts'
export type { TextureAtlas } from './textures.ts'
export { ANY_META, CIRCUIT_ID, RecipeBook } from './recipes.ts'
export type { Recipe, RecipeFluid, RecipeHandler, RecipeSlot, RecipeStack } from './recipes.ts'
export { ItemTable } from './items.ts'
export { StructureBook, structureCells } from './structures.ts'
export { CarvingBook } from './carving.ts'
export type { CarvingGroup, CarvingMatch, CarvingVariant } from './carving.ts'
export type { Structure, StructurePart, StructureRow } from './structures.ts'
export type { PackItemInfo } from './items.ts'
export { QuestBook, isQuestId, logicHolds, normalizeQuestId } from './quests.ts'
export type { PackItem, PackQuest, PackQuestLine, PackQuestReward, PackQuestTask, QuestFilter, QuestMatch, QuestSearchResult, QuestState } from './quests.ts'

export interface PackData {
  /** 资料目录。 */
  dir: string
  /** 任务书（quests.jsonl + questlines.json）。 */
  quests?: QuestBook
  /** 物品表（items.jsonl）。 */
  items?: ItemTable
  /** 方块颜色表（blocks.jsonl）。没有时用 blockColors() 拿内置的小表。 */
  blocks?: BlockColor[]
  /** 方块贴图的图集（textures/）。没有时面板的三维预览按颜色画。 */
  textures?: TextureAtlas
  /** 配方册（handlers.json、recipes.jsonl）。没有时查做法、合成退回去问服务器。 */
  recipes?: RecipeBook
  /** 多方块机器怎么搭（structures.jsonl）。没有时查不了结构。 */
  structures?: StructureBook
  /** 凿子的组（carving.jsonl）：哪些方块能用凿子互相变。没有时查做法、查用途里不提凿子。 */
  carving?: CarvingBook
}

/** 像素画用的方块颜色表：blocks.jsonl 加载到了就用它，否则是内置的 16 色羊毛和 16 色染色粘土。 */
export function blockColors(data: PackData | undefined): readonly BlockColor[] {
  return data?.blocks ?? BUILTIN_BLOCK_COLORS
}

/** 这个大脑读得懂的 quests.jsonl / questlines.json 的格式版本（meta.json 的 quests.format）。 */
export const QUESTS_FORMAT = 1

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 文件不存在时返回 undefined；别的读取错误照抛。 */
function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

/** 一行一个 JSON 的文件：认得出来的行，和认不出来的行数。 */
function parseJsonLines<T>(content: string, parse: (raw: unknown) => T | undefined): { rows: T[]; bad: number } {
  const rows: T[] = []
  let bad = 0
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue
    let row: T | undefined
    try {
      row = parse(JSON.parse(line))
    } catch {
      row = undefined
    }
    if (row === undefined) bad++
    else rows.push(row)
  }
  return { rows, bad }
}

function loadQuests(dir: string, meta: Record<string, unknown>, log: (message: string) => void): QuestBook | undefined {
  const fallback = '任务书改问服务器（内容是英文的）'
  try {
    const questsText = readText(path.join(dir, 'quests.jsonl'))
    const linesText = readText(path.join(dir, 'questlines.json'))
    if (questsText === undefined || linesText === undefined) {
      const missing = [questsText === undefined ? 'quests.jsonl' : '', linesText === undefined ? 'questlines.json' : ''].filter((n) => n.length > 0)
      log(`没有任务书资料（${dir} 里缺 ${missing.join(' 和 ')}），${fallback}。`)
      return undefined
    }
    const info = isRecord(meta.quests) ? meta.quests : {}
    if (typeof info.format === 'number' && info.format !== QUESTS_FORMAT) {
      log(`任务书资料是第 ${info.format} 版格式，这个大脑只认第 ${QUESTS_FORMAT} 版，${fallback}。用 tools/make-packdata.py 重新生成。`)
      return undefined
    }
    const { rows: quests, bad } = parseJsonLines<PackQuest>(questsText, parseQuest)
    const rawLines: unknown = JSON.parse(linesText)
    const lines = (isRecord(rawLines) && Array.isArray(rawLines.lines) ? rawLines.lines : []).map(parseQuestLine).filter((l): l is PackQuestLine => l !== undefined)
    if (quests.length === 0 || lines.length === 0) {
      log(`任务书资料是空的（${quests.length} 个任务、${lines.length} 章），${fallback}。`)
      return undefined
    }
    const book = new QuestBook(quests, lines)
    const from = [typeof info.source === 'string' ? `来自 ${info.source}` : '', typeof info.generatedAt === 'string' ? `${info.generatedAt} 生成` : ''].filter((s) => s.length > 0)
    log(`任务书：${book.size} 个任务、${book.lines.length} 章${from.length > 0 ? `（${from.join('，')}）` : ''}${bad > 0 ? `；quests.jsonl 里有 ${bad} 行认不出来，跳过了` : ''}。`)
    return book
  } catch (e) {
    log(`任务书资料读不了（${reason(e)}），${fallback}。`)
    return undefined
  }
}

function loadItems(dir: string, log: (message: string) => void): ItemTable | undefined {
  try {
    const content = readText(path.join(dir, 'items.jsonl'))
    if (content === undefined) {
      log('没有物品表（items.jsonl）：找物品改问服务器（只认英文名），物品的名字都是服务器给的英文名。')
      return undefined
    }
    const { rows, bad } = parseJsonLines<PackItemInfo>(content, parseItem)
    if (rows.length === 0) {
      log('物品表（items.jsonl）是空的：找物品改问服务器（只认英文名），物品的名字都是服务器给的英文名。')
      return undefined
    }
    const table = new ItemTable(rows)
    log(`物品表：${table.size} 种物品${bad > 0 ? `；items.jsonl 里有 ${bad} 行认不出来，跳过了` : ''}。`)
    return table
  } catch (e) {
    log(`物品表读不了（${reason(e)}）：找物品改问服务器（只认英文名），物品的名字都是服务器给的英文名。`)
    return undefined
  }
}

function loadBlocks(dir: string, log: (message: string) => void): BlockColor[] | undefined {
  const builtin = `像素画用内置的 ${BUILTIN_BLOCK_COLORS.length} 种（羊毛和染色粘土）`
  try {
    const content = readText(path.join(dir, 'blocks.jsonl'))
    if (content === undefined) {
      log(`没有方块颜色表（blocks.jsonl），${builtin}。`)
      return undefined
    }
    const { rows, bad } = parseJsonLines<BlockColor>(content, parseBlockColor)
    if (rows.length === 0) {
      log(`方块颜色表（blocks.jsonl）是空的，${builtin}。`)
      return undefined
    }
    log(`方块颜色表：${rows.length} 种方块${bad > 0 ? `；blocks.jsonl 里有 ${bad} 行认不出来，跳过了` : ''}。`)
    return rows
  } catch (e) {
    log(`方块颜色表读不了（${reason(e)}），${builtin}。`)
    return undefined
  }
}

function loadRecipes(dir: string, log: (message: string) => void): RecipeBook | undefined {
  const fallback = '查做法、查用途退回去问服务器（只有英文，也不全）'
  try {
    const loaded = RecipeBook.load(dir)
    if (!loaded) {
      log(`没有配方册（recipes.jsonl），${fallback}。`)
      return undefined
    }
    const { book, bad, ms } = loaded
    if (book.size - book.fake - bad <= 0) {
      book.close()
      log(`配方册（recipes.jsonl）是空的，${fallback}。`)
      return undefined
    }
    log(`配方册：${book.size - book.fake - bad} 条配方、${book.handlers.length} 个配方页，做得出 ${book.counts.products} 种物品（读了 ${ms} 毫秒${book.fake > 0 ? `；另有 ${book.fake} 条只是示意的不列` : ''}${bad > 0 ? `；${bad} 行认不出来，跳过了` : ''}）。`)
    return book
  } catch (e) {
    log(`配方册读不了（${reason(e)}），${fallback}。`)
    return undefined
  }
}

function loadTextures(dir: string, log: (message: string) => void): TextureAtlas | undefined {
  const flat = '面板的三维预览按方块颜色画'
  try {
    const index = readText(path.join(dir, 'textures', 'atlas.json'))
    const file = path.join(dir, 'textures', 'atlas.png')
    if (index === undefined || !fs.existsSync(file)) {
      log(`没有方块贴图（textures/atlas.json 和 atlas.png），${flat}。生成办法见 docs/PACKDATA.md。`)
      return undefined
    }
    const atlas = parseAtlas(JSON.parse(index), file)
    log(`方块贴图：${atlas.tiles.size} 张（每张 ${atlas.tile} 像素）。`)
    return atlas
  } catch (e) {
    log(`方块贴图读不了（${reason(e)}），${flat}。`)
    return undefined
  }
}

/** 读本地资料。什么情况下都不抛错：读到多少算多少，没读到的在 log 里各说一句。 */
export function loadPackData(dir: string, log: (message: string) => void = () => {}): PackData {
  const data: PackData = { dir }
  if (!fs.existsSync(dir)) {
    log(`没有本地资料（${dir} 不存在）：任务书改问服务器，内容是英文的。生成办法见 docs/PACKDATA.md。`)
    return data
  }
  let meta: Record<string, unknown> = {}
  try {
    const raw: unknown = JSON.parse(readText(path.join(dir, 'meta.json')) ?? '{}')
    if (isRecord(raw)) meta = raw
  } catch (e) {
    log(`meta.json 读不了（${reason(e)}），当它没有。`)
  }
  const quests = loadQuests(dir, meta, log)
  if (quests) data.quests = quests
  const items = loadItems(dir, log)
  if (items) data.items = items
  const blocks = loadBlocks(dir, log)
  if (blocks) data.blocks = blocks
  const textures = loadTextures(dir, log)
  if (textures) data.textures = textures
  const recipes = loadRecipes(dir, log)
  if (recipes) data.recipes = recipes
  try {
    const loaded = StructureBook.load(dir)
    // 文件不在就当没有，不用说
    if (loaded) {
      data.structures = loaded.book
      log(`多方块结构：${loaded.book.machines.length} 台机器、${loaded.rows} 种等级的结构${loaded.bad > 0 ? `（${loaded.bad} 行认不出来，跳过了）` : ''}。`)
    }
  } catch (e) {
    log(`多方块结构（structures.jsonl）读不了（${reason(e)}），当它没有。`)
  }
  try {
    const loaded = CarvingBook.load(dir)
    // 文件不在就当没有，不用说
    if (loaded) {
      data.carving = loaded.book
      log(`凿子的组：${loaded.book.groups.length} 组、${loaded.book.variants} 种方块${loaded.bad > 0 ? `（${loaded.bad} 行认不出来，跳过了）` : ''}。`)
    }
  } catch (e) {
    log(`凿子的组（carving.jsonl）读不了（${reason(e)}），当它没有。`)
  }
  return data
}
