package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import net.minecraft.block.Block;
import net.minecraft.block.material.Material;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.act.ContainerSession;
import alu.aiplayer.act.Digger;
import alu.aiplayer.act.Inventories;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.act.Placer;
import alu.aiplayer.act.Reach;
import alu.aiplayer.bot.Bot;
import alu.aiplayer.nav.Goal;
import alu.aiplayer.nav.NavWorld;
import alu.aiplayer.nav.Navigator;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.nav.TerrainLog;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Kinds;
import alu.aiplayer.util.Names;
import alu.aiplayer.world.WorldQueries;

/**
 * Shared machinery for tasks that work through many block positions: get within reach of a cell, dig or place
 * there, keep count of what was skipped and why, empty the inventory at a drop-off chest when it fills, fetch
 * material from a supply chest when it runs out, and sweep up the drops.
 * <p>
 * Nothing here remembers progress across a restart. Subclasses decide what is left to do by looking at the world,
 * which is what makes these tasks safe to start again.
 */
abstract class AreaTask extends Task {

    protected enum Act {
        /** Still working on this cell. */
        BUSY,
        /** The cell is as wanted. */
        OK,
        /** Gave up on this cell; the reason is recorded. */
        SKIPPED,
        /** Could not get within reach of this cell. Nothing is recorded; the caller decides what that means. */
        UNREACHABLE,
        /** Placing needs an item the bot does not carry. */
        NEED_MATERIAL,
        /** The task itself has failed. */
        FAILED
    }

    private static final int PLACE_COOLDOWN = 4;
    private static final int MAX_ATTEMPTS_PER_CELL = 4;

    protected final List<int[]> dropoff;
    protected final List<int[]> supply;
    /** What to do when the inventory is full and there is no drop-off: "fail" or "leave" drops on the ground. */
    protected final String overflow;

    protected Navigator nav;
    protected Digger digger;
    protected NavWorld.BreakRule rule = Rules.NATURAL_ONLY;
    protected int removed;
    protected int placed;
    private int alreadyMatches;
    private final boolean travelDig;
    private final boolean travelClimb;
    private final int travelMaxDrop;
    /** Compatibility fields for the last completed sweep only; history below retains earlier observations. */
    private JsonArray remainingDrops = new JsonArray();
    private String collectionProblem;
    private final JsonArray collectionSweeps = new JsonArray();
    private JsonObject collecting;

    private final Map<String, Integer> skipCounts = new LinkedHashMap<>();
    private final JsonArray skipExamples = new JsonArray();
    protected final Set<Long> gaveUp = new HashSet<>();
    private final Map<Long, Integer> attempts = new HashMap<>();
    private int cooldown;
    private boolean walking;
    private int recentre;
    private int recentred;
    private int airborne;

    /** Why the last trip to a supply container went wrong, if one did. */
    protected String supplyProblem;

    /**
     * Set by tasks that build upward: a block is then only placed from a footing at its own level or higher, so
     * the bot ends up on top of what it builds instead of sealed in underneath.
     */
    protected boolean placeFromAbove;

    private ContainerTrip trip;
    private Runnable afterTrip;
    private int tripIndex;
    private boolean tripIsDropoff;
    private Collector collector;

    AreaTask(String type, JsonObject params) {
        super(type, params);
        travelDig = J.bool(params, "dig", true);
        travelClimb = J.bool(params, "climb", true);
        travelMaxDrop = J.has(params, "maxDrop") ? J.i(params, "maxDrop", 3) : -1;
        if (J.has(params, "maxDrop") && (travelMaxDrop < 0 || travelMaxDrop > 40)) throw new IllegalArgumentException("maxDrop must be 0..40");
        dropoff = Params.posList(params, "dropoff");
        supply = Params.posList(params, "supply");
        overflow = J.str(params, "overflow", "fail");
        if (!overflow.equals("fail") && !overflow.equals("leave")) {
            throw new IllegalArgumentException("overflow must be \"fail\" or \"leave\"");
        }
    }

    @Override
    public void start(Bot bot) {
        super.start(bot);
        nav = new Navigator(bot);
        nav.terrain(travelDig, travelClimb);
        nav.explainClimbing(true);
        if (travelMaxDrop >= 0) nav.maxDrop(travelMaxDrop);
        nav.interaction(false);
        digger = new Digger(bot);
        scaffoldBefore = new HashSet<>(bot.scaffoldCells());
    }

    @Override
    public void cleanup() {
        if (nav != null) nav.stop();
        if (digger != null) digger.abort();
        if (trip != null) trip.stop();
        if (collector != null) collector.stop();
    }

    protected static long key(int x, int y, int z) {
        return NavWorld.key(x, y, z);
    }

    protected void skip(int x, int y, int z, String reason) {
        if ("unreachable".equals(reason)) reason = why(x, y, z, reason);
        gaveUp.add(key(x, y, z));
        skipCounts.merge(reason, 1, Integer::sum);
        if (skipExamples.size() < 12) {
            JsonObject o = J.pos(x, y, z);
            o.addProperty("reason", reason);
            skipExamples.add(o);
        }
    }

    protected void countSkip(String reason, int n) {
        if (n > 0) skipCounts.merge(reason, n, Integer::sum);
    }

    // ---- one cell -------------------------------------------------------------------------------------------

    /** Digs out one cell, walking within reach first if need be. Call every tick until it is not BUSY. */
    protected Act digCell(int x, int y, int z) {
        EntityPlayerMP p = bot.player();
        World w = p.worldObj;
        if (p.isInWater()) bot.motion.jump = true;
        if (digger.busy()) {
            Digger.Status st = digger.tick();
            if (st == Digger.Status.WORKING) return Act.BUSY;
            if (st == Digger.Status.DONE) {
                // A climbing block of the bot's own coming down is not part of the work: it is said in the
                // climbing blocks' list, not counted as removed.
                if (diggingOwnClimbingBlock) bot.terrain()
                    .takenDown(x, y, z, diggingBlock, diggingMeta);
                else removed++;
                bot.forgetScaffold(x, y, z);
                return Act.OK;
            }
            return digFailed(x, y, z);
        }
        if (walking) {
            Navigator.Status st = nav.tick();
            if (st == Navigator.Status.WORKING) return Act.BUSY;
            walking = false;
            if (st == Navigator.Status.FAILED) return walkFailed(x, y, z);
        }
        if (w.blockExists(x, y, z)) {
            Block block = w.getBlock(x, y, z);
            if (block.isAir(w, x, y, z)) return Act.OK;
            // The work list may be minutes old: someone could have put a chest here since.
            String why = untouchable(w, x, y, z, block);
            if ("has contents".equals(why) && named(x, y, z)) why = null;
            if (why == null && nextToLava(w, x, y, z)) why = "next to lava";
            if (why != null) {
                skip(x, y, z, why);
                return Act.SKIPPED;
            }
            if (Reach.canReach(p, x, y, z)) {
                diggingBlock = block;
                diggingMeta = w.getBlockMetadata(x, y, z);
                // Asked for by position (dig_blocks on one of its own climbing blocks), it is the work itself.
                diggingOwnClimbingBlock = bot.scaffoldCells()
                    .contains(key(x, y, z)) && Rules.isFiller(block) && !named(x, y, z);
                digger.begin(x, y, z);
                return Act.BUSY;
            }
        }
        if (bump(x, y, z) > MAX_ATTEMPTS_PER_CELL) return Act.UNREACHABLE;
        // Treetops and what lies on them hang far above anything to stand on. Not worth a search, or a tower.
        if (w.blockExists(x, y, z) && isFoliage(w, x, y, z) && y > groundNear(w, x, z) + 6) return Act.UNREACHABLE;
        // While tidying up, no new climbing blocks: that would never end.
        nav.go(Goal.reach(x, y, z, false), rule, tidyList == null);
        walking = true;
        return Act.BUSY;
    }

    private Block diggingBlock;
    private int diggingMeta;
    private boolean diggingOwnClimbingBlock;

    /** Kinds of block that turned out to need a tool the bot does not carry. */
    protected final Set<String> noToolFor = new HashSet<>();
    /** For each of those, the reason as written in the result (what tool it needs). */
    protected final Map<String, String> noToolWhy = new HashMap<>();

    /**
     * Whether meeting a block the bot has no tool for ends the task. It does where digging is the whole job;
     * a task with other work to do passes such blocks by and reports them.
     */
    protected boolean stopsWithoutTool() {
        return true;
    }

    private Act digFailed(int x, int y, int z) {
        String code = digger.failCode;
        if ("no_tool".equals(code) && !stopsWithoutTool()) {
            noToolFor.add(digger.failBlock);
            String why = "no tool for " + digger.failBlock + needsWords(digger.failNeeds);
            noToolWhy.put(digger.failBlock, why);
            skip(x, y, z, why);
            return Act.SKIPPED;
        }
        if ("no_tool".equals(code) || "denied".equals(code)) {
            JsonObject detail = "denied".equals(code) ? bot.refusalDetail(x, y, z) : J.pos(x, y, z);
            detail.addProperty("block", digger.failBlock);
            if ("no_tool".equals(code) && digger.failNeeds != null) detail.add("needs", digger.failNeeds);
            fail(code, digger.failMessage, detail);
            return Act.FAILED;
        }
        if ("out_of_reach".equals(code)) return Act.BUSY; // moved since the check; the next tick walks closer
        skip(x, y, z, code == null ? "failed" : code);
        return Act.SKIPPED;
    }

    /** " (needs tool class "wrench" level 2)", for a skip reason; empty when the block names no tool class. */
    private static String needsWords(JsonObject needs) {
        if (needs == null || !needs.has("tool")) return "";
        return " (needs tool class \"" + needs.get("tool")
            .getAsString() + "\" level " + needs.get("level")
                .getAsInt() + ")";
    }

    private Act walkFailed(int x, int y, int z) {
        cellWhy.put(key(x, y, z), nav.failCode + ": " + nav.failMessage);
        // Running out of blocks to climb with only means this cell is too high; a missing tool stops everything.
        if ("no_tool".equals(nav.failCode) && stopsWithoutTool()) {
            JsonObject detail = J.pos(x, y, z);
            if (nav.failBlock != null) detail.addProperty("block", nav.failBlock);
            fail(nav.failCode, nav.failMessage, detail);
            return Act.FAILED;
        }
        return Act.UNREACHABLE;
    }

    /** Opening a cell beside lava lets it run, onto the bot and over the drops. */
    private static boolean nextToLava(World w, int x, int y, int z) {
        return isLava(w, x + 1, y, z) || isLava(w, x - 1, y, z)
            || isLava(w, x, y, z + 1)
            || isLava(w, x, y, z - 1)
            || isLava(w, x, y + 1, z);
    }

    private static boolean isLava(World w, int x, int y, int z) {
        return w.blockExists(x, y, z) && w.getBlock(x, y, z)
            .getMaterial() == Material.lava;
    }

    /** Leaves, and thin things resting on them such as snow. */
    protected static boolean isFoliage(World w, int x, int y, int z) {
        Material m = w.getBlock(x, y, z)
            .getMaterial();
        if (m == Material.leaves || m == Material.vine) return true;
        return (m == Material.snow || m == Material.plants) && w.getBlock(x, y - 1, z)
            .getMaterial() == Material.leaves;
    }

    private final Map<Long, Integer> groundCache = new HashMap<>();

    /** The highest ground (foliage not counted) within a few blocks of a column. */
    private int groundNear(World w, int x, int z) {
        int best = -1;
        for (int dx = -4; dx <= 4; dx += 2) {
            for (int dz = -4; dz <= 4; dz += 2) {
                int cx = x + dx, cz = z + dz;
                if (!w.blockExists(cx, 64, cz)) continue;
                Long k = key(cx, 0, cz);
                Integer g = groundCache.get(k);
                if (g == null) {
                    g = WorldQueries.surfaceY(w, cx, cz);
                    groundCache.put(k, g);
                }
                best = Math.max(best, g);
            }
        }
        return best;
    }

    private int bump(int x, int y, int z) {
        return attempts.merge(key(x, y, z), 1, Integer::sum);
    }

    /** Places one block, walking within reach (and out of the way) first if need be. */
    protected Act placeCell(int x, int y, int z, ItemFilter item) {
        return placeCell(x, y, z, item, -1);
    }

    /**
     * Why cells could not be done, beyond the plain words: kept per cell for the ones a task gives up on at the end
     * (nothing to place against, unreachable), so the result says what a cell that must face a certain way needed.
     */
    private final Map<Long, String> cellWhy = new HashMap<>();

    /** What went wrong with this cell, in words, or {@code plain} when nothing more is known. */
    protected String why(int x, int y, int z, String plain) {
        String w = cellWhy.get(key(x, y, z));
        return w == null ? plain : w;
    }

    /** Placed blocks that came out with another meta than the one wanted: {x, y, z, want, got}. */
    private final JsonArray cameOut = new JsonArray();
    private int cameOutCount;

    private void cameOut(int x, int y, int z, int want, int got, String why) {
        cameOutCount++;
        if (cameOut.size() >= 12) return;
        JsonObject o = J.pos(x, y, z);
        o.addProperty("want", want);
        o.addProperty("got", got);
        if (why != null) o.addProperty("why", why);
        cameOut.add(o);
    }

    /**
     * Places one block that has to come out with meta {@code want} (-1: any): the bot stands where its look and
     * the face it clicks give that meta. A cell where no click can give it is skipped with the reason.
     */
    protected Act placeCell(int x, int y, int z, ItemFilter item, int want) {
        EntityPlayerMP p = bot.player();
        if (p.isInWater()) bot.motion.jump = true;
        if (cooldown > 0) {
            cooldown--;
            return Act.BUSY;
        }
        if (walking) {
            Navigator.Status st = nav.tick();
            if (st == Navigator.Status.WORKING) return Act.BUSY;
            walking = false;
            if (st == Navigator.Status.FAILED) return walkFailed(x, y, z);
        }
        if (recentre > 0) {
            // Standing with a shoulder in the target cell: shuffle back to the middle of the bot's own cell.
            recentre--;
            bot.motion.moveToward(p, bot.blockX() + 0.5, bot.blockZ() + 0.5);
            return Act.BUSY;
        }
        // An airborne player can place from an intentionally chosen hover, but do not chase a falling body.
        if (!p.onGround && !p.isInWater() && Math.abs(p.posY - p.prevPosY) > 0.02 && ++airborne < 60) return Act.BUSY;
        airborne = 0;
        // The stack the block is placed from (the first that matches, as the placing itself picks it): which variant.
        int from = Inventories.find(p, item);
        ItemStack using = from < 0 ? null : p.inventory.mainInventory[from].copy();
        Placer.Result r;
        Placer.Facing facing = new Placer.Facing();
        if (want >= 0) {
            World w = p.worldObj;
            if (w.blockExists(x, y, z) && !Placer.isReplaceable(w, x, y, z)
                && w.getBlockMetadata(x, y, z) != want
                && using != null
                && w.getBlock(x, y, z) == alu.aiplayer.act.Orientation.blockOf(using.getItem())) {
                skip(x, y, z, "the same block is already there, as /" + w.getBlockMetadata(x, y, z) + " (not /" + want + ")");
                return Act.SKIPPED;
            }
            r = Placer.placeAs(bot, x, y, z, item, want, facing, placeFromAbove && bot.blockY() < y);
        } else if (placeFromAbove && bot.blockY() < y) {
            // Standing too low. Find out what a walk up there would be for before setting off.
            World w = p.worldObj;
            if (!w.blockExists(x, y, z)) r = Placer.Result.OUT_OF_REACH;
            else if (!Placer.isReplaceable(w, x, y, z)) r = Placer.Result.OCCUPIED;
            else if (Inventories.find(p, item) < 0) r = Placer.Result.NO_ITEM;
            else if (!Placer.hasSupport(w, x, y, z)) r = Placer.Result.NO_SUPPORT;
            else r = Placer.Result.OUT_OF_REACH;
        } else {
            r = Placer.place(bot, x, y, z, item);
        }
        if (r == Placer.Result.IN_THE_WAY && (bot.blockX() != x || bot.blockZ() != z) && recentred < 3) {
            recentred++;
            recentre = 6;
            return Act.BUSY;
        }
        // Off the middle of its cell the look from there is not quite the one the way needs: to the middle first.
        if (r == Placer.Result.OFF_CENTRE && recentred < 3) {
            recentred++;
            recentre = 6;
            return Act.BUSY;
        }
        recentred = 0;
        switch (r) {
            case PLACED:
            case WRONG:
                placed++;
                if (using != null) placedItems.add(using, 1);
                cooldown = PLACE_COOLDOWN;
                if (r == Placer.Result.WRONG) cameOut(x, y, z, want, facing.got, facing.why);
                return Act.OK;
            case OCCUPIED: {
                World w = p.worldObj;
                Block there = w.getBlock(x, y, z);
                int meta = w.getBlockMetadata(x, y, z);
                // A named placement is satisfied only by the requested block/variant, not any obstruction.
                // For mod items with unknown placement mapping, report the occupied cell rather than guess.
                Block requested = alu.aiplayer.act.Orientation.blockOf(item.item);
                boolean same = requested != null && requested == there;
                if (same && want >= 0) same = meta == want;
                else if (same && item.meta >= 0) {
                    try { same = meta == alu.aiplayer.act.Orientation.placedMeta(item.item, item.meta); }
                    catch (Throwable t) { same = false; }
                }
                if (same) {
                    alreadyMatches++;
                    return Act.OK;
                }
                skip(x, y, z, "occupied by " + Names.blockId(there) + "/" + meta + "; not replaced");
                return Act.SKIPPED;
            }
            case NO_ITEM:
                return Act.NEED_MATERIAL;
            case NO_WAY:
                skip(x, y, z, facing.why);
                return Act.SKIPPED;
            case NO_SUPPORT:
                if (facing.why != null) cellWhy.put(key(x, y, z), facing.why);
                return Act.SKIPPED;
            case REJECTED:
                if (bot.placementWasRefused()) {
                    fail("denied", bot.refused("placing a block at (" + x + "," + y + "," + z + ")"), bot.refusalDetail(x, y, z));
                    return Act.FAILED;
                }
                if (bump(x, y, z) >= 2) {
                    skip(x, y, z, "rejected");
                    return Act.SKIPPED;
                }
                cooldown = PLACE_COOLDOWN;
                return Act.BUSY;
            default: // OUT_OF_REACH, IN_THE_WAY, OFF_CENTRE
                cellWhy.put(key(x, y, z), r == Placer.Result.IN_THE_WAY ? "the bot occupies the target cell; could not find a clear placement position"
                    : r == Placer.Result.OFF_CENTRE ? "could not align with the required placement position" : "out of reach from the current position");
                if (bump(x, y, z) > MAX_ATTEMPTS_PER_CELL) return Act.UNREACHABLE;
                Goal goal = null;
                if (want >= 0 && using != null) {
                    goal = Placer.facingGoal(p.worldObj, x, y, z, using, want, placeFromAbove);
                    if (goal != null) {
                        String look = Placer.lookNeeded(p.worldObj, x, y, z, using, want);
                        cellWhy.put(
                            key(x, y, z),
                            "unreachable: found nowhere to stand that is in reach and gives /" + want
                                + (look == null ? "" : " (" + look + ")")
                                + (placeFromAbove ? ", with the feet no lower than the block" : ""));
                    }
                }
                if (goal == null) goal = placeFromAbove ? Goal.reachFromAbove(x, y, z) : Goal.reach(x, y, z, true);
                nav.go(goal, rule);
                walking = true;
                return Act.BUSY;
        }
    }

    /** What the placed blocks were placed from, by kind: the variants that actually went in. */
    private final Kinds placedItems = new Kinds();

    /** Removes and returns the target nearest to the bot's eyes; with {@code lowestFirst}, among the lowest layer. */
    protected int[] takeNearest(List<int[]> targets, boolean lowestFirst) {
        EntityPlayerMP p = bot.player();
        int lowest = Integer.MAX_VALUE;
        if (lowestFirst) for (int[] t : targets) lowest = Math.min(lowest, t[1]);
        int best = -1;
        double bestDist = Double.MAX_VALUE;
        for (int i = 0; i < targets.size(); i++) {
            int[] t = targets.get(i);
            if (lowestFirst && t[1] != lowest) continue;
            double d = Reach.distanceSq(p.posX, p.posY + Reach.EYE_HEIGHT, p.posZ, t[0], t[1], t[2]);
            if (d < bestDist) {
                bestDist = d;
                best = i;
            }
        }
        if (best < 0) return null;
        int[] t = targets.get(best);
        int last = targets.size() - 1;
        targets.set(best, targets.get(last));
        targets.remove(last);
        return t;
    }

    // ---- errands --------------------------------------------------------------------------------------------

    /**
     * Runs whatever errand is in progress (a container trip or an item sweep). Returns true while one is, in which
     * case the task should do nothing else this tick.
     */
    protected boolean busyWithErrand() {
        if (collector != null) {
            if (collector.tick()) return true;
            remainingDrops = collector.remaining();
            collectionProblem = collector.failCode == null ? null : collector.failCode + ": " + collector.failMessage;
            collecting.addProperty("observedAt", System.currentTimeMillis());
            collecting.addProperty("pickedUpStacks", collector.picked);
            collecting.add("remaining", remainingDrops);
            if (collectionProblem != null) collecting.addProperty("problem", collectionProblem);
            if (collector.disappeared > 0) collecting.addProperty("disappearedTargets", collector.disappeared);
            collectionSweeps.add(collecting);
            collecting = null;
            collector = null;
        }
        if (trip == null) return false;
        ContainerTrip.Status st = trip.tick();
        if (st == ContainerTrip.Status.WORKING) return true;
        ContainerTrip finished = trip;
        trip = null;
        if (st == ContainerTrip.Status.FAILED && !tripIsDropoff) {
            supplyProblem = finished.failCode + ": " + finished.failMessage;
        }
        List<int[]> places = tripIsDropoff ? dropoff : supply;
        boolean incomplete = st == ContainerTrip.Status.FAILED
            || (tripIsDropoff ? finished.session.containerFull : !supplySatisfied());
        if (incomplete && tripIndex + 1 < places.size()) {
            // Try the next chest in the list.
            tripIndex++;
            beginTrip();
            return true;
        }
        if (incomplete && tripIsDropoff) {
            if (st == ContainerTrip.Status.FAILED) fail(finished);
            else fail("container_full", "the drop-off containers are full");
            return true;
        }
        Runnable next = afterTrip;
        afterTrip = null;
        if (next != null) next.run();
        return finished();
    }

    private Set<String> dropKeep;
    private List<ItemFilter> supplyWant;
    private int[] supplyHad;

    private boolean supplySatisfied() {
        for (int i = 0; i < supplyWant.size(); i++) {
            ItemFilter f = supplyWant.get(i);
            if (f.count > 0 && Inventories.count(bot.player(), f) - supplyHad[i] < f.count) return false;
        }
        return true;
    }

    private void beginTrip() {
        int[] at = (tripIsDropoff ? dropoff : supply).get(tripIndex);
        trip = new ContainerTrip(bot, at[0], at[1], at[2]);
        trip.travel(travelDig, travelMaxDrop);
        if (tripIsDropoff) {
            trip.session.deposit(dropPlan(dropKeep));
            return;
        }
        // Ask each further chest only for what the earlier ones did not provide.
        List<ItemFilter> rest = new ArrayList<>();
        for (int i = 0; i < supplyWant.size(); i++) {
            ItemFilter f = supplyWant.get(i);
            int gained = Inventories.count(bot.player(), f) - supplyHad[i];
            int need = f.count < 0 ? -1 : Math.max(0, f.count - Math.max(0, gained));
            if (need != 0) rest.add(new ItemFilter(f.id, f.meta, need));
        }
        if (rest.isEmpty()) rest.add(new ItemFilter(supplyWant.get(0).id, supplyWant.get(0).meta, 0));
        trip.session.withdraw(rest);
    }

    /** At most this many items of the kinds to keep stay with the bot on a drop-off trip. */
    private static final int KEEP_LIMIT = 256;

    protected int keepLimit() {
        return KEEP_LIMIT;
    }

    /** What to leave at a drop-off: everything but tools, food, a limited amount of what the task needs, and one
     * stack of filler to climb with. A fresh plan for each chest, since it counts what it has let through. */
    private ContainerSession.DepositPlan dropPlan(final Set<String> keep) {
        final ItemFilter scaffold = Rules.scaffold(bot.player());
        return new ContainerSession.DepositPlan() {

            private final Map<ItemStack, Integer> decided = new java.util.IdentityHashMap<>();
            private boolean keptScaffold;
            private int kept;

            @Override
            public int wanted(ItemStack stack) {
                // Asked more than once about the same stack, the answer must not change.
                Integer known = decided.get(stack);
                if (known != null) return known;
                int answer = -1;
                if (Inventories.isTool(stack) || Inventories.isFood(stack)) {
                    answer = 0;
                } else if (keep != null && keep.contains(Names.itemId(stack.getItem())) && kept < keepLimit()) {
                    kept += stack.stackSize;
                    answer = 0;
                } else if (scaffold != null && !keptScaffold && scaffold.matches(stack)) {
                    keptScaffold = true;
                    answer = 0;
                }
                decided.put(stack, answer);
                return answer;
            }

            @Override
            public void moved(ItemStack type, int count) {
                if (count > 0) unloaded.add(type, count);
            }
        };
    }

    /** What drop-off trips have left in the drop-off containers. */
    private final Kinds unloaded = new Kinds();

    /** Whether the inventory is full enough that digging should stop to deal with it. */
    protected boolean inventoryFull() {
        return Inventories.freeSlots(bot.player()) == 0;
    }

    /**
     * Deals with a full inventory. Returns true if work can go on (after a drop-off trip, or at once when drops
     * may be left lying); false if the task has failed.
     */
    protected boolean relieveInventory(final Set<String> keep) {
        if (!dropoff.isEmpty()) {
            startDropoff(keep, new Runnable() {

                @Override
                public void run() {
                    if (inventoryFull()) fail("inventory_full", "the drop-off trip did not free any space");
                }
            });
            return true;
        }
        if (overflow.equals("leave")) return true;
        fail("inventory_full", "the inventory is full and no drop-off container was given");
        return false;
    }

    protected void startDropoff(final Set<String> keep, Runnable then) {
        phase = "emptying inventory";
        tripIsDropoff = true;
        tripIndex = 0;
        afterTrip = then;
        dropKeep = keep;
        beginTrip();
    }

    /** Fetches items from the supply containers. Returns false (and fails the task) if none were given. */
    protected boolean startSupply(List<ItemFilter> want, String missingMessage, JsonObject detail) {
        if (supply.isEmpty()) {
            fail("no_material", missingMessage, detail);
            return false;
        }
        final int before = countAll(want);
        final String msg = missingMessage;
        final JsonObject det = detail;
        fetch(want, new Runnable() {

            @Override
            public void run() {
                // Nothing gained from any supply chest: the material is simply not there.
                if (countAll(supplyWant) <= before) fail("no_material", msg, det);
            }
        });
        return true;
    }

    /**
     * Goes round the supply containers for the listed items, then runs {@code then}. Coming back with less than
     * asked, or nothing, is not a failure here; the caller looks at what the bot now carries.
     */
    protected void fetch(List<ItemFilter> want, Runnable then) {
        phase = "fetching material";
        tripIsDropoff = false;
        tripIndex = 0;
        supplyWant = want;
        supplyHad = new int[want.size()];
        for (int i = 0; i < supplyHad.length; i++) supplyHad[i] = Inventories.count(bot.player(), want.get(i));
        afterTrip = then;
        beginTrip();
    }

    private int countAll(List<ItemFilter> filters) {
        int n = 0;
        for (ItemFilter f : filters) n += Inventories.count(bot.player(), f);
        return n;
    }

    /** Starts picking up the drops lying in and around a box. */
    protected void sweep(int x1, int y1, int z1, int x2, int y2, int z2) {
        beginCollection("work_drops", AxisAlignedBB.getBoundingBox(x1 - 3, y1 - 2, z1 - 3, x2 + 4, y2 + 3, z2 + 4),
            20 * 90, travelClimb);
    }

    /** Each sweep observes one box at one time, not the whole task's current remainder. */
    private void beginCollection(String kind, AxisAlignedBB box, int ticks, boolean climb) {
        collecting = new JsonObject();
        collecting.addProperty("kind", kind);
        collecting.addProperty("dim", bot.player().dimension);
        JsonObject bounds = new JsonObject();
        bounds.addProperty("minX", box.minX);
        bounds.addProperty("minY", box.minY);
        bounds.addProperty("minZ", box.minZ);
        bounds.addProperty("maxX", box.maxX);
        bounds.addProperty("maxY", box.maxY);
        bounds.addProperty("maxZ", box.maxZ);
        collecting.add("bounds", bounds);
        collector = new Collector(bot, box, travelDig ? rule : Rules.NO_BREAK, ticks, climb);
        if (travelMaxDrop >= 0) collector.maxDrop(travelMaxDrop);
    }

    // ---- tidying up -----------------------------------------------------------------------------------------

    private List<int[]> tidyList;
    private int[] tidyCurrent;
    /** Climbing blocks taken down while tidying, and the box they were in. */
    private int tidiedDown;
    private int tx1 = Integer.MAX_VALUE, ty1 = Integer.MAX_VALUE, tz1 = Integer.MAX_VALUE, tx2 = Integer.MIN_VALUE,
        ty2 = Integer.MIN_VALUE, tz2 = Integer.MIN_VALUE;
    /** Climbing blocks carried when tidying began; after the drops are swept up, how many did not come back. */
    private int fillerBeforeTidying;
    private boolean tidySwept;
    private int dropsNotPickedUp;
    /** Climbing blocks that tidying could not take down. */
    private final List<int[]> scaffoldLeft = new ArrayList<>();
    /** The climbing blocks the bot knew of when this task started; any others are this task's own. */
    private Set<Long> scaffoldBefore = new HashSet<>();

    /** Whether a block at this cell is part of what the task is meant to leave behind. */
    protected boolean keepsBlock(int x, int y, int z) {
        return false;
    }

    /**
     * Takes down the climbing blocks this task put down, wherever they are, and those the bot left standing around
     * here earlier, highest first. Returns true while it is still at it. What it cannot get at without building
     * more is left, listed in the result and still remembered as the bot's own.
     */
    protected boolean tidying() {
        EntityPlayerMP p = bot.player();
        World w = p.worldObj;
        if (tidyList == null) {
            tidyList = new ArrayList<>();
            for (Long k : new ArrayList<>(bot.scaffoldCells())) {
                int x = NavWorld.keyX(k), y = NavWorld.keyY(k), z = NavWorld.keyZ(k);
                if (!w.blockExists(x, y, z)) continue;
                if (!Rules.isFiller(w.getBlock(x, y, z)) || keepsBlock(x, y, z)) {
                    bot.forgetScaffold(x, y, z);
                    continue;
                }
                if (p.getDistanceSq(x + 0.5, y, z + 0.5) > 48.0 * 48.0 && scaffoldBefore.contains(k)) continue;
                tidyList.add(new int[] { x, y, z });
            }
            if (!tidyList.isEmpty()) phase = "tidying up";
            fillerBeforeTidying = Rules.fillerCarried(p);
        }
        if (tidyCurrent != null) {
            int[] c = tidyCurrent;
            // Taking away one's footing is a drop too; cleanup must honour the same limit as approaching.
            if (!digger.busy() && travelMaxDrop >= 0 && c[1] <= p.posY && c[1] + 1 >= p.posY - 0.1
                && p.boundingBox.maxX > c[0] && p.boundingBox.minX < c[0] + 1
                && p.boundingBox.maxZ > c[2] && p.boundingBox.minZ < c[2] + 1) {
                double below = NavWorld.heightAboveSupport(w, c[0] + 0.5, c[1], c[2] + 0.5, travelMaxDrop + 1);
                if (below < 0 || below + 1 > travelMaxDrop) {
                    scaffoldLeft.add(c);
                    cellWhy.put(key(c[0], c[1], c[2]), "removing this footing would exceed maxDrop=" + travelMaxDrop);
                    tidyCurrent = null;
                    return true;
                }
            }
            Act a = digCell(c[0], c[1], c[2]);
            if (a == Act.BUSY || a == Act.FAILED) return true;
            if (a == Act.OK) {
                bot.forgetScaffold(c[0], c[1], c[2]);
                tidiedDown++;
                tx1 = Math.min(tx1, c[0]);
                ty1 = Math.min(ty1, c[1]);
                tz1 = Math.min(tz1, c[2]);
                tx2 = Math.max(tx2, c[0]);
                ty2 = Math.max(ty2, c[1]);
                tz2 = Math.max(tz2, c[2]);
            } else {
                scaffoldLeft.add(c);
            }
            tidyCurrent = null;
        }
        if (tidyList.isEmpty()) {
            if (tidiedDown == 0) return false;
            if (!tidySwept) {
                // What was taken down dropped where it stood, or rolled off: pick it up again, as a player would.
                // Climbing to get at a drop would leave a new climbing block, so this walk does not.
                tidySwept = true;
                beginCollection("climbing_cleanup",
                    AxisAlignedBB.getBoundingBox(tx1 - 3, ty1 - 6, tz1 - 3, tx2 + 4, ty2 + 3, tz2 + 4), 20 * 60, false);
                return true;
            }
            dropsNotPickedUp = Math.max(0, tidiedDown - (Rules.fillerCarried(p) - fillerBeforeTidying));
            tidiedDown = 0;
            return false;
        }
        int best = 0;
        for (int i = 1; i < tidyList.size(); i++) if (tidyList.get(i)[1] > tidyList.get(best)[1]) best = i;
        tidyCurrent = tidyList.remove(best);
        return true;
    }

    // ---- helpers for subclasses -----------------------------------------------------------------------------

    /**
     * Whether this block was asked for by its position (not merely lies inside an area). Such a block is dug
     * like a player digs it, contents and all: what was inside drops. Area work leaves blocks with contents
     * standing, so that clearing a box does not empty somebody's chests on the way.
     */
    protected boolean named(int x, int y, int z) {
        return false;
    }

    /** Why a block must be left alone, or null if it may be dug out. */
    protected static String untouchable(World w, int x, int y, int z, Block b) {
        if (b.getMaterial()
            .isLiquid()) return "liquid";
        if (w.getTileEntity(x, y, z) != null) return "has contents";
        if (b.getBlockHardness(w, x, y, z) < 0.0F) return "unbreakable";
        return null;
    }

    protected List<int[]> cellsToDig(int x1, int y, int z1, int x2, int z2) {
        World w = bot.player().worldObj;
        List<int[]> out = new ArrayList<>();
        for (int x = x1; x <= x2; x++) {
            for (int z = z1; z <= z2; z++) {
                if (!w.blockExists(x, y, z)) continue;
                Block b = w.getBlock(x, y, z);
                if (b.isAir(w, x, y, z) || gaveUp.contains(key(x, y, z))) continue;
                String why = untouchable(w, x, y, z, b);
                if (why != null) {
                    // Flowing liquid goes away by itself once its source or its bed is dealt with.
                    if (!why.equals("liquid") || w.getBlockMetadata(x, y, z) == 0) skip(x, y, z, why);
                    else gaveUp.add(key(x, y, z));
                    continue;
                }
                out.add(new int[] { x, y, z });
            }
        }
        return out;
    }

    @Override
    protected boolean reportsTerrain() {
        return true;
    }

    @Override
    protected JsonObject summary() {
        JsonObject o = new JsonObject();
        o.addProperty("removed", removed);
        o.addProperty("placed", placed);
        if (alreadyMatches > 0) o.addProperty("alreadyMatches", alreadyMatches);
        if (remainingDrops.size() > 0) o.add("remainingDrops", remainingDrops);
        if (collectionProblem != null) o.addProperty("collectionProblem", collectionProblem);
        if (collectionSweeps.size() > 0) o.add("collectionSweeps", collectionSweeps);
        if (!placedItems.isEmpty()) o.add("placedItems", placedItems.toJson());
        if (cameOutCount > 0) {
            o.addProperty("cameOutDifferent", cameOutCount);
            o.add("cameOutExamples", cameOut);
        }
        if (!skipCounts.isEmpty()) {
            JsonObject s = new JsonObject();
            for (Map.Entry<String, Integer> e : skipCounts.entrySet()) s.addProperty(e.getKey(), e.getValue());
            o.add("skipped", s);
            o.add("skippedExamples", skipExamples);
        }
        if (!scaffoldLeft.isEmpty()) {
            o.addProperty("climbingBlocksLeftStanding", scaffoldLeft.size());
            JsonArray a = new JsonArray();
            for (int[] c : scaffoldLeft) {
                JsonObject at = J.pos(c[0], c[1], c[2]);
                at.addProperty("reason", why(c[0], c[1], c[2], "could not take down"));
                a.add(at);
            }
            o.add("climbingBlocksLeft", a);
        }
        if (bot != null && bot.online()) bot.terrain()
            .addTo(o, bot.player().worldObj);
        if (dropsNotPickedUp > 0) o.addProperty("climbingBlockDropsNotPickedUp", dropsNotPickedUp);
        if (!unloaded.isEmpty()) o.add("unloaded", unloaded.toJson());
        if (bot != null && bot.online()) o.addProperty("freeSlots", Inventories.freeSlots(bot.player()));
        return o;
    }
}
