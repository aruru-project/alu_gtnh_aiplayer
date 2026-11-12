package alu.aiplayer.bot;

import java.util.List;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.inventory.Container;
import net.minecraft.item.ItemStack;
import net.minecraftforge.fluids.FluidTank;

import com.google.gson.JsonArray;

/**
 * What one mod's code in a player's game client does for that player: what its keys do, what its items do when
 * used in the air, what it does every tick, which of its buttons exist only in its drawing of a screen. A bot has no
 * client, so its body does these the way that mod's client code does them, sending the mod's own messages to the
 * server ({@link ModClients#send}). Each implementation names the client code it stands in for.
 */
interface ModClient {

    /** A thing worn somewhere other than the armor slots, and the tanks it shows the player. */
    final class Worn {

        final String slot;
        final ItemStack stack;
        final List<FluidTank> tanks;

        Worn(String slot, ItemStack stack, List<FluidTank> tanks) {
            this.slot = slot;
            this.stack = stack;
            this.tanks = tanks;
        }
    }

    /** Its keys that reach the server, as {key, name, category}: key is the game's own name for the binding. */
    void keys(JsonArray out);

    /**
     * Presses one of its keys, the bot's sneaking already set as the player holds Shift. False when the key is not
     * one of its own.
     */
    boolean press(Bot bot, String key);

    /** What its client does after the held item is used in the air (opens the item's screen, say). */
    void usedInAir(BotConnection conn, ItemStack held);

    /**
     * Every tick of a bot, inside the player's own tick after the mods' handlers have run: what its client does each
     * tick (what holding jump does with a worn thing, for one).
     */
    void tick(Bot bot, EntityPlayerMP p);

    /** What the player wears that it keeps outside the armor slots. */
    void worn(EntityPlayerMP p, List<Worn> out);

    /** Buttons of the open screen that only its client draws: {key, kind:"button", label}. */
    void controls(Container c, JsonArray out);

    /** Presses such a button, as a click on it does. False when the screen has no such button of its own. */
    boolean pressControl(Bot bot, Container c, String key);

    /**
     * Its screens that exist only in its client and that the body does not draw: the server has nothing to open, so
     * opening them from the bot opens nothing. Each is {screen, item?:{id}, key?, keyName?, instead:[methods]}: what
     * it is, the item whose right-click and the key whose press open it in a client, and the bridge methods that do
     * what its buttons do.
     */
    default void clientScreens(JsonArray out) {}
}
