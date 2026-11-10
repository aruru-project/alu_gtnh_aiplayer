import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Message, ProviderConfig } from '../src/llm/index.ts'

/** 建一个临时数据目录，测试结束时由调用方用 t.after(cleanup) 删掉。 */
export function tmpDir(prefix = 'aiplayer-test-'): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** 轮询等一个条件成立；超时则抛错并带上说明。 */
export async function waitFor<T>(
  what: string,
  probe: () => T | undefined | false | null,
  timeoutMs = 5000,
  intervalMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] }
}

export function openaiConfig(baseUrl: string, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: 'oa', label: 'mock openai', kind: 'openai-chat', baseUrl, apiKey: 'sk-test-openai-1234', model: 'gpt-mock', ...extra }
}

export function anthropicConfig(baseUrl: string, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'an',
    label: 'mock anthropic',
    kind: 'anthropic-messages',
    baseUrl,
    apiKey: 'sk-ant-test-5678',
    model: 'claude-mock',
    ...extra,
  }
}

/** 找一个当前没人监听的端口（用来测“连不上”）。 */
export async function freePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}
