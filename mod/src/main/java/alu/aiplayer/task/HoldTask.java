package alu.aiplayer.task;

import java.util.HashMap;
import java.util.Map;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraftforge.fluids.FluidTank;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.act.Machines;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.ModClients;
import alu.aiplayer.util.J;

/**
 * Keys held down for a while, as a player holds them: jump (space), sneak (Shift), and forward towards a point,
 * turning to face it on the way. Nothing more: no path is planned and nothing is dug or put down, so the bot goes
 * straight into whatever is there. What holding them does depends on the world and on what the bot wears: on foot,
 * jump hops and sneak crouches; with a flying pack on, jump climbs and sneak sinks, as that mod has it.
 * <p>
 * It ends after its ticks, or sooner when the feet reach a given height, or a given height above the ground (from
 * below or from above; 0 is touching down), or when the bot is within range of the point it heads for. The result
 * says where the bot is then, how high above the ground, how it moves, the way it went, and what the tanks of what
 * it wears held before and hold now.
 */
public final class HoldTask extends Task {

    private static final int MOST_TICKS = 20 * 60;
    /** At most about this many points of the way are kept for the result. */
    private static final int TRACK_POINTS = 30;

    private final int ticks;
    private final boolean jump, sneak;
    /** The block column to head for; null holds no forward key. */
    private final int[] toward;
    private final double range;
    /** The height of the feet that ends the hold; NaN for none. */
    private final double untilY;
    /** The height above the ground that ends the hold; NaN for none. */
    private final double untilAbove;

    private int held;
    private String stopped;
    private double fromX, fromY, fromZ, fromAbove, lowest, highest;
    private int every;
    private final JsonArray track = new JsonArray();
    private int tracked = -1;
    /** What each tank of the worn things held at the start, by "slot#index". */
    private final Map<String, Integer> tanksBefore = new HashMap<>();

    public HoldTask(JsonObject params) {
        super("hold", params);
        ticks = J.i(params, "ticks", 0);
        if (ticks < 1 || ticks > MOST_TICKS) {
            throw new IllegalArgumentException("ticks is how long to hold the keys: 1 to " + MOST_TICKS + " (20 make a second)");
        }
        jump = J.bool(params, "jump", false);
        sneak = J.bool(params, "sneak", false);
        JsonObject t = J.object(params, "toward");
        toward = t == null ? null : new int[] { J.reqCoord(t, "x"), J.reqCoord(t, "z") };
        range = Math.max(0.1, Math.min(32, J.d(params, "range", 1.0)));
        if (J.has(params, "y")) {
            untilY = J.d(params, "y", 0);
            if (untilY < -64 || untilY > 512) throw new IllegalArgumentException("y is a height of the feet, such as 74.5");
        } else {
            untilY = Double.NaN;
        }
        if (J.has(params, "above")) {
            untilAbove = J.d(params, "above", 0);
            if (untilAbove < 0 || untilAbove > 256) throw new IllegalArgumentException("above is a height above the ground, 0 (touching down) to 256");
        } else {
            untilAbove = Double.NaN;
        }
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        if (toward != null && !withinTravel(toward[0], toward[1])) return;
        EntityPlayerMP p = bot.player();
        fromX = p.posX;
        fromY = p.posY;
        fromZ = p.posZ;
        lowest = highest = p.posY;
        fromAbove = Bot.aboveGround(p);
        every = Math.max(1, (ticks + TRACK_POINTS - 1) / TRACK_POINTS);
        for (Map.Entry<String, FluidTank> e : ModClients.wornTanks(p)
            .entrySet()) tanksBefore.put(e.getKey(), e.getValue()
                .getFluidAmount());
        phase = "holding " + keys();
        progressTotal = ticks;
    }

    private String keys() {
        StringBuilder sb = new StringBuilder();
        if (jump) sb.append("jump ");
        if (sneak) sb.append("sneak ");
        if (toward != null) sb.append("forward ");
        return sb.length() == 0 ? "nothing" : sb.toString()
            .trim();
    }

    @Override
    public void tick() {
        EntityPlayerMP p = bot.player();
        lowest = Math.min(lowest, p.posY);
        highest = Math.max(highest, p.posY);
        if (held % every == 0) point(p);
        note = "y " + J.round(p.posY);
        if (!Double.isNaN(untilY) && (fromY < untilY ? p.posY >= untilY : p.posY <= untilY)) {
            stop("y");
            return;
        }
        double above = Double.isNaN(untilAbove) || fromAbove < 0 ? -1 : Bot.aboveGround(p);
        if (above >= 0 && (fromAbove < untilAbove ? above >= untilAbove : above <= untilAbove)) {
            stop("above");
            return;
        }
        if (toward != null && flat(p) <= range) {
            stop("arrived");
            return;
        }
        if (held >= ticks) {
            stop("ticks");
            return;
        }
        bot.motion.jump = jump;
        bot.motion.sneak = sneak;
        if (toward != null) bot.motion.moveToward(p, toward[0] + 0.5, toward[1] + 0.5);
        held++;
        progressDone = held;
    }

    private void stop(String why) {
        stopped = why;
        point(bot.player());
        done();
    }

    private double flat(EntityPlayerMP p) {
        double dx = toward[0] + 0.5 - p.posX, dz = toward[1] + 0.5 - p.posZ;
        return Math.sqrt(dx * dx + dz * dz);
    }

    /** One point of the way: after how many ticks, where, how high above the ground. */
    private void point(EntityPlayerMP p) {
        if (tracked == held) return;
        tracked = held;
        JsonObject o = J.pos(p.posX, p.posY, p.posZ);
        o.addProperty("t", held);
        double above = Bot.aboveGround(p);
        if (above >= 0) o.addProperty("above", J.round(above));
        track.add(o);
    }

    @Override
    protected JsonObject summary() {
        JsonObject o = new JsonObject();
        if (bot == null || !bot.online() || every == 0) return o;
        EntityPlayerMP p = bot.player();
        o.addProperty("held", held);
        if (stopped != null) o.addProperty("stopped", stopped);
        o.add("from", J.pos(fromX, fromY, fromZ));
        o.add("pos", J.pos(p.posX, p.posY, p.posZ));
        o.add("block", J.pos(bot.blockX(), bot.blockY(), bot.blockZ()));
        o.addProperty("onGround", p.onGround);
        double above = Bot.aboveGround(p);
        if (above >= 0) o.addProperty("aboveGround", J.round(above));
        o.add("motion", Bot.moved(p));
        o.addProperty("lowest", J.round(lowest));
        o.addProperty("highest", J.round(highest));
        if (toward != null) o.addProperty("distance", J.round(flat(p)));
        o.add("track", track);
        JsonArray tanks = new JsonArray();
        for (Map.Entry<String, FluidTank> e : ModClients.wornTanks(p)
            .entrySet()) {
            FluidTank t = e.getValue();
            JsonObject j = Machines.tank(t.getFluid(), t.getCapacity());
            String key = e.getKey();
            j.addProperty("slot", key.substring(0, key.indexOf('#')));
            if (tanksBefore.containsKey(key)) j.addProperty("was", tanksBefore.get(key));
            tanks.add(j);
        }
        if (tanks.size() > 0) o.add("tanks", tanks);
        return o;
    }
}
