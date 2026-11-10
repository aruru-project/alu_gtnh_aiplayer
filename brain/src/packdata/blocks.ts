// 方块颜色表：blocks.jsonl，一行一种方块和它贴图的平均色（格式见 docs/PACKDATA.md）。
// 两个用处：像素画把图片上的一个颜色换成颜色最接近的方块；简图（render/）按它给方块上色。
// 文件不在时用下面这份内置的小表。

export interface BlockColor {
  id: string
  meta: number
  /** 显示名（中文），可能没有。 */
  name?: string
  /** 英文名，可能没有。 */
  en?: string
  /** 贴图的平均色：红、绿、蓝，0–255。侧面的颜色；顶面一样时就只有这一个。 */
  color: [number, number, number]
  /** 顶面的颜色，和侧面不一样时才有（草方块、原木、工作台这类）。 */
  top?: [number, number, number]
  /** 侧面的贴图名（游戏里的图标名，如 "wool_colored_red"、"chisel:marble/raw"），可能没有。 */
  tex?: string
  /** 顶面的贴图名，和侧面不一样时才有。 */
  texTop?: string
}

const COLOR_NAMES = ['白色', '橙色', '品红色', '淡蓝色', '黄色', '黄绿色', '粉红色', '灰色', '淡灰色', '青色', '紫色', '蓝色', '棕色', '绿色', '红色', '黑色']

// 原版 1.7.10 客户端贴图（wool_colored_*.png、hardened_clay_stained_*.png，都是 16×16）逐像素取平均、四舍五入得到的；
// 顺序就是 meta 0–15。
const WOOL: [number, number, number][] = [
  [222, 222, 222],
  [219, 125, 63],
  [180, 81, 189],
  [107, 138, 201],
  [177, 166, 39],
  [66, 174, 57],
  [208, 132, 153],
  [64, 64, 64],
  [155, 161, 161],
  [47, 111, 137],
  [127, 62, 182],
  [46, 57, 142],
  [79, 51, 31],
  [53, 71, 27],
  [151, 52, 49],
  [26, 22, 22],
]
const STAINED_CLAY: [number, number, number][] = [
  [210, 178, 161],
  [162, 84, 38],
  [150, 88, 109],
  [113, 109, 138],
  [186, 133, 35],
  [104, 118, 53],
  [162, 78, 79],
  [58, 42, 36],
  [135, 107, 98],
  [87, 91, 91],
  [118, 70, 86],
  [74, 60, 91],
  [77, 51, 36],
  [76, 83, 42],
  [143, 61, 47],
  [37, 23, 16],
]

/** 内置的小表：16 色羊毛和 16 色染色粘土。blocks.jsonl 不在时，像素画靠它也能做。 */
export const BUILTIN_BLOCK_COLORS: readonly BlockColor[] = [
  ...WOOL.map((color, meta): BlockColor => ({ id: 'minecraft:wool', meta, name: `${COLOR_NAMES[meta]}羊毛`, color })),
  ...STAINED_CLAY.map((color, meta): BlockColor => ({ id: 'minecraft:stained_hardened_clay', meta, name: `${COLOR_NAMES[meta]}染色粘土`, color })),
]

function isColor(c: unknown): c is [number, number, number] {
  return Array.isArray(c) && c.length === 3 && c.every((v) => typeof v === 'number' && v >= 0 && v <= 255)
}

/** blocks.jsonl 的一行。认不出来（没有 id、颜色不是三个 0–255 的数）时返回 undefined。 */
export function parseBlockColor(raw: unknown): BlockColor | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id.includes(':')) return undefined
  const c = r.color
  if (!isColor(c)) return undefined
  // 世界里一个方块的 meta 只有 0–15；别的值（那是物品的 meta）图纸里放不下
  const meta = r.meta === undefined ? 0 : r.meta
  if (typeof meta !== 'number' || !Number.isInteger(meta) || meta < 0 || meta > 15) return undefined
  const block: BlockColor = { id: r.id, meta, color: [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])] }
  if (typeof r.name === 'string' && r.name.length > 0) block.name = r.name
  if (typeof r.en === 'string' && r.en.length > 0) block.en = r.en
  // 顶面颜色写坏了不连累这一行：当它没有
  if (isColor(r.top)) block.top = [Math.round(r.top[0]), Math.round(r.top[1]), Math.round(r.top[2])]
  if (typeof r.tex === 'string' && r.tex.length > 0) block.tex = r.tex
  if (typeof r.texTop === 'string' && r.texTop.length > 0) block.texTop = r.texTop
  return block
}
