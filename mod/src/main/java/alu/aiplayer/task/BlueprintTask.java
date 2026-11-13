package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import alu.aiplayer.act.Inventories;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.util.Names;
import alu.aiplayer.world.Blueprint;
import alu.aiplayer.world.BlueprintPlan;

/**
 * Builds what a blueprint draws: first digs out the blocks that are in the way and that the caller offered up,
 * top layer first, then places the drawn blocks from the bottom up, fetching material from the supply containers
 * as it runs out. A block that faces one way or another by how it is placed (stairs, logs, slabs) is placed so that
 * it comes out as drawn. Blocks that need a player's hand (anything with contents, a block whose placing code the
 * body cannot foresee) are left alone and reported, as is everything in the way that was not offered up.
 * <p>
 * Like the other area tasks it keeps no progress: started again, it looks at the world and does what is left.
 */
public final class BlueprintTask extends ClearTask {

    static final int MAX_SIDE = 64;

    private final BlueprintPlan plan;
    private final Set<String> materialIds;
    private int stage;
    private List<int[]> targets = new ArrayList<>();
    private List<int[]> deferred = new ArrayList<>();
    private boolean progressSinceDeferral;
    private int[] current;
    /** A cell being dug out during placing: a climbing block of the bot's own, or a block that came out wrong. */
    private int[] digging;
    private boolean placeAfterDigging;
    /** Kinds that the supply containers turned out not to hold. */
    private final Set<Integer> unavailable = new HashSet<>();
    /** Per kind, the cells left empty for want of material. */
    private final int[] starved;
    private int failingLayer = Integer.MIN_VALUE;
    private int layerFailures;
    private boolean needsClimbingBlocks;
    private boolean relieved;
    private boolean finishing;
    /** Kinds there is no room to fetch for the moment, and the cells that wait for them. */
    private final Set<Integer> postponed = new HashSet<>();
    private List<int[]> waiting = new ArrayList<>();
    private int placedWhenLastStuck = -1;

    public BlueprintTask(JsonObject params) {
        super("blueprint", params);
        plan = BlueprintPlan.fromParams(params);
        int wide = plan.x2 - plan.x1 + 1, deep = plan.z2 - plan.z1 + 1;
        if (wide > MAX_SIDE || deep > MAX_SIDE) {
            throw new IllegalArgumentException(
                "one task works on at most " + MAX_SIDE
                    + "x"
                    + MAX_SIDE
                    + " columns and this covers "
                    + wide
                    + "x"
                    + deep
                    + "; give x1, x2, z1, z2 to take it a part at a time");
        }
        setBox(plan.x1, plan.y1, plan.z1, plan.x2, plan.y2, plan.z2);
        rule = plan.breakRule();
        placeFromAbove = true;
        materialIds = plan.materialIds();
        starved = new int[plan.blueprint.kinds.length];
    }

    @Override
    public void tick() {
        if (busyWithErrand()) return;
        switch (stage) {
            case 0:
                if (approach()) {
                    beginClearing();
                    stage = 1;
                }
                break;
            case 1:
                if (clearTick() > 0) {
                    stage = 2;
                    if (removed > 0) sweep(x1, y1, z1, x2, y2, z2);
                }
                break;
            case 2:
                targets = plan.cellsToPlace(bot.player().worldObj);
                progressTotal = removed + placed + targets.size();
                phase = "placing";
                note = "";
                stage = 3;
                // Spoil from the digging would crowd out the building blocks: get rid of it before fetching any.
                if (!targets.isEmpty() && crowded()) startDropoff(materialIds, null);
                break;
            case 3:
                placeTick();
                break;
            case 4:
                if (tidying() || finished()) break;
                stage = 5;
                // What was dug out goes to the drop-off; the building blocks stay with the bot.
                if (!dropoff.isEmpty() && removed > 0) startDropoff(materialIds, null);
                break;
            default:
                finish();
                break;
        }
    }

    // ---- digging out what is in the way ---------------------------------------------------------------------

    @Override
    protected void beginClearing() {
        phase = "clearing";
        World w = bot.player().worldObj;
        int total = 0;
        for (int y = y1; y <= y2; y++) total += plan.cellsToRemove(w, y, gaveUp)
            .size();
        progressTotal += total;
    }

    @Override
    protected List<int[]> cellsToDig(int ax, int y, int az, int bx, int bz) {
        World w = bot.player().worldObj;
        List<int[]> cells = plan.cellsToRemove(w, y, gaveUp);
        if (noToolFor.isEmpty()) return cells;
        // What one block of a kind needed, the others of that kind need too: no use walking up to each.
        for (Iterator<int[]> it = cells.iterator(); it.hasNext();) {
            int[] c = it.next();
            String id = Names.blockId(w.getBlock(c[0], c[1], c[2]));
            if (!noToolFor.contains(id)) continue;
            String why = noToolWhy.get(id);
            skip(c[0], c[1], c[2], why != null ? why : "no tool for " + id);
            it.remove();
        }
        return cells;
    }

    @Override
    protected boolean stopsWithoutTool() {
        return false;
    }

    @Override
    protected Set<String> keepOnDropoff() {
        return materialIds;
    }

    @Override
    protected int keepLimit() {
        return Integer.MAX_VALUE;
    }

    @Override
    protected boolean keepsBlock(int x, int y, int z) {
        return plan.inBox(x, y, z) && plan.state(bot.player().worldObj, x, y, z) == BlueprintPlan.State.DONE;
    }

    // ---- placing --------------------------------------------------------------------------------------------

    private void placeTick() {
        World w = bot.player().worldObj;
        phase = "placing";
        if (digging != null) {
            Act a = digCell(digging[0], digging[1], digging[2]);
            if (a == Act.BUSY || a == Act.FAILED) return;
            if (a == Act.UNREACHABLE) skip(digging[0], digging[1], digging[2], "unreachable");
            else if (a == Act.OK && placeAfterDigging) targets.add(digging);
            digging = null;
            return;
        }
        if (current != null) {
            int x = current[0], y = current[1], z = current[2];
            Blueprint.Kind kind = plan.blueprint.kinds[current[3]];
            BlueprintPlan.State s = plan.state(w, x, y, z);
            if (s == BlueprintPlan.State.BLOCKED) {
                Block b = w.getBlock(x, y, z);
                boolean ownClimbingBlock = bot.scaffoldCells()
                    .contains(key(x, y, z)) && Rules.isFiller(b);
                if (ownClimbingBlock || plan.wantsGone(w, x, y, z, b)) {
                    digging = current;
                    placeAfterDigging = true;
                } else {
                    skip(x, y, z, "something else is there");
                }
            } else if (s == BlueprintPlan.State.PLACE) {
                if (unavailable.contains(kind.index)) {
                    starved[kind.index]++;
                    gaveUp.add(key(x, y, z));
                } else if (postponed.contains(kind.index)) {
                    waiting.add(current);
                } else {
                    int before = placed;
                    // A block that comes out one way or another by how it is placed is placed to come out as drawn.
                    Act a = placeCell(x, y, z, kind.item, kind.facing ? kind.meta : -1);
                    if (a == Act.BUSY || a == Act.FAILED) return;
                    if (a == Act.NEED_MATERIAL) {
                        needMaterial(kind);
                        return;
                    }
                    if (a == Act.OK) placedOrFound(w, x, y, z, placed > before);
                    else if (a == Act.UNREACHABLE) tooFar(current);
                    else if (!gaveUp.contains(key(x, y, z))) deferred.add(current);
                }
            } else if (s == BlueprintPlan.State.DONE) {
                progressSinceDeferral = true;
            }
            progressDone = removed + placed;
            current = null;
            if (digging != null) return;
        }
        if (targets.isEmpty() && !waiting.isEmpty()) {
            // What the bot carried has been used; now there is room to fetch the kinds that had to wait.
            if (placed == placedWhenLastStuck) {
                fail("inventory_full", "there is no room in the inventory to fetch building blocks");
                return;
            }
            placedWhenLastStuck = placed;
            targets = waiting;
            waiting = new ArrayList<>();
            postponed.clear();
        }
        if (targets.isEmpty()) {
            if (!deferred.isEmpty() && progressSinceDeferral) {
                // Blocks that had nothing to go against may have neighbours now.
                targets = deferred;
                deferred = new ArrayList<>();
                progressSinceDeferral = false;
            } else {
                for (int[] d : deferred) skip(d[0], d[1], d[2], why(d[0], d[1], d[2], "nothing to place against"));
                deferred.clear();
                stage = 4;
                return;
            }
        }
        current = takeNearest(targets, true);
        if (current != null) note = "layer y=" + current[1];
    }

    private void placedOrFound(World w, int x, int y, int z, boolean byThisBot) {
        if (plan.state(w, x, y, z) == BlueprintPlan.State.DONE) {
            progressSinceDeferral = true;
            layerFailures = 0;
            return;
        }
        if (byThisBot) {
            // It went in as something other than what is drawn. Out it comes; a player will have to place this one.
            skip(x, y, z, "came out differently than drawn");
            digging = current;
            placeAfterDigging = false;
        } else {
            skip(x, y, z, "something else is there");
        }
    }

    static final String LAYER_GIVEN_UP = "not tried: 3 cells of this layer in a row were unreachable";

    private void tooFar(int[] cell) {
        skip(cell[0], cell[1], cell[2], why(cell[0], cell[1], cell[2], "unreachable"));
        if (Rules.scaffold(bot.player()) == null) needsClimbingBlocks = true;
        if (cell[1] != failingLayer) {
            failingLayer = cell[1];
            layerFailures = 0;
        }
        if (++layerFailures < 3) return;
        // Three in a row on one layer with nothing placed in between: the rest of it is most likely just as far
        // out of reach, and finding that out cell by cell costs a path search each. Those cells were not tried,
        // and the result says so: from somewhere else they may well be within reach.
        for (Iterator<int[]> it = targets.iterator(); it.hasNext();) {
            int[] t = it.next();
            if (t[1] != failingLayer) continue;
            skip(t[0], t[1], t[2], LAYER_GIVEN_UP);
            it.remove();
        }
        layerFailures = 0;
    }

    // ---- material -------------------------------------------------------------------------------------------

    private void needMaterial(Blueprint.Kind now) {
        if (supply.isEmpty()) {
            // Nowhere to fetch from: carry on with the kinds the bot does have.
            unavailable.add(now.index);
            return;
        }
        final List<Blueprint.Kind> asked = new ArrayList<>();
        if (crowded() && !relieved) {
            relieved = true;
            startDropoff(materialIds, null);
            return;
        }
        List<ItemFilter> want = shoppingList(now, asked);
        if (want.isEmpty()) {
            if (!dropoff.isEmpty() && !relieved) {
                relieved = true;
                startDropoff(materialIds, null);
                return;
            }
            if (carriesWork()) {
                // Full of other building blocks: use those up first and come back for this kind.
                postponed.add(now.index);
                return;
            }
            fail("inventory_full", "there is no room in the inventory to fetch building blocks");
            return;
        }
        fetch(want, new Runnable() {

            @Override
            public void run() {
                relieved = false;
                phase = "placing";
                EntityPlayerMP p = bot.player();
                for (Blueprint.Kind k : asked) if (Inventories.count(p, k.item) == 0) unavailable.add(k.index);
                targets.addAll(waiting);
                waiting.clear();
                postponed.clear();
            }
        });
    }

    /** Whether the bot carries blocks that some cell still to do can take. */
    private boolean carriesWork() {
        EntityPlayerMP p = bot.player();
        Set<Integer> seen = new HashSet<>();
        List<int[]> open = new ArrayList<>(targets);
        open.addAll(deferred);
        for (int[] t : open) {
            if (!seen.add(t[3]) || postponed.contains(t[3]) || unavailable.contains(t[3])) continue;
            Blueprint.Kind k = plan.blueprint.kinds[t[3]];
            if (k.item != null && Inventories.count(p, k.item) > 0) return true;
        }
        return false;
    }

    /** Whether there is a drop-off to use and enough spoil in the inventory to be worth a trip there. */
    private boolean crowded() {
        if (dropoff.isEmpty()) return false;
        int spoil = 0;
        for (net.minecraft.item.ItemStack st : bot.player().inventory.mainInventory) {
            if (st == null || Inventories.isTool(st) || Inventories.isFood(st)) continue;
            if (!materialIds.contains(Names.itemId(st.getItem()))) spoil++;
        }
        // One of those stacks is the climbing blocks, which stay.
        return spoil >= 6;
    }

    /** What to bring from the supply: the kind needed now, then the others in the order the work will want them. */
    private List<ItemFilter> shoppingList(final Blueprint.Kind now, List<Blueprint.Kind> asked) {
        EntityPlayerMP p = bot.player();
        Blueprint.Kind[] kinds = plan.blueprint.kinds;
        final int[] count = new int[kinds.length];
        final int[] lowest = new int[kinds.length];
        Arrays.fill(lowest, Integer.MAX_VALUE);
        List<int[]> open = new ArrayList<>(targets);
        open.addAll(deferred);
        open.addAll(waiting);
        if (current != null) open.add(current);
        for (int[] t : open) {
            count[t[3]]++;
            lowest[t[3]] = Math.min(lowest[t[3]], t[1]);
        }
        lowest[now.index] = Integer.MIN_VALUE;
        List<Blueprint.Kind> order = new ArrayList<>();
        for (Blueprint.Kind k : kinds) {
            if (count[k.index] > 0 && k.item != null && !unavailable.contains(k.index)) order.add(k);
        }
        Collections.sort(order, (a, b) -> Integer.compare(lowest[a.index], lowest[b.index]));
        List<ItemFilter> want = new ArrayList<>();
        // One slot stays free for the climbing blocks the bot picks up again.
        int free = Inventories.freeSlots(p) - 1;
        for (Blueprint.Kind k : order) {
            int deficit = count[k.index] - Inventories.count(p, k.item);
            if (deficit <= 0) continue;
            int stacks = Math.min((deficit + k.maxStack - 1) / k.maxStack, free);
            if (stacks <= 0) break;
            want.add(new ItemFilter(k.item.id, k.meta, Math.min(deficit, stacks * k.maxStack)));
            asked.add(k);
            free -= stacks;
        }
        return want;
    }

    // ---- wrapping up ----------------------------------------------------------------------------------------

    private void finish() {
        finishing = true;
        int missing = 0;
        JsonArray list = new JsonArray();
        for (Blueprint.Kind k : plan.blueprint.kinds) {
            if (starved[k.index] == 0) continue;
            missing += starved[k.index];
            JsonObject m = BlueprintPlan.kindJson(k);
            m.addProperty("count", starved[k.index]);
            list.add(m);
        }
        if (missing == 0) {
            done();
            return;
        }
        JsonObject detail = new JsonObject();
        detail.add("missing", list);
        if (supplyProblem != null) detail.addProperty("supplyProblem", supplyProblem);
        fail(
            "no_material",
            missing + " blocks were left unplaced for want of material"
                + (supply.isEmpty() ? "; no supply container was given" : ""),
            detail);
    }

    private static final String[] COUNTS = { "cells", "done", "toPlace", "byHand", "blocked", "extra", "unloaded" };
    private static final String[] LISTS = { "materials", "byHandBlocks", "blockedBy", "extraBlocks" };
    private static final int SUMMARY_LIST_LIMIT = 8;

    @Override
    protected JsonObject summary() {
        JsonObject o = super.summary();
        o.remove("clearedDownTo");
        if (needsClimbingBlocks) o.addProperty("needsClimbingBlocks", true);
        if (!finishing || bot == null || !bot.online()) return o;
        // How the place compares with the drawing now that the work has stopped.
        JsonObject s = plan.survey(bot.player().worldObj, bot.player(), false);
        JsonObject now = new JsonObject();
        for (String k : COUNTS) if (s.has(k)) now.add(k, s.get(k));
        o.add("now", now);
        for (String k : LISTS) {
            if (!s.has(k)) continue;
            JsonArray all = s.getAsJsonArray(k), few = new JsonArray();
            for (JsonElement e : all) if (few.size() < SUMMARY_LIST_LIMIT) few.add(e);
            o.add(k, few);
        }
        return o;
    }
}
