// 看仓库：附近的容器一个个列（list_containers），一个抽屉管理器管着的每一格（list_drawers），
// 一片仓库合成一张存货总表（list_stock）。都只读。
// 身体一次只给一页（world.containers 的 total / offset），所以每个结果都写明“这是 N 个里的第几到第几个”，不悄悄截断。
// 带 attached 的容器（旁边接着漏斗、管道）是主人自动化的一环，结果里标出来。

import type { ContainerInfo, DrawerSlot } from '../bridge/protocol.ts'
import { attachedText, formatContainer, formatPos, itemKey, nameOf } from './format.ts'
import { int, obj, str } from './schema.ts'
import { fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'
import { AT, lookFrom } from './where.ts'
import type { At, LookFrom } from './where.ts'

export const CONTAINERS_MAX_RADIUS = 32
export const CONTAINERS_PER_PAGE = 20
export const DRAWER_SLOTS_PER_PAGE = 60
export const STOCK_LINES_PER_PAGE = 40
/** list_stock 一次最多看这么多个容器（身体一页最多给 100 个）。 */
export const STOCK_MAX_CONTAINERS = 400
const SERVER_PAGE = 100

function pages(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size))
}

export const listContainers: Tool = {
  name: 'list_containers',
  description: `Containers around you, or around a place you give ("at"), nearest first, a page at a time: position, name, kind (chest, [drawers], [drawer controller], [machine]), slots used and contents merged per item. Drawer counts are what is really stored. "AUTOMATED" marks a container with a hopper or pipe attached: it is part of your owner's automation, so ask before putting things in or taking them out.`,
  inputSchema: obj({
    radius: int('Search radius in blocks (default 16).', { min: 1, max: CONTAINERS_MAX_RADIUS }),
    page: int(`Page (${CONTAINERS_PER_PAGE} containers per page, default 1).`, { min: 1 }),
    at: AT,
  }),
  async run(ctx, input: { radius?: number; page?: number; at?: At }): Promise<ToolResult | string> {
    const radius = input.radius ?? 16
    const page = input.page ?? 1
    const offset = (page - 1) * CONTAINERS_PER_PAGE
    const from = await lookFrom(ctx, input.at)
    const res = await ctx.bridge.worldContainers(from.center, { radius, offset, limit: CONTAINERS_PER_PAGE })
    // 老的身体不认 offset / limit，一次全给：自己切一页
    const all = res.containers ?? []
    const paged = res.offset === undefined && all.length > CONTAINERS_PER_PAGE ? all.slice(offset, offset + CONTAINERS_PER_PAGE) : all
    // 一共多少个以身体说的为准（它没说时就是给回来的这些）
    const total = res.total ?? (res.offset === undefined ? all.length : offset + all.length)
    if (total === 0) return `No containers within ${radius} blocks of ${from.of}.${from.hint}`
    if (paged.length === 0) return fail(`There is no page ${page}: ${total} container(s) within ${radius} blocks, ${pages(total, CONTAINERS_PER_PAGE)} page(s).`)
    const lines = paged.map((c) => `- ${formatContainer(c, 30)}`)
    const range = total > paged.length ? `containers ${offset + 1}–${offset + paged.length} of ${total} (page ${page} of ${pages(total, CONTAINERS_PER_PAGE)}), nearest first` : `${total} container(s)`
    return { content: `Within ${radius} blocks of ${from.of}: ${range}.\n${lines.join('\n')}`, data: { total, offset, containers: paged }, keepWhole: true }
  },
}

function drawerSlotLine(s: DrawerSlot): string {
  const what = `${s.count ?? 0}× ${nameOf(s) ?? itemKey({ id: s.id ?? '?', meta: s.meta ?? 0 })} [${itemKey({ id: s.id ?? '?', meta: s.meta ?? 0 })}]`
  return `- ${formatPos(s)} slot ${s.slot}: ${what}${typeof s.room === 'number' ? `, room for ${s.room} more` : ''}`
}

export const listDrawers: Tool = {
  name: 'list_drawers',
  description:
    'Every drawer slot a Storage Drawers controller manages, with the real count in each (or the slots of one drawer block). "below" lists only slots holding fewer than that many. Each line gives the drawer block to withdraw from.',
  inputSchema: obj(
    {
      x: int('x of the drawer controller (or of a drawer block)'),
      y: int('y', { min: 0, max: 255 }),
      z: int('z'),
      below: int('Only slots that hold something but fewer than this many.', { min: 1 }),
      page: int(`Page (${DRAWER_SLOTS_PER_PAGE} slots per page, default 1).`, { min: 1 }),
    },
    ['x', 'y', 'z'],
  ),
  async run(ctx, i: { x: number; y: number; z: number; below?: number; page?: number }): Promise<ToolResult | string> {
    const page = i.page ?? 1
    const offset = (page - 1) * DRAWER_SLOTS_PER_PAGE
    const res = await ctx.bridge.worldDrawers({ x: i.x, y: i.y, z: i.z, ...(i.below !== undefined ? { below: i.below } : {}), offset, limit: DRAWER_SLOTS_PER_PAGE })
    const slots = res.slots ?? []
    const total = res.total ?? offset + slots.length
    const where = res.controller ? `The drawer controller at ${formatPos(res.controller)} manages ${res.drawers ?? '?'} drawer block(s)` : `The drawers at ${formatPos(i)}`
    const head = `${where}: ${res.slotsUsed ?? '?'} of ${res.slotsTotal ?? '?'} slots hold something.`
    const which = i.below !== undefined ? `slots holding fewer than ${i.below}` : 'slots'
    if (total === 0) return { content: `${head} No ${which}.`, data: { ...res, slots: [] } }
    if (slots.length === 0) return fail(`There is no page ${page}: ${total} ${which}, ${pages(total, DRAWER_SLOTS_PER_PAGE)} page(s).`)
    const filled = slots.filter((s) => s.empty !== true)
    const empty = slots.filter((s) => s.empty === true)
    const lines = filled.map(drawerSlotLine)
    if (empty.length > 0) lines.push(`- ${empty.length} empty slot(s) with no item set: ${empty.slice(0, 8).map((s) => `${formatPos(s)} slot ${s.slot}`).join(', ')}${empty.length > 8 ? ', …' : ''}`)
    const range = total > slots.length ? `These are ${which} ${offset + 1}–${offset + slots.length} of ${total} (page ${page} of ${pages(total, DRAWER_SLOTS_PER_PAGE)}).` : `${total} ${which}:`
    return { content: `${head} ${range}\n${lines.join('\n')}`, data: res, keepWhole: true }
  },
}

interface StockLine {
  id: string
  meta: number
  name?: string
  count: number
  /** 其中在自动化容器（接着漏斗、管道）里的。 */
  automated: number
  places: { x: number; y: number; z: number; count: number; kind?: string; automated?: boolean }[]
}

/** 把范围里的容器一页一页全读回来（到上限为止）。 */
async function allContainers(ctx: ToolContext, from: LookFrom, radius: number): Promise<{ containers: ContainerInfo[]; total: number }> {
  const containers: ContainerInfo[] = []
  let total = 0
  for (let offset = 0; offset < STOCK_MAX_CONTAINERS; ) {
    const res = await ctx.bridge.worldContainers(from.center, { radius, offset, limit: SERVER_PAGE })
    const got = res.containers ?? []
    total = res.total ?? offset + got.length
    containers.push(...got)
    // 老的身体一次全给（没有 offset）：这就是全部了
    if (got.length === 0 || res.offset === undefined || offset + got.length >= total) break
    offset += got.length
  }
  return { containers, total }
}

export const listStock: Tool = {
  name: 'list_stock',
  description: `Everything stored around you, or around a place you give ("at"), as one table: each item with its total and where most of it is, summed over all chests and drawers within the radius, most first. Filter with "contains" (a word of the name or id) and "below" (items you have fewer than that of). Machines and drawer controllers are not counted; what sits in automated containers is marked.`,
  inputSchema: obj({
    radius: int('Search radius in blocks (default 16).', { min: 1, max: CONTAINERS_MAX_RADIUS }),
    contains: str('Only items whose name or id contains this.', { maxLength: 60 }),
    below: int('Only items whose total is below this.', { min: 1 }),
    page: int(`Page (${STOCK_LINES_PER_PAGE} items per page, default 1).`, { min: 1 }),
    at: AT,
  }),
  async run(ctx, i: { radius?: number; contains?: string; below?: number; page?: number; at?: At }): Promise<ToolResult | string> {
    const radius = i.radius ?? 16
    const from = await lookFrom(ctx, i.at)
    const { containers, total } = await allContainers(ctx, from, radius)
    if (total === 0) return `No containers within ${radius} blocks of ${from.of}.${from.hint}`
    const storage = containers.filter((c) => c.kind !== 'machine' && c.kind !== 'drawer_controller')
    const merged = new Map<string, StockLine>()
    let truncated = 0
    for (const c of storage) {
      if ((c.moreKinds ?? 0) > 0) truncated++
      const automated = (c.attached?.length ?? 0) > 0
      for (const it of c.items ?? []) {
        if (!it || typeof it.id !== 'string') continue
        const key = itemKey(it)
        let line = merged.get(key)
        if (!line) merged.set(key, (line = { id: it.id, meta: it.meta ?? 0, count: 0, automated: 0, places: [], ...(it.name ? { name: it.name } : {}) }))
        const n = typeof it.count === 'number' ? it.count : 1
        line.count += n
        if (automated) line.automated += n
        line.places.push({ x: c.x, y: c.y, z: c.z, count: n, ...(c.kind ? { kind: c.kind } : {}), ...(automated ? { automated: true } : {}) })
      }
    }
    let list = [...merged.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
    const kinds = list.length
    const word = i.contains?.trim().toLowerCase()
    if (word) list = list.filter((l) => `${nameOf(l) ?? ''}\n${l.name ?? ''}\n${itemKey(l)}`.toLowerCase().includes(word))
    if (i.below !== undefined) list = list.filter((l) => l.count < i.below!)
    const skipped = containers.length - storage.length
    const notes = [
      `Looked into ${storage.length} chest(s) and drawer(s) within ${radius} blocks of ${from.of}${skipped > 0 ? ` (${skipped} machine(s) and drawer controller(s) not counted)` : ''}: ${kinds} kind(s) of item.`,
      ...(total > containers.length ? [`Only the nearest ${containers.length} of ${total} containers were read: the totals are not complete. Use a smaller radius.`] : []),
      ...(truncated > 0 ? [`${truncated} container(s) hold more kinds than the server lists (60 each): their rarer items are missing here. Use find_in_storage for a particular item.`] : []),
    ]
    const filter = [word ? `containing "${i.contains!.trim()}"` : '', i.below !== undefined ? `with fewer than ${i.below}` : ''].filter(Boolean).join(' and ')
    if (list.length === 0) return { content: `${notes.join(' ')} None ${filter || 'at all'}.`, data: { items: [] } }
    const page = i.page ?? 1
    const offset = (page - 1) * STOCK_LINES_PER_PAGE
    const shown = list.slice(offset, offset + STOCK_LINES_PER_PAGE)
    if (shown.length === 0) return fail(`There is no page ${page}: ${list.length} item(s)${filter ? ` ${filter}` : ''}, ${pages(list.length, STOCK_LINES_PER_PAGE)} page(s).`)
    const lines = shown.map((l) => {
      const places = [...l.places].sort((a, b) => b.count - a.count)
      const where = places.slice(0, 2).map((p) => `${formatPos(p)}${p.kind === 'drawers' ? ' drawers' : ''}${p.automated ? ' AUTOMATED' : ''} ${p.count}`)
      const name = nameOf(l)
      return `- ${l.count}× ${name ? `${name} ` : ''}[${itemKey(l)}]: ${where.join(', ')}${places.length > 2 ? `, and ${places.length - 2} more place(s)` : ''}${l.automated > 0 ? ` (${l.automated} of them in automated containers)` : ''}`
    })
    const range = list.length > shown.length ? `Items ${offset + 1}–${offset + shown.length} of ${list.length}${filter ? ` ${filter}` : ''} (page ${page} of ${pages(list.length, STOCK_LINES_PER_PAGE)}), most first:` : `${list.length} item(s)${filter ? ` ${filter}` : ''}, most first:`
    return { content: `${notes.join(' ')} ${range}\n${lines.join('\n')}`, data: { items: list }, keepWhole: true }
  },
}

/** 容器这一行里“自动化的一环”的提醒，给别的工具（存取任务的失败说明）用。 */
export function automationNote(c: Pick<ContainerInfo, 'attached'>): string {
  return attachedText(c.attached)
}
