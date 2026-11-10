package alu.aiplayer.task;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.MathHelper;

import com.google.gson.JsonObject;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.util.J;

/** Walks up to a player, re-aiming as the player moves. */
public final class GotoPlayerTask extends MoveTask {

    private final String player;
    private final int range;
    private int gx, gy, gz;

    public GotoPlayerTask(JsonObject params) {
        super("goto_player", params);
        player = J.reqStr(params, "player");
        range = Math.max(1, Math.min(16, J.i(params, "range", 2)));
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        phase = "walking";
        aim();
    }

    private boolean aim() {
        EntityPlayerMP target = findPlayer(player);
        if (target == null) {
            fail("unreachable", "player is not online: " + player);
            return false;
        }
        if (target.dimension != bot.player().dimension) {
            fail("unreachable", player + " is in another dimension");
            return false;
        }
        gx = MathHelper.floor_double(target.posX);
        gy = MathHelper.floor_double(target.posY + 0.01);
        gz = MathHelper.floor_double(target.posZ);
        walkTo(gx, gy, gz, range);
        return true;
    }

    @Override
    public void tick() {
        EntityPlayerMP target = findPlayer(player);
        if (target != null && target.dimension == bot.player().dimension) {
            double dx = target.posX - (gx + 0.5), dy = target.posY - gy, dz = target.posZ - (gz + 0.5);
            if (dx * dx + dy * dy + dz * dz > 9.0 && !aim()) return;
        }
        Navigator.Status st = nav.tick();
        if (st == Navigator.Status.ARRIVED) done();
        else if (st == Navigator.Status.FAILED) failNav();
    }
}
