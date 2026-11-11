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
| 测试用不用它 | 不用。`brain/test/` 里的测试用自造的小样本（`fixture-pack.ts`、`fixture-recipes.ts`），真实的这份可以整体替换 |

文件：

| 文件 | 内容 | 由谁生成 |
|---|---|---|
| `meta.json` | 每个子命令一节：来源、生成时间、条数 | 各子命令，各写各的那一节 |
| `quests.jsonl` `questlines.json` | 任务书，见“任务书” | `make-packdata.py quests` |
| `items.jsonl` | 物品表，见“物品” | `tools/export-packdata` |
| `blocks.jsonl` | 方块颜色表，见“方块颜色” | `tools/export-packdata` |
| `textures/atlas.png` `textures/atlas.json` | 方块贴图的图集，见“方块贴图” | `make-packdata.py textures` |
| `recipes.jsonl` `handlers.json` `structures.jsonl` `carving.jsonl` | 配方册、多方块结构、凿子的组，见“配方” | `tools/export-packdata` |

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

- `find_quests` / `get_quest` 和库函数 `list_quest_lines` 的内容全部来自这两个文件，不问服务器。搜索在名称和描述的中文、英文里都找。
- 进度问服务器：`quest.progress {player}` → `{player, completed: [id…], unclaimed: [id…]}`（见 `docs/PROTOCOL.md`），结果缓存 20 秒。
  “做完了 / 现在能做 / 没解锁”由大脑拿 `completed` 和上面的 `pre`、`logic` 算；`unclaimed` 里的显示成“做完了，奖励没领”。
- 这两个文件不在时，三个工具整个退回去问服务器的 `quest.lines` / `quest.search` / `quest.get`（英文，不能翻页）。

## 物品

`items.jsonl`，一行一个物品：`{"id":"mod:name","meta":0,"name":"中文显示名","en":"English name","ores":["plateSteel"]}`（`en`、`ores` 可以没有）。

大脑拿它做两件事（`brain/src/packdata/items.ts`）：

- **找物品**（`find_item`）：查询按空白分成几个词，每个词都要出现在中文名、英文名、`id/meta` 或矿辞名里。名字正好对上的排最前，其次是以它开头的、名字里含它的、只有 id 或矿辞名对上的。结果翻页，写明一共多少个。
- **叫名字**：服务器回来的东西（背包、箱子里的物品、机器、任务结果、任务书里的物品、主人指着的方块）凡是带 `id` 的，给模型看时都换成这里的中文名。物品按 `id` + `meta` 对（不限 meta 时用 meta 0 的名字）；世界里的方块（箱子、抽屉）的 meta 是朝向之类、不是物品的 meta，所以拿服务器给的英文名在同一个 `id` 下对 `en`，同一个 `id` 下英文名重了的不认。带 `variants` 的条目（匠魂工具每种材质一个变体，表里的名字只是其中一种的）在服务器给的名字和它对不上时不用表里的名字，免得把钢镐叫成别的材质的镐。对不上的都保持服务器给的英文名。

文件不在时 `find_item` 改问服务器（只认英文名），所有名字都是服务器的英文名。

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

## 方块贴图

面板的三维预览（草稿和 `view_area` 结果的那个可以拖着转的立体图）用游戏里真的贴图。贴图在 mod 的 jar 里，用下面的命令取出来、拼成一张图集：

```sh
tools/make-packdata.py textures \
  --client /extra_data/gtnh_manager/dist/GTNH-2.9.0-Aru-client.zip \
  --jar client/libraries/com/mojang/minecraft/1.7.10/minecraft-1.7.10-client.jar \
  --out brain/packdata
```

- `--client`：客户端包。里面所有的 `*.jar`（mod 的 jar 是套在 zip 里的）都会翻一遍，不解压到磁盘。
- `--jar`：另外再翻的 jar，可以给多个。原版的方块贴图在原版客户端 jar 里，客户端包里没有它，所以要单独给。
- `--blocks`：方块颜色表在哪，默认是 `--out` 目录下的 `blocks.jsonl`。所以要先有 `blocks.jsonl`（并且带 `tex` 字段）。
- `--tile`：图集里一张贴图的边长，16（默认）或 32。

取哪些贴图：`blocks.jsonl` 里 `tex` / `texTop` 点到的全部，加上原版的全部方块贴图（`assets/minecraft/textures/blocks/` 下面那一层；大脑给颜色表里没有的常见原版方块——草方块、水、树叶、玻璃——配贴图时要用）。
贴图名 `chisel:marble/raw` 对应 jar 里的 `assets/chisel/textures/blocks/marble/raw.png`；没有冒号的（`stone`）在 `assets/minecraft/` 下。同一个文件好几个 jar 里都有时，客户端包里的 mod 先于 `--jar` 给的（mod 换掉原版贴图时用 mod 的，和游戏里一样），mod 之间按 jar 的文件名排。

每张贴图变成图集里的一格：

- 动画贴图（一长条，高是宽的好几倍）只取最上面那一帧。
- 比一格大的（32×32、64×64……）缩小：边长是整数倍时取平均（按不透明度加权，透明的像素不把旁边的颜色带暗），不是整数倍时取最近的像素。
- 透明度原样留着。PNG 的各种存法（调色板、灰度、16 位、隔行）都读。

生成两个文件：

- `textures/atlas.png`：8 位 RGBA。每行 64 格，第 n 格（从 0 数）在第 `n % 64` 列、第 `n / 64` 行。真实的整合包是 5487 格、1024×1376 像素、不到 2 MB，生成用 4 秒左右。
- `textures/atlas.json`：

```jsonc
{
  "format": 1,
  "generatedAt": "2026-11-10T19:58:42Z",
  "tile": 16, "columns": 64, "rows": 86,
  "tiles": { "stone": 0, "dirt": 1, "chisel:marble/raw": 57 },   // 贴图名（和 blocks.jsonl 里写的一样）→ 第几格
  "missing": ["nowhere:block"]                                     // blocks.jsonl 点到了、jar 里找不到或者读不了的
}
```

`meta.json` 的 `textures` 一节：`{format, source, generatedAt, tile, tiles, missing}`，后两个是张数。

大脑启动时只读 `atlas.json`（建“贴图名 → 第几格”的表），`atlas.png` 不解码，原样交给面板（`GET /api/textures/atlas.png`）。
没有这两个文件、或者读不了时，三维预览按方块颜色画，别的不受影响。大脑自己画给模型看的简图现在只用颜色，不用贴图。

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

### 大脑怎么用

读法在 `brain/src/packdata/recipes.ts`，工具在 `brain/src/tools/recipe-book.ts`。

**加载。** `recipes.jsonl` 启动时从头到尾读一遍，只在内存里留索引，配方本身用到时才按位置从文件里读那一行：

- 每条配方：它在文件里的偏移和长度、属于哪一页。
- 两张倒排表：哪些配方产出某个 `id/meta`；哪些配方用到某个 `id/meta`、某个 `id` 的任何 meta、某个矿辞名（`any` 列出来的每一种也算）。
- `fake:true` 的不进倒排表，哪里都查不到。读不出来的行跳过，启动日志里说有几行。

真实的整合包（29.6 万条、约 100 MB）：读一遍 0.9 秒，索引占 JS 堆 30 MB 左右；读文件时进程的常驻内存会冲高两百多兆，之后 V8 不一定还给系统。查一个物品的做法是几毫秒；“钢板能做什么”这种四千条的，分组不读配方本身，要按内容筛时才逐条读（四千条 20 毫秒）。

**编号。** 一条配方的编号（工具结果里的 `#数字`）就是它在 `recipes.jsonl` 里的行号，从 0 数。文件重新导出以后编号会变，所以只在当次运行里用。

**查做法**（`find_recipes`，NEI 的 R）。先按配方页汇总，一页是一种“方式”：

- 每种方式有几条、每条耗什么料出什么；一次出好几个的，算出每个成品耗多少。电压等级（按 `eut`）、时长、炉温（高炉的 `special`）、流体、编程电路（`n:0` 的 `gregtech:gt.integrated_circuit`，meta 是电路号）、模具模头（别的 `n:0` 的原料）都写明。一模一样的配方（导出里常有重复）合并。
- 标出基地里现在做得了的方式：拿身体的 `world.machines`（附近 64 格、最近的 60 台）比对——机器的 `id`+`meta` 在这一页的 `machines` 里，或者它的 `recipeKey` 等于这一页的 `key`。再看这台机器行不行：单方块看有没有电、是不是被关了、等级够不够；多方块看 `formed`、能源仓给的电压，高炉再看 `heat` 够不够配方的 `special`。合成台类的页看摆不摆得进随身的 2×2，要 3×3 的看附近 48 格内有没有工作台或匠魂合成站。
- 排序：现在做得了的在前（其中机器先于手工）；手工工具配方（原料里有 `craftingTool…`）在这个物品另有机器做法时排在后面并注明“有机器就别用”；然后是有机器但现在不行的（写明差在哪）、附近没有的、它操作不了的（既不是合成台类、也不是 `read` 为 `gregtech` 的页）。
- 一种方式下配方多（工具每种材质一条）时汇总里只举两条，写明还有多少；给 `way`（页名或页的 `key`）、`contains`（原料的中英文名、id、矿辞名里的一段）、`page` 看具体的，一页 10 条，写明一共多少条、这是第几页。

**查用途**（库函数 `find_uses`，NEI 的 U：不在发给模型的工具清单里，程序里调，见 `docs/SCRIPTS.md` 的“库函数”）同样按页汇总、可筛可翻页。

**同一种东西两个 id。** GregTech 把登记在同一个“材料件”矿辞名下的物品当成一种（`ingotDarkSteel` 下有 EnderIO 的和 GregTech 的两个玄钢锭；机器配方点名的、高炉产出的常常是 EnderIO 那个）。只对 `ingot`、`plate`、`dust`、`gem`、`stick`、`bolt`、`screw`、`ring`、`gear`、`foil`、`rotor`、`spring`、`round`、`wireFine`、`lens`、`nugget`、`block` 这些前缀的矿辞名这样办（`UNIFIED_ORE`）：查其中一个的做法时把做另一个的配方也算上并说明；机器配方里点名的那格标 `(or any 矿辞名)`；`process_items` 身上是哪种就放哪种。手工合成里点名某个 id 的格子不这样办。

**做法规划**（`brain/src/tools/planner.ts`）曾经拿这本配方册替模型把整棵树走完、挑好每一步；它已经不是给模型的工具了（原因见 `brain/README.md` 的“做一样东西”），代码留着。现在模型自己一层层查，要算总原料时用库函数 `total_materials`（只做乘法，路线由模型给）。

**认机器。** 配方页的 `machines`（做这类配方的机器，作为物品的 id + meta）除了和 `world.machines` 里的 GregTech 机器比对，还用来认身体读不懂状态的机器：`world.containers` 里方块 id 对得上的容器（同一个 id 下有好几种机器时再按英文名对）就是一台别的 mod 的机器或熔炉，可以照玩家的办法用。见 `brain/README.md` 的“机器：身体读得懂的，和照配方册认的”。

**交给身体。**

- `craft_item` 把配方变成协议里 `craft` 任务的 `grid` 写法：有序合成每格放在它的 `g`，无序合成从头往后摆；矿辞名的格子原样写成 `{ore}` 交给身体认；`gives` 是配方的第一个产物，`rounds` 按要的个数除以每轮出的个数向上取整。
- `process_items` 把配方变成 `process` 任务的参数：消耗的原料乘上轮数，`n:0` 的模具模头各 1 个，编程电路不当物品放、写成 `circuit`，不带概率的产物写成 `expect`。配方要的流体不替它准备：要么机器已经接好，要么模型用 `fluids` 给装满的单元。

没有 `recipes.jsonl` 时这几个工具退回去问服务器的 `recipe.find`（英文、每种机器只给前几条），`find_uses` 用不了。

### structures.jsonl：多方块机器怎么搭

一行是一台多方块机器在某个等级下的结构，也就是 NEI 里那个结构预览（玩家说的“投影”）。同一台机器等级不同、结构也不同时有多行；几个等级结构一样的并成一行。

```jsonc
{
  "id":"gregtech:gt.blockmachines","meta":31080,"name":"大型蒸汽离心机",   // 主机这件物品
  "tiers":[2], "maxTier":2,           // 这一行是哪几个等级的结构；等级就是全息投影仪叠几个
  "size":[5,5,5],                     // x、y、z 各几格
  "controller":[2,1,4], "facing":"south",   // 主机在这个盒子里的位置（从 0 数），和它正面朝哪
  "blocks":[ {"id":"…","meta":…,"name":"脱氧钢机械方块","n":69}, {"id":"…","meta":…,"name":"钢齿轮箱机械方块","n":8}, … ],   // 材料清单
  "palette":[{"id":"minecraft:air","meta":0}, {"id":"…","meta":…,"name":"脱氧钢机械方块"}, …],
  "runs":[0,3, 1,5, …],               // 和身体 world.blocks 同一种写法：下标 = (y*sz + z)*sx + x
  "info":[ "机器类型: 离心机", "并行：8", … ],                        // 主机的说明文字（只在这台机器的第一行带）
  "structureInfo":[ "大小: 5x5x5 (LxWxH)", "控制器: 第二层，正面中央", "1+ 蒸汽输入总线: 任意机械方块", … ]   // 按住 Shift 看到的结构说明
}
```

- 结构是照预览的样子搭出来的：总线、仓这些“可以换成别的方块”的位置，预览里放的是机械方块（个别是默认的仓）。哪些位置能放什么仓，看 `structureInfo` 的文字。
- `palette` 里机器零件的 `meta` 是它作为物品时的 meta（各种仓、主机都是同一个方块，靠这个区分）。
- 有的机器除了等级还有别的可调项（线圈、玻璃等级），这里只导了默认的那一档；高炉这类“等级就是线圈”的，每种线圈一行。
- 这份数据是让游戏在一个临时世界里把结构真的搭一遍再读出来的（和 NEI 预览同一段代码），不是抄的说明文字。

**大脑怎么用。** 启动时整个读进来（334 台机器、1426 行，四五十毫秒，多占 30 MB 左右；文件不在就当没有）。它不是模型的工具，是模型写的程序里的数据：`data.structure(名字或 id, meta)`，加上三个库函数（`find_structure`、`check_structure`、`read_blocks`：不在发给模型的工具清单里，程序里调），见 `docs/SCRIPTS.md` 的“库函数”；面板“图纸”页最下面可以按名字搜一台机器，看它每一级的材料和三维预览。对着世界里的机器比的时候要知道：主机、各种仓和总线在世界里是同一个方块（`gregtech:gt.blockmachines`），`world.blocks` 给的 meta 分不出是哪一种，所以“预览是机器零件、世界里也是机器零件”就算对。

### carving.jsonl：凿子能把什么变成什么

一行是 Chisel（凿子）的一个“组”：组里的任何一种方块都能用凿子变成同组的另一种，不耗别的材料。配方页里没有这些（凿子不是配方），而图纸要的常常是某个具体花纹。

```jsonc
{ "group":"cobblestone",           // 组名
  "ore":"cobblestone",             // 有的组还认矿辞：这个矿辞名下的东西也能凿成这一组
  "variants":[ {"id":"minecraft:cobblestone","meta":0,"name":"圆石"}, {"id":"chisel:cobblestone","meta":14,"name":"圆石"}, … ] }
```

- 怎么凿：拿着凿子右键打开它的界面，把方块放进去，点想要的那个花纹，整组一起变（它用通用的界面动作就能做，见 `screens` 手册）。
- 只有一种方块的组不导。

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
