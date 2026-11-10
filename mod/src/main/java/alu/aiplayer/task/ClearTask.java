package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.world.World;

import com.google.gson.JsonObject;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.nav.Goal;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.util.J;

/**
 * Digs out everything in a box, one layer at a time from the top, so nothing is ever dug from underneath and the
 * bot always has the layer below to stand on. Also the first half of flattening.
 */
public class ClearTask extends AreaTask {

    static final int MAX_VOLUME = 32768;

    protected int x1, y1, z1, x2, y2, z2;
    private int stage;
    private int layerY;
    private List<int[]> layer = new ArrayList<>();
    private int[] current;
    private int removedAtSweep;
    private int pass = 1;
    private final List<int[]> retry = new ArrayList<>();
    private boolean layerAbandoned;
    private int unreachable;

    public ClearTask(JsonObject params) {
        this("clear", params);
        setBox(
            J.reqCoord(params, "x1"),
            J.reqHeight(params, "y1"),
            J.reqCoord(params, "z1"),
            J.reqCoord(params, "x2"),
            J.reqHeight(params, "y2"),
            J.reqCoord(params, "z2"));
        long volume = ((long) x2 - x1 + 1) * ((long) y2 - y1 + 1) * ((long) z2 - z1 + 1);
        if (volume > MAX_VOLUME) {
            throw new IllegalArgumentException("the box holds " + volume + " cells; the limit is " + MAX_VOLUME);
        }
    }

    protected ClearTask(String type, JsonObject params) {
        super(type, params);
    }

    protected final void setBox(int ax, int ay, int az, int bx, int by, int bz) {
        x1 = Math.min(ax, bx);
        x2 = Math.max(ax, bx);
        y1 = Math.max(0, Math.min(ay, by));
        y2 = Math.min(255, Math.max(ay, by));
        z1 = Math.min(az, bz);
        z2 = Math.max(az, bz);
        rule = Rules.within(x1, y1, z1, x2, y2, z2);
        layerY = y2;
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        if (!withinTravel((x1 + x2) / 2, (z1 + z2) / 2)) return;
        phase = "going to the area";
        nav.go(Goal.column((x1 + x2) / 2, (z1 + z2) / 2, approachRange()), Rules.NATURAL_ONLY);
    }

    /** Close enough that the whole area is loaded and the first target is a short walk. */
    private int approachRange() {
        return Math.max(4, Math.max(x2 - x1, z2 - z1) / 2 + 6);
    }

    @Override
    public void tick() {
        if (busyWithErrand()) return;
        switch (stage) {
            case 0:
                if (approach()) {
                    stage = 1;
                    beginClearing();
                }
                break;
            case 1: {
                int r = clearTick();
                if (r > 0) {
                    stage = 2;
                    sweep(x1, y1, z1, x2, y2, z2);
                }
                break;
            }
            default:
                afterClearing();
                break;
        }
    }

    /** Returns true once the bot is at the area. Fails the task if it cannot get near. */
    protected boolean approach() {
        // The bot may ignore height here: it only has to be near enough for the chunks to be loaded.
        int dx = bot.blockX() - (x1 + x2) / 2, dz = bot.blockZ() - (z1 + z2) / 2;
        int r = approachRange();
        if (dx * dx + dz * dz <= r * r) {
            nav.stop();
            return true;
        }
        Navigator.Status st = nav.tick();
        if (st == Navigator.Status.FAILED) {
            fail(nav.failCode, "cannot get to the area: " + nav.failMessage);
            return false;
        }
        if (st == Navigator.Status.ARRIVED) return true;
        return false;
    }

    protected void beginClearing() {
        phase = "clearing";
        World w = bot.player().worldObj;
        int total = 0;
        for (int x = x1; x <= x2; x++) {
            for (int z = z1; z <= z2; z++) {
                if (!w.blockExists(x, 64, z)) continue;
                for (int y = y1; y <= y2; y++) {
                    Block b = w.getBlock(x, y, z);
                    if (!b.isAir(w, x, y, z) && untouchable(w, x, y, z, b) == null) total++;
                }
            }
        }
        progressTotal += total;
    }

    /** One tick of clearing. Returns 1 when the box is clear, 0 while working, -1 if the task failed. */
    protected int clearTick() {
        if (current != null) {
            Act a = digCell(current[0], current[1], current[2]);
            if (a == Act.BUSY) return 0;
            if (a == Act.FAILED) return -1;
            if (a == Act.UNREACHABLE) outOfReach(current);
            progressDone = removed + placed;
            current = null;
        }
        if (inventoryFull()) {
            if (!relieveInventory(keepOnDropoff())) return -1;
            if (!overflow.equals("leave") || !dropoff.isEmpty()) return 0;
        }
        // Skip through empty layers quickly, a few per tick.
        for (int i = 0; i < 8 && layer.isEmpty(); i++) {
            if (!layerAbandoned) layer = cellsToDig(x1, layerY, z1, x2, z2);
            if (!layer.isEmpty()) break;
            // Empty right after a scan: the layer is done, or was given up on.
            layerAbandoned = false;
            if (--layerY < y1) {
                if (pass == 1 && !retry.isEmpty()) {
                    // What could not be reached the first time may be reachable now that the bot carries blocks
                    // to climb with. One more pass over the layers that had such cells.
                    pass = 2;
                    for (int[] c : retry) gaveUp.remove(key(c[0], c[1], c[2]));
                    retry.clear();
                    layerY = y2;
                    return 0;
                }
                if (removed == 0 && unreachable > 0) {
                    fail("unreachable", "could not get within reach of any block in the area");
                    return -1;
                }
                return 1;
            }
            if (removed - removedAtSweep >= 48) {
                // Gather what has been dug loose before it despawns or gets buried.
                removedAtSweep = removed;
                sweep(x1, layerY, z1, x2, y2, z2);
                return 0;
            }
        }
        if (layer.isEmpty()) return 0;
        note = "layer y=" + layerY;
        current = takeNearest(layer, false);
        return 0;
    }

    /**
     * A cell could not be reached. The rest of its layer is most likely just as far away (a treetop, a ledge), so
     * instead of searching for a way to each cell the whole layer is set aside: foliage for good, anything else
     * until the second pass.
     */
    private void outOfReach(int[] cell) {
        World w = bot.player().worldObj;
        layer.add(cell);
        for (int[] c : layer) {
            if (isFoliage(w, c[0], c[1], c[2])) {
                skip(c[0], c[1], c[2], "foliage out of reach");
            } else if (pass == 1) {
                gaveUp.add(key(c[0], c[1], c[2]));
                retry.add(c);
            } else {
                unreachable++;
                skip(c[0], c[1], c[2], "unreachable");
            }
        }
        layer.clear();
        layerAbandoned = true;
    }

    /** Item ids a drop-off trip should leave with the bot (in limited amount) because the task needs them. */
    protected java.util.Set<String> keepOnDropoff() {
        return null;
    }

    protected void afterClearing() {
        if (!dropoff.isEmpty() && removed > 0 && stage == 2) {
            stage = 3;
            startDropoff(null, null);
            return;
        }
        done();
    }

    @Override
    protected JsonObject summary() {
        JsonObject o = super.summary();
        o.addProperty("clearedDownTo", Math.max(y1, layerY + 1));
        return o;
    }
}
