package alu.aiplayer.act;

import java.util.IdentityHashMap;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.block.BlockDoor;
import net.minecraft.block.BlockFenceGate;
import net.minecraft.block.material.Material;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.world.World;

import alu.aiplayer.AiPlayerMod;
import alu.aiplayer.util.Names;

/**
 * Doors and gates a player opens with a right-click. Iron doors, which only redstone moves, are not among them.
 * Besides the vanilla kinds (and the many mod doors built on them), the blocks listed in the configuration count:
 * garage doors and the like, which have their own classes.
 */
public final class Doors {

    private Doors() {}

    public static final int NONE = 0, CLOSED = 1, OPEN = 2;

    private static final Map<Block, Integer> KIND = new IdentityHashMap<>();

    /** 0 not a door, 1 a vanilla-style door, 2 a gate, 3 a configured door block. */
    private static int kind(Block b) {
        Integer known = KIND.get(b);
        if (known != null) return known;
        int k = 0;
        if (b instanceof BlockDoor) k = b.getMaterial() == Material.iron ? 0 : 1;
        else if (b instanceof BlockFenceGate) k = 2;
        else if (AiPlayerMod.config().doorBlocks.contains(Names.blockId(b))) k = 3;
        KIND.put(b, k);
        return k;
    }

    public static boolean isDoor(Block b) {
        return kind(b) != 0;
    }

    public static int state(World w, int x, int y, int z, Block b) {
        switch (kind(b)) {
            case 1:
                return ((BlockDoor) b).func_150015_f(w, x, y, z) ? OPEN : CLOSED;
            case 2:
                return BlockFenceGate.isFenceGateOpen(w.getBlockMetadata(x, y, z)) ? OPEN : CLOSED;
            case 3: {
                // Whatever the block is, open means there is nothing left to walk into.
                AxisAlignedBB box;
                try {
                    box = b.getCollisionBoundingBoxFromPool(w, x, y, z);
                } catch (Throwable t) {
                    return CLOSED;
                }
                return box == null || box.maxY - y <= 0.26 ? OPEN : CLOSED;
            }
            default:
                return NONE;
        }
    }
}
