// 图纸：身体能照 Schematica 的 .schematic 文件盖建筑框体。这里是看有哪些图纸、动手前的对比、启动建造任务三个工具。
// 发给模型的只有 build_blueprint：列图纸并进了 list_designs（design.ts），check_blueprint 是库函数（程序里调；模型直接调也照常执行）。

import type { BlueprintEntry, BlueprintKind, BlueprintPlacement } from '../bridge/protocol.ts'
import { blockCount, materialsOf } from '../design/index.ts'
import { compactJson, formatBlueprintCheck, formatBlueprintList, itemKey, nameOf } from './format.ts'
import { arr, bool, int, obj, pos, str } from './schema.ts'
import { dropoff, overflow, queue, startTask, supply } from './tasks.ts'
import { fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

/** blueprint.check 和 blueprint 任务共用的参数：图纸放在哪、只处理哪一部分、哪些方块管不管、允许挖什么。 */
const placementProps = {
  name: str('Blueprint name, as list_designs shows it.', { maxLength: 80 }),
  x: int('World x, y, z where the lowest corner of the blueprint (its smallest x, y and z) goes.'),
  y: int(undefined, { min: 0, max: 255 }),
  z: int(),
  x1: int('x1..x2, y1..y2 (layers), z1..z2: handle only this part, in world coordinates. Give both ends of a pair.'),
  x2: int(),
  y1: int(undefined, { min: 0, max: 255 }),
  y2: int(undefined, { min: 0, max: 255 }),
  z1: int(),
  z2: int(),
  only: arr('Handle only these blueprint blocks (block ids); spots the blueprint leaves empty are then ignored.', str(), { max: 64 }),
  skip: arr('Leave out these blueprint blocks (block ids).', str(), { max: 64 }),
  clear: arr(
    'What may be dug out when in the way: block ids, "natural" (plain terrain: dirt, grass, sand, gravel, snow, leaves), "plants" (whatever grows). Default: nothing is dug. Chests, machines, liquids and bedrock are never dug.',
    str(),
    { max: 64 },
  ),
}
const placementRequired = ['name', 'x', 'y', 'z']

/**
 * 模型把“不限制”写成空列表时，当作没给：身体那边 only: [] 的意思是“哪种方块都不管”，不是模型想要的。
 * 名字后面带着 ".schematic" 的（照文件名写的）去掉后缀：图纸的名字是不带后缀的。
 */
function withoutEmptyLists<T extends BlueprintPlacement>(input: T): T {
  const out = { ...input }
  if (typeof out.name === 'string') out.name = out.name.trim().replace(/\.schematic$/i, '')
  for (const key of ['only', 'skip', 'clear'] as const) {
    if (out[key]?.length === 0) delete out[key]
  }
  return out
}

/** 服务器上的图纸：给模型看的那段文字，和给程序用的列表（list_designs 和旧名字 list_blueprints 共用）。 */
export async function blueprintListing(ctx: ToolContext): Promise<{ text: string; blueprints: BlueprintEntry[] }> {
  const res = await ctx.bridge.blueprintList()
  const blueprints = res.blueprints ?? []
  // 这里只有名字、尺寸、总数：里面有什么（材料表、每一格）指到 read_blueprint
  const pointer = blueprints.length > 0 ? '\nWhat is in one (its materials, its cells): the library function read_blueprint.' : ''
  return { text: `${formatBlueprintList(blueprints, res.folder)}${pointer}`, blueprints }
}

/** 旧名字：不在发给模型的清单里（并进了 list_designs），程序里、旧笔记里调到它照常执行。 */
export const listBlueprints: Tool = {
  name: 'list_blueprints',
  description:
    'List the blueprints (Schematica .schematic files) on the server that you can build from: name, size and number of blocks. Files that cannot be read are listed with the reason.',
  inputSchema: obj({}),
  async run(ctx): Promise<ToolResult> {
    const listing = await blueprintListing(ctx)
    return { content: listing.text, data: { blueprints: listing.blueprints } }
  },
}

// ── 图纸里有什么（read_blueprint）──

/** 一次最多读这么多格（身体 blueprint.read 的上限；草稿照同一个数）。 */
export const BLUEPRINT_READ_MAX_CELLS = 262_144
const MATERIALS_SHOWN = 40

interface Corner {
  x: number
  y: number
  z: number
}

/** read_blueprint 给程序的 data：服务器上的图纸和它自己的草稿是同一个形状。 */
export interface BlueprintData {
  name: string
  /** 读的是哪一份：服务器上的图纸，还是大脑这边的草稿。 */
  source: 'server' | 'draft'
  size: Corner
  blocks: number
  /** 整张图纸的材料，多的在前。byHand：身体不放、得由人放的原因（草稿没有这一项：发布以后才知道）。 */
  materials: { id: string; meta: number; name?: string; count: number; item?: { id: string; meta?: number }; byHand?: string }[]
  /** 下面是 from..to 这个盒子里的格子（没读格子时没有）：盒子从图纸里的 (x, y, z) 起，palette[cells[(dy * sz + dz) * sx + dx]] 是那一格，palette[0] 是空。 */
  x?: number
  y?: number
  z?: number
  sx?: number
  sy?: number
  sz?: number
  palette?: { id: string; meta: number; name?: string }[]
  cells?: number[]
}

const kindName = (k: { id: string; meta?: number; name?: string }): string | undefined => nameOf({ id: k.id, meta: k.meta ?? 0, name: k.name })

function materialLine(m: BlueprintData['materials'][number]): string {
  const name = kindName(m)
  const placed = m.item ? ` (placed with ${kindName(m.item) ? `${kindName(m.item)} ` : ''}[${itemKey({ id: m.item.id, meta: m.item.meta ?? 0 })}])` : ''
  return `- ${m.count}× ${name ? `${name} ` : ''}[${itemKey(m)}]${placed}${m.byHand ? ` — a player has to place it: ${m.byHand}` : ''}`
}

/** “下标, 连续几格”的序列展开成每格一个下标。 */
function expandRuns(runs: readonly number[], total: number): number[] {
  const cells = new Array<number>(total).fill(0)
  let at = 0
  for (let i = 0; i + 1 < runs.length && at < total; i += 2) {
    const count = Math.min(runs[i + 1]!, total - at)
    if (runs[i] !== 0) cells.fill(runs[i]!, at, at + count)
    at += count
  }
  return cells
}

/**
 * 一张图纸里有什么（read_blueprint 的 data）：服务器上的图纸问身体，草稿读大脑这边存的。出不了时返回一个出错的结果。
 * cells: false 只要尺寸和材料表（面板的图纸页用）。身体那边的错（没有这张图纸、from/to 不对）照常抛出。
 */
export async function blueprintData(src: { bridge: ToolContext['bridge']; design?: ToolContext['design'] }, i: { name: string; draft?: boolean; from?: Corner; to?: Corner; cells?: boolean }): Promise<BlueprintData | ToolResult> {
  const name = i.name.trim().replace(/\.schematic$/i, '')
  const part = i.from !== undefined || i.to !== undefined
  let data: BlueprintData
  if (i.draft === true) {
    if (!src.design) return fail('Writing programs and drafts is not set up on this brain.')
    const record = src.design.drafts.get(name)
    if (!record) return fail(`There is no draft named "${name}". list_designs shows the ones there are.`)
    const { draft } = record
    const design = src.design
    data = { name: draft.name, source: 'draft', size: draft.size, blocks: blockCount(draft), materials: materialsOf(draft).map((m) => ({ id: m.id, meta: m.meta, ...(design.nameOf(m) ? { name: design.nameOf(m)! } : {}), count: m.count })) }
    const from = i.from ?? { x: 0, y: 0, z: 0 }
    const to = { x: Math.min(i.to?.x ?? draft.size.x - 1, draft.size.x - 1), y: Math.min(i.to?.y ?? draft.size.y - 1, draft.size.y - 1), z: Math.min(i.to?.z ?? draft.size.z - 1, draft.size.z - 1) }
    if (from.x < 0 || from.y < 0 || from.z < 0 || to.x < from.x || to.y < from.y || to.z < from.z) {
      return fail(`"from" and "to" are positions inside the draft, counted from 0 at its lowest corner; it is ${draft.size.x}×${draft.size.y}×${draft.size.z} (x × y × z).`)
    }
    const [sx, sy, sz] = [to.x - from.x + 1, to.y - from.y + 1, to.z - from.z + 1]
    if (i.cells === false) {
      /* 只要材料表 */
    } else if (sx * sy * sz <= BLUEPRINT_READ_MAX_CELLS) {
      const cells: number[] = []
      for (let y = from.y; y <= to.y; y++) for (let z = from.z; z <= to.z; z++) for (let x = from.x; x <= to.x; x++) cells.push(draft.cells[x + (y * draft.size.z + z) * draft.size.x]!)
      Object.assign(data, { x: from.x, y: from.y, z: from.z, sx, sy, sz, palette: [{ id: 'minecraft:air', meta: 0 }, ...draft.kinds.map((k) => ({ id: k.id, meta: k.meta, ...(design.nameOf(k) ? { name: design.nameOf(k)! } : {}) }))], cells })
    } else if (part) {
      return fail(`That part is ${sx * sy * sz} cells; one read gives at most ${BLUEPRINT_READ_MAX_CELLS}. Give a smaller "from".."to".`)
    }
  } else {
    // 先只要材料表和尺寸；整张图纸放得进一次读取（或者指定了一部分）再要格子
    const head = await src.bridge.blueprintRead({ name, cells: false })
    const size = head.size ?? { x: 0, y: 0, z: 0 }
    const kindOf = (k: BlueprintKind) => ({ id: k.id, meta: k.meta ?? 0, ...(k.name !== undefined ? { name: k.name } : {}) })
    data = {
      name: head.name ?? name,
      source: 'server',
      size,
      blocks: head.blocks ?? 0,
      materials: (head.materials ?? []).map((m) => ({ ...kindOf(m), count: m.count ?? 0, ...(m.item ? { item: m.item } : {}), ...(m.byHand !== undefined ? { byHand: m.byHand } : {}) })),
    }
    if (i.cells !== false && (part || size.x * size.y * size.z <= BLUEPRINT_READ_MAX_CELLS)) {
      // 超过一次能读的、from/to 写得不对：身体的原话会说清楚（照常以出错的结果回给它）
      const body = await src.bridge.blueprintRead({ name, ...(i.from ? { from: i.from } : {}), ...(i.to ? { to: i.to } : {}) })
      const [sx, sy, sz] = [body.sx ?? 0, body.sy ?? 0, body.sz ?? 0]
      Object.assign(data, { x: body.x ?? 0, y: body.y ?? 0, z: body.z ?? 0, sx, sy, sz, palette: (body.palette ?? []).map(kindOf), cells: expandRuns(body.runs ?? [], sx * sy * sz) })
    }
  }
  return data
}

export const readBlueprint: Tool = {
  name: 'read_blueprint',
  brief: '{name, draft?, from?, to?}: what a blueprint (or your draft) holds -> size, materials[{id, meta, name, count, byHand}], palette[], cells[]',
  description:
    'What a blueprint holds, whatever the world looks like: its size, every kind of block in it with its count (and which kinds a player has to place by hand), and its cells. "name" is a blueprint on the server, or with "draft": true one of your drafts. In a program: data is { name, source, size, blocks, materials, x, y, z, sx, sy, sz, palette, cells }, where cells[(dy * sz + dz) * sx + dx] is an index into palette (palette[0] is air) for the box that starts at (x, y, z) inside the blueprint. One read gives at most 262144 cells: a bigger blueprint comes without cells unless "from" and "to" pick a part.',
  inputSchema: obj(
    {
      name: str('Blueprint name, as list_designs shows it.', { maxLength: 80 }),
      draft: bool('true: read your draft of this name instead of the blueprint on the server.'),
      from: pos('Cells of only this part: one corner inside the blueprint, counted from 0 at its lowest corner.'),
      to: pos('The opposite corner (included).'),
    },
    ['name'],
  ),
  async run(ctx, i: { name: string; draft?: boolean; from?: Corner; to?: Corner }): Promise<ToolResult> {
    const part = i.from !== undefined || i.to !== undefined
    const data = await blueprintData(ctx, i)
    if ('content' in data) return data
    const { size } = data
    const byHand = data.materials.filter((m) => m.byHand !== undefined).reduce((n, m) => n + m.count, 0)
    const lines = [
      `${data.source === 'draft' ? 'Draft' : 'Blueprint'} "${data.name}"${data.source === 'draft' ? ' (on the brain, not published)' : ' (on the server)'}: ${size.x}×${size.y}×${size.z} (x × y × z), ${data.blocks} block(s) of ${data.materials.length} kind(s)${byHand > 0 ? `, ${byHand} of them for a player to place by hand` : ''}.`,
      'Materials, for the whole of it:',
      ...data.materials.slice(0, MATERIALS_SHOWN).map(materialLine),
      ...(data.materials.length > MATERIALS_SHOWN ? [`- … and ${data.materials.length - MATERIALS_SHOWN} more kinds (${data.materials.slice(MATERIALS_SHOWN).reduce((n, m) => n + m.count, 0)} blocks): every kind is in the result data (data.materials)`] : []),
      ...(data.source === 'draft' ? ['Which kinds the body cannot place by itself is known once the draft is published (check_blueprint, or read_blueprint without "draft").'] : []),
      data.cells
        ? `Its cells${part ? ` from (${data.x},${data.y},${data.z}), ${data.sx}×${data.sy}×${data.sz}` : ''} are in the result data, for a program (data.palette, data.cells).`
        : `It has ${size.x * size.y * size.z} cells, more than one read gives (${BLUEPRINT_READ_MAX_CELLS}), so no cells came with this: give "from" and "to" (corners inside the blueprint, counted from 0) to read them a part at a time, for instance a few layers.`,
    ]
    return { content: lines.join('\n'), data, keepWhole: true }
  },
}

export const checkBlueprint: Tool = {
  name: 'check_blueprint',
  brief: '{name, x, y, z, ...as build_blueprint}: the world against a blueprint, nothing changed -> done, toPlace, byHand, blocked, materials[]',
  description:
    'Compare the world with a blueprint set down at x, y, z, changing nothing: what is already in place, the materials needed and how many you carry, what a player must place by hand, and what is in the way. Run it before build_blueprint with the same arguments.',
  inputSchema: obj(placementProps, placementRequired),
  async run(ctx, i: BlueprintPlacement) {
    // 带上 bot：用它所在的维度，materials 里有它身上的数量
    const placement = withoutEmptyLists(i)
    const res = await ctx.bridge.blueprintCheck({ ...placement, bot: ctx.botName })
    if (typeof res.cells !== 'number') return fail(`unexpected blueprint.check result: ${compactJson(res)}`)
    // data：身体的原样回答（blueprint.check），给程序用
    return { content: formatBlueprintCheck(res, { clearGiven: placement.clear !== undefined }), data: res }
  },
}

export const buildBlueprint: Tool = {
  name: 'build_blueprint',
  description:
    'Build what a blueprint draws (task): digs out what "clear" allows, then places the blueprint blocks from the bottom up, taking them from your inventory and "supply". At most 64×64 columns per task (x1..z2 take a part). check_blueprint, a library function, takes the same arguments and shows beforehand what would be placed, dug and left. Details: blueprint manual.',
  inputSchema: obj(
    {
      ...placementProps,
      supply: supply('building blocks'),
      dropoff,
      overflow,
      queue,
    },
    placementRequired,
  ),
  async run(ctx, i: BlueprintPlacement & { supply?: unknown[]; dropoff?: unknown[]; overflow?: string; queue?: boolean }) {
    // 范围成不成对、超没超 64×64 都由身体判断（它才知道图纸多大），它的原话会原样回给模型
    const { queue: q, ...params } = withoutEmptyLists(i)
    return startTask(ctx, { type: 'blueprint', ...params }, q)
  },
}
