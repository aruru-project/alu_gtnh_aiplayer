package alu.aiplayer.nav;

import alu.aiplayer.act.Reach;

/** Where a path should end. Positions are feet cells. */
public abstract class Goal {

    static final double WALK = 4.7;

    public abstract boolean reached(int x, int y, int z);

    /** A lower bound on the remaining cost, in ticks. */
    public abstract double heuristic(int x, int y, int z);

    /** Within a horizontal range of a block position, and about level with it. */
    public static Goal near(final int gx, final int gy, final int gz, final int range) {
        return new Goal() {

            @Override
            public boolean reached(int x, int y, int z) {
                int dx = x - gx, dz = z - gz;
                return dx * dx + dz * dz <= range * range && Math.abs(y - gy) <= Math.max(1, range);
            }

            @Override
            public double heuristic(int x, int y, int z) {
                int flat = Math.max(0, Math.abs(x - gx) + Math.abs(z - gz) - range);
                int vert = Math.max(0, Math.abs(y - gy) - Math.max(1, range));
                return flat * WALK + vert * 6.0;
            }
        };
    }

    /**
     * Anywhere the block can be touched from. With {@code clear}, the bot must also not occupy the block's cell,
     * which placing a block there requires.
     */
    public static Goal reach(final int bx, final int by, final int bz, final boolean clear) {
        return new Goal() {

            @Override
            public boolean reached(int x, int y, int z) {
                if (clear && x == bx && z == bz && (y == by || y + 1 == by)) return false;
                return Reach.canPlanReachFrom(x + 0.5, y, z + 0.5, bx, by, bz);
            }

            @Override
            public double heuristic(int x, int y, int z) {
                int flat = Math.max(0, Math.abs(x - bx) + Math.abs(z - bz) - 4);
                int dy = by - y;
                // Reach extends about five blocks up from the feet and three down.
                int vert = dy > 5 ? dy - 5 : (dy < -3 ? -3 - dy : 0);
                return flat * WALK + vert * 6.0;
            }
        };
    }
}
