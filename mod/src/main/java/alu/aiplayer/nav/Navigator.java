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
    /** A single approach is bounded even if repeated partial or empty paths appear to succeed. */
    private static final int MAX_TICKS = 20 * 90;
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
    private int ticks;
    private int maxDrop = -1;
    private boolean interaction;
    private boolean currentOnly;
    private boolean allowDig = true;
    private boolean allowPillar = true;
    private boolean mayPillar = true;
    private boolean swim;
    private boolean gentle = true;
    private boolean explainClimbing;
    /** A last search, with climbing blocks allowed, run only to say whether they would have helped. */
    private boolean probing;

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
        go(goal, rule, mayPillar, false);
    }

    /** Swimming below the surface is opt-in; ordinary travel keeps its surface-only routes. */
    public void go(Goal goal, NavWorld.BreakRule rule, boolean mayPillar, boolean swim) {
        stop();
        this.swim = swim;
        this.mayPillar = mayPillar && allowPillar;
        this.gentle = true;
        this.probing = false;
        this.goal = goal;
        this.rule = !allowDig ? Rules.NO_BREAK : rule == null ? Rules.NATURAL_ONLY : rule;
        fruitless = 0;
        plans = 0;
        airTicks = 0;
        ticks = 0;
        failCode = null;
        failMessage = null;
        failBlock = null;
        climbingBlocksWouldTake = -1;
    }

    /** Permissions for all subsequent routes owned by this navigator, including replans. */
    public void terrain(boolean dig, boolean climb) {
        allowDig = dig;
        allowPillar = climb;
    }

    /** Optional per-route drop limit; omission retains the legacy invulnerability-based limit. */
    public void maxDrop(int blocks) {
        if (blocks < 0 || blocks > PathSearch.FEARLESS_DROP) throw new IllegalArgumentException("maxDrop must be 0..40");
        maxDrop = blocks;
    }

    /** Interactions may use an already reachable airborne position; this never plans a flight. */
    public void interaction(boolean currentOnly) {
        this.interaction = true;
        this.currentOnly = currentOnly;
    }

    /**
     * With climbing blocks not allowed, finding no way ends with one more search that may use them, so that the
     * failure can say whether they would have got the bot there.
     */
    public void explainClimbing(boolean on) {
        explainClimbing = on;
    }

    /** What the running task's walking has done to the world (the bot's log, shared by all its navigators). */
    public TerrainLog changes() {
        return bot.terrain();
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
        if (interaction && goal.reached(p)) {
            stop();
            return Status.ARRIVED;
        }
        if (currentOnly) return fail("out_of_reach", "the target is not reachable from the current position (distance, requested face or line of sight); approach=current does not move", null);
        if (++ticks > MAX_TICKS) return fail("stuck", "walking approach timed out after 90 seconds of game ticks; no flight route was attempted", null);
        // A walking plan cannot control a hovering body. Allow a normal jump/fall to settle, but do not
        // repeatedly search from mid-air while a backpack spends fuel. Stopping does not switch equipment off.
        if (!(p.onGround || p.isInWater() || p.isOnLadder())) {
            if (++airTicks >= 60) return fail("unreachable", "still airborne after 3 seconds; walking cannot approach from here. Reposition with movement controls or land first; flight equipment is unchanged and may keep consuming fuel", null);
            if (follower == null) return Status.WORKING;
        } else airTicks = 0;

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
                fruitless = made == 0 ? fruitless + 1 : 0;
                if (fruitless > MAX_FRUITLESS) return fail("stuck", "planned arrival repeatedly did not reach the target from the actual position", null);
            }
        }

        if (search == null) {
            if (goal.reached(p) && (p.onGround || p.isInWater())) {
                goal = null;
                return Status.ARRIVED;
            }
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
                maxDrop >= 0 ? maxDrop : bot.invulnerable ? PathSearch.FEARLESS_DROP : PathSearch.SAFE_DROP,
                swim);
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
            if (explainClimbing && (!mayPillar || Rules.scaffold(p) == null)) {
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
            bot.terrain(),
            swim);
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
        if ("unreachable".equals(code)) failMessage += " (walking permissions: dig=" + (rule != Rules.NO_BREAK)
            + ", climb=" + mayPillar + ", maxDrop=" + (maxDrop >= 0 ? maxDrop : bot.invulnerable ? PathSearch.FEARLESS_DROP : PathSearch.SAFE_DROP) + ")";
        failBlock = block;
        stop();
        return Status.FAILED;
    }
}
