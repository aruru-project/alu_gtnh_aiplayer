// f26/f27/f29: real brain + scripted local models + this worktree's GTNH test server.
// node test/live-fluid-machine.ts [--only-process | --only-limit | --only-wrong | --only-shortfall]
// Selectors skip already verified cases; each selected case gets fresh, powered fixtures.
// Uses a disposable platform at (10,100,10); no real model credentials or production ports.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BridgeApi } from '../src/bridge/api.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import { TESTSERVER_BRIDGE_PORT, TOKEN_FILE, lastTurnText, openRcon, sleep, startBrain, until } from './live-brain.ts'
import { MockLlm, talkRelay } from './mock-llm.ts'

const BOT = 'Alu'
const reactor = { x: 10, y: 100, z: 7 }
const solidifier = { x: 12, y: 100, z: 8 }
const GT = 'gregtech:gt.metaitem.01'
const observer = new BridgeClient({ address: () => ({ host: '127.0.0.1', port: TESTSERVER_BRIDGE_PORT }), token: () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(), clientName: 'live-fluid-machine' })
observer.start()
const game = new BridgeApi(observer)
const work = new MockLlm(), talk = new MockLlm()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplayer-fluid-machine-'))
const transcript = path.join(dir, 'transcript.txt')
console.log(`Evidence: ${dir}`)
const seen: string[] = []
work.fallback = (req) => {
  const text = lastTurnText(req)
  seen.push(text)
  fs.appendFileSync(transcript, `\nMODEL SAW:\n${text}\n`)
  return { text: '' }
}
talk.fallback = talkRelay()
await work.start(25640)
await talk.start(25641)
const brain = await startBrain(dir, undefined, 28783)
const rcon = await openRcon()
try {
  await until('test bridge', () => observer.isConnected(), 10000)
  for (const [line, model] of [['work', work], ['talk', talk]] as const) {
    const p = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: `script-${line}`, baseUrl: model.anthropicBaseUrl, apiKey: 'fake-local-only', model: `script-${line}` })
    await brain.call('POST', '/models/use', { providerId: p.provider.id, modelId: p.provider.models[0].id, line })
  }
  await brain.call('POST', '/bot/spawn', {}).catch(() => undefined)
  await until('online', async () => (await game.botStatus(BOT)).online, 10000)
  await game.taskCancel(BOT)
  await game.screenClose(BOT)
  for (let x = 7; x <= 14; x++) for (let z = 5; z <= 12; z++) for (let y = 99; y <= 102; y++) await rcon.send(`setblock ${x} ${y} ${z} ${y === 99 ? 'minecraft:stone' : 'minecraft:air'}`)
  await rcon.send('tp Alu 10 100 10')
  const stageReactor = async (tag = '') => {
    await game.screenClose(BOT)
    await rcon.send('clear Alu')
    await rcon.send('setblock 10 100 7 minecraft:air')
    await rcon.send('setblock 10 100 7 gregtech:gt.blockmachines 0 replace {mID:422s,mFacing:1s,mMainFacing:3,mStoredEnergy:8192L,mFluidOut:{FluidName:"molten.rubber",Amount:10368}}')
    await rcon.send(`give Alu ${GT} 1 32408${tag ? ` ${tag}` : ''}`)
  }
  const execute = async (name: string, code: string) => {
    const from = seen.length
    work.enqueue({ toolCalls: [{ name: 'start_routine', input: { name, code, minutes: 3 } }] })
    await brain.call('POST', '/command', { text: `Run scripted validation ${name}` })
    await until(name, () => seen.slice(from).some((s) => s.includes(`It returned: PASS ${name}`) || /Routine .*FAILED:/.test(s)), 160000)
    const result = seen.slice(from).join('\n')
    assert.match(result, new RegExp(`It returned: PASS ${name}`), result)
    await until('brain idle', async () => { const o = await brain.call('GET', '/overview'); return !o.agent.busy && !o.talk.busy && !o.agent.pending && !o.talk.pending }, 10000)
    console.log(`PASS ${name}`)
  }
  const prelude = `async function call(n,a={}) { const r=await tool(n,a); if(!r.ok) throw Error(n+': '+r.text); return r; } function check(ok,msg) { if(!ok) throw Error(msg); }`
  // All four cases use the same machine/cell; only the cell's saved fluid changes. The real UI action is unchanged.
  for (const [name, tag, fluid, amount, accepted] of [
    ['empty', '', undefined, 0, 10368],
    ['other-fluid', '{GT.FluidContent:{FluidName:"water",Amount:120}}', 'water', 120, 0],
    ['full', '{GT.FluidContent:{FluidName:"molten.rubber",Amount:64000}}', 'molten.rubber', 64000, 0],
    ['partial', '{GT.FluidContent:{FluidName:"molten.rubber",Amount:60000}}', 'molten.rubber', 60000, 4000],
  ] as const) {
    if (process.argv.some((x) => x.startsWith('--only-'))) continue
    await stageReactor(tag)
    await execute(`f26-${name}`, `${prelude}
const s=await call('open_screen',{at:${JSON.stringify(reactor)}});
const slot=s.data.slots.find(x=>x.own&&x.item?.meta===32408);
check(slot.item.fluidContainer?.amount===${amount},'cell initial fluid contents missing or incorrect: '+JSON.stringify(slot));
check(slot.item.fluidContainer?.fluid===${JSON.stringify(fluid) ?? 'undefined'},'wrong cell fluid');
await call('click_slot',{slot:slot.slot});
const before=await call('open_screen');
const key='auto_sync:basicmachine.chemicalreactor.tier.02:4';
check(before.data.controls.find(c=>c.key===key).cursorFillableMb===${accepted},'native simulation wrong');
const unchanged=await call('open_screen');
check(unchanged.data.cursor.fluidContainer.amount===${amount},'simulation mutated cursor');
const after=await call('use_control',{key});
check(after.data.controls.find(c=>c.key===key).amount===${10368 - accepted},'wrong tank transfer');
check(after.data.cursor.fluidContainer.amount===${amount + accepted},'wrong cursor transfer');
await call('close_screen'); return 'PASS f26-${name}';`)
  }
  const stageSolidifier = async (mb: number, mold = 32301) => {
    await game.screenClose(BOT)
    await rcon.send('clear Alu')
    await rcon.send('setblock 12 100 8 minecraft:air')
    await rcon.send(`setblock 12 100 8 gregtech:gt.blockmachines 0 replace {mID:522s,mFacing:1s,mMainFacing:3,mStoredEnergy:32768L,mFluid:{FluidName:"molten.rubber",Amount:${mb}}}`)
    await rcon.send(`give Alu ${GT} 1 ${mold}`)
    await game.screenOpen(BOT, solidifier)
    const screen = await until('solidifier screen settled', async () => { const s = await game.screenLook(BOT); return s.slots?.some((x) => x.own && x.item?.meta === mold) ? s : undefined }, 5000)
    const mould = screen.slots!.find((s) => s.own && s.item?.meta === mold)!
    await game.screenClick(BOT, { slot: mould.slot, shift: true })
    await game.screenClose(BOT)
  }
  if (process.argv.includes('--only-shortfall')) {
    await stageSolidifier(144)
    await until('one existing plate', async () => (await game.worldContainers(solidifier, { radius: 1 })).containers?.some((c) => c.x === 12 && c.items?.some((i) => i.meta === 17880 && i.count === 1)), 5000)
    await execute('f27-idle-shortfall', `${prelude}
const p=await tool('process_items',{machine:${JSON.stringify(solidifier)},recipe:208950,rounds:2,moldInside:true,wait:10});
const r=p.data.result;
check(!p.ok,'idle machine with only one of two requested plates was called done: '+p.text);
check(r.outputs.some(x=>x.meta===17880&&x.count===1),'lost partial collection');
check(r.missingOutputs.some(x=>x.meta===17880&&x.count===1),'missing count not reported');
check(r.stopReason==='machine_idle'&&r.requestedOutputsCollected===false,'idle shortfall reason missing');
return 'PASS f27-idle-shortfall';`)
    await stageSolidifier(9072)
    await execute('f27-timeout-shortfall', `${prelude}
const p=await tool('process_items',{machine:${JSON.stringify(solidifier)},recipe:208950,rounds:63,moldInside:true,wait:5});
const r=p.data.result;
check(!p.ok,'timeout with incomplete collection was called done: '+p.text);
const got=r.outputs.filter(x=>x.meta===17880).reduce((n,x)=>n+x.count,0);
const missing=r.missingOutputs.filter(x=>x.meta===17880).reduce((n,x)=>n+x.count,0);
check(got>0&&got<63&&got+missing===63,'partial and missing quantities inconsistent');
check(r.stopReason==='wait_limit'&&r.timedOut===true&&r.requestedOutputsCollected===false,'timeout reason missing');
return 'PASS f27-timeout-shortfall';`)
    // No collection goal: idle observation is allowed to finish. leave is a snapshot, not goal completion.
    await stageSolidifier(0)
    await execute('f27-observe-without-goal', `${prelude}
const p=await call('process_items',{machine:${JSON.stringify(solidifier)},inputs:[],wait:5});
check(p.data.result.observedExisting===true&&p.data.result.outputs.length===0,'not pure observation');
return 'PASS f27-observe-without-goal';`)
    await stageSolidifier(9072)
    await execute('f27-leave-snapshot', `${prelude}
const p=await call('process_items',{machine:${JSON.stringify(solidifier)},recipe:208950,rounds:63,moldInside:true,leave:true});
check(p.data.result.startedByTask===false&&p.data.result.outputs.length===0,'leave collected or claimed its own batch');
check(p.data.result.requestedOutputsCollected===false,'snapshot claimed collection complete');
return 'PASS f27-leave-snapshot';`)
  } else {
  // Solidifier with 63 rounds worth of rubber and a resident plate mould; machine already runs before process_items.
  if (!process.argv.includes('--only-limit') && !process.argv.includes('--only-wrong')) {
  await stageSolidifier(9072)
  // Read-only NEI query through the model tool and a direct current state sample (actual machine, not a mock formula).
  const working = await until('solidifier running', async () => (await game.worldMachines(solidifier, { radius: 1 })).machines?.find((m) => m.x === 12 && (m.maxProgress ?? 0) > 0), 5000)
  assert.equal(working.maxProgress, 16)
  const oc = await game.recipeOverclock({ machine: solidifier, recipeKey: 'gt.recipe.fluidsolidifier', eut: 8, ticks: 32 })
  assert.deepEqual([oc.ticks, oc.eut], [16, 32])
  fs.appendFileSync(transcript, `\nACTUAL vs NEI: ${JSON.stringify({ working, oc })}\n`)
  await execute('f29', `${prelude}
const r=await call('find_recipes',{id:'${GT}',meta:17880,way:'gt.recipe.fluidsolidifier',machine:${JSON.stringify(solidifier)}});
check(r.text.includes('16 ticks (0.8 s), 32 EU/t'),'MV prediction missing: '+r.text);
check(r.text.includes('8 EU/t')&&r.text.includes('1.6 s'),'base recipe was changed');
return 'PASS f29';`)
  await execute('f27', `${prelude}
const p=await call('process_items',{machine:${JSON.stringify(solidifier)},recipe:208950,rounds:63,moldInside:true,wait:90});
const r=p.data.result;
check(r.observedExisting===true&&r.startedByTask===false,'claimed own batch');
check(r.put===0&&r.rounds===undefined&&r.made===undefined,'claimed fabricated rounds/made');
check(r.observedRounds<63,'already completed rounds attributed to this watch');
check(r.outputs.reduce((n,x)=>n+(x.meta===17880?x.count:0),0)===63,'did not collect exactly 63 plates: '+JSON.stringify(r));
check(r.requestedOutputsCollected===true,'count not met');
const s=await call('open_screen',{at:${JSON.stringify(solidifier)}});
check(s.data.slots.some(x=>!x.own&&x.item?.meta===32301),'resident mould was taken');
await call('close_screen');return 'PASS f27';`)
  }
  // A fresh powered fixture: the 63-round run uses almost the entire stored energy buffer.
  // Produce five normally before asking to collect two; no claims of new production are justified.
  if (!process.argv.includes('--only-wrong')) {
  await stageSolidifier(720)
  await until('five pre-existing plates', async () => {
    const b = await game.worldContainers(solidifier, { radius: 0 })
    return b.containers?.some((c) => c.items?.some((i) => i.meta === 17880 && i.count === 5))
  }, 10000)
  await execute('f27-existing-limit', `${prelude}
const p=await tool('process_items',{machine:${JSON.stringify(solidifier)},recipe:208950,rounds:2,moldInside:true,wait:10});
const r=p.data.result;
check(!p.ok&&r.pickupLimited?.minimum===3&&r.pickupLimited?.wanted===2,'did not explain native pickup limit: '+p.text);
check(r.existingOutputs.some(x=>x.meta===17880&&x.count===5),'did not disclose existing stock');
check(r.observedRounds===0,'claimed old stock as new production');
check(r.outputs.length===0&&r.requestedOutputsCollected===false,'took extra or falsely claimed collection');
const s=await call('open_screen',{at:${JSON.stringify(solidifier)}});
check(s.data.slots.some(x=>!x.own&&x.item?.meta===17880&&x.item.count===5),'took other plates');
check(s.data.slots.some(x=>!x.own&&x.item?.meta===32301),'took resident mould');
await call('close_screen');return 'PASS f27-existing-limit';`)
  await stageSolidifier(576)
  await until('four pre-existing plates', async () => (await game.worldContainers(solidifier, { radius: 0 })).containers?.some((c) => c.items?.some((i) => i.meta === 17880 && i.count === 4)), 10000)
  await execute('f27-half-stack', `${prelude}
const p=await call('process_items',{machine:${JSON.stringify(solidifier)},recipe:208950,rounds:2,moldInside:true,wait:10});
check(p.data.result.outputs.some(x=>x.meta===17880&&x.count===2),'native half-stack did not collect two');
check(p.data.result.observedRounds===0,'old stock counted as new');
const s=await call('open_screen',{at:${JSON.stringify(solidifier)}});
check(s.data.slots.some(x=>!x.own&&x.item?.meta===17880&&x.item.count===2),'two did not remain');
check(s.data.slots.some(x=>!x.own&&x.item?.meta===32301),'resident mould taken');
await call('close_screen');return 'PASS f27-half-stack';`)
  }
  // The machine is active, but on an ingot recipe: observation must reject a plate request.
  await stageSolidifier(9072, 32306)
  await until('ingot recipe actually running', async () => (await game.worldMachines(solidifier, { radius: 1 })).machines?.some((m) => m.x === 12 && (m.maxProgress ?? 0) > 0), 5000)
  await execute('f27-wrong-recipe', `${prelude}
const p=await tool('process_items',{machine:${JSON.stringify(solidifier)},recipe:208950,rounds:63,moldInside:true,wait:10});
check(!p.ok&&p.text.includes('existing machine recipe does not make the expected items'),'wrong recipe counted as success: '+p.text);
check(p.data.result.startedByTask===false,'claimed to start wrong recipe');
const s=await call('open_screen',{at:${JSON.stringify(solidifier)}});
check(s.data.slots.some(x=>!x.own&&x.item?.meta===32306),'took resident ingot mould');
await call('close_screen');return 'PASS f27-wrong-recipe';`)
  // No generic formula is substituted for a multiblock.
  await rcon.send('setblock 13 100 8 gregtech:gt.blockmachines 0 replace {mID:1000s,mFacing:3s}')
  const multi = await game.recipeOverclock({ machine: { x: 13, y: 100, z: 8 }, recipeKey: 'gt.recipe.blastfurnace', eut: 120, ticks: 1000 })
  assert.match(multi.unavailable ?? '', /parallel.*amperage/)
  assert.equal(multi.ticks, undefined)
  fs.appendFileSync(transcript, `\nMULTIBLOCK: ${JSON.stringify(multi)}\n`)
  }
  console.log('All selected live fluid/machine checks passed')
} finally {
  await game.taskCancel(BOT).catch(() => undefined)
  await game.screenClose(BOT).catch(() => undefined)
  rcon.close()
  brain.child.kill('SIGTERM')
  await Promise.race([brain.exited, sleep(5000)])
  fs.writeFileSync(path.join(dir, 'brain-output.txt'), brain.output())
  await work.stop(); await talk.stop(); observer.stop()
}
