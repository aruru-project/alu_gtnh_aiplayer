// 一个小 JSON 状态文件：读一次，之后每次改动落盘（可选节流）。

import { readJson, writeJsonAtomic } from './files.ts'

export class JsonFile<T> {
  private readonly file: string
  private readonly throttleMs: number
  private value: T
  private timer: NodeJS.Timeout | undefined
  private dirty = false

  /** parse 负责把磁盘上的任意内容整理成 T（文件不存在时收到 undefined）。 */
  constructor(file: string, parse: (raw: unknown) => T, opts: { throttleMs?: number } = {}) {
    this.file = file
    this.throttleMs = opts.throttleMs ?? 0
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
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.throttleMs)
      this.timer.unref()
    }
  }

  /** 把还没写的改动立刻写下去。退出前要调。 */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.dirty) {
      this.dirty = false
      writeJsonAtomic(this.file, this.value)
    }
  }
}
