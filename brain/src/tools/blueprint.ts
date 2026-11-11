// 图纸：身体能照 Schematica 的 .schematic 文件盖建筑框体。这里是看有哪些图纸、动手前的对比、启动建造任务三个工具。
// 发给模型的只有 build_blueprint：列图纸并进了 list_designs（design.ts），check_blueprint 是库函数（程序里调；模型直接调也照常执行）。

import type { BlueprintEntry, BlueprintPlacement } from '../bridge/protocol.ts'
import { compactJson, formatBlueprintCheck, formatBlueprintList } from './format.ts'
import { arr, int, obj, str } from './schema.ts'
import { containerList, overflow, queue, startTask } from './tasks.ts'
import { fail } from './types.ts'
import type { Tool, ToolContext, ToolResult } from './types.ts'

/** blueprint.check 和 blueprint 任务共用的参数：图纸放在哪、只处理哪一部分、哪些方块管不管、允许挖什么。 */
const placementProps = {
  name: str('Blueprint name as list_designs shows it (the file name without ".schematic").', { maxLength: 80 }),
  x: int('World x where the lowest corner of the blueprint (its smallest x, y and z) goes.'),
  y: int('World y of that corner.', { min: 0, max: 255 }),
  z: int('World z of that corner.'),
  x1: int('Handle only world x from x1 to x2. Give both or neither.'),
  x2: int('See x1.'),
  y1: int('Handle only world y (layers) from y1 to y2. Give both or neither.', { min: 0, max: 255 }),
  y2: int('See y1.', { min: 0, max: 255 }),
  z1: int('Handle only world z from z1 to z2. Give both or neither.'),
  z2: int('See z1.'),
  only: arr(
    'Handle only these kinds of blueprint block (block ids). Spots the blueprint leaves empty are then ignored.',
    str('block id'),
    { max: 64 },
  ),
  skip: arr('Leave out these kinds of blueprint block (block ids).', str('block id'), { max: 64 }),
  clear: arr(
    'What may be dug out when it is in the way: block ids, and two words that stand for groups: "natural" (plain terrain: dirt, grass, sand, gravel, snow, leaves) and "plants" (everything that grows: flowers, bushes, leaves, crops). Omit to dig nothing at all. Blocks that hold data (chests, machines), liquids and bedrock are never dug.',
    str('block id, "natural" or "plants"'),
    { max: 64 },
  ),
}
const placementRequired = ['name', 'x', 'y', 'z']

/**
 * 模型把“不限制”写成空列表时，当作没给：身体那边 only: [] 的意思是“哪种方块都不管”，不是模型想要的。
 */
function withoutEmptyLists<T extends BlueprintPlacement>(input: T): T {
  const out = { ...input }
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
  brief: '{name, x, y, z, ...}: the world against a blueprint -> done, toPlace, byHand, materials[]',
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
    'Build what a blueprint draws (task): digs out what "clear" allows, then places the blueprint blocks from the bottom up, fetching material from "supply". Only plain building blocks are placed; blocks with contents or a facing are left for a player. At most 64×64 columns per task: split a bigger one with x1..z2 and queue the parts. What it would place, dig and leave is shown beforehand by check_blueprint with the same arguments (a library function: see run_program); details in the blueprint manual.',
  inputSchema: obj(
    {
      ...placementProps,
      supply: containerList('Containers (chests or drawers) to fetch building blocks from when you run out.'),
      dropoff: containerList('Containers to unload what you dug out into when the inventory fills up. Building blocks stay with you.'),
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
