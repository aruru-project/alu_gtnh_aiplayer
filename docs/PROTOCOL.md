# 身体 ↔ 大脑 通信协议（bridge，版本 1）

身体是服务端 mod（`mod/`），大脑是后台服务（`brain/`）。两者只通过本协议交互。
协议只增不改：新增方法、字段、事件不升版本号；删除或改变含义才升。
双方都必须忽略不认识的字段和事件。

## 传输

- TCP，mod 监听，默认 `127.0.0.1:25590`（mod 配置 `config/aiplayer/aiplayer.json` 的 `bridgePort`；测试实例用 25591）。
- 每条消息是一行 UTF-8 JSON，以 `\n` 结束。单行上限 4 MiB。
- 最多 8 个客户端同时连接（大脑、调试脚本）。事件广播给所有已认证客户端。
- 连接后 5 秒内必须完成 `hello`，在那之前只能发一行、不超过 4 KiB。
- 客户端发得比服务器处理得快时会被压住（每个连接最多 64 条待处理请求），不会丢请求。
- 口令：mod 首次启动生成，写在 `config/aiplayer/bridge-token.txt`（仅属主可读）。

## 消息形状

```jsonc
// 客户端 → mod：请求
{"id": 7, "method": "bot.status", "params": {"bot": "Alu"}}
// mod → 客户端：响应（id 对应）
{"id": 7, "ok": true, "result": { ... }}
{"id": 7, "ok": false, "error": {"code": "not_found", "message": "no such bot: Alu"}}
// mod → 客户端：事件（无 id）
{"event": "chat", "seq": 131, "time": 1794300000000, "data": { ... }}
```

错误码：`unauthorized` `bad_request` `unknown_method` `not_found` `offline` `denied` `too_large` `internal`。

请求在服务器主线程的下一刻执行，响应通常在 50ms 内返回。耗时的事一律是“任务”（见下），请求只负责启动。

## 握手

连接后第一条请求必须是 `hello`，否则返回 `unauthorized` 并断开。

```jsonc
{"id":1,"method":"hello","params":{"token":"…","client":"brain/0.1.0","lastSeq":120,"serverEpoch":"k3j9…"}}
→ {"protocol":1,"modVersion":"0.1.0","mcVersion":"1.7.10","serverEpoch":"k3j9…","seq":131}
```

- `serverEpoch`：服务器每次启动随机生成。`seq` 在一个 epoch 内从 1 递增；响应里的 `seq` 是已经发出的最后一个事件的序号。
- 补发（缓冲最近 1000 条事件），在 `hello` 响应之后立刻发出：
  - 客户端带了 `serverEpoch` 且与当前一致：补发 `seq > lastSeq` 的事件。
  - 带了但不一致（服务器重启过）：补发这次启动以来缓冲里的全部事件。客户端应把 lastSeq 归零。
  - 没带（全新客户端）：不补发。

## 通用数据

- 方块坐标是整数 `x y z`，维度是整数 `dim`（主世界 0）。x、z 超出 ±3000 万或 y 明显不是高度时返回 `bad_request`。`world.*` 方法省略 `dim` 时：带了 `bot` 就用它所在的维度，否则主世界。
- 实体位置 `pos` 是小数；`block` 是脚所在格子的整数坐标。
- 方块：`{"id":"minecraft:stone","meta":0}`。物品：`{"id":"minecraft:dirt","meta":0,"count":64,"name":"Dirt"}`。
  `name` 是服务器语言（英文）下的显示名，只给人和模型看，不用于匹配。工具的 `meta` 一律是 0。
- 物品筛选 `ItemFilter`：`{"id":"minecraft:dirt"}`（任意 meta）或带 `"meta":0`，可带 `"count":N`。

## 方法

### 服务器与世界（只读，不会加载或生成区块）

| 方法 | 参数 | 结果 |
|---|---|---|
| `server.info` | – | `{tick, tps, tickMs, worldTime, dayTime, isDay, raining, difficulty, players:[{name,uuid,dim,pos,isBot}], bots:[name]}` |
| `world.player` | `{name}` | 一个在线玩家（真人或 bot）站在哪、朝哪看、指着什么：`{name, isBot}` 加上下面的 PlayerView。不在线返回 `not_found` |
| `world.block` | `{dim?,x,y,z, detail?=false, path?}` | `{id,meta,name,air,solid,liquid,replaceable,hardness,tileEntity,inventory,covers?,tanks?}`；区块没加载时只有 `{loaded:false}`。`covers`、`tanks` 见下面“覆盖板和流体罐”。**`detail:true` 把这个方块自己知道的全部给出来**，见下面“一个方块的全部数据” |
| `world.blocks` | `{dim?,x1,y1,z1,x2,y2,z2}`，每边最多 64 格 | 一个范围里的全部方块，画图用，见下 |
| `world.scan` | `{dim?,x1,z1,x2,z2}`，最多 64×64 列 | 见下 |
| `world.find` | `{blocks:[id…], radius?(≤48), limit?(≤64)}` + 中心 | `{matches:[{x,y,z,id,meta,dist}], total}`，由近到远 |
| `world.containers` | `{radius?(≤32), offset?=0, limit?=40(≤100), kinds?=60(≤2000)}` + 中心 | `{containers:[Container…], total, offset}`，由近到远。**`total` 是范围里的总数，`containers` 只是从 `offset` 起的一页**，要看全就翻页。Container 见下 |
| `world.drawers` | `{dim?,x,y,z, below?, offset?=0, limit?=200(≤500)}` | 一个抽屉管理器管着的全部抽屉（给的位置是普通抽屉时只有它自己），逐格列出，见下 |
| `world.entities` | `{radius?(≤64)}` + 中心 | `{entities:[{type:"player"\|"mob"\|"animal"\|"item"\|"other",name,pos,dist,item?}], total}` |

“中心”是 `{x,y,z}`，或者 `{bot}`（用该 bot 站的位置）。

Container：

```jsonc
{
  "x":-509,"y":69,"z":90, "id":"IronChest:BlockIronChest", "name":"Compressed Chest",
  "kind":"drawers",              // 没有：普通容器；"drawers"：抽屉；"drawer_controller"：抽屉管理器；"machine"：GregTech 机器
  "slots":243, "usedSlots":28,
  "items":[Item…],               // 按物品合并，最多列 kinds 种（默认 60）；还有没列的时带 "moreKinds":n。要把一个大箱子看全：以它为中心、radius 0、kinds 给大
  "covers":[Cover…],             // 它各个面上的覆盖板，以及能装东西的覆盖板里装着什么；没有就不带。见“覆盖板和流体罐”
  "attached":[                   // 紧挨着它、会自己往里送或往外抽东西的方块；没有就不带这个字段
    {"x":-516,"y":71,"z":85,"name":"Brass Item Pipe","kind":"item pipe"}   // kind：hopper、item pipe、fluid pipe、pipe（其他 mod 的管道类）
  ],
  "controller":{"x":-511,"y":71,"z":86},  // 抽屉：管着它的抽屉管理器（在查询范围内才认得出）
  "machineSlots":{"inputs":9,"inputsUsed":1,"outputs":1,"outputsUsed":0,"circuit":24}   // GregTech 单方块机器；总线是 {"slots":4,"slotsUsed":0}
}
```

- `machineSlots`：GregTech 单方块机器、总线自己的格子。机器整个物品栏的 `slots` 还算上了玩家不放东西的格子（编程电路的设置、显示用的、电池格、特殊格），说明不了能放几样原料：进阶组装机 II 的 `slots` 是 16，原料格是 9。`circuit` 是现在的编程电路号（0 没有），它是设置，不占原料格。

- 抽屉（Storage Drawers）的 `count` 是抽屉里真实的数量（可以上万），`slots` 是抽屉格数。
- 抽屉管理器自己不装东西：`items` 为空，`drawers` 是它管着几个抽屉方块，`slots`/`usedSlots` 是这些抽屉合计的格数。它管的东西用 `world.drawers` 看。
- 带 `attached` 的箱子多半是自动化的一环（进货口、出货口），往里放的东西可能马上被抽走。

**界面上的控件**（`screen.look` 等结果里的 `controls`，没有就不带）。界面上除了格子，还有开关、数字、选项、能再打开的面板（页签）、流体格、按钮。用 ModularUI 2 做的界面（GregTech 的单方块机器、覆盖板等），服务端给玩家能改的每一样东西都留着一个有名字的处理器；这里把它们原样列出来，并照玩家的客户端那样去操作。**名字是界面自己起的**（`fluidAutoOutput`、`cover_panel_west`、`powerSwitch`……），身体不知道任何一个界面是干什么的。别的做法的界面没有这一项，只能点格子。

```jsonc
"controls":[
  {"panel":"basicmachine.fluidextractor.tier.02","key":"fluidAutoOutput:0","kind":"switch","value":false},
  {"panel":"…","key":"powerfail:0","kind":"switch","value":false,"readOnly":true},          // 只显示、不收玩家的改动
  {"panel":"…","key":"cover_panel_west","kind":"panel","open":false},                       // 能再打开的面板；打开后它的格子出现在 slots 里
  {"panel":"…","key":"auto_sync:…:3","kind":"fluid","fluid":"molten.steel","name":"Molten Steel","amount":288,"capacity":32000,"fills":false,"drains":true},
  {"panel":"…","key":"…","kind":"choice","value":"X","options":["X","Y"]},                  // 还有 number、text、button、value（只是显示）、other
  {"panel":"basicmachine.assembler.tier.02","key":"auto_sync:basicmachine.assembler.tier.02:2","kind":"circuit","value":24,"range":"0 (none) or 1-24"},
]
```

- `circuit` 是 GregTech 的编程电路设置（玩家点它弹出一个小窗口选号）：`value` 是现在的号，0 是没有。`screen.set {key, value}` 给 0–24 就设成那个号，和玩家在小窗口里点一样，不用电路物品。实测：进阶组装机 24 → 5 → 0 → 24。界面另外列着的 `ghostCircuitIndex`（只读文字）是从 0 数的序号，比号小 1。

- `key` 可以写全（`fluidAutoOutput:0`），也可以只写冒号前的名字（不重名时）；`panel` 只在重名时需要。
- 实测：流体提取机 `screen.press {key:"fluidAutoOutput"}` 之后，它罐里的 288 mB 熔融钢几秒内进了隔壁的固化器；固化器 `screen.press {key:"cover_panel_west"}` 之后格子从 40 个变成 49 个，多出来的 9 个就是西面覆盖板里的东西。
- 这些改的是机器的设置，和玩家点那个按钮是一回事。
- **只画在 mod 客户端里的按钮**也在 `controls` 里：有的 mod 的界面是原版那种做法，按钮只存在于它的客户端，点了由客户端给服务器发它自己的消息。身体替 bot 做那个客户端的事（见下面“mod 的客户端”），所以这些按钮同样列出来、同样用 `screen.press` 按：`{"key":"equip","kind":"button","label":"Shoulder Copter Pack"}`，`label` 是鼠标移上去时它写的话（英文）。现在有的：探险背包（Adventure Backpack）三样背在背上的东西的界面——从手里打开的有 `equip`（背到背上），从背上打开的有 `unequip`（卸下来）。按了以后界面关上，和客户端点完就关一样；`unequip` 是这个 mod 自己隔 0.2 秒才把东西放回背包。

**一个方块的全部数据**（`world.block` 带 `detail:true` 或 `path`）。不按方块的种类做任何假设：凡是存着东西的方块（里面有什么、怎么设置的、正在干什么），存档时都把自己的全部状态写成一棵树，这里把那棵树原样给出来；会对扫描器“自报家门”的方块再把那几行话给出来。所以没见过的机器、没人为它写过读取代码的状态（输出仓锁定了哪种流体、机器的各种开关、覆盖板的设置……）都在这里。

```jsonc
{ …world.block 原有的字段…,
  "class":"gregtech.api.metatileentity.BaseMetaTileEntity",
  "says":[ "Output Hatch", "Stored Fluid: No Fluid", "0 L 16,000 L", "Locked to fluid.gas_gas" ],   // 它对扫描器说的话（GregTech 的机器有；别的没有就不带）
  "saved":{ "lockedFluidName":"gas_gas", "mMode":9, "mFacing":5, "Inventory":[], … },           // 它存档里的全部数据
  "savedCut":true            // saved 里有被省略的部分（太深、列表太长、总量太大），省略处写着怎么要
}
```

- `saved` 的键是方块自己起的内部名字（`mMode`、`lockedFluidName`、`gt.covers`……），值是原样的。物品在存档里是一个只在本服有意义的数字编号，这里换成了看得懂的 `{item, meta, count, name, …其余原样}`。
- 默认给到 6 层深、每个列表 40 项、一共约 4 万字符；超出的地方写着“ask for this path”。`path` 指定只看其中一部分并放宽限制（12 层、200 项、6 万字符），写法如 `gt.covers`、`Inventory[3].tag`（键名里本身带点的照写；列表用 `[n]`）。路径不存在时带 `pathNotFound:true` 并给出顶层。
- 没有自己数据的方块（普通方块）只有原有字段，外加一句说明。
- 这是读，不是动；怎么操作它仍然是界面和右键那一套。

**覆盖板和流体罐**（`world.block`、`world.containers` 的每个容器、`world.machines` 的每台机器都带，没有就不带这个字段）：

```jsonc
"covers":[                       // GregTech 机器、管道各个面上的覆盖板
  {"side":"west",                // 在哪个面：down / up / north / south / west / east
   "id":"gregtech:gt.metaitem.01","meta":32380,"name":"Basic Item Holder",   // 它是哪件物品
   "screen":true,                // 蹲着右键这个面会打开它自己的界面
   "slots":9,"usedSlots":9,      // 能装东西的覆盖板（槽位扩展）才有下面这几项
   "items":[Item…], "moreKinds":0}
],
"tanks":[                        // 任何装流体的方块（机器的罐、储罐、超级缸……）里现在有什么
  {"fluid":"chlorine","name":"Chlorine","amount":67000,"capacity":4000000},
  {"amount":0,"capacity":32000}  // 空的罐只有容量
]
```

- 覆盖板里的东西**不在机器自己的格子里**：机器的 `items`/`slots` 不含它们。`world.stock` 会把它们算进去，那个存放点带 `kind:"cover"`、`cover`（覆盖板的名字）、`side`。
- 存取覆盖板里的东西和玩家一样：蹲着右键那个面，打开的是覆盖板自己的界面。`deposit`/`withdraw` 的 `container` 写成 `{x,y,z,side:"west",sneak:true}`；自己点界面用 `screen.open` 的 `side`、`sneak`。
- `tanks` 是方块自己报的（Forge 的流体接口），从各个面问一遍、同一个罐只列一次。有的机器有的罐不对外报，那就不在这里。

`world.drawers` 结果：

```jsonc
{
  "controller":{"x":-511,"y":71,"z":86},   // 给的是管理器时才有
  "drawers":120,                            // 抽屉方块数
  "slotsTotal":353, "slotsUsed":166,        // 全部格数、有货的格数（不受 below 和翻页影响）
  "slots":[
    {"x":-515,"y":70,"z":86,"slot":0,"id":"gregtech:gt.metaitem.01","meta":11054,"name":"Silver Ingot","count":4,"room":2044,
     "front":"south","hit":{"x":0.25,"y":0.75,"z":1.0}},   // 玩家点这一格时点的面和位置，可以原样交给 use 任务的 side / hit
    {"x":-516,"y":69,"z":91,"slot":0,"empty":true}        // 没指定物品的空格
  ],
  "total":54, "offset":0                    // 符合条件的格数；slots 是其中从 offset 起的一页
}
```

`below` 给了就只列“有货而且数量少于它”的格。`x,y,z,slot` 就是 `withdraw` 从抽屉取货时要找的那一格所在的方块。

`world.blocks` 结果：

```jsonc
{
  "x":-600,"y":63,"z":80,            // 范围的最小角
  "sx":32,"sy":27,"sz":32,           // 各边格数
  "palette":[{"id":"minecraft:air","meta":0}, {"id":"chisel:nucrete","meta":7}, …],   // 0 号永远是空气
  "runs":[0,1520, 1,64, 0,3, …],     // 调色板下标和连续个数交替；顺序是 x 最快，其次 z，最后 y（下标 = (y*sz + z)*sx + x）
  "unloaded":0                        // 没加载的区块里的格数；这些格在调色板里是 {"id":"?"}
}
```

PlayerView（`world.player` 的结果，也是 `chat`、`whisper` 事件里的 `speaker`）：

```jsonc
{
  "dim":0, "pos":{"x":-512.4,"y":69.0,"z":93.7}, "block":{"x":-513,"y":69,"z":93},
  "yaw":-171.2, "pitch":12.5,        // 原版的角度：yaw 0 朝南（+z），90 朝西，±180 朝北，-90 朝东；pitch 正数是低头
  "facing":"north",                  // north/south/east/west；抬头或低头超过 60 度时是 up/down
  "lookingAt":{"x":-509,"y":69,"z":90,"id":"IronChest:BlockIronChest","meta":3,"name":"Compressed Chest",
               "kind":"container","side":"west","dist":4.2},   // 准星指着的方块，48 格内；什么都没指着就没有这个字段
  "ahead":[                          // 面前 12 格内、视野中央约 100 度里的容器，最正对、最近的在前，最多 6 个
    {"x":-509,"y":69,"z":90,"id":"…","meta":3,"name":"Compressed Chest","kind":"container","dist":4.2},
    {"x":-517,"y":71,"z":85,"id":"…","meta":3,"name":"Compressed Chest","kind":"container","dist":7.9,
     "attached":[{"x":-516,"y":71,"z":85,"name":"Brass Item Pipe","kind":"item pipe"}]}
  ]
}
```

`kind` 是 `container`、`drawers`、`drawer_controller`、`machine`，都不是就不带。人说“这个”“我面前的”时，先看 `lookingAt`，再看 `ahead`。

`world.scan` 结果：

```jsonc
{
  "x1":100,"z1":200,"x2":115,"z2":215,      // 已规范化为 x1≤x2, z1≤z2
  "heights":[[64,64,65,…],…],               // heights[z-z1][x-x1] = 该列地表的 y；没有则 -1
  "tops":[[0,0,1,…],…],                     // 同形状，值是 palette 下标
  "palette":["minecraft:grass","minecraft:water",…],
  "liquidPalette":[1],                      // palette 里哪些下标是液体
  "stats":{"minY":63,"maxY":71,"modeY":64,"meanY":64.8,"columns":256,"unloaded":0},
  "liquidColumns":12,                       // 顶部是液体的列数
  "tileEntities":[{"x":104,"y":65,"z":207,"id":"minecraft:chest"}]   // 区域内全高度的带数据方块，最多 64 个
}
```

地表指最高的、会挡住人的方块或液体。树叶、花草、薄雪不算；树干算，所以树在高度网格里是一根尖刺。

### bot 生命周期

| 方法 | 参数 | 结果 |
|---|---|---|
| `bot.list` | – | `{bots:[{name,online,dim?,block?,task?}]}`，含已创建但离线的 |
| `bot.spawn` | `{name, dim?,x?,y?,z?, skin?:{value,signature}}` | `BotStatus`。不给坐标时用上次下线的位置，从没上过线则在出生点。服务器开了白名单时自动把它加进白名单。`skin` 必须同时有 value 和 signature。名字和在这个服务器玩过的真人重名时返回 `denied`（离线模式下名字就是身份，重名会接管对方的存档） |
| `bot.despawn` | `{bot}` | `{}`。背包和位置存入玩家存档，任务被中断 |
| `bot.remove` | `{bot}` | `{}`。忘掉一个离线的 bot（玩家存档不删，以后同名的 bot 会接着用） |
| `bot.status` | `{bot}` | `BotStatus` |
| `bot.configure` | `{bot, settings:{invulnerable?,hunger?}}` | `{settings}` |
| `bot.chat` | `{bot, message}` | `{lines, droppedLines?, cutChars?}`：排进去了几行；队列满了没排进去的行数；超过 1000 字被截掉的字数。以该玩家身份在公共聊天说话，超过 100 字自动分行（尽量在标点或空格后面断开，不把一句话从中间切开），约每秒一行；一次最多 1000 字，排队最多 20 行，超出的丢弃。每一行开头的 `/` 和空白都会被去掉，聊天内容不会被当成指令 |
| `bot.command` | `{bot, command}` | `{output:[string]}`。以该玩家身份执行指令（不带 `/`，连斜杠最多 100 字符，超出返回 `bad_request`）。`output` 是执行当下服务器回给它的消息；之后才到的走 `bot.message` 事件。指令必须以 mod 配置 `allowedCommands` 里某一项的全部单词开头，否则 `denied`。短时间内说话和指令加起来超过大约 8 条也返回 `denied`（再多会被服务器当刷屏踢掉），等几秒再试 |
| `bot.look` | `{bot, x,y,z}` | `{}` |
| `bot.drop` | `{bot, items:[ItemFilter]\|all:true}` | `{dropped:n}`，丢在面前 |
| `bot.probe` | `{bot, x,y,z}` | `world.block` 的内容，加 `{canDig, digTicks, toolSlot, inReach, needs, candidates:[{slot,item,harvest,strength,ticks,level?,classes?,excluded?}], protection?}`：它现在能不能挖这个方块、用哪件工具、要多久，见下；`protection` 是服务器自己的保护不让它动这一格（见“任务”下面的“服务器自己的保护”），这时工具挖得动也一样 |

`bot.probe` 的 `needs` 是这个方块自己说要什么工具（Forge 的 `getHarvestTool(meta)`、`getHarvestLevel(meta)`）：`{tool?, level?, toolRequired}`。`tool` 是工具类别的名字（`pickaxe`、`axe`、`shovel`，GregTech 的 `wrench`、`cutter`……），`level` 是最低等级；方块不说类别时没有这两项，能不能挖由每件工具自己判断（原版工具按方块的材质）。`toolRequired:false` 是空手也挖得下来（有合适的工具只是更快）。读不出来时带 `unreadable:true`。
`candidates` 是空手和身上每件不能叠放的东西各自对这一格的结果：`harvest` 是游戏判定挖下来有没有掉落（Forge 的 `canHarvestBlock`，再要求有进度），`strength` 是每 tick 挖掉的比例（0 是一点进度都没有：这个整合包把原版的铁镐这类工具关掉了，就是这样），`ticks` 是要多久（-1 挖不动）；`level` 是这件工具对 `needs.tool` 那一类自报的等级（`getHarvestLevel(stack, 类别)`，-1 是不算这一类；**GregTech 的工具对任何类别都报自己的等级**，挖不挖得动看 `harvest`），`classes` 是它自认是哪几类工具、各几级（GregTech 的工具不报）。
实测（测试服）：钢管道方块（`gregtech:gt.blockcasings2` 13）`needs` 是 `wrench` 2 级；铁镐 `classes {pickaxe:3}`、`level -1`、挖不动；没有材料数据的扳手（`/give` 出来的）`level 0`、挖不动；钢扳手 `level 3`、25 tick。石头是 `pickaxe` 0 级，铁镐 `level 3` 但 `strength 0`。

`allowedCommands` 默认：`home`、`sethome`、`delhome`、`homes`、`spawn`、`back`、`tell`、`msg`、`w`、`tpa`、`tpaccept`、`team join`。
一项可以是几个词：`team join` 只放行 `team join …`，不放行 `team leave`。`home` 任务也受这个列表约束。
在这台服务器（ServerUtilities）上实测：`sethome 名字` 回 `Home '名字' set!`；`home list` 回 `Alu: 1 / 99: 名字, …`；不存在的 home 回 `Unknown Home: '名字'!`。

对已经在线的 bot 再 `bot.spawn` 返回 `bad_request`；先看 `bot.status` 的 `online`。

上线时服务器和其他 mod 会给它发十来行欢迎语，这些都作为 `bot.message` 事件出现。`bot.command` 的回显除了在响应里，也会各作为一条 `bot.message` 事件发出。

`BotStatus`：

```jsonc
{
  "name":"Alu","uuid":"…","online":true,"dim":0,
  "pos":{"x":10.5,"y":64.0,"z":-3.5},"block":{"x":10,"y":64,"z":-4},
  "yaw":90.0,"pitch":0.0,"onGround":true,"inWater":false,
  "health":20.0,"maxHealth":20.0,"food":20,"xpLevel":0,
  "heldSlot":0,"held":Item|null,
  "inventory":[{"slot":0,"id":"…","meta":0,"count":1,"name":"…","durability":0.83}],  // slot 0–8 快捷栏，9–35 背包；durability 是剩余比例，仅工具有
  "armor":[Item|null ×4],
  "worn":[Worn],                   // 穿在盔甲格以外的东西，没有就不带；见下
  "aboveGround":10.04,             // 脚离下面第一个挡得住人的方块（或液面）多高；站在地上是 0；下面 256 格内什么都没有、或没加载时不带
  "motion":{"x":0.0,"y":0.18,"z":0.0},   // 上一个 tick 实际移动了多少（格/tick，一秒 20 tick）
  "freeSlots":20,
  "task":TaskInfo|null,"queue":[TaskInfo],
  "settings":{"invulnerable":true,"hunger":false}
}
```

离线的 bot 只有 `name uuid online settings task queue`。

Worn：穿在盔甲格以外的一件东西。有的 mod 把玩家穿的东西放在自己的格子里（探险背包 mod 背上那一格：背包、直升机背包、煤喷气背包，一次一件）。

```jsonc
{"slot":"back", "id":"adventurebackpack:copterPack","meta":0,"count":1,"name":"Copter Pack",
 "tanks":[{"fluid":"fuel","name":"Fuel","amount":15806,"capacity":16000}],   // 它画给玩家看的那几个罐（屏幕角上的液位），同 world.block 的 tanks
 "data":{"wearableData":{"status":2,"fuelTank":{"FluidName":"fuel","Amount":15806},"inventory":[],"tickCounter":1}},  // 它自己存的数据（NBT），原样
 "dataCut":true}                  // data 里有截掉的部分（最多 5 层、每个列表 12 项、约 3000 字符）时才有
```

`data` 的键是那个 mod 起的名字，值原样；身体不解释（探险背包的直升机背包：`wearableData.status` 0 关、1 普通、2 悬停，是这个 mod 的代码里的意思）。

### mod 的客户端

有的 mod 让玩家做的事有一半在客户端里：按它加的键、右键它的某些物品、点它界面上画的按钮、按住跳时它做的事。客户端算完，再给服务器发它自己的消息。bot 没有客户端，身体替它做客户端的那一半：照那个 mod 客户端的代码做，发它自己的消息，交给服务器上这个 mod 的处理代码，和真客户端发来的一样。做了什么由那个 mod 决定，身体只报看得见的变化。

现在有的只有探险背包（Adventure Backpack）：

- 它的两个键：`keys.adventureBackpack.openInventory`（打开背上那件的界面；手里拿着背包时打开手里那个；它的界面开着时再按是关上）和 `keys.adventureBackpack.toggleActions`（穿着直升机背包时蹲着按是开关、不蹲按是普通和悬停之间切换；煤喷气背包蹲着按是开关；背包不蹲按是工具循环的开关、蹲着按是夜视的开关；手里拿着软管时换它接的罐）。
- 右键它的三样东西（在空中）：客户端向服务器要这件东西的界面。`screen.open {item}`、`use` 任务、`deposit`/`withdraw` 的随身包都走这条路，所以这三样从手里能打开界面，背包能当随身的包用。
- 界面上的 `equip` / `unequip` 按钮（见上面“界面上的控件”）。
- 按住跳：直升机背包开着、有油时把人往上提（它客户端里的 `elevate`，紧接在这个 mod 自己每 tick 的悬停、慢落之后）；煤喷气背包开着、有蒸汽时告诉服务器“正按着跳”，往上推的是它服务器这边的代码。按住跳是 `hold` 任务。
- 它的客户端打印的几句话（`CopterPack: Normal Mode.` 这类，配置 Chat Spam 开着时）当成 bot 收到的消息：进 `bot.message` 事件，也在 `bot.key` 的 `said` 里。

还有任务书（BetterQuesting）：它的界面整个只在客户端里画，按钮发的消息见下面“任务书的按钮”。

**只在客户端里画的界面**：有的界面服务器上根本没有（不是容器，没有格子），客户端自己画、自己处理点击，点了再给服务器发 mod 自己的消息。身体不替 bot 画这种界面，所以它打不开；它的按钮做的事由专门的方法做。现在有的只有任务书：

```jsonc
{"screen":"the quest book (BetterQuesting)", "item":{"id":"questbook:ItemQuestBook"},   // 客户端里右键它打开
 "key":"key.betterquesting.quests", "keyName":"Open Quests",                            // 客户端里按它打开
 "instead":["quest.submit","quest.check","quest.choose","quest.claim"]}                  // 做它的按钮做的事的方法
```

- `bot.keys` 的 `clientOnly` 列出有键的；`bot.key` 按这个键是 `bad_request`，消息说它只在客户端里打开什么、用哪些方法。
- `screen.open {item}` 拿着这件东西右键以后没有界面时，结果是 `{open:false, clientOnly:{screen, instead, text}}`：这个界面不会出现，不用再等。

| 方法 | 参数 | 结果 |
|---|---|---|
| `bot.keys` | – | `{keys:[{key, name, category}], clientOnly?}`：身体按得了的键。`key` 是游戏自己给这个键起的名字，`name`、`category` 是游戏“控制”设置里它的名字和分组（英文）。`clientOnly` 是客户端里有、却只打开一个服务器上没有的界面的键（见下面“只在客户端里画的界面”），按不了 |
| `bot.key` | `{bot, key, sneak?=false}` | 像玩家那样按一下这个键；`sneak` 是按着 Shift 按。结果 `{key, screen?, changed?, said?}`：`screen` 是按完以后开着的界面（同 `screen.look`；按之前开着、按完关了的，是 `{open:false}`），`changed` 是穿着的东西自己存的数据里变了的值 `[{slot, key, was?, now?}]`（`key` 是 `data` 里的路径，空串是那件东西本身换了；最多 30 个），`said` 是这一下让游戏对它说的话。什么都没变时只有 `key`。只在没有任务在跑时可用（否则 `busy`：一个键可能打开界面）；没有这个键是 `bad_request`，消息里列出有哪些 |

实测（测试服）：直升机背包 16 个柴油单元灌满 16000 mB；蹲着按 toggleActions `status` 0 → 1、说 `CopterPack: Normal Mode.`，再按（不蹲）1 → 2、`Hover Mode.`；悬停时 `hold {jump:true, y:104}` 56 tick 从 y 94 升到 104.04 并停在那里；`hold {toward}` 向西 29 格（最快 0.7 格/tick），松手后又滑了 7.7 格；`hold {sneak:true, y:86}` 61 tick 落地；蹲着按 toggleActions 关机。按住跳时不做客户端的那一半（把身体里的 `elevate` 去掉），同样的 `hold {jump:true}` 100 tick 一格也没升。

**设置**：`invulnerable`（默认开）不受伤害，怪物也不把它当目标；`hunger`（默认关）关着时饱食度不下降。
进食用 `use` 任务（把食物拿在手里右键）；打开 `hunger` 后没人让它吃它就会饿死。

**死亡**：和玩家一样。发 `bot.death`，当前任务以 `interrupted` 失败、队列清空；约 1.5 秒后自动重生（发 `bot.spawned`），位置和掉落物按服务器规则。死亡到重生之间 `bot.status` 的 `health` 是 0。

**被踢或被顶号**：变为离线并保持离线（发 `bot.despawned`，`reason` 是踢人理由），需要再次 `bot.spawn`。

**服务器重启**：重启前在线的 bot 在服务器启动约 2 秒后自动上线，没做完的任务从头重新开始。
区域任务因此只是接着做；但 `withdraw` 会再取一份，`haul` 重启时拿在手上的那一趟货会留在 bot 身上不再送达。

### 物品、配方、库存（只读）

配方数据都在服务器上：合成台配方、GregTech 各机器的配方、熔炉配方。服务器启动后约 20 秒建好索引，在那之前这几个方法返回 `busy`，过几秒再试。
物品名是服务器上的英文显示名（例如 `Electric Motor (LV)`、`Copter Pack`）。

| 方法 | 参数 | 结果 |
|---|---|---|
| `item.search` | `{query, limit?=12(≤40)}` | `{items:[{id,meta,name, recipes:{crafting,machine,smelting}, ores?:[矿辞名]}]}`。名字或 id 里包含 query 的每个词，最像的排前面 |
| `recipe.find` | `{id, meta?=0, bot?, crafting?=4, machines?=8, machine?}` | 这个物品怎么做，见下。`machine` 给了就只列名字里含它的机器的配方 |
| `world.machines` | `{radius?=32(≤64), name?, limit?=30(≤60)}` + 中心 | 附近的 GregTech 加工机器（单方块的，和多方块机器的主机），由近到远：`{machines:[{x,y,z,name,id,meta,recipes,tier,inputSlots,outputSlots,active,progress?,maxProgress?,storedEU,inputVoltage,switchedOff?,autoOutput?,dist}], total}`。`autoOutput` 是单方块机器界面上的自动输出开着时（两个开关都关着不带）：`{items, fluids, side?, to?:{x,y,z,name}, outputFaceIsFront?}`，开着的那几样做出来就从输出面 `side` 推给挨着的 `to`，不留在产物格；`outputFaceIsFront` 时输出面就是它的正面，什么都推不出去。`recipes` 是它跑哪种配方，`recipeKey` 是这种配方在配方册里的页（`handlers.json` 的 `key`），`circuit` 是它现在设的编程电路（没设不带）（和 `recipe.find` 里的 `machine` 同名，如 `Lathe`）；`id`+`meta` 是这台机器作为物品时的那一对，和配方册 `handlers.json` 里每个配方页的 `machines` 可以直接比对；`storedEU` 为 0 就是没电；`name` 给了就只列名字或 `recipes` 里含它的 |
| `world.stock` | `{items:[{id,meta?} \| {ore}], radius?=32(≤64)}` + 中心 | 这些东西存在哪：`{items:[{id,meta?\|ore, total, places:[{x,y,z,container,kind?,cover?,side?,count,items?}], morePlaces?}], containersLookedInto}`。查的是半径内已加载区块里的所有箱子、抽屉（真实数量）和其他带物品栏的方块；每样最多列 6 处，数量多的在前。按矿辞名或不带 meta 查时，每处带 `items`：具体是哪几种（id、meta、名字、数量），可以直接拿去 `withdraw` |

`recipe.find` 的结果：

```jsonc
{
  "item":{"id":"adventurebackpack:backpackComponent","meta":6,"name":"Copter Blades"},
  "crafting":[{
    "index":0,              // craft 任务的 recipe 参数
    "gives":1,              // 做一次出几个
    "grid":"3x3",           // "2x2" 的不需要工作台
    "ingredients":[
      {"count":4,"name":"Shaft (Refined Iron)","id":"IC2:itemRecipePart","meta":12,"have":0},
      {"count":3,"name":"Steel Screw (any screwSteel)","ore":"screwSteel","example":{"id":"gregtech:gt.metaitem.01","meta":27305},"have":0},
      {"count":1,"name":"Single Use Screwdriver (any craftingToolScrewdriver)","ore":"craftingToolScrewdriver","example":{…},"alternatives":6,"tool":true,"have":0}
    ]
  }],
  "machines":[{
    "machine":"Lathe","tier":"LV","eut":16,"seconds":2.5,
    "inputs":[{"id":"…","meta":0,"name":"Steel Bolt","count":1}],     // notConsumed:true 的要放在机器里但不消耗（编程电路、模具）
    "fluidInputs":[{"name":"Molten Steel","mb":18}],
    "outputs":[{"id":"…","meta":0,"name":"Steel Screw","count":1}],
    "fluidOutputs":[…]
  }],
  "machineRecipeCounts":{"Lathe":1,"Fluid Solidifier":3},   // 每种机器有几条配方；默认每种机器最多列 2 条
  "smeltedFrom":[{"id":"…","meta":0,"name":"…","count":1}],
  "total":{"crafting":1,"machines":4,"smelting":0}
}
```

- `ingredients` 里一项要么是一种确定的物品（`id`、`meta`；没有 `meta` 表示任何变体都行），要么是一个矿辞名（`ore`，任何登记在这个名字下的物品都行，`example` 是其中一种）。
- `tool:true` 是锤子、扳手、锉刀这类：做的时候要带着，只磨损不消耗。
- `have` 是给了 `bot` 时它身上现有的数量。
- 有些 mod 自己的配方类型读不出原料，标 `unreadable:true`；这种配方 `craft` 做不了。
- `tier` 是按 `eut` 算出的最低机器等级。

多方块机器在 `world.machines` 里是它的主机，字段不同：

```jsonc
{
  "x":-569,"y":69,"z":41, "name":"Electric Blast Furnace", "id":"gregtech:gt.blockmachines","meta":1000,
  "kind":"multiblock",
  "formed":true,                      // 结构完整。false 时下面的总线和仓都是空的，用不了
  "recipes":"Blast Furnace", "recipeKey":"gt.recipe.blastfurnace",
  "inputVoltage":1024, "tier":"EV",   // 能源仓合计能给的电压和对应的等级；配方的 eut 不能超过它
  "heat":3801,                        // 只有高炉一类有：线圈给的炉温，配方的 special 不能超过它
  "active":false, "progress":40, "maxProgress":200, "switchedOff":true,
  "idleReason":"No valid recipe found",        // 没在干活时，机器自己界面上说的原因（英文）；结构不完整、有维护问题也写在这里
  "inputBuses":[ {"x":-568,"y":69,"z":41,"name":"Input Bus (LV)","kind":"input bus","slots":4,"usedSlots":4,"circuit":2,
                  "attached":[{"x":-568,"y":69,"z":42,"name":"Hopper","kind":"hopper"}]} ],
  "outputBuses":[ {"x":-570,"y":69,"z":41,"name":"Output Bus (LV)","kind":"output bus","slots":4,"usedSlots":0,
                   "passesTo":[{"x":-570,"y":69,"z":42,"name":"Chest"}]} ],   // 输出总线不留东西时，东西会到这些箱子里
  "inputHatches":[ {"x":-570,"y":69,"z":40,"name":"Input Hatch (LV)","kind":"input hatch","capacity":16000,
                    "fluid":"argon","fluidName":"Argon","amount":16000} ],
  "outputHatches":[ … ],
  "dist":12.4
}
```

- 总线和仓也是容器：`deposit` / `withdraw` 可以直接对着它们的位置用，和对着箱子一样走它自己的界面。
- `attached` 说明这个口有漏斗或管道在自动喂料、抽料：输入总线可能一直是满的，输出总线里的东西可能留不住。

### 界面（通用）

玩家用任何带界面的东西都是同一套动作：打开、看格子、点、关。存取、加工、合成这些任务是走某一类界面的现成办法；下面四个方法是它们底下那层，给没有现成任务的界面用。它们不认界面是哪个 mod 的，点了会怎样由界面自己决定。只在 bot 没有任务在跑时可用（否则 `busy`）。

| 方法 | 参数 | 结果 |
|---|---|---|
| `screen.open` | `{bot, x,y,z, side?, hit?:{x,y,z}, sneak?=false}` 或 `{bot, item:{id,meta?}}` | 右键打开够得着的方块的界面，或把身上那件东西拿到手里右键打开它的界面（那件东西的界面只在客户端里画时，结果带 `clientOnly`，见“只在客户端里画的界面”）。`side`（点哪个面）、`hit`（点面上的哪一点，各 0–1）、`sneak`（蹲着点）和 `use` 任务的同名参数一个意思：有的方块点不同的面、蹲不蹲，打开的界面不一样（蹲着右键机器上有覆盖板的那个面，打开的是覆盖板的界面）。给了 `side` 时身体必须已经站在那个面的前方。拿着东西右键时，有些 mod 的物品是在客户端里才去要界面的，身体照它的客户端做（见“mod 的客户端”）。结果同 `screen.look`。够不着是 `out_of_reach`（先走过去），被拒绝是 `denied`（消息里写着是什么：服务器的出生点保护连范围一起写，领地这类别的 mod 只说被拒绝了），身上没有那件东西是 `no_material` |
| `screen.look` | `{bot}` | `{open, screen?, slotCount?, slots?:[Slot…], cursor?:Item}`。有的界面点开后过一小会儿才出现，那时 `open:false`，稍后再看 |
| `screen.click` | `{bot, slot, button?=0, shift?=false}` | 点一个格子：`button` 0 左键、1 右键，`shift` 是按着 Shift 点。和游戏自己的界面发的点击完全一样。结果是点完之后的 `screen.look` |
| `screen.press` | `{bot, key, panel?, button?=0, shift?=false}` | 按一下界面上格子以外的东西（见下面“界面上的控件”）：开关翻过来；面板打开（已经开着就关上）；按钮做它的事；流体格照鼠标上拿着的容器装或倒（`button` 0 左键、1 右键）。结果同 `screen.look`。界面没有这个控件、或者它只是显示用的，照实拒绝 |
| `screen.set` | `{bot, key, panel?, value}` | 把一个开关、数字、文字或选项设成 `value`。只读的控件 `denied` |
| `screen.close` | `{bot}` | 关掉；鼠标上还拿着的东西放回背包（放不下就掉在脚边） |

Slot：`{slot, own?, item?:Item, x?, y?, class?, takesNothing?, takes?, accepts?, ghost?, index?, role?}`。界面自己的格子带 `x`、`y`：界面把它画在哪（从界面左上角数的像素），玩家靠位置认格子；自己摆格子的界面（GregTech 的）没有这两项。`class` 是这一格在代码里的种类（类名，如 `SlotPattern`、`SlotOnlyTake`），普通的格子不带。实测（匠魂的部件加工台）：0、1 号 `SlotPattern`（x 40，y 27 / 45），2、3 号材料格（x 58），4–7 号 `SlotOnlyTake`（x 102、120）。GregTech 机器、总线的界面上，机器自己的格子带 `index`（在机器物品栏里是第几格）和 `role`：`input` 原料格、`output` 产物格、`special` 特殊格（有的配方要读的模具、数据棒）、`battery` 电池格、`circuit` 编程电路。实测（测试服进阶组装机）：界面 0 号是特殊格（机器第 3 格）、1 号电池格（第 1 格）、2–10 号原料格（第 5–13 格）、11 号产物格（第 14 格）；编程电路不在格子里，是一个 `circuit` 控件。`slot` 是点击用的编号；`own:true` 是 bot 自己背包里的格子（自己的空格不列）；`takesNothing:true` 是放不进东西的格子，也就是机器出产物的地方；`takes:[{id,meta,name}]` 是只收某些东西的空格子（燃料格、只收装流体的单元和桶的格子、工具格、模具格）收 bot 身上的哪几种（鼠标上拿着的也算；最多 8 种，可能一种都没有）；一种都没有时 `accepts:[{id,meta,name}]` 是游戏的物品表里它收的几样（最多 4 样，各取 meta 0），看得出是哪一类东西；圆石、bot 身上的东西、几样代表（煤、空桶、水桶、铁镐、空单元）和物品表里的每一种都不收的才算 `takesNothing`；`ghost:true` 是只显示、里面没有真东西的格子（编程电路的设置）。

常用的点法：按着 Shift 点自己的一格，东西会进界面里“该去的地方”（机器的原料格、熔炉的燃料格）；按着 Shift 点界面里的一格，东西回到背包；左键点一格是拿起或放下一整组，右键是拿一半或放一个。

### 任务书

服务器上的任务书（BetterQuesting）：章节、每个任务的说明和要求、某个玩家的进度。下面四个方法只查；bot 替自己按任务书上的按钮见“任务书的按钮”。服务器没装任务书时这些方法返回 `not_found`（消息里有 `no quest book`）。
任务书的内容对所有人都一样，也都在客户端包里，大脑可以自己存一份（见 `docs/PACKDATA.md`）；那样只需要 `quest.progress`。
`player` 是玩家名（在线的，或任务书见过的）；给了才有进度相关的字段。任务 id 是任务书自己的编号：老任务是一小段十六进制数（如 `47`），新任务是完整的 UUID。

| 方法 | 参数 | 结果 |
|---|---|---|
| `quest.lines` | `{player?}` | `{lines:[{name, quests, complete?, available?}], quests}`，按任务书里章节的顺序 |
| `quest.search` | `{query?, line?, state?, player?, limit?=20(≤60)}` | `{quests:[{id, name, line?, state?}], total}`。`query` 的每个词都要出现在标题或说明里（标题里出现的排前面）；`line` 是章节名的一部分；`state` 是 `available`（已解锁未完成）、`complete`、`locked` 之一，需要 `player` |
| `quest.get` | `{id, player?}` | 见下 |
| `quest.progress` | `{player}` | `{player, completed:[id…], unclaimed:[id…], known?}`。`completed` 是这个玩家已完成的全部任务；`unclaimed` 是其中有奖励还没领的。任务书没见过这个玩家时两个都是空数组，并带 `known:false` |

```jsonc
{
  "id":"47","name":"Basic Crafting: Motors","line":"Tier 0.5 - Steam",
  "description":"Motors are little devices that …",      // 最多 3000 字
  "state":"complete, reward unclaimed",                  // available | locked | complete | complete, reward unclaimed
  "requires":[{"id":"43","name":"Wired, Weird?!","complete":true}],
  "tasks":[
    {"type":"crafting","complete":true,"items":[{"id":"gregtech:gt.metaitem.01","meta":32600,"count":2,"name":"Electric Motor (LV)"}]},
    {"type":"optional_retrieval","complete":false,"consumed":false,"items":[…]}
    // 其他类型可能带 fluids:[{fluid,mb}]、target+count（猎杀）、location:{x,y,z,dim}
  ],
  "rewards":[{"type":"item","items":[{"id":"…","meta":0,"count":15,"name":"…"}]}]
}
```

任务书里的文字是英文。`tasks`、`rewards` 的顺序就是任务书自己的顺序（和客户端包里的任务文件、大脑的本地资料一样）；下面的按钮方法说“第几个”就是这个顺序，从 0 数。

给了 `player` 时还有这个玩家的：

- 每个子任务的 `complete`；`optional:true`（可做可不做，不影响完成）；`progress`：子任务自己记着的数——每样物品（或流体）一个数，和 `items`（或 `fluids`）一一对应，是交了几个 / 数到几个；猎杀、经验这类是一个数；打勾、到某地这类不计数的没有。
- 挑一样的奖励（`type:"choice"`）的 `chosen`：他现在选的是 `items` 里的第几样（从 0 数），没选不带。
- `buttons:{submit, claim}`（玩家在线时）：任务界面上“检测/提交”“领取”两个按钮在他的客户端里能不能按，用的是任务书自己的判断（`canSubmit`；有奖励且 `canClaim`）。
- `party:{name, members, claimForAll}`（他在任务书的队伍里时）：队伍里打勾、交东西算全队；`claimForAll` 是服务器设置（questbook.cfg 的 syncQuestRewards），为真时一个人领了全队都算领过，为假时各领各的。

### 任务书的按钮

任务书的界面只在客户端里画（见“只在客户端里画的界面”）。玩家在里面能做的四件事，每件是客户端给服务器发一条任务书自己的消息（BQ_NET_CHAN 通道，NBT 压缩后切片）。身体替 bot 做客户端那一半：照任务书客户端的代码拼出同样的消息，交给服务器上这个通道的处理代码，和真客户端发来的一样。**只动 bot 自己的进度**（它在队伍里时，任务书照它的规矩算到全队）。只在没有任务在跑时可用（否则 `busy`）。

| 方法 | 参数 | 客户端里是哪一下 | 发的消息 |
|---|---|---|---|
| `quest.submit` | `{bot, id}` | 任务界面的“检测/提交”（Detect/Submit） | `betterquesting:quest_action`，action 1 |
| `quest.check` | `{bot, id, task}` | 勾选框子任务的那个框 | `bq_standard:task_checkbox` |
| `quest.choose` | `{bot, id, reward, choice}` | 挑一样的奖励里点其中一样 | `bq_standard:choice_reward` |
| `quest.claim` | `{bot, id}` | 任务界面的“领取”（Claim） | `betterquesting:quest_action`，action 0 |

`task`、`reward`、`choice` 是 `quest.get` 里的第几个，从 0 数。任务书自己存的编号不一定是 0、1、2……（这个整合包里有 375 处不连着，比如 47b 的三个奖励存的是 1、3、4），身体照位置换成它存的编号再发。不是勾选框的 `task`、不是挑一样的 `reward`、超出范围的是 `bad_request`。

结果（`QuestPressResult`）只报看得见的变化：

```jsonc
{
  "pressed":true,
  "quest":{"id":"2","name":"Sticks 'n Stones","state":"available","was":"locked"},   // 现在的状态，同 quest.get；was 只在变了时有
  "tasks":[                                   // submit、check：每个子任务现在的样子，task 从 0 数
    {"task":0,"type":"retrieval","complete":true,"was":false,"progress":[9,5],"progressWas":[0,0]},
    {"task":1,"type":"retrieval","complete":true,"was":false,"progress":[2],"progressWas":[0]}
  ],
  "tasksDone":true,                           // 子任务都满足了、任务还没标完成：任务书下一次查这个玩家时标（每 3 秒一次）
  "lost":[{"id":"minecraft:log","meta":0,"name":"Oak Wood","count":2}],      // 背包（连盔甲格）少了的：交上去被收走的
  "gained":[Item…], "dropped":[Item…],        // 多了的；背包放不下、掉在脚边的
  "xp":{"levelWas":0,"level":1,"pointsWas":0,"points":7},
  "alsoComplete":[{"id":"60","name":"…"}],    // claim：奖励顺带完成的别的任务
  "chosen":{"reward":0,"choice":1,"item":Item},   // choose
  "said":["…"],                               // 这一下让游戏对它说的话（命令奖励这类）
  "party":{…},                                // 在队伍里时，同 quest.get
  "note":"…",                                 // 要知道的：任务还锁着（检测不看、打的勾留着解锁后算）、选择只在内存里
  "freeSlots":28
}
```

- **按钮在客户端里是灰的**时身体不发消息，结果是 `{pressed:false, button, why, quest, choices?}`，`why` 用任务书自己的判断：提交——任务已完成（奖励领没领）；领取——没有奖励、还没完成（还锁着的连前置一起写；子任务都满足了、等任务书下一次查的也写明）、已经领过、挑一样的还没挑（`choices` 列出没挑的那个奖励的选项）；勾选框——已经勾上了。
- **提交**：任务书只看已经解锁的任务。要收走东西的子任务（retrieval、fluid 带 `consumed:true`）只在按这一下时从背包里拿走（这个整合包里有 103 个，没有一个是自动收的）；不收走的那种，背包一变任务书就自己数（玩家没按也会完成），按这一下也会再数一遍。还锁着的照样按得下（客户端里这个按钮亮着），什么都不看，`note` 写明。
- **打勾**：服务器不看任务解没解锁（客户端开了查看模式就能打开没解锁的任务去点，这台服务器显示查看模式按钮），所以照收；任务还锁着时 `note` 写明勾留着、解锁后算。
- **挑一样**：选择只存在服务器内存里（任务书不把它写进存档），服务器重启以后、还没领的要重新选。`note` 写着这句。
- **领取**：东西进背包，放不下的掉在脚边（`dropped`）；命令奖励在下一刻执行，看得见的只有它说的话。
- 子任务满足以后，“完成”要等任务书下一次查这个玩家（每 3 秒一次）才标上；结果带 `tasksDone` 时，过几秒再 `quest.get` 看。
- 实测（测试服）：“木棍与石头”（2）身上 9 个沙砾、7 个原木，前置“你的第一个夜晚”（0）没完成时提交：`state:"locked"`、什么都没数，`note` 写着差 0；0 完成以后等 8 秒什么都没变（要收走的那 2 个原木没人收），提交：收走 2 个原木，两个子任务 `[9,5]`、`[2]`，3 秒内标成完成；领取得到 1 个火把、5 个硬币。存档里它的这条进度和正式服上三个真玩家用任务书做完的一模一样（`data` `[9,5]`、`[2]`，`claimed:1`）。勾选框：“GT6 型导线和线缆”（47b）勾上、3 秒内完成；不选就领：灰的，`choices` 列出两样；选第 2 样（橡胶末，任务书里这个奖励存的编号是 1）再领，得到 8 个橡胶末、豌豆汤、10 个硬币。没解锁的“准备出发！”（f）打勾照收，前置一完成它就完成了。“继续焊接！”（a6b，两个子任务存的编号是 1、2）勾第 1 个（从 0 数）、“TecTech 多方块机器”（a7a，勾选框存的编号是 1）勾第 0 个，都勾上了。背包满时领“终于，有点像样的燃料了！”（1b）的桶：桶掉在脚边，`dropped` 里有它。

### 图纸

图纸是 Schematica 的 `.schematic` 文件，放在服务器的 `config/aiplayer/schematics/` 里（随时可以放进去，不用重启），名字就是去掉后缀的文件名。
图纸里的方块按文件自带的注册名对应，所以在别的存档上画的图纸也能用。摆放时不旋转、不镜像，`x y z` 是图纸最小角落在世界里的位置（和 Schematica 里显示的原点一致）。

| 方法 | 参数 | 结果 |
|---|---|---|
| `blueprint.list` | – | `{blueprints:[{name, size:{x,y,z}, blocks} \| {name, error}], folder}` |
| `blueprint.check` | `{name, x,y,z, bot?\|dim?, layers?=true}` + 下面的范围和方块选项 | 把世界和图纸逐格对比，见下。只读，不动任何东西 |
| `blueprint.read` | `{name, from?:{x,y,z}, to?:{x,y,z}, cells?=true}` | 图纸本身的内容，和世界无关。`{name, size:{x,y,z}, blocks, materials:[{id, meta, name, count, item?, byHand?}], x,y,z, sx,sy,sz, palette:[…], runs:[…]}`。`materials` 永远是整张图纸的材料，多的在前：`id`/`meta` 是方块；放它用的物品和方块不同名时带 `item:{id,meta}`；身体不放、留给人的带 `byHand`（原因）。`palette` + `runs` 和 `world.blocks` 同一种写法（下标 = (y*sz + z)*sx + x，`palette[0]` 是空），是 `from`..`to` 这个盒子里的格子；两个角都是**图纸内部**的位置，从最低角的 0 数起，两头都含，不给就是整张。一次最多 262144 格，超了 `too_large`，分块读。`cells:false` 只要材料、不要格子 |
| `blueprint.put` | `{name, data}`，`data` 是文件内容的 base64，最大 2 MiB | `{name, size, blocks}`。同名覆盖；不是能用的图纸时 `bad_request` 并说明原因 |
| `blueprint.remove` | `{name}` | `{removed:bool}` |

`blueprint.check` 和 `blueprint` 任务共用的选项：

- `x1,x2` / `y1,y2` / `z1,z2`：只处理图纸的一部分（世界坐标，成对给）。大图纸靠它分块，楼层靠 `y1,y2` 分层。
- `only:[方块id]`：只管图纸里的这几种方块，这时图纸里空着的格子不处理。`skip:[方块id]`：图纸里的这几种不管。
- `clear:[方块id]`：挡路时允许挖掉的方块。两个词代表一类：`"natural"` 是配置的天然方块（泥土、草方块、沙子、沙砾、雪、树叶……），`"plants"` 是所有长出来的东西（花、灌木、树叶、没有内容的作物）。不给 `clear` 就什么都不挖。

`blueprint.check` 的结果：

```jsonc
{
  "name":"02_Workshop_v3","origin":{"x":-592,"y":63,"z":80},
  "box":{"x1":-592,"y1":63,"z1":80,"x2":-561,"y2":89,"z2":111},   // 实际对比的范围
  "cells":5294,        // 范围内图纸上有方块的格子数
  "done":10,           // 已经和图纸一样
  "toPlace":3823,      // 现在空着，bot 能放
  "byHand":0,          // 现在空着，但得由人来放（见 byHandBlocks）
  "blocked":1461,      // 图纸上有方块的位置被别的方块占着
  "extra":2581,        // 图纸上是空的位置有方块
  "willRemove":4019,   // blocked 和 extra 里，clear 允许挖、也确实挖得动的
  "unloaded":0,        // 所在区块没加载、看不到的格子（为 0 时省略）；不为 0 时结果不完整，让 bot 走近些
  "materials":[{"id":"chisel:nucrete","meta":7,"name":"Structural Concrete","need":1874,"have":0}],  // 要放的方块；have 只在给了 bot 时有；放它用的物品 meta 不同时带 item:{id,meta}（have 数的是它）
  "byHandBlocks":[{"id":"minecraft:chest","meta":3,"name":"Chest","count":2,"why":"it holds contents or settings"}],
  "blockedBy":[{"id":"minecraft:dirt","name":"Dirt","count":1196,"removable":1196,"natural":true}],
  "extraBlocks":[{"id":"gregtech:gt.blockmachines","name":"…","count":14,"removable":0,"holdsData":14}],
  "layers":[[63,1024,0,0,1024,0], …]     // 每层 [y, 图纸方块数, done, toPlace, blocked, extra]
}
```

`blockedBy` / `extraBlocks` 按世界里的方块种类统计：`removable` 是按现在的 `clear` 会被挖掉的个数，`holdsData` 是带数据（机器、箱子）谁也不会动的个数。列表各最多 30 种，没有时省略。

**bot 能放的**是普通建筑方块及其变体，和朝向取决于怎么放的方块（楼梯、原木、台阶的上下半、火把、梯子这类）：后者照图纸里那一格的 meta 放，见“任务”下面的“放成指定的 meta”；材料表里放它用的物品和方块的 meta 不同时带 `item`（朝南的楼梯用的是普通的楼梯物品 0，上半台阶用的是普通的台阶物品）。不放、算作 `byHand` 的：带内容或设置的（箱子、抽屉、GT 管道和机器），没有放它的物品的，放它的物品不是普通方块物品的（门、告示牌），方块类自己另写了放法、身体预料不到的，以及哪种点法都放不出这个 meta 的。以前楼梯、原木都算 `byHand`；上半台阶不算，可要的物品是根本没有的 `stone_slab` 8，取不到。

### 任务

任务是 bot 在游戏里花时间做的事。每个 bot 同一时刻只执行一个任务，其余排队（最多 32 个）。
任务状态和队列随世界存档保存，服务器重启后自动继续。

| 方法 | 参数 | 结果 |
|---|---|---|
| `task.start` | `{bot, task:{type,…}, mode?:"replace"\|"append"}` | `{task:TaskInfo, replaced:[id]}`。`replace`（默认）取消当前任务和队列后立即开始，`replaced` 是被它取消的任务；`append` 排到队尾。响应里的任务状态总是 `queued`，它在下一刻才开始（届时发 `task.update`）。被取消任务的 `task.update` 事件先于这个响应到达 |
| `task.cancel` | `{bot, id?}` | `{canceled:n, ids:[id]}`。不给 id 则取消当前任务和整个队列 |
| `task.list` | `{bot}` | `{active:TaskInfo\|null, queue:[TaskInfo], recent:[TaskInfo]}`，recent 是最近结束的 10 个，新的在前 |

`TaskInfo`：

```jsonc
{
  "id":"t42","type":"flatten","params":{…},
  "state":"queued|running|done|failed|canceled",
  "progress":{"done":120,"total":400,"phase":"clearing","note":"layer y=70"},
  "createdAt":…, "startedAt":…, "finishedAt":…,          // epoch ms
  "result":{…},                                           // 已经做成的部分；运行中、失败、取消时也有
  "error":{"code":"no_tool","message":"…","detail":{…}}   // failed 时
}
```

任务失败码：

| code | 含义 | detail | 大脑通常怎么办 |
|---|---|---|---|
| `unreachable` | 走不到目标，或目标比步行上限（配置 `maxTravel`，默认 256 格）还远 | 可能有 `x y z` | 太远就先 `home` 传送到附近；否则换目标或问人 |
| `stuck` | 多次尝试后仍无进展 | | 看状态后重试或问人 |
| `no_tool` | 没有能挖这种方块的工具。消息写着它要什么（工具类别和等级，同 `bot.probe` 的 `needs`）和身上每件工具为什么不行 | `block`、`x y z`、`needs` | 找工具或问人 |
| `no_material` | 要放的方块不够 | `missing`，`item` 或 `items` | 去取或问人 |
| `inventory_full` | 背包满且没有指定卸货箱 | | 去存东西再重启任务 |
| `container_full` | 目标箱子放不下 | | 换箱子或问人 |
| `denied` | 被服务器的出生点保护、领地或其他 mod 拒绝（挖不动、放不下、点不动、箱子打不开），或指令不在允许列表里 | 可能有 `block`、`x y z`；服务器自己的保护拒绝的带 `protection` | 问人 |
| `invalid` | 参数不合法，或服务器拒绝了指令 | | 修正参数 |
| `interrupted` | bot 下线、死亡，或被带到了别的维度 | | – |
| `internal` | mod 内部出错 | | 报告给人 |
| `busy` | 配方索引还在建（服务器刚启动） | | 过几秒再试 |

区域类任务（`dig` `place` `clear` `fill` `flatten`）是可重入的：失败后用同样参数再启动，只做还没做完的部分。

任务类型：

| type | 参数 | 行为 |
|---|---|---|
| `goto` | `{x,z, y?, range?=1, dim?}` | 走到离目标水平 range 格以内。给了 `y` 时高度差不超过 2（range 大于 2 时至多 4）；不给则以该处地面为准 |
| `goto_player` | `{player, range?=2}` | 走到某玩家身边；5 分钟追不上以 `stuck` 失败 |
| `follow` | `{player, distance?=3}` | 一直跟着，直到被取消。对方离线、在别的维度或暂时走不到时原地等 |
| `home` | `{name}` | 执行 `/home name` 并等传送完成 |
| `dig` | `{blocks:[{x,y,z}]}`，≤256 | 逐个挖掉，由近到远。点名的方块里装着东西（箱子、抽屉、机器）也照样挖，像玩家挖一样，里面的东西掉出来；区域类任务（`clear` `flatten` 和图纸的清障）碰到装着东西的方块是跳过的（`has contents`） |
| `place` | `{blocks:[{x,y,z,item,meta?,blockMeta?}], supply?}`，≤256 | 逐个放置，由低到高，材料从背包拿。给了 `meta` 就只用这个 meta 的物品放（用完了去 `supply` 取这一种，取不到以 `no_material` 停下）；不给是这个 id 的哪种都行，背包里先找到哪种用哪种，可能混着放（`fill` 同）。`blockMeta`（0–15）是放下去以后那一格方块的 meta（`world.block` 读到的那个）：楼梯朝哪边升、原木横竖、台阶上半下半。给了就照它放，见下面“放成指定的 meta”；给了 `blockMeta` 不给 `meta` 时用哪种物品由身体挑（能放出这个 meta 的那种：云杉原木横放 `blockMeta` 5 用的是物品 `log` 1） |
| `clear` | `{x1,y1,z1,x2,y2,z2, dropoff?, overflow?}`，体积 ≤ 32768 | 把盒子里所有方块挖掉，一层一层从上往下 |
| `fill` | `{x1,y1,z1,x2,y2,z2, item, meta?, shape?:"solid"\|"hollow"\|"walls", supply?}` | 在盒子里的空位放方块，由低到高。`hollow` 只放六个面，`walls` 只放四周 |
| `flatten` | `{x1,z1,x2,z2, y, fill?=true, fillItems?:[id], maxFillDepth?=3, dropoff?, supply?, overflow?}`，≤64×64 | 把区域整成地面顶层在 y 的平地：挖掉 y 以上的一切，再把 y 及以下的坑由低到高填上 |
| `deposit` | `{container:{x,y,z, side?, sneak?}, items?:[ItemFilter], keep?:[id]}` | 走过去把物品放进箱子。`container` 里带 `side` / `sneak` 时，不是普通地右键它，而是点那个面（蹲着或不蹲）打开界面，打开的是什么界面就往什么界面里放（覆盖板里的格子就这样存取）；`withdraw` 同。不给 items 则放入除工具、食物和 keep 以外的全部 |
| `withdraw` | `{container:{x,y,z, side?, sneak?}, items:[ItemFilter], fromInputs?=false}` | 走过去取出物品，数量精确。界面里有“放不进东西的格子”的是机器：默认只从这些产物格取；`fromInputs:true` 改成从其余的格子取（把留在里面的模具、模头、没用完的原料拿出来）。没有这种格子的是普通仓储，哪格都取 |
| `haul` | `{from:{x,y,z}, to:{x,y,z}, items?:[ItemFilter]}` | 在两个箱子之间来回搬，直到源箱子里符合条件的搬完或数量够。只搬这一趟取出来的东西，bot 自己的物品不动 |
| `collect` | `{x,y,z, radius?=8}` | 捡起范围内掉在地上的物品 |
| `give` | `{player, items:[ItemFilter]}` | 走到玩家面前，把物品扔给他 |
| `blueprint` | `{name, x,y,z, 范围和方块选项, supply?, dropoff?, overflow?}`，一次最多 64×64 列 | 照图纸建：先把挡路又允许挖的方块从上往下挖掉，再由低到高放方块。见“图纸” |
| `craft` | `{id, meta?=0, count?=1, recipe?=0, table?:{x,y,z}}`，或 `{grid:[9 格], gives?:{id,meta?}, rounds?=1, table?}` | 手工合成：用身上的材料按配方摆好、取成品。第一种写法按服务器自己知道的配方：`count` 是想要的个数，`recipe` 是 `recipe.find` 里的 `index`。第二种写法由调用方把摆法说出来，见下 |
| `process` | `{machine:{x,y,z}, inputs:[{id,meta?,count}], circuit?, fluids?:[{id,meta?,count}], expect?:[{id,meta?,count}], bus?:{x,y,z}, wait?=180, leave?=false}` | 用一台 GT 机器加工一批：把原料放进去，等它做完，把产物取回来。`machine` 是单方块机器，或多方块机器的主机。`wait` 是最多等多少秒（5–3600）。其余见下 |
| `use` | `{item?:{id,meta?}, on?:{x,y,z}, side?, hit?:{x,y,z}, times?=1(≤64), every?=4(1–40 tick), sneak?=false, left?=false}` | 右键一下，像玩家那样：手里拿着 `item`（不给就是空手，这时必须给 `on`），对着空中（不给 `on`：吃、喝、穿戴、打开它自己的界面）或者对着那个方块（会先走过去）。可以指定点哪个面、点面上的哪一点、连点几下。见下 |
| `hold` | `{ticks(1–1200), jump?, sneak?, toward?:{x,z}, range?=1, y?, above?}` | 按住几个键一段时间，像玩家那样：`jump` 跳（空格）、`sneak` 潜行（Shift）、`toward` 朝那一列方块的中心按住前进（边走边转向它）。不找路、不挖不放，前面有什么就撞上什么。按了会怎样由世界和身上穿的东西决定（穿着开着的直升机背包，按住跳是往上升、按住潜行是往下降）。到 `ticks`、脚到 `y`（从下往上升到它，或从上往下降到它）、离地高度到 `above`（同样两个方向；0 是落地）、或者离 `toward` 水平不到 `range` 格时松手结束。见下 |
| `wait` | `{ticks}` | 原地等待 |

规则和边界：

- **挖**：走原版挖掘流程，时间、工具耐久、掉落都照算。自动选背包里最快的工具，但不用一次挖多格的工具（配置 `excludedTools`：匠魂锤、挖掘铲、伐木斧等），它们会波及任务范围之外。
  没有合适工具时，一挖就碎的东西（雪、草）徒手挖，石头之类则以 `no_tool` 失败，消息写着方块要的工具类别和等级、身上每件工具为什么不行（不是这一类、等级不够、一点进度都没有），`detail.needs` 同 `bot.probe`。区域任务碰到这种方块跳过时，原因里也写着要的类别和等级。
  不动带数据的方块（箱子、机器）、液体、基岩和紧挨岩浆的方块，记入 `result.skipped`。
- **放**：必须有相邻的方块可以依附，够得着，自己不能站在那一格。没处依附的记入 skipped。
- **放成指定的 meta**（`place` 的 `blockMeta`、`blueprint` 里朝向由放法决定的方块）：游戏里决定的是方块自己的两段代码。先是 `onBlockPlaced`，看点的是哪个面、点在面上哪一点（原木顺着点的那个面的轴；台阶和楼梯点在侧面上半是倒的）——身体对任何方块都原样调它；再是 `onBlockPlacedBy`，看放的人：朝哪看（楼梯往远离人的方向升，熔炉、箱子正面朝人），活塞、发射器还看人站得多近多高——这一段身体认得原版的那些方块类，所以也认得继承它们的方块（各个 mod 的楼梯）。方块类自己另写了这一段的，身体预料不到：照平常的放法放，放完对照，不对就记在 `cameOutDifferent` 里（见结果）。
  - 玩家放的时候视线就是从眼睛到点的那一点的方向，所以身体先算出哪几种点法（点哪个邻格的哪个面、上半还是下半）能放出这个 meta，再走到一个站位：够得着、点的那个面朝着眼睛、从那里看过去的方向给这个 meta（离两个方向的分界至少 10 度）。站好以后转头、蹲着点。
  - 哪种点法都放不出来：记入 skipped，原因写着放出来会是哪几种（`no click gives /9 with minecraft:spruce_stairs:0: placed in this cell it comes out as /0, …, /7`）。能放出来、但要点的那个邻格没有方块：原因写着要点在哪（`to come out as /8 it has to be placed by clicking the upper half of the side of a block north, south, west or east of it; or the underside of the block above it; there is no such block there`），像没处依附一样，别的格放好以后再试一遍。找不到那样的站位：原因写着要朝哪看、站在哪边（`unreachable: found nowhere to stand that is in reach and gives /2 (looking south as it clicks, so standing north of the point it clicks)`）。那一格已经是同一种方块、meta 不对：不动它，记入 skipped。
  - 点同一种台阶的上表面（或上半台阶的下表面）在游戏里是把两块合成一个双台阶，这种点法不算。
  - 实测（测试服）：一条一格宽、两边是墙、下面悬空的梯道里，四级云杉木楼梯 `blockMeta 2`（往南升）四级都是 /2；平地上四级 /0、/1、/2、/3 各是各的；原木 /4 点了它西边那块石头的侧面；云杉原木 /5 不给 `meta` 用了 `log` 1；只有地面时上半台阶 /8、倒楼梯 /4 记着要点侧面上半或上面那块的底面。
- **服务器自己的保护**：原版服务器会不出声地丢掉玩家对它保护的方块的点击、挖掘和对着它的放置（没有事件，什么都不变，该开的界面也不开）。身体在每一次右键、挖、对着方块放之前先问服务器（`isBlockProtected`）；受保护就不点出去，这一下以 `denied` 收场：任务失败，`screen.open` 返回错误。消息写明是什么、多大范围，`error.detail.protection` 是同样的数：`{x,y,z, by:"spawn protection", spawn:{x,z}, range, x1,z1,x2,z2}`——被拒绝的那一格（放方块时是对着放的那一格），主世界里离出生点 `range` 格以内（x、z 两个方向里大的那个）、所有高度；服务器有 op 时，不是 op 的玩家在这里点、挖、放都被拒绝。`by` 是 `"the server"` 的，是服务器拒绝了、但不在出生点那一块里（别的 mod 改了规则）。实测（测试服 spawn-protection=1，出生点 (-136, 154)，范围 x -137..-135、z 153..155）：打开那里的部件加工台、空手右键、左键、挖、对着那里的方块放、往那里的箱子里放东西都以 `denied` 收场，都在 0.6 秒内；`fill` 跨进这块时外面的两格照放，碰到里面的那一格停下。
- **走路时**先找不改动地形的路；确实走不通才挖开或垫脚。
- **走路时**只会自己挖开“天然方块”（mod 配置 `naturalBlocks`：泥土、草方块、沙子、沙砾、雪、树叶、花草等；不含石头和木头，因为人也拿它们盖房子）和任务指定要清掉的区域内的方块，不会为了抄近路拆别的东西，也不会挖掉本任务刚放下的方块。
  够不着高处时会用填充方块（配置 `fillerBlocks`：泥土、圆石等）垫脚往上搭；去箱子存取的路上不垫脚，免得把货用掉。
- **树**：够不着的树叶和上面的雪直接跳过（`foliage out of reach`）。
- **`dropoff` / `supply`** 是箱子坐标 `{x,y,z}` 或坐标数组：背包满时自动去 dropoff 卸货（留下工具、食物和一组垫脚方块），`clear` 和 `flatten` 结束时再卸一次；材料不够时自动去 supply 取。
- **`overflow`**：背包满又没给 dropoff 时，`"fail"`（默认）以 `inventory_full` 失败，`"leave"` 继续挖、把掉落物留在地上。
- **`flatten` 的填充材料**按 `fillItems`（默认是配置的 `fillerBlocks`）的顺序，用背包里有的第一种；挖出来的泥土、圆石会被捡回来用上。坑比 `maxFillDepth` 深的列不填，记入 skipped。
- **箱子**：空手右键打开箱子界面，用 shift 点击转移。点击被领地保护之类拒绝时以 `denied` 失败。
  点击没被拒绝却没有界面的储物方块（桶）按漏斗的方式存取。
- **抽屉**（Storage Drawers）按玩家的方式用：站到正面，左键拍出一组或一个，右键把手里的东西放进去；数量精确。身上某一种东西要全部放进去、又不止一组时，放完第一组马上再点一下（双击），剩下的同类一次全进去；只放一部分时仍是一组一组放。
  `deposit`/`withdraw`/`haul`/`supply`/`dropoff` 的箱子位置都可以是抽屉。封箱的抽屉、被保护的抽屉以 `denied` 失败。
  往抽屉里放：已经装着同一种的那格优先，其次是还没指定物品的空格；都没有就算放不下。
- **`blueprint`**：
  - 不给 `clear` 时一块都不挖；挡着的位置跳过，留在结果的 `blockedBy` 里。带数据的方块、液体、基岩在任何情况下都不挖。
  - 一格只从“脚不低于它”的位置放，所以楼板和屋顶是站在上面铺的，bot 不会把自己封在底下；做完时它在建筑顶上。
  - 材料不够时去 `supply` 取（一次按接下来要用的顺序尽量多拿）；哪种都取不到的，先跳过继续放别的，最后以 `no_material` 失败，`error.detail.missing` 列出每种缺多少。没给 `supply` 也是这样。
  - 挖出来的东西背包满时送去 `dropoff`，建筑材料留在身上。
  - 结束时（成功或失败）结果里有 `now`：`{cells, done, toPlace, byHand, blocked, extra}`，以及各最多 8 项的 `materials`（还缺的）、`byHandBlocks`、`blockedBy`、`extraBlocks`。
    够不着又没有垫脚方块时带 `needsClimbingBlocks:true`。
  - 重新执行会接着做：已经对的格子不动。
- **`craft`**：
  - 材料和工具必须已经在身上（先 `withdraw`）。不够时以 `no_material` 失败，`error.detail.missing` 列出每样还差多少（格式同 `recipe.find` 的 `ingredients`）。
  - `2x2` 的配方在随身的合成格里做，不用走动。`3x3` 的要工作台：`table` 给位置，不给就找 48 格内最近的（原版工作台、匠魂的合成站都行；任何界面里有 3×3 合成格的方块都可以用 `table` 指定）。附近没有时以 `invalid` 失败。
  - 合成站的格子里有别人摆的东西时不动它，以 `invalid` 失败。
  - 摆好以后出什么由游戏说了算：出来的不是要的东西时把材料收回、以 `invalid` 失败。
  - 结果 `{crafted, item:{id,meta,name}, freeSlots}`，`crafted` 是多出来的个数。
  - **`grid` 写法**：`grid` 是 3×3 格子一行一行数的 9 格，每格是 `null`、`{id, meta?}`（不写 meta 是任何 meta 都行）或 `{ore:"plateSteel"}`（这个矿物辞典名下的任何一种，工具也这样写，如 `{ore:"craftingToolHardHammer"}`）。配方册 `recipes.jsonl` 里有序合成的每格带的 `g` 就是这里的下标；无序合成随便摆。**东西照给的格子原样摆**：右边、下面空着的列和行不算（所以只占左上 2×2 的配方不用工作台），左边、上面空着的列和行是配方的一部分，不会被挪掉。这个包里的黏土铸模全是“空白黏土铸模 + 小刀”，出哪一种只看两样东西各摆在哪一格。
    只占左上 2×2 的就在随身合成格里做。`rounds` 是做几轮（1–64）。`gives` 是预期的成品：给了，出来的不是它就失败；不给，第一轮出什么就认什么。
- **随身的包当容器**：`deposit` / `withdraw` 的 `container` 除了位置，还可以写 `{item:{id,meta?}}`，意思是“我身上这件东西右键打开的那个界面”（背包一类）。不用走路；包本身不会被放进它自己里面；`deposit` 这样用时必须列出 `items`。身上没有这件东西是 `no_material`；右键后没有界面打开是 `invalid`。
- **`use`**：
  - 这是玩家用东西的通用办法，做了什么由那件物品自己决定，所以结果只报看得见的变化：`{used:"名字", gained:[{id,meta,name,count}], lost:[…], openedScreen?, health, food, freeSlots}`。`gained`/`lost` 是背包里多了、少了什么（吃掉的食物、穿到身上去的装备会出现在 `lost` 里）。
  - 吃喝这类要举着一会儿的，会等到用完（最多 8 秒）。
  - 右键打开了界面的（背包）会被马上关掉并带 `openedScreen:true`；要往里放、往外拿，用上一条说的 `deposit` / `withdraw`。
  - `sneak:true` 是蹲着右键，有些东西蹲着用是另一个意思（比如穿到身上而不是打开）。
  - **点哪里**（只在给了 `on` 时有意义）：`side` 是 `down`/`up`/`north`/`south`/`west`/`east` 之一，指方块的哪个面；给了水平的面，它会先走到那个面的正前方（走不到就 `out_of_reach`）。不给 `side` 时点朝着它的那个面。`hit` 是点在方块里的哪一点，三个数各 0–1、从方块最低的角算起，和游戏自己发的一样；不给是那个面的正中间。只认正面、按点的位置分格子的方块（抽屉的每一格、面板上的按钮）靠这两个参数。
  - **连点**：`times` 是右键几下，`every` 是两下之间隔几 tick——就是玩家按住右键。手里的东西中途用光了，后面几下照样点（手里是空的）。中途打开了界面就不再点。例：手里拿着一组东西对抽屉正面 `times:2`，第二下是“双击”，身上所有同类的都放进去。
  - 结果里多 `clicks`（实际点了几下）和 `side`（点的是哪个面）；空手时 `used` 是 `"an empty hand"`。
  - **手里是方块时**（以及点完那一格变了时），结果里还有 `placeCell:{x,y,z, before, now, clicked?}`：手里的方块会进的那一格，点之前和现在是什么。游戏放进的是点的那个面外面的一格；点的方块自己一碰就让开（草、薄雪、藤蔓）时是它自己那一格（`clicked:true`）。拿着方块点了、那一格没变时，`notPlaced` 照游戏放方块前自己做的检查依次写明是哪一条没过：点的方块有界面、又没蹲着时点击给了它（它打开了界面，蹲着点才是对着它放）、那一格被什么占着、有什么站在那一格里、方块自己的规矩说它不能立在那里（梯子要贴着实心方块、火把要有地方挂）、服务器或别的 mod 拒绝了，都不是时照实说看不出原因。实测：意见簿 f16 那一下（拿着梯子点墙的西面），梯子其实放进了西边那一格，以前结果只写着“点的那一格还是混凝土”，模型以为放了个空。对着方块点的，还有 `blockBefore`、`blockNow`（`注册名/meta`）：点之前和现在那一格是什么，方块变了、没了都看得出。那一格有方块实体（机器、箱子）时还有 `dataChanged:[{key, was?, now?}]`：它自己存的数据（NBT，摊平成 `mFacing`、`gt.covers[0].d` 这样的路径）里点完以后变了的值，最多 30 个（多的数在 `dataChangedMore`）；点之前两 tick 里就在自己变的（进度、电量）不算，去掉了几个写在 `dataMovingLeftOut`。实测：扳手点输出总线上表面中间 `mFacing` 5 → 1。
  - 实测：凿子左键结构混凝土，凿子界面输入格里放着 /3 时那一格变成 /3；输入格空着时是同组下一种（/7 → /8）。
  - **`left:true` 是左键**（要给 `on`）：按下马上松开，像玩家点一下。对按下有反应的东西照样反应（拿着凿子左键方块就是在原地凿成凿子里选好的样子；一碰就碎的方块会碎），要挖一会儿的方块不会被挖掉。空手左键要快捷栏里有空格（没有是 `inventory_full`）。结果里带 `left:true`。
- **`process`**：
  - `machine` 可以是**任何带界面、能放东西的方块**。GregTech 的单方块机器和多方块主机，身体读得懂它的状态（见 `world.machines`）；别的机器（原版熔炉、其他 mod 的机器）身体不认识，就照玩家的办法用：按着 Shift 把原料点进去，等它里面的东西不再变化，把产物格里的东西取回来。这种机器“没开工”的判断是 10 秒内里面什么都没变。
  - 原料必须已经在身上。模具、模头这类“放进去但不消耗”的东西列进 `inputs`（数量 1）；做完后它放进去的东西里没被消耗的会一并取回，机器里原来就有的不动。
  - **产物是流体的配方**（流体提取机把钢板化成熔融钢）：没有物品可取，但机器的罐（多方块是输出仓）里的东西变了，就算做成了；结果带 `note` 和 `fluids`（现在罐里有什么）。流体留在原处，怎么送到下一台机器是另一回事（机器界面上的自动输出开关、管道、单元）。
  - **编程电路**用 `circuit`（1–24，0 是清掉）：像玩家点机器界面上的电路格一样直接设，不需要身上有电路；做完后恢复成原来的设置。单方块机器设在机器上，多方块设在输入总线上。没有电路设置的机器（总线）给 `0` 照常加工（本来就没有电路）；给 1–24 是 `invalid`，什么都不放。走到机器跟前、放原料**之前**先设好（先放再设的话，机器会先拿刚放进去的料按原来的电路开工：实测卷板机原来是电路 1，放 9 块黑曜石板要做致密板（电路 9），先做出了黑曜石箔）。
  - **做的不是要的东西**：给了 `expect` 时（不只是多方块），GregTech 机器被看见在做的东西（`making`、`made`）一样都不是 `expect` 里的，任务就不是 `done`：一看到它在做别的，身体马上把还在原料格里的、它放进去的东西取回来；不带 `leave` 的再等手上那一轮做完、把产物格里的取走，带 `leave` 的不等；电路恢复原样；以 `invalid` 失败，`error.message` 写着它做了什么、要的是什么、带着几号电路（是不是这个任务设的），`result` 同下（`outputs` 里是取回来的原料和产物，`made`、`elsewhere` 是做了什么、去了哪）。放料前机器已经在跑配方的（别人的料、管道送来的），看见的头一个配方可能是那个，这时不提前取回，只在结束时比：做出来的里面有 `expect` 的就算数。实测（测试服，照正式服那台进阶组装机 II 的设置：电路 1、物品自动输出朝西接着箱子）：2 铁杆 + 4 铁环要做车轮、不清电路，开工的是“铁杆 + 电路 1 → 铁栅栏”；修之前 `done`、取回 4 个铁环、2 根铁杆做成 2 个铁栅栏进了箱子；现在 `invalid`，第一轮的 1 根铁杆做成铁栅栏，4 铁环 1 铁杆取回；电路给 0 时做出 2 个车轮。
  - 结果里的 `making`（有就带）：机器开工后正在跑的那个配方要出的东西，身体看见它在跑配方时从机器里读的。别的东西进了机器（管道、覆盖板送来的），或者它带着别的电路，这里会和要的对不上。配方短到两次查看之间就做完的，读不到，不带。`leave` 只在看见机器真的在跑配方、或者放进去的原料已经被拿走时才算开工（机器做完一个配方后“工作中”的标记还会亮一会儿，单看它会误以为开工了）。
  - **多方块机器**：原料放进输入总线（有几个时挑空格最多的，或用 `bus` 指定），产物从各个输出总线取。
    - `fluids`：身上装着流体的单元，放进第一个输入仓让它倒空，空单元取回；仓装不下的满单元也取回，不算倒了。配方要的流体如果已经由管道接好，就不用给。
    - 输出总线自己不留东西（它会把东西推给旁边的箱子，或被管道抽走）时：给了 `expect` 就去它推往的箱子（`passedTo`）里把 `expect` 列的产物取回来；没给就以 `done` 结束，`outputs` 为空，带 `note` 和 `passedTo` 说明东西去了哪。
    - 流体产物留在输出仓里，不取。
  - 机器没开工（单方块 3 秒、多方块 10 秒）就把原料取回来，以 `invalid` 失败，`error.message` 里带原因（多方块是它界面上的说法，如 `No valid recipe found`），`error.detail` 是这台机器的状态。可能是没电、缺电路或流体、没有这个配方、炉温或电压不够、输出口被占着。
  - 原料一样都放不进去（输入格、输入总线满了）也以 `invalid` 失败。输入总线带 `attached` 时多半是被自动喂料占满的，这要主人决定怎么办。
  - 结果 `{put, cellsPoured?, outputs:[{id,meta,name,count}], rounds?, made?, elsewhere?, autoOutput?, attached?, timedOut?, note?, passedTo?, freeSlots}`。`outputs` 是取回到身上的（产物，和没被消耗的模具、没用完的原料）。等到 `wait` 还没做完时取走已有的产物和还没开始做的原料并带 `timedOut:true`；机器只把手上那一轮做完，产物留在它里面（实测：54 个钢锭进压缩机、等 5 秒，取回 36 个钢锭，之后机器里多了 2 个钢块）。一个东西都没取到、可看见机器在跑配方的，也是 `done` 带 `timedOut`。
  - **机器做了什么**（GregTech 机器，身体看着它转时读的）：`rounds` 是这次看着它做完了几轮配方，`made` 是这几轮一共做出了什么（机器开始每一轮时自己记着的产物）。和 `outputs` 是两件事：做出来的可能没留在机器里。
  - **产物被送走了**：机器自己的自动输出、覆盖板、管道可能边做边把产物送走，产物格里什么都不剩。身体在放完料时把机器（多方块是各个输出总线）周围的容器——挨着它各面、有物品栏的方块（机器、总线、管道也算）和它的漏斗通往的箱子——记下里面有什么，做完再看一遍：`elsewhere:[{x,y,z,name,side?,bus?,items}]` 是多了它做的那几种东西的容器、多了多少（`side` 是它挨着机器——多方块是 `bus` 那个输出总线——的哪一面，经过漏斗才到的没有 `side`）；身体读不懂的机器不知道它做什么，是多了的不是原料的东西。这时还带 `autoOutput`（同 `world.machines`）和 `attached`（接在机器上的漏斗、管道）。
  - 一个产物都没取到，但看到它做完了配方（`rounds` > 0）或者周围的容器里多了它做的东西：做成了、产物被送走了，任务是 `done`，带 `note`。都没有才以 `invalid` 失败（`the machine ran but nothing could be taken out of it, and it was not seen to finish a recipe`）。实测：LV 压缩机物品自动输出开着、输出面朝下、下面是一个输入总线，54 个钢锭 → `done`，`rounds` 6、`made` 6 个钢块、`outputs` 空、`elsewhere` 是那个总线（`side:"down"`）里的 6 个钢块；奇点压缩机（一轮只要一两 tick）同样 7 轮都数到了；原版熔炉下面接漏斗、漏斗通到箱子，3 个圆石烧成的 3 个石头在那个箱子里。
  - **`leave:true`：放进去就走。** 不给它时这个任务从放料一直占着身体到取完产物（机器要转几分钟，身体就站几分钟）。给了它：原料放进去、电路设好、看到机器开工，任务就以 `done` 结束，身体可以去做别的；机器自己接着转。结果是 `{put, cellsPoured?, left:true, note, machine?, circuit?:{now, was}, freeSlots}`——`machine` 是结束那一刻这台机器的状态（同 `world.machines` 的一项，带 `progress`/`maxProgress`，单位 tick），身体不认识的机器没有这一项。
    - 产物、没消耗掉的模具都留在机器里，之后像从容器里取东西一样取：`withdraw` 的 `container` 给这台机器（产物格；`fromInputs:true` 是原料格，模具在那里）；多方块取输出总线。
    - 电路**不恢复**（后面几轮还要用），`circuit.was` 是原来的值；要恢复得之后自己设回去。
    - 没开工的处理和不带 `leave` 时一样：原料取回、电路恢复、以 `invalid` 失败。
  - **调用的人自己带的字段**：任务参数里身体不认识的键原样留在任务的 `params` 里，任务信息和结束事件都带着它。大脑用它记“这一批是哪条配方的几轮”（`recipe:{ref, rounds, ticks?}`），身体不读它。
  - 多方块的总线和仓不按名单找：主机名下登记的所有总线和仓都算（蒸汽多方块的蒸汽总线也在内）。
  - 还不行的：单方块机器的流体格（要它已经接好流体来源）；界面里要点按钮才能开工的机器（用 `screen.*` 自己点）。
- **门和电梯**：走路时会开门（原版木门、栅栏门、以及配置 `doorBlocks` 里的门，如木匠方块的卷帘门），走过去以后随手关上；铁门这类只能用红石开的不行。
  会坐 OpenBlocks 电梯（站上去，相当于跳一下上楼、蹲一下下楼）。门打不开或电梯不动时换别的路。
- **从高处下来**：无敌的 bot 敢从最多 40 格高直接跳下；会受伤的只肯落 3 格。
  数量按 bot 背包里实际增减的数目计。

结果 `result`：

- 区域任务：`{removed, placed, placedItems?, skipped?:{原因:数量}, skippedExamples?:[{x,y,z,reason}], cameOutDifferent?, cameOutExamples?:[{x,y,z,want,got,why?}], freeSlots}`，`cameOutDifferent` 是放下去了、但 meta 和要的不一样的格数（身体预料不到放法的方块，`why` 写着），`flatten` 另有 `level`，`clear` 另有 `clearedDownTo`。`placedItems:[{id,meta,name,count}]` 是放下去的方块各是从哪种物品放的（`place`、`fill`、`flatten`、`blueprint` 都有）：同一个 id 的不同 meta 是不同的方块，放混了看得出来。实测：`fill` 不给 meta，身上先放着 10 个钢管道方块（`gregtech:gt.blockcasings2` 13）、20 个坚固钢机械方块（0），放了 18 个是 10 个 13 加 8 个 0；给 `meta:0` 只放 8 个 0，以 `no_material`（`out of gregtech:gt.blockcasings2:0; 10 more needed`）停下。`blueprint` 照图纸里那一格的 meta 放，同样只用这一种（实测：一排 9 格坚固钢机械方块的图纸，身上同样放着两种，放了 8 个 0、缺 1 个以 `no_material` 停下，钢管道方块一个没动）。
  为了够到高处垫的方块，任务结束前会拆掉；够不着拆的个数在 `climbingBlocksLeftStanding`。
- `give`：`{dropped}`；`deposit`：`{moved, freeSlots}`；`withdraw`：`{moved, missing?:[{id,meta?,count}]}`（箱子里不够的部分）；`haul`：`{moved, trips}`；`collect`：`{pickedUpStacks}`。
- 移动类：`{block:{x,y,z}}`，`home` 另有 `dim`。
- `hold`：`{held, stopped, from, pos, block, onGround, aboveGround?, motion, lowest, highest, distance?, track, tanks?}`。`held` 是按了几个 tick；`stopped` 是为什么松手（`ticks` 时间到、`y` 到了那个高度、`above` 离地到了那个高度、`arrived` 到了 `toward` 的 `range` 以内）；`from`、`pos` 是开始和现在的位置（小数）；`aboveGround`、`motion` 同 `BotStatus`（松手那一刻还在动的，之后还会接着滑一段）；`lowest`、`highest` 是脚的最低、最高；`distance` 是现在离 `toward` 多远；`track` 是路上最多约 30 个点 `[{t, x,y,z, above?}]`（`t` 是第几个 tick）；`tanks` 是穿着的东西的罐 `[{slot, fluid?, name?, amount, capacity, was}]`（`was` 是开始时的量）。

## 事件

| event | data | 说明 |
|---|---|---|
| `chat` | `{player, uuid, message, isBot, speaker?}` | 公共聊天里的每一句，含 bot 自己说的（`isBot:true`）。控制台 `/say` 不算。真人说的带 `speaker`：他说这句话时站在哪、朝哪看、指着什么（PlayerView，见“服务器与世界”） |
| `whisper` | `{bot, from, message, isBot, speaker?}` | 有人用 `/tell` `/msg` 私聊 bot。`isBot` 是发来的是不是另一个 bot（大脑据此不让两个 bot 互相叫醒）；说话的人是在线的真人时带 `speaker` |
| `bot.message` | `{bot, text}` | 发给 bot 的其他系统消息（指令回显、死亡信息等） |
| `task.update` | `{bot, task:TaskInfo}` | 任务开始、完成、失败、取消时各发一次；进度变化不推送 |
| `bot.spawned` | `{bot}` | 上线，以及死亡后重生 |
| `bot.despawned` | `{bot, reason}` | |
| `bot.hurt` | `{bot, source, amount, health}` | 每个 bot 最多每 2 秒一次 |
| `bot.death` | `{bot, cause}` | |
| `player.join` / `player.leave` | `{player, uuid}` | 真人玩家 |
| `server.stopping` | `{}` | 之后连接会断开 |
