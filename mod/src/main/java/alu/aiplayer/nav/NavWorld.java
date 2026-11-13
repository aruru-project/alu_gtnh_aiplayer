package alu.aiplayer.nav;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.block.material.Material;
import net.minecraft.entity.EntityLivingBase;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.init.Blocks;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.world.World;

import alu.aiplayer.act.Doors;
import alu.aiplayer.act.Elevators;
import alu.aiplayer.act.Tools;

/**
 * The world as the pathfinder sees it: every cell is one of a few movement classes, cached for the lifetime of one
 * search. Also answers whether a cell may be broken to get through, and what that would cost.
 */
public final class NavWorld {

    /** Nothing to bump into: air, plants, torches, thin snow. */
    public static final byte OPEN = 0;
    /** A full-height block: blocks the way, can be stood on. */
    public static final byte SOLID = 1;
    /** Water and other harmless liquids; the bot floats at the surface. */
    public static final byte WATER = 2;
    /** Lava, fire and the like: never enter, never stand next to. */
    public static final byte HAZARD = 3;
    /** Something with an odd shape (fence, chest, pane, door): blocks the way, cannot be stood on. */
    public static final byte OBSTACLE = 4;
    /** A lower half block: step onto it, stand half a block up. */
    public static final byte SLAB = 5;
    /** Chunk not loaded: unknown, treated as impassable. */
    public static final byte UNLOADED = 6;
    /** A closed door or gate that a right-click opens. */
    public static final byte DOOR = 7;
    /**
     * Something a player climbs: a ladder, a vine. It does not fill the cell, so the bot can be in it; while its feet
     * are in such a cell it holds on, goes up by pushing toward the wall and slides down when it lets go.
     */
    public static final byte CLIMB = 8;

    /** Decides which blocks may be broken to make a path. */
    public interface BreakRule {

        /** Whether the block may be broken to get through when there is no other way. */
        boolean mayBreak(World w, int x, int y, int z, Block block);

        /**
         * Whether breaking the block is the task's own work (it lies in the box being cleared). Such blocks may be
         * broken freely; everything else is only touched once walking around has been tried and found impossible.
         */
        default boolean isJob(World w, int x, int y, int z, Block block) {
            return false;
        }
    }

    public final World world;
    private final EntityPlayerMP player;
    private final BreakRule rule;
    private final boolean gentle;
    private final java.util.Set<Long> ownScaffold;
    private final java.util.Set<Long> shutDoors;
    private final Map<Long, Byte> classes = new HashMap<>();
    private final Map<Long, Integer> breakCosts = new HashMap<>();
    private final Map<Integer, Integer> digTicks = new HashMap<>();
    public boolean sawUnloaded;

    /**
     * @param gentle      plan without altering terrain: only the task's own work and the bot's own leftover
     *                    climbing blocks may be broken
     * @param ownScaffold cells where this bot has put climbing blocks; taking those away again is always welcome
     */
    public NavWorld(EntityPlayerMP player, BreakRule rule, boolean gentle, java.util.Set<Long> ownScaffold) {
        this(player, rule, gentle, ownScaffold, java.util.Collections.<Long>emptySet());
    }

    /**
     * @param shutDoors doors that did not open when tried; they count as walls
     */
    public NavWorld(EntityPlayerMP player, BreakRule rule, boolean gentle, java.util.Set<Long> ownScaffold,
        java.util.Set<Long> shutDoors) {
        this.shutDoors = shutDoors;
        this.world = player.worldObj;
        this.player = player;
        this.rule = rule;
        this.gentle = gentle;
        this.ownScaffold = ownScaffold;
    }

    public static long key(int x, int y, int z) {
        return ((long) (x + 30000000) << 38) | ((long) (z + 30000000) << 12) | (y & 0xFFFL);
    }

    public static int keyX(long key) {
        return (int) (key >>> 38) - 30000000;
    }

    public static int keyY(long key) {
        return (int) (key & 0xFFFL);
    }

    public static int keyZ(long key) {
        return (int) ((key >>> 12) & 0x3FFFFFFL) - 30000000;
    }

    public byte cls(int x, int y, int z) {
        if (y < 0) return OBSTACLE;
        if (y > 255) return OPEN;
        long k = key(x, y, z);
        Byte cached = classes.get(k);
        if (cached != null) return cached;
        byte c = classify(world, x, y, z, player);
        if (c == DOOR && shutDoors.contains(k)) c = OBSTACLE;
        if (c == UNLOADED) sawUnloaded = true;
        classes.put(k, c);
        return c;
    }

    public static byte classify(World w, int x, int y, int z) {
        return classify(w, x, y, z, null);
    }

    /** @param who the player whose way this is, for blocks that are solid or climbable for some only; may be null */
    public static byte classify(World w, int x, int y, int z, EntityLivingBase who) {
        if (!w.blockExists(x, y, z)) return UNLOADED;
        Block b = w.getBlock(x, y, z);
        Material m = b.getMaterial();
        if (m == Material.air) return OPEN;
        if (m == Material.lava || m == Material.fire || b == Blocks.cactus) return HAZARD;
        if (m.isLiquid()) return WATER;
        int door = Doors.state(w, x, y, z, b);
        if (door == Doors.OPEN) return OPEN;
        if (door == Doors.CLOSED) return DOOR;
        byte shape = shape(w, x, y, z, b, who);
        if (shape != SOLID && shape != SLAB && climbable(w, x, y, z, b, who)) return CLIMB;
        return shape;
    }

    /**
     * The movement class of a block's shape, from the boxes the game's physics collides a player with. Not from the
     * block's bounds: some blocks keep bounds that are only true for the last thing asked of them. Stairs are the
     * case in point: once anything traces a ray through a stair (a player pointing at one, a mob checking whether it
     * can see someone), every stair of that kind reports an eighth of a block as its bounds until a moving entity
     * next bumps into one, and was then taken for something that cannot be stood on.
     */
    private static byte shape(World w, int x, int y, int z, Block b, EntityLivingBase who) {
        List<AxisAlignedBB> boxes = collisionBoxes(w, x, y, z, b, who);
        if (boxes == null) return OBSTACLE;
        if (boxes.isEmpty()) return b == Blocks.web ? OBSTACLE : OPEN;
        double top = Double.NEGATIVE_INFINITY;
        boolean fullWidth = false, fullWidthFromBottom = false;
        for (AxisAlignedBB bb : boxes) {
            top = Math.max(top, bb.maxY - y);
            if (bb.minX <= x + 0.01 && bb.maxX >= x + 0.99 && bb.minZ <= z + 0.01 && bb.maxZ >= z + 0.99) {
                fullWidth = true;
                if (bb.minY <= y + 0.01) fullWidthFromBottom = true;
            }
        }
        if (top <= 0.26) return OPEN;
        if (!fullWidth) return OBSTACLE;
        if (top >= 0.85 && top <= 1.01) return SOLID;
        if (top >= 0.4 && top <= 0.6 && fullWidthFromBottom) return SLAB;
        return OBSTACLE;
    }

    /** The boxes a player in this cell collides with, as the game's physics finds them; null if the block threw. */
    private static List<AxisAlignedBB> collisionBoxes(World w, int x, int y, int z, Block b, EntityLivingBase who) {
        List<AxisAlignedBB> boxes = new ArrayList<>();
        try {
            b.addCollisionBoxesToList(w, x, y, z, AxisAlignedBB.getBoundingBox(x, y, z, x + 1, y + 1, z + 1), boxes, who);
        } catch (Throwable t) {
            return null;
        }
        return boxes;
    }

    /** Whether a player in this cell holds on to it, as on a ladder. */
    private static boolean climbable(World w, int x, int y, int z, Block b, EntityLivingBase who) {
        try {
            return b.isLadder(w, x, y, z, who);
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * The horizontal direction {dx, dz} from a climbable cell toward what it hangs on: the way to push to climb it.
     * Null when it hangs on nothing the bot can push against.
     */
    public static int[] climbWall(World w, int x, int y, int z) {
        Block b = w.getBlock(x, y, z);
        int meta = w.getBlockMetadata(x, y, z);
        if (b instanceof net.minecraft.block.BlockLadder) {
            switch (meta) {
                case 2:
                    return new int[] { 0, 1 };
                case 3:
                    return new int[] { 0, -1 };
                case 4:
                    return new int[] { 1, 0 };
                case 5:
                    return new int[] { -1, 0 };
                default:
                    break;
            }
        } else if (b instanceof net.minecraft.block.BlockVine) {
            if ((meta & 1) != 0) return new int[] { 0, 1 };
            if ((meta & 4) != 0) return new int[] { 0, -1 };
            if ((meta & 2) != 0) return new int[] { -1, 0 };
            if ((meta & 8) != 0) return new int[] { 1, 0 };
        }
        // Anything else that is climbed: whatever solid neighbour it has.
        int[][] dirs = { { 0, 1 }, { 0, -1 }, { 1, 0 }, { -1, 0 } };
        for (int[] d : dirs) {
            byte c = classify(w, x + d[0], y, z + d[1]);
            if (c == SOLID || c == OBSTACLE) return d;
        }
        return null;
    }

    /**
     * How far feet at this height are above what holds them up in their column: the top of the highest collision
     * box at or below them, or a liquid's surface. -1 if nothing does within the given depth or that part of the
     * world is not loaded.
     */
    public static double heightAboveSupport(World w, double px, double feetY, double pz, int depth) {
        int x = net.minecraft.util.MathHelper.floor_double(px), z = net.minecraft.util.MathHelper.floor_double(pz);
        int top = net.minecraft.util.MathHelper.floor_double(feetY);
        for (int y = top; y >= Math.max(0, top - depth); y--) {
            if (!w.blockExists(x, y, z)) return -1;
            Block b = w.getBlock(x, y, z);
            if (b.getMaterial()
                .isLiquid()) return Math.max(0, feetY - (y + 1));
            List<AxisAlignedBB> boxes = collisionBoxes(w, x, y, z, b, null);
            if (boxes == null) continue;
            double best = Double.NEGATIVE_INFINITY;
            for (AxisAlignedBB bb : boxes) if (bb.maxY <= feetY + 1.0e-6) best = Math.max(best, bb.maxY);
            if (best > Double.NEGATIVE_INFINITY) return feetY - best;
        }
        return -1;
    }

    /** For a bot standing with its feet at x y z: the feet level it would arrive at by elevator, or -1. */
    public int elevatorTarget(int x, int y, int z, boolean up) {
        if (y < 1 || !world.blockExists(x, y - 1, z)) return -1;
        Block here = world.getBlock(x, y - 1, z);
        if (!Elevators.is(here)) return -1;
        int colour = Elevators.colour(world, x, y - 1, z);
        // The mod's own search is the judge; this only has to be right often enough to be worth trying.
        for (int d = 2; d <= ELEVATOR_REACH; d++) {
            int by = up ? y - 1 + d : y - 1 - d;
            if (by < 1 || by > 253) break;
            if (!Elevators.is(world.getBlock(x, by, z)) || Elevators.colour(world, x, by, z) != colour) continue;
            if (cls(x, by + 1, z) != OPEN || cls(x, by + 2, z) != OPEN) continue;
            return by + 1;
        }
        return -1;
    }

    private static final int ELEVATOR_REACH = 20;

    /** Whether a bot with its feet here stands on an elevator block. */
    public boolean onElevator(int x, int y, int z) {
        return y >= 1 && world.blockExists(x, y - 1, z) && Elevators.is(world.getBlock(x, y - 1, z));
    }

    /** Nothing in the cell keeps the bot out of it: open, water, or something it climbs. */
    public boolean passable(int x, int y, int z) {
        byte c = cls(x, y, z);
        return c == OPEN || c == WATER || c == CLIMB;
    }

    /** Lava or fire in the cell or right next to it. */
    public boolean nearHazard(int x, int y, int z) {
        return cls(x, y, z) == HAZARD || cls(x + 1, y, z) == HAZARD
            || cls(x - 1, y, z) == HAZARD
            || cls(x, y, z + 1) == HAZARD
            || cls(x, y, z - 1) == HAZARD
            || cls(x, y - 1, z) == HAZARD;
    }

    /**
     * Ticks to break the block in a cell so the bot can pass, or -1 if it must not or cannot be broken.
     * Blocks holding data, blocks next to lava or under a liquid, and blocks the rule protects are never broken.
     */
    public int breakCost(int x, int y, int z) {
        long k = key(x, y, z);
        Integer cached = breakCosts.get(k);
        if (cached != null) return cached;
        int cost = computeBreakCost(x, y, z);
        breakCosts.put(k, cost);
        return cost;
    }

    private int computeBreakCost(int x, int y, int z) {
        byte c = cls(x, y, z);
        if (c != SOLID && c != OBSTACLE && c != SLAB) return -1;
        Block b = world.getBlock(x, y, z);
        if (b.getBlockHardness(world, x, y, z) < 0.0F) return -1;
        if (world.getTileEntity(x, y, z) != null) return -1;
        boolean own = ownScaffold.contains(key(x, y, z)) && Rules.isFiller(b);
        if (!own && !(gentle ? rule.isJob(world, x, y, z, b) : rule.mayBreak(world, x, y, z, b))) return -1;
        // Opening a cell next to lava, or under any liquid, lets it flow in.
        for (int[] d : SIDES) {
            byte n = cls(x + d[0], y + d[1], z + d[2]);
            if (n == HAZARD) return -1;
        }
        if (cls(x, y + 1, z) == WATER) return -1;
        // Which tool is best depends on the kind of block, not on where it is; asking is costly, so ask once.
        int kind = Block.getIdFromBlock(b) * 16 + (world.getBlockMetadata(x, y, z) & 15);
        Integer known = digTicks.get(kind);
        if (known == null) {
            Tools.Choice choice = Tools.best(player, world, x, y, z);
            int ticks = choice == null || !choice.worthwhile() ? -1 : choice.ticks();
            known = ticks < 0 || ticks > 400 ? -1 : ticks + 6;
            digTicks.put(kind, known);
        }
        // Priced low on purpose: coming down through its own pillar tidies up after the bot.
        if (own && known > 0) return 1;
        return known;
    }

    private static final int[][] SIDES = { { 1, 0, 0 }, { -1, 0, 0 }, { 0, 0, 1 }, { 0, 0, -1 }, { 0, 1, 0 },
        { 0, -1, 0 } };
}
