import { isRecord } from '../util.ts'
import { overclockTierIndex, tierIndex } from './catalog.ts'
import { portHandle } from './adapter.ts'
import type { FactoryProject, GoalAssessment, MachineEnergyAssessment, ReportContext, ReportSummary, ThroughputResult } from './model.ts'
import { getStorageRoles, storageTargetMode, hasStorageTarget, getNodePowerReport, getNodeSteamReport } from '../../vendor/gtnh-planner/dist/catalog.mjs'

const EPS = 1e-7
function meets(rule: string, actual: number | undefined, target: number): boolean {
  if (actual === undefined || !Number.isFinite(actual)) return false
  const tolerance = EPS * Math.max(1e-9, Math.abs(target), Math.abs(actual))
  return rule === 'at-most' ? actual <= target + tolerance : rule === 'exact' ? Math.abs(actual - target) <= tolerance : actual + tolerance >= target
}

/** Explains, but never replaces, the complete native English books/diagnostics. */
export function summarizeReport(project: FactoryProject, nativeReport: unknown, context: ReportContext = {}): ReportSummary {
  const summary: ReportSummary = {
    status: 'failed', nativeReport, goals: [], machines: [], externalInputs: [], externalOutputs: [], forcedFlows: [], shortfalls: [],
    issues: [...context.issues ?? []], staticAnalysis: true,
    assumptions: [
      'Static steady-state arithmetic only: solved does not mean inventory is available or the world build can operate.',
      'Rates are items/s and mB/s (GT L = mB); durationTicks uses 20 ticks/s; power is EU/t. View rate units do not change solver inputs.',
      'Machine settings/defaults describe a model, not machines, coils, hatches, voltage or installed supply observed in the world.',
      'External imports, terminal inputs and forced inflows require actual sustained supply. Exports/forced outflows require disposal or storage capacity.',
      'Build quantities round total shared-machine time upward once per card; extraRecipes time-share one machine group. Production groups scope resource pools, not shared physical machines.',
      'A source with no explicit targetMode uses the native Exactly rule. To limit supply without requiring all of it, set targetMode: at-most.',
      'Machine formation, stock, startup materials, power distribution, piping, throughput bottlenecks and permissions still need world inspection and execution acceptance.',
    ],
  }
  if (!isRecord(nativeReport) || !isRecord(nativeReport.nodes) || !isRecord(nativeReport.storages) || !isRecord(nativeReport.edges) || !isRecord(nativeReport.resources) || typeof nativeReport.totalEuT !== 'number' || !Number.isFinite(nativeReport.totalEuT)) {
    summary.issues.push({ severity: 'error', code: 'INVALID_NATIVE_REPORT', message: 'Engine did not return a valid finite ThroughputResult.' })
    return summary
  }
  const report = nativeReport as unknown as ThroughputResult
  const plan = report.plan
  const planning = !!(project.planMode || project.solveMode || project.poolMode)
  const roles = getStorageRoles(project)
  const recipes = new Map(project.recipes.map(recipe => [recipe.id, recipe]))
  summary.averageEuT = 0; summary.buildPeakEuT = 0
  summary.averageSteamMbPerSecond = 0; summary.buildPeakSteamMbPerSecond = 0
  summary.totalEuT = report.totalEuT
  const forcedFlows = (plan?.forced ?? []).filter(flow => flow.perSecond > 0)
  summary.forcedFlows = forcedFlows
  summary.shortfalls = [...plan?.shortfalls ?? []]
  for (const flow of forcedFlows) {
    const incoming = flow.side === 'in'
    summary.issues.push({
      severity: 'warning', code: incoming ? 'FORCED_IMPORT' : 'FORCED_EXPORT', nodeId: flow.nodeId,
      message: `The solver ${incoming ? 'supplies' : 'removes'} ${flow.perSecond}/s of ${flow.resourceKey} at ${flow.portKey}. The drawn line needs ${incoming ? 'an additional source' : 'an additional outlet'} for this flow.`,
    })
  }
  summary.externalInputs = [
    ...(report.externalInputs ?? []).map(row => ({ source: 'native-externalInputs', ...row })),
    ...Object.values(report.resources).filter(row => row.importedPerSecond > 0 && !(report.externalInputs ?? []).some(input => input.key === row.key)).map(row => ({ source: 'native-imported-balance', ...row })),
    ...forcedFlows.filter(row => row.side === 'in').map(row => ({ source: 'forced', ...row })),
    ...(plan?.terminals ?? []).filter(row => row.side === 'in' && row.perSecond > 0).map(row => ({ source: 'terminal', ...row })),
  ]
  summary.externalOutputs = [
    ...(report.unconsumedOutputs ?? []).map(row => ({ source: 'native-unconsumedOutputs', ...row })),
    ...forcedFlows.filter(row => row.side === 'out').map(row => ({ source: 'forced', ...row })),
    ...(plan?.terminals ?? []).filter(row => row.side === 'out' && row.perSecond > 0).map(row => ({ source: 'terminal', ...row })),
    ...(plan?.spills ?? []).map(row => ({ source: 'buffer-spill', ...row })),
  ]
  summary.assumptions.push('Boundary lists preserve native resource balances and port-level detail as separate views of the same flows; do not sum both views together.')
  const unmet = new Set(plan?.unmetDrawers ?? [])
  for (const storage of project.storages ?? []) {
    const role = roles.get(storage.id)
    const rate = storage.targetPerSecond
    const source = role === 'source'
    const buffer = role === 'buffer'
    const reading = report.storages[storage.id]
    const actual = reading ? source ? reading.consumedPerSecond : reading.producedPerSecond : undefined
    const rule = storageTargetMode(storage, role)
    if (source && actual !== undefined && actual > 0) summary.externalInputs.push({ source: 'source-storage', storageId: storage.id, resourceKey: `${storage.kind}:${storage.resourceId}`, perSecond: actual, rule, ...(rate !== undefined ? { limit: Math.abs(rate) } : {}) })
    if (!source && !buffer && actual !== undefined && actual > 0) summary.externalOutputs.push({ source: 'drain-storage', storageId: storage.id, resourceKey: `${storage.kind}:${storage.resourceId}`, perSecond: actual, drainMode: storage.drainMode ?? 'product' })
    if (!planning || role !== 'source' && role !== 'product' || !hasStorageTarget(storage, role) || rate === undefined) continue
    const goal: GoalAssessment = { ownerId: storage.id, rule, target: Math.abs(rate), actual, resourceKey: `${storage.kind}:${storage.resourceId}`,
      met: !unmet.has(storage.id) && !reading?.targetUnreachable && meets(rule, actual, Math.abs(rate)) }
    summary.goals.push(goal)
  }
  for (const node of project.nodes) {
    const sectionIds = [node.id, ...(node.extraRecipes ?? []).map((_, index) => `${node.id}#r${index + 1}`)]
    const readings = sectionIds.flatMap(id => report.nodes[id] ? [report.nodes[id]] : [])
    const fractionalMachines = readings.reduce((sum, row) => sum + Math.max(0, row.theoreticalMachinesRequired), 0)
    const capacity = planning ? node.solvePin : node.machineCount
    const buildMachines = fractionalMachines > 0 ? Math.max(1, Math.ceil(fractionalMachines - EPS)) : 0
    // Plan/Solve rewrite flow/EU fields at solved scale and use utilization 1 for running
    // rows. Build leaves them at nameplate: multiply by utilization exactly once in either mode.
    const averageEuT = readings.reduce((sum, row) => sum + row.euT * Math.max(0, row.utilization), 0)
    const energy: MachineEnergyAssessment = { sections: [], averageEuT, buildPeakEuT: 0, averageSteamMbPerSecond: 0, buildPeakSteamMbPerSecond: 0 }
    for (const [index, id] of sectionIds.entries()) {
      const recipe = recipes.get(index ? node.extraRecipes?.[index - 1]?.recipeId ?? '' : node.recipeId)
      const row = report.nodes[id]
      if (!recipe || !row) continue
      const power = getNodePowerReport(recipe, node)
      const requestedTier = overclockTierIndex(node.overclockTier)
      const usesOverclockTier = !power.isMultiblock || (!power.typedBudget && node.hatchVoltageTier === undefined && node.powerInputMode !== 'eut')
      if (usesOverclockTier && requestedTier >= 0 && tierIndex(power.tier) > requestedTier) {
        summary.issues.push({ severity: 'warning', code: 'TIER_RAISED', recipeId: recipe.id, nodeId: id,
          message: `Node ${id} requests ${node.overclockTier}. The native calculation runs this recipe at ${power.tier}.` })
      }
      const steam = getNodeSteamReport(recipe, node)
      // The original throughput loop multiplies the machine rule by the card's parallel;
      // energy-hatch and machine-specific maths stay entirely in the native reports.
      const perMachineRunningEuT = power.drawEuT * node.parallel
      const perMachineSteamMbPerSecond = (steam?.drawSteamPerTick ?? 0) * 20 * node.parallel
      energy.sections.push({ nodeId: id, power, ...(steam ? { steam } : {}), cardParallel: node.parallel, perMachineRunningEuT, perMachineSteamMbPerSecond })
      energy.buildPeakEuT = Math.max(energy.buildPeakEuT, perMachineRunningEuT * buildMachines)
      energy.buildPeakSteamMbPerSecond = Math.max(energy.buildPeakSteamMbPerSecond, perMachineSteamMbPerSecond * buildMachines)
      const activeMachines = planning ? row.theoreticalMachinesRequired : node.machineCount * Math.max(0, row.utilization)
      energy.averageSteamMbPerSecond += perMachineSteamMbPerSecond * activeMachines
    }
    summary.averageEuT += averageEuT; summary.buildPeakEuT += energy.buildPeakEuT
    summary.averageSteamMbPerSecond += energy.averageSteamMbPerSecond; summary.buildPeakSteamMbPerSecond += energy.buildPeakSteamMbPerSecond
    if (energy.averageSteamMbPerSecond > 0) summary.externalInputs.push({ source: 'machine-steam', nodeId: node.id, resourceKey: 'fluid:steam', perSecond: energy.averageSteamMbPerSecond, note: 'Native steam operating requirement, separate from recipe wires; provide steam supply.' })
    summary.machines.push({ nodeId: node.id, sections: sectionIds, fractionalMachines, buildMachines, shared: sectionIds.length > 1,
      ...(capacity !== undefined ? { capacity } : {}), capacityExceeded: capacity !== undefined && fractionalMachines > capacity + EPS * Math.max(1, capacity),
      euT: averageEuT, energy,
    })
    for (const [handle, target] of Object.entries(project.planMode ? node.portRates ?? {} : {})) {
      const match = /^r(\d+):(.*)$/.exec(handle)
      const section = match ? Number(match[1]) : 0
      const bare = match?.[2] ?? handle
      const row = report.nodes[section ? `${node.id}#r${section}` : node.id]
      const flows = row ? bare.startsWith('input:') ? row.inputs : row.outputs : undefined
      const flow = flows && Object.values(flows).find(flow => portHandle(bare.startsWith('input:') ? 'input' : 'output', flow.kind, flow.resourceId) === bare)
      const actual = flow && row ? flow.amountPerSecond * Math.max(0, row.utilization) : undefined
      summary.goals.push({ ownerId: `${node.id}:${handle}`, rule: 'exact', target, actual, met: meets('exact', actual, target), resourceKey: flow?.key })
    }
    // Old Solve/Build projects use this field; plan mode ignores it (adapter warns).
    if (node.targetOutput && !project.planMode) {
      const target = node.targetOutput
      const row = report.nodes[node.id]
      const key = `${target.kind}:${target.resourceId}` as const
      const actual = row?.outputs[key] ? row.outputs[key].amountPerSecond * Math.max(0, row.utilization) : undefined
      summary.goals.push({ ownerId: node.id, rule: 'at-least', target: target.amountPerSecond, actual, met: meets('at-least', actual, target.amountPerSecond), resourceKey: key })
    }
  }
  if (project.targetRate) {
    const target = project.targetRate
    const key = `${target.kind}:${target.resourceId}` as const
    const actual = report.resources[key]?.producedPerSecond
    summary.goals.push({ ownerId: project.id, rule: 'at-least', target: target.amountPerSecond, actual, met: meets('at-least', actual, target.amountPerSecond), resourceKey: key })
  }
  summary.assumptions.push('averageEuT is load-weighted actual average. Native totalEuT is preserved unchanged (Build mode uses nameplate totals); it is not always the average. Each energy section retains the original voltage/amps/hatches and full-speed draw.')
  summary.assumptions.push('buildPeakEuT and buildPeakSteamMbPerSecond are the sum of integer-build full-speed requirements; a shared card uses the largest section draw, not the sum of its time-shared recipes. Actual scheduling may reduce simultaneous peak. Zero EU/t on a steam machine does not mean free energy.')
  if (project.recipes.some(r => r.outputs.some(o => (o.chance ?? 1) < 1))) summary.assumptions.push('Probabilistic outputs are expected long-run rates. Integer machine rounding does not guarantee completion of a finite batch or eliminate variance.')
  if (project.recipes.some(r => r.inputs.some(i => i.consumed === false || i.amount === 0))) summary.assumptions.push('Nonconsumed count-zero circuits, molds and catalysts are preparation conditions, not continuous consumption. Install the required item/settings before starting.')
  if (context.provenance?.some(p => p.status !== 'local-current')) summary.assumptions.push('Some recipes are declared/unverified or explicitly stale saved snapshots; these are assumptions, not a match with current local packdata.')
  for (const bottleneck of report.bottlenecks ?? []) summary.issues.push({ severity: 'warning', code: 'NATIVE_BOTTLENECK', message: bottleneck.message, nodeId: bottleneck.nodeId })
  for (const node of Object.values(report.nodes)) for (const warning of node.warnings ?? []) summary.issues.push({ severity: 'warning', code: 'NATIVE_MACHINE_WARNING', message: warning, nodeId: node.nodeId })
  if (plan?.alternativesComplete === false) summary.issues.push({ severity: 'warning', code: 'INCOMPLETE_ALTERNATIVES', message: 'Native alternatives search stopped early; the displayed alternative choices are incomplete.' })
  if (plan?.notes.some(note => note.message === 'PIN_DROPPED')) summary.issues.push({ severity: 'warning', code: 'PIN_DROPPED', message: 'Native solver dropped a pin. Inspect the unchanged plan.notes and target/capacity readouts before accepting this result.' })
  const failure = plan?.failure?.message
  if (summary.issues.some(issue => issue.severity === 'error')) summary.status = 'invalid'
  else if (report.stale) summary.status = 'failed'
  else if (failure === 'NO_PIN' || (plan?.unanchored.length ?? 0) > 0) summary.status = 'unanchored'
  else if (failure) summary.status = failure === 'SOLVER_UNSATISFIABLE' || failure === 'BALANCE_FAILED' || failure === 'PIN_CONFLICT' ? 'infeasible' : 'failed'
  else if (summary.goals.some(goal => !goal.met) || unmet.size || summary.shortfalls.length || summary.machines.some(m => m.capacityExceeded) || Object.values(report.nodes).some(n => n.powerStalled || n.status === 'missing-recipe')) summary.status = 'unmet'
  else if (forcedFlows.length) summary.status = 'requires-forced-flow'
  else if (summary.externalInputs.length) summary.status = 'needs-external-supply'
  else summary.status = 'satisfied'
  return summary
}
