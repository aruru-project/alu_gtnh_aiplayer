// 模型看图这条路在 agent 里怎么走：工具结果带的图只给能看图的模型，只在这一轮里跟着，之后换成占位文字。
// 假的游戏和按脚本回应的假模型；工具、历史、日志都是真的。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { LIVE_IMAGES_MAX } from '../src/agent/agent.ts'
import { countImages } from '../src/llm/index.ts'
import type { GenerateRequest, ToolResultPart } from '../src/llm/index.ts'
import { decodePng } from '../src/design/index.ts'
import { PICTURES_KEPT, PictureStore } from '../src/store/pictures.ts'
import { NO_VISION_NOTE } from '../src/tools/pictures.ts'
import { chat, makeAgent, reply } from './agent-harness.ts'
import type { MakeAgentOptions } from './agent-harness.ts'
import { tmpDir, worldBlocksAnswer } from './helpers.ts'

/** 假世界里有一小堆石头；view_area 看得到它。 */
function agentWithWorld(t: { after(fn: () => void): void }, opts: MakeAgentOptions = {}) {
  const tmp = tmpDir()
  t.after(tmp.cleanup)
  const pictures = new PictureStore(tmp.dir)
  const h = makeAgent({ dir: tmp.dir, pictures, ...opts })
  h.game.handlers['world.blocks'] = (p) => worldBlocksAnswer(p, { '10,63,-4': 'minecraft:stone', '11,63,-4': 'minecraft:stone' })
  return { ...h, pictures, dir: tmp.dir }
}

/** 一次请求里所有工具结果，按出现的顺序。 */
function toolResults(req: GenerateRequest): ToolResultPart[] {
  return req.messages.flatMap((m) => (m.role === 'user' ? m.content.filter((p) => p.type === 'tool_result') : []))
}

describe('agent：把图给模型看', () => {
  it('能看图的模型：它要的图跟在工具结果里发过去；到了下一轮，这张图换成一句占位文字，不再重新发、不再算钱；历史文件里没有图', async (t) => {
    const h = agentWithWorld(t, { vision: true })
    h.llm.enqueue(reply('', [{ id: 'look', name: 'view_area', input: { radius: 4 } }]), reply('', [{ id: 'say1', name: 'say', input: { message: '一小堆石头。' } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 看看你周围'))
    await h.agent.whenIdle()

    // 第 1 次请求：还没看过图
    assert.equal(countImages(h.llm.requests[0]!.messages), 0)
    // 第 2 次请求（拿到 view_area 的结果）：图跟着那条结果
    const seen = toolResults(h.llm.requests[1]!).find((r) => r.toolCallId === 'look')!
    assert.equal(seen.images?.length, 1)
    assert.match(seen.content, /^Picture of x 6\.\.14, y 61\.\.72, z -8\.\.0 \(9×12×9 blocks\): iso view from the southeast corner/)
    const image = seen.images![0]!
    assert.deepEqual([image.mediaType, image.label], ['image/png', 'iso view from the southeast corner of the world at x 6..14, y 61..72, z -8..0'])
    assert.ok(decodePng(Buffer.from(image.data, 'base64')).width > 100)
    // 第 3 次请求（同一轮里接着干）：图还在，它还能对着图想
    assert.equal(countImages(h.llm.requests[2]!.messages), 1)

    // 下一轮
    h.llm.enqueue(reply('', [{ name: 'say', input: { message: '还是那堆石头。' } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 现在呢'))
    await h.agent.whenIdle()
    for (const n of [3, 4]) {
      const req = h.llm.requests[n]!
      assert.equal(countImages(req.messages), 0, `request ${n} must not carry the old picture`)
      assert.equal(JSON.stringify(req.messages).includes(image.data), false)
      const old = toolResults(req).find((r) => r.toolCallId === 'look')!
      assert.equal(old.images, undefined)
      assert.match(old.content, /^\[picture seen earlier, no longer attached: iso view from the southeast corner of the world at x 6\.\.14, y 61\.\.72, z -8\.\.0\. Ask for it again if you need to look at it once more\.\]\nPicture of x 6\.\.14/)
    }
    // 落盘的历史里也没有图的内容（重启以后同样不会再发）
    const saved = fs.readFileSync(path.join(h.dir, 'history.json'), 'utf8')
    assert.equal(saved.includes(image.data.slice(0, 200)), false)
    assert.ok(saved.includes('picture seen earlier, no longer attached'))
    assert.ok(saved.length < 30_000, `history.json is ${saved.length} chars`)
  })

  it('看不了图的模型：同一个工具只给文字（开头写明看不了图），请求里没有图；图照样存一份，面板的对话日志里看得到', async (t) => {
    const h = agentWithWorld(t)
    h.llm.enqueue(reply('', [{ id: 'look', name: 'view_area', input: { radius: 4 } }]), reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 看看你周围'))
    await h.agent.whenIdle()
    assert.equal(countImages(h.llm.requests[1]!.messages), 0)
    const result = toolResults(h.llm.requests[1]!).find((r) => r.toolCallId === 'look')!
    assert.equal(result.images, undefined)
    assert.ok(result.content.startsWith(`${NO_VISION_NOTE}\nArea x 6..14, y 61..72, z -8..0 (9×12×9 blocks).`), result.content)
    assert.match(result.content, /\ny=63: 2 of 81 cells filled: 2 stone\n/)

    const entry = h.log.recent(0, 100).find((e) => e.kind === 'tool_result' && e.who === 'view_area')!
    assert.equal(entry.pictures?.length, 1)
    const png = h.pictures.get(entry.pictures![0]!)
    assert.ok(png && decodePng(png).width > 100)
    // 画这张图用的方块也存下了（面板的三维预览用）：就是身体给的那个盒子，加上标自己位置的记号（Steve 站在盒子外面，不标）
    assert.deepEqual(entry.scenes, entry.pictures)
    const blocks = h.pictures.blocks(entry.pictures![0]!) as { x: number; y: number; z: number; sx: number; sy: number; sz: number; palette: { id: string }[] }
    assert.deepEqual([blocks.x, blocks.y, blocks.z, blocks.sx, blocks.sy, blocks.sz], [6, 61, -8, 9, 12, 9])
    assert.deepEqual(blocks.palette.map((k) => k.id), ['minecraft:air', 'minecraft:stone', '@Alu'])
    // 别的工具结果不带图
    assert.equal(h.log.recent(0, 100).filter((e) => e.pictures !== undefined).length, 1)
  })

  it(`一轮里要了很多张图：同时跟着的最多 ${LIVE_IMAGES_MAX} 张，更早的换成占位文字`, async (t) => {
    const h = agentWithWorld(t, { vision: true })
    const looks = LIVE_IMAGES_MAX + 2
    for (let n = 0; n < looks; n++) h.llm.enqueue(reply('', [{ id: `look${n}`, name: 'view_area', input: { radius: 2 + n } }]))
    h.llm.enqueue(reply(''))
    h.agent.handleEvent(chat('Steve', 'Alu 多看几眼'))
    await h.agent.whenIdle()
    // 每多看一次多一张，到上限为止
    assert.deepEqual(h.llm.requests.map((r) => countImages(r.messages)), [0, 1, 2, 3, 4, 4, 4])
    const last = toolResults(h.llm.requests[looks]!)
    assert.deepEqual(last.map((r) => [r.toolCallId, r.images?.length ?? 0, r.content.startsWith('[picture seen earlier')]), [
      ['look0', 0, true],
      ['look1', 0, true],
      ['look2', 1, false],
      ['look3', 1, false],
      ['look4', 1, false],
      ['look5', 1, false],
    ])
  })

  it('留给面板看的图只留最近的若干张，旧的自动清掉；编号不合规的取不到', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const store = new PictureStore(tmp.dir)
    const ids: string[] = []
    for (let n = 0; n < PICTURES_KEPT + 5; n++) ids.push(store.save(Buffer.from(`picture ${n}`)))
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(fs.readdirSync(path.join(tmp.dir, 'pictures')).length, PICTURES_KEPT)
    assert.deepEqual([store.get(ids[0]!), store.get(ids[4]!)], [undefined, undefined])
    assert.equal(store.get(ids[5]!)?.toString(), 'picture 5')
    assert.equal(store.get(ids.at(-1)!)?.toString(), `picture ${PICTURES_KEPT + 4}`)
    for (const bad of ['', '../config', 'a/b', `${ids.at(-1)!}.png`, '..']) assert.equal(store.get(bad), undefined)
    // 重启以后还取得到
    assert.equal(new PictureStore(tmp.dir).get(ids.at(-1)!)?.toString(), `picture ${PICTURES_KEPT + 4}`)

    // 简图连同画它用的方块一起存；图清掉时那份方块也清掉
    const withBlocks = store.save(Buffer.from('a drawing'), { sx: 1, runs: [0, 1] })
    assert.deepEqual(store.blocks(withBlocks), { sx: 1, runs: [0, 1] })
    assert.equal(store.blocks(ids.at(-1)!), undefined)
    for (let n = 0; n < PICTURES_KEPT; n++) store.save(Buffer.from('newer'))
    assert.deepEqual([store.get(withBlocks), store.blocks(withBlocks)], [undefined, undefined])
    assert.deepEqual(fs.readdirSync(path.join(tmp.dir, 'pictures')).filter((f) => f.endsWith('.json')), [])
  })
})
