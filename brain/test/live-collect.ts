// f31: real brain + scripted model + this checkout's GTNH server. No real model/key.
// Default requires a test-only copy of live World/level.dat + region/r.-1.0.mca (online snapshot).
// Restores the documented lake-bed damage and six clay blocks, then replays dig → collect.
// --pond instead builds a fixed covered mud-bed drop at the same coordinates; independent of historical drops.
// It overwrites x -452..-444, y56..65, z108..114 in THIS TEST WORLD and removes its loose items.
// node test/live-collect.ts [--pond] [--terrain] [--blocked|--lost] [--out /tmp/collect.json]
// --blocked and --lost require --pond: inaccessible and disappearing targets must fail honestly.
// Optional LIVE_PANEL_PORT / LIVE_LLM_PORT override the isolated test's local ports.
// --terrain explicitly allows dig/climb, proving the route fix independently of cautious defaults.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import type { TaskInfo, WorldBlocks } from '../src/bridge/protocol.ts'
import { TESTSERVER_BRIDGE_PORT, TOKEN_FILE, lastTurnText, openRcon, say, sleep, startBrain, until } from './live-brain.ts'
import { MockLlm, talkRelay } from './mock-llm.ts'

const BOT = 'Alu'
const args = process.argv.slice(2)
const output = args.includes('--out') ? args[args.indexOf('--out') + 1]! : '/tmp/collect.json'
const terrain = args.includes('--terrain')
const pond = args.includes('--pond')
const blocked = args.includes('--blocked')
const lost = args.includes('--lost')
const clay = [[-449,61,111],[-448,61,112],[-448,61,111],[-448,61,113],[-448,61,110],[-447,61,112]]
const damage = [[-450,59,112],[-451,62,113],[-451,61,113],[-451,60,113],[-451,59,113],[-451,58,113],[-450,59,113],[-450,58,113],[-449,59,113],[-449,58,113],[-448,59,113],[-448,58,113],[-447,59,113],[-447,58,113],[-447,59,112],[-447,58,112],[-447,59,111],[-447,58,111],[-448,59,111],[-448,58,111],[-448,59,112],[-448,58,112]]

async function main() {
  assert.ok(pond || (!blocked && !lost),'--blocked/--lost require --pond')
  const client = new BridgeClient({ address: () => ({ host: '127.0.0.1', port: TESTSERVER_BRIDGE_PORT }), token: () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(), clientName: 'live-collect-driver' })
  client.start()
  await until('bridge connected', () => client.isConnected(), 10000)
  const game = new BridgeApi(client)
  const llm = new MockLlm()
  llm.fallback = () => ({ text: '' })
  const llmPort = Number(process.env.LIVE_LLM_PORT ?? 25632)
  await llm.start(llmPort)
  const talk = new MockLlm()
  talk.fallback = talkRelay()
  await talk.start(llmPort+1)
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplayer-live-collect-'))
  const brain = await startBrain(data, undefined, Number(process.env.LIVE_PANEL_PORT ?? 28781))
  const transcript: unknown[] = []
  const tracks: unknown[] = []
  const results: TaskInfo[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    for (const [line, model] of [['work', llm], ['talk', talk]] as const) {
      const provider = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: `script-${line}`, baseUrl: model.anthropicBaseUrl, apiKey: 'fake-local-only', model: 'script' })
      await brain.call('POST', '/models/use', { providerId: provider.provider.id, modelId: provider.provider.models[0].id, line })
    }
    await until('brain connected', async () => (await brain.call('GET', '/overview')).bridge.state === 'connected', 10000)
    await brain.call('POST', '/bot/spawn', {})
    await until('bot online', async () => (await game.botStatus(BOT)).online, 10000)
    await game.taskCancel(BOT)
    const rc = await openRcon()
    try {
      await rc.send(`tp ${BOT} -450.5 63 111.5`)
      await sleep(1200)
      await rc.send('cofh killall item') // This isolated test server only: remove snapshot/previous-run drops.
      await rc.send(`clear ${BOT}`)
      for (const [x,y,z] of damage) await rc.send(`setblock ${x} ${y} ${z} minecraft:${y === 62 ? 'grass' : 'dirt'} 0 replace`)
      for (const [x,y,z] of clay) await rc.send(`setblock ${x} ${y} ${z} minecraft:clay 0 replace`)
      if (pond) {
        for (let y=56;y<=65;y++) for (let x=-452;x<=-444;x++) for (let z=108;z<=114;z++) {
          const inside = x>=-449 && x<=-446 && z>=110 && z<=112
          const covered = x===-448 && z===111
          const id = y===56 ? 'stone' : y>=63 ? 'air' : inside && y===60 ? 'BiomesOPlenty:mud' : inside && y>=61 ? (covered ? (y===61 ? 'clay' : 'BiomesOPlenty:mud') : 'water') : 'dirt'
          await rc.send(`setblock ${x} ${y} ${z} ${id.includes(':') ? id : `minecraft:${id}`} 0 replace`)
        }
      }
      if (blocked) {
        for (let x=-449;x<=-447;x++) for (let y=59;y<=63;y++) for (let z=110;z<=112;z++) {
          if (x===-448 && z===111) continue
          await rc.send(`setblock ${x} ${y} ${z} minecraft:stone 0 replace`)
        }
      }
      await rc.send(`give ${BOT} TConstruct:shovel 1 0 {InfiTool:{Head:16,Handle:16,RenderHead:16,RenderHandle:16,BaseDurability:3000,TotalDurability:3000,BonusDurability:0,ModDurability:0.0f,Shoddy:0.0f,HarvestLevel:5,MiningSpeed:700,Attack:4,BaseAttack:4,Damage:0,Broken:0b,Modifiers:0,Unbreaking:2,ToolLevel:1,ToolEXP:0L,HeadEXP:0L}}`)
      await sleep(800)
      const drops = await game.worldEntities({ x:-450,y:63,z:111 },{radius:6})
      const shovel = drops.entities?.find((e) => e.item?.id === 'TConstruct:shovel')
      if (shovel?.pos) {
        await rc.send(`tp ${BOT} ${shovel.pos.x} ${shovel.pos.y} ${shovel.pos.z}`)
        await sleep(1200)
      }
      await rc.send(`tp ${BOT} -450.5 63 111.5`)
      if (pond) {
        await rc.send('cofh killall item')
        // The live lake has mud at y60: drops settle at y60.78 under neighbouring clay/mud.
        // Fixed covered target: reachable by swimming alongside it, not by standing above it or tunnelling below.
        await rc.send('summon Item -447.5 60.78 111.5 {Item:{id:337s,Count:24b,Damage:0s},Motion:[0.0d,0.0d,0.0d]}')
      }
    } finally { rc.close() }
    await sleep(1500)
    assert.ok((await game.botStatus(BOT)).inventory?.some((i) => i.id === 'TConstruct:shovel'),'test shovel acquired')
    const bounds = { x1:-453, y1:57, z1:108, x2:-444, y2:64, z2:116 }
    const before = await game.worldBlocks(bounds)
    transcript.push({ before })
    let stage = 0
    llm.fallback = (req) => {
      const seen = lastTurnText(req)
      transcript.push({ stage, seen })
      if (stage === 0) {
        stage = pond ? 2 : 1
        return { toolCalls: [{ name: pond ? 'collect_items' : 'dig_blocks', input: pond ? {x:-448,y:61,z:111,radius:6,...(terrain ? {dig:true,climb:true} : {})} : { blocks: clay.map(([x,y,z]) => ({x,y,z})) } }] }
      }
      if (stage === 1 && /任务 \w+（dig）完成/.test(seen)) {
        stage++
        return { toolCalls: [{ name: 'collect_items', input: { x:-448,y:61,z:111,radius:6,...(terrain ? {dig:true,climb:true} : {}) } }] }
      }
      if (stage === 2 && /任务 \w+（collect）(?:完成|失败)/.test(seen)) stage++
      return { text: '' }
    }
    timer = setInterval(() => {
      void Promise.all([game.botStatus(BOT), game.worldEntities({ x:-448,y:61,z:111 }, { radius:8 })]).then(([status, entities]) => tracks.push({ at:Date.now(), pos:status.pos, inWater:status.inWater, inventory:status.inventory, entities })).catch(() => {})
    }, 500)
    await brain.call('POST','/command',{text:'采这六块黏土，再捡回掉落。'})
    if (lost) {
      await until('collect has selected its target', async () => (await game.taskList(BOT)).active?.type==='collect',10000,50)
      await sleep(100)
      const rc = await openRcon()
      try { await rc.send('cofh killall item') } finally { rc.close() }
    }
    await until('dig and collect finish', () => stage === 3, 240000, 300)
    const tasks = await game.taskList(BOT)
    results.push(...(tasks.recent ?? []).filter((t) => t.type === 'collect' || t.type === 'dig'))
    const result = results.find((t) => t.type === 'collect')!
    const status = await game.botStatus(BOT)
    const entities = await game.worldEntities({ x:-448,y:61,z:111 }, {radius:8})
    const after = await game.worldBlocks(bounds)
    transcript.push({ after, status, entities, result })
    say(JSON.stringify(result))
    const count = (status.inventory ?? []).filter((i) => i.id === 'minecraft:clay_ball').reduce((n,i) => n+i.count,0)
    if (blocked || lost) {
      assert.equal(result.state,'failed','inaccessible or vanished items must not be reported as done')
      assert.equal(count,0)
      assert.equal((result.result?.dugOnTheWay as unknown[] | undefined)?.length ?? 0,0)
      if (lost) {
        assert.equal(result.error?.code,'interrupted')
        assert.equal(result.result?.disappearedTargets,1)
        assert.equal(result.result?.pickedUpStacks,0,'isDead is not a successful pickup')
      } else {
        assert.equal(result.error?.code,'unreachable')
        const remaining = result.result?.remaining as {id:string;count:number;reason:string}[]
        assert.equal(remaining.length,1)
        assert.equal(remaining[0]?.id,'minecraft:clay_ball')
        assert.equal(remaining[0]?.count,24)
        assert.match(remaining[0]?.reason ?? '',/unreachable/)
      }
      say('PASS: failed honestly without digging; remaining/lost target reported')
      return
    }
    assert.equal(count,24,'all 24 clay balls must be in inventory, not just a done flag')
    assert.equal(result.state,'done')
    assert.equal((result.result?.dugOnTheWay as unknown[] | undefined)?.length ?? 0,0,'collect must not tunnel through the lake bed, even with dig:true')
    assert.equal((result.result?.climbingBlocks as unknown[] | undefined)?.length ?? 0,0)
    if (pond) {
      const cells = (b: WorldBlocks) => {
        const out: string[] = []
        for (let i=0;i<b.runs.length;i+=2) {
          const p = b.palette[b.runs[i]!]!
          out.push(...Array<string>(b.runs[i+1]!).fill(`${p.id}/${p.meta ?? 0}`))
        }
        return out
      }
      const was = cells(before), now = cells(after)
      for (let i=0;i<was.length;i++) {
        if (/^(minecraft:(dirt|stone|clay)|BiomesOPlenty:mud)\//.test(was[i]!)) assert.equal(now[i],was[i],`lake bed cell ${i} unchanged`)
      }
      const rc = await openRcon()
      try { await rc.send(`tp ${BOT} -448.5 62.5 110.5`) } finally { rc.close() }
      const started = await game.taskStart(BOT,{type:'goto',x:-446,y:62,z:110,range:0,climb:false})
      const surface = await until('ordinary goto across water surface',async () => {
        const t = (await game.taskList(BOT)).recent?.find((r) => r.id===started.task.id)
        return t && ['done','failed'].includes(t.state) ? t : false
      },30000)
      results.push(surface)
      assert.equal(surface.state,'done','ordinary goto still crosses the surface')
      assert.equal((surface.result?.dugOnTheWay as unknown[] | undefined)?.length ?? 0,0)
      assert.ok((await game.botStatus(BOT)).pos!.y>61.3,'ordinary goto stayed at the surface')
      if (terrain) {
        const rc = await openRcon()
        try {
          await rc.send(`tp ${BOT} -450.5 63 111.5`)
          await rc.send('summon Item -447.5 60.78 111.5 {Item:{id:337s,Count:24b,Damage:0s},Motion:[0.0d,0.0d,0.0d]}')
        } finally { rc.close() }
        const legacy = await game.taskStart(BOT,{type:'collect',x:-448,y:61,z:111,radius:6})
        const ended = await until('legacy body collect without new flags',async () => (await game.taskList(BOT)).recent?.find((t) => t.id===legacy.task.id),30000)
        results.push(ended)
        assert.equal(ended.state,'done')
        assert.equal((ended.result?.dugOnTheWay as unknown[] | undefined)?.length ?? 0,0)
        assert.equal((await game.botStatus(BOT)).inventory?.filter((i) => i.id==='minecraft:clay_ball').reduce((n,i) => n+i.count,0),48)
      }
    }
    say('PASS: 24 clay balls recovered without changing terrain; pond mode also checks ordinary surface goto')
  } finally {
    if (timer) clearInterval(timer)
    fs.writeFileSync(output,JSON.stringify({terrain,pond,blocked,lost,data,results,transcript,tracks},null,2))
    await game.taskCancel(BOT).catch(() => {})
    brain.child.kill('SIGTERM')
    await brain.exited
    await llm.stop()
    await talk.stop()
    client.stop()
    say(`evidence: ${output}`)
  }
}
main().catch((e:unknown) => { console.error(e); process.exitCode=1 })
