import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import type { ReadyInfo, ResumeState } from '../src/bridge/client.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import { readBridgeToken } from '../src/bridge/token.ts'
import type { BridgeEvent } from '../src/bridge/protocol.ts'
import { sleep, tmpDir, waitFor } from './helpers.ts'
import { MockBridge, NO_REPLY } from './mock-bridge.ts'

interface Harness {
  client: BridgeClient
  events: BridgeEvent[]
  readies: ReadyInfo[]
  saved: { state: ResumeState | undefined }
}

describe('bridge 客户端', () => {
  let bridge: MockBridge
  const clients: BridgeClient[] = []

  function connect(opts: { token?: string; saved?: { state: ResumeState | undefined }; requestTimeoutMs?: number } = {}): Harness {
    const saved = opts.saved ?? { state: undefined }
    const client = new BridgeClient({
      address: () => ({ host: '127.0.0.1', port: bridge.port }),
      token: () => opts.token ?? bridge.token,
      clientName: 'brain/test',
      requestTimeoutMs: opts.requestTimeoutMs ?? 2000,
      reconnectMinMs: 20,
      reconnectMaxMs: 100,
      resume: { load: () => saved.state, save: (s) => (saved.state = s) },
    })
    const events: BridgeEvent[] = []
    const readies: ReadyInfo[] = []
    client.onEvent((e) => events.push(e))
    client.onReady((r) => readies.push(r))
    client.start()
    clients.push(client)
    return { client, events, readies, saved }
  }

  const connected = (h: Harness) => waitFor('bridge connected', () => h.client.isConnected())

  beforeEach(async () => {
    bridge = new MockBridge({ bots: ['Alu'] })
    await bridge.start()
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) c.stop()
    await bridge.stop()
  })

  it('握手时带上口令和客户端名，之后能发请求拿到结果', async () => {
    const h = connect()
    await connected(h)
    assert.equal(bridge.hellos[0]!.token, bridge.token)
    assert.equal(bridge.hellos[0]!.client, 'brain/test')
    const status = await new BridgeApi(h.client).botStatus('Alu')
    assert.equal(status.name, 'Alu')
    assert.equal(status.online, true)
    assert.deepEqual(status.block, { x: 10, y: 64, z: -4 })
    assert.equal(h.client.status().state, 'connected')
    assert.equal(h.client.status().hello?.modVersion, 'v0.1.0-mock')
  })

  it('对方返回错误时，请求以带错误码的 BridgeError 失败', async () => {
    const h = connect()
    await connected(h)
    await assert.rejects(new BridgeApi(h.client).botStatus('Nobody'), (e: unknown) => {
      assert.ok(e instanceof BridgeError)
      assert.equal(e.code, 'not_found')
      assert.match(e.message, /Nobody/)
      return true
    })
  })

  it('对方一直不回时，请求在超时后以 timeout 失败，连接继续可用', async () => {
    bridge.on('server.info', () => NO_REPLY)
    const h = connect({ requestTimeoutMs: 80 })
    await connected(h)
    await assert.rejects(h.client.request('server.info'), (e: unknown) => e instanceof BridgeError && e.code === 'timeout')
    const list = (await h.client.request('bot.list')) as { bots: unknown[] }
    assert.equal(list.bots.length, 1)
  })

  it('没连上时请求立刻以 disconnected 失败', async () => {
    await bridge.stop()
    const h = connect()
    await assert.rejects(h.client.request('server.info'), (e: unknown) => e instanceof BridgeError && e.code === 'disconnected')
  })

  it('口令不对时连不上，状态里说明是口令被拒绝', async () => {
    const h = connect({ token: 'wrong-token' })
    const status = await waitFor('unauthorized reported', () => {
      const s = h.client.status()
      return s.lastError && /unauthorized/.test(s.lastError) ? s : undefined
    })
    assert.notEqual(status.state, 'connected')
    assert.equal(bridge.connectedClients, 0)
  })

  it('还没配置口令时根本不去连、也不重试；配置好并 restart 之后连上', async () => {
    let token: string | undefined
    const client = new BridgeClient({
      address: () => ({ host: '127.0.0.1', port: bridge.port }),
      token: () => token,
      clientName: 'brain/test',
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
    })
    clients.push(client)
    client.start()
    await sleep(80)
    assert.equal(client.status().state, 'unconfigured')
    assert.equal(client.status().lastError, undefined)
    assert.equal(bridge.hellos.length, 0)
    await assert.rejects(client.request('server.info'), (e: unknown) => e instanceof BridgeError && e.code === 'disconnected')

    token = bridge.token // 面板上填好了
    client.restart()
    await waitFor('connected after configuring', () => client.isConnected())
    assert.equal(bridge.hellos.length, 1)
  })

  it('启动时还读不到口令（游戏服务器还没生成口令文件）：说明原因并继续重试，口令有了就自己连上', async () => {
    let tokenFileExists = false
    const client = new BridgeClient({
      address: () => ({ host: '127.0.0.1', port: bridge.port }),
      token: () => {
        if (!tokenFileExists) throw new Error('读不到 bridge 口令文件 /somewhere/bridge-token.txt（ENOENT）')
        return bridge.token
      },
      clientName: 'brain/test',
      reconnectMinMs: 20,
      reconnectMaxMs: 60,
    })
    clients.push(client)
    client.start()
    assert.equal(client.status().state, 'waiting')
    assert.match(client.status().lastError ?? '', /读不到 bridge 口令文件/)
    assert.equal(bridge.connectedClients, 0)

    tokenFileExists = true
    await waitFor('connected once the token is readable', () => client.isConnected(), 3000)
    assert.equal(client.status().lastError, undefined)
  })

  it('大脑先启动、游戏服务器后启动：服务器起来后自己连上', async () => {
    await bridge.stop()
    const h = connect()
    await waitFor('a failed attempt is reported', () => h.client.status().lastError !== undefined)
    assert.equal(h.client.isConnected(), false)
    await bridge.start()
    await connected(h)
    assert.equal(bridge.connectedClients, 1)
  })

  it('等响应的时候连接断了，请求以 disconnected 失败', async () => {
    bridge.on('server.info', () => NO_REPLY)
    const h = connect()
    await connected(h)
    const pending = h.client.request('server.info')
    bridge.dropConnections()
    await assert.rejects(pending, (e: unknown) => e instanceof BridgeError && e.code === 'disconnected')
  })

  it('跨多个 TCP 包、带多字节字符的大响应能完整收到', async () => {
    const big = '方块'.repeat(300_000) // 约 1.8 MB 的 UTF-8
    bridge.on('world.block', () => ({ id: 'minecraft:stone', name: big }))
    const h = connect()
    await connected(h)
    const block = await new BridgeApi(h.client).worldBlock({ x: 0, y: 0, z: 0 })
    assert.equal(block.name?.length, big.length)
    assert.equal(block.name, big)
  })

  it('2 MiB 的图纸文件（协议允许的最大）经 blueprint.put 完整送到身体', async () => {
    const file = Buffer.alloc(2 * 1024 * 1024)
    for (let i = 0; i < file.length; i++) file[i] = (i * 31 + (i >> 8)) & 0xff
    let received: Buffer | undefined
    bridge.on('blueprint.put', (p) => {
      received = Buffer.from(String(p.data), 'base64')
      return { name: p.name, size: { x: 1, y: 1, z: 1 }, blocks: 1 }
    })
    const h = connect()
    await connected(h)
    const saved = await new BridgeApi(h.client).blueprintPut('big', file.toString('base64'))
    assert.equal(saved.name, 'big')
    assert.ok(received && received.equals(file), 'the body got every byte of the file')
  })

  it('事件按发生顺序交给监听者', async () => {
    const h = connect()
    await connected(h)
    bridge.chat('Steve', 'one')
    bridge.chat('Steve', 'two')
    bridge.emit('player.join', { player: 'Alex', uuid: 'u' })
    await waitFor('3 events', () => h.events.length === 3)
    assert.deepEqual(
      h.events.map((e) => [e.event, e.seq, e.data.message ?? e.data.player]),
      [
        ['chat', 1, 'one'],
        ['chat', 2, 'two'],
        ['player.join', 3, 'Alex'],
      ],
    )
  })

  it('断线后自动重连，补上断线期间错过的事件，已经收到的不重复', async () => {
    const h = connect()
    await connected(h)
    bridge.chat('Steve', 'before')
    await waitFor('first event', () => h.events.length === 1)

    await bridge.stop() // 断开并暂时不接受连接
    await waitFor('client noticed', () => !h.client.isConnected())
    bridge.chat('Steve', 'missed 1')
    bridge.chat('Steve', 'missed 2')
    await bridge.start()

    await waitFor('caught up', () => h.events.length === 3)
    assert.deepEqual(
      h.events.map((e) => e.data.message),
      ['before', 'missed 1', 'missed 2'],
    )
    // 第二次握手带着上次的 epoch 和 lastSeq
    const second = bridge.hellos[1]!
    assert.equal(second.serverEpoch, bridge.epoch)
    assert.equal(second.lastSeq, 1)
    assert.deepEqual(
      h.readies.map((r) => r.epochChanged),
      [true, false],
    )
    // 重连后的新事件照常收到
    bridge.chat('Steve', 'after')
    await waitFor('live again', () => h.events.length === 4)
  })

  it('大脑进程重启后（新的客户端实例）从落盘的位置接着收', async () => {
    const first = connect()
    await connected(first)
    bridge.chat('Steve', 'seen by first')
    await waitFor('first event', () => first.events.length === 1)
    first.client.stop()

    bridge.chat('Steve', 'while brain was down')
    const second = connect({ saved: first.saved })
    await waitFor('replayed', () => second.events.length === 1)
    assert.equal(second.events[0]!.data.message, 'while brain was down')
    assert.equal(first.saved.state?.lastSeq, 2)
  })

  it('全新的客户端不收以前的事件，从握手那一刻之后开始听；之后重连只补真正错过的', async () => {
    bridge.chat('Steve', 'long before the brain existed 1')
    bridge.chat('Steve', 'long before the brain existed 2')
    const h = connect()
    await connected(h)
    assert.equal(bridge.hellos[0]!.serverEpoch, undefined)
    assert.deepEqual(h.saved.state, { serverEpoch: bridge.epoch, lastSeq: 2 })

    // 什么事件都还没收到就断线重连：不能把握手之前的旧事件翻出来
    await bridge.stop()
    await waitFor('client noticed', () => !h.client.isConnected())
    bridge.chat('Steve', 'missed while disconnected')
    await bridge.start()
    await waitFor('caught up', () => h.events.length === 1)
    await sleep(50)
    assert.deepEqual(
      h.events.map((e) => e.data.message),
      ['missed while disconnected'],
    )
    assert.equal(bridge.hellos[1]!.lastSeq, 2)
  })

  it('服务器重启后（epoch 变了）：补上它这次启动以来的事件，通知上层重新拉状态，新事件照常收到', async () => {
    const h = connect()
    await connected(h)
    bridge.chat('Steve', 'a')
    bridge.chat('Steve', 'b')
    await waitFor('two events', () => h.events.length === 2)
    const oldEpoch = bridge.epoch

    // 重启后 bot 自己上线：欢迎语和 bot.spawned 都发生在大脑重连之前
    bridge.restart()
    await waitFor('reconnected to new epoch', () => h.readies.length === 2 && h.client.isConnected())
    assert.notEqual(bridge.epoch, oldEpoch)
    assert.equal(h.readies[1]!.epochChanged, true)
    // 握手时带的还是旧 epoch 和旧位置
    assert.equal(bridge.hellos[1]!.serverEpoch, oldEpoch)
    const spawned = await waitFor('replayed bot.spawned of the new epoch', () => h.events.find((e) => e.event === 'bot.spawned'))
    assert.deepEqual(spawned.data, { bot: 'Alu' })
    await waitFor('resume position caught up', () => h.saved.state?.lastSeq === bridge.seq)
    assert.equal(h.saved.state?.serverEpoch, bridge.epoch)

    // 新 epoch 里 seq 重新从 1 数起，不能被旧的 lastSeq 挡掉；新事件只收到一次
    bridge.chat('Steve', 'fresh')
    await waitFor('fresh event', () => h.events.some((e) => e.data.message === 'fresh'))
    await sleep(50)
    assert.equal(h.events.filter((e) => e.data.message === 'fresh').length, 1)
    assert.equal(h.events.filter((e) => e.event === 'bot.spawned').length, 1)
  })
})

describe('bridge 口令', () => {
  it('没配置时返回 undefined；直接写的口令优先于文件', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    fs.writeFileSync(path.join(tmp.dir, 'token.txt'), 'from-file-123\n')
    assert.equal(readBridgeToken({ token: '', tokenFile: '' }, tmp.dir), undefined)
    assert.equal(readBridgeToken({ token: '', tokenFile: 'token.txt' }, tmp.dir), 'from-file-123')
    assert.equal(readBridgeToken({ token: '', tokenFile: path.join(tmp.dir, 'token.txt') }, '/somewhere/else'), 'from-file-123')
    assert.equal(readBridgeToken({ token: 'inline-456', tokenFile: 'token.txt' }, tmp.dir), 'inline-456')
  })

  it('口令文件不存在、是空的时说明原因', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    fs.writeFileSync(path.join(tmp.dir, 'empty.txt'), '  \n')
    assert.throws(() => readBridgeToken({ token: '', tokenFile: 'missing.txt' }, tmp.dir), /读不到 bridge 口令文件 .*missing\.txt（ENOENT）/)
    assert.throws(() => readBridgeToken({ token: '', tokenFile: 'empty.txt' }, tmp.dir), /是空的/)
  })

  it('路径指向的不是口令文件（多行、带空格）时不把内容当口令发出去', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    fs.writeFileSync(path.join(tmp.dir, 'passwd'), 'root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1::/usr/sbin:/usr/sbin/nologin\n')
    fs.writeFileSync(path.join(tmp.dir, 'note.txt'), 'this is a sentence with spaces')
    fs.writeFileSync(path.join(tmp.dir, 'huge.txt'), 'a'.repeat(300))
    for (const name of ['passwd', 'note.txt', 'huge.txt']) {
      assert.throws(() => readBridgeToken({ token: '', tokenFile: name }, tmp.dir), /看起来不是 bridge 口令文件/, name)
    }
  })
})

