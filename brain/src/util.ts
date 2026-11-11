// 到处都要用的几个小函数：不依赖本项目里任何别的模块，store、packdata、render、design、tools、agent 都能放心地引。

/** 是不是一个普通的对象（不是 null、不是数组）：读 JSON 时先用它认。 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 是不是一个整数。 */
export function isWhole(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

/** 数组里的字符串（别的丢掉）；不是数组时是空的。 */
export function stringsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 字符串去掉首尾空白、截到 max 个字符；不是字符串时是空串。 */
export function trimmedText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** 一个错误的说法：Error 取 message，别的转成字符串。 */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 第一行，太长时截到 max 个字符并加“…”。 */
export function firstLine(text: string, max: number): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** 本地时间的日期：2026-11-12。 */
export function localDateKey(now: number): string {
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
