// 程序能用的 API（docs/SCRIPTS.md 里列的那些）。这个文件不是被 import 的：runner.mjs 把它当成源码，
// 在一个全新的 vm 上下文里求值，得到下面这个函数，再调用它一次把 API 装到那个上下文的全局对象上。
//
// 这里的代码和模型写的程序跑在同一个上下文里，所以规矩是：
//   - 宿主那边只给进来一个函数 hostCall(op, arg)，收的、回的都只有字符串；它只存在闭包里，程序拿不到。
//   - 调 hostCall 出了任何意外都在这里换成本上下文自己的 Error 再抛，不让宿主那边的对象漏进来。
// 这是纯 JavaScript（不是 TypeScript）：vm 只认 JavaScript。
(function boot(hostCall, configJson) {
  'use strict'
  const config = JSON.parse(configJson)

  /** 问宿主要东西。失败时宿主回的是 "E" 开头的字符串。 */
  function host(op, arg) {
    let reply
    try {
      reply = hostCall(String(op), String(arg))
    } catch {
      throw new Error('the sandbox could not do that')
    }
    if (typeof reply !== 'string') throw new Error('the sandbox could not do that')
    if (reply[0] === 'E') throw new Error(reply.slice(1))
    return reply.slice(1)
  }

  // ── log ──

  function show(value) {
    if (typeof value === 'string') return value
    if (value instanceof Error) return `${value.name}: ${value.message}`
    try {
      const text = JSON.stringify(value)
      return text === undefined ? String(value) : text
    } catch {
      return String(value)
    }
  }
  function log(...values) {
    host('log', values.map(show).join(' '))
  }

  // ── 方块的写法 ──

  const KIND = /^([^/\s][^/]*:[^/]*[^/\s])(?:\/(\d{1,2}))?$/
  /** 'minecraft:wool/14'、{ id, meta } → 规范的写法 "id" 或 "id/meta"；空（null、'air'）→ null。 */
  function kindKey(block) {
    if (block === null || block === undefined || block === false || block === 'air' || block === 'minecraft:air') return null
    let id
    let meta = 0
    if (typeof block === 'string') {
      const m = KIND.exec(block)
      if (!m) throw new TypeError(`${JSON.stringify(block)} is not a block: write a registry name such as "minecraft:planks", or "minecraft:wool/14" for meta 14`)
      id = m[1]
      if (m[2] !== undefined) meta = Number(m[2])
    } else if (typeof block === 'object' && typeof block.id === 'string') {
      const m = KIND.exec(block.id)
      if (!m || m[2] !== undefined) throw new TypeError(`${JSON.stringify(block.id)} is not a block registry name`)
      id = block.id
      if (block.meta !== undefined && block.meta !== null) meta = block.meta
    } else {
      throw new TypeError(`${show(block)} is not a block: give a string such as "minecraft:wool/14", an object { id, meta }, or null for empty`)
    }
    if (!Number.isInteger(meta) || meta < 0 || meta > 15) throw new RangeError(`block meta must be a whole number from 0 to 15, not ${show(meta)}`)
    if (id === 'minecraft:air') return null
    return meta === 0 ? id : `${id}/${meta}`
  }

  // ── 图纸 ──

  const saved = new Map()

  function whole(value, what) {
    if (!Number.isInteger(value)) throw new TypeError(`${what} must be a whole number, not ${show(value)}`)
    return value
  }

  class Blueprint {
    #sx
    #sy
    #sz
    #cells
    #kinds = []
    #indexOf = new Map()

    constructor(width, height, length) {
      const max = config.limits.maxSide
      for (const [name, v] of [['width (x)', width], ['height (y)', height], ['length (z)', length]]) {
        whole(v, `the ${name} of a blueprint`)
        if (v < 1 || v > max) throw new RangeError(`the ${name} of a blueprint must be from 1 to ${max}, not ${v}`)
      }
      if (width * height * length > config.limits.maxCells) {
        throw new RangeError(`a blueprint of ${width}×${height}×${length} has ${width * height * length} cells; the most is ${config.limits.maxCells}`)
      }
      this.#sx = width
      this.#sy = height
      this.#sz = length
      this.#cells = new Uint16Array(width * height * length)
    }

    get width() {
      return this.#sx
    }
    get height() {
      return this.#sy
    }
    get length() {
      return this.#sz
    }
    get size() {
      return { x: this.#sx, y: this.#sy, z: this.#sz }
    }

    #index(block) {
      const key = typeof block === 'string' && this.#indexOf.has(block) ? block : kindKey(block)
      if (key === null) return 0
      let index = this.#indexOf.get(key)
      if (index === undefined) {
        if (this.#kinds.length >= config.limits.maxKinds) throw new RangeError(`a blueprint can use at most ${config.limits.maxKinds} kinds of block`)
        this.#kinds.push(key)
        index = this.#kinds.length
        this.#indexOf.set(key, index)
      }
      return index
    }

    #inside(x, y, z, what) {
      whole(x, `${what}: x`)
      whole(y, `${what}: y`)
      whole(z, `${what}: z`)
      if (x < 0 || x >= this.#sx) throw new RangeError(`${what}: x ${x} is outside the blueprint (x runs from 0 to ${this.#sx - 1})`)
      if (y < 0 || y >= this.#sy) throw new RangeError(`${what}: y ${y} is outside the blueprint (y runs from 0 to ${this.#sy - 1})`)
      if (z < 0 || z >= this.#sz) throw new RangeError(`${what}: z ${z} is outside the blueprint (z runs from 0 to ${this.#sz - 1})`)
    }

    /** 放一个方块；block 给 null 是清空这一格。 */
    set(x, y, z, block) {
      this.#inside(x, y, z, 'set')
      this.#cells[x + (y * this.#sz + z) * this.#sx] = this.#index(block)
      return this
    }

    /** 这一格是什么：'minecraft:wool/14' 这样的写法，空的是 null。 */
    get(x, y, z) {
      this.#inside(x, y, z, 'get')
      const index = this.#cells[x + (y * this.#sz + z) * this.#sx]
      return index === 0 ? null : this.#kinds[index - 1]
    }

    /** 盒子里符合条件的格子都放上 block。两个角哪个在前都行。 */
    #region(what, x1, y1, z1, x2, y2, z2, block, wanted) {
      this.#inside(x1, y1, z1, what)
      this.#inside(x2, y2, z2, what)
      const index = this.#index(block)
      const [ax, bx] = x1 <= x2 ? [x1, x2] : [x2, x1]
      const [ay, by] = y1 <= y2 ? [y1, y2] : [y2, y1]
      const [az, bz] = z1 <= z2 ? [z1, z2] : [z2, z1]
      for (let y = ay; y <= by; y++) {
        for (let z = az; z <= bz; z++) {
          for (let x = ax; x <= bx; x++) {
            if (wanted(x === ax || x === bx, y === ay || y === by, z === az || z === bz)) this.#cells[x + (y * this.#sz + z) * this.#sx] = index
          }
        }
      }
      return this
    }

    /** 实心的盒子。 */
    fill(x1, y1, z1, x2, y2, z2, block) {
      return this.#region('fill', x1, y1, z1, x2, y2, z2, block, () => true)
    }

    /** 空心的盒子：只有六个面。 */
    box(x1, y1, z1, x2, y2, z2, block) {
      return this.#region('box', x1, y1, z1, x2, y2, z2, block, (onX, onY, onZ) => onX || onY || onZ)
    }

    /** 四面墙：没有地板和顶。 */
    walls(x1, y1, z1, x2, y2, z2, block) {
      return this.#region('walls', x1, y1, z1, x2, y2, z2, block, (onX, _onY, onZ) => onX || onZ)
    }

    /** 两点之间的一条直线。 */
    line(x1, y1, z1, x2, y2, z2, block) {
      this.#inside(x1, y1, z1, 'line')
      this.#inside(x2, y2, z2, 'line')
      const index = this.#index(block)
      const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), Math.abs(z2 - z1))
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps
        const x = Math.round(x1 + (x2 - x1) * t)
        const y = Math.round(y1 + (y2 - y1) * t)
        const z = Math.round(z1 + (z2 - z1) * t)
        this.#cells[x + (y * this.#sz + z) * this.#sx] = index
      }
      return this
    }

    /** 把现在的样子存成一张草稿（同名的后存的盖掉先存的）。草稿在大脑这边，不在游戏里。 */
    save(name) {
      if (typeof name !== 'string' || name.trim().length === 0) throw new TypeError('save(name): give the draft a name')
      if (!saved.has(name) && saved.size >= config.limits.maxDrafts) throw new RangeError(`one program can save at most ${config.limits.maxDrafts} drafts`)
      const runs = []
      const cells = this.#cells
      for (let i = 0; i < cells.length; ) {
        let j = i + 1
        while (j < cells.length && cells[j] === cells[i]) j++
        runs.push(cells[i], j - i)
        i = j
      }
      saved.set(name, { name, size: this.size, kinds: [...this.#kinds], runs })
      return this
    }
  }

  // ── 图片 ──

  function makeImage(name, width, height, pixels) {
    const inside = (x, y) => {
      whole(x, 'pixel: x')
      whole(y, 'pixel: y')
      if (x < 0 || x >= width || y < 0 || y >= height) throw new RangeError(`pixel (${x}, ${y}) is outside the image, which is ${width}×${height}`)
    }
    return Object.freeze({
      name,
      width,
      height,
      /** [红, 绿, 蓝, 不透明度]，都是 0–255；(0, 0) 是左上角。 */
      pixel(x, y) {
        inside(x, y)
        const o = (y * width + x) * 4
        return [pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]]
      },
      /** 缩成 w×h 的新图（h 不给就按比例）。缩小时每个新像素是它盖住的那一块的平均色。 */
      resize(w, h) {
        whole(w, 'resize: width')
        if (h === undefined) h = Math.max(1, Math.round((height * w) / width))
        whole(h, 'resize: height')
        if (w < 1 || h < 1 || w * h > config.limits.maxPixels) throw new RangeError(`resize: ${w}×${h} is not a size an image can have here`)
        const out = new Uint8ClampedArray(w * h * 4)
        for (let ty = 0; ty < h; ty++) {
          const y0 = Math.floor((ty * height) / h)
          const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / h))
          for (let tx = 0; tx < w; tx++) {
            const x0 = Math.floor((tx * width) / w)
            const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / w))
            // 颜色按不透明度加权，免得透明像素把边缘带黑
            let r = 0
            let g = 0
            let b = 0
            let a = 0
            for (let y = y0; y < y1; y++) {
              for (let x = x0; x < x1; x++) {
                const o = (y * width + x) * 4
                const alpha = pixels[o + 3]
                r += pixels[o] * alpha
                g += pixels[o + 1] * alpha
                b += pixels[o + 2] * alpha
                a += alpha
              }
            }
            const o = (ty * w + tx) * 4
            if (a > 0) {
              out[o] = Math.round(r / a)
              out[o + 1] = Math.round(g / a)
              out[o + 2] = Math.round(b / a)
            }
            out[o + 3] = Math.round(a / ((y1 - y0) * (x1 - x0)))
          }
        }
        return makeImage(name, w, h, out)
      },
    })
  }

  /** 主人在面板上传的一张图片。 */
  function image(name) {
    const reply = host('image', name)
    const cut = reply.indexOf(';')
    const [width, height] = reply.slice(0, cut).split(',').map(Number)
    const pixels = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < pixels.length; i++) pixels[i] = reply.charCodeAt(cut + 1 + i)
    return makeImage(String(name), width, height, pixels)
  }

  function images() {
    return config.images.map((i) => ({ name: i.name, width: i.width, height: i.height }))
  }

  // ── 方块颜色 ──

  /**
   * 两个颜色看着差多少：按红色的多少给三个分量加权的 RGB 距离（“redmean”）。
   * 试过 CIELAB 和 Oklab：对着羊毛这种偏灰的颜色表，前者会把纯蓝配成紫色，后者会把黄、粉配成白色；这个最不离谱。
   */
  function distance(a, b) {
    const mean = (a[0] + b[0]) / 2
    const dr = a[0] - b[0]
    const dg = a[1] - b[1]
    const db = a[2] - b[2]
    return (2 + mean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - mean) / 256) * db * db
  }

  const table = config.palette.map((p) => ({ id: p.id, meta: p.meta, name: p.name, color: p.color, key: p.meta === 0 ? p.id : `${p.id}/${p.meta}` }))
  const publicEntry = (e) => ({ id: e.id, meta: e.meta, ...(e.name ? { name: e.name } : {}), color: [...e.color] })

  /** 方块颜色表：每种方块和它贴图的平均色。 */
  function palette() {
    return table.map(publicEntry)
  }

  /** among 的写法 → 颜色表里符合的那些。'minecraft:wool' 指它的所有 meta。 */
  const subsets = new Map()
  function subset(among) {
    if (among === undefined || among === null) return table
    if (!Array.isArray(among)) throw new TypeError('nearestBlock: "among" must be a list of blocks, e.g. ["minecraft:wool"]')
    const wanted = among.map((b) => (typeof b === 'string' && !b.includes('/') ? `${b}/*` : kindKey(b)))
    const signature = wanted.join('\n')
    let list = subsets.get(signature)
    if (!list) {
      const exact = new Set(wanted)
      list = table.filter((e) => exact.has(e.key) || exact.has(`${e.id}/*`))
      if (list.length === 0) throw new Error('nearestBlock: none of the blocks in "among" is in the colour table (see palette())')
      subsets.set(signature, list)
    }
    return list
  }

  /** 颜色最接近的方块。nearestBlock(r, g, b) 或 nearestBlock([r, g, b])，后面可以再跟一个 among 列表限定只在哪些方块里挑。 */
  function nearestBlock(r, g, b, among) {
    if (Array.isArray(r)) {
      among = g
      ;[r, g, b] = r
    }
    for (const v of [r, g, b]) if (typeof v !== 'number' || Number.isNaN(v)) throw new TypeError('nearestBlock: give a colour as r, g, b (0 to 255) or as [r, g, b]')
    const want = [r, g, b]
    let best
    let bestDistance = Infinity
    for (const e of subset(among)) {
      const d = distance(e.color, want)
      if (d < bestDistance) {
        bestDistance = d
        best = e
      }
    }
    return publicEntry(best)
  }

  // ── 本地资料 ──

  const loaded = new Map()
  function dataset(key, parse) {
    if (!loaded.has(key)) loaded.set(key, parse(host('data', key)))
    return loaded.get(key)
  }
  const jsonLines = (text) =>
    text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
  let itemIndex
  const data = Object.freeze({
    /** 物品表：[{ id, meta, name, en?, ores? }]。 */
    items: () => dataset('items', jsonLines),
    /** 一种物品，没有就是 null。 */
    item(id, meta = 0) {
      if (!itemIndex) itemIndex = new Map(data.items().map((i) => [`${i.id}/${i.meta ?? 0}`, i]))
      return itemIndex.get(`${id}/${meta}`) ?? null
    },
    /** 任务书的全部任务（字段见 docs/PACKDATA.md）。 */
    quests: () => dataset('quests', jsonLines),
    /** 任务书的章节。 */
    questLines: () => dataset('questLines', (text) => JSON.parse(text).lines),
    /** 多方块机器：[{ id, meta, name, tiers }]（主机这件物品、它有哪些等级）。 */
    structures: () => [...structureIndex().values()].map((m) => ({ id: m.id, meta: m.meta, name: m.name, tiers: m.tiers })),
    /**
     * 一台多方块机器各等级的结构。给主机的 id（和 meta），或者它的名字（中文名，或者物品表里它的英文名；要正好是它；好几台重名时报错，列出各自的 id/meta）。没有就是 null。
     * 返回 { id, meta, name, tiers, info, structureInfo, rows, tier(n) }；rows 的每一项是一种搭法：
     * { tiers, size: [x, y, z], controller: [x, y, z], blocks: [{ id, meta, name, n }], palette, cells }，
     * cells[(y * size[2] + z) * size[0] + x] 是 palette 的下标（0 是空），主机正面朝南（+z）。tier(n) 是第 n 级用的那一项。
     */
    structure(idOrName, meta = 0) {
      const index = structureIndex()
      const text = String(idOrName)
      const byId = index.get(`${text}/${meta}`)
      if (byId) return byId
      // 中文名（结构数据里的）或者英文名（物品表里这台主机的 en，不分大小写）
      const english = config.data.includes('items') ? text.toLowerCase() : undefined
      const named = [...index.values()].filter((m) => m.name === text || (english !== undefined && (data.item(m.id, m.meta)?.en ?? '').toLowerCase() === english))
      if (named.length > 1) throw new Error(`${named.length} machines are named ${text}: use data.structure(id, meta) with one of ${named.map((m) => `${m.id}/${m.meta}`).join(', ')}`)
      return named[0] ?? null
    },
    /** 凿子的全部组：[{ group, ore?, variants: [{ id, meta, name }] }]。同组里的任何一种都能用凿子变成另一种，一换一。 */
    chiselGroups: () => carvingIndex().groups,
    /**
     * 一样东西在凿子的哪几个组里：[{ group, ore?, variants, member }]，一个都没有就是 []。
     * member 为 true 是它就是组里的一种；false 是它只带着那个组认的矿辞名（能凿成那一组，自己不在组里）。
     */
    chiselGroupsOf(id, meta = 0) {
      const index = carvingIndex()
      const found = (index.byItem.get(`${id}/${meta}`) ?? []).map((g) => ({ ...g, member: true }))
      const ores = config.data.includes('items') ? (data.item(id, meta)?.ores ?? []) : []
      for (const ore of ores) for (const g of index.byOre.get(ore) ?? []) if (!found.some((f) => f.group === g.group)) found.push({ ...g, member: false })
      return found
    },
    /** 现在有哪几样资料：['items', 'quests', 'questLines', 'structures', 'carving'] 里的几个。 */
    available: () => [...config.data],
  })

  let carving
  function carvingIndex() {
    if (carving) return carving
    // 认不出来的行（没有组名、没有变体）跳过，和大脑自己读这份资料时一样
    const groups = (config.data.includes('carving') ? dataset('carving', jsonLines) : []).filter((g) => g && typeof g.group === 'string' && Array.isArray(g.variants) && g.variants.length > 0)
    const byItem = new Map()
    const byOre = new Map()
    const add = (map, key, g) => {
      const list = map.get(key)
      if (!list) map.set(key, [g])
      else if (!list.includes(g)) list.push(g)
    }
    for (const g of groups) {
      for (const v of g.variants) add(byItem, `${v.id}/${v.meta ?? 0}`, g)
      if (g.ore) add(byOre, g.ore, g)
    }
    carving = { groups, byItem, byOre }
    return carving
  }

  let structures
  function structureIndex() {
    if (structures) return structures
    structures = new Map()
    for (const raw of dataset('structures', jsonLines)) {
      const key = `${raw.id}/${raw.meta}`
      let machine = structures.get(key)
      if (!machine) {
        machine = { id: raw.id, meta: raw.meta, name: raw.name, tiers: [], info: raw.info ?? [], structureInfo: raw.structureInfo ?? [], rows: [], tier: (n) => machine.rows.find((r) => r.tiers.includes(n)) ?? null }
        structures.set(key, machine)
      }
      const row = { tiers: raw.tiers, size: raw.size, controller: raw.controller, blocks: raw.blocks, palette: raw.palette }
      // 每格一个下标，用到时才展开（大的结构有二十万格）
      let cells
      Object.defineProperty(row, 'cells', {
        enumerable: false,
        get() {
          if (!cells) {
            cells = new Array(raw.size[0] * raw.size[1] * raw.size[2]).fill(0)
            let at = 0
            for (let i = 0; i + 1 < raw.runs.length && at < cells.length; i += 2) {
              const count = Math.min(raw.runs[i + 1], cells.length - at)
              if (raw.runs[i] !== 0) cells.fill(raw.runs[i], at, at + count)
              at += count
            }
          }
          return cells
        },
      })
      machine.rows.push(row)
      machine.tiers.push(...raw.tiers)
    }
    for (const m of structures.values()) {
      m.rows.sort((a, b) => a.tiers[0] - b.tiers[0])
      m.tiers = [...new Set(m.tiers)].sort((a, b) => a - b)
    }
    return structures
  }

  // ── 调工具 ──
  // 程序 await tool(名字, 参数)：请求经宿主交给大脑，大脑照模型自己调工具的那条路执行，结果再送回来。
  // 等结果的时候这个进程是停着的，不算进计算时限。回来的是 { ok, text, data }：
  // ok 成没成，text 是模型会看到的那段文字，data 是同一个结果的数据形式（有些工具没有）。

  const waiting = new Map()
  let nextCall = 1
  function tool(name, input) {
    if (config.limits.tools !== true) return Promise.reject(new Error('this program cannot call tools'))
    if (typeof name !== 'string' || name.length === 0) return Promise.reject(new TypeError('tool: give the name of a tool or library function, e.g. tool("list_drawers", { x, y, z })'))
    let request
    const id = nextCall++
    try {
      request = JSON.stringify({ id, name, input: input === undefined || input === null ? {} : input })
    } catch {
      return Promise.reject(new TypeError('tool: the input cannot be written as JSON'))
    }
    return new Promise((resolve) => {
      waiting.set(id, resolve)
      host('call', request)
    })
  }
  /** 宿主把一个工具结果送回来（一个 JSON 字符串）。 */
  function deliver(text) {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    const resolve = waiting.get(message.id)
    if (!resolve) return
    waiting.delete(message.id)
    resolve(Object.freeze({ ok: message.ok === true, text: String(message.text ?? ''), data: message.data }))
  }

  // ── 装到全局上 ──

  const outcome = { state: 'pending' }
  function describe(error) {
    if (error instanceof Error) return { name: String(error.name), message: String(error.message), stack: String(error.stack ?? '') }
    return { name: 'Thrown', message: show(error), stack: '' }
  }
  function finish(promise) {
    promise.then(
      (value) => {
        outcome.state = 'done'
        if (value !== undefined) {
          // 太长的只交开头那一段，连同原来一共多长：那一头好写明截了多少
          const text = show(value)
          outcome.value = text.slice(0, config.limits.valueChars)
          if (text.length > outcome.value.length) outcome.valueLength = text.length
        }
        outcome.drafts = [...saved.values()]
      },
      (error) => {
        outcome.state = 'failed'
        outcome.error = describe(error)
      },
    )
  }

  const api = { log, blueprint: (width, height, length) => new Blueprint(width, height, length), image, images, palette, nearestBlock, data, tool }
  for (const [name, value] of Object.entries(api)) Object.defineProperty(globalThis, name, { value, writable: false, configurable: false, enumerable: true })
  Object.defineProperty(globalThis, 'console', { value: Object.freeze({ log, info: log, warn: log, error: log, debug: log }), writable: false, configurable: false })
  Object.defineProperty(globalThis, config.finishName, { value: finish, writable: false, configurable: false })

  /**
   * 宿主来取结果：一个 JSON 字符串。给了参数就是先把一个工具结果送进来。
   * waiting 是还在等结果的工具调用有几个：不为 0 时程序没完是正常的，宿主去等结果。
   */
  return (delivered) => {
    if (typeof delivered === 'string') deliver(delivered)
    return JSON.stringify({ ...outcome, waiting: waiting.size })
  }
})
