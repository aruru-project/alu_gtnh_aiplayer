// bridge 口令从哪里来：配置里直接写的，或者一个口令文件。

import fs from 'node:fs'
import path from 'node:path'

export interface TokenSource {
  /** 直接写的口令；非空时优先。 */
  token: string
  /** 口令文件路径；相对路径相对 baseDir。 */
  tokenFile: string
}

/**
 * 读 bridge 口令。
 * - 没配置（既没直接写口令，也没给口令文件）：返回 undefined，那时不连接、不重试。
 * - 配置了口令文件但读不到、是空的、或者内容不像口令：抛 Error（消息给人看），bridge 客户端会按退避重试。
 */
export function readBridgeToken(source: TokenSource, baseDir: string): string | undefined {
  if (source.token.length > 0) return source.token
  if (source.tokenFile.length === 0) return undefined
  const file = path.resolve(baseDir, source.tokenFile)
  let token: string
  try {
    token = fs.readFileSync(file, 'utf8').trim()
  } catch (e) {
    throw new Error(`读不到 bridge 口令文件 ${file}（${(e as NodeJS.ErrnoException).code ?? 'error'}）。游戏服务器带着 mod 启动过一次才会有这个文件`)
  }
  if (token.length === 0) throw new Error(`bridge 口令文件 ${file} 是空的`)
  // 口令是 mod 生成的一行可打印字符。别的文件（路径被人填错或故意填成别的）不该被当成口令发出去。
  if (token.length > 256 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error(`${file} 看起来不是 bridge 口令文件（口令应该是一行不带空格的字符）`)
  }
  return token
}
