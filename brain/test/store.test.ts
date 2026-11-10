import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { ReminderScheduler } from '../src/agent/reminders.ts'
import { ActivityLog } from '../src/store/activity-log.ts'
import { ConfigStore, maskSecret, overridesFromEnv } from '../src/store/config.ts'
import { ensureDir } from '../src/store/files.ts'
import { HistoryStore } from '../src/store/history.ts'
import { MemoryStore } from '../src/store/memory.ts'
import type { Reminder } from '../src/store/reminders.ts'
import { ReminderStore } from '../src/store/reminders.ts'
import { UsageStore } from '../src/store/usage.ts'
import { sleep, tmpDir, waitFor } from './helpers.ts'

const mode = (file: string) => fs.statSync(file).mode & 0o777

describe('数据目录', () => {
  it('目录权限 700，里面每个文件权限 600', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const dir = path.join(tmp.dir, 'data')
    fs.mkdirSync(dir, { mode: 0o755 }) // 之前被别的方式建成了 755
    ensureDir(dir)
    new ConfigStore(dir)
    new MemoryStore(dir, () => 4000).set('k', 'v')
    new HistoryStore(dir).appendTurn({ id: 1, startedAt: 1, messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })
    new UsageStore(dir).add({ inputTokens: 1, outputTokens: 1 })
    new ReminderStore(dir).add(Date.now() + 1000, 'n')
    new ActivityLog(dir).add({ kind: 'info', text: 'hello' })

    assert.equal(mode(dir), 0o700)
    assert.equal(mode(path.join(dir, 'logs')), 0o700)
    const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    assert.deepEqual(
      files.map((f) => f.name).sort().map((n) => n.replace(/\d{4}-\d{2}-\d{2}/, 'DATE')),
      ['activity-DATE.jsonl', 'config.json', 'history.json', 'memory.json', 'reminders.json', 'usage.json'],
    )
    for (const f of files) assert.equal(mode(path.join(f.parentPath, f.name)), 0o600, f.name)
  })

  it('配置文件被手改坏时，进程照样能起来，坏文件留底', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    fs.writeFileSync(path.join(tmp.dir, 'config.json'), '{ "panel": { "port": 9000, ')
    const config = new ConfigStore(tmp.dir)
    assert.equal(config.get().panel.port, 8765)
    assert.ok(fs.readdirSync(tmp.dir).some((f) => f.startsWith('config.json.corrupt-')))
  })

  it('配置里类型不对的字段退回默认值，其余字段保留', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    fs.writeFileSync(
      path.join(tmp.dir, 'config.json'),
      JSON.stringify({
        panel: { port: 'abc', password: 'keep-me' },
        bot: { name: 'has space', aliases: 'not-a-list', limits: { maxSteps: 9999 }, wake: { mode: 'sometimes' } },
        providers: [{ id: 'ok', kind: 'openai-chat', baseUrl: 'https://x.example/v1', apiKey: 'k', model: 'm' }, { id: 'bad', kind: 'nope' }],
        activeProviderId: 'bad',
      }),
    )
    const c = new ConfigStore(tmp.dir).get()
    assert.equal(c.panel.port, 8765)
    assert.equal(c.panel.password, 'keep-me')
    assert.equal(c.bot.name, 'Alu')
    assert.deepEqual(c.bot.aliases, [])
    assert.equal(c.bot.limits.maxSteps, 64)
    assert.equal(c.bot.wake.mode, 'mention')
    assert.deepEqual(c.providers.map((p) => p.id), ['ok'])
    assert.equal(c.activeProviderId, 'ok')
  })

  it('环境变量覆盖面板和 bridge 的地址，但不写回配置文件', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const config = new ConfigStore(
      tmp.dir,
      overridesFromEnv({ AIPLAYER_PANEL_HOST: '0.0.0.0', AIPLAYER_PANEL_PORT: '9001', AIPLAYER_BRIDGE_PORT: '26000', AIPLAYER_BRIDGE_TOKEN_FILE: '/tmp/token.txt' }),
    )
    assert.deepEqual(config.panelAddress(), { host: '0.0.0.0', port: 9001 })
    assert.equal(config.bridgeSettings().port, 26000)
    assert.equal(config.bridgeSettings().tokenFile, '/tmp/token.txt')
    assert.equal(config.bridgeSettings().host, '127.0.0.1')
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp.dir, 'config.json'), 'utf8'))
    assert.equal(onDisk.panel.port, 8765)
    // 默认按正式部署来：端口 25590，口令文件没有默认值（不配就不连）
    assert.equal(onDisk.bridge.port, 25590)
    assert.equal(onDisk.bridge.tokenFile, '')
  })

  it('key 的掩码只露前缀和末四位，短的完全不露', () => {
    assert.equal(maskSecret('sk-abcdefghijklmnop1234'), 'sk-…1234')
    assert.equal(maskSecret('abcdefghijklmnop9999'), '…9999')
    assert.equal(maskSecret('short'), '…')
    assert.equal(maskSecret(''), '')
  })
})

describe('记忆、历史、用量', () => {
  it('记忆重启后还在；超过总长度上限时拒绝写入', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const a = new MemoryStore(tmp.dir, () => 50)
    a.set('home:base', '(0,64,0) 仓库')
    assert.throws(() => a.set('long', 'x'.repeat(60)), /memory is full/)
    // 覆盖已有的键时，旧内容不计入
    a.set('home:base', 'y'.repeat(40))
    const b = new MemoryStore(tmp.dir, () => 50)
    assert.deepEqual(b.list().map((n) => [n.key, n.text]), [['home:base', 'y'.repeat(40)]])
    assert.equal(b.render(), `- home:base: ${'y'.repeat(40)}`)
  })

  it('历史重启后还在，轮的编号接着往下排', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const a = new HistoryStore(tmp.dir)
    a.appendTurn({ id: a.newTurnId(), startedAt: 5, messages: [{ role: 'user', content: [{ type: 'text', text: 'one' }] }] })
    a.replace('summary so far', a.get().turns)
    const b = new HistoryStore(tmp.dir)
    assert.equal(b.get().summary, 'summary so far')
    assert.equal(b.get().turns.length, 1)
    assert.equal(b.newTurnId(), 2)
    b.clear()
    assert.deepEqual([new HistoryStore(tmp.dir).get().summary, new HistoryStore(tmp.dir).get().turns.length], ['', 0])
  })

  it('用量按天累计，换了一天从零开始', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const day1 = new Date(2026, 10, 10, 23, 50).getTime()
    const day2 = new Date(2026, 10, 11, 0, 10).getTime()
    const u = new UsageStore(tmp.dir)
    u.add({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800 }, day1)
    u.add({ inputTokens: 500, outputTokens: 50 }, day1)
    assert.deepEqual(u.today(day1), { calls: 2, inputTokens: 1500, outputTokens: 150, cacheReadTokens: 800, cacheWriteTokens: 0 })
    assert.equal(u.todayTokens(day1), 1650)
    assert.equal(u.todayTokens(day2), 0)
    assert.equal(new UsageStore(tmp.dir).todayTokens(day1), 1650)
  })

  it('活动日志重启后能看到之前的记录，编号接着往下排', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const a = new ActivityLog(tmp.dir)
    a.add({ kind: 'chat', who: 'Steve', text: 'hello' })
    a.add({ kind: 'say', who: 'Alu', text: 'hi' })
    const b = new ActivityLog(tmp.dir)
    assert.deepEqual(b.recent().map((e) => e.text), ['hello', 'hi'])
    assert.equal(b.add({ kind: 'info', text: 'after restart' }).id, 3)
    assert.deepEqual(b.recent(2).map((e) => e.text), ['after restart'])
  })
})

describe('提醒', () => {
  it('到点触发一次，然后从清单里消失', async (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const fired: Reminder[] = []
    const s = new ReminderScheduler(new ReminderStore(tmp.dir), (r) => fired.push(r))
    s.start()
    t.after(() => s.stop())
    s.add(Date.now() + 60, '看看熔炉')
    s.add(Date.now() + 3_600_000, '一小时后的事')
    assert.equal(fired.length, 0)
    await waitFor('reminder fired', () => fired.length === 1)
    assert.equal(fired[0]!.note, '看看熔炉')
    await sleep(100)
    assert.equal(fired.length, 1)
    assert.deepEqual(s.list().map((r) => r.note), ['一小时后的事'])
  })

  it('进程重启不丢：没到点的继续等，重启期间过点的启动后立刻触发', async (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    // 上一个进程登记了两个提醒就退出了
    const before = new ReminderStore(tmp.dir)
    before.add(Date.now() - 5000, '重启期间到点的')
    before.add(Date.now() + 3_600_000, '还没到点的')

    const fired: Reminder[] = []
    const s = new ReminderScheduler(new ReminderStore(tmp.dir), (r) => fired.push(r))
    s.start()
    t.after(() => s.stop())
    await waitFor('overdue reminder fired', () => fired.length === 1)
    assert.equal(fired[0]!.note, '重启期间到点的')
    assert.deepEqual(new ReminderStore(tmp.dir).list().map((r) => r.note), ['还没到点的'])
  })
})
