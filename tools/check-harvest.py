#!/usr/bin/env python3
"""Live regression for f33, on tools/local.env's TEST server only.

Usage: python3 tools/check-harvest.py --site -700 230 174
Requires an empty 5x5 platform site. Makes and removes its own bot/fixture; never uses a real model.
Checks a live probe's shearing capability and normal left-click shearing, without asking getDrops to
predict or reroll anything. A source rule (BOP foliage/3's ordinary getDrops) is documented separately;
this test does not infer probabilities by repeating a random drop.
"""
import argparse
import json
import time

from scenario import Builder, Session


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', type=int, nargs=3, required=True, metavar=('X', 'Y', 'Z'))
    args = parser.parse_args()
    x, y, z = args.site
    assert 2 <= y <= 252
    bot = 'HarvestProbe'
    s, rcon = Session(), Builder()
    created = False
    changed = []
    try:
        assert not any(b['name'] == bot for b in s.call('bot.list')['bots']), 'test bot already exists'
        s.call('bot.spawn', {'name': bot, 'dim': 0, 'x': x + .5, 'y': y, 'z': z + .5})
        created = True
        s.call('bot.configure', {'bot': bot, 'settings': {'invulnerable': True, 'hunger': False}})
        box = s.call('world.blocks', {'dim': 0, 'x1': x - 2, 'y1': y - 1, 'z1': z - 2,
                                     'x2': x + 2, 'y2': y + 2, 'z2': z + 2})
        assert not box.get('unloaded') and all(p['id'] == 'minecraft:air' for p in box['palette']), 'site not empty'
        for dx in range(-2, 3):
            for dz in range(-2, 3):
                changed.append((x + dx, y - 1, z + dz))
                rcon.put(x + dx, y - 1, z + dz, 'minecraft:grass')
        rcon.cmd(f'tp {bot} {x + .5} {y} {z + .5}')
        rcon.cmd(f'clear {bot}')
        rcon.cmd(f'give {bot} minecraft:shears 1')
        deadline = time.time() + 8
        while time.time() < deadline:
            if any(i['id'] == 'minecraft:shears' for i in s.call('bot.status', {'bot': bot})['inventory']):
                break
            time.sleep(.2)
        else:
            raise AssertionError('shears not picked up')

        def run(task):
            task_id = s.call('task.start', {'bot': bot, 'task': task})['task']['id']
            deadline = time.time() + 30
            while time.time() < deadline:
                for ended in s.call('task.list', {'bot': bot})['recent']:
                    if ended['id'] == task_id:
                        assert ended['state'] == 'done', ended
                        return ended
                time.sleep(.1)
            raise AssertionError('task did not finish')

        for block, meta in [('BiomesOPlenty:foliage', 3), ('minecraft:leaves', 0)]:
            at = {'x': x + 1, 'y': y, 'z': z}
            changed.append((x + 1, y, z))
            rcon.put(x + 1, y, z, block, meta)
            before = s.call('bot.status', {'bot': bot})['inventory']
            probe = s.call('bot.probe', {'bot': bot, **at})
            assert probe.get('shearing') == {'item': 'minecraft:shears', 'shearable': True}, probe
            after = s.call('world.block', {'dim': 0, **at})
            assert (after['id'], after['meta']) == (block, meta), 'probe changed block'
            assert s.call('bot.status', {'bot': bot})['inventory'] == before, 'probe changed inventory'
            if block == 'BiomesOPlenty:foliage':
                ordinary = run({'type': 'dig', 'blocks': [at]})
                assert ordinary['result']['removed'] == 1, ordinary
                rcon.cmd(f'tp {bot} {x + 1.5} {y} {z + .5}')
                time.sleep(2)
                inventory = s.call('bot.status', {'bot': bot})['inventory']
                assert not any(i['id'] == block and i.get('meta', 0) == meta for i in inventory), inventory
                print('Ordinary flax digging broke it but did not return the flax plant (random seeds are not asserted).')
                rcon.cmd(f'tp {bot} {x + .5} {y} {z + .5}')
                rcon.put(x + 1, y, z, block, meta)
            result = run({'type': 'use', 'on': at, 'left': True, 'item': {'id': 'minecraft:shears'}})
            assert s.call('world.block', {'dim': 0, **at})['id'] == 'minecraft:air', result
            rcon.cmd(f'tp {bot} {x + 1.5} {y} {z + .5}')
            deadline = time.time() + 5
            while time.time() < deadline:
                inventory = s.call('bot.status', {'bot': bot})['inventory']
                if any(i['id'] == block and i.get('meta', 0) == meta for i in inventory):
                    break
                time.sleep(.2)
            else:
                raise AssertionError(f'no sheared {block}/{meta} in inventory: {inventory}')
            print(json.dumps({'block': block, 'meta': meta, 'probe': probe['shearing'],
                              'afterClick': result['result'], 'pickedUp': True}, ensure_ascii=False))
            rcon.cmd(f'tp {bot} {x + .5} {y} {z + .5}')
        print('PASS: probe is read-only; flax and leaves can be sheared through normal use(left)')
    finally:
        if created:
            s.call('task.cancel', {'bot': bot})
            s.call('bot.despawn', {'bot': bot})
            s.call('bot.remove', {'bot': bot})
        for xx, yy, zz in reversed(changed):
            rcon.put(xx, yy, zz, 'minecraft:air')
        rcon.close()


if __name__ == '__main__':
    main()
