package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.world.World;

import com.google.gson.JsonObject;

import alu.aiplayer.act.Digger;
import alu.aiplayer.act.Reach;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.nav.Goal;
import alu.aiplayer.nav.NavWorld;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.nav.TerrainLog;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/**
 * Walks to within a range of a block position. Given a height, the feet must end up within {@code yRange} of it,
 * and a destination where nothing can be stood fails at once instead of being searched for.
 */
public final class GotoTask extends MoveTask {

    private final int x, z, range;
    /** Null means "wherever the ground is at x, z". */
    private final Integer y;
    private final int yRange;
    /** Whether to take down, on arrival, the climbing blocks of this walk that can be reached from there. */
    private final boolean takeBack;

    private List<TerrainLog.Cell> toTakeBack;
    private int notReachedToTakeBack;
    private TerrainLog.Cell takingBack;
    private Digger digger;

    public GotoTask(JsonObject params) {
        super("goto", params);
        x = J.reqCoord(params, "x");
        y = J.has(params, "y") ? J.reqHeight(params, "y") : null;
        z = J.reqCoord(params, "z");
        range = Math.max(0, Math.min(32, J.i(params, "range", 1)));
        yRange = J.has(params, "yRange") ? Math.max(0, Math.min(32, J.i(params, "yRange", 0)))
            : Goal.defaultHeightSlack(range);
        takeBack = J.bool(params, "takeBack", false);
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        if (J.has(params, "dim") && J.i(params, "dim", 0) != bot.player().dimension) {
            fail("unreachable", "the destination is in another dimension");
            return;
        }
        if (!withinTravel(x, z)) return;
        phase = "walking";
        if (y == null) {
            nav.go(Goal.column(x, z, range), Rules.NATURAL_ONLY, climb);
            return;
        }
        JsonObject noFooting = noFooting(bot.player());
        if (noFooting != null) {
            fail("unreachable", noFooting.remove("message").getAsString(), noFooting);
            return;
        }
        nav.go(Goal.near(x, y, z, range, yRange), Rules.NATURAL_ONLY, climb);
    }

    @Override
    public void tick() {
        if (toTakeBack != null) {
            if (takingBackTick()) return;
            done();
            return;
        }
        Navigator.Status st = nav.tick();
        if (st == Navigator.Status.ARRIVED) {
            if (takeBack) beginTakingBack();
            else done();
        } else if (st == Navigator.Status.FAILED) {
            failNav();
        }
    }

    // ---- footing ----------------------------------------------------------------------------------------------

    /**
     * When no cell the goal accepts can hold a standing player as the world is now (and could not be made to by
     * what this walk may do: dig natural blocks out of the way, stack climbing blocks if allowed), a description of
     * the destination cell saying why; null otherwise. Unloaded cells count as possible.
     */
    private JsonObject noFooting(EntityPlayerMP p) {
        NavWorld nav = new NavWorld(p, Rules.NATURAL_ONLY, false, bot.scaffoldCells(), bot.shutDoors());
        for (int dy = -yRange; dy <= yRange; dy++) {
            int cy = y + dy;
            if (cy < 1 || cy > 254) continue;
            for (int dx = -range; dx <= range; dx++) {
                for (int dz = -range; dz <= range; dz++) {
                    if (dx * dx + dz * dz > range * range) continue;
                    if (footing(nav, x + dx, cy, z + dz)) return null;
                }
            }
        }
        World w = p.worldObj;
        JsonObject o = J.pos(x, y, z);
        o.add("feet", WorldCell.describe(w, x, y, z));
        o.add("head", WorldCell.describe(w, x, y + 1, z));
        o.add("below", WorldCell.describe(w, x, y - 1, z));
        String why = whyNot(nav, x, y, z);
        String around = range > 0 || yRange > 0
            ? "; no other cell within " + range + " horizontally and " + yRange + " in height has footing either"
            : "";
        o.addProperty("message", "nothing to stand on at the destination: " + why + around);
        return o;
    }

    private boolean footing(NavWorld nav, int cx, int cy, int cz) {
        byte feet = nav.cls(cx, cy, cz), head = nav.cls(cx, cy + 1, cz), below = nav.cls(cx, cy - 1, cz);
        if (feet == NavWorld.UNLOADED || head == NavWorld.UNLOADED || below == NavWorld.UNLOADED) return true;
        if (!enterable(nav, feet, cx, cy, cz) || !enterable(nav, head, cx, cy + 1, cz)) return false;
        if (head == NavWorld.SLAB) return false;
        if (feet == NavWorld.SLAB || feet == NavWorld.WATER) return true;
        if (below == NavWorld.SOLID) return true;
        // Nothing under it yet: only stacking a block there would make it a place to stand.
        return climb && (below == NavWorld.OPEN || below == NavWorld.WATER);
    }

    /** Whether the bot can be in this cell: it is open, a door, a half block to stand on, or can be dug out. */
    private static boolean enterable(NavWorld nav, byte c, int cx, int cy, int cz) {
        if (c == NavWorld.OPEN || c == NavWorld.WATER || c == NavWorld.CLIMB || c == NavWorld.DOOR || c == NavWorld.SLAB) {
            return true;
        }
        if (c == NavWorld.HAZARD) return false;
        return nav.breakCost(cx, cy, cz) >= 0;
    }

    private String whyNot(NavWorld nav, int cx, int cy, int cz) {
        World w = bot.player().worldObj;
        byte feet = nav.cls(cx, cy, cz), head = nav.cls(cx, cy + 1, cz), below = nav.cls(cx, cy - 1, cz);
        if (!enterable(nav, feet, cx, cy, cz)) {
            return "(" + cx + "," + cy + "," + cz + ") itself is " + WorldCell.name(w, cx, cy, cz) + ", which a walk does not dig";
        }
        if (!enterable(nav, head, cx, cy + 1, cz) || head == NavWorld.SLAB) {
            return "the cell above it, (" + cx + "," + (cy + 1) + "," + cz + "), is " + WorldCell.name(w, cx, cy + 1, cz)
                + ", so there is no head room";
        }
        if (feet == NavWorld.CLIMB) {
            return "(" + cx + "," + cy + "," + cz + ") is " + WorldCell.name(w, cx, cy, cz)
                + ", which the bot can only hang on there: (" + cx + "," + (cy - 1) + "," + cz + ") under it is "
                + WorldCell.name(w, cx, cy - 1, cz);
        }
        return "(" + cx + "," + (cy - 1) + "," + cz + ") under it is " + WorldCell.name(w, cx, cy - 1, cz)
            + (below == NavWorld.OPEN || below == NavWorld.WATER ? ", nothing to stand on" + (climb ? "" : " (climb is off)")
                : ", which cannot be stood on");
    }

    // ---- taking back the climbing blocks ------------------------------------------------------------------------

    private void beginTakingBack() {
        EntityPlayerMP p = bot.player();
        World w = p.worldObj;
        toTakeBack = new ArrayList<>();
        for (TerrainLog.Cell c : nav.changes()
            .stillStanding(w)) {
            // Not what the bot stands on.
            if (c.y == bot.blockY() - 1 && Math.abs(c.x + 0.5 - p.posX) < 0.8 && Math.abs(c.z + 0.5 - p.posZ) < 0.8) {
                notReachedToTakeBack++;
                continue;
            }
            toTakeBack.add(c);
        }
        // Highest first, as a pillar is taken down.
        toTakeBack.sort((a, b) -> Integer.compare(b.y, a.y));
        digger = new Digger(bot);
        phase = "taking back climbing blocks";
    }

    /** Takes the next block down; false once there are none left to try. */
    private boolean takingBackTick() {
        EntityPlayerMP p = bot.player();
        if (digger.busy()) {
            digger.tick();
            if (digger.busy()) return true;
            if (digger.failCode != null) notReachedToTakeBack++;
            else bot.terrain()
                .takenDown(takingBack.x, takingBack.y, takingBack.z, null, 0);
        }
        while (!toTakeBack.isEmpty()) {
            TerrainLog.Cell c = toTakeBack.remove(0);
            if (!TerrainLog.standing(p.worldObj, c)) continue;
            if (!Reach.canReach(p, c.x, c.y, c.z)) {
                notReachedToTakeBack++;
                continue;
            }
            takingBack = c;
            digger.begin(c.x, c.y, c.z);
            return true;
        }
        return false;
    }

    @Override
    public void cleanup() {
        super.cleanup();
        if (digger != null) digger.abort();
    }

    @Override
    protected JsonObject summary() {
        JsonObject o = super.summary();
        if (o == null || y == null) return o;
        // How far the feet are from the height asked for: above it is positive.
        o.addProperty("dy", bot.blockY() - y);
        if (toTakeBack != null && notReachedToTakeBack > 0) {
            o.addProperty("notTakenBack", notReachedToTakeBack);
        }
        return o;
    }

    /** Names of what is in a cell, for messages. */
    private static final class WorldCell {

        static String name(World w, int cx, int cy, int cz) {
            if (!w.blockExists(cx, cy, cz)) return "not loaded";
            return Names.blockId(w.getBlock(cx, cy, cz)) + "/" + w.getBlockMetadata(cx, cy, cz);
        }

        static JsonObject describe(World w, int cx, int cy, int cz) {
            JsonObject o = new JsonObject();
            if (!w.blockExists(cx, cy, cz)) {
                o.addProperty("loaded", false);
                return o;
            }
            o.addProperty("id", Names.blockId(w.getBlock(cx, cy, cz)));
            int meta = w.getBlockMetadata(cx, cy, cz);
            if (meta != 0) o.addProperty("meta", meta);
            return o;
        }
    }
}
