// “知识 → 指南”读一页之前的那一步（src/panel/public/markdown.js）：大脑读成字以后的正文（Markdown）→ 块和行内的结构。
// 认错了，主人看到的就是一堆记号，或者页间链接点不动、表格散架。画到页面上的那一半在浏览器里看（test/panel-shots.ts 截图）。
// 例子都是照着整合包指南里真有的写法写的（gregtech、appliedenergistics2 那几本）。

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

type Json = Record<string, any>
interface Markdown {
  parseBlocks(text: string): Json[]
  parseInline(text: string): Json[]
  linkTarget(href: string): Json | null
  slugOf(title: string): string
  plainText(text: string): string
}
const md = (await import(new URL('../src/panel/public/markdown.js', import.meta.url).href)) as Markdown

/** 行内结构 → 一串简写，方便比较：text 原样，别的写成 <种类:…>。 */
function show(nodes: Json[]): string {
  return nodes
    .map((n) => {
      if (n.t === 'text') return n.v
      if (n.t === 'br') return '<br>'
      if (n.t === 'item') return `<item:${n.id}>`
      if (n.t === 'code') return `<code:${n.v}>`
      if (n.t === 'link') return `<link:${n.href}:${show(n.c)}>`
      if (n.t === 'abbr') return `<abbr:${n.title}:${show(n.c)}>`
      if (n.t === 'game') return `<game:${n.kind}:${show(n.c)}>`
      return `<${n.t}:${show(n.c ?? [])}>`
    })
    .join('')
}

describe('指南的正文：行内', () => {
  it('“中文名 [id/meta]”里的 id 认成物品；页间链接、粗体、按键、带说明的 <a> 各是各的', () => {
    const nodes = md.parseInline('可手持软锤 [gregtech:gt.metatool.01/14]<kbd>右键</kbd>切换，见[变压器](gregtech:power/distribution.md#变压器)和**单方块变压器**，<a title="译注：涌现">涌现</a>')
    assert.equal(show(nodes), '可手持软锤 <item:gregtech:gt.metatool.01/14><kbd:右键>切换，见<link:gregtech:power/distribution.md#变压器:变压器>和<strong:单方块变压器>，<abbr:译注：涌现:涌现>')
  })

  it('“游戏里这里显示的是什么”那一句认成一块，换成中文的种类；里面的物品照样认', () => {
    assert.equal(show(md.parseInline('[a recipe for [appliedenergistics2:item.ItemMultiMaterial/68] is shown here in the game]')), '<game:配方:a recipe for <item:appliedenergistics2:item.ItemMultiMaterial/68>>')
    assert.equal(show(md.parseInline('[image shown here in the game: GTNH Logo (gtnh_logo.png)]')), '<game:图片:GTNH Logo (gtnh_logo.png)>')
    assert.equal(show(md.parseInline('[3D scene shown here in the game: the structure of 有源变压器 [gregtech:gt.blockmachines/15300]]')), '<game:立体场景:the structure of 有源变压器 <item:gregtech:gt.blockmachines/15300>>')
  })

  it('转义的星号是字，不是粗体；不认得的标签原样当字；换行是换行', () => {
    assert.equal(show(md.parseInline('\\*\\*\\*\\* 和 <player>名字</player>\n下一行<br>再一行')), '**** 和 <player>名字</player><br>下一行<br>再一行')
  })

  it('链接指向哪里：book:path（可带 #小节）是指南里的一页，http 是站外，# 开头是这一页里的小节，别的认不出来', () => {
    assert.deepEqual(md.linkTarget('gregtech:power/distribution.md#%E5%8F%98%E5%8E%8B%E5%99%A8'), { kind: 'page', path: 'gregtech:power/distribution.md', anchor: '变压器' })
    assert.deepEqual(md.linkTarget('appliedenergistics2:getting_started.md'), { kind: 'page', path: 'appliedenergistics2:getting_started.md' })
    assert.deepEqual(md.linkTarget('https://wiki.gtnewhorizons.com/wiki/Main_Page'), { kind: 'web', url: 'https://wiki.gtnewhorizons.com/wiki/Main_Page' })
    assert.deepEqual(md.linkTarget('#爆炸'), { kind: 'anchor', anchor: '爆炸' })
    assert.equal(md.linkTarget('From'), null)
  })

  it('小节的锚点和 GitHub 一样写（指南里的链接就是这么写的）', () => {
    assert.equal(md.slugOf('到达 1tick 后的超频（1toc）'), '到达-1tick-后的超频1toc')
    assert.equal(md.slugOf('Hot Ingot Routing'), 'hot-ingot-routing')
  })

  it('搜索结果的那一小段去掉记号和物品 id，只留字', () => {
    assert.equal(md.plainText('…局部电力网络由三部分构成： - **输电方块**：例如[变压器](gregtech:power/distribution.md#变压器)、有源变压器 [gregtech:gt.blockmachines/15300]。'), '…局部电力网络由三部分构成：输电方块：例如变压器、有源变压器。')
  })
})

describe('指南的正文：块', () => {
  const kinds = (blocks: Json[]): string[] => blocks.map((b) => b.type)

  it('标题、段落、提示框（> [!WARNING]）、列表分得开；提示框里的字是它的内容', () => {
    const blocks = md.parseBlocks('# 变压器\n\n> [!WARNING]\n> 变压器带电时，切换其模式会使其立刻爆炸。\n\n变压设备可以改变电压。\n\n- 最大输入电压：输入面对应等级的标准电压。\n- 输出电压：输出面对应等级的标准电压。')
    assert.deepEqual(kinds(blocks), ['heading', 'quote', 'para', 'list'])
    assert.deepEqual([blocks[0]!.level, blocks[0]!.slug], [1, '变压器'])
    assert.equal(blocks[1]!.alert, 'WARNING')
    assert.equal(blocks[1]!.blocks[0].text, '变压器带电时，切换其模式会使其立刻爆炸。')
    assert.equal(blocks[3]!.items.length, 2)
  })

  it('缩进的子列表挂在上一项下面', () => {
    const [list] = md.parseBlocks('- 许多页面有可交互场景，你可以：\n  - 用鼠标左键旋转。\n  - 使用侧面的按钮开关网格。\n- 将鼠标移至最左侧。')
    assert.equal(list!.items.length, 2)
    const nested = list!.items[0].blocks
    assert.deepEqual(kinds(nested), ['para', 'list'])
    assert.equal(nested[1].items.length, 2)
  })

  it('表格：表头、对齐、每一行；单元格里的 \\| 是字', () => {
    const [table] = md.parseBlocks('| 25% | 耐久损失10%的镐 |\n| :--: | --: |\n| 几近损坏的镐 | ✔ |\n| a \\| b | \\*\\*\\*\\* |')
    assert.equal(table!.type, 'table')
    assert.deepEqual(table!.align, ['center', 'right'])
    assert.deepEqual(table!.head, ['25%', '耐久损失10%的镐'])
    assert.deepEqual(table!.rows, [['几近损坏的镐', '✔'], ['a | b', '\\*\\*\\*\\*']])
  })

  it('<details> 收着的一块：summary 是标题，里面缩进的表格照样认；代码块里的东西不当 Markdown', () => {
    const blocks = md.parseBlocks('### Recipes\n\n<details>\n  <summary>UEV Recipes</summary>\n\n  | Recipes | Duration |\n  | --- | --- |\n  | [gregtech:gt.metaitem.03/32319] | 300 s |\n</details>\n\n```lua\nlocal x = **1**\n```')
    assert.deepEqual(kinds(blocks), ['heading', 'details', 'code'])
    assert.equal(blocks[1]!.summary, 'UEV Recipes')
    assert.deepEqual(kinds(blocks[1]!.blocks), ['table'])
    assert.deepEqual([blocks[2]!.lang, blocks[2]!.text], ['lua', 'local x = **1**'])
  })
})
