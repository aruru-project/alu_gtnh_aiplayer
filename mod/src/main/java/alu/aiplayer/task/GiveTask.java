package alu.aiplayer.task;

import java.util.List;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.MathHelper;

import com.google.gson.JsonObject;

import alu.aiplayer.act.Inventories;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.Motion;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.util.J;

/** Walks up to a player and tosses items to them. */
public final class GiveTask extends MoveTask {

    private final String player;
    private final List<ItemFilter> items;
    private int gx, gy, gz;
    private int dropped;
    private static final int TIME_LIMIT = 20 * 60 * 5;
    private int ticks;

    public GiveTask(JsonObject params) {
        super("give", params);
        player = J.reqStr(params, "player");
        items = Inventories.filters(J.array(params, "items"));
        if (items.isEmpty()) throw new IllegalArgumentException("items must list what to hand over");
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        phase = "walking";
        aim();
    }

    private boolean aim() {
        EntityPlayerMP target = findPlayer(player);
        if (target == null || target.dimension != bot.player().dimension) {
            fail("unreachable", player + " is not here");
            return false;
        }
        gx = MathHelper.floor_double(target.posX);
        gy = MathHelper.floor_double(target.posY + 0.01);
        gz = MathHelper.floor_double(target.posZ);
        walkTo(gx, gy, gz, 2);
        return true;
    }

    @Override
    public void tick() {
        EntityPlayerMP target = findPlayer(player);
        if (target == null || target.dimension != bot.player().dimension) {
            fail("unreachable", player + " is not here");
            return;
        }
        double dx = target.posX - (gx + 0.5), dy = target.posY - gy, dz = target.posZ - (gz + 0.5);
        if (dx * dx + dy * dy + dz * dz > 9.0 && !nav.planning() && !aim()) return;
        if (++ticks > TIME_LIMIT) {
            fail("stuck", "could not catch up with " + player);
            return;
        }
        Navigator.Status st = nav.tick();
        if (st == Navigator.Status.FAILED) {
            failNav();
        } else if (st == Navigator.Status.ARRIVED) {
            Motion.face(bot.player(), target.posX, target.posY + 1.0, target.posZ);
            dropped = Inventories.drop(bot, items);
            if (dropped == 0) fail("no_material", "the bot carries none of those items");
            else done();
        }
    }

    /** Its summary is its own (what it dropped): what the walk did is added the way other tasks get it. */
    @Override
    protected boolean reportsTerrain() {
        return false;
    }

    @Override
    protected JsonObject summary() {
        JsonObject o = new JsonObject();
        o.addProperty("dropped", dropped);
        return o;
    }
}
