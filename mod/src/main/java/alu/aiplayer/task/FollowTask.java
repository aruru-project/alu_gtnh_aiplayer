package alu.aiplayer.task;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.MathHelper;

import com.google.gson.JsonObject;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.util.J;

/** Stays near a player until canceled. Waits where it is while the player is away or out of walking range. */
public final class FollowTask extends MoveTask {

    private final String player;
    private final int distance;
    private int gx, gy, gz;
    private int retryIn;

    public FollowTask(JsonObject params) {
        super("follow", params);
        player = J.reqStr(params, "player");
        distance = Math.max(1, Math.min(16, J.i(params, "distance", 3)));
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        phase = "following";
    }

    @Override
    public void tick() {
        EntityPlayerMP me = bot.player();
        EntityPlayerMP target = findPlayer(player);
        if (target == null || target.dimension != me.dimension) {
            note = target == null ? "waiting: " + player + " is offline" : "waiting: " + player + " is in another dimension";
            nav.stop();
            return;
        }
        double dist = me.getDistanceToEntity(target);
        // Close enough only when standing: in the middle of a jump (to put a block under itself) the bot is nearer
        // someone above it than it will be on landing, and stopping there threw the climbing step away.
        if (dist <= distance + 0.5 && (me.onGround || me.isInWater() || !nav.active())) {
            note = "";
            nav.stop();
            bot.motion.lookAt(me, target.posX, target.posY + target.getEyeHeight(), target.posZ);
            return;
        }
        if (retryIn > 0) {
            retryIn--;
            return;
        }
        int tx = MathHelper.floor_double(target.posX);
        int ty = MathHelper.floor_double(target.posY + 0.01);
        int tz = MathHelper.floor_double(target.posZ);
        boolean moved = Math.abs(tx - gx) + Math.abs(ty - gy) + Math.abs(tz - gz) > 2;
        // A flying or falling player has no ground under them to path to; wait until they land.
        if ((!nav.active() || (moved && !nav.planning())) && (target.onGround || target.isInWater() || !nav.active())) {
            gx = tx;
            gy = ty;
            gz = tz;
            walkTo(gx, gy, gz, distance);
        }
        Navigator.Status st = nav.tick();
        if (st == Navigator.Status.FAILED) {
            note = "cannot reach " + player + " right now: " + navProblem();
            retryIn = 60;
        } else if (!nav.planning()) {
            // Said why it could not get there until a new way is found (or not).
            note = "";
        }
    }
}
