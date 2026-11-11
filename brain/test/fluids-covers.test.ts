// 覆盖板、流体罐、流体的配方、一个方块的全部数据。
// 主人的那个用例：两个钢板做钢环——流体提取机把钢板化成熔融钢，旁边的流体固化器用模具（环）浇出钢环；
// 模具放在固化器西面的覆盖板“基础槽位扩展”里。再加上蒸馏塔那一个：石油 + 电路 9 在做哪条配方。
// 入口是模型用的工具和它写的程序；资料是这里自造的一小份（几样物品、几种流体、七条配方）；游戏是按方法名应答的假服务器。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { DesignWorkspace } from '../src/design/index.ts'
import { loadPackData } from '../src/packdata/index.ts'
import { useLocalNames } from '../src/tools/format.ts'
import { makeAgent, modelCalls } from './agent-harness.ts'
import type { AgentHarness } from './agent-harness.ts'
import { tmpDir } from './helpers.ts'

const GT = 'gregtech:gt.metaitem.01'
const NEI = 'NotEnoughItems:neiFluidDisplay'
const ITEMS = [
  { id: GT, meta: 17305, name: '钢板', en: 'Steel Plate', ores: ['plateSteel'] },
  { id: GT, meta: 28305, name: '钢环', en: 'Steel Ring', ores: ['ringSteel'] },
  { id: GT, meta: 32322, name: '模具（环）', en: 'Mold (Ring)' },
  { id: GT, meta: 32380, name: '基础槽位扩展', en: 'Basic Item Holder' },
  { id: 'gregtech:gt.integrated_circuit', meta: 1, name: '编程电路 1', en: 'Programmed Circuit' },
  { id: 'gregtech:gt.integrated_circuit', meta: 9, name: '编程电路 9', en: 'Programmed Circuit' },
  { id: 'gregtech:gt.blockmachines', meta: 511, name: '基础流体提取机', en: 'Basic Fluid Extractor' },
  { id: 'gregtech:gt.blockmachines', meta: 521, name: '基础流体固化器', en: 'Basic Fluid Solidifier' },
  { id: 'gregtech:gt.blockmachines', meta: 1126, name: '蒸馏塔', en: 'Distillation Tower' },
  { id: 'gregtech:gt.blockmachines', meta: 130, name: '超级缸 I', en: 'Super Tank I' },
  // NEI 给每种流体造的“流体展示”物品：只是配方画面上代表流体的那张图
  { id: NEI, meta: 30, name: '熔融钢', en: 'Molten Steel' },
  { id: NEI, meta: 52, name: '石油', en: 'Oil' },
  { id: NEI, meta: 137, name: '含硫轻燃油', en: 'Sulfuric Light Fuel' },
  { id: NEI, meta: 77, name: '炼油气', en: 'Refinery Gas' },
  { id: NEI, meta: 78, name: '重油', en: 'Heavy Oil' },
]
const HANDLERS = [
  { key: 'gt.recipe.fluidextractor', name: '流体提取机', mod: 'GregTech', machines: [{ id: 'gregtech:gt.blockmachines', meta: 511 }], read: 'gregtech' },
  { key: 'gt.recipe.fluidsolidifier', name: '流体固化器', mod: 'GregTech', machines: [{ id: 'gregtech:gt.blockmachines', meta: 521 }], read: 'gregtech' },
  { key: 'gt.recipe.distillationtower', name: '蒸馏塔', mod: 'GregTech', machines: [{ id: 'gregtech:gt.blockmachines', meta: 1126 }], read: 'gregtech' },
  // 不是 GregTech 的页：流体画成了物品
  { key: 'demo.pumpjack', name: '抽油机', mod: 'Demo', machines: [], read: 'all' },
]
const circuit = (n: number) => ({ id: 'gregtech:gt.integrated_circuit', meta: n, n: 0 })
const fluid = (f: string, name: string, mb: number) => ({ f, name, mb })
const LIGHT = 'liquid_sufluriclight_fuel'
const RECIPES = [
  // #0：流体提取机，1 钢板 → 144 mB 熔融钢
  { h: 'gt.recipe.fluidextractor', in: [{ id: GT, meta: 17305, n: 1 }], out: [], fout: [fluid('molten.steel', '熔融钢', 144)], eut: 30, ticks: 24 },
  // #1：流体固化器，模具（环）不消耗 + 36 mB 熔融钢 → 1 钢环
  { h: 'gt.recipe.fluidsolidifier', in: [{ id: GT, meta: 32322, n: 0 }], out: [{ id: GT, meta: 28305, n: 1 }], fin: [fluid('molten.steel', '熔融钢', 36)], eut: 30, ticks: 100 },
  // #2、#3：蒸馏塔，石油，电路 1 和电路 9 出的东西不一样
  { h: 'gt.recipe.distillationtower', in: [circuit(1)], out: [], fin: [fluid('oil', '石油', 100)], fout: [fluid(LIGHT, '含硫轻燃油', 100), fluid('gas_gas', '炼油气', 120)], eut: 96, ticks: 30 },
  { h: 'gt.recipe.distillationtower', in: [circuit(9)], out: [], fin: [fluid('oil', '石油', 1000)], fout: [fluid(LIGHT, '含硫轻燃油', 1000), fluid('gas_gas', '炼油气', 1200)], eut: 480, ticks: 64 },
  // #4：蒸馏塔，重油，也是电路 9，也出含硫轻燃油
  { h: 'gt.recipe.distillationtower', in: [circuit(9)], out: [], fin: [fluid('liquid_heavy_oil', '重油', 1000)], fout: [fluid(LIGHT, '含硫轻燃油', 450)], eut: 480, ticks: 64 },
  // #5：别的 mod 的页，产物是“流体展示”物品（石油）
  { h: 'demo.pumpjack', in: [], out: [{ id: NEI, meta: 52, n: 1 }] },
  // #6：另一种也叫“熔融钢”的流体（匠魂的 steel.molten）
  { h: 'gt.recipe.fluidsolidifier', in: [{ id: GT, meta: 32322, n: 0 }], out: [{ id: GT, meta: 17305, n: 1 }], fin: [fluid('steel.molten', '熔融钢', 144)], eut: 30, ticks: 80 },
]

const SOLIDIFIER = { x: -525, y: 70, z: 41 }
const EXTRACTOR = { x: -527, y: 70, z: 41 }
const TOWER = { x: -518, y: 69, z: 56 }
const SUPER_TANK = { x: -524, y: 69, z: 48 }
const HATCH = { x: -518, y: 70, z: 58 }
const MOLD = { id: GT, meta: 32322, count: 1, name: 'Mold (Ring)' }
const HOLDER = { id: GT, meta: 32380, name: 'Basic Item Holder', screen: true }
const COVERS = [
  { side: 'west', ...HOLDER, slots: 9, usedSlots: 1, items: [MOLD], moreKinds: 0 },
  { side: 'south', ...HOLDER, slots: 9, usedSlots: 0, items: [], moreKinds: 0 },
]
const SOLIDIFIER_TANKS = [{ fluid: 'molten.steel', name: 'Molten Steel', amount: 144, capacity: 16000 }]
const MACHINES = [
  { ...SOLIDIFIER, name: 'Basic Fluid Solidifier', id: 'gregtech:gt.blockmachines', meta: 521, recipes: 'Fluid Solidifier', recipeKey: 'gt.recipe.fluidsolidifier', tier: 'LV', inputSlots: 1, active: false, storedEU: 4000, inputVoltage: 32, dist: 3, covers: COVERS, tanks: SOLIDIFIER_TANKS },
  { ...EXTRACTOR, name: 'Basic Fluid Extractor', id: 'gregtech:gt.blockmachines', meta: 511, recipes: 'Fluid Extractor', recipeKey: 'gt.recipe.fluidextractor', tier: 'LV', inputSlots: 1, active: false, storedEU: 4000, inputVoltage: 32, dist: 5, tanks: [{ amount: 0, capacity: 16000 }] },
  {
    ...TOWER, name: 'Distillation Tower', id: 'gregtech:gt.blockmachines', meta: 1126, kind: 'multiblock', formed: true, recipes: 'Distillation Tower', recipeKey: 'gt.recipe.distillationtower', tier: 'HV', inputVoltage: 512, active: false, idleReason: 'Not enough output space', dist: 16,
    inputBuses: [{ x: -519, y: 69, z: 56, name: 'Input Bus (LV)', kind: 'input bus', slots: 4, usedSlots: 0, circuit: 9 }],
    inputHatches: [{ x: -517, y: 69, z: 56, name: 'Input Hatch (HV)', kind: 'input hatch', capacity: 16000, fluid: 'oil', fluidName: 'Oil', amount: 16000 }],
    outputHatches: [{ ...HATCH, name: 'Output Hatch (HV)', kind: 'output hatch', capacity: 16000, fluid: LIGHT, fluidName: 'Sulfuric Light Fuel', amount: 16000 }],
  },
]
const BLOCK = { air: false, solid: true, liquid: false, replaceable: false, hardness: 2, tileEntity: true, inventory: true }
// 输出仓自己存的数据：锁定了哪种流体只有这里有
const HATCH_SAYS = ['Output Hatch', 'Stored Fluid: No Fluid', '0 L 16,000 L', 'Locked to fluid.gas_gas']
const HATCH_SAVED = {
  Inventory: [],
  lockedFluidName: 'gas_gas',
  mFacing: 5,
  mMode: 9,
  // 存档里什么写法都有：这一项长得像工具结果里的物品（id + 英文名），也照样不能动它
  mDisplayed: { id: GT, meta: 32380, name: 'Basic Item Holder' },
  'gt.covers': [{ side: 4, item: { item: GT, meta: 32380, count: 1, name: 'Basic Item Holder' } }],
}

function setup(t: { after(fn: () => void): void }, settings: { toolResultMaxChars?: number } = {}): AgentHarness {
  const tmp = tmpDir()
  const dir = path.join(tmp.dir, 'packdata')
  fs.mkdirSync(dir, { recursive: true })
  const lines = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
  fs.writeFileSync(path.join(dir, 'items.jsonl'), lines(ITEMS))
  fs.writeFileSync(path.join(dir, 'handlers.json'), JSON.stringify(HANDLERS))
  fs.writeFileSync(path.join(dir, 'recipes.jsonl'), lines(RECIPES))
  const packdata = loadPackData(dir)
  // 大脑启动时就是这么设的：物品和流体都叫游戏里的中文名
  useLocalNames(packdata.items, packdata.fluids)
  const h = makeAgent({ dir: tmp.dir, design: new DesignWorkspace({ dataDir: tmp.dir, packdata }), packdata, settings })
  t.after(async () => {
    await h.agent.stop()
    useLocalNames(undefined)
    packdata.recipes?.close()
    tmp.cleanup()
  })
  const g = h.game.handlers
  g['world.machines'] = () => ({ machines: MACHINES, total: MACHINES.length })
  g['world.find'] = () => ({ matches: [], total: 0 })
  // 固化器（两面有覆盖板）和超级缸（一罐氯）都算容器
  g['world.containers'] = () => ({
    containers: [
      { ...SOLIDIFIER, id: 'gregtech:gt.blockmachines', name: 'Basic Fluid Solidifier', kind: 'machine', slots: 2, usedSlots: 0, items: [], covers: COVERS, tanks: SOLIDIFIER_TANKS },
      { ...SUPER_TANK, id: 'gregtech:gt.blockmachines', name: 'Super Tank I', kind: 'machine', slots: 2, usedSlots: 0, items: [], tanks: [{ fluid: 'chlorine', name: 'Chlorine', amount: 67000, capacity: 4000000 }] },
    ],
    total: 2,
    offset: 0,
  })
  // 模具（环）只在固化器西面那块覆盖板里
  g['world.stock'] = (p) => ({
    containersLookedInto: 7,
    items: (p.items as { id: string; meta?: number }[]).map((q) =>
      q.id === GT && q.meta === 32322 ? { ...q, total: 1, places: [{ ...SOLIDIFIER, container: 'Basic Fluid Solidifier', kind: 'cover', cover: 'Basic Item Holder', side: 'west', count: 1 }] } : { ...q, total: 0, places: [] },
    ),
  })
  g['world.block'] = (p) => {
    const at = (b: { x: number; y: number; z: number }) => b.x === p.x && b.y === p.y && b.z === p.z
    if (at(SOLIDIFIER)) return { ...BLOCK, id: 'gregtech:gt.blockmachines', meta: 0, name: 'Basic Fluid Solidifier', covers: COVERS, tanks: SOLIDIFIER_TANKS }
    if (at(SUPER_TANK)) return { ...BLOCK, id: 'gregtech:gt.blockmachines', meta: 0, name: 'Super Tank I', tanks: [{ fluid: 'chlorine', name: 'Chlorine', amount: 67000, capacity: 4000000 }] }
    if (at(HATCH)) {
      const base = { ...BLOCK, id: 'gregtech:gt.blockmachines', meta: 0, name: 'Output Hatch (HV)', tanks: [{ amount: 0, capacity: 16000 }] }
      if (p.detail !== true) return base
      const detail = { ...base, class: 'gregtech.api.metatileentity.BaseMetaTileEntity', says: HATCH_SAYS }
      if (p.path === 'gt.covers') return { ...detail, path: 'gt.covers', saved: HATCH_SAVED['gt.covers'] }
      if (typeof p.path === 'string') return { ...detail, path: p.path, pathNotFound: true, saved: { Inventory: [], lockedFluidName: 'gas_gas' } }
      return { ...detail, saved: HATCH_SAVED }
    }
    const stone = { air: false, solid: true, liquid: false, replaceable: false, hardness: 1.5, tileEntity: false, inventory: false, id: 'minecraft:stone', meta: 0, name: 'Stone' }
    return p.detail === true ? { ...stone, detail: 'this block keeps no data of its own: its id and meta are all there is' } : stone
  }
  g['screen.open'] = () => ({ open: true, screen: 'Basic Item Holder', slotCount: 45, slots: [{ slot: 0, item: MOLD }] })
  return h
}

/** 模型用 run_program 跑一段程序，返回它 return 的值（JSON）。 */
async function program(h: AgentHarness, code: string): Promise<any> {
  const res = await modelCalls(h, 'run_program', { code })
  assert.equal(res.isError, false, res.content)
  return JSON.parse(/^Returned: (.*)$/ms.exec(res.content)![1]!)
}

const COVER_NOTE =
  'What a cover holds is not in the block\'s own slots: it is behind the cover\'s own screen, opened by sneaking and right-clicking that face. deposit_items / withdraw_items reach it with container {x, y, z, side, sneak: true}; open_screen with "at", "side" and sneak: true shows it.'
const WEST = 'cover on its west face: 基础槽位扩展 [gregtech:gt.metaitem.01/32380], 1/9 slots used: 1× gregtech:gt.metaitem.01/32322 "模具（环）"'
const SOUTH = 'cover on its south face: 基础槽位扩展 [gregtech:gt.metaitem.01/32380], 0/9 slots used: empty'

describe('覆盖板里的东西', () => {
  it('找模具：它在一台机器某个面的覆盖板里——find_in_storage 写明是哪台机器、哪个面、哪块覆盖板，和取它用的容器写法；照那个写法去取，身体收到的容器带着面和“蹲着”', async (t) => {
    const h = setup(t)
    const found = await modelCalls(h, 'find_in_storage', { items: [{ id: GT, meta: 32322 }], radius: 32 })
    assert.deepEqual(found.content.split('\n'), [
      'Looked into 7 container(s) within 32 blocks of you. withdraw_items takes things out (container = the position, items = the exact id/meta).',
      '- gregtech:gt.metaitem.01/32322 "模具（环）": 1 in total',
      '  - (-525,70,41) 基础流体固化器, in the cover "基础槽位扩展" on its west face: 1 — container {x: -525, y: 70, z: 41, side: "west", sneak: true}',
      'A place "in the cover … on its … face" is not the block\'s own slots: the cover has a screen of its own, opened by sneaking and right-clicking that face. withdraw_items / deposit_items take the container written after it.',
    ])
    // 照着取、再放回去：容器原样带着 side 和 sneak 交给身体
    await modelCalls(h, 'withdraw_items', { container: { ...SOLIDIFIER, side: 'west', sneak: true }, items: [{ id: GT, meta: 32322, count: 1 }] })
    await modelCalls(h, 'deposit_items', { container: { ...SOLIDIFIER, side: 'west', sneak: true }, items: [{ id: GT, meta: 32322 }] })
    assert.deepEqual(h.game.callsOf('task.start').map((p) => p.task), [
      { type: 'withdraw', container: { ...SOLIDIFIER, side: 'west', sneak: true }, items: [{ id: GT, meta: 32322, count: 1 }] },
      { type: 'deposit', container: { ...SOLIDIFIER, side: 'west', sneak: true }, items: [{ id: GT, meta: 32322 }] },
    ])
    // 面写错了被拦下
    assert.equal((await modelCalls(h, 'withdraw_items', { container: { ...SOLIDIFIER, side: 'left' }, items: [{ id: GT }] })).content, 'Invalid arguments for withdraw_items: container.side must be one of: down, up, north, south, west, east')
  })

  it('不带范围找（看整个基地）时：同一台机器自己的格子和它各个面的覆盖板是不同的存放点，四个方向重叠查到的同一处只算一次', async (t) => {
    const h = setup(t)
    h.game.handlers['world.stock'] = () => ({
      containersLookedInto: 3,
      items: [{ id: GT, meta: 32322, total: 3, places: [
        { ...SOLIDIFIER, container: 'Basic Fluid Solidifier', kind: 'cover', cover: 'Basic Item Holder', side: 'west', count: 1 },
        { ...SOLIDIFIER, container: 'Basic Fluid Solidifier', kind: 'cover', cover: 'Basic Item Holder', side: 'south', count: 1 },
        { ...SOLIDIFIER, container: 'Basic Fluid Solidifier', kind: 'machine', count: 1 },
      ] }],
    })
    const places = await program(h, `const r = await tool('find_in_storage', { items: [{ id: '${GT}', meta: 32322 }] }); return r.data.items[0].places.map((p) => [p.kind, p.side ?? null, p.count, p.cover ?? null])`)
    assert.deepEqual(places, [['cover', 'west', 1, 'Basic Item Holder'], ['cover', 'south', 1, 'Basic Item Holder'], ['machine', null, 1, null]])
  })

  it('开覆盖板自己的界面：open_screen 带着点哪个面、哪一点、蹲不蹲交给身体；没说是哪个方块时如实说', async (t) => {
    const h = setup(t)
    const opened = await modelCalls(h, 'open_screen', { at: SOLIDIFIER, side: 'west', sneak: true })
    assert.match(opened.content, /^Screen "Basic Item Holder"/)
    await modelCalls(h, 'open_screen', { at: SOLIDIFIER, side: 'up', hit: { x: 0.5, y: 1, z: 0.25 } })
    assert.deepEqual(h.game.callsOf('screen.open'), [
      { bot: 'Alu', ...SOLIDIFIER, side: 'west', sneak: true },
      { bot: 'Alu', ...SOLIDIFIER, side: 'up', hit: { x: 0.5, y: 1, z: 0.25 } },
    ])
    const lost = await modelCalls(h, 'open_screen', { side: 'west', sneak: true })
    assert.deepEqual([lost.isError, lost.content], [true, '"side", "hit" and "sneak" say how to click a block: give the block as "at".'])
  })

  it('看一台机器、看一片容器、看附近的机器：各个面的覆盖板和里面的东西都照实列出来，并写明怎么够得着；仓库总表把覆盖板里的东西算进去', async (t) => {
    const h = setup(t)
    assert.deepEqual((await modelCalls(h, 'inspect_block', SOLIDIFIER)).content.split('\n'), [
      '(-525,70,41): gregtech:gt.blockmachines "基础流体固化器" [solid, tileEntity, inventory] hardness 2',
      'tank: 144 of 16000 mB 熔融钢 [fluid molten.steel]',
      WEST,
      SOUTH,
      COVER_NOTE,
    ])
    assert.deepEqual((await modelCalls(h, 'list_containers', { at: SOLIDIFIER, radius: 4 })).content.split('\n'), [
      'Within 4 blocks of (-525,70,41): 2 container(s).',
      '- (-525,70,41) 基础流体固化器 [gregtech:gt.blockmachines] [machine] 0/2 slots used (tank: 144 of 16000 mB 熔融钢 [fluid molten.steel]): empty',
      `  ${WEST}`,
      `  ${SOUTH}`,
      // 氯不在配方册里：没有中文名，就用身体给的
      '- (-524,69,48) 超级缸 I [gregtech:gt.blockmachines] [machine] 0/2 slots used (tank: 67000 of 4000000 mB Chlorine [fluid chlorine]): empty',
      COVER_NOTE,
    ])
    const machines = (await modelCalls(h, 'find_machines', { radius: 32 })).content.split('\n')
    assert.deepEqual(machines.slice(1, 6), [
      '- (-525,70,41) "基础流体固化器": runs "流体固化器" recipes, tier LV, has power (4000 EU stored), idle, 3 blocks away',
      '    tank: 144 of 16000 mB 熔融钢 [fluid molten.steel]',
      `    ${WEST}`,
      `    ${SOUTH}`,
      '- (-527,70,41) "基础流体提取机": runs "流体提取机" recipes, tier LV, has power (4000 EU stored), idle, 5 blocks away',
    ])
    assert.equal(machines[6], '    tank: empty (holds up to 16000 mB)')
    assert.equal(machines.at(-1), COVER_NOTE)
    // 仓库总表（库函数）：机器自己的格子不算，覆盖板里的算，写明在哪个面
    const stock = await program(h, `const r = await tool('list_stock', { at: ${JSON.stringify(SOLIDIFIER)}, radius: 4 }); return { text: r.text.split('\\n'), places: r.data.items[0].places }`)
    assert.deepEqual(stock.text, [
      'Looked into 0 chest(s) and drawer(s) and 2 cover(s) that hold items within 4 blocks of (-525,70,41) (the own slots of 2 machine(s) and drawer controller(s) not counted): 1 kind(s) of item. A place marked "cover <side>" is a cover on that face of the block there: withdraw_items with container {x, y, z, side, sneak: true}. 1 item(s), most first:',
      '- 1× 模具（环） [gregtech:gt.metaitem.01/32322]: (-525,70,41) cover west 1',
    ])
    assert.deepEqual(stock.places, [{ ...SOLIDIFIER, kind: 'cover', side: 'west', count: 1 }])
  })
})

describe('流体', () => {
  it('机器状态里的流体叫游戏里的中文名（石油、含硫轻燃油），程序拿到的数据里英文原名留着；罐、覆盖板在数据里是全的', async (t) => {
    const h = setup(t)
    const tower = (await modelCalls(h, 'find_machines', { radius: 32 })).content.split('\n').slice(7, 12)
    assert.deepEqual(tower, [
      '- (-518,69,56) "蒸馏塔": multiblock, formed, runs "蒸馏塔" recipes, tier HV (512 V), idle (it says: Not enough output space), 16 blocks away',
      '    input bus (-519,69,56), 0/4 slots used, circuit 9',
      '    input hatch (-517,69,56), 16000/16000 mB 石油 [fluid oil]',
      '    output hatch (-518,70,58), 16000/16000 mB 含硫轻燃油 [fluid liquid_sufluriclight_fuel]',
      // 它卡在哪条配方：输入仓里的流体、总线上的电路都在上面了，这一句是拿它们去查的写法
      '    the recipe it is on, with all it takes and gives: the library function find_uses {fluid: "oil", way: "蒸馏塔", circuit: 9}',
    ])
    const data = await program(h, `const m = (await tool('find_machines', { radius: 32 })).data.machines; return { hatch: m[2].inputHatches[0], tank: m[0].tanks[0], cover: m[0].covers[0].items[0], block: (await tool('inspect_block', ${JSON.stringify(SUPER_TANK)})).data.tanks }`)
    assert.deepEqual(data, {
      hatch: { x: -517, y: 69, z: 56, name: 'Input Hatch (HV)', kind: 'input hatch', capacity: 16000, fluid: 'oil', fluidName: '石油', fluidEn: 'Oil', amount: 16000 },
      tank: { fluid: 'molten.steel', name: '熔融钢', en: 'Molten Steel', amount: 144, capacity: 16000 },
      cover: { id: GT, meta: 32322, count: 1, name: '模具（环）', en: 'Mold (Ring)' },
      // 本地资料里没有的流体：名字原样
      block: [{ fluid: 'chlorine', name: 'Chlorine', amount: 67000, capacity: 4000000 }],
    })
  })

  it('找得到流体：用中文名、英文名、内部名都行，写明它是流体、怎么拿它去查配方；NEI 的“流体展示”物品说清它是哪种流体的图；记错一个字时给出相近的名字', async (t) => {
    const h = setup(t)
    const HOW = 'A fluid is not an item: find_recipes (how it is made) and the library function find_uses (what takes it) are asked with "fluid" instead of "id": its name, or the internal name in the brackets.'
    assert.deepEqual((await modelCalls(h, 'find_item', { query: '含硫轻燃油' })).content.split('\n'), [
      '"含硫轻燃油" matches 1 item(s), most alike first.',
      '- 含硫轻燃油 [NotEnoughItems:neiFluidDisplay/137]: not an item you can hold — NEI\'s picture of the fluid 含硫轻燃油 [fluid liquid_sufluriclight_fuel]',
      'Fluids matching "含硫轻燃油" (1):',
      '- 含硫轻燃油 [fluid liquid_sufluriclight_fuel] (Sulfuric Light Fuel): 3 recipe(s) make it; used in 0',
      HOW,
    ])
    // 英文名、内部名
    for (const query of ['sulfuric light fuel', 'liquid_sufluriclight_fuel']) {
      assert.match((await modelCalls(h, 'find_item', { query })).content, /\n- 含硫轻燃油 \[fluid liquid_sufluriclight_fuel\] \(Sulfuric Light Fuel\): 3 recipe\(s\) make it; used in 0\n/)
    }
    // 同名的两种流体都列出来，各有几条配方
    const steel = (await modelCalls(h, 'find_item', { query: '熔融钢' })).content.split('\n')
    assert.deepEqual(steel.slice(2, 5), [
      'Fluids matching "熔融钢" (2):',
      '- 熔融钢 [fluid molten.steel] (Molten Steel): 1 recipe(s) make it; used in 1',
      '- 熔融钢 [fluid steel.molten] (Molten Steel): 0 recipe(s) make it; used in 1',
    ])
    // 主人那次：记成了“含硫轻燃料”（差一个字）
    assert.equal(
      (await modelCalls(h, 'find_item', { query: '含硫轻燃料' })).content,
      'No item or fluid matches "含硫轻燃料". Names one or two characters away: 含硫轻燃油 [NotEnoughItems:neiFluidDisplay/137], 含硫轻燃油 [fluid liquid_sufluriclight_fuel]. Try fewer or other words: part of the Chinese name, of the English name, of the id, or an ore-dictionary name such as plateSteel.',
    )
  })

  it('按流体查做法：熔融钢怎么来——哪种机器、吃什么、附近那台机器的罐里现在有多少；同名的两种流体让它挑；拿 NEI 的流体展示物品来问，答的是那种流体；别的 mod 把流体画成物品的配方也算上', async (t) => {
    const h = setup(t)
    const made = (await modelCalls(h, 'find_recipes', { fluid: 'molten.steel' })).content.split('\n')
    assert.deepEqual(made.slice(0, 3), [
      "熔融钢 [fluid molten.steel] can be made 1 way(s), 1 recipe(s) in all. Listed by way of making, in the recipe book's order; what stands in your base for each way is stated, nothing is ranked or recommended:",
      '1. 流体提取机 — 1 recipe(s); CAN RUN NOW on 基础流体提取机 at (-527,70,41) LV',
      '   #0: 1× 钢板 [gregtech:gt.metaitem.01/17305] → 144 mB 熔融钢 — LV (30 EU/t), 1.2 s',
    ])
    // 名字对着两种流体：都列出来，各有几条配方，让它挑
    const both = await modelCalls(h, 'find_recipes', { fluid: '熔融钢' })
    assert.deepEqual([both.isError, both.content], [true, '2 fluids are named "熔融钢": 熔融钢 [fluid molten.steel] (1 recipe(s) make it, 1 use it); 熔融钢 [fluid steel.molten] (0 recipe(s) make it, 1 use it). Give the internal name in the brackets as "fluid".'])
    // 拿流体展示物品的 id 来问（它搜英文名搜到的就是这个）：答的是那种流体
    const light = (await modelCalls(h, 'find_recipes', { id: NEI, meta: 137 })).content.split('\n')
    assert.equal(light[0], "含硫轻燃油 [fluid liquid_sufluriclight_fuel] can be made 1 way(s), 3 recipe(s) in all. (含硫轻燃油 [NotEnoughItems:neiFluidDisplay/137] is NEI's picture of this fluid, not an item you can hold: this is about the fluid itself.) Listed by way of making, in the recipe book's order; what stands in your base for each way is stated, nothing is ranked or recommended:")
    // 石油：GregTech 的页里没有出它的配方，别的 mod 的页把它画成物品——照样查得到
    const oil = (await modelCalls(h, 'find_recipes', { fluid: '石油' })).content.split('\n')
    assert.match(oil[0]!, /^石油 \[fluid oil\] can be made 1 way\(s\), 1 recipe\(s\) in all\./)
    assert.match(oil[1]!, /^1\. 抽油机 — 1 recipe\(s\); /)
    // 没有的流体、两个都给了
    assert.equal((await modelCalls(h, 'find_recipes', { fluid: '岩浆' })).content, 'No fluid matches "岩浆". A fluid is asked for by its Chinese or English name or its internal name; find_item finds fluids too.')
    assert.equal((await modelCalls(h, 'find_recipes', { id: GT, fluid: 'oil' })).content, 'Give exactly one of "id" (an item) or "fluid" (a fluid: its name, or its internal name such as molten.steel).')
  })

  it('配方要的流体不再是“看不到”：固化器的罐里现在有多少熔融钢、一轮要多少，照实写；照配方开工时也说罐里有多少；身体没报罐的才说没报', async (t) => {
    const h = setup(t)
    const ring = (await modelCalls(h, 'find_recipes', { id: GT, meta: 28305 })).content.split('\n')
    assert.deepEqual(ring.slice(1, 3), [
      '1. 流体固化器 — 1 recipe(s); CAN RUN NOW on 基础流体固化器 at (-525,70,41) LV',
      '   #1: 36 mB 熔融钢 (fluid); needs 模具（环） [gregtech:gt.metaitem.01/32322] (stays in the machine, not used up) → 1× 钢环 — LV (30 EU/t), 5 s [the tanks of the 基础流体固化器 at (-525,70,41) now hold 144 mB 熔融钢 (one round takes 36)]',
    ])
    // 开工：两轮要 72 mB，罐里现在 144
    const started = await modelCalls(h, 'process_items', { machine: SOLIDIFIER, recipe: 1, rounds: 2, moldInside: true })
    assert.match(started.content, / This recipe also takes 72 mB 熔融钢 in all, from inside the machine \(its tank, or a multiblock's input hatch\)\. Its tanks now hold 144 mB 熔融钢\.$/)
  })

  it('身体没报一台机器的罐时：照实说读不到，指到能看它全部数据的办法，不说成“没有”', async (t) => {
    const h = setup(t)
    // 同一台固化器，只是这回身体没带 tanks 这一项
    const solidifier: Record<string, unknown> = { ...MACHINES[0]! }
    delete solidifier.tanks
    h.game.handlers['world.machines'] = () => ({ machines: [solidifier], total: 1 })
    h.game.handlers['world.block'] = () => ({ ...BLOCK, id: 'gregtech:gt.blockmachines', meta: 0, name: 'Basic Fluid Solidifier' })
    const blind = (await modelCalls(h, 'find_recipes', { id: GT, meta: 28305 })).content.split('\n')[2]!
    assert.match(blind, / \[what the tanks of the 基础流体固化器 at \(-525,70,41\) hold cannot be read; inspect_block with "detail" shows everything the machine keeps\]$/)
    assert.match((await modelCalls(h, 'process_items', { machine: SOLIDIFIER, recipe: 1, moldInside: true })).content, / What its tanks hold is not reported; inspect_block with "detail" shows everything the machine keeps\.$/)
  })

  it('一台机器现在在做哪条配方：加工方式 + 输入里的流体 + 编程电路号一筛就是那一条，全部产物和数量都在；按产物、按原料筛也行', async (t) => {
    const h = setup(t)
    // find_machines 在蒸馏塔下面给的那句查询，照抄
    const running = await program(h, `const r = await tool('find_uses', { fluid: "oil", way: "蒸馏塔", circuit: 9 }); return { text: r.text.split('\\n'), data: r.data }`)
    assert.deepEqual(running.text, [
      // 用到石油的只有蒸馏塔这一种方式，所以开头不用再写“by 蒸馏塔”
      'Recipes that use 石油 [fluid oil] with programmed circuit 9: 1 recipe(s).',
      '#3: 1000 mB 石油 (fluid); needs programmed circuit 9 → 1000 mB 含硫轻燃油, 1200 mB 炼油气 — HV (480 EU/t), 3.2 s',
    ])
    assert.deepEqual(running.data, {
      fluid: { fluid: 'oil', name: '石油', en: 'Oil' },
      total: 1,
      page: 1,
      pages: 1,
      recipes: [{
        recipe: 3,
        way: '蒸馏塔',
        in: [{ id: 'gregtech:gt.integrated_circuit', meta: 9, name: '编程电路 9', count: 0 }],
        out: [],
        fluidsIn: [{ fluid: 'oil', name: '石油', mb: 1000 }],
        fluidsOut: [{ fluid: LIGHT, name: '含硫轻燃油', mb: 1000 }, { fluid: 'gas_gas', name: '炼油气', mb: 1200 }],
        eut: 480,
        ticks: 64,
      }],
    })
    // 不给电路：石油在蒸馏塔里有两条；汇总里按方式列
    const uses = await program(h, `const r = await tool('find_uses', { fluid: "石油" }); return [r.text.split('\\n')[0], r.text.split('\\n')[1], r.data.ways]`)
    assert.deepEqual(uses, ['石油 [fluid oil] is an ingredient of 2 recipe(s), in 1 way(s) (the same recipe can be listed more than once in the book):', '- 蒸馏塔: 2 recipe(s), e.g. makes 含硫轻燃油', [{ way: '蒸馏塔', name: '蒸馏塔', recipes: 2 }]])
    // 从产物那头查（find_recipes 在工具清单里）：蒸馏塔里电路 9 出含硫轻燃油的有两条，再按原料里含“石油”筛就是那一条
    const byProduct = (await modelCalls(h, 'find_recipes', { fluid: LIGHT, way: '蒸馏塔', circuit: 9 })).content.split('\n')
    assert.deepEqual(byProduct.slice(0, 3), [
      '含硫轻燃油 [fluid liquid_sufluriclight_fuel] with programmed circuit 9: 2 recipe(s).',
      '#3: 1000 mB 石油 (fluid); needs programmed circuit 9 → 1000 mB 含硫轻燃油, 1200 mB 炼油气 — HV (480 EU/t), 3.2 s',
      '#4: 1000 mB 重油 (fluid); needs programmed circuit 9 → 450 mB 含硫轻燃油 — HV (480 EU/t), 3.2 s',
    ])
    const narrowed = (await modelCalls(h, 'find_recipes', { fluid: LIGHT, circuit: 9, contains: '石油' })).content.split('\n')
    assert.deepEqual(narrowed.slice(0, 2), ['含硫轻燃油 [fluid liquid_sufluriclight_fuel] with an ingredient containing "石油" with programmed circuit 9: 1 recipe(s).', '#3: 1000 mB 石油 (fluid); needs programmed circuit 9 → 1000 mB 含硫轻燃油, 1200 mB 炼油气 — HV (480 EU/t), 3.2 s'])
    // 对不上的电路号：没有，写明筛之前有几条
    assert.equal((await modelCalls(h, 'find_recipes', { fluid: LIGHT, circuit: 5 })).content.split('\n')[0], 'No recipe for 含硫轻燃油 [fluid liquid_sufluriclight_fuel] with programmed circuit 5 (3 recipe(s) before the "contains" and "circuit" filter; 3 in all). Try another word: part of an ingredient\'s Chinese or English name, id or ore name.')
  })

  it('算总料时带着流体的一步：做 5 个钢环要 180 mB 熔融钢，点名了出它的配方就按 mB 往下乘——流体提取机一轮出 144，所以化 2 个钢板（多 108 mB）；没点名的流体记成要供的，写着现在哪个罐里有多少；重名的流体带着注册名分得开', async (t) => {
    const h = setup(t)
    // 从零算（不看库存）：钢环点名固化器那条、熔融钢点名提取机那条
    const sum = await program(h, `const r = await tool('total_materials', { id: '${GT}', meta: 28305, count: 5, stock: false, recipes: [1, 0] }); return { text: r.text.split('\\n'), data: r.data }`)
    assert.deepEqual(sum.text, [
      "For 5× 钢环 [gregtech:gt.metaitem.01/28305]: 3 thing(s) to make in 3 wave(s) (2 named by you, 1 with only one recipe); 0 thing(s) NOT DECIDED. This adds up amounts by the base's methods (0 entries); it chooses no recipe.",
      'Storage was not looked into (stock: false): everything is counted from nothing.',
      'No raw material is needed.',
      'Missing capability:',
      // 钢板只有一条配方：拿另一种也叫“熔融钢”的流体（匠魂的）浇——它不是提取机出的那种，所以是要供的
      "- fluids to supply (a fluid is made only by a recipe you name or one the base's methods record for it): 288 mB 熔融钢 [fluid steel.molten] (no machine tank here holds any that can be read)",
      '- needed at hand but not used up, one of each: 模具（环） [gregtech:gt.metaitem.01/32322]',
      'Jobs, 3, by when they can start and by way:',
      'Wave 1 — these take only raw materials and what is in storage:',
      '- 流体固化器 (1 job(s)) — CAN RUN NOW on 基础流体固化器 at (-525,70,41) LV',
      '  - #6 × 2 → 2× 钢板 [gregtech:gt.metaitem.01/17305] [only recipe]',
      'Wave 2 — these take things made in wave 1 (or earlier):',
      '- 流体提取机 (1 job(s)) — CAN RUN NOW on 基础流体提取机 at (-527,70,41) LV',
      '  - #0 × 2 → 288 mB 熔融钢 [fluid molten.steel]; 108 left over [named by you]',
      'Wave 3 — these take things made in wave 2 (or earlier):',
      '- 流体固化器 (1 job(s)) — CAN RUN NOW on 基础流体固化器 at (-525,70,41) LV',
      '  - #1 × 5 → 5× 钢环 [gregtech:gt.metaitem.01/28305] [named by you]',
    ])
    assert.deepEqual(sum.data.steps, [
      { recipe: 6, way: '流体固化器', rounds: 2, makes: { id: GT, meta: 17305, name: '钢板', count: 2 }, needed: 2, rule: 'only', wave: 1, level: 2 },
      { recipe: 0, way: '流体提取机', rounds: 2, makes: { fluid: 'molten.steel', name: '熔融钢', count: 288 }, needed: 180, rule: 'named', wave: 2, level: 1 },
      { recipe: 1, way: '流体固化器', rounds: 5, makes: { id: GT, meta: 28305, name: '钢环', count: 5 }, needed: 5, rule: 'named', wave: 3, level: 0 },
    ])
    assert.deepEqual([sum.data.raw, sum.data.fluids], [[], [{ fluid: 'steel.molten', name: '熔融钢', mb: 288 }]])
    // 只点名固化器那条：熔融钢没人说怎么来，是要供的流体；固化器的罐里现在有 144 mB，照实写
    const only = await program(h, `const r = await tool('total_materials', { id: '${GT}', meta: 28305, count: 5, stock: false, recipes: [1] }); return [r.text.split('\\n').find((line) => line.startsWith('- fluids')), r.data.fluids]`)
    assert.deepEqual(only, [
      "- fluids to supply (a fluid is made only by a recipe you name or one the base's methods record for it): 180 mB 熔融钢 [fluid molten.steel] (tanks here hold 144 mB in 基础流体固化器 at (-525,70,41) LV)",
      [{ fluid: 'molten.steel', name: '熔融钢', mb: 180 }],
    ])
    // 目标本身是流体：数量按 mB
    const liquid = await program(h, `const r = await tool('total_materials', { fluid: 'molten.steel', count: 1000, stock: false, recipes: [0] }); return [r.text.split('\\n')[0], r.text.split('\\n').at(-1), r.data.target]`)
    assert.deepEqual(liquid, [
      "For 1000 mB 熔融钢 [fluid molten.steel]: 2 thing(s) to make in 2 wave(s) (1 named by you, 1 with only one recipe); 0 thing(s) NOT DECIDED. This adds up amounts by the base's methods (0 entries); it chooses no recipe.",
      '  - #0 × 7 → 1008 mB 熔融钢 [fluid molten.steel]; 8 left over [named by you]',
      { fluid: 'molten.steel', name: '熔融钢', count: 1000 },
    ])
  })
})

describe('一个方块的全部数据（inspect_block 的 detail）', () => {
  it('看一个输出仓为什么空着还说“输出空间不足”：它自己说的话、它存档里的全部数据原样给出来（锁定的流体就在里面），内部名字附一个中文对照；只看一部分用 path', async (t) => {
    const h = setup(t)
    const plain = (await modelCalls(h, 'inspect_block', HATCH)).content
    assert.equal(plain, '(-518,70,58): gregtech:gt.blockmachines "Output Hatch (HV)" [solid, tileEntity, inventory] hardness 2\ntank: empty (holds up to 16000 mB)')
    const detail = await modelCalls(h, 'inspect_block', { ...HATCH, detail: true })
    assert.deepEqual(detail.content.split('\n'), [
      '(-518,70,58): gregtech:gt.blockmachines "Output Hatch (HV)" [solid, tileEntity, inventory] hardness 2',
      'tank: empty (holds up to 16000 mB)',
      'What it says of itself (as to a scanner):',
      '  Output Hatch',
      '  Stored Fluid: No Fluid',
      '  0 L 16,000 L',
      '  Locked to fluid.gas_gas',
      'Its own saved data, whole (class gregtech.api.metatileentity.BaseMetaTileEntity); the keys are its internal names, the values raw:',
      '  Inventory: []',
      '  lockedFluidName: "gas_gas"',
      '  mFacing: 5',
      '  mMode: 9',
      '  mDisplayed: {"id":"gregtech:gt.metaitem.01","meta":32380,"name":"Basic Item Holder"}',
      '  gt.covers: [{"side":4,"item":{"item":"gregtech:gt.metaitem.01","meta":32380,"count":1,"name":"Basic Item Holder"}}]',
      // 原文一个字不动；查得到中文名的内部名字列在最后
      'Names in the above, as the game shows them: fluid.gas_gas = 炼油气; gas_gas = 炼油气; gregtech:gt.metaitem.01/32380 = 基础槽位扩展',
    ])
    assert.deepEqual(h.game.callsOf('world.block').at(-1), { ...HATCH, detail: true })
    // 只看一部分
    const part = await modelCalls(h, 'inspect_block', { ...HATCH, path: 'gt.covers' })
    assert.deepEqual(part.content.split('\n').slice(7), [
      'Its saved data under "gt.covers":',
      '  [0]: {"side":4,"item":{"item":"gregtech:gt.metaitem.01","meta":32380,"count":1,"name":"Basic Item Holder"}}',
      'Names in the above, as the game shows them: fluid.gas_gas = 炼油气; gregtech:gt.metaitem.01/32380 = 基础槽位扩展',
    ])
    assert.deepEqual(h.game.callsOf('world.block').at(-1), { ...HATCH, detail: true, path: 'gt.covers' })
    // 路径不存在：说没有，给出顶层
    const wrong = (await modelCalls(h, 'inspect_block', { ...HATCH, path: 'nope' })).content.split('\n')
    assert.deepEqual(wrong.slice(7, 10), ['There is nothing at "nope" in its saved data. Its top level:', '  Inventory: []', '  lockedFluidName: "gas_gas"'])
    // 没有自己数据的方块
    assert.equal((await modelCalls(h, 'inspect_block', { x: 0, y: 60, z: 0, detail: true })).content, '(0,60,0): minecraft:stone "Stone" [solid] hardness 1.5\nIt keeps no data of its own (this block keeps no data of its own: its id and meta are all there is).')
  })

  it('程序里拿得到同一份数据，一个键不少、一个字不改：写个循环就能把一片机器的某个设置扫一遍', async (t) => {
    const h = setup(t)
    const got = await program(h, `const r = await tool('inspect_block', { x: ${HATCH.x}, y: ${HATCH.y}, z: ${HATCH.z}, detail: true }); return { locked: r.data.saved.lockedFluidName, keys: Object.keys(r.data.saved), says: r.data.says, cover: r.data.saved['gt.covers'][0].item, shown: r.data.saved.mDisplayed, name: r.data.name }`)
    assert.deepEqual(got, {
      locked: 'gas_gas',
      keys: ['Inventory', 'lockedFluidName', 'mFacing', 'mMode', 'mDisplayed', 'gt.covers'],
      says: HATCH_SAYS,
      // 存档里的东西原样：名字还是身体给的那个，没有被换成中文，也没有多出 en
      cover: { item: GT, meta: 32380, count: 1, name: 'Basic Item Holder' },
      shown: { id: GT, meta: 32380, name: 'Basic Item Holder' },
      name: 'Output Hatch (HV)',
    })
  })

  it('存档数据比一个结果装得下的还多：能放几项放几项，写明一共多长、每一项多长，照着挑一项用 path 往里看；程序拿到的 data 照样是全的', async (t) => {
    const h = setup(t, { toolResultMaxChars: 900 })
    const big = { mMode: 9, Inventory: Array.from({ length: 30 }, (_, n) => ({ item: 'minecraft:cobblestone', meta: 0, count: 64, name: 'Cobblestone', Slot: n })), lockedFluidName: 'gas_gas' }
    h.game.handlers['world.block'] = (p) => ({ ...BLOCK, id: 'gregtech:gt.blockmachines', meta: 0, name: 'Output Hatch (HV)', ...(p.detail === true ? { class: 'X', saved: big, savedCut: true } : {}) })
    const res = await modelCalls(h, 'inspect_block', { ...HATCH, detail: true })
    const lines = res.content.split('\n')
    assert.ok(res.content.length <= 900, `the result is ${res.content.length} characters`)
    const whole = JSON.stringify(big.Inventory).length + '  Inventory: '.length
    assert.equal(lines[1], 'Its own saved data, whole (class X); the keys are its internal names, the values raw:')
    assert.equal(lines[2], `It is ${whole + 28 + 10 + 3} characters, more than fits here. One part of it whole: give one of these as "path" (path: characters) — Inventory: ${whole}, lockedFluidName: 28, mMode: 10.`)
    // 放得下的那一项照给；放不下的那一项给个开头并写明多长
    assert.equal(lines[3], '  mMode: 9')
    assert.match(lines[4]!, new RegExp(`^  Inventory: \\[\\{"item":"minecraft:cobblestone".*… \\(cut: ${whole} characters\\)$`))
    assert.deepEqual(lines.slice(5), ['… 1 more key(s) not shown.', 'Where an entry says "ask for this path" or "more entr(ies)", that part was left out: give it as "path" (written like gt.covers or Inventory[3].tag).', 'Names in the above, as the game shows them: gas_gas = 炼油气'])
    assert.equal(await program(h, `return (await tool('inspect_block', { x: 1, y: 2, z: 3, detail: true })).data.saved.Inventory.length`), 30)
  })
})
