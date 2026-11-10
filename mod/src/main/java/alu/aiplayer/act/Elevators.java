package alu.aiplayer.act;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.world.World;
import net.minecraftforge.common.MinecraftForge;

import alu.aiplayer.AiPlayerMod;
import cpw.mods.fml.common.eventhandler.Event;

/**
 * OpenBlocks elevators: stand on one, jump to go to the next one above, sneak for the next one below. The client
 * reports the jump or sneak to the server, which does the moving; a bot has no client, so the same report is
 * handed to the server here, and the server's own rules (range, blocks in between, cost) decide what happens.
 * <p>
 * Reached by reflection; without the mod nothing here matches.
 */
public final class Elevators {

    private Elevators() {}

    private static boolean looked;
    private static boolean usable;
    private static Class<?> blockClass;
    private static Method colour;
    private static Constructor<?> action;
    private static Object jump, sneak;
    private static Field sender;

    private static synchronized boolean available() {
        if (looked) return usable;
        looked = true;
        try {
            blockClass = Class.forName("openblocks.api.IElevatorBlock");
            colour = blockClass.getMethod("getColor", World.class, int.class, int.class, int.class);
            Class<?> type = Class.forName("openmods.movement.PlayerMovementEvent$Type");
            jump = type.getField("JUMP")
                .get(null);
            sneak = type.getField("SNEAK")
                .get(null);
            Class<?> event = Class.forName("openblocks.events.ElevatorActionEvent");
            action = event.getConstructor(int.class, int.class, int.class, int.class, type);
            sender = Class.forName("openmods.network.event.NetworkEvent")
                .getField("sender");
            usable = true;
        } catch (ClassNotFoundException e) {
            usable = false;
        } catch (Throwable t) {
            usable = false;
            AiPlayerMod.LOG.warn("OpenBlocks is installed but not in a form this mod knows; elevators go unused", t);
        }
        return usable;
    }

    public static boolean is(Block b) {
        return b != null && available() && blockClass.isInstance(b);
    }

    /** Elevators only link to others of their own colour; -1 if it cannot be told. */
    public static int colour(World w, int x, int y, int z) {
        try {
            return (Integer) colour.invoke(w.getBlock(x, y, z), w, x, y, z);
        } catch (Throwable t) {
            return -1;
        }
    }

    /** Tells the server the player standing on the elevator at x y z jumped (up) or sneaked (down). */
    public static void ride(EntityPlayerMP p, int x, int y, int z, boolean up) {
        try {
            Object event = action.newInstance(p.dimension, x, y, z, up ? jump : sneak);
            sender.set(event, p);
            MinecraftForge.EVENT_BUS.post((Event) event);
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("Riding an elevator failed", t);
        }
    }
}
