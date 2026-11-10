# 身体 ↔ 大脑 通信协议（bridge，版本 1）

身体是服务端 mod（`mod/`），大脑是后台服务（`brain/`）。两者只通过本协议交互。
协议只增不改：新增方法、字段、事件不升版本号；删除或改变含义才升。
双方都必须忽略不认识的字段和事件。

## 传输

- TCP，mod 监听，默认 `127.0.0.1:25590`（mod 配置 `config/aiplayer/aiplayer.json`）。
- 每条消息是一行 UTF-8 JSON，以 `\n` 结束。单行上限 4 MiB。
- 允许多个客户端同时连接（大脑、调试脚本）。事件广播给所有已认证客户端。
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

- `serverEpoch`：服务器每次启动随机生成。`seq` 在一个 epoch 内单调递增。
- 客户端带上上次见过的 `serverEpoch` + `lastSeq`，且 epoch 一致时，mod 会在响应之后补发缓冲区里 `seq > lastSeq` 的事件（缓冲最近 1000 条）。epoch 不一致说明服务器重启过，客户端应把 lastSeq 归零并重新拉取状态。

## 通用数据

- 方块坐标是整数 `x y z`，维度是整数 `dim`（主世界 0）。省略 `dim` 时用该 bot 所在维度。
- 实体位置 `pos` 是小数；`block` 是脚所在格子的整数坐标。
- 方块：`{"id":"minecraft:stone","meta":0}`。物品：`{"id":"minecraft:dirt","meta":0,"count":64,"name":"Dirt"}`。
  `name` 是服务器语言下的显示名，只给人和模型看，不用于匹配。
- 物品筛选 `ItemFilter`：`{"id":"minecraft:dirt"}`（任意 meta）或带 `"meta":0`，可带 `"count":N`。

## 方法

### 服务器与世界（只读）

| 方法 | 参数 | 结果 |
|---|---|---|
| `server.info` | – | `{tick, tps, worldTime, dayTime, isDay, raining, difficulty, players:[{name,uuid,dim,pos,isBot}], bots:[name]}` |
| `world.block` | `{dim?,x,y,z}` | `{id,meta,name,air,solid,liquid,replaceable,hardness,tileEntity,inventory}` |
| `world.scan` | `{dim?,x1,z1,x2,z2}`，最多 64×64 列 | 见下 |
| `world.find` | `{dim?,x,y,z,radius(≤48),blocks:[id…],limit?(≤64)}` | `{matches:[{x,y,z,id,meta,dist}]}`，由近到远 |
| `world.containers` | `{dim?,x,y,z,radius(≤32)}` | `{containers:[{x,y,z,id,name,slots,usedSlots,items:[Item…]}]}`，items 已按物品合并 |
| `world.entities` | `{dim?,x,y,z,radius(≤64)}` | `{entities:[{type:"player"\|"mob"\|"animal"\|"item"\|"other",name,pos,dist,item?}]}` |

`world.scan` 结果：

```jsonc
{
  "x1":100,"z1":200,"x2":115,"z2":215,      // 已规范化为 x1≤x2, z1≤z2
  "heights":[[64,64,65,…],…],               // heights[z-z1][x-x1] = 该列最高的非空气、非植物方块的 y；没有则 -1
  "tops":[[0,0,1,…],…],                     // 同形状，值是 palette 下标
  "palette":["minecraft:grass","minecraft:water",…],
  "stats":{"minY":63,"maxY":71,"modeY":64,"meanY":64.8,"columns":256,"unloaded":0},
  "liquidColumns":12,                       // 顶部是液体的列数
  "tileEntities":[{"x":104,"y":65,"z":207,"id":"minecraft:chest"}]   // 区域内全高度的带数据方块，最多 64 个
}
```

### bot 生命周期

| 方法 | 参数 | 结果 |
|---|---|---|
| `bot.list` | – | `{bots:[{name,online,dim?,block?,task?}]}`，含已创建但离线的 |
| `bot.spawn` | `{name, dim?,x?,y?,z?, skin?:{value,signature}}` | `BotStatus`。不给坐标时用上次下线的位置，从没上过线则在出生点 |
| `bot.despawn` | `{bot}` | `{}`。背包和位置存入玩家存档 |
| `bot.status` | `{bot}` | `BotStatus` |
| `bot.configure` | `{bot, settings:{invulnerable?,hunger?,…}}` | `{settings}` |
| `bot.chat` | `{bot, message}` | `{}`。以该玩家身份在公共聊天说话，超长自动分行 |
| `bot.command` | `{bot, command}` | `{output:[string]}`。以该玩家身份执行指令（不带 `/`），返回随后 10 刻内发给它的消息。指令必须在 mod 配置的允许列表里，否则 `denied` |
| `bot.look` | `{bot, x,y,z}` | `{}` |
| `bot.drop` | `{bot, items:[ItemFilter]\|all:true}` | `{dropped:n}`，丢在脚下 |

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

### 任务

任务是 bot 在游戏里花时间做的事。每个 bot 同一时刻只执行一个任务，其余排队。
任务状态和队列随世界存档保存，服务器重启后自动继续。

| 方法 | 参数 | 结果 |
|---|---|---|
| `task.start` | `{bot, task:{type,…}, mode?:"replace"\|"append"}` | `{task:TaskInfo}`。`replace`（默认）取消当前任务和队列后立即开始；`append` 排到队尾 |
| `task.cancel` | `{bot, id?}` | `{canceled:n}`。不给 id 则取消当前任务和整个队列 |
| `task.list` | `{bot}` | `{active:TaskInfo\|null, queue:[TaskInfo], recent:[TaskInfo]}`，recent 是最近结束的 10 个 |

`TaskInfo`：

```jsonc
{
  "id":"t42","type":"flatten","params":{…},
  "state":"queued|running|done|failed|canceled",
  "progress":{"done":120,"total":400,"phase":"clearing","note":"…"},
  "createdAt":…, "startedAt":…, "finishedAt":…,          // epoch ms
  "result":{…},                                           // done 时；failed/canceled 时是已完成的部分
  "error":{"code":"no_tool","message":"…","detail":{…}}   // failed 时
}
```

任务失败码：

| code | 含义 | 大脑通常怎么办 |
|---|---|---|
| `unreachable` | 走不到目标 | 换目标或问人 |
| `no_tool` | 没有能挖这种方块的工具，`detail.block` 说明是什么 | 找工具或问人 |
| `no_material` | 要放的方块不够，`detail.item`、`detail.missing` | 去取或问人 |
| `inventory_full` | 背包满且没有指定卸货箱 | 去存东西再重启任务 |
| `container_full` | 目标箱子放不下 | 换箱子或问人 |
| `denied` | 被领地保护或其他 mod 拒绝 | 问人 |
| `stuck` | 多次尝试后仍无进展 | 看状态后重试或问人 |
| `invalid` | 参数不合法或超出上限 | 修正参数 |
| `interrupted` | bot 下线或死亡 | – |

区域类任务（`clear` `fill` `flatten`）是可重入的：失败后用同样参数再启动，只做还没做完的部分。

任务类型：

| type | 参数 | 行为 |
|---|---|---|
| `goto` | `{x,y,z, range?=1, dim?}` | 走到离目标 range 格以内 |
| `goto_player` | `{player, range?=2}` | 走到某玩家身边 |
| `follow` | `{player, distance?=3}` | 一直跟着，直到被取消 |
| `home` | `{name}` | 执行 `/home name` 并等传送完成 |
| `dig` | `{blocks:[{x,y,z}]}`，≤256 | 逐个挖掉 |
| `place` | `{blocks:[{x,y,z,item,meta?}]}`，≤256 | 逐个放置，材料从背包拿 |
| `clear` | `{x1,y1,z1,x2,y2,z2, dropoff?}`，体积 ≤ 32768 | 把盒子里所有方块挖掉（从上往下）。不动带数据的方块（箱子、机器）和液体源，记入 `result.skipped` |
| `fill` | `{x1,y1,z1,x2,y2,z2, item, meta?, shape?:"solid"\|"hollow"\|"walls", supply?}` | 在盒子里的空位放方块。`hollow` 只放六个面，`walls` 只放四周 |
| `flatten` | `{x1,z1,x2,z2, y, fill?=true, fillItems?:[id], maxFillDepth?=3, dropoff?, supply?}`，≤64×64 | 把区域整成地面顶层在 y 的平地：挖掉 y 以上的一切；`fill` 为真时把 y 及以下的坑填上（最深 maxFillDepth 层，更深的记入 skipped） |
| `deposit` | `{container:{x,y,z}, items?:[ItemFilter], keep?:[id]}` | 走过去把物品放进箱子。不给 items 则放入除工具、食物和 keep 以外的全部 |
| `withdraw` | `{container:{x,y,z}, items:[ItemFilter]}` | 走过去取出物品 |
| `haul` | `{from:{x,y,z}, to:{x,y,z}, items?:[ItemFilter]}` | 在两个箱子之间来回搬，直到源箱子里符合条件的搬完或数量够 |
| `collect` | `{x,y,z, radius?=8}` | 捡起范围内掉在地上的物品 |
| `wait` | `{ticks}` | 原地等待 |

`dropoff` / `supply` 是箱子坐标 `{x,y,z}` 或坐标数组：背包快满时自动去 dropoff 卸货，材料不够时自动去 supply 取。

## 事件

| event | data | 说明 |
|---|---|---|
| `chat` | `{player, uuid, message, isBot}` | 公共聊天里的每一句，含 bot 自己说的（`isBot:true`） |
| `whisper` | `{bot, from, message}` | 有人用 `/tell` `/msg` 私聊 bot |
| `bot.message` | `{bot, text}` | 发给 bot 的其他系统消息（指令回显等） |
| `task.update` | `{bot, task:TaskInfo}` | 任务开始、完成、失败、取消时各发一次；进度变化不推送 |
| `bot.spawned` | `{bot}` | |
| `bot.despawned` | `{bot, reason}` | |
| `bot.hurt` | `{bot, source, amount, health}` | 最多每 2 秒一次 |
| `bot.death` | `{bot, cause}` | |
| `player.join` / `player.leave` | `{player, uuid}` | 真人玩家 |
| `server.stopping` | `{}` | 之后连接会断开 |
