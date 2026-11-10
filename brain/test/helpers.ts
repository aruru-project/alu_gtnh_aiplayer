import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
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

/**
 * 造一个 Schematica 的 .schematic 文件（gzip 压缩的 NBT）：一个 width×height×length 的盒子，每一格由 blockAt 决定。
 * blockAt 返回方块的注册名，或者 [注册名, meta]；返回 undefined 是空气。
 * 和真文件一样：Blocks 里是数字 id，哪个数字是哪种方块写在 SchematicaMapping 里；格子的顺序是 x + (y * length + z) * width。
 */
export function makeSchematic(
  size: { width: number; height: number; length: number },
  blockAt: (x: number, y: number, z: number) => string | [string, number] | undefined,
): Buffer {
  const volume = size.width * size.height * size.length
  const blocks = Buffer.alloc(volume)
  const data = Buffer.alloc(volume)
  const ids = new Map<string, number>([['minecraft:air', 0]])
  for (let y = 0; y < size.height; y++) {
    for (let z = 0; z < size.length; z++) {
      for (let x = 0; x < size.width; x++) {
        const block = blockAt(x, y, z)
        if (block === undefined) continue
        const [name, meta] = typeof block === 'string' ? [block, 0] : block
        if (!ids.has(name)) ids.set(name, ids.size)
        const i = x + (y * size.length + z) * size.width
        blocks[i] = ids.get(name)!
        data[i] = meta
      }
    }
  }
  const parts: Buffer[] = []
  const named = (type: number, name: string) => {
    const head = Buffer.alloc(3)
    head.writeUInt8(type, 0)
    head.writeUInt16BE(Buffer.byteLength(name), 1)
    parts.push(head, Buffer.from(name))
  }
  const short = (name: string, value: number) => {
    named(2, name)
    const b = Buffer.alloc(2)
    b.writeInt16BE(value)
    parts.push(b)
  }
  const bytes = (name: string, value: Buffer) => {
    named(7, name)
    const b = Buffer.alloc(4)
    b.writeInt32BE(value.length)
    parts.push(b, value)
  }
  named(10, 'Schematic')
  short('Width', size.width)
  short('Height', size.height)
  short('Length', size.length)
  named(8, 'Materials')
  parts.push(Buffer.from([0, 5]), Buffer.from('Alpha'))
  bytes('Blocks', blocks)
  bytes('Data', data)
  named(10, 'SchematicaMapping')
  for (const [name, id] of ids) short(name, id)
  parts.push(Buffer.from([0]))
  parts.push(Buffer.from([0]))
  return zlib.gzipSync(Buffer.concat(parts))
}
