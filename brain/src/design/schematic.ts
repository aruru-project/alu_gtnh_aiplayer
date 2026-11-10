// 草稿 → Schematica 的 .schematic 文件（gzip 压缩的 NBT），身体的 blueprint.put 收的就是它。
// 写法以 mod/src/main/java/alu/aiplayer/world/Blueprint.java 的读法为准：
//   Width / Height / Length：x / y / z 三个方向的尺寸；
//   Blocks：每格一个字节，是方块的数字 id 的低 8 位；格子的顺序是 x + (y * Length + z) * Width；
//   AddBlocks：数字 id 超过 255 时才有，每格半个字节（id 的第 9–12 位），偶数格在高半字节（Schematica 的习惯）；
//   Data：每格的 meta；
//   SchematicaMapping：注册名 → 这个文件里用的数字 id。身体按名字认方块，所以数字 id 是这里自己编的：空气 0，其余从 1 排起。

import zlib from 'node:zlib'
import type { Draft } from './draft.ts'

/** 协议定的 blueprint.put 的文件上限。 */
export const SCHEMATIC_MAX_BYTES = 2 * 1024 * 1024

const TAG_SHORT = 2
const TAG_BYTE_ARRAY = 7
const TAG_STRING = 8
const TAG_LIST = 9
const TAG_COMPOUND = 10

function named(type: number, name: string, payload: Buffer): Buffer {
  const text = Buffer.from(name, 'utf8')
  const head = Buffer.alloc(3)
  head.writeUInt8(type, 0)
  head.writeUInt16BE(text.length, 1)
  return Buffer.concat([head, text, payload])
}

function short(name: string, value: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeInt16BE(value)
  return named(TAG_SHORT, name, b)
}

function text(name: string, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8')
  const length = Buffer.alloc(2)
  length.writeUInt16BE(bytes.length)
  return named(TAG_STRING, name, Buffer.concat([length, bytes]))
}

function byteArray(name: string, value: Uint8Array): Buffer {
  const length = Buffer.alloc(4)
  length.writeInt32BE(value.length)
  return named(TAG_BYTE_ARRAY, name, Buffer.concat([length, value]))
}

function emptyCompoundList(name: string): Buffer {
  const payload = Buffer.alloc(5)
  payload.writeUInt8(TAG_COMPOUND, 0)
  return named(TAG_LIST, name, payload)
}

function compound(name: string, children: Buffer[]): Buffer {
  return named(TAG_COMPOUND, name, Buffer.concat([...children, Buffer.from([0])]))
}

/** 把草稿写成 .schematic 文件的字节。 */
export function toSchematic(draft: Draft): Buffer {
  const { x: sx, y: sy, z: sz } = draft.size
  const volume = sx * sy * sz
  // 同一种方块的不同 meta 共用一个数字 id
  const numericId = new Map<string, number>([['minecraft:air', 0]])
  const idOfKind = draft.kinds.map((kind) => {
    let n = numericId.get(kind.id)
    if (n === undefined) {
      n = numericId.size
      numericId.set(kind.id, n)
    }
    return n
  })
  const blocks = new Uint8Array(volume)
  const data = new Uint8Array(volume)
  const wide = numericId.size > 256
  const add = new Uint8Array(wide ? (volume + 1) >> 1 : 0)
  for (let i = 0; i < volume; i++) {
    const cell = draft.cells[i]!
    if (cell === 0) continue
    const id = idOfKind[cell - 1]!
    blocks[i] = id & 0xff
    data[i] = draft.kinds[cell - 1]!.meta
    if (wide) add[i >> 1]! |= (i & 1) === 0 ? (id >> 8) << 4 : id >> 8
  }
  const root = compound('Schematic', [
    short('Width', sx),
    short('Height', sy),
    short('Length', sz),
    text('Materials', 'Alpha'),
    byteArray('Blocks', blocks),
    byteArray('Data', data),
    ...(wide ? [byteArray('AddBlocks', add)] : []),
    emptyCompoundList('Entities'),
    emptyCompoundList('TileEntities'),
    compound('SchematicaMapping', [...numericId].map(([name, id]) => short(name, id))),
  ])
  return zlib.gzipSync(root)
}
