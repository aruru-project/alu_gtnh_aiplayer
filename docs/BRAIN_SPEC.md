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
- **一轮决策**：把待处理事件格式化成一条 user 消息（附当前状态快照：位置、血量、背包摘要、当前任务和队列、在线玩家、游戏内时间）→ 调模型 → 顺序执行工具调用 → 结果回给模型 → 直到模型不再调用工具或达到步数上限（默认 16）。
  - 同一时刻只跑一轮。期间到达的事件排队，本轮结束后合并成下一轮。
  - 任务是异步的：启动任务的工具立刻返回“已开始”，模型应当结束这一轮；任务结束事件会再次唤醒它。提示词里要讲清这一点。
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

## bridge 客户端 `bridge/`

- 连接、`hello`、断线指数退避重连、带 `serverEpoch` + `lastSeq` 续传（落盘）、请求超时、事件分发。
- 口令来源：配置里直接写，或给一个口令文件路径（默认指向测试服的 `config/aiplayer/bridge-token.txt`，路径可配）。
- 协议里的方法做成有类型的薄封装。

## 面板 `panel/`

- 默认监听 `127.0.0.1:8765`，地址和端口可配（环境变量和配置文件）。
- 访问口令：首次启动随机生成，打印到标准输出并存入配置。登录后发 HttpOnly、SameSite=Strict 的会话 cookie。除登录外所有 API 需要会话，写操作校验 `Origin`。
- **API key 只写不读**：接口永远不返回完整 key，只返回掩码（如 `sk-…abcd`）和“已设置”标记；提交空值表示不修改。
- 页面：
  - **概览**：bridge 连接状态、bot 状态（位置、血量、背包）、当前任务和队列（可取消）、当前模型和最近一次调用结果、今日用量。
  - **对话**：实时日志（SSE）——聊天、模型文本、工具调用和结果（可折叠）、错误；一个输入框，以主人身份直接给它下指令。
  - **模型**：服务商增删改、选当前、测试连接。
  - **AI 玩家**：名字、别名、人设提示词（可恢复默认）、主人名单、唤醒方式、各项上限；上线/下线按钮；无敌和饥饿开关（透传 `bot.configure`）。
  - **记忆**：查看、编辑、删除。
- 布局清楚、朴素即可，不追求花哨；手机上也能看。

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
