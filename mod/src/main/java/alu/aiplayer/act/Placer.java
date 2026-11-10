package alu.aiplayer.act;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.world.World;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.Motion;

/**
 * Places one block from the inventory by right-clicking a neighbouring block's face, as a player must: there has
 * to be something to click on, within reach, and the bot may not be standing in the way.
 */
public final class Placer {

    private Placer() {}

    public enum Result {
        PLACED,
        /** The cell already holds a block. */
        OCCUPIED,
        NO_ITEM,
        /** No neighbouring block to place against. */
        NO_SUPPORT,
        OUT_OF_REACH,
        /** The bot itself stands in the cell. */
        IN_THE_WAY,
        /** The click went through but no block appeared (protection, another entity, a block that refuses). */
        REJECTED
    }

    // Neighbour offsets in the order they are tried, and the face of that neighbour that looks at the cell.
    private static final int[][] NEIGHBOURS = { { 0, -1, 0, 1 }, { 0, 0, -1, 3 }, { 0, 0, 1, 2 }, { -1, 0, 0, 5 },
        { 1, 0, 0, 4 }, { 0, 1, 0, 0 } };

    public static boolean isReplaceable(World w, int x, int y, int z) {
        Block b = w.getBlock(x, y, z);
        return b.isAir(w, x, y, z) || b.isReplaceable(w, x, y, z);
    }

    /** Whether some neighbour offers a face to place against. */
    public static boolean hasSupport(World w, int x, int y, int z) {
        for (int[] n : NEIGHBOURS) {
            if (!isReplaceable(w, x + n[0], y + n[1], z + n[2])) return true;
        }
        return false;
    }

    public static boolean bodyIntersects(EntityPlayerMP p, int x, int y, int z) {
        return p.boundingBox.intersectsWith(AxisAlignedBB.getBoundingBox(x, y, z, x + 1, y + 1, z + 1));
    }

    public static Result place(Bot bot, int x, int y, int z, ItemFilter item) {
        EntityPlayerMP p = bot.player();
        World w = p.worldObj;
        if (!isReplaceable(w, x, y, z)) return Result.OCCUPIED;
        if (bodyIntersects(p, x, y, z)) return Result.IN_THE_WAY;
        int slot = Inventories.find(p, item);
        if (slot < 0) return Result.NO_ITEM;

        int[] support = null;
        boolean sawSupport = false;
        for (int[] n : NEIGHBOURS) {
            int nx = x + n[0], ny = y + n[1], nz = z + n[2];
            if (isReplaceable(w, nx, ny, nz)) continue;
            sawSupport = true;
            if (Reach.canReach(p, nx, ny, nz)) {
                support = new int[] { nx, ny, nz, n[3] };
                break;
            }
        }
        if (support == null) return sawSupport ? Result.OUT_OF_REACH : Result.NO_SUPPORT;

        Inventories.hold(bot, slot);
        int side = support[3];
        float hx = 0.5F, hy = 0.5F, hz = 0.5F;
        switch (side) {
            case 0:
                hy = 0.0F;
                break;
            case 1:
                hy = 1.0F;
                break;
            case 2:
                hz = 0.0F;
                break;
            case 3:
                hz = 1.0F;
                break;
            case 4:
                hx = 0.0F;
                break;
            default:
                hx = 1.0F;
                break;
        }
        Motion.face(p, support[0] + hx, support[1] + hy, support[2] + hz);
        // Sneaking makes the click place the block instead of opening whatever the clicked block is.
        boolean wasSneaking = p.isSneaking();
        p.setSneaking(true);
        try {
            bot.conn()
                .useOnBlock(support[0], support[1], support[2], side, hx, hy, hz);
        } finally {
            p.setSneaking(wasSneaking);
        }
        bot.conn()
            .swingArm();
        return isReplaceable(w, x, y, z) ? Result.REJECTED : Result.PLACED;
    }
}
