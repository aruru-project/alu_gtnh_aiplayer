// 模拟服务能用哪些端口。
// 这台机器上跑着真实的游戏服务器和带 mod 的测试服，它们的端口模拟服务绝不能占：
//   25590 正式服 mod 的 bridge    25591 测试服 mod 的 bridge
//   10086 / 10186 游戏端口         25575 / 25576 RCON
// 自动测试一律让系统分配临时端口（listen 0）；手动起模拟服务时用 25600–25699。

export const RESERVED_PORTS: readonly number[] = [25590, 25591, 10086, 10186, 25575, 25576]

export const MOCK_BRIDGE_DEFAULT_PORT = 25600
export const MOCK_LLM_DEFAULT_PORT = 25601

/** 独立运行模拟服务时检查端口；不允许的端口直接退出，不去 listen。 */
export function checkMockPort(port: number, what: string): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`${what}：端口 ${port} 不合法。`)
    process.exit(2)
  }
  if (RESERVED_PORTS.includes(port)) {
    console.error(`${what}：端口 ${port} 是留给游戏服务器或真实 mod 的，模拟服务不能占。请用 25600–25699 之间的端口。`)
    process.exit(2)
  }
}
