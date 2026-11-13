# 写程序的工具（run_program、start_routine）

AI 玩家可以写一段 JavaScript 让大脑在沙箱里跑。两个用处：

- **出设计**：程序画出**图纸草稿**；主人在面板上看过同意了，草稿才发布成服务器上的图纸，之后照现有的办法盖。
- **调工具**：程序里 `await tool(名字, 参数)` 调它自己的工具，和不在工具清单里的**库函数**（见“库函数”一节）。`run_program` 当场跑完，只能调查询类的；`start_routine` 在后台跑（“例程”），能调动作，一步步做完再把模型叫醒。见下面“程序调工具”一节。

**两条线**（`docs/TALK_WORK.md`）：`run_program` 对话线和干活线都有，各跑各的、互不挡着，程序里都只能查。会动手的那一半——`start_routine`、`routine_status`、`stop_routine`、`publish_draft`、`delete_draft`、照图纸盖——只有干活线有；对话线直接调了这些名字、或者在程序里调了会动身体的工具，不执行，结果里写明这归干活线、用 `tell_worker` 交过去。下面说“模型”的地方，凡是讲例程和发布的，指的都是干活线。

```
模型写程序 ──run_program──▶ 沙箱子进程 ──▶ 草稿（数据目录 drafts/）──▶ 面板“建造”页给主人看
                                                    │ 主人同意
                                                    ▼
                              publish_draft ──▶ .schematic ──blueprint.put──▶ 服务器上的图纸 ──▶ check_blueprint / build_blueprint
```

程序自己是纯计算：画图纸、读图片的像素、查本地资料、算数。它碰不到文件、网络和游戏世界；要看世界、动世界，只有“调工具”这一个口子，走的是模型自己调工具的同一条路。

## 工具

| 工具 | 做什么 |
|---|---|
| `run_program(code, timeout?)` | 跑一段程序，这一轮里就拿到结果：日志、`return` 的值、存下的每张草稿的尺寸和材料表；草稿小的话直接带预览。出错时给报错、行号和调用栈。程序里能调查询类的工具。它的说明后面带着库函数的索引 |
| `start_routine(code, name?, minutes?)` | 把程序放到后台跑（例程）：能调动作类的工具。立刻返回；结束时把模型叫醒 |
| `routine_status()` / `stop_routine()` | 例程做到哪了（状态、正等着的那一步、最近几次调用、程序的日志）/ 停掉它 |
| `list_designs(kind?)` | 三样一起列，或者只列一样：`blueprints` 服务器上的图纸、`drafts` 草稿（名字、尺寸、方块数）、`images` 主人在面板上传的图片（名字、宽高）。旧的三个名字 `list_blueprints` / `list_drafts` / `list_images` 不在清单里了，调到照常执行 |
| `view_draft(name, blueprint?, along?, x1…z2?, program?)` | 看一张草稿：材料表，加一片片的字符画（带图例）。`along` 是 `y`（一层层俯视）、`z`（从南面看的竖切面）、`x`（从西面看）；不给就沿最薄的方向。大草稿按约 4000 字符的预算画，画不下的写明没画哪些，用 `x1…z2` 指定范围再看。`program: true` 把生成它的程序也给出来。`blueprint: true` 看的是游戏服务器上那张同名的图纸：看法一样，材料表是身体给的（带得由人放的原因），格子用身体的 `blueprint.read` 读（一次最多 262,144 格，大的分几次读，结果里写明读了几次；给了 `x1…z2` 只读那一块），字符按整张图纸的材料表发（分几次看不同的部分，同一个字符还是同一种方块）；`data` 是 `{ name, source: 'server', size, blocks, materials }`，每一格用 `read_blueprint` |
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
| `data.available()` | 现在有哪几样本地资料：`items`、`quests`、`questLines`、`structures`、`carving` 里的几个 |
| `data.chiselGroups()` | 凿子的全部组（`carving.jsonl`）：`[{ group, ore?, variants: [{ id, meta, name }] }]`。同组里的方块能用凿子互相变，一换一 |
| `data.chiselGroupsOf(id, meta?)` | 一样东西在凿子的哪几个组里：`[{ group, ore?, variants, member }]`，都不在是 `[]`。`member` 为 `false` 是它自己不在组里、只带着那个组认的矿辞名（能凿成那一组） |
| `data.items()` / `data.item(id, meta?)` | 物品表（`items.jsonl`） |
| `data.quests()` / `data.questLines()` | 任务书（字段见 `docs/PACKDATA.md`） |
| `data.structures()` | 全部多方块机器：`[{ id, meta, name, tiers }]`（`structures.jsonl`） |
| `data.structure(名字)` 或 `data.structure(id, meta)`（名字是中文名，或者物品表里这台主机的英文名） | 一台多方块机器：`{ id, meta, name, tiers, info, structureInfo, rows, tier(n) }`。`rows` 的每一项是一种搭法 `{ tiers, size: [x, y, z], controller: [x, y, z], blocks: [{ id, meta, name, n }], palette, cells }`，`palette[cells[(y * size[2] + z) * size[0] + x]]` 是那一格的方块，主机正面朝南；`tier(n)` 是第 n 级的搭法。没有是 `null`，重名的抛错并列出各自的 id/meta |
| `log(…)`，`console.log(…)` | 打日志。一共留 4000 字符，多的丢掉并说明丢了几条 |
| `await tool(名字, 参数)` | 调一个工具或库函数，参数和模型自己调时一样。返回 `{ ok, text, data }`：成没成、模型会看到的那段文字、同一个结果的数据形式（有些工具没有）。工具失败不抛错，只是 `ok` 为 `false` |
| `await wait(秒)`（只在例程里） | 停这么久再往下走（可以是小数）。等的时间算进例程的总时长，不算进程序自己的计算时间，也不算工具调用；一次等会超过剩下的总时长的，当场抛错，消息写着还剩多少秒。`run_program` 的程序调它抛错，说这里不能等、能怎么办 |
| `setTimeout(回调, 毫秒, …参数)` / `clearTimeout(id)`（只在例程里） | 底下就是 `wait`：模型顺手写的 `await new Promise((r) => setTimeout(r, 5000))` 照样能用。回调里抛出来的（或它返回的 promise 被拒绝）当成程序出错；不让等（超过剩下的总时长）也是程序出错。`setInterval` 没有（调它抛错，说用循环加 `wait`）；`run_program` 里 `setTimeout` 抛错 |
| `return 值` | 显示在结果里。最多和一个工具结果一样长（面板上的“单个工具结果上限”，默认 20000 字符）；更长的只给开头，并写明一共多少、给了多少、剩下的怎么拿 |

没有的东西：`import`、`require`、`process`、文件、网络、`eval` / `new Function`；定时器只有例程里的 `wait` / `setTimeout`，它们不是宿主的定时器，是和调工具同一条路上的一次“请大脑等一会儿”（见下面“计时分两种”）。

`nearestBlock` 的“接近”用的是按红色分量加权的 RGB 距离（redmean）。对着羊毛这种偏灰的颜色表试过 CIELAB 和 Oklab，前者把纯蓝配成紫色，后者把黄、粉配成白色，这个最不离谱。想用别的算法，程序可以拿 `palette()` 自己算。

## 程序调工具

用例：“把抽屉管理器管着的、数量不到 128 的东西，都搬到那个没接管道的压缩箱子里。”几十样东西一样样取、一样样放，模型自己一步步调要几十轮；写成程序就是一个循环。

| | `run_program` | `start_routine`（例程） |
|---|---|---|
| 什么时候跑完 | 模型的这一轮里，结果当场回来 | 后台。模型启动它以后这一轮就结束 |
| 能调哪些工具 | 只有查询类的（`brain/src/tools/index.ts` 的 `QUERY_TOOLS`：看状态、看仓库、查配方、查任务书、读游戏内指南……，只查不动的库函数也在里面） | 除了 `run_program` 和例程自己的三个工具以外的全部，库函数和旧名字也算 |
| 开任务的工具 | 调不了（结果是失败，并指到 `start_routine`） | 等任务结束才返回：`ok` 是任务成没成，`data` 是 `{ task, state, result, error }` |
| 总时长 | 90 秒（连等查询结果的时间） | 默认 120 分钟、`minutes` 最多要到 720（12 小时）；这两个数主人在面板“设置”里改，启动的结果里写着这一次给了多少 |
| 程序自己的计算时间 | 默认 10 秒，`timeout` 最多 30 | 20 秒 |
| 调用次数 | 不限 | 不限（调多少次工具、开多少个任务都没有上限） |
| 别的上限 | – | 连着 3 次工具失败就停；每秒最多调 20 次工具，超了的那次自动等一下，不算失败 |
| 等一会儿（`wait`、`setTimeout`） | 没有 | 有：算进总时长，不算计算时间、不算工具调用；超过剩下的总时长的一次等当场不让等 |
| 同时几个 | 每条线一个 | 一个（例程在跑时，两条线都还可以各跑一个 `run_program`） |

**同一条路。** 程序调的每个工具都交给大脑的 `runTool`：和模型自己调是同一份校验、同一个执行函数，结果一样被截到“单个工具结果上限”（截了会写明截掉多少；`data` 不截）。例程开的任务一样出现在面板的任务列表里。

**每一步记在哪。** 一个例程可以调几千次工具，所以不是每次都往对话日志里记：

- 全量在这次运行自己的文件里：数据目录 `logs/runs/<routine|program>-<日期>-<时间>-<编号>.jsonl`，一行一条（一次运行写过 20 MiB 以后，成功的结果只留开头 400 字符并记下原来多长，免得跑十二小时的例程把磁盘写满；参数、成没成、用时照记，出错的照样留全）。`start`（程序全文）、`call`（第几次、工具、参数、成没成、结果全文、用时、开的任务号）、`log`（程序自己 `log` 的一行）、`end`（怎么结束的、返回值）。留最近 300 次运行。
- 对话日志里一次运行只有一条汇总（“例程 r3（整理抽屉）：在跑，已调 312 次工具，开了 150 个任务，0 次出错，64 秒”），跑着的时候原地更新；另外每一次出错的调用各有一条。面板上点开汇总就是读上面那个文件。
- `run_program` 的程序调的查询也是这样记（编号 `p1`、`p2`……）；一次工具都没调的程序不占行。

**例程怎么和模型配合**（`brain/src/agent/routine.ts`）：

- 例程开的任务结束时不叫醒模型，交给例程接着走；例程做完（`return`）、程序出错、被停掉、碰到上限时，才叫醒模型一次，消息里是：怎么结束的、调了几次工具开了几个任务、`return` 的值、最近 12 次调用各自的结果、程序最后 40 行日志。
- “需要拿主意”也是这样回来的：程序 `return` 一句话说明卡在哪，模型被叫醒后决定。
- 停：模型调 `stop_routine`；主人在面板“现在”页点“停止例程”（侧栏例程那一行的“停”也是它）；它正在做的任务被人取消（主人在面板上取消、模型另开了任务把它顶掉）；总停止（对话线的 `stop_work`、面板的 `POST /api/work/stop`）。停下时它正等着的任务会被取消，已经做了的不撤销。总停止停掉的那一次不叫醒干活线：它停在哪只留作背景，等有了新的交代它才看到。
- 例程里可以调 `report`（干活线的工具）把进度或问题送给对话线：普通汇报只作背景，对话线下次醒来看到；带 `question: true` 的叫醒它。`say`、`whisper` 调不了（干活线不对玩家说话）。
- 例程在跑的时候模型照常会被别的事叫醒，可以用 `routine_status` 看进度。
- 例程不落盘。大脑退出时它停下、正在做的任务被取消；下次启动，模型第一件事就是被告知“例程没跑完，停在哪一步”，带着日志。

**计时分两种。** 程序等工具结果的时候，沙箱子进程是停着的（读标准输入等那一行结果），这段时间不算进“程序自己的计算时间”；等一个任务做完可能要几分钟，由总时长管。所以一个不调工具的死循环，20 秒内就会被停掉。

**例程自己等**（`wait`、`setTimeout`；意见簿 f20：它在例程里用 `setTimeout` 等蒸汽锤一批做完，报 `ReferenceError`）：子进程往标准输出写一行 `{t:"wait", id, ms}`，停下来读标准输入，和调工具一样；大脑（`routine.ts` 的 `wait`）计时，到了写回 `{t:"result", id, ok:true}`。所以等的时间同样不算计算时间，算总时长。大脑先看这次等完会不会超过这个例程剩下的总时长（和总时长的定时器是同一只单调时钟），超过就当场回 `ok:false` 和还剩多少秒；例程被停掉时正在等的那一次马上结束。等不算工具调用：不限速、不算进“连着失败”，记录文件里是一条 `wait`（见 `docs/BRAIN_SPEC.md` 的“程序运行的明细”），汇总里多“等了 N 次共 X 秒”，叫醒模型的消息里多 `N wait(s) of its own (X s in all)`，`routine_status` 在等时写 `Now waiting for: wait 5 s`。`run_program` 的程序没有这个口子（`limits.waits` 是 false），一调就是程序里的错误。

## 库函数：不在工具清单里的

每个工具的说明和参数 schema 每一轮都发给模型（瘦身前 66 个工具、六万两千多字符；现在两条线各有清单——不能看图的模型，干活线 52 个、约 46,900 字符，对话线 28 个、20,951 字符）。“查一查、把结果算一算”这类事不值得每一轮都占着地方，做成**库函数**：和工具一样的写法、一样用 `await tool(名字, 参数)` 调、一样返回 `{ ok, text, data }`，只是不在发给模型的清单里。登记在 `brain/src/tools/index.ts`，一共三层：

| | 发给模型 | 模型怎么知道它存在 | 怎么调 |
|---|---|---|---|
| 工具（干活线 `WORK_TOOLS`、对话线 `TALK_TOOLS`） | 每一轮，连说明和 schema | 工具清单 | 直接调；程序里也能调 |
| 库函数（`LIBRARY_TOOLS`） | 不发 | `run_program` 的说明后面有一份**索引**：每个一行（名字、参数要点、`data` 里有什么），整份不超过 2200 字符；`start_routine` 的说明指过去。细节在 `routines` 手册的“库函数”一节 | 程序里 `await tool(名字, 参数)` |
| 旧名字（`LEGACY_TOOLS`） | 不发 | 不提（只为已经存着的例程、笔记、它自己写的手册还能用） | 同上 |

**挪走不等于拿掉能力。** `runTool` 按名字找的时候三层都找：模型直接调了一个库函数或旧名字，和调工具一样**照常执行**（同样的参数校验、同样的结果），不回“没有这个工具”，也不回“请写程序”。旧习惯、旧笔记、小模型的误调都不会变成一次失败。调了真不存在的名字时，报错里分两组列出能调的：它的工具，和库函数。

只查不动手的库函数在 `QUERY_TOOLS` 里，`run_program` 和例程里都能调；`haul_items` 会开任务，只能在例程里调（干活线直接调时照常开任务）。对话线的索引里只有只查不动的；“照常执行”对它的例外是会动身体的名字（见开头“两条线”一段）。

**看图的工具按模型给**（`Tool.picture`，`modelToolSpecs`）。`view_area`、`view_image`、`view_draft` 的图只有能看图的模型用得上：

- 当前模型能看图：三个都在工具清单里。
- 不能看图：`view_area`、`view_image` 不进清单，列在库函数的索引里（程序里调，拿文字和 `data`）；`view_draft` 的文字那一半（尺寸、材料表、字符画、生成它的程序）谁都用得上，所以留在清单里，换成不提图的那份说明，少了 `picture`、`from`、`layer` 三个参数（`Tool.textOnly`）。直接调照常执行，给文字。
- `view_draft` 的图：草稿的，或者加 `blueprint: true` 是服务器上的图纸的（和面板“图纸”页“查看”里的简图是同一种）。一张图每边最多 256 格（和草稿的上限一样，画在 1024 像素里一格至少一个像素）：更宽的图纸要图时照实说多大、让它用 `x1…z2` 挑一块，那时还没读格子。

现在的库函数（`text` 都是整理好的一段话，下面只写 `data`）：

| | |
|---|---|
| `recent_chat { minutes?, limit?, player? }` | 最近的聊天记录，只读，早的在前：公共聊天、对它的悄悄话、主人在面板上发来的话、它自己在游戏里说出去的话、对话线在面板上回主人的字（`replied`，文字里是 “you replied on the panel:”）；别人说的每一句带着他当时站在哪、朝哪、指着什么。干活线不直接听人说话，交来的事只附着当时那一轮的原话，更早的几句靠它查。`data`：`{ lines: [{ time, kind: 'chat' \| 'whisper' \| 'panel' \| 'said' \| 'whispered' \| 'replied', who, text, to?, speaker? }], matched }`（`speaker` 是身体给的那份 `{ block, facing, lookingAt, ahead }`）。默认最近 30 句、最多 100；记录一共留最近 300 句（数据目录 `chat-log.json`） |
| `read_log { turn?, turnTo?, from?, to?, minutes?, query?, kinds?, line?, id?, offset?, after?, before?, limit? }` | 它自己的活动日志（面板“对话”页那一份，留最近 14 个有记录的日子），只读：对话历史里较早的轮换成交接记录以后，原文在这里。按第几轮、时间段、词、类别（`said` 它说的、`heard` 别人说的和面板上发来的、`tools` 工具调用和结果、`relay` 两条线之间、`thought`、`turns`、`events`、`notes`、`runs`、`calls`）取；给了起点（`turn`、`from`、`after`）从头往后读，否则给最晚的；`id` 读一条的全文。`data`：`{ entries: [{ id, time, kind, turn?, step?, agent?, who?, text, detail?, isError? }], matched, earlier, later, shown }`（`entries` 是这一页的整条，`detail` 是日志里存着的全部——落盘时超过 8000 字符的被截过，末尾写着原长）；`id` 时是 `{ entry }` |
| `list_stock { radius?, contains?, below?, at?, page? }` | 周围所有箱子和抽屉合成一张存货表（`radius` 默认 16，最大 160：一个基地；超过 32 时切成每块每个方向 32 格的几块各看一次，文字里写明几块、盖住哪一片，慢的写花了多久；一次最多读 3000 个容器）；机器各个面上能装东西的覆盖板（槽位扩展）里的东西也算（机器自己的格子不算）。`data`：`{ items: [{ id, meta, name?, count, automated, places: [{ x, y, z, count, kind?, side?, automated? }] }] }`（全部，不分页；`text` 一页 40 行）。`kind: "cover"` 的那一处在那个方块 `side` 面的覆盖板里，取它的容器写成 `{ x, y, z, side, sneak: true }` |
| `list_entities { radius?, at?, page?, entity?, detail?, path? }` | 默认查附近实体，每页20只，`data:{entities:[{uuid,dim,entityId,kind,type,name,pos,motion,state,item?}],total,offset,more}`；页外数量显式给出，动物移动时页序可变，跨页按uuid去重。`entity:{uuid,dim}` 改为精查一只，data是Entity本身；detail/path读非玩家自己的存档状态（同inspect_block限额和显式省略）。用 `use_item.entity` 右键/left攻击，详见inventory手册 |
| `list_drawers { x, y, z, below?, page? }` | 一个抽屉管理器（或一个抽屉方块）的每一格。`data` 是身体 `world.drawers` 的原样回答：`{ controller?, drawers, slotsTotal, slotsUsed, slots: [{ x, y, z, slot, id, meta, name, count, room, front, hit } 或 { x, y, z, slot, empty: true }], total, offset }`。`front`（正面朝哪）和 `hit`（点这一格时点在方块里的哪一点）可以原样交给 `use_item` 的 `side` / `hit` |
| `read_blueprint { name, draft?, from?, to? }` | 一张图纸里有什么，不用知道它放在哪：服务器上的图纸（身体的 `blueprint.read`），或者 `draft: true` 读它自己的草稿，两边是同一个形状。`data`：`{ name, source: 'server' \| 'draft', size: { x, y, z }, blocks, materials: [{ id, meta, name?, count, item?, byHand? }], x, y, z, sx, sy, sz, palette: [{ id, meta, name? }], cells }`，`palette[cells[(dy * sz + dz) * sx + dx]]` 是盒子里那一格（`palette[0]` 是空）。整张超过 262,144 格时不带格子那几项，文字里写明用 `from` / `to` 分块读；草稿没有 `byHand`（发布以后才知道） |
| `find_uses { id \| fluid, meta?, way?, contains?, circuit?, page? }` | 一样东西能拿来做什么（NEI 的 U）。问的可以是物品（`id`），也可以是一种流体（`fluid`：中文名、英文名或注册名；这时 `data` 里是 `fluid: { fluid, name, en? }` 而不是 `item`）。`circuit` 只要设这个编程电路号的配方：加工方式 + 输入里的一样东西 + 电路号，就是“这台机器现在在做哪条”。只给 id/meta：`{ item: { id, meta, name }, total, ways: [{ way, name, recipes }] }`（`way` 是可以回填给 `way` 参数的写法）。给了 `way` / `contains` / `circuit` / `page`：`{ item, total, page, pages, recipes: [{ recipe, way, in: [{ id, meta?, name, count } 或 { ore, name, count } 或 { any, name, count }], out: [{ id, meta, name, count, chance? }], fluidsIn?, fluidsOut?, eut?, ticks? }] }`（`count` 为 0 的原料是放进去但不消耗的）。它在凿子的某个组里（或者带着那个组认的矿辞名）时多一项 `chisel: [{ group, ore?, member, variants: [{ id, meta, name }] }]`：能凿成的全部变体；`way: "凿子"` 的文字是一行一种 |
| `list_quest_lines { player? }` | 任务书各章和进度。`data`：`{ quests, player?, lines: [{ name, en?, quests, complete?, available? }], unclaimed? }`（进度那几项要看得到某个玩家的进度才有） |
| `probe_block { x, y, z }` | 现在能不能挖这一格、用哪件工具、要多久、这一格要什么工具。`data` 是身体 `bot.probe` 的原样回答：`{ id, meta, …, canDig, digTicks, toolSlot, inReach, needs: { tool?, level?, toolRequired }, candidates: [{ slot, item, harvest, strength, ticks, level?, classes?, excluded? }] }`（见 `docs/PROTOCOL.md` 的 `bot.probe`） |
| `check_blueprint { name, x, y, z, x1?…z2?, only?, skip?, clear? }` | 世界和图纸对比，什么都不动。`data` 是身体 `blueprint.check` 的原样回答：`{ name, origin, box, cells, done, toPlace, byHand, blocked, extra, willRemove, unloaded?, materials: [{ id, meta, name, need, have }], byHandBlocks, blockedBy, extraBlocks, layers }` |
| `haul_items { from, to, items?, queue? }` | 在两个容器之间来回搬（任务）。只能在例程里调，等任务结束才返回：`data` 是 `{ task, state, result?, error? }` |
| `read_blocks { x1, y1, z1, x2, y2, z2 }` | 世界里一个盒子的全部方块（每边最多 64）。`data`：`{ x, y, z, sx, sy, sz, palette: [{ id, meta, name? }], cells, unloaded }`，盒子从 `(x, y, z)` 起，`palette[cells[(dy * sz + dz) * sx + dx]]` 是那一格（`palette[0]` 是空气） |
| `find_structure { name \| id, meta, tier?, from? }` | 一台多方块机器怎么搭（`name` 认中文名，也认物品表里这台主机的英文名）：等级、每级的尺寸和材料、机器自己的结构说明、相邻两级差什么。`tier` 看一级，`from` + `tier` 看两级之差。`data`：`{ id, meta, name, tiers, rows: [{ tiers, size, blocks }] }` |
| `check_structure { at, tier, id?, meta? }` | 把世界里 `at` 那台主机周围的方块和它 `tier` 级的搭法对一遍（四个水平朝向都试，取对得最上的；机器零件占着机械方块的位置算对）。`data`：`{ machine, tier, facing, looksLike, total, right, changes: [{ x, y, z, from, to }], need: [{ id, meta, name, count, carried, stored, short }] }` |
| `total_materials { id \| fluid, meta?, count?, recipes?: [#…], chisel?: [{ id, meta?, from: { id, meta? } }], stock?, from? }` | 做一样东西，整棵树要什么、先干哪些（流体也算：目标本身也可以是流体，`count` 是 mB）。每样要做的东西用哪条配方按这个先后定：`recipes` 里点名的（`chisel` 是“用凿子从同组另一种变来”的一步，不是配方、没有编号，一换一，凿子不算消耗）→ 基地的做法里给这样东西记的配方 → 当现成的就不往下做 → 它这一类零件的做法 → 两种做法用的料一样时用哪种 → 总的先后 → 只有一条配方（没得选）→ 都不是就不展开、列进 `undecided`。流体只有点名或者记了配方的才往下做。库存（默认看）先扣掉，只把缺的往下算；接着管道、漏斗的容器里的另记、不计入；机器里的不算；`stock: false` 从零算。数量沿树相乘，一轮出几个按轮数取整，模具和工具只算一个。活儿清单放不下时 `from` 接着列。 | `summary: { toMake, waves, byMethods, named, onlyRecipe, undecided, missing, stock: 'used' \| 'off' \| 'unknown' }`，`undecided: [{ id\|ore\|fluid…, name, count, needed, inStorage?, ways: [{ way, recipe, text, more, state }] }]`，`missing: [{ …, count, needed, why: 'ready' \| 'none' \| 'loop' \| 'unfit' \| 'cannot run' \| 'limit', inStorage?, places?, automated? }]`（`ready` 是基地的做法说它当现成的），`jobs: [{ recipe \| chisel, way, rounds, makes: { …, count }, needed, rule: 'named' \| 'thing' \| 'part' \| 'same' \| 'order' \| 'only', method?, wave, level, fromStock?, waitsOn? }]`（照“哪一批、哪种做法”排；`steps` 是同样的东西、先做的在前），`raw`、`kept`、`fluids: [{ fluid, name, mb }]`、`stocked`（用了库存的那些）、`stale?`（基地的做法里记的配方在配方册里没了）、`unused`（点了名没用到的配方号） |
| `view_area { x1…z2 \| radius, view?, from?, layer? }`（模型不能看图时） | 世界里一个盒子的文字说明：范围、各种方块各多少、一层层各有什么。`data`：`{ x, y, z, sx, sy, sz, unloaded, kinds: [{ id, meta, name?, count }] }` |
| `view_image { name }`（模型不能看图时） | 主人传的一张图片的文字说明：尺寸、透明的占多少、主要颜色。`data`：`{ name, width, height, transparent（0–1）, colors: ["颜色名 百分比"] }` |

**`data` 里的名字。** 全局一个规矩：凡是带 `id` 的东西（物品、方块、容器、机器），`name` 是游戏里看到的中文名（和文字结果里的、和主人说的是同一个叫法），身体给的英文原名在 `en` 里。没有本地物品表、或者这样东西表里查不到时，`name` 还是身体给的英文名，没有 `en`。本来不带名字的条目（只有 `id`、`meta`、`count` 的清单项）不添字段。换名字的地方只有一处（`tools/format.ts` 的 `dataWithLocalNames`，`runTool` 和例程等任务结束的那一步都过它），所以每个工具的 `data` 都是这个规矩。

`find_recipes`（在工具清单里）的 `data`：平时没有；查的东西在凿子的某个组里时是 `{ item: { id, meta, name }, chisel: [{ group, ore?, member, variants }] }`。它和 `find_uses` 一样可以给 `fluid` 代替 `id`、给 `circuit` 筛。

**流体的名字**是同一个规矩：罐（`tanks: [{ fluid, name, amount, capacity }]`，`inspect_block`、`list_containers`、`find_machines` 的 `data` 里都有）的 `name` 是游戏里的中文名，身体给的英文名在 `en`；多方块的输入输出仓上是 `fluidName`（中文）和 `fluidEn`（英文）。`fluid` 是注册名，和配方册里的写法一样。本地资料里查不到的流体，名字原样是身体给的。

**界面**：`open_screen`、`click_slot`、`use_control`（干活线的工具，例程里能调）的 `data` 是身体给的界面原样：`{ open, screen, slotCount, slots: [{ slot, own?, item?, takesNothing?, takes?, ghost? }], cursor?, controls?: [{ panel, key, kind, value?, open?, options?, readOnly?, fluid?, name?, amount?, capacity?, fills?, drains?, label? }] }`。`controls` 是界面上格子以外的东西（开关、数字、文字、选项、页签、流体格、按钮），`panel` 和 `key` 是界面自己起的名字，原样交回给 `use_control`。`takes` 是只收某些东西的格子收你身上的哪几种。`press_key` 的 `data` 是身体 `bot.key` 的原样回答（`{ key, screen?, changed?, said? }`，见 `docs/PROTOCOL.md`）；不给 `key` 时是 `{ keys, clientOnly }`。

**任务书的按钮**：`quest_book`（干活线的工具，例程里能调）的 `data` 是身体 `quest.submit` / `quest.check` / `quest.claim` 的原样回答（`{ pressed, quest: { id, name, state, was? }, tasks?, tasksDone?, lost?, gained?, dropped?, xp?, alsoComplete?, why?, choices?, note?, party? }`，见 `docs/PROTOCOL.md` 的“任务书的按钮”；里面的 `task`、`reward`、`choice` 从 0 数），带 `choice` 领奖时多一个 `chosen`，等过任务书标完成时多一个 `settled`（`{ state, ms }`，没等到是 `null`）。

**放下就走的加工**：`process_items` 带 `leave: true` 时任务在机器开工后就结束，`data.result` 是 `{ put, left: true, machine?, circuit?: { now, was, setBack? }, notPut?, inputSlots?, freeSlots }`（`machine` 是那一刻机器的状态，带 `progress` / `maxProgress`，单位 tick；身体读不懂的机器没有这一项），没有 `outputs`。产物留在机器里，之后 `withdraw_items` 取。`setBack` 是这一批做完后身体把电路改回 `was`（到时候来一条事件，例程不用管）。

**产物是流体的加工**：例程里 `await tool("process_items", …)` 等到任务结束，`data.result` 里除了 `put`、`outputs`（这时是空的）还有 `fluids`：机器的罐（`[{ fluid, name, en?, amount, capacity }]`）或者多方块的输出仓（`[{ x, y, z, kind, capacity, fluid?, fluidName?, fluidEn?, amount? }]`）现在有什么。

**覆盖板**在同一批 `data` 里是 `covers: [{ side, id, meta, name, screen, slots?, usedSlots?, items?, moreKinds? }]`；`find_in_storage` 的存放点带 `kind: "cover"`、`cover`、`side`。

**物品的提示文字**：`find_item`（在工具清单里）的 `data` 是 `{ total, page, pages, items: [{ id, meta, name, en?, ores?, tooltip?: { tip, shift?, ctrl? } }] }`。`tooltip` 是玩家把鼠标放到这件物品上看到的那几行：`tip` 是不按键时的，`shift`、`ctrl` 是按住那个键时换成的另一版；不管这一页有几个物品，程序里拿到的都是全的（文字结果里只在物品不超过 5 个时带）。`find_item` 的 `tip` 参数按提示里的字找物品。见 `docs/PACKDATA.md` 的“物品的提示文字 · 大脑怎么用”。

**游戏内指南**：`read_guide`（在工具清单里，两条线都有）在程序里一样调。读一页（`{ path }`）的 `data` 是 `{ path, book, title, lang, english?, parent?, author?, date?, items?, quests?, children, sections: [{ level, title, offset }], text }`，`text` 是整页读成字以后的正文，不受单个结果上限的限制；目录（`{ book }`）是 `{ book, pages: [{ path, book, title, lang, english?, parent?, items? }] }`；搜索（`{ query }`）是 `{ matched, hits: [{ path, title, …, score, snippet? }] }`；按物品（`{ id, meta? }`）是 `{ pages: […] }`。怎么读成字的见 `docs/PACKDATA.md` 的“游戏内指南 · 大脑怎么用”。

**一个方块自己存的全部数据**：`inspect_block { x, y, z, detail: true }`（在工具清单里）的 `data` 多 `class`、`says`（它对扫描器自报的那几行话）、`saved`（它存档里的全部数据，键是内部名字，值原样；`path` 只看其中一部分）。这两项在 `data` 里一个字不改（不换中文名），所以程序可以写个循环把一片机器的某个设置扫一遍：`(await tool("inspect_block", { x, y, z, detail: true })).data.saved.lockedFluidName`。

合并掉的旧名字（程序里照样能调）：`list_blueprints`、`list_drafts`、`list_images`（现在是 `list_designs`，`data` 是 `{ blueprints?, drafts?, images? }`）；`set_home`、`list_homes`、`join_team`（现在是 `run_command`：发一条服务器指令，`data` 是 `{ command, output: [回显的每一行] }`。能发哪些由身体的允许列表定，协议里没有读这份列表的接口，所以被拒绝时结果里写明原因和默认的列表）。

**加一个库函数**：写成一个 `Tool`（`brain/src/tools/structures.ts` 是例子），放进 `LIBRARY_TOOLS`，写上 `brief`（索引里的那一行，尽量短：整份索引有 2200 字符的上限，有测试看着；真正的闸是清单总大小那条测试）和结构化的 `data`，把 `data` 的形状补进上面这张表和 `routines` 手册。只查不动的自动进 `QUERY_TOOLS`；会开任务的要另外登记在 `LIBRARY_TASKS`（那样它只能在例程里调）。`test/tool-list.test.ts` 里有一条防回涨的测试：发给模型的工具清单总字符数超过上限就失败，并列出各工具的大小——往 `ALL_TOOLS` 里加东西之前先想能不能做成库函数。

**程序里看长结果。** `return` 的值最多和一个工具结果一样长（跟“单个工具结果上限”那个设置走），更长的只给开头，并写明一共多少字符、给了多少、剩下的怎么拿（从 `r.data` 里挑、用工具自己的筛选和翻页参数、分段返回 `r.text`）。同一条路上别的会截短的地方也都写明：程序的日志满了（4000 字符）、例程只留最近 40 行日志和最近 12 次调用（每次只留结果的第一行）、报错的话超过 1000 字符。

按场景的示例程序在手册里：`routines`（一样样搬东西；库函数各自的参数和 `data`）、`multiblocks`（这台多方块升到某一级要换什么——取结构、读世界、试朝向、列差异、对库存）。手册里这两段示例程序都有测试照抄着跑一遍；手册里出现的每一个 `tool("名字", …)` 也有测试看着它确实调得到。

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
| 总时长（等工具结果的时间算在内） | `run_program` 90 秒；例程默认 120 分钟、最多 720（主人在面板上可改） | 大脑把子进程杀掉 |
| JS 堆 | 256 MiB（`--max-old-space-size`） | V8 自己中止子进程 |
| 常驻内存（大数组不在 JS 堆里） | 512 MiB | 大脑每 25 毫秒看一次 `/proc/<pid>/statm`，超了就杀。**只在 Linux 上有** |
| 标准输出（草稿从这里回来） | 16 MiB | 杀掉 |
| 日志 | 4000 字符 | 截断，并写明后面有多少条没留下 |
| 返回值 | 和“单个工具结果上限”一样（默认 20000 字符） | 只给开头，并写明一共多少、给了多少、剩下的怎么拿 |

程序交回来的草稿当作不可信的 JSON，在大脑这边逐项检查（`brain/src/design/draft.ts`：名字不能带路径、尺寸和格子数要对得上、方块写法要合规）过了才落盘。

### 保证什么（都有测试，`brain/test/design.test.ts`）

- 程序死循环、吃光内存、狂打日志、把自己弄崩，都只是这一次 `run_program`（或这个例程）失败并说明原因；大脑进程不受影响，下一个程序照常跑。
- 程序的正常写法里没有读写文件、起进程、联网的入口：`fetch`、`XMLHttpRequest`、`WebSocket`、`require`、`import()`、`process`、`eval`、`Function` 都没有或者用不了；`run_program` 里定时器也用不了，例程里的 `setTimeout` 只是请大脑等一会儿（宿主那边没有替它跑的回调，回调在上下文里面由 API 自己调）。
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
例程能动世界，但能做的就是模型本来能做的那些（搬东西、挖、放、合成、说话），只是做得快、一口气做得多：调用次数不设上限，一个写错的循环会一直做到时长用完、连着失败 3 次或者有人把它停掉为止（每秒最多 20 次调用，开任务的调用要等任务做完，实际慢得多）。所以它的防线和模型自己干活是同一套——主人名单、手册里“先问”的规矩、面板上随时能停——**没有“例程启动前要主人点头”这一道**。要不要加，是该由主人定的事。

想要真正的隔离，得靠操作系统：让沙箱子进程跑在另一个系统用户下，或者放进容器 / 没有网络的命名空间。这台机器上不要特权做不到（`unshare -n`、`bwrap --unshare-net` 都被 Ubuntu 24.04 的 AppArmor 拦了），所以没有做。

## 代码在哪

```
brain/src/script/sandbox.ts     起子进程、各项上限、把结果拿回来
brain/src/script/runner.mjs     子进程入口：收紧自己、建 vm 上下文、跑程序、报结果（纯 JavaScript 的 ES 模块）
brain/src/script/prelude.js     程序能用的 API，在 vm 上下文里求值（纯 JavaScript）
brain/src/design/               草稿的检查和存取、文字预览、.schematic、PNG 解码、图片存取
brain/src/agent/routine.ts      例程：程序调工具时怎么执行、怎么等任务、各项上限、怎么结束
brain/src/agent/run-log.ts      程序每次运行的记录：每一步的全量写进 logs/runs/，对话日志里一条滚动更新的汇总加出错的那几步
brain/src/tools/design.ts       run_program、例程的三个工具、list_designs、草稿的三个工具（view_draft 加 picture 可以把草稿画成图，加 blueprint 看的是服务器上的图纸）
brain/src/tools/index.ts        工具、库函数、旧名字三层；发给模型的清单（按模型能不能看图）；库函数的索引
brain/src/tools/pictures.ts     看图的工具：view_area（世界）、view_image（主人传的图片）
brain/src/render/               简图：把草稿、世界里的一块地方按方块颜色画成 PNG（见 brain/README.md 的“看图”）
brain/src/packdata/blocks.ts    方块颜色表和内置的小表
brain/manuals/design.md         给模型看的手册：出设计
brain/manuals/routines.md       给模型看的手册：程序调工具、例程
```
