package alu.aiplayer.task;

import java.util.List;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.act.Inventories;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.util.J;

/** Walks to a container and takes the listed items out. */
public final class WithdrawTask extends Task {

    private final int[] at;
    private final alu.aiplayer.act.ItemFilter bag;
    private final boolean fromInputs;
    private final List<ItemFilter> items;
    private ContainerTrip trip;

    public WithdrawTask(JsonObject params) {
        super("withdraw", params);
        bag = Params.carried(params, "container");
        at = bag != null ? null : Params.pos(params, "container");
        items = Inventories.filters(J.array(params, "items"));
        if (items.isEmpty()) throw new IllegalArgumentException("items must list what to take");
        fromInputs = J.bool(params, "fromInputs", false);
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
            trip = new ContainerTrip(bot, at[0], at[1], at[2]);
        }
        trip.session.withdraw(items);
        // At a machine a plain withdrawal takes products. A mould or shape left in its input slots is taken out
        // the same way a player does it, by reaching into those slots, when the caller says so.
        if (fromInputs) trip.session.fromInputSlots();
    }

    @Override
    public void tick() {
        if (trip == null) return;
        ContainerTrip.Status st = trip.tick();
        progressDone = trip.session.moved;
        if (st == ContainerTrip.Status.FAILED) fail(trip.failCode, trip.failMessage);
        else if (st == ContainerTrip.Status.DONE) {
            if (trip.session.inventoryFull) fail("inventory_full", "the bot's inventory filled up");
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
        JsonArray missing = new JsonArray();
        for (int i = 0; i < items.size(); i++) {
            int n = trip.session.withdrawMissing(i);
            if (n <= 0) continue;
            JsonObject m = items.get(i)
                .toJson();
            m.addProperty("count", n);
            missing.add(m);
        }
        // What the container did not have enough of.
        if (missing.size() > 0) o.add("missing", missing);
        return o;
    }
}
