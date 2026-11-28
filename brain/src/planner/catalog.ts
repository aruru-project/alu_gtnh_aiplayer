import fs from 'node:fs'
import type { Recipe as LocalRecipe } from '../packdata/recipes.ts'
import type { FactoryNode, MachineConfigControl, MachineHandler, MachineOption, PlannerIssue, Recipe } from './model.ts'
// Pure upstream functions only. No solver or game-world access occurs in describe.
import * as native from '../../vendor/gtnh-planner/dist/catalog.mjs'

export const CATALOG_VERSION = 'gtnh-factory-flow@e493e36a64d5a226e6110fab8a765ae08c3bf7c5+gtnh-planner-mod@69dd09fe21117d7b8558625dc9556723873942ca'
interface Template {
  id: string; label: string; kind: MachineHandler['kind']; primary?: boolean
  minimumTier?: string; maximumTier?: string; availableTiers?: string[]; perfectOverclock?: boolean
  durationMultiplier?: number; eutMultiplier?: number; durationTicks?: number; eut?: number; controls?: string[]; items?: string[]
}
interface AppHandler { id: string; label: string; machineType: string; kind: MachineHandler['kind']; multiblock: boolean; table?: string; items?: string[] }
interface MapEntry { id: string; name: string; handlersOnRecipes: boolean; handlers?: Template[]; app?: AppHandler[]; controls?: string[]; coilFromSpecialValue?: boolean }
interface CompactControl extends Omit<MachineConfigControl, 'tiers'> {
  tiers: Array<Omit<MachineConfigControl['tiers'][number], 'resource'> & { icon?: string; name?: string }>
}
interface CatalogData { tiers: string[]; recipeTiers: [string, number][]; coils: { key: string; heat: number }[]; controls: Record<string, CompactControl>; maps: MapEntry[] }
const data = JSON.parse(fs.readFileSync(new URL('../../vendor/gtnh-planner/mod/handlers.json', import.meta.url), 'utf8')) as CatalogData
const maps = new Map(data.maps.map(map => [map.id, map]))

export function recipeMapFor(handlerKey: string): MapEntry | undefined {
  // Original mod WebCards.entry aliases its current GT++ map ids to the website export.
  return maps.get(handlerKey) ?? (handlerKey === 'gt.recipe.industrialcokeoven' ? maps.get('gtpp.recipe.cokeoven')
    : handlerKey.startsWith('gt.recipe.') ? maps.get(`gtpp.recipe.${handlerKey.slice(10)}`) : undefined)
}
export function tierIndex(tier: string | undefined): number {
  return data.tiers.indexOf(tier ?? '')
}

// The native reader accepts OpV as the legacy spelling of UXV for overclock settings.
export function overclockTierIndex(tier: string): number {
  return tierIndex(tier === 'OpV' ? 'UXV' : tier)
}
function recipeMinimumTier(eut: number): string { return data.recipeTiers.find(([, voltage]) => Math.abs(eut) <= voltage)?.[0] ?? 'MAX' }
function control(ref: string): MachineConfigControl {
  const c = data.controls[ref]
  if (!c) throw new Error(`Fixed machine catalog references missing control ${ref}`)
  return { ...c, tiers: c.tiers.map(({ icon, name, ...tier }) => ({ ...tier, resource: { kind: 'item', id: icon ?? `factoryflow:machine_config/${c.id}_${tier.key}`, amount: 1, displayName: name ?? tier.label } })) }
}

/** Compact catalog hydration follows original mod HandlerData.java, not a generic machine multiplier. */
export function machineOptionsFor(local: LocalRecipe, recipe: Recipe): MachineOption[] {
  const map = recipeMapFor(local.handler.key)
  if (!map) return []
  const minimumTier = recipeMinimumTier(recipe.eut)
  const controls = (map.controls ?? []).map(control)
  if (map.coilFromSpecialValue && (local.special ?? 0) > 0) {
    const coil = data.coils.find(c => c.heat >= local.special!) ?? data.coils.at(-1)
    for (const c of controls) if (c.id === 'heatingCoil' && coil) c.minimumKey = c.defaultKey = coil.key
  }
  recipe.minimumTier = minimumTier
  recipe.machineConfigControls = controls
  recipe.machineHandlers = map.handlersOnRecipes ? (map.handlers ?? []).map((template): MachineHandler => {
    const index = Math.max(tierIndex(template.minimumTier), tierIndex(minimumTier))
    const own = template.controls?.map(control)
    return {
      id: template.id, label: template.label, machineType: template.label, kind: template.kind,
      minimumTier: index >= 0 ? data.tiers[index] : minimumTier,
      ...(template.maximumTier ? { maximumTier: template.maximumTier } : {}),
      ...(template.availableTiers ? { availableTiers: template.availableTiers } : {}),
      ...(template.durationMultiplier !== undefined ? { durationTicks: Math.max(1, Math.round(recipe.durationTicks * template.durationMultiplier)) } : {}),
      ...(template.eutMultiplier !== undefined ? { eut: Math.max(0, Math.round(recipe.eut * template.eutMultiplier * 100) / 100) } : {}),
      ...(template.durationTicks !== undefined ? { durationTicks: Math.max(1, Math.round(template.durationTicks)) } : {}),
      ...(template.eut !== undefined ? { eut: Math.max(0, template.eut) } : {}),
      ...(template.perfectOverclock ? { perfectOverclock: true } : {}),
      ...(own ? { machineConfigControls: [...own, ...controls.filter(c => !own.some(o => o.id === c.id))] } : {}),
    }
  }) : undefined
  const handlers = native.getRecipeMachineHandlers(recipe) as MachineHandler[]
  return handlers.map(handler => {
    const selected = { machineHandlerId: handler.id }
    const effective = native.applyMachineHandlerToRecipe({ ...recipe, machineHandlers: handlers }, selected) as Recipe
    const configs = native.getRecipeMachineConfigTierControls(effective, {})
    const coil = native.getRecipeCoilTierControl(effective, {})
    const resolved = [...configs, ...(coil ? [coil] : [])]
    const app = map.app?.find(app => app.id === handler.id)
    const template = map.handlers?.find(t => t.id === handler.id)
    const missing: string[] = []
    if (map.name === 'Fusion Reactor') missing.push('Local export lacks fusionStartupEu (FUSION_THRESHOLD). A foreign startup lookup is not a verified local threshold.')
    if (map.name === 'Bacterial Vat') missing.push('Local export lacks culture NBT and per-recipe glass/radiation requirements. Native vat fallback requirements cannot be treated as verified local metadata.')
    if (!app) missing.push(`No original app profile metadata for handler ${handler.id}.`)
    if (app?.multiblock && !app.table && template?.durationMultiplier === undefined && template?.eutMultiplier === undefined && !template?.perfectOverclock && !template?.controls?.length) missing.push(`Multiblock ${handler.id} has no confirmed machine-table rule or exported processing coefficients.`)
    const originalControls = [...handler.machineConfigControls ?? recipe.machineConfigControls ?? [], ...native.getMachineTableControls(handler.machineType, recipe) as MachineConfigControl[]]
    const settings: MachineConfigControl[] = resolved.map(c => ({
      id: c.id, label: c.label, minimumKey: c.minimum.key, defaultKey: c.current.key,
      ...(c.numeric ? { numeric: c.numeric } : {}), tiers: c.tiers,
    }))
    // The native resolver falls back to a coil when a heat requirement is beyond its ladder. Surface the unmet requirement.
    for (const c of originalControls) {
      if ((c.minimumHeatFromSpecialValue || map.coilFromSpecialValue && c.id === 'heatingCoil') && (local.special ?? 0) > 0 && !c.tiers.some(t => (t.heat ?? data.coils.find(coil => coil.key === t.key)?.heat ?? 0) >= local.special!)) missing.push(`${c.id} has no tier meeting specialValue ${local.special}.`)
      if (c.minimumFromSpecialValue && (local.special ?? 0) > c.tiers.length) missing.push(`${c.id} ladder does not reach specialValue ${local.special}.`)
    }
    const overclockTier = handler.availableTiers?.find(t => tierIndex(t) >= tierIndex(effective.minimumTier)) ?? effective.minimumTier
    if (handler.maximumTier && tierIndex(effective.minimumTier) > tierIndex(handler.maximumTier)) missing.push(`Recipe requires ${effective.minimumTier}, above ${handler.maximumTier} for ${handler.id}.`)
    return {
      handler, items: app?.items ?? template?.items ?? [], supported: missing.length === 0, missing, controls: settings,
      defaults: { machineHandlerId: handler.id, overclockTier, parallel: 1,
        ...(handler.kind === 'multiblock' || app?.multiblock ? { energyHatches: 1 } : {}),
        ...(coil ? { coilTier: coil.current.key } : {}),
        ...(configs.length ? { machineConfigTiers: Object.fromEntries(configs.map(c => [c.id, c.current.key])) } : {}),
      },
    }
  })
}

/** Resolve physical settings exactly as each native recipe section does; no max-tier or common-default guessing. */
export function resolvedMachineSettings(recipe: Recipe, node: FactoryNode): {
  runTier: string; coilTier: string | undefined; machineConfigTiers: Record<string, string>
} {
  const effective = native.applyMachineHandlerToRecipe(recipe, node)
  return {
    runTier: native.getNodeRunTier(effective, node),
    coilTier: native.getRecipeCoilTierControl(effective, node)?.current.key,
    machineConfigTiers: Object.fromEntries(native.getRecipeMachineConfigTierControls(effective, node).map(control => [control.id, control.current.key])),
  }
}

export function validateMachineSettings(recipe: Recipe, node: FactoryNode): PlannerIssue[] {
  const issues: PlannerIssue[] = []
  const add = (code: string, message: string) => issues.push({ severity: 'error' as const, code, message, recipeId: recipe.id, nodeId: node.id })
  const binding = recipe.metadata?.localBinding as { snapshot?: Omit<LocalRecipe, 'ref'> } | undefined
  if (!binding?.snapshot) return issues
  const copy = structuredClone(recipe)
  // Only read the fixed catalog to validate the chosen profile; never mutate the supplied graph.
  const options = machineOptionsFor({ ...binding.snapshot, ref: 0 }, copy)
  const selected = node.machineHandlerId ? options.find(o => o.handler.id === node.machineHandlerId) : options[0]
  if (!selected) { add('UNKNOWN_MACHINE_HANDLER', `Machine handler ${node.machineHandlerId} is not in the original map catalog.`); return issues }
  if (!selected.supported) add('MISSING_MACHINE_METADATA', selected.missing.join('; '))
  const tier = overclockTierIndex(node.overclockTier)
  if (tier < 0 || selected.handler.maximumTier && tier > tierIndex(selected.handler.maximumTier) || selected.handler.availableTiers && !selected.handler.availableTiers.some(t => tierIndex(t) === tier)) add('INVALID_MACHINE_TIER', `Tier ${node.overclockTier} is not a registered tier for ${selected.handler.id}.`)
  for (const [id, key] of Object.entries({ ...node.machineConfigTiers, ...(node.coilTier ? { heatingCoil: node.coilTier } : {}) })) {
    const c = selected.controls.find(c => c.id === id)
    if (!c) { add('UNKNOWN_MACHINE_SETTING', `Unknown or hidden setting ${id} for ${selected.handler.id}.`); continue }
    if (c.numeric) {
      const value = Number(key)
      const step = c.numeric.step ?? 1
      if (!Number.isFinite(value) || value < c.numeric.min || c.numeric.max !== undefined && value > c.numeric.max || Math.abs(value / step - Math.round(value / step)) > 1e-7) add('INVALID_MACHINE_SETTING', `${id}=${key} is outside its native numeric range/step.`)
    } else if (!c.tiers.some(t => t.key === key)) add('INVALID_MACHINE_SETTING', `${id}=${key} is not an allowed native key at this recipe's minimum.`)
  }
  if (node.energyHatches !== undefined && (!Number.isInteger(node.energyHatches) || node.energyHatches < 1)) add('INVALID_HATCH_COUNT', 'energyHatches must be a positive integer.')
  return issues
}
