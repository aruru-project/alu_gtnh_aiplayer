package alu.aiplayer.task;

import java.util.List;

import com.google.gson.JsonObject;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.util.J;

/** Runs /home and waits for the teleport to land. */
public final class HomeTask extends Task {

    private static final int TIMEOUT = 20 * 15;

    private final String name;
    private int teleportsBefore;
    private int ticks;
    private List<String> output;

    public HomeTask(JsonObject params) {
        super("home", params);
        name = J.reqStr(params, "name");
        if (!name.matches("[^\\s/]{1,32}")) throw new IllegalArgumentException("bad home name");
    }

    @Override
    public boolean dimensionBound() {
        return false;
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        teleportsBefore = bot.conn()
            .teleportCount();
        phase = "teleporting";
        try {
            output = bot.runCommand("home " + name);
        } catch (alu.aiplayer.bridge.RpcException e) {
            output = java.util.Collections.emptyList();
            fail("denied", e.getMessage());
        }
    }

    @Override
    public void tick() {
        boolean teleported = bot.conn()
            .teleportCount() > teleportsBefore;
        if (teleported) {
            if (!bot.conn()
                .teleportPending()) done();
            return;
        }
        // No teleport after a moment: whatever the server said was the refusal.
        if (++ticks >= 40 && !output.isEmpty()) {
            fail("invalid", String.join(" / ", output));
        } else if (ticks > TIMEOUT) {
            fail("invalid", "the server did not teleport the bot to home '" + name + "'");
        }
    }

    @Override
    protected JsonObject summary() {
        if (bot == null || !bot.online()) return null;
        JsonObject o = new JsonObject();
        o.addProperty("dim", bot.player().dimension);
        o.add("block", J.pos(bot.blockX(), bot.blockY(), bot.blockZ()));
        return o;
    }
}
