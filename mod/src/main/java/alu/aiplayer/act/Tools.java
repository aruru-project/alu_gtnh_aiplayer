package alu.aiplayer.act;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.entity.player.InventoryPlayer;
import net.minecraft.item.ItemStack;
import net.minecraft.world.World;
import net.minecraftforge.common.ForgeHooks;

import alu.aiplayer.util.Names;

/** Picks what to hold to break a block, by asking the game how fast each carried tool would be. */
public final class Tools {

    private Tools() {}

    /** Tools this close to breaking are left alone rather than used up. */
    private static final double MIN_DURABILITY = 0.02;
    private static final int QUICK_BY_HAND = 40;

    public static final class Choice {

        /** Inventory slot of the tool to hold, or -1 for "no tool needed". */
        public final int slot;
        /** Fraction of the block broken per tick. */
        public final float strength;
        /** Whether breaking it this way yields drops. False means a tool is required that the bot lacks. */
        public final boolean harvest;

        Choice(int slot, float strength, boolean harvest) {
            this.slot = slot;
            this.strength = strength;
            this.harvest = harvest;
        }

        /**
         * Whether to go ahead and break the block this way. Without the right tool that is only sensible for
         * things that give way quickly (snow, plants); pounding on stone bare-handed wastes time and the drop.
         */
        public boolean worthwhile() {
            return strength > 0.0F && (harvest || ticks() <= QUICK_BY_HAND);
        }

        public int ticks() {
            if (strength >= 1.0F) return 1;
            if (strength <= 0.0F) return Integer.MAX_VALUE;
            return (int) Math.ceil(1.0F / strength);
        }
    }

    /** The best way to break the block at x,y,z, or null if it cannot be broken at all. */
    public static Choice best(EntityPlayerMP p, World w, int x, int y, int z) {
        Block block = w.getBlock(x, y, z);
        if (block.getBlockHardness(w, x, y, z) < 0.0F) return null;
        int meta = w.getBlockMetadata(x, y, z);
        InventoryPlayer inv = p.inventory;
        int cur = inv.currentItem;
        ItemStack saved = inv.mainInventory[cur];
        Choice best;
        try {
            // Evaluate each candidate as the held item without sending anything: only this array entry changes.
            inv.mainInventory[cur] = null;
            best = evaluate(-1, block, meta, p, w, x, y, z);
            for (int slot = 0; slot < inv.mainInventory.length; slot++) {
                ItemStack s = slot == cur ? saved : inv.mainInventory[slot];
                // Any single item might be a modded tool; stackable things never dig better than a hand.
                if (s == null || s.getMaxStackSize() != 1) continue;
                // Hammers and the like take neighbouring blocks with them, beyond what a task was given.
                if (alu.aiplayer.AiPlayerMod.config().excludedTools.contains(Names.itemId(s.getItem()))) continue;
                Double left = Names.durabilityLeft(s);
                if (left != null && left < MIN_DURABILITY) continue;
                inv.mainInventory[cur] = s;
                Choice c = evaluate(slot, block, meta, p, w, x, y, z);
                if (better(c, best)) best = c;
            }
        } finally {
            inv.mainInventory[cur] = saved;
        }
        return best;
    }

    private static Choice evaluate(int slot, Block block, int meta, EntityPlayerMP p, World w, int x, int y, int z) {
        boolean harvest;
        float strength;
        try {
            harvest = ForgeHooks.canHarvestBlock(block, p, meta);
            strength = block.getPlayerRelativeBlockHardness(p, w, x, y, z);
        } catch (Throwable t) {
            // A modded tool that cannot answer for this block is simply not a candidate.
            return new Choice(slot, 0.0F, false);
        }
        // A tool the pack has disabled reports no progress at all; it cannot harvest anything.
        return new Choice(slot, strength, harvest && strength > 0.0F);
    }

    private static boolean better(Choice a, Choice b) {
        if (a.harvest != b.harvest) return a.harvest;
        // A tool must be clearly faster than the bare hand to be worth its wear.
        return a.strength > b.strength * 1.05F;
    }

    /** Every carried candidate with how it would do against the block; for diagnosis. */
    public static com.google.gson.JsonArray explain(EntityPlayerMP p, World w, int x, int y, int z) {
        com.google.gson.JsonArray out = new com.google.gson.JsonArray();
        Block block = w.getBlock(x, y, z);
        int meta = w.getBlockMetadata(x, y, z);
        InventoryPlayer inv = p.inventory;
        int cur = inv.currentItem;
        ItemStack saved = inv.mainInventory[cur];
        try {
            for (int slot = -1; slot < inv.mainInventory.length; slot++) {
                ItemStack s = slot < 0 ? null : (slot == cur ? saved : inv.mainInventory[slot]);
                if (slot >= 0 && (s == null || s.getMaxStackSize() != 1)) continue;
                boolean excluded = s != null
                    && alu.aiplayer.AiPlayerMod.config().excludedTools.contains(Names.itemId(s.getItem()));
                inv.mainInventory[cur] = s;
                Choice c = evaluate(slot, block, meta, p, w, x, y, z);
                com.google.gson.JsonObject o = new com.google.gson.JsonObject();
                o.addProperty("slot", slot);
                o.addProperty("item", s == null ? "hand" : Names.itemId(s.getItem()) + ":" + s.getItemDamage());
                if (excluded) o.addProperty("excluded", true);
                o.addProperty("harvest", c.harvest);
                o.addProperty("strength", c.strength);
                o.addProperty("ticks", c.ticks() == Integer.MAX_VALUE ? -1 : c.ticks());
                out.add(o);
            }
        } finally {
            inv.mainInventory[cur] = saved;
        }
        return out;
    }

    /** Holds the chosen tool, or puts tools away when none is needed so they are not worn for nothing. */
    public static void hold(alu.aiplayer.bot.Bot bot, Choice choice) {
        EntityPlayerMP p = bot.player();
        if (choice.slot >= 0) {
            Inventories.hold(bot, choice.slot);
            return;
        }
        if (!Inventories.isTool(p.inventory.getCurrentItem())) return;
        for (int i = 0; i < 9; i++) {
            if (!Inventories.isTool(p.inventory.mainInventory[i])) {
                bot.conn()
                    .selectHotbar(i);
                return;
            }
        }
    }
}
