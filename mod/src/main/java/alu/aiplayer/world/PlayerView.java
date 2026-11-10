package alu.aiplayer.world;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.inventory.IInventory;
import net.minecraft.tileentity.TileEntity;
import net.minecraft.util.MovingObjectPosition;
import net.minecraft.util.Vec3;
import net.minecraft.world.World;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.act.Drawers;
import alu.aiplayer.act.Machines;
import alu.aiplayer.util.J;
import alu.aiplayer.util.Names;

/**
 * Where a player stands, which way they look and what they point at.
 * <p>
 * People say "this chest" and "over there". Someone standing next to them understands because they see where the
 * speaker is and what the speaker is looking at; this is that knowledge, so that it can travel with the words.
 */
public final class PlayerView {

    private PlayerView() {}

    private static final double POINT_RANGE = 48.0;
    private static final int AHEAD_RANGE = 12;
    private static final int AHEAD_LIMIT = 6;
    private static final String[] COMPASS = { "south", "west", "north", "east" };
    private static final String[] SIDE = { "down", "up", "north", "south", "west", "east" };

    public static JsonObject describe(EntityPlayer p) {
        JsonObject o = new JsonObject();
        o.addProperty("dim", p.dimension);
        o.add("pos", J.pos(p.posX, p.posY, p.posZ));
        o.add("block", J.pos((int) Math.floor(p.posX), (int) Math.floor(p.posY), (int) Math.floor(p.posZ)));
        o.addProperty("yaw", J.round(wrap(p.rotationYaw)));
        o.addProperty("pitch", J.round(p.rotationPitch));
        o.addProperty("facing", p.rotationPitch < -60 ? "up" : p.rotationPitch > 60 ? "down" : compass(p.rotationYaw));

        World w = p.worldObj;
        Vec3 eye = Vec3.createVectorHelper(p.posX, p.posY + p.getEyeHeight(), p.posZ);
        Vec3 look = direction(p.rotationYaw, p.rotationPitch);
        Vec3 end = Vec3.createVectorHelper(
            eye.xCoord + look.xCoord * POINT_RANGE,
            eye.yCoord + look.yCoord * POINT_RANGE,
            eye.zCoord + look.zCoord * POINT_RANGE);
        try {
            MovingObjectPosition hit = w.func_147447_a(
                Vec3.createVectorHelper(eye.xCoord, eye.yCoord, eye.zCoord),
                end,
                false,
                false,
                true);
            if (hit != null && hit.typeOfHit == MovingObjectPosition.MovingObjectType.BLOCK) {
                JsonObject at = thing(w, hit.blockX, hit.blockY, hit.blockZ);
                if (hit.sideHit >= 0 && hit.sideHit < 6) at.addProperty("side", SIDE[hit.sideHit]);
                double dx = hit.blockX + 0.5 - eye.xCoord, dy = hit.blockY + 0.5 - eye.yCoord, dz = hit.blockZ + 0.5 - eye.zCoord;
                at.addProperty("dist", J.round(Math.sqrt(dx * dx + dy * dy + dz * dz)));
                o.add("lookingAt", at);
            }
        } catch (Throwable ignored) {
            // A block with an odd shape can throw here; then there is simply nothing pointed at.
        }
        o.add("ahead", ahead(w, eye, look));
        return o;
    }

    /** The containers in front of the player, the ones most squarely in view and nearest first. */
    private static JsonArray ahead(World w, Vec3 eye, Vec3 look) {
        int ex = (int) Math.floor(eye.xCoord), ey = (int) Math.floor(eye.yCoord), ez = (int) Math.floor(eye.zCoord);
        final List<Object[]> seen = new ArrayList<>();
        for (TileEntity te : WorldQueries
            .tileEntities(w, ex - AHEAD_RANGE, ez - AHEAD_RANGE, ex + AHEAD_RANGE, ez + AHEAD_RANGE)) {
            if (!(te instanceof IInventory) || Math.abs(te.yCoord - ey) > AHEAD_RANGE) continue;
            double dx = te.xCoord + 0.5 - eye.xCoord, dy = te.yCoord + 0.5 - eye.yCoord, dz = te.zCoord + 0.5 - eye.zCoord;
            double dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > AHEAD_RANGE || dist < 0.01) continue;
            double cos = (dx * look.xCoord + dy * look.yCoord + dz * look.zCoord) / dist;
            // Roughly what fills the screen: within 50 degrees of where they look.
            if (cos < 0.64) continue;
            // Squarely ahead beats near: a chest two blocks off to the side is not "the one in front of me".
            seen.add(new Object[] { te, dist, dist * (2.0 - cos) });
        }
        Collections.sort(seen, (a, b) -> Double.compare((Double) a[2], (Double) b[2]));
        JsonArray out = new JsonArray();
        for (Object[] s : seen) {
            if (out.size() >= AHEAD_LIMIT) break;
            TileEntity te = (TileEntity) s[0];
            JsonObject c = thing(w, te.xCoord, te.yCoord, te.zCoord);
            c.addProperty("dist", J.round((Double) s[1]));
            JsonArray attached = WorldQueries.attached(w, te);
            if (attached.size() > 0) c.add("attached", attached);
            out.add(c);
        }
        return out;
    }

    private static JsonObject thing(World w, int x, int y, int z) {
        JsonObject o = J.pos(x, y, z);
        Block b = w.getBlock(x, y, z);
        TileEntity te = w.getTileEntity(x, y, z);
        o.addProperty("id", Names.blockId(b));
        o.addProperty("meta", w.getBlockMetadata(x, y, z));
        String machine = Machines.name(te);
        o.addProperty("name", machine != null ? machine : WorldQueries.blockName(b, w.getBlockMetadata(x, y, z)));
        if (Drawers.isController(te)) o.addProperty("kind", "drawer_controller");
        else if (Drawers.is(te)) o.addProperty("kind", "drawers");
        else if (machine != null) o.addProperty("kind", "machine");
        else if (te instanceof IInventory) o.addProperty("kind", "container");
        return o;
    }

    private static Vec3 direction(float yaw, float pitch) {
        double y = Math.toRadians(yaw), p = Math.toRadians(pitch);
        return Vec3.createVectorHelper(-Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p));
    }

    private static float wrap(float yaw) {
        float r = yaw % 360f;
        if (r >= 180f) r -= 360f;
        if (r < -180f) r += 360f;
        return r;
    }

    private static String compass(float yaw) {
        return COMPASS[Math.floorMod(Math.round(wrap(yaw) / 90f), 4)];
    }
}
