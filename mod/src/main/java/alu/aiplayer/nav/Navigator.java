package alu.aiplayer.nav;

import net.minecraft.entity.player.EntityPlayerMP;

import alu.aiplayer.bot.Bot;

/**
 * Gets a bot to a goal: plan, walk, and plan again whenever the walk is interrupted or the plan only went part of
 * the way. Tasks own one of these and call {@link #tick()} while they want the bot to travel.
 */
public final class Navigator {

    public enum Status {
        WORKING,
        ARRIVED,
        FAILED
    }

    private static final long SEARCH_BUDGET_NANOS = 2_500_000L;
    private static final int MAX_NODES = 16000;
    /** A search that may stack blocks to climb has far more to consider, and is only run when walking failed. */
    private static final int MAX_NODES_CLIMBING = 48000;
    /** Replans in a row that got nowhere before giving up. */
    private static final int MAX_FRUITLESS = 6;
    private static final int MAX_PLANS = 200;
    /**
     * How much closer (in the search's own measure: ticks of walking, about 4.7 a block) a path that digs or stacks
     * blocks must bring the bot when it does not reach the goal. Changing the terrain only to end up a little nearer
     * is how a bot that could not find the door dug down beside it and tunnelled under the house.
     */
    private static final double MIN_PROGRESS_CHANGING_TERRAIN = 8 * Goal.WALK;

    private final Bot bot;
    private Goal goal;
    private NavWorld.BreakRule rule = Rules.NATURAL_ONLY;
    private PathSearch search;
    private PathFollower follower;
    private int fruitless;
    private int plans;
    private int airTicks;
    private boolean mayPillar = true;
    private boolean gentle = true;
    private boolean explainClimbing;
    /** A last search, with climbing blocks allowed, run only to say whether they would have helped. */
    private boolean probing;
    private final TerrainLog changes = new TerrainLog();

    /** unreachable, stuck, no_tool or no_material. */
    public String failCode;
    public String failMessage;
    public String failBlock;
    /**
     * After an unreachable failure with climbing blocks not allowed and {@link #explainClimbing} asked for: how many
     * climbing blocks a way that uses them would take, or 0 when there is no such way either. -1 when not known.
     */
    public int climbingBlocksWouldTake = -1;

    public Navigator(Bot bot) {
        this.bot = bot;
    }

    /** Sets a new destination and forgets the old one. */
    public void go(Goal goal, NavWorld.BreakRule rule) {
        go(goal, rule, true);
    }

    /**
     * @param mayPillar whether the bot may stack filler blocks under itself to climb. Off for errands that carry
     *                  cargo, which would otherwise get used up as scaffolding.
     */
    public void go(Goal goal, NavWorld.BreakRule rule, boolean mayPillar) {
        stop();
        this.mayPillar = mayPillar;
        this.gentle = true;
        this.probing = false;
        this.goal = goal;
        this.rule = rule == null ? Rules.NATURAL_ONLY : rule;
        fruitless = 0;
        plans = 0;
        failCode = null;
        failMessage = null;
        failBlock = null;
        climbingBlocksWouldTake = -1;
    }

    /**
     * With climbing blocks not allowed, finding no way ends with one more search that may use them, so that the
     * failure can say whether they would have got the bot there.
     */
    public void explainClimbing(boolean on) {
        explainClimbing = on;
    }

    /** The blocks this navigator has put down to climb on and dug out of the way, since it was made. */
    public TerrainLog changes() {
        return changes;
    }

    public boolean active() {
        return goal != null;
    }

    /** True while a route is being worked out; a new destination now would throw that work away. */
    public boolean planning() {
        return search != null;
    }

    public void stop() {
        if (follower != null) follower.stop();
        follower = null;
        search = null;
        goal = null;
    }

    public Status tick() {
        if (goal == null) return Status.ARRIVED;
        EntityPlayerMP p = bot.player();

        if (follower != null) {
            PathFollower.Status st = follower.tick();
            if (st == PathFollower.Status.MOVING) return Status.WORKING;
            int made = follower.stepsDone();
            PathFollower done = follower;
            follower = null;
            if (st == PathFollower.Status.FAILED) {
                return fail(done.failCode, done.failMessage, done.failBlock);
            }
            if (st == PathFollower.Status.BLOCKED) {
                fruitless = made >= 2 ? 0 : fruitless + 1;
                if (fruitless > MAX_FRUITLESS) {
                    return fail("stuck", "kept getting blocked on the way", done.failBlock);
                }
            } else {
                fruitless = 0;
            }
        }

        if (search == null) {
            if (goal.reached(bot.blockX(), bot.blockY(), bot.blockZ()) && (p.onGround || p.isInWater())) {
                goal = null;
                return Status.ARRIVED;
            }
            // Plan from solid footing (or from a ladder, which holds the bot where it is); a search started in
            // mid-air would begin from a cell the bot is leaving.
            if (!(p.onGround || p.isInWater() || p.isOnLadder()) && ++airTicks < 60) return Status.WORKING;
            airTicks = 0;
            if (++plans > MAX_PLANS) return fail("stuck", "could not get there after many attempts", null);
            // First look for a way that leaves the terrain as it is. Digging through and stacking blocks to climb
            // are the fallback, for when walking there is impossible.
            search = new PathSearch(
                new NavWorld(p, rule, gentle, bot.scaffoldCells(), bot.shutDoors()),
                bot.blockX(),
                bot.blockY(),
                bot.blockZ(),
                goal,
                probing || (!gentle && mayPillar && Rules.scaffold(p) != null),
                gentle ? MAX_NODES : MAX_NODES_CLIMBING,
                bot.invulnerable ? PathSearch.FEARLESS_DROP : PathSearch.SAFE_DROP);
        }

        PathSearch.Status st = search.step(budget());
        if (st == PathSearch.Status.RUNNING) return Status.WORKING;
        PathSearch finished = search;
        search = null;
        if (probing) {
            probing = false;
            int pillars = 0;
            if (st == PathSearch.Status.FOUND) {
                for (PathSearch.Step s : finished.path()) if (s.move == PathSearch.PILLAR) pillars++;
            }
            climbingBlocksWouldTake = pillars;
            if (pillars > 0) {
                return fail(
                    "unreachable",
                    "no way to get there without stacking blocks to climb on; a way that stacks " + pillars
                        + " exists",
                    null);
            }
            return fail("unreachable", "no way to get there", null);
        }
        boolean changesTerrain = !gentle;
        if (st == PathSearch.Status.PARTIAL && changesTerrain && finished.progress() < MIN_PROGRESS_CHANGING_TERRAIN) {
            // Only part of the way, and that part digs or climbs: not worth altering anything for.
            st = PathSearch.Status.NONE;
        }
        if (st == PathSearch.Status.NONE) {
            if (gentle) {
                gentle = false;
                return Status.WORKING;
            }
            if (explainClimbing && !mayPillar) {
                probing = true;
                return Status.WORKING;
            }
            return fail("unreachable", "no way to get there", null);
        }
        follower = new PathFollower(
            bot,
            finished.path(),
            bot.blockX(),
            bot.blockY(),
            bot.blockZ(),
            rule,
            gentle,
            changes);
        gentle = true;
        return Status.WORKING;
    }

    /** Planning time for this tick: the normal slice, or a fraction of it while the server is behind. */
    private static long budget() {
        long[] times = net.minecraft.server.MinecraftServer.getServer().tickTimeArray;
        long sum = 0;
        for (long t : times) sum += t;
        long mean = sum / times.length;
        return mean > 45_000_000L ? SEARCH_BUDGET_NANOS / 5 : SEARCH_BUDGET_NANOS;
    }

    private Status fail(String code, String message, String block) {
        failCode = code;
        failMessage = message;
        failBlock = block;
        stop();
        return Status.FAILED;
    }
}
