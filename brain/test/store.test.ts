import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { ReminderScheduler } from '../src/agent/reminders.ts'
import { ActivityLog } from '../src/store/activity-log.ts'
import { ConfigStore, maskSecret, overridesFromEnv } from '../src/store/config.ts'
import { ensureDir } from '../src/store/files.ts'
import { HistoryStore } from '../src/store/history.ts'
import { MANUAL_BODY_MAX_CHARS, MANUAL_SUMMARY_MAX_CHARS, ManualError, ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import type { Reminder } from '../src/store/reminders.ts'
import { ReminderStore } from '../src/store/reminders.ts'
import { UsageStore } from '../src/store/usage.ts'
import { DEFAULT_MANUALS_DIR } from './agent-harness.ts'
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
    assert.equal(config.get().panel.port, 28765)
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
    assert.equal(c.panel.port, 28765)
    assert.equal(c.panel.password, 'keep-me')
    assert.equal(c.bot.name, 'Alu')
    assert.deepEqual(c.bot.aliases, [])
    assert.equal(c.bot.limits.maxSteps, 500)
    assert.equal(c.bot.wake.mode, 'mention')
    assert.deepEqual(c.providers.map((p) => p.id), ['ok'])
    assert.equal(c.activeProviderId, 'ok')
  })

  it('旧配置（一个服务商只有一个模型）自动转成新格式：原来的模型成了这个服务商下面的第一个模型，调用时用的设置和以前一模一样；原文件留了底', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const file = path.join(tmp.dir, 'config.json')
    const old = JSON.stringify({
      version: 1,
      panel: { password: 'keep-me', sessionSecret: 'keep-this-too' },
      providers: [
        {
          id: 'main',
          label: '主力',
          kind: 'openai-chat',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-old-openai-key-123456',
          model: 'gpt-old',
          maxOutputTokens: 2000,
          temperature: 0.3,
          timeoutMs: 90_000,
          extraHeaders: { 'x-team': 'gtnh' },
          extraBody: { reasoning_effort: 'low' },
          options: { maxTokensField: 'max_completion_tokens', systemRole: 'developer' },
        },
        { id: 'ant', label: '备用', kind: 'anthropic-messages', baseUrl: 'https://gateway.example', apiKey: 'sk-old-ant-key-654321', model: 'claude-old', options: { authStyle: 'bearer', promptCaching: false } },
      ],
      activeProviderId: 'ant',
    })
    fs.writeFileSync(file, old, { mode: 0o600 })

    const store = new ConfigStore(tmp.dir)
    const c = store.get()
    assert.equal(c.version, 3)
    // 服务商上留下的是一家只有一份的东西；跟着模型走的挪到了模型上
    assert.deepEqual(c.providers[0], {
      id: 'main',
      label: '主力',
      kind: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-old-openai-key-123456',
      extraHeaders: { 'x-team': 'gtnh' },
      models: [
        { id: 'm1', name: 'gpt-old', label: '', maxOutputTokens: 2000, temperature: 0.3, timeoutMs: 90_000, extraBody: { reasoning_effort: 'low' }, options: { maxTokensField: 'max_completion_tokens', systemRole: 'developer' } },
      ],
    })
    // key 放在哪个请求头是这一家接口的事，留在服务商上；缓存开关跟着模型
    assert.deepEqual([c.providers[1]!.options, c.providers[1]!.models], [{ authStyle: 'bearer' }, [{ id: 'm1', name: 'claude-old', label: '', options: { promptCaching: false } }]])
    assert.deepEqual([c.activeProviderId, c.activeModelId], ['ant', 'm1'])
    // 对话线没选过：和原来选的是同一个
    assert.deepEqual([c.talkProviderId, c.talkModelId], ['ant', 'm1'])
    // 交给模型调用层的配置和迁移前的那一条一样
    assert.deepEqual(store.activeProvider(), {
      id: 'ant',
      label: '备用',
      kind: 'anthropic-messages',
      baseUrl: 'https://gateway.example',
      apiKey: 'sk-old-ant-key-654321',
      model: 'claude-old',
      options: { authStyle: 'bearer', promptCaching: false },
    })

    // 文件已经是新格式；原来的那份留了底，权限一样收着
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual([saved.version, saved.providers[0].model, saved.providers[0].models[0].name, saved.panel.password], [3, undefined, 'gpt-old', 'keep-me'])
    assert.equal(fs.readFileSync(`${file}.v1.bak`, 'utf8'), old)
    assert.equal(fs.statSync(`${file}.v1.bak`).mode & 0o777, 0o600)
    // 再启动一次：已经是新格式，不会再动那份底
    fs.writeFileSync(`${file}.v1.bak`, 'untouched')
    assert.deepEqual(new ConfigStore(tmp.dir).get(), c)
    assert.equal(fs.readFileSync(`${file}.v1.bak`, 'utf8'), 'untouched')
  })

  it('只有一条线时的配置自动补上对话线的那几项：两条线用的都是原来选的模型，对话线有自己的步数上限和历史压缩阈值；原文件留了底；主人改过的旧人设清空并说明原文在哪', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const file = path.join(tmp.dir, 'config.json')
    const providers = [
      { id: 'main', label: '主力', kind: 'openai-chat', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-key-123456', models: [{ id: 'a', name: 'gpt-a', label: '' }, { id: 'b', name: 'gpt-b', label: '快的' }] },
      { id: 'ant', label: '备用', kind: 'anthropic-messages', baseUrl: 'https://api.anthropic.example', apiKey: 'sk-ant-key-654321', models: [{ id: 'c', name: 'claude-c', label: '' }] },
    ]
    const old = JSON.stringify({
      version: 2,
      panel: { password: 'keep-me', sessionSecret: 'keep-this-too' },
      bot: { name: 'Alu', owners: ['Steve'], systemPrompt: '你是 {{name}}。玩家只能看到你用 say 说的话。干活靠任务。', limits: { maxSteps: 80, historyTokenThreshold: 200_000 } },
      providers,
      activeProviderId: 'main',
      activeModelId: 'b',
    })
    fs.writeFileSync(file, old, { mode: 0o600 })

    const store = new ConfigStore(tmp.dir)
    const c = store.get()
    assert.equal(c.version, 3)
    assert.deepEqual([c.activeProviderId, c.activeModelId, c.talkProviderId, c.talkModelId], ['main', 'b', 'main', 'b'])
    assert.deepEqual([store.lineProvider('talk')?.model, store.lineProvider('work')?.model], ['gpt-b', 'gpt-b'])
    // 原来的上限是干活线的，原样留着；对话线的两项用默认值
    assert.deepEqual([c.bot.limits.maxSteps, c.bot.limits.historyTokenThreshold, c.bot.limits.talkMaxSteps, c.bot.limits.talkHistoryTokenThreshold], [80, 200_000, 20, 60_000])
    assert.deepEqual(c.bot.owners, ['Steve'])
    // 旧人设是分线之前的整段核心提示词，不能当对话线的说话风格：清空，说明原文在哪份备份里
    assert.equal(c.bot.systemPrompt, '')
    assert.equal(store.upgradeNotes.length, 1)
    assert.match(store.upgradeNotes[0]!, /已经清空、改用默认风格。原文（\d+ 字）留在 .*config\.json\.v2\.bak 的 bot\.systemPrompt 里/)
    // 原文件留了底，权限收着；现在的文件是新格式
    assert.equal(fs.readFileSync(`${file}.v2.bak`, 'utf8'), old)
    assert.equal(fs.statSync(`${file}.v2.bak`).mode & 0o777, 0o600)
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 3)
    // 再启动一次：已经是新格式，不再动那份底，也没有要说的
    fs.writeFileSync(`${file}.v2.bak`, 'untouched')
    const again = new ConfigStore(tmp.dir)
    assert.deepEqual(again.get(), c)
    assert.deepEqual(again.upgradeNotes, [])
    assert.equal(fs.readFileSync(`${file}.v2.bak`, 'utf8'), 'untouched')

    // 之后两条线各选各的；对话线选的那家被删了，就回到和干活线一样
    again.update((draft) => {
      draft.talkProviderId = 'ant'
      draft.talkModelId = 'c'
    })
    assert.deepEqual([again.lineProvider('talk')?.model, again.lineProvider('work')?.model], ['claude-c', 'gpt-b'])
    again.update((draft) => {
      draft.providers = draft.providers.filter((p) => p.id !== 'ant')
    })
    assert.deepEqual([again.get().talkProviderId, again.get().talkModelId, again.lineProvider('talk')?.model], ['main', 'b', 'gpt-b'])
  })

  it('没改过人设的旧配置升上来：没有要说明的事；全新的数据目录不留底', (t) => {
    const tmp = tmpDir()
    const fresh = tmpDir()
    t.after(tmp.cleanup)
    t.after(fresh.cleanup)
    fs.writeFileSync(path.join(tmp.dir, 'config.json'), JSON.stringify({ version: 2, bot: { systemPrompt: '' } }))
    assert.deepEqual(new ConfigStore(tmp.dir).upgradeNotes, [])
    assert.ok(fs.existsSync(path.join(tmp.dir, 'config.json.v2.bak')))
    new ConfigStore(fresh.dir)
    assert.deepEqual(fs.readdirSync(fresh.dir), ['config.json'])
  })

  it('当前用的模型不在了（手改配置改坏了）：改用这个服务商下面的第一个；一处写坏的模型不连累整个服务商和它的 key', (t) => {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    fs.writeFileSync(
      path.join(tmp.dir, 'config.json'),
      JSON.stringify({
        version: 2,
        providers: [{ id: 'main', label: '主力', kind: 'openai-chat', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-key-123456', models: [{ id: 'a', name: 'gpt-a' }, { id: 'b', name: '' }, { id: 'c', name: 'gpt-c', label: '备选' }] }],
        activeProviderId: 'main',
        activeModelId: 'gone',
      }),
    )
    const store = new ConfigStore(tmp.dir)
    assert.deepEqual(store.get().providers[0]!.models.map((m) => [m.id, m.name, m.label]), [['a', 'gpt-a', ''], ['c', 'gpt-c', '备选']])
    assert.deepEqual([store.get().activeModelId, store.activeProvider()?.model, store.activeProvider()?.apiKey], ['a', 'gpt-a', 'sk-key-123456'])
  })

  it('对话窗口默认 5 分钟（说过话以后隔一两分钟再说，不用再叫名字）；配置文件里已经存着的值不动', (t) => {
    const fresh = tmpDir()
    const existing = tmpDir()
    t.after(fresh.cleanup)
    t.after(existing.cleanup)
    assert.equal(new ConfigStore(fresh.dir).get().bot.wake.conversationWindowSec, 300)
    // 以前的版本默认 60 秒，并且已经把 60 写进了配置文件：主人没改过，也不替他改
    fs.writeFileSync(path.join(existing.dir, 'config.json'), JSON.stringify({ bot: { wake: { mode: 'mention', conversationWindowSec: 60 } } }))
    assert.equal(new ConfigStore(existing.dir).get().bot.wake.conversationWindowSec, 60)
  })

  it('每轮最多调模型的次数默认 60（查配方、找材料的目标要走很多步，干活时新到的话也接在这一轮里）；配置文件里已经存着的值不动', (t) => {
    const fresh = tmpDir()
    const existing = tmpDir()
    t.after(fresh.cleanup)
    t.after(existing.cleanup)
    assert.equal(new ConfigStore(fresh.dir).get().bot.limits.maxSteps, 60)
    fs.writeFileSync(path.join(existing.dir, 'config.json'), JSON.stringify({ bot: { limits: { maxSteps: 16 } } }))
    assert.equal(new ConfigStore(existing.dir).get().bot.limits.maxSteps, 16)
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
    assert.equal(onDisk.panel.port, 28765)
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

describe('手册', () => {
  /** 一个临时的“默认手册”目录加一个临时的数据目录。 */
  function setup(t: { after(fn: () => void): void }) {
    const tmp = tmpDir()
    t.after(tmp.cleanup)
    const defaults = path.join(tmp.dir, 'shipped')
    const mine = path.join(tmp.dir, 'data', 'manuals')
    fs.mkdirSync(defaults)
    fs.writeFileSync(path.join(defaults, 'blueprint.md'), '照图纸盖建筑之前看。\n\n# 准备\n先 check_blueprint。\n')
    fs.writeFileSync(path.join(defaults, 'travel.md'), '\n要去某个地方时看。\n\n走不到就先传送。\n')
    return { tmp, defaults, mine, store: new ManualStore(defaults, mine) }
  }

  it('随代码发布的默认手册：要求的那几本都在，每本第一行是“什么时候看”，正文不超过上限', () => {
    const shipped = new ManualStore(DEFAULT_MANUALS_DIR, path.join(DEFAULT_MANUALS_DIR, 'no-such-user-dir')).list()
    const names = shipped.map((m) => m.name)
    for (const name of ['blueprint', 'crafting', 'containers', 'terrain', 'travel', 'quests']) assert.ok(names.includes(name), `${name} is shipped`)
    for (const m of shipped) {
      assert.equal(m.source, 'default')
      assert.ok(m.summary.length >= 8 && m.summary.length <= MANUAL_SUMMARY_MAX_CHARS, `${m.name} starts with a one-line "when to read": ${m.summary}`)
      assert.equal(m.summary.startsWith('#'), false, `${m.name}: the first line is a sentence, not a heading`)
      assert.ok(m.body.length > 100 && m.body.length <= MANUAL_BODY_MAX_CHARS, `${m.name} body is ${m.body.length} chars`)
    }
  })

  it('文件的第一行是“什么时候看”，其余是正文；默认的和主人写的列在一起，主人新写的排在后面', (t) => {
    const s = setup(t)
    assert.deepEqual(s.store.list(), [
      { name: 'blueprint', summary: '照图纸盖建筑之前看。', body: '# 准备\n先 check_blueprint。', source: 'default', overridesDefault: false },
      { name: 'travel', summary: '要去某个地方时看。', body: '走不到就先传送。', source: 'default', overridesDefault: false },
    ])
    s.store.save({ name: '基地布局', summary: '要在基地里找仓库、机器时看。', body: '仓库在 (100,64,200) 一带。' })
    assert.deepEqual(s.store.list().map((m) => [m.name, m.source]), [['blueprint', 'default'], ['travel', 'default'], ['基地布局', 'user']])
    assert.equal(s.store.get('基地布局')?.body, '仓库在 (100,64,200) 一带。')
    // 落在数据目录里，和别的数据文件一样只有属主能读
    assert.equal(mode(path.join(s.mine, '基地布局.md')), 0o600)
    assert.equal(mode(s.mine), 0o700)
  })

  it('主人写了一本和默认手册同名的：读到的是主人的；删掉主人的那本，默认的就回来了', (t) => {
    const s = setup(t)
    const saved = s.store.save({ name: 'blueprint', summary: '盖房子之前看（我们服的规矩）。', body: '一律先问我。' })
    assert.equal(saved.overridesDefault, true)
    assert.deepEqual(s.store.get('blueprint'), { name: 'blueprint', summary: '盖房子之前看（我们服的规矩）。', body: '一律先问我。', source: 'user', overridesDefault: true })
    assert.deepEqual(s.store.list().map((m) => m.name), ['blueprint', 'travel'])
    // 默认的那份原封不动
    assert.equal(s.store.defaults().find((m) => m.name === 'blueprint')?.body, '# 准备\n先 check_blueprint。')

    assert.equal(s.store.remove('blueprint'), true)
    assert.equal(s.store.get('blueprint')?.source, 'default')
    assert.equal(s.store.get('blueprint')?.body, '# 准备\n先 check_blueprint。')
    // 默认手册本身删不掉
    assert.equal(s.store.remove('blueprint'), false)
    assert.equal(fs.existsSync(path.join(s.defaults, 'blueprint.md')), true)
  })

  it('手册名带路径、带点、带空格的一律存不进去也删不到：数据目录外面的文件不受影响', (t) => {
    const s = setup(t)
    const outside = path.join(s.tmp.dir, 'data', 'config.md')
    fs.mkdirSync(path.dirname(outside), { recursive: true })
    fs.writeFileSync(outside, 'keep me')
    for (const name of ['../config', '..', 'a/b', 'a\\b', '.hidden', 'has space', 'x.md', '', 'a'.repeat(41)]) {
      assert.throws(() => s.store.save({ name, summary: 's', body: 'b' }), ManualError, `save "${name}"`)
      assert.throws(() => s.store.remove(name), ManualError, `remove "${name}"`)
    }
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me')
    // 什么都没写出来
    assert.deepEqual(fs.readdirSync(path.join(s.tmp.dir, 'data')), ['config.md'])
  })

  it('没写“什么时候看”、正文是空的或者太长的手册存不进去；名字只差大小写的不能并存', (t) => {
    const s = setup(t)
    assert.throws(() => s.store.save({ name: 'base', summary: '  ', body: '正文' }), /什么时候看/)
    assert.throws(() => s.store.save({ name: 'base', summary: '找仓库时看', body: '   ' }), /正文不能是空的/)
    assert.throws(() => s.store.save({ name: 'base', summary: '找仓库时看', body: '长'.repeat(MANUAL_BODY_MAX_CHARS + 1) }), /最长/)
    assert.throws(() => s.store.save({ name: 'Blueprint', summary: '盖房子时看', body: '正文' }), /已经有一本叫“blueprint”/)
    assert.deepEqual(s.store.list().map((m) => m.name), ['blueprint', 'travel'])
    // 找的时候不计较大小写和多写的后缀
    assert.equal(s.store.get('Blueprint.md')?.name, 'blueprint')
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
