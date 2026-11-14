package alu.aiplayer.act;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.MathHelper;
import net.minecraft.util.MovingObjectPosition;
import net.minecraft.util.Vec3;
import net.minecraft.world.World;

import com.google.gson.JsonObject;

import alu.aiplayer.nav.Goal;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/**
 * What a player's look meets. Two rays matter when a player right-clicks. The client's crosshair goes through
 * liquids and picks the first solid block within 4.5 blocks: that block is clicked, and if the click comes to
 * nothing the client also uses the item in the air. Then the item may cast a ray of its own along the same look
 * (a bucket, a cell: 5 blocks, stopping at a liquid source): that is how a liquid is taken, since no click can be
 * aimed at a liquid. So to use a thing on a liquid a player looks at the liquid from where it can be seen.
 */
public final class Sight {

    private Sight() {}

    /** How far a survival client's crosshair reaches. */
    public static final double CROSSHAIR_REACH = 4.5;
    private static final String[] SIDES = { "down", "up", "north", "south", "west", "east" };

    /** The eyes, as the game puts them for an item's ray (feet plus the eye height). */
    public static Vec3 eyes(EntityPlayerMP p) {
        return Vec3.createVectorHelper(p.posX, p.posY + p.getEyeHeight(), p.posZ);
    }

    /** The look as a unit vector, worked out from yaw and pitch the way the game's items do. */
    public static Vec3 look(EntityPlayerMP p) {
        float yaw = p.rotationYaw, pitch = p.rotationPitch;
        float f3 = MathHelper.cos(-yaw * 0.017453292F - (float) Math.PI);
        float f4 = MathHelper.sin(-yaw * 0.017453292F - (float) Math.PI);
        float f5 = -MathHelper.cos(-pitch * 0.017453292F);
        float f6 = MathHelper.sin(-pitch * 0.017453292F);
        return Vec3.createVectorHelper(f4 * f5, f6, f3 * f5);
    }

    private static MovingObjectPosition ray(EntityPlayerMP p, double reach, boolean liquids, boolean ignoreNoBox) {
        Vec3 from = eyes(p);
        Vec3 dir = look(p);
        Vec3 to = from.addVector(dir.xCoord * reach, dir.yCoord * reach, dir.zCoord * reach);
        MovingObjectPosition mo = p.worldObj.func_147447_a(from, to, liquids, ignoreNoBox, false);
        return mo != null && mo.typeOfHit == MovingObjectPosition.MovingObjectType.BLOCK ? mo : null;
    }

    /** The block a player's crosshair is on: the first solid one within reach; liquids are looked through. */
    public static MovingObjectPosition crosshair(EntityPlayerMP p) {
        return ray(p, CROSSHAIR_REACH, false, false);
    }

    /** What an item that takes liquids (a bucket, a cell) meets along the look: the first block or liquid source. */
    public static MovingObjectPosition itemRay(EntityPlayerMP p) {
        return ray(p, p.theItemInWorldManager.getBlockReachDistance(), true, false);
    }

    /** {x,y,z,side,block} of a ray's hit, for a task's result. */
    public static JsonObject json(World w, MovingObjectPosition mo) {
        JsonObject o = J.pos(mo.blockX, mo.blockY, mo.blockZ);
        o.addProperty("side", mo.sideHit >= 0 && mo.sideHit < 6 ? SIDES[mo.sideHit] : "?");
        Block b = w.getBlock(mo.blockX, mo.blockY, mo.blockZ);
        o.addProperty("block", Names.blockId(b) + "/" + w.getBlockMetadata(mo.blockX, mo.blockY, mo.blockZ));
        return o;
    }

    // ---- seeing a block -------------------------------------------------------------------------------------

    private static final float[][] POINTS = { { 0.5F, 0.5F }, { 0.25F, 0.25F }, { 0.75F, 0.25F }, { 0.25F, 0.75F },
        { 0.75F, 0.75F } };

    /**
     * The points of a liquid's face to try, the middle first. More of them than for a block: which one is looked at
     * decides whether the crosshair, going on through the liquid, lands on a block within reach.
     */
    private static final float[][] LIQUID_POINTS;
    static {
        float[] at = { 0.5F, 0.3F, 0.7F, 0.1F, 0.9F };
        LIQUID_POINTS = new float[at.length * at.length][];
        int n = 0;
        for (int s = 0; s < at.length; s++) for (int i = 0; i <= s; i++) {
            LIQUID_POINTS[n++] = new float[] { at[i], at[s] };
            if (i != s) LIQUID_POINTS[n++] = new float[] { at[s], at[i] };
        }
    }

    /** A point on a face of a block, each 0..1 from its lowest corner; {@code u, v} run across the face. */
    private static double[] point(int face, float u, float v) {
        switch (face) {
            case 0:
                return new double[] { u, 0, v };
            case 1:
                return new double[] { u, 1, v };
            case 2:
                return new double[] { u, v, 0 };
            case 3:
                return new double[] { u, v, 1 };
            case 4:
                return new double[] { 0, v, u };
            default:
                return new double[] { 1, v, u };
        }
    }

    private static final int[][] OUT = { { 0, -1, 0 }, { 0, 1, 0 }, { 0, 0, -1 }, { 0, 0, 1 }, { -1, 0, 0 }, { 1, 0, 0 } };

    /**
     * Whether eyes at (ex, ey, ez) see the point on the block's face: the face is turned to them, the point is within
     * {@code reach}, and nothing but the block itself stops a look at it. With {@code liquids} a liquid source stops
     * the look, as it stops a bucket's (that is how a liquid is seen); without, liquids are looked through, as the
     * crosshair does. Flowing liquid never stops it.
     */
    public static boolean sees(World w, double ex, double ey, double ez, int x, int y, int z, int face, double[] at,
        double reach, boolean liquids) {
        double px = x + at[0], py = y + at[1], pz = z + at[2];
        // The face turned to the eyes.
        double dx = ex - px, dy = ey - py, dz = ez - pz;
        if (dx * OUT[face][0] + dy * OUT[face][1] + dz * OUT[face][2] <= 0.05) return false;
        double d2 = (px - ex) * (px - ex) + (py - ey) * (py - ey) + (pz - ez) * (pz - ez);
        if (d2 > reach * reach) return false;
        // A little way into the block, so that the block itself is met.
        double len = Math.sqrt(d2);
        if (len < 1.0e-3) return false;
        double ix = px + (px - ex) / len * 0.3, iy = py + (py - ey) / len * 0.3, iz = pz + (pz - ez) / len * 0.3;
        MovingObjectPosition mo = w.func_147447_a(
            Vec3.createVectorHelper(ex, ey, ez),
            Vec3.createVectorHelper(ix, iy, iz),
            liquids,
            false,
            false);
        if (mo == null || mo.typeOfHit != MovingObjectPosition.MovingObjectType.BLOCK) return true;
        return mo.blockX == x && mo.blockY == y && mo.blockZ == z;
    }

    /** The faces to try, the one asked for alone or all of them (the top first: that is where a liquid is seen). */
    private static int[] faces(int side) {
        return side >= 0 ? new int[] { side } : new int[] { 1, 2, 3, 4, 5, 0 };
    }

    /**
     * A point of the block that the player sees from where it stands, within the crosshair's reach: {face, x, y, z}
     * with x, y, z each 0..1 from the block's lowest corner. {@code hit} given: that point only. Null when none.
     */
    public static double[] lookPoint(EntityPlayerMP p, int x, int y, int z, int side, float[] hit, boolean liquids) {
        double ex = p.posX, ey = p.posY + p.getEyeHeight(), ez = p.posZ;
        // A liquid: a point past which the crosshair lands on a block (the bottom under it, the wall behind it), when
        // there is one. A player looks there, so the click goes to a block: some items take a liquid only from a
        // click on a block (an IC2 cell), none from a click at nothing.
        double[] seenOnly = null;
        for (int face : faces(side)) {
            if (hit != null) {
                double[] at = { hit[0], hit[1], hit[2] };
                if (sees(p.worldObj, ex, ey, ez, x, y, z, face, at, CROSSHAIR_REACH, liquids)) return new double[] { face, at[0], at[1], at[2] };
                continue;
            }
            for (float[] uv : liquids ? LIQUID_POINTS : POINTS) {
                double[] at = point(face, uv[0], uv[1]);
                if (!sees(p.worldObj, ex, ey, ez, x, y, z, face, at, CROSSHAIR_REACH, liquids)) continue;
                double[] r = { face, at[0], at[1], at[2] };
                if (!liquids || landsOnBlock(p.worldObj, ex, ey, ez, x + at[0], y + at[1], z + at[2])) return r;
                if (seenOnly == null) seenOnly = r;
            }
        }
        return seenOnly;
    }

    /** Whether the crosshair, looking from the eyes at that point, lands on a block within reach (liquids looked through). */
    private static boolean landsOnBlock(World w, double ex, double ey, double ez, double px, double py, double pz) {
        double dx = px - ex, dy = py - ey, dz = pz - ez;
        double len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1.0e-3) return false;
        // A little short of the full reach: the look is set from yaw and pitch, which round.
        double k = (CROSSHAIR_REACH - 0.05) / len;
        MovingObjectPosition mo = w.func_147447_a(
            Vec3.createVectorHelper(ex, ey, ez),
            Vec3.createVectorHelper(ex + dx * k, ey + dy * k, ez + dz * k),
            false,
            false,
            false);
        return mo != null && mo.typeOfHit == MovingObjectPosition.MovingObjectType.BLOCK;
    }

    /** Somewhere to stand from which a face of the block is seen (its middle), within reach. */
    public static Goal seeing(final World w, final int x, final int y, final int z, final int side, final boolean liquids) {
        return seeing(w, x, y, z, side, liquids, null);
    }

    public static Goal seeing(final World w, final int x, final int y, final int z, final int side, final boolean liquids,
        final float[] hit) {
        return new Goal() {

            @Override
            public boolean reached(EntityPlayerMP p) {
                return lookPoint(p, x, y, z, side, hit, liquids) != null;
            }

            @Override
            public boolean reached(int sx, int sy, int sz) {
                if (sx == x && sz == z && (sy == y || sy + 1 == y)) return false;
                double ex = sx + 0.5, ey = sy + Reach.EYE_HEIGHT, ez = sz + 0.5;
                for (int face : faces(side)) {
                    if (sees(w, ex, ey, ez, x, y, z, face, point(face, 0.5F, 0.5F), Reach.PLANNING_REACH, liquids)) return true;
                }
                return false;
            }

            @Override
            public double heuristic(int sx, int sy, int sz) {
                int flat = Math.max(0, Math.abs(sx - x) + Math.abs(sz - z) - 4);
                int dy = y - sy;
                int vert = dy > 5 ? dy - 5 : (dy < -3 ? -3 - dy : 0);
                return flat * 4.7 + vert * 6.0;
            }
        };
    }
}
