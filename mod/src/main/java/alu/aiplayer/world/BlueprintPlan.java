package alu.aiplayer.world;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import net.minecraft.block.Block;
import net.minecraft.block.material.Material;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import alu.aiplayer.AiPlayerMod;
import alu.aiplayer.act.Inventories;
import alu.aiplayer.nav.NavWorld;
import alu.aiplayer.nav.Rules;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/**
 * A blueprint set down at a place in the world, with the caller's limits on what to work on. It answers, for any
 * cell, how the world there compares with the drawing. Both the survey a brain asks for and the task that builds
 * use these answers, so what a survey promises is what the task does.
 */
public final class BlueprintPlan {

    public enum State {
        /** The blueprint has no say here, or the cell is as drawn. */
        NONE,
        /** The drawn block is in place. */
        DONE,
        /** Empty, and the bot can place the drawn block. */
        PLACE,
        /** Empty, but the drawn block has to be placed by a player. */
        BY_HAND,
        /** Another block sits where the drawing has a block. */
        BLOCKED,
        /** A block sits where the drawing has nothing. */
        EXTRA,
        UNLOADED
    }

    public final Blueprint blueprint;
    /** Where the blueprint's lowest corner sits in the world. */
    public final int ox, oy, oz;
    /** The part of it to work on. */
    public final int x1, y1, z1, x2, y2, z2;
    private final Set<Block> only;
    private final Set<Block> skip;
    private final Set<Block> clear;
    private final boolean clearNatural;
    private final boolean clearPlants;

    /**
     * Reads {@code name}, the corner {@code x y z}, an optional range ({@code x1 x2}, {@code y1 y2}, {@code z1 z2},
     * each pair on its own), and the block lists {@code only}, {@code skip} and {@code clear}.
     */
    public static BlueprintPlan fromParams(JsonObject p) {
        Blueprint b = AiPlayerMod.blueprints()
            .get(J.reqStr(p, "name"));
        return new BlueprintPlan(b, p);
    }

    private BlueprintPlan(Blueprint b, JsonObject p) {
        blueprint = b;
        ox = J.reqCoord(p, "x");
        oy = J.reqHeight(p, "y");
        oz = J.reqCoord(p, "z");
        int[] xs = range(p, "x1", "x2", ox, ox + b.sx - 1, false);
        int[] ys = range(p, "y1", "y2", Math.max(0, oy), Math.min(255, oy + b.sy - 1), true);
        int[] zs = range(p, "z1", "z2", oz, oz + b.sz - 1, false);
        x1 = xs[0];
        x2 = xs[1];
        y1 = ys[0];
        y2 = ys[1];
        z1 = zs[0];
        z2 = zs[1];
        if (x1 > x2 || y1 > y2 || z1 > z2) {
            throw new IllegalArgumentException(
                "the given range does not touch the blueprint, which set down there spans x " + ox
                    + ".."
                    + (ox + b.sx - 1)
                    + ", y "
                    + oy
                    + ".."
                    + (oy + b.sy - 1)
                    + ", z "
                    + oz
                    + ".."
                    + (oz + b.sz - 1));
        }
        only = J.has(p, "only") ? blocks(p, "only", null) : null;
        skip = blocks(p, "skip", null);
        boolean[] words = new boolean[2];
        clear = blocks(p, "clear", words);
        clearNatural = words[0];
        clearPlants = words[1];
    }

    private static int[] range(JsonObject p, String a, String b, int lo, int hi, boolean height) {
        if (!J.has(p, a) && !J.has(p, b)) return new int[] { lo, hi };
        if (!J.has(p, a) || !J.has(p, b)) throw new IllegalArgumentException(a + " and " + b + " go together");
        int u = height ? J.reqHeight(p, a) : J.reqCoord(p, a), v = height ? J.reqHeight(p, b) : J.reqCoord(p, b);
        return new int[] { Math.max(lo, Math.min(u, v)), Math.min(hi, Math.max(u, v)) };
    }

    /**
     * A list of block ids. In the clear list two words stand for whole groups: "natural" for the configured plain
     * terrain, "plants" for everything that grows (flowers, bushes, leaves, crops without contents).
     */
    private static Set<Block> blocks(JsonObject p, String key, boolean[] words) {
        Set<Block> out = Collections.newSetFromMap(new IdentityHashMap<Block, Boolean>());
        JsonArray a = J.array(p, key);
        if (a == null) {
            if (J.has(p, key)) throw new IllegalArgumentException(key + " must be a list of block ids");
            return out;
        }
        for (JsonElement e : a) {
            String id = e.getAsString();
            if (words != null && (id.equals("natural") || id.equals("plants"))) {
                words[id.equals("natural") ? 0 : 1] = true;
                continue;
            }
            Block b = Names.block(id);
            if (b == null) throw new IllegalArgumentException("unknown block id in " + key + ": " + id);
            out.add(b);
        }
        return out;
    }

    public boolean inBox(int x, int y, int z) {
        return x >= x1 && x <= x2 && y >= y1 && y <= y2 && z >= z1 && z <= z2;
    }

    public long volume() {
        return ((long) x2 - x1 + 1) * ((long) y2 - y1 + 1) * ((long) z2 - z1 + 1);
    }

    /** What the drawing asks for at a world position; null where it has no say. */
    public Blueprint.Kind want(int x, int y, int z) {
        if (!inBox(x, y, z)) return null;
        Blueprint.Kind k = blueprint.at(x - ox, y - oy, z - oz);
        if (k.empty()) return only == null ? k : null;
        if (k.block == null) return null;
        if (only != null && !only.contains(k.block)) return null;
        if (skip.contains(k.block)) return null;
        return k;
    }

    public State state(World w, int x, int y, int z) {
        Blueprint.Kind k = want(x, y, z);
        if (k == null) return State.NONE;
        if (!w.blockExists(x, y, z)) return State.UNLOADED;
        Block b = w.getBlock(x, y, z);
        boolean free = b.isAir(w, x, y, z) || b.isReplaceable(w, x, y, z);
        if (k.empty()) return free ? State.NONE : State.EXTRA;
        if (b == k.block && w.getBlockMetadata(x, y, z) == k.meta) return State.DONE;
        if (free) return k.byHand == null ? State.PLACE : State.BY_HAND;
        return State.BLOCKED;
    }

    /** Whether the caller allowed blocks of this kind to be dug out when they are in the way. */
    public boolean mayRemove(Block b) {
        if (clear.contains(b) || (clearNatural && Rules.isNatural(b))) return true;
        if (!clearPlants) return false;
        Material m = b.getMaterial();
        return m == Material.plants || m == Material.vine || m == Material.leaves || m == Material.gourd;
    }

    /** Whether the block now in a cell is in the way of the drawing and may be dug out. */
    public boolean wantsGone(World w, int x, int y, int z, Block b) {
        if (!mayRemove(b)) return false;
        State s = state(w, x, y, z);
        return s == State.BLOCKED || s == State.EXTRA;
    }

    private static boolean fixed(World w, int x, int y, int z, Block b) {
        return w.getTileEntity(x, y, z) != null || b.getBlockHardness(w, x, y, z) < 0.0F;
    }

    /**
     * On the way somewhere the bot may break plain terrain outside the plan, and inside it only what the plan
     * itself would dig out: never a block that is drawn, and never one the caller did not offer up.
     */
    public NavWorld.BreakRule breakRule() {
        return new NavWorld.BreakRule() {

            @Override
            public boolean mayBreak(World w, int x, int y, int z, Block block) {
                if (inBox(x, y, z)) return wantsGone(w, x, y, z, block);
                return Rules.isNatural(block);
            }

            @Override
            public boolean isJob(World w, int x, int y, int z, Block block) {
                return inBox(x, y, z) && wantsGone(w, x, y, z, block);
            }
        };
    }

    /** The cells of one layer whose block is to be dug out. */
    public List<int[]> cellsToRemove(World w, int y, Set<Long> except) {
        List<int[]> out = new ArrayList<>();
        if (y < y1 || y > y2 || (clear.isEmpty() && !clearNatural && !clearPlants)) return out;
        for (int x = x1; x <= x2; x++) {
            for (int z = z1; z <= z2; z++) {
                if (!w.blockExists(x, y, z) || except.contains(NavWorld.key(x, y, z))) continue;
                Block b = w.getBlock(x, y, z);
                if (b.isAir(w, x, y, z) || !wantsGone(w, x, y, z, b) || fixed(w, x, y, z, b)) continue;
                out.add(new int[] { x, y, z });
            }
        }
        return out;
    }

    /** The empty cells the bot can put a block in, as {x, y, z, kind}. */
    public List<int[]> cellsToPlace(World w) {
        List<int[]> out = new ArrayList<>();
        for (int y = y1; y <= y2; y++) {
            for (int x = x1; x <= x2; x++) {
                for (int z = z1; z <= z2; z++) {
                    if (state(w, x, y, z) == State.PLACE) out.add(new int[] { x, y, z, want(x, y, z).index });
                }
            }
        }
        return out;
    }

    private static final class Tally {

        final Block block;
        int meta;
        int count;
        int removable;
        int fixed;

        Tally(Block block, int meta) {
            this.block = block;
            this.meta = meta;
        }
    }

    private static void tally(Map<Block, Tally> into, World w, int x, int y, int z, Block b, boolean removable) {
        Tally t = into.get(b);
        if (t == null) {
            t = new Tally(b, w.getBlockMetadata(x, y, z));
            into.put(b, t);
        }
        t.count++;
        if (fixed(w, x, y, z, b)) t.fixed++;
        else if (removable) t.removable++;
    }

    private static final int LIST_LIMIT = 30;

    /**
     * Compares the world with the drawing, cell by cell.
     *
     * @param p      whose inventory to count the materials against; may be null
     * @param layers whether to include the count per layer
     */
    public JsonObject survey(World w, EntityPlayerMP p, boolean layers) {
        int cells = 0, done = 0, toPlace = 0, byHand = 0, blocked = 0, extra = 0, unloaded = 0, willRemove = 0;
        int[] need = new int[blueprint.kinds.length];
        int[] hand = new int[blueprint.kinds.length];
        Map<Block, Tally> blockedBy = new IdentityHashMap<>();
        Map<Block, Tally> extras = new IdentityHashMap<>();
        JsonArray perLayer = new JsonArray();
        for (int y = y1; y <= y2; y++) {
            int lCells = 0, lDone = 0, lPlace = 0, lBlocked = 0, lExtra = 0;
            for (int x = x1; x <= x2; x++) {
                for (int z = z1; z <= z2; z++) {
                    Blueprint.Kind k = want(x, y, z);
                    if (k == null) continue;
                    if (!k.empty()) lCells++;
                    State s = state(w, x, y, z);
                    switch (s) {
                        case DONE:
                            lDone++;
                            break;
                        case PLACE:
                            lPlace++;
                            need[k.index]++;
                            break;
                        case BY_HAND:
                            byHand++;
                            hand[k.index]++;
                            break;
                        case BLOCKED: {
                            lBlocked++;
                            Block b = w.getBlock(x, y, z);
                            boolean removable = mayRemove(b);
                            tally(blockedBy, w, x, y, z, b, removable);
                            if (removable && !fixed(w, x, y, z, b)) {
                                willRemove++;
                                if (k.byHand == null) need[k.index]++;
                            }
                            break;
                        }
                        case EXTRA: {
                            lExtra++;
                            Block b = w.getBlock(x, y, z);
                            boolean removable = mayRemove(b);
                            tally(extras, w, x, y, z, b, removable);
                            if (removable && !fixed(w, x, y, z, b)) willRemove++;
                            break;
                        }
                        case UNLOADED:
                            unloaded++;
                            break;
                        default:
                            break;
                    }
                }
            }
            cells += lCells;
            done += lDone;
            toPlace += lPlace;
            blocked += lBlocked;
            extra += lExtra;
            if (layers && (lCells > 0 || lExtra > 0)) {
                JsonArray row = new JsonArray();
                for (int v : new int[] { y, lCells, lDone, lPlace, lBlocked, lExtra }) row.add(J.prim(v));
                perLayer.add(row);
            }
        }

        JsonObject o = new JsonObject();
        o.addProperty("name", blueprint.name);
        o.add("origin", J.pos(ox, oy, oz));
        JsonObject box = new JsonObject();
        box.addProperty("x1", x1);
        box.addProperty("y1", y1);
        box.addProperty("z1", z1);
        box.addProperty("x2", x2);
        box.addProperty("y2", y2);
        box.addProperty("z2", z2);
        o.add("box", box);
        o.addProperty("cells", cells);
        o.addProperty("done", done);
        o.addProperty("toPlace", toPlace);
        o.addProperty("byHand", byHand);
        o.addProperty("blocked", blocked);
        o.addProperty("extra", extra);
        o.addProperty("willRemove", willRemove);
        if (unloaded > 0) o.addProperty("unloaded", unloaded);

        JsonArray materials = new JsonArray();
        JsonArray byHandBlocks = new JsonArray();
        for (Blueprint.Kind k : sortedByCount(need)) {
            JsonObject m = kindJson(k);
            m.addProperty("need", need[k.index]);
            if (p != null) m.addProperty("have", Inventories.count(p, k.item));
            materials.add(m);
        }
        for (Blueprint.Kind k : sortedByCount(hand)) {
            JsonObject m = kindJson(k);
            m.addProperty("count", hand[k.index]);
            m.addProperty("why", k.byHand);
            byHandBlocks.add(m);
        }
        o.add("materials", materials);
        if (byHandBlocks.size() > 0) o.add("byHandBlocks", byHandBlocks);
        if (!blockedBy.isEmpty()) o.add("blockedBy", tallies(blockedBy));
        if (!extras.isEmpty()) o.add("extraBlocks", tallies(extras));
        if (layers) o.add("layers", perLayer);
        return o;
    }

    private List<Blueprint.Kind> sortedByCount(final int[] counts) {
        List<Blueprint.Kind> out = new ArrayList<>();
        for (Blueprint.Kind k : blueprint.kinds) if (counts[k.index] > 0) out.add(k);
        Collections.sort(out, (a, b) -> counts[b.index] - counts[a.index]);
        return out.size() > LIST_LIMIT ? out.subList(0, LIST_LIMIT) : out;
    }

    public static JsonObject kindJson(Blueprint.Kind k) {
        JsonObject m = new JsonObject();
        m.addProperty("id", k.item != null ? k.item.id : k.blockId);
        m.addProperty("meta", k.meta);
        m.addProperty("name", k.name);
        return m;
    }

    private static JsonArray tallies(Map<Block, Tally> map) {
        List<Tally> list = new ArrayList<>(map.values());
        Collections.sort(list, (a, b) -> b.count - a.count);
        JsonArray out = new JsonArray();
        for (Tally t : list) {
            if (out.size() >= LIST_LIMIT) break;
            JsonObject o = new JsonObject();
            o.addProperty("id", Names.blockId(t.block));
            o.addProperty("name", WorldQueries.blockName(t.block, t.meta));
            o.addProperty("count", t.count);
            // How many of them the clear list lets the bot dig out, and how many nobody may (contents, bedrock).
            o.addProperty("removable", t.removable);
            if (t.fixed > 0) o.addProperty("holdsData", t.fixed);
            if (Rules.isNatural(t.block)) o.addProperty("natural", true);
            out.add(o);
        }
        return out;
    }

    /** Keys of the item ids this plan builds with, for telling building material from spoil. */
    public Set<String> materialIds() {
        Set<String> ids = new HashSet<>();
        for (Blueprint.Kind k : blueprint.kinds) if (k.item != null) ids.add(k.item.id);
        return ids;
    }
}
