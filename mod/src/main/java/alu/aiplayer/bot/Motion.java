package alu.aiplayer.bot;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.util.MathHelper;

/**
 * What the bot's "keyboard and mouse" are doing this tick. Tasks set these every tick they want movement; the bot
 * applies them to the entity before the physics step and then clears them, so a task that stops asking stops moving.
 */
public final class Motion {

    private static final float MAX_TURN_PER_TICK = 50.0F;

    private boolean moving;
    private double dirX;
    private double dirZ;
    public boolean jump;
    public boolean sneak;
    private boolean looking;
    private float lookYaw;
    private float lookPitch;

    /** Walk horizontally toward a point this tick. */
    public void moveToward(EntityPlayerMP p, double x, double z) {
        double dx = x - p.posX;
        double dz = z - p.posZ;
        double len = Math.sqrt(dx * dx + dz * dz);
        if (len < 1.0e-4) {
            moving = false;
            return;
        }
        moving = true;
        dirX = dx / len;
        dirZ = dz / len;
    }

    /** Turn the head toward a point; without this the bot faces where it walks. */
    public void lookAt(EntityPlayerMP p, double x, double y, double z) {
        float[] yp = angles(p, x, y, z);
        looking = true;
        lookYaw = yp[0];
        lookPitch = yp[1];
    }

    public void clear() {
        moving = false;
        jump = false;
        sneak = false;
        looking = false;
    }

    /** Writes the inputs into the entity the way a client's movement input would. */
    void apply(EntityPlayerMP p) {
        float targetYaw = p.rotationYaw;
        float targetPitch = p.rotationPitch;
        if (looking) {
            targetYaw = lookYaw;
            targetPitch = lookPitch;
        } else if (moving) {
            targetYaw = (float) (Math.atan2(-dirX, dirZ) * 180.0 / Math.PI);
            targetPitch = 0.0F;
        }
        p.rotationYaw = approach(p.rotationYaw, targetYaw, MAX_TURN_PER_TICK);
        p.rotationPitch = MathHelper
            .clamp_float(p.rotationPitch + clampDelta(targetPitch - p.rotationPitch, MAX_TURN_PER_TICK), -90.0F, 90.0F);
        p.rotationYawHead = p.rotationYaw;

        float forward = 0.0F;
        float strafe = 0.0F;
        if (moving) {
            // Decompose the wanted world direction onto the body axes, so the bot can walk one way while it is
            // still turning or looking another.
            double rad = p.rotationYaw * Math.PI / 180.0;
            double sin = Math.sin(rad);
            double cos = Math.cos(rad);
            forward = (float) (dirX * -sin + dirZ * cos);
            strafe = (float) (dirX * cos + dirZ * sin);
            if (sneak) {
                forward *= 0.3F;
                strafe *= 0.3F;
            }
        }
        p.moveForward = forward;
        p.moveStrafing = strafe;
        p.setJumping(jump);
        if (p.isSneaking() != sneak) p.setSneaking(sneak);
    }

    /** Snaps the view to a point immediately, for actions whose result depends on where the player looks. */
    public static void face(EntityPlayerMP p, double x, double y, double z) {
        float[] yp = angles(p, x, y, z);
        p.rotationYaw = yp[0];
        p.rotationPitch = yp[1];
        p.rotationYawHead = yp[0];
    }

    private static float[] angles(EntityPlayerMP p, double x, double y, double z) {
        double dx = x - p.posX;
        double dy = y - (p.posY + p.getEyeHeight());
        double dz = z - p.posZ;
        double horiz = Math.sqrt(dx * dx + dz * dz);
        float yaw = horiz < 1.0e-4 ? p.rotationYaw : (float) (Math.atan2(-dx, dz) * 180.0 / Math.PI);
        float pitch = (float) (-Math.atan2(dy, horiz) * 180.0 / Math.PI);
        return new float[] { yaw, pitch };
    }

    private static float approach(float current, float target, float maxStep) {
        float delta = MathHelper.wrapAngleTo180_float(target - current);
        return current + clampDelta(delta, maxStep);
    }

    private static float clampDelta(float delta, float maxStep) {
        return delta > maxStep ? maxStep : (delta < -maxStep ? -maxStep : delta);
    }
}
