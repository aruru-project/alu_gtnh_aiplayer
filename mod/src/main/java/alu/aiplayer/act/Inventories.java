package alu.aiplayer.act;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemFood;
import net.minecraft.item.ItemStack;
import net.minecraftforge.common.ForgeHooks;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.util.Names;

/** Looking through and rearranging a bot's own inventory (slots 0-8 hotbar, 9-35 backpack). */
public final class Inventories {

    private Inventories() {}

    public static List<ItemFilter> filters(JsonArray array) {
        List<ItemFilter> out = new ArrayList<>();
        if (array == null) return out;
        for (JsonElement e : array) out.add(ItemFilter.parse(e.getAsJsonObject()));
        return out;
    }

    public static int freeSlots(EntityPlayerMP p) {
        int n = 0;
        for (ItemStack s : p.inventory.mainInventory) if (s == null) n++;
        return n;
    }

    public static int count(EntityPlayerMP p, ItemFilter f) {
        int n = 0;
        for (ItemStack s : p.inventory.mainInventory) if (f.matches(s)) n += s.stackSize;
        return n;
    }

    /** First slot holding a matching stack, or -1. */
    public static int find(EntityPlayerMP p, ItemFilter f) {
        ItemStack[] inv = p.inventory.mainInventory;
        for (int i = 0; i < inv.length; i++) if (f.matches(inv[i])) return i;
        return -1;
    }

    /** Tools and weapons: single items that wear out or declare a tool class. */
    public static boolean isTool(ItemStack s) {
        if (s == null || s.getMaxStackSize() != 1) return false;
        try {
            return s.isItemStackDamageable() || Names.durabilityLeft(s) != null
                || !s.getItem()
                    .getToolClasses(s)
                    .isEmpty();
        } catch (Throwable t) {
            return false;
        }
    }

    public static boolean isFood(ItemStack s) {
        return s != null && s.getItem() instanceof ItemFood;
    }

    /**
     * Makes the stack in the given inventory slot the held item. Backpack slots are swapped with a hotbar slot,
     * which is what a player does in the inventory screen. Returns false if the slot is empty.
     */
    public static boolean hold(Bot bot, int slot) {
        EntityPlayerMP p = bot.player();
        ItemStack[] inv = p.inventory.mainInventory;
        if (slot < 0 || slot >= inv.length || inv[slot] == null) return false;
        if (slot < 9) {
            bot.conn()
                .selectHotbar(slot);
            return true;
        }
        int target = swapTarget(p);
        ItemStack tmp = inv[target];
        inv[target] = inv[slot];
        inv[slot] = tmp;
        p.inventory.markDirty();
        bot.conn()
            .selectHotbar(target);
        return true;
    }

    /** Holds nothing: selects an empty hotbar slot if there is one. Returns whether the hand is now empty. */
    public static boolean holdNothing(Bot bot) {
        EntityPlayerMP p = bot.player();
        if (p.inventory.getCurrentItem() == null) return true;
        for (int i = 0; i < 9; i++) {
            if (p.inventory.mainInventory[i] == null) {
                bot.conn()
                    .selectHotbar(i);
                return true;
            }
        }
        return false;
    }

    /** The hotbar slot to give up when something from the backpack must be held: an empty one, else the last. */
    private static int swapTarget(EntityPlayerMP p) {
        for (int i = 0; i < 9; i++) if (p.inventory.mainInventory[i] == null) return i;
        // Prefer displacing something that is not a tool, so tools stay within quick reach.
        for (int i = 8; i >= 0; i--) if (!isTool(p.inventory.mainInventory[i])) return i;
        return 8;
    }

    /** Throws matching stacks on the ground; null drops everything. Returns the number of items dropped. */
    public static int drop(Bot bot, List<ItemFilter> filters) {
        EntityPlayerMP p = bot.player();
        ItemStack[] inv = p.inventory.mainInventory;
        int dropped = 0;
        if (filters == null) {
            for (int i = 0; i < inv.length; i++) {
                if (inv[i] != null) dropped += toss(p, i, inv[i].stackSize);
            }
            return dropped;
        }
        for (ItemFilter f : filters) {
            int want = f.count < 0 ? Integer.MAX_VALUE : f.count;
            for (int i = 0; i < inv.length && want > 0; i++) {
                if (!f.matches(inv[i])) continue;
                int n = Math.min(want, inv[i].stackSize);
                dropped += toss(p, i, n);
                want -= n;
            }
        }
        return dropped;
    }

    private static int toss(EntityPlayerMP p, int slot, int n) {
        ItemStack out = p.inventory.decrStackSize(slot, n);
        if (out == null) return 0;
        ForgeHooks.onPlayerTossEvent(p, out, true);
        return out.stackSize;
    }
}
