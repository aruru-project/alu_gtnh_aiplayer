# 写程序的工具（run_program、start_routine）

AI 玩家可以写一段 JavaScript 让大脑在沙箱里跑。两个用处：

- **出设计**：程序画出**图纸草稿**；主人在面板上看过同意了，草稿才发布成服务器上的图纸，之后照现有的办法盖。
- **调工具**：程序里 `await tool(名字, 参数)` 调它自己的工具。`run_program` 当场跑完，只能调查询类的；`start_routine` 在后台跑（“例程”），能调动作，一步步做完再把模型叫醒。见下面“程序调工具”一节。

```
模型写程序 ──run_program──▶ 沙箱子进程 ──▶ 草稿（数据目录 drafts/）──▶ 面板“图纸”页给主人看
                                                    │ 主人同意
                                                    ▼
                              publish_draft ──▶ .schematic ──blueprint.put──▶ 服务器上的图纸 ──▶ check_blueprint / build_blueprint
```

程序自己是纯计算：画图纸、读图片的像素、查本地资料、算数。它碰不到文件、网络和游戏世界；要看世界、动世界，只有“调工具”这一个口子，走的是模型自己调工具的同一条路。

## 工具

| 工具 | 做什么 |
|---|---|
| `run_program(code, timeout?)` | 跑一段程序，这一轮里就拿到结果：日志、`return` 的值、存下的每张草稿的尺寸和材料表；草稿小的话直接带预览。出错时给报错、行号和调用栈。程序里能调查询类的工具 |
| `start_routine(code, name?, minutes?)` | 把程序放到后台跑（例程）：能调动作类的工具。立刻返回；结束时把模型叫醒 |
| `routine_status()` / `stop_routine()` | 例程做到哪了（状态、正等着的那一步、最近几次调用、程序的日志）/ 停掉它 |
| `list_images()` | 主人在面板上传的图片：名字、宽高 |
| `list_drafts()` | 草稿：名字、尺寸、方块数 |
| `view_draft(name, along?, x1…z2?, program?)` | 看一张草稿：材料表，加一片片的字符画（带图例）。`along` 是 `y`（一层层俯视）、`z`（从南面看的竖切面）、`x`（从西面看）；不给就沿最薄的方向。大草稿按约 4000 字符的预算画，画不下的写明没画哪些，用 `x1…z2` 指定范围再看。`program: true` 把生成它的程序也给出来 |
| `publish_draft(name, as?)` | 把草稿转成 `.schematic`，经 `blueprint.put` 发给身体（同名覆盖） |
| `delete_draft(name)` | 删草稿（不影响已经发布的图纸） |

规矩（写在 `brain/manuals/design.md` 里）：自己设计的东西，先把样子、材料、打算盖在哪告诉主人，主人同意再发布和开工；主人说过“直接盖”的除外。
例程的规矩在 `brain/manuals/routines.md` 里：三五步的事自己调；每一步都要看结果拿主意的事不塞进例程；动别人的东西、数量大的、接着管道的容器，先问主人再写。

## 程序能用的 API

`code` 是一个 async 函数的函数体：直接写语句，可以 `await`，`return` 的值会显示在结果里。全局只有 JavaScript 语言自带的对象（`Math`、`JSON`、`Map`、类型化数组……）和下面这些。

**坐标**都从 0 数：x 向东，y 向上，z 向南。发布以后，草稿的 (0, 0, 0) 角就是 `check_blueprint` / `build_blueprint` 的 `x y z`。
**方块**写成 `"注册名"` 或 `"注册名/meta"`（meta 0–15），也可以是 `{ id, meta }`；`null` 是空。

| | |
|---|---|
| `blueprint(宽, 高, 长)` | 一张空图纸（x 方向宽、y 方向高、z 方向长）。每边最多 256，总共最多 200 万格 |
| `b.set(x, y, z, 方块)` / `b.get(x, y, z)` | 放一个 / 看一个。越界抛 `RangeError` |
| `b.fill(x1, y1, z1, x2, y2, z2, 方块)` | 实心盒子（两个角都含，哪个在前都行） |
| `b.box(…)` / `b.walls(…)` / `b.line(…)` | 空心盒子（六个面）/ 四面墙 / 两点连线，参数同 `fill` |
| `b.save(名字)` | 把现在的样子存成草稿。一个程序最多存 8 张；程序出错的话一张都不留 |
| `b.width` `b.height` `b.length` `b.size` | 尺寸 |
| `images()` | 主人传的图片：`[{ name, width, height }]` |
| `image(名字)` | 一张图：`img.width`、`img.height`、`img.pixel(x, y)` → `[r, g, b, a]`（0–255，左上角是 (0, 0)） |
| `img.resize(宽, 高?)` | 缩放成一张新图。缩小时每格是它盖住的那一块的平均色（按不透明度加权）；不给高就按比例 |
| `palette()` | 方块颜色表：`[{ id, meta, name?, color: [r, g, b] }]`。来自 `brain/packdata/blocks.jsonl`，没有这个文件时是内置的 16 色羊毛加 16 色染色粘土 |
| `nearestBlock(r, g, b, among?)` 或 `nearestBlock([r, g, b], among?)` | 颜色最接近的方块（返回颜色表里的一项，可以直接交给 `b.set`）。`among` 是一个方块列表，只在里面挑；`"minecraft:wool"` 指它的所有 meta |
| `data.available()` | 现在有哪几样本地资料：`items`、`quests`、`questLines`、`structures` 里的几个 |
| `data.items()` / `data.item(id, meta?)` | 物品表（`items.jsonl`） |
| `data.quests()` / `data.questLines()` | 任务书（字段见 `docs/PACKDATA.md`） |
| `data.structures()` | 全部多方块机器：`[{ id, meta, name, tiers }]`（`structures.jsonl`） |
| `data.structure(名字)` 或 `data.structure(id, meta)` | 一台多方块机器：`{ id, meta, name, tiers, info, structureInfo, rows, tier(n) }`。`rows` 的每一项是一种搭法 `{ tiers, size: [x, y, z], controller: [x, y, z], blocks: [{ id, meta, name, n }], palette, cells }`，`palette[cells[(y * size[2] + z) * size[0] + x]]` 是那一格的方块，主机正面朝南；`tier(n)` 是第 n 级的搭法。没有是 `null`，重名的抛错并列出各自的 id/meta |
| `log(…)`，`console.log(…)` | 打日志。一共留 4000 字符，多的丢掉并说明丢了几条 |
| `await tool(名字, 参数)` | 调一个工具，参数和模型自己调时一样。返回 `{ ok, text, data }`：成没成、模型会看到的那段文字、同一个结果的数据形式（有些工具没有）。工具失败不抛错，只是 `ok` 为 `false` |

没有的东西：`import`、`require`、`process`、文件、网络、定时器、`eval` / `new Function`。

`nearestBlock` 的“接近”用的是按红色分量加权的 RGB 距离（redmean）。对着羊毛这种偏灰的颜色表试过 CIELAB 和 Oklab，前者把纯蓝配成紫色，后者把黄、粉配成白色，这个最不离谱。想用别的算法，程序可以拿 `palette()` 自己算。

## 程序调工具

用例：“把抽屉管理器管着的、数量不到 128 的东西，都搬到那个没接管道的压缩箱子里。”几十样东西一样样取、一样样放，模型自己一步步调要几十轮；写成程序就是一个循环。

| | `run_program` | `start_routine`（例程） |
|---|---|---|
| 什么时候跑完 | 模型的这一轮里，结果当场回来 | 后台。模型启动它以后这一轮就结束 |
| 能调哪些工具 | 只有查询类的（`brain/src/tools/index.ts` 的 `QUERY_TOOLS`：看状态、看仓库、查配方、查任务书……） | 除了 `run_program` 和例程自己的三个工具以外的全部 |
| 开任务的工具 | 调不了（结果是失败，并指到 `start_routine`） | 等任务结束才返回：`ok` 是任务成没成，`data` 是 `{ task, state, result, error }` |
| 总时长 | 90 秒（连等查询结果的时间） | 默认 30 分钟，`minutes` 最多 180 |
| 程序自己的计算时间 | 默认 10 秒，`timeout` 最多 30 | 20 秒 |
| 别的上限 | – | 最多调 400 次工具、其中最多开 150 个任务；连着 3 次工具失败就停 |
| 同时几个 | 一个 | 一个（例程在跑时，模型还可以另跑一个 `run_program`） |

**同一条路。** 程序调的每个工具都交给大脑的 `runTool`：和模型自己调是同一份校验、同一个执行函数，结果一样被截到“单个工具结果上限”（`data` 不截）。每一次调用和结果都记进对话日志（前面标着 `[程序]` 或 `[例程 r1]`），例程开的任务一样出现在面板的任务列表里。

**例程怎么和模型配合**（`brain/src/agent/routine.ts`）：

- 例程开的任务结束时不叫醒模型，交给例程接着走；例程做完（`return`）、程序出错、被停掉、碰到上限时，才叫醒模型一次，消息里是：怎么结束的、调了几次工具开了几个任务、`return` 的值、最近 12 次调用各自的结果、程序最后 40 行日志。
- “需要拿主意”也是这样回来的：程序 `return` 一句话说明卡在哪，模型被叫醒后决定。
- 停：模型调 `stop_routine`；主人在面板概览页点“停止例程”；它正在做的任务被人取消（主人在面板上取消、模型另开了任务把它顶掉）。停下时它正等着的任务会被取消，已经做了的不撤销。
- 例程在跑的时候模型照常会被别的事叫醒，可以用 `routine_status` 看进度。
- 例程不落盘。大脑退出时它停下、正在做的任务被取消；下次启动，模型第一件事就是被告知“例程没跑完，停在哪一步”，带着日志。

**计时分两种。** 程序等工具结果的时候，沙箱子进程是停着的（读标准输入等那一行结果），这段时间不算进“程序自己的计算时间”；等一个任务做完可能要几分钟，由总时长管。所以一个不调工具的死循环，20 秒内就会被停掉。

## 库函数：只在程序里能调的

有些事是“查本地资料，再算一算”，模型不常用，用的时候写几行程序就行。它们不做成发给模型的工具（每个工具的说明每一轮都要发给模型，现在一共六万多字符），而是**库函数**：和工具一样的写法、一样用 `await tool(名字, 参数)` 调、一样返回 `{ ok, text, data }`，但只在程序里调得到。登记在 `brain/src/tools/index.ts` 的 `LIBRARY_TOOLS`；都是只查不动手的，所以 `run_program` 里也能调。模型自己直接调会得到“没有这个工具”。

| | |
|---|---|
| `read_blocks { x1, y1, z1, x2, y2, z2 }` | 世界里一个盒子的全部方块（每边最多 64）。`data`：`{ x, y, z, sx, sy, sz, palette: [{ id, meta, name? }], cells, unloaded }`，盒子从 `(x, y, z)` 起，`palette[cells[(dy * sz + dz) * sx + dx]]` 是那一格（`palette[0]` 是空气） |
| `find_structure { name \| id, meta, tier?, from? }` | 一台多方块机器怎么搭：等级、每级的尺寸和材料、机器自己的结构说明、相邻两级差什么（`text` 是整理好的一段话）。`tier` 看一级，`from` + `tier` 看两级之差。`data`：`{ id, meta, name, tiers, rows: [{ tiers, size, blocks }] }` |
| `total_materials { id, meta?, count?, recipes: [#…] }` | 纯计算：模型**自己选定**了每一层用哪条配方之后，把总原料算出来（数量沿树相乘，一轮出几个按轮数取整，模具和工具只算一个）。没给配方的东西算成“要现成的”。它不查库存、不看机器、不替模型选任何一步。`data`：`{ target, steps: [{ recipe, way, rounds, makes, needed }], raw, kept, fluids, unused }` |
| `check_structure { at, tier, id?, meta? }` | 把世界里 `at` 那台主机周围的方块和它 `tier` 级的搭法对一遍（四个水平朝向都试，取对得最上的；机器零件占着机械方块的位置算对）。`data`：`{ machine, tier, facing, looksLike, total, right, changes: [{ x, y, z, from, to }], need: [{ id, meta, name, count, carried, stored, short }] }` |

加一个库函数：写成一个 `Tool`（`brain/src/tools/structures.ts` 是例子），放进 `LIBRARY_TOOLS`。结果里的 `data` 是给程序用的，`text` 是模型把结果 `return` 出来时看的。模型的工具有不少还没有 `data`（只有文字）；给程序用得上的陆续补（现在有的见 `brain/manuals/routines.md` 的“常用的 data”）。

按场景的示例程序在手册里：`routines`（一样样搬东西）、`multiblocks`（这台多方块升到某一级要换什么——取结构、读世界、试朝向、列差异、对库存）。手册里的示例都有测试照抄着跑一遍。

## 草稿和图片

都在大脑的数据目录里（`brain/data/`，或 `AIPLAYER_DATA_DIR`）。

| | 位置 | 上限 |
|---|---|---|
| 草稿 | `drafts/<名字>.json`：尺寸、方块种类、格子（“下标, 连续几格”的序列，顺序同 `.schematic`）、生成它的程序 | 40 张；每边 256 格，200 万格 |
| 图片 | `images/<名字>.png`（面板传上来的原样）和 `images/<名字>.rgba`（解好的像素，沙箱里的程序读这个） | 30 张；每边 256 像素，文件 512 KiB |

图片在浏览器里先用 canvas 缩到最长边 256 像素以内、转成 PNG 再上传，所以大脑只解 PNG（`brain/src/design/png.ts`：灰度、RGB、RGBA 和调色板图，各种位深；不支持隔行扫描）。

发布时写出的 `.schematic`（`brain/src/design/schematic.ts`）照 `mod/.../world/Blueprint.java` 的读法：`Width/Height/Length`、`Blocks`、`Data`，方块种类超过 255 种时加 `AddBlocks`（Schematica 的半字节顺序），`SchematicaMapping` 里是注册名 → 文件内的数字 id（空气 0，其余从 1 排起）。

## 沙箱

### 怎么跑的

每个程序（`run_program` 的，或者一个例程）起一个新的 Node 子进程（约 30 毫秒），跑完就没了。三层限制：

1. **进程这一层**（`brain/src/script/sandbox.ts`）。子进程带着 Node 的 permission 模型启动：
   `--permission`，只许读三处——`brain/src/script/`（runner 和 API 的源码）、数据目录的 `images/`、本地资料里程序能查的那几个文件；
   没有任何写权限；不许起子进程、worker、原生模块、WASI、调试器。环境变量是空的；标准输入里先是这次的请求，之后是它调的每个工具的结果（一行一个），别的什么都没有。
2. **vm 这一层**（`runner.mjs` + `prelude.js`）。程序跑在一个全新的 `node:vm` 上下文里（`vm.constants.DONT_CONTEXTIFY`）：
   全局对象上只有 JavaScript 语言内置的东西和上面那张表里的 API。宿主那边一个对象都没递进去：API 是在上下文里面定义的，
   它和宿主之间只有一个“字符串进、字符串出”的函数（打日志、读一张图、读一份资料、提交一次工具调用）。进程带 `--disallow-code-generation-from-strings`，`eval` / `new Function` 在上下文内外都不能用。
   工具调用是这样过去的：子进程往标准输出写一行“调哪个工具、什么参数”，然后停下来读标准输入；大脑执行完，把结果写回它的标准输入。子进程自己什么都没碰，世界是大脑替它动的。
3. **资源**。

| 资源 | 上限 | 超了会怎样 |
|---|---|---|
| 计算时间（等工具结果的时间不算） | `run_program` 默认 10 秒、`timeout` 最多 30 秒；例程 20 秒 | vm 自己的超时把程序停掉；万一没停住，再过 1.5 秒大脑把子进程杀掉 |
| 总时长（等工具结果的时间算在内） | `run_program` 90 秒；例程默认 30 分钟、最多 180 | 大脑把子进程杀掉 |
| JS 堆 | 256 MiB（`--max-old-space-size`） | V8 自己中止子进程 |
| 常驻内存（大数组不在 JS 堆里） | 512 MiB | 大脑每 25 毫秒看一次 `/proc/<pid>/statm`，超了就杀。**只在 Linux 上有** |
| 标准输出（草稿从这里回来） | 16 MiB | 杀掉 |
| 日志 / 返回值 | 4000 / 2000 字符 | 截断并说明 |

程序交回来的草稿当作不可信的 JSON，在大脑这边逐项检查（`brain/src/design/draft.ts`：名字不能带路径、尺寸和格子数要对得上、方块写法要合规）过了才落盘。

### 保证什么（都有测试，`brain/test/design.test.ts`）

- 程序死循环、吃光内存、狂打日志、把自己弄崩，都只是这一次 `run_program`（或这个例程）失败并说明原因；大脑进程不受影响，下一个程序照常跑。
- 程序的正常写法里没有读写文件、起进程、联网的入口：`fetch`、`XMLHttpRequest`、`WebSocket`、`require`、`import()`、`process`、`eval`、`Function`、定时器都没有或者用不了。
- 就算程序执行到了子进程自己的那一层，按这组启动参数：数据目录里的 `config.json`（API key）、记忆、历史读不到，任何文件都写不了，进程和线程起不了。
- 程序读得到的只有：主人传的图片、方块颜色表、物品表、任务书。都不是秘密。
- 程序对游戏世界能做的事，不多于模型自己用工具能做的事（`brain/test/routine.test.ts`）：它提交的每一次工具调用都由大脑按工具的 schema 校验后执行，没有的工具、不合规的参数一样被拒；`run_program` 的程序只调得了查询类的；例程调不了 `run_program` 和例程自己的那三个工具，而且有次数和时长的上限。就算程序突破了 vm、能随便往标准输出写东西，它能递给大脑的也还只是“调某个工具”的请求。

### 不保证什么

这不是对付恶意代码的硬隔离，两层都有官方的免责声明：

- `node:vm`：Node 文档原话是 “The node:vm module is not a security mechanism. Do not use it to run untrusted code.”
- permission 模型：Node 文档原话是 “This feature does not protect against malicious code… It does not provide security guarantees in the presence of malicious code.” 它自称“安全带”，防的是写错的代码，不是存心的攻击。

具体到这里：

- **网络没有在进程这一层堵住。** 这台机器的 Node 24.22.1 的 permission 模型不管网络（`node --help` 里没有 `--allow-net`；实测带着 `--permission` 的进程 `net.connect` 连得出去）。现在靠的是 vm 那一层不给入口，外加 runner 启动时把子进程自己的 `fetch`、`WebSocket`、`process.binding`、`process.getBuiltinModule` 之类摘掉。也就是说：**联不了网这一条，只在 vm 没被突破的前提下成立。**（新版 Node 的文档里 permission 模型已经管网络了；升级 Node 后应该把这条补上并重新验证。）
- **突破 vm 之后够得着同一个用户的其他进程。** permission 模型不管发信号，也不管 `process._debugProcess(pid)`（Node 文档点了名：它能让同一用户下的另一个 Node 进程打开调试口）。runner 把这两样也摘了，大脑的启动命令加了 `--disable-sigusr1`（不响应“打开调试口”的信号），但这些同样只是多一层，不是硬保证。
- 突破 vm 靠的是 V8 / Node 的漏洞，或者 `node:vm` 已知的那类把宿主对象漏进上下文的路子。这里把已知的路子堵了（上下文里没有宿主对象；`import()` 的拒绝值是字符串而不是宿主的 Error；runner 是 ES 模块，栈上没有宽松模式的函数），没法证明没有别的。
- CPU：一个核跑满，到超时为止。没有 CPU 配额。
- 常驻内存的上限靠轮询，瞬间可能冲高一截（实测超出一成左右）；不是 Linux 就只有 JS 堆的上限。
- permission 模型会跟着符号链接走到允许范围之外：不要往数据目录的 `images/` 里放符号链接。

谁能让它跑程序：能指挥它的人（主人名单里的；没设名单就是服务器里所有玩家）。程序拿不到秘密；被人诱导着乱写，纯计算的后果是白占一会儿 CPU、多几张草稿（有数量上限）。
例程能动世界，但能做的就是模型本来能做的那些（搬东西、挖、放、合成、说话），只是做得快、一口气做得多：一个写错的循环在被停下之前最多开 150 个任务。所以它的防线和模型自己干活是同一套——主人名单、手册里“先问”的规矩、面板上随时能停——**没有“例程启动前要主人点头”这一道**。要不要加，是该由主人定的事。

想要真正的隔离，得靠操作系统：让沙箱子进程跑在另一个系统用户下，或者放进容器 / 没有网络的命名空间。这台机器上不要特权做不到（`unshare -n`、`bwrap --unshare-net` 都被 Ubuntu 24.04 的 AppArmor 拦了），所以没有做。

## 代码在哪

```
brain/src/script/sandbox.ts     起子进程、各项上限、把结果拿回来
brain/src/script/runner.mjs     子进程入口：收紧自己、建 vm 上下文、跑程序、报结果（纯 JavaScript 的 ES 模块）
brain/src/script/prelude.js     程序能用的 API，在 vm 上下文里求值（纯 JavaScript）
brain/src/design/               草稿的检查和存取、文字预览、.schematic、PNG 解码、图片存取
brain/src/agent/routine.ts      例程：程序调工具时怎么执行、怎么等任务、各项上限、怎么结束
brain/src/tools/design.ts       run_program、例程的三个工具、草稿和图片的六个工具（view_draft 加 picture 可以把草稿画成图）
brain/src/tools/pictures.ts     看图的工具：view_area（世界）、view_image（主人传的图片）
brain/src/render/               简图：把草稿、世界里的一块地方按方块颜色画成 PNG（见 brain/README.md 的“看图”）
brain/src/packdata/blocks.ts    方块颜色表和内置的小表
brain/manuals/design.md         给模型看的手册：出设计
brain/manuals/routines.md       给模型看的手册：程序调工具、例程
```
