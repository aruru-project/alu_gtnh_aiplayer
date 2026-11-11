// “现在”页要的东西：游戏里的它此刻的样子，整理成面板可以直接画的形状。
//   - 身上的东西：每一格是什么、叫什么（本地物品表的中文名，查不到用身体给的英文名）、图标怎么画；
//   - 开着的界面（箱子、机器）的格子；
//   - 附近的玩家（同一个维度的按远近排）；
//   - 脚下一片地的俯视图（world.scan 的地表，按方块颜色表上色）。
// 这里只读不改：问身体的都是只读的请求，问不到的那一部分就是没有，别的照给。
//
// 一样东西的图标怎么画（ItemLook），按这个顺序找：
//   1. 物品图标图集（packdata 的 icons/）里有它：{ icon: 第几个 }
//   2. 它是方块，方块贴图图集（textures/）里有它的贴图：{ tex: 第几格 }（面板把那一格贴图放大当图标）
//   3. 它是颜色表里的方块：{ color: 颜色, known: true }
//   4. 都不是：{ color: 由 id 算出来的固定颜色, known: false }（面板画成色块加名字的头一个字）

import fs from 'node:fs'
import path from 'node:path'
import type { BridgeApi } from '../bridge/api.ts'
import type { BridgeStatus } from '../bridge/client.ts'
import type { BotStatus, InventoryItem, Item, ScanResult, ScreenState, ServerInfo } from '../bridge/protocol.ts'
import type { DesignWorkspace } from '../design/index.ts'
import { itemIconsStillValid, loadItemIcons } from '../packdata/icons.ts'
import type { ItemIcons } from '../packdata/icons.ts'
import type { TextureAtlas } from '../packdata/index.ts'
import { BlockLooks, stableColor } from '../render/index.ts'
import type { RGB } from '../render/index.ts'
import type { ConfigStore } from '../store/config.ts'
import { fluidName, nameOf } from '../tools/format.ts'

export type ItemLook = { icon: number } | { tex: number; tint?: RGB } | { color: RGB; known: boolean }

export interface ItemView {
  id: string
  meta: number
  count: number
  /** 给人看的名字：中文名，查不到是身体给的英文名，再没有就是 id。 */
  name: string
  /** 身体给的英文名；和 name 一样、或者没有时不带。 */
  en?: string
  /** 剩余耐久的比例（0–1），只有工具有。 */
  durability?: number
  look: ItemLook
}

export interface SlotView {
  slot: number
  item?: ItemView
  /** 开着的界面里：这一格是它自己背包的。 */
  own?: boolean
  /** 放不进东西的格子（机器出产物的地方）。 */
  takesNothing?: boolean
  /** 只显示、里面没有真东西的格子（编程电路的设置）。 */
  ghost?: boolean
}

/**
 * 开着的界面上格子以外的一样东西（docs/PROTOCOL.md 的“界面上的控件”）：开关、选项、数字、能再打开的面板（页签）、流体格、按钮。
 * 名字是界面自己起的（fluidAutoOutput、cover_panel_west……），面板只照着显示，不操作。
 */
export interface ControlView {
  /** 它在哪块面板上（界面自己起的名字）。 */
  panel?: string
  key: string
  /** key 里冒号前面的那一段：给人看的名字。 */
  name: string
  /** switch | choice | number | text | panel | fluid | button | value | other */
  kind: string
  value?: string | number | boolean
  /** 只显示、不收玩家的改动。 */
  readOnly?: boolean
  /** kind 是 panel：这块面板现在开着没有。 */
  open?: boolean
  /** kind 是 choice：能选哪几样。 */
  options?: string[]
  /** kind 是 fluid：格里是什么流体（name 是中文名，查不到是身体给的）、多少 mB、能装多少；空的没有 id。 */
  fluid?: { id?: string; name?: string; amount: number; capacity?: number; fills?: boolean; drains?: boolean }
}

/** 一个界面最多给面板这么多个控件（再多的不列，带上一共多少个）。 */
const CONTROLS_MAX = 80

export interface LiveDeps {
  config: ConfigStore
  bridge: BridgeApi
  bridgeStatus(): BridgeStatus
  design: DesignWorkspace
  textures?: TextureAtlas
  /** 物品图标图集。false：没有，也不用去找；不给：自己到配置的 packdata 目录里找一次。 */
  icons?: ItemIcons | false
  now(): number
}

const BRAIN_ROOT = path.resolve(import.meta.dirname, '..', '..')
/** 俯视图最多看多远（world.scan 一次最多 64×64 列）。 */
export const MINIMAP_MAX_RADIUS = 31
const MINIMAP_DEFAULT_RADIUS = 24
const MINIMAP_CACHE_MS = 2500
const LIVE_CACHE_MS = 700
/** 隔这么久看一眼物品图标的说明文件有没有被换过。 */
const ICONS_RECHECK_MS = 5000
const NAMES_PER_REQUEST = 200

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 身体给的一个控件 → 面板显示的。认不出来（没有 key）的不要。 */
function controlView(raw: unknown): ControlView | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.key !== 'string' || r.key.length === 0) return undefined
  const view: ControlView = { key: r.key, name: r.key.split(':')[0] || r.key, kind: typeof r.kind === 'string' ? r.kind : 'other' }
  if (typeof r.panel === 'string' && r.panel.length > 0) view.panel = r.panel
  if (typeof r.value === 'string' || typeof r.value === 'number' || typeof r.value === 'boolean') view.value = typeof r.value === 'string' ? r.value.slice(0, 200) : r.value
  if (r.readOnly === true) view.readOnly = true
  if (typeof r.open === 'boolean') view.open = r.open
  if (Array.isArray(r.options)) view.options = r.options.filter((o): o is string => typeof o === 'string').slice(0, 40)
  if (view.kind === 'fluid') {
    const id = typeof r.fluid === 'string' && r.fluid.length > 0 ? r.fluid : undefined
    view.fluid = { amount: finite(r.amount) ? r.amount : 0 }
    if (id !== undefined) {
      view.fluid.id = id
      view.fluid.name = fluidName(id, typeof r.name === 'string' ? r.name : undefined)
    }
    if (finite(r.capacity)) view.fluid.capacity = r.capacity
    if (typeof r.fills === 'boolean') view.fluid.fills = r.fills
    if (typeof r.drains === 'boolean') view.fluid.drains = r.drains
  }
  return view
}

export class PanelLive {
  private readonly deps: LiveDeps
  private icons: ItemIcons | undefined
  private iconsLooked = false
  private iconsCheckedAt = 0
  private looks: { table: object; looks: BlockLooks } | undefined
  private liveCache: { at: number; data: unknown } | undefined
  private mapCache: { at: number; key: string; data: unknown } | undefined

  constructor(deps: LiveDeps) {
    this.deps = deps
    if (deps.icons !== undefined) {
      this.icons = deps.icons === false ? undefined : deps.icons
      this.iconsLooked = true
    }
  }

  /**
   * 物品图标图集：头一次用到时读一次，记住结论。之后只隔一阵看一眼说明文件有没有被换过（大脑运行期间重新导出了资料）：
   * 换过就当没有图标，直到大脑重启——那时内存里的行号对不上磁盘上的图了。
   */
  private itemIcons(): ItemIcons | undefined {
    const log = (message: string): void => console.log(`${new Date().toISOString()} [packdata] ${message}`)
    if (!this.iconsLooked) {
      this.iconsLooked = true
      this.icons = loadItemIcons(path.resolve(BRAIN_ROOT, this.deps.config.packdataDir()), log)
      this.iconsCheckedAt = this.deps.now()
    } else if (this.icons && this.deps.now() - this.iconsCheckedAt > ICONS_RECHECK_MS) {
      this.iconsCheckedAt = this.deps.now()
      if (!itemIconsStillValid(this.icons)) {
        this.icons = undefined
        log('物品图标在大脑运行期间被重新导出了，和内存里的物品表对不上：面板先用替代的画法，重启大脑后再用新的图标。')
      }
    }
    return this.icons
  }

  private blockLooks(): BlockLooks {
    const table = this.deps.design.colors()
    if (this.looks?.table !== table) this.looks = { table, looks: new BlockLooks(table) }
    return this.looks.looks
  }

  /** 面板画图标要的两张图集在哪、怎么切。哪张没有就是 null。 */
  looksInfo(): { icons: unknown; textures: unknown } {
    const icons = this.itemIcons()
    const textures = this.deps.textures
    return {
      // 第 n 个图标在第 floor(n / (columns*rows)) 张图里，张内第 n % (columns*rows) 格；面板用到哪张才取哪张
      icons: icons
        ? {
            cell: icons.cell,
            columns: icons.columns,
            rows: icons.rows,
            sheets: icons.files.map((_, n) => `/api/icons/sheet?n=${n}&v=${encodeURIComponent(icons.version)}`),
          }
        : null,
      textures: textures ? { url: `/api/textures/atlas.png?v=${encodeURIComponent(textures.version)}`, tile: textures.tile, columns: textures.columns, rows: textures.rows } : null,
    }
  }

  /** 物品图标图集的第 n 张图，原样给。没有这张时返回 undefined。 */
  iconSheet(n: number): Buffer | undefined {
    const file = this.itemIcons()?.files[n]
    if (file === undefined) return undefined
    try {
      return fs.readFileSync(file)
    } catch {
      return undefined
    }
  }

  /** 一样东西的图标怎么画。 */
  lookOf(id: string, meta: number): ItemLook {
    const icon = this.itemIcons()?.indexOf(id, meta)
    if (icon !== undefined) return { icon }
    // 物品的 meta 可以很大（GregTech 的元物品）；只有 0–15 的才可能是放下去的方块
    if (meta >= 0 && meta <= 15) {
      const look = this.blockLooks().of({ id, meta })
      if (look.source !== 'hash' && !look.marker) {
        const name = look.texTop ?? look.tex
        const tile = name !== undefined ? this.deps.textures?.tiles.get(name) : undefined
        if (tile !== undefined) {
          const tint = look.tintTop ?? look.tint
          return tint ? { tex: tile, tint } : { tex: tile }
        }
        return { color: look.top, known: true }
      }
    }
    return { color: stableColor(id), known: false }
  }

  /**
   * 一批物品的中文名（对话页把工具参数里的物品 id 写成名字用）。q 是逗号隔开的 "id/meta"（meta 不写当 0），一次最多 200 个。
   * 只回查得到名字的那些。
   */
  itemNames(q: string): { names: Record<string, string> } {
    const names: Record<string, string> = {}
    for (const key of q.split(',').slice(0, NAMES_PER_REQUEST)) {
      const slash = key.lastIndexOf('/')
      const id = slash > 0 ? key.slice(0, slash) : key
      const meta = slash > 0 ? Number(key.slice(slash + 1)) : 0
      if (id.length === 0 || id.length > 200 || !Number.isInteger(meta)) continue
      const name = nameOf({ id, meta })
      if (name !== undefined) names[`${id}/${meta}`] = name
    }
    return { names }
  }

  /** 身体给的一样东西 → 面板画的一样东西。认不出来（没有 id）时返回 undefined。 */
  itemView(raw: Item | InventoryItem | null | undefined): ItemView | undefined {
    if (!raw || typeof raw.id !== 'string' || raw.id.length === 0) return undefined
    const meta = finite(raw.meta) ? raw.meta : 0
    const server = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : undefined
    const name = nameOf(raw) ?? server ?? raw.id
    const view: ItemView = { id: raw.id, meta, count: finite(raw.count) ? raw.count : 1, name, look: this.lookOf(raw.id, meta) }
    if (server !== undefined && server !== name) view.en = server
    const durability = (raw as InventoryItem).durability
    if (finite(durability)) view.durability = Math.max(0, Math.min(1, durability))
    return view
  }

  /**
   * “现在”页的数据。没连上游戏、它不在线时也回一个完整的对象（online: false 加原因），面板照着画“看不到”的样子。
   * 同一秒里问几次只问身体一次。
   */
  async live(): Promise<unknown> {
    const now = this.deps.now()
    if (this.liveCache && now - this.liveCache.at < LIVE_CACHE_MS) return this.liveCache.data
    const data = await this.build(now)
    this.liveCache = { at: now, data }
    return data
  }

  private async build(now: number): Promise<unknown> {
    const name = this.deps.config.get().bot.name
    const base = { time: now, name, looks: this.looksInfo() }
    if (this.deps.bridgeStatus().state !== 'connected') return { ...base, connected: false, online: false, reason: '没连上游戏' }

    const [st, si] = await Promise.allSettled([this.deps.bridge.botStatus(name), this.deps.bridge.serverInfo()])
    if (st.status !== 'fulfilled') {
      return { ...base, connected: true, online: false, reason: st.reason instanceof Error ? st.reason.message : String(st.reason) }
    }
    const status: BotStatus = st.value
    const server: ServerInfo | undefined = si.status === 'fulfilled' ? si.value : undefined
    if (!status.online) return { ...base, connected: true, online: false, settings: status.settings ?? {}, players: this.players(server, name, undefined) }

    // 开着的界面：有任务在跑时身体不让看（busy），那就当没有
    let screen: ScreenState | undefined
    try {
      screen = await this.deps.bridge.screenLook(name)
    } catch {
      screen = undefined
    }

    const inventory: SlotView[] = []
    for (const raw of status.inventory ?? []) {
      const item = this.itemView(raw)
      if (item && finite(raw.slot)) inventory.push({ slot: raw.slot, item })
    }
    return {
      ...base,
      connected: true,
      online: true,
      dim: status.dim ?? null,
      pos: status.pos ?? null,
      block: status.block ?? null,
      yaw: finite(status.yaw) ? status.yaw : null,
      pitch: finite(status.pitch) ? status.pitch : null,
      onGround: status.onGround ?? null,
      inWater: status.inWater ?? null,
      health: finite(status.health) ? status.health : null,
      maxHealth: finite(status.maxHealth) ? status.maxHealth : 20,
      food: finite(status.food) ? status.food : null,
      xpLevel: finite(status.xpLevel) ? status.xpLevel : null,
      heldSlot: finite(status.heldSlot) ? status.heldSlot : null,
      freeSlots: finite(status.freeSlots) ? status.freeSlots : null,
      settings: status.settings ?? {},
      inventory,
      // 协议里盔甲的顺序是 1.7.10 的 armorInventory：0 靴子、1 护腿、2 胸甲、3 头盔
      armor: [0, 1, 2, 3].map((n) => this.itemView(status.armor?.[n]) ?? null),
      screen: screen?.open ? this.screenView(screen) : null,
      players: this.players(server, name, status),
      world: server ? { dayTime: server.dayTime ?? null, isDay: server.isDay ?? null, raining: server.raining ?? null, tps: server.tps ?? null } : null,
    }
  }

  private screenView(screen: ScreenState): unknown {
    const slots: SlotView[] = []
    for (const s of screen.slots ?? []) {
      if (!finite(s.slot)) continue
      const view: SlotView = { slot: s.slot }
      const item = this.itemView(s.item)
      if (item) view.item = item
      if (s.own) view.own = true
      if (s.takesNothing) view.takesNothing = true
      if (s.ghost) view.ghost = true
      slots.push(view)
    }
    const all = screen.controls
    const controls = Array.isArray(all) ? all.slice(0, CONTROLS_MAX).map((c) => controlView(c)).filter((c): c is ControlView => c !== undefined) : []
    return {
      name: screen.screen ?? '',
      slotCount: screen.slotCount ?? slots.length,
      slots,
      cursor: this.itemView(screen.cursor) ?? null,
      controls,
      ...(Array.isArray(all) && all.length > controls.length ? { controlsTotal: all.length } : {}),
    }
  }

  /** 别的玩家：和它同一个维度的按远近排在前面，带距离和方位；别的维度的排后面。 */
  private players(server: ServerInfo | undefined, self: string, status: BotStatus | undefined): unknown[] {
    const out: { name: string; isBot: boolean; dim: number | null; dist: number | null; dx?: number; dy?: number; dz?: number }[] = []
    for (const p of server?.players ?? []) {
      if (typeof p.name !== 'string' || p.name.toLowerCase() === self.toLowerCase()) continue
      const same = status?.pos !== undefined && p.pos !== undefined && p.dim !== undefined && p.dim === status.dim
      if (same) {
        const dx = p.pos!.x - status!.pos!.x
        const dy = p.pos!.y - status!.pos!.y
        const dz = p.pos!.z - status!.pos!.z
        out.push({ name: p.name, isBot: p.isBot === true, dim: p.dim ?? null, dist: Math.round(Math.hypot(dx, dy, dz) * 10) / 10, dx: Math.round(dx), dy: Math.round(dy), dz: Math.round(dz) })
      } else {
        out.push({ name: p.name, isBot: p.isBot === true, dim: p.dim ?? null, dist: null })
      }
    }
    return out.sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity) || a.name.localeCompare(b.name))
  }

  /**
   * 脚下一片地的俯视图：以它为中心、半径 radius 格的地表。每一列给“是什么方块”（调色板下标）和高度，
   * 调色板里每种方块带名字和顶面的颜色；面板自己上色、画明暗。它不在线、没连上、区块没加载时 available 是 false。
   */
  async minimap(radiusText: string | null): Promise<unknown> {
    const wanted = Number(radiusText ?? MINIMAP_DEFAULT_RADIUS)
    const radius = Number.isFinite(wanted) ? Math.max(4, Math.min(MINIMAP_MAX_RADIUS, Math.round(wanted))) : MINIMAP_DEFAULT_RADIUS
    const now = this.deps.now()
    const name = this.deps.config.get().bot.name
    const key = `${name}/${radius}`
    if (this.mapCache && this.mapCache.key === key && now - this.mapCache.at < MINIMAP_CACHE_MS) return this.mapCache.data
    const data = await this.buildMinimap(name, radius, now)
    this.mapCache = { at: now, key, data }
    return data
  }

  private async buildMinimap(name: string, radius: number, now: number): Promise<unknown> {
    const none = (reason: string): unknown => ({ time: now, available: false, reason })
    if (this.deps.bridgeStatus().state !== 'connected') return none('没连上游戏')
    let status: BotStatus
    let scan: ScanResult
    let server: ServerInfo | undefined
    try {
      status = await this.deps.bridge.botStatus(name)
      if (!status.online || !status.block) return none('它不在线')
      const { x, z } = status.block
      const dim = status.dim
      ;[scan, server] = await Promise.all([
        this.deps.bridge.worldScan({ ...(dim !== undefined ? { dim } : {}), x1: x - radius, z1: z - radius, x2: x + radius, z2: z + radius }),
        this.deps.bridge.serverInfo().catch(() => undefined),
      ])
    } catch (e) {
      return none(e instanceof Error ? e.message : String(e))
    }
    const width = scan.x2 - scan.x1 + 1
    const depth = scan.z2 - scan.z1 + 1
    if (!(width > 0 && depth > 0) || !Array.isArray(scan.heights) || scan.heights.length !== depth) return none('身体给的地表数据不对')
    const looks = this.blockLooks()
    const liquid = new Set(scan.liquidPalette ?? [])
    const palette = (scan.palette ?? []).map((id, n) => {
      const look = looks.of({ id, meta: 0 })
      return { id, name: this.deps.design.nameOf({ id, meta: 0 }) ?? null, color: look.tintTop ?? look.top, known: look.source !== 'hash', ...(liquid.has(n) ? { liquid: true } : {}) }
    })
    const heights: number[] = []
    const tops: number[] = []
    for (let z = 0; z < depth; z++) {
      const hRow = scan.heights[z] ?? []
      const tRow = scan.tops?.[z] ?? []
      for (let x = 0; x < width; x++) {
        heights.push(finite(hRow[x]) ? hRow[x]! : -1)
        tops.push(finite(tRow[x]) ? tRow[x]! : -1)
      }
    }
    const players: { name: string; x: number; z: number; isBot: boolean }[] = []
    for (const p of server?.players ?? []) {
      if (!p.pos || p.dim !== status.dim || p.name.toLowerCase() === name.toLowerCase()) continue
      if (p.pos.x < scan.x1 || p.pos.x > scan.x2 + 1 || p.pos.z < scan.z1 || p.pos.z > scan.z2 + 1) continue
      players.push({ name: p.name, x: p.pos.x, z: p.pos.z, isBot: p.isBot === true })
    }
    return {
      time: now,
      available: true,
      dim: status.dim ?? null,
      x1: scan.x1,
      z1: scan.z1,
      width,
      depth,
      palette,
      tops,
      heights,
      unloaded: scan.stats?.unloaded ?? 0,
      self: { x: status.pos?.x ?? status.block!.x + 0.5, y: status.block!.y, z: status.pos?.z ?? status.block!.z + 0.5, yaw: finite(status.yaw) ? status.yaw : null },
      players,
    }
  }
}
