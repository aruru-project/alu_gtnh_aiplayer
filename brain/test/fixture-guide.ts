// 一本极小的“游戏内指南”：照真实的 GuideNH 指南包抄的形状（assets/<书>/guidenh/_<语言>/<页>.md，每页开头几行 YAML）。
// 测试把它打成一个指南包，拿 tools/make-packdata.py guide 生成 guide.jsonl，再让大脑去读：生成器和大脑之间的文件约定是真的走了一遍。
// 旁边另写几样小资料（物品表、一条带流体的配方、一个任务），指南里的物品、流体、任务的名字从它们来。
//
// 两本书：
//   gregtech   index.md（中英都有）
//              ├ power/cable.md（中英都有）
//              └ multiblocks/multiblocks_index.md（中英都有）
//                  ├ multiblocks/lv/electric_blast_furnace.md（只有中文，讲工业高炉 1000 和白铜线圈方块）
//                  ├ multiblocks/hv/vacuum_freezer.md（只有中文，讲真空冷冻机 1002；这一页很长）
//                  └ multiblocks/vacuum_freezer.md（只有英文，讲的也是 1002）
//   changelog  index.md（中英都有，只有这一页）

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { makeZip } from './helpers.ts'

const GENERATOR = path.resolve(import.meta.dirname, '../../tools/make-packdata.py')
const M = 'gregtech:gt.blockmachines'
const NEI = 'NotEnoughItems:neiFluidDisplay'

export const VF = { id: M, meta: 1002 }
export const EBF = { id: M, meta: 1000 }
/** 任务 531 在指南里的写法：它的 UUID 的 base64。 */
export const QUEST_531 = 'AAAAAAAAAAAAAAAAAAAFMQ=='

export const GUIDE_ITEMS = [
  { ...VF, name: '真空冷冻机', en: 'Vacuum Freezer' },
  { ...EBF, name: '工业高炉', en: 'Electric Blast Furnace' },
  { id: 'gregtech:gt.blockcasings2', meta: 1, name: '防冻机械方块', en: 'Frost Proof Machine Casing' },
  { id: 'gregtech:gt.blockcasings', meta: 11, name: '隔热机械方块', en: 'Heat Proof Machine Casing' },
  { id: 'gregtech:gt.blockcasings5', meta: 0, name: '白铜线圈方块', en: 'Cupronickel Coil Block' },
  { id: 'gregtech:gt.blockcasings5', meta: 1, name: '坎塔尔线圈方块', en: 'Kanthal Coil Block' },
  { id: 'gregtech:gt.metaitem.01', meta: 17305, name: '钢板', en: 'Steel Plate' },
  { id: 'minecraft:furnace', meta: 0, name: '熔炉', en: 'Furnace' },
  { id: 'minecraft:dirt', meta: 0, name: '泥土', en: 'Dirt' },
  // NEI 给流体造的“流体展示”物品
  { id: NEI, meta: 7, name: '液氧', en: 'Liquid Oxygen' },
]

/** 真空冷冻机那一页末尾的一长段：四十条差不多的话，让这一页比一次读得完的长。 */
const TROUBLE = Array.from({ length: 40 }, (_, n) => `- 第 ${n + 1} 条：检查能源仓、维护仓和输入输出总线有没有装反，再数一数防冻机械方块够不够 16 个。`).join('\n')

const page = (head: string, body: string): string => `---\n${head.trim()}\n---\n\n${body.trim()}\n`

const PAGES: Record<string, string> = {
  'gregtech/_zh_cn/index.md': page(
    `navigation:\n  title: GT 新视野\n  icon: ${M}:1000`,
    `# GT 新视野

这本书讲 GregTech 的机器。<PlayerName />，从这里开始：

<SubPages />`,
  ),
  'gregtech/_en_us/index.md': page(`navigation:\n  title: GT New Horizons`, `# GT New Horizons\n\nWelcome, <PlayerName />.`),

  'gregtech/_zh_cn/power/cable.md': page(
    `navigation:\n  title: 导线与线缆\n  parent: index.md\n  position: 10`,
    `# 导线与线缆

电流越大，线损越大：<Latex formula="P = U \\times I" />。按 <KeyBind id="key.gt.wire" /> 看导线的参数。

## 线损

每一格导线都会损耗电压。`,
  ),
  'gregtech/_en_us/power/cable.md': page(`navigation:\n  title: Wires and Cables\n  parent: index.md\n  position: 10`, `# Wires and Cables\n\nCables lose power over distance.`),

  'gregtech/_zh_cn/multiblocks/multiblocks_index.md': page(
    `navigation:\n  title: 多方块机器\n  parent: index.md\n  position: 20`,
    `# 多方块机器

## 机器一览

<Category name="machines" rows="4" />`,
  ),
  'gregtech/_en_us/multiblocks/multiblocks_index.md': page(`navigation:\n  title: Multiblock Machines\n  parent: index.md\n  position: 20`, `# Multiblock Machines\n\n<Category name="machines" rows="4" />`),

  'gregtech/_zh_cn/multiblocks/hv/vacuum_freezer.md': page(
    `navigation:
  title: 真空冷冻机
  parent: multiblocks/multiblocks_index.md
  position: 10
  icon: ${M}:1002
item_ids:
  - ${M}:1002
quest_ids:
  - ${QUEST_531}
categories:
  - machines
author: Skorched
date: 2026-05-27`,
    `# 真空冷冻机

<GameScene interactive={true} wrap="square" align="right" width ="320" height="280">
  <ImportStructureLib controller="${M}:1002" tier={2} />
</GameScene>

<ItemImage id="${M}:1002" /><ItemLink id="${M}:1002" showIcon="left" />（俗称“冰箱”）把[工业高炉](../lv/electric_blast_furnace.md)出的热锭冷却成普通锭，冷却液用<ItemLink id="${NEI}:7" />，也有人用<ItemLink id="gregtech:gt.metaitem.99:5" />。电怎么接见[导线](/power/cable.md#线损)，官网在[这里](https://example.org/vf.md)。任务：<QuestLink id="${QUEST_531}" />。

| 部件 | 数量 |
| --- | --- |
| <ItemLink id="gregtech:gt.blockcasings2:1" showIcon="left" /> | <Color id="RED">至少 16 个</Color> |
| 能源仓<Tooltip label="哪种">普通的和多安的都行</Tooltip> | 1 个<br>任意位置 |

## 合成

<RecipesFor id="${M}:1002" />

<RecipeFor id="gregtech:gt.blockcasings2:1" handlerId="gt.recipe.assembler" input="gregtech:gt.metaitem.01:17305" />

指令 \`/gt <player> freeze\` 里的尖括号是字，\`<PlayerName />\` 写在代码里也是字。<Mystery kind="x">没见过的标签</Mystery>

![结构图](../../assets/vacuum_freezer.png)

## 故障排查

${TROUBLE}`,
  ),

  'gregtech/_zh_cn/multiblocks/lv/electric_blast_furnace.md': page(
    `navigation:\n  title: 工业高炉\n  parent: multiblocks/multiblocks_index.md\n  position: 5\nitem_ids:\n  - ${M}:1000\n  - gregtech:gt.blockcasings5:0\ncategories:\n  - machines`,
    `# 工业高炉

<GameScene zoom="2">
  <ImportStructure src="../../assets/ebf_built.snbt" />
  <IsometricCamera yaw="195" pitch="30" />
  <Block id="minecraft:furnace" x="2" y="1" z="0" facing="north" />
  <RemoveBlocks id="minecraft:dirt" />
  <BoxAnnotation min="0 0 0" max="3 1 3" color="#00ff1a">
    底层一圈是<ItemLink id="gregtech:gt.blockcasings:11" />。
  </BoxAnnotation>
  <TextAnnotation pos="1 3 1" text="消声仓放在顶上正中" />
  <LineAnnotation from="0 0 0" to="0 3 0" color="#ff0000" />
</GameScene>

<GameScene>
  <ImportPonder src="../../assets/ebf_ponder.json" />
</GameScene>

<Row gap="20">
  <Column>
    线圈：<ItemImage id="gregtech:gt.blockcasings5:0" scale="4" />
    <BlockImage id="gregtech:gt.blockcasings5" meta="1" scale="4" />
  </Column>
</Row>

<FunctionGraph title="炉温与耗电" xLabel="炉温 (K)" yLabel="耗电倍率" xRange="1800..5400">
  <Function expr="0.95^((x-1800)/900)" label="每 900K 省 5%" domain="1800..5400" />
</FunctionGraph>

<ContentTabs title="配方表">
<Tab title="按电压分">
铝要 MV。
</Tab>
</ContentTabs>

<FloatingImage src="../../assets/ebf_gui.png" title="高炉界面" align="left">
  <ImageAnnotation>右上角是炉温</ImageAnnotation>
</FloatingImage>

<RecipesUsage id="gregtech:gt.blockcasings5:0" />`,
  ),

  'gregtech/_en_us/multiblocks/vacuum_freezer.md': page(
    `navigation:\n  title: Vacuum Freezer\n  parent: multiblocks/multiblocks_index.md\nitem_ids:\n  - ${M}:1002\ncategories:\n  - machines`,
    `# Vacuum Freezer\n\nThe <ItemLink id="${M}:1002" /> cools hot ingots. Hello, <PlayerName />.`,
  ),

  'changelog/_zh_cn/index.md': page(`navigation:\n  title: 2.9 新内容`, `# 2.9 新内容\n\n久等了，<PlayerName />。`),
  'changelog/_en_us/index.md': page(`navigation:\n  title: What's New`, `# What's New\n\nThe wait is over, <PlayerName />.`),
}

/** 这台机器上有没有 python3（生成器是 Python 写的；没有就跳过要用它的测试）。 */
export function pythonMissing(): string | false {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  return probe.error || probe.status !== 0 ? 'python3 is not available, so tools/make-packdata.py cannot run' : false
}

/**
 * 在 dir 里做出一份带指南的本地资料：把上面那些页打成指南包，用 tools/make-packdata.py guide 生成 guide.jsonl；
 * 再写物品表、一条用到液氧的配方（流体表从配方册来）、一个任务。opts.guide 为 false 时不生成指南（看“没有这份资料”时用）。
 */
export function buildGuidePackdata(dir: string, opts: { guide?: boolean } = {}): string {
  const packdata = path.join(dir, 'packdata')
  fs.mkdirSync(packdata, { recursive: true })
  if (opts.guide !== false) {
    const zip = path.join(dir, 'FixtureGuide.zip')
    fs.writeFileSync(zip, makeZip([{ name: 'pack.mcmeta', data: '{"pack":{"pack_format":1,"description":"fixture guide"}}' }, ...Object.entries(PAGES).map(([name, data]) => ({ name: `assets/${name.replace('/', '/guidenh/')}`, data }))]))
    const run = spawnSync('python3', [GENERATOR, 'guide', '--pack', zip, '--out', packdata], { encoding: 'utf8' })
    if (run.error) throw run.error
    if (run.status !== 0) throw new Error(`make-packdata.py guide failed (${run.status}): ${run.stderr || run.stdout}`)
  }
  fs.writeFileSync(path.join(packdata, 'items.jsonl'), GUIDE_ITEMS.map((i) => JSON.stringify(i)).join('\n'))
  fs.writeFileSync(path.join(packdata, 'handlers.json'), JSON.stringify({ handlers: [{ key: 'gt.recipe.vacuumfreezer', name: '真空冷冻机', mod: 'GregTech', machines: [VF], read: 'gregtech' }] }))
  fs.writeFileSync(path.join(packdata, 'recipes.jsonl'), JSON.stringify({ h: 'gt.recipe.vacuumfreezer', in: [{ id: 'gregtech:gt.metaitem.01', meta: 17305, n: 1 }], out: [{ id: 'gregtech:gt.metaitem.01', meta: 17305, n: 1 }], fin: [{ f: 'liquidoxygen', name: '液氧', mb: 1000 }], eut: 480, ticks: 100 }))
  fs.writeFileSync(path.join(packdata, 'quests.jsonl'), JSON.stringify({ id: '531', name: '冰箱造好了', desc: '', lines: ['hv'], pre: [], tasks: [], rewards: [] }))
  fs.writeFileSync(path.join(packdata, 'questlines.json'), JSON.stringify({ lines: [{ id: 'hv', name: 'HV', desc: '', quests: ['531'] }] }))
  return packdata
}
