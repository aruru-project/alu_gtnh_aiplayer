# 本地资料（packdata）

静态的资料放在大脑本地，实时的东西才问服务器。

整合包里不随游戏进行变化的内容——任务书的名称、描述、前置、要求、奖励，物品的名字，配方——客户端整合包里是全的，而且有中文；
服务器上只有英文，查一次还要走一趟 bridge。所以这些内容从客户端包导出成文件，大脑启动时读进内存；
服务器只回答会变的事（谁完成了哪些任务、箱子里有什么）。

## 总述

| | |
|---|---|
| 放在哪 | `brain/packdata/`（生成物，不进 git）。换地方：环境变量 `AIPLAYER_PACKDATA`，或 `config.json` 的 `packdataDir`；相对路径相对 `brain/` |
| 怎么来 | `tools/make-packdata.py <子命令> …`（Python 3 标准库）。客户端包只读，不解压到磁盘 |
| 大脑什么时候读 | 启动时读一次。重新生成之后要重启大脑 |
| 缺了会怎样 | 目录或某个文件不在、读不了时，那一部分当没有，用它的工具退回去问服务器；启动日志里 `[packdata]` 开头的行逐项说明读到了什么、没读到什么 |

文件：

| 文件 | 内容 | 由谁生成 |
|---|---|---|
| `meta.json` | 每个子命令一节：来源、生成时间、条数 | 各子命令，各写各的那一节 |
| `quests.jsonl` `questlines.json` | 任务书，见“任务书” | `make-packdata.py quests` |
| `items.jsonl` | 物品表，见“物品” | `tools/export-packdata` |
| `blocks.jsonl` | 方块颜色表，见“方块颜色” | `tools/export-packdata` |
| `recipes.jsonl` `handlers.json` | 配方册，见“配方” | `tools/export-packdata` |

`meta.json` 是一个对象，键是子命令的名字。子命令重新生成时只替换自己那一节，别的键原样保留：

```jsonc
{
  "quests": {
    "format": 1,                              // quests.jsonl / questlines.json 的格式版本；大脑只读它认识的版本
    "source": "GTNH-2.9.0-Aru-client.zip",    // 来源包的文件名
    "generatedAt": "2026-11-10T17:13:14Z",
    "lang": "zh_CN",
    "quests": 3814,                           // 任务数
    "lines": 46,                              // 章节数
    "translated": 3813                        // 语言文件里有名字的任务数
  }
}
```

各文件都是 UTF-8、`\n` 换行。生成时先写临时文件再改名，所以不会读到写了一半的文件。

## 任务书

```sh
tools/make-packdata.py quests --client /extra_data/gtnh_manager/dist/GTNH-2.9.0-Aru-client.zip --out brain/packdata
```

来源（都在客户端包里，游戏目录下）：

- `config/betterquesting/DefaultQuests/Quests/**.json`：一个文件一个任务。
- `config/betterquesting/DefaultQuests/QuestLines/<章节>/`：`QuestLine.json` 是章节本身，其余文件各是章节里的一个任务和它在画布上的位置；`QuestLinesOrder.txt` 是章节的顺序。
- `config/txloader/forceload/betterquesting/lang/zh_CN.lang`：中文的名称和描述（`--lang` 可以换别的语言）。

### 任务 id

和服务器用的是同一种（`mod/.../world/Quests.java` 的 `shortId`），`quest.progress` 返回的 id 可以直接拿来对：

- UUID 以 `00000000-0000-0000-0000-` 开头的老任务：取后面那段十六进制数，去掉前导零（全是零就是 `0`）。例：`47`、`1bc`。
- 其余：完整的小写 UUID。例：`7b32816f-fd94-4cb5-abef-55c9d3707bc1`。

章节的 id 是同一套写法。

### quests.jsonl

一行一个任务，按书里的顺序（一章接一章，每个任务排在它第一次出现的那一章里；不在任何章节里的排最后）。

```jsonc
{
  "id": "47",
  "name": "基础制作：马达",             // 中文名；语言文件里没有的任务是任务文件里的英文
  "en": "Basic Crafting: Motors",       // 英文原名；和 name 一样时没有这一项
  "desc": "电动马达是能够将电力转化为……",  // 中文描述，纯文本，段落之间是 \n\n；没翻译的是英文
  "descEn": "Motors are little devices…", // 英文描述；和 desc 一样时没有这一项
  "lines": ["2"],                       // 所在章节的 id，按书里章节的顺序；空数组 = 不在任何章节里（玩家在书里看不到的内部任务）
  "main": true,                         // 主线任务
  "pre": ["43", "45"],                  // 前置任务的 id
  "logic": "AND",                       // 前置之间的关系，见下
  "taskLogic": "AND",                   // 子任务之间的关系：AND 全部做完，OR 做完任意一个
  "tasks": [ … ],
  "rewards": [ … ]
}
```

只在有意义时才出现的项：

| 项 | 含义 |
|---|---|
| `visibility` | 不是 `NORMAL` 时才有：`CHAIN`、`UNLOCKED`、`SECRET`（解锁前书里不显示）、`HIDDEN`（书里永不显示） |
| `repeat` | 可以重复做：做完多少 tick 之后能再做（20 tick 一秒；`0` 是马上能再做） |
| `autoClaim` | `true`：奖励自动发，不用点领取 |

`lines` 是为了查看方便带上的，谁在哪一章以 `questlines.json` 为准（大脑只认后者）。

`logic` 的取值和判法（`done` 是前置里已完成的个数，`total` 是前置的个数；和 BetterQuesting 的 `EnumLogic.getResult` 一致）：

| `logic` | 解锁条件 |
|---|---|
| `AND` | `done >= total` |
| `OR` | `done > 0` |
| `XOR` | `done == 1` |
| `NAND` | `done < total` |
| `NOR` | `done == 0` |
| `XNOR` | `done == total - 1` |

没有前置的任务总是解锁的。`pre` 里可能有不存在的任务（这个整合包里有 3 处）：它算进 `total`，但永远不算完成。

**子任务**（`tasks` 的一项）。`type` 是 BetterQuesting 的任务类型去掉前缀 `bq_standard:`：

| `type` | 带的项 |
|---|---|
| `retrieval`、`optional_retrieval`（可做可不做，不影响任务完成） | `items`；`consume`（交任务时是否收走）；`anyOne: true`（`items` 里有任意一样就够）；`ignoreNBT: true`（比对时不看 NBT） |
| `crafting`（要玩家自己做出来才算） | `items`；`allow`：怎么做出来的才算，`craft` / `smelt` / `anvil` 的子集；`ignoreNBT` |
| `checkbox`（在书里打勾） | 无 |
| `hunt`（猎杀） | `target`：生物的注册名；`count` |
| `meeting`（走到生物旁边） | `target`、`count`、`range`（多少格以内） |
| `location`（到某个地方） | `location: {name?, dim?}`，到了那个维度就算；要求离某个点多近时另有 `x y z range`；可能还有 `biome`、`structure`、`invert: true`（反过来：不能在那里） |
| `fluid`（交流体） | `fluids: [{fluid, mb}]`，`fluid` 是流体的注册名；`consume` |

没见过的类型照样导出：`type` 加上能认出来的那些项。

**奖励**（`rewards` 的一项）：

| `type` | 带的项 |
|---|---|
| `item`（都给） | `items` |
| `choice`（挑一样） | `items` |
| `questcompletion`（顺带把另一个任务标成完成） | `quest`：那个任务的 id |
| `xp` | `amount`；`levels`：`true` 是等级，`false` 是经验点 |

**物品**（`items` 的一项）：

```jsonc
{"id": "gregtech:gt.metaitem.01", "meta": 32600, "count": 2}
{"id": "minecraft:log", "count": 4, "ore": "logWood"}       // 没有 meta = 任何变体都行；ore = 登记在这个矿辞名下的都行
{"id": "Forestry:beePrincessGE", "meta": 0, "count": 1, "nbt": {"Genome": {"Chromosomes": [{"UID0": "forestry.speciesForest"}]}}}
```

`nbt` 是物品自带的 NBT（去掉了类型后缀，列表还原成数组），只在有内容时才有。这里没有物品的名字：名字由大脑从 `items.jsonl` 配。

### questlines.json

```jsonc
{
  "lines": [                              // 按书里章节的顺序
    {
      "id": "2",
      "name": "第0.5阶 - 蒸汽时代",
      "en": "Tier 0.5 - Steam",           // 和 name 一样时没有
      "desc": "…",
      "descEn": "…",                      // 和 desc 一样时没有
      "quests": ["342", "2c", "4b5", "2e"] // 这一章里的任务：前置在前（按前置链的深度），同一深度的按画布上从上到下、从左到右
    }
  ]
}
```

一个任务可以在几章里（这个整合包里有 194 个）；有 68 个不在任何章节里，是内部用的触发任务和模板，玩家在书里看不到。

### 文字是怎么整理的

名称和描述都整理成纯文本：

- 语言文件里的 `%n` 是换行，`%%` 是百分号（它们在游戏里要过一遍 `String.format`）；任务文件里的英文原文不用转。
- 颜色和样式码（`§` 加一个字符，以及 `&#RRGGBB` 这种渐变色）去掉。
- 任务书自己的标记 `[note]` `[warn]` `[quest]` `[bold]` `[url]` 去掉，里面的字留着；`[img …]…[/img]` 整个去掉；
  `[questlink]<任务的 base64 id>[/questlink]` 换成 `“任务名”（任务 <id>）`。别的方括号是正文，不动。
- 行尾空白去掉，连续三个以上的换行并成一个空行。

### 大脑怎么用

- `list_quest_lines` / `find_quests` / `get_quest` 的内容全部来自这两个文件，不问服务器。搜索在名称和描述的中文、英文里都找。
- 进度问服务器：`quest.progress {player}` → `{player, completed: [id…], unclaimed: [id…]}`（见 `docs/PROTOCOL.md`），结果缓存 20 秒。
  “做完了 / 现在能做 / 没解锁”由大脑拿 `completed` 和上面的 `pre`、`logic` 算；`unclaimed` 里的显示成“做完了，奖励没领”。
- 这两个文件不在时，三个工具整个退回去问服务器的 `quest.lines` / `quest.search` / `quest.get`（英文，不能翻页）。

## 物品

`items.jsonl`，一行一个物品：`{"id":"mod:name","meta":0,"name":"中文显示名","en":"English name","ores":["plateSteel"]}`（`en`、`ores` 可以没有）。

大脑现在只用它给任务书里的物品配中文名（按 `id` + `meta`；任务不限 meta 时用 meta 0 的名字）。文件不在时任务书里的物品只显示 id 和 meta。

完整的字段：

| 字段 | 含义 |
|---|---|
| `id`、`meta` | 物品的注册名和 meta。`meta` 为 32767 表示“任何 meta 都行”（只出现在配方里引用到的条目上） |
| `name` | 游戏设成中文时显示的名字，去掉了颜色代码 |
| `en` | 游戏设成英文时显示的名字；和 `name` 一样时不写 |
| `ores` | 这个物品登记在哪些矿物辞典名下，如 `plateSteel`、`craftingToolHardHammer` |
| `variants` | 同一个 `id`+`meta` 下还有几种只靠附加数据（NBT）区分、名字不同的变体，如不同材质的 GregTech 工具 |

来源是 NEI 物品面板里的全部物品，加上配方里出现过的物品。怎么导出见“配方”一节末尾。

## 方块颜色

`blocks.jsonl`，一行一种方块和它贴图的平均色：`{"id":"minecraft:wool","meta":14,"name":"红色羊毛","color":[151,52,49]}`。

- `id` 是方块的注册名，`meta` 是放在世界里的 meta（0–15，不写当 0；超出这个范围的行会被跳过——那是物品的 meta，图纸里放不下）。
- `color` 是 `[红, 绿, 蓝]`，0–255。`name` 可以没有。

用在两处：模型写的程序里的 `palette()` / `nearestBlock()`（做像素画时把颜色换成方块，见 `docs/SCRIPTS.md`），和简图的着色（`brain/src/render/`：`view_area`、`view_draft` 的图，面板“图纸”页和对话日志里的图都是它画的）。
简图里侧面用 `color`、顶面用 `top`。表里没有的方块这样上色（`brain/src/render/looks.ts`）：草方块、水、树叶、玻璃、火把、楼梯、半砖这些常见的原版方块用渲染器内置的颜色和形状；别的模组的树叶、玻璃、水按注册名猜一类（图例里带 `~`）；其余的由注册名和 meta 算一个固定的颜色，只为了区分（图例里带 `?`）。同一个注册名、表里没有的 meta 不借用别的 meta 的颜色。
文件不在时用内置的小表（`brain/src/packdata/blocks.ts`）：16 色羊毛和 16 色染色粘土，颜色是原版 1.7.10 贴图逐像素的平均值。
这张表里应该只放“放下去就是一整块、哪面看都是这个颜色”的方块：`nearestBlock()` 会从整张表里挑。

导出来的表还带这些字段（内置小表没有）：

| 字段 | 含义 |
|---|---|
| `en` | 英文名，和 `name` 一样时不写 |
| `top` | 顶面的颜色，和侧面不同时才有（`color` 是侧面） |
| `tex`、`texTop` | 侧面、顶面的贴图名，形如 `minecraft:wool_colored_red`，对应客户端资源里的 `assets/<冒号前，没有冒号则 minecraft>/textures/blocks/<冒号后>.png`。`texTop` 和 `tex` 相同时不写 |
| `falls` | 会像沙子一样掉落 |
| `light` | 发光强度（1–15），不发光时不写 |

导出时只收“不透明的整块、不带机器或箱子那样的内部数据、物品 meta 和放下去的 meta 相同、游戏不给它另外上色”的方块；草、树叶这类贴图是灰的、靠游戏染色的不收。

## 配方

配方册是 NEI 里能翻到的全部内容：每个“配方页”（一种加工方式，NEI 里的一个标签页）和它下面的每条配方。
游戏里的配方不是文件，是每个 mod 启动时登记到内存里的；每个 mod 又各自带着把它那类配方排给 NEI 看的代码，这些代码只在客户端里有。所以配方册是从一个真的客户端里导出来的，每个整合包版本导一次。

### handlers.json

一个数组，每项是一个配方页：

```jsonc
{
  "key": "gt.recipe.metalbender",   // 配方页的编号，recipes.jsonl 用它指回来。GregTech 的页是配方类别名，别的页一般是类名；重名时后面加 #2、#3
  "name": "卷板机",                  // NEI 里这个标签页的名字（中文）
  "mod": "GregTech",                // 哪个 mod 的，NEI 知道才有
  "class": "gregtech.nei.GTNEIDefaultHandler",
  "machines": [                     // 能做这类配方的机器（NEI 标签页下面那排图标），多方块机器也在里面
    {"id":"gregtech:gt.blockmachines","meta":221}, …
  ],
  "grid": true,                     // 这是合成台类的页（有序或无序合成）
  "recipes": 3784,                  // recipes.jsonl 里属于这一页的条数
  "read": "gregtech",               // 怎么读出来的：gregtech（直接读配方本身）、all（这一页一次给出全部）、per item（挨个物品问出来的；后面跟着 cut short 表示没问完）
  "ms": 120
}
```

`machines` 里的 `id`+`meta` 和身体 `world.machines` 返回的每台机器的 `id`+`meta` 是同一对，可以直接比对“基地里哪台机器能做这条配方”。
`recipes` 为 0 的页是说明页，或者是整合包删光了配方的机器。

### recipes.jsonl

一行一条配方：

```jsonc
{
  "h": "gt.recipe.metalbender",                       // handlers.json 里的 key
  "in":  [ {"id":"gregtech:gt.metaitem.01","meta":11305,"n":1},       // 原料，一格一项
           {"id":"gregtech:gt.integrated_circuit","meta":1,"n":0} ],  // n 为 0：要放进去但不消耗（编程电路、模具、模头）
  "out": [ {"id":"gregtech:gt.metaitem.01","meta":17305,"n":1} ],     // 产物
  "fin":  [ {"f":"oxygen","name":"氧气","mb":1000} ],                  // 流体原料：注册名、中文名、毫桶
  "fout": [ … ],                                                       // 流体产物
  "eut": 24, "ticks": 56,           // 每刻耗电和时长（20 刻 = 1 秒）。电压等级：eut ≤8 ULV，≤32 LV，≤128 MV，≤512 HV，≤2048 EV …
  "special": 1800,                  // 配方页自己的附加数值，含义随页而定（高炉是炉温）；0 不写
  "fake": true                      // 只是给人看的示意，机器里做不出来；一般应忽略
}
```

`eut`、`ticks`、`special`、`fake`、`fin`、`fout` 只有 GregTech 的页（`read` 为 `gregtech`）才有。别的页是照 NEI 画面读的，另有：

- `other`：画面上既不算原料也不算产物的格子（副产物、燃料、催化剂之类，含义随页而定）。
- 流体：这些页把流体画成物品（桶、单元或“流体显示”物品），所以出现在 `in`/`out` 里，没有 `fin`/`fout`。

原料的一格有三种写法：

| 写法 | 含义 |
|---|---|
| `{"id","meta","n"}` | 就是这一种物品。带 `name` 时表示这一格的物品带附加数据，显示名和物品表里的不同 |
| `{"ore":"plateSteel","n":1,"any":[[id,meta],…],"more":k}` | 矿物辞典名下的任何一种都行。`any` 列出前 12 种，`more` 是没列出的个数。`craftingTool…` 开头的是工具，合成时不消耗，只掉耐久 |
| `{"n":1,"any":[[id,meta],…],"more":k}` | 这几种都行，但不对应某一个矿物辞典名 |

合成台类的页（`grid:true`）里，有序合成的每一格还带 `g`：它在 3×3 格子里的位置，0–8，从左上起一行一行数。无序合成没有 `g`，随便摆。
产物带 `chance`（0–1）时表示有这个概率才出。

同一个物品常有很多条配方：不同的加工方式耗料不同（手工用锤子 2 锭出 1 板，卷板机 1 锭出 1 板），工具类的每种材质各有一条（一把锤子几百条）。用的时候按配方页分组、算清每个成品耗多少料再比较，不要只看前几条。

### 怎么导出

```bash
tools/client setup            # 头一回：把客户端包解到 client/，从官方源取游戏的库和资源，约 1.1G
tools/gradle build            # 导出代码在 mod 里（alu.aiplayer.export，只在客户端里加载）
tools/export-packdata         # 约 10 分钟；结果写进 brain/packdata/
```

- 需要一个能让客户端进去的服务器（默认测试服 `127.0.0.1:10186`，`--join` 改），客户端用离线名字 `Exporter` 进，这个名字要在白名单里。
- 客户端要一个桌面来开窗口（默认 `DISPLAY=:10`，本机的 RDP 桌面），用显卡渲染。它不走启动器，也不登录账号。
- 游戏会启动两次：第一次中文，导出全部；第二次英文，只导名字（有些 mod 的名字在启动时就定死了，所以要两次），然后按 `id`+`meta` 并进 `items.jsonl` 和 `blocks.jsonl` 的 `en`。
- `client/` 里是我们自己的一份客户端，为了能在这台机器上启动拿掉了两个 mod（Opis、CraftPresence，在 `client/disabled-mods/`），它们不带配方。
- `meta.json` 的 `nei` 一节记着这次导出的条数：`{format, generatedAt, lang, pack, items, recipes, pages, seconds, english, blocks}`。
