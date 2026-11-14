package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.world.World;

import com.google.gson.JsonObject;

import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.act.Placer;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.nav.Goal;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.util.J;

/**
 * Places one kind of block in the empty cells of a box, bottom layer first: the whole box, only its six faces, or
 * only its four walls. Each block goes against one already there, so floating shapes with nothing to start from
 * are reported as skipped rather than built.
 */
public final class FillTask extends AreaTask {

    private final int x1, y1, z1, x2, y2, z2;
    private final String shape;
    private ItemFilter item;
    /** The meta every block must come out with (which way stairs or logs face), or -1 for any. */
    private final int want;
    /** Whether the item's variant was left to the bot and is still to be chosen (with {@link #want}). */
    private boolean open;
    private int stage;
    private List<int[]> targets;
    private List<int[]> deferred = new ArrayList<>();
    private boolean progressSinceDeferral;
    private int[] current;
    private boolean noTargets;

    public FillTask(JsonObject params) {
        super("fill", params);
        int ax = J.reqCoord(params, "x1"), ay = J.reqHeight(params, "y1"), az = J.reqCoord(params, "z1");
        int bx = J.reqCoord(params, "x2"), by = J.reqHeight(params, "y2"), bz = J.reqCoord(params, "z2");
        x1 = Math.min(ax, bx);
        x2 = Math.max(ax, bx);
        y1 = Math.max(1, Math.min(ay, by));
        y2 = Math.min(254, Math.max(ay, by));
        z1 = Math.min(az, bz);
        z2 = Math.max(az, bz);
        long volume = ((long) x2 - x1 + 1) * ((long) y2 - y1 + 1) * ((long) z2 - z1 + 1);
        if (volume > ClearTask.MAX_VOLUME) {
            throw new IllegalArgumentException("the box holds " + volume + " cells; the limit is " + ClearTask.MAX_VOLUME);
        }
        shape = J.str(params, "shape", "solid");
        if (!shape.equals("solid") && !shape.equals("hollow") && !shape.equals("walls")) {
            throw new IllegalArgumentException("shape must be solid, hollow or walls");
        }
        item = new ItemFilter(J.reqStr(params, "item"), J.i(params, "meta", -1), -1);
        want = J.i(params, "blockMeta", -1);
        if (J.has(params, "blockMeta") && (want < 0 || want > 15)) throw new IllegalArgumentException("blockMeta is 0 to 15");
        open = want >= 0 && item.meta < 0;
    }

    private boolean inShape(int x, int y, int z) {
        boolean side = x == x1 || x == x2 || z == z1 || z == z2;
        switch (shape) {
            case "walls":
                return side;
            case "hollow":
                return side || y == y1 || y == y2;
            default:
                return true;
        }
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        if (!withinTravel((x1 + x2) / 2, (z1 + z2) / 2)) return;
        // Whatever the bot has to dig through on the way, it must not be the blocks this task puts down.
        rule = Rules.outside(x1, y1, z1, x2, y2, z2);
        phase = "going to the area";
        nav.go(Goal.column((x1 + x2) / 2, (z1 + z2) / 2, range()), rule);
    }

    private int range() {
        return Math.max(4, Math.max(x2 - x1, z2 - z1) / 2 + 6);
    }

    @Override
    public void tick() {
        if (busyWithErrand()) return;
        if (stage == 0) {
            int dx = bot.blockX() - (x1 + x2) / 2, dz = bot.blockZ() - (z1 + z2) / 2;
            if (dx * dx + dz * dz > range() * range()) {
                Navigator.Status st = nav.tick();
                if (st == Navigator.Status.FAILED) fail(nav.failCode, "cannot get to the area: " + nav.failMessage);
                if (st != Navigator.Status.ARRIVED) return;
            }
            nav.stop();
            targets = findTargets();
            progressTotal = targets.size();
            noTargets = targets.isEmpty();
            phase = "placing";
            stage = 1;
            return;
        }
        if (stage == 2) {
            if (!tidying() && !finished()) done();
            return;
        }
        if (current != null) {
            if (open) {
                open = false;
                if (!chooseVariant(current)) return;
            }
            Act a = placeCell(current[0], current[1], current[2], item, want);
            if (a == Act.BUSY || a == Act.FAILED) return;
            if (a == Act.NEED_MATERIAL) {
                int missing = targets.size() + deferred.size() + 1;
                JsonObject detail = new JsonObject();
                detail.add("item", item.toJson());
                detail.addProperty("missing", missing);
                List<ItemFilter> want = new ArrayList<>();
                want.add(new ItemFilter(item.id, item.meta, missing));
                startSupply(want, "out of " + item.label() + "; " + missing + " more needed", detail);
                return;
            }
            if (a == Act.UNREACHABLE) skip(current[0], current[1], current[2], why(current[0], current[1], current[2], "unreachable"));
            if (a == Act.OK) progressSinceDeferral = true;
            else if (!gaveUp.contains(key(current[0], current[1], current[2]))) deferred.add(current);
            progressDone = placed;
            current = null;
        }
        if (targets.isEmpty()) {
            if (!deferred.isEmpty() && progressSinceDeferral) {
                targets = deferred;
                deferred = new ArrayList<>();
                progressSinceDeferral = false;
            } else {
                for (int[] d : deferred) skip(d[0], d[1], d[2], why(d[0], d[1], d[2], "nothing to place against"));
                deferred.clear();
                stage = 2;
                return;
            }
        }
        current = takeNearest(targets, true);
    }

    /**
     * The blocks must come out as {@link #want} and the variant of the item was not given: the one whose clicks can
     * give that meta (judged at the first cell). False, the task failed, when no variant can.
     */
    private boolean chooseVariant(int[] cell) {
        net.minecraft.block.Block b = alu.aiplayer.act.Orientation.blockOf(item.item);
        if (b == null || alu.aiplayer.act.Orientation.rule(b) == alu.aiplayer.act.Orientation.Rule.UNKNOWN) return true;
        World w = bot.player().worldObj;
        int d = alu.aiplayer.act.Orientation.damageFor(w, cell[0], cell[1], cell[2], item.item, want);
        if (d < 0) {
            int plain;
            try {
                plain = alu.aiplayer.act.Orientation.placedMeta(item.item, 0);
            } catch (Throwable t) {
                plain = 0;
            }
            java.util.Set<Integer> can = alu.aiplayer.act.Orientation.allOutcomes(
                alu.aiplayer.act.Orientation.rule(b),
                alu.aiplayer.act.Orientation.ways(w, cell[0], cell[1], cell[2], b, plain));
            fail(
                "invalid",
                "no variant of " + item.id
                    + " can come out as /"
                    + want
                    + " ("
                    + item.id
                    + ":0 comes out as "
                    + alu.aiplayer.act.Orientation.metas(can)
                    + ")");
            return false;
        }
        item = new ItemFilter(item.id, d, -1);
        return true;
    }

    @Override
    protected boolean keepsBlock(int x, int y, int z) {
        return x >= x1 && x <= x2 && y >= y1 && y <= y2 && z >= z1 && z <= z2 && inShape(x, y, z);
    }

    @Override
    protected JsonObject summary() {
        JsonObject o = super.summary();
        if (noTargets) o.addProperty("placementNote", "no empty/replaceable cells in requested shape; existing blocks were left unchanged");
        return o;
    }

    private List<int[]> findTargets() {
        World w = bot.player().worldObj;
        List<int[]> out = new ArrayList<>();
        for (int y = y1; y <= y2; y++) {
            for (int x = x1; x <= x2; x++) {
                for (int z = z1; z <= z2; z++) {
                    if (!inShape(x, y, z) || !w.blockExists(x, y, z)) continue;
                    if (Placer.isReplaceable(w, x, y, z)) out.add(new int[] { x, y, z });
                }
            }
        }
        return out;
    }
}
