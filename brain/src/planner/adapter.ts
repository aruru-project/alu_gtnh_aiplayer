import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { PackData } from '../packdata/index.ts'
import { ANY_META, CIRCUIT_ID } from '../packdata/recipes.ts'
import type { Recipe as LocalRecipe, RecipeSlot } from '../packdata/recipes.ts'
import { isRecord } from '../util.ts'
import { resourceMatchesInput, canonicalizeResourceHandleId, getRecipeMachineHandlers } from '../../vendor/gtnh-planner/dist/catalog.mjs'
import { CATALOG_VERSION, machineOptionsFor, overclockTierIndex, recipeMapFor, resolvedMachineSettings, tierIndex, validateMachineSettings } from './catalog.ts'
import type {
  DescribeOptions, DescribeResult, DescribedRecipe, FactoryProject, FactoryNode, LocalRecipeBinding,
  PlannerIssue, PrepareOptions, PreparedProject, Recipe, RecipeInput, RecipePort, RecipeProvenance, ResourceAmount,
} from './model.ts'

/** Stable JSON hashing: object key order is not identity; array/slot order is. */
export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical)
    : isRecord(v) ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

const datasetCache = new Map<string, { stamp: string; digest: string; offsets: Uint32Array; lengths: Uint32Array }>()
/** Hash the actual files, not the directory name, line ref or translated labels. Recheck stat on every solve. */
function datasetFingerprint(packdata: PackData): string {
  const files = ['meta.json', 'handlers.json', 'recipes.jsonl'].map(name => path.join(packdata.dir, name))
  const stamp = files.map(file => {
    try { const s = fs.statSync(file); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` }
    catch { return 'missing' }
  }).join('|')
  const cached = datasetCache.get(packdata.dir)
  if (cached?.stamp === stamp) return cached.digest
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(1024 * 1024)
  const offsets: number[] = []; const lengths: number[] = []
  files.forEach((file, index) => {
    hash.update(`${index}:`)
    let fd: number
    try { fd = fs.openSync(file, 'r') } catch { hash.update('missing'); return }
    try {
      let n: number; let position = 0; let start = 0
      while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        hash.update(buffer.subarray(0, n))
        if (index === 2) {
          let at = 0
          for (;;) {
            const end = buffer.indexOf(10, at)
            if (end < 0 || end >= n) break
            const length = position + end - start
            if (length > 0) { offsets.push(start); lengths.push(length) }
            start = position + end + 1; at = end + 1
          }
        }
        position += n
      }
      if (index === 2 && start < position) { offsets.push(start); lengths.push(position - start) }
    } finally { fs.closeSync(fd) }
  })
  const digest = hash.digest('hex')
  datasetCache.set(packdata.dir, { stamp, digest, offsets: Uint32Array.from(offsets), lengths: Uint32Array.from(lengths) })
  return digest
}

function localSnapshot(packdata: PackData, local: LocalRecipe): LocalRecipeBinding['snapshot'] {
  datasetFingerprint(packdata)
  const index = datasetCache.get(packdata.dir)!
  const bytes = Buffer.alloc(index.lengths[local.ref] ?? 0)
  const fd = fs.openSync(path.join(packdata.dir, 'recipes.jsonl'), 'r')
  try { fs.readSync(fd, bytes, 0, bytes.length, index.offsets[local.ref]) } finally { fs.closeSync(fd) }
  const raw: unknown = JSON.parse(bytes.toString('utf8'))
  if (!isRecord(raw)) throw new Error(`Local recipe ref ${local.ref} is not an exported JSON object.`)
  const { ref: _ref, ...snapshot } = local
  return { ...snapshot, raw }
}

/** Upstream's item id spelling: bare id is meta 0, @32767 is wildcard damage. */
export function itemResourceId(id: string, meta: number): string { return meta === 0 ? id : `${id}@${meta}` }
export function portHandle(side: 'input' | 'output', kind: string, id: string): string { return `${side}:${kind}:${encodeURIComponent(id)}` }

function slotInput(slot: RecipeSlot, packdata: PackData): RecipeInput {
  // Native schema requires positive amounts even for tools. One installed item, consumed:false;
  // the exact exported n:0 remains in localSlot and the signed snapshot.
  const base = { kind: 'item' as const, amount: slot.n === 0 ? 1 : slot.n, consumed: slot.n !== 0 }
  if (slot.kind === 'item') return { ...base, id: itemResourceId(slot.id, slot.meta), displayName: packdata.items?.get(slot.id, slot.meta)?.en ?? slot.id }
  return {
    ...base,
    id: slot.kind === 'ore' ? `oredict:${slot.ore}` : `any:${fingerprint({ any: slot.any, more: slot.more })}`,
    displayName: slot.kind === 'ore' ? `Ore Dictionary: ${slot.ore}` : 'Any listed alternative',
    alternatives: slot.any.map(([id, meta]) => ({ kind: 'item', id: itemResourceId(id, meta), displayName: packdata.items?.get(id, meta)?.en ?? id })),
  }
}

export function recipePorts(recipe: Recipe): RecipePort[] {
  return (['input', 'output'] as const).flatMap(side => (side === 'input' ? recipe.inputs : recipe.outputs).map((slot, index): RecipePort => ({
    side, index, handle: portHandle(side, slot.kind, slot.id), kind: slot.kind, resourceId: slot.id,
    amount: slot.amount, chance: 'chance' in slot && typeof slot.chance === 'number' ? slot.chance : 1,
    consumed: side === 'output' || !('consumed' in slot) || slot.consumed !== false,
    unit: slot.kind === 'fluid' ? 'mB/craft' : slot.kind === 'item' ? 'item/craft' : slot.kind === 'power' ? 'EU/craft' : 'aspect/craft',
    ...(slot.alternatives ? { alternatives: slot.alternatives } : {}),
  })))
}

function nativeFingerprint(recipe: Recipe): string {
  const { localBinding: _binding, ...metadata } = recipe.metadata ?? {}
  return fingerprint({ ...recipe, metadata })
}

function describeOne(packdata: PackData, local: LocalRecipe, options: DescribeOptions, dataset: string): DescribedRecipe {
  const ref = local.ref
  const snapshot = localSnapshot(packdata, local)
  const digest = fingerprint(snapshot)
  const id = `local:${digest}`
  const issues: PlannerIssue[] = []
  const add = (severity: PlannerIssue['severity'], code: string, message: string) => issues.push({ severity, code, message, recipeId: id })
  const map = recipeMapFor(local.handler.key)
  // NeiExport omits a GT mSpecialValue of zero. This is an observed zero, not missing metadata.
  const special = local.special ?? (local.handler.gregtech ? 0 : undefined)
  if (!local.handler.gregtech || !Number.isInteger(local.ticks) || (local.ticks ?? 0) <= 0 || !Number.isFinite(local.eut) || (local.eut ?? 0) < 0) {
    add('error', 'MISSING_RECIPE_MATH', 'The local export has no complete positive durationTicks and EU/t baseline for this recipe. No generic speed is assumed.')
  }
  if (!map) add('error', 'MISSING_MACHINE_MAP', `No authoritative machine map for local handler ${local.handler.key}.`)
  // NeiExport.stack writes name only for a tagged stack whose name differs from the
  // canonical item table. Handler/fluid/item-table names are ordinary labels, not this signal.
  const instanced = [...local.in.filter((s): s is Extract<RecipeSlot, { kind: 'item' }> => s.kind === 'item'), ...local.out].filter(s => {
    if (!s.name) return false
    const known = packdata.items?.get(s.id, s.meta)
    return s.name !== known?.name && s.name !== known?.en
  })
  if (instanced.length) add('error', 'MISSING_ITEM_INSTANCE_DATA', `Exported per-stack names identify NBT-distinct instances but the NBT identity/matching data is absent: ${instanced.map(s => `${itemResourceId(s.id, s.meta)} (${s.name})`).join(', ')}. They cannot be verified as one registry/meta resource. Keep the snapshot; removing metadata.localBinding explicitly declares an unverified assumption instead.`)
  const rawOutputs = Array.isArray(snapshot.raw.out) ? snapshot.raw.out : []
  if (rawOutputs.some(o => !isRecord(o) || typeof o.id !== 'string')) add('error', 'UNSUPPORTED_OUTPUT_VARIANTS', 'Some exported outputs are choice groups rather than concrete stacks. Their full raw data is retained; a native output cannot be guessed.')
  const recipe: Recipe = {
    id, name: `${map?.name ?? local.handler.key} / ${digest.slice(0, 12)}`,
    kind: local.handler.gregtech ? 'gregtech_machine' : 'unknown',
    machineType: map?.name ?? local.handler.key, minimumTier: 'ULV',
    durationTicks: local.ticks ?? 0, eut: local.eut ?? 0,
    inputs: [...local.in.map(slot => slotInput(slot, packdata)), ...local.fin.map(fluid => ({ kind: 'fluid' as const, id: fluid.f, amount: fluid.mb, displayName: fluid.f }))],
    outputs: [...local.out.map((stack, index) => {
      const raw = rawOutputs[index]
      const chance = isRecord(raw) && typeof raw.chance === 'number' ? raw.chance : stack.chance
      return { kind: 'item' as const, id: itemResourceId(stack.id, stack.meta), amount: stack.n,
        displayName: packdata.items?.get(stack.id, stack.meta)?.en ?? stack.id, ...(chance !== undefined ? { chance } : {}) }
    }),
    ...local.fout.map(fluid => ({ kind: 'fluid' as const, id: fluid.f, amount: fluid.mb, displayName: fluid.f }))],
    ...(special !== undefined ? { specialValue: special, nei: { additionalInfo: [`Special value: ${special}`] } } : {}),
    source: { recipeMap: map?.name ?? local.handler.key, rawRecipeId: String(ref), sourceIdentifier: local.handler.key, exporter: 'unknown' },
    metadata: { localHandler: local.handler.key, localFake: local.fake === true },
  }
  const circuit = local.in.filter((s): s is Extract<RecipeSlot, { kind: 'item' }> => s.kind === 'item' && s.id === CIRCUIT_ID && s.n === 0)
  if (circuit.length === 1) recipe.programmedCircuit = String(circuit[0].meta)
  const machineOptions = machineOptionsFor(local, recipe)
  recipe.machineHandlers = machineOptions.map(option => option.handler)
  const selected = options.machineHandlerId ? machineOptions.find(option => option.handler.id === options.machineHandlerId) : machineOptions[0]
  if (!selected) add('error', 'MISSING_MACHINE_PROFILE', options.machineHandlerId ? `Machine handler ${options.machineHandlerId} is not available for this map.` : 'No usable original machine profile is available.')
  else if (!selected.supported) add('error', 'MISSING_MACHINE_METADATA', selected.missing.join('; '))
  if (local.fake) add('warning', 'DISPLAY_RECIPE', 'Local fake:true is an NEI display recipe: the real machine uses special matching/processing logic. This is a static baseline, not confirmation that it can run unchanged.')
  if (local.in.some(slot => slot.kind !== 'item' || slot.meta === ANY_META)) add('warning', 'EQUIVALENCE_CLASS', 'Unselected ore/candidate/wildcard inputs remain explicit equivalence classes. Connect compatible resources or use native recipeInputOverrides; no candidate has been chosen for you.')
  if (local.in.some(slot => slot.kind !== 'item' && slot.more > 0)) add('warning', 'INCOMPLETE_CANDIDATES', 'The local exporter truncated some candidate lists (more > 0). The complete ore/candidate identity and exported candidates are retained; missing candidates are not guessed.')
  if (recipe.outputs.some(stack => (stack.chance ?? 1) < 1)) add('warning', 'EXPECTED_OUTPUT', 'Chanced outputs are long-run expectations (amount × chance), not a guarantee that a short batch will yield them.')
  const ports = recipePorts(recipe)
  ports.forEach(port => { port.localSlot = port.side === 'input' ? [...local.in, ...local.fin][port.index] : [...local.out, ...local.fout][port.index] })
  if (new Set(ports.map(p => p.handle)).size !== ports.length) add('info', 'AGGREGATED_PORTS', 'Native flow rows aggregate slots with the same kind/id. Repeated handles below deliberately name the same summed row; original slot indices remain in the snapshot.')
  add('info', 'STATIC_MACHINE_DEFAULTS', 'Machine/config defaults are the original planner defaults, not machines, hatches, coils or supplies observed in the world.')
  const binding: LocalRecipeBinding = { version: 1, ref, fingerprint: digest, datasetFingerprint: dataset, catalogVersion: CATALOG_VERSION, snapshot, nativeFingerprint: nativeFingerprint(recipe) }
  recipe.metadata!.localBinding = binding
  const nodeTemplate: FactoryNode = { id: `node-${digest.slice(0, 12)}`, recipeId: id, machineCount: 1, parallel: 1,
    overclockTier: recipe.minimumTier, enabled: true, position: { x: 0, y: 0 }, ...selected?.defaults }
  return { ref, recipe, nodeTemplate, ports, prerequisites: ports.filter(p => p.side === 'input' && !p.consumed),
    provenance: { recipeId: id, status: 'local-current', binding }, machineOptions, issues }
}

export function describeRecipes(packdata: PackData | undefined, refs: readonly number[], options: DescribeOptions = {}): DescribeResult {
  const result: DescribeResult = { recipes: [], issues: [], catalogVersion: CATALOG_VERSION }
  if (!packdata?.recipes) { result.issues.push({ severity: 'error', code: 'NO_LOCAL_RECIPES', message: 'Local packdata recipes are not loaded.' }); return result }
  if (!packdata.recipes.isSourceCurrent()) { result.issues.push({ severity: 'error', code: 'PACKDATA_RELOAD_REQUIRED', message: 'Recipe export files changed since RecipeBook was loaded. Restart/reload packdata before describing local bindings; no hot reload is performed.' }); return result }
  const dataset = datasetFingerprint(packdata)
  for (const ref of refs) {
    const local = packdata.recipes.get(ref)
    if (!local) { result.issues.push({ severity: 'error', code: 'RECIPE_NOT_FOUND', message: `No local recipe at ref ${ref}.` }); continue }
    const described = describeOne(packdata, local, options, dataset)
    result.recipes.push(described)
    result.issues.push(...described.issues)
  }
  return result
}

function finiteJson(value: unknown, issues: PlannerIssue[], at = '$', seen = new Set<object>()): void {
  if (typeof value === 'number' && !Number.isFinite(value)) issues.push({ severity: 'error', code: 'NON_FINITE_NUMBER', message: 'JSON numeric values must be finite.', path: at })
  if (value && typeof value === 'object') {
    if (seen.has(value)) { issues.push({ severity: 'error', code: 'CYCLIC_JSON', message: 'Project must be acyclic JSON.', path: at }); return }
    seen.add(value)
    for (const [key, child] of Object.entries(value)) finiteJson(child, issues, `${at}.${key}`, seen)
    seen.delete(value)
  }
}
const kinds = new Set(['item', 'fluid', 'aspect', 'power'])
function validResource(v: unknown): boolean { return isRecord(v) && kinds.has(String(v.kind)) && typeof v.id === 'string' && typeof v.amount === 'number' && v.amount >= 0 }
function compatible(resource: Pick<ResourceAmount, 'kind' | 'id'>, input: Pick<ResourceAmount, 'kind' | 'id' | 'alternatives'>): boolean {
  return resourceMatchesInput(resource, input)
}
function bindingOf(recipe: Recipe): LocalRecipeBinding | undefined {
  const b = recipe.metadata?.localBinding
  return isRecord(b) && b.version === 1 && typeof b.ref === 'number' && typeof b.fingerprint === 'string' && typeof b.datasetFingerprint === 'string' && typeof b.nativeFingerprint === 'string' && isRecord(b.snapshot) ? b as unknown as LocalRecipeBinding : undefined
}

/** Validation and provenance only: never silently changes pins, wires, recipes, groups or settings. */
export function prepareProject(packdata: PackData | undefined, value: unknown, options: PrepareOptions = {}): PreparedProject {
  const issues: PlannerIssue[] = []
  const provenance: RecipeProvenance[] = []
  const project = value as FactoryProject
  const result: PreparedProject = { project, provenance, issues }
  const error = (code: string, message: string, at?: string) => issues.push({ severity: 'error', code, message, path: at })
  finiteJson(value, issues)
  if (issues.some(i => i.severity === 'error')) return result
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.name !== 'string' || !Array.isArray(value.recipes) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.fuelProfiles) || (value.storages !== undefined && !Array.isArray(value.storages))) {
    error('INVALID_PROJECT', 'Expected native FactoryProject schemaVersion:1 with id/name, recipes/nodes/edges/fuelProfiles arrays and optional storages array.'); return result
  }
  const ids = (entries: unknown[], label: string) => {
    const used = new Set<string>()
    entries.forEach((entry, i) => {
      if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || used.has(entry.id)) error('INVALID_ID', `${label} ids must be nonempty and unique.`, `${label}[${i}]`)
      else {
        used.add(entry.id)
        if (['__proto__', 'constructor', 'prototype'].includes(entry.id) || label === 'nodes/storages' && (/^(?:hatch-supply:|pool:|pool-tank:)/.test(entry.id) || /#r\d+$|[|\u0000-\u001f]/.test(entry.id)) || label === 'edges' && (/^(?:pool-edge:|hatch-supply:|boundary-edge-)/.test(entry.id) || entry.id.includes('>'))) error('RESERVED_GRAPH_ID', `${entry.id} is reserved for native expanded/hidden graph entities. Choose another user entity id.`, `${label}[${i}]`)
      }
    })
  }
  ids(project.recipes, 'recipes'); ids([...project.nodes, ...(project.storages ?? [])], 'nodes/storages'); ids(project.edges, 'edges')
  for (const [i, recipe] of project.recipes.entries()) {
    if (!isRecord(recipe) || typeof recipe.name !== 'string' || typeof recipe.machineType !== 'string' || typeof recipe.minimumTier !== 'string' || typeof recipe.durationTicks !== 'number' || recipe.durationTicks <= 0 || typeof recipe.eut !== 'number' || !Array.isArray(recipe.inputs) || !Array.isArray(recipe.outputs) || !recipe.inputs.every(validResource) || !recipe.outputs.every(validResource)) error('INVALID_RECIPE', 'Recipe requires a native machine baseline and valid resource amounts.', `recipes[${i}]`)
    else for (const output of recipe.outputs) if (output.chance !== undefined && (typeof output.chance !== 'number' || output.chance < 0 || output.chance > 1)) error('INVALID_CHANCE', 'Output chance must be between 0 and 1.', `recipes[${i}]`)
  }
  for (const [i, node] of project.nodes.entries()) {
    if (!isRecord(node) || typeof node.recipeId !== 'string' || typeof node.enabled !== 'boolean' || typeof node.overclockTier !== 'string' || typeof node.machineCount !== 'number' || node.machineCount < 0 || !Number.isInteger(node.parallel) || node.parallel < 1 || !isRecord(node.position) || typeof node.position.x !== 'number' || typeof node.position.y !== 'number' || (node.extraRecipes !== undefined && (!Array.isArray(node.extraRecipes) || node.extraRecipes.some(e => !isRecord(e) || typeof e.recipeId !== 'string')))) {
      error('INVALID_NODE', 'Node requires recipeId, enabled, machineCount >= 0, integer parallel >= 1, overclockTier and position.', `nodes[${i}]`)
      continue
    }
    if (overclockTierIndex(node.overclockTier) < 0 && node.overclockTier !== 'DEMO') {
      error('INVALID_MACHINE_TIER', `Unknown voltage tier ${node.overclockTier}.`, `nodes[${i}].overclockTier`)
    }
    if (node.hatchVoltageTier !== undefined && tierIndex(node.hatchVoltageTier) < 0) {
      error('INVALID_MACHINE_TIER', `Unknown hatch voltage tier ${node.hatchVoltageTier}.`, `nodes[${i}].hatchVoltageTier`)
    }
  }
  for (const [i, storage] of (project.storages ?? []).entries()) if (!isRecord(storage) || !kinds.has(String(storage.kind)) || typeof storage.resourceId !== 'string') error('INVALID_STORAGE', 'Storage requires resource kind and resourceId.', `storages[${i}]`)
  for (const [i, edge] of project.edges.entries()) if (!isRecord(edge) || typeof edge.source !== 'string' || typeof edge.target !== 'string' || !kinds.has(String(edge.resourceKind)) || typeof edge.resourceId !== 'string') error('INVALID_EDGE', 'Edge requires source/target and resourceKind/resourceId.', `edges[${i}]`)
  if (issues.some(i => i.severity === 'error')) return result
  if (packdata?.recipes && !packdata.recipes.isSourceCurrent() && project.recipes.some(recipe => recipe.metadata?.localBinding !== undefined)) {
    error('PACKDATA_RELOAD_REQUIRED', 'Recipe export files changed since the loaded RecipeBook fd/index. Restart/reload packdata before verifying local bindings.'); return result
  }
  for (const recipe of project.recipes) {
    const binding = bindingOf(recipe)
    if (!binding) {
      if (recipe.metadata?.localBinding !== undefined) error('INVALID_BINDING', `Recipe ${recipe.id} has malformed localBinding metadata.`)
      provenance.push({ recipeId: recipe.id, status: 'declared-unverified' })
      issues.push({ severity: 'warning', code: 'DECLARED_RECIPE', recipeId: recipe.id, message: 'External/AI-declared recipe: used as a static assumption, not verified against this server packdata.' })
      continue
    }
    if (nativeFingerprint(recipe) !== binding.nativeFingerprint || fingerprint(binding.snapshot) !== binding.fingerprint) error('BINDING_CHANGED', `Bound recipe ${recipe.id} was edited. Refresh describe, or remove localBinding to declare an unverified recipe.`)
    const current = packdata?.recipes?.get(binding.ref)
    let currentFingerprint: string | undefined
    try { currentFingerprint = current && packdata ? fingerprint(localSnapshot(packdata, current)) : undefined }
    catch { currentFingerprint = undefined }
    const stale = !packdata || currentFingerprint !== binding.fingerprint || datasetFingerprint(packdata) !== binding.datasetFingerprint || binding.catalogVersion !== CATALOG_VERSION
    provenance.push({ recipeId: recipe.id, status: stale ? 'local-stale' : 'local-current', binding })
    if (stale) issues.push({ severity: options.allowStale ? 'warning' : 'error', code: 'STALE_LOCAL_RECIPE', recipeId: recipe.id, message: options.allowStale ? 'Using the saved recipe snapshot as an explicit old assumption; local data/catalog no longer matches.' : 'Local data/catalog changed or the recipe ref no longer matches its full fingerprint. Refresh describe or explicitly set allowStale.' })
    if (!stale && packdata && current) {
      const described = describeOne(packdata, current, {}, binding.datasetFingerprint)
      if (nativeFingerprint(recipe) !== nativeFingerprint(described.recipe)) error('LOCAL_RECIPE_MISMATCH', `Bound recipe ${recipe.id} differs from the native conversion of its current local snapshot. Refresh describe or explicitly declare an unverified recipe.`)
      issues.push(...described.issues.filter(i => i.code !== 'MISSING_MACHINE_METADATA'))
    }
  }
  const recipes = new Map(project.recipes.map(r => [r.id, r]))
  const nodes = new Map(project.nodes.map(n => [n.id, n]))
  const storages = new Map((project.storages ?? []).map(s => [s.id, s]))
  const sectionRecipe = (node: FactoryNode, section: number): Recipe | undefined => {
    const recipe = recipes.get(section === 0 ? node.recipeId : node.extraRecipes?.[section - 1]?.recipeId ?? '')
    if (!recipe) return undefined
    const overrides = section === 0 ? node.recipeInputOverrides : node.extraRecipes?.[section - 1]?.recipeInputOverrides
    return !overrides ? recipe : { ...recipe, inputs: recipe.inputs.map((input, index) => overrides[String(index)]
      ? { ...input, ...overrides[String(index)], consumed: input.consumed, alternatives: undefined } : input) }
  }
  for (const node of project.nodes) {
    const recipe = recipes.get(node.recipeId)
    if (!recipe) { error('MISSING_RECIPE', `Node ${node.id} references missing recipe ${node.recipeId}.`); continue }
    const primaryHandlers = getRecipeMachineHandlers(recipe)
    const sharedHandler = node.machineHandlerId === undefined ? primaryHandlers[0] : primaryHandlers.find(h => h.id === node.machineHandlerId)
    if (node.machineHandlerId !== undefined && !sharedHandler) {
      error('UNKNOWN_MACHINE_HANDLER', `Node ${node.id}: explicit machineHandlerId ${node.machineHandlerId} is not available for its primary recipe; it will not be replaced with a default.`)
      continue
    }
    let primarySettings: ReturnType<typeof resolvedMachineSettings> | undefined
    if (node.extraRecipes?.length) {
      try { primarySettings = resolvedMachineSettings(recipe, node) }
      catch { error('INVALID_MACHINE_SETTINGS', `Node ${node.id}: native machine settings could not be resolved for its primary recipe.`) }
    }
    for (const [section, recipeId] of [node.recipeId, ...(node.extraRecipes ?? []).map(s => s.recipeId)].entries()) {
      const r = recipes.get(recipeId)
      if (!r) { error('MISSING_RECIPE', `Node ${node.id} section ${section} references missing recipe ${recipeId}.`); continue }
      if (section > 0 && sharedHandler) {
        const handlers = getRecipeMachineHandlers(r)
        if (!handlers.some(h => h.id === sharedHandler.id)) error('SHARED_MACHINE_MISMATCH', `Node ${node.id}: section ${section} cannot run on the primary section's ${sharedHandler.id} machine.`)
        else if (!node.machineHandlerId && handlers[0]?.id !== sharedHandler.id) error('AMBIGUOUS_SHARED_MACHINE', `Node ${node.id}: sections have different native default machines. Set machineHandlerId explicitly to a handler shared by every section before sharing its capacity.`)
      }
      if (section > 0 && primarySettings) {
        try {
          const settings = resolvedMachineSettings(r, node)
          const differences = (['runTier', 'coilTier', 'machineConfigTiers'] as const).filter(key => fingerprint(primarySettings![key] ?? null) !== fingerprint(settings[key] ?? null))
          if (differences.length) error('SHARED_MACHINE_SETTINGS_MISMATCH', `Node ${node.id}: shared sections resolve different physical settings (${differences.join(', ')}). Section 0: ${JSON.stringify(primarySettings)}; section ${section}: ${JSON.stringify(settings)}. Set explicit common overclockTier/coilTier/machineConfigTiers that resolve identically for every section, or use separate machine cards; no highest/default setting is selected automatically.`)
        } catch { error('INVALID_MACHINE_SETTINGS', `Node ${node.id}: native machine settings could not be resolved for section ${section}.`) }
      }
      if (bindingOf(r)) issues.push(...validateMachineSettings(r, node))
      const overrides = section === 0 ? node.recipeInputOverrides : node.extraRecipes?.[section - 1]?.recipeInputOverrides
      for (const [key, override] of Object.entries(overrides ?? {})) {
        const original = /^\d+$/.test(key) ? r.inputs[Number(key)] : undefined
        const alternative = original?.alternatives?.find(a => a.kind === override.kind && a.id === override.id)
        const amount = original ? original.amount * (alternative?.amount ?? 1) : undefined
        if (!original || !validResource(override) || !compatible(override, original) || override.amount !== amount) error('INVALID_INPUT_OVERRIDE', `Node ${node.id}: recipeInputOverrides keys are native decimal input indices; ${key} must select a compatible input with the original amount (or its declared alternative ratio).`)
      }
    }
    if (node.solvePin !== undefined && (typeof node.solvePin !== 'number' || node.solvePin < 0)) error('INVALID_PIN', `Node ${node.id}: solvePin must be nonnegative.`)
    if (node.solvePinExact && node.solvePin !== undefined && (node.targetOutput || Object.keys(node.portRates ?? {}).length)) error('COUNT_PIN_TARGET_CONFLICT', `Node ${node.id}: native target/port pins override an Exactly count. For a hard capacity use solvePin with solvePinExact:false (native Up-to pool) and a product storage target.`)
    if (node.solvePin === 0) error('ZERO_MACHINE_PIN', `Node ${node.id}: upstream ignores zero solvePin, including Exactly zero. Remove/disable this node and calculate again; zero is not a hard capacity.`)
    if (node.enabled && node.machineCount === 0 && (project.planMode || project.solveMode || project.poolMode)) error('ZERO_NAMEPLATE_SEED', `Node ${node.id}: a zero machineCount seed can yield solved production with zero reported power. Use machineCount:1 as the calculation baseline (not a machine limit), and solvePin for capacity.`)
    if ((project.planMode || project.solveMode || project.poolMode) && node.solvePin === undefined) issues.push({ severity: 'info', code: 'COUNT_NOT_CAPACITY', nodeId: node.id, message: 'machineCount is a nameplate seed, not a hard planning capacity. Set solvePin (Up to) for a native capacity pool.' })
    if (project.planMode && node.targetOutput) issues.push({ severity: 'warning', code: 'LEGACY_NODE_TARGET', nodeId: node.id, message: 'Plan mode uses portRates and product storage targets. targetOutput is a legacy mode field; use native portRates for an exact port pin.' })
    for (const [handle, rate] of Object.entries(node.portRates ?? {})) {
      const match = /^r(\d+):(.*)$/.exec(handle)
      const r = sectionRecipe(node, match ? Number(match[1]) : 0)
      if (typeof rate !== 'number' || rate <= 0 || !r || !recipePorts(r).some(p => p.handle === (match?.[2] ?? handle) && p.consumed)) error('INVALID_PORT_RATE', `Node ${node.id}: port rate ${handle} must name a consumed input/output canonical handle and be positive; native zero port pins are ignored.`)
    }
  }
  for (const edge of project.edges) {
    for (const end of ['source', 'target'] as const) {
      const side = end === 'source' ? 'output' : 'input'
      const node = nodes.get(edge[end]); const storage = storages.get(edge[end])
      if (!node && !storage) { error('MISSING_EDGE_ENDPOINT', `Edge ${edge.id}: missing ${end} ${edge[end]}.`); continue }
      if (storage) {
        if (storage.kind !== edge.resourceKind || storage.resourceId !== edge.resourceId) error('EDGE_RESOURCE_MISMATCH', `Edge ${edge.id}: ${end} storage resource differs.`)
        continue
      }
      const handle = edge[end === 'source' ? 'sourceHandle' : 'targetHandle']
      const match = handle ? /^r(\d+):(.*)$/.exec(handle) : null
      const recipe = sectionRecipe(node!, match ? Number(match[1]) : 0)
      if (!recipe) { error('INVALID_SECTION', `Edge ${edge.id}: ${end} recipe section is missing.`); continue }
      const ports = recipePorts(recipe).filter(p => p.side === side && p.consumed)
      const resource = { kind: edge.resourceKind, id: edge.resourceId }
      const candidates = ports.filter(p => compatible(resource, { kind: p.kind, id: p.resourceId, alternatives: p.alternatives }))
      const exact = candidates.find(p => p.resourceId === edge.resourceId)
      const selected = exact ?? candidates[0]
      if (!selected) error('EDGE_RESOURCE_MISMATCH', `Edge ${edge.id}: ${end} recipe has no compatible ${side} resource.`)
      else if (handle && selected.handle !== canonicalizeResourceHandleId(match?.[2] ?? handle) && `${side}:${selected.kind}:${selected.resourceId}` !== (match?.[2] ?? handle)) error('EDGE_HANDLE_MISMATCH', `Edge ${edge.id}: upstream resolves this resource to ${selected.handle}, not ${handle}. Concretize recipeInputOverrides rather than choosing an ignored handle.`)
      else if (!exact && new Set(candidates.map(p => p.handle)).size > 1) error('AMBIGUOUS_RESOURCE_PORT', `Edge ${edge.id}: this resource satisfies multiple input rows; upstream picks the first. Concretize native recipeInputOverrides to make the intended row unambiguous.`)
    }
  }
  return result
}
