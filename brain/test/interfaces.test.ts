import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { loadPackData } from '../src/packdata/index.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { ALL_TOOLS, runTool } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/types.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { tmpDir } from './helpers.ts'

const vending = 'com.cubefury.vendingmachine.integration.nei.NeiRecipeHandler'
const copper = { id: 'IC2:blockOreCopper', meta: 0 }
const machine = { id: 'gregtech:gt.blockmachines', meta: 2741 }

function setup(t: { after(fn: () => void): void }) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  fs.writeFileSync(path.join(tmp.dir, 'items.jsonl'), [
    { ...copper, name: '铜矿石', en: 'Copper Ore' }, { ...machine, name: '自动售货机', en: 'Vending Machine' },
    { id: 'dreamcraft:CoinSmith', meta: 0, name: '匠师币$1' },
    { id: 'gregtech:gt.metaitem.03', meta: 5035, name: '粗铜矿石' },
  ].map((r) => JSON.stringify(r)).join('\n'))
  fs.writeFileSync(path.join(tmp.dir, 'handlers.json'), JSON.stringify([
    { key: vending, name: '自动售货机', machines: [machine] },
    { key: 'demo.other', name: 'Other information' },
  ]))
  // The installed NEI export's shape: getOtherStacks holds this handler's goods, not its result slot.
  fs.writeFileSync(path.join(tmp.dir, 'recipes.jsonl'), [
    { h: vending, in: [{ id: 'gregtech:gt.metaitem.03', meta: 5035, n: 64 }, { id: 'dreamcraft:CoinSmith', meta: 0, n: 50 }], out: [], other: [{ ...copper, n: 64 }] },
    { h: 'demo.other', in: [], out: [], other: [{ id: 'minecraft:diamond', meta: 0, n: 1 }] },
  ].map((r) => JSON.stringify(r)).join('\n'))
  const packdata = loadPackData(tmp.dir, () => {})
  t.after(() => packdata.recipes?.close())
  const game = new FakeGame()
  game.handlers['recipe.tradeRules'] = () => ({
    source: 'installed Vending Machine TradeDatabase', scope: 'static trade rules, not current player unlocks',
    trades: [{ group: 'ccb88bf2-9868-4b3f-b8de-62b500cf79c5', cooldownSeconds: 1200, maxTrades: -1, currency: [{ type: 'smith', value: 50 }], requirements: [{ name: 'betterquesting', questId: '00000000-0000-0000-0000-000000000339' }], products: [{ ...copper, count: 64 }], inputs: [{ id: 'gregtech:gt.metaitem.03', meta: 5035, count: 64 }], nonConsumedItems: [] }],
  })
  const ctx: ToolContext = {
    botName: 'Alu', bridge: new BridgeApi(game), packdata,
    memory: new MemoryStore(tmp.dir, () => 300), manuals: new ManualStore(DEFAULT_MANUALS_DIR, `${tmp.dir}/manuals`),
    reminders: { add: (dueAt) => ({ id: 'r1', dueAt }) }, hooks: {}, now: () => 1800000000000,
  }
  return { game, packdata, run: (name: string, input: unknown = {}) => runTool(ALL_TOOLS, ctx, name, input, { maxResultChars: 20000 }) }
}

it('空手左键准备失败、0次点击：报告没点，不把缺少left标志说成旧身体右键', async (t) => {
  const s = setup(t)
  s.game.handlers['task.list'] = () => ({ active: null, queue: [], recent: [{
    id: 'f49', type: 'use', state: 'failed', params: { on: { x: 1, y: 64, z: 1 }, left: true },
    error: { code: 'inventory_full', message: 'no empty hotbar slot to click with an empty hand' },
    result: { used: 'an empty hand', clicks: 0, gained: [], lost: [], freeSlots: 9 },
  }] })
  const answer = await s.run('task_status')
  assert.match(answer.content, /no click was made \(left click requested\)/)
  assert.doesNotMatch(answer.content, /older than|RIGHT click|right-clicked/)
})

it('open_screen将物品、方块和潜行上下文一起交给身体，界面留下供点击', async (t) => {
  const s = setup(t)
  s.game.handlers['screen.open'] = () => ({ open: true, screen: 'ContainerOreFinder', slots: [{ slot: 0 }], slotCount: 37 })
  const answer = await s.run('open_screen', { item: { id: 'ifu:ifu_buildingKit' }, at: { x: 301, y: 79, z: 300 }, side: 'up', sneak: true })
  assert.match(answer.content, /ContainerOreFinder.*is open/)
  assert.deepEqual(s.game.callsOf('screen.open'), [{ bot: 'Alu', item: { id: 'ifu:ifu_buildingKit' }, x: 301, y: 79, z: 300, side: 'up', sneak: true }])
})

it('查铜商品能找到售货机成本及静态冷却条件，不把其它NEI页的other算成商品', async (t) => {
  const s = setup(t)
  const answer = await s.run('find_recipes', { ...copper, way: '自动售货机' })
  assert.equal(answer.isError, undefined, answer.content)
  assert.match(answer.content, /64× 铜矿石/)
  assert.match(answer.content, /50× 匠师币\$1/)
  assert.match(answer.content, /"cooldownSeconds":1200/)
  assert.match(answer.content, /"questId":"00000000-0000-0000-0000-000000000339"/)
  assert.match(answer.content, /not current player unlocks/)
  assert.deepEqual(s.packdata.recipes!.makesOf('minecraft:diamond', 0), [])
})

it('查售货机用途把它可做的交易另列，不把机器本身当耗材，并能筛商品', async (t) => {
  const s = setup(t)
  const summary = await s.run('find_uses', machine)
  assert.match(summary.content, /Nothing .*as an ingredient/)
  assert.match(summary.content, /As a machine \/ NEI recipe catalyst/)
  assert.equal((summary.data as any).total, 0)
  assert.equal((summary.data as any).performedBy.total, 1)
  const detail = await s.run('find_uses', { ...machine, way: '自动售货机', contains: '铜' })
  assert.match(detail.content, /64× 铜矿石/)
  assert.equal((detail.data as any).total, 0)
  assert.equal((detail.data as any).performedBy.recipes[0].out[0].count, 64)
})
