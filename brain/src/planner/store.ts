import { constants } from 'node:fs'
import { link, mkdir, open, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const PLANNER_RECORD_VERSION = 1
export const PLANNER_RECORD_MAX_BYTES = 64 * 1024 * 1024
export const PLANNER_PAGE_MAX = 200

/** Analysis artifacts only. Neither the store nor its callers have a world-action API. */
export interface PlannerRecord {
  schemaVersion: 1
  id: string
  createdAt: string
  durationMs: number
  parentId?: string
  projectHash: string
  /** Exactly the submitted native FactoryProject, including untrusted notes. */
  project: unknown
  /** Adapter-validated calculation input; kept separately from the submitted project. */
  preparedProject?: unknown
  provenance: unknown
  engine: unknown
  outcome: 'calculated' | 'rejected' | 'failed'
  /** Complete, unabridged native calculation report. Null when no report was produced. */
  report: unknown
  /** Adapter explanation, not a replacement for the native report. */
  explanation: unknown
  issues: unknown[]
  error?: { code: string; message: string }
}

export type PlannerRecordInput = Omit<PlannerRecord, 'schemaVersion' | 'id' | 'projectHash'>

/** Small directory metadata only. Full graphs, reports and explanations are available from get/read/export. */
export interface PlannerRecordSummary {
  id: string
  createdAt: string
  durationMs: number
  parentId?: string
  projectHash: string
  outcome: PlannerRecord['outcome']
  status: string
  counts: {
    goals: number
    unmetGoals: number
    machines: number
    shortfalls: number
    forcedFlows: number
    externalInputs: number
    externalOutputs: number
    issues: number
    errors: number
    warnings: number
    assumptions: number
  }
  /** Original native total: Build uses nameplate, Solve/Plan uses its native scaled total. */
  totalEuT?: number
  averageEuT?: number
  buildPeakEuT?: number
  averageSteamMbPerSecond?: number
  buildPeakSteamMbPerSecond?: number
  /** At most 120 characters; only a label preview, never a replacement for project.name. */
  namePreview?: string
  namePreviewTruncated?: boolean
  /** Error details stay in the record; the directory contains bounded previews only. */
  errorCode?: string
  errorCodeTruncated?: boolean
  errorMessagePreview?: string
  errorMessagePreviewTruncated?: boolean
}

export interface PlannerPage<T> {
  items: T[]
  offset: number
  limit: number
  total: number
  more: boolean
  nextOffset: number | null
}

export class PlannerStoreError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PlannerStoreError'
    this.code = code
  }
}

export function assertPlannerId(id: string): void {
  if (typeof id !== 'string' || !/^pp_[0-9a-f]{32}$/.test(id)) {
    throw new PlannerStoreError('invalid_id', 'Use a planner record ID returned by solve or list, not a path or filename.')
  }
}

/** Reject lossy JSON conversions (NaN, Maps, cycles); omit only optional undefined object properties. */
export function plannerJson(value: unknown, maxBytes = PLANNER_RECORD_MAX_BYTES): string {
  const ancestors = new Set<object>()
  function check(v: unknown, depth: number): void {
    if (depth > 256) throw new PlannerStoreError('invalid_json', 'Planner JSON is nested more than 256 levels deep.')
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return
    if (typeof v === 'number' && Number.isFinite(v)) return
    if (typeof v !== 'object') throw new PlannerStoreError('invalid_json', 'Planner data must be JSON with finite numbers; no undefined, functions or bigint.')
    if (ancestors.has(v)) throw new PlannerStoreError('invalid_json', 'Planner data must not contain cycles.')
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) {
      throw new PlannerStoreError('invalid_json', 'Planner data must contain plain JSON objects and arrays only.')
    }
    ancestors.add(v)
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(v, String(i))
        if (!descriptor || !('value' in descriptor)) throw new PlannerStoreError('invalid_json', 'Planner JSON arrays must not contain holes or accessors.')
        check(descriptor.value, depth + 1)
      }
    } else {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(v))) {
        if (descriptor.get || descriptor.set) throw new PlannerStoreError('invalid_json', 'Planner JSON must not contain accessors.')
        if (descriptor.enumerable && descriptor.value !== undefined) check(descriptor.value, depth + 1)
      }
    }
    ancestors.delete(v)
  }
  check(value, 0)
  const json = JSON.stringify(value)
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw new PlannerStoreError('too_large', `Planner JSON exceeds ${maxBytes} bytes; nothing was truncated or saved.`)
  }
  return json
}

export function copyPlannerJson<T>(value: T): T {
  return JSON.parse(plannerJson(value)) as T
}

/** Object key order does not change the signature; array order remains significant. */
export function plannerHash(value: unknown): string {
  const plain = copyPlannerJson(value)
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, item]) => [k, canonical(item)]))
    }
    return v
  }
  return createHash('sha256').update(JSON.stringify(canonical(plain))).digest('hex')
}

export function plannerPage<T>(items: readonly T[], options: { offset?: number; limit?: number } = {}): PlannerPage<T> {
  const { offset = 0, limit = 25 } = options
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > PLANNER_PAGE_MAX) {
    throw new PlannerStoreError('invalid_page', `offset must be a non-negative integer; limit must be 1..${PLANNER_PAGE_MAX}.`)
  }
  const page = items.slice(offset, offset + limit)
  const more = offset + page.length < items.length
  return { items: page, offset, limit, total: items.length, more, nextOffset: more ? offset + page.length : null }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }

export function recordStatus(record: PlannerRecord): string {
  const explanation = object(record.explanation)
  const status = explanation.status
  // Older analyses could count a forced flow as ordinary supply or even as satisfied.
  if ((status === 'satisfied' || status === 'needs-external-supply') && array(explanation.forcedFlows).some(flow => {
    const row = object(flow)
    return typeof row.perSecond === 'number' && row.perSecond > 0
  })) return 'requires-forced-flow'
  return typeof status === 'string' && ['satisfied', 'needs-external-supply', 'requires-forced-flow', 'unmet', 'infeasible', 'unanchored', 'invalid', 'failed'].includes(status)
    ? status : record.outcome
}

export function recordSummary(record: PlannerRecord): PlannerRecordSummary {
  const explanation = object(record.explanation)
  const goals = array(explanation.goals)
  const issues = array(explanation.issues).length ? array(explanation.issues) : record.issues
  const name = object(record.project).name
  return {
    id: record.id, createdAt: record.createdAt, durationMs: record.durationMs,
    ...(record.parentId !== undefined ? { parentId: record.parentId } : {}),
    projectHash: record.projectHash, outcome: record.outcome,
    status: recordStatus(record),
    counts: {
      goals: goals.length,
      unmetGoals: goals.reduce<number>((count, goal) => count + (object(goal).met === true ? 0 : 1), 0),
      machines: array(explanation.machines).length,
      shortfalls: array(explanation.shortfalls).length,
      forcedFlows: array(explanation.forcedFlows).length,
      externalInputs: array(explanation.externalInputs).length,
      externalOutputs: array(explanation.externalOutputs).length,
      issues: issues.length,
      errors: issues.reduce<number>((count, issue) => count + (object(issue).severity === 'error' ? 1 : 0), 0),
      warnings: issues.reduce<number>((count, issue) => count + (object(issue).severity === 'warning' ? 1 : 0), 0),
      assumptions: array(explanation.assumptions).length,
    },
    ...(typeof explanation.totalEuT === 'number' && Number.isFinite(explanation.totalEuT) ? { totalEuT: explanation.totalEuT } : {}),
    ...(typeof explanation.averageEuT === 'number' && Number.isFinite(explanation.averageEuT) ? { averageEuT: explanation.averageEuT } : {}),
    ...(typeof explanation.buildPeakEuT === 'number' && Number.isFinite(explanation.buildPeakEuT) ? { buildPeakEuT: explanation.buildPeakEuT } : {}),
    ...(typeof explanation.averageSteamMbPerSecond === 'number' && Number.isFinite(explanation.averageSteamMbPerSecond) ? { averageSteamMbPerSecond: explanation.averageSteamMbPerSecond } : {}),
    ...(typeof explanation.buildPeakSteamMbPerSecond === 'number' && Number.isFinite(explanation.buildPeakSteamMbPerSecond) ? { buildPeakSteamMbPerSecond: explanation.buildPeakSteamMbPerSecond } : {}),
    ...(typeof name === 'string' ? { namePreview: name.slice(0, 120), namePreviewTruncated: name.length > 120 } : {}),
    ...(record.error !== undefined ? {
      errorCode: record.error.code.slice(0, 80),
      errorCodeTruncated: record.error.code.length > 80,
      errorMessagePreview: record.error.message.slice(0, 240),
      errorMessagePreviewTruncated: record.error.message.length > 240,
    } : {}),
  }
}

/** Append-only files: publish a fully fsynced inode with link(), which never replaces an old record. */
export class PlannerStore {
  readonly directory: string
  constructor(directory: string) {
    this.directory = path.resolve(directory)
  }

  async save(input: PlannerRecordInput): Promise<PlannerRecord> {
    if (input.parentId !== undefined) await this.get(input.parentId)
    const record: PlannerRecord = {
      ...copyPlannerJson(input), schemaVersion: PLANNER_RECORD_VERSION,
      id: `pp_${randomUUID().replaceAll('-', '')}`, projectHash: plannerHash(input.project),
    }
    const text = plannerJson(record)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(this.directory, `.${record.id}.${randomUUID()}.tmp`)
    const target = path.join(this.directory, `${record.id}.json`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(text, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await link(temporary, target)
      const directory = await open(this.directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    }
    return record
  }

  async get(id: string): Promise<PlannerRecord> {
    assertPlannerId(id)
    let file
    try {
      file = await open(path.join(this.directory, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new PlannerStoreError('not_found', `No planner record ${id}. Use list to find saved analyses.`)
      throw new PlannerStoreError('unreadable_record', `Could not open planner record ${id}: ${(error as Error).message}`)
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > PLANNER_RECORD_MAX_BYTES) throw new Error('record is not a regular JSON file within the record size limit')
      const record = JSON.parse(await file.readFile('utf8')) as PlannerRecord
      if (record === null || record.schemaVersion !== PLANNER_RECORD_VERSION || record.id !== id ||
        typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt)) ||
        !Number.isFinite(record.durationMs) || record.durationMs < 0 ||
        !['calculated', 'rejected', 'failed'].includes(record.outcome) ||
        !Array.isArray(record.issues) || record.explanation === undefined || record.report === undefined ||
        record.provenance === undefined || record.engine === undefined ||
        (record.error !== undefined && (record.error === null || typeof record.error.code !== 'string' || typeof record.error.message !== 'string')) ||
        plannerHash(record.project) !== record.projectHash) {
        throw new Error('record schema or project checksum does not match')
      }
      if (record.parentId !== undefined) assertPlannerId(record.parentId)
      return record
    } catch (error) {
      throw new PlannerStoreError('corrupt_record', `Planner record ${id} is unreadable: ${(error as Error).message}`)
    } finally {
      await file.close()
    }
  }

  async list(options: { offset?: number; limit?: number } = {}): Promise<PlannerPage<PlannerRecordSummary>> {
    plannerPage([], options)
    let files
    try { files = await readdir(this.directory, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return plannerPage([], options)
      throw error
    }
    const summaries: PlannerRecordSummary[] = []
    for (const file of files) {
      if (/^pp_[0-9a-f]{32}\.json$/.test(file.name)) summaries.push(recordSummary(await this.get(file.name.slice(0, -5))))
    }
    summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    return plannerPage(summaries, options)
  }

  async export(id: string): Promise<{ filename: string; mediaType: 'application/json'; json: string; record: PlannerRecord }> {
    const record = await this.get(id)
    return { filename: `${record.id}.json`, mediaType: 'application/json', json: plannerJson(record), record }
  }
}
