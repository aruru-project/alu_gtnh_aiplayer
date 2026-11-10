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
| `world.block` | `{dim?,x,y,z}` | `{id,meta,name,air,solid,liquid,replaceable,hardness,tileEntity,inventory}`；区块没加载时只有 `{loaded:false}` |
| `world.scan` | `{dim?,x1,z1,x2,z2}`，最多 64×64 列 | 见下 |
| `world.find` | `{blocks:[id…], radius?(≤48), limit?(≤64)}` + 中心 | `{matches:[{x,y,z,id,meta,dist}], total}`，由近到远 |
| `world.containers` | `{radius?(≤32)}` + 中心 | `{containers:[{x,y,z,id,name,slots,usedSlots,items:[Item…]}], total}`，由近到远最多 40 个；items 已按物品合并，每个箱子最多列 60 种 |
| `world.entities` | `{radius?(≤64)}` + 中心 | `{entities:[{type:"player"\|"mob"\|"animal"\|"item"\|"other",name,pos,dist,item?}], total}` |

“中心”是 `{x,y,z}`，或者 `{bot}`（用该 bot 站的位置）。

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
| `bot.chat` | `{bot, message}` | `{}`。以该玩家身份在公共聊天说话，超过 100 字自动分行，约每秒一行；一次最多 1000 字，排队最多 20 行，超出的丢弃。每一行开头的 `/` 和空白都会被去掉，聊天内容不会被当成指令 |
| `bot.command` | `{bot, command}` | `{output:[string]}`。以该玩家身份执行指令（不带 `/`，连斜杠最多 100 字符，超出返回 `bad_request`）。`output` 是执行当下服务器回给它的消息；之后才到的走 `bot.message` 事件。指令必须以 mod 配置 `allowedCommands` 里某一项的全部单词开头，否则 `denied`。短时间内说话和指令加起来超过大约 8 条也返回 `denied`（再多会被服务器当刷屏踢掉），等几秒再试 |
| `bot.look` | `{bot, x,y,z}` | `{}` |
| `bot.drop` | `{bot, items:[ItemFilter]\|all:true}` | `{dropped:n}`，丢在面前 |
| `bot.probe` | `{bot, x,y,z}` | `world.block` 的内容，加 `{canDig, digTicks, toolSlot, inReach, candidates:[{slot,item,harvest,strength,ticks}]}`：它现在能不能挖这个方块、用哪件工具、要多久 |

`allowedCommands` 默认：`home`、`sethome`、`delhome`、`homes`、`spawn`、`back`、`tell`、`msg`、`w`、`tpa`、`tpaccept`、`team join`。
一项可以是几个词：`team join` 只放行 `team join …`，不放行 `team leave`。`home` 任务也受这个列表约束。
在这台服务器（ServerUtilities）上实测：`sethome 名字` 回 `Home '名字' set!`；`home list` 回 `Alu: 1 / 99: 名字, …`；不存在的 home 回 `Unknown Home: '名字'!`。

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
  "freeSlots":20,
  "task":TaskInfo|null,"queue":[TaskInfo],
  "settings":{"invulnerable":true,"hunger":false}
}
```

离线的 bot 只有 `name uuid online settings task queue`。

**设置**：`invulnerable`（默认开）不受伤害，怪物也不把它当目标；`hunger`（默认关）关着时饱食度不下降。
现在没有进食的能力，打开 `hunger` 它最终会饿死。

**死亡**：和玩家一样。发 `bot.death`，当前任务以 `interrupted` 失败、队列清空；约 1.5 秒后自动重生（发 `bot.spawned`），位置和掉落物按服务器规则。死亡到重生之间 `bot.status` 的 `health` 是 0。

**被踢或被顶号**：变为离线并保持离线（发 `bot.despawned`，`reason` 是踢人理由），需要再次 `bot.spawn`。

**服务器重启**：重启前在线的 bot 在服务器启动约 2 秒后自动上线，没做完的任务从头重新开始。
区域任务因此只是接着做；但 `withdraw` 会再取一份，`haul` 重启时拿在手上的那一趟货会留在 bot 身上不再送达。

### 任务

任务是 bot 在游戏里花时间做的事。每个 bot 同一时刻只执行一个任务，其余排队（最多 32 个）。
任务状态和队列随世界存档保存，服务器重启后自动继续。

| 方法 | 参数 | 结果 |
|---|---|---|
| `task.start` | `{bot, task:{type,…}, mode?:"replace"\|"append"}` | `{task:TaskInfo, replaced:[id]}`。`replace`（默认）取消当前任务和队列后立即开始，`replaced` 是被它取消的任务；`append` 排到队尾 |
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
| `no_tool` | 没有能挖这种方块的工具 | `block`、`x y z` | 找工具或问人 |
| `no_material` | 要放的方块不够 | `missing`，`item` 或 `items` | 去取或问人 |
| `inventory_full` | 背包满且没有指定卸货箱 | | 去存东西再重启任务 |
| `container_full` | 目标箱子放不下 | | 换箱子或问人 |
| `denied` | 被领地保护或其他 mod 拒绝 | `block`、`x y z` | 问人 |
| `invalid` | 参数不合法，或服务器拒绝了指令 | | 修正参数 |
| `interrupted` | bot 下线、死亡，或被带到了别的维度 | | – |
| `internal` | mod 内部出错 | | 报告给人 |

区域类任务（`dig` `place` `clear` `fill` `flatten`）是可重入的：失败后用同样参数再启动，只做还没做完的部分。

任务类型：

| type | 参数 | 行为 |
|---|---|---|
| `goto` | `{x,z, y?, range?=1, dim?}` | 走到离目标水平 range 格以内。给了 `y` 时高度差不超过 2（range 大于 2 时至多 4）；不给则以该处地面为准 |
| `goto_player` | `{player, range?=2}` | 走到某玩家身边；5 分钟追不上以 `stuck` 失败 |
| `follow` | `{player, distance?=3}` | 一直跟着，直到被取消。对方离线、在别的维度或暂时走不到时原地等 |
| `home` | `{name}` | 执行 `/home name` 并等传送完成 |
| `dig` | `{blocks:[{x,y,z}]}`，≤256 | 逐个挖掉，由近到远 |
| `place` | `{blocks:[{x,y,z,item,meta?}], supply?}`，≤256 | 逐个放置，由低到高，材料从背包拿 |
| `clear` | `{x1,y1,z1,x2,y2,z2, dropoff?, overflow?}`，体积 ≤ 32768 | 把盒子里所有方块挖掉，一层一层从上往下 |
| `fill` | `{x1,y1,z1,x2,y2,z2, item, meta?, shape?:"solid"\|"hollow"\|"walls", supply?}` | 在盒子里的空位放方块，由低到高。`hollow` 只放六个面，`walls` 只放四周 |
| `flatten` | `{x1,z1,x2,z2, y, fill?=true, fillItems?:[id], maxFillDepth?=3, dropoff?, supply?, overflow?}`，≤64×64 | 把区域整成地面顶层在 y 的平地：挖掉 y 以上的一切，再把 y 及以下的坑由低到高填上 |
| `deposit` | `{container:{x,y,z}, items?:[ItemFilter], keep?:[id]}` | 走过去把物品放进箱子。不给 items 则放入除工具、食物和 keep 以外的全部 |
| `withdraw` | `{container:{x,y,z}, items:[ItemFilter]}` | 走过去取出物品，数量精确 |
| `haul` | `{from:{x,y,z}, to:{x,y,z}, items?:[ItemFilter]}` | 在两个箱子之间来回搬，直到源箱子里符合条件的搬完或数量够。只搬这一趟取出来的东西，bot 自己的物品不动 |
| `collect` | `{x,y,z, radius?=8}` | 捡起范围内掉在地上的物品 |
| `give` | `{player, items:[ItemFilter]}` | 走到玩家面前，把物品扔给他 |
| `wait` | `{ticks}` | 原地等待 |

规则和边界：

- **挖**：走原版挖掘流程，时间、工具耐久、掉落都照算。自动选背包里最快的工具，但不用一次挖多格的工具（配置 `excludedTools`：匠魂锤、挖掘铲、伐木斧等），它们会波及任务范围之外。
  没有合适工具时，一挖就碎的东西（雪、草）徒手挖，石头之类则以 `no_tool` 失败。
  不动带数据的方块（箱子、机器）、液体、基岩和紧挨岩浆的方块，记入 `result.skipped`。
- **放**：必须有相邻的方块可以依附，够得着，自己不能站在那一格。没处依附的记入 skipped。
- **走路时**只会自己挖开“天然方块”（mod 配置 `naturalBlocks`：泥土、草方块、沙子、沙砾、雪、树叶、花草等；不含石头和木头，因为人也拿它们盖房子）和任务指定要清掉的区域内的方块，不会为了抄近路拆别的东西，也不会挖掉本任务刚放下的方块。
  够不着高处时会用填充方块（配置 `fillerBlocks`：泥土、圆石等）垫脚往上搭；去箱子存取的路上不垫脚，免得把货用掉。
- **树**：够不着的树叶和上面的雪直接跳过（`foliage out of reach`）。
- **`dropoff` / `supply`** 是箱子坐标 `{x,y,z}` 或坐标数组：背包满时自动去 dropoff 卸货（留下工具、食物和一组垫脚方块），`clear` 和 `flatten` 结束时再卸一次；材料不够时自动去 supply 取。
- **`overflow`**：背包满又没给 dropoff 时，`"fail"`（默认）以 `inventory_full` 失败，`"leave"` 继续挖、把掉落物留在地上。
- **`flatten` 的填充材料**按 `fillItems`（默认是配置的 `fillerBlocks`）的顺序，用背包里有的第一种；挖出来的泥土、圆石会被捡回来用上。坑比 `maxFillDepth` 深的列不填，记入 skipped。
- **箱子**：空手右键打开箱子界面，用 shift 点击转移。点击被领地保护之类拒绝时以 `denied` 失败。
  点击没被拒绝却没有界面的储物方块（桶、抽屉）按漏斗的方式存取。
  数量按 bot 背包里实际增减的数目计。

结果 `result`：

- 区域任务：`{removed, placed, skipped?:{原因:数量}, skippedExamples?:[{x,y,z,reason}], freeSlots}`，`flatten` 另有 `level`，`clear` 另有 `clearedDownTo`。
- `give`：`{dropped}`；`deposit`：`{moved, freeSlots}`；`withdraw`：`{moved, missing?:[{id,meta?,count}]}`（箱子里不够的部分）；`haul`：`{moved, trips}`；`collect`：`{pickedUpStacks}`。
- 移动类：`{block:{x,y,z}}`，`home` 另有 `dim`。

## 事件

| event | data | 说明 |
|---|---|---|
| `chat` | `{player, uuid, message, isBot}` | 公共聊天里的每一句，含 bot 自己说的（`isBot:true`）。控制台 `/say` 不算 |
| `whisper` | `{bot, from, message}` | 有人用 `/tell` `/msg` 私聊 bot |
| `bot.message` | `{bot, text}` | 发给 bot 的其他系统消息（指令回显、死亡信息等） |
| `task.update` | `{bot, task:TaskInfo}` | 任务开始、完成、失败、取消时各发一次；进度变化不推送 |
| `bot.spawned` | `{bot}` | 上线，以及死亡后重生 |
| `bot.despawned` | `{bot, reason}` | |
| `bot.hurt` | `{bot, source, amount, health}` | 每个 bot 最多每 2 秒一次 |
| `bot.death` | `{bot, cause}` | |
| `player.join` / `player.leave` | `{player, uuid}` | 真人玩家 |
| `server.stopping` | `{}` | 之后连接会断开 |
