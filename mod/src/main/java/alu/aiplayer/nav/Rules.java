package alu.aiplayer.nav;

import java.util.IdentityHashMap;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.block.material.Material;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.world.World;

import alu.aiplayer.AiPlayerMod;
import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.util.Names;

/** What a bot may break or use up on its own initiative while getting somewhere. */
public final class Rules {

    private Rules() {}

    private static final Map<Block, Boolean> NATURAL = new IdentityHashMap<>();

    /** Plain terrain: the configured list of natural blocks, plus foliage and snow. */
    public static boolean isNatural(Block b) {
        Boolean known = NATURAL.get(b);
        if (known != null) return known;
        Material m = b.getMaterial();
        boolean natural = m == Material.leaves || m == Material.vine
            || m == Material.snow
            || m == Material.craftedSnow
            || AiPlayerMod.config().naturalBlocks.contains(Names.blockId(b));
        NATURAL.put(b, natural);
        return natural;
    }

    /** No digging, including the bot's own old climbing blocks. */
    public static final NavWorld.BreakRule NO_BREAK = (w, x, y, z, block) -> false;

    /** Only natural terrain may be broken. This is the rule for simply walking somewhere. */
    public static final NavWorld.BreakRule NATURAL_ONLY = new NavWorld.BreakRule() {

        @Override
        public boolean mayBreak(World w, int x, int y, int z, Block block) {
            return isNatural(block);
        }
    };

    /** Natural terrain anywhere, and anything at all inside a box a task has been told to clear. */
    public static NavWorld.BreakRule within(final int x1, final int y1, final int z1, final int x2, final int y2,
        final int z2) {
        return new NavWorld.BreakRule() {

            @Override
            public boolean mayBreak(World w, int x, int y, int z, Block block) {
                return isJob(w, x, y, z, block) || isNatural(block);
            }

            @Override
            public boolean isJob(World w, int x, int y, int z, Block block) {
                return x >= x1 && x <= x2 && y >= y1 && y <= y2 && z >= z1 && z <= z2;
            }
        };
    }

    /** Natural terrain only, and nothing at all inside a box that a task is filling in. */
    public static NavWorld.BreakRule outside(final int x1, final int y1, final int z1, final int x2, final int y2,
        final int z2) {
        return new NavWorld.BreakRule() {

            @Override
            public boolean mayBreak(World w, int x, int y, int z, Block block) {
                if (x >= x1 && x <= x2 && y >= y1 && y <= y2 && z >= z1 && z <= z2) return false;
                return isNatural(block);
            }
        };
    }

    private static final Map<Block, Boolean> FILLER = new IdentityHashMap<>();

    /** One of the configured throwaway blocks. */
    public static boolean isFiller(Block b) {
        Boolean known = FILLER.get(b);
        if (known == null) {
            known = AiPlayerMod.config().fillerBlocks.contains(Names.blockId(b));
            FILLER.put(b, known);
        }
        return known;
    }

    /** How many items of the configured throwaway blocks the bot carries. */
    public static int fillerCarried(EntityPlayerMP p) {
        int n = 0;
        for (ItemStack s : p.inventory.mainInventory) {
            if (s == null) continue;
            Block b = Block.getBlockFromItem(s.getItem());
            if (b != null && b != net.minecraft.init.Blocks.air && isFiller(b)) n += s.stackSize;
        }
        return n;
    }

    /** The throwaway block to build pillars and fill holes with: the first configured filler the bot carries. */
    public static ItemFilter scaffold(EntityPlayerMP p) {
        for (String id : AiPlayerMod.config().fillerBlocks) {
            Item item = Names.item(id);
            if (item == null) continue;
            for (ItemStack s : p.inventory.mainInventory) {
                if (s != null && s.getItem() == item) return new ItemFilter(id, -1, -1);
            }
        }
        return null;
    }
}
