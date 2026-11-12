package alu.aiplayer.bot;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.Container;
import net.minecraft.item.ItemStack;
import net.minecraft.util.IChatComponent;
import net.minecraftforge.fluids.FluidTank;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.AiPlayerMod;
import alu.aiplayer.act.Machines;
import alu.aiplayer.act.Screens;
import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.util.Names;
import alu.aiplayer.util.Nbt;
import cpw.mods.fml.common.Loader;
import cpw.mods.fml.common.network.internal.FMLProxyPacket;
import cpw.mods.fml.common.network.simpleimpl.IMessage;
import cpw.mods.fml.common.network.simpleimpl.SimpleNetworkWrapper;
import cpw.mods.fml.relauncher.Side;

/**
 * The bot's stand-in for the parts of other mods that run in a player's game client ({@link ModClient}): the keys
 * those mods add, what their items do when used in the air, what they do every tick, what a player wears outside the
 * armor slots, and the buttons only their client draws on a screen. Which mods have such parts, and what each does,
 * is in that mod's {@link ModClient}; this holds what is the same for all of them.
 */
public final class ModClients {

    private ModClients() {}

    private static final List<ModClient> ALL = load();

    private static List<ModClient> load() {
        List<ModClient> out = new ArrayList<>();
        if (Loader.isModLoaded("adventurebackpack")) {
            try {
                out.add(new AdventureBackpackClient());
            } catch (Throwable t) {
                AiPlayerMod.LOG.warn("Adventure Backpack is here but its client parts cannot be reached; bots cannot press its keys", t);
            }
        }
        return out;
    }

    /** Every key a bot can press: [{key, name, category}]. */
    public static JsonArray keys() {
        JsonArray out = new JsonArray();
        for (ModClient m : ALL) m.keys(out);
        return out;
    }

    /**
     * Presses a key once, as a player does, holding Shift for it when sneak. Only while no task runs: a key may open a
     * screen. Returns what could be seen to change: {key, screen?, changed?, said?}. A key that does nothing in the
     * bot's present state (no screen opened, nothing it wears changed, nothing said) returns only {key}.
     */
    public static JsonObject press(Bot bot, String key, boolean sneak) {
        if (!bot.tasks.idle()) throw new RpcException("busy", "a task is running; keys are pressed when the bot is idle");
        ModClient owner = null;
        for (ModClient m : ALL) {
            JsonArray mine = new JsonArray();
            m.keys(mine);
            for (int i = 0; i < mine.size(); i++) {
                if (key.equals(mine.get(i)
                    .getAsJsonObject()
                    .get("key")
                    .getAsString())) owner = m;
            }
        }
        if (owner == null) throw RpcException.badRequest("no such key: " + key + "; the keys are " + keys());
        EntityPlayerMP p = bot.player();
        Map<String, String> before = wornData(p);
        boolean screenBefore = p.openContainer != p.inventoryContainer;
        long mark = bot.heardMark();
        boolean was = p.isSneaking();
        if (sneak) p.setSneaking(true);
        try {
            owner.press(bot, key);
        } catch (RpcException e) {
            throw e;
        } catch (Throwable t) {
            AiPlayerMod.LOG.warn("Pressing {} for bot {} failed", key, bot.name, t);
            throw new RpcException("internal", "pressing that key failed: " + t);
        } finally {
            if (sneak && bot.online()) bot.player()
                .setSneaking(was);
        }
        JsonObject o = new JsonObject();
        o.addProperty("key", key);
        if (!bot.online()) return o;
        p = bot.player();
        boolean screenNow = p.openContainer != p.inventoryContainer;
        if (screenNow || screenBefore) o.add("screen", Screens.look(bot));
        JsonArray changed = changes(before, wornData(p));
        if (changed.size() > 0) o.add("changed", changed);
        JsonArray said = new JsonArray();
        for (String line : bot.heardSince(mark)) said.add(new com.google.gson.JsonPrimitive(line));
        if (said.size() > 0) o.add("said", said);
        return o;
    }

    /** After the bot used its held item in the air: the client half of that, for the mods that have one. */
    static void usedInAir(BotConnection conn, ItemStack held) {
        if (held == null) return;
        for (ModClient m : ALL) {
            try {
                m.usedInAir(conn, held);
            } catch (Throwable t) {
                AiPlayerMod.LOG.warn("The client side of using {} failed", Names.itemId(held.getItem()), t);
            }
        }
    }

    /** Called inside every tick of a bot, after the mods' own handlers for that tick. */
    public static void tick(Bot bot, EntityPlayerMP p) {
        for (ModClient m : ALL) {
            try {
                m.tick(bot, p);
            } catch (Throwable t) {
                AiPlayerMod.LOG.debug("A client stand-in failed this tick", t);
            }
        }
    }

    /** The tanks of everything worn outside the armor slots, by "slot#index". */
    public static Map<String, FluidTank> wornTanks(EntityPlayerMP p) {
        Map<String, FluidTank> out = new java.util.LinkedHashMap<>();
        for (ModClient.Worn w : wornThings(p)) {
            for (int i = 0; i < w.tanks.size(); i++) out.put(w.slot + "#" + i, w.tanks.get(i));
        }
        return out;
    }

    /** What the player wears outside the armor slots. */
    static List<ModClient.Worn> wornThings(EntityPlayerMP p) {
        List<ModClient.Worn> out = new ArrayList<>();
        for (ModClient m : ALL) {
            try {
                m.worn(p, out);
            } catch (Throwable t) {
                AiPlayerMod.LOG.debug("Cannot tell what a player wears", t);
            }
        }
        return out;
    }

    /**
     * [{slot, id, meta, count, name, tanks?, data?, dataCut?}] for what is worn outside the armor slots: the tanks are
     * the ones the player sees filling and emptying, data is the worn thing's own saved data, as it is.
     */
    public static JsonArray worn(EntityPlayerMP p) {
        JsonArray out = new JsonArray();
        for (ModClient.Worn w : wornThings(p)) {
            JsonObject o = Names.describe(w.stack);
            o.addProperty("slot", w.slot);
            JsonArray tanks = new JsonArray();
            for (FluidTank t : w.tanks) tanks.add(Machines.tank(t.getFluid(), t.getCapacity()));
            if (tanks.size() > 0) o.add("tanks", tanks);
            if (w.stack.hasTagCompound()) {
                Nbt.Limits l = new Nbt.Limits();
                l.depth = 5;
                l.list = 12;
                l.chars = 3000;
                o.add("data", Nbt.json(w.stack.getTagCompound(), l));
                if (l.cut) o.addProperty("dataCut", true);
            }
            out.add(o);
        }
        return out;
    }

    /** The open screen's buttons that only a mod's client draws. */
    public static JsonArray controls(Container c) {
        JsonArray out = new JsonArray();
        for (ModClient m : ALL) {
            try {
                m.controls(c, out);
            } catch (Throwable t) {
                AiPlayerMod.LOG.debug("Cannot list a screen's buttons", t);
            }
        }
        return out;
    }

    /** Presses one of those buttons; false when the open screen has none of that name. */
    public static boolean pressControl(Bot bot, Container c, String key) {
        for (ModClient m : ALL) {
            try {
                if (m.pressControl(bot, c, key)) return true;
            } catch (RpcException e) {
                throw e;
            } catch (Throwable t) {
                throw new RpcException("invalid", "the screen did not take that: " + t);
            }
        }
        return false;
    }

    /**
     * Sends a mod's message to its server side as this player's client would: encoded by the mod's own channel and
     * handed to the server's handlers of that channel, on this thread, the way a packet from a client reaches them.
     */
    static void send(BotConnection conn, Object network, Object message) {
        FMLProxyPacket out = (FMLProxyPacket) ((SimpleNetworkWrapper) network).getPacketFrom((IMessage) message);
        FMLProxyPacket in = new FMLProxyPacket(
            out.payload()
                .copy(),
            out.channel());
        in.setTarget(Side.SERVER);
        in.processPacket(conn);
    }

    /** Shows the bot a line as its client would print it, so it is heard like anything the server says. */
    static void print(Bot bot, IChatComponent line) {
        bot.onMessage(line);
    }

    /** Every value of what is worn, under "slot:path", to tell what a key changed. */
    private static Map<String, String> wornData(EntityPlayerMP p) {
        Map<String, String> out = new java.util.LinkedHashMap<>();
        for (ModClient.Worn w : wornThings(p)) {
            out.put(w.slot + ":", Names.itemId(w.stack.getItem()) + "/" + w.stack.getItemDamage());
            if (!w.stack.hasTagCompound()) continue;
            for (Map.Entry<String, String> e : Nbt.flatten(w.stack.getTagCompound())
                .entrySet()) out.put(w.slot + ":" + e.getKey(), e.getValue());
        }
        return out;
    }

    /** [{slot, key, was?, now?}]: values that differ; key "" is the worn thing itself (id/meta). At most 30. */
    private static JsonArray changes(Map<String, String> before, Map<String, String> after) {
        JsonArray out = new JsonArray();
        TreeSet<String> keys = new TreeSet<>(before.keySet());
        keys.addAll(after.keySet());
        for (String k : keys) {
            String was = before.get(k), now = after.get(k);
            if (was == null ? now == null : was.equals(now)) continue;
            if (out.size() >= 30) break;
            int colon = k.indexOf(':');
            JsonObject c = new JsonObject();
            c.addProperty("slot", k.substring(0, colon));
            c.addProperty("key", k.substring(colon + 1));
            if (was != null) c.addProperty("was", was);
            if (now != null) c.addProperty("now", now);
            out.add(c);
        }
        return out;
    }
}
