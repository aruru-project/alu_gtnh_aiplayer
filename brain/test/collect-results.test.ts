import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeEvent } from '../src/agent/events.ts'
import type { TaskInfo } from '../src/bridge/protocol.ts'
import { formatTask } from '../src/tools/format.ts'

describe('捡物结束后查剩余物品', () => {
  for (const state of ['done', 'failed'] as const) {
    for (const terrain of [false, true]) {
      it(`${state}${terrain ? '且改过地形' : ''}：任务状态和结束通知都列全最后一堆的位置、数量和完整原因`, () => {
        // Body data only; no fake implementation of navigation or collection. The list exceeds both old JSON caps.
        const remaining = [
          ...Array.from({ length: 14 }, (_, i) => ({
            entityId: 700 + i, id: 'minecraft:clay_ball', meta: 0, count: i + 1,
            x: -448.5 - i, y: 60.78, z: 111.25 + i,
            reason: `unreachable: item ${i} has no route through the water without changing the lake bed`,
          })),
          { entityId: 799, id: 'minecraft:dye', meta: 4, count: 17, x: -470.5, y: 59.78, z: 132.25,
            reason: 'in pickup range but not picked up (delay, owner or server rules); the last stack is still here' },
        ]
        const task: TaskInfo = {
          id: 'collect-long', type: 'collect', state,
          ...(state === 'failed' ? { error: { code: 'unreachable', message: 'items remain; see their positions and reasons' } } : {}),
          result: {
            pickedUpStacks: 3, disappearedTargets: 2, remaining,
            ...(terrain ? {
              dugOnTheWay: [{ x: -450, y: 59, z: 112, id: 'minecraft:dirt' }],
              climbingBlocks: [{ x: -451, y: 62, z: 113, id: 'minecraft:cobblestone', standing: true }],
              climbingBlocksStanding: 1,
            } : {}),
          },
        }
        for (const text of [formatTask(task), describeEvent({ type: 'task_ended', time: 1, task })]) {
          // Same public entry points used by task_status/routines and the notification waking the model.
          assert.ok(text.includes('(-470.5,59.78,132.25)'), 'the last remaining item must not disappear behind the compact JSON limit')
          assert.match(text, /17× minecraft:dye\/4[^\n;]* at \(-470\.5,59\.78,132\.25\)/)
          assert.match(text, /pickedUpStacks 3/)
          assert.match(text, /disappearedTargets 2/)
          for (const item of remaining) {
            assert.ok(text.includes(`(${item.x},${item.y},${item.z})`), `missing position of entity ${item.entityId}`)
            assert.ok(text.includes(item.reason), `missing full reason of entity ${item.entityId}`)
            assert.equal(text.split(item.reason).length - 1, 1, 'a remaining item must not be repeated by terrain handling')
          }
          if (state === 'failed') assert.ok(text.includes('unreachable'))
          if (terrain) {
            assert.ok(text.includes('dug out of the way: (-450,59,112) minecraft:dirt'))
            assert.ok(text.includes('climbing blocks put down on the way: 1, still standing 1: (-451,62,113) minecraft:cobblestone'))
            assert.equal(text.split('dug out of the way:').length - 1, 1)
            assert.equal(text.split('climbing blocks put down on the way:').length - 1, 1)
          }
          assert.doesNotMatch(text, /"remaining"|"dugOnTheWay"|"climbingBlocks"|…/)
        }
      })
    }
  }
})
