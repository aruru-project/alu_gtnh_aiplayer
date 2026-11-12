// 面板“建造 → 图纸”页的“查看”：游戏服务器上的一张图纸长什么样。和草稿的查看是同一套：大脑画的四种简图（和模型用
// view_draft 看到的是同一种图，render/views.ts）、三维预览的数据（render/scene.ts）、每种方块的颜色和数量。
// 格子问身体要（tools/blueprint.ts 的 readPlanCells：一次读不完的分几次读）；读到的留一会儿，换着角度看、一层层翻不用每次再问游戏。
// “查看”那一下总是重新读，并给出这一份的版本号，之后的图和三维数据都带着它。
// 一次最多看每边 256 格（和草稿一样大）：更宽的图纸先给最低角那一块，写明是哪一块、怎么换。
// 列表里的小图：只给一次读得完的图纸画（不超过 262,144 格、每边不超过 256 格），画好的留在内存里，
// 图纸列表上它的“尺寸-方块数”没变就一直用，不过期；变了才重新读。身体的 blueprint.read 跑在游戏的主线程上，开页面不该每次都去读。
//
// 和 server.ts 分开放：server.ts 里只有几行路由指到这里。

import crypto from 'node:crypto'
import type { BridgeApi } from '../bridge/api.ts'
import { CORNERS, GridError, PICTURE_MAX_SIZE, SIDES, countKinds, isAir, kindKey, renderView } from '../render/index.ts'
import type { BlockKind, BlockLooks, Corner, Scene, Side, ViewSpec, VoxelGrid } from '../render/index.ts'
import { BLUEPRINT_READ_MAX_CELLS, PLAN_PICTURE_MAX_SIDE, boxSize, readPlanCells, readPlanHead } from '../tools/blueprint.ts'
import type { BlueprintData, PlanBox } from '../tools/blueprint.ts'
import { dataWithLocalNames, nameOf } from '../tools/format.ts'
import type { Reject } from './data-api.ts'

/** 怎么看（简图那四种）：从地址里读出来。层号是盒子里的 y（layers 是这个盒子从第几层到第几层），换成画的时候的第几层。 */
export function pictureRequest(q: URLSearchParams, layers: [number, number], reject: Reject): { spec: ViewSpec; size: number; plain: boolean } {
  const view = q.get('view') ?? 'iso'
  const from = q.get('from')
  let spec: ViewSpec
  if (view === 'iso') {
    if (from !== null && !(CORNERS as readonly string[]).includes(from)) return reject(400, 'bad_request', `立体图的 from 是四个角之一：${CORNERS.join('、')}`)
    spec = { view, from: (from as Corner | null) ?? 'southeast' }
  } else if (view === 'side') {
    if (from !== null && !(SIDES as readonly string[]).includes(from)) return reject(400, 'bad_request', `立面图的 from 是四边之一：${SIDES.join('、')}`)
    spec = { view, from: (from as Side | null) ?? 'south' }
  } else if (view === 'layer') {
    const layer = Number(q.get('layer') ?? String(layers[0]))
    if (!Number.isInteger(layer) || layer < layers[0] || layer > layers[1]) return reject(400, 'bad_request', `这一张的层是 ${layers[0]} 到 ${layers[1]}`)
    spec = { view, layer: layer - layers[0] }
  } else if (view === 'top') {
    spec = { view }
  } else {
    return reject(400, 'bad_request', 'view 是 iso、top、side、layer 之一')
  }
  const wanted = Number(q.get('size') ?? PICTURE_MAX_SIZE)
  const size = Number.isFinite(wanted) ? Math.max(64, Math.min(PICTURE_MAX_SIZE, Math.round(wanted))) : PICTURE_MAX_SIZE
  return { spec, size, plain: q.get('plain') === '1' }
}

/** 读到的一张图纸（的一块）。 */
interface Loaded {
  head: BlueprintData
  box: PlanBox
  grid: VoxelGrid
  /** 这一块分几次读的（一次最多 262144 格）。 */
  reads: number
  /** 这一份内容的版本号：内容一样就一样。图和三维数据的地址带着它。 */
  version: string
  at: number
}

export interface BlueprintViewDeps {
  bridge: BridgeApi
  /** 方块在简图上长什么样（和草稿、和模型看到的图同一张表）。 */
  looks(): BlockLooks
  /** 本地资料里的显示名（物品表、颜色表）。 */
  localName(kind: BlockKind): string | undefined
  /** 三维预览的数据（server.ts 的 model：带上贴图图集）。 */
  scene(grid: VoxelGrid, nameOf: (kind: BlockKind) => string | undefined): Scene
  reject: Reject
  now(): number
}

/** 既没带版本号、也不是列表里的小图的请求，用多久以前读的还算数。 */
const UNVERSIONED_FRESH_MS = 5 * 60_000
/** 读过的图纸留几份（一份最多 256×256×256 格的盒子）。 */
const LOADED_KEPT = 8
/** 画好的图留几张。 */
const PICTURES_KEPT = 48
const NAME_MAX_CHARS = 80

export class BlueprintViews {
  private readonly deps: BlueprintViewDeps
  /** 键是“名字 + 地址里给的范围”。放的是 Promise：同一张图纸同时来几个请求，只问游戏一次。 */
  private readonly loaded = new Map<string, Promise<Loaded>>()
  private readonly pictures = new Map<string, Buffer>()
  /**
   * 列表里的小图：名字 → 画的时候那张图纸的“尺寸-方块数”，和画好的图（按怎么画分）。只在内存里，只留 PNG（不留格子），
   * 大脑重启了重新读一轮。
   */
  private readonly thumbs = new Map<string, { stamp: string; pngs: Map<string, Buffer> }>()
  /** 正在为小图读的（名字 + 尺寸-方块数）：同时来的请求等同一次。 */
  private readonly thumbReads = new Map<string, Promise<Loaded>>()

  constructor(deps: BlueprintViewDeps) {
    this.deps = deps
  }

  /** 这张图纸变了（面板上传、删除、发布草稿覆盖了它）：读过的、画好的都不要了。 */
  forget(name: string): void {
    for (const key of [...this.loaded.keys()]) if (key.split('\n')[0] === name) this.loaded.delete(key)
    for (const key of [...this.pictures.keys()]) if (JSON.parse(key)[0] === name) this.pictures.delete(key)
    this.thumbs.delete(name)
  }

  /**
   * GET /api/blueprints/view?name=&x1=&z1=…：重新问游戏读这张图纸（大的分几次读），回尺寸、整张的材料表、看的是哪一块、
   * 这一块里每种方块的颜色和数量，和版本号。范围（x1..z2，图纸里从 0 数）不给就是整张；比每边 256 格宽的，没给的那一头只到 256 格。
   */
  async view(q: URLSearchParams): Promise<unknown> {
    const got = await this.load(q, { fresh: true })
    const { head, box, grid } = got
    const looks = this.deps.looks()
    const counts = countKinds(grid)
    const byHand = new Map(head.materials.filter((m) => m.byHand !== undefined).map((m) => [kindKey(m), m.byHand!]))
    const names = this.namer(head)
    const shown = boxSize(box)
    const whole = shown.x === head.size.x && shown.y === head.size.y && shown.z === head.size.z
    return {
      ...(dataWithLocalNames(head) as object),
      box,
      // 看的只是一块（整张比每边 256 格宽）
      part: !whole,
      maxSide: PLAN_PICTURE_MAX_SIDE,
      // 整张一共多少格、一次最多读多少格、这一块读了几次
      cells: head.size.x * head.size.y * head.size.z,
      readMax: BLUEPRINT_READ_MAX_CELLS,
      reads: got.reads,
      version: got.version,
      // 这一块里有的方块：颜色和图上的一致；颜色表里没有的给的是由名字定的颜色，只用来区分
      kinds: grid.kinds.flatMap((kind, i) => {
        if (i === 0 || counts[i] === 0) return []
        const look = looks.of(kind)
        const key = kindKey(kind)
        return [{ key, name: names(kind) ?? null, count: counts[i]!, color: look.top, colorKnown: look.source !== 'hash', ...(byHand.has(key) ? { byHand: byHand.get(key) } : {}) }]
      }),
    }
  }

  /**
   * GET /api/blueprints/picture?name=&v=&x1..z2&view=&from=&layer=&size=&plain=：图（PNG），和模型用 view_draft 要到的同一种。
   * 不带 v、带着 t（列表里的“尺寸-方块数”）的是列表里的小图（thumbnail）。
   */
  async picture(q: URLSearchParams): Promise<Buffer> {
    if (!q.has('v') && q.has('t')) return this.thumbnail(q)
    const got = await this.load(q, { version: q.get('v') ?? undefined })
    const { spec, size, plain } = pictureRequest(q, [got.box.y1, got.box.y2], this.deps.reject)
    const key = JSON.stringify([got.head.name, got.version, got.box, spec, size, plain])
    let png = this.pictures.get(key)
    if (!png) {
      try {
        png = renderView(got.grid, this.deps.looks(), spec, { maxSize: size, plain, title: /^[\x20-\x7e]+$/.test(got.head.name) ? `Blueprint "${got.head.name}"` : 'Blueprint' }).png
      } catch (e) {
        if (e instanceof GridError) return this.deps.reject(400, 'bad_request', e.message)
        throw e
      }
      this.pictures.set(key, png)
      if (this.pictures.size > PICTURES_KEPT) this.pictures.delete(this.pictures.keys().next().value!)
    }
    return png
  }

  /**
   * 列表里的小图（整张）：t 是列表上这张图纸的“尺寸-方块数”（如 11×12×12-496）。一次读不完的（超过 262,144 格）、
   * 比每边 256 格宽的不画：不问游戏，回 400 too_large。画过、而 t 没变的直接给，不再问游戏，也不过期。
   */
  private async thumbnail(q: URLSearchParams): Promise<Buffer> {
    const reject = this.deps.reject
    const name = this.planName(q)
    const stamp = q.get('t') ?? ''
    const m = /^(\d+)×(\d+)×(\d+)-(\d+)$/.exec(stamp)
    if (!m) return reject(400, 'bad_request', '小图的地址里 t 要写成列表里的“尺寸-方块数”，如 11×12×12-496')
    const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (x * y * z > BLUEPRINT_READ_MAX_CELLS || Math.max(x, y, z) > PLAN_PICTURE_MAX_SIDE) {
      return reject(400, 'too_large', `大图纸（${x}×${y}×${z}，${x * y * z} 格），列表里不画小图：点“查看”才读`)
    }
    const { spec, size, plain } = pictureRequest(q, [0, Math.max(0, y - 1)], reject)
    const how = JSON.stringify([spec, size, plain])
    const kept = this.thumbs.get(name)
    const drawn = kept?.stamp === stamp ? kept.pngs.get(how) : undefined
    if (drawn) return drawn
    const key = `${name}\n${stamp}`
    let reading = this.thumbReads.get(key)
    if (!reading) {
      const started = this.read(name, {})
      reading = started
      this.thumbReads.set(key, started)
      started.then(
        () => this.thumbReads.delete(key),
        () => this.thumbReads.delete(key),
      )
    }
    const got = await reading
    let png: Buffer
    try {
      png = renderView(got.grid, this.deps.looks(), spec, { maxSize: size, plain, title: /^[\x20-\x7e]+$/.test(got.head.name) ? `Blueprint "${got.head.name}"` : 'Blueprint' }).png
    } catch (e) {
      if (e instanceof GridError) return reject(400, 'bad_request', e.message)
      throw e
    }
    // 记在读到的那一份的“尺寸-方块数”下（列表要是旧的，下次带着新的来就对上了）
    const real = `${got.head.size.x}×${got.head.size.y}×${got.head.size.z}-${got.head.blocks}`
    const entry = this.thumbs.get(name)?.stamp === real ? this.thumbs.get(name)! : { stamp: real, pngs: new Map<string, Buffer>() }
    entry.pngs.set(how, png)
    this.thumbs.set(name, entry)
    return png
  }

  /** GET /api/blueprints/model?name=&v=&x1..z2：三维预览要的数据（和草稿的同一种）。 */
  async model(q: URLSearchParams): Promise<unknown> {
    const got = await this.load(q, { version: q.get('v') ?? undefined })
    return { name: got.head.name, ...this.deps.scene(got.grid, this.namer(got.head)) }
  }

  /** 方块的显示名：本地的中文名，没有就用身体给的。 */
  private namer(head: BlueprintData): (kind: BlockKind) => string | undefined {
    const given = new Map(head.materials.map((m) => [kindKey(m), m.name]))
    return (kind) => nameOf({ id: kind.id, meta: kind.meta, name: given.get(kindKey(kind)) }) ?? this.deps.localName(kind) ?? given.get(kindKey(kind))
  }

  /** 地址里的图纸名（不带路径；带着 .schematic 的去掉）。 */
  private planName(q: URLSearchParams): string {
    const name = (q.get('name') ?? '').trim().replace(/\.schematic$/i, '')
    if (name.length === 0 || name.length > NAME_MAX_CHARS || name.includes('..') || /[/\\]/.test(name)) return this.deps.reject(400, 'bad_request', '需要图纸的名字（不带路径）')
    return name
  }

  /**
   * 拿一张图纸的一块：fresh 时总是重新问游戏；带着版本号、而留着的那一份正是这个版本时直接用；
   * 都没带时留着的不超过五分钟就用。正在读的那一份，后来的请求等它，不再问一次。
   */
  private async load(q: URLSearchParams, opts: { fresh?: boolean; version?: string | undefined }): Promise<Loaded> {
    const reject = this.deps.reject
    const name = this.planName(q)
    const asked: Partial<Record<keyof PlanBox, number>> = {}
    for (const k of ['x1', 'x2', 'y1', 'y2', 'z1', 'z2'] as const) {
      const text = q.get(k)
      if (text === null || text === '') continue
      const n = Number(text)
      if (!Number.isInteger(n) || n < 0) return reject(400, 'bad_request', `${k} 要写成 0 或正的整数（图纸里的位置，从最低角的 0 数起）`)
      asked[k] = n
    }
    const key = `${name}\n${JSON.stringify(asked)}`
    const kept = this.loaded.get(key)
    if (kept && !opts.fresh) {
      const got = await kept.catch(() => undefined)
      if (got && (opts.version !== undefined ? got.version === opts.version : this.deps.now() - got.at < UNVERSIONED_FRESH_MS)) return got
    }
    const reading = this.read(name, asked)
    this.keep(key, reading)
    reading.then(
      // 读到以后也记在实际的范围下：查看器之后要图时把六个数都写全了（查看时可能一个都没写）
      (got) => {
        const exact = `${name}\n${JSON.stringify(got.box)}`
        if (exact !== key) this.keep(exact, reading)
      },
      // 读失败的不留着（下次再问游戏）
      () => {
        if (this.loaded.get(key) === reading) this.loaded.delete(key)
      },
    )
    return reading
  }

  private keep(key: string, reading: Promise<Loaded>): void {
    this.loaded.delete(key)
    this.loaded.set(key, reading)
    if (this.loaded.size > LOADED_KEPT) this.loaded.delete(this.loaded.keys().next().value!)
  }

  private async read(name: string, asked: Partial<Record<keyof PlanBox, number>>): Promise<Loaded> {
    const reject = this.deps.reject
    const head = await readPlanHead(this.deps.bridge, name)
    const { size } = head
    if (!(size.x > 0 && size.y > 0 && size.z > 0)) return reject(502, 'bad_answer', `游戏那边给的图纸 ${name} 没有尺寸`)
    // 每根轴：从给的那一头起（不给是 0），到给的另一头（不给就到边，但最多 256 格）
    const range = (axis: 'x' | 'y' | 'z'): [number, number] => {
      const max = size[axis] - 1
      const lo = asked[`${axis}1`] ?? 0
      const hi = Math.min(max, asked[`${axis}2`] ?? lo + PLAN_PICTURE_MAX_SIDE - 1)
      if (lo > max) return reject(400, 'bad_request', `${axis}1 是 ${lo}，这张图纸的 ${axis} 是 0 到 ${max}`)
      if (hi < lo) return reject(400, 'bad_request', `${axis}2（${hi}）比 ${axis}1（${lo}）小`)
      if (hi - lo + 1 > PLAN_PICTURE_MAX_SIDE) return reject(400, 'bad_request', `一次最多看每边 ${PLAN_PICTURE_MAX_SIDE} 格，${axis} ${lo} 到 ${hi} 是 ${hi - lo + 1} 格`)
      return [lo, hi]
    }
    const [x1, x2] = range('x')
    const [y1, y2] = range('y')
    const [z1, z2] = range('z')
    const box = { x1, x2, y1, y2, z1, z2 }
    let cells: Awaited<ReturnType<typeof readPlanCells>>
    try {
      cells = await readPlanCells(this.deps.bridge, name, box)
    } catch (e) {
      if (e instanceof GridError) return reject(502, 'bad_answer', `游戏那边给的图纸数据读不出来：${e.message}`)
      throw e
    }
    const hash = crypto.createHash('sha1')
    hash.update(JSON.stringify([head, box, cells.grid.kinds.map((k) => (isAir(k) ? '' : kindKey(k)))]))
    hash.update(new Uint8Array(cells.grid.cells.buffer, cells.grid.cells.byteOffset, cells.grid.cells.byteLength))
    return { head, box, grid: cells.grid, reads: cells.reads, version: hash.digest('hex').slice(0, 16), at: this.deps.now() }
  }
}
