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

/** 造一个 zip 文件（deflate 压缩，文件名 UTF-8）。条目按给的顺序写。 */
export function makeZip(entries: readonly { name: string; data: Buffer | string }[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data) : entry.data
    const packed = zlib.deflateRawSync(raw)
    // 两种头里从“需要的版本”到“扩展区长度”这 26 个字节是一样的
    const common = Buffer.alloc(26)
    common.writeUInt16LE(20, 0)
    common.writeUInt16LE(0x0800, 2)
    common.writeUInt16LE(8, 4)
    common.writeUInt16LE(0, 6)
    common.writeUInt16LE(0x21, 8)
    common.writeUInt32LE(zlib.crc32(raw), 10)
    common.writeUInt32LE(packed.length, 14)
    common.writeUInt32LE(raw.length, 18)
    common.writeUInt16LE(name.length, 22)
    common.writeUInt16LE(0, 24)
    const local = Buffer.alloc(4)
    local.writeUInt32LE(0x04034b50)
    locals.push(local, common, name, packed)
    const head = Buffer.alloc(6)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    const tail = Buffer.alloc(14)
    tail.writeUInt32LE(offset, 10)
    central.push(head, common, tail, name)
    offset += 4 + common.length + name.length + packed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** 把 RGBA 像素（一行接一行，每像素 4 字节）写成一个 PNG：8 位 RGBA，不滤波。测试里用它造“主人传的图片”。 */
export function encodePng(image: { width: number; height: number; rgba: Buffer }): Buffer {
  const { width, height, rgba } = image
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'latin1')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])))
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/**
 * 假装是身体的 world.blocks：世界里只有 blocks 说的这些方块（"x,y,z" → "注册名" 或 "注册名/meta"；"?" 是没加载的区块），别的都是空气。
 * 回应照协议的约定：最小角、各边格数、调色板（0 号是空气）、“下标, 连续几格”的序列（x 最快，其次 z，最后 y）。
 */
export function worldBlocksAnswer(p: Record<string, unknown>, blocks: Readonly<Record<string, string>>): Record<string, unknown> {
  const n = (key: string): number => Number(p[key])
  const [x1, y1, z1] = [Math.min(n('x1'), n('x2')), Math.min(n('y1'), n('y2')), Math.min(n('z1'), n('z2'))]
  const [sx, sy, sz] = [Math.abs(n('x2') - n('x1')) + 1, Math.abs(n('y2') - n('y1')) + 1, Math.abs(n('z2') - n('z1')) + 1]
  const palette: { id: string; meta?: number }[] = [{ id: 'minecraft:air', meta: 0 }]
  const index = new Map<string, number>()
  const runs: number[] = []
  let unloaded = 0
  for (let y = y1; y < y1 + sy; y++) {
    for (let z = z1; z < z1 + sz; z++) {
      for (let x = x1; x < x1 + sx; x++) {
        const key = blocks[`${x},${y},${z}`]
        let at = 0
        if (key !== undefined) {
          if (key === '?') unloaded++
          at = index.get(key) ?? -1
          if (at < 0) {
            const [id, meta] = key.split('/')
            at = palette.push(key === '?' ? { id: '?' } : { id: id!, meta: Number(meta ?? 0) }) - 1
            index.set(key, at)
          }
        }
        if (runs.length > 0 && runs[runs.length - 2] === at) runs[runs.length - 1]!++
        else runs.push(at, 1)
      }
    }
  }
  return { x: x1, y: y1, z: z1, sx, sy, sz, palette, runs, unloaded }
}
