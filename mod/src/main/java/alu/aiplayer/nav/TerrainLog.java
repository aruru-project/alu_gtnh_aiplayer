package alu.aiplayer.nav;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/**
 * What a task's walking did to the world: the blocks put down to climb on (and which of them the task took down
 * again) and the blocks dug out of the way. The bot keeps one for the task it is running, shared by every walk the
 * task makes (to the work, to a supply chest, after drops), and the task reports it as it is when it ends, so that
 * nothing the bot changed on the way goes unsaid.
 */
public final class TerrainLog {

    /** At most this many cells of each kind are listed; how many more there were is said, not left out silently. */
    public static final int LIST_LIMIT = 64;

    public static final class Cell {

        public final int x, y, z;
        public final String id;
        public final int meta;

        Cell(int x, int y, int z, String id, int meta) {
            this.x = x;
            this.y = y;
            this.z = z;
            this.id = id;
            this.meta = meta;
        }
    }

    private final List<Cell> placed = new ArrayList<>();
    private final List<Cell> dug = new ArrayList<>();
    /** Climbing blocks of this log that the task itself dug out again. */
    private final java.util.Set<Long> takenDown = new java.util.HashSet<>();
    /** Climbing blocks left by earlier work that this task took down. */
    private final List<Cell> olderTakenDown = new ArrayList<>();

    void placed(World w, int x, int y, int z) {
        for (Cell c : placed) if (c.x == x && c.y == y && c.z == z) return;
        Block b = w.getBlock(x, y, z);
        placed.add(new Cell(x, y, z, Names.blockId(b), w.getBlockMetadata(x, y, z)));
    }

    void dug(int x, int y, int z, Block b, int meta) {
        // Taking down one of the walk's own climbing blocks is not a change to report twice: the climbing block's
        // entry says it no longer stands.
        for (Cell c : placed) if (c.x == x && c.y == y && c.z == z) return;
        dug.add(new Cell(x, y, z, Names.blockId(b), meta));
    }

    /**
     * The task dug out a climbing block of the bot's: one of this log's, or one an earlier task left standing (then
     * it is listed apart, as it was when dug).
     */
    public void takenDown(int x, int y, int z, Block b, int meta) {
        for (Cell c : placed) {
            if (c.x == x && c.y == y && c.z == z) {
                takenDown.add(NavWorld.key(x, y, z));
                return;
            }
        }
        if (b != null) olderTakenDown.add(new Cell(x, y, z, Names.blockId(b), meta));
    }

    public boolean isEmpty() {
        return placed.isEmpty() && dug.isEmpty() && olderTakenDown.isEmpty();
    }

    /** The climbing blocks put down, in the order they were. */
    public List<Cell> placed() {
        return placed;
    }

    /** Whether the block put down at this cell is still there. */
    public static boolean standing(World w, Cell c) {
        if (!w.blockExists(c.x, c.y, c.z)) return true; // not loaded: nobody can have taken it
        return Names.blockId(w.getBlock(c.x, c.y, c.z))
            .equals(c.id);
    }

    /** The climbing blocks of this walk still standing. */
    public List<Cell> stillStanding(World w) {
        List<Cell> out = new ArrayList<>();
        for (Cell c : placed) if (standing(w, c)) out.add(c);
        return out;
    }

    /**
     * Adds {@code climbingBlocks} (each with whether it still stands, and {@code takenDown} for those the task dug out
     * again), {@code olderClimbingBlocksTakenDown} and {@code dugOnTheWay} to a task result. Nothing is added for a
     * task whose walking changed nothing.
     */
    public void addTo(JsonObject o, World w) {
        if (!placed.isEmpty()) {
            JsonArray a = new JsonArray();
            int standing = 0;
            for (Cell c : placed) {
                boolean s = standing(w, c);
                if (s) standing++;
                if (a.size() >= LIST_LIMIT) continue;
                JsonObject e = cell(c);
                e.addProperty("standing", s);
                if (takenDown.contains(NavWorld.key(c.x, c.y, c.z))) e.addProperty("takenDown", true);
                a.add(e);
            }
            o.add("climbingBlocks", a);
            if (placed.size() > LIST_LIMIT) o.addProperty("climbingBlocksNotListed", placed.size() - LIST_LIMIT);
            o.addProperty("climbingBlocksStanding", standing);
        }
        if (!olderTakenDown.isEmpty()) {
            JsonArray a = new JsonArray();
            for (Cell c : olderTakenDown) if (a.size() < LIST_LIMIT) a.add(cell(c));
            o.add("olderClimbingBlocksTakenDown", a);
        }
        addDugTo(o);
    }

    /** Adds only {@code dugOnTheWay}: for tasks that report their climbing blocks their own way. */
    public void addDugTo(JsonObject o) {
        if (dug.isEmpty()) return;
        JsonArray a = new JsonArray();
        for (Cell c : dug) if (a.size() < LIST_LIMIT) a.add(cell(c));
        o.add("dugOnTheWay", a);
        if (dug.size() > LIST_LIMIT) o.addProperty("dugOnTheWayNotListed", dug.size() - LIST_LIMIT);
    }

    static JsonObject cell(Cell c) {
        JsonObject e = J.pos(c.x, c.y, c.z);
        e.addProperty("id", c.id);
        if (c.meta != 0) e.addProperty("meta", c.meta);
        return e;
    }
}
