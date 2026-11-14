// Brain-facing regressions for f26/f27/f29. The bridge is the only mocked boundary;
// live-fluid-machine.ts verifies native container transfer, process state and GT calculation on the real body.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { loadPackData } from '../src/packdata/index.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { processResultLines } from '../src/tools/format.ts'
import { ALL_TOOLS, runTool } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/index.ts'
import { DEFAULT_MANUALS_DIR, FakeGame } from './agent-harness.ts'
import { tmpDir } from './helpers.ts'

const GT = 'gregtech:gt.metaitem.01'
const machine = { x: -525, y: 70, z: 41 }
function setup(t: { after(fn: () => void): void }) {
  const tmp = tmpDir()
  fs.writeFileSync(path.join(tmp.dir, 'handlers.json'), JSON.stringify([{ key: 'gt.recipe.fluidsolidifier', name: 'Fluid Solidifier', read: 'gregtech', mod: 'GregTech', machines: [] }]))
  fs.writeFileSync(path.join(tmp.dir, 'recipes.jsonl'), JSON.stringify({ h: 'gt.recipe.fluidsolidifier', in: [{ id: GT, meta: 32301, n: 0 }], fin: [{ f: 'molten.rubber', name: 'Molten Rubber', mb: 144 }], out: [{ id: GT, meta: 17880, n: 1 }], eut: 8, ticks: 32 }) + '\n')
  const packdata = loadPackData(tmp.dir)
  const game = new FakeGame()
  game.handlers['world.machines'] = () => ({ machines: [{ ...machine, tanks: [{ fluid: 'molten.rubber', amount: 9072, capacity: 32000 }] }] })
  const ctx: ToolContext = { botName: 'Alu', bridge: new BridgeApi(game), memory: new MemoryStore(tmp.dir, () => 300), manuals: new ManualStore(DEFAULT_MANUALS_DIR, path.join(tmp.dir, 'manuals')), packdata, reminders: { add: () => ({ id: 'r1', dueAt: 0 }) }, hooks: {}, now: () => 0 }
  t.after(() => { packdata.recipes?.close(); tmp.cleanup() })
  return { game, run: (name: string, input = {}) => runTool(ALL_TOOLS, ctx, name, input, { maxResultChars: 16000 }) }
}

it('the same large cell name no longer hides another fluid on the cursor or in inventory', async (t) => {
  const s = setup(t)
  const cell = { id: GT, meta: 32408, count: 1, name: 'Large Stainless Steel Fluid Cell' }
  s.game.handlers['screen.look'] = () => ({ open: true, cursor: { ...cell, fluidContainer: { fluid: 'water', amount: 120, capacity: 64000 } }, slots: [{ slot: 9, own: true, item: { ...cell, fluidContainer: { amount: 0, capacity: 64000 } } }], controls: [{ key: 'tank', kind: 'fluid', fluid: 'molten.rubber', amount: 10368, capacity: 32000, drains: true, cursorFillableMb: 0 }] })
  const result = await s.run('open_screen')
  assert.match(result.content, /container: empty \(holds up to 64000 mB\)/)
  assert.match(result.content, /container: 120 of 64000 mB water \[fluid water\]/)
  assert.match(result.content, /one cursor container can accept 0 mB/)
  s.game.handlers['bot.status'] = () => ({ name: 'Alu', online: true, inventory: [{ ...cell, slot: 0, fluidContainer: { amount: 0, capacity: 64000 } }, { ...cell, slot: 1, fluidContainer: { fluid: 'water', amount: 120, capacity: 64000 } }] })
  const inventory = await s.run('get_status')
  assert.match(inventory.content, /container: empty/)
  assert.match(inventory.content, /container: 120 of 64000 mB water/)
})

it('get_status shows real damage of returned forms even when rounded durability still says 100%', async (t) => {
  const s = setup(t)
  s.game.handlers['bot.status'] = () => ({ name: 'Alu', online: true, inventory: [
    { id: 'dreamcraft:WoodenBrickForm', meta: 0, slot: 0, count: 1, durability: 1, rawDamage: 0, maxDamage: 300 },
    { id: 'dreamcraft:WoodenBrickForm', meta: 0, slot: 1, count: 1, durability: 1, rawDamage: 1, maxDamage: 300 },
  ] })
  const result = await s.run('get_status')
  assert.match(result.content, /2× dreamcraft:WoodenBrickForm.*100% durability.*raw damage 0–1\/300/)
})

it('fluid recipe with resident mould sends zero added inputs and exactly the requested collection count', async (t) => {
  const s = setup(t)
  const result = await s.run('process_items', { machine, recipe: 0, rounds: 63, moldInside: true })
  assert.equal(result.isError, undefined)
  const task = s.game.callsOf('task.start').at(-1)!.task as Record<string, unknown>
  assert.deepEqual(task.inputs, [])
  assert.deepEqual(task.expect, [{ id: GT, meta: 17880, count: 63 }])
  const observed = processResultLines({ put: 0, outputs: [{ id: GT, meta: 17880, count: 63 }], observedExisting: true, alreadyWorking: true, existingOutputs: [{ id: GT, meta: 17880, count: 5 }], observedRounds: 58, observedMade: [{ id: GT, meta: 17880, count: 58 }], requestedOutputsCollected: true })
  assert.match(observed.join('\n'), /not a batch started by this task/)
  assert.match(observed.join('\n'), /outputs already present:.*"count":5/)
  assert.match(observed.join('\n'), /completions observed \(not proof of ownership or requested rounds\): 58/)
  assert.match(observed.join('\n'), /actually collected:.*"count":63/)
  assert.doesNotMatch(observed.join('\n'), /finished 63 round/)
})

it('an observation shortfall retains collected items and says how many are missing and why it stopped', () => {
  const text = processResultLines({ observedExisting: true, alreadyWorking: false, existingOutputs: [{ id: GT, meta: 17880, count: 1 }], outputs: [{ id: GT, meta: 17880, count: 1 }], observedRounds: 0, observedMade: [], requestedOutputsCollected: false, missingOutputs: [{ id: GT, meta: 17880, count: 1 }], stopReason: 'machine_idle' }).join('\n')
  assert.match(text, /actually collected:.*"count":1/)
  assert.match(text, /requested counts collected: false/)
  assert.match(text, /still missing:.*"count":1.*observation stopped: machine_idle/)
})

it('querying MV adds the game-calculated NEI prediction without rewriting the base recipe', async (t) => {
  const s = setup(t)
  s.game.handlers['recipe.overclock'] = () => ({ ticks: 16, eut: 32, scope: 'standard electric 1 A', source: 'installed GregTech calculator' })
  const result = await s.run('find_recipes', { id: GT, meta: 17880, tier: 'MV' })
  assert.match(result.content, /8 EU\/t.*1.6 s/)
  assert.match(result.content, /NEI prediction: 16 ticks \(0.8 s\), 32 EU\/t/)
  assert.deepEqual(s.game.callsOf('recipe.overclock')[0], { bot: 'Alu', recipeKey: 'gt.recipe.fluidsolidifier', eut: 8, ticks: 32, tier: 'MV' })
  s.game.handlers['recipe.overclock'] = () => ({ unavailable: 'parallel, heat and machine-specific modifiers unknown' })
  const custom = await s.run('find_recipes', { id: GT, meta: 17880, machine })
  assert.match(custom.content, /overclock unavailable: parallel, heat and machine-specific modifiers unknown/)
  assert.doesNotMatch(custom.content, /NEI prediction:/)
})
