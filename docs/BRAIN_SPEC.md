# 大脑服务（brain/）实现规格

先读 `docs/ARCHITECTURE.md` 和 `docs/PROTOCOL.md`。本文件只说大脑这一侧。

## 背景

GTNH（Minecraft 1.7.10）服务器里有一个由 mod 生成的 AI 玩家（“身体”）。大脑是一个独立后台进程：
听游戏里的聊天和任务事件，调用大模型做决策，通过 bridge 协议指挥身体，并提供网页面板让主人配置模型服务和 API key。

主人的明确要求：

1. **agent 循环和模型调用必须分开**，按正经项目的方式分层。
2. 同时支持 **OpenAI 兼容接口** 和 **Anthropic 兼容接口**，以后加别家不麻烦。
3. 面板里能配置模型服务地址、API key、模型名。
4. 日常用途：主人在或不在时，让它平地、盖建筑、搬运材料。服务器允许随意 `/sethome` 和 `/home` 传送。

## 技术约束

- Node 24（本机 `/home/luziyi/.nvm/versions/node/v24.22.1/bin/node`），TypeScript 由 Node 原生执行，不设编译步骤。
  因此只用可擦除语法：不用 `enum`、参数属性、`namespace`；相对导入写 `.ts` 后缀。`tsconfig.json` 开 `strict`、`erasableSyntaxOnly`、`allowImportingTsExtensions`、`noEmit`。
- **运行时零依赖**：只用 `node:http` `node:net` `node:fs` `node:crypto` `node:test` 和内置 `fetch`。开发依赖只有 `typescript` 和 `@types/node`（装包走环境变量里的代理）。
- 面板前端是手写的静态 HTML/CSS/JS，没有构建工具和框架。界面文字用中文。
- 所有运行期数据放在数据目录（默认 `brain/data/`，可用环境变量 `AIPLAYER_DATA_DIR` 改）。目录权限 700，文件 600。
- 只改 `brain/` 下的文件。不要运行任何 git 命令（提交由我来做）。
- 不要寻找或使用这台机器上任何现有的 API key，不要请求真实的模型接口；模型调用一律用自己写的模拟 HTTP 服务测试。
- 这台机器上有正在运行的正式游戏服务器（端口 10086 / 25575），不要连接它。测试只连你自己的模拟 bridge。

## 目录

```
brain/
  package.json  tsconfig.json  README.md
  aiplayer-brain.service        # systemd 用户服务模板（不要安装）
  src/
    main.ts                     # 组装并启动
    llm/                        # 模型调用层
    agent/                      # agent 循环
    tools/                      # 模型可用的工具
    bridge/                     # 协议客户端
    panel/                      # HTTP API + 静态页面（panel/public/）
    store/                      # 配置、记忆、历史落盘
  test/                         # node:test，含模拟 bridge 和模拟模型服务
```

## 模型调用层 `llm/`

对外只暴露统一类型和一个接口。它不知道 Minecraft，也不知道 agent。

```ts
type Message =
  | { role: 'user'; content: (TextPart | ToolResultPart)[] }
  | { role: 'assistant'; content: (TextPart | ToolCallPart | OpaquePart)[] }

interface TextPart       { type: 'text'; text: string }
interface ToolCallPart   { type: 'tool_call'; id: string; name: string; input: unknown }
interface ToolResultPart { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
// 某一家特有、必须原样回传的内容（例如 Anthropic 的 thinking 块）。只回放给产生它的同一种适配器，其他适配器丢弃。
interface OpaquePart     { type: 'opaque'; provider: string; data: unknown }

interface ToolSpec { name: string; description: string; inputSchema: object /* JSON Schema */ }

interface GenerateRequest {
  system: string
  messages: Message[]
  tools: ToolSpec[]
  toolChoice?: 'auto' | 'required' | 'none'
  maxOutputTokens?: number
  temperature?: number
  signal?: AbortSignal
}
interface GenerateResult {
  message: Extract<Message, { role: 'assistant' }>
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'other'
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  model: string
}
interface LlmClient { generate(req: GenerateRequest): Promise<GenerateResult> }
```

服务商配置（面板里可增删改，多条并存，选一条为当前使用）：

```ts
interface ProviderConfig {
  id: string; label: string
  kind: 'openai-chat' | 'anthropic-messages'
  baseUrl: string            // openai-chat 例: https://api.openai.com/v1   anthropic-messages 例: https://api.anthropic.com
  apiKey: string
  model: string
  maxOutputTokens?: number; temperature?: number; timeoutMs?: number
  extraHeaders?: Record<string, string>
  extraBody?: Record<string, unknown>   // 浅合并进请求体，用来传各家特有参数
  options?: Record<string, unknown>     // 适配器自己的开关，见下
}
```

适配器：

- `openai-chat`：`POST {baseUrl}/chat/completions`，`Authorization: Bearer`。工具用 `tools:[{type:'function',function:{…}}]`，工具结果用 `role:'tool'`。
  开关：`maxTokensField`（`max_tokens` 默认 / `max_completion_tokens`）、`systemRole`（`system` 默认 / `developer`）。
  工具参数的 JSON 解析失败时不要抛错：把这次调用标记出来，让 agent 以错误工具结果回给模型重试。
  响应里若有 `reasoning_content` 之类的额外字段，存成 OpaquePart；是否回传由开关 `replayReasoning` 决定（默认否）。
- `anthropic-messages`：`POST {baseUrl}/v1/messages`，头 `anthropic-version: 2023-06-01`。
  开关：`authStyle`（`x-api-key` 默认 / `bearer`，后者给第三方网关用）、`promptCaching`（默认开：给 system 和最后一个工具定义加 `cache_control`）。
  `thinking` / `redacted_thinking` 块必须存成 OpaquePart 并在后续请求里原样、原位置回传，否则带思考的工具循环会被接口拒绝。
  连续的同角色消息要合并，工具结果必须紧跟对应的工具调用，这些格式约束在适配器里保证。
- 新增一家 = 加一个文件并在注册表登记。写一段 README 说明怎么加。

共用部分：

- 统一错误 `LlmError { kind: 'auth'|'rate_limit'|'overloaded'|'bad_request'|'context_length'|'network'|'timeout'|'server'|'aborted'; status?; retryable; message }`。
- `withRetry` 包装：只对 retryable 的错误指数退避重试，尊重 `Retry-After`，可被 AbortSignal 打断。
- 非流式请求即可（游戏里没有逐字显示的需要）。
- `testConnection(config)`：发一个最小请求，给面板的“测试连接”按钮用，返回成功/失败原因和耗时。
- 每次调用的用量交给一个回调，由上层记账。

## agent 循环 `agent/`

事件驱动，不是阻塞式循环。一个 bot 一个 Agent 实例。

- **输入事件**：聊天、私聊、任务结束（`task.update` 的 done/failed/canceled）、bot 受伤/死亡/上线、玩家进出、面板发来的指令、定时提醒。
- **唤醒策略**（纯函数，单独可测）：哪些事件触发一轮决策。
  - 聊天：提到 bot 的名字或别名时触发；或者该玩家刚和 bot 对话过（可配置的窗口，默认 60 秒）。可配置为“所有聊天都触发”。
  - 可配置“主人名单”：非空时只有名单里的玩家能指挥；其他人的话只作为背景。
  - 私聊、任务结束、面板指令、提醒：总是触发。
  - 不触发的事件进入“最近发生的事”缓冲，下一轮一并给模型看。
- **一轮决策**：把待处理事件格式化成一条 user 消息（附当前状态快照：位置、血量、背包摘要、当前任务和队列、在线玩家、游戏内时间）→ 调模型 → 顺序执行工具调用 → 结果回给模型 → 直到模型不再调用工具或达到步数上限（默认 60，可设到 500）。
  - 同一时刻只跑一轮。每一步的工具结果凑齐后、下一次调模型前，这期间新到的会触发决策的事件接在工具结果后面一起给模型（格式同“需要你处理的事”，说话的带站位和指向），算进这一轮：一起落盘、不另开一轮。模型不再调工具、这一轮要结束时又到的事件，照旧在本轮结束后合并成下一轮。
  - 任务是异步的：启动任务的工具立刻返回“已开始”；任务结束事件会再次唤醒它（它那一轮还在进行时，接在当时那一步后面）。提示词里要讲清这一点。
- **说话**：玩家只能看到 bot 用 `say` 工具说的话。模型最后的纯文本不进聊天，只记入日志。
  兜底：如果这一轮是被聊天/私聊/面板指令触发的，模型全程没调用 `say` 却给了最终文本，就把这段文本（截断到 200 字）说出去。
- **历史与压缩**：历史落盘。估算 token（字符数/3 即可）超过阈值时，把较早的部分用一次不带工具的模型调用压成摘要。只在整轮的边界上切，保证工具调用和结果成对。过长的旧工具结果先截断。
- **记忆**：模型通过工具读写的持久笔记（键 → 文本），每轮放进提示词，有总长度上限。地点（home 名字和用途）也记在这里。
- **限制**：每轮步数上限；可选的每日 token 上限（0 为不限）；模型接口连续失败时停止重试并在聊天里说一次（限频），接口恢复后自动继续。
- **系统提示词**：默认人设是一个在服务器里一起玩的伙伴，中文，简短口语。要写清：它是生存模式的玩家；动手靠任务；任务失败码各自该怎么办（见协议）；不确定区域或高度时先 `scan_area` 或问人；不要动别人的箱子和机器。面板里可改，可恢复默认。

## 工具 `tools/`

每个工具：`{ name, description, inputSchema, run(ctx, input) }`。`description` 用英文，简短准确。
工具结果是给模型看的紧凑文本或 JSON，超长截断并说明。bridge 返回错误或任务参数不合法时，以 `isError` 结果回给模型。

第一版工具：

| 工具 | 对应 |
|---|---|
| `say(message)` `whisper(player, message)` | `bot.chat` / `bot.command "tell …"` |
| `get_status()` | `bot.status`，背包按物品合并 |
| `look_around(radius?)` | 合并 `world.entities` + `world.containers`（只给摘要）+ 周围地形摘要 |
| `scan_area(x1,z1,x2,z2)` | `world.scan`。区域 ≤ 24×24 时给完整高度网格，否则给高度直方图和降采样网格 |
| `inspect_block(x,y,z)` `find_blocks(ids, radius?)` `list_containers(radius?)` | 同名 world 方法 |
| `get_player_position(player)` | 从 `server.info` |
| `go_to` `go_to_player` `follow_player` `go_home(name)` | 任务 `goto` `goto_player` `follow` `home` |
| `set_home(name)` `list_homes()` | `bot.command`（指令字符串集中定义在一个常量文件里，方便以后按服务器实际情况改） |
| `flatten_area` `clear_area` `fill_area` `dig_blocks` `place_blocks` | 同名任务 |
| `deposit_items` `withdraw_items` `haul_items` `collect_items` | 同名任务 |
| `task_status()` `cancel_task(id?)` | `task.list` / `task.cancel` |
| `remember(key, text)` `forget(key)` | 记忆 |
| `set_reminder(minutes, note)` | 到点产生一个提醒事件，落盘，进程重启不丢 |

任务类工具都带可选参数 `queue: boolean`（对应 `mode: "append"`）。

上面是第一版的清单，留着当记录。现在的工具分三层：发给模型的工具、不发给模型而在它写的程序里调的**库函数**、合并掉的工具的**旧名字**（`set_home` / `list_homes` 现在是通用的 `run_command`，`haul_items` 是库函数……）；看图的工具只发给能看图的模型。现在的清单见 `brain/README.md` 的“工具一览”，三层怎么分、库函数各给什么见 `docs/SCRIPTS.md` 的“库函数”。

## bridge 客户端 `bridge/`

- 连接、`hello`、断线指数退避重连、带 `serverEpoch` + `lastSeq` 续传（落盘）、请求超时、事件分发。
- 口令来源：配置里直接写，或给一个口令文件路径（默认指向测试服的 `config/aiplayer/bridge-token.txt`，路径可配）。
- 协议里的方法做成有类型的薄封装。

## 面板 `panel/`

- 默认监听 `127.0.0.1:28765`，地址和端口可配（环境变量和配置文件）。
- 访问口令：首次启动随机生成，打印到标准输出并存入配置。登录后发 HttpOnly、SameSite=Strict 的会话 cookie。除登录外所有 API 需要会话，写操作校验 `Origin`。
- **API key 只写不读**：接口永远不返回完整 key，只返回掩码（如 `sk-…abcd`）和“已设置”标记；提交空值表示不修改。
- 界面围绕“这一个 AI 玩家”来组织（一个大脑 = 一个玩家），不是能管好几个玩家的样子。深色，中文；不引任何外部资源。
- **常驻的状态区**（宽屏在左边，窄于 940 像素时在顶上）：
  - 玩家卡：名字、在不在线、位置、血量和饱食度、上线 / 下线。
  - “全部停下”：有东西在跑时是实心的警示色；点了以后说明停了什么。先调 `POST /api/work/stop`，后端没有这个接口（404）时退回“停例程 + 取消全部任务”。
  - 每条线一张状态卡，照 `GET /api/status` 的 `agents` 数组画（现在一项 `main`；两条线时是 `talk`、`work`，见 `docs/TALK_WORK.md`）：模型的状态（空闲 / 正在想第几步、已几秒 / 在执行工具 / 接口故障）、这条线用的模型（卡上直接换）、第几轮第几步。管身体的那条线下面再挂两行：**例程**（哪个在跑、多久、调了多少次，可停）和**身体**（正在做的任务、进度条、排队的，可取消）；它提了问还没人回答（`waitingAnswer`）时有一块醒目的。
  - “可能卡住了”是面板自己判断的：模型一步超过 90 秒、身体任务的进度 120 秒没动，标黄，悬停写着依据。
  - 导航：现在 · 对话 · 知识 · 建造 · 设置。再下面是游戏连接和今日用量。
- 页面：
  - **现在**：一句话的现状；正在跑的那一轮（起因、已经几步多久、上一步调了什么、现在这一步）；等回答的问题全文和“去回答”；例程的实时计数和正在等的那一步；身体任务的进度和排队；最近几步；一行输入框。右边是游戏里的它：心和鸡腿、位置朝向、**物品栏**（和游戏里一样的格子：盔甲、背包 9×3、快捷栏，手持的有白框，数量、耐久条，悬停或聚焦显示中文名、英文名、id/meta）、开着的界面的格子、别的玩家（远近和方位）、脚下的俯视图。
  - **对话**：一条时间线分左右两道、一行行对齐。左边“说了什么”：玩家的话、它的话、主人在面板上说的（对话线自己的那几步也在这边，画得很省）。右边“干了什么”：一轮 → 模型的每一步（用时、token）→ 这一步调的工具（收着时是读得懂的一句：物品写中文名，位置写坐标；点开是参数和结果全文）；它写的程序的一次运行是一块汇总（跑着时实时更新，点开读每一步的明细）。两条线之间的往来（`relay`）是横跨两边的一条。一轮默认收成一行，最新的一轮开着。三档：只看对话 / 加上模型的决策 / 全部（再加游戏事件和说明）。往上翻到头自动取更早的；不在底部时有“回到最新”；底部输入框（只有它看得到，不进游戏聊天）。窄于 760 像素时两道叠成一列。
  - **知识**：记忆（查看、改、删、新增）· 手册（默认的、你改过的、你写的、它自己写的；改默认手册存的是你的一份，可以恢复默认）· 意见簿（按类别和状态筛、看详情、标已处理、导出）。导航上的数字是意见簿里没看过的条数。
  - **建造**：草稿（三维预览和四种简图、材料、生成它的程序、发布到游戏、删除）· 图纸（服务器上的：上传、删除、看材料）· 图片（上传、删除）· 多方块结构（按名字搜，每一级的材料和三维预览）。
  - **设置**：模型（每条线用哪个；服务商和它下面的模型的增删改、测试连接、从接口拉模型列表）· 玩家（上线 / 下线、无敌、会饿；名字、别名、主人名单、什么时候回应聊天；人设提示词）· 上限 · 游戏连接 · 面板口令 · 历史和提醒（清空对话历史、今日用量、删提醒）。
- 前端是 `panel/public/` 下的一组 ES 模块，浏览器直接加载，没有构建步骤：
  `app.js`（登录、框架、换页）、`side.js`（状态区）、`data.js`（定时取状态）、`logstore.js`（日志：SSE 加往上翻）、`logmodel.js`（**日志条目 → 时间线**，纯函数；条目长什么样只有它知道，新旧两种形状都认）、`logview.js`（把时间线画出来）、`items.js`（物品格子、心和鸡腿）、`names.js`（物品中文名）、`page-*.js`（五页）、`viewer3d.js`（三维预览）、`ui.js`（小工具）。
- 窄窗口（游戏开在旁边）、键盘（都是真的按钮和表单控件，格子可以 Tab 到）也能用。

### 面板的数据接口

界面要的数据都从这几处来（实现在 `panel/data-api.ts`、`store/activity-log.ts`、`agent/run-log.ts`）。前端只管显示；这里定的是字段。

**1. 日志条目**（`GET /api/log`、SSE `GET /api/events`）。原有字段：`id`、`time`、`kind`、`text`，可选的 `who`、`detail`、`isError`、`turn`、`pictures`、`scenes`。另有这些可选字段：

| 字段 | 出现在 | 含义 |
|---|---|---|
| `agent` | 任何条目 | 哪个代理的；不带就是主代理（以后它开的帮手各有各的名字） |
| `step` | `model_call`、`model_text`、模型直接调的 `tool_call` / `tool_result` | 这一轮的第几次模型调用（从 1 起），和 `turn` 一起定位 |
| `source` | `tool_call`、`tool_result`、`run`、例程开始和结束的那两条 | 谁发起的：`model`（模型自己）、`program`（`run_program` 的程序）、`routine`（后台的例程） |
| `runId` | 属于某次程序运行的条目 | `r3`（例程）、`p12`（程序）。每次大脑重启从 1 重新数，唯一的是 `run.file` |
| `run` | `kind: "run"`，例程开始和结束的那两条 | 这次运行的快照，见下 |
| `call` | `kind: "model_call"` | 这次模型调用的账，见下 |

`kind` 在原来那些之外多两种，**这两种会原地更新**：SSE 里收到一条数据里的 `id` 是已经有的，就是同一条的新样子，替换掉原来那条；之后再拉日志拿到的也是新样子。更新的那一帧不带 SSE 自己的 `id:` 行（只有 `data:`），所以浏览器断线重连用的 `Last-Event-ID` 一直是最新那条的。

- **`model_call`**：一次模型调用一条。开始想的时候就出现（`call.state: "thinking"`），回来或出错时改成结果。

  ```jsonc
  { "id": 812, "time": 1731300000000, "kind": "model_call", "turn": 12, "step": 3,
    "text": "第 3 步：11.8 秒，输入 181204（缓存命中 176900） / 输出 412 token，要调 2 个工具",
    "call": { "state": "done",            // thinking | done | failed
              "purpose": "turn",          // turn：一轮里的一步；compact：压缩历史的那次调用（没有 step）
              "step": 3, "startedAt": 1731300000000, "ms": 11820,
              "model": "claude-…",        // 接口回的模型名
              "inputTokens": 181204,      // 已含缓存读写的部分
              "outputTokens": 412,
              "cacheReadTokens": 176900, "cacheWriteTokens": 4100,   // 接口给了才有
              "stop": "tool_calls",       // tool_calls 要调工具 | end 说完了 | truncated 被输出上限截断 | other | error
              "toolCalls": 2 } }
  ```

  `thinking` 时只有 `state`、`purpose`、`step`、`startedAt`。`failed` 时 `stop` 是 `error`，带 `errorKind`（`auth`、`timeout`、`server`、`context_length`、`aborted`……）和 `error`（原话），条目 `isError: true`。

- **`run`**：它写的程序的一次运行一条汇总，跑着的时候更新（最快一秒一次），结束时定稿。例程调工具**不再每次记两条**：只有出错的那一步另有一条 `tool_result`（`isError`、`source`、`runId`，`text` 以 `[例程 r3 #12]` 开头，`detail` 是参数和结果全文）。

  ```jsonc
  { "id": 830, "time": 1731300100000, "kind": "run", "source": "routine", "runId": "r3",
    "text": "例程 r3（整理抽屉）：在跑，已调 312 次工具，开了 150 个任务，0 次出错，64 秒；正在等 withdraw_items {…}",
    "run": { "id": "r3", "kind": "routine",       // routine | program
             "name": "整理抽屉",
             "status": "running",                 // running | done | failed | stopped | limit
             "startedAt": 1731300100000,          // 结束后多一项 endedAt
             "calls": 312, "tasks": 150, "errors": 0,
             "waiting": "withdraw_items {\"container\":…}",   // 正等着的那一步；结束后没有
             "file": "routine-20261111-153012-r3.jsonl" } }   // 明细在哪个文件（见第 3 条）
  ```

  例程另有开始、结束各一条（`kind` 是 `info`，没跑完的结束是 `error`），带 `source: "routine"`、`runId` 和当时的 `run` 快照；开始那条的 `detail` 是程序全文，结束那条的 `detail` 是交给模型的那段总结。`run_program` 的程序只有那条 `run`，一次工具都没调的不出现。大脑正常停下时例程会被停掉，那条 `run` 定稿成 `stopped`；进程被强杀的话它停在 `running`，没有结束的那一条。

**2. 翻页。** `id` 跨重启单调递增，可以当游标。

- `GET /api/log?after=<id>&limit=<n>`（默认 300，最多 500）→ `{ entries, more }`：`id` 大于 `after` 的里面**最新的** n 条，按时间顺序；`more` 是 `after` 和 `entries[0]` 之间还有没给的。不带参数就是最新的 300 条。
- `GET /api/log?before=<id>&limit=<n>` → `{ entries, more }`：紧挨在 `id` 之前的 n 条，按时间顺序；内存里（最近 500 条）不够就读按天存的文件（留 14 天）。`more: false` 是到头了。往上翻就一直用这一页第一条的 `id`。
- SSE `GET /api/events?after=<id>`：先补发 `id` 大于 `after` 的最近 300 条，之后实时推。

**3. 程序运行的明细**（数据目录 `logs/runs/`，一次运行一个文件，留最近 300 次）。

- `GET /api/runs?limit=<n>` → `{ runs: [{ file, id, kind, name, status, startedAt, endedAt?, calls, tasks, errors }] }`，新的在前。
- `GET /api/runs/records?file=<run.file>&after=<行号，默认 0>&limit=<n，默认 200，最多 1000>` → `{ file, total, next, records }`。也可以给 `id=r3`，取这个编号最近的一次。`next` 是下一页的 `after`；还在跑的运行文件在长，拿 `next` 接着读就是新追加的。`records` 一行一条：

  ```jsonc
  { "t": "start", "time": 1731300100000, "id": "r3", "kind": "routine", "name": "整理抽屉", "code": "程序全文" }
  { "t": "call",  "time": 1731300100050, "n": 1, "tool": "list_drawers", "input": { "x": 1, "y": 64, "z": 1 },
    "ok": true, "text": "结果全文（超过 2 万字符截并写明）", "ms": 35, "task": "t12" }   // task：这一步开了任务时才有
    // 一次运行的记录写过 20 MiB 以后，成功的结果只留开头 400 字符，并多一项 "textLength"（原来多长）；出错的照样留全
  { "t": "log",   "time": 1731300100060, "text": "slots below 128: 2" }                    // 程序自己 log 的一行
  { "t": "end",   "time": 1731300164000, "status": "done", "ending": "the program finished", "calls": 4, "tasks": 3, "errors": 0, "value": "47" }
  ```

**4. 状态** `GET /api/status`（不缓存，可以一秒一拉；`/api/overview` 原样保留）。三样分开：模型、例程、身体。

```jsonc
{ "time": 1731300000000,
  "agents": [ {
    "agent": "main", "name": "Alu",
    "model": { "state": "thinking",                    // idle | thinking | tools | outage
               "provider": "Anthropic", "model": "claude-…",        // 现在配置用的
               "turn": 12, "step": 3, "since": 1731300000000, "purpose": "turn",
               "lastCall": { "time": 1731299990000, "ok": true, "durationMs": 11820, "model": "claude-…",
                             "inputTokens": 181204, "outputTokens": 412, "cacheReadTokens": 176900 } },
    "turn": { "id": 12, "startedAt": 1731299950000, "steps": 2, "maxSteps": 60 },
    "pending": 0,
    "routine": { "id": "r3", "name": "整理抽屉", "status": "running", "startedAt": 1731300100000,
                 "calls": 312, "tasks": 150, "errors": 0,
                 "waiting": "withdraw_items {…}", "waitingSince": 1731300160000, "waitingTask": "t151",
                 "limitMs": 7200000, "file": "routine-20261111-153012-r3.jsonl" },
    "lastRoutine": null,
    "body": { "online": true,
              "task": { "id": "t151", "type": "withdraw", "state": "running", "progress": { "done": 3, "total": 8 }, "startedAt": 1731300160000 },
              "queue": [ { "id": "t152", "type": "craft", "state": "queued" } ] }
  } ] }
```

- `model.state`：`idle` 没有在跑的一轮；`thinking` 模型调用进行中（带 `turn`、`step`、`since`、`purpose`）；`tools` 这一轮没完、正在执行它要的工具（带 `turn`、`step`）；`outage` 模型接口故障、过一阵再试。有故障时（不管当时是哪个状态）带 `outage: { failures, since, nextRetryAt, lastError }`。
- `turn`：正在跑的一轮，`steps` 是已经完成的模型调用次数；没有是 `null`。`pending`：排着队还没处理的事件数。
- `routine`：正在跑的例程，没有是 `null`；`lastRoutine` 是上一个结束的（多 `endedAt`、`ending`）。停它是 `POST /api/routine/stop`。
- `body`：`task` 是身体正在做的任务（`progress` 身体给了才有），`queue` 是排队的。连不上身体时是 `{ "online": false, "task": null, "queue": [], "error": "…" }`。取消是 `POST /api/tasks/cancel`。
- **`agents` 是数组**：现在只有 `main` 一项；以后每个帮手一项，各有自己的 `model`、`turn`、`routine`，日志条目用 `agent` 字段对上。界面别写死成只有一个模型。

**5. 图纸里有什么** `GET /api/blueprints/read?name=<名字>&draft=<0|1>&cells=<0|1>` → 和库函数 `read_blueprint` 的 `data` 同一个形状（见 `docs/SCRIPTS.md`）：`{ name, source, size: { x, y, z }, blocks, materials: [{ id, meta, name, count, item?, byHand? }] }`；`cells=1` 才带 `x y z sx sy sz palette cells`。`draft=1` 读它的草稿。没有这张图纸是 502（身体的原话），没有这张草稿是 404。

**6. 游戏里的它** `GET /api/live`（“现在”页和状态区的玩家卡用，实现在 `panel/live.ts`）。只读；同一秒里问几次只问身体一次。

```jsonc
{ "time": 1731300000000, "name": "Alu", "connected": true, "online": true,
  "dim": 0, "pos": { "x": -521.5, "y": 69, "z": 43.5 }, "block": { "x": -522, "y": 69, "z": 43 }, "yaw": -160, "pitch": 8,
  "onGround": true, "inWater": false, "health": 17, "maxHealth": 20, "food": 15, "xpLevel": 7,
  "heldSlot": 0, "freeSlots": 7, "settings": { "invulnerable": true, "hunger": false },
  "inventory": [ { "slot": 0, "item": { "id": "TConstruct:pickaxe", "meta": 0, "count": 1, "name": "钢镐", "en": "Steel Pickaxe",
                                         "durability": 0.83, "look": { "icon": 13038 } } } ],   // slot 0–8 快捷栏，9–35 背包
  "armor": [ null, null, null, { "id": "minecraft:iron_helmet", "name": "铁头盔", "look": { "icon": 314 } } ],   // 0 靴子 … 3 头盔
  "screen": { "name": "ContainerChisel", "slotCount": 97, "cursor": null,
              "slots": [ { "slot": 0, "takesNothing": true, "item": { } }, { "slot": 62, "own": true, "item": { } } ] },   // 没开界面是 null
  "players": [ { "name": "阿露", "isBot": false, "dim": 0, "dist": 6.4, "dx": 4, "dy": 0, "dz": -5 } ],   // 同一个维度的按远近排；别的维度 dist 是 null
  "world": { "dayTime": 3000, "isDay": true, "raining": false, "tps": 20 },
  "looks": { "icons": { "cell": 32, "columns": 64, "rows": 64, "sheets": [ "/api/icons/sheet?n=0&v=…" ] },   // 没有图集是 null
             "textures": { "url": "/api/textures/atlas.png?v=…", "tile": 16, "columns": 64, "rows": 86 } } }
```

- `name` 是本地物品表的中文名，查不到是身体给的英文名，再没有是 id；`en` 是身体给的名字（和 `name` 不同时才有）。只靠附加数据区分的物品（匠魂、GregTech 的工具）名字以身体给的为准。
- `look` 是这样东西的图标怎么画，按这个顺序找：`{ "icon": n }` 物品图标图集里的第 n 个（见 `docs/PACKDATA.md` 的“物品图标”）；`{ "tex": n, "tint"? }` 它是方块，方块贴图图集里的第 n 格；`{ "color": [r,g,b], "known": true }` 颜色表里的方块；`{ "color", "known": false }` 都不是，颜色由 id 算出来，只为了区分（面板画成色块加名字的头一个字）。
- 没连上游戏、它不在线时也是 200：`{ "connected", "online": false, "reason"? }`。有任务在跑时身体不让看界面，`screen` 是 `null`。
- 物品图标图集的图：`GET /api/icons/sheet?n=<第几张>`（地址里带着版本，可以让浏览器一直留着）。大脑头一次用到时读 `icons/icons.json` 并核对 `count` 和 `itemsSha1`（对不上就当没有图标）；运行期间说明文件被换过（重新导出了）也当没有，直到重启——行号对不上了，宁可没图也不能错位。

**7. 脚下的俯视图** `GET /api/minimap?radius=<4–31，默认 24>` → `{ available, x1, z1, width, depth, palette: [{ id, name, color, known, liquid? }], tops, heights, unloaded, self: { x, y, z, yaw }, players: [{ name, x, z, isBot }] }`。`tops` / `heights` 一行行排（下标 = z * width + x）：那一列地表是调色板里的第几种、多高（没有是 -1）。看不到时 `{ available: false, reason }`。

**8. 物品的中文名** `GET /api/items/names?q=<逗号隔开的 id/meta，最多 200 个>` → `{ names: { "minecraft:dirt/0": "泥土" } }`，只回查得到的。

## 测试

用 `node:test`。命令：`npm test`、`npm run typecheck`。

- **模拟 bridge**：实现协议的服务端，可脚本化地推事件、让任务按设定结束。也能独立运行（`npm run mock-bridge`），方便手动看面板。
- **模拟模型服务**：同时会说 OpenAI chat 和 Anthropic messages 两种线格式，按脚本回应。
- 至少覆盖：两个适配器的请求/响应翻译（文本、多工具调用、工具结果、思考块回传、错误分类）；重试；agent 的工具循环、步数上限、事件排队合并、唤醒策略、历史压缩不拆散工具对；bridge 重连与续传；面板的鉴权和 key 掩码。
- 最后做一次端到端：模拟 bridge + 模拟模型服务 + 真实启动 `main.ts`，从一条聊天事件走到任务启动、任务结束再唤醒、`say` 回话。

## 交付

- `node src/main.ts` 能启动；README 写清怎么跑、数据目录里有什么、怎么加新的模型适配器。
- 最终回复按“发现了什么 / 做了什么、对我意味着什么、建议”来写：结构概览、验证了什么（给出命令和结果）、没做或没验证的部分、你认为协议里需要改的地方。
- 协议有疑问或发现缺口时，先按最合理的理解做下去，把问题列在最终回复里；只有被彻底卡住才中途问我。
