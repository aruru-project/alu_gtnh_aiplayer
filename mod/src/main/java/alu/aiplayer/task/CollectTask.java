package alu.aiplayer.task;

import net.minecraft.util.AxisAlignedBB;

import com.google.gson.JsonObject;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.util.J;

/** Picks up items lying on the ground around a point. */
public final class CollectTask extends Task {

    private final int x, y, z, radius;
    private Collector collector;

    public CollectTask(JsonObject params) {
        super("collect", params);
        x = J.reqCoord(params, "x");
        y = J.reqHeight(params, "y");
        z = J.reqCoord(params, "z");
        radius = Math.max(1, Math.min(32, J.i(params, "radius", 8)));
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        if (!withinTravel(x, z)) return;
        phase = "collecting";
        AxisAlignedBB box = AxisAlignedBB
            .getBoundingBox(x - radius, y - radius, z - radius, x + radius + 1, y + radius + 1, z + radius + 1);
        collector = new Collector(bot, box, Rules.NATURAL_ONLY, 20 * 60 * 5);
    }

    @Override
    public void tick() {
        if (collector == null) return;
        boolean more = collector.tick();
        progressDone = collector.picked;
        if (!more) done();
    }

    @Override
    public void cleanup() {
        if (collector != null) collector.stop();
    }

    @Override
    protected JsonObject summary() {
        JsonObject o = new JsonObject();
        o.addProperty("pickedUpStacks", collector == null ? 0 : collector.picked);
        return o;
    }
}
