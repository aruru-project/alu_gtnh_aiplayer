主人问一台多方块机器怎么搭、要什么材料、升到下一级（T2、换线圈）要换什么，或者让你帮着搭、帮着升级时看。

# 结构数据在哪
- 每台多方块机器每个等级怎么搭，大脑本地有一份（就是游戏里的“投影”）。它不是工具，是**程序里的数据**：用 run_program 写几行程序去取、去算。
- 等级 = 搭的时候“多方块结构全息投影仪”叠几个。有的机器等级是外壳的档次（蒸汽机器 T1 青铜、T2 钢），有的是线圈（高炉每种线圈一级）。
- 程序里：
  - `data.structures()`：全部机器 `[{ id, meta, name, tiers }]`。按名字找：`data.structures().filter((m) => m.name.includes('离心'))`。
  - `data.structure('大型蒸汽离心机')` 或 `data.structure(id, meta)`：一台机器。`m.tiers` 有哪些等级，`m.info`、`m.structureInfo` 是机器自己的说明（中文，写着哪些位置能放仓：“任意机械方块”），`m.tier(2)` 是第 2 级的搭法。重名的机器会报错并列出各自的 id/meta。
  - 一种搭法 `row`：`row.size` 是 [x, y, z] 各几格，`row.blocks` 是材料清单 `[{ id, meta, name, n }]`，`row.controller` 是主机在盒子里的位置，`row.palette[row.cells[(y * row.size[2] + z) * row.size[0] + x]]` 是 (x, y, z) 那一格的方块（空的是 minecraft:air）。**数据里主机正面朝南（+z）。**
- 现成的库函数（也只在程序里能调）：
  - `await tool('find_structure', { name })`：这台机器的等级、材料、说明、相邻两级差什么，已经整理成一段话（r.text）。加 `tier` 看一级，加 `from` 和 `tier` 看两级之差。
  - `await tool('check_structure', { at: 主机坐标, tier })`：对着世界里那台比，r.text 是结论，r.data.changes 是每个要换的位置 `{ x, y, z, from, to }`，r.data.need 是要的方块和还差多少。
  - `await tool('read_blocks', { x1, y1, z1, x2, y2, z2 })`：世界里一个盒子的全部方块，r.data 是 `{ x, y, z, sx, sy, sz, palette, cells }`，下标同上。
- 只是想知道“要什么材料”：`return (await tool('find_structure', { name: '大型蒸汽离心机' })).text` 就够了。

# 这台机器升到某一级要换什么（示例程序）
库函数 check_structure 做的就是这件事。下面是它的做法，写成一个完整的程序：想换一种比法（只看某一层、别的方块也算对、顺便算别的）就照着改。改最上面三行就能用。

```js
const at = { x: 100, y: 64, z: 200 }            // 世界里那台主机的位置（find_machines 里有）
const m = data.structure('大型蒸汽离心机')       // 哪台机器：名字，或者 data.structure(id, meta)
const want = m.tier(2)                           // 要升到哪一级

// 数据里主机朝南。世界里那台朝哪不知道：绕主机转 0、1、2、3 个直角（南、西、北、东）各对一遍
const turn = (k, dx, dz) => (k === 0 ? [dx, dz] : k === 1 ? [-dz, dx] : k === 2 ? [-dx, -dz] : [dz, -dx])
const spot = (row, k, x, y, z) => {
  const [wx, wz] = turn(k, x - row.controller[0], z - row.controller[2])
  return { x: at.x + wx, y: at.y + y - row.controller[1], z: at.z + wz }
}
// 主机、各种仓和总线在世界里是同一个方块，分不出是哪种
const part = (b) => b.id === 'gregtech:gt.blockmachines'

// 把一种搭法按朝向 k 对到世界上，列出对不上的位置
async function compare(row, k) {
  const a = spot(row, k, 0, 0, 0)
  const b = spot(row, k, row.size[0] - 1, row.size[1] - 1, row.size[2] - 1)
  const box = (await tool('read_blocks', { x1: a.x, y1: a.y, z1: a.z, x2: b.x, y2: b.y, z2: b.z })).data
  const changes = []
  for (let y = 0; y < row.size[1]; y++) for (let z = 0; z < row.size[2]; z++) for (let x = 0; x < row.size[0]; x++) {
    const to = row.palette[row.cells[(y * row.size[2] + z) * row.size[0] + x]]
    if (to.id === 'minecraft:air') continue
    const p = spot(row, k, x, y, z)
    const got = box.palette[box.cells[((p.y - box.y) * box.sz + (p.z - box.z)) * box.sx + (p.x - box.x)]]
    // 同一种方块算对；预览里是机械方块、世界里是机器零件（主人在那里放了仓）也算对，不用换
    const ok = got.id === to.id ? part(to) || got.meta === to.meta : part(got)
    if (!ok) changes.push({ ...p, from: got.id === 'minecraft:air' ? null : got, to })
  }
  return changes
}

// 朝向：拿同样大小的每一级各对一遍，对不上的最少的那个朝向就是它现在的朝向
let best
for (let k = 0; k < 4; k++) {
  for (const row of m.rows.filter((r) => r.size.join() === want.size.join())) {
    const changes = await compare(row, k)
    if (!best || changes.length < best.changes.length) best = { k, row, changes }
  }
}
const changes = await compare(want, best.k)

// 按“要换成什么”数一数，再对身上和仓库
const need = new Map()
for (const c of changes) {
  const key = c.to.id + '/' + c.to.meta
  need.set(key, { id: c.to.id, meta: c.to.meta, name: c.to.name, n: (need.get(key)?.n ?? 0) + 1 })
}
const list = [...need.values()]
const carried = (await tool('get_status')).data.inventory
const stored = list.length > 0 ? (await tool('find_in_storage', { items: list.map((b) => ({ id: b.id, meta: b.meta })), radius: 64 })).data.items : []
const lines = list.map((b, i) => {
  const mine = carried.filter((it) => it.id === b.id && (it.meta ?? 0) === b.meta).reduce((n, it) => n + it.count, 0)
  const short = Math.max(0, b.n - mine - stored[i].total)
  return `${b.n}× ${b.name}：身上 ${mine}，仓库 ${stored[i].total}，${short > 0 ? `还差 ${short}` : '够了'}`
})
return [`主机朝${['南', '西', '北', '东'][best.k]}，现在是 ${best.row.tiers.join('/')} 级的样子；对着 ${want.tiers.join('/')} 级要换 ${changes.length} 处`, ...lines].join('\n')
```

- 大的结构（一边几十格）一次 read_blocks 就读回来了，不用一格格 inspect_block。
- 只转了四个水平朝向。主机朝上朝下、镜像着搭的机器对不上：那样的照实告诉主人。
- 只导了默认的那一档可调项（玻璃等级之类）；预览里个别位置放的是默认的仓，世界里是机械方块时会被算成“要换”，其实不用——拿不准的看 `m.structureInfo`。

# 怎么搭、怎么升级
1. **查**：要什么材料（find_structure），世界里那台要换哪些位置（check_structure，或上面的程序）。
2. **备料**：缺的方块一样样查怎么做、去做（crafting 手册）。报给主人时照结果里的名字和数量说。
3. **动手，现在有三条路，如实告诉主人你走的是哪条**：
   - **告诉主人清单，让他来换。** 最稳：“T1→T2 要把 65 个镀铜砖块换成脱氧钢机械方块……料我备好了，放在哪个箱子。”
   - **一块块换**：dig_blocks 挖掉旧的、place_blocks 放新的（位置就是 changes 里的 x y z；多的话写成例程）。只适合机械方块、线圈这类**没有朝向**的方块；仓、总线、主机有朝向，你放不对，不要动它们。升级时先问主人：拆的时候机器会停、里面的东西可能掉出来。
   - **还没验证的办法：全息投影仪。** 玩家是手拿“多方块结构全息投影仪”（叠几个就是几级）右键主机，让它从背包里自动取方块搭好。你有 use_item（item 给投影仪，on 给主机的坐标），材料带在身上以后**可以试**。没人验证过它对你管不管用：试之前告诉主人这是试，试完用 check_structure 再比一遍，把结果如实说，不要当成一定行。
4. 搭完、换完：find_machines 看那台主机是不是 formed（成型），再用 check_structure 比一遍。没成型的把它说的原因（idle 后面那句）告诉主人。
