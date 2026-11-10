// 一种方块在简图上长什么样：侧面和顶面的颜色、透不透、占多大地方。
// 颜色先查方块颜色表（blocks.jsonl，只有整块的方块），再查下面这份内置的补充（草、水、树叶、玻璃这些颜色表里没有的常见方块），
// 再按名字猜（别的模组的树叶、玻璃、水……），都不行就由名字算一个固定的颜色：看得出是不同的方块，但不是它真实的颜色。

import { BUILTIN_BLOCK_COLORS } from '../packdata/blocks.ts'
import type { BlockColor } from '../packdata/blocks.ts'
import type { RGB } from './raster.ts'

export interface BlockKind {
  id: string
  meta: number
}

/**
 * 占多大地方（都是示意）：full 整格；slab 下半格；small 中间一小块（花草、火把）；flat 贴地一薄层（地毯、铁轨、雪）；
 * post 中间一根柱子（栅栏、墙、玻璃板）。
 */
export type Shape = 'full' | 'slab' | 'small' | 'flat' | 'post'

/** 颜色是哪来的：table 颜色表；builtin 内置的补充；guess 按名字猜的一类（树叶、玻璃……）；hash 由名字算的，只为了区分。 */
export type LookSource = 'table' | 'builtin' | 'guess' | 'hash'

export interface BlockLook {
  side: RGB
  top: RGB
  /** 不透明度，0–1。玻璃、水、冰小于 1。 */
  alpha: number
  shape: Shape
  source: LookSource
  /** 这不是方块，是图上标位置用的记号（自己、别的玩家）。 */
  marker?: boolean
  /** 侧面、顶面的贴图名（面板的三维预览用；简图只用颜色）。没有就按颜色画。 */
  tex?: string
  texTop?: string
  /** 贴图是灰的、要再染上这个颜色的（草的顶面、树叶）：侧面和顶面各自的染色。 */
  tint?: RGB
  tintTop?: RGB
}

/** 还没加载的区块里的格子（world.blocks 记成 id 为 "?" 的方块）。 */
export const UNLOADED_ID = '?'
/** 图上标位置用的假方块：id 是 "@名字"。 */
export const MARKER_PREFIX = '@'

export function isAir(kind: BlockKind): boolean {
  return kind.id === 'minecraft:air'
}

/** "minecraft:wool/14"；meta 0 不写。 */
export function kindKey(kind: BlockKind): string {
  return kind.meta ? `${kind.id}/${kind.meta}` : kind.id
}

/**
 * 由名字算出一个固定的颜色：色相和明暗都取自名字的散列。
 * 品红和青色那两段色相留给位置记号（自己、别的玩家），算出来的颜色避开它们，免得把一台机器看成一个人。
 */
export function stableColor(key: string): [number, number, number] {
  let hash = 2166136261
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619)
  hash = Math.imul(hash ^ (hash >>> 15), 2246822519)
  hash = (hash ^ (hash >>> 13)) >>> 0
  // 可用的色相：0–170、205–285、345–360，一共 265 度
  const slot = hash % 265
  const hue = slot < 170 ? slot : slot < 250 ? slot + 35 : slot + 95
  const light = 0.4 + ((hash >>> 9) % 30) / 100
  const spread = 0.5 * Math.min(light, 1 - light)
  const channel = (offset: number): number => {
    const k = (offset + hue / 30) % 12
    return Math.round(255 * (light - spread * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [channel(0), channel(8), channel(4)]
}

type Builtin = { side: RGB; top?: RGB; alpha?: number; shape?: Shape; tex?: string; texTop?: string; tint?: RGB; tintTop?: RGB }

const DIRT: RGB = [134, 96, 67]
const OAK: RGB = [156, 127, 78]
const COBBLE: RGB = [122, 122, 122]
const LEAF: RGB = [58, 120, 40]
const PLANT: RGB = [84, 150, 52]
// 原版的草顶面和树叶贴图是灰的，游戏按群系染色：这里用平原的草色和默认的树叶色
const GRASS_TINT: RGB = [145, 189, 89]
const LEAF_TINT: RGB = [72, 181, 24]
const LEAVES: Builtin = { side: LEAF, tex: 'leaves_oak', tint: LEAF_TINT }
const WATER: Builtin = { side: [52, 95, 218], alpha: 0.6, tex: 'water_still' }
const LAVA: Builtin = { side: [214, 96, 20], tex: 'lava_still' }
const GLASS: Builtin = { side: [196, 224, 236], alpha: 0.35, tex: 'glass' }
const PLANT_SMALL: Builtin = { side: PLANT, shape: 'small' }
const post = (side: RGB, alpha = 1): Builtin => ({ side, shape: 'post', alpha })
const flat = (side: RGB): Builtin => ({ side, shape: 'flat' })
const small = (side: RGB): Builtin => ({ side, shape: 'small' })

// 原版里颜色表没有的常见方块（颜色表只收贴图是一整块的方块），和没有颜色表时也该认得的那几样（石头、泥土、木头……）。
// 颜色是照着游戏里的样子定的近似值；颜色表里有的以颜色表为准。
const BUILTIN: Record<string, Builtin> = {
  'minecraft:stone': { side: [125, 125, 125], tex: 'stone' },
  'minecraft:cobblestone': { side: COBBLE, tex: 'cobblestone' },
  'minecraft:dirt': { side: DIRT, tex: 'dirt' },
  'minecraft:sand': { side: [219, 211, 160], tex: 'sand' },
  'minecraft:gravel': { side: [126, 124, 122], tex: 'gravel' },
  'minecraft:bedrock': { side: [83, 83, 83], tex: 'bedrock' },
  'minecraft:sandstone': { side: [218, 210, 158], tex: 'sandstone_normal', texTop: 'sandstone_top' },
  'minecraft:planks': { side: OAK, tex: 'planks_oak' },
  'minecraft:log': { side: [102, 81, 49], top: [155, 125, 77], tex: 'log_oak', texTop: 'log_oak_top' },
  'minecraft:log2': { side: [105, 99, 89], top: [169, 91, 51], tex: 'log_acacia', texTop: 'log_acacia_top' },
  'minecraft:stonebrick': { side: [122, 122, 122], tex: 'stonebrick' },
  'minecraft:brick_block': { side: [146, 99, 86], tex: 'brick' },
  'minecraft:obsidian': { side: [20, 18, 29], tex: 'obsidian' },
  'minecraft:snow': { side: [239, 251, 251], tex: 'snow' },
  'minecraft:clay': { side: [158, 164, 176], tex: 'clay' },
  'minecraft:netherrack': { side: [111, 54, 52], tex: 'netherrack' },
  'minecraft:crafting_table': { side: [129, 106, 70], top: [107, 71, 42], tex: 'crafting_table_side', texTop: 'crafting_table_top' },
  'minecraft:grass': { side: [126, 108, 66], top: [106, 168, 64], tex: 'grass_side', texTop: 'grass_top', tintTop: GRASS_TINT },
  'minecraft:farmland': { side: DIRT, top: [97, 62, 34], tex: 'dirt', texTop: 'farmland_dry' },
  'minecraft:water': WATER,
  'minecraft:flowing_water': WATER,
  'minecraft:lava': LAVA,
  'minecraft:flowing_lava': LAVA,
  'minecraft:leaves': LEAVES,
  'minecraft:leaves2': LEAVES,
  'minecraft:glass': GLASS,
  'minecraft:glass_pane': { ...GLASS, shape: 'post' },
  'minecraft:ice': { side: [160, 190, 250], alpha: 0.7, tex: 'ice' },
  'minecraft:snow_layer': { side: [239, 251, 251], shape: 'flat', tex: 'snow' },
  'minecraft:cactus': { side: [20, 110, 30], tex: 'cactus_side', texTop: 'cactus_top' },
  'minecraft:reeds': { side: [130, 170, 90], shape: 'post' },
  'minecraft:tallgrass': PLANT_SMALL,
  'minecraft:double_plant': PLANT_SMALL,
  'minecraft:deadbush': small([120, 90, 45]),
  'minecraft:sapling': PLANT_SMALL,
  'minecraft:vine': PLANT_SMALL,
  'minecraft:waterlily': flat([30, 110, 40]),
  'minecraft:wheat': small([190, 170, 60]),
  'minecraft:carrots': PLANT_SMALL,
  'minecraft:potatoes': PLANT_SMALL,
  'minecraft:yellow_flower': small([230, 210, 40]),
  'minecraft:red_flower': small([210, 50, 50]),
  'minecraft:brown_mushroom': small([145, 110, 85]),
  'minecraft:red_mushroom': small([200, 40, 40]),
  'minecraft:torch': small([255, 216, 60]),
  'minecraft:redstone_torch': small([220, 40, 20]),
  'minecraft:unlit_redstone_torch': small([110, 30, 20]),
  'minecraft:fire': small([255, 140, 20]),
  'minecraft:chest': { side: [160, 115, 40] },
  'minecraft:trapped_chest': { side: [160, 115, 40] },
  'minecraft:furnace': { side: [110, 110, 110], tex: 'furnace_side', texTop: 'furnace_top' },
  'minecraft:lit_furnace': { side: [130, 110, 100], tex: 'furnace_side', texTop: 'furnace_top' },
  'minecraft:fence': post(OAK),
  'minecraft:fence_gate': post(OAK),
  'minecraft:nether_brick_fence': post([45, 22, 27]),
  'minecraft:cobblestone_wall': post(COBBLE),
  'minecraft:iron_bars': post([110, 110, 110]),
  'minecraft:wooden_door': post(OAK),
  'minecraft:iron_door': post([190, 190, 190]),
  'minecraft:ladder': post(OAK),
  'minecraft:trapdoor': flat(OAK),
  'minecraft:rail': flat([125, 110, 90]),
  'minecraft:golden_rail': flat([170, 140, 60]),
  'minecraft:detector_rail': flat([125, 100, 90]),
  'minecraft:activator_rail': flat([125, 100, 90]),
  'minecraft:redstone_wire': flat([170, 20, 10]),
  'minecraft:stone_pressure_plate': flat([125, 125, 125]),
  'minecraft:wooden_pressure_plate': flat(OAK),
  'minecraft:bed': { side: [150, 40, 40], shape: 'slab' },
  'minecraft:mob_spawner': { side: [30, 45, 60] },
  'minecraft:web': small([230, 230, 230]),
  'minecraft:portal': { side: [90, 20, 190], alpha: 0.7 },
  'minecraft:end_portal_frame': { side: [90, 120, 90], top: [40, 90, 80] },
}

/**
 * 原版里“另一种方块换了个形状”的那些（楼梯、半砖、地毯、染色玻璃）：颜色照着原来那种方块查，形状和透明度用这里的。
 * fallback 是颜色表里查不到原来那种方块时用的颜色（只有内置小表时）。
 */
interface Alias {
  as: (meta: number) => BlockKind
  fallback: RGB
  shape?: Shape
  alpha?: number
  /** 不用原来那种方块的贴图，用这张（染色玻璃有自己的贴图）。 */
  tex?: (meta: number) => string
}
// 原版染色方块贴图名里的颜色，按 meta
const DYES = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'silver', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']
const stainedGlass = (meta: number): string => `glass_${DYES[meta & 15]}`
const wool = (meta: number): BlockKind => ({ id: 'minecraft:wool', meta })
const planks = (meta: number): BlockKind => ({ id: 'minecraft:planks', meta: meta <= 5 ? meta : 0 })
const block = (id: string, meta = 0) => (): BlockKind => ({ id: `minecraft:${id}`, meta })
// 石台阶的 meta 低 3 位是材质：石头、砂岩、（旧的）木头、圆石、砖、石砖、地狱砖、石英
const STONE_SLABS = [block('double_stone_slab'), block('sandstone'), block('planks'), block('cobblestone'), block('brick_block'), block('stonebrick'), block('nether_brick'), block('quartz_block')]
const stairsOf = (as: () => BlockKind, fallback: RGB): Alias => ({ as, fallback })
const ALIASES: Record<string, Alias> = {
  'minecraft:stained_glass': { as: wool, fallback: GLASS.side, alpha: 0.45, tex: stainedGlass },
  'minecraft:stained_glass_pane': { as: wool, fallback: GLASS.side, alpha: 0.45, shape: 'post', tex: stainedGlass },
  'minecraft:carpet': { as: wool, fallback: [222, 222, 222], shape: 'flat' },
  'minecraft:wooden_slab': { as: (meta) => planks(meta & 7), fallback: OAK, shape: 'slab' },
  'minecraft:double_wooden_slab': { as: (meta) => planks(meta & 7), fallback: OAK },
  'minecraft:stone_slab': { as: (meta) => STONE_SLABS[meta & 7]!(), fallback: [160, 160, 160], shape: 'slab' },
  'minecraft:oak_stairs': stairsOf(() => planks(0), OAK),
  'minecraft:spruce_stairs': stairsOf(() => planks(1), [103, 77, 46]),
  'minecraft:birch_stairs': stairsOf(() => planks(2), [195, 179, 123]),
  'minecraft:jungle_stairs': stairsOf(() => planks(3), [154, 110, 77]),
  'minecraft:acacia_stairs': stairsOf(() => planks(4), [169, 91, 51]),
  'minecraft:dark_oak_stairs': stairsOf(() => planks(5), [61, 39, 18]),
  'minecraft:stone_stairs': stairsOf(block('cobblestone'), COBBLE),
  'minecraft:brick_stairs': stairsOf(block('brick_block'), [146, 99, 86]),
  'minecraft:stone_brick_stairs': stairsOf(block('stonebrick'), [122, 122, 122]),
  'minecraft:nether_brick_stairs': stairsOf(block('nether_brick'), [45, 22, 27]),
  'minecraft:sandstone_stairs': stairsOf(block('sandstone'), [218, 210, 158]),
  'minecraft:quartz_stairs': stairsOf(block('quartz_block'), [236, 233, 226]),
}

// 按名字猜一类：别的模组里的树叶、水、玻璃、花草……名字里通常带着这些词。
const GUESSES: { test: RegExp; look: Builtin }[] = [
  { test: /leaves|leaf/i, look: LEAVES },
  { test: /lava/i, look: LAVA },
  { test: /water/i, look: WATER },
  { test: /glass.*pane|pane.*glass/i, look: { ...GLASS, shape: 'post' } },
  { test: /glass/i, look: GLASS },
  { test: /sapling|flower|tallgrass|tall_grass|plant|crop|bush|mushroom(?!.*block)|foliage/i, look: PLANT_SMALL },
  { test: /torch/i, look: small([255, 216, 60]) },
]

// 名字看得出不是整块的：颜色还是查不到（由名字算），但至少形状别画成一整格。
const SHAPES: { test: RegExp; shape: Shape }[] = [
  { test: /slab|halfstep|half_step/i, shape: 'slab' },
  { test: /fence|wall(?!paper)|pane|bars|pole|pillar_thin|ladder|door(?!.*block)/i, shape: 'post' },
  { test: /carpet|rail|pressure_?plate|snow_?layer|trapdoor|redstone_?wire|cover|panel/i, shape: 'flat' },
  { test: /button|lever|torch|sign|flower|sapling/i, shape: 'small' },
]

/** 原版里 meta 的一部分是朝向或上下半格、不是另一种方块的那些：查颜色时把这部分去掉。 */
function tableMeta(kind: BlockKind): number {
  if (kind.id === 'minecraft:log' || kind.id === 'minecraft:log2') return kind.meta & 3
  if (kind.id === 'minecraft:quartz_block' && kind.meta > 2) return 2
  if (kind.id === 'minecraft:hay_block') return 0
  return kind.meta
}

/** 查一种方块长什么样。一张表建一个，查过的记着。 */
export class BlockLooks {
  private readonly table = new Map<string, BlockColor>()
  private readonly seen = new Map<string, BlockLook>()

  constructor(table: readonly BlockColor[]) {
    // 同一种方块在表里出现两次时用头一次的；内置的羊毛和染色粘土垫在最后（表里有就用表里的）
    for (const row of [...table, ...BUILTIN_BLOCK_COLORS]) {
      const key = kindKey(row)
      if (!this.table.has(key)) this.table.set(key, row)
    }
  }

  of(kind: BlockKind): BlockLook {
    const key = kindKey(kind)
    let look = this.seen.get(key)
    if (!look) {
      look = this.find(kind)
      this.seen.set(key, look)
    }
    return look
  }

  private find(kind: BlockKind): BlockLook {
    if (kind.id === UNLOADED_ID) return { side: [44, 44, 52], top: [44, 44, 52], alpha: 1, shape: 'full', source: 'builtin' }
    if (kind.id.startsWith(MARKER_PREFIX)) {
      const color = stableMarkerColor(kind.meta)
      return { side: color, top: color, alpha: 1, shape: 'post', source: 'builtin', marker: true }
    }
    const row = this.table.get(kindKey({ id: kind.id, meta: tableMeta(kind) }))
    if (row) return withTextures({ side: row.color, top: row.top ?? row.color, alpha: 1, shape: 'full', source: 'table' }, row.tex, row.texTop)
    const alias = ALIASES[kind.id]
    if (alias) {
      const like = this.table.get(kindKey(alias.as(kind.meta)))
      const side = like?.color ?? alias.fallback
      const look: BlockLook = { side, top: like?.top ?? side, alpha: alias.alpha ?? 1, shape: alias.shape ?? 'full', source: like ? 'table' : 'builtin' }
      return alias.tex ? withTextures(look, alias.tex(kind.meta)) : withTextures(look, like?.tex, like?.texTop)
    }
    const builtin = BUILTIN[kind.id]
    if (builtin) return fromBuiltin(builtin, 'builtin')
    const guess = GUESSES.find((g) => g.test.test(kind.id))
    if (guess) return fromBuiltin(guess.look, 'guess')
    const color = stableColor(kindKey(kind))
    return { side: color, top: color, alpha: 1, shape: SHAPES.find((s) => s.test.test(kind.id))?.shape ?? 'full', source: 'hash' }
  }
}

function withTextures(look: BlockLook, tex: string | undefined, texTop?: string): BlockLook {
  if (tex !== undefined) look.tex = tex
  if (texTop !== undefined && texTop !== tex) look.texTop = texTop
  return look
}

function fromBuiltin(b: Builtin, source: LookSource): BlockLook {
  const look = withTextures({ side: b.side, top: b.top ?? b.side, alpha: b.alpha ?? 1, shape: b.shape ?? 'full', source }, b.tex, b.texTop)
  if (b.tint) look.tint = b.tint
  if (b.tintTop) look.tintTop = b.tintTop
  return look
}

/** 位置标记的颜色：0 号（自己）是品红，别的（其他玩家）是青色。都是地形里少见的颜色。 */
function stableMarkerColor(index: number): RGB {
  return index === 0 ? [255, 0, 200] : [0, 220, 255]
}

/** 一个颜色大概叫什么（英文）：给文字图例用，好把名字和图上的颜色对上。 */
export function colorName(c: RGB): string {
  const r = c[0] / 255
  const g = c[1] / 255
  const b = c[2] / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const light = (max + min) / 2
  const spread = max - min
  const saturation = spread === 0 ? 0 : spread / (1 - Math.abs(2 * light - 1))
  if (saturation < 0.14 || spread < 0.06) {
    if (light < 0.16) return 'black'
    if (light > 0.86) return 'white'
    return light < 0.4 ? 'dark gray' : light > 0.65 ? 'light gray' : 'gray'
  }
  let hue = max === r ? ((g - b) / spread) % 6 : max === g ? (b - r) / spread + 2 : (r - g) / spread + 4
  hue = (hue * 60 + 360) % 360
  let name: string
  if (hue < 15 || hue >= 345) name = 'red'
  else if (hue < 45) name = light < 0.45 || saturation < 0.5 ? 'brown' : 'orange'
  else if (hue < 70) name = light < 0.4 ? 'olive' : saturation < 0.45 && light < 0.6 ? 'tan' : 'yellow'
  else if (hue < 165) name = 'green'
  else if (hue < 200) name = 'cyan'
  else if (hue < 255) name = 'blue'
  else if (hue < 290) name = 'purple'
  else name = light > 0.6 ? 'pink' : 'magenta'
  if (name === 'brown' || name === 'tan' || name === 'olive') return light < 0.25 ? `dark ${name}` : name
  return light < 0.3 ? `dark ${name}` : light > 0.72 ? `light ${name}` : name
}
