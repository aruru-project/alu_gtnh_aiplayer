import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { JsonFile } from '../src/store/json-file.ts'
import { tmpDir, waitFor } from './helpers.ts'

const parse = (raw: unknown) => (raw as { n: number } | undefined) ?? { n: 0 }

describe('JsonFile 节流落盘', () => {
  it('定时落盘失败不会从定时器里抛出；改动留着，之后重试写上', async (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const file = path.join(tmp.dir, 'state.json')
    const errors: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    t.after(() => {
      console.error = original
    })
    const store = new JsonFile(file, parse, { throttleMs: 10, retryMs: 30 })
    // 目标位置被一个非空目录占着，改名一定失败
    fs.mkdirSync(path.join(file, 'x'), { recursive: true })
    store.set({ n: 1 })
    await waitFor('第一次写失败', () => errors.length > 0)
    fs.rmSync(file, { recursive: true })
    await waitFor('重试后写上', () => fs.existsSync(file) && fs.statSync(file).isFile())
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 1 })
    assert.deepEqual(fs.readdirSync(tmp.dir), ['state.json'], '临时文件不留下')
  })

  it('flush 写失败时抛出，改动仍算没写，下次 flush 写上', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const file = path.join(tmp.dir, 'state.json')
    const store = new JsonFile(file, parse, { throttleMs: 60_000 })
    fs.mkdirSync(path.join(file, 'x'), { recursive: true })
    store.set({ n: 2 })
    assert.throws(() => store.flush())
    fs.rmSync(file, { recursive: true })
    store.flush()
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 2 })
  })
})
