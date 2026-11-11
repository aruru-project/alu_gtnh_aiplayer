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
| `guide.jsonl` | 游戏内指南（玩家按 G 打开的那本）的每一页，见“游戏内指南” | `make-packdata.py guide` |
| `items.jsonl` | 物品表，见“物品” | `tools/export-packdata` |
| `blocks.jsonl` | 方块颜色表，见“方块颜色” | `tools/export-packdata` |
| `textures/atlas.png` `textures/atlas.json` | 方块贴图的图集，见“方块贴图” | `make-packdata.py textures` |
| `icons/icons.json` `icons/icons-000.png` … | 每个物品在物品栏里的样子，见“物品图标” | `tools/export-packdata` |
| `tooltips.jsonl` | 每个物品的悬停提示文字（名字下面的那几行，以及按住 Shift 时的那一版），见“物品的提示文字” | `tools/export-packdata` |
| `recipes.jsonl` `handlers.json` `structures.jsonl` `carving.jsonl` | 配方册、多方块结构、凿子的组，见“配方” | `tools/export-packdata` |

`meta.json` 是一个对象，键是子命令的名字。子命令重新生成时只替换自己那一节，别的键原样保留：

```jsonc
{
  "quests": {
    "format": 1,                              // quests.jsonl / questlines.json 的格式版本；大脑只读它认识的版本
    "source": "GTNH-2.9.0-client.zip",    // 来源包的文件名
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
tools/make-packdata.py quests --client <客户端整合包>.zip --out brain/packdata
```

`<客户端整合包>.zip` 是 GTNH 的客户端整合包 zip（启动器导出的那种）；下面几条命令里的也是它。

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

## 游戏内指南

整合包带着一本游戏里看的指南（GuideNH：把物品栏里的东西按住 G，或从按键打开）。它是人写的说明：一台机器是干什么的、怎么搭、
接什么仓、电怎么算、出了毛病查什么；另有 AE2、神秘时代几本和各版本的更新说明。配方册和多方块结构是从游戏里导出来的事实，
这本是玩家写给玩家的解释，两样互相补。

```sh
tools/make-packdata.py guide --client <客户端整合包>.zip --out brain/packdata
```

不用开游戏，一秒以内。来源是客户端包里的 `config/guidenh/*.zip`（2.9.0 里是 `DefaultGuide.zip`，即 GTNH-Guide-Pack 0.1.26）；
`--pack 某个.zip` 可以直接指定指南包，给几次读几个，后面的页盖掉前面同名的页。
指南包是一个资源包：`assets/<书>/guidenh/_<语言>/<页>.md`，每页是 Markdown，最前面有几行 YAML（标题、在目录里的位置、讲的是哪些物品）。

2.9.0 的这一份：689 页、209 万字符，7 本书。

| 书（`book`） | 中文页 | 英文页 | 内容 |
|---|---|---|---|
| `gregtech` | 32 | 83 | 机器、多方块、电力、超频和并行。**两种语言的页不是一一对应的**：中文是另外写的一套（路径也不同，如 `multiblocks/hv/vacuum_freezer.md`），英文有 60 多页没有中文 |
| `appliedenergistics2` | 116 | 116 | AE2 的机制和每样东西 |
| `changelog` | 159 | 159 | 各版本改了什么 |
| `thaumcraft` | 9 | 9 | 神秘时代 |
| `bloodmagic` `botania` `forestry` | 各 1 | 各 1 | 只有一页开头 |

### guide.jsonl

一行一页，按书、语言、路径排序。**正文是原样的**：页里的标签（`<ItemLink id="…"/>`、`<RecipesFor …/>`、`<GameScene>…` 等）不动，
怎么读给模型是大脑的事。

```jsonc
{
  "book": "gregtech",
  "lang": "zh_cn",                                   // 这一页的语言；同一路径可能两种语言各有一行
  "path": "multiblocks/hv/vacuum_freezer.md",        // 在这本书里的路径
  "title": "真空冷冻机",                              // 目录里的名字；页里没写时取正文第一个一级标题
  "parent": "multiblocks/multiblocks_index.md",      // 目录里的上一级（同一本书、同一种语言的 path）；没有就是顶层
  "position": 10,                                    // 在同级里的次序
  "icon": {"id": "gregtech:gt.blockmachines", "meta": 1002},
  "items": [{"id": "gregtech:gt.blockmachines", "meta": 1002}],   // 这一页讲的是哪些物品（游戏里对着它按 G 就翻到这页）
  "quests": ["EL2z-VAzS9eVmQFpNnwimg=="],            // 页里挂的任务（任务书的 base64 id）
  "categories": ["network infrastructure"],
  "author": "Skorched", "date": "2026-05-27",
  "text": "# 真空冷冻机\n\n<GameScene …"            // 去掉开头那几行 YAML 之后的全文
}
```

- `items` 里一项是 `{id, meta}`、`{id}`（没写损害值，或写的是 `*`）或 `{id, metas: [516, 517, [520, 536]]}`（页里写的是一串损害值或范围）。
- `parent` 页里写的是从书的顶上数的路径，以 `.` 开头时从这一页自己的文件夹数；这里统一成书里的路径。指不到任何一页的原样留着，并带 `parentUnknown: true`（这一份里没有）。
- `position` 页里写成 `010` 的按十进制读成 10（游戏按八进制读成 8，这一份里有两页这样），只影响同级里的先后。
- 没有带进来的：图（70 张）、场景里摆的结构（113 个 `.snbt`）、演示动画（12 个 `.json`）、一张表（`.tsv`）。数目记在 `meta.json` 的 `guide.notTaken`。

指南的内容是 CC BY-NC-SA 4.0（GTNewHorizons/GTNH-Guide-Pack）。`brain/packdata/` 不进 git，这份只在本机用。

### 大脑怎么用

启动时读进来（`brain/src/packdata/guide.ts`；689 行十几毫秒，全部读成字再五十毫秒，日志里一行“游戏内指南：7 本书、382 页……”）。文件不在就当没有：`read_guide` 照实说这份资料没导出，别的工具不提指南，提示词里也没有那一节。

**页怎么算。** 一本书里同一个路径两种语言都有的算一页，给中文的，并说明英文也有（`english: true` 拿英文版）；只有一种语言的照常算一页，只有英文的在目录里标 `[en]`。2.9.0 这一份合起来是 382 页，其中 63 页只有英文（都在 `gregtech`）。同级里的先后：有中文的在前，各自按页里写的 `position`，再按路径。一页写成 `book:path`（`gregtech:multiblocks/hv/vacuum_freezer.md`），目录、搜索结果、页间链接、别的工具带的那一行用的都是这个写法，能直接拿去读。

**标签读成字。** 给模型的（和面板接口给的）是同一份读成字以后的正文，不是原文：

| 原文里 | 读成 |
|---|---|
| `<ItemLink id="mod:name:meta"/>`、`<ItemImage …/>` | `中文名 [mod:name/meta]`；物品表里没有的只有 `[mod:name/meta]`；带了自己的字的是“那几个字 (中文名 [id/meta])”。图标紧挨着同一件物品的链接只说一次。NEI 的流体展示物品说成 `流体名 [fluid 注册名]` |
| `<RecipesFor …/>`、`<RecipeFor …/>`、`<Recipe …/>`、`<RecipesUsage …/>` | 一句 `[the recipes for 名字 [id/meta] are shown here in the game]`（`RecipeFor`、`Recipe` 是 `a recipe for …`，`RecipesUsage` 是 `the recipes that use …`），标签上写的配方页、输入、输出、条数照写在括号里 |
| `<GameScene>` | 一句 `[3D scene shown here in the game: …]`，冒号后面是场景里摆的东西：`<ImportStructureLib controller=… tier=…/>` 是“哪台机器的结构、第几级”，`<ImportStructure src/>` 是“一个搭好的例子（文件名）”，`<ImportPonder src/>` 是“一段演示（文件名）”，`<Block …/>`、`<RemoveBlocks …/>` 是摆了、去掉了哪种方块。下面一行一条批注：`BoxAnnotation`、`DiamondAnnotation`、`LineAnnotation`、`BlockAnnotation`、`TextAnnotation` 各写明指着哪里（原样的坐标）和它的字；没有字的（只画了一条线、一个框）不留。`<IsometricCamera/>` 只管视角，不留 |
| `![标题](x.png)`、`<FloatingImage src title>`、`<BlockImage id meta>` | 一句 `[image shown here in the game: 标题 (文件名)]` / `[picture of the block … shown here in the game]`；`<ImageAnnotation>` 里的字接在后面 |
| `<Color>`、`<Row>`、`<Column>`、`<ContentTabs title>`、`<Tab title>`、`<Tooltip label>` | 只留里面的字（去掉为排进标签而整体缩进的那几格）；页签留标题，`Tooltip` 是“标签 (提示)” |
| `<Latex formula/>` | `$公式$`，里面另写的字接在后面 |
| `<FunctionGraph>`、`<LineChart>` 和里面的 `<Function expr label domain/>`、`<Plot/>`、`<Series name data/>` | 一句 `[graph shown here in the game: 标题; x: …; y: …]`，下面一行一条曲线或一组数：名字、式子或数据、定义域 |
| `<KeyBind id/>` | `[key binding id]` |
| `<QuestLink id/>` | `“任务名” [quest 任务 id]`（id 从 base64 换成任务书里的写法；任务书里没有的只有 id） |
| `<PlayerName/>` | 中文页是“玩家”，英文页是 `player` |
| `<SubPages/>`、`<Category name/>` | 它指的那些页，一页一行：`- 标题 (book:path)` |
| 页间链接 `](../x.md)`、`](./a/b.md#节)`、`](/a.md)`、`](x.md)` | `](book:path#节)`；网址不动 |
| 代码（行内的和三个反引号围起来的） | 原样，里面的尖括号不当标签 |
| 别的（`<br>`、`<u>`、`<kbd>`、`<a>`、`<details>`、`<summary>`、`<sup>` 这些 HTML，和以后新出的标签） | 原样留着 |

2.9.0 这一份读成字以后，剩下没读成字的只有那几样 HTML：`br` 581 处、`u` 162、`kbd` 68、`a` 15、`details` 4、`summary` 4、`sup` 2。物品引用四千多处里只有 13 处物品表里查不到名字；页间链接全部指得到；最长的一页（`gregtech:multiblocks/bose_einstein_condensate_line.md`，只有英文）读成字是 38,959 字符，超过 6,000 字符的有 39 页；七本书的目录加起来一万八千字符。

**模型的工具 `read_guide`**（两条线都有，只看；程序里也能调）：

- 不带参数：有哪几本书、各多少页、顶上有哪几章。
- `book`（可带 `under`：一页的路径）：这本书（那一页下面）的目录，一页一行、缩进是上下级。放不下时把深的那几层收起来，写明下面还有几页、怎么看。
- `query`（可带 `book`、`page`）：按词找，每个词都要在标题、读成字以后的正文、或者这一页讲的物品的名字（中英文）里。标题对上的在前，其次是讲的物品对上的，再是正文里出现得多的；每页带对上的那一处前后的一小段。一页十条。
- `id`（可带 `meta`）：页自己写明讲这件物品的那些页，中文的在前。
- `path`（`book:path`，可以接 `#小节`；可带 `offset`、`english`）：读一页。开头几行是这一页的事实：什么语言、谁在什么时候写的、讲的是哪些物品、上一级和下面的页、讲同一件物品的别的页。正文超过单个结果上限时给到放得下为止（尽量断在段落末尾），写明给了第几到第几个字符、一共多少、接着读的 `offset`，并列出各小节各从第几个字符起（那个数可以直接当 `offset`）。程序里 `r.data.text` 是全文，`r.data.sections` 是小节。

**别的工具里的一行。** `find_item`、`inspect_block`、`find_machines`、`find_structure` 说到一件指南里有页讲它的物品时，带一行 `in the guide: "页名" — read_guide {path: "book:path"}`；讲它的不止一页时写第一页并说还有几页、怎么列出来。`find_machines` 同一种机器只在头一台下面说一次。世界里的机器靠身体给的英文名到物品表里认出是哪件物品（它在世界里的 meta 不是物品的 meta）；认不出的不猜。

**提示词。** 读到了指南时，两条线的系统提示词里各有同一节（`agent/prompt.ts` 的 `guideSection`）：包里带着这本指南、多少页、`read_guide` 读到的和主人看到的是同一份；它是人写的说明，2026 年 5 月前后照 2.9 写的，配方和多方块结构以从这个客户端导出来的资料为准。

**面板。** 只读接口 `GET /api/guide`、`/api/guide/search`、`/api/guide/page`（见 `docs/BRAIN_SPEC.md`），读出来的也是读成字以后的正文；页面还没做。

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

## 物品图标

`icons/`：`items.jsonl` 里每一个物品在物品栏格子里的样子，是游戏自己画出来的（方块是立体的那个角度，按材料染色的物品是染好的颜色）。
给面板画“和游戏里一样的物品栏”用。

- `icons-000.png`、`icons-001.png` ……：图集。每张 2048×2048、8 位 RGBA，64 列 × 64 行，一格 32×32 像素（游戏界面里一格 16 像素的 2 倍）。
  背景是真的透明；玻璃、冰这类半透明的东西是半透明的（普通透明度，颜色没有预先乘过透明度）。最后一张没用到的格子全透明。
- `icons.json`：

```jsonc
{
  "format": 1,
  "generatedAt": "2026-11-11T16:33:55+08:00",
  "cell": 32, "columns": 64, "rows": 64,        // 一格的边长；每张图几列几行
  "count": 63678,                               // 图标的个数 = items.jsonl 的行数
  "itemsSha1": "87dc659f…",                     // 这些图标是照哪一份 items.jsonl 画的，见下
  "files": ["icons-000.png", "icons-001.png", …],
  "missing": [726, 727, 941, …],                // 画出来是空的那些行号，升序；它们的格子全透明
  "failed": 1,                                  // missing 里有几个是画的时候出错的
  "errors": [[57528, "java.lang.NullPointerException: …"]],   // 出错的行号和原因，最多 200 条；没有出错的就没有这一项
  "cutShort": 61440,                            // 只在超时没画完时才有：从这一行起都没画（它们也在 missing 里）
  "seconds": 11.2                               // 画这些图标用了多久
}
```

### 怎么找到一个物品的那一格

**图标的编号就是物品在 `items.jsonl` 里的行号，从 0 数**（第一行是 0）。没有别的索引：读 `items.jsonl` 时记下每个 `id/meta` 在第几行就行。

行号 `n` 的图标：

- 在第 `n / 4096`（取整）张图里，即 `files[⌊n / (columns×rows)⌋]`；
- 张内第 `i = n % 4096` 格，左上角的像素是 `x = (i % 64) × 32`，`y = ⌊i / 64⌋ × 32`。

例：`minecraft:chest/0` 在第 93 行 → `icons-000.png` 的 (928, 32)；`gregtech:gt.metaitem.01/11305`（钢锭）在第 32241 行 → `icons-007.png`（32241 = 7×4096 + 3569）的 (1568, 1760)。
行号只对这一份 `items.jsonl` 有效：每次整套导出，物品表的行数和顺序都会差一点（配方里随机举例的那些物品不一样），图标是跟着同一次导出一起画的。

手里的东西按 `id` + `meta` 找不到行的时候：

- 有耐久的工具和护甲，`meta` 是磨损掉的耐久，表里只有 `meta` 0 的那一行，用它；
- 再没有就看有没有 `meta` 32767（“任何 meta 都行”）的那一行；它画的是 `meta` 0 的样子；
- 还没有，或者行号在 `missing` 里，就没有图标，显示文字。

`itemsSha1` 用来确认图标和物品表是同一份：把 `items.jsonl` 每一行的 `<id>/<meta>` 加一个换行符依次接起来（UTF-8），取 SHA-1。
`tools/export-packdata` 把图标放进 packdata 之前核对它，对不上就不放，并且把 packdata 里旧的 `icons/` 删掉（图标是按行号找的，配错了物品表就全是错的图）。
读的一方至少要核对 `count` 等于 `items.jsonl` 的行数。

### 画的是什么

- 画的是物品栏里一格的样子，走的是游戏画物品栏时的同一个调用，所以各个 mod 自己的画法（GregTech 的机器和按材料染色的零件、箱子、匠魂工具、带光晕的物品）都在。
  不画数量、耐久条、电量条；附魔的闪光不画。会动的东西（流体、闪烁的矿石、GregTech 里会抖会转的高阶零件）是导出那一刻的那一帧，所以两次导出有两千来个图标不完全一样。
- 一行只有一个图标，可同一个 `id` + `meta` 下的东西不一定只有一种样子。画的是 NEI 物品列表里这个 `id` + `meta` 的第一种（它的名字就是 `items.jsonl` 里的 `name`）；
  NEI 不列出的（只在配方里出现过的）画的是不带附加数据（NBT）的那一种。所以：
  - 带 `variants` 的行（这个整合包里 340 行：神秘时代 178，几乎都是法杖；原版 43，是配方里带着附魔或名字出现过的工具和护甲、玩家头颅之类；匠魂 26；其余零散）图标只是其中一种。
    匠魂的镐画的是“精金镐”（白的），背包里那把是别的材质时颜色就对不上；
  - 配方里代表流体的那个物品（`NotEnoughItems:neiFluidDisplay`，1475 行）画的是流体的贴图铺满一格，没有数量。
- 界面里超出一格的东西（Avaritia 那类物品的光晕）在格子边上被裁掉，不会画到旁边的格子里。

### 哪些没有图标

这个整合包六万三千多行里有 21 行是空的（`missing`）：

| 原因 | 行数 | 例子 |
|---|---|---|
| 本来就看不见的方块（空气一类、光源、传送门），和只是“某样东西放下去以后”的占位方块 | 12 | `Botania:fakeAir`、`Thaumcraft:blockHole`、`ThaumicHorizons:light`、`AWWayofTime:bloodLight`、`WitchingGadgets:WG_CustomAir`、`TConstruct:HeldItemBlock` |
| 样子全靠 NBT 或当时的状态，不带就什么也画不出来 | 7 | `StevesCarts:ModularCart`、`ArchitectureCraft:cladding`、`littletiles:BlockLittleTiles`、`malisisdoors:item.custom_door`、`EnderIO:blockConduitFacade`、`WR-CBE\|Addons:triangulator` |
| 图标就是空的 | 1 | `dreamcraft:Nothing`（“你什么都没得到”） |
| 画的时候 mod 自己出错 | 1 | `Genetics:serumArray/16`（空的血清阵列，Binnie 的代码里空指针） |

另外有 16 行画出来是紫黑格子（游戏里“贴图丢了”的样子，游戏里看也是这样，所以不算在 `missing` 里）：`chisel:moss_carpet` 的 5 个、`EMT:EMTItems` 的 4 个弃用图纸、其余零散。

一个物品画的时候出错只是它那一格留空，别的照画。整个画图有 10 分钟的时间上限（实际十来秒），到点就停，没画的记进 `missing`，并写上 `cutShort`。

### 透明度是怎么来的

游戏画物品时面对的是不透明的界面，它在透明度通道里留下的数没有意义（平面物品会先把那一块的透明度清零，半透明的会被乘两遍）。
所以每个物品画两遍，一遍在黑底上、一遍在白底上：两遍一样的像素是不透明的，白底还是白、黑底还是黑的像素是空的，介于中间的按差值算出透明度，再还原出颜色。
附魔闪光是往画面上“加”一张贴图，导出时把这张贴图临时换成全黑的，加上去等于没加。

## 物品的提示文字

`tooltips.jsonl`：玩家在物品栏里把鼠标放到一个物品上看到的字——名字下面的那几行，以及按住 Shift 时换成的那一版。
单方块机器的电压和容量、覆盖板是干什么的、电池、单元、工具的数值、多方块主机的说明和结构，游戏里都只写在这里。

一行一个**有提示的**物品，顺序和 `items.jsonl` 一样（没有提示的物品没有行），按 `id` + `meta` 对：

```jsonc
{"id":"gregtech:gt.blockmachines","meta":221,"tip":["嘘,他是坏的!我们要本德! ! !","机器类型: 卷板机","电压输入：32 (LV)","容量：2,048 EU"]}
{"id":"gregtech:gt.blockmachines","meta":31080,
 "tip":["长按 [G] 打开指南","机器类型: 离心机","并行：8","速度：125%","蒸汽消耗：62.5%","高压等级处理速度与蒸汽消耗翻倍"],
 "shift":["长按 [G] 打开指南","大小: 5x5x5 (LxWxH)","结构:","   控制器: 第二层，正面中央","   1 蒸汽仓: 任意机械方块", …]}
{"id":"Thaumcraft:WandCap","meta":0,"tip":["按住CTRL以显示神秘时代法杖信息"],"ctrl":["魔力减免：-10%","合成魔力消耗倍数：0x","无法保留节点！"]}
{"id":"IC2:itemCellEmpty","meta":1,"tip":[],"shift":["容器大小：1,000 L = 6 * 144 L + 136 L","冷却剂"," 2.3 度每桶"]}
```

| 字段 | 含义 |
|---|---|
| `tip` | 什么键都不按时名字下面的行，从上到下。可以是空的（不按键时什么都没有，按住键才有） |
| `shift` | 按住 Shift 时的行。它是**换掉** `tip`，不是接在后面。只在和 `tip` 的行不一样时才有（同样的行换了个顺序不算） |
| `ctrl` | 按住 Ctrl 时的行，同样是换掉 `tip`。只有 194 个物品有，见“按键” |

行是原样的：颜色和样式去掉了，行尾的空白去掉了，行首的空格留着（缩进有意思），顺序没动，没有替谁筛过。
`""` 是提示里的一段空白，`"---"` 是一条横线。

`meta.json` 的 `tooltips` 一节：

```jsonc
{
  "format": 1,
  "generatedAt": "2026-11-11T20:09:23+08:00",
  "lang": "zh_CN",
  "itemsSha1": "87dc659f…",   // 是照哪一份 items.jsonl 取的，和 icons.json 里的是同一个算法
  "items": 54732,              // 有提示的物品数（= tooltips.jsonl 的行数）
  "shift": 3404, "ctrl": 194,  // 其中另有 Shift 版、Ctrl 版的
  "lines": 127770,             // 一共多少行字
  "errors": 6,                 // 取的时候物品自己的代码出错的个数，见“哪些没取到”
  "seconds": 38.5
}
```

`itemsSha1` 和读进来的物品表对不上时，说明这份提示不是照这份物品表取的：逐个物品看仍然是对的（它是按 `id` + `meta` 认的），只是可能缺几个、多几个；大脑照用，启动日志里说一声对不上。
这个整合包：63,678 个物品里 54,732 个有提示，文件 6.0 MB；一半以上只有一行，九成不超过 5 行；最长的是多方块主机（`tip` 38 行，`shift` 44 行）。

### 取的是什么

提示不是存在哪里的一段字，是显示的那一刻各个 mod 一起拼出来的：物品自己的代码，听 Forge 提示事件（`ItemTooltipEvent`）的 mod，NEI 的提示处理器（这个包里有 17 个，电量那一行就是其中一个加的）。
这个整合包里最后由 ChromaticTooltips 把它们排成一块块，自己再加几块（燃烧时间、耐久、食物的饥饿值和饱和度、矿辞名、流体的温度和状态、所属 mod），并决定按住哪个键显示哪几块。
导出就是让游戏在“物品栏开着、鼠标停在一格上、那一格里是这个物品”的状态下把提示照常做出来，再把字读出来。物品栏是真的打开的；“那一格里是什么”“鼠标在哪”“按着什么键”是在游戏读它们的地方换掉的，不发任何东西给服务器。

- 取的是**正文**。名字、名字下面那行 `[shift] [ctrl]` 的按键提示、最下面的 mod 名（每个物品都有，从 `id` 就看得出）不取。
- 攻击伤害、耐久、燃烧时间、饥饿值、饱和度在游戏里不按键时是一排小图标加数字。导出写成它们各自的那一行字（按住 Shift 时游戏自己显示的就是这些字，NEI 按提示搜索用的也是它们），放在 `tip` 的最前面，和图标在游戏里的位置一样。
- 提示里画出来的东西没有字，不取：神秘时代的要素（按住 Shift 时画在旁边的图标，而且要玩家扫描过才有）、Botania 的魔力条之类。
- 一行一个物品取的是哪一种，和图标一样：NEI 物品列表里这个 `id` + `meta` 的第一种，NEI 不列的取不带 NBT 的。“任何 meta 都行”的行取 meta 0 的。
- 整合包没有 ChromaticTooltips 时退回去取游戏和 NEI 排出来的那个列表（去掉名字那一行），这条路在这个包上没用到。

### 按键

| 键 | 这个整合包里按住它看到什么 | 导出 |
|---|---|---|
| Shift | 物品自己的“详细”一版（多方块的结构、蜜蜂的基因、匠魂工具的数值、EnderIO 机器的说明），加上流体容器的容量；数值从图标变成字 | `shift`，3,404 个物品 |
| Ctrl | 正文整个换成这个物品的矿辞名（33,327 个物品，`items.jsonl` 的 `ores` 已经有了）。只有没有矿辞名的物品，按住 Ctrl 才轮得到 mod 自己的字：法杖部件的容量和合成消耗（神秘时代一系，写着“按住CTRL以显示神秘时代法杖信息”的那些）、匠魂工具的各个部件、龙之研究装备的上限、冒险背包的按键说明 | `ctrl`，194 个物品 |
| Alt | 没有用到。它是 NEI 自己面板上的“显示快捷键”，物品栏里的物品按住它和不按一样 | 不导 |

`tip` 里留着一些“按住某键”的字（“<按住 Shift 查看更多信息>”“按住 Shift 查看数据”之类，二十来种、两百多个物品）：那是没被 ChromaticTooltips 认出来换成按键提示的，原样留着。

### 和谁在看、和这一个物品有关的行

导出用的是一个新号、一份没改过按键的客户端，物品是刚拿出来的那一个。下面这些行说的是它们，不是这种物品：

| 行 | 物品数 | 说的是什么 |
|---|---|---|
| “食物恢复的饥饿值递减开始在” “食用任何食物超过 10次 之后” | 1,871（所有食物） | Spice of Life 对一个还没吃过东西的玩家的说明；吃过以后这里是这种食物吃了几次 |
| 带 `NONE` 的（“按 'NONE' 穿着时”“按住[NONE]显示所需材料。”） | 162 | 这个客户端上没绑定的按键显示成 NONE |
| “0 /10 k EU” “充能: 0 / 10M RF” “0 / 1,024 字节已使用” | 四百多 | 这一个物品的电量、存了多少：新拿出来的都是空的 |
| “没有绑定” “未链接” “绑定维度: 0” | 约 70 | 这一个物品还没绑定或链接 |
| “工具等级: 01-备受摧残” “工具经验: 0 / …” | 32 | 这一把匠魂工具的等级和经验 |
| “长按 [G] 打开指南” | 911 | 这个物品在游戏内指南里有页（见“游戏内指南”）；是给人看的操作提示 |

没有“没研究过所以看不到”的文字行：神秘时代那类要研究、要扫描的内容是画出来的图标，本来就不在文字里。

另有二十来个物品的提示每次都不一样（随机挑一句俏皮话的、随机数值的、列表顺序不固定的），两次导出这些行会不同。
还有两种一看就是坏的行是游戏里本来就这样，不是导出弄坏的：“添加者：%s - [GT++]”（118 个物品）、“Format error: …%1$s”（4 个）。

### 哪些没取到

- 物品自己的代码出错的 6 个：`Genetics:sequence` 的 5 个 meta 和 `Genetics:serum/16`（Binnie 的遗传学物品，不带 NBT 时空指针）。游戏遇到这种情况是把出错之前拼好的那几行照常显示，导出也一样；它们记在导出目录的 `tooltips.json` 的 `errors` 里，个数在 `meta.json` 的 `errors`。
- 一个物品出错只影响它自己。整个取提示有 20 分钟的上限（实际不到 40 秒），到点就停，这一次就没有 `tooltips.jsonl`。
- 一批几百个物品是在游戏的同一刻里取的，而有的 mod 把东西记到下一刻（GuideNH 就是这样找“鼠标下这个物品在指南里有没有页”的，不处理的话一批物品全都得到第一个的答案）。已知的这一处导出里处理了；为了发现新的，每次导出最后会挑 300 个物品照玩家的节奏（一个物品、过一刻、再下一个）重取一遍，和前面取的比。不一样的个数在导出目录 `tooltips.json` 的 `checked` 里（现在是 0），不是 0 时 `tools/export-packdata` 会说。

### 怎么核对

`tools/tooltip-check/shots.py`：让游戏把物品栏真的画出来——鼠标下依次是三十来个有代表性的物品，不按键、按 Shift、按 Ctrl——把画面存下来，和 `tooltips.jsonl` 里的字左右并排拼成对照图（`client/tooltip-check/sheet-NN.png`），人看。
它还会在客户端的桌面上真的按住 Shift 键把 Shift 那几张再拍一遍，和“在游戏里换掉按键状态”拍的逐像素比，确认两种按法看到的一样。
`tools/tooltip-check/stats.py`：文件多大、最长多少行、出现最多的行、上面那张表里的数。

### 大脑怎么用

启动时读进来（`brain/src/packdata/tooltips.ts`，一百多毫秒；日志里一行“物品的提示文字：53854 个物品有……”）。文件不在就当没有：`find_item` 不带提示，按提示里的字找（`tip`）时照实说这份资料没导出。
它按 `id` + `meta` 认，所以和 `items.jsonl` 不是同一次导出的也照用：`meta.json` 的 `tooltips.itemsSha1` 和现在这份物品表对不上时，只在日志里说一声（可能有物品缺提示）。

**只是界面提示的行不读进来**（整行正好是它的才去掉；去掉以后开头、结尾多出来的空行也收掉）。它们不是这件物品的信息：

| 行 | 为什么不给 |
|---|---|
| `长按 [G] 打开指南` | 说的是“这件物品在游戏内指南里有页”，是给人看的按键提示；`find_item` 自己会带一行“指南里有这一页”（页名和怎么读） |
| `食物恢复的饥饿值递减开始在`、`食用任何食物超过 10次 之后` | Spice of Life 对导出用的那个还没吃过东西的新号说的，所有食物都是这两行；吃过以后这里是这种食物吃了几次 |
| `Alt/Ctrl+Scroll to`、`Cycle Between Blocks` | Ztones 的“按住 Alt/Ctrl 滚轮换样式”的按键提示 |

别的都原样给，包括 `---`（一条横线）、行首的空格（缩进）、和那些说“这一个物品”的行（电量、存量、绑定，见上面“和谁在看、和这一个物品有关的行”）。去掉以后三个画面都空了的物品算没有提示；`shift` / `ctrl` 去掉以后和 `tip` 一样的就不算另一版。
2.9.0 这一份：文件里 54,732 个物品，去掉这几行以后 53,854 个有提示（另有 Shift 版的 3,404 个、Ctrl 版的 194 个）。

**模型怎么看到**（`find_item`，两条线都有）：

- **找到的物品不超过 5 个时，每个下面带着它的提示**，三个画面分开、各标明是哪个，行原样（竖线后面的就是那一行，行首的空格留着）：

  ```
  - 大型蒸汽离心机 [gregtech:gt.blockmachines/31080]: 1 recipe(s) make it; used in none; in the guide: "大型蒸汽离心机" — read_guide {path: "…"}
      tooltip:
        | 机器类型: 离心机
        | 并行：8
      tooltip while Shift is held (it replaces the lines above):
        | 大小: 5x5x5 (LxWxH)
        | 结构:
        |    控制器: 第二层，正面中央
  ```

  只有一个物品时提示全给；有两到五个时每个画面最多 12 行（99% 的物品不超过这么多），多的写明还有几行、怎么看全。带了提示的结果末尾有一句事实：这些字是一个新号对着一个刚拿出来的样品看到的，电量、存量、绑定、工具等级这类行是样品的，不是它手里那个的。
- **超过 5 个时不逐个带**，结尾一句：物品少的时候才带、怎么看某一个的（`find_item {query: "<id/meta>"}`：`query` 正好是一个物品的 `id/meta` 时就是那一个物品）。“指南里有这一页”那一行也是同一条线：不超过 5 个时每个带，超过时结尾说其中几个在指南里有页、怎么看。
- **按提示里的字找物品**：`find_item {tip: "覆盖板"}`，每个词都要在这件物品的提示里（三个画面合起来算）。它和按名字找（`query`）是分开的两件事：名字搜不看提示，提示搜不看名字；两个都给就是都要对上。结果多的时候每条写着对上的那一行（在按住键的那一版里的写明是哪一版）。
- 程序里 `r.data.items[n].tooltip` 是 `{ tip, shift?, ctrl? }`，不管这一页有几个物品都是全的。

真实那份上的长度：单查一个有提示的物品，整条结果（名字、配方数、指南、提示）中位 150 字符，九成不超过 207，99% 不超过 380；最长的是多方块主机，两千七百字符左右（`tip` 38 行、`shift` 43 行）。

多方块主机的 `shift` 版和 `structures.jsonl` 的 `structureInfo` 是同一段字，所以 `find_structure` 那边没有再加提示。

**面板**：只读接口 `GET /api/items/tooltips?q=<逗号隔开的 id/meta>`（见 `docs/BRAIN_SPEC.md`），给的也是去掉了那几行以后的；页面还没做。

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
  --client <客户端整合包>.zip \
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
  "fake": true                      // GregTech 给这条标了 mFakeRecipe：它是给 NEI 显示用的，机器自己另有一套找配方的办法。不是“做不出来”，见下
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
- `fake:true` 的照常进倒排表、照常查得到、照常算进“几条配方 / 几种做法”（`find_recipes`、`find_uses`、`find_item` 的计数、`total_materials` 走树、`process_items` 照编号开机器）。`fake` 是照抄的 GregTech 的 `mFakeRecipe`，意思是“这条是给 NEI 显示用的，机器不是照普通办法逐条对的”——板材切割机（`gt.recipe.fakecuttingsaw`，三种冷却液各显示一条）、工业凿子、扫描仪、装配线加工、研究站、炼药锅……整页都是这样。玩家在 NEI 里看到的就是它们，不是“这条不是真的”。2.9.0 这一份里有 9,860 条、27 个配方页带着它。给模型看的配方行后面带一个 `[NEI display]` 标记，那是什么意思在结果里说一次；`data` 里是 `fake: true`。
- 读不出来的行跳过，启动日志里说有几行；带 `fake` 的有几条也在那一句里。

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

**走树和算数**在 `brain/src/tools/material-tree.ts`：每样东西用哪条配方（或者不做、要现成的）由调用的人给的选择函数定，它只管把树走完、把数算对——材料件按矿辞名算同一样东西（每样东西有个稳定的键：`ore:plateSteel`、`id/meta`、`fluid:molten.steel`……）、选定的配方要用到树上在它上面的东西时这样东西当原料并记下是哪条配方绕回去的、不消耗的模具和工具整棵树只算一个、流体按 mB、一轮出几个按轮数往上取整、有概率才出的产物不算。现在用它的只有 `total_materials`（选择函数是“只用点了名的那几条”）。

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

### 流体：没有单独的文件

流体表是大脑启动时从两份现成的资料里拼出来的（`brain/src/packdata/fluids.ts`），没有配方册时没有：

- 配方册里每种出现过的流体（`fin` / `fout` 的 `f` 是注册名，`name` 是中文名）。读配方册时顺带建了两张倒排表：哪些配方产出、哪些配方用到这种流体。
- 物品表里 NEI 给每种流体造的“流体展示”物品（`NotEnoughItems:neiFluidDisplay`，meta 是运行时的流体编号，不稳定）：它有中文名和英文名。两边**靠中文名对上**（真实的整合包 1419 种流体对上 1413 种），流体的英文名就是这么来的。
- 同一个名字可以对着好几种流体（真实数据里 30 个名字是这样，如“熔融钢”有 GregTech 的 `molten.steel` 和匠魂的 `steel.molten`）：按名字问时把它们都列出来让问的人挑注册名。

**大脑怎么用：**

- `find_item` 搜得到流体（中文名、英文名、注册名），列在物品后面，写明“这是流体，查配方时给 `fluid`”；搜到的“流体展示”物品那一行写它是哪种流体的图，不再写“没有配方”。什么都没搜到时列出名字只差一两个字的物品和流体。
- `find_recipes` / `find_uses` 给 `fluid`（名字或注册名）代替 `id`：产出、用到这种流体的配方，照样按配方页分组，可以用 `way`、`contains`、`circuit`（编程电路号）筛。不是 GregTech 的页把流体画成“流体展示”物品的，也算上。拿“流体展示”物品的 id 来问，答的是那种流体。
- 身体报的罐里的流体（`tanks` 的 `fluid` 是注册名）用这张表叫成中文名；表里没有的用身体给的名字。
- `total_materials` 把“出这种流体的配方”当成一步，按 mB 往下乘。

### carving.jsonl：凿子能把什么变成什么

一行是 Chisel（凿子）的一个“组”：组里的任何一种方块都能用凿子变成同组的另一种，不耗别的材料。配方页里没有这些（凿子不是配方），而图纸要的常常是某个具体花纹。

```jsonc
{ "group":"cobblestone",           // 组名
  "ore":"cobblestone",             // 有的组还认矿辞：这个矿辞名下的东西也能凿成这一组
  "variants":[ {"id":"minecraft:cobblestone","meta":0,"name":"圆石"}, {"id":"chisel:cobblestone","meta":14,"name":"圆石"}, … ] }
```

- 怎么凿：拿着凿子右键打开它的界面，把方块放进去，点想要的那个花纹，整组一起变（它用通用的界面动作就能做，见 `screens` 手册）。
- 只有一种方块的组不导。

**大脑怎么用**（`brain/src/packdata/carving.ts`，文件不在就当没有；真实的这份 297 组、4220 种方块，读进来几毫秒）：

- 同一种方块可以在不止一个组里（真实数据里有 37 种），所以按物品查到的是一串组。
- `find_recipes` 查到组里的方块时，把“凿子”当作又一种做法列在最后：它在哪一组、能从同组的哪些变来（同一个 id 的各个 meta 并成一行，如 `chisel:nucrete/0–6, 8–15 "结构混凝土"`；id 多的组只列前 8 个 id 并写明还有多少）、组认矿辞名的写明、凿子是拿在手里用的工具。配方册里一条配方都没有的变体不再只回一句“没有配方”。`way: "凿子"` 是全部变体一行一种；`data.chisel` 是全部变体。照实列，不排序、不推荐。
- `find_uses`（库函数）同理：它能凿成同组的哪些；自己不在组里、只带着那个组认的矿辞名的东西也列（能凿成那一组）。
- `find_item` 的每一行：组里的东西标着 `chisel group "…"`。
- 程序里：`data.chiselGroups()`、`data.chiselGroupsOf(id, meta)`，见 `docs/SCRIPTS.md`。
- `total_materials` 的 `chisel` 参数：凿子的一步一换一往下乘，凿子不算消耗；一次凿掉多少耐久这份资料里没有，结果里照实说不知道。

### 怎么导出

```bash
tools/client setup            # 头一回：把客户端包解到 client/，从官方源取游戏的库和资源，约 1.1G
tools/gradle build            # 导出代码在 mod 里（alu.aiplayer.export，只在客户端里加载）
tools/export-packdata         # 约 10 分钟；结果写进 brain/packdata/
tools/export-packdata --only icons   # 只重画图标：照 packdata 里现有的 items.jsonl 画，别的文件不动；约一分半
tools/export-packdata --only tooltips   # 只重取提示文字，同样照现有的 items.jsonl，别的文件不动；约两分钟
```

- 需要一个能让客户端进去的服务器（默认测试服 `127.0.0.1:10186`，`--join` 改），客户端用离线名字 `Exporter` 进，这个名字要在白名单里。
- 客户端要一个桌面来开窗口（默认 `DISPLAY=:10`，本机的 RDP 桌面），用显卡渲染。它不走启动器，也不登录账号。
- 游戏会启动两次：第一次中文，导出全部；第二次英文，只导名字（有些 mod 的名字在启动时就定死了，所以要两次），然后按 `id`+`meta` 并进 `items.jsonl` 和 `blocks.jsonl` 的 `en`。
- `client/` 里是我们自己的一份客户端，为了能在这台机器上启动拿掉了两个 mod（Opis、CraftPresence，在 `client/disabled-mods/`），它们不带配方。
- 图标是第一次启动时在别的都写完之后画的（多十来秒）。它画坏了不影响别的：那一次没画成的话，最后会再单独启动一次只画图标；还不成，这次导出就没有图标，别的文件照常。
  第二次启动只导名字，不碰图标；把英文名并进 `items.jsonl` 时行的顺序不变。
- `--only icons` 画的是 packdata 里那份 `items.jsonl`，只写 `icons/` 和 `meta.json` 的 `icons` 一节。
- 提示文字和图标一样，是第一次启动时在别的都写完之后取的（多四十秒左右，在画图标之前），取坏了不影响别的，没取成会在最后单独再启动一次。
  `--only tooltips` 取的是 packdata 里那份 `items.jsonl`，只写 `tooltips.jsonl` 和 `meta.json` 的 `tooltips` 一节；`--only icons,tooltips` 一次启动两样都做。
- `meta.json` 的 `nei` 一节记着这次导出的条数：`{format, generatedAt, lang, pack, items, recipes, pages, seconds, english, blocks}`；
  `icons` 一节是图标的：`{format, generatedAt, cell, icons, sheets, missing, seconds}`（图标数、图集张数、空着的格数、画了几秒）。
