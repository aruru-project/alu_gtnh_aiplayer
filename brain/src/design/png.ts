// PNG 解码：把一个 PNG 文件读成 RGBA 像素。只用内置的 zlib。
// 面板上传图片时浏览器已经把图缩小并转成了 PNG，所以大脑只需要会读 PNG（不碰 JPEG）。
// 支持：灰度、RGB、调色板、灰度+透明、RGBA；位深 1/2/4/8/16（16 位取高 8 位）。不支持隔行扫描（Adam7）。

import zlib from 'node:zlib'

export interface DecodedImage {
  width: number
  height: number
  /** 一行接一行、从上到下，每个像素 4 个字节：红、绿、蓝、不透明度（0–255）。 */
  rgba: Buffer
}

/** 不是能读的 PNG：消息是给上传的人看的。 */
export class PngError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PngError'
  }
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 每种颜色类型一个像素有几个采样，和允许的位深。 */
const COLOR_TYPES: Record<number, { samples: number; depths: number[] }> = {
  0: { samples: 1, depths: [1, 2, 4, 8, 16] },
  2: { samples: 3, depths: [8, 16] },
  3: { samples: 1, depths: [1, 2, 4, 8] },
  4: { samples: 2, depths: [8, 16] },
  6: { samples: 4, depths: [8, 16] },
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * 解码。maxPixels 是宽×高的上限：超过就拒绝，不去解压（免得一个小文件解出一大片内存）。
 */
export function decodePng(bytes: Buffer, limits: { maxPixels: number } = { maxPixels: 4_000_000 }): DecodedImage {
  if (bytes.length < SIGNATURE.length || !bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) throw new PngError('这不是 PNG 文件')
  let at = SIGNATURE.length
  let header: { width: number; height: number; depth: number; colorType: number } | undefined
  let palette: Buffer | undefined
  let transparency: Buffer | undefined
  const data: Buffer[] = []
  let ended = false
  while (!ended) {
    if (at + 12 > bytes.length) throw new PngError('PNG 文件不完整')
    const length = bytes.readUInt32BE(at)
    const type = bytes.toString('latin1', at + 4, at + 8)
    const end = at + 8 + length
    if (end + 4 > bytes.length) throw new PngError('PNG 文件不完整')
    const body = bytes.subarray(at + 8, end)
    if (zlib.crc32(bytes.subarray(at + 4, end)) !== bytes.readUInt32BE(end)) throw new PngError('PNG 文件损坏了（校验和对不上）')
    at = end + 4
    if (header === undefined && type !== 'IHDR') throw new PngError('PNG 文件开头不对')
    switch (type) {
      case 'IHDR': {
        if (length !== 13) throw new PngError('PNG 文件开头不对')
        header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8]!, colorType: body[9]! }
        const kind = COLOR_TYPES[header.colorType]
        if (!kind || !kind.depths.includes(header.depth) || body[10] !== 0 || body[11] !== 0) throw new PngError('这种 PNG 读不了（颜色格式不认识）')
        if (body[12] !== 0) throw new PngError('这张 PNG 是隔行扫描的，读不了：另存成不隔行的再传')
        if (header.width === 0 || header.height === 0) throw new PngError('这张图没有大小')
        if (header.width * header.height > limits.maxPixels) throw new PngError(`这张图有 ${header.width}×${header.height} 像素，太大了`)
        break
      }
      case 'PLTE':
        palette = body
        break
      case 'tRNS':
        transparency = body
        break
      case 'IDAT':
        data.push(body)
        break
      case 'IEND':
        ended = true
        break
      default:
        break // 其余的块（时间、注释、色彩空间……）用不上
    }
  }
  if (!header) throw new PngError('PNG 文件开头不对')
  const { width, height, depth, colorType } = header
  const samples = COLOR_TYPES[colorType]!.samples
  if (colorType === 3 && (!palette || palette.length < 3)) throw new PngError('PNG 文件损坏了（没有调色板）')

  const rowBytes = Math.ceil((width * samples * depth) / 8)
  const expected = height * (rowBytes + 1)
  let raw: Buffer
  try {
    raw = zlib.inflateSync(Buffer.concat(data), { maxOutputLength: expected })
  } catch {
    throw new PngError('PNG 文件损坏了（像素数据解不开）')
  }
  if (raw.length !== expected) throw new PngError('PNG 文件损坏了（像素数据和尺寸对不上）')

  // 逐行还原滤波。bpp：一个像素占几个字节（不足一个字节的算一个）。
  const bpp = Math.max(1, (samples * depth) >> 3)
  const pixels = Buffer.alloc(height * rowBytes)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]!
    const src = y * (rowBytes + 1) + 1
    const dst = y * rowBytes
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= bpp ? pixels[dst + i - bpp]! : 0
      const up = y > 0 ? pixels[dst + i - rowBytes]! : 0
      const upLeft = y > 0 && i >= bpp ? pixels[dst + i - rowBytes - bpp]! : 0
      let predicted: number
      if (filter === 0) predicted = 0
      else if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) predicted = paeth(left, up, upLeft)
      else throw new PngError('PNG 文件损坏了（不认识的滤波方式）')
      pixels[dst + i] = (raw[src + i]! + predicted) & 0xff
    }
  }

  /** 第 y 行的第 n 个采样，原始值（位深不足 8 时是 0..2^depth-1；16 位时是高 8 位）。 */
  const sample = (y: number, n: number): number => {
    const row = y * rowBytes
    if (depth === 8) return pixels[row + n]!
    if (depth === 16) return pixels[row + n * 2]!
    const bit = n * depth
    return (pixels[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
  }
  /** 位深不足 8 的灰度值拉伸到 0..255。 */
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1
  // 灰度和 RGB 可以指定一种颜色当透明色（tRNS 里是 16 位的值；16 位图这里只比高 8 位）
  const keyOf = (i: number): number | undefined => {
    if (!transparency || transparency.length < (i + 1) * 2) return undefined
    const v = transparency.readUInt16BE(i * 2)
    return depth === 16 ? v >> 8 : v
  }
  const grayKey = colorType === 0 ? keyOf(0) : undefined
  const rgbKey = colorType === 2 ? [keyOf(0), keyOf(1), keyOf(2)] : undefined

  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      let r: number
      let g: number
      let b: number
      let a = 255
      if (colorType === 0 || colorType === 4) {
        const v = sample(y, x * samples)
        r = g = b = Math.round(v * scale)
        if (colorType === 4) a = sample(y, x * samples + 1)
        else if (grayKey !== undefined && v === grayKey) a = 0
      } else if (colorType === 3) {
        const index = sample(y, x)
        if (index * 3 + 2 >= palette!.length) throw new PngError('PNG 文件损坏了（颜色不在调色板里）')
        r = palette![index * 3]!
        g = palette![index * 3 + 1]!
        b = palette![index * 3 + 2]!
        if (transparency && index < transparency.length) a = transparency[index]!
      } else {
        r = sample(y, x * samples)
        g = sample(y, x * samples + 1)
        b = sample(y, x * samples + 2)
        if (colorType === 6) a = sample(y, x * samples + 3)
        else if (rgbKey && r === rgbKey[0] && g === rgbKey[1] && b === rgbKey[2]) a = 0
      }
      rgba[o] = r
      rgba[o + 1] = g
      rgba[o + 2] = b
      rgba[o + 3] = a
    }
  }
  return { width, height, rgba }
}
