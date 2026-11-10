// 把图给模型看：两种线格式各怎么带图，图什么时候换成占位文字，以及“测试连接”带图试一下。
// 对着模拟的模型服务（它像真实接口那样检查图片放的位置和内容，不合规就回 400）。

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { countImages, createClient, imagePlaceholder, keepLatestImages, testConnection, withoutImages } from '../src/llm/index.ts'
import type { GenerateRequest, ImageAttachment, Message } from '../src/llm/index.ts'
import { Raster, encodePng } from '../src/render/index.ts'
import { anthropicConfig, openaiConfig, user } from './helpers.ts'
import { MockLlm, imagesInRequest } from './mock-llm.ts'

const TOOLS = [{ name: 'view_area', description: 'Look', inputSchema: { type: 'object', properties: {} } }]

function picture(label: string, shade = 200): ImageAttachment {
  return { label, mediaType: 'image/png', data: encodePng(new Raster(4, 4, [shade, 10, 10])).toString('base64') }
}

/** 一轮：模型调了两个工具，第一个的结果带一张图，第二个只有文字；后面还有一句系统提示。 */
function turnWithPicture(image: ImageAttachment): Message[] {
  return [
    user('Steve: what does it look like?'),
    {
      role: 'assistant',
      content: [
        { type: 'tool_call', id: 'call_a', name: 'view_area', input: {} },
        { type: 'tool_call', id: 'call_b', name: 'view_area', input: { view: 'top' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', toolCallId: 'call_a', content: 'Picture of x 0..3.', images: [image] },
        { type: 'tool_result', toolCallId: 'call_b', content: 'offline', isError: true },
        { type: 'text', text: 'step limit reached' },
      ],
    },
  ]
}

const request = (messages: Message[]): GenerateRequest => ({ system: 'You are a test bot.', messages, tools: TOOLS })

describe('把图给模型看', () => {
  const llm = new MockLlm()
  before(async () => {
    await llm.start()
  })
  after(() => llm.stop())
  beforeEach(() => {
    llm.requests.length = 0
    llm.rejected.length = 0
    llm.clearScript()
  })

  it('OpenAI 兼容：工具结果里的图放在紧跟其后的一条 user 消息里（tool 消息只能是文字），前面写明是哪个结果的图', async () => {
    const image = picture('iso view of the world at x 0..3')
    await createClient(openaiConfig(llm.openaiBaseUrl), { retry: false }).generate(request(turnWithPicture(image)))
    assert.deepEqual(llm.rejected, [])
    assert.deepEqual(llm.requests[0]!.body.messages.slice(3), [
      { role: 'tool', tool_call_id: 'call_a', content: 'Picture of x 0..3.\n[The picture is in the next message.]' },
      { role: 'tool', tool_call_id: 'call_b', content: 'ERROR: offline' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Picture from the tool result above: iso view of the world at x 0..3]' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}` } },
          { type: 'text', text: 'step limit reached' },
        ],
      },
    ])
    assert.deepEqual(imagesInRequest(llm.requests[0]!).map((i) => [i.mediaType, i.bytes.toString('base64')]), [['image/png', image.data]])
  })

  it('Anthropic 兼容：图就放在 tool_result 的内容里，文字在前、图在后', async () => {
    const image = picture('iso view of the world at x 0..3')
    await createClient(anthropicConfig(llm.anthropicBaseUrl, { options: { promptCaching: false } }), { retry: false }).generate(request(turnWithPicture(image)))
    assert.deepEqual(llm.rejected, [])
    assert.deepEqual(llm.requests[0]!.body.messages[2], {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_a',
          content: [
            { type: 'text', text: 'Picture of x 0..3.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } },
          ],
        },
        { type: 'tool_result', tool_use_id: 'call_b', content: 'offline', is_error: true },
        { type: 'text', text: 'step limit reached' },
      ],
    })
    assert.equal(imagesInRequest(llm.requests[0]!).length, 1)
  })

  it('没有图的消息发出去的样子和以前一样：内容还是一整段文字', async () => {
    const plain = withoutImages(turnWithPicture(picture('p')))
    await createClient(openaiConfig(llm.openaiBaseUrl), { retry: false }).generate(request(plain))
    await createClient(anthropicConfig(llm.anthropicBaseUrl), { retry: false }).generate(request(plain))
    assert.deepEqual(llm.rejected, [])
    const placeholder = imagePlaceholder(picture('p'))
    assert.deepEqual(llm.requests[0]!.body.messages.slice(3), [
      { role: 'tool', tool_call_id: 'call_a', content: `${placeholder}\nPicture of x 0..3.` },
      { role: 'tool', tool_call_id: 'call_b', content: 'ERROR: offline' },
      { role: 'user', content: 'step limit reached' },
    ])
    assert.equal(llm.requests[1]!.body.messages[2].content[0].content, `${placeholder}\nPicture of x 0..3.`)
    assert.deepEqual([imagesInRequest(llm.requests[0]!), imagesInRequest(llm.requests[1]!)], [[], []])
  })

  it('只留最近的几张图：更早的换成一句占位文字（写着那是什么图），放在原来那段结果的最前面；原来的消息不动', () => {
    const a = picture('first look', 10)
    const b = picture('second look', 20)
    const c = picture('third look', 30)
    const messages: Message[] = [
      user('go'),
      { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'view_area', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: 'two pictures', images: [a, b] }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 't2', name: 'view_area', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolCallId: 't2', content: 'one picture', images: [c] }, { type: 'image', image: a }] },
    ]
    const before = structuredClone(messages)
    assert.equal(countImages(messages), 4)
    // 都留得下时原样返回
    assert.equal(keepLatestImages(messages, 4), messages)

    const two = keepLatestImages(messages, 2)
    assert.equal(countImages(two), 2)
    assert.deepEqual(two[2], { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: `${imagePlaceholder(a)}\n${imagePlaceholder(b)}\ntwo pictures` }] })
    assert.deepEqual(two[4], messages[4])

    // 一条结果里的两张图可以只换掉前一张
    const three = keepLatestImages(messages, 3)
    assert.deepEqual(three[2], { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: `${imagePlaceholder(a)}\ntwo pictures`, images: [b] }] })

    const none = withoutImages(messages)
    assert.equal(countImages(none), 0)
    assert.deepEqual(none[4], { role: 'user', content: [{ type: 'tool_result', toolCallId: 't2', content: `${imagePlaceholder(c)}\none picture` }, { type: 'text', text: imagePlaceholder(a) }] })
    assert.equal(JSON.stringify(none).includes(a.data), false)
    assert.match(imagePlaceholder(a), /^\[picture seen earlier, no longer attached: first look\. /)
    assert.deepEqual(messages, before)
  })

  it('测试连接：模型标着“能看图”时请求里带一张小图，接口不收图就当场报出来；没标的不带图', async () => {
    const seeing = await testConnection(openaiConfig(llm.openaiBaseUrl, { vision: true }))
    assert.deepEqual([seeing.ok, seeing.withPicture, seeing.reply], [true, true, 'ok'])
    assert.equal(imagesInRequest(llm.requests[0]!).length, 1)
    assert.equal((await testConnection(anthropicConfig(llm.anthropicBaseUrl, { vision: true }))).ok, true)
    assert.equal(imagesInRequest(llm.requests[1]!).length, 1)
    assert.deepEqual(llm.rejected, [])

    const plain = await testConnection(openaiConfig(llm.openaiBaseUrl))
    assert.deepEqual([plain.ok, plain.withPicture], [true, undefined])
    assert.deepEqual(imagesInRequest(llm.requests[2]!), [])

    // 这个模型其实不收图
    llm.enqueue({ status: 400, errorMessage: 'This model does not support image input.' })
    const refused = await testConnection(openaiConfig(llm.openaiBaseUrl, { vision: true }))
    assert.deepEqual([refused.ok, refused.withPicture, refused.error?.status], [false, true, 400])
    assert.match(refused.error!.message, /does not support image input/)
  })

  it('模拟的模型服务像真实接口那样拒绝放错地方或内容不对的图', async () => {
    const good = picture('p')
    const send = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${llm.port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const call = { id: 'c1', type: 'function', function: { name: 'view_area', arguments: '{}' } }
    // OpenAI：图放进了 tool 消息
    const inTool = await send('/v1/chat/completions', {
      model: 'm',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: 'c1', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${good.data}` } }] },
      ],
    })
    assert.equal(inTool.status, 400)
    assert.match(((await inTool.json()) as { error: { message: string } }).error.message, /image_url content parts are only allowed in messages with the user role/)
    // 两家：声称是 PNG、内容不是
    const notPng = Buffer.from('this is not a png file!!').toString('base64')
    const badOpenAi = await send('/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${notPng}` } }] }] })
    assert.equal(badOpenAi.status, 400)
    const badAnthropic = await send('/v1/messages', { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: notPng } }] }] }, { 'anthropic-version': '2023-06-01' })
    assert.equal(badAnthropic.status, 400)
    assert.match(((await badAnthropic.json()) as { error: { message: string } }).error.message, /Could not process image/)
    assert.equal(llm.rejected.length, 3)
  })
})
