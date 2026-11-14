package alu.aiplayer.task;

import net.minecraft.util.AxisAlignedBB;

import com.google.gson.JsonObject;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.util.J;

/** Picks up items lying on the ground around a point. */
public final class CollectTask extends Task {

    private final int x, y, z, radius;
    private final boolean dig, climb;
    private final int maxDrop;
    private Collector collector;

    public CollectTask(JsonObject params) {
        super("collect", params);
        x = J.reqCoord(params, "x");
        y = J.reqHeight(params, "y");
        z = J.reqCoord(params, "z");
        radius = Math.max(1, Math.min(32, J.i(params, "radius", 8)));
        dig = J.bool(params, "dig", true);
        climb = J.bool(params, "climb", true);
        maxDrop = J.has(params, "maxDrop") ? J.i(params, "maxDrop", 3) : -1;
        if (J.has(params, "maxDrop") && (maxDrop < 0 || maxDrop > 40)) throw new IllegalArgumentException("maxDrop must be 0..40");
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        if (!withinTravel(x, z)) return;
        phase = "collecting";
        AxisAlignedBB box = AxisAlignedBB
            .getBoundingBox(x - radius, y - radius, z - radius, x + radius + 1, y + radius + 1, z + radius + 1);
        collector = new Collector(bot, box, dig ? Rules.NATURAL_ONLY : Rules.NO_BREAK, 20 * 60 * 5, climb);
        if (maxDrop >= 0) collector.maxDrop(maxDrop);
    }

    @Override
    public void tick() {
        if (collector == null) return;
        boolean more = collector.tick();
        progressDone = collector.picked;
        if (!more) {
            if (collector.failCode != null) fail(collector.failCode, collector.failMessage);
            else done();
        }
    }

    @Override
    public void cleanup() {
        if (collector != null) collector.stop();
    }

    @Override
    protected JsonObject summary() {
        JsonObject o = new JsonObject();
        o.addProperty("pickedUpStacks", collector == null ? 0 : collector.picked);
        if (collector != null) {
            com.google.gson.JsonArray remaining = collector.remaining();
            if (remaining.size() > 0) o.add("remaining", remaining);
            if (collector.disappeared > 0) o.addProperty("disappearedTargets", collector.disappeared);
        }
        return o;
    }
}
