// 真模型试一试（不是自动测试，不在 npm test 里）：对话线写的字只给面板，游戏里说话要用 say。
// 用法：node test/eval-talk-channels.ts <配置文件> <服务商 id> [模型 id] [每种重复几次]
// 拿配置里那个服务商的真模型当对话线，游戏是假的；看它在几种叫醒方式下有没有在游戏里说话、说了什么、写了什么。
import fs from 'node:fs'
import { createClient } from '../src/llm/index.ts'
import type { LlmClient } from '../src/llm/index.ts'
import { chat, makeAgent } from './agent-harness.ts'

const [cfgPath, providerId, modelId, timesArg] = process.argv.slice(2)
if (!cfgPath || !providerId) {
  console.error('usage: node test/eval-talk-channels.ts <config.json> <providerId> [modelId] [times]')
  process.exit(2)
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const p = cfg.providers.find((x: { id: string }) => x.id === providerId)
const m = modelId ? p.models.find((x: { id: string }) => x.id === modelId) : p.models[0]
const client: LlmClient = createClient({ id: p.id, label: p.label, kind: p.kind, baseUrl: p.baseUrl, apiKey: p.apiKey, model: m.name, ...(m.extraBody ? { extraBody: m.extraBody } : {}) })
const times = Number(timesArg ?? 2)
console.log(`talk line model: ${p.label} / ${m.name}`)

type Case = { name: string; send: (h: ReturnType<typeof makeAgent>) => void }
const only = process.env.ONLY
const cases: Case[] = [
  { name: 'in-game chat from the owner', send: (h) => h.agent.handleEvent(chat('阿露', 'Alu，你现在在干嘛呀')) },
  { name: 'in-game chat from another player', send: (h) => h.agent.handleEvent(chat('Gumi', 'Alu 你会饿吗')) },
  { name: 'whisper', send: (h) => h.agent.handleEvent({ type: 'whisper', time: Date.now(), from: 'Gumi', message: '悄悄问一下，你今天铺了多少地板' }) },
  { name: 'panel', send: (h) => h.agent.handleEvent({ type: 'panel_command', time: Date.now(), text: '你现在在干嘛' }) },
  { name: 'worker stopped and left a note', send: (h) => h.agent.handleEvent({ type: 'worker', time: Date.now(), kind: 'result', text: '这片地板铺完了：x=-616..-609,z72..79 放了 47 块结构混凝土，没拆东西；累计 1153 格。' }) },
  { name: 'worker plain report (should not wake)', send: (h) => h.agent.handleEvent({ type: 'worker', time: Date.now(), kind: 'report', text: '下一片 x=-624..-617,z72..79：41 个空位。' }) },
]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
for (const c of cases.filter((x) => !only || x.name.includes(only))) {
  for (let n = 0; n < times; n++) {
    const h = makeAgent({ talk: client as never, noModel: 'work' })
    c.send(h)
    await sleep(500)
    await Promise.race([h.agent.whenIdle(), sleep(120_000)])
    const said = h.game.callsOf('bot.chat').map((x) => `say "${String(x.message ?? x.text ?? '')}"`)
    const whispers = h.game.callsOf('bot.command').filter((x) => /^(tell|msg|w) /.test(String(x.command ?? ''))).map((x) => `whisper "${String(x.command)}"`)
    const replies = h.log.recent(0, 500).filter((e) => e.kind === 'reply').map((e) => `reply "${e.text}"`)
    const tools = h.log.recent(0, 500).filter((e) => e.kind === 'tool_call').map((e) => e.who)
    const turns = h.log.recent(0, 500).filter((e) => e.kind === 'turn' && e.text.includes('开始')).length
    console.log(`\n[${c.name} #${n + 1}] turns ${turns}; tools: ${tools.join(', ') || '-'}`)
    for (const line of [...said, ...whispers, ...replies]) console.log('  ' + line.slice(0, 200))
    if (said.length + whispers.length + replies.length === 0) console.log('  (nothing said or written)')
    await h.agent.stop()
  }
}
process.exit(0)
