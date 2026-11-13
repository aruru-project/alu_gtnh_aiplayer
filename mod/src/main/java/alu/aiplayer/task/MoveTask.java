package alu.aiplayer.task;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;

import com.google.gson.JsonObject;

import alu.aiplayer.nav.Goal;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.util.J;

/** Base for tasks that are mostly about walking somewhere. */
abstract class MoveTask extends Task {

    protected Navigator nav;

    MoveTask(String type, JsonObject params) {
        super(type, params);
    }

    @Override
    public void start(alu.aiplayer.bot.Bot bot) {
        super.start(bot);
        nav = new Navigator(bot);
    }

    @Override
    public void cleanup() {
        if (nav != null) nav.stop();
    }

    protected void walkTo(int x, int y, int z, int range) {
        nav.go(Goal.near(x, y, z, range), Rules.NATURAL_ONLY);
    }

    /** Fails the task with the navigator's reason. */
    protected void failNav() {
        JsonObject detail = null;
        if (nav.failBlock != null) {
            detail = new JsonObject();
            detail.addProperty("block", nav.failBlock);
        }
        fail(nav.failCode, nav.failMessage, detail);
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
