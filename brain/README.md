# 大脑服务（brain/）

GTNH 服务器里那个 AI 玩家的“大脑”：一个独立的后台进程。它听游戏里的聊天和任务事件，调用大模型做决定，
通过 bridge 协议（`docs/PROTOCOL.md`）指挥游戏里的“身体”（`mod/`），并提供一个网页面板来配置模型和查看状况。

改提示词、换模型、改决策逻辑都只动这个进程，不用重启游戏。

## 怎么跑

需要 Node 24（本机：`/home/luziyi/.nvm/versions/node/v24.22.1/bin/node`）。TypeScript 由 Node 直接执行，没有编译步骤，运行时没有任何依赖。

```sh
cd brain
node src/main.ts          # 或 npm start
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

它等于 `AIPLAYER_PANEL_HOST=0.0.0.0 AIPLAYER_DATA_DIR=data/testserver AIPLAYER_BRIDGE_PORT=25591 AIPLAYER_BRIDGE_TOKEN_FILE=../testserver/config/aiplayer/bridge-token.txt node src/main.ts`。
数据目录是单独的 `brain/data/testserver/`，所以测试服上的记忆、对话历史、续传位置不会和正式运行的（`brain/data/`）混在一起；模型服务商和面板口令两边各配各的。

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `AIPLAYER_DATA_DIR` | 数据目录（相对路径相对 `brain/`） | `brain/data/` |
| `AIPLAYER_PANEL_HOST` / `AIPLAYER_PANEL_PORT` | 面板监听地址 | `127.0.0.1` / `28765` |
| `AIPLAYER_BRIDGE_HOST` / `AIPLAYER_BRIDGE_PORT` | 身体的 bridge 地址 | `127.0.0.1` / `25590` |
| `AIPLAYER_BRIDGE_TOKEN_FILE` | bridge 口令文件（相对路径相对 `brain/`） | 无，不配就不连 |
| `AIPLAYER_BRIDGE_TOKEN` | 直接给 bridge 口令（优先于文件） | – |

环境变量优先于 `config.json`，而且不会写回文件；被环境变量盖住的项，面板“设置”页会标出来。面板自己的监听地址和 bridge 的主机只能在 `config.json`（`panel`、`bridge` 两节）或环境变量里改，改完要重启大脑。

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
| `config.json` | 面板口令、bridge 地址、bot 的名字/别名/主人/人设/上限、所有服务商配置（**含 API key 明文**） | 回到初始状态，重新生成口令 |
| `memory.json` | 它自己记的笔记（键 → 文本） | 它忘掉地点和长期要求 |
| `history.json` | 对话历史（按“轮”存）和更早部分的摘要 | 它不记得聊过什么、做到哪一步 |
| `usage.json` | 每天的调用次数和 token 数（留 90 天） | 今日用量归零 |
| `reminders.json` | 它给自己定的、还没到点的提醒 | 提醒丢失 |
| `bridge-state.json` | 上次见到的 `serverEpoch` 和 `lastSeq`，断线续传用 | 下次连接不补发错过的事件 |
| `agent-state.json` | 它启动后还没结束的任务 id、已处理过的任务结束、已排队但没处理完的事件 | 重启时正排着队的事会丢 |
| `manuals/*.md` | 你在面板“手册”页写的手册，和你改过的默认手册（同名的盖住 `brain/manuals/` 里默认的那本） | 你写的手册没了；改过的默认手册恢复成默认的 |
| `logs/activity-YYYY-MM-DD.jsonl` | 面板“对话”页的日志（聊天、模型文本、工具调用和结果、错误），留 14 天 | 面板上看不到之前的记录 |

## 面板

默认 `http://127.0.0.1:28765/`，只监听本机；把 `AIPLAYER_PANEL_HOST` 设成 `0.0.0.0`（`npm run dev:testserver` 和 systemd 模板已经这样设）后，局域网里用 `http://这台机器的地址:28765/` 打开。八个页面：

- **概览**：bridge 连接状态、bot 的位置/血量/背包、当前任务和队列（可取消）、当前模型和最近一次调用结果、今日用量、提醒、清空对话历史。
- **对话**：实时日志（聊天、它说的话、模型的文本、工具调用和结果、错误）；下面的输入框以主人身份直接给它下指令（只有它看得到，不进游戏聊天）。
- **模型**：服务商增删改、选当前使用的、测试连接。改完立刻生效。
- **AI 玩家**：名字、别名、主人名单、什么时候回应聊天、各项上限、人设提示词（也就是核心提示词，可恢复默认）；上线/下线；无敌和饥饿开关（“会饿”打开后它会饿死，因为它不会吃东西）。上线、下线的选择会被记住；它被踢下线也算“下线”，要回来得有人在这里点“上线”。
- **记忆**：查看、编辑、删除它的笔记。
- **手册**：看每本手册的名字、“什么时候看”那一句和正文；改默认手册（存下来的是你的一份，随时可以“恢复默认”）；新写、改名、删除自己的手册（比如“基地布局”“材料仓库在哪”）。改完立刻生效：它下次要用时读到的就是新的。
- **图纸**：列出游戏服务器上的图纸（Schematica 的 `.schematic` 文件：名字、尺寸、方块数，读不了的显示原因），上传本地文件（最大 2 MiB，同名覆盖），删除。图纸存在游戏服务器的 `config/aiplayer/schematics/` 里，面板只是经 bridge 转手，所以要连着游戏才能用；文件是不是能用的图纸由身体判断。
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
  agent/           agent 循环：收事件、决定要不要叫醒模型、跑一轮决策、压缩历史。不发 HTTP，不碰 socket
  tools/           模型能用的工具：名字、参数 schema、执行函数。只调 bridge，不含策略
  bridge/          协议客户端：连接、握手、重连续传、请求超时、事件分发；协议方法的有类型封装
  panel/           面板的 HTTP API 和静态页面（panel/public/，手写的 HTML/CSS/JS）
  store/           配置、记忆、历史、用量、提醒、活动日志、手册的落盘
manuals/           随代码发布的默认手册（Markdown，一类活一本）
test/              node:test；模拟 bridge（mock-bridge.ts）和模拟模型服务（mock-llm.ts）
```

依赖方向：`main` → `panel` / `agent` → `tools` → `bridge`；`agent` → `llm`；谁都可以用 `store`。`llm/` 不导入其他任何一层。

### 提示词和手册

每次调模型的系统提示词 = **核心提示词** + 程序生成的几节（手册目录、名字、主人、记忆）。

- 核心提示词（`agent/prompt.ts` 的 `DEFAULT_PERSONA`，一千三百字左右）只放任何时候都用得上的：它是谁、怎么说话和汇报、任务怎么运作、底线。面板“AI 玩家”页的“人设提示词”改的就是它；自定义过的照旧整段替换默认的，后面那几节照样附上。
- 各类活具体怎么做写在**手册**里：`brain/manuals/*.md` 是默认的（`blueprint` 照图纸盖、`crafting` 办目标、`containers` 箱子和抽屉、`terrain` 地形活、`travel` 走路和传送、`quests` 任务书、`failures` 失败和重启），数据目录的 `manuals/` 是主人写的，同名时主人的盖住默认的。文件第一行是一句“什么时候看这本”，其余是正文。
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
     options: [],                                  // 适配器自己的开关；面板会按这里的说明自动画出表单
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

写适配器时注意：

- `postJson` 已经处理了超时、打断，并把失败归成统一的 `LlmError`（auth / rate_limit / overloaded / bad_request / context_length / network / timeout / server / aborted）。重试、用量回调由 `createClient` 统一包在外面，适配器里不用管。
- 这家特有、下次必须原样带回的内容（思考块之类）存成 `{ type: 'opaque', provider: MY_KIND, data }`，放在它原来的位置。
- 工具参数解析失败时不要抛错：返回 `{ type: 'tool_call', …, input: {}, invalid: { reason, raw } }`，agent 会回一个错误结果让模型重试。
- 用量的口径：`inputTokens` 是输入 token 的总数，**包含**缓存读写的部分。
- 给它写一份像 `test/llm-openai.test.ts` 那样的测试：`test/mock-llm.ts` 是个真的 HTTP 服务，加一种线格式就能用。

现有两个适配器的开关见各自文件开头的注释（`openai-chat`：`maxTokensField`、`systemRole`、`replayReasoning`；`anthropic-messages`：`authStyle`、`promptCaching`、`cacheConversation`）。

## 测试

```sh
npm test            # node:test，约 10 秒
npm run typecheck   # tsc --noEmit
```

- `test/mock-bridge.ts`：按协议实现的服务端，代替游戏里的 mod。测试里可以推事件、让任务按设定结束、断开连接、模拟服务器重启、让 bot 死亡或被踢。它的行为（响应里有哪些字段、事件和响应谁先谁后、指令的回显、任务结果的形状）是对着测试服上的真实 mod 校对过的；世界本身是假的。
  图纸那部分（`blueprint.list/check/put/remove` 和 `blueprint` 任务）是照协议和 mod 的源码写的，还没有对着测试服校对过：它读得了真的 `.schematic` 文件，拿假地形逐格对比，任务“做完”时按背包和 `supply` 里的材料算结果（不够就是 `no_material`）；够不着、没工具、背包满这些情况不模拟。
  物品、配方、库存那部分（`item.search`、`recipe.find`、`world.stock` 和 `craft` 任务）同样是照协议和 mod 的源码写的、没对着测试服校对过：一本十来种物品的假配方书（`defaultRecipeBook()`，够走一遍“做一个 Copter Blades”），`withdraw` 和 `craft` 会真的增减箱子和背包里的东西；`recipesReady = false` 时前两个方法返回 `busy`。`world.machines` 和 `process` 任务也在这部分：机器有电、空闲、等级够、给的原料凑得出它的一条配方（不带流体）才开工，否则像真实 mod 那样以 `invalid` 失败并带上机器状态。
  任务书（`quest.lines/search/get`）也是照协议和 mod 的源码写的：两章六个任务，自带 Steve 的进度；`questBook = undefined` 就是服务器没装任务书。
- `test/mock-llm.ts`：一个 HTTP 服务，同时会说 OpenAI chat completions 和 Anthropic messages 两种线格式，按脚本回应。它像真实接口那样拒绝格式不对的请求（工具调用没有紧跟结果、角色不交替等，回 400），所以适配器漏了整理、历史压缩把配对拆散时，测试会失败。
- `test/e2e.test.ts`：模拟 bridge + 模拟模型 + 真实启动 `src/main.ts` 子进程，像主人那样登录面板、配模型、让 bot 上线，然后从一条聊天走到任务启动、任务结束再唤醒、`say` 回话。

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
- 任务书只能查（`list_quest_lines` / `find_quests` / `get_quest`）：它替不了谁提交任务或领奖励。
- 机器只会用 GregTech 的单方块加工机器（`find_machines` / `process_items`）：多方块机器、蒸汽机器、别的 mod 的机器和原版熔炉用不了；配方要流体的，得机器已经接好流体。
