// f32: real craft_item calls through a real brain and scripted local models, not a simulated crafting grid.
// Run: node test/live-craft-tools.ts [--only mallet] [--transcript /tmp/craft-model.txt]
// Uses this checkout's tools/local.env ports; clears ONLY the test bot's inventory. No real model/key.
// GTNH 2.9.0 packdata recipe refs: 53710 blueberry juice, 46981 sticks, 57519 fresh water.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import type { BotStatus, TaskInfo } from '../src/bridge/protocol.ts'
import { TESTSERVER_BRIDGE_PORT, TOKEN_FILE, lastTurnText, openRcon, say, sleep, startBrain, until } from './live-brain.ts'
import { MockLlm, talkRelay } from './mock-llm.ts'

const BOT = process.env.LIVE_BOT ?? 'Alu'
const arg = (name: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined
const transcript = arg('--transcript')
const MALLET = 'gregtech:gt.metatool.01'
const JUICE = 'harvestcraft:blueberryjuiceItem'
const mallet = (damage: number) => `${MALLET} 1 14 {GT.ToolStats:{PrimaryMaterial:"Wood",SecondaryMaterial:"Wood",MaxDamage:12800L,Damage:${damage}L}}`
const count = (s: BotStatus, id: string, meta?: number) => (s.inventory ?? []).filter((i) => i.id === id && (meta === undefined || i.meta === meta)).reduce((n, i) => n + i.count, 0)
const wear = (s: BotStatus) => s.inventory?.find((i) => i.id === MALLET && i.meta === 14)?.durability
interface Scenario { name: string; give: string[]; recipe: number; count: number; check(task: TaskInfo, before: BotStatus, after: BotStatus): void }
const done = (t: TaskInfo, n: number) => { assert.equal(t.state, 'done', JSON.stringify(t)); assert.equal(t.result?.crafted, n) }
const partial = (t: TaskInfo, n: number, missing: string) => {
  assert.equal(t.state, 'failed', JSON.stringify(t))
  assert.equal(t.error?.code, 'no_material')
  assert.equal(t.result?.crafted, n)
  assert.match(JSON.stringify(t.error?.detail), new RegExp(missing))
}
const scenarios: Scenario[] = [
  { name: 'mallet', give: [mallet(0), 'Natura:berry 10 1'], recipe: 53710, count: 10, check(t, before, after) {
    done(t, 10); assert.equal(count(after, JUICE), 10); assert.equal(count(after, 'Natura:berry'), 0)
    assert.equal(count(after, MALLET, 14), 1); assert.equal(wear(before), 1); assert.equal(wear(after), 0.38)
  } },
  { name: 'worn-mallet', give: [mallet(11200), 'Natura:berry 10 1'], recipe: 53710, count: 10, check(t, _before, after) {
    // GTTool.getToolDamagePerContainerCraft is 800 in this pack: 1600 remaining permits two real rounds.
    partial(t, 2, 'toolJuicer'); assert.equal(count(after, JUICE), 2); assert.equal(count(after, 'Natura:berry', 1), 8)
    assert.equal(count(after, MALLET, 14), 0)
  } },
  { name: 'juicer', give: ['harvestcraft:juicerItem 1 0', 'Natura:berry 10 1'], recipe: 53710, count: 10, check(t, _before, after) {
    done(t, 10); assert.equal(count(after, JUICE), 10); assert.equal(count(after, 'harvestcraft:juicerItem'), 1)
  } },
  { name: 'consumables', give: ['minecraft:planks 6 0'], recipe: 46981, count: 5, check(t, _before, after) {
    // count is products: requesting five sticks takes three rounds of two, consuming six planks.
    done(t, 6); assert.equal(count(after, 'minecraft:stick'), 6); assert.equal(count(after, 'minecraft:planks'), 0)
  } },
  { name: 'short-consumables', give: ['minecraft:planks 5 0'], recipe: 46981, count: 5, check(t, _before, after) {
    partial(t, 0, 'plankWood'); assert.equal(count(after, 'minecraft:planks'), 5); assert.equal(count(after, 'minecraft:stick'), 0)
    assert.match(JSON.stringify(t.error?.detail), /"count":1/)
  } },
  { name: 'buckets', give: ['minecraft:water_bucket 3 0'], recipe: 57519, count: 9, check(t, _before, after) {
    done(t, 12); assert.equal(count(after, 'harvestcraft:freshwaterItem'), 12)
    assert.equal(count(after, 'minecraft:bucket'), 3); assert.equal(count(after, 'minecraft:water_bucket'), 0)
  } },
  { name: 'short-buckets', give: ['minecraft:water_bucket 1 0'], recipe: 57519, count: 8, check(t, _before, after) {
    partial(t, 4, 'minecraft:water_bucket'); assert.equal(count(after, 'harvestcraft:freshwaterItem'), 4)
    assert.equal(count(after, 'minecraft:bucket'), 1); assert.equal(count(after, 'minecraft:water_bucket'), 0)
  } },
]

async function main(): Promise<void> {
  const observer = new BridgeClient({ address: () => ({ host: '127.0.0.1', port: TESTSERVER_BRIDGE_PORT }), token: () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(), clientName: 'live-craft-tools', reconnectMinMs: 500 })
  observer.start()
  const game = new BridgeApi(observer)
  await until('test bridge', () => observer.isConnected(), 10_000)
  const llm = new MockLlm()
  const seen: string[] = []
  llm.fallback = (req) => { const text = lastTurnText(req); seen.push(text); if (transcript) fs.appendFileSync(transcript, `\nMODEL SAW\n${text}\n`); return { text: '' } }
  await llm.start(Number(process.env.LIVE_LLM_PORT ?? 25624))
  const talk = new MockLlm(); talk.fallback = talkRelay(); await talk.start(Number(process.env.LIVE_LLM_PORT ?? 25624) + 1)
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplayer-live-craft-'))
  fs.chmodSync(dataDir, 0o700)
  const brain = await startBrain(dataDir, undefined, Number(process.env.LIVE_PANEL_PORT ?? 28782))
  const rcon = await openRcon()
  say(`real brain data ${dataDir}; bridge ${TESTSERVER_BRIDGE_PORT}`)
  const failures: string[] = []
  try {
    for (const [line, model] of [['work', llm], ['talk', talk]] as const) {
      const p = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: `script-${line}`, baseUrl: model.anthropicBaseUrl, apiKey: 'fake-local-craft', model: `script-${line}` })
      await brain.call('POST', '/models/use', { providerId: p.provider.id, modelId: p.provider.models[0].id, line })
    }
    await until('brain connected', async () => (await brain.call('GET', '/overview')).bridge.state === 'connected', 10_000)
    await brain.call('POST', '/bot/spawn', {})
    await until('bot online', async () => (await game.botStatus(BOT)).online, 15_000)
    await game.taskCancel(BOT); await game.screenClose(BOT)
    for (const s of scenarios.filter((x) => !arg('--only') || x.name === arg('--only'))) {
      await until('brain idle', async () => { const o = await brain.call('GET', '/overview'); return !o.agent.busy && !o.agent.pending && !o.talk.busy && !o.talk.pending }, 15_000)
      await rcon.send(`clear ${BOT}`)
      for (const give of s.give) say(await rcon.send(`give ${BOT} ${give}`))
      await sleep(400)
      const before = await game.botStatus(BOT)
      const old = new Set(((await game.taskList(BOT)).recent ?? []).map((t) => t.id))
      seen.length = 0
      llm.enqueue({ toolCalls: [{ name: 'craft_item', input: { recipe: s.recipe, count: s.count } }] })
      await brain.call('POST', '/command', { text: `测试 ${s.name}：craft_item recipe ${s.recipe} count ${s.count}` })
      const task = await until('craft task ended', async () => (await game.taskList(BOT)).recent?.find((t) => t.type === 'craft' && !old.has(t.id)), 60_000)
      await until('model received craft outcome', () => seen.some((x) => x.includes(task.id) && (x.includes('完成') || x.includes('失败'))), 15_000)
      const after = await game.botStatus(BOT)
      const evidence = { scenario: s.name, task, before: before.inventory, after: after.inventory }
      say(JSON.stringify(evidence))
      if (transcript) fs.appendFileSync(transcript, `\nEVIDENCE ${JSON.stringify(evidence)}\n`)
      try { s.check(task, before, after); say(`PASS ${s.name}`) } catch (e) { failures.push(`${s.name}: ${String(e)}`); say(`FAIL ${s.name}: ${String(e)}`) }
    }
  } finally {
    rcon.close(); brain.child.kill('SIGTERM'); await brain.exited; await llm.stop(); await talk.stop(); observer.stop()
  }
  assert.equal(failures.length, 0, failures.join('\n'))
}
main().catch((e: unknown) => { console.error(e); process.exitCode = 1 })
