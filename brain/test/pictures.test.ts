// 简图：把草稿、世界里的一块地方按方块颜色画成 PNG，以及模型用来要图的那几个工具（view_area、view_draft 的 picture、view_image）。
// 画出来的 PNG 用 design/png.ts 的解码器读回像素来检查（它和这里的编码器是两份独立的代码）。
// 游戏那一头是按方法名应答的假服务器。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { DesignWorkspace, decodePng } from '../src/design/index.ts'
import { BUILTIN_BLOCK_COLORS, loadPackData } from '../src/packdata/index.ts'
import type { PackData } from '../src/packdata/index.ts'
import { BlockLooks, DEPTH_SHADE, ISO_SHADE, cropGrid, gridFromBlocks, renderView, shade, withMarkers } from '../src/render/index.ts'
import type { Corner, RGB, RenderOptions, ViewSpec, VoxelGrid } from '../src/render/index.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { NO_VISION_NOTE } from '../src/tools/pictures.ts'
import { ALL_TOOLS, runTool } from '../src/tools/index.ts'
import type { ToolContext, ToolResult } from '../src/tools/index.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { encodePng, tmpDir, worldBlocksAnswer } from './helpers.ts'

const NOW = 1_800_000_000_000
// 内置颜色表里的羊毛（meta → 颜色）
const WHITE: RGB = [222, 222, 222]
const YELLOW: RGB = [177, 166, 39]
const BLUE: RGB = [46, 57, 142]
const RED: RGB = [151, 52, 49]
const BACKGROUND: RGB = [238, 242, 247]
const looks = new BlockLooks(BUILTIN_BLOCK_COLORS)

/** 一个盒子：blocks 是 "x,y,z" → 方块（坐标是世界坐标，盒子的最小角在 origin）。 */
function grid(size: [number, number, number], blocks: Record<string, string>, origin: [number, number, number] = [0, 0, 0]): VoxelGrid {
  return gridFromBlocks(worldBlocksAnswer({ x1: origin[0], y1: origin[1], z1: origin[2], x2: origin[0] + size[0] - 1, y2: origin[1] + size[1] - 1, z2: origin[2] + size[2] - 1 }, blocks))
}

interface Pixels {
  width: number
  height: number
  at(x: number, y: number): RGB
  /** 这个颜色的像素有多少个。 */
  count(color: RGB): number
  /** 这个颜色的像素平均在哪（横坐标）。 */
  middleX(color: RGB): number
}

function pixelsOf(png: Buffer): Pixels {
  const image = decodePng(png)
  const same = (at: number, c: RGB): boolean => image.rgba[at] === c[0] && image.rgba[at + 1] === c[1] && image.rgba[at + 2] === c[2]
  return {
    width: image.width,
    height: image.height,
    at: (x, y) => [image.rgba[(y * image.width + x) * 4]!, image.rgba[(y * image.width + x) * 4 + 1]!, image.rgba[(y * image.width + x) * 4 + 2]!],
    count: (c) => {
      let n = 0
      for (let at = 0; at < image.rgba.length; at += 4) if (same(at, c)) n++
      return n
    },
    middleX: (c) => {
      let n = 0
      let sum = 0
      for (let at = 0; at < image.rgba.length; at += 4) {
        if (!same(at, c)) continue
        n++
        sum += (at / 4) % image.width
      }
      return n === 0 ? Number.NaN : sum / n
    },
  }
}

/** 只画画面本身（不带说明和图例），读回像素。 */
function plain(g: VoxelGrid, spec: ViewSpec, opts: RenderOptions = {}): Pixels & { cell: number } {
  const picture = renderView(g, looks, spec, { plain: true, ...opts })
  const pixels = pixelsOf(picture.png)
  assert.deepEqual([pixels.width, pixels.height], [picture.width, picture.height])
  return { ...pixels, cell: picture.cell }
}

/** 平面图（俯视、立面、分层）里第 column 列、第 row 行那一格正中间的颜色。 */
function cellOf(p: Pixels & { cell: number }, column: number, row: number): RGB {
  return p.at(Math.floor(column * p.cell + p.cell / 2), Math.floor(row * p.cell + p.cell / 2))
}

/** a 是不是 b 调暗（或略调亮）以后的颜色：三个通道的比例差不多。 */
function isShadeOf(a: RGB, b: RGB, range: [number, number]): boolean {
  const ratios = a.map((v, i) => v / b[i]!)
  return ratios.every((r) => Math.abs(r - ratios[0]!) < 0.04 && r >= range[0] && r <= range[1])
}

describe('简图：等轴测', () => {
  // 东西向并排两块：西边红的，东边蓝的
  const pair = grid([2, 1, 1], { '0,0,0': 'minecraft:wool/14', '1,0,0': 'minecraft:wool/11' })

  it('站在哪个角，看见的就是朝着那个角的两个面，三个面明暗不同；换一个角，东西的左右跟着换', () => {
    const left = (c: RGB) => shade(c, ISO_SHADE.left)
    const right = (c: RGB) => shade(c, ISO_SHADE.right)
    /** 每个角：图上左边的面朝哪、右边的面朝哪；这两块里谁的那一面露在外面。 */
    const cases: { from: Corner; leftFaces: RGB[]; rightFaces: RGB[]; redIsLeftOfBlue: boolean }[] = [
      // 左边的面朝南（两块都露着），右边的面朝东（只有东边那块蓝的露着）
      { from: 'southeast', leftFaces: [RED, BLUE], rightFaces: [BLUE], redIsLeftOfBlue: true },
      // 左边的面朝西（只有红的），右边的面朝南（两块都露着）
      { from: 'southwest', leftFaces: [RED], rightFaces: [RED, BLUE], redIsLeftOfBlue: true },
      { from: 'northwest', leftFaces: [RED, BLUE], rightFaces: [RED], redIsLeftOfBlue: false },
      { from: 'northeast', leftFaces: [BLUE], rightFaces: [RED, BLUE], redIsLeftOfBlue: false },
    ]
    for (const c of cases) {
      const p = plain(pair, { view: 'iso', from: c.from })
      for (const color of [RED, BLUE]) {
        assert.ok(p.count(color) > 100, `${c.from}: the top of each block shows`)
        assert.equal(p.count(left(color)) > 100, c.leftFaces.includes(color), `${c.from}: left face of ${color}`)
        assert.equal(p.count(right(color)) > 100, c.rightFaces.includes(color), `${c.from}: right face of ${color}`)
      }
      assert.equal(p.middleX(RED) < p.middleX(BLUE), c.redIsLeftOfBlue, `${c.from}: which block is on the left`)
    }
    // 三个面确实是三种明暗
    assert.equal(new Set([RED, left(RED), right(RED)].map(String)).size, 3)
  })

  it('被挡住的方块不画；顶上空着的那一截不留白', () => {
    // 3×3×3 的实心红块，正中心藏一块蓝的：哪个角都看不见它
    const blocks: Record<string, string> = {}
    for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) blocks[`${x},${y},${z}`] = 'minecraft:wool/14'
    blocks['1,1,1'] = 'minecraft:wool/11'
    const cube = grid([3, 3, 3], blocks)
    for (const from of ['southeast', 'northwest'] as const) {
      const p = plain(cube, { view: 'iso', from })
      assert.equal(p.count(BLUE) + p.count(shade(BLUE, ISO_SHADE.left)) + p.count(shade(BLUE, ISO_SHADE.right)), 0)
    }
    // 把顶上两层拿掉、只留底下一层：图矮了两格的高度，而不是上面空着一大片
    const full = plain(cube, { view: 'iso', from: 'southeast' })
    const low = plain(cropGrid(cube, { y2: 0 }), { view: 'iso', from: 'southeast' })
    assert.equal(low.cell, full.cell)
    assert.equal(low.height, full.height - 2 * full.cell)
    // 同一个 3 层高的盒子里只有底下一层有东西：画出来和上面那张一样高
    const hollow = plain(grid([3, 3, 3], Object.fromEntries(Object.entries(blocks).filter(([key]) => key.split(',')[1] === '0'))), { view: 'iso', from: 'southeast' })
    assert.equal(hollow.height, low.height)
  })

  it('整张图最长的一边不超过上限：范围越大每格画得越小；小东西也不会放大到一格几十像素以上', () => {
    const all: Record<string, string> = {}
    for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) for (let y = 0; y < 64; y++) if (y < 20 || (x + z) % 9 === 0) all[`${x},${y},${z}`] = 'minecraft:wool/14'
    const big = grid([64, 64, 64], all)
    for (const spec of [{ view: 'iso', from: 'southwest' }, { view: 'top' }, { view: 'side', from: 'east' }, { view: 'layer', layer: 3 }] as ViewSpec[]) {
      const picture = renderView(big, looks, spec)
      assert.ok(picture.width <= 1024 && picture.height <= 1024, `${spec.view}: ${picture.width}×${picture.height}`)
      assert.ok(picture.cell >= 2 && picture.cell < 16, `${spec.view}: cell ${picture.cell}`)
      const small = renderView(big, looks, spec, { plain: true, maxSize: 200 })
      assert.ok(small.width <= 200 && small.height <= 200, `${spec.view} thumbnail: ${small.width}×${small.height}`)
    }
    assert.equal(renderView(pair, looks, { view: 'iso', from: 'southeast' }).cell, 32)
  })
})

describe('简图：俯视、立面、分层', () => {
  // x=0 那一列：红的上面摞着白的；x=2：北边（z=0）蓝的，南边（z=2）黄的，都在地面那一层
  const scene = grid([3, 2, 3], { '0,0,0': 'minecraft:wool/14', '0,1,0': 'minecraft:wool', '2,0,0': 'minecraft:wool/11', '2,0,2': 'minecraft:wool/4' })

  it('俯视图：上北下南、左西右东，每一列画最上面那块；低的地方暗一些', () => {
    const p = plain(scene, { view: 'top' })
    assert.deepEqual([p.width, p.height], [3 * p.cell, 3 * p.cell])
    // 西北角那一列最上面是白的（底下的红的看不见），而且它最高，颜色不打折
    assert.deepEqual(cellOf(p, 0, 0), WHITE)
    assert.equal(p.count(RED), 0)
    // 东北角是蓝的，东南角是黄的：都在低处，比原色暗
    assert.ok(isShadeOf(cellOf(p, 2, 0), BLUE, [DEPTH_SHADE.top - 0.02, 0.99]), String(cellOf(p, 2, 0)))
    assert.ok(isShadeOf(cellOf(p, 2, 2), YELLOW, [DEPTH_SHADE.top - 0.02, 0.99]), String(cellOf(p, 2, 2)))
    // 什么都没有的地方是底色
    assert.deepEqual(cellOf(p, 1, 1), BACKGROUND)
  })

  it('立面图：站在哪一边就画最靠那一边的方块，左右是站在那里看到的左右；远处的暗', () => {
    // 站在南边朝北看：东在右手边。x=2 那一列最靠前的是南边的黄的；x=0 那一列的红和白都在最远处
    const south = plain(scene, { view: 'side', from: 'south' })
    assert.deepEqual([south.width, south.height], [3 * south.cell, 2 * south.cell])
    assert.deepEqual(cellOf(south, 2, 1), YELLOW)
    assert.ok(isShadeOf(cellOf(south, 0, 0), WHITE, [DEPTH_SHADE.side - 0.02, DEPTH_SHADE.side + 0.02]))
    assert.ok(isShadeOf(cellOf(south, 0, 1), RED, [DEPTH_SHADE.side - 0.02, DEPTH_SHADE.side + 0.02]))
    assert.deepEqual(cellOf(south, 1, 1), BACKGROUND)
    // 站在北边朝南看：西在右手边，最靠前的换成了蓝的
    const north = plain(scene, { view: 'side', from: 'north' })
    assert.deepEqual([cellOf(north, 0, 1), cellOf(north, 2, 1), cellOf(north, 2, 0)], [BLUE, RED, WHITE])
    // 站在东边朝西看：北在右手边。最靠前的是 x=2 上的两块：左边（南）黄的，右边（北）蓝的
    const east = plain(scene, { view: 'side', from: 'east' })
    assert.deepEqual([cellOf(east, 0, 1), cellOf(east, 2, 1)], [YELLOW, BLUE])
    // 站在西边朝东看：南在右手边。x=0 上的红和白挡在最前面（北，左边），黄的在右边远处
    const west = plain(scene, { view: 'side', from: 'west' })
    assert.deepEqual([cellOf(west, 0, 1), cellOf(west, 0, 0)], [RED, WHITE])
    assert.ok(isShadeOf(cellOf(west, 2, 1), YELLOW, [DEPTH_SHADE.side - 0.02, DEPTH_SHADE.side + 0.02]))
  })

  it('分层：只画那一层，图例也只算那一层', () => {
    const upper = renderView(scene, looks, { view: 'layer', layer: 1 }, { plain: true })
    const p = pixelsOf(upper.png)
    assert.ok(p.count(WHITE) > 100)
    assert.equal(p.count(RED) + p.count(BLUE) + p.count(YELLOW), 0)
    assert.deepEqual(upper.legend.map((e) => [e.kind.id, e.kind.meta, e.count]), [['minecraft:wool', 0, 1]])
    assert.deepEqual(renderView(scene, looks, { view: 'layer', layer: 0 }, { plain: true }).legend.map((e) => e.kind.meta).sort((a, b) => a - b), [4, 11, 14])
  })

  it('玻璃、水这类透明方块透得出后面的东西；非整块的（火把、栅栏）画小一点，不把一格占满', () => {
    // 俯视：沙子上面一层水，颜色在两者之间；旁边只有沙子的那格是沙子本色（都在同一高度以上没有别的）
    const pond = grid([2, 2, 1], { '0,0,0': 'minecraft:wool/4', '0,1,0': 'minecraft:water', '1,1,0': 'minecraft:wool/4' })
    const top = plain(pond, { view: 'top' })
    const wet = cellOf(top, 0, 0)
    assert.deepEqual(cellOf(top, 1, 0), YELLOW)
    assert.ok(wet[2] > YELLOW[2] + 40 && wet[0] < YELLOW[0] - 20 && wet[0] > 52, `water over yellow: ${wet}`)
    // 立面：玻璃后面的红块看得见，和玻璃后面什么都没有的那格不一样
    const window = grid([2, 1, 2], { '0,0,1': 'minecraft:glass', '1,0,1': 'minecraft:glass', '0,0,0': 'minecraft:wool/14' })
    const side = plain(window, { view: 'side', from: 'south' })
    const behind = cellOf(side, 0, 0)
    const empty = cellOf(side, 1, 0)
    assert.notDeepEqual(behind, empty)
    assert.ok(behind[0] > behind[1] + 15 && empty[0] < empty[1], `${behind} / ${empty}`)
    // 俯视：火把只占一格中间的一小块，四个角还是底下的方块
    const torch = plain(grid([1, 2, 1], { '0,0,0': 'minecraft:wool/11', '0,1,0': 'minecraft:torch' }), { view: 'top' })
    assert.notDeepEqual(cellOf(torch, 0, 0), BLUE)
    assert.ok(isShadeOf(torch.at(1, 1), BLUE, [0.7, 1.1]), String(torch.at(1, 1)))
  })
})

describe('简图：位置记号', () => {
  it('自己和别的玩家标在站的那一格（脚和头两格高），不盖掉方块；图例里记号排在最前面，方块种类再多也不会被挤掉', () => {
    // 一排 14 种不同的方块铺在地上（y=0），每种两格深；Alu 站在 x=3 那格上面，Steve 站在 x=9；还有一个玩家卡在方块里、一个在盒子外面
    const blocks: Record<string, string> = {}
    for (let x = 0; x < 14; x++) for (let z = 0; z < 2; z++) blocks[`${x},0,${z}`] = `minecraft:wool/${x}`
    const floor = grid([14, 4, 2], blocks)
    const { grid: marked, placed } = withMarkers(floor, [
      { name: 'Alu', who: 0, x: 3.5, y: 1, z: 1.2 },
      { name: 'Steve', who: 1, x: 9.9, y: 1.0, z: 1.7 },
      { name: 'Stuck', who: 1, x: 5.5, y: 0, z: 1.5 },
      { name: 'Far', who: 1, x: 40, y: 1, z: 1 },
    ])
    assert.deepEqual(placed.map((m) => m.name), ['Alu', 'Steve', 'Stuck'])
    // 原来的盒子没被改
    assert.equal(floor.kinds.length, 15)
    const ME: RGB = [255, 0, 200]
    const OTHER: RGB = [0, 220, 255]
    // 从南面看：第 0 行是最高处。Alu 在 x=3 的第 1、2 格高（画面第 2、1 行），Steve 在 x=9
    const side = plain(marked, { view: 'side', from: 'south' })
    const column = (c: number, color: RGB): number[] => [0, 1, 2, 3].filter((row) => side.at(Math.floor(c * side.cell + side.cell / 2), Math.floor(row * side.cell + side.cell / 2)).join() === color.join())
    assert.deepEqual([column(3, ME), column(9, OTHER)], [[1, 2], [1, 2]])
    // 卡在方块里的那个：脚那格是方块，不盖；只标了头那一格
    assert.deepEqual(column(5, OTHER), [2])
    assert.deepEqual(cellOf(side, 5, 3), looks.of({ id: 'minecraft:wool', meta: 5 }).side)
    // 俯视图里记号占满一格（连格子的角上都是它的颜色），看得见
    const top = plain(marked, { view: 'top' })
    assert.deepEqual([top.at(3 * top.cell + 3, top.cell + 3), top.at(9 * top.cell + 3, top.cell + 3)], [ME, OTHER])
    // 图例：记号在最前面，后面才是按数量排的方块
    const legend = renderView(marked, looks, { view: 'iso', from: 'southeast' }).legend
    assert.deepEqual(legend.slice(0, 3).map((e) => [e.kind.id, e.look.marker]), [['@Alu', true], ['@Steve', true], ['@Stuck', true]])
    assert.equal(legend.length, 17)
  })
})

describe('简图：颜色从哪来', () => {
  function packWith(t: { after(fn: () => void): void }, rows: unknown[]): PackData {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    fs.writeFileSync(path.join(tmp.dir, 'blocks.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'))
    const data = loadPackData(tmp.dir, () => {})
    assert.ok(data?.blocks, 'the block colour table should load')
    return data
  }

  it('颜色表里有的用表里的：侧面用 color，顶面用 top（没有 top 就和侧面一样）', (t) => {
    const data = packWith(t, [
      { id: 'minecraft:dirt', meta: 2, name: '灰化土', color: [122, 87, 57], top: [90, 63, 28], en: 'Podzol', falls: false },
      { id: 'chisel:nucrete', meta: 7, name: '核凝土', color: [40, 160, 200], light: 15 },
    ])
    const table = new BlockLooks(data.blocks!)
    const two = grid([2, 1, 1], { '0,0,0': 'minecraft:dirt/2', '1,0,0': 'chisel:nucrete/7' })
    const top = pixelsOf(renderView(two, table, { view: 'top' }, { plain: true }).png)
    assert.ok(top.count([90, 63, 28]) > 100 && top.count([40, 160, 200]) > 100)
    assert.equal(top.count([122, 87, 57]), 0)
    const side = pixelsOf(renderView(two, table, { view: 'side', from: 'south' }, { plain: true }).png)
    assert.ok(side.count([122, 87, 57]) > 100 && side.count([40, 160, 200]) > 100)
    assert.equal(side.count([90, 63, 28]), 0)
  })

  it('表里没有的：常见的原版方块有内置的颜色；别的按名字猜一类，或者由名字算一个固定的颜色，并在图例里标出来', () => {
    const of = (id: string, meta = 0) => looks.of({ id, meta })
    // 草方块：顶面绿，侧面偏土色；水是半透明的；不认识的树叶按名字当树叶
    assert.deepEqual([of('minecraft:grass').source, of('minecraft:water').source, of('BiomesOPlenty:leaves1', 2).source], ['builtin', 'builtin', 'guess'])
    assert.ok(of('minecraft:grass').top[1] > of('minecraft:grass').top[0] + 30)
    assert.ok(of('minecraft:water').alpha < 1 && of('minecraft:glass').alpha < 1 && of('minecraft:grass').alpha === 1)
    assert.deepEqual(of('BiomesOPlenty:leaves1', 2).side, of('minecraft:leaves').side)
    // 楼梯、半砖、地毯、染色玻璃照着原来那种方块上色
    assert.deepEqual([of('minecraft:carpet', 14).top, of('minecraft:carpet', 14).shape], [RED, 'flat'])
    assert.deepEqual([of('minecraft:stained_glass', 11).side, of('minecraft:stained_glass', 11).alpha < 1], [BLUE, true])
    assert.equal(of('minecraft:stone_slab', 3).shape, 'slab')
    // 完全不认识的：由名字算，同一个名字每次一样，不同的名字不一样
    const machine = of('gregtech:gt.blockmachines', 3)
    assert.equal(machine.source, 'hash')
    assert.deepEqual(new BlockLooks([]).of({ id: 'gregtech:gt.blockmachines', meta: 3 }).side, machine.side)
    assert.notDeepEqual(of('gregtech:gt.blockmachines', 4).side, machine.side)
    assert.equal(of('chisel:marble_fence', 1).shape, 'post')
    // 图例里：算出来的带 “?”，猜的带 “~”，位置记号排最前面
    const mixed = grid([4, 1, 1], { '0,0,0': 'gregtech:gt.blockmachines/3', '1,0,0': 'BiomesOPlenty:leaves1/2', '2,0,0': 'minecraft:wool/14', '3,0,0': '?' })
    const picture = renderView(mixed, looks, { view: 'top' })
    assert.deepEqual(picture.legend.map((e) => e.look.source).sort(), ['builtin', 'guess', 'hash', 'table'])
    // 带说明的图比光是画面大：上面有说明，下面有图例
    const bare = renderView(mixed, looks, { view: 'top' }, { plain: true })
    assert.ok(picture.height > bare.height + 60 && picture.width >= bare.width)
  })
})

// ── 工具 ──

function setup(t: { after(fn: () => void): void }, opts: { vision?: boolean; packdata?: PackData } = {}) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  const game = new FakeGame()
  const design = new DesignWorkspace({ dataDir: tmp.dir, now: () => NOW, ...(opts.packdata ? { packdata: opts.packdata } : {}) })
  /** 假世界：只有这里写的方块，别的都是空气。 */
  const world: Record<string, string> = {}
  game.handlers['world.blocks'] = (p) => worldBlocksAnswer(p, world)
  const ctx: ToolContext = {
    botName: 'Alu',
    bridge: new BridgeApi(game),
    memory: new MemoryStore(tmp.dir, () => 300),
    manuals: new ManualStore(DEFAULT_MANUALS_DIR, path.join(tmp.dir, 'manuals')),
    design,
    ...(opts.packdata ? { packdata: opts.packdata } : {}),
    reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
    hooks: {},
    canSeeImages: () => opts.vision === true,
    now: () => NOW,
  }
  const run = (name: string, input: unknown = {}): Promise<ToolResult> => runTool(ALL_TOOLS, ctx, name, input, { maxResultChars: 2000 })
  return { tmp, game, design, world, run }
}

describe('view_area：看世界里的一块地方', () => {
  it('不给范围就是看自己周围：向身体要那个盒子里的方块，画成图，文字里有范围、图例，自己和旁边的玩家标在图上', async (t) => {
    const s = setup(t, { vision: true })
    // bot 站在 (10, 64, -4)；脚下一片石头地，旁边一堵红羊毛的矮墙
    for (let x = -2; x <= 22; x++) for (let z = -16; z <= 8; z++) s.world[`${x},63,${z}`] = 'minecraft:stone'
    for (let x = 5; x <= 8; x++) for (let y = 64; y <= 65; y++) s.world[`${x},${y},0`] = 'minecraft:wool/14'
    const res = await s.run('view_area')
    assert.equal(res.isError, undefined, res.content)
    // 四周各 12 格，脚下留 3 层，往上看 12 层；在 bot 所在的维度
    assert.deepEqual(s.game.callsOf('world.blocks'), [{ x1: -2, z1: -16, x2: 22, z2: 8, y1: 61, y2: 76, dim: 0 }])
    const lines = res.content.split('\n')
    assert.match(lines[0]!, /^Picture of x -2\.\.22, y 61\.\.76, z -16\.\.8 \(25×16×25 blocks\): iso view from the southeast corner, \d+×\d+ px, 1 block = \d+ px\.$/)
    assert.ok(lines.includes('- the magenta marker is you (Alu)'), res.content)
    assert.ok(lines.includes('- the cyan marker is the player Steve'), res.content)
    assert.ok(lines.includes('- 625× minecraft:stone (gray)'), res.content)
    assert.ok(lines.includes('- 8× minecraft:wool/14 "红色羊毛" (red)'), res.content)
    assert.match(res.content, /schematic drawing made from block colours, not what the game looks like/)

    assert.equal(res.images?.length, 1)
    const image = res.images![0]!
    assert.deepEqual([image.mediaType, image.label], ['image/png', 'iso view from the southeast corner of the world at x -2..22, y 61..76, z -16..8'])
    const p = pixelsOf(image.data)
    assert.ok(p.width <= 1024 && p.height <= 1024 && p.width > 300)
    // 图上有墙（红羊毛的顶面和两个侧面）、有自己（品红）和 Steve（青）
    assert.ok(p.count(RED) > 50 && p.count(shade(RED, ISO_SHADE.left)) > 50)
    assert.ok(p.count([255, 0, 200]) > 10 && p.count([0, 220, 255]) > 10)
  })

  it('给两个对角和看法：要的就是那个盒子（哪个角在前都行）；俯视、立面、分层各是各的图；layer 用世界里的 y', async (t) => {
    const s = setup(t, { vision: true })
    s.world['100,70,200'] = 'minecraft:wool/14'
    s.world['101,71,200'] = 'minecraft:wool/11'
    const box = { x1: 103, y1: 72, z1: 203, x2: 100, y2: 70, z2: 200 }
    const top = await s.run('view_area', { ...box, view: 'top' })
    assert.deepEqual(s.game.callsOf('world.blocks')[0], { ...box, dim: 0 })
    assert.match(top.content, /^Picture of x 100\.\.103, y 70\.\.72, z 200\.\.203 \(4×3×4 blocks\): top view \(north up\), /)
    assert.equal(top.images![0]!.label, 'top view (north up) of the world at x 100..103, y 70..72, z 200..203')
    // bot 不在这个盒子里：图上没有它的记号
    assert.doesNotMatch(top.content, /marker/)

    const side = await s.run('view_area', { ...box, view: 'side', from: 'west' })
    assert.match(side.content, /: side view from the west, /)
    const layer = await s.run('view_area', { ...box, view: 'layer', layer: 71 })
    assert.match(layer.content, /: layer y=71 from above \(north up\), /)
    assert.match(layer.content, /In that layer \(most common first\):\n- 1× minecraft:wool\/11 "蓝色羊毛" \(blue\)\nThis is a schematic/)
    const p = pixelsOf(layer.images![0]!.data)
    assert.ok(p.count(BLUE) > 100)
    assert.equal(p.count(RED), 0)
  })

  it('没加载的区块如实说；盒子里什么都没有也说', async (t) => {
    const s = setup(t, { vision: true })
    for (let y = 60; y <= 61; y++) for (let z = 0; z <= 1; z++) s.world[`0,${y},${z}`] = '?'
    const res = await s.run('view_area', { x1: 0, y1: 60, z1: 0, x2: 3, y2: 61, z2: 1 })
    assert.match(res.content, /\n4 of its cells are in chunks that are not loaded; go closer to see them\.\n/)
    assert.match(res.content, /- 4 cells are in chunks that are not loaded \(drawn dark\): nothing is known about them/)
    const empty = await s.run('view_area', { x1: 500, y1: 60, z1: 500, x2: 503, y2: 61, z2: 501 })
    assert.match(empty.content, /\nThere is nothing but air in it\.\n/)
    assert.equal(empty.images?.length, 1)
  })

  it('参数不对时不去问身体，说清怎么改；身体回的数据对不上约定时不画', async (t) => {
    const s = setup(t, { vision: true })
    const refused = async (input: unknown, why: RegExp) => {
      const res = await s.run('view_area', input)
      assert.equal(res.isError, true, res.content)
      assert.match(res.content, why)
      assert.equal(res.images, undefined)
    }
    await refused({ x1: 0, z1: 0, x2: 5, z2: 5 }, /Give all of x1, y1, z1, x2, y2, z2 \(two opposite corners\), or none of them/)
    await refused({ x1: 0, y1: 0, z1: 0, x2: 64, y2: 10, z2: 10 }, /The box is 65×11×11 \(x × y × z\); each side can be at most 64\. Look at it in several pieces\./)
    assert.equal(s.game.callsOf('world.blocks').length, 0)
    const box = { x1: 0, y1: 60, z1: 0, x2: 3, y2: 63, z2: 3 }
    await refused({ ...box, view: 'layer' }, /For a layer picture give "layer": the y of the layer to look at \(60 to 63 here\)/)
    await refused({ ...box, view: 'layer', layer: 70 }, /Layer 70 is outside: the layers here are 60 to 63/)
    await refused({ ...box, from: 'south' }, /For an iso picture "from" is the corner you look from: southeast, southwest, northwest, northeast/)
    await refused({ ...box, view: 'side', from: 'northeast' }, /For a side picture "from" is the side you stand on: south, west, north, east/)
    // 身体回的格子数和尺寸对不上
    s.game.handlers['world.blocks'] = () => ({ x: 0, y: 60, z: 0, sx: 4, sy: 4, sz: 4, palette: [{ id: 'minecraft:air' }, { id: 'minecraft:stone' }], runs: [1, 60] })
    await refused(box, /The game server answered with block data that cannot be used: the runs do not match the size of the area\./)
    s.game.handlers['world.blocks'] = () => ({ x: 0, y: 60, z: 0, sx: 4, sy: 4, sz: 4, palette: [{ id: 'minecraft:stone' }], runs: [0, 64] })
    await refused(box, /palette entry 0 must be air/)
    // bot 不在游戏里：给了范围照样能看，没给范围就没有“周围”
    s.game.handlers['world.blocks'] = (p) => worldBlocksAnswer(p, s.world)
    s.game.online = false
    assert.equal((await s.run('view_area', box)).isError, undefined)
    assert.deepEqual(s.game.callsOf('world.blocks').at(-1), box)
    await refused({}, /You are not in the game world, so there is no "around you": give x1, y1, z1, x2, y2, z2\./)
  })

  it('有整合包的方块颜色表时：图上用表里的颜色，图例里用表里的中文名，不再说颜色是配的', async (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    fs.writeFileSync(path.join(tmp.dir, 'blocks.jsonl'), `${JSON.stringify({ id: 'chisel:nucrete', meta: 7, name: '核凝土', color: [40, 160, 200], top: [250, 250, 20], en: 'Nucrete' })}\n`)
    const packdata = loadPackData(tmp.dir, () => {})
    const s = setup(t, { vision: true, packdata: packdata! })
    s.world['0,60,0'] = 'chisel:nucrete/7'
    s.world['1,60,0'] = 'chisel:nucrete/8'
    const res = await s.run('view_area', { x1: 0, y1: 60, z1: 0, x2: 1, y2: 60, z2: 0, view: 'top' })
    const lines = res.content.split('\n')
    assert.ok(lines.includes('- 1× chisel:nucrete/7 "核凝土" (yellow top, cyan sides)'), res.content)
    // 同一个注册名、表里没有的 meta 是另一种方块：不借用别的 meta 的颜色
    assert.ok(lines.some((l) => /^- 1× chisel:nucrete\/8 \([a-z ]+; colour made up, not its real colour\)$/.test(l)), res.content)
    assert.ok(pixelsOf(res.images![0]!.data).count([250, 250, 20]) > 500)
  })

  it('模型看不了图时：开头写明看不了，给文字说明（范围、图例、一层一层各有什么）；图照样画出来（面板上主人看得到）', async (t) => {
    const s = setup(t)
    for (let x = 0; x <= 3; x++) for (let z = 0; z <= 3; z++) for (let y = 60; y <= 61; y++) s.world[`${x},${y},${z}`] = 'minecraft:stone'
    for (let x = 0; x <= 3; x++) s.world[`${x},62,0`] = 'minecraft:wool/14'
    s.world['3,62,3'] = 'gregtech:gt.blockmachines/3'
    const res = await s.run('view_area', { x1: 0, y1: 60, z1: 0, x2: 3, y2: 64, z2: 3 })
    assert.equal(res.isError, undefined, res.content)
    const machine = res.content.split('\n')[5]!
    assert.deepEqual(res.content.split('\n'), [
      NO_VISION_NOTE,
      'Area x 0..3, y 60..64, z 0..3 (4×5×4 blocks).',
      'In it (most common first):',
      '- 32× minecraft:stone (gray)',
      '- 4× minecraft:wool/14 "红色羊毛" (red)',
      machine,
      'This is a schematic drawing made from block colours, not what the game looks like. Use it for shape, layout and looks; for exact ids, counts and positions trust the query tools.',
      'Layer by layer, from the bottom up:',
      'y=60..61: 16 of 16 cells filled: 16 stone',
      'y=62: 5 of 16 cells filled: 4 红色羊毛, 1 gregtech:gt.blockmachines/3',
      'y=63..64: empty',
    ])
    // 颜色表里没有的方块：说明它的颜色是配的
    assert.match(machine, /^- 1× gregtech:gt\.blockmachines\/3 \([a-z ]+; colour made up, not its real colour\)$/)
    assert.match(NO_VISION_NOTE, /cannot see pictures/)
    assert.equal(res.images?.length, 1)
  })
})

describe('view_draft 的 picture、view_image', () => {
  const HUT = `
    const b = blueprint(5, 4, 5)
    b.walls(0, 0, 0, 4, 2, 4, "minecraft:wool/11")
    b.fill(0, 3, 0, 4, 3, 4, "minecraft:wool/14")
    b.set(2, 0, 2, "minecraft:wool/4")
    b.save("hut")`

  it('草稿画成图：整体看、切掉屋顶看里面、只看一层；图上的说明里有草稿名', async (t) => {
    const s = setup(t, { vision: true })
    assert.equal((await s.run('run_program', { code: HUT })).isError, undefined)
    const whole = await s.run('view_draft', { name: 'hut', picture: 'iso' })
    assert.equal(whole.isError, undefined, whole.content)
    const lines = whole.content.split('\n')
    assert.match(lines[0]!, /^Draft "hut": 5×4×5 /)
    assert.match(lines[1]!, /^Picture: iso view from the southeast corner, \d+×\d+ px, 1 block = \d+ px\.$/)
    assert.deepEqual(lines.slice(2, 6), ['In it (most common first):', '- 48× minecraft:wool/11 "蓝色羊毛" (blue)', '- 25× minecraft:wool/14 "红色羊毛" (red)', '- 1× minecraft:wool/4 "黄色羊毛" (yellow)'])
    assert.equal(whole.images![0]!.label, 'iso view from the southeast corner of the draft "hut"')
    // 屋顶盖着：屋里那块黄的看不见；红屋顶和蓝墙看得见
    const outside = pixelsOf(whole.images![0]!.data)
    assert.ok(outside.count(RED) > 500 && outside.count(shade(BLUE, ISO_SHADE.left)) > 500)
    // 用 y2 把屋顶切掉：没有红的了，看得见屋里地上那块黄的
    const open = await s.run('view_draft', { name: 'hut', picture: 'iso', from: 'northwest', y2: 2 })
    const inside = pixelsOf(open.images![0]!.data)
    assert.equal(inside.count(RED), 0)
    assert.ok(inside.count(YELLOW) > 50)
    assert.doesNotMatch(open.content, /wool\/14/)
    // 只看最上面一层：整层都是屋顶
    const roof = await s.run('view_draft', { name: 'hut', picture: 'layer', layer: 3 })
    assert.match(roof.content, /Picture: layer y=3 from above \(north up\)/)
    assert.match(roof.content, /In that layer \(most common first\):\n- 25× minecraft:wool\/14/)
    const bad = await s.run('view_draft', { name: 'hut', picture: 'layer', layer: 4 })
    assert.deepEqual([bad.isError, bad.content], [true, 'Layer 4 is outside: the layers here are 0 to 3.'])
    // 跑完程序的结果里提示可以这样看图（只在模型能看图时）
    assert.match((await s.run('run_program', { code: HUT })).content, /To see what it looks like, view_draft with name "hut" and picture "iso"\./)
  })

  it('模型看不了图时要草稿的图：写明看不了，给的是字符预览', async (t) => {
    const s = setup(t)
    const made = await s.run('run_program', { code: HUT })
    assert.doesNotMatch(made.content, /picture "iso"/)
    const res = await s.run('view_draft', { name: 'hut', picture: 'iso' })
    assert.equal(res.isError, undefined, res.content)
    const lines = res.content.split('\n')
    assert.equal(lines[0], NO_VISION_NOTE)
    assert.match(lines[1]!, /^Draft "hut": 5×4×5 /)
    assert.ok(!res.content.includes('Picture:'))
    assert.match(res.content, /\nLegend: \. empty; A minecraft:wool\/11 "蓝色羊毛"; B minecraft:wool\/14 "红色羊毛"; C minecraft:wool\/4 "黄色羊毛"\n/)
    assert.match(res.content, /\ny=3:\nBBBBB\n/)
  })

  it('看主人传的图片：小图放大到看得清，透明的地方垫灰白格子；看不了图时给尺寸和主要颜色', async (t) => {
    // 2×2：左上红，右上蓝，左下透明，右下红
    const png = encodePng({ width: 2, height: 2, rgba: Buffer.from([255, 0, 0, 255, 0, 0, 255, 255, 9, 9, 9, 0, 255, 0, 0, 255]) })
    const s = setup(t, { vision: true })
    s.design.images.save('flag', png)
    const res = await s.run('view_image', { name: 'flag' })
    assert.equal(res.isError, undefined, res.content)
    assert.equal(res.content, 'Image "flag": 2×2 pixels, shown enlarged 16× (32×32 px).\n25% of it is transparent (drawn as a grey and white checker).')
    assert.equal(res.images![0]!.label, 'the uploaded image "flag"')
    const p = pixelsOf(res.images![0]!.data)
    assert.deepEqual([p.width, p.height], [32, 32])
    assert.deepEqual([p.at(8, 8), p.at(24, 8), p.at(24, 24), p.at(8, 24)], [[255, 0, 0], [0, 0, 255], [255, 0, 0], [255, 255, 255]])
    assert.deepEqual([(await s.run('view_image', { name: 'nope' })).isError, (await s.run('view_image', { name: 'nope' })).content], [true, 'There is no image named "nope". list_images shows the ones there are.'])

    const blind = setup(t)
    blind.design.images.save('flag', png)
    const words = await blind.run('view_image', { name: 'flag' })
    assert.deepEqual(words.content.split('\n'), [
      NO_VISION_NOTE,
      'Image "flag": 2×2 pixels.',
      '25% of it is transparent.',
      'Main colours: red 67%, blue 33%.',
      'A program can read every pixel with image(name) (see the "design" manual).',
    ])
  })
})
