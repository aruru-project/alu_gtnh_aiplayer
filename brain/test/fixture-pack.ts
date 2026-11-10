// 一个极小的“客户端整合包”：只有任务书那几样文件，形状照真实的 GTNH 2.9.0 客户端包抄的
// （BetterQuesting 的带类型后缀的 JSON、章节目录、QuestLinesOrder.txt、txloader 的 zh_CN.lang）。
// 测试拿它跑 tools/make-packdata.py，再让大脑读生成出来的资料：生成器和大脑之间的文件约定是真的走了一遍，不是两头各测各的。
//
// 这本书和模拟 bridge 自带的那本（mock-bridge.ts 的 defaultQuestBook）是同一本的“客户端版”：1、2、43、47、4a 和那个 UUID 任务
// 两边都有，所以模拟 bridge 里 Steve 的进度（做完了 1 和 2）拿来配它正合适。

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { makeZip } from './helpers.ts'

const GENERATOR = path.resolve(import.meta.dirname, '../../tools/make-packdata.py')
const ROOT = 'instance/.minecraft/'
const QUESTS = `${ROOT}config/betterquesting/DefaultQuests/`
const GT = 'gregtech:gt.metaitem.01'

export const NIGHT_WATCH = 'a81f1f2c-3d7e-4a4c-9a55-1f2e3d4c5b6a'
export const TRAVEL_LINE = '6c06a5f2-4677-47c7-914f-068781b62428'

type Json = Record<string, unknown>

// ── id 的几种写法 ──

/** 资料和服务器用的短 id → 完整的 UUID。 */
function uuidOf(id: string): string {
  return /^[0-9a-f]{1,12}$/.test(id) ? `00000000-0000-0000-0000-${id.padStart(12, '0')}` : id
}

/** 文件名、QuestLinesOrder.txt 和 questcompletion 奖励里的写法：UUID 的 base64（URL 安全，带 == 结尾）。 */
function base64Of(id: string): string {
  return `${Buffer.from(uuidOf(id).replaceAll('-', ''), 'hex').toString('base64url')}==`
}

/** 任务文件里的写法：两个有符号的 64 位整数。 */
function halves(id: string): { high: bigint; low: bigint } {
  const hex = uuidOf(id).replaceAll('-', '')
  return { high: BigInt.asIntN(64, BigInt(`0x${hex.slice(0, 16)}`)), low: BigInt.asIntN(64, BigInt(`0x${hex.slice(16)}`)) }
}

/** 和 JSON.stringify 一样，只是认 bigint（64 位整数在这些文件里是直接写出来的数字）。 */
function toJson(v: unknown): string {
  if (typeof v === 'bigint') return v.toString()
  if (Array.isArray(v)) return `[${v.map(toJson).join(',')}]`
  if (v !== null && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${toJson(x)}`).join(',')}}`
  return JSON.stringify(v)
}

/** BetterQuesting 把列表写成以位置为键的对象：{"0:10": …, "1:10": …}。 */
function list(items: readonly Json[]): Json {
  return Object.fromEntries(items.map((item, i) => [`${i}:10`, item]))
}

function item(id: string, damage: number, count: number, extra: { ore?: string; tag?: Json } = {}): Json {
  return { 'Count:3': count, 'Damage:2': damage, 'OreDict:8': extra.ore ?? '', 'id:8': id, ...(extra.tag ? { 'tag:10': extra.tag } : {}) }
}

function retrieval(items: Json[], opts: { optional?: boolean; consume?: boolean; anyOne?: boolean; ignoreNBT?: boolean } = {}): Json {
  return {
    'autoConsume:1': 0,
    'consume:1': opts.consume ? 1 : 0,
    'groupDetect:1': 0,
    'ignoreNBT:1': opts.ignoreNBT ? 1 : 0,
    'index:3': 0,
    'partialMatch:1': 1,
    'requireOnlyOneItem:1': opts.anyOne ? 1 : 0,
    'requiredItems:9': list(items),
    'taskID:8': opts.optional ? 'bq_standard:optional_retrieval' : 'bq_standard:retrieval',
  }
}

function crafting(items: Json[]): Json {
  return {
    'allowAnvil:1': 0,
    'allowCraft:1': 1,
    'allowCraftedFromStatistics:1': 0,
    'allowSmelt:1': 1,
    'ignoreNBT:1': 1,
    'index:3': 0,
    'partialMatch:1': 1,
    'requiredItems:9': list(items),
    'taskID:8': 'bq_standard:crafting',
  }
}

const itemReward = (items: Json[]): Json => ({ 'ignoreDisabled:1': 0, 'index:3': 0, 'rewardID:8': 'bq_standard:item', 'rewards:9': list(items) })
const choiceReward = (items: Json[]): Json => ({ 'choices:9': list(items), 'ignoreDisabled:1': 0, 'index:3': 0, 'rewardID:8': 'bq_standard:choice' })

interface FixtureQuest {
  id: string
  /** Quests/ 下的哪个目录（真包里按章节分，另有 NoQuestLine 和 MultipleQuestLine）。 */
  folder: string
  /** 任务文件里的英文原文，带着游戏里的格式码。 */
  name: string
  desc: string
  /** zh_CN.lang 里的写法（%n 换行、%% 百分号）。没有就是整合包没翻译这一个。 */
  zh?: { name: string; desc: string }
  pre?: string[]
  logic?: string
  taskLogic?: string
  main?: boolean
  visibility?: string
  repeatTime?: number
  tasks: Json[]
  rewards: Json[]
}

interface FixtureLine {
  id: string
  folder: string
  name: string
  desc: string
  zh: { name: string; desc: string }
  /** 这一章里的任务和它们在画布上的位置。 */
  quests: { id: string; x: number; y: number }[]
}

const QUEST_LIST: FixtureQuest[] = [
  {
    id: '1',
    folder: 'Tier0StoneAge-AAAAAAAAAAAAAAAAAAAAAQ==',
    name: '§9§lThe Beginning',
    desc: 'Welcome to GregTech: New Horizons!\n\nPunch a tree to get some wood.',
    zh: { name: '§9§l万事开头难', desc: '欢迎来到§6格雷科技：新视野§r！%n%n先撸树，弄点木头。[note]木头有 100%% 的用处。[/note]' },
    main: true,
    tasks: [retrieval([item('minecraft:log', 32767, 4, { ore: 'logWood' })])],
    rewards: [itemReward([item('minecraft:apple', 0, 4)])],
  },
  {
    id: '2',
    folder: 'Tier0StoneAge-AAAAAAAAAAAAAAAAAAAAAQ==',
    name: 'Tools of the Trade',
    desc: 'Vanilla tools do not work here. Build a Tinkers Construct pickaxe.',
    zh: { name: '趁手的工具', desc: '原版工具在这里不好使。做一把匠魂的镐子。' },
    pre: ['1'],
    tasks: [crafting([item('TConstruct:pickaxe', 0, 1)])],
    rewards: [choiceReward([item('minecraft:bread', 0, 8), item('minecraft:torch', 0, 16)])],
  },
  {
    id: '43',
    folder: 'Tier05Steam-AAAAAAAAAAAAAAAAAAAAAg==',
    name: '§c§lWired, Weird?!',
    desc: 'Cables carry electricity. Make some tin cables to get started with LV.',
    zh: { name: '§c§l导线，奇怪？', desc: '线缆用来输电。做几根锡线缆，为 LV 做准备。' },
    pre: ['2'],
    main: true,
    tasks: [retrieval([item('gregtech:gt.blockmachines', 1246, 4)], { consume: true })],
    rewards: [itemReward([item(GT, 32000, 5)])],
  },
  {
    id: '47',
    folder: 'Tier05Steam-AAAAAAAAAAAAAAAAAAAAAg==',
    name: '§c§lBasic Crafting: Motors',
    desc: 'Motors are little devices that turn electricity into motion. You will need a lot of them.',
    zh: {
      name: '§c§l基础制作：马达',
      desc: '电动马达把电变成转动，以后要用很多。%n%n[warn]磁化铁杆要用红石。[/warn]%n详见 [url]https://wiki.gtnewhorizons.com[/url]',
    },
    pre: ['43'],
    main: true,
    tasks: [crafting([item(GT, 32600, 2)]), retrieval([item(GT, 23032, 2)], { optional: true })],
    rewards: [itemReward([item(GT, 32000, 15)])],
  },
  {
    id: '4a',
    folder: 'MultipleQuestLine',
    name: 'Take to the Skies',
    desc: 'A Copter Pack lets you hover around your base. Build one and show it to me.',
    zh: { name: '飞向天空', desc: '直升机背包能让你在基地上空悬停。做一个给我看看。' },
    tasks: [retrieval([item('adventurebackpack:copterPack', 0, 1)])],
    rewards: [itemReward([item(GT, 32000, 10)])],
  },
  {
    id: NIGHT_WATCH,
    folder: 'Tier0StoneAge-AAAAAAAAAAAAAAAAAAAAAQ==',
    name: 'Night Watch',
    desc: 'The nights are dangerous. Thin out the zombies, then visit the Nether and bring a bucket of water.',
    zh: { name: '守夜人', desc: '夜里很危险。清一清僵尸，去一趟下界，再带一桶水来。' },
    tasks: [
      { 'damageType:8': '', 'ignoreNBT:1': 1, 'index:3': 0, 'required:3': 10, 'subtypes:1': 1, 'target:8': 'Zombie', 'targetNBT:10': {}, 'taskID:8': 'bq_standard:hunt' },
      {
        'biome:3': -1,
        'dimension:3': -1,
        'hideInfo:1': 0,
        'index:3': 1,
        'invert:1': 0,
        'name:8': 'THE NETHER',
        'posX:3': 0,
        'posY:3': 0,
        'posZ:3': 0,
        'range:3': -1,
        'structure:8': '',
        'taskID:8': 'bq_standard:location',
        'taxiCabDist:1': 0,
        'visible:1': 0,
      },
      {
        'autoConsume:1': 0,
        'consume:1': 0,
        'groupDetect:1': 0,
        'ignoreNBT:1': 0,
        'index:3': 2,
        'requiredFluids:9': list([{ 'Amount:3': 1000, 'FluidName:8': 'water' }]),
        'taskID:8': 'bq_standard:fluid',
      },
    ],
    rewards: [],
  },
  {
    // 前置是“任意一个”：2 做完了就解锁，哪怕 47 还没做
    id: '50',
    folder: 'Tier05Steam-AAAAAAAAAAAAAAAAAAAAAg==',
    name: 'Two Roads',
    desc: 'Either way leads here.',
    zh: { name: '条条大路', desc: '哪条路都能到这里。' },
    pre: ['2', '47'],
    logic: 'OR',
    tasks: [{ 'index:3': 0, 'taskID:8': 'bq_standard:checkbox' }],
    rewards: [],
  },
  {
    // 前置是“恰好一个”：1 和 2 都做完了，反而锁着
    id: '51',
    folder: 'Tier05Steam-AAAAAAAAAAAAAAAAAAAAAg==',
    name: 'One or the Other',
    desc: 'You cannot have both.',
    zh: { name: '二选一', desc: '鱼和熊掌不可兼得。' },
    pre: ['1', '2'],
    logic: 'XOR',
    tasks: [{ 'index:3': 0, 'taskID:8': 'bq_standard:checkbox' }],
    rewards: [],
  },
  {
    // 语言文件里没有它；前置指向一个不存在的任务
    id: '52',
    folder: 'Tier05Steam-AAAAAAAAAAAAAAAAAAAAAg==',
    name: '§2§lTools of the Trade 4 - Rubber Boots',
    desc: 'Some crops do not enjoy being stepped on.\n\n[note]Wear rubber boots.[/note]',
    pre: ['99'],
    tasks: [retrieval([item('dreamcraft:MoldBoots', 0, 1), item('IC2:itemArmorRubBoots', 32767, 1)])],
    rewards: [],
  },
  {
    id: '53',
    folder: 'GettingAround-bAal8kZ3R8eRTwaHgbYkKA==',
    name: 'Daily Bread',
    desc: 'Hand in bread or a cookie, or just tick the box.',
    zh: { name: '每日面包', desc: '交面包或者曲奇，或者直接打个勾。做马达见[questlink]AAAAAAAAAAAAAAAAAAAARw==[/questlink]。' },
    repeatTime: 72000,
    taskLogic: 'OR',
    tasks: [retrieval([item('minecraft:bread', 0, 1), item('minecraft:cookie', 0, 1)], { consume: true, anyOne: true }), { 'index:3': 1, 'taskID:8': 'bq_standard:checkbox' }],
    rewards: [
      { 'amount:3': 3, 'ignoreDisabled:1': 0, 'index:3': 0, 'isLevels:1': 1, 'rewardID:8': 'bq_standard:xp' },
      { 'ignoreDisabled:1': 1, 'index:3': 1, 'isSilent:1': 0, 'questID:8': 'AAAAAAAAAAAAAAAAAAAAYA==', 'rewardID:8': 'bq_standard:questcompletion' },
    ],
  },
  {
    id: '54',
    folder: 'Tier0StoneAge-AAAAAAAAAAAAAAAAAAAAAQ==',
    name: 'Queen of the Hive',
    desc: 'Catch a princess.',
    zh: { name: '蜂后', desc: '抓一只公主蜂。' },
    tasks: [
      retrieval([
        item('Forestry:beePrincessGE', 0, 1, {
          tag: { 'Genome:10': { 'Chromosomes:9': { '0:10': { 'UID0:8': 'forestry.speciesForest', 'UID1:8': 'forestry.speciesForest' } } } },
        }),
      ]),
    ],
    rewards: [],
  },
  {
    // 不在任何章节里的内部任务：玩家在书里看不到
    id: '60',
    folder: 'NoQuestLine',
    name: 'Trigger: Skip',
    desc: 'No Description',
    zh: { name: '触发器：跳过', desc: '无描述' },
    visibility: 'HIDDEN',
    tasks: [{ 'index:3': 0, 'taskID:8': 'bq_standard:checkbox' }],
    rewards: [],
  },
]

// 章节目录在压缩包里的先后（按字母）和书里的顺序（QuestLinesOrder.txt）故意不一样
const LINE_LIST: FixtureLine[] = [
  {
    id: '1',
    folder: 'Tier0StoneAge-AAAAAAAAAAAAAAAAAAAAAQ==',
    name: 'Tier 0 - Stone Age',
    desc: 'The basics, until your first steam machine.',
    zh: { name: '第0阶 - 石器时代', desc: '打基础，直到做出第一台蒸汽机器。' },
    quests: [
      { id: '2', x: 48, y: 0 },
      { id: '1', x: 0, y: 0 },
      { id: NIGHT_WATCH, x: 0, y: 48 },
      { id: '54', x: 0, y: 96 },
    ],
  },
  {
    id: '2',
    folder: 'Tier05Steam-AAAAAAAAAAAAAAAAAAAAAg==',
    name: 'Tier 0.5 - Steam',
    desc: 'Steam power.',
    zh: { name: '第0.5阶 - 蒸汽时代', desc: '蒸汽动力。' },
    quests: [
      { id: '47', x: 24, y: 0 },
      { id: '43', x: 0, y: 0 },
      { id: '4a', x: 0, y: 24 },
      { id: '50', x: 48, y: 24 },
      { id: '51', x: 48, y: 48 },
      { id: '52', x: 48, y: 72 },
    ],
  },
  {
    id: TRAVEL_LINE,
    folder: 'GettingAround-bAal8kZ3R8eRTwaHgbYkKA==',
    name: 'Getting Around...',
    desc: 'Ways to travel.',
    zh: { name: '游历四方……', desc: '出行的办法。' },
    quests: [
      { id: '4a', x: 0, y: 0 },
      { id: '53', x: 24, y: 0 },
    ],
  },
]

function questFile(q: FixtureQuest): string {
  const { high, low } = halves(q.id)
  return toJson({
    'preRequisites:9': list((q.pre ?? []).map((id) => ({ 'questIDHigh:4': halves(id).high, 'questIDLow:4': halves(id).low }))),
    'properties:10': {
      'betterquesting:10': {
        'autoClaim:1': 0,
        'desc:8': q.desc,
        'globalShare:1': 1,
        'icon:10': item('minecraft:stick', 0, 1),
        'isMain:1': q.main ? 1 : 0,
        'isSilent:1': 0,
        'lockedProgress:1': 0,
        'name:8': q.name,
        'questLogic:8': q.logic ?? 'AND',
        'repeatTime:3': q.repeatTime ?? -1,
        'repeat_relative:1': 1,
        'simultaneous:1': 0,
        'snd_complete:8': 'random.levelup',
        'taskLogic:8': q.taskLogic ?? 'AND',
        'visibility:8': q.visibility ?? 'NORMAL',
      },
    },
    'questIDHigh:4': high,
    'questIDLow:4': low,
    'rewards:9': list(q.rewards),
    'tasks:9': list(q.tasks),
  })
}

/** 那个小客户端包的全部文件。 */
export function fixturePackEntries(): { name: string; data: string }[] {
  const entries: { name: string; data: string }[] = [
    { name: `${ROOT}options.txt`, data: 'lang:zh_CN\n' },
    { name: `${QUESTS}QuestSettings.json`, data: toJson({ 'betterquesting:10': { 'editMode:1': 0, 'pack_name:8': 'GT-New-Horizons' }, 'format:8': '3.1.0' }) },
    // 书里的顺序：石器时代、出行、蒸汽
    { name: `${QUESTS}QuestLinesOrder.txt`, data: [LINE_LIST[0]!, LINE_LIST[2]!, LINE_LIST[1]!].map((l) => `${base64Of(l.id)}: ${l.name}\n`).join('') },
  ]
  for (const line of [...LINE_LIST].sort((a, b) => a.folder.localeCompare(b.folder))) {
    const { high, low } = halves(line.id)
    entries.push({
      name: `${QUESTS}QuestLines/${line.folder}/QuestLine.json`,
      data: toJson({
        'properties:10': { 'betterquesting:10': { 'bg_image:8': '', 'bg_size:3': 256, 'desc:8': line.desc, 'icon:10': item('minecraft:stick', 0, 1), 'name:8': line.name, 'visibility:8': 'UNLOCKED' } },
        'questLineIDHigh:4': high,
        'questLineIDLow:4': low,
      }),
    })
    for (const member of line.quests) {
      entries.push({
        name: `${QUESTS}QuestLines/${line.folder}/Quest-${base64Of(member.id)}.json`,
        data: toJson({ 'questIDHigh:4': halves(member.id).high, 'questIDLow:4': halves(member.id).low, 'sizeX:3': 24, 'sizeY:3': 24, 'x:3': member.x, 'y:3': member.y }),
      })
    }
  }
  for (const q of QUEST_LIST) entries.push({ name: `${QUESTS}Quests/${q.folder}/Quest-${base64Of(q.id)}.json`, data: questFile(q) })

  const key = (id: string) => base64Of(id).replace(/=+$/, '')
  const lang: string[] = ['### Quest Lines ###', '']
  for (const line of LINE_LIST) {
    lang.push(`## Quest Line: ${line.name}`, `betterquesting.questline.${key(line.id)}.name=${line.zh.name}`, `betterquesting.questline.${key(line.id)}.desc=${line.zh.desc}`, '')
  }
  for (const q of QUEST_LIST) {
    if (q.zh) lang.push(`# Quest: ${q.name}`, `betterquesting.quest.${key(q.id)}.name=${q.zh.name}`, `betterquesting.quest.${key(q.id)}.desc=${q.zh.desc}`, '')
  }
  entries.push({ name: `${ROOT}config/txloader/forceload/betterquesting/lang/zh_CN.lang`, data: lang.join('\n') })
  return entries
}

/** 这台机器上有没有 python3（生成器是 Python 写的；没有就跳过要用它的测试）。 */
export function pythonMissing(): string | false {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  return probe.error || probe.status !== 0 ? 'python3 is not available, so tools/make-packdata.py cannot run' : false
}

export interface GeneratorRun {
  status: number | null
  stdout: string
  stderr: string
}

/** 跑一次 tools/make-packdata.py quests。 */
export function runGenerator(clientZip: string, outDir: string): GeneratorRun {
  const run = spawnSync('python3', [GENERATOR, 'quests', '--client', clientZip, '--out', outDir], { encoding: 'utf8' })
  if (run.error) throw run.error
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

/** 把那个小客户端包写到 dir 里，并用生成器在 dir/packdata 生成资料。返回两者的路径。 */
export function buildFixturePackdata(dir: string): { zip: string; packdata: string } {
  const zip = path.join(dir, 'Fixture-client.zip')
  fs.writeFileSync(zip, makeZip(fixturePackEntries()))
  const packdata = path.join(dir, 'packdata')
  const run = runGenerator(zip, packdata)
  if (run.status !== 0) throw new Error(`make-packdata.py failed (${run.status}): ${run.stderr || run.stdout}`)
  return { zip, packdata }
}
