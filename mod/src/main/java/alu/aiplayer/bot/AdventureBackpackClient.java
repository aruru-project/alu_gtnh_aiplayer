package alu.aiplayer.bot;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import net.minecraft.entity.Entity;
import net.minecraft.entity.player.EntityPlayer;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.Container;
import net.minecraft.inventory.IInventory;
import net.minecraft.item.ItemStack;
import net.minecraft.util.ChatComponentTranslation;
import net.minecraft.util.StatCollector;
import net.minecraftforge.fluids.FluidTank;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * Adventure Backpack's client parts. The mod keeps what a player wears on the back (a backpack, a copter pack, a
 * coal jetpack) in its own slot outside the armor, and almost everything a player does with those starts in the
 * client: its two keys (KeyInputEventHandler), a right-click of one of them in the air (the items'
 * onItemRightClick, which on the server does nothing), the shoulder/unshoulder buttons of their screens
 * (GuiWithTanks), and holding jump with a copter pack or jetpack on (their onEquippedUpdate, whose jump part runs
 * only in the client). Each method below says which of these it does; the messages are the mod's own.
 */
final class AdventureBackpackClient implements ModClient {

    static final String OPEN = "keys.adventureBackpack.openInventory";
    static final String ACTION = "keys.adventureBackpack.toggleActions";
    private static final String P = "com.darkona.adventurebackpack.";

    // The numbers the mod's messages carry (GUIPacket, WearableModePacket, EquipUnequipBackWearablePacket,
    // PlayerActionPacket, EntitySoundPacket, CycleToolPacket).
    private static final byte BACKPACK_GUI = 1, COPTER_GUI = 2, JETPACK_GUI = 3;
    private static final byte FROM_WEARING = 0, FROM_HOLDING = 1;
    private static final byte COPTER_ON_OFF = 0, COPTER_TOGGLE = 1, JETPACK_ON_OFF = 2, CYCLING_ON_OFF = 3,
        NIGHTVISION_ON_OFF = 4;
    private static final byte EQUIP = 0, UNEQUIP = 1;
    private static final byte JETPACK_IN_USE = 1, JETPACK_NOT_IN_USE = 2;
    private static final byte JETPACK_FIZZ = 2;
    private static final byte TOGGLE_HOSE_TANK = 0;
    /** ItemCopterPack.OFF_MODE and HOVER_MODE; NORMAL_MODE is 1. */
    private static final byte COPTER_OFF = 0, COPTER_HOVER = 2;
    /** What ItemCoalJetpack takes from the steam tank for one tick of thrust. */
    private static final int JETPACK_STEAM_PER_TICK = 13;

    private final Object net;
    private final Class<?> backpackItem, copterItem, jetpackItem, hoseItem, containerAdventure;
    private final Class<?> backpackProperty;
    private final Method wearable, wearingInventory, tanksArray, elevate;
    private final Constructor<?> guiMessage, modeMessage, equipMessage, syncMessage, actionMessage, soundMessage,
        cycleMessage;
    private final Constructor<?> copterInventory, jetpackInventory, backpackInventory;
    private final Method copterStatus, copterFuel, jetpackStatus, jetpackInUse, jetpackSteam, backpackType, nightVision;
    private final Field source, chatSpam;

    AdventureBackpackClient() throws ReflectiveOperationException {
        net = cls("init.ModNetwork").getField("net")
            .get(null);
        backpackItem = cls("item.ItemAdventureBackpack");
        copterItem = cls("item.ItemCopterPack");
        jetpackItem = cls("item.ItemCoalJetpack");
        hoseItem = cls("item.ItemHose");
        containerAdventure = cls("inventory.ContainerAdventure");
        backpackProperty = cls("playerProperties.BackpackProperty");
        wearable = backpackProperty.getMethod("getWearable");
        wearingInventory = cls("util.Wearing").getMethod("getWearingWearableInv", EntityPlayer.class);
        tanksArray = cls("inventory.IInventoryTanks").getMethod("getTanksArray");
        elevate = copterItem.getDeclaredMethod("elevate", EntityPlayer.class, ItemStack.class);
        elevate.setAccessible(true);
        guiMessage = cls("network.GUIPacket$GUImessage").getConstructor(byte.class, byte.class);
        modeMessage = cls("network.WearableModePacket$Message").getConstructor(byte.class);
        equipMessage = cls("network.EquipUnequipBackWearablePacket$Message").getConstructor(byte.class);
        syncMessage = cls("network.SyncPropertiesPacket$Message").getConstructor();
        actionMessage = cls("network.PlayerActionPacket$ActionMessage").getConstructor(byte.class);
        soundMessage = cls("network.messages.EntitySoundPacket$Message").getConstructor(byte.class, Entity.class);
        cycleMessage = cls("network.CycleToolPacket$CycleToolMessage").getConstructor(boolean.class, byte.class);
        copterInventory = cls("inventory.InventoryCopterPack").getConstructor(ItemStack.class);
        jetpackInventory = cls("inventory.InventoryCoalJetpack").getConstructor(ItemStack.class);
        backpackInventory = cls("inventory.InventoryBackpack").getConstructor(ItemStack.class);
        copterStatus = copterInventory.getDeclaringClass()
            .getMethod("getStatus");
        copterFuel = copterInventory.getDeclaringClass()
            .getMethod("getFuelTank");
        jetpackStatus = jetpackInventory.getDeclaringClass()
            .getMethod("getStatus");
        jetpackInUse = jetpackInventory.getDeclaringClass()
            .getMethod("isInUse");
        jetpackSteam = jetpackInventory.getDeclaringClass()
            .getMethod("getSteamTank");
        backpackType = backpackInventory.getDeclaringClass()
            .getMethod("getType");
        nightVision = cls("reference.BackpackTypes").getMethod("isNightVision", cls("reference.BackpackTypes"));
        source = containerAdventure.getDeclaredField("source");
        source.setAccessible(true);
        chatSpam = cls("config.ConfigHandler").getField("chatSpam");
    }

    private static Class<?> cls(String name) throws ClassNotFoundException {
        return Class.forName(P + name);
    }

    // ---- what the player wears and holds ----------------------------------------------------------------------

    private ItemStack wearing(EntityPlayer p) {
        Object prop = p.getExtendedProperties("abp.property");
        if (!backpackProperty.isInstance(prop)) return null;
        try {
            return (ItemStack) wearable.invoke(prop);
        } catch (ReflectiveOperationException e) {
            return null;
        }
    }

    private static boolean is(ItemStack s, Class<?> item) {
        return s != null && s.getItem() != null && item.isInstance(s.getItem());
    }

    private boolean holding(EntityPlayer p, Class<?> item) {
        return is(p.inventory.getCurrentItem(), item);
    }

    /** An inventory of the mod's, read fresh from the item's data, as the mod reads it each time. */
    private static Object open(Constructor<?> inventory, ItemStack stack) throws ReflectiveOperationException {
        Object inv = inventory.newInstance(stack);
        ((IInventory) inv).openInventory();
        return inv;
    }

    private void send(Bot bot, Object message) {
        ModClients.send(bot.conn(), net, message);
    }

    private void gui(Bot bot, byte type, byte from) throws ReflectiveOperationException {
        send(bot, guiMessage.newInstance(type, from));
    }

    /**
     * The line the mod's client prints for a change it made: some only when its "Chat Spam" setting is on, as
     * ServerActions, run in the client too, prints them there.
     */
    private void print(Bot bot, String key, boolean onlyWithChatSpam) {
        try {
            if (onlyWithChatSpam && !chatSpam.getBoolean(null)) return;
        } catch (IllegalAccessException e) {
            return;
        }
        ModClients.print(bot, new ChatComponentTranslation(key));
    }

    // ---- keys -----------------------------------------------------------------------------------------------

    @Override
    public void keys(JsonArray out) {
        for (String k : new String[] { OPEN, ACTION }) {
            JsonObject o = new JsonObject();
            o.addProperty("key", k);
            o.addProperty("name", StatCollector.translateToLocal(k));
            o.addProperty("category", StatCollector.translateToLocal("keys.adventureBackpack.category"));
            out.add(o);
        }
    }

    /** KeyInputEventHandler.onInput, and GuiWithTanks.keyTyped for the inventory key on the mod's own screen. */
    @Override
    public boolean press(Bot bot, String key) {
        if (!OPEN.equals(key) && !ACTION.equals(key)) return false;
        EntityPlayerMP p = bot.player();
        try {
            if (p.openContainer != p.inventoryContainer) {
                // On a screen the game takes keys for the screen; on the mod's own screens its inventory key closes it.
                if (OPEN.equals(key) && containerAdventure.isInstance(p.openContainer)) bot.conn()
                    .closeWindow();
                return true;
            }
            ItemStack worn = wearing(p);
            boolean sneaking = p.isSneaking();
            if (OPEN.equals(key)) {
                send(bot, syncMessage.newInstance());
                if (sneaking) {
                    if (holding(p, backpackItem)) gui(bot, BACKPACK_GUI, FROM_HOLDING);
                } else if (is(worn, backpackItem)) gui(bot, BACKPACK_GUI, FROM_WEARING);
                else if (holding(p, backpackItem)) gui(bot, BACKPACK_GUI, FROM_HOLDING);
                else if (is(worn, copterItem)) gui(bot, COPTER_GUI, FROM_WEARING);
                else if (is(worn, jetpackItem)) gui(bot, JETPACK_GUI, FROM_WEARING);
                return true;
            }
            if (holding(p, hoseItem)) {
                send(bot, cycleMessage.newInstance(false, TOGGLE_HOSE_TANK));
            } else if (is(worn, backpackItem)) {
                if (!sneaking) {
                    toggle(bot, CYCLING_ON_OFF, "disableCycling", "cycling", false);
                } else if ((Boolean) nightVision.invoke(null, backpackType.invoke(open(backpackInventory, worn)))) {
                    toggle(bot, NIGHTVISION_ON_OFF, "disableNVision", "nightvision", true);
                }
            } else if (is(worn, copterItem)) {
                byte was = (Byte) copterStatus.invoke(open(copterInventory, worn));
                send(bot, modeMessage.newInstance(sneaking ? COPTER_ON_OFF : COPTER_TOGGLE));
                byte now = (Byte) copterStatus.invoke(open(copterInventory, wearing(p)));
                if (now != was) print(bot, "adventurebackpack:messages.copterpack." + (now == COPTER_OFF ? "off" : now == COPTER_HOVER ? "hover" : "normal"), true);
            } else if (is(worn, jetpackItem) && sneaking) {
                send(bot, modeMessage.newInstance(JETPACK_ON_OFF));
                boolean on = (Boolean) jetpackStatus.invoke(open(jetpackInventory, wearing(p)));
                print(bot, "adventurebackpack:messages.jetpack." + (on ? "on" : "off"), true);
            }
            return true;
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    /** A backpack's switch: the message, then the line the client prints when it flipped (ServerActions). */
    private void toggle(Bot bot, byte message, String flag, String words, boolean onlyWithChatSpam)
        throws ReflectiveOperationException {
        boolean was = flag(wearing(bot.player()), flag);
        send(bot, modeMessage.newInstance(message));
        boolean off = flag(wearing(bot.player()), flag);
        if (off != was) print(bot, "adventurebackpack:messages." + words + (off ? ".off" : ".on"), onlyWithChatSpam);
    }

    private static boolean flag(ItemStack worn, String flag) {
        return worn != null && worn.hasTagCompound()
            && worn.getTagCompound()
                .getCompoundTag("wearableData")
                .getBoolean(flag);
    }

    // ---- items used in the air -------------------------------------------------------------------------------

    /** onItemRightClick of the three wearables: in the client it asks the server for the item's screen. */
    @Override
    public void usedInAir(BotConnection conn, ItemStack held) {
        byte type = is(held, copterItem) ? COPTER_GUI : is(held, jetpackItem) ? JETPACK_GUI : is(held, backpackItem) ? BACKPACK_GUI : 0;
        if (type == 0) return;
        try {
            ModClients.send(conn, net, guiMessage.newInstance(type, FROM_HOLDING));
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---- every tick -----------------------------------------------------------------------------------------

    /**
     * The jump part of onEquippedUpdate, which runs only in the client. A copter pack that is on and has fuel lifts
     * the player while jump is held (ItemCopterPack.elevate, after the mod has set this tick's hover or slow fall). A
     * coal jetpack is told each tick whether jump is held while it is on and has steam (PlayerActionPacket), and the
     * mod's own server tick does the lifting.
     */
    @Override
    public void tick(Bot bot, EntityPlayerMP p) {
        ItemStack worn = wearing(p);
        if (worn == null) return;
        boolean jump = bot.motion.jump;
        try {
            if (is(worn, copterItem)) {
                if (!jump) return;
                Object inv = open(copterInventory, worn);
                if ((Byte) copterStatus.invoke(inv) != COPTER_OFF && ((FluidTank) copterFuel.invoke(inv)).getFluidAmount() > 0) {
                    elevate.invoke(null, p, worn);
                }
            } else if (is(worn, jetpackItem)) {
                Object inv = open(jetpackInventory, worn);
                FluidTank steam = (FluidTank) jetpackSteam.invoke(inv);
                boolean thrust = jump && (Boolean) jetpackStatus.invoke(inv) && steam.drain(JETPACK_STEAM_PER_TICK, false) != null;
                if (thrust == (Boolean) jetpackInUse.invoke(inv)) return;
                send(bot, actionMessage.newInstance(thrust ? JETPACK_IN_USE : JETPACK_NOT_IN_USE));
                if (thrust) send(bot, soundMessage.newInstance(JETPACK_FIZZ, p));
            }
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---- what is worn ---------------------------------------------------------------------------------------

    /** The mod's back slot, with the tanks its overlay shows (IInventoryTanks.getTanksArray). */
    @Override
    public void worn(EntityPlayerMP p, List<Worn> out) {
        ItemStack worn = wearing(p);
        if (worn == null) return;
        List<FluidTank> tanks = new ArrayList<>();
        try {
            Object inv = wearingInventory.invoke(null, p);
            if (inv != null) {
                ((IInventory) inv).openInventory();
                tanks.addAll(Arrays.asList((FluidTank[]) tanksArray.invoke(inv)));
            }
        } catch (ReflectiveOperationException ignored) {}
        out.add(new Worn("back", worn, tanks));
    }

    // ---- screen buttons -------------------------------------------------------------------------------------

    /** The shoulder button of a carried one's screen, the unshoulder button of the worn one's (GuiWithTanks). */
    @Override
    public void controls(Container c, JsonArray out) {
        String button = button(c);
        if (button == null) return;
        JsonObject o = new JsonObject();
        o.addProperty("key", button);
        o.addProperty("kind", "button");
        String kind = c.getClass()
            .getSimpleName()
            .replace("Container", "")
            .toLowerCase();
        String tip = "adventurebackpack:tooltips." + kind + "." + button + ("unequip".equals(button) && "backpack".equals(kind) ? ".key1" : "");
        if (StatCollector.canTranslate(tip)) o.addProperty("label", StatCollector.translateToLocal(tip));
        out.add(o);
    }

    /** "equip" on a screen opened from the hand, "unequip" on one opened from the back; null on other screens. */
    private String button(Container c) {
        if (!containerAdventure.isInstance(c)) return null;
        try {
            String from = String.valueOf(source.get(c));
            return "HOLDING".equals(from) ? "equip" : "WEARING".equals(from) ? "unequip" : null;
        } catch (IllegalAccessException e) {
            return null;
        }
    }

    /** The button's click: the mod's message, then the screen closes, as the client closes it right after. */
    @Override
    public boolean pressControl(Bot bot, Container c, String key) {
        String button = button(c);
        if (button == null || !button.equals(key)) return false;
        try {
            send(bot, equipMessage.newInstance("equip".equals(key) ? EQUIP : UNEQUIP));
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
        if (bot.player().openContainer != bot.player().inventoryContainer) bot.conn()
            .closeWindow();
        return true;
    }
}
