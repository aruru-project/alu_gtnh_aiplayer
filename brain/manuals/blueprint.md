主人让你照图纸（.schematic 文件）盖建筑时，动手之前看。

# 要的是什么，你手上有什么
- 要的是：图纸上的建筑，在主人说的位置，照图纸的样子立起来；剩下得他自己放的东西，他清楚是哪些。
- 你能知道的：图纸里有什么（read_blueprint：尺寸、材料表、每一格）；它放在某个位置时现场差什么（check_blueprint：已经对上的、要放的、挡着的、得由人放的）；材料在哪（find_in_storage、list_stock），没有的怎么来（find_recipes；同一种东西的不同花纹见 crafting 手册的“凿子的花纹”）。
- 你能做的：build_blueprint 是现成的办法，替你把一片范围里的普通方块照图纸放好（走位、清障、取料都是它的事）。它放不了的、或者你想换个做法的，你有通用的手：place_blocks、fill_area、use_item，重复多的写成例程。用哪个、先做哪块由你定。

# 准备
- 你能照 Schematica 的图纸把建筑的框体盖出来。图纸存在服务器上，用 list_designs 看有哪些（kind 给 "blueprints"）；名字就是文件名去掉 .schematic；没有主人要的那张，就请他在控制面板的“图纸”页上传。主人是让你自己设计的话，图纸由你写程序画出来：看 design 手册。
- 图纸不旋转、不镜像。x y z 是图纸最小角落（x、y、z 都最小的那个角）放在世界的哪里，和 Schematica 里显示的原点一致。放在哪由主人说了算：他没给坐标就问，不要自己猜。

# 对比：现场和图纸差什么
- 库函数 check_blueprint（参数和 build_blueprint 一样）只看不动，告诉你：已经对上多少、要放哪些材料（各要多少、你身上有多少）、哪些得由人来放、有什么挡着、按你给的 clear 会挖掉什么。它不在工具清单里，用 run_program 写一行程序调：`return (await tool("check_blueprint", { name: "cabin", x: 30, y: 65, z: 30, clear: ["natural"] })).text`。
- 动手之前对比一次，开工后的意外（挖了不该挖的、材料不够停在半路）大多能提前看到。主人关心的通常是这四件事：要清掉什么、有什么挡着不会动、缺什么材料、哪些得他自己放。没有需要他先点头的事（见下面 clear 那一条）时，说一声就可以开工，不用等他回话。
- 检查结果开头写着 INCOMPLETE（有格子所在的区块没加载）时，数字不完整：走到工地跟前再查，区块就加载了。

# clear：图纸占位的清障
- 不给 clear 就不清掉图纸占位上的原方块，被挡住的位置直接跳过。dig 管额外挖路，与 clear 分开。
- "natural"（泥土、草方块、沙子、沙砾、雪、树叶这类天然地形）和 "plants"（花、灌木、树叶、作物这些长出来的东西）你可以自己决定给。
- 除此之外的方块（原木、石头、旧建材……）可能是别人盖的东西，挖掉就没了。主人交代过这里清什么的，照他说的给；检查结果显示会挖掉不是天然地形的方块、又没人交代过的，问一句再给。
- clear 不挖带数据的方块（箱子、机器）、液体、基岩。要把挡路的箱子、机器挪开：dig_blocks 点名挖（里面的东西会掉出来），或者用手推车连东西一起搬（containers 手册）。

# 它放什么、不放什么
- build_blueprint 放普通建筑方块，也放朝向由放法决定的方块（楼梯、原木、上下半台阶、火把、梯子）：身体照图纸里那一格的 meta，自己找站位和点的面让它朝对。材料表里这种方块写着 placed with [物品]：要取、要数的是那种物品（朝南的楼梯就是普通的楼梯物品）。
- 带内容或设置的方块（箱子、抽屉、机器、管道）、门和告示牌这类由专门物品放的、身体预料不到放法的，你放不了，结果里算在 byHand（得由人放，why 写着为什么）。如实告诉主人这些要他自己来放，不要说成已经全盖完了。
- 朝向的方块也可能这一格放不出来（要点的邻格还空着、找不到那样朝向的站位），结果的 skipped 里写着原因；周围盖好了再跑一遍，或者告诉主人。
- 材料先从背包拿，不够时去 supply 给的容器取（箱子、抽屉都行）。开工前对着 check_blueprint 的材料清单看身上和 supply 里够不够，不够就先跟主人说缺什么、缺多少。材料不齐也能开工：能放的会先放完，最后任务以 no_material 结束并列出每种还缺多少。
- 要清掉的东西多时给 dropoff；建筑材料会留在身上，不会被卸掉。

# 施工站位
- dig / climb / maxDrop 和地形施工工具相同：默认不额外挖路、不自动垫脚、单次规划落差最多 3 格。补料、卸货和收尾走路也遵守这些选择。需要自动垫脚才给 climb:true，并准备填料；允许挖天然方块开路才给 dig:true。clear 指定的清障仍照做。
- 悬空中段或高层够不着时，先选已有梯子、台阶、楼板，或计划临时站位。工具不会替你规划飞行。详见 terrain 手册。

# 大图纸
- build_blueprint 的一次任务最多覆盖 64×64 列：这是身体一次任务的上限，不是图纸的上限。更大的图纸分几次做：x1,x2 和 z1,z2 圈出一块不超过 64×64 的，y1,y2 圈出哪几层；几块可以排队（queue: true），也可以写成例程一块块做、每块做完看一眼结果。这几个范围用的是世界坐标，成对给。
- 任务先从上往下挖掉允许挖的挡路方块，再由低到高放。楼板和屋顶要求从同层或更高的位置铺，避免把自己封在里面；是否能上到那里取决于现有路径和允许的挖垫。收尾可能换站位，最后位置看任务结果。
- 用同样的参数再执行会接着做：已经对的格子不动。

# 看懂结果
- 任务结束时（成功或失败），结果里的 now 是此刻世界和图纸的对比：done 已经对上、toPlace 还空着你能放、byHand 得由人放、blocked 被别的方块占着、extra 图纸上是空的位置却有方块。后面列着还要放的材料、得由人放的、还挡着的各是什么。
- toPlace 不是 0 就是还没盖完。任务“完成”也要看一眼 byHand 和 blocked，把剩下的告诉主人。
- 以 no_material 失败时，能放的已经先放了，missing 列出每种材料还缺多少：取够了或者请主人补上，再用同样的参数重跑。
- 结果里有 needsClimbingBlocks 时，找到了需要垫脚的路线而身上没有填料。决定采用这条路线后，准备泥土或圆石并给 climb:true；不想垫就换已有站位。
- skipped 里的 unreachable 是试过、走不到的格子；not tried: 3 cells of this layer in a row were unreachable 是同一层连着 3 格走不到后、这一层剩下没去试的格子。换个地方站再跑一次（比如先 go_to 到屋顶或那一层旁边），它们多半够得着。
- 垫脚：任务结束前尝试拆回并捡掉落；拆脚下支撑也遵守 maxDrop。拆掉不等于已入包。collectionSweeps 保留各次工作掉落/垫脚清理结束时的范围、时点和剩余原因，前次未收不会因后次成功而消失；旧位置是当时观察，不是当前全任务余量。remainingDrops 仅兼容最后一次。先腾空间或选择安全站位，再决定是否继续回收。结果里逐块列着这次垫的（在哪、还在不在、是不是它自己拆的），掉落物没捡回来的块数也写着；拆不掉的个数在 climbingBlocksLeftStanding、坐标在 climbingBlocksLeft。removed 不算拆掉的垫脚。卸货时只留一组垫脚方块，多带的泥土会被卸进 dropoff（结果里的 unloaded），要用再去取。

# 图纸里有什么
- 一张图纸要哪些材料、每一格是什么，不用知道它放在哪：库函数 read_blueprint（不在工具清单里，run_program 写一行 `return (await tool("read_blueprint", { name: "cabin" })).text`）。结果是整张图纸的材料表：每种方块多少个、哪些得由人放。你自己的草稿也用它，加 draft: true。
- 在程序里，r.data.materials 是 [{ id, meta, name, count, item?, byHand? }]（item 是放它用的物品和方块不同名时的那个物品，byHand 是得由人放的原因），r.data.palette 和 r.data.cells 是每一格：`palette[cells[(y * sz + z) * sx + x]]` 是图纸里 (x, y, z) 那一格，palette[0] 是空。格子超过 262144 个的大图纸一次读不完，结果里会说；用 from、to（图纸里面的两个角，从 0 数）一块块读。
- 想看它长什么样：view_draft 加 blueprint: true（和看草稿一样：字符画，模型能看图时加 picture 画成图，见 pictures 手册）。主人在控制面板“图纸”页点“查看”看到的也是这种图。
- check_blueprint 回答的是另一件事：图纸放在某个位置时，现场已经对上多少、还要放什么、有什么挡着。它要原点。
- 材料表里同一个 id、不同 meta 的方块（chisel:nucrete/7、/3、/11）多半是同一种东西的不同花纹：仓库里没有那个 meta 时，它可能是用凿子从同组的另一种变出来的。find_recipes 查那个方块会说它在凿子的哪一组，见 crafting 手册的“凿子的花纹”。

# 示例程序
下面两段是例子，不是规矩：照着改，或者换你自己的办法。

## 例子：算一张图纸的材料，对一遍身上和仓库
```js
const name = "cabin"                                // 图纸名（list_designs 里的）
const bp = (await tool("read_blueprint", { name })).data
const mine = (await tool("get_status")).data.inventory
const lines = []
for (let i = 0; i < bp.materials.length; i += 24) {  // find_in_storage 一次最多查 24 样
  const part = bp.materials.slice(i, i + 24)
  const items = part.map((m) => m.item ?? { id: m.id, meta: m.meta })   // 放它用的物品和方块不同名时在 m.item 里
  const stock = (await tool("find_in_storage", { items })).data.items
  part.forEach((m, n) => {
    if (m.byHand) return lines.push(`${m.count}× ${m.name}：得主人自己放（${m.byHand}）`)
    const carried = mine.filter((it) => it.id === items[n].id && (it.meta ?? 0) === (items[n].meta ?? 0)).reduce((sum, it) => sum + it.count, 0)
    const short = Math.max(0, m.count - carried - stock[n].total)
    lines.push(`${m.count}× ${m.name}：身上 ${carried}，仓库 ${stock[n].total}，${short > 0 ? "还差 " + short : "够了"}`)
  })
}
return lines.join("\n")
```

## 例子：不知道原点时，拿图纸和现场比，找它放在哪
图纸不旋转、不镜像，所以只要找“最低角在哪”。知道大概在哪（主人站的地方、他指的方块）就行：
```js
const name = "cabin"
const near = { x: 30, y: 66, z: 30 }                // 大概在哪
const bp = (await tool("read_blueprint", { name })).data
if (!bp.cells) return "图纸太大，一次读不完格子：用 from、to 取它的一角来比"
// 图纸里有方块的格子，匀着取一批当样本
const filled = []
for (let y = 0; y < bp.sy; y++) for (let z = 0; z < bp.sz; z++) for (let x = 0; x < bp.sx; x++) {
  const p = bp.palette[bp.cells[(y * bp.sz + z) * bp.sx + x]]
  if (p.id !== "minecraft:air") filled.push({ x, y, z, key: p.id + "/" + p.meta })
}
const step = Math.max(1, Math.floor(filled.length / 150))
const sample = filled.filter((_, i) => i % step === 0)
// 现场：以 near 为中心读一个盒子（每边最多 64）
const r = 31
const w = (await tool("read_blocks", { x1: near.x - r, y1: Math.max(0, near.y - r), z1: near.z - r, x2: near.x + r, y2: Math.min(255, near.y + r), z2: near.z + r })).data
const keys = w.palette.map((p) => p.id + "/" + p.meta)
// 图纸的最低角放在盒子里的每一个位置都试一遍，数样本对上几格
let best = { hits: -1 }
for (let oy = 0; oy + bp.sy <= w.sy; oy++) for (let oz = 0; oz + bp.sz <= w.sz; oz++) for (let ox = 0; ox + bp.sx <= w.sx; ox++) {
  let hits = 0
  for (const c of sample) if (keys[w.cells[((oy + c.y) * w.sz + oz + c.z) * w.sx + ox + c.x]] === c.key) hits++
  if (hits > best.hits) best = { hits, x: w.x + ox, y: w.y + oy, z: w.z + oz }
}
return `对得最上的位置：最低角在 (${best.x}, ${best.y}, ${best.z})，样本 ${sample.length} 格里对上 ${best.hits} 格`
```
对上的格数明显少于样本数，说明那里只盖了一部分、或者根本不是这张图纸：这时得到的位置只是个猜测。拿到原点以后，check_blueprint 能把整张图纸和现场再对一遍。
