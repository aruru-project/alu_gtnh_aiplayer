package alu.aiplayer.task;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.world.World;
import net.minecraft.world.chunk.Chunk;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.AiPlayerMod;
import alu.aiplayer.act.Inventories;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.act.Placer;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/**
 * Turns a rectangle of terrain into level ground whose top layer is at y: everything above y is dug away, then
 * holes at and below y are filled from the bottom up with filler blocks, preferably the ones just dug.
 */
public final class FlattenTask extends ClearTask {

    private final int ax, az, bx, bz, level;
    private final boolean fill;
    private final int maxFillDepth;
    private final List<String> fillItems;
    private int stage;
    private List<int[]> holes;
    private List<int[]> deferred = new ArrayList<>();
    private boolean progressSinceDeferral;
    private int[] current;

    public FlattenTask(JsonObject params) {
        super("flatten", params);
        ax = J.reqInt(params, "x1");
        az = J.reqInt(params, "z1");
        bx = J.reqInt(params, "x2");
        bz = J.reqInt(params, "z2");
        level = J.reqInt(params, "y");
        if (level < 1 || level > 250) throw new IllegalArgumentException("y must be between 1 and 250");
        if (Math.abs(bx - ax) + 1 > 64 || Math.abs(bz - az) + 1 > 64) {
            throw new IllegalArgumentException("the area is limited to 64x64");
        }
        fill = J.bool(params, "fill", true);
        maxFillDepth = Math.max(1, Math.min(16, J.i(params, "maxFillDepth", 3)));
        List<String> given = Params.strings(params, "fillItems");
        fillItems = given.isEmpty() ? AiPlayerMod.config().fillerBlocks : given;
        for (String id : fillItems) {
            if (Names.item(id) == null) throw new IllegalArgumentException("unknown item id: " + id);
        }
        // The top of the box is found once the bot is there and the chunks are loaded.
        setBox(ax, level + 1, az, bx, level + 1, bz);
    }

    @Override
    public void tick() {
        if (busyWithErrand()) return;
        switch (stage) {
            case 0:
                if (approach()) {
                    setBox(ax, level + 1, az, bx, Math.max(level + 1, highestBlock()), bz);
                    beginClearing();
                    stage = 1;
                }
                break;
            case 1:
                if (clearTick() > 0) {
                    stage = 2;
                    sweep(x1, level, z1, x2, y2, z2);
                }
                break;
            case 2:
                if (!fill) {
                    finish();
                    break;
                }
                phase = "filling";
                holes = findHoles();
                progressTotal += holes.size();
                stage = 3;
                break;
            case 3:
                fillTick();
                break;
            default:
                finish();
                break;
        }
    }

    private void finish() {
        if (!dropoff.isEmpty() && removed > 0 && stage != 5) {
            stage = 5;
            startDropoff(null, null);
            return;
        }
        done();
    }

    private int highestBlock() {
        World w = bot.player().worldObj;
        int top = level + 1;
        for (int x = x1; x <= x2; x++) {
            for (int z = z1; z <= z2; z++) {
                if (!w.blockExists(x, 64, z)) continue;
                Chunk chunk = w.getChunkFromBlockCoords(x, z);
                for (int y = Math.min(255, chunk.getTopFilledSegment() + 15); y > top; y--) {
                    if (!chunk.getBlock(x & 15, y, z & 15)
                        .isAir(w, x, y, z)) {
                        top = y;
                        break;
                    }
                }
            }
        }
        return top;
    }

    /** Cells at and below the level that need a block, lowest first within each column. */
    private List<int[]> findHoles() {
        World w = bot.player().worldObj;
        List<int[]> out = new ArrayList<>();
        int tooDeep = 0;
        for (int x = x1; x <= x2; x++) {
            for (int z = z1; z <= z2; z++) {
                if (!w.blockExists(x, level, z)) continue;
                int depth = 0;
                while (depth <= maxFillDepth && level - depth >= 1 && Placer.isReplaceable(w, x, level - depth, z)) depth++;
                if (depth == 0) continue;
                if (depth > maxFillDepth) {
                    tooDeep++;
                    continue;
                }
                for (int y = level - depth + 1; y <= level; y++) out.add(new int[] { x, y, z });
            }
        }
        countSkip("hole deeper than maxFillDepth (columns)", tooDeep);
        return out;
    }

    private void fillTick() {
        if (current != null) {
            ItemFilter material = material();
            if (material == null) {
                needMaterial();
                return;
            }
            Act a = placeCell(current[0], current[1], current[2], material);
            if (a == Act.BUSY || a == Act.FAILED) return;
            if (a == Act.NEED_MATERIAL) {
                needMaterial();
                return;
            }
            if (a == Act.UNREACHABLE) skip(current[0], current[1], current[2], "unreachable");
            if (a == Act.OK) progressSinceDeferral = true;
            // Nothing to place against yet; a neighbour placed later may provide it.
            else if (!gaveUp.contains(key(current[0], current[1], current[2]))) deferred.add(current);
            progressDone = removed + placed;
            current = null;
        }
        if (holes.isEmpty()) {
            if (!deferred.isEmpty() && progressSinceDeferral) {
                holes = deferred;
                deferred = new ArrayList<>();
                progressSinceDeferral = false;
            } else {
                for (int[] d : deferred) skip(d[0], d[1], d[2], "nothing to place against");
                deferred.clear();
                stage = 4;
                return;
            }
        }
        current = takeNearest(holes, true);
    }

    private ItemFilter material() {
        EntityPlayerMP p = bot.player();
        for (String id : fillItems) {
            ItemFilter f = new ItemFilter(id, -1, -1);
            if (Inventories.find(p, f) >= 0) return f;
        }
        return null;
    }

    private void needMaterial() {
        int missing = holes.size() + deferred.size() + (current == null ? 0 : 1);
        JsonObject detail = new JsonObject();
        detail.addProperty("missing", missing);
        JsonArray ids = new JsonArray();
        for (String id : fillItems) ids.add(J.prim(id));
        detail.add("items", ids);
        List<ItemFilter> want = new ArrayList<>();
        for (String id : fillItems) want.add(new ItemFilter(id, -1, Math.min(missing, 128)));
        startSupply(want, "out of filler blocks; " + missing + " more needed", detail);
    }

    @Override
    protected java.util.Set<String> keepOnDropoff() {
        return fill ? new java.util.HashSet<>(fillItems) : null;
    }

    @Override
    protected JsonObject summary() {
        JsonObject o = super.summary();
        o.remove("clearedDownTo");
        o.addProperty("level", level);
        return o;
    }
}
