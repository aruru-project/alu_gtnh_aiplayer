package alu.aiplayer.act;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.ChunkCoordinates;
import net.minecraft.world.World;

import com.google.gson.JsonObject;

/**
 * The server's own refusal of a player's hand on a block, asked before the bot reaches out. The game drops a click,
 * a dig or a placement against a block it protects without a word: no event goes out, nothing changes, the screen
 * that was to open does not. Asked first, the refusal is known and can be told, with what refuses it.
 * <p>
 * What a vanilla server protects is its spawn area: in the overworld, the blocks within the spawn-protection
 * distance of the world spawn (the larger of the x and z distances, at every height), from every player who is not
 * an operator, as long as the server has operators at all.
 */
public final class Protection {

    private Protection() {}

    /**
     * Null when the server lets this player put a hand on the block there. Otherwise what refuses it: {by:"spawn
     * protection", spawn:{x,z}, range, x1, z1, x2, z2}, or {by:"the server"} when the server refuses it and the
     * spawn area does not explain why (a mod changed the rule).
     */
    public static JsonObject of(EntityPlayerMP p, int x, int y, int z) {
        MinecraftServer server = MinecraftServer.getServer();
        if (server == null || p == null) return null;
        World w = p.worldObj;
        try {
            if (!server.isBlockProtected(w, x, y, z, p)) return null;
        } catch (Throwable t) {
            return null;
        }
        JsonObject o = new JsonObject();
        ChunkCoordinates spawn = w.getSpawnPoint();
        int range = server.getSpawnProtectionSize();
        if (w.provider.dimensionId == 0 && range > 0 && Math.max(Math.abs(x - spawn.posX), Math.abs(z - spawn.posZ)) <= range) {
            o.addProperty("by", "spawn protection");
            JsonObject at = new JsonObject();
            at.addProperty("x", spawn.posX);
            at.addProperty("z", spawn.posZ);
            o.add("spawn", at);
            o.addProperty("range", range);
            o.addProperty("x1", spawn.posX - range);
            o.addProperty("z1", spawn.posZ - range);
            o.addProperty("x2", spawn.posX + range);
            o.addProperty("z2", spawn.posZ + range);
        } else {
            o.addProperty("by", "the server");
        }
        return o;
    }

    /** The refusal of the block at x, y, z, in words. */
    public static String words(JsonObject by, int x, int y, int z) {
        String block = "(" + x + "," + y + "," + z + ")";
        if (!"spawn protection".equals(
            by.get("by")
                .getAsString()))
            return "the server protects the block at " + block
                + " from the bot (its own block protection refuses it; this is not the spawn area)";
        JsonObject spawn = by.getAsJsonObject("spawn");
        return "the server's spawn protection covers the block at " + block
            + ": in the overworld, within "
            + by.get("range")
                .getAsInt()
            + " block(s) of the world spawn ("
            + spawn.get("x")
                .getAsInt()
            + ", "
            + spawn.get("z")
                .getAsInt()
            + "), that is x "
            + by.get("x1")
                .getAsInt()
            + " to "
            + by.get("x2")
                .getAsInt()
            + " and z "
            + by.get("z1")
                .getAsInt()
            + " to "
            + by.get("z2")
                .getAsInt()
            + " at every height, a player who is not a server operator can neither click, dig nor place, and the bot"
            + " is not an operator";
    }
}
