# 大脑服务（brain/）

GTNH 服务器里那个 AI 玩家的“大脑”：一个独立的后台进程。它听游戏里的聊天和任务事件，调用大模型做决定，
通过 bridge 协议（`docs/PROTOCOL.md`）指挥游戏里的“身体”（`mod/`），并提供一个网页面板来配置模型和查看状况。

改提示词、换模型、改决策逻辑都只动这个进程，不用重启游戏。

## 怎么跑

需要 Node 24（本机：`/home/luziyi/.nvm/versions/node/v24.22.1/bin/node`）。TypeScript 由 Node 直接执行，没有编译步骤，运行时没有任何依赖。

```sh
cd brain
npm start                 # 等于 node --disable-sigusr1 src/main.ts
```

首次启动会在标准输出打印面板地址和随机生成的访问口令：

```
[panel] 面板地址：http://127.0.0.1:28765/
[panel] 首次启动，已生成面板访问口令：xxxxxxxxxxxxxxxxxxxxxxxx
```

之后打开面板 → “设置”页填 bridge 的口令文件 → “模型”页添加服务商并测试连接 → “AI 玩家”页点“上线”。面板口令可以在“设置”页改；忘了就看 `data/config.json` 里的 `panel.password`，直接改这个值也行（改完旧的登录全部失效）。

`npm install` 只在要跑类型检查时才需要（装 `typescript` 和 `@types/node`）。

### 连哪个游戏

默认值按正式部署来：bridge 端口 `25590`，**口令文件没有默认值**。没配口令文件时大脑不去连游戏（也不重试、不刷日志），面板概览页写着“还没配置 bridge 口令文件”。
配置的办法二选一：面板“设置”页填端口和口令文件路径（存进 `config.json`，保存后立刻按新的设置重连），或者用环境变量（优先于面板上填的）。

口令文件是游戏服务器目录下的 `config/aiplayer/bridge-token.txt`，mod 首次启动时生成。配了但读不到、或者连不上时，大脑照常运行并自己重试，面板上写明原因。

**开发时连测试服**（端口 25591，口令文件在 `../testserver/`）用现成的入口：

```sh
npm run dev:testserver
```

它等于 `AIPLAYER_PANEL_HOST=0.0.0.0 AIPLAYER_DATA_DIR=data/testserver AIPLAYER_BRIDGE_PORT=25591 AIPLAYER_BRIDGE_TOKEN_FILE=../testserver/config/aiplayer/bridge-token.txt node --disable-sigusr1 src/main.ts`。
数据目录是单独的 `brain/data/testserver/`，所以测试服上的记忆、对话历史、续传位置不会和正式运行的（`brain/data/`）混在一起；模型服务商和面板口令两边各配各的。

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `AIPLAYER_DATA_DIR` | 数据目录（相对路径相对 `brain/`） | `brain/data/` |
| `AIPLAYER_PANEL_HOST` / `AIPLAYER_PANEL_PORT` | 面板监听地址 | `127.0.0.1` / `28765` |
| `AIPLAYER_BRIDGE_HOST` / `AIPLAYER_BRIDGE_PORT` | 身体的 bridge 地址 | `127.0.0.1` / `25590` |
| `AIPLAYER_BRIDGE_TOKEN_FILE` | bridge 口令文件（相对路径相对 `brain/`） | 无，不配就不连 |
| `AIPLAYER_BRIDGE_TOKEN` | 直接给 bridge 口令（优先于文件） | – |
| `AIPLAYER_PACKDATA` | 本地资料（任务书、物品表、配方册等）的目录（相对路径相对 `brain/`） | `brain/packdata/` |

环境变量优先于 `config.json`，而且不会写回文件；被环境变量盖住的项，面板“设置”页会标出来。面板自己的监听地址和 bridge 的主机只能在 `config.json`（`panel`、`bridge` 两节）或环境变量里改，改完要重启大脑。

### 本地资料（任务书、物品表、配方册）

不随游戏进行变化的内容，大脑读本地的一份中文资料（`brain/packdata/`，不进 git），不问服务器：

| 资料 | 文件 | 谁用 | 没有时 |
|---|---|---|---|
| 任务书 | `quests.jsonl` `questlines.json` | `list_quest_lines` / `find_quests` / `get_quest`；只有“谁做完了哪些”问服务器 | 这三个工具改问服务器（英文） |
| 物品表（中英文名、矿辞名） | `items.jsonl` | `find_item`；服务器回来的东西（背包、箱子、机器、任务结果、主人指着的方块）凡是带 id 的，给模型看时都换成中文名 | `find_item` 改问服务器（只认英文名），名字都是英文 |
| 配方册（NEI 里的全部配方） | `recipes.jsonl` `handlers.json` | `find_recipes`（NEI 的 R）、`find_uses`（NEI 的 U）、`craft_item` / `process_items` 按配方编号干活 | `find_recipes` 改问服务器（英文、每种机器只给前几条），`find_uses` 用不了，合成用服务器自己知道的配方 |
| 方块颜色表、贴图 | `blocks.jsonl` `textures/` | 像素画配色、简图上色、面板的三维预览 | 内置的 16 色羊毛和 16 色染色粘土；三维预览按颜色画 |

```sh
tools/make-packdata.py quests --client <客户端包.zip> --out brain/packdata    # 任务书。在仓库根目录执行，不到一秒
tools/export-packdata                                                        # 物品表、配方册、方块颜色表：从一个真的客户端里导出，十来分钟，见 docs/PACKDATA.md
```

大脑启动时读一次（日志里 `[packdata]` 开头的几行说读到了什么），所以重新生成后要重启大脑。目录不在、文件不全时照常启动，缺哪样哪样就按上表的最后一列办。文件格式见 `docs/PACKDATA.md`。

配方册有三十万条、一百来兆：启动时从头读一遍，只在内存里留索引（每条配方在文件里的位置、哪些配方产出某物、哪些配方用到某物），配方本身用到时才从文件里读那一行。
这个整合包实测：建索引 0.9 秒，整个大脑从启动到面板可用 1.2 秒（没有本地资料时 0.2 秒）；进程常驻内存 360 MB 左右（没有本地资料时 100 MB），其中留在 JS 堆里的是一百兆上下（配方索引约 30 MB，任务书、物品表和方块表约 40 MB，第一次找物品时建的搜索表约 20 MB），其余是读文件时冲高、V8 没还给系统的部分。
一条配方的编号（`find_recipes` 里的 `#数字`）是它在 `recipes.jsonl` 里的行号：重新导出以后会变，所以编号只在当次运行里用，不要记进记忆。

有了 `blocks.jsonl` 以后可以再生成方块贴图（面板的三维预览用，没有就按颜色画）：

```sh
tools/make-packdata.py textures --client <客户端包.zip> --jar <原版 minecraft-1.7.10-client.jar> --out brain/packdata    # 四秒左右
```

资料放在别处时用环境变量 `AIPLAYER_PACKDATA` 或 `config.json` 的 `packdataDir` 指过去。

bot 的皮肤不归大脑管：服务器上的 PierceSkinRestorer 认 bot，主人在控制台执行 `skin <bot名> set <正版用户名>` 即可。

模型接口要走代理时，启动前加 `NODE_USE_ENV_PROXY=1`（Node 内置的 fetch 默认不看 `HTTP_PROXY`）。

### 不连游戏、不用真模型，先看看面板

```sh
npm run mock-bridge       # 模拟身体，127.0.0.1:25600，口令 mock-token，带一个在线的 Alu、一个箱子、一组抽屉、一个工作台、一张图纸 hut、一本小配方书、一本六个任务的任务书、两台 GT 机器（一台有电的车床、一台没电的组装机）
npm run mock-llm          # 模拟模型，127.0.0.1:25601，只认“平 / 跟 / 停 / 看看”几个字
AIPLAYER_DATA_DIR=/tmp/aiplayer-demo AIPLAYER_BRIDGE_PORT=25600 AIPLAYER_BRIDGE_TOKEN=mock-token node src/main.ts
```

然后在面板“模型”页添加：接口类型任选，服务地址填 `http://127.0.0.1:25601/v1`（OpenAI 兼容）或 `http://127.0.0.1:25601`（Anthropic 兼容），key 和模型名随便填。
在 mock-bridge 的终端里输入 `chat Steve Alu 把这块地平一下` 就相当于有人在游戏里说话；输入 `help` 看全部指令（让任务完成或失败、玩家进出、断线、模拟服务器重启）。

**端口规矩：** 模拟服务只用 25600–25699 或系统分配的临时端口。25590、25591（真实 mod 的 bridge）和 10086、10186、25575、25576（游戏服务器和 RCON）被写死在 `test/ports.ts` 里，模拟服务拒绝在这些端口上启动。自动测试全部用临时端口。

## 数据目录里有什么

默认 `brain/data/`，目录权限 700，文件权限 600。全部是可读的 JSON，可以直接备份或删除。

| 文件 | 内容 | 删掉会怎样 |
|---|---|---|
| `config.json` | 面板口令、bridge 地址、bot 的名字/别名/主人/人设/上限、所有服务商和它们下面的模型（**含 API key 明文**）、现在用哪个 | 回到初始状态，重新生成口令 |
| `config.json.v1.bak` | 旧格式的配置（一个服务商只有一个模型）被自动转成新格式之前的原样，只留一次 | 没影响；想退回旧版本的大脑时用得上 |
| `memory.json` | 它自己记的笔记（键 → 文本） | 它忘掉地点和长期要求 |
| `history.json` | 对话历史（按“轮”存）和更早部分的摘要 | 它不记得聊过什么、做到哪一步 |
| `usage.json` | 每天的调用次数和 token 数（留 90 天） | 今日用量归零 |
| `reminders.json` | 它给自己定的、还没到点的提醒 | 提醒丢失 |
| `bridge-state.json` | 上次见到的 `serverEpoch` 和 `lastSeq`，断线续传用 | 下次连接不补发错过的事件 |
| `agent-state.json` | 它启动后还没结束的任务 id、已处理过的任务结束、已排队但没处理完的事件 | 重启时正排着队的事会丢 |
| `feedback.jsonl` | 意见簿：它自己记下的反馈。只追加不改写，一行是一件事（新记一条、同一个问题又来一次、状态改了） | 记过的反馈没了 |
| `drafts/*.json` | 图纸草稿：它自己写程序设计出来、还没发到游戏里的建筑（连同生成它的程序） | 草稿没了；已经发布到游戏里的图纸不受影响 |
| `images/*.png`、`*.rgba` | 你在面板“图纸”页传给它的图片，和解好的像素 | 它读不到这些图了 |
| `pictures/*.png`、`*.json` | 它看过的图（世界和草稿的简图、你传的图片放大后的样子），给“对话”页的日志显示用；简图旁边的 `.json` 是画它用的方块数据，三维预览用。只留最近 80 张 | 日志里那些图显示“已经清理掉了” |
| `manuals/*.md` | 你在面板“手册”页写的手册，和你改过的默认手册（同名的盖住 `brain/manuals/` 里默认的那本） | 你写的手册没了；改过的默认手册恢复成默认的 |
| `logs/activity-YYYY-MM-DD.jsonl` | 面板“对话”页的日志（聊天、模型文本、工具调用和结果、错误），留 14 天 | 面板上看不到之前的记录 |

## 面板

默认 `http://127.0.0.1:28765/`，只监听本机；把 `AIPLAYER_PANEL_HOST` 设成 `0.0.0.0`（`npm run dev:testserver` 和 systemd 模板已经这样设）后，局域网里用 `http://这台机器的地址:28765/` 打开。九个页面：

- **概览**：bridge 连接状态、bot 的位置/血量/背包、当前任务和队列（可取消）、正在跑的例程（做到第几步、最近几次工具调用和它的日志，可以点“停止例程”）、当前模型和最近一次调用结果、今日用量、提醒、清空对话历史。
- **对话**：实时日志（聊天、它说的话、模型的文本、工具调用和结果、错误）；下面的输入框以主人身份直接给它下指令（只有它看得到，不进游戏聊天）。工具结果带图的（它看了世界的一块地方、一张草稿、一张你传的图片），图直接显示在那一条下面，点开是原图：你看到的就是它看到的那张（它的模型看不了图时图也照样有）。世界和草稿的简图下面还有一个“三维预览”按钮，点开是同一块地方可以拖着转的立体图。
- **模型**：服务商（接口类型、地址、API key）和它下面的模型分开管。一个服务商可以有好几个模型，各有各的名字和设置（输出上限、温度、超时、思考相关的额外请求参数、按模型走的开关）；同一个模型可以存两份不同的设置来对比（“复制”）。模型名可以从接口拉列表来挑，拉不到就手填。每个模型都能单独测试连接。
  现在用哪个，在这里点“用这个”，或者在**页面顶上的下拉框**里直接换：不用重启，下一轮决策起生效。对话日志里每一轮开头写着用的是哪个服务商的哪个模型。
  每个模型有一个“能看图”开关，默认关。开着，它要看的图会真的发给它；关着，同样的工具只给文字说明。开着时“测试连接”会带一张小图去试，模型其实不收图的话当场就报出来。
- **AI 玩家**：名字、别名、主人名单、什么时候回应聊天、各项上限、人设提示词（也就是核心提示词，可恢复默认）；上线/下线；无敌和饥饿开关（“会饿”打开后要小心：它能吃身上的食物，但只在被叫醒、看到饱食度低时才会去吃，没人叫它时照样会饿死）。上线、下线的选择会被记住；它被踢下线也算“下线”，要回来得有人在这里点“上线”。
- **记忆**：查看、编辑、删除它的笔记。
- **手册**：看每本手册的名字、“什么时候看”那一句和正文；改默认手册（存下来的是你的一份，随时可以“恢复默认”）；新写、改名、删除自己的手册（比如“基地布局”“材料仓库在哪”）。改完立刻生效：它下次要用时读到的就是新的。
- **图纸**：三块，各管各的。
  - 草稿：它自己写程序设计出来的建筑，还只在大脑这边。列表里每张有一张小图；点“查看”先是三维预览：用游戏里的贴图，拖动旋转、滚轮缩放，滑块一层层剖开，“完整外观 / 剖开看里面 / 从正上方看”三个预设。下拉框里还有大脑画的四种简图（立体图、俯视图、立面图、一层层看），那是它自己用 `view_draft` 看到的样子。再下面是材料表和生成它的程序。你觉得行，跟它说一声，或者直接点“发布到游戏”；不要的删掉。
  - 图片：传给它做像素画、当参考的图。什么格式都行，浏览器会先缩到最长边 256 像素以内、转成 PNG 再传；聊天里跟它说图片的名字就行。
  - 服务器上的图纸：列出游戏服务器上的图纸（Schematica 的 `.schematic` 文件：名字、尺寸、方块数，读不了的显示原因），上传本地文件（最大 2 MiB，同名覆盖），删除。它们存在游戏服务器的 `config/aiplayer/schematics/` 里，面板只是经 bridge 转手，所以这一块要连着游戏才能用；草稿和图片不用。
- **意见簿**：它干活时觉得哪里有问题（没有合适的工具、工具的结果不对或看不懂、同一件事反复失败、手册和实际对不上、你让做的它做不到），会自己用 `report_problem` 记一条；大脑自动附上当时的现场（这一轮的指令原文、最近几次工具调用和结果、相关任务和失败码、大脑和 mod 的版本）。这一页列出来（新的在前，可按类别和状态筛），点开看详情，标成已处理，或者把筛出来的导出成一个 JSON 文件。导航上的数字是你还没看过的条数。
- **设置**：bridge 的端口和口令文件路径（保存后立刻重连）、修改面板口令（要先输入当前口令）。

安全方面：

- 登录后发 HttpOnly、SameSite=Strict 的会话 cookie（30 天，大脑重启不用重新登录）。除登录外所有接口都要会话；连续输错 5 次口令锁 60 秒。
- 所有写操作校验 `Origin` 必须和访问的地址同源。用 curl 之类调接口要自己带上，例如 `-H 'Origin: http://127.0.0.1:28765'`。
- **API key 只写不读**：任何接口都不返回完整的 key，只给掩码（如 `sk-…abcd`）和“已设置”标记；编辑时 key 留空表示不修改。名字里带 key/token/auth 之类的自定义请求头同样只显示掩码。
- 把服务地址改到另一台主机时必须重新填 key——否则登上面板的人可以把地址指向自己的机器把 key 套走。
- bridge 的主机不能在面板上改，口令文件的内容不像口令（多行、带空格、超长）时不会发出去——否则登上面板的人可以把路径指向别的文件、把主机指向自己的机器，把文件内容套走。
- 面板本身是明文 HTTP：对局域网开放时，面板口令和你填的 API key 在局域网里不加密。家里的网络可以接受；要经过不信任的网络访问，用 SSH 隧道或带 HTTPS 的反向代理，不要把这个端口映射到公网。

## 代码结构

```
src/
  main.ts          组装并启动
  llm/             模型调用层：统一的“消息 + 工具”请求 ↔ 各家接口。不知道 Minecraft，也不知道 agent
  agent/           agent 循环：收事件、决定要不要叫醒模型、跑一轮决策、压缩历史；例程（routine.ts：它写的程序在后台一步步调工具）。不发 HTTP，不碰 socket
  tools/           模型能用的工具：名字、参数 schema、执行函数。只调 bridge 和本地资料，不含策略
  packdata/        本地资料：读 brain/packdata/ 里的文件（任务书、物品表、配方册、方块颜色表、方块贴图的目录），建索引，回答查询。不碰 bridge
  script/          跑模型写的程序的沙箱：起受限的子进程（sandbox.ts）、子进程入口（runner.mjs）、程序能用的 API（prelude.js）
  design/          它自己出设计的家当：图纸草稿的检查和存取、文字预览、转成 .schematic、PNG 解码、主人传的图片
  render/          简图：把草稿或世界里的一块地方按方块颜色画成 PNG（等轴测、俯视、立面、分层），带说明和图例。纯软件画，不依赖任何图形库
  bridge/          协议客户端：连接、握手、重连续传、请求超时、事件分发；协议方法的有类型封装
  panel/           面板的 HTTP API 和静态页面（panel/public/，手写的 HTML/CSS/JS）
  store/           配置、记忆、历史、用量、提醒、活动日志、手册的落盘
manuals/           随代码发布的默认手册（Markdown，一类活一本）
test/              node:test；模拟 bridge（mock-bridge.ts）和模拟模型服务（mock-llm.ts）
```

依赖方向：`main` → `panel` / `agent` → `tools` → `bridge` / `packdata` / `design` / `render` → `script`；`agent` → `llm`；谁都可以用 `store`。`llm/` 和 `packdata/` 不导入其他任何一层；`render/` 只用 `packdata/` 的方块颜色表和 `design/` 的草稿类型。

`script/` 里的 `runner.mjs` 和 `prelude.js` 是纯 JavaScript：前者是沙箱子进程的入口，后者是在 `node:vm` 上下文里求值的源码，都不经过类型检查，靠 `test/design.test.ts` 管。沙箱保证什么、不保证什么，见 `docs/SCRIPTS.md`。

### 提示词和手册

每次调模型的系统提示词 = **核心提示词** + 程序生成的几节（手册目录、名字、主人、记忆）。

- 核心提示词（`agent/prompt.ts` 的 `DEFAULT_PERSONA`，一千九百字左右；有测试卡着不让它超过两千）只放任何时候都用得上的：它是谁、怎么说话和汇报、任务怎么运作、底线、什么时候往意见簿里记一条。面板“AI 玩家”页的“人设提示词”改的就是它；自定义过的照旧整段替换默认的，后面那几节照样附上。
- 各类活具体怎么做写在**手册**里：`brain/manuals/*.md` 是默认的（`blueprint` 照图纸盖、`crafting` 查配方挑做法办目标、`containers` 看仓库和存取、`inventory` 用身上的东西和随身的包、`routines` 写程序调工具、`terrain` 地形活、`travel` 走路和传送、`quests` 任务书、`design` 自己写程序出设计、`pictures` 看图、`failures` 失败和重启），数据目录的 `manuals/` 是主人写的，同名时主人的盖住默认的。文件第一行是一句“什么时候看这本”，其余是正文。
- 提示词里只列每本手册的名字和那一句；模型要干那类事时用 `read_manual` 读整本（`list_manuals` 列目录）。手册整本给模型，不受“单个工具结果上限”截断，所以正文有自己的上限（8000 字符）。
- 每一轮的“当前状态”里有一行写明哪几本手册的原文现在还在对话历史里。这是程序从历史里数出来的：历史压缩把较早的手册原文换成了一句“要用时重新读”的、主人后来改过内容的，都不算，模型要用时会重新读。
- 加一类新的活：在 `brain/manuals/` 里放一个 `名字.md`，第一行写什么时候看。不用改代码。

### agent 一轮是怎么跑的

1. 事件进来（聊天、私聊、任务结束、受伤、面板指令、提醒……）→ `agent/wake.ts` 的纯函数决定要不要叫醒模型。不叫醒的进“最近发生的事”，下一轮一并给模型看。
2. 被叫醒后，把待处理的事件加上当前状态快照拼成一条 user 消息 → 调模型 → 顺序执行它要的工具 → 把结果回给它 → 直到它不再调工具，或到每轮步数上限。
3. 同一时刻只跑一轮；期间到达的事件排队，本轮结束后合并成下一轮。
4. 启动任务的工具立刻返回“已开始”，模型结束这一轮；任务结束的事件再把它叫醒。bot 干活期间不花模型调用。
5. 玩家只看得到它用 `say` / `whisper` 说的话。被人叫醒却只留了文本没说话时，程序替它把文本（截到 200 字）说出去。

默认的唤醒规则和几条规格之外的保护（都在 `agent/wake.ts` 和 `agent/agent.ts`，有测试）：

- 自己取消任务、或启动新任务顶掉旧任务后收到的“任务被取消”，不再叫醒模型（否则每次都白花一次调用）。面板上取消的同理。判断依据是身体在响应里给的被取消任务的 id，加上“请求发出到响应回来之间”这段时间（身体是先发事件、后回响应的）。
- 自己执行指令的回显（身体会同时作为 `bot.message` 事件发一遍）、上线时服务器刷的那串欢迎语，不进“最近发生的事”。
- 同一个任务的结束只处理一次（按任务 id）：断线续传的重叠、重连后的对账、身体在任务一开始就失败时连发的两次 failed，都不会让模型看到两遍。
- 死亡后等两秒多（身体重生之后）再开始决策，这样模型看到的是重生后的位置和血量。
- 没有人介入的情况下任务连续失败超过 5 次，不再自动叫醒，并在聊天里说一声；有人跟它说话后恢复。
- 断线期间补发的、超过 10 分钟的旧聊天只当背景。
- bot 不在线时聊天不叫醒它（它说不了话）；面板指令照常。
- 受伤只在血量 ≤ 6 时叫醒，一分钟最多一次。

### 工具一览

现在一共 63 个工具。每个工具开头那段说明合计一万四千字符左右，连参数 schema 一起发给模型的是五万九千字符左右。细节不写在工具说明里：说明只讲这个工具给什么、要什么，怎么用好写在手册里。

| 一类 | 工具 |
|---|---|
| 说话 | `say` `whisper` |
| 看 | `get_status` `look_around` `scan_area` `view_area` `inspect_block` `probe_block` `find_blocks` `get_player_position`（站在哪、朝哪、准星指着什么、面前有哪些容器） |
| 仓库 | `list_containers`（一页页列，标出接着管道的）`list_drawers`（抽屉管理器管着的每一格）`list_stock`（一片仓库的存货总表，能筛能翻页）`find_in_storage`（某几样东西在哪） |
| 走动 | `go_to` `go_to_player` `follow_player` `go_home` `set_home` `list_homes` `join_team` |
| 地形 | `flatten_area` `clear_area` `fill_area` `dig_blocks` `place_blocks` |
| 图纸 | `list_blueprints` `check_blueprint` `build_blueprint` |
| 写程序 | `run_program`（当场跑完，只能调查询类的工具）`start_routine` `routine_status` `stop_routine`（后台例程，能调动作）`list_images` `view_image` `list_drafts` `view_draft` `publish_draft` `delete_draft` |
| 物品 | `deposit_items` `withdraw_items`（位置，或者身上的一个包）`haul_items` `collect_items` `give_items` `use_item`（拿在手里右键） |
| 制作 | `find_item` `plan_item`（把整条做法排成步骤）`find_recipes` `find_uses` `find_machines` `craft_item` `process_items` |
| 任务书 | `list_quest_lines` `find_quests` `get_quest` |
| 任务、记忆、手册、意见簿 | `task_status` `cancel_task` `remember` `forget` `set_reminder` `list_manuals` `read_manual` `report_problem` |

**看周围的工具可以换中心。** `look_around`、`find_blocks`、`list_containers`、`list_stock`、`find_in_storage`、`find_machines` 默认以它自己为中心；给 `at`（一个坐标）就以那个地方为中心看（`tools/where.ts`）。主人说的是某个地方的东西时该这么用：实测它站在五十格外、以自己为中心查了一圈没找到目标箱子，就停下来问主人要坐标了。所以以自己为中心什么都没找到时，结果里会提醒一句“可以给 at 看别处”。`view_area`、`scan_area` 本来就是给范围的，`list_drawers` 给的是抽屉管理器的坐标。

### 做法规划：plan_item

主人只说“做一个 X”时，小一点的模型查得出一层配方，却不会自己一层层往下查（实测：查到“缺硬锤和玄钢板”就汇报了，这两样其实都做得出来）。所以把“走完整棵树”这件事交给程序（`tools/planner.ts`），模型只管照着步骤调工具：

- **每样东西先看库存**（它身上，加上附近的箱子和抽屉；机器和总线里的不算），够就取，不够的那部分才往下展开。同一样东西在树上出现几次时需求加在一起算。
- **挑做法**按 crafting 手册那套规矩：只用这里现在做得了的（机器、合成台的比对和查做法是同一套）；料凑得齐的优先；手工工具配方只在没有机器做得了时用；然后是每个成品耗料少的。回收配方（把成品拆回材料）和会绕回自己的配方（锭磨成粉、粉再炼回锭）不算做法。
- **数量沿树算**：一轮出几个按轮数取整；模具、模头、工具这类不消耗的只要 1 个；编程电路不是原料，由 `process_items` 设在机器上。
- **工具**（`craftingTool…`）仓库里有任何一种就用；没有就挑一种材料现成的做一把。哪种材料都没有时不替主人挑材质，把“缺一把锤”报出来。
- **结果三块**：按先后顺序的步骤（每步是一行“工具名 + JSON 参数”，照抄就能调；先取料、再一样样做，底下写着为什么挑这种做法、还有哪些别的做法）；缺的东西（查到底以后真正没有的那几样，各缺多少、为什么做不了）；要主人先点头的事（要用的箱子、机器或输入总线接着管道，机器报维护问题，省料的做法现在用不上只能用费料的）。
- **到哪为止**：缺的东西如果它的料里一样现成的都没有（往下几层也没有），就报它本身，不再往下猜；最多展开 60 样东西、10 层，到了就说明没展开完。步骤多时一页 20 步。
- 中途失败、或者主人补了料：再调一次，它按身上和仓库里现在有的重新排。`data.steps` 是 `[{tool, input}]`，例程可以直接照着执行。
- **看的是整个基地，不是它身边那一小圈**：仓库和机器常常隔着六七十格，而身体一次查询最多看 32 到 64 格。所以机器、合成台、库存都是以它站的地方为中心、往四周错开几个点各查一次再合起来，每个方向大约看得到一百格（`recipe-book.ts` 的 `spread`；`find_recipes` 判断“基地里现在做得了”用的也是这一套）。
- 库存看两遍：先把周围的容器扫一遍得到一张粗表（最多 1200 个），用来挑材质、判断哪条路走得通；计划里真正要取的东西再向身体精确地问（`world.stock`）。真实配方册上排一个直升机桨叶（十五步）不到一秒，向身体发四五十个查询。

### 例程：它写的程序调工具

重复几十遍的活（“把抽屉管理器管着的、不到 128 个的东西都搬到这个箱子里”）不靠模型一步步调工具，而是让它写一段程序：

- `run_program`：程序在模型的这一轮里跑完，里面可以 `await tool(名字, 参数)` 调**查询类**的工具（`tools/index.ts` 的 `QUERY_TOOLS`），适合一次查很多再汇总。
- `start_routine`：程序在后台跑（“例程”），几乎所有工具都能调；会开任务的工具等任务结束才返回。模型启动它以后这一轮就结束，例程做完、出错、被停掉或者碰到上限时再把模型叫醒，带上每一步和程序的日志。
- 例程里调的每个工具和模型自己调走同一条路（`runTool`）：同样的参数校验，同样记进对话日志，面板概览页看得到进度，主人可以点“停止例程”；它正在做的任务被人取消也算叫它停下。
- 上限（`agent/routine.ts` 的 `DEFAULT_ROUTINE_LIMITS`）：总时长 30 分钟（启动时可以给到 180），最多调 400 次工具、开 150 个任务，连着 3 次工具失败就停；程序自己的计算时间 20 秒，等工具结果的时间不算在内。同一时间只跑一个。
- 例程不落盘：大脑重启时它会停下、正在做的任务被取消，重启后模型被告知它停在哪一步。
- 程序本身照旧跑在沙箱里，碰不到文件和网络，只多了“调工具”这一个口子。边界见 `docs/SCRIPTS.md`。

### 看图：简图怎么画、怎么给模型

它“看”东西靠三个工具，返回的都是一张 PNG 加一段文字说明：

| 工具 | 看什么 |
|---|---|
| `view_area` | 世界里的一个盒子（两个对角，每边最多 64 格；不给就是自己周围）。方块数据来自协议的 `world.blocks` |
| `view_draft` 加 `picture` | 一张图纸草稿（`x1`…`z2` 可以裁，比如用 `y2` 把屋顶切掉看里面） |
| `view_image` | 主人在面板上传的图片（小图放大到看得清，透明处垫灰白格子） |

简图由 `render/` 画，四种看法：`iso` 等轴测（站在四个角之一，顶面和两个侧面明暗不同）、`top` 俯视（上北下南，高处亮）、`side` 立面（站在四边之一，远处暗）、`layer` 只看一层。整张图最长边不超过 1024 像素，范围大了每格自动画小。图上有一段说明（范围、每格几个像素、朝向）和图例（色块、注册名、数量），俯视和立面带坐标刻度；自己和范围里的其他玩家标成品红和青色的记号。

这是**按方块颜色画的示意图，不是游戏画面**：没有贴图和光影，楼梯、栅栏、火把这类不是整块的方块只是画小一点，实体不画。颜色从哪来见 `docs/PACKDATA.md` 的“方块颜色”。

把图给模型看是一条通用的路，以后别的来源（比如真实截图）照着走就行：

1. 工具在结果里带 `images`（`tools/types.ts` 的 `ToolImage`：一句说明 + PNG/JPEG 的内容），同时 `content` 里要有不看图也读得懂的文字。
2. agent 把每张图存一份到数据目录的 `pictures/`（面板的对话日志显示用），然后看当前模型的“能看图”开关：开着就把图挂在这条工具结果上（`llm/types.ts` 的 `ToolResultPart.images`），关着就不挂——工具自己从 `ctx.canSeeImages()` 知道这一点，会在文字里写明“看不了图”并多给一些文字说明。
3. 适配器把图翻成各家的写法：Anthropic 兼容是 `tool_result` 内容里的图片块；OpenAI 兼容的 tool 消息只能是文字，图放在紧跟其后的一条 user 消息里（`image_url` 的 data URI）。
4. **图只在产生它的那一轮里跟着**，而且一轮里同时最多 4 张（`agent.ts` 的 `LIVE_IMAGES_MAX`，再要新的，最早的换掉）。一轮结束存进历史时，所有的图都换成一句占位文字（`[picture seen earlier, no longer attached: …]`，`llm/messages.ts`）：之后每一轮不会为同一张图再付一次钱，`history.json` 里也没有图的内容。它要再看就重新要一张。
5. 图只在模型主动调这三个工具时才有，不会自动塞进每一轮。

### 面板上的三维预览

给主人看的，不是给模型看的。`panel/public/viewer3d.js`：手写的 WebGL，没有用任何库。

- 数据：`GET /api/drafts/model?name=`（草稿）和 `GET /api/pictures/model?id=`（对话日志里的一张简图，画那张图时把方块存了一份）。格式是 `render/scene.ts` 的 `Scene`：盒子的尺寸、每一格是哪种方块（“下标, 连续几格”），每种方块怎么画——贴图在图集的第几格，或者没有贴图时的颜色，透不透，是不是整块。
- 贴图：本地资料里的图集（`docs/PACKDATA.md` 的“方块贴图”），面板从 `GET /api/textures/atlas.png` 取。颜色表里没有的常见原版方块（草方块、水、树叶、玻璃）用内置的贴图名和染色（`render/looks.ts`）；别的没有贴图的方块（机器、别的模组的非整块方块）按颜色画。没有图集时全部按颜色画。
- 文件里分两半：`buildMesh` 把盒子变成三角形（哪些面露在外面、剖到第几层、贴图坐标），是纯计算，`test/viewer3d.test.ts` 管着；`createViewer` 管画布、镜头和按钮，是在浏览器里手动看的。
- 页面上同时最多开两个（图纸页一个、对话日志里一个）：浏览器能开的 WebGL 画布有限，开新的会把旧的关掉。

### 游戏指令在哪改

`src/tools/commands.ts` 集中放着以 bot 身份执行的指令字符串（`tell`、`sethome`、`home list`、`team join`）和判断私聊有没有送到的回显样式，
按 GTNH 自带的 ServerUtilities 写的，回显都在测试服上实测过。换了指令 mod 改这一个文件。这些指令还得在身体那边的允许列表里，否则 `bot.command` 返回 `denied`。

身体对说话和指令有两条限制，工具已经照着做了：一条指令连斜杠最多 100 个字符（长的私聊会拆成几条 `tell`）；
短时间内说话加指令太多会被拒绝（`denied: too many chat lines and commands…`），这时工具告诉模型“等几秒再说”，和“这条指令不让用”分开。

## 怎么加一家新的模型接口

1. 在 `src/llm/` 下新建一个文件，导出一个 `Adapter`（类型在 `llm/types.ts`）。照着 `openai-chat.ts` 写最省事：

   ```ts
   // src/llm/my-provider.ts
   import { postJson } from './http.ts'
   import { normalizeMessages } from './messages.ts'
   import type { Adapter, GenerateRequest, GenerateResult, ProviderConfig } from './types.ts'

   export const MY_KIND = 'my-provider'

   export const myProvider: Adapter = {
     label: '面板下拉框里显示的名字',
     baseUrlExample: 'https://api.example.com/v1',
     options: [],                                  // 适配器自己的开关；面板会按这里的说明自动画出表单。scope: 'provider' 的跟着服务商，其余跟着模型
     // listModels: async (config, deps) => [...],  // 可选：问接口它有哪些模型（面板填模型名时用）
     create: (config: ProviderConfig, deps) => ({
       async generate(req: GenerateRequest): Promise<GenerateResult> {
         // normalizeMessages 已经保证：角色交替、工具结果紧跟工具调用且排在文本前、没有空内容。
         // keepOpaque 决定哪些 OpaquePart 回放——一般只留自己这一家产生的。
         const messages = normalizeMessages(req.messages, { keepOpaque: (p) => p.provider === MY_KIND })
         const { json } = await postJson({
           fetch: deps.fetch,
           url: `${config.baseUrl}/...`,
           headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}`, ...(config.extraHeaders ?? {}) },
           body: { model: config.model, /* 把 req.system / messages / req.tools 翻译成这家的格式 */ ...(config.extraBody ?? {}) },
           timeoutMs: config.timeoutMs,
           signal: req.signal,
         })
         // 把 json 翻译回 { message, stopReason, usage, model }
         throw new Error('TODO')
       },
     }),
   }
   ```

2. 在 `src/llm/registry.ts` 的 `ADAPTERS` 里加一行：`'my-provider': myProvider,`

就这两处。`ProviderKind` 类型、配置校验、面板的“接口类型”下拉框和开关表单都从这张表生成；agent 循环、面板、存储都不用改。

适配器拿到的 `ProviderConfig` 是“一家接口加一个模型”：存盘时服务商和模型是分开的（`store/config.ts` 的 `StoredProvider` / `ModelConfig`），调用前由 `resolveModel` 把服务商的地址、key、请求头和那个模型自己的设置合成一份。所以适配器不用知道一个服务商下面有几个模型。

写适配器时注意：

- `postJson` 已经处理了超时、打断，并把失败归成统一的 `LlmError`（auth / rate_limit / overloaded / bad_request / context_length / network / timeout / server / aborted）。重试、用量回调由 `createClient` 统一包在外面，适配器里不用管。
- 这家特有、下次必须原样带回的内容（思考块之类）存成 `{ type: 'opaque', provider: MY_KIND, data }`，放在它原来的位置。
- 工具参数解析失败时不要抛错：返回 `{ type: 'tool_call', …, input: {}, invalid: { reason, raw } }`，agent 会回一个错误结果让模型重试。
- 用量的口径：`inputTokens` 是输入 token 的总数，**包含**缓存读写的部分。
- 给它写一份像 `test/llm-openai.test.ts` 那样的测试：`test/mock-llm.ts` 是个真的 HTTP 服务，加一种线格式就能用。

现有两个适配器的开关见各自文件开头的注释（`openai-chat`：`maxTokensField`、`systemRole`、`replayReasoning`；`anthropic-messages`：`authStyle`、`promptCaching`、`cacheConversation`）。

## 测试

```sh
npm test            # node:test，约半分钟
npm run typecheck   # tsc --noEmit
```

- `test/mock-bridge.ts`：按协议实现的服务端，代替游戏里的 mod。测试里可以推事件、让任务按设定结束、断开连接、模拟服务器重启、让 bot 死亡或被踢。它的行为（响应里有哪些字段、事件和响应谁先谁后、指令的回显、任务结果的形状）是对着测试服上的真实 mod 校对过的；世界本身是假的。
  图纸那部分（`blueprint.list/check/put/remove` 和 `blueprint` 任务）是照协议和 mod 的源码写的，还没有对着测试服校对过：它读得了真的 `.schematic` 文件，拿假地形逐格对比，任务“做完”时按背包和 `supply` 里的材料算结果（不够就是 `no_material`）；够不着、没工具、背包满这些情况不模拟。
  物品、配方、库存那部分（`item.search`、`recipe.find`、`world.stock` 和 `craft` 任务）同样是照协议和 mod 的源码写的、没对着测试服校对过：一本十来种物品的假配方书（`defaultRecipeBook()`，够走一遍“做一个 Copter Blades”），`withdraw`、`deposit` 和 `craft` 会真的增减箱子、抽屉和背包里的东西（`craft` 的两种写法都认：按服务器的配方，和调用方给摆法的 `grid`）；
  `world.containers` 的翻页和 `attached`、`world.drawers`、`world.player` 和聊天事件里的 `speaker`、`use` 任务、随身的包当容器（`container: {item}`）也都是照协议写的，没对着测试服校对过；`recipesReady = false` 时前两个方法返回 `busy`。`world.machines` 和 `process` 任务也在这部分：机器有电、空闲、等级够、给的原料凑得出它的一条配方（不带流体）才开工，否则像真实 mod 那样以 `invalid` 失败并带上机器状态。
  任务书（`quest.lines/search/get`）也是照协议和 mod 的源码写的：两章六个任务，自带 Steve 的进度；`questBook = undefined` 就是服务器没装任务书。
  `quest.progress`（谁做完了哪些）是照约定写的，真实 mod 实现之后还没对过。
- `test/fixture-pack.ts`：一个只有任务书的小“客户端整合包”，文件形状照真实的 GTNH 客户端包抄的。`packdata.test.ts` 和一场端到端测试拿它跑 `tools/make-packdata.py`，再让大脑读生成出来的资料；这些测试要 `python3`，没有时会跳过并写明。
- `test/mock-llm.ts`：一个 HTTP 服务，同时会说 OpenAI chat completions 和 Anthropic messages 两种线格式，按脚本回应。它像真实接口那样拒绝格式不对的请求（工具调用没有紧跟结果、角色不交替等，回 400），所以适配器漏了整理、历史压缩把配对拆散时，测试会失败。
- `test/design.test.ts`：模型写的程序 → 沙箱 → 草稿 → 预览 → 发布。沙箱那几条是真的起子进程去试：死循环、吃内存、读配置文件、写文件、起进程、联网，都要被拦住而大脑没事。`.schematic` 由模拟 bridge 里那个照 mod 写的读取器读回来，另外和 `tools/make-test-schematic.py` 做的参考文件对了一遍（这一条要 `python3`）。
- `test/feedback.test.ts`：意见簿——模型在一轮里记一条时附带的现场、同一个问题合并计数、太长的裁短、密钥被抹掉、重启后还在。
- `test/fixture-recipes.ts`：一本自造的小配方册（三十来条），照着真实数据里要紧的情形造的：同一个东西几种做法耗料不同、手工工具配方、编程电路和模具、重复的和只是示意的配方、高炉炉温、同一种东西两个 id、每种材质一条的工具配方。`recipes.test.ts`（找物品、查做法、查用途、合成和加工交给身体的参数）和 `storage.test.ts`（看仓库、中文名、主人指着说）用它；测试不读 `brain/packdata/` 里真实的那份。
- `test/fixture-plan.ts`、`test/planner.test.ts`：做法规划。另一本自造的小配方册（一条四五层深的链、机器和手工两种做法、一轮出多个、不消耗的模头和工具、每种材质一条的工具、粉和锭互相变、回收配方、要流体和炉温的高炉配方、一条很长的链）和一个假基地（机器、合成台、箱子）。预期的数量是照配方手算的。同一个基地也能布置到模拟身体上，端到端那一场用它把桨叶整条链真的做一遍。
- `test/routine.test.ts`：例程——程序一步步调工具、等任务、各项上限、三种停法、大脑重启。沙箱是真的子进程。
- `test/e2e.test.ts`：模拟 bridge + 模拟模型 + 真实启动 `src/main.ts` 子进程，像主人那样登录面板、配模型、让 bot 上线，然后从一条聊天走到任务启动、任务结束再唤醒、`say` 回话。其中几场对着主人的验收用例：“做一个直升机桨叶”从规划到做成（高炉的输入总线接着漏斗，先问主人再动手）、指着箱子说“做一个直升机桨叶”（本地配方册）、“把抽屉里不到 128 个的都搬到这个箱子”（例程，程序就是 routines 手册里的那个例子）、“做一个小背包再把东西放进去”（随身的包当容器）。

`npm test` 不碰真实的模型接口，也不连这台机器上的游戏服务器。

### 对着真实 mod 联调

```sh
npm run live:testserver                         # 约 2 分半
npm run live:testserver -- --restart-server     # 最后加一场“测试服重启”，多花约 1 分钟
npm run live:testserver -- --only flatten,home  # 只跑名字里含这些词的场景
npm run live:testserver -- --transcript /tmp/live.txt   # 把每次给模型看的内容和它的回应写进文件
```

`test/live-testserver.ts` 用按脚本回应的模拟模型驱动一个真实启动的大脑进程，连测试服的 bridge（只连 25591），依次走 16 场：

1. 设 home、列 home、`probe_block`、加入一个不存在的队伍
2. 面板下指令 → 看状态和地形 → 平一小块地 → 任务结束被叫醒 → 回话
3. `clear_area` 带 `dropoff`（东西自动卸进箱子）→ 从箱子取回来 → `fill_area` 填回去
4. 传送回家
5. RCON 私聊触发 → 存进箱子再取回
6. `haul_items` 在两个箱子之间搬过去再搬回来
7. 失败或缺货后的再唤醒：`no_material`、不存在的 home（`invalid`）、withdraw 缺货（done + `missing`）、5000 格外的目标（`unreachable`）、把镐存起来再挖石头（`no_tool`）
8. `collect_items` 捡地上的东西（RCON 放一个掉落物）
9. `give_items` 送给另一个 bot，再传送回家
10. 自己取消任务 → 大脑重启续传 →（可选）测试服重启

前提：

- 测试服在运行，bot `Alu` 在线并带着匠魂镐和铲（没有就先跑 `tools/test-kit.sh Alu`）。
- 联调用的两个箱子在 `(-51,99,-87)` 和 `(-47,99,-83)`，一个空、一个有货（换地方用 `LIVE_CHESTS="x,y,z;x,y,z"`）。脚本只用这两个箱子；bot 不在它们旁边时先让它走过去，走不到就不跑。
- 第 9 步要另一个 bot（默认 `Scout`，可用 `LIVE_OTHER_BOT` 改）在线。

前提不满足的场景会标成“跳过，没有验证”，不算通过；有失败或跳过时退出码不是 0。

它会真的在世界里动手：每次在箱子东南方向那片坡上平掉一块 4×4 的不平地，来回走几十格。动过的箱子和背包都会还原，临时设的 home `braintest` 结束时会删掉，最后打印背包和箱子与开始时相比的变化（挖出来和填进去的土石、送出去的 3 个雪球会留在账上）。它不属于 `npm test`。

模拟模型服务会像真实接口那样检查每个请求的消息格式（角色交替、工具调用和结果配对），不合规的直接回 400；脚本还把历史压缩的阈值调低，让压缩在这一趟里一定发生。

## 作为后台服务运行

`aiplayer-brain.service` 是 systemd 用户服务的模板（没有安装）。要用的话：

```sh
cp aiplayer-brain.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now aiplayer-brain
journalctl --user -u aiplayer-brain -f      # 首次启动的面板口令在这里
```

停止时（SIGTERM）它会打断正在进行的一轮决策并把状态落盘；没处理完的事件下次启动接着处理。

## 已知的限制

- 历史压缩的 token 数是估的（字符数 ÷ 3），不是各家的真实计数。
- 模型调用是非流式的。
- 一个大脑进程只管一个 bot。
- 面板自己的监听地址、bridge 的主机不能在面板上改（改 `config.json` 或用环境变量）。
- 协议里的 `bot.look`、`bot.drop`、`bot.remove` 和任务 `wait` 有封装（`bridge/api.ts`）但没有做成给模型用的工具；没有删除 home 的工具。
- 随身的包（`deposit_items` / `withdraw_items` 的 `bag`）只能往里放、往外取，看不了包里现在有什么：协议里没有这个查询。
- 配方册照的是 NEI 的画面：GregTech 的页数量是准的；别的 mod 的页（“它操作不了的方式”）只供参考。配方的编号重新导出后会变。“基地里现在做得了”只看机器和工作台（每个方向一百来格以内），不看原料够不够：原料够不够、缺什么，问 `plan_item`。
- 做法规划是照规矩挑的，不是最优解：耗料只按“每个成品几个原料”粗比；别的 mod 的机器、熔炉当成做不了；库存和机器只看每个方向一百格左右、已经加载的区块；单方块机器的流体看不了，只能提出来让主人确认。
- 例程不落盘，大脑重启就停；例程在跑时模型另开任务会把它顶停。启动例程不需要主人批准（规矩写在 routines 手册里：动别人的东西、数量大的、接着管道的容器先问）。
- 任务书只能查（`list_quest_lines` / `find_quests` / `get_quest`）：它替不了谁提交任务或领奖励。读本地资料时，进度只到“这个任务做完没有、奖励领了没有”：看不到一个任务里哪几个子任务已经完成。
- 本地资料只在启动时读一次；重新生成后要重启大脑。
- 它自己出设计（`run_program` 等几个工具）：程序只做计算，动不了世界；沙箱不是对付恶意代码的硬隔离，网络没有在进程一层堵住（`docs/SCRIPTS.md` 写了真实的边界）。
- 简图和三维预览都是示意：颜色表里没有的方块（机器、别的模组的非整块方块）颜色是配的，图例里带 `?`；半砖一律画在下半格，楼梯画成整块，门、活板门不分开合，方块的朝向（原木横放、机器的正面）不分；实体和掉落物不画。给模型看的简图只用颜色，不用贴图。模型的“能看图”要主人自己在面板上开，大脑不会去探测模型到底能不能看。
- 机器只会用 GregTech 的加工机器（`find_machines` / `process_items`）：单方块的，和用普通总线、仓的多方块（原料进输入总线、产物从输出总线或它推往的箱子取，流体靠带着装满的单元倒进输入仓，或者已经接好管道）。蒸汽机器、别的 mod 的机器和原版熔炉用不了；单方块机器的流体得已经接好；流体产物取不了。
