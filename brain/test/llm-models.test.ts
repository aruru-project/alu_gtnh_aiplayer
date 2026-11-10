// 问一家接口它有哪些模型（面板填模型名时用）。对着模拟的模型服务：两种线格式、拉到和拉不到。

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import { listRemoteModels } from '../src/llm/index.ts'
import { anthropicConfig, freePort, openaiConfig } from './helpers.ts'
import { MockLlm } from './mock-llm.ts'

describe('拉模型列表', () => {
  const llm = new MockLlm()
  before(async () => {
    await llm.start()
  })
  after(() => llm.stop())
  beforeEach(() => {
    llm.modelList = [{ id: 'zeta-large' }, { id: 'alpha-mini', displayName: 'Alpha Mini' }, { id: 'zeta-large' }]
    llm.modelListRequests.length = 0
  })

  it('OpenAI 兼容：GET {服务地址}/models，带着 key；拿回模型名，按名字排好、去掉重复的', async () => {
    const res = await listRemoteModels(openaiConfig(llm.openaiBaseUrl, { model: '', extraHeaders: { 'x-team': 'gtnh' } }))
    assert.deepEqual(res, { ok: true, models: [{ id: 'alpha-mini' }, { id: 'zeta-large' }] })
    assert.equal(llm.modelListRequests.length, 1)
    const sent = llm.modelListRequests[0]!
    assert.equal(sent.path, '/v1/models')
    assert.equal(sent.headers.authorization, 'Bearer sk-test-openai-1234')
    assert.equal(sent.headers['x-team'], 'gtnh')
  })

  it('Anthropic 兼容：GET {服务地址}/v1/models，key 放在 x-api-key（或按设置放在 Bearer）；接口给的显示名一起带回来', async () => {
    const res = await listRemoteModels(anthropicConfig(llm.anthropicBaseUrl, { model: '' }))
    assert.deepEqual(res, { ok: true, models: [{ id: 'alpha-mini', label: 'Alpha Mini' }, { id: 'zeta-large' }] })
    const sent = llm.modelListRequests[0]!
    assert.equal(sent.path, '/v1/models')
    assert.deepEqual([sent.headers['x-api-key'], sent.headers['anthropic-version'], sent.headers.authorization], ['sk-ant-test-5678', '2023-06-01', undefined])

    await listRemoteModels(anthropicConfig(llm.anthropicBaseUrl, { model: '', options: { authStyle: 'bearer' } }))
    assert.deepEqual([llm.modelListRequests[1]!.headers['x-api-key'], llm.modelListRequests[1]!.headers.authorization], [undefined, 'Bearer sk-ant-test-5678'])
  })

  it('拉不到不抛错，说明原因：key 不对、接口没有这个功能、回的不是模型列表、连不上', async () => {
    llm.modelList = { status: 401, message: 'Incorrect API key provided' }
    const denied = await listRemoteModels(openaiConfig(llm.openaiBaseUrl))
    assert.deepEqual([denied.ok, denied.error?.kind, denied.error?.status, denied.models], [false, 'auth', 401, undefined])
    assert.match(denied.error!.message, /Incorrect API key provided/)

    // 第三方网关常常没有这个接口
    llm.modelList = { status: 404, message: 'no route GET /v1/models' }
    const missing = await listRemoteModels(anthropicConfig(llm.anthropicBaseUrl))
    assert.deepEqual([missing.ok, missing.error?.status], [false, 404])

    llm.modelList = { status: 200, message: '', rawBody: '{"hello":"world"}' }
    const odd = await listRemoteModels(openaiConfig(llm.openaiBaseUrl))
    assert.deepEqual([odd.ok, odd.error?.kind], [false, 'server'])
    llm.modelList = { status: 200, message: '', rawBody: '<html>login</html>' }
    assert.equal((await listRemoteModels(openaiConfig(llm.openaiBaseUrl))).ok, false)

    const nobody = await listRemoteModels(openaiConfig(`http://127.0.0.1:${await freePort()}/v1`))
    assert.deepEqual([nobody.ok, nobody.error?.kind], [false, 'network'])
  })
})
