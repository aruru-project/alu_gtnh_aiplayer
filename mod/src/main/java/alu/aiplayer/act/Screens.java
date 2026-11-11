package alu.aiplayer.act;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.Container;
import net.minecraft.inventory.Slot;
import net.minecraft.item.ItemStack;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.Motion;
import alu.aiplayer.bridge.RpcException;
import alu.aiplayer.util.Names;

/**
 * A screen, used the way a player uses one: open it, look at its slots, click them, close it.
 * <p>
 * The tasks that move things (deposit, withdraw, process, craft) are ready-made ways through particular screens.
 * This is the plain thing underneath, for every screen nobody wrote a task for: whoever drives the bot can open
 * what a player could open and click what a player could click, and find out by trying. Nothing here knows which
 * mod a screen belongs to.
 */
public final class Screens {

    private Screens() {}

    /** The block whose screen each bot has open, so that what is changed through it is saved with the world. */
    private static final java.util.Map<String, int[]> AT = new java.util.concurrent.ConcurrentHashMap<>();

    private static void opened(Bot bot, int[] at) {
        if (at == null) AT.remove(bot.name);
        else AT.put(bot.name, at.clone());
    }

    private static void changed(Bot bot) {
        int[] at = AT.get(bot.name);
        if (at != null && bot.online()) ContainerSession.markChanged(bot.player().worldObj, at[0], at[1], at[2]);
    }

    /** Opens the screen of a block within reach, or the one a carried item opens when used. */
    public static JsonObject open(Bot bot, int[] at, ItemFilter item) {
        return open(bot, at, item, -1, null, false);
    }

    /**
     * The same, with the click a player would make chosen in full: which face of the block, where on it, sneaking
     * or not. Some blocks open a different screen depending on that (a cover on a machine's face opens its own
     * when the face is sneak-clicked).
     */
    public static JsonObject open(Bot bot, int[] at, ItemFilter item, int side, float[] hit, boolean sneak) {
        if (item != null || (side < 0 && hit == null && !sneak)) return openPlain(bot, at, item);
        EntityPlayerMP p = bot.player();
        if (!bot.tasks.idle()) throw new RpcException("busy", "a task is running; screens are for when the bot is idle");
        if (p.openContainer != p.inventoryContainer) bot.conn()
            .closeWindow();
        if (!p.worldObj.blockExists(at[0], at[1], at[2]) || !Reach.canReach(p, at[0], at[1], at[2])) {
            throw new RpcException("out_of_reach", "the block is out of reach; go next to it first");
        }
        if (side >= 0 && !Drawers.inFront(p, at[0], at[1], at[2], side)) {
            throw new RpcException("out_of_reach", "that face of the block cannot be clicked from where the bot stands; go to that side of it first");
        }
        int face = side >= 0 ? side : Reach.facingSide(p, at[0], at[1], at[2]);
        float[] where = hit != null ? hit : ContainerSession.middleOf(face);
        Motion.face(p, at[0] + where[0], at[1] + where[1], at[2] + where[2]);
        boolean was = p.isSneaking();
        if (sneak) p.setSneaking(true);
        try {
            ContainerSession.clickEmptyHanded(bot, at[0], at[1], at[2], face, where[0], where[1], where[2]);
        } finally {
            if (sneak) p.setSneaking(was);
        }
        if (bot.clickWasRefused(at[0], at[1], at[2])) {
            throw RpcException.denied("opening that was refused; it may be protected");
        }
        opened(bot, at);
        return look(bot);
    }

    private static JsonObject openPlain(Bot bot, int[] at, ItemFilter item) {
        EntityPlayerMP p = bot.player();
        if (!bot.tasks.idle()) throw new RpcException("busy", "a task is running; screens are for when the bot is idle");
        if (p.openContainer != p.inventoryContainer) bot.conn()
            .closeWindow();
        if (item != null) {
            int slot = -1;
            for (int i = 0; i < Inventories.CARRY_SLOTS && slot < 0; i++) {
                ItemStack s = p.inventory.mainInventory[i];
                if (s != null && item.matches(s)) slot = i;
            }
            if (slot < 0) throw new RpcException("no_material", "the bot carries no such item");
            Inventories.hold(bot, slot);
            bot.conn()
                .useItem();
        } else {
            if (!p.worldObj.blockExists(at[0], at[1], at[2]) || !Reach.canReach(p, at[0], at[1], at[2])) {
                throw new RpcException("out_of_reach", "the block is out of reach; go next to it first");
            }
            Motion.face(p, at[0] + 0.5, at[1] + 0.5, at[2] + 0.5);
            ContainerSession.clickEmptyHanded(bot, at[0], at[1], at[2]);
            if (bot.clickWasRefused(at[0], at[1], at[2])) {
                throw RpcException.denied("opening that was refused; it may be protected");
            }
        }
        opened(bot, item != null ? null : at);
        return look(bot);
    }

    /** What the open screen shows. Some screens only appear a moment after the click; then this says not open yet. */
    public static JsonObject look(Bot bot) {
        EntityPlayerMP p = bot.player();
        JsonObject o = new JsonObject();
        Container c = p.openContainer;
        boolean open = c != null && c != p.inventoryContainer;
        o.addProperty("open", open);
        if (!open) return o;
        o.addProperty(
            "screen",
            c.getClass()
                .getSimpleName());
        JsonArray slots = new JsonArray();
        ItemStack probe = new ItemStack(net.minecraft.init.Blocks.cobblestone);
        for (Object each : c.inventorySlots) {
            Slot s = (Slot) each;
            JsonObject j = new JsonObject();
            j.addProperty("slot", s.slotNumber);
            ItemStack shown = s.getStack();
            boolean own = ContainerSession.isOwnSlot(p, s);
            if (own) j.addProperty("own", true);
            if (shown != null) {
                JsonObject item = Names.describe(shown);
                j.add("item", item);
            }
            if (!own) {
                if (ContainerSession.isGhostSlot(s)) j.addProperty("ghost", true);
                else if (ContainerSession.slotTakesNothing(s, shown != null ? shown : probe)) j.addProperty("takesNothing", true);
            }
            // Empty slots of the bot's own inventory say nothing anyone needs; leave them out.
            if (own && shown == null) continue;
            slots.add(j);
        }
        o.add("slots", slots);
        o.addProperty("slotCount", c.inventorySlots.size());
        // What the screen has besides slots: switches, choices, further panels, fluid slots, buttons.
        JsonArray controls = Controls.list(c);
        if (controls.size() > 0) o.add("controls", controls);
        ItemStack held = p.inventory.getItemStack();
        if (held != null) o.add("cursor", Names.describe(held));
        return o;
    }

    /**
     * One click on a slot: left or right button, with or without shift, exactly as the game's own screens send it.
     * What it does is up to the screen.
     */
    public static JsonObject click(Bot bot, int slot, int button, boolean shift) {
        EntityPlayerMP p = bot.player();
        if (!bot.tasks.idle()) throw new RpcException("busy", "a task is running");
        Container c = p.openContainer;
        if (c == null || c == p.inventoryContainer) throw RpcException.badRequest("no screen is open; open one first");
        if (slot < 0 || slot >= c.inventorySlots.size()) throw RpcException.badRequest("the screen has no slot " + slot);
        if (button != 0 && button != 1) throw RpcException.badRequest("button is 0 (left) or 1 (right)");
        try {
            c.slotClick(slot, button, shift ? 1 : 0, p);
            c.detectAndSendChanges();
            changed(bot);
        } catch (RuntimeException e) {
            throw new RpcException("invalid", "the screen did not take that click: " + e);
        }
        return look(bot);
    }

    /** Works one of the screen's controls as a click does; see {@link Controls#press}. */
    public static JsonObject press(Bot bot, String panel, String key, int button, boolean shift) {
        Container c = open(bot);
        Controls.press(c, panel, key, button, shift);
        c.detectAndSendChanges();
        changed(bot);
        return look(bot);
    }

    /** Sets one of the screen's controls to a value; see {@link Controls#set}. */
    public static JsonObject set(Bot bot, String panel, String key, com.google.gson.JsonElement value) {
        Container c = open(bot);
        Controls.set(c, panel, key, value);
        c.detectAndSendChanges();
        changed(bot);
        return look(bot);
    }

    private static Container open(Bot bot) {
        EntityPlayerMP p = bot.player();
        if (!bot.tasks.idle()) throw new RpcException("busy", "a task is running");
        Container c = p.openContainer;
        if (c == null || c == p.inventoryContainer) throw RpcException.badRequest("no screen is open; open one first");
        return c;
    }

    /** Closes the screen. Whatever is still on the cursor goes back into the inventory, or to the ground. */
    public static JsonObject close(Bot bot) {
        EntityPlayerMP p = bot.player();
        ItemStack held = p.inventory.getItemStack();
        if (held != null) {
            p.inventory.setItemStack(null);
            if (!p.inventory.addItemStackToInventory(held)) p.dropPlayerItemWithRandomChoice(held, false);
        }
        if (p.openContainer != p.inventoryContainer) bot.conn()
            .closeWindow();
        changed(bot);
        opened(bot, null);
        JsonObject o = new JsonObject();
        o.addProperty("open", false);
        return o;
    }
}
