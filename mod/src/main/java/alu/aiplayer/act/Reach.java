package alu.aiplayer.act;

import net.minecraft.entity.player.EntityPlayerMP;

/** How far a survival player's arm goes, measured the way the client does: from the eyes. */
public final class Reach {

    private Reach() {}

    public static final double BLOCK_REACH = 4.5;
    /** Reach assumed when choosing where to stand, leaving room for not standing exactly mid-cell. */
    public static final double PLANNING_REACH = 4.1;
    public static final double EYE_HEIGHT = 1.62;

    public static boolean canReach(EntityPlayerMP p, int x, int y, int z) {
        return canReachFrom(p.posX, p.posY, p.posZ, x, y, z);
    }

    /** Whether a player standing with feet at the given position can touch the block. */
    public static boolean canReachFrom(double px, double feetY, double pz, int x, int y, int z) {
        return distanceSq(px, feetY + EYE_HEIGHT, pz, x, y, z) <= BLOCK_REACH * BLOCK_REACH;
    }

    /** Like {@link #canReachFrom}, with the margin used for planning a standing spot. */
    public static boolean canPlanReachFrom(double px, double feetY, double pz, int x, int y, int z) {
        return distanceSq(px, feetY + EYE_HEIGHT, pz, x, y, z) <= PLANNING_REACH * PLANNING_REACH;
    }

    /** Squared distance from a point to the nearest point of a block. */
    public static double distanceSq(double ex, double ey, double ez, int x, int y, int z) {
        double dx = ex < x ? x - ex : (ex > x + 1 ? ex - (x + 1) : 0);
        double dy = ey < y ? y - ey : (ey > y + 1 ? ey - (y + 1) : 0);
        double dz = ez < z ? z - ez : (ez > z + 1 ? ez - (z + 1) : 0);
        return dx * dx + dy * dy + dz * dz;
    }

    /** The block face (0 down, 1 up, 2 north, 3 south, 4 west, 5 east) most turned toward the player's eyes. */
    public static int facingSide(EntityPlayerMP p, int x, int y, int z) {
        double dx = p.posX - (x + 0.5);
        double dy = p.posY + EYE_HEIGHT - (y + 0.5);
        double dz = p.posZ - (z + 0.5);
        double ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
        if (ay >= ax && ay >= az) return dy > 0 ? 1 : 0;
        if (ax >= az) return dx > 0 ? 5 : 4;
        return dz > 0 ? 3 : 2;
    }
}
