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
import alu.aiplayer.util.Kinds;
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
        if (at == null || (item == null && side < 0 && hit == null && !sneak)) return openPlain(bot, at, item, sneak);
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
            if (item == null) ContainerSession.clickEmptyHanded(bot, at[0], at[1], at[2], face, where[0], where[1], where[2]);
            else {
                hold(bot, item);
                bot.conn().useOnBlock(at[0], at[1], at[2], face, where[0], where[1], where[2]);
            }
        } finally {
            if (sneak) p.setSneaking(was);
        }
        if (bot.clickWasRefused(at[0], at[1], at[2])) throw RpcException.denied(bot.refused("opening that"));
        opened(bot, at);
        return look(bot);
    }

    private static void hold(Bot bot, ItemFilter item) {
        for (int i = 0; i < Inventories.CARRY_SLOTS; i++) {
            ItemStack s = bot.player().inventory.mainInventory[i];
            if (s != null && item.matches(s)) {
                Inventories.hold(bot, i);
                return;
            }
        }
        throw new RpcException("no_material", "the bot carries no such item");
    }

    private static JsonObject openPlain(Bot bot, int[] at, ItemFilter item, boolean sneak) {
        EntityPlayerMP p = bot.player();
        if (!bot.tasks.idle()) throw new RpcException("busy", "a task is running; screens are for when the bot is idle");
        if (p.openContainer != p.inventoryContainer) bot.conn()
            .closeWindow();
        if (item != null) {
            hold(bot, item);
            boolean was = p.isSneaking();
            if (sneak) p.setSneaking(true);
            try {
                bot.conn().useItem();
            } finally {
                if (sneak) p.setSneaking(was);
            }
        } else {
            if (!p.worldObj.blockExists(at[0], at[1], at[2]) || !Reach.canReach(p, at[0], at[1], at[2])) {
                throw new RpcException("out_of_reach", "the block is out of reach; go next to it first");
            }
            Motion.face(p, at[0] + 0.5, at[1] + 0.5, at[2] + 0.5);
            ContainerSession.clickEmptyHanded(bot, at[0], at[1], at[2]);
            if (bot.clickWasRefused(at[0], at[1], at[2])) throw RpcException.denied(bot.refused("opening that"));
        }
        opened(bot, item != null ? null : at);
        JsonObject o = look(bot);
        if (item != null && !o.get("open")
            .getAsBoolean()) {
            // Some items open a screen only their mod's client draws: nothing will ever appear here.
            JsonObject screen = alu.aiplayer.bot.ModClients.clientScreenOf(p.inventory.getCurrentItem());
            if (screen != null) {
                JsonObject c = new JsonObject();
                c.addProperty("screen", screen.get("screen").getAsString());
                c.add("instead", screen.get("instead"));
                c.addProperty("text", alu.aiplayer.bot.ModClients.clientOnlyText(screen));
                o.add("clientOnly", c);
            }
        }
        return o;
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
        // The block whose screen this is, if it was opened on one: a GregTech machine says what each of its slots is for.
        int[] where = AT.get(bot.name);
        net.minecraft.tileentity.TileEntity block = where == null || !p.worldObj.blockExists(where[0], where[1], where[2]) ? null
            : p.worldObj.getTileEntity(where[0], where[1], where[2]);
        boolean gt = block != null && Machines.inputSlots(block) != null;
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
                // Where the screen draws it (pixels from its top left corner) and what kind of slot its code made it:
                // a player reads a screen by its layout, and the kind's name often says what the slot is for.
                // (Screens that lay their slots out themselves, GregTech's among them, leave these at a stand-in value.)
                if (Math.abs(s.xDisplayPosition) < 10000 && Math.abs(s.yDisplayPosition) < 10000) {
                    j.addProperty("x", s.xDisplayPosition);
                    j.addProperty("y", s.yDisplayPosition);
                }
                if (s.getClass() != Slot.class) j.addProperty("class", s.getClass().getSimpleName());
                String role = null;
                if (gt && Machines.ownSlot(block, s)) {
                    // The slot's place in the machine's own inventory, and what that place is for. Slots of a cover
                    // shown on the same screen hold the cover's things; their numbers are the cover's.
                    j.addProperty("index", s.getSlotIndex());
                    role = Machines.slotRole(block, s.getSlotIndex());
                    if (role != null) j.addProperty("role", role);
                }
                if (ContainerSession.isGhostSlot(s)) j.addProperty("ghost", true);
                else if (ContainerSession.slotTakesNothing(s, shown != null ? shown : probe)) {
                    // A slot for some things only (fuel, fluid containers, tools, patterns) is told from one that takes
                    // nothing by what the bot carries, by a few things of those kinds, and failing those by the game's
                    // whole list of items: the kinds of what the bot carries that it would take are listed (maybe
                    // none), and when none fit, a few of the game's items that it takes.
                    JsonArray takes = shown != null ? new JsonArray() : carriedThatFit(p, s);
                    JsonArray accepts = shown != null || takes.size() > 0 || "output".equals(role) ? new JsonArray() : anyThatFit(s);
                    if (takes.size() > 0 || (shown == null && takesSomeKind(s)) || accepts.size() > 0) {
                        j.add("takes", takes);
                        if (accepts.size() > 0) j.add("accepts", accepts);
                    } else {
                        j.addProperty("takesNothing", true);
                    }
                }
            }
            // Empty slots of the bot's own inventory say nothing anyone needs; leave them out.
            if (own && shown == null) continue;
            slots.add(j);
        }
        o.add("slots", slots);
        o.addProperty("slotCount", c.inventorySlots.size());
        // What the screen has besides slots: switches, choices, further panels, fluid slots, buttons; and the buttons
        // only a mod's client draws on it.
        JsonArray controls = Controls.list(c);
        for (com.google.gson.JsonElement e : alu.aiplayer.bot.ModClients.controls(c)) controls.add(e);
        if (controls.size() > 0) o.add("controls", controls);
        ItemStack held = p.inventory.getItemStack();
        if (held != null) o.add("cursor", Names.describe(held));
        return o;
    }

    /** One thing of each kind a slot may be kept for: fuel, a fluid container empty and full, a tool. */
    private static ItemStack[] kindProbes;

    private static boolean takesSomeKind(Slot s) {
        if (kindProbes == null) {
            java.util.List<ItemStack> probes = new java.util.ArrayList<>();
            probes.add(new ItemStack(net.minecraft.init.Items.coal));
            probes.add(new ItemStack(net.minecraft.init.Items.bucket));
            probes.add(new ItemStack(net.minecraft.init.Items.water_bucket));
            probes.add(new ItemStack(net.minecraft.init.Items.iron_pickaxe));
            net.minecraft.item.Item cell = Names.item("IC2:itemCellEmpty");
            if (cell != null) probes.add(new ItemStack(cell));
            kindProbes = probes.toArray(new ItemStack[0]);
        }
        for (ItemStack probe : kindProbes) {
            try {
                if (s.isItemValid(probe)) return true;
            } catch (Throwable ignored) {}
        }
        return false;
    }

    /** One of every item the game has (each at meta 0), to ask a slot whether it takes anything at all. */
    private static ItemStack[] everyItem;

    /** A few of the game's items an empty slot takes, when the bot carries none: [{id, meta, name}], at most 4. */
    private static JsonArray anyThatFit(Slot s) {
        if (everyItem == null) {
            java.util.List<ItemStack> all = new java.util.ArrayList<>();
            for (Object o : net.minecraft.item.Item.itemRegistry) {
                if (o instanceof net.minecraft.item.Item) all.add(new ItemStack((net.minecraft.item.Item) o, 1, 0));
            }
            everyItem = all.toArray(new ItemStack[0]);
        }
        JsonArray out = new JsonArray();
        for (ItemStack each : everyItem) {
            try {
                if (!s.isItemValid(each)) continue;
                JsonObject item = Kinds.of(each);
                // A meta that names no real item of its kind shows only its untranslated key; not an example.
                if (item.get("name")
                    .getAsString()
                    .endsWith(".name")) continue;
                out.add(item);
            } catch (Throwable t) {
                continue;
            }
            if (out.size() >= 4) break;
        }
        return out;
    }

    /**
     * The kinds of thing the bot carries that a slot would take: [{id, meta, name}], at most 8. What it holds on the
     * cursor counts first: picked up to be put down somewhere, it is the one asked about.
     */
    private static JsonArray carriedThatFit(EntityPlayerMP p, Slot s) {
        JsonArray out = new JsonArray();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (int i = -1; i < Inventories.CARRY_SLOTS && out.size() < 8; i++) {
            ItemStack carried = i < 0 ? p.inventory.getItemStack() : p.inventory.mainInventory[i];
            if (carried == null || !seen.add(Names.itemId(carried.getItem()) + "/" + carried.getItemDamage())) continue;
            try {
                if (!s.isItemValid(carried)) continue;
            } catch (Throwable t) {
                continue;
            }
            out.add(Kinds.of(carried));
        }
        return out;
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

    /**
     * Works one of the screen's controls as a click does; see {@link Controls#press}. A button only a mod's client
     * draws does what its click does in that client, which may close the screen.
     */
    public static JsonObject press(Bot bot, String panel, String key, int button, boolean shift) {
        Container c = open(bot);
        if (!alu.aiplayer.bot.ModClients.pressControl(bot, c, key)) {
            Controls.press(c, panel, key, button, shift);
            c.detectAndSendChanges();
        }
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
