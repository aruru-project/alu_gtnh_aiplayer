// 方块贴图的图集：textures/atlas.png 是把很多张小贴图拼成的一张大图，textures/atlas.json 说哪张贴图在第几格
// （tools/make-packdata.py textures 生成，格式见 docs/PACKDATA.md）。面板的三维预览用它给方块贴上真的贴图。
// 大脑自己不解这张图，只把文件原样交给面板，并告诉面板每种方块用第几格。

import { isRecord } from '../util.ts'

export interface TextureAtlas {
  /** atlas.png 在哪。 */
  file: string
  /** 一格贴图的边长（像素）。 */
  tile: number
  /** 图集有几列、几行；第 n 格在第 n % columns 列、第 floor(n / columns) 行。 */
  columns: number
  rows: number
  /** 贴图名（blocks.jsonl 的 tex / texTop 那种写法）→ 第几格。 */
  tiles: Map<string, number>
  /** 这份图集的版本（生成时间）。面板把它带在地址里，重新生成以后浏览器不会接着用旧的。 */
  version: string
}

/** atlas.json 的内容 → 图集。对不上格式时抛 Error（消息给人看）。 */
export function parseAtlas(raw: unknown, file: string): TextureAtlas {
  if (!isRecord(raw)) throw new Error('atlas.json 不是一个 JSON 对象')
  const whole = (v: unknown, what: string, max: number): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) throw new Error(`atlas.json 的 ${what} 不对`)
    return v
  }
  const tile = whole(raw.tile, 'tile', 256)
  const columns = whole(raw.columns, 'columns', 1024)
  const rows = whole(raw.rows, 'rows', 4096)
  if (!isRecord(raw.tiles)) throw new Error('atlas.json 里没有 tiles')
  const tiles = new Map<string, number>()
  for (const [name, index] of Object.entries(raw.tiles)) {
    // 指到图集外面的那几条不要，别的照用
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < columns * rows) tiles.set(name, index)
  }
  if (tiles.size === 0) throw new Error('atlas.json 里一张贴图都没有')
  return { file, tile, columns, rows, tiles, version: typeof raw.generatedAt === 'string' ? raw.generatedAt : String(tiles.size) }
}
