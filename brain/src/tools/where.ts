// “看周围”的工具（look_around、find_blocks、list_containers、list_stock、find_in_storage、find_machines）共用的中心点：
// 默认以它自己为中心；给了 at 就以那个地方为中心。主人说的是某个地方的东西（他的箱子、抽屉管理器、某台机器）时，
// 应该以那个地方为中心看，而不是以自己为中心——它站在五十格外时，以自己为中心什么也看不到。

import type { Center } from '../bridge/protocol.ts'
import { formatPos } from './format.ts'
import { obj } from './schema.ts'
import type { ToolContext } from './types.ts'

export interface At {
  x: number
  y: number
  z: number
}

// 好几个工具都带着它，每轮都发给模型：说明尽量短，x、y、z 不另写说明。
// 以自己为中心什么都没找到时，结果里另有一句提醒（ELSEWHERE_HINT），所以这里不用多说。
export const AT = obj(
  { x: { type: 'integer' }, y: { type: 'integer', minimum: 0, maximum: 255 }, z: { type: 'integer' } },
  ['x', 'y', 'z'],
  'Look around this place instead of yourself: where your owner stands, a chest or machine they mean.',
)

export interface LookFrom {
  center: Center
  /** 结果里“within N blocks of …”的那半句：you，或者那个地方的坐标。 */
  of: string
  /** 以自己为中心、什么都没找到时附上的提醒；给了 at 的不用。 */
  hint: string
}

export const ELSEWHERE_HINT = ' If it is at some other place (where your owner is, or a position they named), look around that place: give "at".'

/** 给了 at 时以它为中心（在它自己所在的那个维度里），否则以它自己为中心。 */
export async function lookFrom(ctx: ToolContext, at: At | undefined): Promise<LookFrom> {
  if (!at) return { center: { bot: ctx.botName }, of: 'you', hint: ELSEWHERE_HINT }
  // 坐标本身不带维度：不说的话身体当成主世界，所以把它现在所在的维度带上
  const status = await ctx.bridge.botStatus(ctx.botName)
  return { center: { x: at.x, y: at.y, z: at.z, ...(status.dim !== undefined ? { dim: status.dim } : {}) }, of: formatPos(at), hint: '' }
}
