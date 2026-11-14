// Real model-tool entry points, scripted local models, this worktree's disposable GTNH test server.
// node test/live-materials.ts [--only containers|brick|process|controller|pickup|return-space] [--baseline]
// No real model credentials. Fixtures use RCON; acceptance actions use ordinary tool/slot calls.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { BridgeClient } from '../src/bridge/client.ts'
import { BridgeApi } from '../src/bridge/api.ts'
import { TESTSERVER_BRIDGE_PORT, TOKEN_FILE, lastTurnText, openRcon, sleep, startBrain, until } from './live-brain.ts'
import { MockLlm, talkRelay } from './mock-llm.ts'

const BOT = 'Alu'
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined
const baseline = process.argv.includes('--baseline')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiplayer-materials-'))
console.log(`Evidence: ${dir}`)
const observer = new BridgeClient({ address: () => ({ host: '127.0.0.1', port: TESTSERVER_BRIDGE_PORT }), token: () => fs.readFileSync(TOKEN_FILE, 'utf8').trim(), clientName: 'live-materials' })
observer.start()
const game = new BridgeApi(observer)
const work = new MockLlm(), talk = new MockLlm(), seen: string[] = []
work.fallback = (req) => { const text = lastTurnText(req); seen.push(text); fs.appendFileSync(path.join(dir, 'transcript.txt'), `\nMODEL SAW\n${text}\n`); return { text: '' } }
talk.fallback = talkRelay()
await work.start(29606); await talk.start(29607)
const brain = await startBrain(dir, undefined, 29608)
const rcon = await openRcon()
const failures: string[] = []
const execute = async (name: string, code: string) => {
  const from = seen.length
  const oldTasks = new Set((await game.taskList(BOT)).recent?.map(t=>t.id))
  const before = await game.botStatus(BOT)
  work.enqueue({ toolCalls: [{ name: 'start_routine', input: { name, code, minutes: 3 } }] })
  await brain.call('POST', '/command', { text: `Run scripted acceptance ${name}` })
  await until(name, () => seen.slice(from).some((s) => s.includes(`It returned: PASS ${name}`) || /Routine .*FAILED:/.test(s)), 160000)
  const result = seen.slice(from).join('\n')
  fs.appendFileSync(path.join(dir,'evidence.jsonl'),JSON.stringify({name,before,after:await game.botStatus(BOT),tasks:(await game.taskList(BOT)).recent?.filter(t=>!oldTasks.has(t.id)),containers:await game.worldContainers({x:10,y:100,z:8},{radius:8})})+'\n')
  if (!result.includes(`It returned: PASS ${name}`)) failures.push(name)
  console.log(`${result.includes(`It returned: PASS ${name}`) ? 'PASS' : 'FAIL'} ${name}`)
  await until('brain idle', async () => { const o = await brain.call('GET', '/overview'); return !o.agent.busy && !o.talk.busy && !o.agent.pending && !o.talk.pending }, 10000)
}
const pre = `async function call(n,a={}) { const r=await tool(n,a); return r; } function check(ok,msg) { if(!ok) throw Error(msg); }`
const stage = async () => { await game.taskCancel(BOT); await game.screenClose(BOT); await rcon.send('clear Alu'); await rcon.send('tp Alu 10 100 10'); await sleep(300) }
const fillBag = async () => { for (let i=0;i<35;i++) await rcon.send('give Alu minecraft:wooden_sword 1') }
try {
  await until('bridge', () => observer.isConnected(), 10000)
  for (const [line, model] of [['work', work], ['talk', talk]] as const) {
    const p = await brain.call('POST', '/providers', { kind: 'anthropic-messages', label: `script-${line}`, baseUrl: model.anthropicBaseUrl, apiKey: 'fake-local-only', model: `script-${line}` })
    await brain.call('POST', '/models/use', { providerId: p.provider.id, modelId: p.provider.models[0].id, line })
  }
  await brain.call('POST', '/bot/spawn', {}).catch(() => undefined)
  await until('online', async () => (await game.botStatus(BOT)).online, 10000)
  await rcon.send('tp Alu 10 100 10'); await sleep(1000)
  for (let x = 7; x <= 14; x++) for (let z = 5; z <= 13; z++) for (let y = 99; y <= 104; y++) await rcon.send(`setblock ${x} ${y} ${z} ${y === 99 ? 'minecraft:stone' : 'minecraft:air'}`)
  if (!only || only === 'containers') {
    await stage()
    await rcon.send('setblock 10 100 7 minecraft:furnace')
    await rcon.send('give Alu minecraft:log 8 1'); await fillBag()
    await execute('deposit-two-full-bag', `${pre}
const b=await call('get_status'); check(b.data.freeSlots===0,'fixture not full');
const r=await call('deposit_items',{container:{x:10,y:100,z:7},items:[{id:'minecraft:log',meta:1,count:2}]});
const s=await call('get_status');
check(r.data.result.moved===2,'requested 2, actual receipt '+JSON.stringify(r));
check(s.data.inventory.filter(x=>x.id==='minecraft:log').reduce((n,x)=>n+x.count,0)===6,'six logs not retained'); return 'PASS deposit-two-full-bag';`)
    await stage(); await rcon.send('setblock 12 100 8 minecraft:air'); await rcon.send('setblock 12 100 8 minecraft:chest')
    await rcon.send('give Alu minecraft:flint 5'); await game.screenOpen(BOT,{x:12,y:100,z:8})
    const chest = await until('chest screen',async()=>{ const s=await game.screenLook(BOT); return s.slots?.some(x=>x.own&&x.item?.id==='minecraft:flint')?s:undefined },5000)
    await game.screenClick(BOT,{slot:chest.slots!.find(x=>x.own&&x.item?.id==='minecraft:flint')!.slot,shift:true}); await game.screenClose(BOT)
    await fillBag()
    await execute('withdraw-one-last-slot', `${pre}
const r=await call('withdraw_items',{container:{x:12,y:100,z:8},items:[{id:'minecraft:flint',count:1}]});
const s=await call('get_status'); const c=await call('list_containers',{at:{x:12,y:100,z:8},radius:0});
check(r.data.result.moved===1,'one requested, receipt '+JSON.stringify(r));
check(s.data.inventory.some(x=>x.id==='minecraft:flint'&&x.count===1),'one not carried');
check(c.data.containers[0].items.some(x=>x.id==='minecraft:flint'&&x.count===4),'four not retained'); return 'PASS withdraw-one-last-slot';`)
    await stage(); await rcon.send('setblock 12 100 8 minecraft:air'); await rcon.send('setblock 12 100 8 TConstruct:ToolStationBlock 5')
    await rcon.send('give Alu TConstruct:woodPattern 1 1')
    await game.screenOpen(BOT, { x: 12, y: 100, z: 8 })
    const sc = await until('pattern screen', async () => { const s = await game.screenLook(BOT); return s.slots?.some(x=>x.own&&x.item?.id==='TConstruct:woodPattern') ? s : undefined }, 5000)
    await game.screenClick(BOT, { slot: sc.slots!.find(x=>x.own&&x.item?.id==='TConstruct:woodPattern')!.slot, shift:true }); await game.screenClose(BOT)
    await execute('withdraw-restricted-storage', `${pre}
const r=await call('withdraw_items',{container:{x:12,y:100,z:8},items:[{id:'TConstruct:woodPattern',meta:1,count:1}]});
check(r.data.result.moved===1,'pattern remained in restricted storage: '+JSON.stringify(r)); return 'PASS withdraw-restricted-storage';`)
  }
  if (!only || only === 'brick') {
    await stage(); await rcon.send('setblock 10 100 8 minecraft:crafting_table'); await rcon.send('give Alu dreamcraft:WoodenBrickForm 1'); await rcon.send('give Alu minecraft:clay_ball 16')
    await execute('brick-real-remainder', `${pre}
const r=await call('craft_item',{recipe:11917,count:16}); const s=await call('get_status');
check(r.data.result.crafted===${baseline ? 8 : 16},'wrong native craft count: '+JSON.stringify(r));
${baseline ? '' : "check(s.data.inventory.some(x=>x.id==='dreamcraft:WoodenBrickForm'&&x.rawDamage===2),'real remainder damage missing'); return 'PASS brick-real-remainder';"}
const sc=await call('open_screen',{at:{x:10,y:100,z:8}});
await call('click_slot',{slot:sc.data.slots.find(x=>x.own&&x.item?.id==='minecraft:clay_ball').slot});
for(let i=1;i<=9;i++)if(i!==5)await call('click_slot',{slot:i,right:true});
const laid=await call('open_screen'); await call('click_slot',{slot:laid.data.slots.find(x=>x.own&&x.item?.id==='dreamcraft:WoodenBrickForm').slot});
await call('click_slot',{slot:5}); const native=await call('open_screen');
check(native.data.slots.find(x=>x.slot===0)?.item?.count===8,'native worn form rejected: '+JSON.stringify(native));
await call('close_screen');
return 'PASS brick-real-remainder';`)
  }
  if (only === 'custom-output') {
    await stage();await rcon.send('setblock 10 100 7 IC2:blockMachine 1');await rcon.send('give Alu minecraft:iron_ore 2')
    await game.screenOpen(BOT,{x:10,y:100,z:7});const sc=await until('IC2 screen',async()=>{const s=await game.screenLook(BOT);return s.slots?.some(x=>x.own&&x.item?.id==='minecraft:iron_ore')?s:undefined},5000)
    await game.screenClick(BOT,{slot:sc.slots!.find(x=>x.own&&x.item?.id==='minecraft:iron_ore')!.slot,shift:true});await game.screenClose(BOT)
    await execute('empty-custom-output-preserves-input',`${pre}
const initial=await call('open_screen',{at:{x:10,y:100,z:7}});check(initial.data.slots.some(x=>!x.own&&x.item?.id==='minecraft:iron_ore'&&x.item.count===2),'bad input fixture');check(initial.data.slots.some(x=>!x.own&&x.class==='SlotInvSlot'&&!x.item),'no empty IC2 custom slot');await call('close_screen');
const r=await call('withdraw_items',{container:{x:10,y:100,z:7},items:[{id:'minecraft:iron_ore',count:1}]});
check(r.data.result.moved===0&&r.data.result.missing[0].count===1,'default withdrawal stole pending input: '+JSON.stringify(r));
const explicit=await call('withdraw_items',{container:{x:10,y:100,z:7},items:[{id:'minecraft:iron_ore',count:1}],fromInputs:true});check(explicit.ok&&explicit.data.result.moved===1,'explicit input withdrawal failed');return 'PASS empty-custom-output-preserves-input';`)
  }
  if (only === 'pickup') {
    for(const size of [5,4]) {
      await stage(); await rcon.send('setblock 10 100 7 minecraft:air')
      await rcon.send(`setblock 10 100 7 minecraft:furnace 0 replace {Items:[{Slot:2b,id:318s,Count:${size}b,Damage:0s}]}`)
      await execute(`output-native-${size}`,`${pre}
const initial=await call('open_screen',{at:{x:10,y:100,z:7}});check(initial.data.slots.find(x=>x.slot===2)?.item?.count===${size},'bad output fixture');await call('close_screen');
const r=await call('withdraw_items',{container:{x:10,y:100,z:7},items:[{id:'minecraft:flint',count:2}]});const after=await call('open_screen',{at:{x:10,y:100,z:7}});
check(${size}===5 ? !r.ok&&r.data.result.moved===0&&r.data.result.missing[0].count===2&&r.data.result.pickupLimited.minimum===3 : r.ok&&r.data.result.moved===2,'wrong native pickup: '+JSON.stringify(r));
check(after.data.slots.find(x=>x.slot===2)?.item?.count===${size===5?5:2},'source output changed incorrectly');await call('close_screen');return 'PASS output-native-${size}';`)
    }
    await stage(); await rcon.send('setblock 12 100 8 minecraft:chest 0 replace {Items:[{Slot:0b,id:318s,Count:5b,Damage:0s}]}');await fillBag();await rcon.send('give Alu minecraft:wooden_sword 1')
    await execute('withdraw-no-capacity',`${pre}
const r=await call('withdraw_items',{container:{x:12,y:100,z:8},items:[{id:'minecraft:flint',count:1}]});
check(!r.ok&&r.data.error.code==='inventory_full'&&r.data.result.moved===0&&r.data.result.missing[0].count===1,'full inventory hidden: '+JSON.stringify(r));return 'PASS withdraw-no-capacity';`)
  }
  if (only === 'return-space') {
    await stage();await rcon.send('setblock 10 100 7 gregtech:gt.blockmachines 0 replace {mID:303s,mFacing:4s,mMainFacing:3,mStoredEnergy:32768L,mItemTransfer:1b}')
    await rcon.send('give Alu minecraft:bedrock 1');await fillBag()
    const running=execute('return-no-capacity',`${pre}
const r=await call('process_items',{machine:{x:10,y:100,z:7},inputs:[{id:'minecraft:bedrock',count:1}],wait:5});
check(!r.ok&&r.data.result.put===1,'invalid fixture: '+JSON.stringify(r));check(r.data.result.returnedInputs.length===0&&r.data.result.inputsNotReturned[0].count===1&&r.data.result.returnFailure.includes('inventory_full'),'false return: '+JSON.stringify(r));return 'PASS return-no-capacity';`)
    await until('bedrock loaded',async()=> (await game.worldContainers({x:10,y:100,z:7},{radius:0})).containers?.some(c=>c.items?.some(i=>i.id==='minecraft:bedrock'&&i.count===1)),10000)
    await rcon.send('give Alu minecraft:wooden_sword 1'); await running
  }
  if (only === 'controller') {
    await stage()
    for(let x=9;x<=11;x++)for(let y=100;y<=102;y++)for(let z=5;z<=7;z++) await rcon.send(`setblock ${x} ${y} ${z} ${x===10&&y===101&&z===6?'minecraft:air':'gregtech:gt.blockcasings12'}`)
    await rcon.send('setblock 10 101 7 gregtech:gt.blockmachines 0 replace {mID:236s,mFacing:3s}')
    await rcon.send('give Alu minecraft:log 8')
    await sleep(3000)
    await execute('controller-direct-input', `${pre}
const m=await call('find_machines',{at:{x:10,y:101,z:7},radius:1});
const r=await call('process_items',{machine:{x:10,y:101,z:7},inputs:[{id:'minecraft:log',count:4}],leave:true});
const s=await call('get_status');check(r.ok&&r.data.result.put===4&&r.data.result.left===true,'controller input failed: '+JSON.stringify(r));
check(s.data.inventory.some(x=>x.id==='minecraft:log'&&x.count===4),'did not retain four');return 'PASS controller-direct-input';`)
  }
  if (!only || only === 'process') {
    await stage(); await rcon.send('setblock 10 100 7 minecraft:air'); await rcon.send('setblock 9 100 7 minecraft:chest')
    await rcon.send('setblock 10 100 7 gregtech:gt.blockmachines 0 replace {mID:303s,mFacing:4s,mMainFacing:3,mStoredEnergy:32768L,mItemTransfer:1b}')
    await rcon.send('give Alu gregtech:gt.metaitem.01 1 17880')
    await execute('fast-auto-output', `${pre}
const c=await call('list_containers',{at:{x:9,y:100,z:7},radius:0});
const r=await call('process_items',{machine:{x:10,y:100,z:7},recipe:138668,rounds:1,wait:10});
const s=await call('get_status'); const a=await call('list_containers',{at:{x:9,y:100,z:7},radius:0});
check(r.ok,'fast run called not started: '+JSON.stringify(r));
check(r.data.result.rounds===1,'fast completion missed: '+JSON.stringify(r));
check(r.data.result.elsewhere?.some(x=>x.items.some(i=>i.meta===2880&&i.count===1)),'auto output delta missing');return 'PASS fast-auto-output';`)
    await stage(); await rcon.send('give Alu minecraft:bedrock 1')
    await execute('invalid-input-return', `${pre}
const r=await call('process_items',{machine:{x:10,y:100,z:7},inputs:[{id:'minecraft:bedrock',count:1}],wait:5}); const s=await call('get_status');
check(!r.ok&&r.data.result.put===1,'invalid-input fixture never loaded: '+JSON.stringify(r));check(s.data.inventory.some(x=>x.id==='minecraft:bedrock'&&x.count===1),'bedrock not returned');
${baseline ? '' : "check(r.data.result.returnedInputs?.some(x=>x.id==='minecraft:bedrock'&&x.count===1),'actual return not reported');"}
return 'PASS invalid-input-return';`)
  }
} finally {
  await game.taskCancel(BOT).catch(()=>undefined); await game.screenClose(BOT).catch(()=>undefined)
  rcon.close(); brain.child.kill('SIGTERM'); await Promise.race([brain.exited,sleep(5000)])
  fs.writeFileSync(path.join(dir,'brain-output.txt'),brain.output()); await work.stop(); await talk.stop(); observer.stop()
}
assert.equal(failures.length,0,failures.join(', '))
