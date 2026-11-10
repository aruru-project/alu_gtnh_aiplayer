package alu.aiplayer.nav;

import alu.aiplayer.act.Reach;

/** Where a path should end. Positions are feet cells. */
public abstract class Goal {

    static final double WALK = 4.7;

    public abstract boolean reached(int x, int y, int z);

    /** A lower bound on the remaining cost, in ticks. */
    public abstract double heuristic(int x, int y, int z);

    /**
     * Within a horizontal range of a block position, and about level with it: up to two blocks off in height (four
     * for a wide range), so a position read off a map or a player still counts when the ground there is a little
     * higher or lower.
     */
    public static Goal near(final int gx, final int gy, final int gz, final int range) {
        final int slack = Math.max(2, Math.min(4, range));
        return new Goal() {

            @Override
            public boolean reached(int x, int y, int z) {
                int dx = x - gx, dz = z - gz;
                return dx * dx + dz * dz <= range * range && Math.abs(y - gy) <= slack;
            }

            @Override
            public double heuristic(int x, int y, int z) {
                int flat = Math.max(0, Math.abs(x - gx) + Math.abs(z - gz) - range);
                int vert = Math.max(0, Math.abs(y - gy) - slack);
                return flat * WALK + vert * 6.0;
            }
        };
    }

    /** Within a horizontal range of a column, at whatever height the ground is. */
    public static Goal column(final int gx, final int gz, final int range) {
        return new Goal() {

            @Override
            public boolean reached(int x, int y, int z) {
                int dx = x - gx, dz = z - gz;
                return dx * dx + dz * dz <= range * range;
            }

            @Override
            public double heuristic(int x, int y, int z) {
                return Math.max(0, Math.abs(x - gx) + Math.abs(z - gz) - range) * WALK;
            }
        };
    }

    /**
     * Within reach of a block and on the side one of its faces looks at (2 north, 3 south, 4 west, 5 east), for
     * things that are used from the front only.
     */
    public static Goal reachFacing(final int bx, final int by, final int bz, final int side) {
        return new Goal() {

            @Override
            public boolean reached(int x, int y, int z) {
                boolean front;
                switch (side) {
                    case 2:
                        front = z < bz;
                        break;
                    case 3:
                        front = z > bz;
                        break;
                    case 4:
                        front = x < bx;
                        break;
                    case 5:
                        front = x > bx;
                        break;
                    default:
                        front = true;
                        break;
                }
                return front && Reach.canPlanReachFrom(x + 0.5, y, z + 0.5, bx, by, bz);
            }

            @Override
            public double heuristic(int x, int y, int z) {
                int flat = Math.max(0, Math.abs(x - bx) + Math.abs(z - bz) - 4);
                int dy = by - y;
                int vert = dy > 5 ? dy - 5 : (dy < -3 ? -3 - dy : 0);
                return flat * WALK + vert * 6.0;
            }
        };
    }

    /**
     * Somewhere to put a block from that is not below it: within reach, out of its cell, feet at its level or
     * higher. Building this way a bot cannot close a floor or a roof over its own head.
     */
    public static Goal reachFromAbove(final int bx, final int by, final int bz) {
        return new Goal() {

            @Override
            public boolean reached(int x, int y, int z) {
                if (y < by || (x == bx && z == bz && y == by)) return false;
                return Reach.canPlanReachFrom(x + 0.5, y, z + 0.5, bx, by, bz);
            }

            @Override
            public double heuristic(int x, int y, int z) {
                int flat = Math.max(0, Math.abs(x - bx) + Math.abs(z - bz) - 4);
                int dy = by - y;
                // Every block of height still to gain costs a jump at the least; saying so keeps the search from
                // wandering the ground when the only way is up.
                return flat * WALK + (dy > 0 ? dy * 9.0 : (dy < -3 ? (-3 - dy) * 2.0 : 0.0));
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
