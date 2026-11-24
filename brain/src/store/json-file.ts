// 一个小 JSON 状态文件：读一次，之后每次改动落盘（可选节流）。

import { readJson, writeJsonAtomic } from './files.ts'

const DEFAULT_RETRY_MS = 5_000

export class JsonFile<T> {
  private readonly file: string
  private readonly throttleMs: number
  private readonly retryMs: number
  private value: T
  private timer: NodeJS.Timeout | undefined
  private dirty = false

  /** parse 负责把磁盘上的任意内容整理成 T（文件不存在时收到 undefined）。 */
  constructor(file: string, parse: (raw: unknown) => T, opts: { throttleMs?: number; retryMs?: number } = {}) {
    this.file = file
    this.throttleMs = opts.throttleMs ?? 0
    this.retryMs = opts.retryMs ?? DEFAULT_RETRY_MS
    this.value = parse(readJson(file))
  }

  get(): T {
    return this.value
  }

  set(value: T): void {
    this.value = value
    if (this.throttleMs <= 0) {
      writeJsonAtomic(this.file, this.value)
      return
    }
    this.dirty = true
    if (!this.timer) this.schedule(this.throttleMs)
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => this.flushLater(), ms)
    this.timer.unref()
  }

  /**
   * 定时器里的落盘。写不下去（磁盘满、没权限）时异常不能从定时器里冒出去把整个进程带走：
   * 改动留着，过一会儿再试。
   */
  private flushLater(): void {
    this.timer = undefined
    try {
      this.flush()
    } catch (e) {
      console.error(`[store] 写 ${this.file} 失败，${this.retryMs} ms 后重试：${(e as Error).message}`)
      this.schedule(this.retryMs)
    }
  }

  /** 把还没写的改动立刻写下去。退出前要调。写失败时抛出，改动仍算没写。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.dirty) {
      this.dirty = false
      try {
        writeJsonAtomic(this.file, this.value)
      } catch (e) {
        this.dirty = true
        throw e
      }
    }
  }
}
