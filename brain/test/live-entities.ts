// f30: real brain + scripted local model + this worktree's GTNH body. No real model keys.
// Creates its own high stone platform and animals with RCON (fixture only), then the model uses
// list_entities / use_item through a routine. Actual shearing, feeding and attacking are ordinary C02 packets.
// Run: node test/live-entities.ts [--log /tmp/entities.log] (server must already be running).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import { TESTSERVER_BRIDGE_PORT, TOKEN_FILE, lastTurnText, openRcon, say, sleep, startBrain, until } from './live-brain.ts'
import { MockLlm, talkRelay } from './mock-llm.ts'

const BOT = 'Alu'
const X = 1000, Y = 180, Z = 1000
const logFile = process.argv.includes('--log') ? process.argv[process.argv.indexOf('--log') + 1]! : '/tmp/aip/entities2-live.log'
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplayer-live-entities-'))
fs.chmodSync(dataDir, 0o700)
const log = (text: string) => { say(text); fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`) }

async function main() {
  fs.writeFileSync(logFile, `f30 entities live; brain data ${dataDir}\n`)
  const observer = new BridgeClient({ address: () => ({ host: '127.0.0.1', port: TESTSERVER_BRIDGE_PORT }), token: () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(), clientName: 'live-entities-driver' })
  observer.start()
  const game = new BridgeApi(observer)
  const rcon = await openRcon()
  const work = new MockLlm(), talk = new MockLlm()
  let brain: Awaited<ReturnType<typeof startBrain>> | undefined
  let sampling = false
  let sampler: Promise<void> | undefined
  try {
    await until('bridge connected', () => observer.isConnected(), 10000)
    const bot = await game.botStatus(BOT).catch(() => undefined)
    if (!bot?.online) await game.botSpawn({ name: BOT, x: X + 0.5, y: Y, z: Z + 0.5 })
    await game.taskCancel(BOT)
    await game.botConfigure(BOT, { invulnerable: true, hunger: false })
    await rcon.send(`say [entities2 test] Preparing f30 isolated entity fixture.`)
    await rcon.send(`gamemode 1 ${BOT}`)
    await rcon.send(`tp ${BOT} ${X + 0.5} ${Y} ${Z + 0.5}`)
    await sleep(1000)
    // No grass to regrow wool during the test. High above natural terrain, fences keep the animals on it.
    for (let x = X - 2; x <= X + 61; x++) {
      for (let z = Z - 3; z <= Z + 3; z++) await rcon.send(`setblock ${x} ${Y - 1} ${z} minecraft:stone`)
      await rcon.send(`setblock ${x} ${Y} ${Z - 3} minecraft:fence`)
      await rcon.send(`setblock ${x} ${Y} ${Z + 3} minecraft:fence`)
    }
    for (const x of [X - 2, X + 61]) for (let z = Z - 2; z <= Z + 2; z++) await rcon.send(`setblock ${x} ${Y} ${z} minecraft:fence`)
    await rcon.send(`clear ${BOT}`)
    await rcon.send(`give ${BOT} minecraft:shears 1`)
    await rcon.send(`give ${BOT} minecraft:wheat 8`)
    await rcon.send(`gamemode 0 ${BOT}`)
    await rcon.send(`tp ${BOT} ${X + 0.5} ${Y} ${Z + 0.5}`)
    const suffix = String(Date.now()).slice(-7)
    const sheepName = `F30Red${suffix}`, cowName = `F30Cow${suffix}`
    log(await rcon.send(`summon Sheep ${X + 53}.5 ${Y} ${Z}.5 {CustomName:"${sheepName}",PersistenceRequired:1b,Color:14,Sheared:0b,Age:0}`))
    log(await rcon.send(`summon Cow ${X + 45}.5 ${Y} ${Z + 1}.5 {CustomName:"${cowName}",PersistenceRequired:1b,Age:0}`))
    // A stable player entity identity actually changes dimension between selection and runtime.
    const previous = await game.botStatus('F30Mover').catch(() => undefined)
    if (previous?.online) await game.botDespawn('F30Mover')
    const oldMover = await game.botSpawn({ name: 'F30Mover', dim: 0, x: X + 10.5, y: Y, z: Z + 0.5 })
    await game.botDespawn('F30Mover')
    await game.botSpawn({ name: 'F30Mover', dim: -1, x: 0.5, y: 100, z: 0.5 })
    const mover = { uuid: oldMover.uuid, dim: 0 }
    assert.equal((await game.botStatus('F30Mover')).dim, -1)
    const first = await game.worldEntities({ x: X + 30, y: Y, z: Z }, { radius: 64, limit: 1 })
    assert.equal(first.entities?.length, 1)
    assert.equal(first.more, first.total! - 1)
    const last = await game.worldEntities({ x: X + 30, y: Y, z: Z }, { radius: 64, limit: 1, offset: first.total! - 1 })
    assert.equal(last.entities?.length, 1)
    assert.equal(last.more, 0)
    log(`PAGINATION ${JSON.stringify({ first, last })}`)

    const code = `
const require = (ok, message) => { if (!ok) throw new Error(message); };
let all = [];
for (let page=1;page<20;page++) {
  const r = await tool('list_entities',{radius:64,at:{x:${X + 30},y:${Y},z:${Z}},page});
  require(r.ok, r.text); all.push(...r.data.entities);
  if (!r.data.more) break;
}
const sheep=all.find(e=>e.name===${JSON.stringify(sheepName)}), cow=all.find(e=>e.name===${JSON.stringify(cowName)});
require(sheep && sheep.uuid && sheep.dim===0 && sheep.pos && sheep.state.woolColor==='red' && sheep.state.sheared===false,'precise red sheep identity/state missing');
require(cow && cow.uuid,'cow identity missing');
const entity={uuid:sheep.uuid,dim:sheep.dim};
const start=(await tool('get_status',{})).data;
// Wheat in hand while approaching tempts the animal toward the player: a repeatable normal moving target.
require((await tool('use_item',{id:'minecraft:wheat'})).ok,'holding wheat failed');
const shear=await tool('use_item',{id:'minecraft:shears',entity});
log('SHEAR',JSON.stringify(shear.data)); require(shear.ok,shear.text);
const s=shear.data.result;
require(s.entityBefore.state.sheared===false && s.entityNow.state.sheared===true,'sheep did not become sheared');
require(s.entityNow.state.woolColor==='red' && s.newNearbyDrops.some(e=>e.item.id==='minecraft:wool' && e.item.meta===14 && e.item.count>0),'red wool drops missing');
const moved=Math.hypot(s.entityBefore.pos.x-sheep.pos.x,s.entityBefore.pos.z-sheep.pos.z);
require(moved>1,'animal did not move at least one block after observation');
const again=await tool('use_item',{id:'minecraft:shears',entity});
require(again.ok && again.data.result.entityBefore.state.sheared && again.data.result.entityNow.state.sheared && again.data.result.newNearbyDrops.length===0,'already sheared animal falsely produced wool');
const detail=await tool('list_entities',{entity,detail:true,path:'Color'});
require(detail.ok && detail.data.saved===14,'entity saved Color path unavailable');
const feed=await tool('use_item',{id:'minecraft:wheat',entity});
log('FEED',JSON.stringify(feed.data)); require(feed.ok,feed.text);
require(feed.data.result.entityNow.state.inLove===true && feed.data.result.lost.some(i=>i.id==='minecraft:wheat' && i.count===1),'feeding had no ordinary wheat/heart effect');
const attack=await tool('use_item',{entity:{uuid:cow.uuid,dim:cow.dim},left:true});
log('ATTACK',JSON.stringify(attack.data)); require(attack.ok,attack.text);
require(attack.data.result.entityEvents===1 && attack.data.result.entityNow.state.health<attack.data.result.entityBefore.state.health,'normal attack event/damage missing');
const gone=await tool('use_item',{entity:{uuid:'00000000-0000-0000-0000-000000000030',dim:0}});
require(!gone.ok && gone.data.error.code==='not_found' && gone.data.result.clicks===0,'missing target did not fail honestly');
const changed=await tool('use_item',{entity:${JSON.stringify(mover)}});
require(!changed.ok && changed.data.error.code==='wrong_dimension' && changed.data.result.clicks===0,'changed dimension target did not fail honestly');
return 'ENTITY_LIVE_OK '+JSON.stringify({start:start.pos,listed:sheep.pos,clicked:s.entityBefore.pos,moved,wool:s.newNearbyDrops,after:s.entityNow.state,feed:feed.data.result.entityNow.state,attackBefore:attack.data.result.entityBefore.state.health,attackAfter:attack.data.result.entityNow.state.health,gone:gone.data.error,changed:changed.data.error});`
    let completed = false
    let failure = ''
    work.fallback = (req) => {
      const text = lastTurnText(req)
      fs.appendFileSync(logFile, `\nMODEL SAW\n${text}\n`)
      if (text.includes('ENTITY_LIVE_OK')) completed = true
      if (/Routine .* (failed|stopped)|program failed/i.test(text)) failure = text
      return { text: '' }
    }
    work.enqueue({ toolCalls: [{ name: 'start_routine', input: { name: 'f30 ordinary entity interactions', minutes: 4, code } }] }, { text: 'Waiting for ordinary entity actions.' })
    talk.fallback = talkRelay()
    await work.start(Number(process.env.LIVE_LLM_PORT ?? 25640))
    await talk.start(Number(process.env.LIVE_LLM_PORT ?? 25640) + 1)
    brain = await startBrain(dataDir, undefined, Number(process.env.LIVE_PANEL_PORT ?? 28784))
    const provider = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: 'entity-script', baseUrl: work.anthropicBaseUrl, apiKey: 'fake-entities-only', model: 'scripted' })
    await brain.call('POST', '/models/use', { providerId: provider.provider.id, modelId: provider.provider.models[0].id, line: 'work' })
    const relay = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: 'entity-relay', baseUrl: talk.anthropicBaseUrl, apiKey: 'fake-entities-only', model: 'relay' })
    await brain.call('POST', '/models/use', { providerId: relay.provider.id, modelId: relay.provider.models[0].id, line: 'talk' })
    await until('brain connected', async () => (await brain!.call('GET', '/overview')).bridge.state === 'connected', 10000)
    sampling = true
    sampler = (async () => {
      while (sampling) {
        const state = await game.botStatus(BOT)
        fs.appendFileSync(logFile, `SAMPLE ${JSON.stringify({ time: Date.now(), pos: state.pos, task: state.task })}\n`)
        await sleep(250)
      }
    })()
    await brain.call('POST', '/command', { text: 'Read exact entity identities and states, shear the named red sheep, feed it wheat, punch the cow once, check vanished/changed-dimension targets. Use the prepared entity test routine.' })
    await until('routine outcome', () => completed || failure, 240000)
    assert.equal(failure, '', failure)
    assert.equal(completed, true)
    log('PASS ENTITY_LIVE_OK; complete observations in model transcript and brain data.')
  } finally {
    sampling = false
    await sampler
    if (brain) { brain.child.kill('SIGTERM'); await brain.exited }
    await work.stop(); await talk.stop()
    await game.taskCancel(BOT).catch(() => {})
    await game.botDespawn('F30Mover').catch(() => {})
    observer.stop()
    rcon.close()
    log(`Brain data retained at ${dataDir}`)
  }
}
main().catch((e) => { log(String(e)); process.exitCode = 1 })
