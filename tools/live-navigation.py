#!/usr/bin/env python3
"""Real body navigation/placement regression on THIS checkout's isolated testserver only.
Uses normal task/interaction entry points. RCON only arranges the test arena/inventory.
python3 tools/live-navigation.py --out /tmp/navigation.json [--expect-fixed]
Overwrites an unclaimed fixture at x=1918..1929,y=200..210,z=80..86 in the test world.
Fixture coordinates below are local to x=-480; the transport adds 2400 to x.
"""
import argparse
import json
import os
import time
from bridge import Bridge, ROOT, _local_env
from rcon import run

ap = argparse.ArgumentParser()
ap.add_argument('--out', required=True)
ap.add_argument('--expect-fixed', action='store_true')
a = ap.parse_args()
b = Bridge()
BOT = 'NavQA'
password = open(os.path.join(ROOT, 'testserver/.rcon-password')).read().strip()
port = int(_local_env('AIPLAYER_TEST_RCON_PORT'))
assert port == 25607, 'This fixture is authorized only for the navigation worker sandbox'
report = {}

def shifted(value):
    if isinstance(value, list): return [shifted(v) for v in value]
    if isinstance(value, dict): return {k: v+2400 if k == 'x' and isinstance(v,(int,float)) else shifted(v) for k,v in value.items()}
    return value

def rc(cmd):
    parts = cmd.split(' ')
    index = 1 if parts[0] == 'setblock' else 2 if parts[0] in ['tp','summon'] else None
    if index is not None: parts[index] = str(float(parts[index])+2400).removesuffix('.0')
    return run('127.0.0.1', port, password, ' '.join(parts))

def call(method, **params):
    return b.call(method, shifted({'bot': BOT, **params}))

def task(spec, seconds=15):
    start = time.monotonic()
    opened = call('task.start', task=spec)
    try:
        result = b.wait_task(BOT, seconds)
    except TimeoutError:
        result = call('task.list')['active']
        call('task.cancel')
    return {'elapsed': time.monotonic()-start, 'task': result, 'status': call('bot.status')}

try:
    try: call('bot.status')
    except RuntimeError: call('bot.spawn', name=BOT,x=-477.5,y=201,z=83.5)
    if not call('bot.status')['online']: call('bot.spawn', name=BOT,x=-477.5,y=201,z=83.5)
    call('task.cancel')
    # Re-running a previous hover trial: safely turn the worn pack off before teleporting.
    if call('bot.status').get('worn'):
        call('bot.key', key='keys.adventureBackpack.openInventory')
        call('screen.press', key='unequip')
        time.sleep(.4)
    rc('clear '+BOT)
    rc('cofh killall item')
    rc(f'tp {BOT} -477.5 211 83.5')
    time.sleep(1)
    for x in range(-480,-473):
        for z in range(80,87):
            rc(f'setblock {x} 200 {z} minecraft:stone 0 replace')
    for x,y,z in [(-478,201,80),(-478,201,82),(-478,201,83),(-479,201,84),(-480,201,84),(-480,202,84),(-478,206,82),(-478,207,82)]:
        rc(f'setblock {x} {y} {z} minecraft:air 0 replace')
    rc(f'tp {BOT} -477.5 201 83.5')
    time.sleep(.5)
    rc(f'give {BOT} minecraft:dirt 10')
    time.sleep(.5)
    rc('setblock -478 201 80 minecraft:stone 0 replace')
    report['occupied'] = task({'type':'place','blocks':[{'x':-478,'y':201,'z':80,'item':'minecraft:dirt','meta':0}], 'dig':False,'climb':False,'maxDrop':3})
    rc('setblock -478 201 80 minecraft:dirt 0 replace')
    report['matching'] = task({'type':'place','blocks':[{'x':-478,'y':201,'z':80,'item':'minecraft:dirt','meta':0}], 'dig':False,'climb':False,'maxDrop':3})
    # Own body in an empty target is not OCCUPIED; the normal placer should move aside and place.
    report['self_cell'] = task({'type':'place','blocks':[{'x':-478,'y':201,'z':83,'item':'minecraft:dirt','meta':0}], 'dig':False,'climb':False,'maxDrop':3})
    rc('setblock -478 201 83 minecraft:air 0 replace')
    # OpenBlocks scaffolding: two ordinary colliding blocks versus a legitimate adjacent one-block step.
    rc('setblock -480 201 84 OpenBlocks:scaffolding 0 replace')
    rc('setblock -480 202 84 OpenBlocks:scaffolding 0 replace')
    rc(f'tp {BOT} -479.5 201 83.5')
    report['scaffold_two_high'] = task({'type':'goto','x':-480,'y':203,'z':84,'range':0,'yRange':0,'climb':False})
    rc('setblock -479 201 84 minecraft:stone 0 replace')
    report['scaffold_with_step'] = task({'type':'goto','x':-480,'y':203,'z':84,'range':0,'yRange':0,'climb':False})
    rc(f'tp {BOT} -477.5 201 83.5')
    rc('clear '+BOT)
    for _ in range(36): rc(f'give {BOT} minecraft:stone 64')
    time.sleep(1)
    rc('summon Item -475.5 201.2 83.5 {Item:{id:337s,Count:4b,Damage:0s},Motion:[0.0d,0.0d,0.0d]}')
    report['full_inventory'] = task({'type':'collect','x':-477,'y':201,'z':83,'radius':5,'dig':False,'climb':False,'maxDrop':3})
    rc('clear '+BOT)
    rc('cofh killall item')
    rc('setblock -478 207 82 minecraft:stone 0 replace')
    rc(f'give {BOT} adventurebackpack:copterPack 1 0 {{wearableData:{{fuelTank:{{FluidName:"fuel",Amount:16000}},status:0}}}}')
    time.sleep(.7)
    call('screen.open', item={'id':'adventurebackpack:copterPack'})
    call('screen.press', key='equip')
    call('bot.key', key='keys.adventureBackpack.toggleActions', sneak=True)
    call('bot.key', key='keys.adventureBackpack.toggleActions')
    rc(f'tp {BOT} -480.5 205 82.5')
    time.sleep(.6)
    report['hover_before'] = call('bot.status')
    report['hover_reachable'] = task({'type':'use','on':{'x':-478,'y':207,'z':82},'side':'west'},8)
    report['hover_unreachable'] = task({'type':'use','on':{'x':-478,'y':200,'z':82},'side':'down'},8)
    report['current_hidden'] = task({'type':'use','on':{'x':-478,'y':207,'z':82},'side':'east','approach':'current'},8)
    rc(f'tp {BOT} -477.5 201 83.5')
    call('bot.key', key='keys.adventureBackpack.toggleActions', sneak=True)
    # Construction travel permissions: a dirt barrier in a closed stone corridor. The target is out of reach.
    rc('clear '+BOT)
    rc(f'give {BOT} minecraft:glass 4')
    for x in range(-482,-470):
        for z in range(80,83):
            for y in range(200,204):
                edge = z in [80,82] or y in [200,203] or x in [-482,-471]
                rc(f'setblock {x} {y} {z} minecraft:{"stone" if edge else "air"} 0 replace')
    for y in [201,202]: rc(f'setblock -478 {y} 81 minecraft:dirt 0 replace')
    rc(f'tp {BOT} -480.5 201 81.5')
    time.sleep(.5)
    placement = {'type':'place','blocks':[{'x':-473,'y':201,'z':81,'item':'minecraft:glass','meta':0}], 'dig':False,'climb':False,'maxDrop':0}
    report['construction_no_dig'] = task(placement,20)
    report['barrier_after_no_dig'] = [call('world.block',x=-478,y=y,z=81) for y in [201,202]]
    report['construction_allow_dig'] = task({**placement,'dig':True},20)
    for y in [201,202]: rc(f'setblock -478 {y} 81 minecraft:dirt 0 replace')
    rc(f'tp {BOT} -480.5 201 81.5')
    report['requested_dig_still_works'] = task({'type':'dig','blocks':[{'x':-478,'y':201,'z':81},{'x':-478,'y':202,'z':81}],'dig':False,'climb':False,'maxDrop':0},20)
    rc('setblock -480 210 85 minecraft:stone 0 replace')
    rc(f'tp {BOT} -479.5 211 85.5')
    time.sleep(.5)
    descent = {'type':'goto','x':-477,'y':201,'z':85,'range':0,'yRange':0,'dig':False,'climb':False,'maxDrop':3}
    report['drop_limited'] = task(descent,15)
    report['drop_allowed'] = task({**descent,'maxDrop':12},15)
    if a.expect_fixed:
        assert report['occupied']['task']['result']['skipped'], report['occupied']
        assert report['matching']['task']['result']['alreadyMatches'] == 1, report['matching']
        assert report['self_cell']['task']['result']['placed'] == 1, report['self_cell']
        assert report['full_inventory']['task']['error']['code'] == 'inventory_full', report['full_inventory']
        assert report['hover_reachable']['task']['state'] == 'done', report['hover_reachable']
        assert report['hover_unreachable']['task']['state'] == 'failed', report['hover_unreachable']
        assert 'airborne' in report['hover_unreachable']['task']['error']['message'], report['hover_unreachable']
        assert report['current_hidden']['task']['state'] == 'failed', report['current_hidden']
        assert report['current_hidden']['elapsed'] < 2, report['current_hidden']
        assert report['construction_no_dig']['task']['result']['placed'] == 0, report['construction_no_dig']
        assert all(c['id'] == 'minecraft:dirt' for c in report['barrier_after_no_dig'])
        assert report['construction_allow_dig']['task']['result']['placed'] == 1, report['construction_allow_dig']
        assert report['requested_dig_still_works']['task']['result']['removed'] == 2, report['requested_dig_still_works']
        assert report['drop_limited']['task']['state'] == 'failed', report['drop_limited']
        assert report['drop_limited']['status']['pos']['y'] >= 210, report['drop_limited']
        assert report['drop_allowed']['task']['state'] == 'done', report['drop_allowed']
finally:
    call('task.cancel')
    with open(a.out,'w') as f: json.dump(report,f,ensure_ascii=False,indent=2)
    print(a.out)
