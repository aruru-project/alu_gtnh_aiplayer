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

    /**
     * What the block asks of a tool, as the game has it (Forge): the kind of tool ({@code getHarvestTool(meta)}: a
     * class name such as "pickaxe", "axe", "shovel", or a mod's own such as GregTech's "wrench") and the level
     * ({@code getHarvestLevel(meta)}), and whether its material needs a tool at all. A block that names no kind of
     * tool leaves it to each tool to say whether it can harvest the block (vanilla tools go by the block's material).
     */
    public static com.google.gson.JsonObject needs(Block block, int meta) {
        com.google.gson.JsonObject o = new com.google.gson.JsonObject();
        String tool = null;
        int level = -1;
        try {
            tool = block.getHarvestTool(meta);
            level = block.getHarvestLevel(meta);
        } catch (Throwable t) {
            o.addProperty("unreadable", true);
        }
        if (tool != null && !tool.isEmpty()) {
            o.addProperty("tool", tool);
            o.addProperty("level", level);
        }
        boolean anyTool;
        try {
            anyTool = !block.getMaterial()
                .isToolNotRequired();
        } catch (Throwable t) {
            anyTool = true;
        }
        o.addProperty("toolRequired", anyTool);
        return o;
    }

    /**
     * Only asks the Forge capability whether vanilla shears can be used here. Never calls onSheared/getDrops to
     * preview drops: those can consume randomness, spawn items or change mod state. The answer is not a drop table.
     */
    public static com.google.gson.JsonObject shearing(World w, int x, int y, int z) {
        Block block = w.getBlock(x, y, z);
        if (!(block instanceof net.minecraftforge.common.IShearable)) return null;
        com.google.gson.JsonObject o = new com.google.gson.JsonObject();
        o.addProperty("item", "minecraft:shears");
        try {
            o.addProperty("shearable", ((net.minecraftforge.common.IShearable) block)
                .isShearable(new ItemStack(net.minecraft.init.Items.shears), w, x, y, z));
        } catch (Throwable t) {
            o.addProperty("unreadable", true);
        }
        return o;
    }

    /** The same in words: "a wrench (tool class "wrench") of level 2 or higher". */
    public static String needsText(Block block, int meta) {
        com.google.gson.JsonObject n = needs(block, meta);
        if (!n.get("toolRequired")
            .getAsBoolean()) return "no required tool; drops still depend on the block and the tool used";
        if (!n.has("tool")) {
            return "a tool the block does not name (it gives no tool class; whether a tool can harvest it is that tool's own call)";
        }
        return "tool class \"" + n.get("tool")
            .getAsString() + "\" of level " + n.get("level")
                .getAsInt() + " or higher";
    }

    /**
     * The bot's tools against the block, in words, for a no_tool message: what each says it is in the block's tool
     * class and what the game made of it ("minecraft:iron_pickaxe:0 is not that class; gregtech:gt.metatool.01:16
     * level 0, too low"). Empty when the bot carries no tool.
     */
    public static String carriedText(EntityPlayerMP p, World w, int x, int y, int z) {
        Block block = w.getBlock(x, y, z);
        int meta = w.getBlockMetadata(x, y, z);
        String tool;
        int need;
        try {
            tool = block.getHarvestTool(meta);
            need = block.getHarvestLevel(meta);
        } catch (Throwable t) {
            tool = null;
            need = -1;
        }
        boolean named = tool != null && !tool.isEmpty();
        StringBuilder sb = new StringBuilder();
        for (com.google.gson.JsonElement e : explain(p, w, x, y, z)) {
            com.google.gson.JsonObject c = e.getAsJsonObject();
            if (c.get("slot")
                .getAsInt() < 0) continue;
            String what = c.get("item")
                .getAsString();
            String verdict;
            if (c.has("excluded")) verdict = "never used (it breaks several blocks at once)";
            else if (c.get("harvest")
                .getAsBoolean()) verdict = "can harvest it";
            else if (named && c.has("level") && c.get("level")
                .getAsInt() < 0) verdict = "is not that class";
            else if (named && c.has("level") && c.get("level")
                .getAsInt() < need) verdict = "level " + c.get("level")
                    .getAsInt() + ", too low";
            else if (c.get("strength")
                .getAsFloat() <= 0.0F) verdict = "makes no progress on it at all";
            else verdict = "cannot harvest it (its own rule)";
            sb.append(sb.length() == 0 ? "" : "; ")
                .append(what)
                .append(' ')
                .append(verdict);
        }
        return sb.length() == 0 ? "you carry no tools" : "your tools: " + sb;
    }

    /**
     * One carried item against the block's needs: its level in the block's tool class ({@code getHarvestLevel(stack,
     * class)}, -1 when it is not that kind of tool) and the kinds of tool it calls itself.
     */
    private static void describeTool(com.google.gson.JsonObject o, ItemStack s, Block block, int meta) {
        if (s == null) return;
        String tool = null;
        try {
            tool = block.getHarvestTool(meta);
        } catch (Throwable t) {
            // unreadable
        }
        try {
            if (tool != null && !tool.isEmpty()) o.addProperty("level", s.getItem()
                .getHarvestLevel(s, tool));
            java.util.Set<String> classes = s.getItem()
                .getToolClasses(s);
            if (classes != null && !classes.isEmpty()) {
                com.google.gson.JsonObject c = new com.google.gson.JsonObject();
                for (String k : new java.util.TreeSet<>(classes)) c.addProperty(k, s.getItem()
                    .getHarvestLevel(s, k));
                o.add("classes", c);
            }
        } catch (Throwable t) {
            // a tool that cannot answer
        }
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
                describeTool(o, s, block, meta);
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
