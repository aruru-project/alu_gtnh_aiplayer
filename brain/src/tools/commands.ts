// 以 bot 身份执行的游戏指令（不带 /）。集中放在这里，方便按服务器实际装的指令 mod 改。
// 注意：这些指令还必须在身体那边的允许列表里（mod 配置），否则 bot.command 返回 denied。
//
// 写法按 GTNH 自带的 ServerUtilities 来，回显是在真实服务器上实测的（都是执行当下同步返回）：
//   sethome 名字   →  Home '名字' set!
//   home list      →  Alu: 2 / 99: 名字, 名字
//   team join 不存在的队伍 →  Team '名字' not found!
//   tell 在线的人   →  You whisper to 名字: 内容
//   tell 不在线的人 →  That player cannot be found
// /home <名字> 的传送由身体的 home 任务执行，不在这里；home 不存在时那个任务以 invalid 失败，
// 消息是 Unknown Home: '名字'!

export const COMMANDS = {
  /** 私聊某个玩家。 */
  whisper: (player: string, message: string): string => `tell ${player} ${message}`,
  /** 把当前位置设为一个 home。 */
  setHome: (name: string): string => `sethome ${name}`,
  /** 列出已有的 home。 */
  listHomes: (): string => 'home list',
  /** 加入一个已经邀请了它的队伍（主人先执行 /team status <bot> invited）。允许列表里只放行 team join。 */
  joinTeam: (team: string): string => `team join ${team}`,
} as const

/**
 * 身体的指令允许列表（mod 配置 allowedCommands）的默认内容，照 docs/PROTOCOL.md 抄的。一项可以是几个词（team join）。
 * 协议里没有读现行列表的接口：这份只在指令被拒绝时给模型参考，并写明主人可能改过。
 */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = ['home', 'sethome', 'delhome', 'homes', 'spawn', 'back', 'tell', 'msg', 'w', 'tpa', 'tpaccept', 'team join']

/** 一条指令最多这么长（身体的限制是连斜杠 100 个字符）。 */
export const COMMAND_MAX_CHARS = 99

/** 队伍 id：ServerUtilities 的队伍 id 是小写字母、数字、下划线。 */
export const TEAM_ID_RE = /^[A-Za-z0-9_-]{1,35}$/

/** /tell 成功时服务器回给发送者的那句话（服务器语言是英文）。 */
export const WHISPER_ECHO_RE = /^You whisper to /

/** 悄悄话的几种指令写法（都在身体默认的允许列表里）：tell 玩家 内容。用 run_command 发它们也算对人说过话。 */
export const WHISPER_COMMAND_RE = /^(?:tell|msg|w)\s+(\S+)\s+(\S.*)$/i

/** /tell 没送到时的回显。 */
export const WHISPER_FAILED_RE = /cannot be found|not found|not online/i

/** 指令当下没有回显时，再等这么久看有没有晚到的系统消息。 */
export const COMMAND_REPLY_WAIT_MS = 600

/**
 * 私聊最多这么长。一条 tell 指令放不下的会拆成几条；
 * 短时间内说话加指令超过大约 8 条会被身体拒绝（再多会被服务器当刷屏踢掉），所以总长要压住。
 */
export const WHISPER_MAX_CHARS = 220

/** 公共聊天一次最多说多少字（身体每 100 字分一行，每行都算一条）。 */
export const SAY_MAX_CHARS = 300

/** home 名字只允许这些字符，免得拼进指令后变成别的意思。 */
export const HOME_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

/**
 * 玩家名。不开正版验证的服务器上名字可以是中文等任何文字，所以只挡会让拼出来的指令变成别的意思的字符：
 * 空白、斜杠、反斜杠和颜色符号。和身体对 bot 名字的要求一致。
 */
export const PLAYER_NAME_RE = /^[^\s/\\§]{1,16}$/u
