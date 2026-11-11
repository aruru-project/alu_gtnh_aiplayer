// 物品图标的图集（src/packdata/icons.ts）：哪样东西的图标是第几个。
// 图标的编号就是物品表里的行号，而物品表每次整套导出行数和顺序都会变一点——
// 图集和物品表不是同一次导出的话，每个图标都会错位，所以对不上时宁可当没有图标。

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { itemIconsStillValid, loadItemIcons } from '../src/packdata/icons.ts'
import { tmpDir } from './helpers.ts'

const ITEMS = [
  { id: 'minecraft:stone', meta: 0, name: '石头' },
  { id: 'minecraft:dirt', meta: 0, name: '泥土' },
  { id: 'minecraft:dirt', meta: 2, name: '灰化土' },
  { id: 'minecraft:air', meta: 0, name: '空气' },
  { id: 'mod:tool', meta: 32767, name: '工具（任何 meta）' },
  { id: 'mod:gem', meta: 7, name: '宝石' },
]
const sha1Of = (items: { id: string; meta: number }[]): string => crypto.createHash('sha1').update(items.map((i) => `${i.id}/${i.meta}\n`).join('')).digest('hex')

/** 在临时目录里摆一份 packdata：items.jsonl 和 icons/（说明文件加一张假的图）。 */
function pack(t: { after(fn: () => void): void }, manifest: Record<string, unknown> = {}, opts: { items?: typeof ITEMS; sheet?: boolean } = {}): { dir: string; logs: string[] } {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  const items = opts.items ?? ITEMS
  fs.writeFileSync(path.join(tmp.dir, 'items.jsonl'), `${items.map((i) => JSON.stringify(i)).join('\n')}\n`)
  fs.mkdirSync(path.join(tmp.dir, 'icons'))
  fs.writeFileSync(path.join(tmp.dir, 'icons', 'icons.json'), JSON.stringify({ format: 1, generatedAt: '2026-11-11T16:17:48+08:00', cell: 32, columns: 2, rows: 2, count: ITEMS.length, itemsSha1: sha1Of(ITEMS), files: ['icons-000.png', 'icons-001.png'], missing: [3], ...manifest }))
  if (opts.sheet !== false) for (const name of ['icons-000.png', 'icons-001.png']) fs.writeFileSync(path.join(tmp.dir, 'icons', name), 'png')
  return { dir: tmp.dir, logs: [] }
}

describe('物品图标：哪样东西是第几个', () => {
  it('一样东西的图标编号就是它在物品表里的行号（从 0 数）；图集的规格照说明文件', (t) => {
    const p = pack(t)
    const icons = loadItemIcons(p.dir, (m) => p.logs.push(m))!
    assert.deepEqual([icons.cell, icons.columns, icons.rows, icons.count, icons.files.map((f) => path.basename(f)), icons.version], [32, 2, 2, 6, ['icons-000.png', 'icons-001.png'], '2026-11-11T16:17:48+08:00'])
    assert.equal(icons.indexOf('minecraft:stone', 0), 0)
    assert.equal(icons.indexOf('minecraft:dirt', 2), 2)
    assert.equal(icons.indexOf('mod:gem', 7), 5)
    assert.match(p.logs.join('\n'), /物品图标：6 个/)
  })

  it('按 id/meta 找不到时：退到这个 id 不限 meta 的那一行，再退到这个 id 的头一行；表里压根没有的没有图标', (t) => {
    const icons = loadItemIcons(pack(t).dir)!
    // 背包里的工具带着具体的 meta，物品表里只有“任何 meta”的那一行
    assert.equal(icons.indexOf('mod:tool', 3), 4)
    // 泥土没有 meta 9 这一行：用它的头一行
    assert.equal(icons.indexOf('minecraft:dirt', 9), 1)
    assert.equal(icons.indexOf('othermod:thing', 0), undefined)
  })

  it('画出来是空的那几个（说明文件的 missing，比如“空气”）当没有图标，面板用替代的画法', (t) => {
    const icons = loadItemIcons(pack(t).dir)!
    assert.equal(icons.indexOf('minecraft:air', 0), undefined)
  })
})

describe('物品图标：和物品表对不上时宁可没有', () => {
  it('图集里的个数和物品表的行数不一样（不是同一次导出的）：当没有图标，日志里写明原因', (t) => {
    const p = pack(t, {}, { items: [...ITEMS, { id: 'mod:new', meta: 0, name: '新加的' }] })
    assert.equal(loadItemIcons(p.dir, (m) => p.logs.push(m)), undefined)
    assert.match(p.logs.join('\n'), /图集里有 6 个图标，物品表（items\.jsonl）有 7 行/)
  })

  it('行数一样但顺序变了（itemsSha1 对不上）：当没有图标', (t) => {
    const swapped = [ITEMS[1]!, ITEMS[0]!, ...ITEMS.slice(2)]
    const p = pack(t, {}, { items: swapped })
    assert.equal(loadItemIcons(p.dir, (m) => p.logs.push(m)), undefined)
    assert.match(p.logs.join('\n'), /itemsSha1 不一样/)
  })

  it('没有 icons 目录、少了一张图、说明文件写坏了：都当没有图标，不报错', (t) => {
    const none = tmpDir()
    t.after(none.cleanup)
    assert.equal(loadItemIcons(none.dir), undefined)
    assert.equal(loadItemIcons(pack(t, {}, { sheet: false }).dir), undefined)
    const broken = pack(t)
    fs.writeFileSync(path.join(broken.dir, 'icons', 'icons.json'), '{not json')
    assert.equal(loadItemIcons(broken.dir, (m) => broken.logs.push(m)), undefined)
    assert.match(broken.logs.join('\n'), /物品图标用不了/)
    // 说明文件点到 icons 目录外面的文件：不认
    assert.equal(loadItemIcons(pack(t, { files: ['../items.jsonl'] }).dir), undefined)
  })

  it('大脑运行期间图集被重新导出了（说明文件换过）：原来读的那份不能再用', (t) => {
    const p = pack(t)
    const icons = loadItemIcons(p.dir)!
    assert.equal(itemIconsStillValid(icons), true)
    const file = path.join(p.dir, 'icons', 'icons.json')
    fs.writeFileSync(file, fs.readFileSync(file))
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000))
    assert.equal(itemIconsStillValid(icons), false)
  })
})
