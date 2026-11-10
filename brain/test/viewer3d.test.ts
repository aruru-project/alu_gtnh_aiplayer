// 面板的三维预览里“把盒子变成三角形”那一半（src/panel/public/viewer3d.js 的 buildMesh）：
// 哪些面画、哪些面被挡住不画，剖开和只看一层，半透明的分开放，贴图坐标落在图集的哪一格。
// 画到屏幕上的那一半（WebGL、镜头、拖动）是在浏览器里手动看的。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Scene, SceneKind } from '../src/render/index.ts'

interface Mesh {
  opaque: Float32Array
  transparent: Float32Array
  faces: number
  blocks: number
  truncated: boolean
}
interface ViewerModule {
  FLOATS_PER_VERTEX: number
  expandRuns(scene: Scene): Uint16Array
  buildMesh(scene: Scene, cells: Uint16Array, opts?: { cut?: number; only?: boolean; maxFaces?: number }): Mesh
}
// 面板的脚本是浏览器里直接跑的 JS（没有类型声明），这里按地址载入
const viewer = (await import(new URL('../src/panel/public/viewer3d.js', import.meta.url).href)) as ViewerModule
const F = viewer.FLOATS_PER_VERTEX

const kind = (key: string, extra: Partial<SceneKind> = {}): SceneKind => ({ key, count: 1, side: [100, 110, 120], top: [200, 210, 220], alpha: 1, shape: 'full', known: true, ...extra })
const STONE = kind('minecraft:stone')
const GLASS = kind('minecraft:glass', { alpha: 0.35, side: [196, 224, 236], top: [196, 224, 236] })

/** 一个盒子：blocks 是 "x,y,z" → kinds 的下标。 */
function scene(size: [number, number, number], kinds: (SceneKind | null)[], blocks: Record<string, number>, atlas?: Scene['atlas']): Scene {
  const [sx, sy, sz] = size
  const runs: number[] = []
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) runs.push(blocks[`${x},${y},${z}`] ?? 0, 1)
  return { size: { x: sx, y: sy, z: sz }, origin: { x: 0, y: 0, z: 0 }, kinds: [null, ...kinds], runs, ...(atlas ? { atlas } : {}) }
}

function mesh(s: Scene, opts?: { cut?: number; only?: boolean; maxFaces?: number }): Mesh {
  return viewer.buildMesh(s, viewer.expandRuns(s), opts)
}

/** 一批顶点里的每一个：位置、贴图坐标、颜色（0–255）、不透明度、明暗。 */
function vertices(data: Float32Array) {
  const out: { p: number[]; uv: number[]; rgb: number[]; a: number; light: number }[] = []
  for (let o = 0; o < data.length; o += F) {
    out.push({ p: [...data.subarray(o, o + 3)], uv: [...data.subarray(o + 3, o + 5)], rgb: [...data.subarray(o + 5, o + 8)].map((v) => Math.round(v * 255)), a: Math.round(data[o + 8]! * 100) / 100, light: Math.round(data[o + 9]! * 100) / 100 })
  }
  return out
}

/** 每个面（6 个顶点一组）朝哪边：顶点全在同一个平面上的那根轴和那个坐标，如 "y=1"。 */
function planes(data: Float32Array): string[] {
  const all = vertices(data)
  const out: string[] = []
  for (let n = 0; n < all.length; n += 6) {
    const face = all.slice(n, n + 6)
    const axis = [0, 1, 2].find((a) => face.every((v) => v.p[a] === face[0]!.p[a]))!
    out.push(`${'xyz'[axis]}=${face[0]!.p[axis]}`)
  }
  return out.sort()
}

describe('三维预览：把盒子变成三角形', () => {
  it('一个方块六个面，每个面两个三角形；位置照“x 最快、其次 z、最后 y”的顺序摆', () => {
    // 3×1×2 的盒子里只有 (2, 0, 1) 那一格有方块
    const s = scene([3, 1, 2], [STONE], { '2,0,1': 1 })
    const m = mesh(s)
    assert.deepEqual([m.faces, m.blocks, m.truncated, m.opaque.length, m.transparent.length], [6, 1, false, 6 * 6 * F, 0])
    assert.deepEqual(planes(m.opaque), ['x=2', 'x=3', 'y=0', 'y=1', 'z=1', 'z=2'])
    const all = vertices(m.opaque)
    assert.ok(all.every((v) => v.p[0]! >= 2 && v.p[0]! <= 3 && v.p[1]! >= 0 && v.p[1]! <= 1 && v.p[2]! >= 1 && v.p[2]! <= 2))
    // 每个面的两个三角形合起来正好是一个 1×1 的方形（面积 1）
    for (let n = 0; n < all.length; n += 6) {
      let area = 0
      for (const tri of [all.slice(n, n + 3), all.slice(n + 3, n + 6)]) {
        const [a, b, c] = tri.map((v) => v.p)
        const u = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!]
        const w = [c![0]! - a![0]!, c![1]! - a![1]!, c![2]! - a![2]!]
        area += Math.hypot(u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!) / 2
      }
      assert.ok(Math.abs(area - 1) < 1e-6, `face ${n / 6} has area ${area}`)
      // 两个三角形共用的那条边是这个面的对角线（不然会叠在一起、漏掉一个角）
      const shared = all.slice(n, n + 3).filter((v) => all.slice(n + 3, n + 6).some((w) => w.p.join() === v.p.join()))
      assert.equal(shared.length, 2)
      assert.ok(Math.abs(Math.hypot(...shared[0]!.p.map((c, i) => c - shared[1]!.p[i]!)) - Math.SQRT2) < 1e-6, `face ${n / 6}`)
    }
    // 没有贴图：贴图坐标是 -1；顶面用顶面的颜色、最亮，侧面用侧面的颜色
    const top = all.filter((v) => v.p[1] === 1 && v.light === 1)
    assert.equal(top.length, 6)
    assert.ok(top.every((v) => v.uv[0] === -1 && v.rgb.join() === '200,210,220' && v.a === 1))
    assert.deepEqual([...new Set(all.filter((v) => v.light !== 1).map((v) => v.rgb.join()))], ['100,110,120'])
    assert.deepEqual([...new Set(all.map((v) => v.light))].sort(), [0.5, 0.62, 0.8, 1])
  })

  it('两块挨着的不透明方块，中间那两个面不画；空气和调色板里的空项不画', () => {
    const s = scene([2, 1, 1], [STONE, null], { '0,0,0': 1, '1,0,0': 1 })
    assert.equal(mesh(s).faces, 10)
    assert.ok(!planes(mesh(s).opaque).includes('x=1'))
    // 调色板里的空项（别的空气）当空气
    assert.deepEqual([mesh(scene([2, 1, 1], [STONE, null], { '0,0,0': 1, '1,0,0': 2 })).faces, mesh(scene([2, 1, 1], [STONE, null], { '0,0,0': 1, '1,0,0': 2 })).blocks], [6, 1])
  })

  it('剖开：只画到第几层，露出来的那一层顶面要画；只看一层时上下的面都画', () => {
    // 三格高的一根柱子
    const column = scene([1, 3, 1], [STONE], { '0,0,0': 1, '0,1,0': 1, '0,2,0': 1 })
    const whole = mesh(column)
    assert.deepEqual([whole.faces, whole.blocks], [14, 3])
    // 只画到第 1 层（从 0 数）：两块，顶上那个面现在露出来了
    const cut = mesh(column, { cut: 1 })
    assert.deepEqual([cut.faces, cut.blocks], [10, 2])
    assert.ok(planes(cut.opaque).includes('y=2') && !planes(cut.opaque).includes('y=3'))
    // 只看第 1 层：一块，六个面
    const only = mesh(column, { cut: 1, only: true })
    assert.deepEqual([only.faces, only.blocks, planes(only.opaque).filter((p) => p.startsWith('y'))], [6, 1, ['y=1', 'y=2']])
    // 层数给过头了当到顶
    assert.equal(mesh(column, { cut: 99 }).faces, 14)
  })

  it('玻璃这类半透明的另放一批（后画）；它不挡后面方块的面，同一种挨着的中间不画', () => {
    // 石头、玻璃、玻璃 排成一排
    const s = scene([3, 1, 1], [STONE, GLASS], { '0,0,0': 1, '1,0,0': 2, '2,0,0': 2 })
    const m = mesh(s)
    // 石头朝玻璃的那一面照画（透过玻璃看得见）
    assert.equal(m.opaque.length, 6 * 6 * F)
    assert.ok(planes(m.opaque).includes('x=1'))
    // 两块玻璃：朝石头的那面不画，两块之间的不画，剩下 4 + 5 = 9 个面，带着自己的不透明度
    assert.equal(m.transparent.length, 9 * 6 * F)
    assert.deepEqual(planes(m.transparent).filter((p) => p.startsWith('x')), ['x=3'])
    assert.ok(vertices(m.transparent).every((v) => v.a === 0.35))
    assert.deepEqual([m.faces, m.blocks], [15, 3])
  })

  it('不是整块的方块画成小一号的盒子，六个面都画，也不挡旁边方块的面', () => {
    const torch = kind('minecraft:torch', { shape: 'small' })
    const slab = kind('minecraft:stone_slab', { shape: 'slab' })
    const s = scene([3, 1, 1], [STONE, torch, slab], { '0,0,0': 1, '1,0,0': 2, '2,0,0': 3 })
    const m = mesh(s)
    assert.equal(m.faces, 18)
    // 火把在第 1 格中间：x、z 方向各缩进四分之一，半格高
    const small = vertices(m.opaque).filter((v) => v.p[0]! >= 1.2 && v.p[0]! <= 1.8)
    assert.deepEqual([Math.min(...small.map((v) => v.p[0]!)), Math.max(...small.map((v) => v.p[0]!)), Math.max(...small.map((v) => v.p[1]!)), Math.min(...small.map((v) => v.p[2]!))], [1.25, 1.75, 0.5, 0.25])
    assert.equal(small.length, 36)
    // 半砖：整格宽，半格高
    const half = vertices(m.opaque).filter((v) => v.p[0]! >= 2)
    assert.deepEqual([half.length, Math.max(...half.map((v) => v.p[1]!)), Math.min(...half.map((v) => v.p[0]!)), Math.max(...half.map((v) => v.p[0]!))], [36, 0.5, 2, 3])
  })

  it('有图集时：有贴图的面的贴图坐标落在它那一格里（顶面用顶面那张，染色的带着染色）；没贴图的方块照旧按颜色', () => {
    const atlas = { url: '/api/textures/atlas.png', tile: 16, columns: 4, rows: 2 }
    // 草方块：侧面是第 5 格（第 1 列第 1 行），顶面是第 2 格、要染绿；旁边一块没贴图的
    const grass = kind('minecraft:grass', { tex: 5, texTop: 2, tintTop: [145, 189, 89] })
    const leaves = kind('minecraft:leaves', { tex: 7, tint: [72, 181, 24] })
    const s = scene([3, 1, 1], [grass, STONE, leaves], { '0,0,0': 1, '1,0,0': 2, '2,0,0': 3 }, atlas)
    const all = vertices(mesh(s).opaque)
    /** 第 x 格那块方块的顶面（pick 'top'）或南北两个侧面（'side'）的顶点：按每个面的中心落在哪一格来分。 */
    const of = (x: number, pick: 'top' | 'side') => {
      const out: typeof all = []
      for (let n = 0; n < all.length; n += 6) {
        const face = all.slice(n, n + 6)
        const center = face.reduce((sum, v) => sum + v.p[0]!, 0) / 6
        if (center > x && center < x + 1 && face[0]!.light === (pick === 'top' ? 1 : 0.8)) out.push(...face)
      }
      return out
    }
    const inTile = (v: { uv: number[] }, tile: number): boolean => {
      const column = tile % 4
      const row = Math.floor(tile / 4)
      return v.uv[0]! > column / 4 && v.uv[0]! < (column + 1) / 4 && v.uv[1]! > row / 2 && v.uv[1]! < (row + 1) / 2
    }
    assert.ok(of(0, 'side').length === 12 && of(0, 'side').every((v) => inTile(v, 5) && v.rgb.join() === '255,255,255'))
    assert.ok(of(0, 'top').length === 6 && of(0, 'top').every((v) => inTile(v, 2) && v.rgb.join() === '145,189,89'))
    // 贴图在面上是正的：侧面上边（y 大）对着贴图的上边（v 小）
    const side = of(0, 'side')
    assert.ok(Math.min(...side.filter((v) => v.p[1] === 1).map((v) => v.uv[1]!)) < Math.min(...side.filter((v) => v.p[1] === 0).map((v) => v.uv[1]!)))
    // 一个面用掉差不多一整格贴图
    const us = side.map((v) => v.uv[0]!)
    assert.ok(Math.max(...us) - Math.min(...us) > 0.9 / 4)
    // 树叶：一张贴图，顶面和侧面都染
    assert.ok([...of(2, 'top'), ...of(2, 'side')].every((v) => inTile(v, 7) && v.rgb.join() === '72,181,24'))
    // 石头没有贴图
    assert.ok(of(1, 'top').every((v) => v.uv[0] === -1 && v.rgb.join() === '200,210,220'))
    // 同一份数据不给图集（贴图还没取到时）：全部按颜色
    const flat = vertices(mesh({ ...s, atlas: undefined } as Scene).opaque)
    assert.ok(flat.every((v) => v.uv[0] === -1))
    assert.ok(flat.some((v) => v.rgb.join() === '200,210,220') && !flat.some((v) => v.rgb.join() === '145,189,89'))
  })

  it('面太多时停下来并说明没画全', () => {
    const blocks: Record<string, number> = {}
    for (let x = 0; x < 10; x += 2) blocks[`${x},0,0`] = 1
    const m = mesh(scene([10, 1, 1], [STONE], blocks), { maxFaces: 20 })
    assert.deepEqual([m.faces, m.truncated, m.opaque.length], [20, true, 20 * 6 * F])
    assert.equal(mesh(scene([10, 1, 1], [STONE], blocks)).truncated, false)
  })
})
