// 放方块和挖方块：意见簿 f16（楼梯朝向指定不了；拿着梯子对墙右键，结果只说“点的那一格还是混凝土”，它以为放了个空）和拍视频时的
// 工具缺口（钢管道方块铁镐、钒钢镐都“挖不了”，probe 只给 harvest:false，它查了一圈也不知道要的是扳手）。
// 这里是模拟身体（npm run mock-bridge、面板开发用的）照协议应答的那部分：probe 带 needs 和每件工具的等级，use 拿着方块点一个面时
// 报方块进的那一格、没进去的原因。真的身体怎么做的在测试服上测（test/live-place.ts）；大脑怎么说给模型听在 tools.test.ts。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import { waitFor } from './helpers.ts'
import { MockBridge } from './mock-bridge.ts'

const WRENCH = 'gregtech:gt.metatool.01'

describe('模拟身体：放方块的那一格、挖方块要什么工具', () => {
  it('probe 一格 GregTech 机器外壳：写着要 wrench 2 级，扳手挖得动、匠魂镐不是扳手；拿着楼梯点地面上表面，楼梯进的是上面那一格；那一格有东西了就写明为什么没放进去', async (t) => {
    const bridge = new MockBridge({ bots: ['Alu'] })
    await bridge.start()
    const client = new BridgeClient({ address: () => ({ host: '127.0.0.1', port: bridge.port }), token: () => bridge.token, clientName: 'brain/test', requestTimeoutMs: 2000, reconnectMinMs: 20, reconnectMaxMs: 100, resume: { load: () => undefined, save: () => {} } })
    client.start()
    t.after(async () => {
      client.stop()
      await bridge.stop()
    })
    await waitFor('connected', () => client.isConnected())
    const api = new BridgeApi(client)
    const bot = bridge.bots.get('Alu')!
    bot.inventory = [
      { slot: 0, id: 'TConstruct:pickaxe', meta: 0, count: 1, name: 'Iron Pickaxe' },
      { slot: 1, id: WRENCH, meta: 16, count: 1, name: 'Wrench' },
      { slot: 2, id: 'minecraft:spruce_stairs', meta: 0, count: 4, name: 'Spruce Wood Stairs' },
    ]
    bridge.changedBlocks.set('3,65,3', { id: 'gregtech:gt.blockcasings2', meta: 13, name: 'Steel Pipe Casing' })
    const probe = await api.botProbe('Alu', { x: 3, y: 65, z: 3 })
    assert.deepEqual(probe.needs, { tool: 'wrench', level: 2, toolRequired: true })
    assert.deepEqual(
      probe.candidates?.map((c) => [c.item, c.harvest, c.level]),
      [['hand', false, undefined], ['TConstruct:pickaxe:0', false, -1], [`${WRENCH}:16`, true, 3]],
    )
    assert.equal(probe.toolSlot, 1)

    const use = async () => {
      const started = await api.taskStart('Alu', { type: 'use', item: { id: 'minecraft:spruce_stairs' }, on: { x: 0, y: 64, z: 0 }, side: 'up' })
      const list = await api.taskList('Alu')
      return list.recent?.find((r) => r.id === started.task.id)?.result as Record<string, unknown>
    }
    const first = await use()
    assert.deepEqual([first.placeCell, first.notPlaced, first.lost], [{ x: 0, y: 65, z: 0, before: 'minecraft:air/0', now: 'minecraft:spruce_stairs/0' }, undefined, [{ id: 'minecraft:spruce_stairs', meta: 0, name: 'Spruce Wood Stairs', count: 1 }]])
    const second = await use()
    assert.deepEqual([second.placeCell, second.lost], [{ x: 0, y: 65, z: 0, before: 'minecraft:spruce_stairs/0', now: 'minecraft:spruce_stairs/0' }, []])
    assert.equal(second.notPlaced, 'the cell the block would go into, (0,65,0), is taken by minecraft:spruce_stairs/0 "Spruce Wood Stairs"')
  })
})
