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

- Node 24，TypeScript 由 Node 原生执行，不设编译步骤。
  因此只用可擦除语法：不用 `enum`、参数属性、`namespace`；相对导入写 `.ts` 后缀。`tsconfig.json` 开 `strict`、`erasableSyntaxOnly`、`allowImportingTsExtensions`、`noEmit`。
- **运行时零依赖**：只用 `node:http` `node:net` `node:fs` `node:crypto` `node:test` 和内置 `fetch`。开发依赖只有 `typescript` 和 `@types/node`（装包走环境变量里的代理）。
- 面板前端是手写的静态 HTML/CSS/JS，没有构建工具和框架。界面文字用中文。
- 所有运行期数据放在数据目录（默认 `brain/data/`，可用环境变量 `AIPLAYER_DATA_DIR` 改）。目录权限 700，文件 600。两条线各有历史和状态：干活线是 `history.json`、`agent-state.json`（只有一条线时的文件名，老数据原样归它），对话线是 `talk-history.json`、`talk-state.json`；两条线之间留着的事在 `lines-state.json`，聊天记录在 `chat-log.json`。
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

事件驱动，不是阻塞式循环。

**一个 bot 两条线**（设计和理由见 `docs/TALK_WORK.md`）：同一个进程里两个 Agent 实例，各有模型、对话历史和压缩、落盘的状态、事件队列、每轮步数上限、系统提示词和工具清单，互不等待。

- **对话线**（`talk`）：听人说话、回话、查资料。**它写出来的文字就是它在公共聊天里说的话**——每一步的文字在那一步返回时就说出去（和工具调用同一步时先说再调），什么都不写就是不说；没有 `say` 工具。它没有任何会动身体的工具，要动手的事用 `tell_worker` 交给干活线。
- **干活线**（`work`）：操作身体的只有它（任务、界面、例程、指令）。它不对玩家说话：中途用 `report` 汇报或提问（总是叫醒对话线）；一轮结束时留下的文字自动送给对话线——它真的停下来了（身体上没有它开的任务、没有例程在跑、没有刚到的事等它处理）才叫醒对话线，它只是在等自己的任务或例程结束时只作背景送达。
- **事件怎么分**（`agent/lines.ts` 的 `lineOf`）：聊天、悄悄话、面板指令、玩家进出、干活线送来的话 → 对话线；提醒 → 定它的那条线（`reminders.json` 里每条记着 `line`，没有这一项的是对话线定的）；任务开始和结束、受伤、系统消息、对话线交来的事 → 干活线；死亡、上线、下线两条线都收到（死亡两条线都叫醒，上线下线对两条线都只是背景）。
- **两条线之间**：`tell_worker`（这一轮里的人的原话连同站位和指向由程序原样附上）、`worker_status`、`stop_work`（一次调用取消身体的全部任务和例程、打断干活线正在进行的模型调用、放下它还没处理的事；它随后只在背景里看到“被叫停了”，不因此自己接着干）、`report`。对话线每一轮的“当前状态”里有干活线的现状：在想第几步、在等它自己开的哪个任务（类型、进度、已经多久）或例程、还是真的停着；并写着“任务或例程一结束它自己会被叫醒接着做”这个事实。话头在两条线之间连着倒了 12 次、中间没有任何外面的事时，之后的往来只作背景、不再互相叫醒（防空转）。
- **共用**：bridge、本地资料、记忆、手册、意见簿、基地的做法、工作清单、设计工作区、聊天记录、每日 token 上限（两条线合计）。
- **工作清单**（`store/todo.ts`，数据目录的 `todo.json`；工具 `todo` 两条线都有）：交代下来的事还剩哪些。每条：`id`、`text`、`state`（`open` 没做 / `waiting` 在等人 / `done`）、`waitingFor?`（等谁、等什么）、`note?`、`by`（`talk` / `work` / `owner`）、`at`、`changedBy?`、`changedAt?`、`doneAt?`。没做完的最多 100 条，做完的留最近 20 条。一次改动里有一处不对整次不做。每一轮的“当前状态”里列没做的、在等人的、最近做完的 3 条（两条线一样）。**叫醒干活线**（`agent/lines.ts`）：干活线一轮走完（没被叫停）、或者清单变了以后过 `todoNudgeMs`（3 秒），干活线没有在跑的一轮和排着的事、没有盯着的任务、例程没在跑、没有在等的回答（`links.waiting`）、身体的任务列表是空的、它在线，清单上又有 `open` 的，就给它一个 `todo` 事件（对话线正在想的时候先不给，等它想完再看：先记清单、再把事交过来是常见的两步）（`{ type: 'todo', open: [{ id, text }] }`，模型看到的是“[系统] 你停下来了（…），工作清单上还有 N 件没做完、也没标成在等人：#3 …、#5 …”）。叫过一次以后，清单上没多出 `open` 的（新加的、重新打开的；勾掉、删掉、改字、改备注都不算，主人在面板上收拾清单不把停着的它叫起来），它也没为别的事走过一轮，就不再叫；被叫停（`stop_work`、面板总停止）以后，要等它为新的事走完一轮；中间没有外面的事（`outside()`：有人说话、提醒、任务结束……）连着叫了 `TODO_NUDGE_MAX`（8）次就不再叫，记一条错误日志。**自动下线**：`Lines.busy()` 把清单上有 `open` 的算作有事，`presence.ts` 平时的检查和下线前的复查都看它。

下面各条说的是“一条线”的一轮怎么走，两条线都一样；只对某一条线成立的地方写明了。

- **输入事件**：聊天、私聊、任务结束（`task.update` 的 done/failed/canceled）、bot 受伤/死亡/上线、玩家进出、面板发来的指令、定时提醒。
- **唤醒策略**（纯函数，单独可测）：哪些事件触发一轮决策。
  - 聊天：提到 bot 的名字或别名时触发；或者该玩家刚和 bot 对话过（可配置的窗口，默认 60 秒）。可配置为“所有聊天都触发”。
  - 可配置“主人名单”：非空时只有名单里的玩家能指挥；其他人的话只作为背景。
  - 私聊、任务结束、面板指令、提醒：总是触发。
  - 不触发的事件进入“最近发生的事”缓冲，下一轮一并给模型看。
- **一轮决策**：把待处理事件格式化成一条 user 消息（附当前状态快照：位置、血量、背包摘要、当前任务和队列、在线玩家、游戏内时间）→ 调模型 → 顺序执行工具调用 → 结果回给模型 → 直到模型不再调用工具或达到步数上限（默认 60，可设到 500）。
  - 同一时刻只跑一轮。每一步的工具结果凑齐后、下一次调模型前，这期间新到的会触发决策的事件接在工具结果后面一起给模型（格式同“需要你处理的事”，说话的带站位和指向），算进这一轮：一起落盘、不另开一轮。模型不再调工具、这一轮要结束时又到的事件，照旧在本轮结束后合并成下一轮。
  - 任务是异步的：启动任务的工具立刻返回“已开始”；任务结束事件会再次唤醒它（它那一轮还在进行时，接在当时那一步后面）。提示词里要讲清这一点。
- **说话**：对话线每一步写的文字去掉 markdown 记号、压成一行后在公共聊天里说出去；身体回的发送结果（分了几行、截掉多少字、丢了几行）照实记进日志，有不寻常的接在那一步的工具结果后面告诉模型。干活线的文字不进聊天，只记入日志；它一轮结束时留下的那段送给对话线。
  （分成两条线之前：玩家只能看到它用 `say` 说的话，没调 `say` 却留了文本时程序替它说出去。这个兜底已经去掉。）
- **历史与压缩**（`agent/compaction.ts`）：历史落盘，按“轮”存。一轮结束时量一下这条线的上下文有多大，超过它的阈值（干活线默认 240,000 token，对话线 120,000，主人可调）才动；一轮中途不压（只有模型接口明确报上下文超长时强压一次再重试）。只在整轮的边界上切，保证工具调用和结果成对。
  - **量的是什么**：这条线下一次调模型时整份请求大概多少 token——提示词、工具清单、交接记录和历史里的各轮。算法：这条线最近一次一轮里的模型调用，接口报的输入 token 是多少、同一份请求按“字符 ÷ 3”估出来是多少，两者的比例拿来折算现在的历史（等于“那次接口报的数，加上之后历史增减的部分按同一个比例折算”）。带图的调用不拿来校准；比例离谱（不到 0.3 倍或超过 8 倍：有的中转不报、乱报）当它没报；大脑刚启动、这条线还没调过模型时整个按“字符 ÷ 3”，只算历史。面板 `history.estimatedTokens` 是同一个数。
  - **最近的一段原样不动**：从最新往回数到阈值的 25%，至少 2 轮。下面两步都不碰它。
  - **第一步，收拾更早的轮**（不调模型）：超过 2,000 字符的工具结果留前 2,000，后面写明原来多长、要用可以重新调（手册原文整段换成一句“要用时重新读”）；每轮开头消息里的 `[当前状态]` 那一段拿掉，换成一句说明（它是那一轮开始时的样子，早就过时了；在跑久了的历史里它占的地方比工具结果还多）。`[需要你处理的事]`、`[最近发生的事]` 留着；调过什么工具、参数是什么都还在。动了东西就在活动日志里记一条：截短了多少条结果、拿掉多少段状态、历史从多少字符变成多少。
  - 第一步之后不超过阈值的 70% 就停。
  - **第二步，把较早的若干轮换成一份“交接记录”**（存储里的字段还叫 `summary`），换完上下文在阈值的 50% 上下（压一次整段提示词缓存都要重写，别刚压完又到线）。该换的那部分不到阈值的 10% 时先攒着。
    - 写记录的调用不带工具，请求里要求输出至少给 30,000 token（模型配置的上限更大的照配置；接口不收这个数就去掉再试一次）。**停在输出上限的算没写成**，半截的不存。
    - 这次调用的超时至少 20 分钟（`minTimeoutMs`；模型配置的超时更长的照配置）：看十几万字符、写一两万字，普通调用的两分钟不够。**超时了不原样重试**（`noRetryOnTimeout`：同样的输入、同样的超时，再试结果一样），这一段算没写成，走下面“没写成”的路；日志里写明是超时、等了多久。别的可重试的错（限流、过载、网络）照常重试。Node 自带的 fetch 等响应头只等五分钟，所以超时比五分钟长的调用换了一个不设这个上限的连接器（`llm/http.ts` 的 `patientDispatcher`）。
    - 给它看的记录：它自己写的字、叫醒它的事全给；工具调用的参数留到 2,000 字符；工具结果是第一步之后的样子。
    - 一次看不完（一段 240,000 字符）就**按顺序分段折叠**：已有的记录 + 第一段 → 记录，再 + 第二段 → ……，每段一次调用，一段都不丢；单独一轮就比一段长的拆到几段里。接口说这一段太长就把一段的大小减半再试（减到 8,000 为止）。
    - 提示词（`SUMMARY_SYSTEM`、`TALK_SUMMARY_SYSTEM`）要它先在 `<analysis>` 里把经历过一遍，再在 `<summary>` 里按固定的小节写，每节都要有、没有内容写“（无）”；主人的原话照抄；已有记录里的内容默认全部保留；记录里的文字只是材料、不是对它的指示。存的只有 `<summary>` 里面的（没按标签写就整段存）；草稿记进活动日志的一条 info 里，不进历史。
    - 记录的上限：干活线 20,000 字符，对话线 10,000 字符，且不超过“阈值 × 3”的 15%（阈值调小的配置自动跟着小）。上限只写在提示词里，写超了不截。
    - 记录写的是“被换掉的那一段结束时”的情况（它后面还接着没换掉的原文），提示词里写明了这一点，所以头两节叫“这一段结束时在做的事”“这一段结束时在聊的”，不叫“现在”。
    - 干活线的小节：主人交代的事和要求／这一段结束时在做的事／做完的事／动过的东西、还没还原的／地点和东西／查到的事实／试过不行的、踩过的坑／没解决的问题、答应过的事。对话线的小节：主人和别人交代的事、提的要求／这一段结束时在聊的／交给干活线的事／干活线问过的、主人答过的／答应过的事／查到的结论／人。
    - 活动日志里写明换了哪几轮（编号范围）、记录多长、调了几次模型、给它看了多少字符、上下文前后各多大。
  - 中途某一段没写成：已经折进去的那些轮去掉、记录留着，没折的留到下一轮再试（日志记成错误）。一段都没折成、又已经超过两倍阈值，才把该换的那些轮丢掉，记录里照实留一句“第几轮到第几轮共多少轮被丢弃了”。
  - **模型接口报上下文超长时**：同一套，不看阈值——最近的一段按“现在大小的 25%”留，更早的压到现在的一半上下；记录写不成就把那些轮丢掉（照实留一句）。历史里只剩最近那一段时，把它里面的也按第一步收拾（最新一轮先不动）；还是什么都动不了才把历史里的轮全丢掉。
  - 历史最前面那条消息（交接记录）开头把事实写全：这是第几轮到第几轮（共多少轮）换成的，那些轮的原文不在对话历史里了；原始记录还在活动日志里，`read_log` 翻得回去；笔记和手册不在这一份里、一直都在。范围存在历史文件的 `summaryOf: { from, to, turns, unknownBefore? }` 里，每次压缩往后并；老数据没有这一项时照常读，开头照实说“是哪几轮当时没有记下”（之后再压，带 `unknownBefore`）。
  - **翻回原始记录**：库函数 `read_log`（两条线都有，只看）读活动日志（`logs/activity-*.jsonl`，面板“对话”页那一份，留最近 14 个有记录的日子）：按第几轮、按时间段、按词、按类别（它说的、别人说的、工具调用和结果、两条线之间的往来……）取，一页放不下写明前后各还有多少；`id` 读一条的全文。日志落盘时每条的详细内容最多留 8,000 字符，截过的照实说。
- **记忆**：模型通过工具读写的持久笔记（键 → 文本），每轮放进提示词，有总长度上限。地点（home 名字和用途）也记在这里。
- **限制**：每轮步数上限（两条线各一个）；可选的每日 token 上限（0 为不限，两条线合计）；模型接口连续失败时停止重试，接口恢复后自动继续——对话线的故障由程序在聊天里说一次（限频），干活线的故障由程序告诉对话线一次。
- **系统提示词**（`agent/prompt.ts`）：公共部分（它是谁、生存模式的规矩、一个玩家两条线）+ 这条线自己的部分 + 程序每轮生成的几节（手册目录、游戏内指南、名字、主人、这个服务器、基地的做法、记忆）。对话线自己的部分里有两句事实：这一步只写了字、没同时调工具，这一轮就到此为止；要查很多步的事可以交给干活线（两条线每轮各最多几步，用的是设置里的 `talkMaxSteps`、`maxSteps`）。只写事实和后果，不立规矩。每条线的核心提示词（公共部分加自己的部分）不超过 2,400 字，有测试卡着。面板里可改、可恢复默认的是对话线的“说话风格”那一段；干活线没有这一段。

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

上面是第一版的清单，留着当记录。现在两条线各有一份工具清单（对话线：悄悄话、交事和管干活线的三个、所有只查不动的、`run_program`、记忆、提醒、基地的做法、手册、意见簿；干活线：操作身体的全部、查、记忆、提醒、基地的做法、手册、意见簿、`report`），另一条线的事按名字调到时不执行、如实说明归谁。工具分三层：发给模型的工具、不发给模型而在它写的程序里调的**库函数**、合并掉的工具的**旧名字**（`set_home` / `list_homes` 现在是通用的 `run_command`，`haul_items` 是库函数……）；看图的工具只发给能看图的模型。现在的清单见 `brain/README.md` 的“工具一览”，三层怎么分、库函数各给什么见 `docs/SCRIPTS.md` 的“库函数”。

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
  - 最上面一条是**这个服务器**的名字（`/api/status` 的 `environment.name`）：名字里有“正式”“生产”“主服”、prod、live 的是红底斜纹，侧栏左边也多一道红线；有“测试”“开发”、test、dev 的是绿色；别的是蓝色；没起名字时是一条虚线框，点了去“设置 → 玩家”。浏览器标签页的标题以它开头，标签页的小图标是同色的方块加名字的头一个字（主人可能同时开着测试服和正式服两个面板）。登录页上也有同样的一条（`GET /api/session` 没登录时给的 `server`），标题和小图标也照样，正式服的登录框是红边。有规矩时鼠标移上去看得到。
  - 玩家卡：名字、在不在线、位置、血量和饱食度、上线 / 下线。不在线时分三种写：“没人在，自己下线了”（`body.awayIdle`，下面一行“有人来会回来”）、“下线了（你点的）”（`bot.wantOnline` 是 false）、“不在线”（要它在线可它不在，标黄）。
  - “全部停下”：有东西在跑时是实心的警示色；点了以后说明停了什么。先调 `POST /api/work/stop`，后端没有这个接口（404）时退回“停例程 + 取消全部任务”。
  - 每条线一张状态卡，照 `GET /api/status` 的 `agents` 数组画（现在一项 `main`；两条线时是 `talk`、`work`，见 `docs/TALK_WORK.md`）：模型的状态（空闲 / 正在想第几步、已几秒 / 在执行工具 / 接口故障；干活线没在想、可它开的任务或例程还在跑时（`ownTasks`、`routine`）写“等任务做完”“等例程跑完”）、这条线用的模型（卡上直接换）、第几轮第几步。管身体的那条线下面再挂两行：**例程**（哪个在跑、多久、调了多少次，可停）和**身体**（正在做的任务、进度条、排队的，可取消）；它提了问还没人回答（`waitingAnswer`）时有一块醒目的。
  - “可能卡住了”是面板自己判断的：模型一步超过 90 秒、身体任务的进度 120 秒没动，标黄，悬停写着依据。
  - 导航：现在 · 对话 · 知识 · 建造 · 设置。再下面是游戏连接和今日用量。
- 页面：
  - **现在**：一句话的现状；正在跑的那一轮（起因、已经几步多久、上一步调了什么、现在这一步）；等回答的问题全文和“去回答”；例程的实时计数和正在等的那一步；身体任务的进度和排队；最近几步；一行输入框。右边是游戏里的它：心和鸡腿、位置朝向、**物品栏**（和游戏里一样的格子：盔甲、背包 9×3、快捷栏，手持的有白框，数量、耐久条，悬停或聚焦显示中文名、英文名、id/meta）、开着的界面（它的格子，和格子以外的控件：开关开没开、页签开没开、流体格里是什么多少；只读）。点一个格子，下面是它的详情和**提示文字**（`/api/items/tooltips`；不按键 / 按住 Shift / 按住 Ctrl 三个画面分开，有几个给几个；写明这是对着样品看到的）、别的玩家（远近和方位）、脚下的俯视图（滚到看得见它、页面在前台时才取，10 秒一次）。
  - **对话**：一条时间线分左右两道、一行行对齐。左边“说了什么”：玩家的话、它的话、主人在面板上说的（对话线自己的那几步也在这边，画得很省）。右边“干了什么”：一轮 → 模型的每一步（用时、token）→ 这一步调的工具（收着时是读得懂的一句：物品写中文名，位置写坐标；点开是参数和结果全文）；它写的程序的一次运行是一块汇总（跑着时实时更新，点开读每一步的明细）。两条线之间的往来（`relay`）是横跨两边的一条；`progress`（还在干、中途留的话）是虚线框，后面写着它在等什么（`relay.waiting`）。被叫停的那一步（`halted`）写“想到一半被叫停了”，大脑进程要停时中止的（`failed` + `aborted`）写“大脑进程要停，这一步被中止了”，两样都不算进一轮的“几处出错”。一轮默认收成一行；干活线最新的一轮开着，对话线的只在它正跑着时开着（它的结果就是下面那句话）。三档：只看对话 / 加上模型的决策 / 全部（再加游戏事件和说明）。往上翻到头自动取更早的；不在底部时有“回到最新”；底部输入框（只有它看得到，不进游戏聊天）。窄于 760 像素时两道叠成一列。
  - **知识**：
    - 记忆（查看、改、删、新增）。
    - 基地的做法（`/api/methods`）：一类零件 · 当现成的 · 同料时用哪种 · 总的先后 · 具体的东西 · 机器的用途，各一块，后端以后多出来的种类照它给的那一行列出来（只能删）。每条写清楚是什么（零件写中文名加矿辞前缀；当现成的写一类零件、一个矿辞名或者一样物品；同料时写用哪种、不用哪种、是不是只在用的那种不要工具时；做法是配方页的名字；具体东西带配方编号和原料 → 产物；机器带坐标、进料、收货、别动的），谁定的（你 / 它自己）、什么时候、理由；能改、能删、能加。对不上的（`stale`：配方、做法或物品在现在的配方册、物品表里找不到了；没有配方册时后端不判断，看 `line` 里的 `NO LONGER IN THE RECIPE BOOK` / `[NOT FOUND ANY MORE …]`）红色标出、写明找不到的是什么，顶上一条写有几条；改具体东西的时候配方编号空着，提示原来那条长什么样。后端拒了的（做法名认不出、配方做不出那样东西）原话写在表单下面。在面板上写的都算主人定的。按谁定的筛、按字找。
    - 手册（默认的、你改过的、你写的、它自己写的；改默认手册存的是你的一份，可以恢复默认）。
    - 指南（`/api/guide*`，只读）：左边一本书的目录（按 `parent` 搭成树）或者搜到的页（标题、讲的物品、正文哪样对上的，和对上的那一小段），右边读一页：在目录里的位置、讲的物品、小节（三个以上时列在顶上）、正文、下一级。正文是 Markdown，前端自己读成结构再拼成页面（`markdown.js`，不拼 HTML 字符串；HTML 只认 `<br>` `<u>` `<kbd>` `<a title>` `<sup>` `<details>`）：页间链接 `book:path#小节` 点了就跳（地址是 `#knowledge/guide:<页>`，浏览器后退回上一页），站外链接在新标签页开，物品的 `[id]` 淡淡地跟在名字后面，“游戏里这里显示的是什么”那句画成一个虚线框（图片、配方、立体场景……），提示框（`> [!WARNING]` 这类）有颜色。有英文原文的页能切过去看。
    - 意见簿（按类别和状态筛、看详情、标已处理、导出）。导航上的数字是意见簿里没看过的条数。
  - **建造**：草稿（三维预览和四种简图、材料、生成它的程序、发布到游戏、删除）· 图纸（服务器上的：上传、删除、看材料）· 图片（上传、删除）· 多方块结构（按名字搜，每一级的材料和三维预览）。
  - **设置**：模型（每条线用哪个；服务商和它下面的模型的增删改、测试连接、从接口拉模型列表）· 玩家（这个服务器：名字和这里的规矩，`bot.environment`，名字旁边预览左上角会是什么颜色；上线 / 下线、无敌、会饿；自动上下线：开关和分钟数，`bot.presence`；名字、别名、主人名单、什么时候回应聊天；人设提示词）· 上限（历史压缩怎么算写在下面）· 游戏连接 · 面板口令 · 历史和提醒（每条线记得多少、上下文多大、哪几轮写成了交接记录；“试写一份”“马上压缩”（`POST /api/history/compact`，旁边写明真压会把最近那一段以外的轮换成交接记录、试写只给看不存；要等一两分钟，等的时候写着已经多久，回来的结果照实列出：换了哪几轮、留了几轮、上下文前后多大、调了几次模型、记录多长、先收拾了什么、哪一段没写成，交接记录全文和草稿能展开）；清空；今日用量；提醒，每条写着是哪条线定的，可删）。
- 前端是 `panel/public/` 下的一组 ES 模块，浏览器直接加载，没有构建步骤：
  `app.js`（登录、框架、换页）、`side.js`（状态区）、`data.js`（定时取状态）、`logstore.js`（日志：SSE 加往上翻）、`logmodel.js`（**日志条目 → 时间线**，纯函数；条目长什么样只有它知道，新旧两种形状都认）、`logview.js`（把时间线画出来）、`items.js`（物品格子、提示文字、心和鸡腿）、`names.js`（物品中文名）、`page-*.js`（五页）、`knowledge-methods.js`、`knowledge-guide.js`（知识页的两块）、`markdown.js`（指南的正文 → 块和行内的结构，纯函数）、`viewer3d.js`（三维预览）、`ui.js`（小工具）。
- 窄窗口（游戏开在旁边）、键盘（都是真的按钮和表单控件；一组物品格子占一个 Tab 位，方向键在格子之间走）也能用。
- 连不上大脑进程时：状态区顶上一条红的，页面上留着的旧样子调暗，各页写明没取到并给“重试”；连上以后自己恢复。
- 看面板、截图用的两个脚本（不连真的游戏、不用真的模型，端口见各自文件头）：
  - `node test/panel-dev.ts [--shape fake|real] [--lines 1|2] [--scene …]`：模拟身体 + 真的大脑（子进程）+ 一层代理。`real` 是大脑真实给的数据；`fake` 由代理顶替“它在干什么”那几个接口，可以把“正在想第 3 步”“例程跑到一半”“干活线在等回答”这些一闪而过的时刻摆住，`--lines 2` 是两条线的假数据。
  - `node test/panel-shots.ts --plan '<步骤单>'`：自己起一个无头 Chrome（临时目录，经管道说 CDP，不占端口），照步骤单去点、去截图，并把页面里的报错打出来。

### 面板的数据接口

界面要的数据都从这几处来（实现在 `panel/data-api.ts`、`store/activity-log.ts`、`agent/run-log.ts`）。前端只管显示；这里定的是字段。

**1. 日志条目**（`GET /api/log`、SSE `GET /api/events`）。原有字段：`id`、`time`、`kind`、`text`，可选的 `who`、`detail`、`isError`、`turn`、`pictures`、`scenes`。另有这些可选字段：

| 字段 | 出现在 | 含义 |
|---|---|---|
| `agent` | 两条线各自产生的条目 | 哪条线的：`talk`（对话线）、`work`（干活线）。不带的是系统的事（连上、断开、面板上的操作）和分成两条线之前的旧条目 |
| `relay` | `kind: "relay"` | 两条线之间的一次往来，见下 |
| `sent` | `kind: "say"`（对话线说的话） | 身体回的发送结果里有不寻常的才带：`{ lines, cutChars, droppedLines }`（分了几行、截掉多少字、丢了几行） |
| `step` | `model_call`、`model_text`、模型直接调的 `tool_call` / `tool_result` | 这一轮的第几次模型调用（从 1 起），和 `turn` 一起定位 |
| `source` | `tool_call`、`tool_result`、`run`、例程开始和结束的那两条 | 谁发起的：`model`（模型自己）、`program`（`run_program` 的程序）、`routine`（后台的例程） |
| `runId` | 属于某次程序运行的条目 | `r3`（例程）、`p12`（程序）。每次大脑重启从 1 重新数，唯一的是 `run.file` |
| `run` | `kind: "run"`，例程开始和结束的那两条 | 这次运行的快照，见下 |
| `call` | `kind: "model_call"` | 这次模型调用的账，见下 |

**`turn` 两条线共用一个计数器，不会重号**：单看 `turn` 就能定位一轮，哪条线的看 `agent`。

对话线写的文字就是它说的话：它每一步的文字是一条 `kind: "say"`（带 `agent: "talk"`、`turn`、`step`），不另有 `model_text`；没说出去的那次是一条 `model_text` 加一条 `error`。干活线的文字照旧是 `model_text`。

**`kind: "relay"`：两条线之间的往来**，一次往来一条（发的那一刻记，收的那头不再另记）：

```jsonc
{ "id": 901, "time": 1731300000000, "kind": "relay", "agent": "talk", "turn": 40, "step": 1,
  "text": "对话线 → 干活线：把他指着的那个箱子拆了",
  "detail": "交给干活线的全文：对话线写的话 + 程序原样附上的主人原话和站位、指向",
  "relay": { "type": "tell", "from": "talk", "to": "work", "quotes": 1 } }      // quotes：附了几句原话
{ "id": 930, "time": 1731300050000, "kind": "relay", "agent": "work", "turn": 41, "step": 4,
  "text": "干活线 → 对话线（提问）：模头（杆）没有库存也没有配方，要不要改用压模机？",
  "relay": { "type": "question", "from": "work", "to": "talk" } }
```

`relay.type`：`tell` 对话线交事或带话；`report` 干活线中途汇报；`question` 干活线提问、在等回答；`result` 干活线停下来了、这是它留下的文字（叫醒对话线）；`progress` 干活线一轮结束留了文字、但它开的任务或例程还在跑（只作背景，没有叫醒对话线；`relay.waiting` 是它还在等什么，如 `"在等它开的任务结束：t5（withdraw）"`，`text` 里写着“只作背景，没有叫醒它”）；`trouble` 干活线出了状况（模型接口故障、没选模型、到步数上限、任务连着失败——程序替它报的，带 `isError`）；`stop` 叫停，`from` 是 `talk` 或 `panel`（面板叫停的那条没有 `agent`、`turn`；身体的任务没取消成时带 `isError`）。两条线空转、这一条只作背景没有叫醒对方时，`text` 里写着“只作背景，没有叫醒它”。

`kind` 在原来那些之外还多两种，**这两种会原地更新**：SSE 里收到一条数据里的 `id` 是已经有的，就是同一条的新样子，替换掉原来那条；之后再拉日志拿到的也是新样子。更新的那一帧不带 SSE 自己的 `id:` 行（只有 `data:`），所以浏览器断线重连用的 `Last-Event-ID` 一直是最新那条的。

- **`model_call`**：一次模型调用一条。开始想的时候就出现（`call.state: "thinking"`），回来或出错时改成结果。

  ```jsonc
  { "id": 812, "time": 1731300000000, "kind": "model_call", "turn": 12, "step": 3,
    "text": "第 3 步：11.8 秒，输入 181204（缓存命中 176900） / 输出 412 token，要调 2 个工具",
    "call": { "state": "done",            // thinking | done | failed | halted
              "purpose": "turn",          // turn：一轮里的一步；compact：压缩历史的那次调用（没有 step）
              "step": 3, "startedAt": 1731300000000, "ms": 11820,
              "model": "claude-…",        // 接口回的模型名
              "inputTokens": 181204,      // 已含缓存读写的部分
              "outputTokens": 412,
              "cacheReadTokens": 176900, "cacheWriteTokens": 4100,   // 接口给了才有
              "stop": "tool_calls",       // tool_calls 要调工具 | end 说完了 | truncated 被输出上限截断 | other | error | halted
              "toolCalls": 2 } }
  ```

  `thinking` 时只有 `state`、`purpose`、`step`、`startedAt`。`failed` 时 `stop` 是 `error`，带 `errorKind`（`auth`、`timeout`、`server`、`context_length`、`aborted`……）和 `error`（原话），条目 `isError: true`。`halted`（`stop` 也是 `halted`）是想到一半被叫停了——对话线 `stop_work` 或主人在面板上点“全部停下”打断的，不是出错：没有 `errorKind`、`error`，条目不带 `isError`，`text` 是“第 2 步：想到一半被叫停了（4.3 秒）”。大脑进程要停时中止的那一次还是 `failed` + `errorKind: "aborted"`。

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

**4. 状态** `GET /api/status`（不缓存，可以一秒一拉；`/api/overview` 原样保留）。`agents` 两项，固定顺序 `talk`、`work`；例程和身体只有一份，挂在干活线下面。

```jsonc
{ "time": 1731300000000,
  "agents": [
    { "agent": "talk", "name": "Alu", "title": "对话线",
      "model": { "state": "idle",                      // idle | thinking | tools | outage
                 "provider": "Anthropic", "model": "claude-…", "providerId": "p_ab12", "modelId": "m1",   // 这条线现在配置用的
                 "lastCall": { "time": 1731299990000, "ok": true, "durationMs": 820, "model": "claude-…",
                               "inputTokens": 9204, "outputTokens": 31, "cacheReadTokens": 8800 } },
      "turn": null,
      "pending": 0,
      "history": { "turns": 12, "hasSummary": false, "estimatedTokens": 5400, "threshold": 60000 } },
    { "agent": "work", "name": "Alu", "title": "干活线",
      "model": { "state": "thinking", "provider": "Anthropic", "model": "claude-…", "providerId": "p_ab12", "modelId": "m2",
                 "turn": 41, "step": 3, "since": 1731300000000, "purpose": "turn",
                 "lastCall": { … } },
      "turn": { "id": 41, "startedAt": 1731299950000, "steps": 2, "maxSteps": 60,
                "about": "对话线交给你的（这一句是它写的）：把他指着的箱子拆了" },
      "pending": 0,
      "history": { "turns": 80, "hasSummary": true, "estimatedTokens": 152000, "threshold": 200000 },
      "waitingAnswer": { "text": "模头（杆）没有库存也没有配方，要不要改用压模机？", "since": 1731299990000 },
      "lastReport": { "type": "question", "text": "…", "time": 1731299990000 },
      "ownTasks": [ "t151", "t152" ],
      "routine": { "id": "r3", "name": "整理抽屉", "status": "running", "startedAt": 1731300100000,
                   "calls": 312, "tasks": 150, "errors": 0,
                   "waiting": "withdraw_items {…}", "waitingSince": 1731300160000, "waitingTask": "t151",
                   "limitMs": 7200000, "file": "routine-20261111-153012-r3.jsonl" },
      "lastRoutine": null,
      "body": { "online": true,
                "task": { "id": "t151", "type": "withdraw", "state": "running", "progress": { "done": 3, "total": 8 }, "startedAt": 1731300160000 },
                "queue": [ { "id": "t152", "type": "craft", "state": "queued" } ] } } ] }
```

- `model.state`：`idle` 没有在跑的一轮；`thinking` 模型调用进行中（带 `turn`、`step`、`since`、`purpose`）；`tools` 这一轮没完、正在执行它要的工具（带 `turn`、`step`）；`outage` 模型接口故障、过一阵再试。有故障时（不管当时是哪个状态）带 `outage: { failures, since, nextRetryAt, lastError }`。两条线各有各的。
- `turn`：正在跑的一轮，`steps` 是已经完成的模型调用次数，`about` 是这一轮的起因（一行）；没有是 `null`。`pending`：排着队还没处理的事件数。
- `history`：这条线的对话历史有多长、离压缩还有多远。`estimatedTokens` 是和 `threshold`（这条线的设置）比的那个数：这条线下一次调模型时整份请求大概多少 token（提示词、工具清单、交接记录和各轮；按最近一次模型调用接口报的输入 token 校准，见“历史与压缩”），大脑刚启动、这条线还没调过模型时只是历史的“字符 ÷ 3”。历史最前面有交接记录、而且记着它是哪几轮换成的时候，多一项 `summaryOf: { from, to, turns, unknownBefore? }`。
- 下面这几项**只有 `work` 有**，`talk` 那一项没有这些键：
  - `waitingAnswer`：干活线提了问、还没人带话回答（对话线 `tell_worker` 或叫停以后清掉）；没有是 `null`。`lastReport`：它最近一次送给对话线的（`type` 同 `relay.type` 里干活线发的那五种：`report`、`question`、`result`、`progress`、`trouble`）；没有是 `null`。这两项落盘，重启后还在。
  - `ownTasks`：干活线开的、还没看到结束的任务的 id（例程开的也在里面；和 `body.task`、`body.queue` 里的 `id` 对得上）。`turn` 是 `null` 而这里不空（或者 `routine` 在跑），就是“还在干，只是这会儿没有在想”：任务或例程一结束它自己会被叫醒接着做。`turn` 是 `null`、这里空、也没有例程，才是真的停着。
  - `routine`：正在跑的例程，没有是 `null`；`lastRoutine` 是上一个结束的（多 `endedAt`、`ending`、`endingText`：为什么结束，`ending` 是给模型看的英文原话，`endingText` 是给主人看的中文）。停它是 `POST /api/routine/stop`。
  - `body`：`task` 是身体正在做的任务（`progress` 身体给了才有），`queue` 是排队的。连不上身体时是 `{ "online": false, "task": null, "queue": [], "error": "…" }`。取消是 `POST /api/tasks/cancel`。

**总停止** `POST /api/work/stop`，body 可带 `{ "reason": "…" }` → `{ "ok": true, "turn": true, "routine": "r3", "tasks": 2, "dropped": 1 }`（打断了正在跑的一轮没有 / 停掉的例程编号或 `null` / 取消了几个身体任务 / 放下了几件它还没处理的事；身体的任务没取消成时 `ok: false` 并带 `error`）。和对话线的 `stop_work` 是同一件事；日志里是一条 `relay`（`type: "stop"`, `from: "panel"`）。

**两条线各选一个模型。**

- `POST /api/models/use { providerId, modelId, line?: "talk" | "work" }`：不带 `line` 是两条线一起换。`POST /api/providers/:id/activate` 也是两条一起。那条线的下一轮起生效。
- `GET /api/providers`（以及所有返回它的接口）带 `lines: { "talk": { "providerId", "modelId" }, "work": { … } }`；原来的 `activeProviderId` / `activeModelId` 保留，等于干活线的。
- `GET /api/overview`：`provider`、`agent`、`history` 保留，都是干活线的；另有 `lineModels: { talk: {…同 provider 的形状…} | null, work: … }`、`talk`（对话线的状态，形状同 `agent`）、`histories: { talk: { turns, hasSummary, estimatedTokens, threshold }, work: … }`。
- `POST /api/history/clear { line?: "talk" | "work" }`：不带是两条线的都清。
- `POST /api/history/compact { line: "talk" | "work", dryRun?: boolean }`：现在就把这条线的历史写成交接记录——不看阈值，最近那一段（阈值的 25%，至少 2 轮）以外的全部换掉，用这条线自己的模型，等模型写完才回（记录长的时候一两分钟）。
  - `dryRun: true`：只写不存，历史不动，看它会写成什么（试提示词用）；这条线正在跑一轮时也能试，同一条线同时只能有一次试写。
  - 不带 `dryRun`：真压。这条线正在跑一轮时不做，回 409 `busy`；没有可用的模型回 503 `no_model`。
  - 回的是 `{ line, dryRun, applied, action, summary, analysis?, turns: { from, to, count } | null, kept, calls, inputChars, usage: { inputTokens, outputTokens }, ms, summaryChars, capChars?, tokensBefore, tokensAfter, tidied?, error? }`：`applied` 历史改了没有；`action` 是 `summarized`（写成了）、`nothing` / `truncated`（最近那一段以外没有可换的轮，或者一段都没写成）、`dropped`；`summary` 是会存进历史的那一份（已有的记录和这些轮合并以后的）；`analysis` 是它打的草稿；`turns` 是换掉的轮的编号范围和轮数，`kept` 是留下的轮数；`calls`、`inputChars`、`usage`、`ms` 是写记录调了几次模型、一共给它看了多少字符、接口报的输入输出 token（写成了的那几次的合计，一次都没写成是 0）、一共等了多少毫秒（没写成的也算）；`capChars` 是记录的上限；`tokensBefore` / `tokensAfter` 是前后上下文多大；`tidied` 是第一步收拾了什么；`error` 是有一段没写成的原因（已经折进去的照样算数）。
- 设置（`GET/PUT /api/bot` 的 `bot.limits`）：`maxSteps`、`historyTokenThreshold` 是干活线的；`talkMaxSteps`（默认 20）、`talkHistoryTokenThreshold`（默认 60000）是对话线的。`bot.systemPrompt` 字段名没变，含义是“对话线的说话风格”（空 = 默认），`defaultPersona` 返回默认的那段。

- **这个服务器**：`GET/PUT /api/bot` 的 `bot.environment = { name: string, rules: string }`（默认都是空；名字最多 40 字，规矩最多 4000 字，首尾空白去掉）。这个实例接的是哪个服务器（主人起的名字，如“测试服”“正式服”）和主人给这里写的规矩（自由文字）。它是这个实例的设置，不是它的记忆：“这里是测试服，材料随便用”这种话写在这里，不跟着记忆搬到别的服务器。`GET /api/status` 顶层带 `environment`。两样有一样不空时，两条线每一轮的系统提示词里多一节“这个服务器”（`agent/prompt.ts` 的 `environmentSection`，程序生成，在“你的记忆”前面）：名字、“这是主人给这个服务器写的设置，不是你记下来的”、规矩的原话；主人改了下一轮就是新的。
- **自动上下线**（`agent/presence.ts`，默认关）：`GET/PUT /api/bot` 的 `bot.presence = { idleOffline: boolean, idleMinutes: number }`（默认 `false`、`5`；分钟数可以写小数，0.05–1440）。开着时：服务器上没有真人、它手上也没事（哪条线在跑一轮或排着事、盯着任务、例程在跑、工作清单上有没做的，都算有事；在等人的不算），满 `idleMinutes` 分钟自己下线；有真人进服、主人从面板发指令、它定的提醒到点时再上来，那件事照常处理（进服的作背景，指令和提醒照常叫醒对话线）。
  - “没事”= 两条线都没有在跑的一轮和排着的事、干活线没有盯着的任务、没有在跑的例程；到点下线前再问一遍身体（`server.info` 里还有没有真人、`task.list` 有没有任务和队列）。别的 bot 不算真人。
  - `bot.awayIdle`（只读的状态，不是设置）：它现在是自动下线的。记在配置文件里，所以大脑重启后仍然是：连上游戏不把它叫出来；那时服务器上有真人才上来。`GET /api/status` 里干活线的 `body` 这时多一项 `awayIdle: true`。
  - 主人手动点的下线（`POST /api/bot/despawn`）不是自动下线：`wantOnline` 变成 `false`，`awayIdle` 跟着没了，之后有人进服也不上来，直到主人手动上线。自动下线不改 `wantOnline`，也不算“被弄下线”。
  - 自动上线、下线各记一条活动日志（为什么下、为什么上）。下线的请求发出去了、答复没回来（连接正好断了）时先当它下了；它其实还在线的话，下一次检查问过身体就改回来。

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
              "slots": [ { "slot": 0, "takesNothing": true, "item": { } }, { "slot": 62, "own": true, "item": { } } ],
              "controls": [ { "panel": "basicmachine.…", "key": "fluidAutoOutput:0", "name": "fluidAutoOutput", "kind": "switch", "value": false },
                            { "key": "cover_panel_west", "name": "cover_panel_west", "kind": "panel", "open": false },
                            { "key": "auto_sync:tank:3", "name": "auto_sync", "kind": "fluid",
                              "fluid": { "id": "molten.steel", "name": "熔融钢", "amount": 288, "capacity": 32000, "fills": false, "drains": true } } ] },   // 没开界面是 null
  "players": [ { "name": "阿露", "isBot": false, "dim": 0, "dist": 6.4, "dx": 4, "dy": 0, "dz": -5 } ],   // 同一个维度的按远近排；别的维度 dist 是 null
  "world": { "dayTime": 3000, "isDay": true, "raining": false, "tps": 20 },
  "looks": { "icons": { "cell": 32, "columns": 64, "rows": 64, "sheets": [ "/api/icons/sheet?n=0&v=…" ] },   // 没有图集是 null
             "textures": { "url": "/api/textures/atlas.png?v=…", "tile": 16, "columns": 64, "rows": 86 } } }
```

- `name` 是本地物品表的中文名，查不到是身体给的英文名，再没有是 id；`en` 是身体给的名字（和 `name` 不同时才有）。只靠附加数据区分的物品（匠魂、GregTech 的工具）名字以身体给的为准。
- `look` 是这样东西的图标怎么画，按这个顺序找：`{ "icon": n }` 物品图标图集里的第 n 个（见 `docs/PACKDATA.md` 的“物品图标”）；`{ "tex": n, "tint"? }` 它是方块，方块贴图图集里的第 n 格；`{ "color": [r,g,b], "known": true }` 颜色表里的方块；`{ "color", "known": false }` 都不是，颜色由 id 算出来，只为了区分（面板画成色块加名字的头一个字）。
- `screen.controls` 是界面上格子以外的东西（`docs/PROTOCOL.md` 的“界面上的控件”，只有 ModularUI 2 的界面有，别的是空数组）。`kind`：`switch`（`value` 是开没开）、`panel`（能再打开的一块面板、页签，`open` 是它现在开没开）、`fluid`（流体格，`fluid` 里是什么、多少 mB、能装多少、能不能倒进取出；空的没有 `id`）、`choice`（`value` 是选的哪个，`options` 是能选的）、`number` / `text` / `value`（`value` 是它现在的内容）、`button`、`other`。`name` 是 `key` 冒号前面那一段；`readOnly` 是只显示、玩家改不了的。最多给 80 个，再多时带 `controlsTotal`。面板只照着画，不操作。
- 没连上游戏、它不在线时也是 200：`{ "connected", "online": false, "reason"? }`。有任务在跑时身体不让看界面，`screen` 是 `null`。
- 物品图标图集的图：`GET /api/icons/sheet?n=<第几张>`（地址里带着版本，可以让浏览器一直留着）。大脑头一次用到时读 `icons/icons.json` 并核对 `count` 和 `itemsSha1`（对不上就当没有图标）；运行期间说明文件被换过（重新导出了）也当没有，直到重启——行号对不上了，宁可没图也不能错位。

**7. 脚下的俯视图** `GET /api/minimap?radius=<4–31，默认 24>` → `{ available, x1, z1, width, depth, palette: [{ id, name, color, known, liquid? }], tops, heights, unloaded, self: { x, y, z, yaw }, players: [{ name, x, z, isBot }] }`。`tops` / `heights` 一行行排（下标 = z * width + x）：那一列地表是调色板里的第几种、多高（没有是 -1）。看不到时 `{ available: false, reason }`。

**8. 物品的中文名** `GET /api/items/names?q=<逗号隔开的 id/meta，最多 200 个>` → `{ names: { "minecraft:dirt/0": "泥土" } }`，只回查得到的。

**8b. 物品的提示文字** `GET /api/items/tooltips?q=<逗号隔开的 id/meta，最多 200 个；meta 不写当 0>` → `{ available, tooltips: { "gregtech:gt.blockmachines/31080": { tip: ["机器类型: 离心机", …], shift?: […], ctrl?: […] } } }`，只回有提示的那些；没有这份资料（`packdata` 的 `tooltips.jsonl`）时是 `{ available: false, tooltips: {} }`。面板在“现在”页点一个格子时问。`tip` 是玩家把鼠标放到物品上、什么键都不按时名字下面的那几行；`shift`、`ctrl` 是按住那个键时**换成**的另一版，不是接在后面，没有另一版的没有这个键。行是原样的（行首的空格是缩进，`""` 是一段空白，`"---"` 是一条横线），已经去掉了只是界面提示的那几行（“长按 [G] 打开指南”等，见 `docs/PACKDATA.md` 的“物品的提示文字 · 大脑怎么用”）。这些字是一个新号对着一个刚拿出来的样品看到的：电量、存量、绑定这类行说的是样品，不是玩家手里那一个。

**8c. 基地的做法**（这个基地怎么做东西的记录：主人教的、它自己定过的；`store/methods.ts`，存在数据目录的 `methods.json`，实现在 `panel/data-api.ts`）。和模型用的 `set_base_method` 是同一套查对。

- `GET /api/methods` → `{ available, total, counts: { part, ready, same, order, thing, machine }, entries: [条目 + line + recipeNow? + stale?] }`。条目照种类排（一类零件、当现成的、同料时用哪种、总的先后、具体的东西、机器），每种里先记的在前（同一时刻记的照键排）。`line` 是给人看的一行，和模型用 `base_methods` 看到的一样（具体东西的配方对回了现在的编号，对不回来写着 `NO LONGER IN THE RECIPE BOOK`；别的几种对不上时带 `[NOT FOUND ANY MORE …]`）。
  - 公共字段：`key`（`part:plate`、`part:stick:Steel`、`ready:ingot`、`ready:minecraft:stone/0`、`same:有序合成>组装机`、`order`、`thing:<东西的键>`、`machine:x,y,z`；写同一个键就是改）、`kind`、`by`（`owner` / `self`）、`at`（epoch ms）、`why`。
  - `part`：`prefix`、`material?`、`way`（配方页的名字）、`from?`。`ready`：`match`（`prefix` 矿辞前缀 / `ore` 一个矿辞名 / `item` 一样物品）、`text`（前缀、矿辞名或物品 id）、`meta?`、`name?`。`same`：`use`、`over`（两种做法的名字：两种都做得出一样东西、用的料一样时用 `use`）、`noTools?`（只在 `use` 那条不用工具时）。`order`：`ways`。`thing`：`thing`（`ore:plateSteel`、`id/meta`、`fluid:注册名`）、`name`、`recipe: { ref, way, wayName, in, out, fin, fout, text }`（`ref` 是记下那时的编号）。`machine`：`x y z`、`name?`、`does`、`feed?`、`collect?`、`keep?`。
  - **判断失效**（照现在这份配方册、物品表算的，不存进文件；没有配方册时都不带）：`stale: boolean`——这条记录说的东西现在找不到了：具体东西的配方对不回来；`part`、`same`、`order` 里的做法名不在配方册里了；`ready` 的物品、矿辞名或前缀不在物品表里了；`machine` 总是 `false`。`thing` 另带 `recipeNow: number | null`：现在对回的配方编号，对不回来是 `null`。
- `PUT /api/methods` body 和工具一样：`{ part, way, from?, material?, why? }`、`{ ready: "ingot" | "ingotSteel" | "mod:name/meta", why? }`、`{ use, over, noTools?, why? }`、`{ id, meta?, recipe, why? }`（流体给 `fluid`）、`{ order: [做法…], why? }`、`{ machine: {x,y,z}, does, feed?, collect?, keep?, why? }`；`by` 不给是 `owner`（面板上写的算主人定的）。→ `{ entry, replaced }`，`entry` 带着 `line`、`recipeNow?`、`stale?`。写错的（做法名认不出、配方做不出那样东西、没有这条配方、前缀没有对上的矿辞名……）400 `bad_request`，`message` 是和工具一样的那句英文。
- `DELETE /api/methods { key }` → `{ removed }`。

**8d. 工作清单**（交代下来的事还剩哪些；`store/todo.ts`，存在数据目录的 `todo.json`，实现在 `panel/data-api.ts`）。和模型用的工具 `todo` 是同一份、同一套查对。面板上改的 `by` / `changedBy` 是 `owner`。

- `GET /api/todo` → `{ available, counts: { open, waiting, done }, items: [条目 + line] }`，照编号排。条目：`id`、`text`、`state`（`open` 没做 / `waiting` 在等人 / `done` 做完）、`waitingFor?`（在等人时：等谁、等什么）、`note?`、`by`（`talk` 对话线 / `work` 干活线 / `owner` 主人在面板上）、`at`（epoch ms，写下的时间）、`changedBy?`、`changedAt?`（最近一次谁改的、什么时候）、`doneAt?`。`line` 是模型在清单里看到的那一行（`- #3 waiting for Steve 回来: 修二号高炉 (the talk line, 22:30) — note: 不急`）。没有这份存储时 `{ available: false, counts: {0,0,0}, items: [] }`。
- `POST /api/todo { add?: [{ text, note? }], change?: [{ id, text?, note?, state?, waitingFor?, remove? }] }` → `{ items, counts, added: [id…], changed: [id…], removed: [id…], cleared: [id…] }`。`state: "open"` 是重新打开（做完的、在等人的都行）；给了 `waitingFor` 不给 `state` 就是标成在等人，`state: "waiting"` 一定要有 `waitingFor`（新给的或原来的）；`note: ""` 去掉备注；`remove: true` 删掉。`cleared` 是做完的超过 20 条时清掉的最早几条。有一处不对整次不做：400 `bad_request`，`message` 是和工具一样的英文（`#9 is not on the list.` 这样一处一句）。加了没做的、而干活线停着时，它会被叫醒（见“agent 循环”的工作清单）。
- `DELETE /api/todo { id }` → `{ removed }`。

**9. 游戏内指南**（只读；整合包带的那本、玩家按 G 看到的，`packdata` 的 `guide.jsonl`，实现在 `panel/data-api.ts`；页面在“知识 → 指南”）。一页写成 `book:path`。给出来的正文是**读成字以后的**，和模型用 `read_guide` 读到的是同一份（物品是“中文名 [id/meta]”，配方框、立体图、图片各是一句“游戏里这里显示的是什么”，页间链接是 `book:path`；规则见 `docs/PACKDATA.md` 的“游戏内指南 · 大脑怎么用”）。同一路径两种语言都有的算一页、给中文的。

- `GET /api/guide` → `{ available, pages, books: [{ book, title, pages, englishOnly }] }`；没有这份资料时是 `{ available: false, books: [] }`。带 `book=<书>` 时多两项：`book`，和 `list`——这本书的全部页，按目录的顺序（上一级在前，同级里有中文的在前、再按书里的次序），每项 `{ path, book, title, lang, english?, parent? }`：`lang` 是给出来的这一版的语言（`zh_cn` / `en_us`），`english: true` 表示同一路径另有英文版，`parent` 是上一级的 `path`（顶上的页没有）。前端拿 `parent` 搭成树。没有这本书是 404。
- `GET /api/guide/search?q=<词，空格隔开，都要有>&book=<可选>&limit=<默认 30，最多 100>` → `{ q, book?, matched, hits: [{ path, book, title, lang, english?, parent?, score, snippet? }] }`。在标题、读成字的正文、这一页讲的物品的名字（中英文）里找；`score` 3 是标题里就有、2 是讲的物品对上了、1 只在正文里；`snippet` 是正文里对上的那一处前后的一小段。
- `GET /api/guide/page?path=<book:path>&english=<0|1>` → `{ path, book, title, lang, english?, parent?, author?, date?, items: [{ id, meta? | metas? }], children: [{ path, book, title, lang, … }], sections: [{ level, title, offset }], text }`。`items` 是这一页自己写明讲的物品，`children` 是目录里它下面的页，`sections` 是各小节的标题从 `text` 的第几个字符起，`text` 是 Markdown（里面留着几样原样的 HTML：`<br>`、`<u>`、`<kbd>`、`<a>`、`<details>`）。`english=1` 只对两种语言都有的页管用。没有这一页是 404。

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
