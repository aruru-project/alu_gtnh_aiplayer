package alu.aiplayer.world;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import net.minecraft.block.Block;
import net.minecraft.block.BlockAnvil;
import net.minecraft.block.BlockButton;
import net.minecraft.block.BlockDirectional;
import net.minecraft.block.BlockDoor;
import net.minecraft.block.BlockEndPortalFrame;
import net.minecraft.block.BlockHopper;
import net.minecraft.block.BlockLadder;
import net.minecraft.block.BlockLever;
import net.minecraft.block.BlockPistonBase;
import net.minecraft.block.BlockRailBase;
import net.minecraft.block.BlockRotatedPillar;
import net.minecraft.block.BlockSign;
import net.minecraft.block.BlockSkull;
import net.minecraft.block.BlockStairs;
import net.minecraft.block.BlockTorch;
import net.minecraft.block.BlockTrapDoor;
import net.minecraft.block.BlockTripWireHook;
import net.minecraft.block.BlockVine;
import net.minecraft.block.material.Material;
import net.minecraft.item.Item;
import net.minecraft.item.ItemBlock;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.CompressedStreamTools;
import net.minecraft.nbt.NBTTagCompound;

import alu.aiplayer.act.ItemFilter;
import alu.aiplayer.util.Names;

/**
 * A building plan read from a Schematica {@code .schematic} file: a box of cells, each either empty or one kind of
 * block. Blocks are identified by the registry names the file carries, so a plan drawn on one world reads the same
 * on another.
 */
public final class Blueprint {

    public static final int MAX_CELLS = 4_000_000;

    /** One kind of block in a plan: a block and its metadata. */
    public static final class Kind {

        public final int index;
        /** Null for the empty kind, and for a block this server does not have. */
        public final Block block;
        public final String blockId;
        public final int meta;
        /** What the bot places it with; null when it cannot. */
        public final ItemFilter item;
        public final int maxStack;
        /** Why placing this is left to a player, or null if the bot can do it. */
        public final String byHand;
        public final String name;
        /** How many cells of the plan hold this kind. */
        public int count;

        Kind(int index, Block block, String blockId, int meta) {
            this.index = index;
            this.block = block;
            this.blockId = blockId;
            this.meta = meta;
            String why = null;
            ItemFilter filter = null;
            int stack = 64;
            String label = blockId;
            if (block == null) {
                why = "this server has no such block";
            } else {
                label = WorldQueries.blockName(block, meta);
                Item it = Item.getItemFromBlock(block);
                if (it == null) {
                    why = "there is no item that places it";
                } else if (block.hasTileEntity(meta)) {
                    why = "it holds contents or settings";
                } else if (faces(block)) {
                    why = "which way it faces depends on how it is placed";
                } else if (!(it instanceof ItemBlock) || ((ItemBlock) it).getMetadata(meta) != meta) {
                    // The item cannot be told which variant to become. (What the block drops when broken says
                    // nothing here: carved glowstone drops dust and is still placed as itself.)
                    why = "its variant depends on how it is placed";
                } else {
                    filter = new ItemFilter(Names.itemId(it), meta, -1);
                    try {
                        stack = Math.max(1, new ItemStack(it, 1, meta).getMaxStackSize());
                    } catch (Throwable t) {
                        stack = 64;
                    }
                }
            }
            this.item = filter;
            this.maxStack = stack;
            this.byHand = why;
            this.name = label;
        }

        public boolean empty() {
            return index == 0;
        }
    }

    private static boolean faces(Block b) {
        return b instanceof BlockStairs || b instanceof BlockRotatedPillar
            || b instanceof BlockDirectional
            || b instanceof BlockPistonBase
            || b instanceof BlockTorch
            || b instanceof BlockLever
            || b instanceof BlockButton
            || b instanceof BlockDoor
            || b instanceof BlockTrapDoor
            || b instanceof BlockLadder
            || b instanceof BlockSign
            || b instanceof BlockRailBase
            || b instanceof BlockVine
            || b instanceof BlockSkull
            || b instanceof BlockAnvil
            || b instanceof BlockHopper
            || b instanceof BlockEndPortalFrame
            || b instanceof BlockTripWireHook;
    }

    public final String name;
    /** Size along x, y and z. */
    public final int sx, sy, sz;
    /** kinds[0] is "nothing here". */
    public final Kind[] kinds;
    private final short[] cells;
    /** Cells that hold a block. */
    public final int blocks;

    private Blueprint(String name, int sx, int sy, int sz, Kind[] kinds, short[] cells, int blocks) {
        this.name = name;
        this.sx = sx;
        this.sy = sy;
        this.sz = sz;
        this.kinds = kinds;
        this.cells = cells;
        this.blocks = blocks;
    }

    /** The kind at a position inside the plan, counted from its lowest corner. */
    public Kind at(int i, int j, int k) {
        return kinds[cells[i + (j * sz + k) * sx]];
    }

    /**
     * Reads a plan. Throws IllegalArgumentException with a message fit for the person who supplied the file when
     * it is not a schematic this mod can use.
     */
    public static Blueprint read(String name, InputStream in) throws IOException {
        NBTTagCompound tag;
        try {
            tag = CompressedStreamTools.readCompressed(in);
        } catch (IOException | RuntimeException e) {
            throw new IllegalArgumentException("not a .schematic file (it is not gzip-compressed NBT)");
        }
        int sx = tag.getShort("Width"), sy = tag.getShort("Height"), sz = tag.getShort("Length");
        if (sx <= 0 || sy <= 0 || sz <= 0) throw new IllegalArgumentException("the file gives no size");
        if (sy > 256) throw new IllegalArgumentException("the plan is " + sy + " high; the world is 256");
        long volume = (long) sx * sy * sz;
        if (volume > MAX_CELLS) {
            throw new IllegalArgumentException("the plan holds " + volume + " cells; the limit is " + MAX_CELLS);
        }
        byte[] ids = tag.getByteArray("Blocks");
        byte[] data = tag.getByteArray("Data");
        if (ids.length != volume || data.length != volume) {
            throw new IllegalArgumentException("the block data does not match the size the file gives");
        }
        // Ids above 255 keep their upper bits either as half-bytes ("AddBlocks") or as whole bytes ("Add").
        byte[] nibbles = tag.hasKey("AddBlocks", 7) ? tag.getByteArray("AddBlocks") : null;
        byte[] upper = nibbles == null && tag.hasKey("Add", 7) ? tag.getByteArray("Add") : null;
        if (nibbles != null && nibbles.length < (volume + 1) / 2) nibbles = null;
        if (upper != null && upper.length < volume) upper = null;

        NBTTagCompound mapping = tag.getCompoundTag("SchematicaMapping");
        Map<Integer, String> names = new HashMap<>();
        for (Object key : mapping.func_150296_c()) names.put(mapping.getShort((String) key) & 0xFFFF, (String) key);
        if (names.isEmpty()) {
            throw new IllegalArgumentException(
                "the file does not say which blocks its numbers stand for; save it with Schematica");
        }
        // Two conventions exist for which half-byte belongs to which cell. The right one is the one under which
        // every id is a name the file knows.
        boolean schematicaOrder = true;
        if (nibbles != null) {
            int a = unknownIds(ids, nibbles, names, true), b = unknownIds(ids, nibbles, names, false);
            if (a != 0 && b != 0) {
                throw new IllegalArgumentException("the block ids do not match the block names in the file");
            }
            schematicaOrder = a == 0;
        }

        List<Kind> kinds = new ArrayList<>();
        kinds.add(new Kind(0, null, "minecraft:air", 0));
        Map<Integer, Integer> kindOf = new HashMap<>();
        short[] cells = new short[(int) volume];
        int blocks = 0;
        for (int i = 0; i < cells.length; i++) {
            int id = ids[i] & 0xFF;
            if (nibbles != null) id |= half(nibbles, i, schematicaOrder) << 8;
            else if (upper != null) id |= (upper[i] & 0xFF) << 8;
            String blockId = names.get(id);
            if (blockId == null) throw new IllegalArgumentException("the file uses a block id it gives no name for");
            int meta = data[i] & 0xF;
            Block block = Names.block(blockId);
            if (block != null && block.getMaterial() == Material.air) continue;
            int key = id << 4 | meta;
            Integer index = kindOf.get(key);
            if (index == null) {
                if (kinds.size() >= Short.MAX_VALUE) throw new IllegalArgumentException("too many kinds of block");
                index = kinds.size();
                kinds.add(new Kind(index, block, blockId, meta));
                kindOf.put(key, index);
            }
            kinds.get(index).count++;
            cells[i] = (short) (int) index;
            blocks++;
        }
        return new Blueprint(name, sx, sy, sz, kinds.toArray(new Kind[0]), cells, blocks);
    }

    private static int half(byte[] nibbles, int i, boolean schematicaOrder) {
        int b = nibbles[i >> 1] & 0xFF;
        return ((i & 1) == 0) == schematicaOrder ? b >> 4 : b & 0xF;
    }

    private static int unknownIds(byte[] ids, byte[] nibbles, Map<Integer, String> names, boolean schematicaOrder) {
        int unknown = 0;
        for (int i = 0; i < ids.length; i++) {
            if (!names.containsKey(ids[i] & 0xFF | half(nibbles, i, schematicaOrder) << 8)) unknown++;
        }
        return unknown;
    }
}
