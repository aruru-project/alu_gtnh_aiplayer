package alu.aiplayer.task;

import com.google.gson.JsonObject;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.util.J;

/** Walks to within a range of a block position. */
public final class GotoTask extends MoveTask {

    private final int x, y, z, range;

    public GotoTask(JsonObject params) {
        super("goto", params);
        x = J.reqInt(params, "x");
        y = J.reqInt(params, "y");
        z = J.reqInt(params, "z");
        range = Math.max(0, Math.min(32, J.i(params, "range", 1)));
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        if (J.has(params, "dim") && J.i(params, "dim", 0) != bot.player().dimension) {
            fail("unreachable", "the destination is in another dimension");
            return;
        }
        phase = "walking";
        walkTo(x, y, z, range);
    }

    @Override
    public void tick() {
        Navigator.Status st = nav.tick();
        if (st == Navigator.Status.ARRIVED) done();
        else if (st == Navigator.Status.FAILED) failNav();
    }
}
