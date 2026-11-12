package alu.aiplayer.act;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Block;
import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.item.ItemStack;
import net.minecraft.util.AxisAlignedBB;
import net.minecraft.util.MathHelper;
import net.minecraft.world.World;

import alu.aiplayer.bot.Bot;
import alu.aiplayer.bot.Motion;
import alu.aiplayer.nav.Goal;
import alu.aiplayer.util.Names;

/**
 * Places one block from the inventory by right-clicking a neighbouring block's face, as a player must: there has
 * to be something to click on, within reach, and the bot may not be standing in the way.
 */
public final class Placer {

    private Placer() {}

    public enum Result {
        PLACED,
        /** The cell already holds a block. */
        OCCUPIED,
        NO_ITEM,
        /** No neighbouring block to place against. */
        NO_SUPPORT,
        OUT_OF_REACH,
        /** The bot itself stands in the cell. */
        IN_THE_WAY,
        /** The click went through but no block appeared (protection, another entity, a block that refuses). */
        REJECTED,
        /** It has to come out as a given meta, and no click in this cell can give that (see {@link Facing#why}). */
        NO_WAY,
        /** Placed, but it came out as another meta than the one wanted ({@link Facing#got}). */
        WRONG,
        /** A way is in reach from the middle of the bot's own cell, not from where it stands in it. */
        OFF_CENTRE
    }

    /** What a placement that must come out as a given meta has to say beyond its result. */
    public static final class Facing {

        /** Why it cannot be done here (NO_WAY, NO_SUPPORT, and WRONG when the block could not be foreseen). */
        public String why;
        /** The meta it came out as (WRONG). */
        public int got = -1;
    }

    // Neighbour offsets in the order they are tried, and the face of that neighbour that looks at the cell.
    private static final int[][] NEIGHBOURS = { { 0, -1, 0, 1 }, { 0, 0, -1, 3 }, { 0, 0, 1, 2 }, { -1, 0, 0, 5 },
        { 1, 0, 0, 4 }, { 0, 1, 0, 0 } };

    /** Whether a block could be placed in the cell. Cells in chunks that are not loaded count as occupied. */
    public static boolean isReplaceable(World w, int x, int y, int z) {
        if (y < 0 || y > 255 || !w.blockExists(x, y, z)) return false;
        Block b = w.getBlock(x, y, z);
        return b.isAir(w, x, y, z) || b.isReplaceable(w, x, y, z);
    }

    /** Whether some neighbour offers a face to place against. */
    public static boolean hasSupport(World w, int x, int y, int z) {
        for (int[] n : NEIGHBOURS) {
            if (!isReplaceable(w, x + n[0], y + n[1], z + n[2])) return true;
        }
        return false;
    }

    public static boolean bodyIntersects(EntityPlayerMP p, int x, int y, int z) {
        return p.boundingBox.intersectsWith(AxisAlignedBB.getBoundingBox(x, y, z, x + 1, y + 1, z + 1));
    }

    /**
     * Places one block so that it comes out with meta {@code want}: picks a face to click and the point on it, and
     * the look, that give that meta (see {@link Orientation}), and clicks it if the bot stands where that look is
     * its own. OUT_OF_REACH means a way exists from somewhere else ({@link #facingGoal}). With {@code dry} nothing
     * is clicked: the result says only whether there is a way, and whether it is in reach. A block whose placing
     * code the body cannot foresee is placed the usual way and checked afterwards.
     */
    public static Result placeAs(Bot bot, int x, int y, int z, ItemFilter item, int want, Facing out, boolean dry) {
        EntityPlayerMP p = bot.player();
        World w = p.worldObj;
        if (!w.blockExists(x, y, z)) return Result.OUT_OF_REACH;
        if (!isReplaceable(w, x, y, z)) return Result.OCCUPIED;
        int slot = Inventories.find(p, item);
        if (slot < 0) return Result.NO_ITEM;
        ItemStack stack = p.inventory.mainInventory[slot];
        Block b = Orientation.blockOf(stack.getItem());
        Orientation.Rule r = b == null ? Orientation.Rule.UNKNOWN : Orientation.rule(b);
        if (r == Orientation.Rule.UNKNOWN) {
            out.why = b == null ? "it is placed by an item that is not a plain block item, which the body cannot foresee"
                : "which way it comes out is decided by its own placing code (" + Orientation.placedByClass(b)
                    .getName() + "), which the body cannot foresee";
            if (dry) return hasSupport(w, x, y, z) ? Result.OUT_OF_REACH : Result.NO_SUPPORT;
            Result plain = place(bot, x, y, z, item);
            return plain == Result.PLACED ? checked(w, x, y, z, want, out) : plain;
        }
        List<Orientation.Way> present = present(w, x, y, z, stack, b, r, want, out);
        if (present == null) return Result.NO_WAY;
        if (present.isEmpty()) return Result.NO_SUPPORT;
        if (bodyIntersects(p, x, y, z)) return Result.IN_THE_WAY;
        for (Orientation.Way way : present) {
            if (!Orientation.stanceGives(w, b, r, way, x, y, z, p.posX, p.posY, p.posZ, want, Reach.BLOCK_REACH)) continue;
            if (dry) return Result.OUT_OF_REACH;
            Inventories.hold(bot, slot);
            click(bot, way.sx, way.sy, way.sz, way.side, way.hx, way.hy, way.hz);
            if (isReplaceable(w, x, y, z)) return Result.REJECTED;
            return checked(w, x, y, z, want, out);
        }
        if (dry) return Result.OUT_OF_REACH;
        double cx = MathHelper.floor_double(p.posX) + 0.5, cz = MathHelper.floor_double(p.posZ) + 0.5;
        for (Orientation.Way way : present) {
            if (Orientation.stanceGives(w, b, r, way, x, y, z, cx, p.posY, cz, want, Reach.BLOCK_REACH)) return Result.OFF_CENTRE;
        }
        return Result.OUT_OF_REACH;
    }

    private static Result checked(World w, int x, int y, int z, int want, Facing out) {
        out.got = w.getBlockMetadata(x, y, z);
        return out.got == want ? Result.PLACED : Result.WRONG;
    }

    /**
     * The clicks that can give {@code want} and have a block to click on now. Null when no click in this cell can
     * give it (why in {@code out}); empty when the blocks to click on are missing (why in {@code out}).
     */
    private static List<Orientation.Way> present(World w, int x, int y, int z, ItemStack stack, Block b,
        Orientation.Rule r, int want, Facing out) {
        int placedMeta;
        try {
            placedMeta = Orientation.placedMeta(stack.getItem(), stack.getItemDamage());
        } catch (Throwable t) {
            placedMeta = 0;
        }
        List<Orientation.Way> all = Orientation.ways(w, x, y, z, b, placedMeta);
        List<Orientation.Way> giving = new ArrayList<>();
        for (Orientation.Way way : all) if (Orientation.canGive(r, way, want)) giving.add(way);
        String what = Names.itemId(stack.getItem()) + ":" + stack.getItemDamage();
        if (giving.isEmpty()) {
            out.why = "no click gives /" + want
                + " with "
                + what
                + ": placed in this cell it comes out as "
                + Orientation.metas(Orientation.allOutcomes(r, all));
            return null;
        }
        List<Orientation.Way> present = new ArrayList<>();
        boolean joins = false;
        for (Orientation.Way way : giving) {
            if (isReplaceable(w, way.sx, way.sy, way.sz)) continue;
            // Clicking the top or bottom of a slab of the same kind makes the two one double slab instead.
            if (way.side <= 1 && Orientation.joinsSlab(stack.getItem(), w.getBlock(way.sx, way.sy, way.sz))) {
                joins = true;
                continue;
            }
            present.add(way);
        }
        if (present.isEmpty()) {
            out.why = "to come out as /" + want
                + " it has to be placed by clicking "
                + Orientation.facesFor(r, giving, x, y, z, want)
                + "; there is no such block there"
                + (joins ? " (the slab of the same kind there would only be made a double slab by that click)" : "");
        }
        return present;
    }

    /**
     * Where to stand to place a block that must come out as {@code want}: in reach of a face that gives it, looking
     * the way that gives it, out of the cell, and with {@code fromAbove} feet no lower than the cell. Null when there
     * is no such way here.
     */
    public static Goal facingGoal(World w, final int x, final int y, final int z, ItemStack stack, final int want,
        final boolean fromAbove) {
        final Block b = Orientation.blockOf(stack.getItem());
        if (b == null) return null;
        final Orientation.Rule r = Orientation.rule(b);
        if (r == Orientation.Rule.UNKNOWN) return null;
        final List<Orientation.Way> present = present(w, x, y, z, stack, b, r, want, new Facing());
        if (present == null || present.isEmpty()) return null;
        final World world = w;
        return new Goal() {

            @Override
            public boolean reached(int sx, int sy, int sz) {
                if (fromAbove && sy < y) return false;
                if (sx == x && sz == z && (sy == y || sy + 1 == y)) return false;
                for (Orientation.Way way : present) {
                    if (Orientation.stanceGives(world, b, r, way, x, y, z, sx + 0.5, sy, sz + 0.5, want, Reach.PLANNING_REACH)) return true;
                }
                return false;
            }

            @Override
            public double heuristic(int sx, int sy, int sz) {
                int flat = Math.max(0, Math.abs(sx - x) + Math.abs(sz - z) - 4);
                int dy = y - sy;
                int vert = dy > 5 ? dy - 5 : (dy < -3 ? -3 - dy : 0);
                return flat * 4.7 + vert * 6.0;
            }
        };
    }

    /**
     * The cell a right-click with a block item on that face of that block puts the block into, as the game picks it:
     * the clicked block itself when it gives way (tall grass, a thin snow layer, vines), else the cell on that face.
     */
    public static int[] targetOfClick(World w, int x, int y, int z, int side) {
        Block clicked = w.getBlock(x, y, z);
        if ((clicked == net.minecraft.init.Blocks.snow_layer && (w.getBlockMetadata(x, y, z) & 7) < 1)
            || clicked == net.minecraft.init.Blocks.vine
            || clicked == net.minecraft.init.Blocks.tallgrass
            || clicked == net.minecraft.init.Blocks.deadbush
            || clicked.isReplaceable(w, x, y, z)) return new int[] { x, y, z };
        int[][] off = { { 0, -1, 0 }, { 0, 1, 0 }, { 0, 0, -1 }, { 0, 0, 1 }, { -1, 0, 0 }, { 1, 0, 0 } };
        int s = side < 0 || side > 5 ? 1 : side;
        return new int[] { x + off[s][0], y + off[s][1], z + off[s][2] };
    }

    /**
     * Why a block item held in the hand did not go into the cell a click on that face aimed at, by the checks the
     * game itself makes before placing it, in its order; null when the item is not a plain block item. Called when
     * the cell did not change.
     */
    public static String whyNotPlaced(Bot bot, ItemStack stack, int x, int y, int z, int side) {
        EntityPlayerMP p = bot.player();
        World w = p.worldObj;
        Block b = stack == null ? null : Orientation.blockOf(stack.getItem());
        if (b == null) return null;
        String cell = "(" + x + "," + y + "," + z + ")";
        if (y < 0 || y > 255) return "the cell " + cell + " is outside the world's height";
        if (!w.blockExists(x, y, z)) return "the cell " + cell + " is not loaded";
        if (stack.stackSize <= 0) return "the hand was empty when it clicked";
        if (!p.canPlayerEdit(x, y, z, side, stack)) return "the game does not let the bot change blocks there (it may not edit them)";
        if (y == 255 && b.getMaterial()
            .isSolid()) return "a solid block cannot go at y 255, the top of the world";
        Block there = w.getBlock(x, y, z);
        if (!there.isReplaceable(w, x, y, z)) {
            return "the cell the block would go into, " + cell
                + ", is taken by "
                + Names.blockId(there)
                + "/"
                + w.getBlockMetadata(x, y, z)
                + " \""
                + alu.aiplayer.world.WorldQueries.blockName(there, w.getBlockMetadata(x, y, z))
                + "\"";
        }
        AxisAlignedBB box = null;
        try {
            box = b.getCollisionBoundingBoxFromPool(w, x, y, z);
        } catch (Throwable t) {
            // a block that cannot say how big it is
        }
        if (box != null) {
            List<String> who = new ArrayList<>();
            for (Object o : w.getEntitiesWithinAABBExcludingEntity(null, box)) {
                net.minecraft.entity.Entity e = (net.minecraft.entity.Entity) o;
                // The one placing it does not count, as in the game's own check.
                if (e.isDead || !e.preventEntitySpawning || e == p) continue;
                String name = e.getCommandSenderName();
                if (!who.contains(name)) who.add(name);
            }
            if (!who.isEmpty()) return "something stands in the cell " + cell + ": " + String.join(", ", who);
        }
        boolean fits;
        try {
            fits = b.canReplace(w, x, y, z, side, stack);
        } catch (Throwable t) {
            fits = true;
        }
        if (!fits) {
            return "the block's own rule says it cannot stand in " + cell
                + " placed against that face (some blocks need a solid block behind them, or a certain ground)";
        }
        if (bot.placementWasRefused() || bot.serverRefusal() != null) return bot.refused("placing it");
        return "the game made all its checks and the cell did not change; nothing the body can see says why";
    }

    /**
     * The look a click that gives {@code want} needs, in words ("looking south, so standing north of the point
     * clicked"); null when the look does not matter for it.
     */
    public static String lookNeeded(World w, int x, int y, int z, ItemStack stack, int want) {
        Block b = Orientation.blockOf(stack.getItem());
        if (b == null) return null;
        Orientation.Rule r = Orientation.rule(b);
        if (r == Orientation.Rule.UNKNOWN) return null;
        List<Orientation.Way> present = present(w, x, y, z, stack, b, r, want, new Facing());
        if (present == null || present.isEmpty()) return null;
        java.util.TreeSet<Integer> looks = new java.util.TreeSet<>();
        for (Orientation.Way way : present) {
            if (!Orientation.readsLook(r, way.m0)) return null;
            for (int q = 0; q < 4; q++) {
                if (Orientation.apply(r, way.m0, w, b, x, y, z, 1.0e6, 0, 1.0e6, q * 90.0F) == want) looks.add(q);
            }
        }
        if (looks.isEmpty()) return null;
        String[] look = { "south", "west", "north", "east" };
        String[] stand = { "north", "east", "south", "west" };
        List<String> a = new ArrayList<>(), s = new ArrayList<>();
        for (int q : looks) {
            a.add(look[q]);
            s.add(stand[q]);
        }
        return "looking " + String.join(" or ", a) + " as it clicks, so standing " + String.join(" or ", s) + " of the point it clicks";
    }

    /** Right-clicks a face to place against, as a player does: looking at the point, sneaking past its screen. */
    private static void click(Bot bot, int sx, int sy, int sz, int side, float hx, float hy, float hz) {
        EntityPlayerMP p = bot.player();
        Motion.face(p, sx + hx, sy + hy, sz + hz);
        boolean wasSneaking = p.isSneaking();
        p.setSneaking(true);
        try {
            bot.conn()
                .useOnBlock(sx, sy, sz, side, hx, hy, hz);
        } finally {
            p.setSneaking(wasSneaking);
        }
        bot.conn()
            .swingArm();
    }

    public static Result place(Bot bot, int x, int y, int z, ItemFilter item) {
        EntityPlayerMP p = bot.player();
        World w = p.worldObj;
        if (!w.blockExists(x, y, z)) return Result.OUT_OF_REACH;
        if (!isReplaceable(w, x, y, z)) return Result.OCCUPIED;
        if (bodyIntersects(p, x, y, z)) return Result.IN_THE_WAY;
        int slot = Inventories.find(p, item);
        if (slot < 0) return Result.NO_ITEM;

        int[] support = null;
        boolean sawSupport = false;
        for (int[] n : NEIGHBOURS) {
            int nx = x + n[0], ny = y + n[1], nz = z + n[2];
            if (isReplaceable(w, nx, ny, nz)) continue;
            sawSupport = true;
            if (Reach.canReach(p, nx, ny, nz)) {
                support = new int[] { nx, ny, nz, n[3] };
                break;
            }
        }
        if (support == null) return sawSupport ? Result.OUT_OF_REACH : Result.NO_SUPPORT;

        Inventories.hold(bot, slot);
        int side = support[3];
        float hx = 0.5F, hy = 0.5F, hz = 0.5F;
        switch (side) {
            case 0:
                hy = 0.0F;
                break;
            case 1:
                hy = 1.0F;
                break;
            case 2:
                hz = 0.0F;
                break;
            case 3:
                hz = 1.0F;
                break;
            case 4:
                hx = 0.0F;
                break;
            default:
                hx = 1.0F;
                break;
        }
        Motion.face(p, support[0] + hx, support[1] + hy, support[2] + hz);
        // Sneaking makes the click place the block instead of opening whatever the clicked block is.
        boolean wasSneaking = p.isSneaking();
        p.setSneaking(true);
        try {
            bot.conn()
                .useOnBlock(support[0], support[1], support[2], side, hx, hy, hz);
        } finally {
            p.setSneaking(wasSneaking);
        }
        bot.conn()
            .swingArm();
        return isReplaceable(w, x, y, z) ? Result.REJECTED : Result.PLACED;
    }
}
