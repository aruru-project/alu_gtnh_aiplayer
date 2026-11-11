// 多方块机器怎么搭（structures.jsonl，格式见 docs/PACKDATA.md）：一行是一台多方块机器在某个等级下的完整结构，
// 也就是 NEI 里那个结构预览（玩家说的“投影”）。等级就是“多方块结构全息投影仪”叠几个。
// 结构用和身体 world.blocks 同一种写法：palette + runs，下标 = (y*sz + z)*sx + x。主机在数据里一律朝南。

import fs from 'node:fs'
import path from 'node:path'
import { isRecord, isWhole, stringsOf } from '../util.ts'

export interface StructurePart {
  id: string
  meta: number
  name?: string
}

/** 一台机器在某几个等级下的结构（几个等级结构一样的并成一行）。 */
export interface StructureRow {
  tiers: number[]
  /** x、y、z 各几格。 */
  size: [number, number, number]
  /** 主机在这个盒子里的位置（从 0 数）；主机正面朝南（+z）。 */
  controller: [number, number, number]
  /** 材料清单。 */
  blocks: (StructurePart & { n: number })[]
  /** palette[0] 是空气。机器零件（各种仓、主机）的 meta 是它作为物品时的 meta。 */
  palette: StructurePart[]
  /** “调色板下标, 连续几格”交替。 */
  runs: Int32Array
}

export interface Structure {
  /** 主机这件物品。 */
  id: string
  meta: number
  name: string
  maxTier: number
  rows: StructureRow[]
  /** 主机的说明文字，和按住 Shift 看到的结构说明（中文）。 */
  info: string[]
  structureInfo: string[]
}

const triple = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(isWhole)

function part(v: unknown): StructurePart | undefined {
  if (!isRecord(v) || typeof v.id !== 'string') return undefined
  return { id: v.id, meta: isWhole(v.meta) ? v.meta : 0, ...(typeof v.name === 'string' ? { name: v.name } : {}) }
}

/** 把一行的 runs 展开成每格一个调色板下标。 */
export function structureCells(row: StructureRow): Uint16Array {
  const cells = new Uint16Array(row.size[0] * row.size[1] * row.size[2])
  let at = 0
  for (let i = 0; i + 1 < row.runs.length && at < cells.length; i += 2) {
    const count = Math.min(row.runs[i + 1]!, cells.length - at)
    if (row.runs[i] !== 0) cells.fill(row.runs[i]!, at, at + count)
    at += count
  }
  return cells
}

export class StructureBook {
  readonly machines: Structure[]
  private readonly byItem = new Map<string, Structure>()

  private constructor(machines: Structure[]) {
    this.machines = machines
    for (const m of machines) this.byItem.set(`${m.id}/${m.meta}`, m)
  }

  /** 读 dir 里的 structures.jsonl。文件不在时返回 undefined；认不出来的行跳过（bad 是跳过了几行）。 */
  static load(dir: string): { book: StructureBook; rows: number; bad: number } | undefined {
    const file = path.join(dir, 'structures.jsonl')
    if (!fs.existsSync(file)) return undefined
    const machines = new Map<string, Structure>()
    let rows = 0
    let bad = 0
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        bad++
        continue
      }
      if (!isRecord(raw) || typeof raw.id !== 'string' || !isWhole(raw.meta) || !triple(raw.size) || !triple(raw.controller) || !Array.isArray(raw.palette) || !Array.isArray(raw.runs) || !raw.runs.every(isWhole)) {
        bad++
        continue
      }
      const palette = raw.palette.map(part)
      const tiers = Array.isArray(raw.tiers) ? raw.tiers.filter(isWhole) : []
      if (palette.some((p) => p === undefined) || tiers.length === 0) {
        bad++
        continue
      }
      const key = `${raw.id}/${raw.meta}`
      let machine = machines.get(key)
      if (!machine) {
        machine = { id: raw.id, meta: raw.meta, name: typeof raw.name === 'string' ? raw.name : key, maxTier: 0, rows: [], info: [], structureInfo: [] }
        machines.set(key, machine)
      }
      // 说明文字只在这台机器的第一行带
      if (machine.info.length === 0) machine.info = stringsOf(raw.info)
      if (machine.structureInfo.length === 0) machine.structureInfo = stringsOf(raw.structureInfo)
      machine.maxTier = Math.max(machine.maxTier, isWhole(raw.maxTier) ? raw.maxTier : 0, ...tiers)
      const blocks = (Array.isArray(raw.blocks) ? raw.blocks : []).flatMap((b) => {
        const p = part(b)
        return p && isRecord(b) && isWhole(b.n) ? [{ ...p, n: b.n }] : []
      })
      machine.rows.push({ tiers, size: raw.size, controller: raw.controller, blocks, palette: palette as StructurePart[], runs: Int32Array.from(raw.runs as number[]) })
      rows++
    }
    for (const m of machines.values()) m.rows.sort((a, b) => a.tiers[0]! - b.tiers[0]!)
    return { book: new StructureBook([...machines.values()]), rows, bad }
  }

  get(id: string, meta: number): Structure | undefined {
    return this.byItem.get(`${id}/${meta}`)
  }

  /** 名字正好是它的排前面，然后是名字里含它的（不分大小写）。 */
  search(query: string): Structure[] {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    const exact = this.machines.filter((m) => m.name.toLowerCase() === q)
    const partial = this.machines.filter((m) => m.name.toLowerCase() !== q && m.name.toLowerCase().includes(q))
    return [...exact, ...partial]
  }

  /** 这个等级用的是哪一行。 */
  static rowOf(machine: Structure, tier: number): StructureRow | undefined {
    return machine.rows.find((r) => r.tiers.includes(tier))
  }

  /** 这台机器有哪些等级。 */
  static tiersOf(machine: Structure): number[] {
    return [...new Set(machine.rows.flatMap((r) => r.tiers))].sort((a, b) => a - b)
  }
}
