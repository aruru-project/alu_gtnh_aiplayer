package alu.aiplayer.task;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;

import com.google.gson.JsonObject;

import alu.aiplayer.AiPlayerMod;
import alu.aiplayer.nav.Goal;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.util.J;

/** Base for tasks that are mostly about walking somewhere. */
abstract class MoveTask extends Task {

    protected Navigator nav;
    /** Whether filler blocks may be stacked to climb on the way (the task's {@code climb}, true when not given). */
    protected final boolean climb;

    MoveTask(String type, JsonObject params) {
        super(type, params);
        climb = J.bool(params, "climb", true);
    }

    @Override
    public void start(alu.aiplayer.bot.Bot bot) {
        super.start(bot);
        nav = new Navigator(bot);
        // Not allowed to stack blocks, a walk that finds no way finds out whether stacking them would have done.
        nav.explainClimbing(!climb);
    }

    @Override
    public void cleanup() {
        if (nav != null) nav.stop();
    }

    protected void walkTo(int x, int y, int z, int range) {
        nav.go(Goal.near(x, y, z, range), Rules.NATURAL_ONLY, climb);
    }

    /** Why the navigator failed, in words: with climbing not allowed, whether stacking blocks would have done. */
    protected String navProblem() {
        if (nav.climbingBlocksWouldTake <= 0) return nav.failMessage;
        String carry = Rules.scaffold(bot.player()) == null
            ? "; the bot carries none of the blocks it climbs with (" + String.join(", ", AiPlayerMod.config().fillerBlocks)
                + ")"
            : "";
        return "no way there without stacking blocks to climb on; one that stacks " + nav.climbingBlocksWouldTake
            + " exists (climb: true allows stacking them)"
            + carry;
    }

    /** Fails the task with the navigator's reason. */
    protected void failNav() {
        JsonObject detail = null;
        if (nav.failBlock != null || nav.climbingBlocksWouldTake > 0) {
            detail = new JsonObject();
            if (nav.failBlock != null) detail.addProperty("block", nav.failBlock);
            if (nav.climbingBlocksWouldTake > 0) detail.addProperty("climbingBlocksWouldTake", nav.climbingBlocksWouldTake);
        }
        fail(nav.failCode, navProblem(), detail);
    }

    protected static EntityPlayerMP findPlayer(String name) {
        return MinecraftServer.getServer()
            .getConfigurationManager()
            .func_152612_a(name);
    }

    /** Where the bot is, and what the walk put down to climb on or dug out of the way. */
    @Override
    protected JsonObject summary() {
        if (bot == null || !bot.online()) return null;
        JsonObject o = new JsonObject();
        o.add("block", J.pos(bot.blockX(), bot.blockY(), bot.blockZ()));
        if (nav != null) nav.changes()
            .addTo(o, bot.player().worldObj);
        return o;
    }
}
