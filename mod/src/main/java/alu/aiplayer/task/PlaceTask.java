package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.act.Orientation;
import alu.aiplayer.util.J;

/**
 * Places a given list of blocks, lowest first, each from the bot's inventory. A cell may say which meta the block
 * must come out with ({@code blockMeta}: which way a stair or a log faces, which half a slab takes): the bot then
 * stands and clicks so that it does.
 */
public final class PlaceTask extends AreaTask {

    private final List<int[]> targets = new ArrayList<>();
    private final List<ItemFilter> items = new ArrayList<>();
    /** Per item index, the meta the block must come out with; -1 for any. */
    private final List<Integer> wants = new ArrayList<>();
    /** Per item index, whether the item's variant was left to the bot and is still to be chosen. */
    private final List<Boolean> open = new ArrayList<>();
    private List<int[]> deferred = new ArrayList<>();
    private boolean progressSinceDeferral;
    private int[] current;
    /** The cells asked for: what ends up there stays, filler or not. */
    private final java.util.Set<Long> asked = new java.util.HashSet<>();
    private boolean finishing;

    public PlaceTask(JsonObject params) {
        super("place", params);
        JsonArray blocks = J.array(params, "blocks");
        if (blocks == null || blocks.size() == 0) throw new IllegalArgumentException("blocks must list positions");
        if (blocks.size() > 256) throw new IllegalArgumentException("at most 256 blocks per place task");
        for (JsonElement e : blocks) {
            JsonObject o = e.getAsJsonObject();
            int[] p = Params.pos(o);
            // The fourth number is the index of the item this cell gets.
            targets.add(new int[] { p[0], p[1], p[2], items.size() });
            asked.add(key(p[0], p[1], p[2]));
            int meta = J.i(o, "meta", -1);
            int want = J.i(o, "blockMeta", -1);
            if (J.has(o, "blockMeta") && (want < 0 || want > 15)) throw new IllegalArgumentException("blockMeta is 0 to 15");
            items.add(new ItemFilter(J.reqStr(o, "item"), meta, -1));
            wants.add(want);
            open.add(want >= 0 && meta < 0);
        }
        progressTotal = targets.size();
    }

    @Override
    public void start(alu.aiplayer.bot.Bot bot) {
        super.start(bot);
        for (int[] t : targets) if (!withinTravel(t[0], t[2])) return;
    }

    @Override
    protected boolean keepsBlock(int x, int y, int z) {
        return asked.contains(key(x, y, z));
    }

    @Override
    public void tick() {
        if (busyWithErrand()) return;
        if (finishing) {
            // The climbing blocks put down to get up to the cells come down again before the task ends.
            if (!tidying() && !finished()) done();
            return;
        }
        if (current != null) {
            int i = current[3];
            if (open.get(i)) {
                open.set(i, false);
                if (!chooseVariant(current)) {
                    current = null;
                    return;
                }
            }
            ItemFilter item = items.get(i);
            Act a = placeCell(current[0], current[1], current[2], item, wants.get(i));
            if (a == Act.BUSY || a == Act.FAILED) return;
            if (a == Act.NEED_MATERIAL) {
                JsonObject detail = new JsonObject();
                detail.add("item", item.toJson());
                detail.addProperty("missing", 1 + countSame(i));
                List<ItemFilter> want = new ArrayList<>();
                want.add(new ItemFilter(item.id, item.meta, 1 + countSame(i)));
                startSupply(want, "the bot has no " + item.label(), detail);
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
                targets.addAll(deferred);
                deferred = new ArrayList<>();
                progressSinceDeferral = false;
            } else {
                for (int[] d : deferred) skip(d[0], d[1], d[2], why(d[0], d[1], d[2], "nothing to place against"));
                finishing = true;
                return;
            }
        }
        current = takeNearest(targets, true);
    }

    /**
     * A cell that must come out as a given meta and did not say which variant of the item to use: the one whose
     * clicks can give that meta here. False (the cell skipped) when no variant can; a block whose placing code the
     * body cannot foresee keeps "any variant".
     */
    private boolean chooseVariant(int[] cell) {
        int i = cell[3];
        ItemFilter any = items.get(i);
        net.minecraft.block.Block b = Orientation.blockOf(any.item);
        if (b == null || Orientation.rule(b) == Orientation.Rule.UNKNOWN) return true;
        World w = bot.player().worldObj;
        if (!w.blockExists(cell[0], cell[1], cell[2])) return true;
        int d = Orientation.damageFor(w, cell[0], cell[1], cell[2], any.item, wants.get(i));
        if (d < 0) {
            int plainMeta;
            try {
                plainMeta = Orientation.placedMeta(any.item, 0);
            } catch (Throwable t) {
                plainMeta = 0;
            }
            java.util.Set<Integer> can = Orientation
                .allOutcomes(Orientation.rule(b), Orientation.ways(w, cell[0], cell[1], cell[2], b, plainMeta));
            skip(
                cell[0],
                cell[1],
                cell[2],
                "no variant of " + any.id
                    + " can come out as /"
                    + wants.get(i)
                    + " in this cell ("
                    + any.id
                    + ":0 comes out as "
                    + Orientation.metas(can)
                    + ")");
            return false;
        }
        items.set(i, new ItemFilter(any.id, d, -1));
        return true;
    }

    private int countSame(int itemIndex) {
        ItemFilter f = items.get(itemIndex);
        int n = 0;
        for (int[] t : targets) {
            ItemFilter o = items.get(t[3]);
            if (o.item == f.item && o.meta == f.meta) n++;
        }
        return n;
    }
}
