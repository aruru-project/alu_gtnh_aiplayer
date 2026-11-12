// 游戏味的那几样组件：物品格子（图标、数量、耐久条、悬停说明）、物品栏、开着的界面、血量和饥饿、玩家的头。
// 图都是整数倍放大、不抹匀的（image-rendering: pixelated）。心、鸡腿、头是照着像素表画在 canvas 上的，不用任何图片文件。

import { api, h, put } from './ui.js'

/** 一个格子里图标的边长（像素）。格子本身是 36：四周各 2 像素的凹槽边。 */
const ICON = 32

// ── 图标 ──

/**
 * 一样东西的图标。look 是后端给的画法（见 panel/live.ts）：
 *   { icon: n }   物品图标图集里的第 n 个
 *   { tex: n }    方块贴图图集里的第 n 格（一格 16 像素，放大两倍）
 *   { color }     没有图：色块加名字的头一个字
 * looks 是两张图集在哪、怎么切。图集没有（或者这张图没取到）时一律退到色块。
 */
export function itemIcon(item, looks, size = ICON) {
  const look = item.look ?? {}
  const el = h('span', { class: 'icon', 'aria-hidden': 'true' })
  el.style.width = `${size}px`
  el.style.height = `${size}px`
  const icons = looks?.icons
  const textures = looks?.textures
  if (typeof look.icon === 'number' && icons) {
    const perSheet = icons.columns * icons.rows
    const sheet = Math.floor(look.icon / perSheet)
    const cell = look.icon % perSheet
    el.classList.add('sprite')
    el.style.backgroundImage = `url("${icons.sheets[sheet]}")`
    el.style.backgroundSize = `${icons.columns * size}px ${icons.rows * size}px`
    el.style.backgroundPosition = `-${(cell % icons.columns) * size}px -${Math.floor(cell / icons.columns) * size}px`
    return el
  }
  if (typeof look.tex === 'number' && textures) {
    el.classList.add('sprite', 'block')
    el.style.backgroundImage = `url("${textures.url}")`
    el.style.backgroundSize = `${textures.columns * size}px ${textures.rows * size}px`
    el.style.backgroundPosition = `-${(look.tex % textures.columns) * size}px -${Math.floor(look.tex / textures.columns) * size}px`
    if (look.tint) {
      // 灰的贴图（草、树叶）要染色：和底色相乘
      el.style.backgroundColor = `rgb(${look.tint.join(',')})`
      el.style.backgroundBlendMode = 'multiply'
    }
    return el
  }
  const color = Array.isArray(look.color) ? look.color : [120, 120, 120]
  el.classList.add('swatch')
  if (look.known === false) el.classList.add('guess')
  el.style.backgroundColor = `rgb(${color.join(',')})`
  // 亮底用深字，暗底用浅字
  const light = (color[0] * 299 + color[1] * 587 + color[2] * 114) / 1000 > 140
  el.style.color = light ? '#1b1b1b' : '#f4f4f4'
  el.style.fontSize = `${Math.round(size * 0.5)}px`
  el.textContent = [...(item.name ?? '?')][0] ?? '?'
  return el
}

const countText = (n) => (n >= 100000 ? `${Math.round(n / 1000)}k` : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n))

// ── 悬停说明（游戏里那种深色小框）──

let tip
function tipEl() {
  if (!tip) {
    tip = h('div', { class: 'mc-tip', role: 'tooltip', hidden: true })
    document.body.append(tip)
  }
  return tip
}

function tipLines(slot) {
  const item = slot.item
  const lines = []
  if (!item) {
    lines.push(h('div', { class: 'tip-dim', text: slot.label ?? '空格' }))
    return lines
  }
  lines.push(h('div', { class: 'tip-name', text: item.name }))
  if (item.en) lines.push(h('div', { class: 'tip-dim', text: item.en }))
  lines.push(h('div', { class: 'tip-id', text: `${item.id}${item.meta ? ` / ${item.meta}` : ''}` }))
  const facts = [`${item.count} 个`]
  if (typeof item.durability === 'number') facts.push(`耐久剩 ${Math.round(item.durability * 100)}%`)
  if (slot.held) facts.push('拿在手里')
  if (slot.takesNothing) facts.push('产物格')
  if (slot.ghost) facts.push('只是显示，里面没有真东西')
  lines.push(h('div', { class: 'tip-dim', text: facts.join(' · ') }))
  if (item.look?.known === false) lines.push(h('div', { class: 'tip-dim', text: '没有它的图标，色块只是用来区分' }))
  return lines
}

function showTip(slot, x, y) {
  const el = tipEl()
  put(el, ...tipLines(slot))
  el.hidden = false
  const pad = 14
  const w = el.offsetWidth
  const hgt = el.offsetHeight
  let left = x + pad
  let top = y - hgt - 6
  if (left + w > window.innerWidth - 6) left = Math.max(6, x - w - pad)
  if (top < 6) top = Math.min(window.innerHeight - hgt - 6, y + pad)
  el.style.left = `${left}px`
  el.style.top = `${top}px`
}

function hideTip() {
  if (tip) tip.hidden = true
}

// ── 格子 ──

/**
 * 一个格子。slot: { slot?, item?, held?, takesNothing?, ghost?, label?（空格时的说明，如“头盔”）, mark?（空格里淡淡的一个字） }
 * 悬停、键盘聚焦都显示说明；点一下把这一格“选中”（onPick），页面下面那行详情跟着变。
 */
export function slotEl(slot, looks, onPick) {
  const item = slot.item
  const el = h('button', {
    type: 'button',
    class: `slot${slot.held ? ' held' : ''}${slot.takesNothing ? ' output' : ''}${slot.ghost ? ' ghost' : ''}${item ? '' : ' empty'}`,
    'aria-label': item ? `${item.name}，${item.count} 个${slot.held ? '，拿在手里' : ''}` : (slot.label ?? '空格'),
  })
  if (item) {
    el.append(itemIcon(item, looks))
    if (item.count !== 1) el.append(h('span', { class: 'count', text: countText(item.count) }))
    if (typeof item.durability === 'number' && item.durability < 0.999) {
      const bar = h('span', { class: 'dura' }, h('span'))
      bar.firstChild.style.width = `${Math.max(4, Math.round(item.durability * 100))}%`
      bar.firstChild.style.backgroundColor = `hsl(${Math.round(item.durability * 120)}, 90%, 45%)`
      el.append(bar)
    }
  } else if (slot.mark) {
    el.append(h('span', { class: 'mark', text: slot.mark }))
  }
  el.addEventListener('mouseenter', (ev) => showTip(slot, ev.clientX, ev.clientY))
  el.addEventListener('mousemove', (ev) => showTip(slot, ev.clientX, ev.clientY))
  el.addEventListener('mouseleave', hideTip)
  el.addEventListener('focus', () => {
    const r = el.getBoundingClientRect()
    showTip(slot, r.right - 8, r.top)
  })
  el.addEventListener('blur', hideTip)
  if (onPick) el.addEventListener('click', () => onPick(slot))
  return el
}

/** 选中的那一格的详情：一行它是什么，下面是它的提示文字（游戏里鼠标放上去看到的那几行）。 */
export function slotDetail(slot) {
  const item = slot?.item
  if (!item) return h('p', { class: 'slot-detail muted', text: '点一个格子看它是什么。' })
  return h(
    'div',
    null,
    h(
      'p',
      { class: 'slot-detail' },
      h('strong', { text: item.name }),
      ` ×${item.count}`,
      typeof item.durability === 'number' ? ` · 耐久剩 ${Math.round(item.durability * 100)}%` : '',
      h('span', { class: 'mono muted', text: `  ${item.id}${item.meta ? `/${item.meta}` : ''}` }),
    ),
    tooltipBox(item),
  )
}

// ── 提示文字 ──

/** 问过的提示文字："id/meta" → { tip, shift?, ctrl? }；没有提示的是 null。没有这份资料时整个是 false。 */
const tooltips = new Map()
let tooltipsAvailable = true
/** 上次看的是哪个画面（不按键 / Shift / Ctrl）：换一格还停在那个画面上（有的话）。 */
let tooltipScreen = 'tip'
const SCREENS = [
  ['tip', '不按键'],
  ['shift', '按住 Shift'],
  ['ctrl', '按住 Ctrl'],
]

/**
 * 一样东西的提示文字：三个画面分开（按住 Shift、Ctrl 时是换成另一版，不是接在后面）。
 * 第一次要的时候去问，问到了填进这个框里；问过的记着。
 */
function tooltipBox(item) {
  const key = `${item.id}/${item.meta ?? 0}`
  const box = h('div', { class: 'mc-tt-box' })
  const fill = () => {
    const tt = tooltips.get(key)
    if (!tooltipsAvailable) return put(box)
    if (tt === undefined) return put(box, h('p', { class: 'hint', text: '正在取它的提示文字…' }))
    if (tt === null) return put(box, h('p', { class: 'hint', text: '游戏里它的名字下面没有别的字。' }))
    const have = SCREENS.filter(([k]) => k === 'tip' || tt[k])
    const screen = have.some(([k]) => k === tooltipScreen) ? tooltipScreen : 'tip'
    const lines = tt[screen] ?? []
    const tabs =
      have.length > 1
        ? h(
            'div',
            { class: 'mc-tt-tabs', role: 'tablist', 'aria-label': '按住哪个键' },
            have.map(([k, label]) => {
              const b = h('button', { type: 'button', role: 'tab', class: 'small', 'aria-selected': String(k === screen), text: label })
              b.addEventListener('click', () => {
                tooltipScreen = k
                fill()
              })
              return b
            }),
          )
        : null
    put(
      box,
      tabs,
      h(
        'div',
        { class: 'mc-tt', role: 'tabpanel', 'aria-label': `${SCREENS.find(([k]) => k === screen)[1]}时的提示` },
        h('div', { class: 'mc-tt-name', text: item.name }),
        lines.length === 0 ? h('div', { class: 'mc-tt-empty', text: screen === 'tip' ? '（不按键时名字下面没有字，按住 Shift 才有）' : '（这时名字下面没有字）' }) : lines.map((line) => (line === '---' ? h('hr') : line.trim() === '' ? h('div', { class: 'mc-tt-gap' }) : h('div', { class: 'mc-tt-line', text: line }))),
      ),
      h('p', { class: 'hint', text: '这几行是对着一件新拿出来的样品看到的：电量、存量、经验、绑定这类说的是样品，不是它身上这一件。' }),
    )
  }
  fill()
  if (!tooltips.has(key) && tooltipsAvailable) {
    api('GET', `/items/tooltips?q=${encodeURIComponent(key)}`).then(
      (res) => {
        if (res.available === false) tooltipsAvailable = false
        tooltips.set(key, res.tooltips?.[key] ?? null)
        fill()
      },
      () => {
        // 这个版本的大脑没有这个接口，或者一时没连上：不显示
        tooltipsAvailable = false
        fill()
      },
    )
  }
  return box
}

/**
 * 一组格子只占一个 Tab 位：Tab 进到这一组，方向键在格子之间走（一行 columns 格），不用按几十下 Tab 才出得去。
 */
function grid(className, label, columns, cells) {
  const el = h('div', { class: className, role: 'group', 'aria-label': `${label}（方向键在格子之间移动）` }, cells)
  cells.forEach((cell, n) => (cell.tabIndex = n === 0 ? 0 : -1))
  el.addEventListener('keydown', (ev) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns, Home: -Infinity, End: Infinity }[ev.key]
    if (step === undefined) return
    const at = cells.indexOf(document.activeElement)
    if (at < 0) return
    const next = Math.max(0, Math.min(cells.length - 1, step === -Infinity ? 0 : step === Infinity ? cells.length - 1 : at + step))
    ev.preventDefault()
    cells[at].tabIndex = -1
    cells[next].tabIndex = 0
    cells[next].focus()
  })
  return el
}

/** 盔甲格以外穿东西的地方（身体给的 slot 名字）。 */
const WORN_SLOTS = { back: '背上' }

const ARMOR = [
  { index: 3, label: '头盔（空）', mark: '头' },
  { index: 2, label: '胸甲（空）', mark: '胸' },
  { index: 1, label: '护腿（空）', mark: '腿' },
  { index: 0, label: '靴子（空）', mark: '靴' },
]

/**
 * 物品栏：盔甲四格、背包 9×3、快捷栏 9 格（手里拿的那格有白框）。和游戏里的格子编号一样：0–8 快捷栏，9–35 背包。
 * live 是 /api/live 的结果（在线时）。
 */
export function inventoryPanel(live, onPick) {
  const looks = live.looks
  const bySlot = new Map((live.inventory ?? []).map((s) => [s.slot, s]))
  const cell = (n) => {
    const s = bySlot.get(n)
    return slotEl({ slot: n, item: s?.item, held: n === live.heldSlot, label: n === live.heldSlot ? '空手' : undefined }, looks, onPick)
  }
  const range = (from, to) => Array.from({ length: to - from }, (_, i) => cell(from + i))
  const held = bySlot.get(live.heldSlot)?.item
  const used = (live.inventory ?? []).length
  return h(
    'div',
    { class: 'mc-panel inventory' },
    h(
      'div',
      { class: 'mc-title' },
      h('span', { text: '物品栏' }),
      h('span', { class: 'mc-note', text: typeof live.freeSlots === 'number' ? `空 ${live.freeSlots} 格` : `用了 ${used} 格` }),
    ),
    h(
      'div',
      { class: 'inv-top' },
      grid(
        'slots armor',
        '盔甲',
        4,
        ARMOR.map((a) => slotEl({ item: live.armor?.[a.index] ?? undefined, label: a.label, mark: a.mark }, looks, onPick)),
      ),
      // 背上那一格（探险背包 mod 的直升机背包、背包……）：穿着东西时才有
      ...((live.worn ?? []).length > 0 ? [grid('slots worn', '背上', live.worn.length, live.worn.map((w) => slotEl({ item: w.item, label: WORN_SLOTS[w.slot] ?? w.slot, mark: '背' }, looks, onPick)))] : []),
      h('div', { class: 'inv-held' }, h('span', { class: 'mc-note', text: '手里拿着' }), h('span', { class: 'inv-held-name', text: held ? held.name : '空手' })),
    ),
    grid('slots grid9', '背包', 9, range(9, 36)),
    grid('slots grid9 hotbar', '快捷栏', 9, range(0, 9)),
  )
}

/** 身体只给界面的类名（ContainerChisel 这种）。常见的几类认得出来就写成人话，类名留在后面。 */
const SCREEN_KINDS = [
  [/cover/i, '覆盖板'],
  [/chisel/i, '凿子'],
  [/drawer/i, '抽屉'],
  [/backpack|bag/i, '背包'],
  [/workbench|crafting/i, '工作台'],
  [/furnace/i, '熔炉'],
  [/chest|crate|barrel/i, '箱子'],
  [/^GT_|^MTE|gregtech|ModularUI/i, 'GregTech 机器'],
]
export function screenTitle(name) {
  if (!name) return '（没有名字）'
  const kind = SCREEN_KINDS.find(([re]) => re.test(name))
  return kind ? `${kind[1]}（${name}）` : name
}

const compactNumber = (n) => (typeof n === 'number' ? n.toLocaleString('zh-CN') : '?')

/** 界面上格子以外的一样东西：开关的开和关、页签开没开、流体格里是什么多少、选项选的哪个……只看，不能点。 */
function controlRow(c) {
  const name = h('span', { class: 'ctl-name', title: c.key, text: c.name })
  const lock = c.readOnly ? h('span', { class: 'ctl-note', title: '只显示，玩家改不了', text: '只读' }) : null
  if (c.kind === 'switch') {
    const on = c.value === true
    return h('div', { class: `ctl switch${on ? ' on' : ''}` }, h('span', { class: 'ctl-light', role: 'img', 'aria-label': on ? '开着' : '关着' }), name, h('span', { class: 'ctl-value', text: on ? '开' : '关' }), lock)
  }
  if (c.kind === 'panel') {
    return h('div', { class: `ctl tab${c.open ? ' on' : ''}` }, h('span', { class: 'ctl-kind', text: '页签' }), name, h('span', { class: 'ctl-value', text: c.open ? '开着' : '没开' }))
  }
  if (c.kind === 'fluid') {
    const f = c.fluid ?? { amount: 0 }
    const has = f.id !== undefined && f.amount > 0
    const ratio = has && f.capacity > 0 ? Math.min(1, f.amount / f.capacity) : 0
    const bar = h('span', { class: 'ctl-tank', role: 'img', 'aria-label': has ? `装了 ${Math.round(ratio * 100)}%` : '空的' }, h('span'))
    bar.firstChild.style.width = `${Math.round(ratio * 100)}%`
    const ways = [f.fills ? '能倒进' : '', f.drains ? '能取出' : ''].filter(Boolean).join('、')
    return h(
      'div',
      { class: 'ctl fluid', title: `${c.key}${f.id ? `\n${f.id}` : ''}` },
      h('span', { class: 'ctl-kind', text: '流体格' }),
      h('span', { class: 'ctl-fluid', text: has ? f.name ?? f.id : '空的' }),
      bar,
      h('span', { class: 'ctl-value', text: has ? `${compactNumber(f.amount)}${f.capacity ? ` / ${compactNumber(f.capacity)}` : ''} mB` : f.capacity ? `能装 ${compactNumber(f.capacity)} mB` : '' }),
      ways ? h('span', { class: 'ctl-note', text: ways }) : null,
    )
  }
  if (c.kind === 'choice') {
    return h('div', { class: 'ctl' }, h('span', { class: 'ctl-kind', text: '选项' }), name, h('span', { class: 'ctl-value', title: (c.options ?? []).length > 0 ? `能选：${c.options.join('、')}` : '', text: String(c.value ?? '—') }), lock)
  }
  if (c.kind === 'button') return h('div', { class: 'ctl' }, h('span', { class: 'ctl-kind', text: '按钮' }), name)
  const kinds = { number: '数字', text: '文字', value: '显示' }
  return h('div', { class: 'ctl' }, h('span', { class: 'ctl-kind', text: kinds[c.kind] ?? c.kind }), name, c.value !== undefined ? h('span', { class: 'ctl-value', text: String(c.value) }) : null, lock)
}

/** 控件按它们所在的面板分组；只有一块面板时不写面板名。 */
function controlsBlock(screen) {
  const controls = screen.controls ?? []
  if (controls.length === 0) return null
  const panels = new Map()
  for (const c of controls) {
    const key = c.panel ?? ''
    if (!panels.has(key)) panels.set(key, [])
    panels.get(key).push(c)
  }
  const total = screen.controlsTotal ?? controls.length
  return h(
    'div',
    { class: 'ctls', role: 'group', 'aria-label': '界面上的控件' },
    h('div', { class: 'mc-title' }, h('span', { text: '格子以外的' }), h('span', { class: 'mc-note', text: `${total} 样${total > controls.length ? `，这里列了 ${controls.length} 样` : ''}，只看不能点` })),
    [...panels.entries()].map(([panel, list]) => [panels.size > 1 && panel ? h('div', { class: 'ctl-panel', text: panel }) : null, list.map(controlRow)]),
  )
}

/** 开着的界面（箱子、机器）：只画界面自己的格子；它背包的那些格子上面已经有了，不重复画。 */
export function screenPanel(screen, looks, onPick) {
  const theirs = (screen.slots ?? []).filter((s) => !s.own)
  const filled = theirs.filter((s) => s.item).length
  return h(
    'div',
    { class: 'mc-panel screen' },
    h('div', { class: 'mc-title' }, h('span', { text: `开着的界面：${screenTitle(screen.name)}` }), h('span', { class: 'mc-note', text: `${theirs.length} 格，${filled} 格有东西` })),
    h('p', { class: 'mc-note mc-sub', text: `按格子编号排，不是游戏里的位置。${theirs.some((s) => s.takesNothing) ? '浅色底的是产物格。' : ''}` }),
    theirs.length === 0
      ? h('p', { class: 'mc-note', text: '这个界面没有自己的格子。' })
      : grid(
          'slots grid9',
          '界面的格子',
          9,
          theirs.map((s) => slotEl(s, looks, onPick)),
        ),
    screen.cursor ? h('p', { class: 'mc-note', text: `鼠标上拿着：${screen.cursor.name} ×${screen.cursor.count}` }) : null,
    controlsBlock(screen),
  )
}

// ── 像素画：心、鸡腿、头 ──

const HEART = ['.XX...XX.', 'XRRX.XRRX', 'XRHRXRRRX', 'XRRRRRRRX', 'XRRRRRRRX', '.XRRRRRX.', '..XRRRX..', '...XRX...', '....X....']
const FOOD = ['.....XXX.', '....XBBBX', '...XBBLBX', '...XBBBBX', '...XBBBX.', '..XDBBX..', '.XWXDX...', 'XWWX.....', '.XX......']
const HEART_COLORS = { X: '#1a0e0e', R: '#e8262b', H: '#ff9c9c', E: '#4a4346' }
const FOOD_COLORS = { X: '#1a120a', B: '#c0762c', L: '#e3a558', D: '#8a4d18', W: '#efe6cf', E: '#4a4346' }

function drawSprite(ctx, rows, colors, x0, scale, fill) {
  // fill：1 整个、0.5 半个（左半边有颜色）、0 空的
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const c = rows[y][x]
      if (c === '.') continue
      let color = colors[c]
      if (c !== 'X' && (fill === 0 || (fill === 0.5 && x >= 5))) color = colors.E
      ctx.fillStyle = color
      ctx.fillRect(x0 + x * scale, y * scale, scale, scale)
    }
  }
}

/** 一排心或者鸡腿。value 是 0–max 的点数（两点一个图标）。 */
function pips(rows, colors, value, max, scale, label) {
  const n = Math.max(1, Math.ceil(max / 2))
  const canvas = h('canvas', { class: 'pips', role: 'img', 'aria-label': label })
  canvas.width = (n * 8 + 1) * scale
  canvas.height = 9 * scale
  canvas.style.width = `${canvas.width}px`
  canvas.style.height = `${canvas.height}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  for (let i = 0; i < n; i++) {
    const left = value - i * 2
    drawSprite(ctx, rows, colors, i * 8 * scale, scale, left >= 2 ? 1 : left >= 1 ? 0.5 : 0)
  }
  return canvas
}

export const hearts = (health, max = 20, scale = 2) => pips(HEART, HEART_COLORS, Math.ceil(health ?? 0), Math.min(40, max ?? 20), scale, `血量 ${health ?? '?'} / ${max ?? 20}`)
export const foodBar = (food, scale = 2) => pips(FOOD, FOOD_COLORS, food ?? 0, 20, scale, `饱食度 ${food ?? '?'} / 20`)
/** 单个的小图标（侧栏里数字前面那个）。 */
export const heartIcon = (scale = 1) => pips(HEART, HEART_COLORS, 2, 2, scale, '血量')
export const foodIcon = (scale = 1) => pips(FOOD, FOOD_COLORS, 2, 2, scale, '饱食度')

function hash(text) {
  let x = 2166136261
  for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 16777619)
  return x >>> 0
}

const SKIN = ['#f2c9a0', '#e0ac7e', '#c68e5f', '#a8703f', '#8a5a33']
const HAIR = ['#3b2414', '#5a3a1e', '#2a2a2e', '#7a4a22', '#c9a15a', '#8c8c94', '#a8482c']
const EYES = ['#3b6fd4', '#3f9a57', '#6b4423', '#5a5fb0', '#2e8f9c']

/** 一个像素头（8×8 放大）：发色、肤色、眼睛的颜色由名字定，同一个名字总是同一张脸。不是游戏里的皮肤。 */
export function playerHead(name, scale = 5) {
  const canvas = h('canvas', { class: 'head', role: 'img', 'aria-label': `${name} 的头像` })
  canvas.width = 8 * scale
  canvas.height = 8 * scale
  canvas.style.width = `${canvas.width}px`
  canvas.style.height = `${canvas.height}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const seed = hash(String(name))
  const skin = SKIN[seed % SKIN.length]
  const hair = HAIR[(seed >>> 4) % HAIR.length]
  const eye = EYES[(seed >>> 9) % EYES.length]
  const fringe = (seed >>> 13) % 3
  const px = (x, y, color) => {
    ctx.fillStyle = color
    ctx.fillRect(x * scale, y * scale, scale, scale)
  }
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px(x, y, skin)
  for (let x = 0; x < 8; x++) {
    px(x, 0, hair)
    px(x, 1, hair)
  }
  // 刘海：三种样子
  const side = fringe === 0 ? [0, 7] : fringe === 1 ? [0, 1, 7] : [0, 6, 7]
  for (const x of side) px(x, 2, hair)
  px(0, 3, hair)
  px(7, 3, hair)
  for (const x of [1, 6]) px(x, 4, '#ffffff')
  for (const x of [2, 5]) px(x, 4, eye)
  const shade = 'rgba(0,0,0,0.22)'
  px(3, 5, shade)
  px(4, 5, shade)
  for (const x of [2, 3, 4, 5]) px(x, 6, 'rgba(90,30,20,0.45)')
  return canvas
}
