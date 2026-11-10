package alu.aiplayer.nav;

import java.util.List;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.MathHelper;

import alu.aiplayer.act.Digger;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.act.Placer;
import alu.aiplayer.act.Reach;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.nav.PathSearch.Step;

/**
 * Walks a path by pressing movement keys, so the body moves under ordinary player physics. Before each step it
 * looks at the world as it is now and digs away whatever blocks the way, if allowed; when a step does not work out
 * within its time it reports BLOCKED and the navigator plans again from wherever the bot ended up.
 */
public final class PathFollower {

    public enum Status {
        MOVING,
        ARRIVED,
        /** The path no longer works; plan again. */
        BLOCKED,
        /** Planning again will not help; see failCode. */
        FAILED
    }

    private final Bot bot;
    private final List<Step> steps;
    private final int ox, oy, oz;
    private final NavWorld.BreakRule rule;
    private final Digger digger;
    private int index;
    private int stepTicks;
    private int pushTicks;
    private int stepsDone;

    public String failCode;
    public String failMessage;
    public String failBlock;

    public PathFollower(Bot bot, List<Step> steps, int ox, int oy, int oz, NavWorld.BreakRule rule) {
        this.bot = bot;
        this.steps = steps;
        this.ox = ox;
        this.oy = oy;
        this.oz = oz;
        this.rule = rule;
        this.digger = new Digger(bot);
    }

    public int stepsDone() {
        return stepsDone;
    }

    public void stop() {
        digger.abort();
    }

    public Status tick() {
        if (index >= steps.size()) return Status.ARRIVED;
        EntityPlayerMP p = bot.player();
        Step s = steps.get(index);
        int px = index == 0 ? ox : steps.get(index - 1).x;
        int py = index == 0 ? oy : steps.get(index - 1).y;
        int pz = index == 0 ? oz : steps.get(index - 1).z;

        if (digger.busy()) {
            if (p.isInWater()) bot.motion.jump = true;
            Digger.Status ds = digger.tick();
            if (ds == Digger.Status.FAILED) {
                failCode = digger.failCode;
                failMessage = digger.failMessage;
                failBlock = digger.failBlock;
                return "no_tool".equals(failCode) ? Status.FAILED : Status.BLOCKED;
            }
            return Status.MOVING;
        }

        if (arrived(p, s)) {
            index++;
            stepsDone++;
            stepTicks = 0;
            pushTicks = 0;
            return index >= steps.size() ? Status.ARRIVED : Status.MOVING;
        }
        if (++stepTicks > limit(s)) return Status.BLOCKED;

        NavWorld nav = new NavWorld(p, rule);
        int[] blocked = firstBlocked(nav, s, px, py, pz);
        if (blocked != null) {
            if (blocked.length == 0 || nav.breakCost(blocked[0], blocked[1], blocked[2]) < 0) return Status.BLOCKED;
            if (s.move == PathSearch.DIG_DOWN && !centered(p, px, pz, 0.18)) {
                bot.motion.moveToward(p, px + 0.5, pz + 0.5);
                return Status.MOVING;
            }
            if (!Reach.canReach(p, blocked[0], blocked[1], blocked[2])) return Status.BLOCKED;
            digger.begin(blocked[0], blocked[1], blocked[2]);
            stepTicks = 0;
            return Status.MOVING;
        }

        if (p.isInWater()) bot.motion.jump = true;
        switch (s.move) {
            case PathSearch.ASCEND:
                bot.motion.moveToward(p, s.x + 0.5, s.z + 0.5);
                if ((p.onGround || p.isInWater()) && s.y - p.posY > 0.6) bot.motion.jump = true;
                break;
            case PathSearch.PILLAR:
                return pillar(p, s);
            case PathSearch.DIG_DOWN:
                // The floor is gone; gravity does the rest.
                if (!centered(p, s.x, s.z, 0.25)) bot.motion.moveToward(p, s.x + 0.5, s.z + 0.5);
                break;
            default:
                bot.motion.moveToward(p, s.x + 0.5, s.z + 0.5);
                // Pushing against something low the planner did not model (a rim, a snow drift): hop over it.
                if (p.isCollidedHorizontally && p.onGround) {
                    if (++pushTicks > 4) bot.motion.jump = true;
                } else {
                    pushTicks = 0;
                }
                break;
        }
        return Status.MOVING;
    }

    private Status pillar(EntityPlayerMP p, Step s) {
        int cellY = s.y - 1; // the cell the feet are leaving, where the block goes
        if (!centered(p, s.x, s.z, 0.2) && p.onGround) {
            bot.motion.moveToward(p, s.x + 0.5, s.z + 0.5);
            return Status.MOVING;
        }
        if (!Placer.isReplaceable(p.worldObj, s.x, cellY, s.z)) {
            // Already placed; just land on it.
            return Status.MOVING;
        }
        if (p.onGround) {
            bot.motion.jump = true;
            return Status.MOVING;
        }
        if (p.posY > s.y + 0.02) {
            ItemFilter scaffold = Rules.scaffold(p);
            if (scaffold == null) {
                failCode = "no_material";
                failMessage = "no filler blocks left to climb with";
                return Status.FAILED;
            }
            Placer.Result r = Placer.place(bot, s.x, cellY, s.z, scaffold);
            if (r != Placer.Result.PLACED && r != Placer.Result.IN_THE_WAY) return Status.BLOCKED;
        }
        return Status.MOVING;
    }

    /**
     * The first cell that has to be opened for this step and is not. An empty array means something is in the way
     * that digging cannot fix.
     */
    private int[] firstBlocked(NavWorld nav, Step s, int px, int py, int pz) {
        switch (s.move) {
            case PathSearch.TRAVERSE:
                if (!nav.passable(s.x, s.y + 1, s.z)) return new int[] { s.x, s.y + 1, s.z };
                if (nav.cls(s.x, s.y, s.z) == NavWorld.SLAB) return null;
                if (!nav.passable(s.x, s.y, s.z)) return new int[] { s.x, s.y, s.z };
                return null;
            case PathSearch.ASCEND:
                if (!nav.passable(px, py + 2, pz)) return new int[] { px, py + 2, pz };
                if (!nav.passable(s.x, s.y + 1, s.z)) return new int[] { s.x, s.y + 1, s.z };
                if (nav.cls(s.x, s.y, s.z) == NavWorld.SLAB) return null;
                if (!nav.passable(s.x, s.y, s.z)) return new int[] { s.x, s.y, s.z };
                return null;
            case PathSearch.DESCEND:
                if (!nav.passable(s.x, py + 1, s.z)) return new int[] { s.x, py + 1, s.z };
                if (!nav.passable(s.x, py, s.z)) return new int[] { s.x, py, s.z };
                for (int y = py - 1; y > s.y; y--) {
                    if (!nav.passable(s.x, y, s.z)) return new int[0];
                }
                if (nav.cls(s.x, s.y, s.z) != NavWorld.SLAB && !nav.passable(s.x, s.y, s.z)) return new int[0];
                return null;
            case PathSearch.PILLAR:
                if (!nav.passable(s.x, s.y + 1, s.z)) return new int[] { s.x, s.y + 1, s.z };
                return null;
            case PathSearch.DIG_DOWN:
                if (!nav.passable(s.x, s.y, s.z)) return new int[] { s.x, s.y, s.z };
                return null;
            default:
                return null;
        }
    }

    private boolean arrived(EntityPlayerMP p, Step s) {
        if (!(p.onGround || p.isInWater())) return false;
        if (MathHelper.floor_double(p.posX) != s.x || MathHelper.floor_double(p.posZ) != s.z) return false;
        if (Math.abs(p.posY - s.y) > 0.75) return false;
        return !needsCentering() || centered(p, s.x, s.z, 0.3);
    }

    /** Whether the bot should settle in the middle of this step's cell before going on. */
    private boolean needsCentering() {
        if (index + 1 >= steps.size()) return true;
        Step s = steps.get(index);
        Step next = steps.get(index + 1);
        if (next.move == PathSearch.PILLAR || next.move == PathSearch.DIG_DOWN) return true;
        if (s.move == PathSearch.PILLAR || s.move == PathSearch.DIG_DOWN) return false;
        int px = index == 0 ? ox : steps.get(index - 1).x;
        int pz = index == 0 ? oz : steps.get(index - 1).z;
        // Keep walking through cells that lie on a straight line.
        return next.x - s.x != s.x - px || next.z - s.z != s.z - pz;
    }

    private static boolean centered(EntityPlayerMP p, int x, int z, double tolerance) {
        double dx = p.posX - (x + 0.5), dz = p.posZ - (z + 0.5);
        return dx * dx + dz * dz <= tolerance * tolerance;
    }

    private static int limit(Step s) {
        switch (s.move) {
            case PathSearch.DESCEND:
                return 80;
            case PathSearch.PILLAR:
                return 70;
            default:
                return 50;
        }
    }
}
