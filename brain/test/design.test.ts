// 自己出设计：模型写的程序在沙箱里跑 → 图纸草稿 → 预览 → 发布成 .schematic。
// 入口是模型用的那几个工具（run_program、view_draft、publish_draft……）；游戏那一头是按方法名应答的假服务器。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import { DesignWorkspace, DraftError, decodePng, parseDraft } from '../src/design/index.ts'
import { loadPackData } from '../src/packdata/index.ts'
import type { PackData } from '../src/packdata/index.ts'
import { sandboxSpawn } from '../src/script/sandbox.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { ALL_TOOLS, runTool } from '../src/tools/index.ts'
import type { ToolContext, ToolResult } from '../src/tools/index.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { pythonMissing } from './fixture-pack.ts'
import { encodePng, tmpDir } from './helpers.ts'
import { readSchematic } from './mock-bridge.ts'
import type { MockBlueprint } from './mock-bridge.ts'

const NOW = 1_800_000_000_000

function setup(t: { after(fn: () => void): void }, opts: { packdata?: PackData; limits?: ConstructorParameters<typeof DesignWorkspace>[0]['limits'] } = {}) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  const game = new FakeGame()
  const design = new DesignWorkspace({ dataDir: tmp.dir, now: () => NOW, ...(opts.packdata ? { packdata: opts.packdata } : {}), ...(opts.limits ? { limits: opts.limits } : {}) })
  /** 身体收到的图纸：照 mod 的读法（模拟 bridge 里那个读取器）读出来的样子。 */
  const published = new Map<string, MockBlueprint>()
  game.handlers['blueprint.put'] = (p) => {
    const blueprint = readSchematic(String(p.name), Buffer.from(String(p.data), 'base64'))
    published.set(blueprint.name, blueprint)
    return { name: blueprint.name, size: blueprint.size, blocks: blueprint.cells.reduce((n, c) => n + (c === 0 ? 0 : 1), 0) }
  }
  const ctx: ToolContext = {
    botName: 'Alu',
    bridge: new BridgeApi(game),
    memory: new MemoryStore(tmp.dir, () => 300),
    manuals: new ManualStore(DEFAULT_MANUALS_DIR, path.join(tmp.dir, 'manuals')),
    design,
    ...(opts.packdata ? { packdata: opts.packdata } : {}),
    reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) },
    hooks: {},
    now: () => NOW,
  }
  const run = (name: string, input: unknown = {}): Promise<ToolResult> => runTool(ALL_TOOLS, ctx, name, input, { maxResultChars: 30_000 })
  /** 跑一个程序；失败了就让测试带着它的报错失败。 */
  const program = async (code: string): Promise<string> => {
    const res = await run('run_program', { code })
    assert.equal(res.isError, undefined, res.content)
    return res.content
  }
  return { tmp, game, design, published, run, program }
}

/** 一张图：每个像素 [r, g, b, a]，按行给。 */
function png(rows: number[][][]): Buffer {
  const height = rows.length
  const width = rows[0]!.length
  return encodePng({ width, height, rgba: Buffer.from(rows.flat(2)) })
}

/** 预览里画出来的格子：每一片的标题下面那几行。 */
function slices(content: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  let current: string[] | undefined
  for (const line of content.split('\n')) {
    const head = /^([xyz]=\d+(?: to [xyz]=\d+ \(\d+ alike\))?):(?: empty)?$/.exec(line)
    if (head) {
      current = out[head[1]!] = []
      continue
    }
    if (current && /^[A-Za-z0-9.#%&*+=@$?]+$/.test(line)) current.push(line)
    else current = undefined
  }
  return out
}

// PIL 存出来的三张小图（独立于这里的解码器），和 PIL 自己读出来的像素
const PNG_FIXTURES = [
  {
    what: 'RGBA，带 Sub 和 Paeth 滤波',
    size: [7, 5],
    file: 'iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFCAYAAACJmvbYAAAAZElEQVR42k3MMQ3DMBBA0VfJBI7CSZba2bO3EAiIlECmIOgUBJmKICAKwnQ6NEO3J33p33CvjIrKUjkuv4tuEIiZOC/vxFp0iE5+SORGvkhF9yDGL7SFdtDQ/rc5004mTDvP9QvVuBJHPgkLjgAAAABJRU5ErkJggg==',
    rgba: 'AAAAKCUAAP9KAAD/bwAAZJQAAP+5AAD/3gAAoAA9AP8lPRH/Sj0iUG89M/+UPUT/uT1VjN49Zv8AegD/JXoiPEp6RP9vemb/lHqIeLl6qv/eesz/ALcAKCW3M/9Kt2b/b7eZZJS3zP+5t///3rcyoAD0AP8l9ET/SvSIUG/0zP+U9BD/ufRUjN70mP8=',
  },
  {
    what: '4 色调色板（每像素 2 位），其中一色透明',
    size: [9, 4],
    file: 'iVBORw0KGgoAAAANSUhEUgAAAAkAAAAEAgMAAAAhYf1dAAAADFBMVEUAAAD/AAAA/wAAAP+bwBPcAAAAAnRSTlP/AOW3MEoAAAAYSURBVHicY5CWZmDIyXFg2LixgeHYsQMAHlYFfYIlbSoAAAAASUVORK5CYII=',
    rgba: 'AAAA//8AAAAA/wD/AAD//wAAAP//AAAAAP8A/wAA//8AAAD//wAAAAD/AP8AAP//AAAA//8AAAAA/wD/AAD//wAAAP//AAAAAP8A/wAA//8AAAD//wAAAAD/AP8AAP//AAAA//8AAAAA/wD/AAD//wAAAP//AAAAAP8A/wAA//8AAAD//wAAAAD/AP8AAP//',
  },
  {
    what: '8 位灰度',
    size: [7, 5],
    file: 'iVBORw0KGgoAAAANSUhEUgAAAAcAAAAFCAAAAACs8akEAAAALklEQVR4nAXBwQ0AIAgDQEn4NbU2jAD7L2f8excLAIAYkiRztCUp27Z9c6rqnf405QQw1E+gvwAAAABJRU5ErkJggg==',
    rgba: 'AAAA/wsLC/8WFhb/ISEh/ywsLP83Nzf/QkJC/yQkJP8xMTH/Pj4+/0tLS/9YWFj/ZWVl/3Jycv9ISEj/V1dX/2VlZf90dHT/g4OD/5KSkv+hoaH/a2tr/3x8fP+NjY3/np6e/6+vr//AwMD/s7Oz/4+Pj/+ioqL/tbW1/8jIyP+9vb3/0NDQ/+Pj4/8=',
  },
] as const

describe('PNG 解码', () => {
  for (const fixture of PNG_FIXTURES) {
    it(`读得出和 PIL 一样的像素：${fixture.what}`, () => {
      const image = decodePng(Buffer.from(fixture.file, 'base64'))
      assert.deepEqual([image.width, image.height], fixture.size)
      assert.equal(image.rgba.toString('base64'), fixture.rgba)
    })
  }
})

describe('写程序出设计', () => {
  it('写一段程序画个小棚子：存成草稿，结果里有尺寸、材料表和一层层的预览', async (t) => {
    const s = setup(t)
    const res = await s.program(
      [
        "const b = blueprint(3, 2, 3)",
        "b.fill(0, 0, 0, 2, 0, 2, 'minecraft:planks')        // 地板",
        "b.walls(0, 1, 0, 2, 1, 2, 'minecraft:cobblestone')  // 一圈墙",
        'b.set(1, 1, 0, null)                                // 北墙留个门',
        "b.save('hut')",
        'return b.get(0, 1, 0)',
      ].join('\n'),
    )
    assert.deepEqual(res.split('\n').slice(1), [
      'Returned: minecraft:cobblestone',
      'Saved draft "hut": 3×2×3 (x east-west × y up × z north-south), 16 block(s) of 2 kind(s). It is only a draft on the brain: nothing is in the game yet.',
      'Materials:',
      '- 9× minecraft:planks',
      '- 7× minecraft:cobblestone',
      'Legend: . empty; A minecraft:planks; B minecraft:cobblestone',
      'Horizontal layers seen from above, from the bottom layer up. Rows run north to south (z 0 to 2), columns west to east (x 0 to 2).',
      'y=0:',
      'AAA',
      'AAA',
      'AAA',
      'y=1:',
      'B.B',
      'B.B',
      'BBB',
      'Check the design, then tell your owner what it looks like, what it needs and where you would build it. Publish it with publish_draft only after they agree.',
    ])
    // 草稿在大脑这边；游戏那边什么都没收到
    assert.deepEqual(s.game.calls, [])
    assert.match((await s.run('list_designs', { kind: 'drafts' })).content, /^1 draft\(s\), newest first:\n- hut: 3×2×3 \(x east-west × y up × z north-south\), 16 block\(s\) of 2 kind\(s\), saved 0 min ago$/)
  })

  it('实心盒子、空心盒子、四面墙、连线各画出什么', async (t) => {
    const s = setup(t)
    await s.program(`
      blueprint(3, 3, 3).box(0, 0, 0, 2, 2, 2, 'minecraft:stone').save('box')
      blueprint(3, 2, 3).walls(2, 1, 2, 0, 0, 0, 'minecraft:stone').save('walls')
      blueprint(4, 1, 3).fill(1, 0, 0, 2, 0, 1, 'minecraft:stone').save('fill')
      blueprint(4, 4, 1).line(0, 0, 0, 3, 3, 0, 'minecraft:stone').save('line')
    `)
    const view = async (name: string, along?: string) => slices((await s.run('view_draft', { name, ...(along ? { along } : {}) })).content)
    // 空心盒子：只有六个面，正中间是空的
    assert.deepEqual(await view('box', 'y'), { 'y=0': ['AAA', 'AAA', 'AAA'], 'y=1': ['AAA', 'A.A', 'AAA'], 'y=2': ['AAA', 'AAA', 'AAA'] })
    // 四面墙：没有地板和顶，每层都是一圈（两个角倒着给也一样）
    assert.deepEqual(await view('walls', 'y'), { 'y=0 to y=1 (2 alike)': ['AAA', 'A.A', 'AAA'] })
    assert.deepEqual(await view('fill', 'y'), { 'y=0': ['.AA.', '.AA.', '....'] })
    // 竖着看：上面是高处
    assert.deepEqual(await view('line', 'z'), { 'z=0': ['...A', '..A.', '.A..', 'A...'] })
  })

  it('程序写错了：语法错误和运行时的错误都告诉它在第几行，什么都不存', async (t) => {
    const s = setup(t)
    const syntax = await s.run('run_program', { code: "const b = blueprint(2, 2, 2)\nb.set(0, 0, 0 'minecraft:stone')\nb.save('x')" })
    assert.equal(syntax.isError, true)
    assert.match(syntax.content, /^The program failed at line 2: SyntaxError: /)
    assert.match(syntax.content, /b\.set\(0, 0, 0 'minecraft:stone'\)\n\s+\^+/)

    const runtime = await s.run('run_program', { code: "const b = blueprint(2, 2, 2)\nb.save('half')\nfunction roof(y) {\n  b.set(0, y, 0, 'minecraft:stone')\n}\nroof(5)" })
    assert.equal(runtime.isError, true)
    assert.match(runtime.content, /^The program failed at line 4, column \d+: RangeError: set: y 5 is outside the blueprint \(y runs from 0 to 1\)\nCall stack: at roof line 4, column \d+; at line 6, column 1\nNothing was saved\./)

    const badBlock = await s.run('run_program', { code: "blueprint(2, 2, 2).set(0, 0, 0, 'stone')" })
    assert.match(badBlock.content, /TypeError: "stone" is not a block: write a registry name such as "minecraft:planks"/)
    // 出错的程序之前 save 过的也不算数
    assert.match((await s.run('list_designs', { kind: 'drafts' })).content, /^There are no drafts\./)
  })

  it('像素画：读主人传的图片，一个像素一个颜色最接近的方块，透明的地方空着', async (t) => {
    const s = setup(t)
    // 颜色正好是红色羊毛、蓝色羊毛、白色染色粘土、黑色羊毛的平均色；右上角透明
    s.design.images.save(
      'flag',
      png([
        [[151, 52, 49, 255], [46, 57, 142, 255], [0, 0, 0, 0]],
        [[210, 178, 161, 255], [26, 22, 22, 255], [151, 52, 49, 255]],
      ]),
    )
    assert.equal((await s.run('list_designs', { kind: 'images' })).content, '1 image(s) (name: width×height in pixels):\n- flag: 3×2')
    const res = await s.program(`
      const img = image('flag')
      const b = blueprint(img.width, img.height, 1)
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const [r, g, bl, a] = img.pixel(x, y)
          if (a < 128) continue
          b.set(x, img.height - 1 - y, 0, nearestBlock(r, g, bl))
        }
      }
      b.save('flag-art')
      // 只许用羊毛时，粘土色的那一格也得是羊毛
      return [images(), nearestBlock([210, 178, 161], ['minecraft:wool']).id]
    `)
    assert.match(res, /^Returned: \[\[\{"name":"flag","width":3,"height":2\}\],"minecraft:wool"\]$/m)
    // 竖着的画只有一格厚：预览默认就是从南面看的整幅
    assert.match(res, /^Legend: \. empty; A minecraft:wool\/14 "红色羊毛"; B minecraft:stained_hardened_clay "白色染色粘土"; C minecraft:wool\/11 "蓝色羊毛"; D minecraft:wool\/15 "黑色羊毛"$/m)
    // 上面一行：红、蓝、空；下面一行：白粘土、黑、红
    assert.deepEqual(slices(res), { 'z=0': ['AC.', 'BDA'] })
  })

  it('img.resize 缩小时每格取它盖住的那一块的平均色；透明的像素不参与', async (t) => {
    const s = setup(t)
    const a = [200, 0, 0, 255]
    const b = [100, 40, 0, 255]
    const clear = [9, 9, 9, 0]
    s.design.images.save(
      'blocks',
      png([
        [a, b, [0, 0, 255, 255], clear],
        [a, b, clear, clear],
      ]),
    )
    const res = await s.program("const small = image('blocks').resize(2)\nreturn [small.width, small.height, small.pixel(0, 0), small.pixel(1, 0)]")
    // 左半边：两个 a 两个 b 的平均；右半边：四格里只有一格不透明，颜色是它的，不透明度是四分之一
    assert.match(res, /^Returned: \[2,1,\[150,20,0,255\],\[0,0,255,64\]\]$/m)
  })

  it('有本地资料时：配色用 blocks.jsonl 的颜色表，材料带物品表里的中文名，程序里能查物品', async (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const lines = (rows: object[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('')
    fs.writeFileSync(
      path.join(tmp.dir, 'blocks.jsonl'),
      lines([
        { id: 'minecraft:planks', meta: 0, name: '橡木木板', color: [157, 128, 79] },
        { id: 'chisel:marble', meta: 3, color: [230, 230, 228] },
      ]),
    )
    fs.writeFileSync(path.join(tmp.dir, 'items.jsonl'), lines([{ id: 'chisel:marble', meta: 3, name: '大理石砖', en: 'Marble Bricks', ores: ['blockMarble'] }]))
    const said: string[] = []
    const s = setup(t, { packdata: loadPackData(tmp.dir, (m) => said.push(m)) })
    assert.match(said.join('\n'), /方块颜色表：2 种方块/)
    const res = await s.program(`
      const b = blueprint(2, 1, 1)
      b.set(0, 0, 0, nearestBlock(240, 240, 240)).set(1, 0, 0, nearestBlock(150, 120, 80))
      b.save('swatch')
      return [palette().length, data.available(), data.item('chisel:marble', 3).en, data.item('minecraft:dirt')]
    `)
    assert.match(res, /^Returned: \[2,\["items"\],"Marble Bricks",null\]$/m)
    assert.match(res, /^- 1× chisel:marble\/3 "大理石砖"$/m)
    assert.match(res, /^- 1× minecraft:planks "橡木木板"$/m)
    // 这里没有任务书资料：查它会得到说明，而不是一个空结果
    const quests = await s.run('run_program', { code: 'return data.quests().length' })
    assert.match(quests.content, /Error: the quests data is not loaded on this brain; data\.available\(\) says what is/)
  })

  it('没有物品表和方块颜色表时：配色用内置的 16 色羊毛和 16 色染色粘土', async (t) => {
    const s = setup(t)
    const res = await s.program('return [palette().length, palette()[14], data.available()]')
    assert.match(res, /^Returned: \[32,\{"id":"minecraft:wool","meta":14,"name":"红色羊毛","color":\[151,52,49\]\},\[\]\]$/m)
  })

  it('大草稿不会一次全倒出来：写明没画哪些、怎么要；可以指定只看哪几层、从哪边看', async (t) => {
    const s = setup(t)
    await s.program(`
      const b = blueprint(40, 12, 30)
      for (let y = 0; y < 12; y++) b.fill(0, y, 0, 39, y, 29, y % 2 ? 'minecraft:stone' : 'minecraft:planks/' + (y % 4))
      b.set(0, 11, 0, 'minecraft:glass')
      b.save('tower')
    `)
    const whole = await s.run('view_draft', { name: 'tower', along: 'y' })
    assert.equal(whole.isError, undefined, whole.content)
    assert.ok(whole.content.length < 6000, `the drawing stays within what one tool result may hold (${whole.content.length} characters)`)
    assert.match(whole.content, /^Draft "tower": 40×12×30 \(x east-west × y up × z north-south\), 14400 block\(s\) of 4 kind\(s\)\./)
    assert.match(whole.content, /^Not drawn: y (\d+) to 11\. Ask again with y1 and y2 to see them\.$/m)
    const firstMissing = Number(/^Not drawn: y (\d+) to 11/m.exec(whole.content)![1])
    assert.deepEqual(Object.keys(slices(whole.content)), Array.from({ length: firstMissing }, (_, y) => `y=${y}`))

    // 只看最上面一层的西北角
    const corner = await s.run('view_draft', { name: 'tower', along: 'y', y1: 11, x2: 3, z2: 1 })
    assert.match(corner.content, /Rows run north to south \(z 0 to 1\), columns west to east \(x 0 to 3\)\./)
    const top = slices(corner.content)['y=11']!
    assert.equal(top[0]!.length, 4)
    assert.notEqual(top[0]![0], top[0]![1], 'the glass block in the corner shows as its own letter')
    assert.equal(top[1], top[0]![1]!.repeat(4))
    // 从西面看：每片是 南北 × 高
    const side = await s.run('view_draft', { name: 'tower', along: 'x', x1: 0, x2: 0 })
    assert.match(side.content, /Upright slices seen from the west.*Rows run from the top down \(y 11 to 0\), columns north to south \(z 0 to 29\)\./)
    assert.deepEqual(slices(side.content)['x=0']!.map((row) => row.length), Array(12).fill(30))

    const outside = await s.run('view_draft', { name: 'tower', y1: 40 })
    assert.equal(outside.isError, true)
    assert.match(outside.content, /y 40 to 11 is outside|y1 \(40\) is above y2 \(11\)/)
    assert.equal((await s.run('view_draft', { name: 'nope' })).isError, true)
  })

  it('view_draft 可以把生成草稿的程序要回来（改一改再跑）；delete_draft 删掉草稿', async (t) => {
    const s = setup(t)
    const code = "const b = blueprint(1, 1, 1)\nb.set(0, 0, 0, 'minecraft:wool/4')\nb.save('dot')"
    await s.program(code)
    const res = await s.run('view_draft', { name: 'dot', program: true })
    assert.ok(res.content.endsWith(`Program that made it:\n${code}`), res.content)
    assert.equal((await s.run('delete_draft', { name: 'dot' })).content, 'Deleted draft "dot".')
    assert.equal((await s.run('delete_draft', { name: 'dot' })).isError, true)
    assert.match((await s.run('list_designs', { kind: 'drafts' })).content, /^There are no drafts\./)
  })

  it('手册里的两个例子照抄就能跑：小屋和像素画各存下一张草稿', async (t) => {
    const s = setup(t)
    s.design.images.save('cat', png(Array.from({ length: 6 }, (_, y) => Array.from({ length: 8 }, (_, x) => [x * 30, y * 40, 200, x === 0 ? 0 : 255]))))
    const manual = fs.readFileSync(path.join(DEFAULT_MANUALS_DIR, 'design.md'), 'utf8')
    const examples = [...manual.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]!)
    assert.equal(examples.length, 2)
    for (const code of examples) await s.program(code)
    const drafts = s.design.drafts.list()
    assert.deepEqual(drafts.map((d) => [d.name, d.size]).sort(), [
      ['cat-art', { x: 32, y: 24, z: 1 }],
      ['小屋', { x: 7, y: 6, z: 7 }],
    ])
  })
})

describe('发布草稿', () => {
  it('publish_draft 把草稿转成 .schematic 发给游戏：身体照它的读法读出来，每一格都和草稿一样', async (t) => {
    const s = setup(t)
    await s.program(`
      const b = blueprint(4, 3, 2)
      b.fill(0, 0, 0, 3, 0, 1, 'minecraft:planks/2')
      b.set(0, 1, 0, 'minecraft:wool/14').set(3, 2, 1, 'minecraft:wool').set(1, 1, 1, 'chisel:cobblestone/15')
      b.save('corner')
    `)
    const res = await s.run('publish_draft', { name: 'corner', as: 'corner-v2' })
    assert.equal(res.isError, undefined, res.content)
    assert.match(res.content, /^Published draft "corner" as blueprint "corner-v2" on the server \(4×3×2, 11 blocks\)\. build_blueprint builds it, given name "corner-v2" and the x, y, z where its lowest corner goes; check_blueprint \(a library function, same arguments\) shows beforehand/)
    assert.deepEqual(s.game.calls.map((c) => [c.method, c.params.name]), [['blueprint.put', 'corner-v2']])

    const got = s.published.get('corner-v2')!
    assert.deepEqual(got.size, { x: 4, y: 3, z: 2 })
    /** 身体读到的 (x, y, z) 那一格。 */
    const at = (x: number, y: number, z: number): string => {
      const kind = got.kinds[got.cells[x + (y * got.size.z + z) * got.size.x]!]!
      return kind.id === 'minecraft:air' ? '.' : `${kind.id}/${kind.meta}`
    }
    const expected = new Map([
      ['0,1,0', 'minecraft:wool/14'],
      ['3,2,1', 'minecraft:wool/0'],
      ['1,1,1', 'chisel:cobblestone/15'],
    ])
    for (let y = 0; y < 3; y++) {
      for (let z = 0; z < 2; z++) {
        for (let x = 0; x < 4; x++) assert.equal(at(x, y, z), y === 0 ? 'minecraft:planks/2' : (expected.get(`${x},${y},${z}`) ?? '.'), `cell ${x},${y},${z}`)
      }
    }
    // 草稿还在，可以接着改
    assert.match((await s.run('list_designs', { kind: 'drafts' })).content, /^1 draft\(s\)/)
  })

  it('用了三百种方块的草稿（数字 id 超过一个字节）也能发布并原样读回', async (t) => {
    const s = setup(t)
    await s.program(`
      const b = blueprint(20, 1, 15)
      for (let i = 0; i < 300; i++) b.set(i % 20, 0, Math.floor(i / 20), 'somemod:block_' + i + '/' + (i % 16))
      b.save('many')
    `)
    const res = await s.run('publish_draft', { name: 'many' })
    assert.equal(res.isError, undefined, res.content)
    const got = s.published.get('many')!
    for (const i of [0, 1, 254, 255, 256, 257, 299]) {
      const kind = got.kinds[got.cells[(i % 20) + Math.floor(i / 20) * 20]!]!
      assert.deepEqual([kind.id, kind.meta], [`somemod:block_${i}`, i % 16], `block ${i}`)
    }
  })

  it('和 tools/make-test-schematic.py 做的那张参考图纸（真实 mod 读得了的）读出来一模一样', { skip: pythonMissing() }, async (t) => {
    const s = setup(t)
    const reference = path.join(s.tmp.dir, 'reference.schematic')
    const made = spawnSync('python3', [path.resolve(import.meta.dirname, '../../tools/make-test-schematic.py'), reference], { encoding: 'utf8' })
    assert.equal(made.status, 0, made.stderr)
    const want = readSchematic('reference', fs.readFileSync(reference))
    // 同一栋小屋，用程序再画一遍（照着那个脚本）
    await s.program(`
      const b = blueprint(5, 5, 5)
      b.fill(0, 0, 0, 4, 0, 4, 'chisel:nucrete/7')
      b.fill(0, 4, 0, 4, 4, 4, 'chisel:cobblestone/15')
      b.walls(0, 1, 0, 4, 3, 4, 'chisel:cobblestone/14')
      for (const [x, z] of [[2, 4], [0, 2], [4, 2]]) b.set(x, 2, z, 'TConstruct:GlassBlock')
      b.fill(2, 1, 0, 2, 2, 0, null)
      b.set(2, 4, 2, 'TConstruct:GlassBlock')
      b.set(1, 3, 1, 'chisel:glowstone/9')
      b.set(3, 1, 3, 'minecraft:chest/3')
      b.set(1, 1, 3, 'minecraft:stone_brick_stairs/3')
      b.save('reference-again')
    `)
    await s.run('publish_draft', { name: 'reference-again' })
    const got = s.published.get('reference-again')!
    assert.deepEqual(got.size, want.size)
    const cells = (b: MockBlueprint) => [...b.cells].map((c) => `${b.kinds[c]!.id}/${b.kinds[c]!.meta}`)
    assert.deepEqual(cells(got), cells(want))
  })

  it('游戏不收这张图纸时，把它的原话告诉模型；草稿没有因此丢掉', async (t) => {
    const s = setup(t)
    await s.program("blueprint(1, 1, 1).set(0, 0, 0, 'minecraft:stone').save('dot')")
    s.game.handlers['blueprint.put'] = () => {
      throw new BridgeError('bad_request', 'the plan is 300 high; the world is 256')
    }
    const res = await s.run('publish_draft', { name: 'dot' })
    assert.equal(res.isError, true)
    assert.equal(res.content, 'The game server did not accept the blueprint: the plan is 300 high; the world is 256. The draft is still there.')
    assert.equal(s.design.drafts.list().length, 1)
    assert.equal((await s.run('publish_draft', { name: 'ghost' })).isError, true)
  })
})

describe('程序交上来的草稿不可信', () => {
  const good = { name: 'a', size: { x: 2, y: 1, z: 1 }, kinds: ['minecraft:stone'], runs: [1, 2] }
  it('合规的草稿收下；名字带路径的、格子和尺寸对不上的、方块写得不对的、大得离谱的都不收', () => {
    assert.deepEqual([...parseDraft(good).cells], [1, 1])
    const reject = (change: object, why: RegExp) => assert.throws(() => parseDraft({ ...good, ...change }), (e: unknown) => e instanceof DraftError && why.test(e.message), JSON.stringify(change))
    reject({ name: '../../config' }, /cannot be a draft name/)
    reject({ name: 'a/b' }, /cannot be a draft name/)
    reject({ name: '.hidden' }, /cannot be a draft name/)
    reject({ runs: [1, 3] }, /do not match its size/)
    reject({ runs: [1, 1] }, /do not match its size/)
    reject({ runs: [2, 2] }, /names a block the draft does not list/)
    reject({ runs: [1, -2, 1, 4] }, /do not match its size/)
    reject({ kinds: ['stone'] }, /is not a block/)
    reject({ kinds: ['minecraft:wool/16'] }, /is not a block/)
    reject({ size: { x: 2, y: 300, z: 1 } }, /the y size is 300/)
    reject({ size: { x: 256, y: 256, z: 256 } }, /cells; the most is/)
    reject({ size: { x: 2.5, y: 1, z: 1 } }, /whole number/)
  })
})

describe('程序篡改了交回来的草稿', () => {
  it('把草稿的名字改成带路径的：大脑不存它，并告诉模型为什么；数据目录以外什么都没多出来', async (t) => {
    const s = setup(t)
    // 程序和 API 在同一个上下文里，改得了 API 内部用的东西：这里让“存下的草稿”变成一张伪造的
    const res = await s.program(`
      Map.prototype.values = function () {
        return [{ name: '../../evil', size: { x: 1, y: 1, z: 1 }, kinds: ['minecraft:stone'], runs: [1, 1] }][Symbol.iterator]()
      }
      return 1
    `)
    assert.match(res, /^Draft "\.\.\/\.\.\/evil" was NOT saved: "\.\.\/\.\.\/evil" cannot be a draft name/m)
    assert.deepEqual(s.design.drafts.list(), [])
    assert.equal(fs.existsSync(path.join(s.tmp.dir, '..', 'evil.json')), false)
    assert.equal(fs.existsSync(path.join(s.tmp.dir, '..', '..', 'evil.json')), false)
  })
})

describe('沙箱', () => {
  // 测试里把上限调小，不然撑爆内存那几个要等好几秒
  const tight = { heapMb: 64, rssMb: 300 }

  it('死循环的程序到时间就被停掉；大脑不受影响，接着照常能跑别的程序', async (t) => {
    const s = setup(t)
    const started = Date.now()
    const res = await s.run('run_program', { code: "log('working')\nfor (;;) {}", timeout: 1 })
    assert.equal(res.isError, true)
    assert.match(res.content, /^The program was stopped: it ran longer than 1 s\. Nothing was saved\./)
    // 被停掉之前打的日志还在
    assert.match(res.content, /^Log:\nworking$/m)
    assert.ok(Date.now() - started < 5000, 'it is stopped soon after the limit')
    assert.match(await s.program('return 6 * 7'), /^Returned: 42$/m)
  })

  it('程序把收尾也卡死（vm 自己的超时管不到那里）：过了时限由大脑把子进程杀掉', async (t) => {
    const s = setup(t)
    const started = Date.now()
    // 程序本身立刻就 return 了；卡住的是之后把结果转成 JSON 的那一步
    const res = await s.run('run_program', { code: 'Object.prototype.toJSON = function () { for (;;) {} }\nreturn 1', timeout: 1 })
    assert.equal(res.isError, true)
    assert.match(res.content, /^The program was stopped: it ran longer than 1 s\./)
    assert.ok(Date.now() - started < 8000)
    assert.match(await s.program('return 6 * 7'), /^Returned: 42$/m)
  })

  it('吃内存的程序被停掉：不管是塞满 JS 堆，还是开一堆大数组', async (t) => {
    const s = setup(t, { limits: tight })
    const heap = await s.run('run_program', { code: "const all = []\nfor (;;) all.push({ n: all.length, text: 'x'.repeat(20) + all.length })" })
    assert.equal(heap.isError, true)
    assert.match(heap.content, /^The program was stopped: it used too much memory\. Nothing was saved\./)
    // 大数组不在 JS 堆里，靠盯着进程的常驻内存来拦：只在 Linux 上有
    if (fs.existsSync('/proc/self/statm')) {
      const buffers = await s.run('run_program', { code: 'const all = []\nfor (;;) { const big = new Uint8Array(32 * 1024 * 1024); big.fill(1); all.push(big) }' })
      assert.equal(buffers.isError, true)
      assert.match(buffers.content, /^The program was stopped: it used too much memory\./)
    }
    assert.match(await s.program('return 1 + 1'), /^Returned: 2$/m)
  })

  it('程序里没有文件、进程和网络的入口：想读文件、想联网的办法都落空，没有一个连接连出去', async (t) => {
    const s = setup(t)
    let connections = 0
    const server = net.createServer((socket) => {
      connections++
      socket.destroy()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    t.after(() => server.close())
    const port = (server.address() as net.AddressInfo).port
    const secret = path.join(s.tmp.dir, 'config.json')
    fs.writeFileSync(secret, '{"apiKey":"sk-very-secret"}')
    const res = await s.program(`
      const tried = {}
      const attempt = async (name, fn) => {
        try { tried[name] = 'GOT ' + String(await fn()) } catch (e) { tried[name] = 'blocked' }
      }
      await attempt('fetch', () => fetch('http://127.0.0.1:${port}/'))
      await attempt('XMLHttpRequest', () => new XMLHttpRequest())
      await attempt('WebSocket', () => new WebSocket('ws://127.0.0.1:${port}/'))
      await attempt('require net', () => require('node:net').connect(${port}, '127.0.0.1'))
      await attempt('import net', async () => (await import('node:net')).connect(${port}, '127.0.0.1'))
      await attempt('require fs', () => require('node:fs').readFileSync(${JSON.stringify(secret)}, 'utf8'))
      await attempt('import fs', async () => (await import('node:fs')).readFileSync(${JSON.stringify(secret)}, 'utf8'))
      await attempt('process', () => process.env)
      await attempt('child_process', () => require('node:child_process').execSync('id'))
      await attempt('eval', () => eval('process'))
      await attempt('Function', () => Function('return process')())
      await attempt('constructor', () => log.constructor('return process')())
      await attempt('global constructor', () => globalThis.constructor.constructor('return process')())
      await attempt('timer', () => setTimeout(() => {}, 1))
      return tried
    `)
    const tried = JSON.parse(/^Returned: (.*)$/m.exec(res)![1]!) as Record<string, string>
    assert.equal(Object.keys(tried).length, 14)
    for (const [name, outcome] of Object.entries(tried)) assert.equal(outcome, 'blocked', name)
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(connections, 0)
    assert.equal(res.includes('sk-very-secret'), false)
  })

  it('沙箱进程本身（就算程序逃出了那层 vm）：读不了数据目录里的配置，写不了文件，起不了进程和线程', async (t) => {
    const s = setup(t)
    const secret = path.join(s.tmp.dir, 'config.json')
    fs.writeFileSync(secret, '{"apiKey":"sk-very-secret"}')
    const allowed = fs.realpathSync(s.design.images.dir.replace(/images$/, '')) + '/images'
    fs.mkdirSync(allowed, { recursive: true })
    const probe = path.join(allowed, 'probe.mjs')
    fs.writeFileSync(
      probe,
      `
      import fs from 'node:fs'
      import { execFileSync } from 'node:child_process'
      import { Worker } from 'node:worker_threads'
      const out = {}
      const attempt = (name, fn) => { try { fn(); out[name] = 'ALLOWED' } catch (e) { out[name] = e.code ?? e.name } }
      attempt('read its own directory', () => fs.readFileSync(import.meta.filename))
      attempt('read the config next door', () => fs.readFileSync(${JSON.stringify(secret)}))
      attempt('read /etc/passwd', () => fs.readFileSync('/etc/passwd'))
      attempt('write a file', () => fs.writeFileSync(${JSON.stringify(path.join(allowed, 'out.txt'))}, 'x'))
      attempt('start a process', () => execFileSync('id'))
      attempt('start a worker', () => new Worker('1', { eval: true }))
      attempt('make code from a string', () => new Function('return 1')())
      attempt('environment', () => { if (Object.keys(process.env).length > 0) return; throw Object.assign(new Error('empty'), { code: 'EMPTY' }) })
      console.log(JSON.stringify(out))
      `,
    )
    // 和 sandbox.ts 起子进程用的是同一组参数、同一个（空的）环境
    const how = sandboxSpawn([allowed], 64)
    const run = spawnSync(process.execPath, [...how.args, probe], { ...how.options, encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.deepEqual(JSON.parse(run.stdout), {
      'read its own directory': 'ALLOWED',
      'read the config next door': 'ERR_ACCESS_DENIED',
      'read /etc/passwd': 'ERR_ACCESS_DENIED',
      'write a file': 'ERR_ACCESS_DENIED',
      'start a process': 'ERR_ACCESS_DENIED',
      'start a worker': 'ERR_ACCESS_DENIED',
      'make code from a string': 'EvalError',
      environment: 'EMPTY',
    })
  })

  it('日志打得太多只留开头，返回的东西太长只给开头：两样都写明一共多少、留了多少、剩下的怎么拿，不悄悄截掉', async (t) => {
    const s = setup(t)
    const res = await s.program("for (let i = 0; i < 5000; i++) log('line ' + i)\nreturn 'y'.repeat(100000)")
    const log = /^Log:\n([\s\S]*?)\n… \(the log is full: it holds 4000 characters in all, so (\d+) log line\(s\) after this point were cut short or dropped\. Log less, or return what you need\)$/m.exec(res)
    assert.ok(log, res.slice(0, 300))
    assert.ok(log[1]!.startsWith('line 0\nline 1\n'))
    assert.ok(log[1]!.length <= 4000)
    assert.ok(Number(log[2]) > 4000)
    // 返回值：一个结果最多 20000 字符（没人另说时的“单个工具结果上限”），前面的日志占了四千多
    const returned = /^Returned \(CUT: this is only the first (\d+) of 100000 characters; one result holds at most 20000 characters, the log above included\. To get the rest, return less at a time: pick the fields you need from r\.data, narrow the tool call with its own filters or its page argument, or return a later slice of the text\): (y+)$/m.exec(res)
    assert.ok(returned, res.slice(-600))
    assert.equal(returned[2]!.length, Number(returned[1]))
    assert.ok(Number(returned[1]) > 15000 && res.length <= 20000, `${returned[1]} shown, ${res.length} in all`)
  })

  it('程序报错的那句话太长时只留开头，并写明留了多少', async (t) => {
    const s = setup(t)
    const res = await s.run('run_program', { code: "throw new Error('e'.repeat(3000))" })
    assert.equal(res.isError, true)
    assert.match(res.content, /^The program failed at line 1, column \d+: Error: e{1000}… \[only the first 1000 of the 3000 characters of this message are kept\]\n/)
  })

  it('返回的东西只要放得下一个工具结果就整段给：五千字符的文字不会被截', async (t) => {
    const s = setup(t)
    const res = await s.program("return 'line of a long table\\n'.repeat(250)")
    assert.equal(res.split('\n').filter((line) => line === 'line of a long table').length, 249)
    assert.match(res, /^Returned: line of a long table$/m)
    assert.doesNotMatch(res, /CUT/)
  })

  it('一次只跑一个程序：上一个还没完，第二个被告知等着', async (t) => {
    const s = setup(t)
    const first = s.run('run_program', { code: 'const end = Date.now() + 400\nwhile (Date.now() < end) {}\nreturn 1' })
    const second = await s.run('run_program', { code: 'return 2' })
    assert.equal(second.isError, true)
    assert.equal(second.content, 'Another program of yours is still running. Wait for it to finish.')
    assert.match((await first).content, /^Returned: 1$/m)
  })
})
