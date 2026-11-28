import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { RecipeBook } from '../src/packdata/recipes.ts'
import { ItemTable } from '../src/packdata/items.ts'
import type { PackData } from '../src/packdata/index.ts'
import { describeRecipes, prepareProject, portHandle } from '../src/planner/adapter.ts'
import { summarizeReport } from '../src/planner/report.ts'
import { PlannerEngine } from '../src/planner/engine.ts'
import { NATIVE_PROJECT_EXAMPLE } from '../src/planner/model.ts'
import type { DescribedRecipe, FactoryProject, Recipe, ThroughputResult } from '../src/planner/model.ts'

const handlers = [{ key: 'gt.recipe.macerator', name: '研磨机', machines: [{ id: 'gregtech:gt.blockmachines', meta: 301 }], read: 'gregtech' }]
function fixture(rows: object[], handlerRows: object[] = handlers) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-adapter-'))
  fs.writeFileSync(path.join(dir, 'handlers.json'), JSON.stringify(handlerRows))
  fs.writeFileSync(path.join(dir, 'recipes.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  const recipes = RecipeBook.load(dir)!.book
  const packdata: PackData = { dir, recipes }
  return { packdata, close() { recipes.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}
const row = { h: 'gt.recipe.macerator', in: [{ id: 'minecraft:stone', meta: 1, n: 2 }], out: [{ id: 'minecraft:sand', meta: 1, n: 3, chance: .25 }], eut: 2, ticks: 100 }
function projectFrom(d: DescribedRecipe, target = 1): FactoryProject {
  const output = d.recipe.outputs[0]
  return { schemaVersion: 1, id: 'test', name: 'Native local plan', solveMode: true, planMode: true, recipes: [d.recipe], nodes: [d.nodeTemplate],
    storages: [{ id: 'product', kind: output.kind, resourceId: output.id, targetMode: 'at-least', targetPerSecond: target, position: { x: 100, y: 0 } }],
    edges: [{ id: 'product-wire', source: d.nodeTemplate.id, target: 'product', resourceKind: output.kind, resourceId: output.id, sourceHandle: portHandle('output', output.kind, output.id) }], fuelProfiles: [] }
}
function noErrors(result: { issues: { severity: string; message: string }[] }): void { assert.deepEqual(result.issues.filter(i => i.severity === 'error'), []) }

test('describe keeps damage, candidates, grids, count-zero tools, chance, fluids and special/fake data in a full binding', () => {
  const f = fixture([{ ...row, in: [
    ...row.in, { ore: 'dustIron', n: 2, g: 4, any: [['test:iron', 2], ['test:iron', 3]], more: 7 },
    { any: [['test:dust', 1], ['test:dust', 2]], more: 0, n: 1 },
    { id: 'gregtech:gt.integrated_circuit', meta: 12, n: 0 },
  ], fin: [{ f: 'water', name: '水', mb: 1000 }], fout: [{ f: 'steam', name: '蒸汽', mb: 1600 }], special: 17, fake: true }])
  try {
    const d = describeRecipes(f.packdata, [0]).recipes[0]
    assert.equal(d.recipe.inputs[0].id, 'minecraft:stone@1')
    assert.equal(d.recipe.inputs[1].id, 'oredict:dustIron')
    assert.deepEqual(d.recipe.inputs[1].alternatives?.map(a => a.id), ['test:iron@2', 'test:iron@3'])
    assert.equal(d.recipe.inputs[3].consumed, false)
    assert.equal(d.recipe.inputs[3].amount, 1)
    assert.equal(d.recipe.programmedCircuit, '12')
    assert.equal(d.prerequisites.length, 1)
    assert.equal((d.prerequisites[0].localSlot as { n: number }).n, 0)
    assert.equal(d.recipe.outputs[0].chance, .25)
    assert.equal(d.recipe.inputs[4].amount, 1000)
    assert.equal(d.ports[4].unit, 'mB/craft')
    assert.equal(d.recipe.specialValue, 17)
    assert.deepEqual(d.recipe.nei?.additionalInfo, ['Special value: 17'])
    assert.equal(d.provenance.binding?.snapshot.fake, true)
    assert.equal(d.provenance.binding?.snapshot.raw.fake, true)
    assert.deepEqual(d.provenance.binding?.snapshot.raw.fin, [{ f: 'water', name: '水', mb: 1000 }])
    assert.equal(d.provenance.binding?.snapshot.in[1].g, 4)
    assert.match(d.ports[0].handle, /minecraft%3Astone%401$/)
    assert.equal(d.nodeTemplate.machineHandlerId, 'macerator')
    noErrors(prepareProject(f.packdata, projectFrom(d)))
  } finally { f.close() }
})

test('different named cultures cannot be merged by item/meta, but ordinary Chinese/English labels remain usable', () => {
  const f = fixture([
    { ...row, out: [{ id: 'test:culture', meta: 0, n: 1, name: 'Culture A' }] },
    { ...row, in: [{ id: 'test:culture', meta: 0, n: 1, name: 'Culture B' }] },
    { ...row, in: [{ id: 'minecraft:stone', meta: 1, n: 2, name: '石头' }] },
    { ...row, in: [{ id: 'minecraft:stone', meta: 1, n: 2, name: 'Stone' }] },
  ])
  f.packdata.items = new ItemTable([{ id: 'test:culture', meta: 0, name: '培养物', en: 'Culture' }, { id: 'minecraft:stone', meta: 1, name: '石头', en: 'Stone' }])
  try {
    const descriptions = describeRecipes(f.packdata, [0, 1, 2, 3]).recipes
    assert(descriptions[0].issues.some(i => i.code === 'MISSING_ITEM_INSTANCE_DATA'))
    assert(descriptions[1].issues.some(i => i.code === 'MISSING_ITEM_INSTANCE_DATA'))
    const p = projectFrom(descriptions[1])
    p.recipes.push(descriptions[0].recipe); p.nodes.push(descriptions[0].nodeTemplate)
    p.edges.push({ id: 'culture', source: p.nodes[1].id, target: p.nodes[0].id, resourceKind: 'item', resourceId: 'test:culture' })
    assert(prepareProject(f.packdata, p).issues.some(i => i.code === 'MISSING_ITEM_INSTANCE_DATA'))
    for (const recipe of p.recipes) delete recipe.metadata!.localBinding
    noErrors(prepareProject(f.packdata, p))
    noErrors(prepareProject(f.packdata, projectFrom(descriptions[2])))
    noErrors(prepareProject(f.packdata, projectFrom(descriptions[3])))
    assert.equal(descriptions[0].provenance.binding?.snapshot.out[0].name, 'Culture A')
  } finally { f.close() }
})

test('same local recipe moved to another ref keeps identity, while stale bindings require refresh or explicit old assumptions', () => {
  const f = fixture([row, { ...row, ticks: 200 }])
  try {
    const d = describeRecipes(f.packdata, [0]).recipes[0]
    const plan = projectFrom(d)
    fs.writeFileSync(path.join(f.packdata.dir, 'recipes.jsonl'), JSON.stringify({ ...row, ticks: 200 }) + '\n' + JSON.stringify(row) + '\n')
    f.packdata.recipes!.close()
    f.packdata.recipes = RecipeBook.load(f.packdata.dir)!.book
    const moved = describeRecipes(f.packdata, [1]).recipes[0]
    assert.equal(moved.recipe.id, d.recipe.id)
    assert(prepareProject(f.packdata, plan).issues.some(i => i.code === 'STALE_LOCAL_RECIPE' && i.severity === 'error'))
    noErrors(prepareProject(f.packdata, plan, { allowStale: true }))
    assert.equal(prepareProject(f.packdata, plan, { allowStale: true }).provenance[0].status, 'local-stale')
    f.packdata.recipes.close()
  } finally { f.close() }
})

test('replacing export files cannot sign an old loaded recipe with a new dataset fingerprint', () => {
  const f = fixture([row])
  try {
    const original = describeRecipes(f.packdata, [0]).recipes[0]
    const p = projectFrom(original)
    const replacement = path.join(f.packdata.dir, 'next.jsonl')
    fs.writeFileSync(replacement, JSON.stringify({ ...row, ticks: 200 }) + '\n')
    fs.renameSync(replacement, path.join(f.packdata.dir, 'recipes.jsonl'))
    assert.equal(f.packdata.recipes!.isSourceCurrent(), false)
    assert(describeRecipes(f.packdata, [0]).issues.some(i => i.code === 'PACKDATA_RELOAD_REQUIRED'))
    assert(prepareProject(f.packdata, p).issues.some(i => i.code === 'PACKDATA_RELOAD_REQUIRED'))
    f.packdata.recipes!.close(); f.packdata.recipes = RecipeBook.load(f.packdata.dir)!.book
    const fresh = describeRecipes(f.packdata, [0]).recipes[0]
    assert.equal(fresh.recipe.durationTicks, 200)
    assert.notEqual(fresh.recipe.id, original.recipe.id)
    noErrors(prepareProject(f.packdata, projectFrom(fresh)))
    fs.writeFileSync(path.join(f.packdata.dir, 'handlers.json'), JSON.stringify([{ ...handlers[0], name: 'Changed export handler' }]))
    assert.equal(f.packdata.recipes.isSourceCurrent(), false)
    f.packdata.recipes.close()
  } finally { f.close() }
})

test('bound native formula edits are rejected, while explicitly declared native recipes remain usable assumptions', () => {
  const f = fixture([row])
  try {
    const plan = projectFrom(describeRecipes(f.packdata, [0]).recipes[0])
    plan.recipes[0].durationTicks = 1
    assert(prepareProject(f.packdata, plan).issues.some(i => i.code === 'BINDING_CHANGED'))
    delete plan.recipes[0].metadata!.localBinding
    const prepared = prepareProject(f.packdata, plan)
    noErrors(prepared)
    assert.equal(prepared.provenance[0].status, 'declared-unverified')
  } finally { f.close() }
})

test('ore selection uses native decimal input overrides and refuses an ambiguous resource row rather than silently choosing the first', () => {
  const f = fixture([{ ...row, in: [{ ore: 'a', n: 1, any: [['minecraft:stone', 0]], more: 0 }, { ore: 'b', n: 1, any: [['minecraft:stone', 0]], more: 0 }] }])
  try {
    const p = projectFrom(describeRecipes(f.packdata, [0]).recipes[0])
    p.storages!.push({ id: 'source', kind: 'item', resourceId: 'minecraft:stone', position: { x: -100, y: 0 } })
    p.edges.push({ id: 'feed', source: 'source', target: p.nodes[0].id, resourceKind: 'item', resourceId: 'minecraft:stone' })
    assert(prepareProject(f.packdata, p).issues.some(i => i.code === 'AMBIGUOUS_RESOURCE_PORT'))
    p.nodes[0].recipeInputOverrides = { '1': { kind: 'item', id: 'minecraft:stone', amount: 1 } }
    p.edges[1].targetHandle = portHandle('input', 'item', 'minecraft:stone')
    noErrors(prepareProject(f.packdata, p))
    p.edges[1].resourceId = 'minecraft:stone@2'
    assert(prepareProject(f.packdata, p).issues.some(i => i.code === 'EDGE_RESOURCE_MISMATCH'))
  } finally { f.close() }
})

test('native count pins and rate pins cannot silently erase a hard capacity', async () => {
  const engine = new PlannerEngine()
  try {
    const p = structuredClone(NATIVE_PROJECT_EXAMPLE)
    p.recipes[0].minimumTier = p.nodes[0].overclockTier = 'LV'
    p.recipes[0].eut = 30
    p.recipes[0].durationTicks = 20
    p.nodes[0].solvePin = 1
    p.storages![0].targetPerSecond = -10
    p.storages![1].targetPerSecond = 3
    noErrors(prepareProject(undefined, p))
    const report = await engine.calculate(p) as ThroughputResult
    const summary = summarizeReport(p, report)
    assert.equal(summary.status, 'unmet')
    assert(report.plan?.shortfalls?.some(s => s.drawerId === 'product' && s.target === 3 && s.reachable <= 1 + 1e-7))
    assert(summary.machines[0].fractionalMachines <= 1 + 1e-7)
    assert.equal(summary.machines[0].capacityExceeded, false)
    assert.strictEqual(summary.nativeReport, report)
    p.nodes[0].solvePinExact = true
    p.nodes[0].portRates = { [portHandle('output', 'item', 'example:product@0')]: 3 }
    assert(prepareProject(undefined, p).issues.some(i => i.code === 'COUNT_PIN_TARGET_CONFLICT'))
  } finally { await engine.close() }
})

test('source at-most limit and product shortfalls remain visible even when the native plan has a solution', async () => {
  const engine = new PlannerEngine()
  try {
    const p = structuredClone(NATIVE_PROJECT_EXAMPLE)
    p.recipes[0].minimumTier = p.nodes[0].overclockTier = 'LV'; p.recipes[0].eut = 30
    delete p.nodes[0].solvePin
    p.storages![0].targetPerSecond = -.5
    p.storages![1].targetPerSecond = 2
    const report = await engine.calculate(p) as ThroughputResult
    const summary = summarizeReport(p, report)
    assert.notEqual(summary.status, 'satisfied')
    assert(summary.goals.some(g => g.ownerId === 'product' && !g.met))
    assert(summary.goals.some(g => g.ownerId === 'source' && g.met))
    assert(summary.shortfalls.length > 0)
  } finally { await engine.close() }
})

test('an unlimited native source still means sustained external supply, not inventory already available', async () => {
  const engine = new PlannerEngine()
  try {
    const p = structuredClone(NATIVE_PROJECT_EXAMPLE)
    delete p.storages![0].targetPerSecond
    delete p.nodes[0].solvePin
    const summary = summarizeReport(p, await engine.calculate(p))
    assert.equal(summary.status, 'needs-external-supply')
    assert(summary.externalInputs.some(row => (row as { source: string }).source === 'source-storage'))
    assert(summary.goals.every(g => g.met))
  } finally { await engine.close() }
})

test('source caps can produce forced imports without native shortfalls, and the report still requires extra supply', async () => {
  const engine = new PlannerEngine()
  try {
    const p: FactoryProject = { schemaVersion: 1, id: 'forced', name: 'Capped ore with forced dust', planMode: true, solveMode: true,
      recipes: [
        { id: 'crush', name: 'Crush', machineType: 'Macerator', minimumTier: 'LV', eut: 30, durationTicks: 20, inputs: [{ kind: 'item', id: 'ore', amount: 1 }], outputs: [{ kind: 'item', id: 'dust', amount: 2 }] },
        { id: 'press', name: 'Press', machineType: 'Bending Machine', minimumTier: 'LV', eut: 30, durationTicks: 20, inputs: [{ kind: 'item', id: 'dust', amount: 1 }], outputs: [{ kind: 'item', id: 'plate', amount: 1 }] },
      ], nodes: ['crush', 'press'].map(id => ({ id, recipeId: id, machineCount: 1, parallel: 1, overclockTier: 'LV', enabled: true, position: { x: 0, y: 0 } })),
      storages: [
        { id: 'ore-source', kind: 'item', resourceId: 'ore', targetMode: 'at-most', targetPerSecond: -.5, position: { x: 0, y: 0 } },
        { id: 'product', kind: 'item', resourceId: 'plate', targetMode: 'exact', targetPerSecond: 3, position: { x: 0, y: 0 } },
      ], edges: [
        { id: 'supply', source: 'ore-source', target: 'crush', resourceKind: 'item', resourceId: 'ore' },
        { id: 'dust', source: 'crush', target: 'press', resourceKind: 'item', resourceId: 'dust' },
        { id: 'out', source: 'press', target: 'product', resourceKind: 'item', resourceId: 'plate' },
      ], fuelProfiles: [] }
    noErrors(prepareProject(undefined, p))
    const nativeReport = await engine.calculate(p) as ThroughputResult
    const summary = summarizeReport(p, nativeReport)
    assert.deepEqual(nativeReport.plan?.unmetDrawers, [])
    assert(summary.goals.every(g => g.met))
    assert(nativeReport.plan?.forced.some(f => f.side === 'in' && f.resourceKey === 'item:dust' && Math.abs(f.perSecond - 2) < 1e-6))
    assert.equal(summary.status, 'requires-forced-flow')
    assert(summary.issues.some(i => i.code === 'FORCED_IMPORT' && i.nodeId === 'press'))
    assert(summary.externalInputs.some(row => (row as { source: string; resourceKey: string }).source === 'forced' && (row as { resourceKey: string }).resourceKey === 'item:dust'))
  } finally { await engine.close() }
})

test('local pyrolyse oven reports the tier the engine used despite its fallback handler', async (t) => {
  const key = 'gt.recipe.pyro'
  const f = fixture([{ ...row, h: key, eut: 60 }], [{ ...handlers[0], key }])
  t.after(() => f.close())
  const engine = new PlannerEngine()
  t.after(() => engine.close())
  const p = projectFrom(describeRecipes(f.packdata, [0]).recipes[0])
  p.nodes[0].overclockTier = 'LV'
  const prepared = prepareProject(f.packdata, p)
  noErrors(prepared)
  const summary = summarizeReport(p, await engine.calculate(p), prepared)
  assert.equal(summary.machines[0].energy?.sections[0].power.tier, 'MV')
  assert.ok(summary.issues.some(issue => issue.code === 'TIER_RAISED' && issue.recipeId === p.recipes[0].id))
})

test('shared native extraRecipes round machine time once for the card, not once for every recipe', async () => {
  const engine = new PlannerEngine()
  try {
    const recipe = (id: string, output: string): Recipe => ({ id, name: id, kind: 'custom', machineType: 'Macerator', minimumTier: 'LV', durationTicks: 20, eut: 30, inputs: [{ kind: 'item', id: 'feed', amount: 1 }], outputs: [{ kind: 'item', id: output, amount: 1 }] })
    const p: FactoryProject = { schemaVersion: 1, id: 'shared', name: 'Shared machine', solveMode: true, planMode: true, recipes: [recipe('a', 'a'), recipe('b', 'b')],
      nodes: [{ id: 'shared', recipeId: 'a', extraRecipes: [{ recipeId: 'b' }], enabled: true, machineCount: 1, parallel: 1, overclockTier: 'LV', position: { x: 0, y: 0 } }],
      storages: ['a', 'b'].map(id => ({ id, kind: 'item' as const, resourceId: id, targetMode: 'exact' as const, targetPerSecond: .3, position: { x: 100, y: 0 } })),
      edges: ['a', 'b'].map((id, i) => ({ id, source: 'shared', target: id, resourceKind: 'item', resourceId: id, sourceHandle: `${i ? 'r1:' : ''}output:item:${id}` })), fuelProfiles: [] }
    noErrors(prepareProject(undefined, p))
    const report = await engine.calculate(p) as ThroughputResult
    const summary = summarizeReport(p, report)
    assert.equal(summary.machines.length, 1)
    assert.equal(summary.machines[0].shared, true)
    assert(Math.abs(summary.machines[0].fractionalMachines - .6) < 1e-7)
    assert.equal(summary.machines[0].buildMachines, 1)
    assert(summary.goals.every(g => g.met))
    p.recipes[1].machineType = 'Chemical Reactor'
    assert(prepareProject(undefined, p).issues.some(i => i.code === 'SHARED_MACHINE_MISMATCH'))
    p.recipes[1].machineHandlers = [
      { id: 'chemical-reactor', label: 'Chemical Reactor', machineType: 'Chemical Reactor', minimumTier: 'LV' },
      { id: 'macerator', label: 'Macerator', machineType: 'Macerator', minimumTier: 'LV' },
    ]
    assert(prepareProject(undefined, p).issues.some(i => i.code === 'AMBIGUOUS_SHARED_MACHINE'))
    p.nodes[0].machineHandlerId = 'macerator'
    noErrors(prepareProject(undefined, p))
  } finally { await engine.close() }
})

test('an explicit unknown handler is rejected instead of being silently replaced by the native default', () => {
  const f = fixture([row])
  try {
    const p = projectFrom(describeRecipes(f.packdata, [0]).recipes[0])
    p.nodes[0].machineHandlerId = 'not-a-machine'
    assert(prepareProject(f.packdata, p).issues.some(i => i.code === 'UNKNOWN_MACHINE_HANDLER'))
    assert.equal(p.nodes[0].machineHandlerId, 'not-a-machine')
    p.nodes[0].machineHandlerId = 'macerator'
    noErrors(prepareProject(f.packdata, p))
  } finally { f.close() }
})

for (const scenario of [
  { name: 'heating coils', map: 'gt.recipe.blastfurnace', lowSpecial: 1800, highSpecial: 3600, lowEut: 120, highEut: 120, field: 'coilTier', setting: 'nichrome' },
  { name: 'singleblock run tiers', map: 'gt.recipe.macerator', lowSpecial: 0, highSpecial: 0, lowEut: 30, highEut: 120, field: 'runTier', setting: 'MV' },
  { name: 'field restriction coils', map: 'gg.recipe.naquadah_fuel_refine_factory', lowSpecial: 1, highSpecial: 3, lowEut: 120, highEut: 120, field: 'machineConfigTiers', setting: 't3' },
]) test(`shared recipe-dependent ${scenario.name} require one actual configuration, and an explicit common higher setting solves`, async () => {
  const f = fixture([
    { ...row, h: scenario.map, special: scenario.lowSpecial, eut: scenario.lowEut, out: [{ id: 'test:first', meta: 0, n: 1 }] },
    { ...row, h: scenario.map, special: scenario.highSpecial, eut: scenario.highEut, out: [{ id: 'test:second', meta: 0, n: 1 }] },
  ], [{ ...handlers[0], key: scenario.map }])
  const engine = new PlannerEngine()
  try {
    const [first, second] = describeRecipes(f.packdata, [0, 1]).recipes
    const p = projectFrom(first, .1)
    p.recipes.push(second.recipe)
    p.nodes[0].extraRecipes = [{ recipeId: second.recipe.id }]
    p.storages!.push({ id: 'second-product', kind: 'item', resourceId: 'test:second', targetMode: 'at-least', targetPerSecond: .1, position: { x: 200, y: 0 } })
    p.edges.push({ id: 'second-wire', source: first.nodeTemplate.id, target: 'second-product', resourceKind: 'item', resourceId: 'test:second', sourceHandle: `r1:${portHandle('output', 'item', 'test:second')}` })
    if (scenario.field === 'coilTier') delete p.nodes[0].coilTier
    if (scenario.field === 'machineConfigTiers') delete p.nodes[0].machineConfigTiers
    const unresolved = structuredClone(p)
    const issues = prepareProject(f.packdata, p).issues
    assert(issues.some(i => i.code === 'SHARED_MACHINE_SETTINGS_MISMATCH' && i.message.includes(scenario.field)))
    assert.deepEqual(p, unresolved)
    if (scenario.field === 'coilTier') p.nodes[0].coilTier = scenario.setting
    else if (scenario.field === 'runTier') p.nodes[0].overclockTier = scenario.setting
    else p.nodes[0].machineConfigTiers = { fieldRestrictionCoil: scenario.setting }
    noErrors(prepareProject(f.packdata, p))
    const report = await engine.calculate(p) as ThroughputResult
    const summary = summarizeReport(p, report)
    assert(summary.goals.every(goal => goal.met))
    assert.equal(summary.machines.length, 1)
    assert.equal(summary.machines[0].shared, true)
    assert(summary.machines[0].energy!.sections.every(section => section.power.state === 'ok'))
    assert(report.nodes[first.nodeTemplate.id].theoreticalMachinesRequired > 0)
    assert(report.nodes[`${first.nodeTemplate.id}#r1`].theoreticalMachinesRequired > 0)
    if (scenario.field === 'runTier') assert(summary.machines[0].energy!.sections.every(section => section.power.tier === 'MV'))
  } finally { f.close(); await engine.close() }
})

test('zero machine pins and zero nameplate seeds are rejected, while an explicit zero source limit really stops supply', async () => {
  const engine = new PlannerEngine()
  try {
    const p = structuredClone(NATIVE_PROJECT_EXAMPLE)
    p.nodes[0].solvePin = 0; p.nodes[0].solvePinExact = true
    assert(prepareProject(undefined, p).issues.some(i => i.code === 'ZERO_MACHINE_PIN'))
    delete p.nodes[0].solvePin; delete p.nodes[0].solvePinExact; p.nodes[0].machineCount = 0
    assert(prepareProject(undefined, p).issues.some(i => i.code === 'ZERO_NAMEPLATE_SEED'))
    p.nodes[0].machineCount = 1
    const running = await engine.calculate(p) as ThroughputResult
    assert.equal(running.nodes.machine.theoreticalMachinesRequired, 1)
    assert.equal(running.totalEuT, 2)
    p.storages![0].targetPerSecond = 0
    for (const rule of ['exact', 'at-most'] as const) {
      p.storages![0].targetMode = rule
      noErrors(prepareProject(undefined, p))
      const stopped = await engine.calculate(p) as ThroughputResult
      assert.equal(stopped.storages.source.consumedPerSecond, 0)
      assert.equal(stopped.storages.product.producedPerSecond, 0)
      assert.equal(summarizeReport(p, stopped).status, 'unmet')
    }
  } finally { await engine.close() }
})

test('Build targets use actual utilization, and integer machines retain their running power rather than the average', async () => {
  const engine = new PlannerEngine()
  try {
    const p: FactoryProject = { schemaVersion: 1, id: 'build', name: 'Half-fed build', recipes: [
      { id: 'a', name: 'A', machineType: 'Macerator', minimumTier: 'LV', durationTicks: 40, eut: 30, inputs: [], outputs: [{ kind: 'item', id: 'feed', amount: 1 }] },
      { id: 'b', name: 'B', machineType: 'Macerator', minimumTier: 'LV', durationTicks: 20, eut: 30, inputs: [{ kind: 'item', id: 'feed', amount: 1 }], outputs: [{ kind: 'item', id: 'product', amount: 1 }] },
    ], nodes: ['a', 'b'].map(id => ({ id, recipeId: id, machineCount: 1, parallel: 1, overclockTier: 'LV', enabled: true, position: { x: 0, y: 0 }, ...(id === 'b' ? { targetOutput: { kind: 'item' as const, resourceId: 'product', amountPerSecond: 1 } } : {}) })),
      storages: [{ id: 'product', kind: 'item', resourceId: 'product', position: { x: 200, y: 0 } }],
      edges: [{ id: 'feed', source: 'a', target: 'b', resourceKind: 'item', resourceId: 'feed' }, { id: 'out', source: 'b', target: 'product', resourceKind: 'item', resourceId: 'product' }], fuelProfiles: [] }
    noErrors(prepareProject(undefined, p))
    const raw = await engine.calculate(p) as ThroughputResult
    const result = summarizeReport(p, raw)
    assert.equal(raw.nodes.b.utilization, .5)
    assert.equal(result.goals.find(g => g.ownerId === 'b')?.actual, .5)
    assert.equal(result.status, 'unmet')
    assert.equal(result.averageEuT, 45)
    assert.equal(result.machines.find(m => m.nodeId === 'b')?.energy?.sections[0].perMachineRunningEuT, 30)
    const plan = structuredClone(NATIVE_PROJECT_EXAMPLE)
    plan.recipes[0].eut = 30; plan.storages![1].targetPerSecond = .3; delete plan.nodes[0].solvePin
    const scaled = summarizeReport(plan, await engine.calculate(plan))
    assert(Math.abs(scaled.averageEuT! - 9) < 1e-7)
    assert.equal(scaled.buildPeakEuT, 30)
    assert.equal(scaled.machines[0].energy?.sections[0].power.tier, 'LV')
  } finally { await engine.close() }
})

test('a negative unwired Pool target is a source even without poolSide', async () => {
  const engine = new PlannerEngine()
  try {
    const p = structuredClone(NATIVE_PROJECT_EXAMPLE)
    p.poolMode = true; p.edges = []; delete p.nodes[0].solvePin
    p.storages![1].poolSide = 'drain'
    noErrors(prepareProject(undefined, p))
    const result = summarizeReport(p, await engine.calculate(p))
    assert(result.goals.every(g => g.met))
    assert.equal(result.goals.find(g => g.ownerId === 'source')?.actual, 1)
    assert.equal(result.status, 'needs-external-supply')
  } finally { await engine.close() }
})

test('GT omitted special means zero heat requirement, while steam defaults still require real steam', async () => {
  const f = fixture([{ ...row, h: 'gt.recipe.multidehydrator', eut: 30, ticks: 1000 }], [{ ...handlers[0], key: 'gt.recipe.multidehydrator' }])
  const steamFixture = fixture([row])
  const engine = new PlannerEngine()
  try {
    const d = describeRecipes(f.packdata, [0]).recipes[0]
    assert.equal(d.recipe.specialValue, 0)
    assert.equal(d.provenance.binding?.snapshot.special, undefined)
    assert.equal(d.provenance.binding?.snapshot.raw.special, undefined)
    assert.deepEqual(d.recipe.nei?.additionalInfo, ['Special value: 0'])
    const p = projectFrom(d, 1)
    p.nodes[0].overclockTier = 'EV'; p.nodes[0].coilTier = 'nichrome'
    noErrors(prepareProject(f.packdata, p))
    const hot = summarizeReport(p, await engine.calculate(p))
    assert(hot.machines[0].energy!.sections[0].power.perfectOverclockSteps > 0)
    const steam = describeRecipes(steamFixture.packdata, [0], { machineHandlerId: 'steam-macerator' }).recipes[0]
    const sp = projectFrom(steam, .1)
    noErrors(prepareProject(steamFixture.packdata, sp))
    const result = summarizeReport(sp, await engine.calculate(sp))
    assert.equal(result.averageEuT, 0)
    assert(result.averageSteamMbPerSecond! > 0)
    assert.equal(result.machines[0].energy?.sections[0].steam?.drawSteamPerTick, 4)
    assert(result.externalInputs.some(row => (row as { source?: string }).source === 'machine-steam'))
  } finally { f.close(); steamFixture.close(); await engine.close() }
})

test('native hidden prefixes and section ids cannot hide supplies or collide with expanded shared sections', () => {
  for (const id of ['hatch-supply:fake', 'pool:fake', 'pool-tank:fake', 'a#r1', 'a|i|fake']) {
    const p = structuredClone(NATIVE_PROJECT_EXAMPLE)
    p.storages![0].id = id; p.edges[0].source = id
    assert(prepareProject(undefined, p).issues.some(i => i.code === 'RESERVED_GRAPH_ID'))
  }
  const p = structuredClone(NATIVE_PROJECT_EXAMPLE); p.nodes[0].parallel = 1.5
  assert(prepareProject(undefined, p).issues.some(i => i.code === 'INVALID_NODE'))
})

test('small positive native loads and imports are not rounded away as zero machines or satisfied zero output', () => {
  const p = structuredClone(NATIVE_PROJECT_EXAMPLE)
  p.storages![1].targetPerSecond = 1e-8
  const nativeReport = {
    nodes: { machine: { nodeId: 'machine', recipeId: 'example-recipe', enabled: true, inputs: {}, outputs: {}, euT: 2, utilization: 0, theoreticalMachinesRequired: 1e-8, status: 'underutilized', warnings: [] } },
    storages: { product: { producedPerSecond: 0, consumedPerSecond: 0 } }, resources: {}, edges: {}, totalEuT: 0,
    plan: { forced: [{ nodeId: 'machine', portKey: 'machine|i|input:item:feed', resourceKey: 'item:feed', side: 'in', perSecond: 1e-10 }], terminals: [], unanchored: [], notes: [], unmetDrawers: [] },
  }
  const summary = summarizeReport(p, nativeReport)
  assert.equal(summary.machines[0].buildMachines, 1)
  assert.equal(summary.goals.find(g => g.ownerId === 'product')?.met, false)
  assert(summary.externalInputs.some(row => (row as { perSecond?: number }).perSecond === 1e-10))
})

test('native trash drawers stay visible as disposal requirements even when they disappear from surplus totals', async () => {
  const engine = new PlannerEngine()
  try {
    const p = structuredClone(NATIVE_PROJECT_EXAMPLE)
    p.recipes[0].outputs.push({ kind: 'fluid', id: 'waste', amount: 1000 })
    p.storages!.push({ id: 'trash', kind: 'fluid', resourceId: 'waste', drainMode: 'trash', position: { x: 0, y: 0 } })
    p.edges.push({ id: 'trash-wire', source: 'machine', target: 'trash', resourceKind: 'fluid', resourceId: 'waste' })
    const summary = summarizeReport(p, await engine.calculate(p))
    assert(summary.externalOutputs.some(row => (row as { drainMode?: string; perSecond?: number }).drainMode === 'trash' && (row as { perSecond?: number }).perSecond === 1000))
  } finally { await engine.close() }
})

test('non-finite input, wrong resource edges and missing machine metadata stop before calculation', () => {
  const f = fixture([row, { ...row, h: 'unknown.machine.map' }])
  try {
    const p = projectFrom(describeRecipes(f.packdata, [0]).recipes[0])
    p.nodes[0].parallel = Infinity
    assert(prepareProject(f.packdata, p).issues.some(i => i.code === 'NON_FINITE_NUMBER'))
    p.nodes[0].parallel = 1; p.edges[0].resourceKind = 'fluid'
    assert(prepareProject(f.packdata, p).issues.some(i => i.code === 'EDGE_RESOURCE_MISMATCH'))
    assert(describeRecipes(f.packdata, [1]).issues.some(i => i.code === 'MISSING_MACHINE_MAP'))
  } finally { f.close() }
})

const realDir = path.resolve(import.meta.dirname, '../packdata')
test('real local packdata describes and solves tool, fluid, probability and heat recipes through the original engine', { skip: !fs.existsSync(path.join(realDir, 'recipes.jsonl')) }, async () => {
  const recipes = RecipeBook.load(realDir)!.book
  const packdata: PackData = { dir: realDir, recipes }
  const engine = new PlannerEngine()
  try {
    // Find by full local identity, not export-dependent line refs.
    const find = (handler: string, input: string, output: string) => {
      for (const ref of recipes.makesOf(output, 0)) {
        const r = recipes.get(ref)!
        if (r.handler.key === handler && r.in.some(s => s.kind === 'item' && s.id === input)) return ref
      }
      return undefined
    }
    const brickRef = find('gt.recipe.alloysmelter', 'minecraft:clay_ball', 'minecraft:brick')
    const concreteRef = find('gt.recipe.mixer', 'etfuturum:concrete_powder', 'etfuturum:concrete')
    assert.notEqual(brickRef, undefined); assert.notEqual(concreteRef, undefined)
    const brick = describeRecipes(packdata, [brickRef!]).recipes[0]
    const p = projectFrom(brick, .05)
    noErrors(prepareProject(packdata, p))
    const report = await engine.calculate(p) as ThroughputResult
    const summary = summarizeReport(p, report, prepareProject(packdata, p))
    assert(summary.goals.every(g => g.met))
    assert.equal(summary.status, 'needs-external-supply')
    assert.equal(summary.machines[0].buildMachines, 1)
    assert.equal(report.nodes[brick.nodeTemplate.id].inputs['item:gregtech:gt.metaitem.01@32306'], undefined)
    const extractorRef = find('gt.recipe.extractor', 'minecraft:clay', 'minecraft:clay_ball')
    assert.notEqual(extractorRef, undefined)
    const extractor = describeRecipes(packdata, [extractorRef!]).recipes[0]
    const chain = projectFrom(brick, .2)
    chain.recipes.push(extractor.recipe); chain.nodes.push(extractor.nodeTemplate)
    chain.storages!.push({ id: 'clay-source', kind: 'item', resourceId: 'minecraft:clay', targetMode: 'at-most', targetPerSecond: -.05, position: { x: -200, y: 0 } })
    chain.edges.push(
      { id: 'clay-source-wire', source: 'clay-source', target: extractor.nodeTemplate.id, resourceKind: 'item', resourceId: 'minecraft:clay' },
      { id: 'clay-ball-wire', source: extractor.nodeTemplate.id, target: brick.nodeTemplate.id, resourceKind: 'item', resourceId: 'minecraft:clay_ball' },
    )
    noErrors(prepareProject(packdata, chain))
    const chainReport = await engine.calculate(chain) as ThroughputResult
    assert(Math.abs(chainReport.edges['clay-ball-wire'].transferredPerSecond - .2) < 1e-7)
    assert(Math.abs(chainReport.storages['clay-source'].consumedPerSecond - .05) < 1e-7)
    assert(summarizeReport(chain, chainReport).goals.every(g => g.met))
    p.nodes[0].solvePin = 1; p.storages![0].targetPerSecond = .3
    const capped = summarizeReport(p, await engine.calculate(p))
    assert.equal(capped.status, 'unmet')
    assert(capped.shortfalls.length > 0)
    const concrete = describeRecipes(packdata, [concreteRef!]).recipes[0]
    const c = projectFrom(concrete, 8)
    noErrors(prepareProject(packdata, c))
    const cr = await engine.calculate(c) as ThroughputResult
    assert(Math.abs(cr.nodes[concrete.nodeTemplate.id].inputs['fluid:water'].amountPerSecond - 1000) < 1e-6)
    // A genuine chanced recipe, selected by a local registered ingredient id.
    const chanceRef = recipes.usesOf('GoodGenerator:naquadahMass', 0).find(ref => recipes.get(ref)?.handler.key === 'gt.recipe.macerator')
    assert.notEqual(chanceRef, undefined)
    const chance = describeRecipes(packdata, [chanceRef!]).recipes[0]
    const chp = projectFrom(chance, 1)
    const chr = await engine.calculate(chp) as ThroughputResult
    const byproduct = chance.recipe.outputs.find(o => o.chance === .01)!
    assert(byproduct)
    assert(Math.abs(chr.nodes[chance.nodeTemplate.id].outputs[`item:${byproduct.id}`].amountPerSecond - .01) < 1e-8)
    assert(summarizeReport(chp, chr).assumptions.some(s => /expected long-run/.test(s)))
    const heatRef = recipes.usesOf('miscutils:item.BasicAgrichemItem', 2).find(ref => recipes.get(ref)?.handler.key === 'gt.recipe.blastfurnace')
    assert.notEqual(heatRef, undefined)
    const heat = describeRecipes(packdata, [heatRef!]).recipes[0]
    assert.equal(heat.recipe.specialValue, 1200)
    assert.equal(heat.nodeTemplate.coilTier, 'cupronickel')
    const hp = projectFrom(heat, 1)
    noErrors(prepareProject(packdata, hp))
    assert(summarizeReport(hp, await engine.calculate(hp)).goals.every(g => g.met))
  } finally { recipes.close(); await engine.close() }
})
