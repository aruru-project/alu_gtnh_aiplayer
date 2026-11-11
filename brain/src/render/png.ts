// PNG 编码：把一块 RGB 画布写成 PNG 文件。只用内置的 zlib（压缩和 CRC 都是它的）。解码在 design/png.ts。

import zlib from 'node:zlib'

/** 每个 PNG 文件开头的那 8 个字节（解码那边也认它）。 */
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(body.length + 12)
  out.writeUInt32BE(body.length, 0)
  out.write(type, 4, 'latin1')
  body.copy(out, 8)
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + body.length)), 8 + body.length)
  return out
}

/**
 * 8 位真彩色（不带透明度）的 PNG。rgb 是一行接一行、每个像素 3 个字节。
 * 每一行都用“不过滤”：简图是大片的纯色，直接压就已经很小了。
 */
export function encodePng(image: { width: number; height: number; data: Uint8Array }): Buffer {
  const { width, height, data } = image
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError('a PNG needs a width and height of at least 1')
  if (data.length !== width * height * 3) throw new RangeError('the pixel data does not match the size of the image')
  const stride = width * 3 + 1
  const raw = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * width * 3, (y + 1) * width * 3), y * stride + 1)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // 位深
  header[9] = 2 // 颜色类型：RGB
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}
