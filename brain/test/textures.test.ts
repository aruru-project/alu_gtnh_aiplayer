// 方块贴图：生成器（tools/make-packdata.py textures）从 mod 的 jar 里取贴图、拼成图集 → 大脑读图集的目录 →
// 三维预览要的数据里每种方块指到图集的第几格。样本包是这里现造的：一个套着 jar 的客户端 zip，加一个“原版”jar。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { decodePng } from '../src/design/index.ts'
import { loadPackData } from '../src/packdata/index.ts'
import { BlockLooks, gridFromBlocks, sceneOf } from '../src/render/index.ts'
import { pythonMissing } from './fixture-pack.ts'
import { TEXTURE_FIXTURES } from './fixture-textures.ts'
import { makeZip, tmpDir, worldBlocksAnswer } from './helpers.ts'

const GENERATOR = path.resolve(import.meta.dirname, '../../tools/make-packdata.py')
const png = (name: keyof typeof TEXTURE_FIXTURES): Buffer => Buffer.from(TEXTURE_FIXTURES[name].png, 'base64')

/** 颜色表里的几行：名字起得和真的一样刁（带目录、带空格和括号、大写）。 */
const BLOCK_ROWS = [
  { id: 'minecraft:stone', meta: 0, name: '石头', color: [125, 125, 125], tex: 'stone' },
  { id: 'chisel:marble', meta: 0, name: '大理石', color: [200, 200, 200], top: [230, 230, 230], tex: 'chisel:marble/raw', texTop: 'stone' },
  { id: 'Ztones:tile.krypBlock', meta: 7, name: 'Kryp ⑦', color: [60, 60, 70], tex: 'ztones:sets/kryp/kryp_ (7)' },
  { id: 'gregtech:gt.blockcasings', meta: 1, name: '机械方块', color: [90, 90, 90], tex: 'gregtech:iconsets/BIG' },
  { id: 'minecraft:dirt', meta: 0, name: '泥土', color: [134, 96, 67], tex: 'dirt' },
  { id: 'broken:block', meta: 0, name: '坏贴图', color: [1, 1, 1], tex: 'broken:bad' },
  { id: 'nowhere:block', meta: 0, name: '没贴图', color: [2, 2, 2], tex: 'nowhere:missing' },
]

function writeFixture(dir: string): { client: string; vanilla: string; out: string } {
  // 客户端包：mod 的 jar 套在 zip 里
  const modJar = makeZip([
    { name: 'assets/chisel/textures/blocks/marble/raw.png', data: png('chisel:marble/raw') },
    { name: 'assets/ztones/textures/blocks/sets/kryp/kryp_ (7).png', data: png('ztones:sets/kryp/kryp_ (7)') },
    { name: 'assets/gregtech/textures/blocks/iconsets/BIG.png', data: png('gregtech:iconsets/BIG') },
    // 这个 mod 换掉了原版的泥土贴图
    { name: 'assets/minecraft/textures/blocks/dirt.png', data: png('dirt@mod') },
    { name: 'assets/broken/textures/blocks/bad.png', data: 'this is not a png' },
    // 不是方块贴图的不管
    { name: 'assets/chisel/textures/items/chisel.png', data: png('stone') },
  ])
  const client = path.join(dir, 'Fixture-client.zip')
  fs.writeFileSync(
    client,
    makeZip([
      { name: 'instance/.minecraft/mods/some-mod-1.0.jar', data: modJar },
      { name: 'instance/.minecraft/mods/not-a-jar.jar', data: 'garbage' },
      { name: 'instance/.minecraft/config/whatever.cfg', data: 'x=1' },
    ]),
  )
  const vanilla = path.join(dir, 'minecraft-client.jar')
  fs.writeFileSync(
    vanilla,
    makeZip([
      { name: 'assets/minecraft/textures/blocks/stone.png', data: png('stone') },
      { name: 'assets/minecraft/textures/blocks/dirt.png', data: png('dirt@vanilla') },
      { name: 'assets/minecraft/textures/blocks/water_still.png', data: png('water_still') },
      { name: 'assets/minecraft/textures/blocks/grass_top.png', data: png('grass_top') },
    ]),
  )
  const out = path.join(dir, 'packdata')
  fs.mkdirSync(out)
  fs.writeFileSync(path.join(out, 'blocks.jsonl'), BLOCK_ROWS.map((r) => JSON.stringify(r)).join('\n'))
  // 别的子命令记下的东西要留着
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify({ nei: { blocks: 7 } }))
  return { client, vanilla, out }
}

function generate(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync('python3', [GENERATOR, 'textures', ...args], { encoding: 'utf8' })
  if (run.error) throw run.error
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

describe('方块贴图', { skip: pythonMissing() }, () => {
  it('生成器：从套在包里的 mod jar 和另给的原版 jar 里取出颜色表点名的贴图，各种存法的 PNG 都读对，拼成一张图集', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const f = writeFixture(tmp.dir)
    const run = generate(['--client', f.client, '--jar', f.vanilla, '--out', f.out])
    assert.equal(run.status, 0, run.stderr)
    assert.equal(run.stdout.trim(), `textures: 7 tiles of 16 px in a 112x16 image (5 of the 7 named in blocks.jsonl, 2 more vanilla ones; 1 not found, 1 unreadable) -> ${path.join(f.out, 'textures')}`)
    assert.match(run.stderr, /cannot read the texture broken:bad: not a PNG file/)
    assert.match(run.stderr, /skipping instance\/\.minecraft\/mods\/not-a-jar\.jar/)

    const index = JSON.parse(fs.readFileSync(path.join(f.out, 'textures', 'atlas.json'), 'utf8'))
    assert.deepEqual([index.format, index.tile, index.columns, index.rows], [1, 16, 7, 1])
    // 先是颜色表里点到的（按出现的先后），再是原版里别的方块贴图
    assert.deepEqual(index.tiles, { stone: 0, 'chisel:marble/raw': 1, 'ztones:sets/kryp/kryp_ (7)': 2, 'gregtech:iconsets/BIG': 3, dirt: 4, grass_top: 5, water_still: 6 })
    assert.deepEqual(index.missing, ['nowhere:missing', 'broken:bad'])

    const atlas = decodePng(fs.readFileSync(path.join(f.out, 'textures', 'atlas.png')))
    assert.deepEqual([atlas.width, atlas.height], [112, 16])
    const tile = (n: number): string => {
      const out = Buffer.alloc(16 * 16 * 4)
      for (let y = 0; y < 16; y++) atlas.rgba.copy(out, y * 64, (y * atlas.width + n * 16) * 4, (y * atlas.width + n * 16 + 16) * 4)
      return out.toString('base64')
    }
    // 每一格的像素和样本的一样：8 位 RGB、隔行的 4 位调色板带透明、16 位灰度、32×32 缩成 16×16（半透明的角按不透明的那部分算颜色）
    assert.equal(tile(0), TEXTURE_FIXTURES.stone.rgba)
    assert.equal(tile(1), TEXTURE_FIXTURES['chisel:marble/raw'].rgba)
    assert.equal(tile(2), TEXTURE_FIXTURES['ztones:sets/kryp/kryp_ (7)'].rgba)
    assert.equal(tile(3), TEXTURE_FIXTURES['gregtech:iconsets/BIG'].rgba)
    // 泥土：mod 换过的那张，不是原版 jar 里的
    assert.equal(tile(4), TEXTURE_FIXTURES['dirt@mod'].rgba)
    assert.equal(tile(5), TEXTURE_FIXTURES.grass_top.rgba)
    // 动画贴图（16×48 的长条）只取最上面那一帧
    assert.equal(tile(6), TEXTURE_FIXTURES.water_still.rgba)

    const meta = JSON.parse(fs.readFileSync(path.join(f.out, 'meta.json'), 'utf8'))
    assert.deepEqual(meta.nei, { blocks: 7 })
    assert.deepEqual({ ...meta.textures, generatedAt: '' }, { format: 1, source: 'Fixture-client.zip + minecraft-client.jar', generatedAt: '', tile: 16, tiles: 7, missing: 2 })
    assert.equal(meta.textures.generatedAt, index.generatedAt)
  })

  it('生成器：只给一个 jar 也行；没有颜色表、一张贴图都找不到时说清楚，不留下半截文件', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const f = writeFixture(tmp.dir)
    const only = generate(['--jar', f.vanilla, '--out', f.out])
    assert.equal(only.status, 0, only.stderr)
    // 原版 jar 里只有石头、泥土、水和草顶：颜色表点到的别的几张都找不到
    const index = JSON.parse(fs.readFileSync(path.join(f.out, 'textures', 'atlas.json'), 'utf8'))
    assert.deepEqual(Object.keys(index.tiles), ['stone', 'dirt', 'grass_top', 'water_still'])
    assert.equal(index.missing.length, 5)

    const empty = path.join(tmp.dir, 'empty')
    fs.mkdirSync(empty)
    const noTable = generate(['--jar', f.vanilla, '--out', empty])
    assert.notEqual(noTable.status, 0)
    assert.match(noTable.stderr, /no such file: .*blocks\.jsonl \(the block colour table names the textures/)
    assert.equal(fs.existsSync(path.join(empty, 'textures')), false)

    const nothing = path.join(tmp.dir, 'nothing.jar')
    fs.writeFileSync(nothing, makeZip([{ name: 'README.txt', data: 'no textures here' }]))
    const none = generate(['--jar', nothing, '--blocks', path.join(f.out, 'blocks.jsonl'), '--out', empty])
    assert.notEqual(none.status, 0)
    assert.match(none.stderr, /none of the 7 textures was found in the jars; nothing written/)
    assert.equal(fs.existsSync(path.join(empty, 'textures')), false)
    assert.match(generate(['--out', empty]).stderr, /give --client .* --jar .* or both/)
  })

  it('大脑读图集的目录；三维预览的数据里，有贴图的方块指到图集的第几格（顶面另有贴图的另指），没有的只有颜色', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const f = writeFixture(tmp.dir)
    assert.equal(generate(['--client', f.client, '--jar', f.vanilla, '--out', f.out]).status, 0)
    const lines: string[] = []
    const data = loadPackData(f.out, (line) => lines.push(line))
    assert.ok(lines.includes('方块贴图：7 张（每张 16 像素）。'), lines.join('\n'))
    const textures = data.textures!
    assert.deepEqual([textures.tile, textures.columns, textures.rows, textures.tiles.get('ztones:sets/kryp/kryp_ (7)'), textures.file], [16, 7, 1, 2, path.join(f.out, 'textures', 'atlas.png')])

    // 一排方块：大理石（侧面和顶面两张贴图）、石头、草方块（原版的：颜色表里没有，内置的，顶面贴图要染绿）、没贴图的、不认识的
    const grid = gridFromBlocks(
      worldBlocksAnswer({ x1: 0, y1: 0, z1: 0, x2: 5, y2: 0, z2: 0 }, { '0,0,0': 'chisel:marble', '1,0,0': 'minecraft:stone', '2,0,0': 'minecraft:grass', '3,0,0': 'nowhere:block', '4,0,0': 'gregtech:gt.blockmachines/3', '5,0,0': 'minecraft:water' }),
    )
    const scene = sceneOf(grid, new BlockLooks(data.blocks!), { textures, atlasUrl: '/api/textures/atlas.png?v=1', nameOf: (k) => (k.id === 'chisel:marble' ? '大理石' : undefined) })
    assert.deepEqual(scene.atlas, { url: '/api/textures/atlas.png?v=1', tile: 16, columns: 7, rows: 1 })
    assert.deepEqual(scene.size, { x: 6, y: 1, z: 1 })
    assert.deepEqual(scene.runs, [1, 1, 2, 1, 3, 1, 4, 1, 5, 1, 6, 1])
    assert.equal(scene.kinds[0], null)
    assert.deepEqual(scene.kinds[1], { key: 'chisel:marble', name: '大理石', count: 1, side: [200, 200, 200], top: [230, 230, 230], alpha: 1, shape: 'full', known: true, tex: 1, texTop: 0 })
    assert.deepEqual([scene.kinds[2]!.tex, scene.kinds[2]!.texTop], [0, undefined])
    // 草方块：侧面那张（grass_side）样本里没有，所以顶面的也不单用，整个按颜色画
    assert.deepEqual([scene.kinds[3]!.key, scene.kinds[3]!.tex, scene.kinds[3]!.known, scene.kinds[3]!.top[1]! > 150], ['minecraft:grass', undefined, true, true])
    assert.deepEqual([scene.kinds[4]!.tex, scene.kinds[4]!.known, scene.kinds[4]!.side], [undefined, true, [2, 2, 2]])
    assert.deepEqual([scene.kinds[5]!.tex, scene.kinds[5]!.known], [undefined, false])
    // 水：原版的水贴图在图集里（不在颜色表里，是跟着原版全部方块贴图一起带上的），半透明
    assert.deepEqual([scene.kinds[6]!.tex, scene.kinds[6]!.alpha < 1], [6, true])

    // 没有图集时：一样的数据，只是都没有贴图
    const plain = sceneOf(grid, new BlockLooks(data.blocks!))
    assert.equal(plain.atlas, undefined)
    assert.ok(plain.kinds.every((k) => k === null || (k.tex === undefined && k.texTop === undefined)))
  })

  it('图集目录坏了、缺了图：大脑照常起来，说明原因，三维预览按颜色画', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const dir = path.join(tmp.dir, 'packdata')
    fs.mkdirSync(path.join(dir, 'textures'), { recursive: true })
    const load = (): { textures: unknown; lines: string[] } => {
      const lines: string[] = []
      return { textures: loadPackData(dir, (line) => lines.push(line)).textures, lines }
    }
    const none = load()
    assert.equal(none.textures, undefined)
    assert.ok(none.lines.some((l) => /^没有方块贴图（textures\/atlas\.json 和 atlas\.png），面板的三维预览按方块颜色画。/.test(l)), none.lines.join('\n'))
    // 有目录没有图
    fs.writeFileSync(path.join(dir, 'textures', 'atlas.json'), JSON.stringify({ tile: 16, columns: 1, rows: 1, tiles: { stone: 0 } }))
    assert.equal(load().textures, undefined)
    fs.writeFileSync(path.join(dir, 'textures', 'atlas.png'), png('stone'))
    assert.equal((load().textures as { tiles: Map<string, number> }).tiles.get('stone'), 0)
    // 目录写坏了
    for (const bad of ['{not json', JSON.stringify({ tile: 16, columns: 0, rows: 1, tiles: { stone: 0 } }), JSON.stringify({ tile: 16, columns: 1, rows: 1, tiles: {} })]) {
      fs.writeFileSync(path.join(dir, 'textures', 'atlas.json'), bad)
      const broken = load()
      assert.equal(broken.textures, undefined, bad)
      assert.ok(broken.lines.some((l) => l.startsWith('方块贴图读不了（')), broken.lines.join('\n'))
    }
    // 指到图集外面的那几条不要，别的照用
    fs.writeFileSync(path.join(dir, 'textures', 'atlas.json'), JSON.stringify({ tile: 16, columns: 2, rows: 1, tiles: { stone: 0, dirt: 1, far: 2, odd: 'x' } }))
    assert.deepEqual([...(load().textures as { tiles: Map<string, number> }).tiles.keys()], ['stone', 'dirt'])
  })
})
