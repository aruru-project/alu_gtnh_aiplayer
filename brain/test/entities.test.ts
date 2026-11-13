import assert from 'node:assert/strict'
import { it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import { ALL_TOOLS, runTool } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/types.ts'
import { FakeGame, makeAgent, modelCalls } from './agent-harness.ts'
import { tmpDir } from './helpers.ts'
import { DesignWorkspace } from '../src/design/index.ts'

const sheep = { uuid: 'da6c52a9-2c12-4db4-b04f-11db07b1dc20', dim: 0, type: 'animal', kind: 'Sheep', name: 'Sheep', pos: { x: -621.125, y: 69, z: 26.3125 }, state: { woolColor: 'red', woolMeta: 14, sheared: false, child: false, health: 8 } }
function setup() {
  const game = new FakeGame()
  const ctx = { botName: 'Alu', bridge: new BridgeApi(game), hooks: {}, now: () => 1800000000000 } as ToolContext
  const run = (name: string, input: unknown = {}) => runTool(ALL_TOOLS, ctx, name, input)
  return { game, run }
}

it('f30：程序查实体得到精确位置、稳定身份与羊毛状态，再用这只实体右键剪毛或左键攻击', async (t) => {
  const tmp = tmpDir()
  const h = makeAgent({ dir: tmp.dir, design: new DesignWorkspace({ dataDir: tmp.dir }) })
  t.after(async () => { await h.agent.stop(); tmp.cleanup() })
  const game = h.game
  const run = (name: string, input: unknown) => modelCalls(h, name, input)
  game.handlers['world.entities'] = () => ({ entities: [sheep], total: 21, offset: 20, more: 0 })
  const observed = await run('run_program', { code: 'const r = await tool("list_entities", {radius:64,page:2}); return JSON.stringify(r.data);' })
  assert.notEqual(observed.isError, true, observed.content)
  assert.match(observed.content, /da6c52a9-2c12-4db4-b04f-11db07b1dc20/)
  assert.match(observed.content, /-621\.125/)
  assert.match(observed.content, /"sheared":false/)
  assert.deepEqual(game.callsOf('world.entities'), [{ bot: 'Alu', radius: 64, offset: 20, limit: 20 }])
  const entity = { uuid: sheep.uuid, dim: 0 }
  assert.notEqual((await run('use_item', { id: 'minecraft:shears', entity })).isError, true)
  assert.notEqual((await run('use_item', { entity, left: true, times: 2, every: 20 })).isError, true)
  assert.deepEqual(game.callsOf('task.start').map((p) => p.task), [
    { type: 'use', item: { id: 'minecraft:shears' }, entity },
    { type: 'use', entity, left: true, times: 2, every: 20 },
  ])
})

it('实体列表翻页不隐藏剩余实体，单体精查保留状态并如实报告已消失', async () => {
  const { game, run } = setup()
  game.handlers['world.entities'] = () => ({ entities: [sheep], total: 81, offset: 0, more: 80 })
  const listed = await run('list_entities', { radius: 64 })
  assert.match(listed.content, /80 more \(page 2 next\)/)
  assert.match(listed.content, /"woolColor":"red"/)
  game.handlers['world.entity'] = () => ({ ...sheep, saved: { Sheared: 0, Color: 14 } })
  const detail = await run('list_entities', { entity: { uuid: sheep.uuid, dim: 0 }, detail: true, path: 'Color' })
  assert.match(detail.content, /"Color":14/)
  assert.deepEqual(game.callsOf('world.entity'), [{ uuid: sheep.uuid, dim: 0, detail: true, path: 'Color' }])
  game.handlers['world.entity'] = () => { throw new BridgeError('not_found', 'target no longer loaded/alive') }
  const missing = await run('list_entities', { entity: { uuid: sheep.uuid, dim: 0 } })
  assert.equal(missing.isError, true)
  assert.match(missing.content, /no longer loaded\/alive/)
})

it('实体动作的结果展示全部羊毛状态、掉落与伤害；失败后保留已尝试的次数，不把发包叫做剪毛成功', async () => {
  const { game, run } = setup()
  const entity = { uuid: sheep.uuid, dim: 0 }
  game.handlers['task.list'] = () => ({ recent: [{
    id: 't1', type: 'use', state: 'failed', params: { entity, left: true },
    error: { code: 'not_found', message: 'target disappeared before next click' },
    result: {
      clicks: 1, entityEvents: 1, left: true, used: 'an empty hand',
      entityBefore: sheep, entityNow: { ...sheep, state: { ...sheep.state, health: 7, sheared: true } },
      newNearbyDrops: [{ type: 'item', pos: sheep.pos, item: { id: 'minecraft:wool', meta: 14, count: 3 } }],
    },
  }] })
  const result = await run('task_status')
  assert.match(result.content, /failed.*not_found/s)
  assert.match(result.content, /1 attempt\(s\), 1 normal game event\(s\)/)
  assert.match(result.content, /"health":7/)
  assert.match(result.content, /"sheared":true/)
  assert.match(result.content, /"id":"minecraft:wool","meta":14,"count":3/)
  assert.match(result.content, /not proof of its intended effect/)
})
