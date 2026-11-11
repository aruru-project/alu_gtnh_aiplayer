package alu.aiplayer.task;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import net.minecraft.item.ItemStack;

import com.google.gson.JsonObject;

import alu.aiplayer.act.ContainerSession;
import alu.aiplayer.act.Inventories;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/** Walks to a container and puts items in: the listed ones, or everything but tools, food and what to keep. */
public final class DepositTask extends Task {

    private final int[] at;
    private final alu.aiplayer.act.ItemFilter bag;
    private final List<ItemFilter> items;
    private final Set<String> keep;
    private ContainerTrip trip;

    public DepositTask(JsonObject params) {
        super("deposit", params);
        bag = Params.carried(params, "container");
        at = bag != null ? null : Params.pos(params, "container");
        items = Inventories.filters(J.array(params, "items"));
        keep = new HashSet<>(Params.strings(params, "keep"));
        if (bag != null && items.isEmpty()) throw new IllegalArgumentException("items must list what goes into the bag");
    }

    /** Everything a bot does not need on its person. */
    static ContainerSession.DepositPlan everythingBut(final Set<String> keep) {
        return new ContainerSession.DepositPlan() {

            @Override
            public int wanted(ItemStack stack) {
                if (Inventories.isTool(stack) || Inventories.isFood(stack)) return 0;
                if (keep.contains(Names.itemId(stack.getItem()))) return 0;
                return -1;
            }

            @Override
            public void moved(ItemStack type, int count) {}

            @Override
            public boolean wholeKind(ItemStack type, int carried) {
                return wanted(type) < 0;
            }
        };
    }

    /** The listed items, each up to its count. */
    static ContainerSession.DepositPlan listed(final List<ItemFilter> items) {
        final int[] left = new int[items.size()];
        for (int i = 0; i < left.length; i++) left[i] = items.get(i).count;
        return new ContainerSession.DepositPlan() {

            private int index(ItemStack stack) {
                for (int i = 0; i < left.length; i++) {
                    if (left[i] != 0 && items.get(i)
                        .matches(stack)) return i;
                }
                return -1;
            }

            @Override
            public int wanted(ItemStack stack) {
                int i = index(stack);
                if (i < 0) return 0;
                return left[i] < 0 ? -1 : Math.min(left[i], stack.stackSize);
            }

            @Override
            public void moved(ItemStack type, int count) {
                int i = index(type);
                if (i >= 0 && left[i] > 0) left[i] = Math.max(0, left[i] - count);
            }

            @Override
            public boolean wholeKind(ItemStack type, int carried) {
                int i = index(type);
                return i >= 0 && (left[i] < 0 || left[i] >= carried);
            }
        };
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        if (bag != null) {
            phase = "opening the bag";
            trip = new ContainerTrip(bot, bag);
        } else {
            if (!withinTravel(at[0], at[2])) return;
            phase = "going to the container";
            int[] face = Params.face(params, "container");
            trip = face[0] >= 0 || face[1] == 1 ? new ContainerTrip(bot, at[0], at[1], at[2], face[0], face[1] == 1)
                : new ContainerTrip(bot, at[0], at[1], at[2]);
        }
        trip.session.deposit(items.isEmpty() ? everythingBut(keep) : listed(items));
    }

    @Override
    public void tick() {
        if (trip == null) return;
        ContainerTrip.Status st = trip.tick();
        progressDone = trip.session.moved;
        if (st == ContainerTrip.Status.FAILED) fail(trip.failCode, trip.failMessage);
        else if (st == ContainerTrip.Status.DONE) {
            if (trip.session.containerFull) fail("container_full", "not everything fit into the container");
            else done();
        }
    }

    @Override
    public void cleanup() {
        if (trip != null) trip.stop();
    }

    @Override
    protected JsonObject summary() {
        if (trip == null) return null;
        JsonObject o = new JsonObject();
        o.addProperty("moved", trip.session.moved);
        if (bot != null && bot.online()) o.addProperty("freeSlots", Inventories.freeSlots(bot.player()));
        return o;
    }
}
