// 自造的多方块结构数据（structures.jsonl 的样子）：一台两个等级的小机器、一台等级很多的、两台重名的。
// 坐标和数量都是手数的，测试里的预期照这里的图来。

import fs from 'node:fs'
import path from 'node:path'

const M = 'gregtech:gt.blockmachines'
export const S = {
  centrifuge: { id: M, meta: 31080 },
  furnace: { id: M, meta: 1000 },
  copper: { id: 'gregtech:gt.blockcasings', meta: 10, name: '镀铜砖块' },
  bronzeGear: { id: 'gregtech:gt.blockcasings2', meta: 2, name: '青铜齿轮箱机械方块' },
  steel: { id: 'gregtech:gt.blockcasings2', meta: 0, name: '脱氧钢机械方块' },
  steelGear: { id: 'gregtech:gt.blockcasings2', meta: 3, name: '钢齿轮箱机械方块' },
  heatproof: { id: 'gregtech:gt.blockcasings', meta: 11, name: '隔热机械方块' },
  coil: (n: number) => ({ id: 'gregtech:gt.blockcasings5', meta: n, name: `${['白铜', '坎塔尔', '镍铬', '钨钢', '高速钢', '硅岩'][n]}线圈方块` }),
}

/**
 * 小离心机：3×2×3，主机在底层正面中央（朝南）。两层从上往下看（上边是北）：
 *   底层 y=0        上层 y=1
 *   C C C           C C C
 *   C G C           C . C        C 机械方块（15 个）  G 齿轮箱（1 个）  M 主机  . 空
 *   C M C           C C C
 * T1 是镀铜砖块 + 青铜齿轮箱，T2 是脱氧钢机械方块 + 钢齿轮箱。
 */
const centrifuge = (tier: number, casing: { id: string; meta: number; name: string }, gear: { id: string; meta: number; name: string }, first: boolean) => ({
  ...S.centrifuge,
  name: '大型蒸汽离心机',
  tiers: [tier],
  maxTier: 2,
  size: [3, 2, 3],
  controller: [1, 0, 2],
  facing: 'south',
  blocks: [{ ...casing, n: 15 }, { ...gear, n: 1 }, { ...S.centrifuge, name: '大型蒸汽离心机', n: 1 }],
  palette: [{ id: 'minecraft:air', meta: 0 }, casing, gear, { ...S.centrifuge, name: '大型蒸汽离心机' }],
  runs: [1, 4, 2, 1, 1, 2, 3, 1, 1, 5, 0, 1, 1, 4],
  ...(first
    ? {
        info: ['机器类型: 离心机', '并行：8', '-----------------------------------------', '按住 [LSHIFT] 以显示结构指导'],
        structureInfo: ['大小: 3x3x2 (LxWxH)', '结构:', '控制器: 底层，正面中央', '1+ 蒸汽输入总线: 任意机械方块', '投影仪堆叠数量确定结构等级', '------------------------------', '使用多方块机器全息投影仪来查看或建造整体结构！'],
      }
    : {}),
})

/** 高炉：一格宽、三格高——主机、线圈、隔热机械方块。六种线圈各一级。 */
const furnace = (tier: number) => ({
  ...S.furnace,
  name: '工业高炉',
  tiers: [tier],
  maxTier: 6,
  size: [1, 3, 1],
  controller: [0, 0, 0],
  facing: 'south',
  blocks: [{ ...S.furnace, name: '工业高炉', n: 1 }, { ...S.coil(tier - 1), n: 1 }, { ...S.heatproof, n: 1 }],
  palette: [{ id: 'minecraft:air', meta: 0 }, { ...S.furnace, name: '工业高炉' }, S.coil(tier - 1), S.heatproof],
  runs: [1, 1, 2, 1, 3, 1],
  ...(tier === 1 ? { info: ['机器类型: 高炉'], structureInfo: ['线圈决定炉温'] } : {}),
})

const lonely = (meta: number) => ({ id: M, meta, name: '工业离心机', tiers: [1], maxTier: 1, size: [1, 1, 1], controller: [0, 0, 0], facing: 'south', blocks: [{ id: M, meta, name: '工业离心机', n: 1 }], palette: [{ id: 'minecraft:air', meta: 0 }, { id: M, meta, name: '工业离心机' }], runs: [1, 1] })

export const STRUCTURE_ROWS: unknown[] = [centrifuge(1, S.copper, S.bronzeGear, true), centrifuge(2, S.steel, S.steelGear, false), ...[1, 2, 3, 4, 5, 6].map(furnace), lonely(790), lonely(31027)]

export function writeStructureFixture(dir: string, extraLines: string[] = []): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'structures.jsonl'), `${[...STRUCTURE_ROWS.map((r) => JSON.stringify(r)), ...extraLines].join('\n')}\n`)
}
