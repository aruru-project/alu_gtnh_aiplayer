// 看图：把世界里的一块地方画成简图（view_area），看主人传的图片（view_image）；草稿的图在 design.ts 的 view_draft。
// 图都从工具结果的 images 走，上层统一决定给不给模型看（模型要能看图，而且图只在这一轮里附带）。
// 模型看不了图时，同样的工具照常返回文字说明：尺寸、图例、一层一层的概要。
// 这两个都标着 picture：模型能看图时才进工具清单；不能看图时列在库函数的索引里（程序里调，拿文字和 data），
// 模型直接调也照常执行。

import { boxPieces } from './reach.ts'
import { BridgeError } from '../bridge/protocol.ts'
import type { PlayerInfo } from '../bridge/protocol.ts'
import { decodePng } from '../design/index.ts'
import { blockColors } from '../packdata/index.ts'
import type { BlockColor, PackData } from '../packdata/index.ts'
import {
  AREA_MAX_SIDE,
  BlockLooks,
  CORNERS,
  GridError,
  Raster,
  SIDES,
  UNLOADED_ID,
  blocksOfGrid,
  colorName,
  cropGrid,
  encodePng,
  gridFromBlocks,
  layerLines,
  legendLines,
  renderView,
  withMarkers,
} from '../render/index.ts'
import type { BlockKind, Corner, Marker, NameOf, Picture, RGB, Side, ViewSpec, VoxelGrid } from '../render/index.ts'
import { int, obj, str } from './schema.ts'
import { boxProps } from './tasks.ts'
import { ToolFailure, fail } from './types.ts'
import type { Tool, ToolContext, ToolImage, ToolResult } from './types.ts'

export const VIEWS = ['iso', 'top', 'side', 'layer'] as const
const FROM = [...CORNERS, ...SIDES]

/** 模型看不了图时，带图的工具结果开头的那句话。 */
export const NO_VISION_NOTE =
  'No picture is attached: the model you are running on cannot see pictures (your owner can pick a model that can on the panel). What follows is a description in words.'

/** 图和它的文字说明后面都跟的一句：这是示意图。 */
export const SCHEMATIC_NOTE =
  'This is a schematic drawing made from block colours, not what the game looks like. Use it for shape, layout and looks; for exact ids, counts and positions trust the query tools.'

export function canSee(ctx: ToolContext): boolean {
  return ctx.canSeeImages?.() === true
}

// 一份方块颜色表建一次“长什么样”的查找表，名字的查找表也一样
const looksCache = new WeakMap<object, BlockLooks>()
const namesCache = new WeakMap<object, Map<string, string>>()

export function looksForTable(table: readonly BlockColor[]): BlockLooks {
  let looks = looksCache.get(table)
  if (!looks) {
    looks = new BlockLooks(table)
    looksCache.set(table, looks)
  }
  return looks
}

export function looksFor(packdata: PackData | undefined): BlockLooks {
  return looksForTable(blockColors(packdata))
}

/** 方块的显示名：物品表里有就用它的，否则看方块颜色表。 */
export function blockNames(packdata: PackData | undefined): NameOf {
  const table = blockColors(packdata)
  let names = namesCache.get(table)
  if (!names) {
    names = new Map()
    for (const row of table) if (row.name && !names.has(`${row.id}/${row.meta}`)) names.set(`${row.id}/${row.meta}`, row.name)
    namesCache.set(table, names)
  }
  return (kind: BlockKind) => packdata?.items?.get(kind.id, kind.meta)?.name ?? names.get(`${kind.id}/${kind.meta}`)
}

/**
 * 模型说的“怎么看”→ 画哪种图。写得不对时抛 ToolFailure，告诉它怎么写。
 * layerOf：把模型给的 layer 换成盒子里的第几层（世界里是 y 坐标，草稿里就是第几层）。
 */
export function viewSpec(i: { view?: string; from?: string; layer?: number }, grid: VoxelGrid, layerOf: (layer: number) => number): ViewSpec {
  const view = (i.view ?? 'iso') as (typeof VIEWS)[number]
  if (view === 'top') return { view: 'top' }
  if (view === 'layer') {
    const lowest = grid.origin.y
    if (i.layer === undefined) throw new ToolFailure(`For a layer picture give "layer": the y of the layer to look at (${lowest} to ${lowest + grid.size.y - 1} here).`)
    const index = layerOf(i.layer)
    if (index < 0 || index >= grid.size.y) throw new ToolFailure(`Layer ${i.layer} is outside: the layers here are ${lowest} to ${lowest + grid.size.y - 1}.`)
    return { view: 'layer', layer: index }
  }
  if (view === 'side') {
    if (i.from !== undefined && !(SIDES as readonly string[]).includes(i.from)) throw new ToolFailure(`For a side picture "from" is the side you stand on: ${SIDES.join(', ')}.`)
    return { view: 'side', from: (i.from as Side | undefined) ?? 'south' }
  }
  if (i.from !== undefined && !(CORNERS as readonly string[]).includes(i.from)) throw new ToolFailure(`For an iso picture "from" is the corner you look from: ${CORNERS.join(', ')}.`)
  return { view: 'iso', from: (i.from as Corner | undefined) ?? 'southeast' }
}

/** 一句话说这是哪种图。 */
export function viewWords(spec: ViewSpec, grid: VoxelGrid): string {
  switch (spec.view) {
    case 'iso':
      return `iso view from the ${spec.from} corner`
    case 'top':
      return 'top view (north up)'
    case 'side':
      return `side view from the ${spec.from}`
    case 'layer':
      return `layer y=${grid.origin.y + spec.layer} from above (north up)`
  }
}

export const VIEW_PARAMS = {
  view: str('"iso": from above one corner, three faces of everything (default); "top": straight down, north up; "side": level, from one side; "layer": one horizontal layer from above.', { enum: [...VIEWS] }),
  from: str('Where you look from. iso: a corner (default southeast). side: the side you stand on (default south).', { enum: FROM }),
}

/** 一张简图，连同画它用的那个盒子（面板的三维预览用）。 */
export function toImage(picture: Picture, label: string, grid: VoxelGrid): ToolImage {
  return { label, mediaType: 'image/png', data: picture.png, blocks: blocksOfGrid(grid) }
}

/**
 * 带图的工具结果。图总是带上（上层存一份给面板看；模型能看图时才给模型）；
 * 模型看不了图时在最前面说明，并加上 fallback：只在看不了图时才有用的那部分文字。
 */
export function pictureResult(ctx: ToolContext, text: string[], image: ToolImage, fallback: () => string[] = () => []): ToolResult {
  if (canSee(ctx)) return { content: text.join('\n'), images: [image], keepWhole: true }
  return { content: [NO_VISION_NOTE, ...text, ...fallback()].join('\n'), images: [image], keepWhole: true }
}

// ── view_area ──

interface AreaInput {
  x1?: number
  y1?: number
  z1?: number
  x2?: number
  y2?: number
  z2?: number
  radius?: number
  view?: string
  from?: string
  layer?: number
}

const AREA_DEFAULT_RADIUS = 12
const AREA_MAX_RADIUS = Math.floor((AREA_MAX_SIDE - 1) / 2)
const MARKED_PLAYERS_MAX = 4
/** 盒子太大时，结果里最多写出这么多块的坐标。 */
const PIECES_LISTED = 16

export const viewArea: Tool = {
  name: 'view_area',
  picture: true,
  brief: '{x1..z2 | radius?}: a box of the world in words, layer by layer -> kinds[]',
  description:
    `Get a picture of a box of the world, drawn from block colours: a schematic drawing for shape and layout, not a screenshot. Give two opposite corners (x1, y1, z1) and (x2, y2, z2), each side at most ${AREA_MAX_SIDE} blocks, or none to look around yourself. Details: pictures manual.`,
  inputSchema: obj({
    ...boxProps,
    radius: int(`Without corners: how far to look around yourself, in blocks each way (default ${AREA_DEFAULT_RADIUS}).`, { min: 2, max: AREA_MAX_RADIUS }),
    ...VIEW_PARAMS,
    layer: int('For view "layer": the y of the layer.', { min: 0, max: 255 }),
  }),
  async run(ctx, i: AreaInput): Promise<ToolResult | string> {
    const corners = [i.x1, i.y1, i.z1, i.x2, i.y2, i.z2]
    const given = corners.filter((v) => v !== undefined).length
    if (given !== 0 && given !== 6) return fail('Give all of x1, y1, z1, x2, y2, z2 (two opposite corners), or none of them to look around yourself.')

    // 自己在哪：没给范围时以它为中心；给了范围时用来在图上标出自己
    const status = await ctx.bridge.botStatus(ctx.botName).catch((e: unknown) => {
      if (e instanceof BridgeError && given === 6 && (e.code === 'offline' || e.code === 'not_found')) return undefined
      throw e
    })
    const me = status?.online === true ? status : undefined
    let box: { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }
    if (given === 6) {
      box = { x1: i.x1!, y1: i.y1!, z1: i.z1!, x2: i.x2!, y2: i.y2!, z2: i.z2! }
    } else {
      const at = me?.block ?? (me?.pos ? { x: Math.floor(me.pos.x), y: Math.floor(me.pos.y), z: Math.floor(me.pos.z) } : undefined)
      if (!at) return fail('You are not in the game world, so there is no "around you": give x1, y1, z1, x2, y2, z2.')
      const r = i.radius ?? AREA_DEFAULT_RADIUS
      // 脚下留几层看得出地面，往上多看一些：地面以上才是要看的
      box = { x1: at.x - r, z1: at.z - r, x2: at.x + r, z2: at.z + r, y1: Math.max(0, at.y - 3), y2: Math.min(255, at.y + Math.max(8, r)) }
    }
    const sides = [Math.abs(box.x2 - box.x1) + 1, Math.abs(box.y2 - box.y1) + 1, Math.abs(box.z2 - box.z1) + 1]
    if (sides.some((n) => n > AREA_MAX_SIDE)) {
      // 照实说要分几块，并把每一块的两个角写出来：照着一块块看，不用一次次试
      const parts = boxPieces(box, AREA_MAX_SIDE)
      const shown = parts.slice(0, PIECES_LISTED)
      return fail(
        `The box is ${sides[0]}×${sides[1]}×${sides[2]} (x × y × z); one picture covers at most ${AREA_MAX_SIDE} on each side, so this box is ${parts.length} pictures: ` +
          `${shown.map((p) => `(${p.x1}, ${p.y1}, ${p.z1})–(${p.x2}, ${p.y2}, ${p.z2})`).join('; ')}${parts.length > shown.length ? `; … ${parts.length - shown.length} more in the same pattern` : ''}.`,
      )
    }

    const raw = await ctx.bridge.worldBlocks(me?.dim !== undefined ? { ...box, dim: me.dim } : box)
    let area: ReturnType<typeof gridFromBlocks>
    try {
      area = gridFromBlocks(raw)
    } catch (e) {
      if (e instanceof GridError) return fail(`The game server answered with block data that cannot be used: ${e.message}.`)
      throw e
    }
    const spec = viewSpec(i, area, (y) => y - area.origin.y)

    const o = area.origin
    const s = area.size
    // 标出自己和范围里的其他玩家（同一个维度、站在这个盒子里的）
    const inside = (p: { x: number; y: number; z: number }): boolean =>
      Math.floor(p.x) >= o.x && Math.floor(p.x) < o.x + s.x && Math.floor(p.z) >= o.z && Math.floor(p.z) < o.z + s.z && Math.floor(p.y) >= o.y - 1 && Math.floor(p.y) < o.y + s.y
    const markers: Marker[] = []
    if (me?.pos && inside(me.pos)) markers.push({ name: ctx.botName, who: 0, x: me.pos.x, y: me.pos.y, z: me.pos.z })
    if (me) {
      const info = await ctx.bridge.serverInfo().catch(() => undefined)
      const others = (info?.players ?? []).filter((p: PlayerInfo) => p.name !== ctx.botName && p.pos !== undefined && (p.dim ?? 0) === (me.dim ?? 0) && inside(p.pos))
      for (const p of others.slice(0, MARKED_PLAYERS_MAX)) markers.push({ name: p.name, who: 1, x: p.pos!.x, y: p.pos!.y, z: p.pos!.z })
    }
    const grid = withMarkers(area, markers).grid
    const where = `x ${o.x}..${o.x + s.x - 1}, y ${o.y}..${o.y + s.y - 1}, z ${o.z}..${o.z + s.z - 1}`
    const looks = looksFor(ctx.packdata)
    const names = blockNames(ctx.packdata)
    const picture = renderView(grid, looks, spec, { title: me?.dim !== undefined ? `The world (dimension ${me.dim})` : 'The world' })
    const empty = picture.legend.every((e) => e.look.marker)
    const text = [
      `${canSee(ctx) ? 'Picture of' : 'Area'} ${where} (${s.x}×${s.y}×${s.z} blocks)${canSee(ctx) ? `: ${viewWords(spec, area)}, ${picture.width}×${picture.height} px, 1 block = ${picture.cell} px` : ''}.`,
      ...(area.unloaded > 0 ? [`${area.unloaded} of its cells are in chunks that are not loaded; go closer to see them.`] : []),
      ...(empty ? ['There is nothing but air in it.'] : [`${spec.view === 'layer' ? 'In that layer' : 'In it'} (most common first):`, ...legendLines(picture.legend, names)]),
      SCHEMATIC_NOTE,
    ]
    const result = pictureResult(
      ctx,
      text,
      toImage(picture, `${viewWords(spec, area)} of the world at ${where}`, grid),
      () => (empty ? [] : ['Layer by layer, from the bottom up:', ...layerLines(spec.view === 'layer' ? cropGrid(area, { y1: spec.layer, y2: spec.layer }) : area, names)]),
    )
    // data：给程序用的——看的是哪个盒子、里面各种方块各多少（每一格是什么用 read_blocks）
    const kinds = picture.legend.filter((e) => !e.look.marker && e.kind.id !== UNLOADED_ID).map((e) => ({ id: e.kind.id, meta: e.kind.meta, ...(names(e.kind) ? { name: names(e.kind) } : {}), count: e.count }))
    return { ...result, data: { x: o.x, y: o.y, z: o.z, sx: s.x, sy: s.y, sz: s.z, unloaded: area.unloaded, kinds } }
  },
}

// ── view_image ──

/** 小图放大到最长边至少这么多像素再给模型看（像素画只有几十像素，太小了看不清）；放大是一格变成整数个像素，不糊。 */
const IMAGE_SHOW_SIDE = 384
const CHECKER: [RGB, RGB] = [
  [255, 255, 255],
  [224, 224, 224],
]

/** 主人传的图片 → 给模型看的 PNG：放大到看得清，透明的地方垫上灰白格子。 */
export function showableImage(png: Buffer): { png: Buffer; width: number; height: number; scale: number; transparent: number; colors: string[] } {
  const image = decodePng(png)
  const { width, height, rgba } = image
  const scale = Math.max(1, Math.min(16, Math.floor(IMAGE_SHOW_SIDE / Math.max(width, height))))
  const out = new Raster(width * scale, height * scale)
  const tally = new Map<string, number>()
  let transparent = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4
      const alpha = rgba[at + 3]! / 255
      const color: RGB = [rgba[at]!, rgba[at + 1]!, rgba[at + 2]!]
      if (alpha < 0.5) transparent++
      else tally.set(colorName(color), (tally.get(colorName(color)) ?? 0) + 1)
      if (alpha < 1) {
        // 透明的地方垫灰白格子，一格 4 个原图像素
        const under = CHECKER[(Math.floor(x / 4) + Math.floor(y / 4)) % 2]!
        out.fillRect(x * scale, y * scale, scale, scale, under)
      }
      if (alpha > 0) out.fillRect(x * scale, y * scale, scale, scale, color, alpha)
    }
  }
  const opaque = width * height - transparent
  const colors = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, n]) => `${name} ${Math.max(1, Math.round((n / Math.max(1, opaque)) * 100))}%`)
  return { png: encodePng(out), width: out.width, height: out.height, scale, transparent, colors }
}

export const viewImage: Tool = {
  name: 'view_image',
  picture: true,
  brief: '{name}: an uploaded image in words -> width, height, colors[]',
  description:
    'Look at an image your owner uploaded on the panel (list_designs shows which there are). Small images are enlarged so you can see them. A program reads its pixels with image(name).',
  inputSchema: obj({ name: str('Image name, as list_designs shows it.', { maxLength: 60 }) }, ['name']),
  async run(ctx, i: { name: string }): Promise<ToolResult | string> {
    if (!ctx.design) return fail('Images are not set up on this brain.')
    const name = i.name.trim()
    const info = ctx.design.images.list().find((image) => image.name === name)
    const png = info ? ctx.design.images.png(name) : undefined
    if (!info || !png) return fail(`There is no image named "${name}". list_designs shows the ones there are.`)
    const shown = showableImage(png)
    const pixels = info.width * info.height
    const text = [
      `Image "${name}": ${info.width}×${info.height} pixels${canSee(ctx) && shown.scale > 1 ? `, shown enlarged ${shown.scale}× (${shown.width}×${shown.height} px)` : ''}.`,
      ...(shown.transparent > 0 ? [`${Math.round((shown.transparent / pixels) * 100)}% of it is transparent${canSee(ctx) ? ' (drawn as a grey and white checker)' : ''}.`] : []),
    ]
    const result = pictureResult(
      ctx,
      text,
      { label: `the uploaded image "${name}"`, mediaType: 'image/png', data: shown.png },
      () => [`Main colours: ${shown.colors.join(', ') || 'none (all transparent)'}.`, 'A program can read every pixel with image(name) (see the "design" manual).'],
    )
    // data：尺寸、透明的占多少（0–1）、主要颜色（“颜色名 百分比”）。每个像素程序自己用 image(name) 读
    return { ...result, data: { name, width: info.width, height: info.height, transparent: shown.transparent / pixels, colors: shown.colors } }
  },
}
