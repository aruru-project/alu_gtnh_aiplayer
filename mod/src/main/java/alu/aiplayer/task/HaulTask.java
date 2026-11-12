package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.item.ItemStack;

import com.google.gson.JsonObject;

import alu.aiplayer.act.ContainerSession;
import alu.aiplayer.act.Inventories;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/**
 * Carries items from one container to another, as many round trips as it takes. Only what was taken out on a trip
 * is put in at the other end, so the bot's own belongings stay with it.
 */
public final class HaulTask extends Task {

    private final int[] from, to;
    private final List<ItemFilter> items;
    private final int[] left;
    private ContainerTrip trip;
    private boolean delivering;
    private Map<String, Integer> before;
    private Map<String, Integer> carrying;
    private int delivered;
    private int rounds;

    public HaulTask(JsonObject params) {
        super("haul", params);
        from = Params.pos(params, "from");
        to = Params.pos(params, "to");
        items = Inventories.filters(J.array(params, "items"));
        left = new int[items.size()];
        for (int i = 0; i < left.length; i++) left[i] = items.get(i).count;
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        if (!withinTravel(from[0], from[2]) || !withinTravel(to[0], to[2])) return;
        fetch();
    }

    private void fetch() {
        rounds++;
        phase = "fetching";
        delivering = false;
        before = counts();
        trip = new ContainerTrip(bot, from[0], from[1], from[2]);
        if (items.isEmpty()) {
            trip.session.withdrawAll();
            return;
        }
        List<ItemFilter> want = new ArrayList<>();
        for (int i = 0; i < left.length; i++) {
            if (left[i] != 0) want.add(new ItemFilter(items.get(i).id, items.get(i).meta, left[i]));
        }
        trip.session.withdraw(want);
    }

    private Map<String, Integer> counts() {
        Map<String, Integer> m = new HashMap<>();
        for (ItemStack s : bot.player().inventory.mainInventory) {
            if (s == null) continue;
            m.merge(key(s), s.stackSize, Integer::sum);
        }
        return m;
    }

    private static String key(ItemStack s) {
        return Names.itemId(s.getItem()) + "@" + Names.meta(s);
    }

    @Override
    public void tick() {
        if (trip == null) return;
        ContainerTrip.Status st = trip.tick();
        if (st == ContainerTrip.Status.WORKING) return;
        if (st == ContainerTrip.Status.FAILED) {
            fail(trip);
            return;
        }
        if (!delivering) {
            carrying = new HashMap<>();
            for (Map.Entry<String, Integer> e : counts().entrySet()) {
                int gained = e.getValue() - before.getOrDefault(e.getKey(), 0);
                if (gained > 0) carrying.put(e.getKey(), gained);
            }
            if (carrying.isEmpty()) {
                // Nothing more to take. With a full inventory that is a problem; otherwise the job is finished.
                if (trip.session.inventoryFull && delivered == 0) {
                    fail("inventory_full", "the bot has no room to carry anything");
                } else {
                    done();
                }
                return;
            }
            phase = "delivering";
            delivering = true;
            trip = new ContainerTrip(bot, to[0], to[1], to[2]);
            trip.session.deposit(new ContainerSession.DepositPlan() {

                @Override
                public int wanted(ItemStack stack) {
                    Integer n = carrying.get(key(stack));
                    return n == null || n <= 0 ? 0 : Math.min(n, stack.stackSize);
                }

                @Override
                public void moved(ItemStack type, int count) {
                    carrying.merge(key(type), -count, Integer::sum);
                    delivered += count;
                    progressDone = delivered;
                    for (int i = 0; i < left.length; i++) {
                        if (left[i] > 0 && items.get(i)
                            .matches(type)) {
                            left[i] = Math.max(0, left[i] - count);
                            break;
                        }
                    }
                }
            });
            return;
        }
        if (trip.session.containerFull) {
            fail("container_full", "the destination container is full; the rest is still with the bot");
            return;
        }
        boolean more = items.isEmpty();
        for (int n : left) if (n != 0) more = true;
        if (more && rounds < 200) fetch();
        else done();
    }

    @Override
    public void cleanup() {
        if (trip != null) trip.stop();
    }

    @Override
    protected JsonObject summary() {
        JsonObject o = new JsonObject();
        o.addProperty("moved", delivered);
        o.addProperty("trips", Math.max(0, rounds - (delivering ? 0 : 1)));
        return o;
    }
}
