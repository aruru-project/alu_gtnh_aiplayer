package alu.aiplayer.act;

import net.minecraft.entity.Entity;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.util.MovingObjectPosition;
import net.minecraft.util.Vec3;
import net.minecraft.world.World;

import alu.aiplayer.nav.Goal;

/** The ordinary survival client's 3-block entity crosshair, not the server's more permissive packet distance. */
public final class EntityReach {

    private EntityReach() {}

    public static Vec3 point(EntityPlayerMP player, Entity target, boolean attack) {
        // GTNH's Battlegear2 shortens an empty hand's attack range to 2.3 blocks between entity feet.
        // Approach to 2 for attacks (also safe for ordinary weapons); still let the real event decide.
        if (attack && player.getDistanceSqToEntity(target) > 4) return null;
        if (!target.canBeCollidedWith()) return null;
        Vec3 eye = Vec3.createVectorHelper(player.posX, player.posY + player.getEyeHeight(), player.posZ);
        Vec3 point = point(player.worldObj, eye, target.boundingBox, 3.0);
        if (point == null || player.getDistanceSqToEntity(target) >= 36) return null;
        // A nearer collidable entity, just like a wall, takes the crosshair. Never click through it.
        AxisAlignedBB scan = AxisAlignedBB.getBoundingBox(Math.min(eye.xCoord, point.xCoord), Math.min(eye.yCoord, point.yCoord), Math.min(eye.zCoord, point.zCoord), Math.max(eye.xCoord, point.xCoord), Math.max(eye.yCoord, point.yCoord), Math.max(eye.zCoord, point.zCoord)).expand(1, 1, 1);
        for (Object value : player.worldObj.getEntitiesWithinAABBExcludingEntity(player, scan)) {
            Entity other = (Entity) value;
            if (other == target || !other.canBeCollidedWith()) continue;
            float border = other.getCollisionBorderSize();
            AxisAlignedBB box = other.boundingBox.expand(border, border, border);
            MovingObjectPosition hit = box.calculateIntercept(eye, point);
            if (box.isVecInside(eye) || (hit != null && eye.distanceTo(hit.hitVec) < eye.distanceTo(point) - 0.01)) return null;
        }
        return point;
    }

    /** A snapshot goal, replaced when the animal moves; searching must not chase a changing heuristic. */
    public static Goal goal(final World world, Entity target, final boolean attack) {
        final AxisAlignedBB box = target.boundingBox.copy();
        final double tx = target.posX, ty = target.posY, tz = target.posZ;
        return new Goal() {
            @Override
            public boolean reached(int x, int y, int z) {
                double dx = x + 0.5 - tx, dy = y - ty, dz = z + 0.5 - tz;
                return (!attack || dx * dx + dy * dy + dz * dz <= 3.24)
                    && point(world, Vec3.createVectorHelper(x + 0.5, y + 1.62, z + 0.5), box, 2.8) != null;
            }

            @Override
            public double heuristic(int x, int y, int z) {
                double dx = x + 0.5 - tx, dy = y - ty, dz = z + 0.5 - tz;
                return Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - 3) * 4.7;
            }
        };
    }

    private static Vec3 point(World world, Vec3 eye, AxisAlignedBB box, double reach) {
        double mx = (box.minX + box.maxX) * 0.5, my = (box.minY + box.maxY) * 0.5, mz = (box.minZ + box.maxZ) * 0.5;
        double x = Math.max(box.minX + 0.01, Math.min(box.maxX - 0.01, eye.xCoord));
        double y = Math.max(box.minY + 0.01, Math.min(box.maxY - 0.01, eye.yCoord));
        double z = Math.max(box.minZ + 0.01, Math.min(box.maxZ - 0.01, eye.zCoord));
        double[][] points = { { x, y, z }, { mx, my, mz }, { mx, box.maxY - 0.05, mz }, { mx, box.minY + 0.05, mz } };
        for (double[] at : points) {
            Vec3 p = Vec3.createVectorHelper(at[0], at[1], at[2]);
            if (eye.distanceTo(p) <= reach && world.func_147447_a(eye, p, false, true, false) == null) return p;
        }
        return null;
    }
}
