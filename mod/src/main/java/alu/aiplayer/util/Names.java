package alu.aiplayer.util;

import net.minecraft.block.Block;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;

import com.google.gson.JsonObject;

/** Registry names and JSON descriptions of blocks and items. */
public final class Names {

    private Names() {}

    public static String blockId(Block block) {
        String id = Block.blockRegistry.getNameForObject(block);
        return id == null ? "unknown" : id;
    }

    public static String itemId(Item item) {
        String id = Item.itemRegistry.getNameForObject(item);
        return id == null ? "unknown" : id;
    }

    /** Returns null when no block has that registry name. */
    public static Block block(String id) {
        if (id == null || !Block.blockRegistry.containsKey(id)) return null;
        return (Block) Block.blockRegistry.getObject(id);
    }

    /** Returns null when no item has that registry name. */
    public static Item item(String id) {
        if (id == null || !Item.itemRegistry.containsKey(id)) return null;
        return (Item) Item.itemRegistry.getObject(id);
    }

    /** Meta as used for matching: damageable items (tools) all count as meta 0. */
    public static int meta(ItemStack stack) {
        return stack.isItemStackDamageable() ? 0 : stack.getItemDamage();
    }

    public static String displayName(ItemStack stack) {
        try {
            return stack.getDisplayName();
        } catch (Throwable t) {
            return itemId(stack.getItem());
        }
    }

    public static JsonObject describe(ItemStack stack) {
        JsonObject o = new JsonObject();
        o.addProperty("id", itemId(stack.getItem()));
        o.addProperty("meta", meta(stack));
        o.addProperty("count", stack.stackSize);
        o.addProperty("name", displayName(stack));
        Double left = durabilityLeft(stack);
        if (left != null) o.addProperty("durability", J.round(left));
        return o;
    }

    /** Remaining durability as 0..1, or null for things that do not wear out. */
    public static Double durabilityLeft(ItemStack stack) {
        try {
            Item item = stack.getItem();
            if (stack.isItemStackDamageable() || item.showDurabilityBar(stack)) {
                double used = item.getDurabilityForDisplay(stack);
                return Math.max(0.0, Math.min(1.0, 1.0 - used));
            }
        } catch (Throwable ignored) {
            // Some modded items need client state to answer; treat them as not wearing out.
        }
        return null;
    }
}
