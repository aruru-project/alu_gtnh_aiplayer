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
import alu.aiplayer.util.J;
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

    private final Map<String, Integer> skipCounts = new LinkedHashMap<>();
    private final JsonArray skipExamples = new JsonArray();
    protected final Set<Long> gaveUp = new HashSet<>();
    private final Map<Long, Integer> attempts = new HashMap<>();
    private int cooldown;
    private boolean walking;
    private int recentre;
    private int recentred;
    private int airborne;

    private ContainerTrip trip;
    private Runnable afterTrip;
    private int tripIndex;
    private boolean tripIsDropoff;
    private Collector collector;

    AreaTask(String type, JsonObject params) {
        super(type, params);
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
        digger = new Digger(bot);
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
                removed++;
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
            if (why == null && nextToLava(w, x, y, z)) why = "next to lava";
            if (why != null) {
                skip(x, y, z, why);
                return Act.SKIPPED;
            }
            if (Reach.canReach(p, x, y, z)) {
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

    private Act digFailed(int x, int y, int z) {
        String code = digger.failCode;
        if ("no_tool".equals(code) || "denied".equals(code)) {
            JsonObject detail = J.pos(x, y, z);
            detail.addProperty("block", digger.failBlock);
            fail(code, digger.failMessage, detail);
            return Act.FAILED;
        }
        if ("out_of_reach".equals(code)) return Act.BUSY; // moved since the check; the next tick walks closer
        skip(x, y, z, code == null ? "failed" : code);
        return Act.SKIPPED;
    }

    private Act walkFailed(int x, int y, int z) {
        // Running out of blocks to climb with only means this cell is too high; a missing tool stops everything.
        if ("no_tool".equals(nav.failCode)) {
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
        // Placing while airborne would put the block where the feet are about to be.
        if (!p.onGround && !p.isInWater() && ++airborne < 100) return Act.BUSY;
        airborne = 0;
        Placer.Result r = Placer.place(bot, x, y, z, item);
        if (r == Placer.Result.IN_THE_WAY && (bot.blockX() != x || bot.blockZ() != z) && recentred < 3) {
            recentred++;
            recentre = 6;
            return Act.BUSY;
        }
        recentred = 0;
        switch (r) {
            case PLACED:
                placed++;
                cooldown = PLACE_COOLDOWN;
                return Act.OK;
            case OCCUPIED:
                return Act.OK;
            case NO_ITEM:
                return Act.NEED_MATERIAL;
            case NO_SUPPORT:
                return Act.SKIPPED;
            case REJECTED:
                if (bot.placementWasRefused()) {
                    fail("denied", "placing a block here was refused; the area may be protected", J.pos(x, y, z));
                    return Act.FAILED;
                }
                if (bump(x, y, z) >= 2) {
                    skip(x, y, z, "rejected");
                    return Act.SKIPPED;
                }
                cooldown = PLACE_COOLDOWN;
                return Act.BUSY;
            default: // OUT_OF_REACH, IN_THE_WAY
                if (bump(x, y, z) > MAX_ATTEMPTS_PER_CELL) return Act.UNREACHABLE;
                nav.go(Goal.reach(x, y, z, true), rule);
                walking = true;
                return Act.BUSY;
        }
    }

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
            collector = null;
        }
        if (trip == null) return false;
        ContainerTrip.Status st = trip.tick();
        if (st == ContainerTrip.Status.WORKING) return true;
        ContainerTrip finished = trip;
        trip = null;
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
            if (st == ContainerTrip.Status.FAILED) fail(finished.failCode, finished.failMessage);
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
                } else if (keep != null && keep.contains(Names.itemId(stack.getItem())) && kept < KEEP_LIMIT) {
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
            public void moved(ItemStack type, int count) {}
        };
    }

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
        phase = "fetching material";
        tripIsDropoff = false;
        tripIndex = 0;
        supplyWant = want;
        supplyHad = new int[want.size()];
        for (int i = 0; i < supplyHad.length; i++) supplyHad[i] = Inventories.count(bot.player(), want.get(i));
        final int before = countAll(want);
        final String msg = missingMessage;
        final JsonObject det = detail;
        afterTrip = new Runnable() {

            @Override
            public void run() {
                // Nothing gained from any supply chest: the material is simply not there.
                if (countAll(supplyWant) <= before) fail("no_material", msg, det);
            }
        };
        beginTrip();
        return true;
    }

    private int countAll(List<ItemFilter> filters) {
        int n = 0;
        for (ItemFilter f : filters) n += Inventories.count(bot.player(), f);
        return n;
    }

    /** Starts picking up the drops lying in and around a box. */
    protected void sweep(int x1, int y1, int z1, int x2, int y2, int z2) {
        if (inventoryFull()) return;
        collector = new Collector(
            bot,
            AxisAlignedBB.getBoundingBox(x1 - 3, y1 - 2, z1 - 3, x2 + 4, y2 + 3, z2 + 4),
            rule,
            20 * 90);
    }

    // ---- tidying up -----------------------------------------------------------------------------------------

    private List<int[]> tidyList;
    private int[] tidyCurrent;
    private int scaffoldLeft;

    /** Whether a block at this cell is part of what the task is meant to leave behind. */
    protected boolean keepsBlock(int x, int y, int z) {
        return false;
    }

    /**
     * Takes down the climbing blocks the bot has left standing around here, highest first. Returns true while it
     * is still at it. What it cannot get at without building more is counted and left.
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
                if (p.getDistanceSq(x + 0.5, y, z + 0.5) > 48.0 * 48.0) continue;
                tidyList.add(new int[] { x, y, z });
            }
            if (!tidyList.isEmpty()) phase = "tidying up";
        }
        if (tidyCurrent != null) {
            Act a = digCell(tidyCurrent[0], tidyCurrent[1], tidyCurrent[2]);
            if (a == Act.BUSY || a == Act.FAILED) return true;
            bot.forgetScaffold(tidyCurrent[0], tidyCurrent[1], tidyCurrent[2]);
            if (a != Act.OK) scaffoldLeft++;
            tidyCurrent = null;
        }
        if (tidyList.isEmpty()) return false;
        int best = 0;
        for (int i = 1; i < tidyList.size(); i++) if (tidyList.get(i)[1] > tidyList.get(best)[1]) best = i;
        tidyCurrent = tidyList.remove(best);
        return true;
    }

    // ---- helpers for subclasses -----------------------------------------------------------------------------

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
    protected JsonObject summary() {
        JsonObject o = new JsonObject();
        o.addProperty("removed", removed);
        o.addProperty("placed", placed);
        if (!skipCounts.isEmpty()) {
            JsonObject s = new JsonObject();
            for (Map.Entry<String, Integer> e : skipCounts.entrySet()) s.addProperty(e.getKey(), e.getValue());
            o.add("skipped", s);
            o.add("skippedExamples", skipExamples);
        }
        if (scaffoldLeft > 0) o.addProperty("climbingBlocksLeftStanding", scaffoldLeft);
        if (bot != null && bot.online()) o.addProperty("freeSlots", Inventories.freeSlots(bot.player()));
        return o;
    }
}
