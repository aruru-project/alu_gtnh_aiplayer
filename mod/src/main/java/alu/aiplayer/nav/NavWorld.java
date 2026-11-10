package alu.aiplayer.nav;

import java.util.HashMap;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.block.material.Material;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.init.Blocks;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.world.World;

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

    /** Decides which blocks may be broken to make a path. */
    public interface BreakRule {

        boolean mayBreak(World w, int x, int y, int z, Block block);
    }

    public final World world;
    private final EntityPlayerMP player;
    private final BreakRule rule;
    private final Map<Long, Byte> classes = new HashMap<>();
    private final Map<Long, Integer> breakCosts = new HashMap<>();
    private final Map<Integer, Integer> digTicks = new HashMap<>();
    public boolean sawUnloaded;

    public NavWorld(EntityPlayerMP player, BreakRule rule) {
        this.world = player.worldObj;
        this.player = player;
        this.rule = rule;
    }

    public static long key(int x, int y, int z) {
        return ((long) (x + 30000000) << 38) | ((long) (z + 30000000) << 12) | (y & 0xFFFL);
    }

    public byte cls(int x, int y, int z) {
        if (y < 0) return OBSTACLE;
        if (y > 255) return OPEN;
        long k = key(x, y, z);
        Byte cached = classes.get(k);
        if (cached != null) return cached;
        byte c = classify(world, x, y, z);
        if (c == UNLOADED) sawUnloaded = true;
        classes.put(k, c);
        return c;
    }

    public static byte classify(World w, int x, int y, int z) {
        if (!w.blockExists(x, y, z)) return UNLOADED;
        Block b = w.getBlock(x, y, z);
        Material m = b.getMaterial();
        if (m == Material.air) return OPEN;
        if (m == Material.lava || m == Material.fire || b == Blocks.cactus) return HAZARD;
        if (m.isLiquid()) return WATER;
        AxisAlignedBB bb;
        try {
            bb = b.getCollisionBoundingBoxFromPool(w, x, y, z);
        } catch (Throwable t) {
            return OBSTACLE;
        }
        if (bb == null) return b == Blocks.web ? OBSTACLE : OPEN;
        double height = bb.maxY - y;
        if (height <= 0.26) return OPEN;
        boolean fullWidth = bb.minX <= x + 0.01 && bb.maxX >= x + 0.99 && bb.minZ <= z + 0.01 && bb.maxZ >= z + 0.99;
        if (!fullWidth) return OBSTACLE;
        if (height >= 0.85 && height <= 1.01) return SOLID;
        if (height >= 0.4 && height <= 0.6 && bb.minY <= y + 0.01) return SLAB;
        return OBSTACLE;
    }

    public boolean passable(int x, int y, int z) {
        byte c = cls(x, y, z);
        return c == OPEN || c == WATER;
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
        if (!rule.mayBreak(world, x, y, z, b)) return -1;
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
        return known;
    }

    private static final int[][] SIDES = { { 1, 0, 0 }, { -1, 0, 0 }, { 0, 0, 1 }, { 0, 0, -1 }, { 0, 1, 0 },
        { 0, -1, 0 } };
}
