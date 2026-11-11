// 图纸：身体能照 Schematica 的 .schematic 文件盖建筑框体。这里是看有哪些图纸、动手前的对比、启动建造任务三个工具。
// 发给模型的只有 build_blueprint：列图纸并进了 list_designs（design.ts），check_blueprint 是库函数（程序里调；模型直接调也照常执行）。

import type { BlueprintEntry, BlueprintPlacement } from '../bridge/protocol.ts'
import { compactJson, formatBlueprintCheck, formatBlueprintList } from './format.ts'
import { arr, int, obj, str } from './schema.ts'
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
  return { text: formatBlueprintList(blueprints, res.folder), blueprints }
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
